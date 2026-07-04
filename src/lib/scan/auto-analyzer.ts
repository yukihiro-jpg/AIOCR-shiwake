// 書類スキャンの自動AI解析エンジン（アプリ全体で常駐・1タブにつき1つ）。
// どのページを開いていても、合言葉設定済みの事務所端末なら:
//  - 起動時にFirebase上の未解析バッチを自動解析
//  - 画面を開いている間に届いた新着バッチを即時解析
// 複数端末が同時に開いていても acquireAnalysisLock により二重解析しない。
// 解析には端末の Gemini APIキー（bs-gemini-api-key / suite-gemini-api-key）が必要。
// 無い端末ではスキップし、キーのある端末（または手動の「AI解析」）に任せる。

import { hasRoom } from '@/core/room'
import { receiptOcrParallel, creditCardOcr, invoiceOcr } from '@/lib/bank-statement/gemini-client'
import {
  loadScanCompanies,
  subscribeBatches,
  loadAnalyses,
  acquireAnalysisLock,
  getBatchImageDataUrls,
  saveAnalysis,
  type ScanBatch,
  type ScanAnalysisRow,
  type ScanAnalysisKind,
  type ScanAnalysisMeta,
} from './store'

/** 書類種類 → 解析種別。未対応（通帳等・第2弾予定）は null */
export function docTypeToKind(docType: string): ScanAnalysisKind | null {
  switch (docType) {
    case 'レシート・領収書':
      return 'receipt'
    case 'クレジットカード利用明細書':
      return 'credit-card'
    case '売上請求書':
      return 'invoice-sales'
    case '仕入請求書':
      return 'invoice-purchase'
    default:
      return null
  }
}

export interface EngineStatus {
  message: string
  analyzingIds: string[]
}

let status: EngineStatus = { message: '', analyzingIds: [] }
const listeners = new Set<(s: EngineStatus) => void>()
function emit(patch: Partial<EngineStatus>) {
  status = { ...status, ...patch }
  listeners.forEach((fn) => {
    try { fn(status) } catch { /* ignore */ }
  })
}
/** 画面（/scan 等）がエンジンの状態を表示するための購読 */
export function subscribeEngineStatus(fn: (s: EngineStatus) => void): () => void {
  listeners.add(fn)
  fn(status)
  return () => { listeners.delete(fn) }
}

// AI解析結果を税率ごとの行へ展開（pageIndex=元画像を保持）
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function receiptsToRows(receipts: any[]): ScanAnalysisRow[] {
  const rows: ScanAnalysisRow[] = []
  for (const r of receipts) {
    const taxLines = Array.isArray(r.taxLines) && r.taxLines.length ? r.taxLines : [{ taxRate: '', totalAmount: 0 }]
    for (const tl of taxLines) {
      rows.push({
        date: r.receiptDate || '',
        storeName: r.storeName || '',
        mainContent: r.mainContent || '',
        invoiceNumber: r.invoiceNumber || '',
        taxRate: tl.taxRate || '',
        totalAmount: Number(tl.totalAmount) || 0,
        pageIndex: typeof r.pageIndex === 'number' ? r.pageIndex : null,
      })
    }
  }
  return rows
}

