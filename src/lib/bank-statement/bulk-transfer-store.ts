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

/**
 * 複合仕訳の1行（振込先1件ぶんを複数の科目に分けるとき。例：支払報酬／預り金（源泉））。
 * 金額が空の行を1行だけ置くと、そこは「差額」になり、借方計−貸方計＝振込金額 になるよう自動で決まる。
 */
export interface PayeeLine {
  side: 'debit' | 'credit'
  code: string
  name: string
  subCode?: string
  subName?: string
  taxCode?: string
  taxType?: string
  taxRate?: string
  businessType?: string
  /** 空なら差額（1行だけ） */
  amount?: number
  description?: string
}

/** 総合振込1件のうちの1先 */
export interface BulkTransferRow {
  /** 受取人名（明細の表記のまま） */
  payee: string
  /** 振込金額 */
  amount: number
  /** 振込手数料（当方負担のとき） */
  fee?: number
  /** この回だけの複合仕訳（金額はこの回のもの）。無ければ取引先辞書の内容を使う */
  lines?: PayeeLine[]
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
  /** 引落口座（通帳を使わずにこの明細だけで仕訳にするとき、貸方に立てる科目） */
  bankCode?: string
  bankName?: string
  bankSubCode?: string
  bankSubName?: string
  /** この明細だけで仕訳にした日時。入っていれば、通帳の解析では同じ引落を仕訳にしない（二重計上の防止） */
  journalizedAt?: number
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
  /** 複合仕訳にする振込先の行（科目と、差額以外の行は前回の金額）。あればこちらを使う */
  lines?: PayeeLine[]
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

/** 金額の決まった複合仕訳の1行 */
export type ResolvedLine = PayeeLine & { amount: number }

/**
 * 振込先1件を、仕訳の行に直す。
 *   この回の複合仕訳 → 取引先辞書の複合仕訳 → 取引先辞書の科目（1行） → 科目なし（空欄の1行）
 * 複合仕訳は、金額が空の行（差額）を 借方計−貸方計＝振込金額 になるように埋める。
 * ok=false は貸借が合わない（差額の行が無い・2行以上ある・差額がマイナス）とき。
 */
export function resolvePayeeLines(row: BulkTransferRow, dict: PayeeDict): { lines: ResolvedLine[]; ok: boolean } {
  const acc = payeeAccountOf(dict, row.payee)
  const src = row.lines?.length ? row.lines : acc?.lines?.length ? acc.lines : null
  if (!src) {
    return {
      ok: true,
      lines: [{
        side: 'debit', code: acc?.code || '', name: acc?.name || '',
        subCode: acc?.subCode, subName: acc?.subName,
        taxCode: acc?.taxCode, taxType: acc?.taxType, taxRate: acc?.taxRate, businessType: acc?.businessType,
        description: acc?.description, amount: row.amount,
      }],
    }
  }
  const blanks = src.filter((l) => l.amount == null || !Number.isFinite(l.amount))
  const net = (ls: PayeeLine[]) => ls.reduce((s, l) => s + (l.amount || 0) * (l.side === 'debit' ? 1 : -1), 0)
  if (blanks.length === 1) {
    const rest = net(src.filter((l) => l !== blanks[0]))
    // 差額の行が借方なら 振込金額−他の行の差引、貸方なら その逆
    const amt = blanks[0].side === 'debit' ? row.amount - rest : rest - row.amount
    const lines = src.map((l) => ({ ...l, amount: l === blanks[0] ? amt : (l.amount || 0) }))
    return { lines, ok: amt >= 0 }
  }
  const lines = src.map((l) => ({ ...l, amount: l.amount || 0 }))
  return { lines, ok: blanks.length === 0 && net(lines) === row.amount }
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

/** 通帳を使わずに明細だけで仕訳にするとき、次の明細の引落口座の初期値に使う（直近で使った口座） */
export function lastBankOf(list: BulkTransfer[]): Pick<BulkTransfer, 'bankCode' | 'bankName' | 'bankSubCode' | 'bankSubName'> | null {
  const t = list.filter((x) => x.bankCode).sort((a, b) => (b.importedAt || 0) - (a.importedAt || 0))[0]
  return t ? { bankCode: t.bankCode, bankName: t.bankName, bankSubCode: t.bankSubCode, bankSubName: t.bankSubName } : null
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
