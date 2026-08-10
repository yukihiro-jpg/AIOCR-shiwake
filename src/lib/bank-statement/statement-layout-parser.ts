// カード明細・入出金明細のテキストPDFを「列の位置」から解析する（API不使用）。
//
// 見出し文字に頼らないのが要点。カード会社のPDFには、日本語フォントに
// 文字コード対応表（ToUnicode）が無く、日本語がすべて文字化けするものがある
// （アメリカン・エキスプレスの「ご利用代金明細書」など）。この場合でも
// 数字は正しく取り出せるため、日付列と金額列の x 位置さえ分かれば
// 日付・金額は1円の誤りもなく抽出できる。
//
// 漏れの検知は「小計行との突合」で行う。明細書には区分ごとの合計が印字されて
// いるので、取引行の累計がその金額と一致すれば取りこぼしが無いと確認できる。

import type { RawTableRow } from './types'

/** 検出した列レイアウト（セル開始xの範囲）。フォーマットとして保存・再利用する */
export interface StatementLayout {
  dateX: [number, number]
  amountX: [number, number]
  /** 摘要（加盟店名）のセル開始xの範囲。文字化けしていてもOCR補完の対象範囲として使う */
  descX: [number, number]
}

export interface LayoutRow {
  pageIndex: number
  /** ページ上端からの位置（pt）。ページ画像OCRとの突合に使う */
  yTop: number
  /** 行の高さ（pt） */
  height: number
  date: string // YYYY-MM-DD
  month: number
  day: number
  /** 出金（プラス表記の行）。マイナス表記なら deposit 側に入る */
  withdrawal: number | null
  deposit: number | null
  /** テキスト層から取れた摘要（文字化けしている場合がある） */
  descRaw: string
}

/** 小計行との突合結果 */
export interface Reconciliation {
  /** 検出できた小計の数 */
  subtotalCount: number
  /** 小計と一致した取引の件数 */
  matchedRows: number
  /** 小計に含まれなかった取引の件数（0なら漏れなし） */
  unmatchedRows: number
  ok: boolean
  details: { subtotal: number; rows: number }[]
}

export interface LayoutParseResult {
  rows: LayoutRow[]
  layout: StatementLayout
  reconciliation: Reconciliation
  /** 明細書の基準年月（締め）。行の年の決定に使う */
  closingYear: number
  closingMonth: number
}

// 金額セル。末尾に「(*)」「※」などの注記が付くことがある（アメックスの軽減税率注記等）
const AMOUNT_RE = /^[△▲+\-\s]*[\d,]+\s*[-+]?\s*(?:[(（][^)）]{0,3}[)）]|[*※＊])?$/

const isAmountText = (s: string): boolean => AMOUNT_RE.test(s.trim()) && /\d/.test(s)

function amountValue(s: string): number | null {
  const t = s.trim()
  if (!isAmountText(t)) return null
  // 注記部分を落としてから数字だけ取り出す
  const body = t.replace(/[(（][^)）]{0,3}[)）]|[*※＊]/g, '')
  const n = Number(body.replace(/[^\d]/g, ''))
  if (!Number.isFinite(n) || n <= 0) return null
  const minus = /[△▲]/.test(body) || /^\s*-/.test(body) || /-\s*$/.test(body)
  return minus ? -n : n
}

/**
 * 文字化け（フォントに ToUnicode が無いPDF）の判定。
 * 日本語の明細に本来出てこないラテン拡張文字（Ê É Ï ã ø …）が混ざっていたら化けている。
 */
export function looksMojibake(s: string): boolean {
  if (!s) return false
  const bad = s.match(/[À-ÿĀ-ɏ]/g)
  if (!bad) return false
  return bad.length >= 2 || bad.length / s.length > 0.15
}

/** 摘要が文字化けしている行の割合（0〜1） */
export function mojibakeRatio(rows: { descRaw: string }[]): number {
  const withDesc = rows.filter((r) => r.descRaw)
  if (!withDesc.length) return 0
  return withDesc.filter((r) => looksMojibake(r.descRaw)).length / withDesc.length
}

/** 「7月10日」「8月1日」等（区切りが文字化けしていても数字2つで判定） */
function dateValue(s: string): { month: number; day: number } | null {
  const t = s.trim()
  if (!t || t.length > 12) return null
  if (/\d{3}/.test(t)) return null // 3桁以上の連番は日付ではない（金額・番号）
  const nums = t.match(/\d{1,2}/g)
  if (!nums || nums.length !== 2) return null
  const month = Number(nums[0]), day = Number(nums[1])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return { month, day }
}

/**
 * 明細書の年を推定する。西暦4桁（19xx/20xx）で最も多く現れるものを採る。
 * 締め日の印字は文字化けで区切りが失われる（例: 「2025年 8月19日」→「2025Q U819Ð」）ため、
 * 年月日をまとめて読もうとせず、年だけを拾う。
 */
function detectYear(pages: RawTableRow[][]): number {
  const count = new Map<number, number>()
  for (const rows of pages.slice(0, 3)) {
    for (const r of rows) {
      const m = r.cells.join(' ').match(/(?:19|20)\d{2}/g)
      if (!m) continue
      for (const s of m) {
        const y = Number(s)
        if (y >= 1990 && y <= 2100) count.set(y, (count.get(y) || 0) + 1)
      }
    }
  }
  let best = new Date().getFullYear(), bestN = 0
  count.forEach((n, y) => { if (n > bestN || (n === bestN && y > best)) { best = y; bestN = n } })
  return best
}

/**
 * 締め月（明細の最後の月）を、出現した月の並びから決める。
 * 円環上でいちばん大きい空きの手前が最後の月。
 * 例) {7,8} → 8 ／ 年跨ぎの {12,1} → 1
 */
