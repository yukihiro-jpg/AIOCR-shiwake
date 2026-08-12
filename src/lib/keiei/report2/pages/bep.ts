// 損益分岐点売上高とシミュレーション。
// 図を上・表を下に置く（ユーザー確定済み）。図はページの上半分いっぱいを使い、
// ①売上高の線・②総費用の線がどれかを凡例で示し、いまの売上がどこにいるかも図の中に出す。
import type { ReportV2Context } from '../types'
import { CY15, amt, esc, negCls, pageFoot, pageHead, pct, section, unitLabel, unitWord } from '../theme'
import { bepChart } from '../charts'

export function pageBep(ctx: ReportV2Context): string {
  const u = ctx.unit
  const w = unitWord(u)
  const b = ctx.bep
  const req = b.requiredParts

  // 損益分岐点比率が100%を超える＝赤字。そのときは「あと何%増えれば黒字か」に言い換える
  const ratioText = b.bepRatio <= 100
    ? `<span class="mg">損益分岐点比率 ${esc(pct(b.bepRatio))}（売上があと${esc(pct(b.safetyRatio))}落ちても赤字にならない）</span>`
    : `<span class="mg">損益分岐点比率 ${esc(pct(b.bepRatio))}（赤字。黒字にするには売上があと${esc(pct(b.bepRatio - 100))}必要）</span>`

  const gapToRequired = b.landingSales - b.requiredSales
  const lead = `損益分岐点売上高は <b>${esc(amt(b.bepYtd, u))}${esc(w)}</b>、実績 ${esc(amt(b.salesYtd, u))}${esc(w)}に対して ${ratioText}。` +
    (b.requiredSales > 0
      ? `ただし借入返済まで賄うには <b>年間 ${esc(amt(b.requiredSales, u))}${esc(w)}（月平均 ${esc(amt(b.requiredSales / 12, u))}${esc(w)}）</b>の売上が必要です。` +
        `現在の着地見込み ${esc(amt(b.landingSales, u))}${esc(w)}は、この水準を <b>${esc(amt(Math.abs(gapToRequired), u))}${esc(w)}</b> ${gapToRequired >= 0 ? '上回っています' : '下回っています'}。`
      : '')

  const simRows = b.simRows.map((r) => {
    const cls = r.highlight ? ' class="key"' : r.goal ? ' class="total"' : r.mark === '—' ? ' class="sub"' : ''
    return `<tr${cls}><td class="c">${esc(r.mark)}</td><td>${esc(r.label)}</td>` +
      `<td class="r">${esc(r.deltaLabel)}</td>` +
      `<td class="r${r.highlight ? ' mgv' : negCls(r.opProfit)}">${esc(amt(r.opProfit, u))}</td>` +
      `<td class="r${r.highlight ? ' mgv' : negCls(r.diff)}">${r.diff == null ? '—' : esc(amt(r.diff, u))}</td>` +
      `<td class="r">${esc(pct(r.bepRatio))}</td></tr>`
  }).join('')

  const simTouched = ctx.sim.salesPct !== 0 || ctx.sim.marginPt !== 0 || ctx.sim.sgnaDelta !== 0
  const simNote = simTouched
    ? `<div class="note" style="margin-top:0.8mm"><b>画面で動かした条件</b>：売上 ${ctx.sim.salesPct >= 0 ? '＋' : '△'}${Math.abs(ctx.sim.salesPct).toFixed(1)}%／売上総利益率 ${ctx.sim.marginPt >= 0 ? '＋' : '△'}${Math.abs(ctx.sim.marginPt).toFixed(1)}pt／販管費 ${esc(amt(ctx.sim.sgnaDelta, u))}${esc(w)} → 営業利益 <b>${esc(amt(b.simOpProfit, u))}${esc(w)}</b>・損益分岐点比率 <b>${esc(pct(b.simBepRatio))}</b>。</div>`
    : `<div class="note" style="margin-top:0.8mm">売上高・売上総利益率・販管費を画面で動かすと、上の図と営業利益・損益分岐点比率が即時に再計算されます。</div>`

  return section(`
  ${pageHead({
    no: ctx.pageNo('bep'),
    title: '損益分岐点売上高とシミュレーション',
    metaHtml: `期首〜${esc(ctx.ymLabel)}（${ctx.monthsDone}か月）累計ベース<br>${esc(unitLabel(u))}`,
  })}
  <div class="lead">${lead}</div>

  <div class="blk-t" style="margin-top:2mm">損益分岐点図<span class="sub">年換算。①と②の2本の線がどこで交わるか、いまの売上がどこにいるかを見ます</span></div>
  ${bepChart(ctx)}
  <div class="note" style="margin-top:0.8mm; font-size:8pt; color:var(--ink);">
    <b>【図の読み方】</b>① 売上高の線が ② 総費用の線を上回ったところから利益が出ます。2本が交わる点が損益分岐点です。
    固定費（＝売上がゼロでもかかる費用）を減らすと ② の線が下へ、粗利率を上げると ② の線が寝て、どちらも分岐点は左（＝より低い売上）へ動きます。
  </div>

  <div class="grid" style="margin-top:2.2mm">
    <div class="col" style="flex:1">
      <div class="blk-t">損益分岐点の計算<span class="sub">${ctx.monthsDone}か月累計</span></div>
      <table class="cmp">
        <colgroup><col><col style="width:26mm"></colgroup>
        <tbody>
          <tr><td>売上高</td><td class="r">${esc(amt(b.salesYtd, u))}</td></tr>
          <tr><td>変動費（売上原価など）</td><td class="r">${esc(amt(b.variableYtd, u))}</td></tr>
          <tr class="sub"><td>限界利益（率 ${esc(pct(b.marginalRate * 100))}）</td><td class="r">${esc(amt(b.marginalYtd, u))}</td></tr>
          <tr><td>固定費（販管費など）</td><td class="r">${esc(amt(b.fixedYtd, u))}</td></tr>
          <tr class="sub"><td>営業利益</td><td class="r${negCls(b.opProfitYtd)}">${esc(amt(b.opProfitYtd, u))}</td></tr>
          <tr class="key"><td>損益分岐点売上高</td><td class="r">${esc(amt(b.bepYtd, u))}</td></tr>
          <tr><td>損益分岐点比率</td><td class="r">${esc(pct(b.bepRatio))}</td></tr>
          <tr class="total"><td>安全余裕率</td><td class="r">${esc(pct(b.safetyRatio))}</td></tr>
        </tbody>
      </table>
    </div>

    <div class="col" style="flex:1.05">
      <div class="blk-t">返済まで賄える売上高<span class="sub">年換算</span></div>
      <div style="border:0.45mm solid var(--mg); background:${CY15}; padding:1.6mm 2mm; margin-top:1mm;">
        <div style="font-size:7.5pt; font-weight:700;">借入返済を続けても資金繰りが安定する売上高</div>
        <div style="font-size:15pt; font-weight:700; color:var(--mg); line-height:1.15;">${esc(amt(b.requiredSales, u))} <span style="font-size:8pt; color:var(--ink)">${esc(w)}／年</span></div>
        <div class="note" style="margin-top:0.5mm">（年間固定費 ${esc(amt(req.fixed, u))} ＋ 年間返済 ${esc(amt(req.repay, u))} ＋ 納税見込 ${esc(amt(req.tax, u))} − 減価償却 ${esc(amt(req.depreciation, u))}）÷ 限界利益率 ${esc(pct(b.marginalRate * 100))}。月平均 ${esc(amt(b.requiredSales / 12, u))}${esc(w)}。</div>
      </div>
    </div>

    <div class="col" style="flex:1.95">
      <div class="blk-t">シミュレーション<span class="sub">アプリ画面で数値を動かした状態がそのまま印刷されます／年換算・着地見込Aベース</span></div>
      <table class="cmp">
        <colgroup><col style="width:7mm"><col><col style="width:19mm"><col style="width:20mm"><col style="width:21mm"><col style="width:21mm"></colgroup>
        <thead><tr><th class="l">＃</th><th class="l">条件</th><th>変更幅</th><th>営業利益</th><th>現状との差</th><th>損益分岐点比率</th></tr></thead>
        <tbody>${simRows}</tbody>
      </table>
      ${simNote}
    </div>
  </div>
  ${pageFoot(ctx.company, ctx.fyLabel, ctx.ymLabel, ctx.pageNo('bep'))}`)
}
