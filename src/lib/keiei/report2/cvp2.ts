// 新報告書 v2 ── 損益分岐点（P6「損益分岐点売上高とシミュレーション」）。
//
// 設計の意図（なぜこうしたか）:
// - 表と図で**基準がずれない**ようにするため、この1関数で「累計ベース」と「年換算ベース」の
//   両方をまとめて返す。左下の計算表は期首〜当月の累計（社長が見慣れている試算表と一致する）、
//   上の損益分岐点図は年換算（1年分の固定費と比べないと分岐点の位置が実感と合わない）。
//   どちらを使うかをページ側で迷わせないよう、フィールド名に Ytd / Annual を付けている。
// - 変動費・固定費の分類は既存の設定（KeieiSettings.varfix）をそのまま尊重する。
//   ここで分類しなおすと、既存の「損益分岐点」タブと数字が食い違って問い合わせになるため、
//   analysis.ts の cvp() を**そのまま**呼ぶ（再実装しない）。
// - 「返済まで賄える売上高」は、損益分岐点（＝利益ゼロ）では借入返済ができないという実務の指摘に
//   応えるための行。利益ゼロではなく「固定費＋年間返済＋納税−減価償却」を回収できる売上高を出す
//   （減価償却は現金が出ていかないので差し引く）。
// - シミュレーションは**年換算・着地見込Aベース**で計算する。累計ベースだと「あと4か月で
//   売上5%増」の話なのか「1年で5%増」の話なのかが読み手に伝わらないため、通期の姿で揃えた。
// - 金額はすべて **円** のまま返す（表示単位の変換は theme.ts の amt()/toUnit() の仕事）。
//   例外は simRows[].deltaLabel だけで、ここは型が文字列なのでこのファイルで整形する（下記参照）。
// - データが無いとき（売上0・限界利益率0以下・前期なし）でも例外は投げない。0 を返して
//   呼び出し側が「—」を出せるようにする。
import type { FiscalYearData } from '../types'
import { cvp, depreciationYtd, type KeieiSettings } from '../analysis'
import { effectiveTaxRate } from '../tax'
import type { BepSimRow, BepSimState, Bep2Result, LandingResult } from './types'

/** 1期＝12か月固定（会計大将の月次推移CSVが12列） */
const M = 12

/**
 * シミュレーション1行に「削減額の生数値（円）」を足した型。
 * Bep2Result.simRows の型（BepSimRow）は表示用の deltaLabel しか持たないが、
 * 画面で単位を「円」に切り替えたときに列の単位を揃えたいことがあるので、
 * 円のままの数値も同じ行に載せておく（型は互換なのでそのまま simRows に入る）。
 */
export interface BepSimRowEx extends BepSimRow {
  /** 固定費の削減額（円・正の値）。削減行以外は undefined */
  deltaAmount?: number
}

// ===== シミュレーションの刻み（紙面の①〜⑤に対応。変えると紙面の文言も変わる） =====
/** ① 売上高の増加率（%） */
const SALES_UP_PCT = 5
/** ② 売上総利益率（＝限界利益率）の改善幅（pt） */
const MARGIN_UP_PT = 1
/** ③ 販管費（固定費）の削減率 */
const FIXED_CUT_1 = 0.01
/** ④ 人件費以外の販管費の削減率（③より一段踏み込んだ想定） */
const FIXED_CUT_2 = 0.02

const fin = (n: number): number => (isFinite(n) ? n : 0)

/**
 * 固定費の削減額ラベル（例「△1,800千円」）。
 * この列だけは型が文字列なので、表示単位を知らないこのファイルで整形せざるを得ない。
 * 単位語を省くと「円」表示のときに1000倍ずれて見えるため、**千円ぐるみで表記する**
 * （生数値は deltaAmount に円で入れてあるので、ページ側で amt() に流し直してもよい）。
 */
function cutLabel(yen: number): string {
  const v = Math.round(Math.abs(yen) / 1000)
  return `△${v.toLocaleString('en-US')}千円`
}

/** 損益分岐点比率（%）＝（固定費 ÷ 限界利益率）÷ 売上高 × 100。成り立たないときは0 */
function bepRatioOf(sales: number, marginalRate: number, fixed: number): number {
  if (marginalRate <= 0 || sales <= 0) return 0
  return fin(((fixed / marginalRate) / sales) * 100)
}

/** シミュレーション1行を組み立てる（営業利益＝売上×限界利益率−固定費） */
function simRow(
  mark: string, label: string, deltaLabel: string,
  sales: number, marginalRate: number, fixed: number,
  base: number | null,
  opts?: { highlight?: boolean; goal?: boolean; deltaAmount?: number },
): BepSimRowEx {
  const opProfit = fin(sales * marginalRate - fixed)
  return {
    mark, label, deltaLabel,
    opProfit,
    diff: base == null ? null : fin(opProfit - base),
    bepRatio: bepRatioOf(sales, marginalRate, fixed),
    ...(opts?.highlight ? { highlight: true } : {}),
    ...(opts?.goal ? { goal: true } : {}),
    ...(opts?.deltaAmount != null ? { deltaAmount: opts.deltaAmount } : {}),
  }
}

// ===== 本体 =====

/**
 * 損益分岐点（累計＋年換算）とシミュレーション表を作る。
 * @param prior 前期（現状この計算では使わないが、他ページと引数の並びを揃えるため受け取る）
 * @param landing 着地見込み（シミュレーションの基準売上＝A案を使う）
 * @param sim 画面スライダーの現在値（そのまま印刷へ反映する）
 */
