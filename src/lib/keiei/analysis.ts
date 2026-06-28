import type { AccountRow, FiscalYearData, Statement } from './types'
import { CODES, getRow, ytd, singleMonth, sortedYears, findPriorYear } from './calc'
import { effectiveTaxRate } from './tax'

// ===== 補助科目を畳んで「科目」単位に集約 =====
export interface AggRow { statement: Statement; name: string; level: number; isSubtotal: boolean; bracket: '' | 'group' | 'profit'; monthly: number[] }

/** 科目名から主科目名を取り出す（"普通/常陽" → "普通"）。括弧付き小計はそのまま */
export function mainAccountName(name: string): string {
  const t = name.trim()
  const i = t.indexOf('/')
  return i >= 0 ? t.slice(0, i).trim() : t
}

/** 補助科目（"科目/補助"）を主科目で合算し、小計行はそのまま残す */
export function aggregateRows(fy: FiscalYearData): AggRow[] {
  const out: AggRow[] = []
  let map = new Map<string, AggRow>()
  let order: string[] = []
  const flush = () => { for (const k of order) out.push(map.get(k)!); map = new Map(); order = [] }
  for (const r of fy.rows) {
    if (r.isSubtotal) {
      flush()
      out.push({ statement: r.statement, name: r.name.trim(), level: r.level, isSubtotal: true, bracket: r.bracket, monthly: [...r.monthly] })
      continue
    }
    const nm = mainAccountName(r.name)
    const key = r.statement + '|' + nm
    const ex = map.get(key)
    if (ex) { for (let i = 0; i < 12; i++) ex.monthly[i] = (ex.monthly[i] ?? 0) + (r.monthly[i] ?? 0) }
    else { map.set(key, { statement: r.statement, name: nm, level: r.level, isSubtotal: false, bracket: '', monthly: [...r.monthly] }); order.push(key) }
  }
  flush()
  return out
}

/** 集約行の値: single=その月の単月（PL）/月末残高（BS）, cum=PL累計 / BS残高 */
export function aggRowValue(row: AggRow, monthIdx: number, mode: 'single' | 'cum'): number {
  if (mode === 'single' || row.statement === 'BS') return row.monthly[monthIdx] ?? 0
  let s = 0
  for (let i = 0; i <= monthIdx; i++) s += row.monthly[i] ?? 0
  return s
}

export interface SubGroup { subtotal: AccountRow; details: AccountRow[] }

/** 小計行の手前に並ぶ明細をその小計のグループとしてまとめる（会計大将の並び順に準拠） */
export function groupBySubtotal(fy: FiscalYearData, statement: Statement): SubGroup[] {
  const out: SubGroup[] = []
  let acc: AccountRow[] = []
  for (const r of fy.rows) {
    if (r.statement !== statement) continue
    if (r.isSubtotal) { out.push({ subtotal: r, details: acc }); acc = [] }
    else acc.push(r)
  }
  return out
}

/** 指定小計コードの明細科目 */
export function detailsOf(fy: FiscalYearData, subtotalCode: string): AccountRow[] {
  const st = getRow(fy, subtotalCode)?.statement || 'PL'
  return groupBySubtotal(fy, st).find((g) => g.subtotal.code === subtotalCode)?.details || []
}

/** 行の期首〜monthIdx累計（PL=合算 / BS=残高） */
export function rowYtd(row: AccountRow, monthIdx: number): number {
  if (row.statement === 'BS') return row.monthly[monthIdx] ?? 0
  let s = 0
  for (let i = 0; i <= monthIdx; i++) s += row.monthly[i] ?? 0
  return s
}

// ===== 変動費 / 固定費 =====
export type VarFix = 'variable' | 'fixed'
export interface KeieiSettings { varfix: Record<string, VarFix>; loanExclude: Record<string, boolean>; fcfComments?: Record<string, string>; repayAnnual?: Record<string, number> }
export function defaultSettings(): KeieiSettings { return { varfix: {}, loanExclude: {}, fcfComments: {}, repayAnnual: {} } }

// 分類対象 = 「売上原価（合計を1ブロック）」＋「販管費の各明細」。
// ※売上原価は期首/期末棚卸を含むため明細合算では正しくならない。小計(9577)を一括で扱う。
export function classifiableCodes(fy: FiscalYearData): { code: string; name: string }[] {
  return [{ code: CODES.cogs, name: '売上原価（合計）' }, ...detailsOf(fy, CODES.sgna).map((a) => ({ code: a.code, name: a.name.trim() }))]
}

