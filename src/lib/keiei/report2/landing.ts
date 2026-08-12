// 新報告書 v2 ── 着地見込み（P3 左の「通期の着地見込み」表 ＋ 下段の月次推移グラフ）。
//
// 設計の意図（なぜこうしたか）:
// - 旧レポートは「前年同月／前期・前々期の同月平均×今期ペース／前年同月+5%」の3シナリオだったが、
//   社長が見るときに「どれを信じればいいのか」が決まらなかった。そこで
//   **A＝当期平均（いまのペースが続いたら）／B＝前期実績（去年と同じ季節変動なら）** の2本だけに絞り、
//   両方を並べて差額（A−B）まで見せる形にした。どちらも「当月までの実績はそのまま使う」ので、
//   見込みで動くのは残り月だけ＝説明しやすい。
// - 段階は9段（売上高→売上総利益→販管費→営業利益→経常利益→税引前）。
//   途中に率（売上総利益率）と内数（うち人件費）を挟み、「売上が伸びたのに利益が出ない」理由が
//   1つの表の中で追えるようにしている。
// - 金額はすべて **円** のまま返す（表示単位の変換は theme.ts の amt()/toUnit() の仕事）。
// - データが無いとき（行が無い・前期が無い・期首月しか入っていない）でも例外は投げない。
//   0 を返して呼び出し側が「—」を出せるようにする。
import type { FiscalYearData } from '../types'
import { CODES, getRow, findPriorYear } from '../calc'
import { detailsOf } from '../analysis'
import { effectiveTaxRate } from '../tax'
import type { LandingResult, LandingRow } from './types'

/** 1期＝12か月固定（会計大将の月次推移CSVが12列） */
const M = 12

// 人件費とみなす科目名。issues.ts の LABOR_RE と**同じ判定**にしている
// （あちらは export されていないため、同等の正規表現をここに置いた。
//   片方だけ直すと労働分配率ページ（P8）と数字がずれるので、変更時は必ず両方を揃えること）。
const LABOR_RE = /役員報酬|役員賞与|給料|給与|賃金|賞与|雑給|法定福利|福利厚生|退職金|退職給付|人件費|労務費|専従者給与/

// ===== 12か月の単月値を取り出す =====

/** 指定コードの単月値12か月ぶん。行が無ければ0埋め（欠損でも落とさない） */
function codeSeries(fy: FiscalYearData, code: string): number[] {
  const out = new Array<number>(M).fill(0)
  const r = getRow(fy, code)
  if (!r) return out
  for (let i = 0; i < M; i++) out[i] = r.monthly[i] ?? 0
  return out
}

function diffSeries(a: number[], b: number[]): number[] {
  const out = new Array<number>(M).fill(0)
  for (let i = 0; i < M; i++) out[i] = (a[i] ?? 0) - (b[i] ?? 0)
  return out
}

/**
 * 人件費（単月12か月）。
 * この行は表の「販管費合計」の直下に置く**内数**なので、拾うのは販管費の明細だけにしている
 * （労働分配率ページは売上原価の労務費も含めた総人件費を使う。あちらは分配率の分子として
 *   総額で見るのが実務の慣行で、こちらは「販管費のうち」を示す行なので範囲が違う）。
 */
function laborSeries(fy: FiscalYearData): number[] {
  const out = new Array<number>(M).fill(0)
  for (const a of detailsOf(fy, CODES.sgna)) {
    if (!LABOR_RE.test(a.name)) continue
    for (let i = 0; i < M; i++) out[i] += a.monthly[i] ?? 0
  }
  return out
}

/** 着地見込みで使う段階利益の単月系列一式 */
interface Series {
  sales: number[]
  gross: number[]
  sgna: number[]
  labor: number[]
  op: number[]
  nonOp: number[]
  ord: number[]
  special: number[]
  preTax: number[]
  net: number[]
}

function seriesOf(fy: FiscalYearData): Series {
  const sales = codeSeries(fy, CODES.sales)
  const gross = codeSeries(fy, CODES.grossProfit)
  const sgna = codeSeries(fy, CODES.sgna)
  const op = codeSeries(fy, CODES.opProfit)
  const ord = codeSeries(fy, CODES.ordProfit)
  const preTax = codeSeries(fy, CODES.preTax)
  return {
    sales, gross, sgna, op, ord, preTax,
    labor: laborSeries(fy),
    // 営業外損益＝営業外収益−営業外費用（1行にまとめて表示する）
    nonOp: diffSeries(codeSeries(fy, CODES.nonOpIncome), codeSeries(fy, CODES.nonOpExpense)),
    // 特別損益＝税引前当期純利益−経常利益（特別利益・特別損失の小計コードは
    //   ソフト・会社によって出ない期があるため、差額で取るほうが確実）
    special: diffSeries(preTax, ord),
    net: codeSeries(fy, CODES.netProfit),
  }
}

function sumTo(a: number[], last: number): number {
  let s = 0
  for (let i = 0; i <= last; i++) s += a[i] ?? 0
  return s
}

/** 期の i 番目の月（1〜12）。fiscalMonths が欠けている取込データでも期末月から逆算する */
function monthNoOf(fy: FiscalYearData, i: number): number {
  const m = fy.fiscalMonths?.[i]
  if (m && m >= 1 && m <= 12) return m
  return (((fy.endMonth - 1 - (M - 1 - i)) % M) + M) % M + 1
}

const rateOf = (part: number, sales: number): number => (sales ? (part / sales) * 100 : 0)

// ===== 本体 =====

