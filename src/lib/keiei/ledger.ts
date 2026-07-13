// 総勘定元帳CSV（会計大将）の解析と、月次レポート向けの元帳分析。
// CSVは「科目ヘッダ行（例: "634 消耗品費"）＋取引行」のブロックが科目数分並ぶ形式。
// 取引行: 検索NO,伝票NO,伝票日付(R06/08/01),相手科目コード,相手科目名称,摘要,
//         消費税コード,消費税率,借方金額,貸方金額,差引金額,税率区分,免税事業者等取引
// 「前期より繰越」行の差引金額が期首残高。
// 元帳は取引ごと税抜タイプを推奨（税込タイプは試算表との突合で自動判定して注記）。

import type { FiscalYearData } from './types'

export interface LedgerTx {
  date: string // YYYY-MM-DD
  month: number // 1-12
  counterCode: string
  counterName: string
  memo: string
  debit: number
  credit: number
  taxRate: number | null // 行に消費税率があれば（10 / 8 など）
  taxCode?: string // 消費税コード（会計大将の税区分。空なら税なし取引）
}

export interface LedgerAccount {
  code: string
  name: string
  opening: number // 前期より繰越（BS科目のみ意味を持つ）
  txs: LedgerTx[]
}

export interface LedgerData {
  accounts: LedgerAccount[]
  fileName: string
  importedAt: string
  minDate: string
  maxDate: string
  txCount: number
}

// ---------- パース ----------

function parseCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQ = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ } else inQ = false
      } else cur += c
    } else if (c === '"') inQ = true
    else if (c === ',') { out.push(cur); cur = '' }
    else cur += c
  }
  out.push(cur)
  return out
}

/** 和暦(R06/08/01)・西暦(2024/08/01)の伝票日付 → YYYY-MM-DD */
function parseDate(s: string): string | null {
  const t = (s || '').trim()
  let m = t.match(/^[RＲ](\d{1,2})[/.](\d{1,2})[/.](\d{1,2})$/)
  if (m) {
    const y = 2018 + Number(m[1])
    return `${y}-${String(Number(m[2])).padStart(2, '0')}-${String(Number(m[3])).padStart(2, '0')}`
  }
  m = t.match(/^[H](\d{1,2})[/.](\d{1,2})[/.](\d{1,2})$/i)
  if (m) {
    const y = 1988 + Number(m[1])
    return `${y}-${String(Number(m[2])).padStart(2, '0')}-${String(Number(m[3])).padStart(2, '0')}`
  }
  m = t.match(/^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})$/)
  if (m) return `${m[1]}-${String(Number(m[2])).padStart(2, '0')}-${String(Number(m[3])).padStart(2, '0')}`
  return null
}

function num(s: string): number {
  const n = Number(String(s || '').replace(/[,，\s]/g, ''))
  return isFinite(n) ? n : 0
}

export function parseLedgerCsv(text: string, fileName: string): LedgerData {
  const lines = text.split(/\r?\n/)
  const accounts: LedgerAccount[] = []
  let cur: LedgerAccount | null = null
  let minDate = ''
  let maxDate = ''
  let txCount = 0
  for (const line of lines) {
    if (!line.trim()) continue
    const cells = parseCsvLine(line)
    const head = (cells[0] || '').trim()
    if (head) {
      // 科目ヘッダ行（例: "634 消耗品費" / "111 現金/本店"）
      const m = head.match(/^(\d{3,4})\s+(.+)$/)
      if (m) {
        cur = { code: m[1], name: m[2].trim(), opening: 0, txs: [] }
        accounts.push(cur)
        // 同じ行に「前期より繰越」が載っている形式（摘要列）
        if (/繰越/.test(cells[6] || '')) cur.opening = num(cells[11])
        continue
      }
    }
    if (!cur) continue
    if (/前期より繰越/.test(cells[6] || '')) {
      cur.opening = num(cells[11])
      continue
    }
    const date = parseDate(cells[3] || '')
    if (!date) continue // 月計・累計などの集計行はスキップ
    const debit = num(cells[9])
    const credit = num(cells[10])
    if (!debit && !credit) continue
    const tx: LedgerTx = {
      date,
      month: Number(date.slice(5, 7)),
      counterCode: (cells[4] || '').trim(),
      counterName: (cells[5] || '').trim(),
      memo: (cells[6] || '').trim(),
      debit,
      credit,
      taxRate: cells[8] && String(cells[8]).trim() !== '' ? Number(cells[8]) || null : null,
    }
    const tc = (cells[7] || '').trim()
    if (tc) tx.taxCode = tc
    cur.txs.push(tx)
    txCount++
    if (!minDate || date < minDate) minDate = date
    if (!maxDate || date > maxDate) maxDate = date
  }
  return {
    accounts: accounts.filter((a) => a.txs.length || a.opening),
    fileName,
    importedAt: new Date().toISOString(),
    minDate,
    maxDate,
    txCount,
  }
}

