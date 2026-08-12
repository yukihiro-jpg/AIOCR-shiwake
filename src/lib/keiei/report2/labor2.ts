// 新報告書 v2 ── 労働分配率と生産性（P8「労働分配率と生産性」）。
//
// 設計の意図（なぜこうしたか）:
// - 人件費とみなす科目の判定は issues.ts の laborShare() を**そのまま**使う。ここで科目名の
//   判定を書き直すと、既存の「経営課題」タブの労働分配率と数字が食い違い、同じ事務所が出す
//   資料の中に2つの分配率が並んでしまうため（対象科目を変えたいときは issues.ts 側を直す）。
// - 前期ぶんは laborShare() を prior に対してもう一度呼ぶ。issues.ts の LaborResult は前期の
//   「率」しか持たず、紙面の内訳表に必要な「前期の科目別金額」が取れないため。
// - 前期の月インデックスは prior.lastFilledIndex で頭打ちにする。前期が期中までしか取り込まれて
//   いないときに空の月まで足すと、前期同期を過小評価して「今期は絶好調」に見えてしまう。
// - 推移グラフは**累計ベース**の労働分配率にする。単月ベースだと賞与月・決算賞与月に分配率が
//   跳ね上がって折れ線がギザギザになり、肝心の「傾向が良くなっているのか」が読めなくなる。
//   累計なら月を追うごとに均され、最後の点＝上の指標カードの数字と必ず一致する。
// - 内訳表の科目は「当期・前期のどちらかにあれば1行」にする。前期にしか無い科目（前期で
//   打ち切った雑給など）を落とすと、明細の前期欄を足しても「人件費 合計」の前期欄に合わず、
//   社長に「足し算が合わない」と言われる。売上原価側と販管費側に同名の科目がある場合
//   （労務費の給料手当など）は1行に合算する。
// - 金額はすべて **円** のまま返す（表示単位の変換は theme.ts の amt()/toUnit() の仕事）。
// - 従業員数が未入力・前期が無い・粗利が0以下、いずれの場合も例外は投げない。null または 0 を
//   返し、呼び出し側が「—」を出せるようにする。
import type { FiscalYearData } from '../types'
import { CODES, ytd } from '../calc'
import { laborShare, type LaborResult } from '../issues'
import type { Labor2Result, LaborRow, ReportV2Settings } from './types'

/** 従業員数などの「入っていれば使う」入力。0・負数・NaN は未入力扱い */
function posOrNull(n: number | null | undefined): number | null {
  return n != null && isFinite(n) && n > 0 ? n : null
}

/**
 * 労働分配率（%）＝ 人件費 ÷ 売上総利益。
 * 粗利が0以下のとき（赤字原価・データ未取込）は比率に意味が無いので null を返す。
 * ※ issues.ts の laborShare().share は「人件費>0」も条件にしているが、こちらは紙面の
 *   推移グラフで期首の点だけ欠けるのを避けるため粗利のみを条件にしている。
 */
function shareOf(labor: number, gross: number): number | null {
  if (!(gross > 0)) return null
  const v = (labor / gross) * 100
  return isFinite(v) ? v : null
}

/** 1人当たり指標（円）。従業員数が未入力なら null（人数を推計してまで出さない） */
function per(value: number | null, employees: number | null): number | null {
  if (value == null || employees == null || !(employees > 0)) return null
  const v = value / employees
  return isFinite(v) ? v : null
}

/** 科目名（trim済み）→ 累計金額。同名科目は合算する */
function byName(r: LaborResult): Map<string, number> {
  const m = new Map<string, number>()
  for (const a of r.accounts) {
    const key = a.name.trim()
    m.set(key, (m.get(key) ?? 0) + a.amount)
  }
  return m
}

/**
 * P8「労働分配率と生産性」の材料をまとめて作る。
 * 期首〜monthIdx の累計ベース（社長が見慣れている試算表の累計欄と一致する）。
 */