export function computeBep2(
  fy: FiscalYearData,
  prior: FiscalYearData | null,
  monthIdx: number,
  settings: KeieiSettings,
  landing: LandingResult,
  sim: BepSimState,
): Bep2Result {
  const idx = Math.max(0, Math.min(M - 1, Math.floor(monthIdx) || 0))
  const annualFactor = M / (idx + 1)

  // ===== 累計ベース（左下の「損益分岐点の計算」表） =====
  // 変動費／固定費の分類は既存設定どおり（cvp を再実装しない）
  const c = cvp(fy, idx, settings)
  const salesYtd = fin(c.sales)
  const variableYtd = fin(c.variable)
  const fixedYtd = fin(c.fixed)
  const marginalYtd = fin(c.marginal)
  const marginalRate = fin(c.marginalRate)
  const opProfitYtd = fin(c.opProfit)
  // 限界利益率が0以下（売上より変動費が大きい）のときは分岐点が定義できない。
  // cvp() は負の値を返すが、紙面に負の「損益分岐点売上高」を出すと図も文章も破綻するので0にする
  const bepYtd = marginalRate > 0 ? fin(c.bep) : 0
  const bepRatio = salesYtd > 0 ? fin((bepYtd / salesYtd) * 100) : 0
  const safetyRatio = salesYtd > 0 ? 100 - bepRatio : 0

  // ===== 年換算ベース（上の損益分岐点図） =====
  const fixedAnnual = fixedYtd * annualFactor
  const bepAnnual = marginalRate > 0 ? fin(fixedAnnual / marginalRate) : 0
  const nowAnnual = salesYtd * annualFactor            // ★＝いまのペースが1年続いたときの売上
  const landingSales = fin(landing?.salesA ?? 0)       // 着地見込A（図の右端の参考・シミュレーションの基準）
  const opAnnual = fin(nowAnnual * marginalRate - fixedAnnual)

  // ===== 借入返済まで賄える売上高 =====
  // （年間固定費 ＋ 年間返済 ＋ 納税見込 − 減価償却）÷ 限界利益率
  const repayMonthly =
    (settings.repayLoanMonthly?.[fy.id] ?? 0) + (settings.repayLeaseMonthly?.[fy.id] ?? 0)
  const repayAnnual = fin(repayMonthly * M)
  // 納税見込は年換算の営業利益に概算実効税率を掛けた概算（赤字なら0）。
  // 正確な税額は納税予測ページ（P3）で出すので、ここは「返済に加えて要る現金」の目安に留める
  const taxAnnual = Math.max(0, fin(opAnnual * effectiveTaxRate(opAnnual)))
  // 減価償却は現金が出ていかない費用なので、必要売上高からは差し引く
  const depAnnual = fin(depreciationYtd(fy, idx) * annualFactor)
  const requiredParts = { fixed: fixedAnnual, repay: repayAnnual, tax: taxAnnual, depreciation: depAnnual }
  const requiredNeed = fixedAnnual + repayAnnual + taxAnnual - depAnnual
  const requiredSales = marginalRate > 0 ? Math.max(0, fin(requiredNeed / marginalRate)) : 0

  // ===== シミュレーション表（年換算・着地見込Aベース） =====
  const baseSales = landingSales
  const baseMarginalRate = marginalRate
  const baseFixed = fixedAnnual
  const base = fin(baseSales * baseMarginalRate - baseFixed)

  const cut1 = baseFixed * FIXED_CUT_1
  const cut2 = baseFixed * FIXED_CUT_2

  const simRows: BepSimRow[] = [
    simRow('—', '現状（着地見込 A）', '—', baseSales, baseMarginalRate, baseFixed, null),
    simRow('①', '売上高を増やす', `＋${SALES_UP_PCT.toFixed(1)}%`,
      baseSales * (1 + SALES_UP_PCT / 100), baseMarginalRate, baseFixed, base),
    simRow('②', '売上総利益率を上げる', `＋${MARGIN_UP_PT.toFixed(1)}pt`,
      baseSales, baseMarginalRate + MARGIN_UP_PT / 100, baseFixed, base),
    simRow('③', '販管費を減らす', cutLabel(cut1),
      baseSales, baseMarginalRate, baseFixed - cut1, base, { deltaAmount: cut1 }),
    simRow('④', '人件費以外の販管費を減らす', cutLabel(cut2),
      baseSales, baseMarginalRate, baseFixed - cut2, base, { deltaAmount: cut2 }),
    // ⑤は①②③の同時実施（④は③を含む想定なので重ねない）
    simRow('⑤', '①＋②＋③を同時に実施', '—',
      baseSales * (1 + SALES_UP_PCT / 100), baseMarginalRate + MARGIN_UP_PT / 100, baseFixed - cut1,
      base, { highlight: true }),
    // 目標行は「返済・納税まで賄える売上高」を達成したときの姿。
    // 差は「達成のために増やす利益」ではなく現状との差額なので、null ではなく実数を入れる
    simRow('目標', '返済・納税を賄える水準', '—',
      requiredSales, baseMarginalRate, baseFixed, base, { goal: true }),
  ]

  // ===== 画面スライダーの反映（動かした状態がそのまま印刷される） =====
  const simSales = baseSales * (1 + fin(sim?.salesPct ?? 0) / 100)
  const simRate = baseMarginalRate + fin(sim?.marginPt ?? 0) / 100
  const simFixed = baseFixed + fin(sim?.sgnaDelta ?? 0)
  const simOpProfit = fin(simSales * simRate - simFixed)
  const simBepRatio = bepRatioOf(simSales, simRate, simFixed)

  return {
    salesYtd, variableYtd, fixedYtd,
    marginalYtd, marginalRate,
    opProfitYtd,
    bepYtd, bepRatio, safetyRatio,
    annualFactor, fixedAnnual, bepAnnual,
    nowAnnual, landingSales, opAnnual,
    requiredSales, requiredParts,
    simRows,
    simOpProfit, simBepRatio,
  }
}