// ---------- 対象期との照合 ----------

/** 期の開始・終了日（YYYY-MM-DD） */
export function fyPeriod(fy: FiscalYearData): { start: string; end: string } {
  const sm = fy.endMonth === 12 ? 1 : fy.endMonth + 1
  const sy = fy.endMonth === 12 ? fy.endYear : fy.endYear - 1
  const start = `${sy}-${String(sm).padStart(2, '0')}-01`
  const endDay = new Date(fy.endYear, fy.endMonth, 0).getDate()
  const end = `${fy.endYear}-${String(fy.endMonth).padStart(2, '0')}-${String(endDay).padStart(2, '0')}`
  return { start, end }
}

/** 元帳がその期のものか（日付範囲が期に収まるか） */
export function ledgerMatchesFy(ledger: LedgerData, fy: FiscalYearData): boolean {
  if (!ledger.minDate || !ledger.maxDate) return false
  const { start, end } = fyPeriod(fy)
  return ledger.minDate >= start && ledger.maxDate <= end
}

/** 元帳の日付範囲から、取込済みの期のどれに属するかを自動判定 */
export function findMatchingFy(
  ledger: LedgerData,
  years: Record<string, FiscalYearData>,
): FiscalYearData | null {
  for (const fy of Object.values(years)) {
    if (ledgerMatchesFy(ledger, fy)) return fy
  }
  return null
}

/** 科目の月次発生額（PL: 借方費用/貸方収益を正とする）。fiscalMonths 順の12配列 */
export function ledgerMonthlyAmounts(acc: LedgerAccount, fy: FiscalYearData, isCredit: boolean): number[] {
  const out = new Array(12).fill(0)
  for (const tx of acc.txs) {
    const idx = fy.fiscalMonths.indexOf(tx.month)
    if (idx < 0) continue
    out[idx] += isCredit ? tx.credit - tx.debit : tx.debit - tx.credit
  }
  return out
}

/** 収益科目か（コード4xx台 or 試算表側でPL貸方） */
export function isRevenueAccount(code: string): boolean {
  const n = Number(code)
  return n >= 400 && n < 430
}

/** PL科目か（元帳コードが4xx以上=損益。BSは1xx-3xx） */
export function isPlAccount(code: string): boolean {
  return Number(code) >= 400
}

/** 税込/税抜タイプの自動判定: PL科目の月合計を試算表と突合。
 *  一致（±2%以内が過半）→ exclusive、×1.10前後で一致 → inclusive */
export function detectTaxMode(ledger: LedgerData, fy: FiscalYearData): 'exclusive' | 'inclusive' | 'unknown' {
  let matchEx = 0
  let matchInc = 0
  let total = 0
  for (const acc of ledger.accounts) {
    if (!isPlAccount(acc.code)) continue
    const row = fy.rows.find((r) => r.code === acc.code)
    if (!row) continue
    const monthly = ledgerMonthlyAmounts(acc, fy, isRevenueAccount(acc.code))
    for (let i = 0; i <= fy.lastFilledIndex; i++) {
      const t = row.monthly[i] || 0
      const l = monthly[i]
      if (!t || !l) continue
      total++
      const r = l / t
      if (Math.abs(r - 1) < 0.02) matchEx++
      else if (r > 1.05 && r < 1.12) matchInc++
    }
  }
  if (total < 3) return 'unknown'
  if (matchEx / total > 0.5) return 'exclusive'
  if (matchInc / total > 0.5) return 'inclusive'
  return 'unknown'
}

