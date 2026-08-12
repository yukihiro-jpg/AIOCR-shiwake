// 単月の損益計算書・貸借対照表（会計ソフトの試算表と同じ並び・同じ科目名）。
// この資料だけは説明文を付けず、数字をそのままお渡しする（ユーザー合意済み）。
//
// 紙面に入り切らないときは科目を落とすのではなく、金額の大きい順に上位N件＋「その他」へ
// 丸めて全額を必ず表示する（合計が合わなくなるのを避けるため）。丸めたことは注記に出す。
import type { FiscalYearData } from '../../types'
import { CODES } from '../../calc'
import { aggregateRows, type AggRow } from '../../analysis'
import type { ReportV2Context } from '../types'
import { amt, esc, negCls, pageFoot, pageHead, section, unitLabel } from '../theme'

/** PL明細の1行 */
interface Line { name: string; kind: 'plain' | 'ind' | 'sub' | 'key' | 'total'; cur: number; cum: number }

const cum = (r: AggRow, i: number): number => {
  let s = 0
  for (let k = 0; k <= i; k++) s += r.monthly[k] ?? 0
  return s
}

/** 明細が多いときに上位N件＋その他へ丸める */
function condense(rows: { name: string; cur: number; cum: number }[], top: number, restName: string) {
  if (rows.length <= top) return { rows, condensed: false }
  const sorted = [...rows].sort((a, b) => Math.abs(b.cum) - Math.abs(a.cum))
  const keep = sorted.slice(0, top)
  const rest = sorted.slice(top)
  const other = { name: restName, cur: rest.reduce((s, x) => s + x.cur, 0), cum: rest.reduce((s, x) => s + x.cum, 0) }
  // 元の並び順を保ったまま、残りをまとめた1行を末尾に足す
  const keepSet = new Set(keep.map((x) => x.name))
  return { rows: [...rows.filter((x) => keepSet.has(x.name)), other], condensed: true }
}

/** 損益計算書（当月・累計・対売上比） */
function plLines(fy: FiscalYearData, monthIdx: number): { lines: Line[]; condensed: boolean } {
  const agg = aggregateRows(fy).filter((r) => r.statement === 'PL')
  const at = (name: string) => agg.find((r) => r.isSubtotal && r.name.replace(/[【】〔〕]/g, '') === name)
  const detailsBefore = (code: string): AggRow[] => {
    // 集約行には code が無いので、名前で小計を探し「その小計の直前に並ぶ明細」を取る
    const out: AggRow[] = []
    for (const r of agg) {
      if (r.isSubtotal) { if (r.name.replace(/[【】〔〕]/g, '') === code) break; out.length = 0; continue }
      out.push(r)
    }
    return out
  }
  const lines: Line[] = []
  const push = (name: string, kind: Line['kind'], cur: number, c: number) => lines.push({ name, kind, cur, cum: c })
  const sub = (nm: string) => {
    const r = at(nm)
    return r ? { cur: r.monthly[monthIdx] ?? 0, cum: cum(r, monthIdx) } : { cur: 0, cum: 0 }
  }

  const sales = sub('純売上高')
  push('売上高', 'plain', sales.cur, sales.cum)
  for (const d of detailsBefore('売上原価')) push(d.name, 'ind', d.monthly[monthIdx] ?? 0, cum(d, monthIdx))
  const cogs = sub('売上原価')
  push('売上原価', 'sub', cogs.cur, cogs.cum)
  const gross = sub('売上総利益')
  push('売上総利益', 'key', gross.cur, gross.cum)

  const sgnaDetails = detailsBefore('販売費及び一般管理費').map((d) => ({ name: d.name, cur: d.monthly[monthIdx] ?? 0, cum: cum(d, monthIdx) }))
  const { rows: sgnaShown, condensed } = condense(sgnaDetails, 9, 'その他販管費')
  for (const d of sgnaShown) push(d.name, 'ind', d.cur, d.cum)
  const sgna = sub('販売費及び一般管理費')
  push('販売費及び一般管理費', 'sub', sgna.cur, sgna.cum)
  const op = sub('営業利益')
  push('営業利益', 'key', op.cur, op.cum)
  const nonIn = sub('営業外収益')
  const nonEx = sub('営業外費用')
  push('営業外収益', 'ind', nonIn.cur, nonIn.cum)
  push('営業外費用', 'ind', nonEx.cur, nonEx.cum)
  const ord = sub('経常利益')
  push('経常利益', 'key', ord.cur, ord.cum)
  const preTax = sub('税引前当期純利益')
  push('特別損益', 'ind', preTax.cur - ord.cur, preTax.cum - ord.cum)
  push('税引前当期純利益', 'total', preTax.cur, preTax.cum)
  return { lines, condensed }
}

/** 貸借対照表（前月末・当月末・増減）。資産の部／負債・純資産の部で分ける */
function bsLines(fy: FiscalYearData, prior: FiscalYearData | null, monthIdx: number) {
  const agg = aggregateRows(fy).filter((r) => r.statement === 'BS')
  const preIdx = monthIdx - 1
  const openOf = (r: AggRow): number | null => {
    if (preIdx >= 0) return r.monthly[preIdx] ?? 0
    if (!prior) return null
    const p = aggregateRows(prior).find((x) => x.statement === 'BS' && x.name === r.name)
    return p ? p.monthly[11] ?? 0 : 0
  }
  // 【資産の部】までが資産、それ以降が負債・純資産
  const assets: AggRow[] = []
  const liabs: AggRow[] = []
  let inAsset = true
  for (const r of agg) {
    ;(inAsset ? assets : liabs).push(r)
    if (r.isSubtotal && r.name.replace(/[【】〔〕]/g, '') === '資産の部') inAsset = false
  }
  const map = (rows: AggRow[]) => rows.map((r) => ({
    name: r.name.replace(/[【】〔〕]/g, ''),
    kind: (r.isSubtotal
      ? (/(資産の部|負債の部|純資産の部)$/.test(r.name.replace(/[【】〔〕]/g, '')) ? 'total' : 'sub')
      : 'plain') as 'plain' | 'sub' | 'total',
    open: openOf(r),
    close: r.monthly[monthIdx] ?? 0,
  }))
  return { assets: map(assets), liabs: map(liabs) }
}