/** 指定コードの期首〜monthIdx累計（小計・明細どちらでも） */
export function costValue(fy: FiscalYearData, code: string, monthIdx: number): number {
  const r = getRow(fy, code)
  return r ? rowYtd(r, monthIdx) : 0
}

/** 既定の変動/固定判定（売上原価=変動・販管費=固定）＋ settings の上書き */
export function classifyOf(fy: FiscalYearData, settings: KeieiSettings) {
  return (code: string): VarFix => settings.varfix[code] || (code === CODES.cogs ? 'variable' : 'fixed')
}

export interface Cvp { sales: number; variable: number; fixed: number; marginal: number; marginalRate: number; bep: number; safety: number; opProfit: number }

/** 期首〜monthIdx累計ベースのCVP指標 */
export function cvp(fy: FiscalYearData, monthIdx: number, settings: KeieiSettings): Cvp {
  const cls = classifyOf(fy, settings)
  const sales = ytd(fy, CODES.sales, monthIdx)
  let variable = 0, fixed = 0
  for (const { code } of classifiableCodes(fy)) {
    const v = costValue(fy, code, monthIdx)
    if (cls(code) === 'variable') variable += v
    else fixed += v
  }
  const marginal = sales - variable
  const marginalRate = sales ? marginal / sales : 0
  const bep = marginalRate ? fixed / marginalRate : 0
  const safety = sales ? (sales - bep) / sales : 0
  const opProfit = marginal - fixed
  return { sales, variable, fixed, marginal, marginalRate, bep, safety, opProfit }
}

/** 月次系列の相関（3期分を連結して変動費らしさを推定） */
export function suggestVarFix(years: Record<string, FiscalYearData>): Record<string, VarFix> {
  const list = sortedYears(years)
  if (!list.length) return {}
  // 売上の月次（全期連結）
  const salesSeries: number[] = []
  for (const fy of list) {
    const s = getRow(fy, CODES.sales)
    for (let i = 0; i <= fy.lastFilledIndex; i++) salesSeries.push(s?.monthly[i] ?? 0)
  }
  const codes = new Set<string>()
  for (const fy of list) for (const c of classifiableCodes(fy)) codes.add(c.code)
  const out: Record<string, VarFix> = {}
  for (const code of Array.from(codes)) {
    const series: number[] = []
    for (const fy of list) {
      const a = getRow(fy, code)
      for (let i = 0; i <= fy.lastFilledIndex; i++) series.push(a?.monthly[i] ?? 0)
    }
    out[code] = correlation(series, salesSeries) >= 0.6 ? 'variable' : 'fixed'
  }
  return out
}

function correlation(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length)
  if (n < 4) return 0
  let sx = 0, sy = 0
  for (let i = 0; i < n; i++) { sx += x[i]; sy += y[i] }
  const mx = sx / n, my = sy / n
  let cov = 0, vx = 0, vy = 0
  for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; cov += dx * dy; vx += dx * dx; vy += dy * dy }
  if (vx === 0 || vy === 0) return 0
  return cov / Math.sqrt(vx * vy)
}

// ===== 有利子負債・キャッシュフロー・安全性 =====
export function isLoanAccount(name: string): boolean {
  return /(短期借入|長期借入|借入金)/.test(name) && !/役員/.test(name)
}
export function isLeaseAccount(name: string): boolean {
  return /リース債務/.test(name)
}

/** BS負債の明細から有利子負債（金融機関）・リース債務の科目を抽出 */
export function debtAccounts(fy: FiscalYearData) {
  const liab = [...detailsOf(fy, CODES.currentLiab), ...detailsOf(fy, CODES.fixedLiab)]
  return {
    loans: liab.filter((a) => isLoanAccount(a.name)),
    leases: liab.filter((a) => isLeaseAccount(a.name)),
  }
}

/** 減価償却費（販管費・売上原価の明細から名称一致でYTD合算） */
export function depreciationYtd(fy: FiscalYearData, monthIdx: number): number {
  let s = 0
  for (const a of [...detailsOf(fy, CODES.sgna), ...detailsOf(fy, CODES.cogs)]) {
    if (/減価償却/.test(a.name)) s += rowYtd(a, monthIdx)
  }
  return s
}

export interface SafetyResult {
  months: number // 経過月数
  annualFactor: number
  loans: number; leases: number
  simpleCfYtd: number; simpleCfAnnual: number
  taxRate: number
  cash: number; monthlySales: number; liquidityMonths: number
  payoffLoans: number | null; payoffLoansLease: number | null
  equityRatio: number
}

