// 新報告書 v2 ── 損益計算書 3期推移（全科目）（P9〜P10）。
//
// 設計の意図（なぜこうしたか）:
// - この資料は「科目を縦・当期／前期／前々期の3段・横に4月〜3月の12か月」で、単月発生額を
//   そのまま並べたもの。**要約せず全科目を出す**のがこの紙面の役目なので、
//   小計・利益行も間引かず、会計大将CSVの並び順のまま出す（並べ替えると
//   〔売上総利益〕が原価の直後に来なくなり、社長が見慣れた損益計算書の形が崩れる）。
// - 補助科目は analysis.ts の aggregateRows() で主科目に畳む。補助科目まで出すと
//   行数が倍以上になり、紙が何枚あっても足りないため（同じ集約規則を他ページと共用する）。
// - **期をまたぐ科目の突合は「集約後の科目名」で行う**。会計大将では期の途中で科目コードを
//   振り直す・別コードで同じ科目を作り直すことがあり、コードで突き合わせると
//   前期の同じ科目が別行になってしまうため。
//   ただし PL には**同じ名前の科目が複数回出る**（例: 減価償却費が売上原価と販管費の両方）。
//   名前だけを鍵にすると両方が同じ前期行に結び付くので、
//   鍵は「科目名＋その期の中での出現回数」にして、1つ目は1つ目・2つ目は2つ目と対応させる。
// - **前期・前々期にだけある科目は当期の並びの末尾へまとめて追加する**。
//   当期の並びだけで作ると「今期から計上が無くなった科目」が紙面から消えてしまい、
//   3期推移で見たいこと（前期にあった費用がどこへ行ったか）が分からなくなるため。
//   ただし3期とも全月ゼロの行は追加しない（消えた科目を見せるための追加なので、
//   実績が1円も無い空行を足すとページだけ増える）。
// - 未入力の月は 0 ではなく **null**。当期は報告月より後、前期・前々期はその期の
//   lastFilledIndex より後を null にする。0 を入れると「合計額（年計）」が
//   途中までの合計なのか本当に0なのか区別できず、紙面でも「—」を出せない。
// - 金額はすべて **円** のまま返す（千円などの表示単位変換は theme.ts の amt()/toUnit() の仕事）。
// - データが無いとき（前期なし・PL行なし）でも例外は投げない。空配列や null 埋めを返し、
//   呼び出し側が「—」を出せるようにする。
import type { FiscalYearData } from '../types'
import { CODES, getRow, findPriorYear } from '../calc'
import { aggregateRows, type AggRow } from '../analysis'
import type { Trend3Result, Trend3Row } from './types'

/** 1期＝12か月固定（会計大将の月次推移CSVが12列） */
const M = 12

/** 3段の見出し（前期・前々期が無くてもラベルは固定で出す＝紙面の形を揃えるため） */
const PERIOD_LABELS: [string, string, string] = ['当期', '前期', '前々期']

/**
 * 利益行の既定の名前。
 * 会計大将のコード（CODES）から実際の科目名を拾うのが第一だが、
 * コード体系が違うCSVでも太罫にできるよう、名前でも判定できるようにしておく。
 */
const PROFIT_NAMES = [
  '売上総利益', '営業利益', '経常利益', '税引前当期純利益', '当期純利益',
]

/** 小計行の囲み（【】〔〕[]()）を外した表示名。明細行はそのまま */
function displayName(row: AggRow): string {
  const t = (row.name || '').trim()
  if (!row.isSubtotal || !row.bracket) return t
  const m = /^[【〔[(]\s*(.*?)\s*[】〕\])]?$/.exec(t)
  return m ? (m[1] || t) : t
}

/** 行の種類。利益行＝'key'（シアン網）／その他の小計＝'sub'（グレー網）／明細＝'plain' */
function kindOf(row: AggRow, name: string, profitNames: Set<string>): Trend3Row['kind'] {
  if (row.bracket === 'profit' || profitNames.has(name)) return 'key'
  return row.isSubtotal ? 'sub' : 'plain'
}

/** 当期のCSVから利益行の科目名を集める（コード優先・取れなければ既定の名前） */
function profitNameSet(fy: FiscalYearData): Set<string> {
  const set = new Set<string>(PROFIT_NAMES)
  for (const code of [CODES.grossProfit, CODES.opProfit, CODES.ordProfit, CODES.preTax, CODES.netProfit]) {
    const r = getRow(fy, code)
    if (!r) continue
    const t = r.name.trim().replace(/^[【〔[(]\s*/, '').replace(/\s*[】〕\])]$/, '')
    if (t) set.add(t)
  }
  return set
}

/** 突合用に鍵を付けたPL行（並び順は会計大将CSVのまま） */
interface KeyedRow {
  /** 科目名＋その期の中での出現回数（同名科目の取り違え防止） */
  key: string
  name: string
  kind: Trend3Row['kind']
  monthly: number[]
}