function detectClosingMonth(months: number[]): number {
  const uniq = Array.from(new Set(months)).sort((a, b) => a - b)
  if (!uniq.length) return new Date().getMonth() + 1
  if (uniq.length === 1) return uniq[0]
  let best = uniq[uniq.length - 1], bestGap = -1
  for (let i = 0; i < uniq.length; i++) {
    const cur = uniq[i]
    const next = uniq[(i + 1) % uniq.length]
    const gap = ((next - cur) + 12) % 12 || 12
    if (gap > bestGap) { bestGap = gap; best = cur }
  }
  return best
}

/** 取引行の候補（日付セル＋金額セル）を全ページから集めて列位置を決める */
export function detectLayout(pages: RawTableRow[][]): StatementLayout | null {
  const dateXs: number[] = [], amtXs: number[] = [], descXs: number[] = []
  for (const rows of pages) {
    for (const r of rows) {
      if (r.cells.length < 2) continue
      const d = dateValue(r.cells[0])
      if (!d) continue
      // 行の中で最も右にある金額セル
      let ai = -1
      for (let i = r.cells.length - 1; i >= 1; i--) {
        if (amountValue(r.cells[i]) != null) { ai = i; break }
      }
      if (ai < 0) continue
      dateXs.push(r.cellPositions?.[0] ?? 0)
      amtXs.push(r.cellPositions?.[ai] ?? 0)
      if (ai >= 2) descXs.push(r.cellPositions?.[1] ?? 0)
    }
  }
  if (dateXs.length < 3) return null
  const range = (a: number[], left: number, right: number): [number, number] =>
    a.length ? [Math.min(...a) - left, Math.max(...a) + right] : [0, 0]
  return {
    dateX: range(dateXs, 6, 6),
    // 金額は右揃えなので、桁数が多い行は開始xが左へ伸びる。左側を広めに取る
    amountX: range(amtXs, 40, 10),
    descX: range(descXs, 6, 6),
  }
}

const inRange = (x: number, r: [number, number]) => x >= r[0] && x <= r[1]

/**
 * 列レイアウトに従って取引行を抽出し、小計行と突き合わせる。
 * layout を渡すと（保存済みフォーマット）その位置で確定的に解析する。
 */
export function parseByLayout(
  pages: RawTableRow[][],
  pageHeights: number[],
  layout?: StatementLayout | null,
): LayoutParseResult | null {
  const lay = layout || detectLayout(pages)
  if (!lay) return null

  interface Draft {
    pageIndex: number; yTop: number; height: number
    month: number; day: number; amount: number; descRaw: string
  }
  const drafts: Draft[] = []
  // 突合用: 文書順に「取引行」と「日付の無い金額だけの行（小計候補）」を並べる
  const seq: ({ kind: 'tx'; idx: number } | { kind: 'sum'; value: number })[] = []

  pages.forEach((prows, pageIndex) => {
    const H = pageHeights[pageIndex] || 842
    for (const r of prows) {
      const posOf = (i: number) => r.cellPositions?.[i] ?? -1
      // 金額セル（レイアウトの金額列にあるもののうち最も右）
      let ai = -1
      for (let i = r.cells.length - 1; i >= 0; i--) {
        if (inRange(posOf(i), lay.amountX) && amountValue(r.cells[i]) != null) { ai = i; break }
      }
      if (ai < 0) continue
      const amt = amountValue(r.cells[ai])!

      const d = inRange(posOf(0), lay.dateX) ? dateValue(r.cells[0]) : null
      if (d) {
        seq.push({ kind: 'tx', idx: drafts.length })
        drafts.push({
          pageIndex,
          yTop: r.boundingBox ? r.boundingBox.y : H,
          height: r.boundingBox ? r.boundingBox.height : 12,
          month: d.month, day: d.day, amount: amt,
          descRaw: r.cells.slice(1, ai).join(' ').trim(),
        })
      } else if (!dateValue(r.cells[0])) {
        // 日付の無い金額行＝小計・合計の候補
        seq.push({ kind: 'sum', value: amt })
      }
    }
  })
  if (!drafts.length) return null

  const closingYear = detectYear(pages)
  const closingMonth = detectClosingMonth(drafts.map((d) => d.month))
  const rows: LayoutRow[] = drafts.map((d) => {
    // 締め月より後の月は前年（12月締めをまたぐ明細のため）
    const y = d.month > closingMonth ? closingYear - 1 : closingYear
    return {
      pageIndex: d.pageIndex, yTop: d.yTop, height: d.height,
      date: `${y}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`,
      month: d.month, day: d.day,
      withdrawal: d.amount > 0 ? d.amount : null,
      deposit: d.amount < 0 ? -d.amount : null,
      descRaw: d.descRaw,
    }
  })

  // 小計との突合: 直前の小計以降の取引の累計と一致すれば「そこまで漏れなし」
  const details: { subtotal: number; rows: number }[] = []
  let run = 0, runRows = 0, matched = 0
  for (const s of seq) {
    if (s.kind === 'tx') {
      const r = rows[s.idx]
      run += (r.withdrawal ?? 0) - (r.deposit ?? 0)
      runRows++
    } else if (runRows > 0 && (s.value === run || s.value === -run)) {
      details.push({ subtotal: s.value, rows: runRows })
      matched += runRows
      run = 0; runRows = 0
    }
  }
  const reconciliation: Reconciliation = {
    subtotalCount: details.length,
    matchedRows: matched,
    unmatchedRows: rows.length - matched,
    ok: details.length > 0 && matched === rows.length,
    details,
  }

  return { rows, layout: lay, reconciliation, closingYear, closingMonth }
}