/** 月末洗替・繰越の振替行（当月末残高／前月末残高／前期末残高 等）。
 *  試算表との突合には必要なので明細（A）には残すが、大口・定額・取引先の分析からは除外する */
export function isBalanceRow(tx: LedgerTx): boolean {
  return /残高|繰越/.test(tx.memo)
}

// ---------- B: 特記取引（大口・重複・普段動かない科目） ----------

export interface NotableTx {
  kind: 'large' | 'dup' | 'rare'
  account: string
  tx: LedgerTx
  note: string
}

export function notableTxs(ledger: LedgerData, fy: FiscalYearData, monthIdx: number): NotableTx[] {
  const month = fy.fiscalMonths[monthIdx]
  const out: NotableTx[] = []
  for (const acc of ledger.accounts) {
    if (!isPlAccount(acc.code)) continue
    const all = acc.txs.filter((t) => !isBalanceRow(t))
    const inMonth = all.filter((t) => t.month === month)
    if (!inMonth.length) continue
    // 大口: 科目内の全取引中央値の8倍以上 かつ 10万円以上（上位に限定）
    const amts = all.map((t) => Math.max(t.debit, t.credit)).filter((x) => x > 0).sort((a, b) => a - b)
    const med = amts.length ? amts[Math.floor(amts.length / 2)] : 0
    for (const t of inMonth) {
      const a = Math.max(t.debit, t.credit)
      if (a >= 100000 && med > 0 && a >= med * 8) {
        out.push({ kind: 'large', account: acc.name, tx: t, note: `この科目の通常取引（中央値 ${med.toLocaleString()}円）に比べて大きい取引` })
      }
    }
    // 重複疑い: 同日・同額・同摘要が2件以上
    const seen = new Map<string, LedgerTx>()
    for (const t of inMonth) {
      const key = `${t.date}|${t.debit}|${t.credit}|${t.memo}`
      if (!t.memo) continue
      if (Math.max(t.debit, t.credit) < 5000) continue
      const prev = seen.get(key)
      if (prev) out.push({ kind: 'dup', account: acc.name, tx: t, note: '同日・同額・同摘要の取引が複数あります（二重計上でないかご確認ください）' })
      else seen.set(key, t)
    }
    // 普段動かない科目: 年間の取引が3件以下の科目に今月取引があった
    if (all.length <= 3) {
      for (const t of inMonth) {
        out.push({ kind: 'rare', account: acc.name, tx: t, note: 'ふだん動きのない科目の取引' })
      }
    }
  }
  // 大口は金額順で上位10件に制限
  const large = out.filter((x) => x.kind === 'large').sort((a, b) => Math.max(b.tx.debit, b.tx.credit) - Math.max(a.tx.debit, a.tx.credit)).slice(0, 10)
  const rest = out.filter((x) => x.kind !== 'large')
  return [...large, ...rest]
}

// ---------- C: 毎月定額の支払い（固定費棚卸し） ----------

export interface RecurringItem {
  account: string
  memo: string
  monthlyAmount: number // 平均月額
  months: number // 出現月数
  annual: number // 年間推計（月額×12）
}

const normMemo = (s: string) => s.replace(/[\s　]+/g, ' ').replace(/[0-9０-９]{4,}/g, '#').trim()