/** バッチを書類種類に応じたAIで解析して結果を保存（自動解析・手動解析で共用） */
export async function analyzeBatchAndSave(
  token: string,
  batch: ScanBatch,
  onProgress?: (msg: string) => void,
): Promise<{ rows: ScanAnalysisRow[]; errors: string[]; kind: ScanAnalysisKind; meta?: ScanAnalysisMeta }> {
  const kind = docTypeToKind(batch.docType)
  if (!kind) throw new Error(`「${batch.docType}」のAI解析は現在準備中です（レシート・領収書／クレジットカード利用明細書／売上・仕入請求書に対応）`)
  onProgress?.('画像を取得しています...')
  const dataUrls = await getBatchImageDataUrls(token, batch)
  onProgress?.('AIで解析しています...')

  let rows: ScanAnalysisRow[] = []
  let errors: string[] = []
  let meta: ScanAnalysisMeta | undefined

  if (kind === 'receipt') {
    const res = await receiptOcrParallel(dataUrls, undefined, {
      onProgress: (done, total) => onProgress?.(`AIで解析しています... (${done}/${total})`),
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rows = receiptsToRows(res.receipts as any[])
    errors = res.errors
  } else if (kind === 'credit-card') {
    // 明細は複数ページで1つの書類なので全ページを1回で解析
    const cc = await creditCardOcr(dataUrls)
    rows = (cc.transactions || []).map((t) => ({
      date: t.usageDate || '',
      storeName: t.storeName || '',
      mainContent: t.memo || '',
      invoiceNumber: '',
      taxRate: '',
      totalAmount: Number(t.amount) || 0,
      pageIndex: null,
    }))
    meta = { paymentDate: cc.paymentDate, totalAmount: cc.totalAmount, cardName: cc.cardName }
  } else {
    // 売上請求書／仕入請求書（発行者・宛名の位置ルールをプロンプトに内蔵）
    const { invoices } = await invoiceOcr(dataUrls, kind === 'invoice-purchase' ? 'purchase' : 'sales')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const inv of invoices as any[]) {
      const taxLines = Array.isArray(inv.taxLines) && inv.taxLines.length
        ? inv.taxLines
        : [{ taxRate: '', totalAmount: Number(inv.totalAmount) || 0 }]
      for (const tl of taxLines) {
        rows.push({
          date: inv.invoiceDate || '',
          storeName: inv.counterpartName || '',
          mainContent: inv.mainContent || '',
          invoiceNumber: inv.invoiceNumber || '',
          taxRate: tl.taxRate || '',
          totalAmount: Number(tl.totalAmount) || 0,
          pageIndex: typeof inv.pageStart === 'number' ? inv.pageStart : null,
        })
      }
    }
  }

  await saveAnalysis(token, batch.id, rows, kind, meta)
  return { rows, errors, kind, meta }
}

function hasGeminiKey(): boolean {
  try {
    return !!((localStorage.getItem('bs-gemini-api-key') || '').trim() || (localStorage.getItem('suite-gemini-api-key') || '').trim())
  } catch {
    return false
  }
}

let started = false
const seen = new Set<string>() // キュー投入済み・解析済み確認済みのバッチID
const queue: { token: string; batch: ScanBatch }[] = []
let pumping = false
const subscribedTokens = new Set<string>()

/** アプリ起動時に一度だけ呼ぶ（多重呼び出しは無視される） */
export function startScanAutoAnalyzer(): void {
  if (typeof window === 'undefined' || started) return
  started = true
  const boot = () => {
    if (!hasRoom()) {
      // 合言葉が未設定なら後で再確認（設定画面で入力されたら動き出す）
      setTimeout(boot, 30_000)
      return
    }
    refreshSubscriptions()
    // 新しく「利用」登録された会社を拾うため、定期的に購読先を更新
    setInterval(refreshSubscriptions, 10 * 60_000)
  }
  boot()
}

async function refreshSubscriptions(): Promise<void> {
  try {
    const comps = await loadScanCompanies()
    for (const c of Object.values(comps)) {
      if (!c.token || subscribedTokens.has(c.token)) continue
      subscribedTokens.add(c.token)
      try {
        await subscribeBatches(c.token, (batches) => { enqueue(c.token, batches) })
      } catch { /* 権限エラー等は次回更新時に再試行しない（tokenは登録済み扱い） */ }
    }
  } catch { /* 合言葉・権限エラー等は無視 */ }
}

async function enqueue(token: string, batches: Record<string, ScanBatch>): Promise<void> {
  const candidates = Object.values(batches).filter(
    (b) => b.status !== 'done' && !seen.has(b.id) && docTypeToKind(b.docType) !== null,
  )
  if (!candidates.length) return
  let analyses: Record<string, unknown> = {}
  try {
    analyses = await loadAnalyses(token)
  } catch {
    return
  }
  for (const b of candidates.sort((x, y) => x.submittedAt.localeCompare(y.submittedAt))) {
    if (analyses[b.id]) {
      seen.add(b.id)
      continue
    }
    seen.add(b.id)
    queue.push({ token, batch: b })
  }
  pump()
}

async function pump(): Promise<void> {
  if (pumping) return
  pumping = true
  while (queue.length) {
    if (!hasGeminiKey()) {
      // この端末では解析できない。キュー分は未処理に戻し、キー登録後の新着/再表示で再開
      for (const it of queue) seen.delete(it.batch.id)
      queue.length = 0
      emit({ message: '⚠️ 自動AI解析にはGemini APIキーが必要です（ホーム右上の⚙️共通設定で登録）', analyzingIds: [] })
      break
    }
    const item = queue.shift()!
    // 多端末の二重解析防止（ロックを取れた端末だけが解析）
    let locked = true
    try {
      locked = await acquireAnalysisLock(item.token, item.batch.id)
    } catch { /* ロック不可でも解析は試みる */ }
    if (!locked) continue
    emit({
      analyzingIds: [...status.analyzingIds, item.batch.id],
      message: `🤖 新着バッチをAI解析中…（残り ${queue.length + 1} 件）`,
    })
    try {
      await analyzeBatchAndSave(item.token, item.batch)
    } catch { /* 個別の失敗は受信箱の手動「AI解析」で再試行できる */ }
    emit({ analyzingIds: status.analyzingIds.filter((id) => id !== item.batch.id) })
  }
  pumping = false
  if (!status.message.startsWith('⚠️')) emit({ message: '' })
}