export function safety(fy: FiscalYearData, monthIdx: number, settings: KeieiSettings): SafetyResult {
  const months = monthIdx + 1
  const annualFactor = 12 / months
  const ord = ytd(fy, CODES.ordProfit, monthIdx)
  const dep = depreciationYtd(fy, monthIdx)
  const incomeAnnual = ord * annualFactor // 概算課税所得 ≒ 経常利益(年換算)
  const taxRate = effectiveTaxRate(incomeAnnual)
  const afterTax = ord * (1 - taxRate)
  const simpleCfYtd = afterTax + dep
  const simpleCfAnnual = simpleCfYtd * annualFactor
  const { loans, leases } = debtAccounts(fy)
  const ex = settings.loanExclude || {}
  const loanBal = loans.filter((a) => !ex[a.code]).reduce((s, a) => s + singleMonth(fy, a.code, monthIdx), 0)
  const leaseBal = leases.filter((a) => !ex[a.code]).reduce((s, a) => s + singleMonth(fy, a.code, monthIdx), 0)
  const cash = singleMonth(fy, CODES.cash, monthIdx)
  const salesAnnual = ytd(fy, CODES.sales, monthIdx) * annualFactor
  const monthlySales = salesAnnual / 12
  const asset = singleMonth(fy, CODES.assetTotal, monthIdx)
  const netAsset = singleMonth(fy, CODES.netAsset, monthIdx)
  return {
    months, annualFactor,
    loans: loanBal, leases: leaseBal,
    simpleCfYtd, simpleCfAnnual, taxRate,
    cash, monthlySales, liquidityMonths: monthlySales ? cash / monthlySales : 0,
    payoffLoans: simpleCfAnnual > 0 ? loanBal / simpleCfAnnual : null,
    payoffLoansLease: simpleCfAnnual > 0 ? (loanBal + leaseBal) / simpleCfAnnual : null,
    equityRatio: asset ? (netAsset / asset) * 100 : 0,
  }
}

// ===== 簡易フリーキャッシュフロー分析 =====
const RECV_RE = /受取手形|電子記録債権|売掛/
const INV_RE = /商品|製品|仕掛|原材料|貯蔵/
const LOAN_RE = /(短期借入|長期借入|借入金)/
function isPay(name: string): boolean { return /買掛|支払手形|電子記録債務/.test(name) || name === '未払金' }

function sumBsAt(rows: AggRow[], monthIdx: number, match: (name: string) => boolean): number {
  let s = 0
  for (const r of rows) if (r.statement === 'BS' && !r.isSubtotal && match(r.name)) s += r.monthly[monthIdx] ?? 0
  return s
}

export interface FcfResult {
  hasPrior: boolean
  ordProfit: number; taxRate: number; afterTax: number; depreciation: number
  recvChg: number; invChg: number; payChg: number
  wcOpen: number; wcClose: number; wcIncrease: number
  operatingCf: number
  loanChg: number; leaseChg: number; financeBalance: number
  netCash: number; cashActualChg: number
}

/** 推移BS/PLから簡易フリーキャッシュフロー（営業CF）と財務収支を算出 */
export function fcfAnalysis(
  fy: FiscalYearData,
  prior: FiscalYearData | null,
  monthIdx: number,
): FcfResult {
  const cur = aggregateRows(fy)
  const pre = prior ? aggregateRows(prior) : null
  const recvM = (n: string) => RECV_RE.test(n)
  const invM = (n: string) => INV_RE.test(n)
  const payM = isPay
  const loanM = (n: string) => LOAN_RE.test(n) && !/役員/.test(n)
  const leaseM = (n: string) => /リース債務/.test(n)
  const open = (m: (n: string) => boolean) => pre ? sumBsAt(pre, 11, m) : sumBsAt(cur, 0, m)
  const close = (m: (n: string) => boolean) => sumBsAt(cur, monthIdx, m)

  const recvChg = close(recvM) - open(recvM)
  const invChg = close(invM) - open(invM)
  const payChg = close(payM) - open(payM)
  const wcOpen = open(recvM) + open(invM) - open(payM)
  const wcClose = close(recvM) + close(invM) - close(payM)
  const wcIncrease = wcClose - wcOpen

  const ordProfit = ytd(fy, CODES.ordProfit, monthIdx)
  const depreciation = depreciationYtd(fy, monthIdx)
  const months = monthIdx + 1
  const taxRate = effectiveTaxRate(ordProfit * (12 / months))
  const afterTax = ordProfit * (1 - taxRate)
  const operatingCf = afterTax + depreciation - wcIncrease

  const loanChg = close(loanM) - open(loanM)
  const leaseChg = close(leaseM) - open(leaseM)
  const financeBalance = loanChg + leaseChg

  const cashOpen = prior ? singleMonth(prior, CODES.cash, 11) : singleMonth(fy, CODES.cash, 0)
  const cashClose = singleMonth(fy, CODES.cash, monthIdx)

  return {
    hasPrior: !!prior,
    ordProfit, taxRate, afterTax, depreciation,
    recvChg, invChg, payChg, wcOpen, wcClose, wcIncrease,
    operatingCf, loanChg, leaseChg, financeBalance,
    netCash: operatingCf + financeBalance,
    cashActualChg: cashClose - cashOpen,
  }
}

