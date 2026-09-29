// 総合振込の内訳と、振込先ごとの科目（取引先辞書）。
//
// 通帳には「フリコミカワリキン」などの名前で、総合振込の合計額が1行で引き落とされる。
// 誰にいくら払ったかは銀行の総合振込の明細（Excel）にしか無いので、それを取り込んでおき、
// 通帳の解析で「同じころの日付・同じ合計額の出金」を見つけたら、振込先ごとの複合仕訳にする。
//
// 【科目の学習は振込先の名前に対して行う】
// 総合振込の顔ぶれは月ごとに変わるので、通帳の摘要（フリコミカワリキン）に紐づけて学習しても
// 意味がない。振込先の名前 → 科目・補助科目・税区分 を顧問先ごとの辞書に持ち、
// 初めて出てきた振込先だけ科目を空欄で出して、先生に決めてもらう。
//
// 【引き当ての考え方】
// ・合計額は**完全一致**を求める（違えば別の支払いなので勝手に割り振らない）
// ・振込手数料は銀行によって「別の行で引き落とす」「合計に含めて引き落とす」の2通りあるので、
//   振込金額の合計と、振込金額＋手数料の合計のどちらに一致しても当てる（後者は手数料の行も作る）
// ・指定日と実際の引落日は通常同じだが、休日などでずれることがあるので前後3日まで見る
//
// 保存は顧問先ごと（STORAGE_KEY_MAP の 'bulk-transfers' / 'payee-accounts'）。

import type { RawTableRow } from './types'
import { parseAmount, parseScheduleDate } from './loan-schedule-store'

const transfersKey = (cid: string) => `bs-bulk-transfers-${cid}`
const payeesKey = (cid: string) => `bs-payee-accounts-${cid}`

/** 総合振込1件のうちの1先 */
export interface BulkTransferRow {
  /** 受取人名（明細の表記のまま） */
  payee: string
  /** 振込金額 */
  amount: number
  /** 振込手数料（当方負担のとき） */
  fee?: number
}

/** 総合振込1回分（明細1枚＝Excelの1シート） */
export interface BulkTransfer {
  id: string
  /** 指定日 YYYY-MM-DD */
  date: string
  rows: BulkTransferRow[]
  fileName?: string
  sheetName?: string
  importedAt?: number
}

export interface BulkTransferMapping {
  dateColumn: number
  payeeColumn: number
  amountColumn: number
  feeColumn?: number
}

/** 振込先ごとに覚える科目 */
export interface PayeeAccount {
  /** 表示用の振込先名（最後に学習したときの表記） */
  payee: string
  code: string
  name: string
  subCode?: string
  subName?: string
  taxCode?: string
  taxType?: string
  taxRate?: string
  businessType?: string
  /** 振込先名と違う摘要にしたいとき（空なら振込先名をそのまま摘要にする） */
  description?: string
  updatedAt?: number
}

/** 正規化した振込先名 → 科目 */
export type PayeeDict = Record<string, PayeeAccount>

/** 手数料の行に使う名前（辞書のキーにもなる） */
export const FEE_PAYEE = '振込手数料'

/** 実際の引落日が指定日とずれても拾う日数 */
export const BULK_DATE_TOLERANCE = 3

/** 保存しておく期間。古い明細は通帳の解析で使わないので、保存領域を空けるため自動で捨てる */
const KEEP_DAYS = 400

