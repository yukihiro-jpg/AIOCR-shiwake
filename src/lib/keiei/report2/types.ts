// 月次レポート（新報告書 v2）の型定義。
// A4横・黒＋シアン2色の10ページ構成。画面と印刷でまったく同じ紙面を出すため、
// 「計算＝このディレクトリの純関数」「描画＝pages.ts の文字列組立」に分けている。
//
// ここは全モジュール共通の契約（インターフェース）。実装ファイルはこの型に従う。
import type { FiscalYearData } from '../types'
import type { KeieiSettings } from '../analysis'

// ===== 単位 =====
/** 表示単位。既定は千円（社長向けに桁を減らす） */
export type Unit = 'thousand' | 'yen'

// ===== ページ =====
export type ReportV2PageKey =
  | 'cover'      // 表紙
  | 'monthlypl'  // 1 当事業年度の月次損益推移
  | 'trial'      // 2 単月の損益計算書・貸借対照表
  | 'landing'    // 2 着地見込と納税予測
  | 'cf'         // 3 キャッシュ・フロー計算書（間接法）
  | 'daily'      // 4 月次資金繰り表（日繰り）
  | 'bep'        // 5 損益分岐点売上高とシミュレーション
  | 'loan'       // 6 借入金とフリーキャッシュフロー
  | 'labor'      // 7 労働分配率と生産性
  | 'trend3'     // 8 損益計算書 3期推移（全科目）

/** 表紙の目次に出す並び順とタイトル（本文の通し番号もこの順） */
export const REPORT_V2_PAGES: [ReportV2PageKey, string][] = [
  ['monthlypl', '当事業年度の月次損益推移'],
  ['trial', '単月の損益計算書・貸借対照表'],
  ['landing', '着地見込と納税予測（法人税等・消費税）'],
  ['cf', 'キャッシュ・フロー計算書（間接法）'],
  ['daily', '月次資金繰り表（日繰り）'],
  ['bep', '損益分岐点売上高とシミュレーション'],
  ['loan', '借入金とフリーキャッシュフロー'],
  ['labor', '労働分配率・生産性'],
  ['trend3', '損益計算書 3期推移（全科目）'],
]

// ===== 設定（KeieiSettings.v2 に期ごとに保存する） =====
/** 必要最低残高の決め方。既定は月商の1/3（ユーザー合意済み） */
export type MinCashMode = 'third' | 'manual'

export interface ReportV2Settings {
  /** 従業員数（当期・期中平均） */
  employees?: number
  /** 前期の従業員数（1人当たり指標の比較用） */
  employeesPrior?: number
  /** 必要最低残高の決め方（既定 'third'＝月商の1/3） */
  minCashMode?: MinCashMode
  /** minCashMode='manual' のときの金額（円） */
  minCashManual?: number
  // --- 日繰りの入出金サイクル（既定値は defaultDailyCycle） ---
  /** 売掛の締日（1〜31。31＝末日） */
  recvCloseDay?: number
  /** 売掛の回収日（1〜31。31＝末日） */
  recvPayDay?: number
  /** 売掛の回収サイト（締めてから何か月後に入金されるか） */
  recvLagMonths?: number
  /** 買掛の締日 */
  payCloseDay?: number
  /** 買掛の支払日 */
  payPayDay?: number
  /** 買掛の支払サイト */
  payLagMonths?: number
  /** 給与支給日 */
  salaryDay?: number
  /** 社会保険・源泉所得税の納付日 */
  socialDay?: number
  /** カード・諸経費の口座振替日 */
  cardDay?: number
  /** 借入返済日 */
  loanDay?: number
  /** 中間納付済の法人税等（円）。納税予測の期末納付額から差し引く */
  taxPrepaid?: number
  /** 中間納付済・予定の消費税（円） */
  vatPrepaid?: number
  /** 消費税の課税方式 */
  vatMethod?: 'general' | 'simple' | 'exempt'
  /** 簡易課税のみなし仕入率（%）。vatMethod='simple' のとき使う */
  vatDeemedRate?: number
  /** 消費税率（%）。既定10 */
  vatRate?: number
}

