// 新報告書 v2 の共通コンテキスト。
//
// 画面（SectionReport2）と印刷（新規ウィンドウ）で紙面が1ドットもズレないよう、
// 「計算はここで1回だけ」「ページは ctx を並べるだけ」に分けている。
// 画面のスライダー（損益分岐点シミュレーション）を動かしたら ctx を作り直して
// 同じ関数でHTMLを組み直す ＝ 画面に見えている状態がそのまま印刷される。
import type { FiscalYearData } from '../types'
import { CODES, ytd } from '../calc'
import { computeCashFlow } from '../cashflow'
import {
  type ReportV2Context, type ReportV2Input, type ReportV2PageKey,
  REPORT_V2_PAGES, defaultBepSim, v2SettingsOf,
} from './types'
import { computeMonthlyPl } from './monthly-pl'
import { computeLanding } from './landing'
import { computeCorporateTax, computeVat } from './tax-forecast'
import { computeDailyCash } from './daily-cash'
import { computeBep2 } from './cvp2'
import { computeLoan } from './loan2'
import { computeLabor2 } from './labor2'
import { computeTrend3 } from './trend3'
import { cfPatternOf } from './cf-comment'

/** 会計期間の月インデックス → 暦の西暦年（期末月をまたぐ期に対応） */
export function calendarYearOf(fy: FiscalYearData, monthIdx: number): number {
  const m = fy.fiscalMonths[monthIdx] ?? fy.endMonth
  return m <= fy.endMonth ? fy.endYear : fy.endYear - 1
}

/** 期首・期末の日付ラベル（例 '2025年4月1日〜2026年3月31日'） */
export function fiscalPeriodLabel(fy: FiscalYearData): string {
  const startM = fy.endMonth === 12 ? 1 : fy.endMonth + 1
  const startY = fy.endMonth === 12 ? fy.endYear : fy.endYear - 1
  const lastDay = new Date(fy.endYear, fy.endMonth, 0).getDate()
  return `${startY}年${startM}月1日〜${fy.endYear}年${fy.endMonth}月${lastDay}日`
}

/** 入力からコンテキストを組み立てる（各計算モジュールを1回ずつ呼ぶ） */
export function buildReportV2Context(input: ReportV2Input): ReportV2Context {
  const { company, fy, prior, years, monthIdx, settings } = input
  const v2 = v2SettingsOf(settings, fy.id)
  const unit = input.unit ?? 'thousand'
  const sim = input.sim ?? defaultBepSim()
  const trendPaper = input.trendPaper ?? 'a4'
  const withCover = input.withCover !== false

  // 出力ページ（指定が無ければ全部）。'cover' は withCover で足す
  const body: ReportV2PageKey[] = (input.pages && input.pages.length
    ? REPORT_V2_PAGES.map(([k]) => k).filter((k) => input.pages!.includes(k))
    : REPORT_V2_PAGES.map(([k]) => k))
  const pages: ReportV2PageKey[] = withCover ? (['cover', ...body] as ReportV2PageKey[]) : body

  // フッターの通し番号（表紙を1として数える）
  const noMap = new Map<ReportV2PageKey, number>()
  pages.forEach((k, i) => noMap.set(k, i + 1))
  const pageNo = (k: ReportV2PageKey): number => noMap.get(k) ?? 0

  const monthsDone = monthIdx + 1
  const annualFactor = monthsDone > 0 ? 12 / monthsDone : 1

  const monthlyPl = computeMonthlyPl(fy, monthIdx)
  const landing = computeLanding(years, fy, prior, monthIdx)
  const corpTax = computeCorporateTax(landing, v2)
  const vat = computeVat(fy, prior, monthIdx, landing, v2)
  const daily = computeDailyCash(fy, prior, monthIdx, settings, v2)
  const bep = computeBep2(fy, prior, monthIdx, settings, landing, sim)
  const loan = computeLoan(fy, prior, monthIdx, settings)
  const labor = computeLabor2(years, fy, prior, monthIdx, v2)
  const trend3 = computeTrend3(years, fy, monthIdx)
  const cashflow = computeCashFlow(fy, prior, monthIdx)
  const sub = (key: 'op' | 'inv' | 'fin') => cashflow.sections.find((s) => s.key === key)?.subtotal ?? 0
  const cfPattern = cfPatternOf(sub('op'), sub('inv'), sub('fin'))

  const calYear = calendarYearOf(fy, monthIdx)
  const calMonth = fy.fiscalMonths[monthIdx] ?? fy.endMonth

  return {
    company, fy, prior, years, monthIdx, settings, v2, unit, sim, trendPaper,
    fyLabel: fy.label,
    monthLabel: `${calMonth}月`,
    periodLabel: fiscalPeriodLabel(fy),
    monthLabels: fy.fiscalMonths.map((m) => `${m}月`),
    ymLabel: `${calYear}年${calMonth}月度`,
    monthsDone, annualFactor,
    monthlyPl, landing, corpTax, vat, daily, bep, loan, labor, trend3, cashflow, cfPattern,
    pageNo, pages,
  }
}

/** リード文などで使う「当月単月」の主要値（PL） */
export function monthValues(fy: FiscalYearData, monthIdx: number) {
  const at = (code: string) => fy.rows.find((r) => r.code === code)?.monthly[monthIdx] ?? 0
  return {
    sales: at(CODES.sales),
    grossProfit: at(CODES.grossProfit),
    opProfit: at(CODES.opProfit),
    ordProfit: at(CODES.ordProfit),
    netProfit: at(CODES.netProfit),
    salesYtd: ytd(fy, CODES.sales, monthIdx),
    opProfitYtd: ytd(fy, CODES.opProfit, monthIdx),
  }
}