export function newBulkTransferId(): string {
  return `bt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

// ---------------------------------------------------------------------------
// 振込先名の正規化（辞書のキー）
// ---------------------------------------------------------------------------

/**
 * 表記ゆれを吸収して辞書のキーにする。
 * 全角/半角・空白・法人格の書き方（株式会社／（株）／(株)／㈱、有限会社／（有）など）の違いで
 * 同じ取引先が別物として扱われると、毎月科目を選び直すことになるため。
 */
export function normalizePayee(name: string): string {
  return String(name || '')
    .normalize('NFKC')
    .replace(/[\s　]+/g, '')
    .replace(/株式会社|有限会社|合同会社|合資会社|合名会社|一般社団法人|一般財団法人|社会福祉法人|医療法人|\(株\)|\(有\)|\(同\)|\(資\)|\(名\)|\(社\)|\(財\)|\(医\)|㈱|㈲/g, '')
    .replace(/[・.,，．]/g, '')
    .toLowerCase()
}

// ---------------------------------------------------------------------------
// 保存・読み込み
// ---------------------------------------------------------------------------

function readJson<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

/** 書けたかを返す（保存領域が満杯のときに黙って失われないように） */
function writeJson(cid: string, key: string, mapKey: string, value: unknown): boolean {
  if (!cid || typeof window === 'undefined') return false
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch (e) {
    console.warn('[bulk-transfer-store] save failed', e)
    return false
  }
  import('./firebase-sync')
    .then((m) => m.schedulePushToFirebase(cid, mapKey, value))
    .catch(() => { /* オフラインなら端末内だけで動く */ })
  return true
}

export function loadBulkTransfers(cid: string): BulkTransfer[] {
  if (!cid) return []
  const list = readJson<BulkTransfer[]>(transfersKey(cid), [])
  return Array.isArray(list) ? list.filter((t) => t && t.id && Array.isArray(t.rows)) : []
}

export function saveBulkTransfers(cid: string, list: BulkTransfer[]): boolean {
  const limit = Date.now() - KEEP_DAYS * 86400000
  const kept = list.filter((t) => { const d = Date.parse(t.date); return isNaN(d) || d >= limit })
  return writeJson(cid, transfersKey(cid), 'bulk-transfers', kept)
}

export function loadPayeeDict(cid: string): PayeeDict {
  if (!cid) return {}
  const d = readJson<PayeeDict>(payeesKey(cid), {})
  return d && typeof d === 'object' ? d : {}
}

export function savePayeeDict(cid: string, dict: PayeeDict): boolean {
  return writeJson(cid, payeesKey(cid), 'payee-accounts', dict)
}

export function payeeAccountOf(dict: PayeeDict, payee: string): PayeeAccount | null {
  return dict[normalizePayee(payee)] ?? null
}

// ---------------------------------------------------------------------------
// 取り込み（列マッピング）
// ---------------------------------------------------------------------------

export interface ParsedBulkSheet {
  /** いちばん多く出てきた指定日（明細1枚＝1回の総合振込なので、ふつうは全行同じ） */
  date: string
  rows: BulkTransferRow[]
  /** 見出し・合計行など、振込として読まなかった行数 */
  skipped: number
  total: number
  feeTotal: number
}

/** 合計・小計など、振込先ではない行（「〇〇設計」のような社名を落とさないよう、末尾の「計」だけでは判定しない） */
const TOTAL_ROW = /合計|小計|総計|^\s*計\s*$|（参考）|\(参考\)|依頼口座/

/** 列マッピングに従って、明細1枚を読む。 */
export function parseBulkSheet(rows: RawTableRow[], map: BulkTransferMapping): ParsedBulkSheet {
  const out: BulkTransferRow[] = []
  const dates = new Map<string, number>()
  let skipped = 0
  const cell = (r: RawTableRow, col?: number): string => (col != null && col >= 0 ? (r.cells[col] ?? '') : '')
  for (const r of rows) {
    const payee = cell(r, map.payeeColumn).trim()
    const amount = parseAmount(cell(r, map.amountColumn))
    if (!payee || TOTAL_ROW.test(payee) || amount === null || amount <= 0) { skipped++; continue }
    const fee = map.feeColumn != null ? parseAmount(cell(r, map.feeColumn)) : null
    const d = parseScheduleDate(cell(r, map.dateColumn))
    if (d) dates.set(d, (dates.get(d) || 0) + 1)
    out.push({ payee, amount, ...(fee && fee > 0 ? { fee } : {}) })
  }
  const date = Array.from(dates.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
  return {
    date, rows: out, skipped,
    total: out.reduce((s, r) => s + r.amount, 0),
    feeTotal: out.reduce((s, r) => s + (r.fee || 0), 0),
  }
}

export const bulkTotal = (t: BulkTransfer): number => t.rows.reduce((s, r) => s + r.amount, 0)
export const bulkFeeTotal = (t: BulkTransfer): number => t.rows.reduce((s, r) => s + (r.fee || 0), 0)

// ---------------------------------------------------------------------------
// 引き当て
// ---------------------------------------------------------------------------

export interface BulkMatch {
  transfer: BulkTransfer
  /** 手数料を含めた額で引き落とされていた（手数料の行も作る） */
  includesFee: boolean
}

/**
 * 通帳の出金1件に当たる総合振込を探す。
 * 振込金額の合計、または振込金額＋手数料の合計に完全一致し、指定日から前後3日以内のもの。
 * 候補が複数あれば日付がいちばん近いものを採る。
 */
export function findBulkTransfer(list: BulkTransfer[], date: string, amount: number): BulkMatch | null {
  if (!list.length || !date || !amount) return null
  const t0 = Date.parse(date)
  if (isNaN(t0)) return null
  let best: { v: BulkMatch; d: number } | null = null
  for (const t of list) {
    const d = Math.abs(Date.parse(t.date) - t0) / 86400000
    if (!(d <= BULK_DATE_TOLERANCE)) continue
    const total = bulkTotal(t)
    const fee = bulkFeeTotal(t)
    const hit = amount === total ? false : (fee > 0 && amount === total + fee) ? true : null
    if (hit === null) continue
    if (!best || d < best.d) best = { v: { transfer: t, includesFee: hit }, d }
  }
  return best ? best.v : null
}
