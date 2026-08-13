// 当事業年度の月次損益推移。
// 当期の12か月を横に並べて「どの月に何が起きたか」を1枚で見る資料。
// 単月PL（次ページ）と3期推移PL（最終ページ）の間をつなぐ位置づけ。
import type { ReportV2Context } from '../types'
import { amt, esc, negCls, pageFoot, pageHead, pct, section, unitLabel, unitWord } from '../theme'

export function pageMonthlyPl(ctx: ReportV2Context): string {
  const u = ctx.unit
  const w = unitWord(u)
  const m = ctx.monthlyPl

  // ---- リード文（実データから組み立てる） ----
  const mLabel = (i: number | null) => (i == null ? '—' : `${m.months[i]}月`)
  const parts: string[] = []
  if (m.bestIdx != null && m.worstIdx != null && m.bestIdx !== m.worstIdx) {
    parts.push(
      `期首から${esc(ctx.monthLabel)}までで売上がいちばん大きかったのは <b>${esc(mLabel(m.bestIdx))}（${esc(amt(m.salesSeries[m.bestIdx] as number, u))}${esc(w)}）</b>、` +
      `いちばん小さかったのは <b>${esc(mLabel(m.worstIdx))}（${esc(amt(m.salesSeries[m.worstIdx] as number, u))}${esc(w)}）</b>で、その差は ${esc(amt((m.salesSeries[m.bestIdx] as number) - (m.salesSeries[m.worstIdx] as number), u))}${esc(w)} です。`,
    )
  }
  if (m.recentAvg != null && m.earlierAvg != null && m.earlierAvg !== 0) {
    const d = ((m.recentAvg - m.earlierAvg) / Math.abs(m.earlierAvg)) * 100
    parts.push(
      Math.abs(d) < 3
        ? `直近3か月の売上は月平均 ${esc(amt(m.recentAvg, u))}${esc(w)}で、それ以前（月平均 ${esc(amt(m.earlierAvg, u))}${esc(w)}）と<b>ほぼ同じ水準</b>です。`
        : `直近3か月の売上は月平均 <span class="mg">${esc(amt(m.recentAvg, u))}${esc(w)}</span>で、それ以前の月平均 ${esc(amt(m.earlierAvg, u))}${esc(w)} を <b>${esc(pct(Math.abs(d)))} ${d > 0 ? '上回って' : '下回って'}</b>います。`,
    )
  }
  parts.push(
    m.lossMonths.length === 0
      ? `営業利益は<b>全ての月で黒字</b>を確保しています。`
      : m.lossMonths.length === 1
        ? `<b>${esc(mLabel(m.lossMonths[0]))}は営業赤字</b>でした。単月で落ち込んだ月の要因を、下の表の科目の動きでご確認ください。`
        : `<b>${m.lossMonths.length}か月（${esc(m.lossMonths.map((i) => mLabel(i)).join('・'))}）が営業赤字</b>でした。季節変動によるものか、固定費が重いのかを下の表で確認します。`,
  )

  // ---- 表 ----
  const cols = `<colgroup><col style="width:44mm">`
    + m.months.map(() => '<col style="width:15.2mm">').join('')
    + `<col style="width:20mm"><col style="width:17mm"><col style="width:14mm"></colgroup>`
  const head = `<thead>
    <tr><th class="l">科目</th>${m.months.map((x) => `<th>${x}月</th>`).join('')}<th>累計</th><th>月平均</th><th>対売上比</th></tr>
  </thead>`

  const rows = m.rows.map((r) => {
    const cls = r.kind === 'key' ? ' class="key"' : r.kind === 'sub' ? ' class="sub"' : r.kind === 'total' ? ' class="total"' : ''
    const nameCls = r.kind === 'ind' ? ' class="nm ind1"' : ' class="nm"'
    const cells = r.monthly.map((v, i) => {
      const hi = i === m.reportIdx ? ' cm' : ''
      return `<td class="r${hi}${negCls(v)}">${v == null ? '—' : esc(amt(v, u))}</td>`
    }).join('')
    return `<tr${cls}><td${nameCls}>${esc(r.name)}</td>${cells}`
      + `<td class="r sumc${negCls(r.cum)}">${esc(amt(r.cum, u))}</td>`
      + `<td class="r sumc${negCls(r.avg)}">${esc(amt(r.avg, u))}</td>`
      + `<td class="r">${r.ratio == null ? '—' : esc(pct(r.ratio))}</td></tr>`
  }).join('')

  return section(`
  ${pageHead({
    no: ctx.pageNo('monthlypl'),
    title: '当事業年度の月次損益推移',
    metaHtml: `${esc(ctx.fyLabel)}（${esc(ctx.periodLabel)}）<br>期首〜<b>${esc(ctx.monthLabel)}</b>＝実績${ctx.monthsDone}か月　${esc(unitLabel(u))}`,
  })}
  <div class="lead">${parts.join(' ')}</div>

  <div class="blk-t" style="margin-top:2.5mm">科目別の月次推移<span class="sub">単月発生額。網かけの列＝報告月（${esc(ctx.monthLabel)}）</span></div>
  <table class="tr3 mpl">
    ${cols}
    ${head}
    <tbody>${rows}</tbody>
  </table>
  <div class="note" style="margin-top:0.6mm">${esc(ctx.monthLabel)}より後の月は未入力のため「—」です。月平均は「累計 ÷ ${ctx.monthsDone}か月」、対売上比は累計ベースです。${m.condensed ? '　※ 科目数が多いため、販管費は金額の大きい順に主要科目を表示し、残りを「その他販管費」にまとめています（合計は全科目の合算です）。' : ''}</div>
  ${pageFoot(ctx.company, ctx.fyLabel, ctx.ymLabel, ctx.pageNo('monthlypl'))}`)
}
