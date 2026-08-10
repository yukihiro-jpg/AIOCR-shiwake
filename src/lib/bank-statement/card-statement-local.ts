// カード明細PDFを「APIを使わずに」解析する入口。
//
//  1. テキストPDFなら、列の位置から日付・金額を取り出す（statement-layout-parser）
//  2. 明細書に印字された小計と突き合わせて、取りこぼしが無いことを確認する
//  3. 摘要が文字化けするフォーマットなら、摘要の列だけ端末内OCRで読み直す（statement-ocr）
//  4. うまく解析できたレイアウトはカード会社ごとに記憶し、次回はそれを使う（card-format-store）
//
// どれか1つでも成立しなければ null を返す。呼び出し側は従来どおり Gemini へ回す。

import type { CreditCardData, CreditCardTransaction, RawTableRow } from './types'
import { parsePdfText } from './pdf-text-parser'
import {
  parseByLayout, detectLayout, mojibakeRatio,
  type LayoutParseResult, type LayoutRow, type Reconciliation, type StatementLayout,
} from './statement-layout-parser'
import { fillDescriptionsByOcr } from './statement-ocr'
import {
  computeCardSignature, computeCardLabel, getCardFormat, saveCardFormat,
} from './card-format-store'

export interface LocalCardParseResult {
  data: CreditCardData
  /** data.transactions と同じ並びの明細行（ページ番号つき。左ペインの表示に使う） */
  rows: LayoutRow[]
  reconciliation: Reconciliation
  /** 記憶しているフォーマット名（初回は明細書から拾った英字表記） */
  formatLabel: string
  signature: string
  /** このフォーマットを使うのが何回目か（1＝今回はじめて覚えた） */
  useCount: number
  /** 摘要がまだ文字化けしていて、端末内OCRで読み直せる状態か */
  descriptionsPending: boolean
  /**
   * 摘要（店名）を端末内OCRで読み直す。rows[].descRaw を書き換え、埋まった件数を返す。
   * 日付・金額はテキスト層だけで確定しているので、これは後追いで実行してよい。
   */
  finishDescriptions?: (
    onProgress?: (done: number, total: number, phase?: 'prepare' | 'start') => void,
  ) => Promise<number>
}

export interface LocalCardProgress {
  (stage: 'text' | 'ocr' | 'done', pct: number, message: string): void
}

/**
 * カード明細PDFをAPI不使用で解析する。解析できなければ null。
 */
export async function parseCardStatementLocally(
  file: File,
  onProgress?: LocalCardProgress,
  /** すでに parsePdfText 済みならその結果を渡す（PDFの二重解析を避ける） */
  pre?: { pages: { rows: RawTableRow[]; pageWidth: number; pageHeight: number }[]; isTextPdf: boolean },
): Promise<LocalCardParseResult | null> {
  if (!pre && !/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') return null

  onProgress?.('text', 5, 'PDFのテキストを読み取り中…')
  const { pages, isTextPdf } = pre || (await parsePdfText(file))
  if (!isTextPdf || !pages.length) return null

  const rowsByPage = pages.map((p) => p.rows)
  const heights = pages.map((p) => p.pageHeight)

  // 記憶済みフォーマットがあればそれで確定解析。無ければ今回から検出する
  const detected = detectLayout(rowsByPage)
  if (!detected) return null
  const signature = computeCardSignature(rowsByPage[0] || [], pages[0].pageWidth, pages[0].pageHeight, detected)
  const saved = getCardFormat(signature)

  let result: LayoutParseResult | null = null
  if (saved) result = parseByLayout(rowsByPage, heights, saved.layout)
  // 記憶したレイアウトで小計が合わないときは、検出し直した結果を優先する
  if (!result || !result.reconciliation.ok) {
    const fresh = parseByLayout(rowsByPage, heights, detected)
    if (fresh && (!result || fresh.reconciliation.ok || fresh.rows.length > result.rows.length)) result = fresh
  }
  if (!result || !result.rows.length) return null
  // 小計と突き合わせられず件数も少ないときは、誤検出の疑いがあるので AI 解析へ譲る
  if (!result.reconciliation.ok && result.rows.length < 5) return null

  onProgress?.('text', 90, `${result.rows.length}件の取引を読み取りました`)

  // 摘要が化けているフォーマットか。前回までに読めた店名の辞書があれば先に当てはめる
  const descDict: Record<string, string> = { ...(saved?.descDict || {}) }
  const needsOcr = saved?.descNeedsOcr || mojibakeRatio(result.rows) > 0.3
  const label = saved?.label || computeCardLabel(rowsByPage[0] || [])
  const rowsRef = result.rows
  const layoutRef = result.layout
  const reconOk = result.reconciliation.ok

  // 小計と一致した（＝漏れが無いと確認できた）ときだけフォーマットを覚える。
  // 摘要のOCRを待たずにここで保存しておく（日付・金額はもう確定している）
  const remember = () => {
    if (!reconOk) return
    saveCardFormat({
      signature, label, layout: layoutRef,
      descNeedsOcr: needsOcr, descDict, lastRows: rowsRef.length,
    })
  }
  remember()

  // 摘要は後追いで読む。日付・金額の結果はすぐ画面に出せるようにするため、
  // ここでは実行せず「あとで呼べる関数」を返すだけにする
  const finishDescriptions = needsOcr
    ? async (
        cb?: (done: number, total: number, phase?: 'prepare' | 'start') => void,
      ): Promise<number> => {
        try {
          const filled = await fillDescriptionsByOcr(file, rowsRef, layoutRef, cb, descDict)
          remember() // 新しく読めた店名を辞書に反映して覚え直す
          return filled
        } catch (e) {
          // OCRに失敗しても日付・金額は正しいので、摘要なしで続行する
          console.warn('摘要のローカルOCRに失敗しました（日付・金額はそのまま使えます）', e)
          return 0
        }
      }
    : undefined

  const transactions: CreditCardTransaction[] = result.rows.map((r) => ({
    usageDate: r.date,
    storeName: r.descRaw,
    // 出金＝プラス（利用）、入金＝マイナス（返品・支払）
    amount: r.withdrawal != null ? r.withdrawal : -(r.deposit || 0),
  }))
  const paymentDate = transactions.reduce((a, t) => (t.usageDate > a ? t.usageDate : a), transactions[0].usageDate)

  onProgress?.('done', 100, '解析が終わりました')
  return {
    data: {
      paymentDate,
      totalAmount: transactions.reduce((s, t) => s + t.amount, 0),
      cardName: label,
      transactions,
    },
    rows: result.rows,
    reconciliation: result.reconciliation,
    formatLabel: label,
    signature,
    useCount: (saved?.useCount || 0) + 1,
    descriptionsPending: !!finishDescriptions,
    finishDescriptions,
  }
}

/** 突合結果を1行の日本語にする（画面表示用） */
export function describeReconciliation(r: Reconciliation, rowCount: number): string {
  if (r.ok) {
    return `明細書の小計${r.subtotalCount}区分すべてと一致（${rowCount}件・漏れなし）`
  }
  if (r.subtotalCount === 0) {
    return `小計の記載が見つからないため件数の検算ができません（${rowCount}件を抽出）`
  }
  return `⚠ ${r.unmatchedRows}件が小計と一致しません（${rowCount}件中）。金額をご確認ください`
}

export type { StatementLayout }
