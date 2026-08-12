// 新報告書 v2 ── 当事業年度の月次損益推移（P2）。
//
// 設計の意図:
//  - 単月PL（P3）は「その月がどうだったか」、3期推移PL（最終ページ）は「3期を比べてどうか」を見る資料。
//    その間をつなぐ「**当期の12か月を横に並べて、どの月に何が起きたか**」を1枚で見る資料が無かったので足した。
//  - 会計ソフトの月次推移試算表と同じ並び・同じ科目名で全科目を出す。紙面に入り切らないときだけ
//    販管費の明細を金額の大きい順に丸める（科目を黙って落とすと合計が合わなくなるため、
//    残りは必ず「その他販管費」に集約して総額は保つ）。
//  - 金額の内部単位は「円」。表示単位の変換は theme.ts の amt()/toUnit() の仕事。
//  - データが欠けていても例外は投げない。未入力月は null にして呼び出し側が「—」を出せるようにする。
import type { FiscalYearData } from '../types'
import { aggregateRows, type AggRow } from '../analysis'
import type { MonthlyPlResult, MonthlyPlRow } from './types'

const M = 12
/** 1ページに収まる行数の上限（これを超えたら販管費の明細を丸める） */
const MAX_ROWS = 28
/** 丸めたあとに残す販管費の明細数 */
const KEEP_SGNA = 14

const nameOf = (r: AggRow): string => r.name.replace(/[【】〔〕]/g, '').trim()

/** 利益段階（シアン網で強調する行） */
const PROFIT_RE = /^(売上総利益|営業利益|経常利益|税引前当期純利益|当期純利益)$/

export function computeMonthlyPl(fy: FiscalYearData, monthIdx: number): MonthlyPlResult {
  const idx = Math.max(0, Math.min(M - 1, Math.trunc(Number(monthIdx) || 0)))
  const months = (fy.fiscalMonths && fy.fiscalMonths.length === M)
    ? fy.fiscalMonths.slice()
    : Array.from({ length: M }, (_, i) => ((fy.endMonth - 1 - (M - 1 - i) + M * 2) % M) + 1)

  const agg = aggregateRows(fy).filter((r) => r.statement === 'PL')
  const monthsDone = idx + 1

  /** 単月値12か月（報告月より後は null） */
  const seriesOf = (r: AggRow): (number | null)[] =>
    Array.from({ length: M }, (_, i) => (i > idx ? null : r.monthly[i] ?? 0))
  const cumOf = (r: AggRow): number => {
    let s = 0
    for (let i = 0; i <= idx; i++) s += r.monthly[i] ?? 0
    return s
  }

  const salesRow = agg.find((r) => r.isSubtotal && nameOf(r) === '純売上高')
  const salesCum = salesRow ? cumOf(salesRow) : 0

  // ---- 販管費の明細だけは、多すぎるときに丸める対象にする ----
  // 「【販売費及び一般管理費】の直前に並ぶ明細」が販管費の明細（会計大将の並び順に準拠）
  const sgnaDetailNames = (() => {
    const buf: string[] = []
    for (const r of agg) {
      if (r.isSubtotal) {
        if (nameOf(r) === '販売費及び一般管理費') return buf.slice()
        buf.length = 0
        continue
      }
      buf.push(nameOf(r))
    }
    return [] as string[]
  })()

  let dropNames = new Set<string>()
  let condensed = false
  if (agg.length > MAX_ROWS && sgnaDetailNames.length > KEEP_SGNA) {
    const ranked = agg
      .filter((r) => !r.isSubtotal && sgnaDetailNames.includes(nameOf(r)))
      .map((r) => ({ name: nameOf(r), v: Math.abs(cumOf(r)) }))
      .sort((a, b) => b.v - a.v)
    dropNames = new Set(ranked.slice(KEEP_SGNA).map((x) => x.name))
    condensed = dropNames.size > 0
  }

  const rows: MonthlyPlRow[] = []
  const other = { monthly: new Array<number>(M).fill(0), cum: 0 }
  const pushRow = (name: string, kind: MonthlyPlRow['kind'], monthly: (number | null)[], cum: number) => {
    rows.push({
      name, kind, monthly, cum,
      avg: monthsDone > 0 ? cum / monthsDone : 0,
      ratio: salesCum ? (cum / salesCum) * 100 : null,
    })
  }

  for (const r of agg) {
    const nm = nameOf(r)
    if (!r.isSubtotal && dropNames.has(nm)) {
      for (let i = 0; i <= idx; i++) other.monthly[i] += r.monthly[i] ?? 0
      other.cum += cumOf(r)
      continue
    }
    // 丸めた「その他販管費」は、販管費の小計行の直前に差し込む
    if (condensed && r.isSubtotal && nm === '販売費及び一般管理費' && other.cum !== 0) {
      pushRow('その他販管費', 'ind',
        other.monthly.map((v, i) => (i > idx ? null : v)), other.cum)
    }
    const kind: MonthlyPlRow['kind'] = r.isSubtotal
      ? (PROFIT_RE.test(nm) ? (nm === '税引前当期純利益' || nm === '当期純利益' ? 'total' : 'key') : 'sub')
      : 'ind'
    pushRow(nm, kind, seriesOf(r), cumOf(r))
  }

  // ---- グラフ用の系列とリード文の材料 ----
  const pick = (nm: string): (number | null)[] => {
    const r = agg.find((x) => x.isSubtotal && nameOf(x) === nm)
    return r ? seriesOf(r) : new Array(M).fill(null)
  }
  const salesSeries = pick('純売上高')
  const grossSeries = pick('売上総利益')
  const opSeries = pick('営業利益')

  let bestIdx: number | null = null
  let worstIdx: number | null = null
  for (let i = 0; i <= idx; i++) {
    const v = salesSeries[i]
    if (v == null) continue
    if (bestIdx == null || v > (salesSeries[bestIdx] as number)) bestIdx = i
    if (worstIdx == null || v < (salesSeries[worstIdx] as number)) worstIdx = i
  }
  const lossMonths: number[] = []
  for (let i = 0; i <= idx; i++) if ((opSeries[i] ?? 0) < 0) lossMonths.push(i)

  // 直近3か月とそれ以前の売上平均（増えているのか減っているのかを文章で言うため）
  const avgOf = (from: number, to: number): number | null => {
    let s = 0, n = 0
    for (let i = from; i <= to; i++) { const v = salesSeries[i]; if (v != null) { s += v; n++ } }
    return n ? s / n : null
  }
  const recentFrom = Math.max(0, idx - 2)
  const recentAvg = avgOf(recentFrom, idx)
  const earlierAvg = recentFrom > 0 ? avgOf(0, recentFrom - 1) : null

  return {
    months, reportIdx: idx, rows, condensed,
    salesSeries, grossSeries, opSeries,
    bestIdx, worstIdx, lossMonths, recentAvg, earlierAvg,
  }
}