export function pageTrial(ctx: ReportV2Context): string {
  const u = ctx.unit
  const { lines, condensed } = plLines(ctx.fy, ctx.monthIdx)
  const { assets, liabs } = bsLines(ctx.fy, ctx.prior, ctx.monthIdx)
  const salesCum = lines[0]?.cum || 0
  const ratio = (v: number) => (salesCum ? `${((v / salesCum) * 100).toFixed(1)}%` : '—')

  const plRows = lines.map((l) => {
    const cls = l.kind === 'key' ? ' class="key"' : l.kind === 'sub' ? ' class="sub"' : l.kind === 'total' ? ' class="total"' : ''
    const nameCls = l.kind === 'ind' ? ' class="ind1"' : ''
    return `<tr${cls}><td${nameCls}>${esc(l.name)}</td>` +
      `<td class="r${negCls(l.cur)}">${esc(amt(l.cur, u))}</td>` +
      `<td class="r${negCls(l.cum)}">${esc(amt(l.cum, u))}</td>` +
      `<td class="r">${esc(ratio(l.cum))}</td></tr>`
  }).join('')

  // CSVには「負債・純資産合計」の行が無いので、負債の部＋純資産の部で作って最後に足す
  const grand = (() => {
    const pick = (nm: string) => liabs.find((r) => r.name === nm)
    const a = pick('負債の部'), b = pick('純資産の部')
    if (!a || !b) return null
    return {
      name: '負債・純資産合計', kind: 'total' as const,
      open: a.open == null || b.open == null ? null : a.open + b.open,
      close: a.close + b.close,
    }
  })()

  const bsRows = (rows: ReturnType<typeof bsLines>['assets']) => rows.map((r) => {
    const cls = r.kind === 'sub' ? ' class="sub"' : r.kind === 'total' ? ' class="total"' : ''
    const diff = r.open == null ? null : r.close - r.open
    return `<tr${cls}><td class="nm">${esc(r.name)}</td>` +
      `<td class="r">${r.open == null ? '—' : esc(amt(r.open, u))}</td>` +
      `<td class="r">${esc(amt(r.close, u))}</td>` +
      `<td class="r${negCls(diff)}">${diff == null ? '—' : esc(amt(diff, u))}</td></tr>`
  }).join('')

  const bsHead = `<colgroup><col><col style="width:19mm"><col style="width:19mm"><col style="width:16mm"></colgroup>
    <thead><tr><th class="l">科目</th><th>${ctx.monthIdx > 0 ? '前月末' : '期首'}</th><th>当月末</th><th>増減</th></tr></thead>`

  return section(`
  ${pageHead({
    no: ctx.pageNo('trial'),
    title: '単月の損益計算書・貸借対照表',
    metaHtml: `${esc(ctx.company)}<br><b>${esc(ctx.ymLabel)}</b>／${esc(ctx.fyLabel)}（${esc(ctx.periodLabel)}）`,
  })}
  <div class="unit">${esc(unitLabel(u))}</div>
  <div class="grid" style="margin-top:1mm">
    <div class="col" style="flex:1.15">
      <div class="blk-t">損益計算書<span class="sub">${esc(ctx.monthLabel)}単月／期首〜${esc(ctx.monthLabel)}累計</span></div>
      <table class="cmp">
        <colgroup><col><col style="width:20mm"><col style="width:22mm"><col style="width:15mm"></colgroup>
        <thead><tr><th class="l">科目</th><th>当月</th><th>累計</th><th>対売上比</th></tr></thead>
        <tbody>${plRows}</tbody>
      </table>
    </div>
    <div class="col">
      <div class="blk-t">貸借対照表（資産の部）<span class="sub">${ctx.monthIdx > 0 ? '前月末' : '期首'}／${esc(ctx.monthLabel)}末</span></div>
      <table class="cmp">${bsHead}<tbody>${bsRows(assets)}</tbody></table>
    </div>
    <div class="col">
      <div class="blk-t">貸借対照表（負債・純資産の部）<span class="sub">${ctx.monthIdx > 0 ? '前月末' : '期首'}／${esc(ctx.monthLabel)}末</span></div>
      <table class="cmp">${bsHead}<tbody>${bsRows(grand ? [...liabs, grand] : liabs)}</tbody></table>
    </div>
  </div>
  <div class="note mt2">会計ソフトの試算表と同じ並び・同じ科目名で出力しています（合計行は網掛け、利益段階はシアン網）。この資料だけは説明文を付けず、数字をそのままお渡しします。${condensed ? '　※ 販管費は金額の大きい順に9科目を表示し、残りを「その他販管費」にまとめています（合計は全科目の合算です）。' : ''}</div>
  ${pageFoot(ctx.company, ctx.fyLabel, ctx.ymLabel, ctx.pageNo('trial'))}`)
}