/** 日繰りのサイクル既定値 */
export function defaultDailyCycle(): Required<Pick<ReportV2Settings,
  'recvCloseDay' | 'recvPayDay' | 'recvLagMonths' | 'payCloseDay' | 'payPayDay' | 'payLagMonths' |
  'salaryDay' | 'socialDay' | 'cardDay' | 'loanDay'>> {
  return {
    recvCloseDay: 31, recvPayDay: 31, recvLagMonths: 1,
    payCloseDay: 31, payPayDay: 31, payLagMonths: 1,
    salaryDay: 25, socialDay: 10, cardDay: 26, loanDay: 10,
  }
}

/** 期ごとの v2 設定を取り出す（未設定は空オブジェクト） */
export function v2SettingsOf(settings: KeieiSettings, yearId: string): ReportV2Settings {
  const all = (settings as KeieiSettings & { v2?: Record<string, ReportV2Settings> }).v2
  return (all && all[yearId]) || {}
}

// ===== 損益分岐点シミュレーション（画面で動かし、そのまま印刷する） =====
export interface BepSimState {
  /** 売上高の増減（%） */
  salesPct: number
  /** 売上総利益率の増減（pt） */
  marginPt: number
  /** 販管費の増減（円。マイナス＝削減） */
  sgnaDelta: number
}
export function defaultBepSim(): BepSimState {
  return { salesPct: 0, marginPt: 0, sgnaDelta: 0 }
}

// ===== 入力 =====
export interface ReportV2Input {
  company: string
  fy: FiscalYearData
  prior: FiscalYearData | null
  years: Record<string, FiscalYearData>
  monthIdx: number
  settings: KeieiSettings
  /** 出力ページ（省略＝全部） */
  pages?: ReportV2PageKey[]
  /** 表紙を付けるか（既定 true） */
  withCover?: boolean
  /** 金額の表示単位（既定 'thousand'） */
  unit?: Unit
  /** 3期推移PLの用紙（'a3' なら円単位でも12か月を1枚に収める） */
  trendPaper?: 'a4' | 'a3'
  /** 損益分岐点シミュレーションの状態（画面の操作をそのまま印刷へ） */
  sim?: BepSimState
  /** 画面プレビュー用（印刷ボタンの表示・body背景の切替） */
  preview?: boolean
}

// ===== 着地見込み =====
/** 着地見込みの1段（実績・A・B・A−B） */
export interface LandingRow {
  label: string
  /** 'plain' 通常 / 'key' シアン網 / 'total' 太罫 / 'sub' グレー網 / 'ind' 字下げ */
  kind: 'plain' | 'key' | 'total' | 'sub' | 'ind'
  actual: number
  a: number
  b: number
  /** 率の行（%表示・A−B は pt 表示） */
  isRate?: boolean
}

export interface LandingResult {
  /** 期中か（false＝通期確定。その場合 A/B は実績と同じ） */
  partial: boolean
  /** 実績の月数 */
  monthsDone: number
  /** 残り月数 */
  monthsLeft: number
  /** 残月のラベル（例 '12月〜3月'） */
  restLabel: string
  rows: LandingRow[]
  /** 主要値（リード文・他ページから参照） */
  salesA: number; salesB: number
  opA: number; opB: number
  ordA: number; ordB: number
  preTaxA: number; preTaxB: number
  /** 月次推移グラフ用（12か月ぶん。未確定月は null） */
  monthlySales: (number | null)[]
  monthlyNet: (number | null)[]
  /** 見込みの月次（12か月ぶん。実績月は null） */
  forecastSalesA: (number | null)[]
  forecastSalesB: (number | null)[]
  forecastNetA: (number | null)[]
  forecastNetB: (number | null)[]
  /** 通期の当期純利益（見込み） */
  netA: number; netB: number
}