/** FCF評価コメントの自動生成（ユーザーが編集可能。短い文章） */
export function buildFcfComment(r: FcfResult, fmt: (n: number) => string): string {
  const lines: string[] = []
  lines.push(
    r.operatingCf >= 0
      ? `期首〜当月の簡易営業キャッシュフローは ${fmt(r.operatingCf)} のプラスです。本業で現金を生み出せています。`
      : `期首〜当月の簡易営業キャッシュフローは ${fmt(r.operatingCf)} のマイナスです。本業から現金が流出しています。`,
  )
  lines.push(
    r.wcIncrease > 0
      ? `売上債権・在庫の増加（運転資本 ${fmt(r.wcIncrease)} 増）が資金を圧迫しています。回収・在庫圧縮が改善余地です。`
      : `運転資本が ${fmt(-r.wcIncrease)} 減少し、回収・在庫の圧縮で資金が改善しています。`,
  )
  if (r.financeBalance < 0) {
    const rep = -r.financeBalance
    lines.push(
      r.operatingCf >= rep
        ? `借入・リースの返済 ${fmt(rep)} は営業CFの範囲内でまかなえています（健全）。`
        : `借入・リースの返済 ${fmt(rep)} に対し営業CFが不足し、手元資金に依存しています。`,
    )
  } else if (r.financeBalance > 0) {
    lines.push(`当期は借入・リースで ${fmt(r.financeBalance)} を新たに調達しています。借入に依存した資金繰りになっていないか、資金使途と返済計画を確認しましょう。`)
  }
  lines.push(`借入・リースの増減を含めた現金の純増減は ${fmt(r.netCash)} です。`)
  return lines.join('\n')
}

// ===== 借入返済対応CVP（損益分岐点 × フリーキャッシュフローの統合） =====
// 「借入の年間返済を賄うには、どれだけ営業利益＝売上・粗利率の改善が必要か」を試算する。
// 営業CF（年換算）＝（営業利益＋営業外）×(1−税率)＋減価償却−運転資本増加（FCFタブと同一定義）。
export interface RepayContext {
  annualFactor: number
  taxRate: number
  salesAnnual: number; fixedAnnual: number; marginalRate: number; opProfitAnnual: number
  depAnnual: number; wcIncreaseAnnual: number; nonOpAnnual: number
  opCfActualAnnual: number
  loanLeaseBal: number
  repayActualAnnual: number; defaultRepay: number
}

/** 借入返済対応CVPの前提値（実績ベース・年換算）を算出 */
export function repaymentContext(
  fy: FiscalYearData, prior: FiscalYearData | null, monthIdx: number, settings: KeieiSettings,
): RepayContext {
  const af = 12 / (monthIdx + 1)
  const c = cvp(fy, monthIdx, settings)
  const f = fcfAnalysis(fy, prior, monthIdx)
  const s = safety(fy, monthIdx, settings)
  const nonOp = f.ordProfit - c.opProfit // 営業外純損益（経常−営業）累計
  const repayActualAnnual = Math.max(0, -f.financeBalance) * af // 期中の純返済（年換算）
  const loanLeaseBal = s.loans + s.leases
  const defaultRepay = repayActualAnnual > 0 ? repayActualAnnual : (loanLeaseBal > 0 ? loanLeaseBal / 7 : 0)
  return {
    annualFactor: af, taxRate: f.taxRate,
    salesAnnual: c.sales * af, fixedAnnual: c.fixed * af, marginalRate: c.marginalRate, opProfitAnnual: c.opProfit * af,
    depAnnual: f.depreciation * af, wcIncreaseAnnual: f.wcIncrease * af, nonOpAnnual: nonOp * af,
    opCfActualAnnual: f.operatingCf * af,
    loanLeaseBal, repayActualAnnual, defaultRepay,
  }
}

export interface RepaySolve {
  reqOp: number; reqMarginal: number; reqSales: number
  salesGap: number; salesGapPct: number
  reqMarginalRate: number; marginRateGapPt: number
  cfSim: number; covered: boolean; shortfall: number; surplus: number
  reachableByMargin: boolean
}