export function computeLanding(
  years: Record<string, FiscalYearData>,
  fy: FiscalYearData,
  prior: FiscalYearData | null,
  monthIdx: number,
): LandingResult {
  const idx = Math.max(0, Math.min(M - 1, Math.floor(monthIdx) || 0))
  const monthsDone = idx + 1
  const monthsLeft = M - 1 - idx
  // 通期確定＝12か月すべて入力済み かつ 報告月が期末月。このときA・Bは実績そのもの
  const partial = !(fy.lastFilledIndex >= M - 1 && idx >= M - 1)

  // 前期は呼び出し側から渡してもらうが、渡されなかったときは同じ期末月の1年前を自分で探す
  // （B＝前期実績 が黙って A と同じ値になるのを避けるため）
  const pre = prior || findPriorYear(years, fy)
  const preLast = pre ? pre.lastFilledIndex : -1
  const cur = seriesOf(fy)
  const preS = pre ? seriesOf(pre) : null
  /** 前期の同じ月インデックスが実績として使えるか（未入力月は当期平均で代替する） */
  const preHas = (i: number): boolean => !!preS && i <= preLast

  interface Fc { actual: number; avg: number; a: number; b: number }
  /** 実績（期首〜idx累計）と、残り月をA・Bで埋めた通期見込み */
  const calc = (key: keyof Series): Fc => {
    const c = cur[key]
    const actual = sumTo(c, idx)
    const avg = actual / monthsDone
    let b = actual
    for (let i = idx + 1; i < M; i++) b += preHas(i) ? (preS as Series)[key][i] ?? 0 : avg
    return { actual, avg, a: actual + avg * monthsLeft, b }
  }

  const sales = calc('sales')
  const gross = calc('gross')
  const sgna = calc('sgna')
  const labor = calc('labor')
  const op = calc('op')
  const nonOp = calc('nonOp')
  const ord = calc('ord')
  const special = calc('special')
  const preTax = calc('preTax')
  const net = calc('net')

  const row = (label: string, kind: LandingRow['kind'], f: Fc): LandingRow =>
    ({ label, kind, actual: f.actual, a: f.a, b: f.b })

  const rows: LandingRow[] = [
    row('売上高', 'plain', sales),
    row('売上総利益', 'key', gross),
    {
      label: '（売上総利益率）', kind: 'ind', isRate: true,
      actual: rateOf(gross.actual, sales.actual),
      a: rateOf(gross.a, sales.a),
      b: rateOf(gross.b, sales.b),
    },
    row('販管費合計', 'plain', sgna),
    row('うち人件費', 'ind', labor),
    row('営業利益', 'key', op),
    row('営業外損益', 'plain', nonOp),
    row('経常利益', 'key', ord),
    row('特別損益', 'plain', special),
    row('税引前当期純利益', 'total', preTax),
  ]

  // 当期純利益の見込みは「税引前 × (1−実効税率)」。期中の実績月は税金がまだ計上されていない
  // ことが多いので、通期の税負担を見込みで乗せる（実効税率は所得階層に応じた概算：tax.ts）
  const taxRateA = effectiveTaxRate(preTax.a)
  const taxRateB = effectiveTaxRate(preTax.b)
  const netA = partial ? preTax.a * (1 - taxRateA) : net.actual
  const netB = partial ? preTax.b * (1 - taxRateB) : net.actual

  // ===== グラフ用の月次配列 =====
  // 実績月＝値／未確定月＝null。見込みの配列は逆に実績月を null にするが、
  // 折れ線・棒がつながって見えるよう**最後の実績月にだけ実績値**を入れて起点にする。
  const monthlySales: (number | null)[] = new Array(M).fill(null)
  const monthlyNet: (number | null)[] = new Array(M).fill(null)
  for (let i = 0; i <= idx; i++) {
    monthlySales[i] = cur.sales[i] ?? 0
    monthlyNet[i] = cur.net[i] ?? 0
  }

  const forecastSalesA: (number | null)[] = new Array(M).fill(null)
  const forecastSalesB: (number | null)[] = new Array(M).fill(null)
  const forecastNetA: (number | null)[] = new Array(M).fill(null)
  const forecastNetB: (number | null)[] = new Array(M).fill(null)
  if (monthsLeft > 0) {
    forecastSalesA[idx] = monthlySales[idx]
    forecastSalesB[idx] = monthlySales[idx]
    forecastNetA[idx] = monthlyNet[idx]
    forecastNetB[idx] = monthlyNet[idx]
    for (let i = idx + 1; i < M; i++) {
      const useP = preHas(i)
      forecastSalesA[i] = sales.avg
      forecastSalesB[i] = useP ? (preS as Series).sales[i] ?? 0 : sales.avg
      // 見込み月の純利益＝その月の税引前見込み×(1−実効税率)。
      // 「通期見込−実績累計」を残月に押し込むと期末に税金がまとめて乗って線が急落し、
      // 月々の稼ぐ力が読めなくなるため、月ごとに同じ税率を掛ける形にした
      const pA = preTax.avg
      const pB = useP ? (preS as Series).preTax[i] ?? 0 : preTax.avg
      forecastNetA[i] = pA * (1 - taxRateA)
      forecastNetB[i] = pB * (1 - taxRateB)
    }
  }

  return {
    partial,
    monthsDone,
    monthsLeft,
    restLabel: monthsLeft > 0 ? `${monthNoOf(fy, idx + 1)}月〜${monthNoOf(fy, M - 1)}月` : '',
    rows,
    salesA: sales.a, salesB: sales.b,
    opA: op.a, opB: op.b,
    ordA: ord.a, ordB: ord.b,
    preTaxA: preTax.a, preTaxB: preTax.b,
    monthlySales, monthlyNet,
    forecastSalesA, forecastSalesB, forecastNetA, forecastNetB,
    netA, netB,
  }
}