export function computeLabor2(
  years: Record<string, FiscalYearData>,
  fy: FiscalYearData,
  prior: FiscalYearData | null,
  monthIdx: number,
  v2: ReportV2Settings,
): Labor2Result {
  const employees = posOrNull(v2.employees)
  const employeesPrior = posOrNull(v2.employeesPrior)

  // ---- 当期（期首〜当月の累計） ----
  const idx = Math.max(0, Math.min(monthIdx, 11))
  const cur = laborShare(years, fy, idx)
  const labor = cur.labor
  const gross = cur.gross
  const sales = ytd(fy, CODES.sales, idx)

  // ---- 前期同期（同じ経過月数。前期の取込が途中ならそこで頭打ち） ----
  const preIdx = prior ? Math.min(idx, prior.lastFilledIndex) : -1
  const pre = prior && preIdx >= 0 ? laborShare(years, prior, preIdx) : null
  const laborPrior = pre ? pre.labor : null
  const grossPrior = pre ? pre.gross : null
  const salesPrior = prior && preIdx >= 0 ? ytd(prior, CODES.sales, preIdx) : null

  const share = shareOf(labor, gross)
  const sharePrior = pre ? shareOf(pre.labor, pre.gross) : null

  // ---- 人件費の内訳（当期・前期のどちらかにあれば1行） ----
  // pre は「前期そのものが無い」ときだけ null。前期はあるが計上が無い科目は 0 にして、
  // 明細を足すと「人件費 合計」の前期欄にちょうど一致するようにしている。
  const curMap = byName(cur)
  const preMap = pre ? byName(pre) : null
  // ※ tsconfig に target 指定が無く ES5 扱いのため、Map のイテレータは展開せず forEach で回す
  const names: string[] = []
  curMap.forEach((_v, n) => { names.push(n) })
  if (preMap) preMap.forEach((_v, n) => { if (!curMap.has(n)) names.push(n) })
  const accounts = names
    .map((name) => ({
      name,
      cur: curMap.get(name) ?? 0,
      pre: preMap ? (preMap.get(name) ?? 0) : null,
    }))
    .sort((a, b) => (b.cur - a.cur) || ((b.pre ?? 0) - (a.pre ?? 0)))

  // ---- 紙面の内訳表 ----
  // 労働分配率の行だけ %（isRate）。粗利0以下で率が出せないときは 0 を入れる
  // （型上 cur は必須。表の他の欄も全部0になるので「データが無い」と読める）。
  const rows: LaborRow[] = [
    { label: '売上高', kind: 'plain', cur: sales, pre: salesPrior },
    { label: '売上総利益（付加価値）', kind: 'sub', cur: gross, pre: grossPrior },
    ...accounts.map((a): LaborRow => ({ label: a.name, kind: 'ind', cur: a.cur, pre: a.pre })),
    { label: '人件費 合計', kind: 'sub', cur: labor, pre: laborPrior },
    { label: '労働分配率', kind: 'key', cur: share ?? 0, pre: sharePrior, isRate: true },
  ]

  // ---- 推移（期首〜当月の各月・累計ベース） ----
  const monthly: { label: string; share: number | null }[] = []
  if (monthIdx >= 0) {
    for (let i = 0; i <= idx; i++) {
      const m = laborShare(years, fy, i)
      monthly.push({ label: `${fy.fiscalMonths[i] ?? i + 1}月`, share: shareOf(m.labor, m.gross) })
    }
  }

  return {
    employees, employeesPrior,
    labor, gross, sales,
    laborPrior, grossPrior, salesPrior,
    share, sharePrior,
    perSales: per(sales, employees),
    perSalesPrior: per(salesPrior, employeesPrior),
    perGross: per(gross, employees),
    perGrossPrior: per(grossPrior, employeesPrior),
    perLabor: per(labor, employees),
    perLaborPrior: per(laborPrior, employeesPrior),
    rows, monthly, accounts,
  }
}