export function recurringPayments(ledger: LedgerData, fy: FiscalYearData): RecurringItem[] {
  const filled = fy.lastFilledIndex + 1
  const out: RecurringItem[] = []
  for (const acc of ledger.accounts) {
    if (!isPlAccount(acc.code) || isRevenueAccount(acc.code)) continue
    if (/棚卸/.test(acc.name)) continue // 月次棚卸の振替は固定費ではない
    // 摘要ごとに月別合計
    const byMemo = new Map<string, Map<number, number>>()
    for (const t of acc.txs) {
      if (!t.memo || isBalanceRow(t)) continue
      const key = normMemo(t.memo)
      if (key.length < 2) continue
      let m = byMemo.get(key)
      if (!m) { m = new Map(); byMemo.set(key, m) }
      m.set(t.month, (m.get(t.month) || 0) + (t.debit - t.credit))
    }
    for (const [memo, byMonth] of Array.from(byMemo.entries())) {
      const vals = Array.from(byMonth.values()).filter((v) => v > 0)
      if (vals.length < Math.max(3, Math.floor(filled * 0.6))) continue // 6割以上の月に出現
      const mean = vals.reduce((s, v) => s + v, 0) / vals.length
      if (mean < 1000) continue
      const sd = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length)
      if (sd / mean > 0.25) continue // 金額のブレが大きいものは定額とみなさない
      out.push({ account: acc.name, memo, monthlyAmount: Math.round(mean), months: vals.length, annual: Math.round(mean * 12) })
    }
  }
  out.sort((a, b) => b.monthlyAmount - a.monthlyAmount)
  return out
}

// ---------- D: 現預金の日次残高 ----------

const CASH_NAME_RE = /現金|当座|普通|定期|定積|通知|貯金|郵便/

export interface DailyCashPoint {
  date: string
  balance: number
}

export function dailyCashSeries(ledger: LedgerData): { points: DailyCashPoint[]; accounts: string[] } {
  const cashAccs = ledger.accounts.filter((a) => Number(a.code) < 200 && CASH_NAME_RE.test(a.name))
  if (!cashAccs.length) return { points: [], accounts: [] }
  const opening = cashAccs.reduce((s, a) => s + a.opening, 0)
  // 日付ごとの純増減
  const byDate = new Map<string, number>()
  for (const a of cashAccs) {
    for (const t of a.txs) {
      byDate.set(t.date, (byDate.get(t.date) || 0) + (t.debit - t.credit))
    }
  }
  const dates = Array.from(byDate.keys()).sort()
  const points: DailyCashPoint[] = []
  let bal = opening
  for (const d of dates) {
    bal += byDate.get(d) || 0
    points.push({ date: d, balance: bal })
  }
  return { points, accounts: cashAccs.map((a) => a.name) }
}

// ---------- E: 取引先別売上 ----------

export interface CustomerSales {
  account: string
  customer: string
  amount: number
  share: number // 売上合計に対する%
}

const DAILY_SALES_RE = /^(売上|現金売上|売上高|クレジット|カード|レジ|日計)?$/

export function customerSales(ledger: LedgerData, fy: FiscalYearData, upToMonthIdx: number): { list: CustomerSales[]; walkIn: number; total: number } {
  const okMonths = new Set(fy.fiscalMonths.slice(0, upToMonthIdx + 1))
  let walkIn = 0
  const map = new Map<string, { account: string; amount: number }>()
  let total = 0
  for (const acc of ledger.accounts) {
    if (!isRevenueAccount(acc.code)) continue
    if (!/売上/.test(acc.name)) continue
    for (const t of acc.txs) {
      if (!okMonths.has(t.month)) continue
      if (isBalanceRow(t)) continue // 売掛金の月末洗替（当月末残高/前月末残高）は取引先集計から除外
      const amt = t.credit - t.debit
      total += amt
      const memo = normMemo(t.memo)
      // 摘要が空・「売上」等の日計は店頭売上として合算
      if (!memo || DAILY_SALES_RE.test(memo) || /^(値引|カード値引|クレジットカード)$/.test(memo)) {
        walkIn += amt
        continue
      }
      const key = memo
      const cur = map.get(key)
      if (cur) cur.amount += amt
      else map.set(key, { account: acc.name, amount: amt })
    }
  }
  const list: CustomerSales[] = Array.from(map.entries())
    .map(([customer, v]) => ({ customer, account: v.account, amount: v.amount, share: total ? (v.amount / total) * 100 : 0 }))
    .filter((x) => x.amount > 0)
    .sort((a, b) => b.amount - a.amount)
  return { list, walkIn, total }
}
