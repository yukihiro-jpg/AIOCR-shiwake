// 簡易予算の作成補助と予実対比。
// 予算は「通期の売上高・粗利率・販管費」の3値だけで作り、営業利益は導出する（社長でも作れる簡易版）。
// 予実対比は、売上・粗利は前年の季節性で、固定費（販管費）は月数按分でYTD予算を割り付ける。

import type { FiscalYearData } from './types'
import { CODES, getRow, plKpisYtd, findPriorYear } from './calc'
import { landingScenarios, type YearBudget } from './analysis'

/** 前年実績から予算の初期値を提案（売上・粗利率・販管費）。前年が無ければ当期実績を年換算 */
export function suggestBudget(years: Record<string, FiscalYearData>, fy: FiscalYearData): YearBudget {
  const prior = findPriorYear(years, fy)
  const src = prior || fy
  const idx = src.lastFilledIndex
  const months = idx + 1
  const annualize = prior ? 1 : 12 / months
  const sales = rowYtd(src, CODES.sales, idx) * annualize
  const cogs = rowYtd(src, CODES.cogs, idx) * annualize
  const gross = sales - cogs
  const grossMargin = sales ? (gross / sales) * 100 : 0
  const sgna = rowYtd(src, CODES.sgna, idx) * annualize
  return {
    sales: Math.round(sales),
    grossMargin: Number(grossMargin.toFixed(1)),
    sgna: Math.round(sgna),
  }
}

function rowYtd(fy: FiscalYearData, code: string, monthIdx: number): number {
  const r = getRow(fy, code)
  if (!r) return 0
  let s = 0
  for (let i = 0; i <= monthIdx; i++) s += r.monthly[i] ?? 0
  return s
}

/** 前年の月次売上構成比（12ヶ月・合計1）。前年が無い/売上0なら均等配分 */
function seasonality(years: Record<string, FiscalYearData>, fy: FiscalYearData): number[] {
  const prior = findPriorYear(years, fy)
  const even = Array.from({ length: 12 }, () => 1 / 12)
  if (!prior) return even
  const r = getRow(prior, CODES.sales)
  if (!r) return even
  const m = Array.from({ length: 12 }, (_, i) => Math.max(0, r.monthly[i] ?? 0))
  const total = m.reduce((a, b) => a + b, 0)
  if (total <= 0) return even
  return m.map((v) => v / total)
}

export interface BudgetLine {
  label: string
  budgetYtd: number
  actualYtd: number
  achieveYtd: number | null // 達成率（%）
  budgetFull: number
  landingFull: number | null // 通期着地見込み（標準シナリオ）
}

export interface BudgetVsActual {
  months: number
  cumSalesRatio: number // 期首〜選択月の売上季節性の累計比率
  lines: BudgetLine[]
  opBudgetFull: number
  hasPriorSeason: boolean
}

/** 予実対比（期首〜monthIdx累計）＋通期着地との比較 */
export function budgetVsActual(
  years: Record<string, FiscalYearData>,
  fy: FiscalYearData,
  monthIdx: number,
  budget: YearBudget,
): BudgetVsActual {
  const months = monthIdx + 1
  const season = seasonality(years, fy)
  const hasPriorSeason = !!findPriorYear(years, fy)
  const cumSalesRatio = season.slice(0, months).reduce((a, b) => a + b, 0)
  const monthRatio = months / 12

  const salesFull = budget.sales
  const grossFull = budget.sales * (budget.grossMargin / 100)
  const sgnaFull = budget.sgna
  const opBudgetFull = grossFull - sgnaFull

  // YTD予算：売上・粗利は季節性、固定費（販管費）は月数按分
  const salesBudgetYtd = salesFull * cumSalesRatio
  const grossBudgetYtd = grossFull * cumSalesRatio
  const sgnaBudgetYtd = sgnaFull * monthRatio
  const opBudgetYtd = grossBudgetYtd - sgnaBudgetYtd

  const act = plKpisYtd(fy, monthIdx)

  // 通期着地（標準シナリオ）
  const land = landingScenarios(years, fy)
  const std = land.scenarios.find((x) => x.key === 'standard') || land.scenarios[0]
  const salesLanding = std ? std.sales : null
  const opLanding = std ? std.opProfit : null

  const rate = (a: number, b: number): number | null => (b === 0 ? null : (a / b) * 100)

  const lines: BudgetLine[] = [
    { label: '売上高', budgetYtd: salesBudgetYtd, actualYtd: act.sales, achieveYtd: rate(act.sales, salesBudgetYtd), budgetFull: salesFull, landingFull: salesLanding },
    { label: '売上総利益(粗利)', budgetYtd: grossBudgetYtd, actualYtd: act.grossProfit, achieveYtd: rate(act.grossProfit, grossBudgetYtd), budgetFull: grossFull, landingFull: null },
    { label: '営業利益', budgetYtd: opBudgetYtd, actualYtd: act.opProfit, achieveYtd: rate(act.opProfit, opBudgetYtd), budgetFull: opBudgetFull, landingFull: opLanding },
  ]

  return { months, cumSalesRatio, lines, opBudgetFull, hasPriorSeason }
}