// ===== 納税予測 =====
export interface TaxLine { label: string; amount: number; kind?: 'ind' | 'sub' | 'key' | 'total' }
export interface CorporateTaxForecast {
  /** 税引前当期純利益（見込） */
  preTax: number
  /** 加減算（見込） */
  adjustment: number
  /** 課税所得（見込） */
  taxableIncome: number
  lines: TaxLine[]
  /** 法人税等 合計 */
  total: number
  /** 中間納付済 */
  prepaid: number
  /** 期末の納付予定 */
  due: number
  /** 実効税率（%） */
  effectiveRate: number
}
export interface VatForecast {
  method: 'general' | 'simple' | 'exempt'
  lines: TaxLine[]
  /** 年間納付見込 */
  annual: number
  prepaid: number
  /** 確定申告時の納付 */
  due: number
  /** 推計が実績残高から取れたか（取れない場合は注記を強める） */
  estimated: boolean
}

// ===== 日繰り資金繰り =====
export interface DailyCashRow {
  day: number
  /** 曜日（'日'〜'土'） */
  dow: string
  income: number
  outgo: number
  balance: number
  /** 主な入出金の摘要 */
  note: string
  /** 必要最低残高を下回った日 */
  danger: boolean
  /** 月内の最低残高の日 */
  bottom: boolean
}
export interface DailyCashResult {
  /** 対象年月 */
  year: number; month: number
  daysInMonth: number
  opening: number
  closing: number
  incomeTotal: number
  outgoTotal: number
  minBalance: number
  minDay: number
  /** 必要最低残高 */
  minRequired: number
  /** 必要最低残高の決め方の説明（既定＝月商の1/3） */
  minRequiredNote: string
  /** 危険水域に入る日（連続していれば範囲で表示する材料） */
  dangerDays: number[]
  rows: DailyCashRow[]
  /** 実績から割り当てられたか（前月BSが無い等で推計になった場合 false） */
  reliable: boolean
}

// ===== 損益分岐点（年換算） =====
export interface BepSimRow {
  /** 表示記号（'—' '①' …） */
  mark: string
  label: string
  /** 変更幅の表示文字列 */
  deltaLabel: string
  opProfit: number
  /** 現状との差（現状行は null） */
  diff: number | null
  /** 損益分岐点比率（%） */
  bepRatio: number
  /** シアン網で強調 */
  highlight?: boolean
  /** 太罫の目標行 */
  goal?: boolean
}
export interface Bep2Result {
  /** 期首〜当月累計ベース */
  salesYtd: number; variableYtd: number; fixedYtd: number
  marginalYtd: number; marginalRate: number
  opProfitYtd: number
  bepYtd: number
  bepRatio: number      // %
  safetyRatio: number   // %
  /** 年換算ベース（図に使う） */
  annualFactor: number
  fixedAnnual: number
  bepAnnual: number
  /** いまの位置＝実績の年換算売上 */
  nowAnnual: number
  /** 着地見込Aの売上（図の右端の参考） */
  landingSales: number
  opAnnual: number
  /** 借入返済まで賄える売上高（年） */
  requiredSales: number
  requiredParts: { fixed: number; repay: number; tax: number; depreciation: number }
  /** シミュレーション表 */
  simRows: BepSimRow[]
  /** 画面スライダーの現在値を反映した結果（sim 指定時） */
  simOpProfit: number
  simBepRatio: number
}

// ===== 借入金とFCF =====
export interface LoanMonth { label: string; balance: number; repaySource: number | null; current: boolean }
export interface LoanResult {
  loanBal: number; leaseBal: number; interestBearing: number
  /** 年間返済額（元本＋リース） */
  annualRepay: number
  monthlyRepay: number
  /** 返済原資（税引後利益＋減価償却）YTD と年換算 */
  sourceYtd: number; sourceAnnual: number
  afterTaxYtd: number; afterTaxAnnual: number
  depYtd: number; depAnnual: number
  /** 返済後に残る資金 */
  restYtd: number; restAnnual: number
  /** 返済カバー率（倍） */
  coverage: number | null
  /** 債務償還年数 */
  payoffYears: number | null
  /** フリーCF（営業CF＋投資CF） */
  fcf: number
  operatingCf: number
  investingCf: number
  equityRatio: number
  months: LoanMonth[]
  /** 来期以降の返済予定（4期分） */
  schedule: { label: string; repay: number; closing: number }[]
}

