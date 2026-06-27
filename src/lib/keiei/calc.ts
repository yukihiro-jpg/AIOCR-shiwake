import type { FiscalYearData } from './types'

// 会計大将の標準小計コード
export const CODES = {
  sales: '9534', // 純売上高
  cogs: '9577', // 売上原価
  grossProfit: '9578', // 売上総利益
  sgna: '9579', // 販売費及び一般管理費
  opProfit: '9580', // 営業利益
  nonOpIncome: '9550', // 営業外収益
  nonOpExpense: '9552', // 営業外費用
  ordProfit: '9581', // 経常利益
  preTax: '9582', // 税引前当期純利益
  netProfit: '9583', // 当期純利益
  // BS
  assetTotal: '9568', // 資産の部
  currentAsset: '9566', // 流動資産
  fixedAsset: '9567', // 固定資産
  cash: '9564', // 現金及び預金
  currentLiab: '9527', // 流動負債
  fixedLiab: '9529', // 固定負債
  liabTotal: '9569', // 負債の部
  netAsset: '9573', // 純資産の部
} as const

export function getRow(fy: FiscalYearData, code: string) {
  return fy.rows.find((r) => r.code === code)
}

/** 単月値: PLはその月の発生額、BSはその月末残高 */
export function singleMonth(fy: FiscalYearData, code: string, monthIdx: number): number {
  const r = getRow(fy, code)
  if (!r) return 0
  return r.monthly[monthIdx] ?? 0
}

/** 累計値: PLは期首からの累計、BSはその月末残高（ストックなので累計=残高） */
export function ytd(fy: FiscalYearData, code: string, monthIdx: number): number {
  const r = getRow(fy, code)
  if (!r) return 0
  if (r.statement === 'BS') return r.monthly[monthIdx] ?? 0
  let s = 0
  for (let i = 0; i <= monthIdx; i++) s += r.monthly[i] ?? 0
  return s
}

export interface PlKpis {
  sales: number
  cogs: number
  grossProfit: number
  sgna: number
  opProfit: number
  ordProfit: number
  netProfit: number
  grossMargin: number // %
  opMargin: number // %
  ordMargin: number // %
}

function margin(part: number, sales: number): number {
  if (!sales) return 0
  return (part / sales) * 100
}

/** 指定月の単月PL指標 */
export function plKpisSingle(fy: FiscalYearData, monthIdx: number): PlKpis {
  const sales = singleMonth(fy, CODES.sales, monthIdx)
  const grossProfit = singleMonth(fy, CODES.grossProfit, monthIdx)
  const opProfit = singleMonth(fy, CODES.opProfit, monthIdx)
  const ordProfit = singleMonth(fy, CODES.ordProfit, monthIdx)
  return {
    sales,
    cogs: singleMonth(fy, CODES.cogs, monthIdx),
    grossProfit,
    sgna: singleMonth(fy, CODES.sgna, monthIdx),
    opProfit,
    ordProfit,
    netProfit: singleMonth(fy, CODES.netProfit, monthIdx),
    grossMargin: margin(grossProfit, sales),
    opMargin: margin(opProfit, sales),
    ordMargin: margin(ordProfit, sales),
  }
}

/** 期首からの累計PL指標 */
export function plKpisYtd(fy: FiscalYearData, monthIdx: number): PlKpis {
  const sales = ytd(fy, CODES.sales, monthIdx)
  const grossProfit = ytd(fy, CODES.grossProfit, monthIdx)
  const opProfit = ytd(fy, CODES.opProfit, monthIdx)
  const ordProfit = ytd(fy, CODES.ordProfit, monthIdx)
  return {
    sales,
    cogs: ytd(fy, CODES.cogs, monthIdx),
    grossProfit,
    sgna: ytd(fy, CODES.sgna, monthIdx),
    opProfit,
    ordProfit,
    netProfit: ytd(fy, CODES.netProfit, monthIdx),
    grossMargin: margin(grossProfit, sales),
    opMargin: margin(opProfit, sales),
    ordMargin: margin(ordProfit, sales),
  }
}

/** 並び替え済みの年度配列（古い→新しい） */
export function sortedYears(years: Record<string, FiscalYearData>): FiscalYearData[] {
  return Object.values(years).sort((a, b) => (a.endYear * 12 + a.endMonth) - (b.endYear * 12 + b.endMonth))
}

/** 指定年度の「前年同期」（同じ期末月で1年前）を探す */
export function findPriorYear(
  years: Record<string, FiscalYearData>,
  fy: FiscalYearData,
): FiscalYearData | null {
  const priorId = `${fy.endYear - 1}-${String(fy.endMonth).padStart(2, '0')}`
  return years[priorId] || null
}

/** 前年比(%)。前年が0なら null */
export function yoy(current: number, prior: number): number | null {
  if (!prior) return null
  return ((current - prior) / Math.abs(prior)) * 100
}