/** 文脈・年間返済額・シミュレーション後の営業利益(年換算)から、返済充足と必要改善量を解く */
export function repaymentSolve(ctx: RepayContext, plannedRepay: number, opAnnualSim: number): RepaySolve {
  const reqAfterTax = plannedRepay - ctx.depAnnual + ctx.wcIncreaseAnnual
  const reqOp = reqAfterTax / (1 - ctx.taxRate) - ctx.nonOpAnnual
  const reqMarginal = ctx.fixedAnnual + reqOp // 必要限界利益（年）
  const reqSales = ctx.marginalRate > 0 ? reqMarginal / ctx.marginalRate : Infinity
  const salesGap = reqSales - ctx.salesAnnual
  const salesGapPct = ctx.salesAnnual ? (salesGap / ctx.salesAnnual) * 100 : 0
  const reqMarginalRate = ctx.salesAnnual > 0 ? reqMarginal / ctx.salesAnnual : 0
  const marginRateGapPt = (reqMarginalRate - ctx.marginalRate) * 100
  const afterTaxSim = (opAnnualSim + ctx.nonOpAnnual) * (1 - ctx.taxRate)
  const cfSim = afterTaxSim + ctx.depAnnual - ctx.wcIncreaseAnnual
  const covered = cfSim >= plannedRepay
  const shortfall = Math.max(0, plannedRepay - cfSim)
  const surplus = Math.max(0, cfSim - plannedRepay)
  return {
    reqOp, reqMarginal, reqSales, salesGap, salesGapPct, reqMarginalRate, marginRateGapPt,
    cfSim, covered, shortfall, surplus,
    reachableByMargin: reqMarginalRate > 0 && reqMarginalRate < 0.99,
  }
}

// ===== 着地見込み（複数シナリオ） =====
export type ScenarioKey = 'conservative' | 'standard' | 'optimistic'
export interface Landing { key: ScenarioKey; label: string; sales: number; opProfit: number; ordProfit: number }

/**
 * 期中の当期について通期着地を予測。残月の単月値を、前年同月（保守）／
 * 前期前々期の同月平均×今期ペース（標準）／前年同月×(1+X%)（楽観）で補完。
 */
export function landingScenarios(
  years: Record<string, FiscalYearData>,
  fy: FiscalYearData,
  optimisticPct = 5,
): { partial: boolean; scenarios: Landing[] } {
  const partial = fy.lastFilledIndex < 11
  const codes = [CODES.sales, CODES.opProfit, CODES.ordProfit] as const
  const prior = findPriorYear(years, fy)
  const prior2 = prior ? findPriorYear(years, prior) : null

  // 各指標のYTD（確定分）
  const ytdOf = (code: string) => ytd(fy, code, fy.lastFilledIndex)

  if (!partial) {
    const s = ytdOf(CODES.sales), o = ytdOf(CODES.opProfit), r = ytdOf(CODES.ordProfit)
    return { partial: false, scenarios: [{ key: 'standard', label: '確定（通期）', sales: s, opProfit: o, ordProfit: r }] }
  }

  // 今期ペース係数（売上ベース: 今期YTD ÷ 前年同YTD）
  let pace = 1
  if (prior) {
    const cur = ytd(fy, CODES.sales, fy.lastFilledIndex)
    const pre = ytd(prior, CODES.sales, fy.lastFilledIndex)
    if (pre) pace = cur / pre
  }

  // 指定指標の「残月」補完額（方式別）
  const remainBy = (code: string, mode: ScenarioKey): number => {
    let s = 0
    for (let i = fy.lastFilledIndex + 1; i <= 11; i++) {
      const a = (prior ? getRow(prior, code)?.monthly[i] : 0) ?? 0
      if (mode === 'conservative') { s += a; continue }
      if (mode === 'optimistic') { s += a * (1 + optimisticPct / 100); continue }
      // standard: 前期・前々期 同月平均 × 今期ペース
      const b = prior2 ? getRow(prior2, code)?.monthly[i] : undefined
      const avg = b != null ? (a + b) / 2 : a
      s += avg * pace
    }
    return s
  }

  const make = (key: ScenarioKey, label: string): Landing => ({
    key, label,
    sales: ytdOf(CODES.sales) + remainBy(CODES.sales, key),
    opProfit: ytdOf(CODES.opProfit) + remainBy(CODES.opProfit, key),
    ordProfit: ytdOf(CODES.ordProfit) + remainBy(CODES.ordProfit, key),
  })

  return {
    partial: true,
    scenarios: [
      make('conservative', '保守（前年同月）'),
      make('standard', '標準（季節性×今期ペース）'),
      make('optimistic', `楽観（前年+${optimisticPct}%）`),
    ],
  }
}