// ===== 労働分配率・生産性 =====
export interface LaborRow { label: string; kind: 'plain' | 'ind' | 'sub' | 'key'; cur: number; pre: number | null; isRate?: boolean }
export interface Labor2Result {
  employees: number | null
  employeesPrior: number | null
  labor: number; gross: number; sales: number
  laborPrior: number | null; grossPrior: number | null; salesPrior: number | null
  share: number | null; sharePrior: number | null
  perSales: number | null; perSalesPrior: number | null
  perGross: number | null; perGrossPrior: number | null
  perLabor: number | null; perLaborPrior: number | null
  rows: LaborRow[]
  /** 月次の労働分配率（実績月ぶん） */
  monthly: { label: string; share: number | null }[]
  accounts: { name: string; cur: number; pre: number | null }[]
}

// ===== 当事業年度の月次損益推移 =====
export interface MonthlyPlRow {
  name: string
  kind: 'plain' | 'ind' | 'sub' | 'key' | 'total'
  /** 12か月の単月値。未入力月は null */
  monthly: (number | null)[]
  /** 期首〜報告月の累計 */
  cum: number
  /** 月平均（累計 ÷ 経過月数） */
  avg: number
  /** 対売上比（累計ベース・%）。売上0なら null */
  ratio: number | null
}
export interface MonthlyPlResult {
  months: number[]
  reportIdx: number
  rows: MonthlyPlRow[]
  /** 販管費の明細を「その他」へ丸めたか */
  condensed: boolean
  /** グラフ用（12か月・未入力は null） */
  salesSeries: (number | null)[]
  grossSeries: (number | null)[]
  opSeries: (number | null)[]
  /** リード文の材料 */
  bestIdx: number | null      // 売上が最も高かった月
  worstIdx: number | null     // 売上が最も低かった月
  lossMonths: number[]        // 営業赤字だった月のインデックス
  /** 直近3か月の売上平均 と それ以前の平均（傾向の判定用） */
  recentAvg: number | null
  earlierAvg: number | null
}

// ===== 3期推移PL =====
export interface Trend3Row {
  name: string
  kind: 'plain' | 'sub' | 'key'
  /** [当期, 前期, 前々期] の12か月。未入力は null */
  series: [(number | null)[], (number | null)[], (number | null)[]]
}
export interface Trend3Result {
  months: number[]      // 月の並び（例 [4,5,...,3]）
  reportIdx: number     // 報告月のインデックス
  rows: Trend3Row[]
  periodLabels: [string, string, string]
}

// ===== CFのパターンコメント =====
export interface CfPattern {
  /** 例 '+−+' */
  sign: string
  /** 短い型名（例「前向きな拡大」） */
  title: string
  /** 本文コメント */
  body: string
}

// ===== 全ページ共通のコンテキスト =====
// context.ts の buildReportV2Context() が1回だけ計算して各ページへ渡す。
// ページ側は「計算しない・ctx の値を並べるだけ」にして、画面と印刷のズレを無くす。
import type { CashFlowResult } from '../cashflow'

export interface ReportV2Context {
  // --- 入力 ---
  company: string
  fy: FiscalYearData
  prior: FiscalYearData | null
  years: Record<string, FiscalYearData>
  monthIdx: number
  settings: KeieiSettings
  v2: ReportV2Settings
  unit: Unit
  sim: BepSimState
  trendPaper: 'a4' | 'a3'
  // --- 表示用ラベル ---
  fyLabel: string          // 例 '令和8年3月期'
  monthLabel: string       // 例 '11月'
  periodLabel: string      // 例 '2025年4月1日〜2026年3月31日'
  monthLabels: string[]    // ['4月', …, '3月']
  ymLabel: string          // 例 '2025年11月度'
  monthsDone: number       // 経過月数
  annualFactor: number     // 12 / monthsDone
  // --- 計算結果 ---
  monthlyPl: MonthlyPlResult
  landing: LandingResult
  corpTax: CorporateTaxForecast
  vat: VatForecast
  daily: DailyCashResult
  bep: Bep2Result
  loan: LoanResult
  labor: Labor2Result
  trend3: Trend3Result
  cashflow: CashFlowResult
  cfPattern: CfPattern
  // --- ページ番号（表紙の目次と本文で一致させる） ---
  pageNo: (key: ReportV2PageKey) => number
  /** 出力対象ページ */
  pages: ReportV2PageKey[]
}