/** 指定期のPL行を集約し、突合用の鍵を付けて並び順どおりに返す */
function plRowsOf(fy: FiscalYearData | null, profitNames: Set<string>): KeyedRow[] {
  if (!fy) return []
  const seen = new Map<string, number>()
  const out: KeyedRow[] = []
  for (const r of aggregateRows(fy)) {
    if (r.statement !== 'PL') continue
    const name = displayName(r)
    if (!name) continue
    const n = (seen.get(name) ?? 0) + 1
    seen.set(name, n)
    out.push({ key: `${name}#${n}`, name, kind: kindOf(r, name, profitNames), monthly: r.monthly })
  }
  return out
}

/** 12か月ぶんの系列。lastIdx より後（＝未入力）は null。行が無ければ全部 null */
function seriesOf(row: KeyedRow | undefined, lastIdx: number): (number | null)[] {
  const out: (number | null)[] = []
  for (let i = 0; i < M; i++) {
    out.push(row && i <= lastIdx ? (row.monthly[i] ?? 0) : null)
  }
  return out
}

/** 入力済みの最終月インデックス（0〜11に丸める。未入力期は -1 ＝ 全部 null） */
function lastIdxOf(fy: FiscalYearData): number {
  const n = Number(fy.lastFilledIndex)
  if (!isFinite(n)) return M - 1
  return Math.max(-1, Math.min(M - 1, Math.trunc(n)))
}

/** 月の並び。CSVから取れなければ期末月から逆算して作る（紙面の見出しを欠かさないため） */
function monthsOf(fy: FiscalYearData): number[] {
  const src = fy.fiscalMonths
  if (Array.isArray(src) && src.length === M) return [...src]
  const end = Number(fy.endMonth) || 12
  const out: number[] = []
  for (let i = 0; i < M; i++) out.push(((end + i) % 12) + 1)
  return out
}

/** 全月 null または 0 か（前期だけにある科目を末尾へ足すかの判定に使う） */
function allEmpty(series: (number | null)[][]): boolean {
  for (const s of series) for (const v of s) if (v != null && v !== 0) return false
  return true
}

/**
 * 損益計算書 3期推移（全科目）の表データ。
 * @param years 取込済みの全期（前期・前々期を findPriorYear で辿る）
 * @param fy    当期
 * @param monthIdx 報告月のインデックス（0＝期首月）。これより後の当期の月は null にする
 */
export function computeTrend3(
  years: Record<string, FiscalYearData>,
  fy: FiscalYearData,
  monthIdx: number,
): Trend3Result {
  const reportIdx = Math.max(0, Math.min(M - 1, Math.trunc(Number(monthIdx) || 0)))
  const months = monthsOf(fy)

  const prior = findPriorYear(years, fy)
  const prior2 = prior ? findPriorYear(years, prior) : null

  const profitNames = profitNameSet(fy)
  const cur = plRowsOf(fy, profitNames)
  const pre = plRowsOf(prior, profitNames)
  const pre2 = plRowsOf(prior2, profitNames)

  const preMap = new Map(pre.map((r) => [r.key, r]))
  const pre2Map = new Map(pre2.map((r) => [r.key, r]))

  // 当期は報告月まで。前期・前々期はその期の入力済み最終月まで（通期確定なら12か月）
  const curLast = reportIdx
  const preLast = prior ? lastIdxOf(prior) : -1
  const pre2Last = prior2 ? lastIdxOf(prior2) : -1

  const rows: Trend3Row[] = cur.map((r) => ({
    name: r.name,
    kind: r.kind,
    series: [
      seriesOf(r, curLast),
      seriesOf(preMap.get(r.key), preLast),
      seriesOf(pre2Map.get(r.key), pre2Last),
    ],
  }))

  // 前期・前々期にだけある科目を末尾へ（今期から計上が無くなった科目を見落とさないため）
  const used = new Set(cur.map((r) => r.key))
  for (const [list, isPre] of [[pre, true], [pre2, false]] as [KeyedRow[], boolean][]) {
    for (const r of list) {
      if (used.has(r.key)) continue
      used.add(r.key)
      const series: [(number | null)[], (number | null)[], (number | null)[]] = [
        seriesOf(undefined, -1),
        seriesOf(isPre ? r : preMap.get(r.key), preLast),
        seriesOf(isPre ? pre2Map.get(r.key) : r, pre2Last),
      ]
      if (allEmpty(series)) continue // 3期とも実績ゼロの空行は足さない
      rows.push({ name: r.name, kind: r.kind, series })
    }
  }

  return { months, reportIdx, rows, periodLabels: PERIOD_LABELS }
}

// ===== 紙面の「合計額」「累計額」列（series から導く。二重に持たない） =====
/** 合計額（年計）＝入力済みの月の合計。当期は報告月までなので累計額と同じ値になる */
export function trend3Total(series: (number | null)[]): number | null {
  let s = 0
  let has = false
  for (const v of series) if (v != null) { s += v; has = true }
  return has ? s : null
}
/** 累計額＝期首〜報告月の合計（前期・前々期は同じ月数で並べて比べるための列） */
export function trend3Ytd(series: (number | null)[], reportIdx: number): number | null {
  let s = 0
  let has = false
  for (let i = 0; i <= reportIdx && i < series.length; i++) {
    const v = series[i]
    if (v != null) { s += v; has = true }
  }
  return has ? s : null
}
