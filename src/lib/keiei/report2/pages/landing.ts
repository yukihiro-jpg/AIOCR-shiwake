// 着地見込と納税予測。
// 残り月の置き方を A＝当期平均／B＝前期実績 の2通りで並べ、差額（A−B）まで見せる。
// 下段に「当期の月次推移と着地見込」を1つのグラフでまとめ、A・Bもその中に表現する。
import type { ReportV2Context } from '../types'
import { CY, CY15, CY30, amt, esc, negCls, pageFoot, pageHead, ptv, pct, unitLabel, unitWord, section } from '../theme'
import { monthlyTrendChart } from '../charts'

export function pageLanding(ctx: ReportV2Context): string {
  const u = ctx.unit
  const L = ctx.landing
  const partial = L.partial
  const w = unitWord(u)

  // ---- リード文 ----
  const need = ctx.corpTax.due + ctx.vat.due
  const lead = partial
    ? `残りを<b>当期平均</b>で置くと通期は <span class="mg">売上 ${esc(amt(L.salesA, u))}${esc(w)}・営業利益 ${esc(amt(L.opA, u))}${esc(w)}</span>、` +
      `<b>前期実績</b>で置くと <b>売上 ${esc(amt(L.salesB, u))}${esc(w)}・営業利益 ${esc(amt(L.opB, u))}${esc(w)}</b> の着地見込みです。` +
      `差は営業利益で <b>${esc(amt(Math.abs(L.opA - L.opB), u))}${esc(w)}</b>。` +
      `納税は法人税等 <b>${esc(amt(ctx.corpTax.total, u))}${esc(w)}</b>（期末納付 ${esc(amt(ctx.corpTax.due, u))}${esc(w)}）、` +
      `消費税 <b>${esc(amt(ctx.vat.annual, u))}${esc(w)}</b>（確定納付 ${esc(amt(ctx.vat.due, u))}${esc(w)}）を見込みます。` +
      `<b>${ctx.fy.endMonth}月末までに合計 ${esc(amt(need, u))}${esc(w)}の納税資金</b>をご準備ください。`
    : `通期が確定しました。売上 <span class="mg">${esc(amt(L.salesA, u))}${esc(w)}</span>、営業利益 <b>${esc(amt(L.opA, u))}${esc(w)}</b>、` +
      `税引前当期純利益 <b>${esc(amt(L.preTaxA, u))}${esc(w)}</b>。納税は法人税等 <b>${esc(amt(ctx.corpTax.total, u))}${esc(w)}</b>、` +
      `消費税 <b>${esc(amt(ctx.vat.annual, u))}${esc(w)}</b>の見込みです。`

  // ---- 着地見込みの表 ----
  const rows = L.rows.map((r) => {
    const cls = r.kind === 'key' ? ' class="key"' : r.kind === 'sub' ? ' class="sub"' : r.kind === 'total' ? ' class="total"' : ''
    const nameCls = r.kind === 'ind' ? ' class="ind1"' : ''
    const diff = r.a - r.b
    const cell = (v: number, extra = '') =>
      r.isRate ? `<td class="r${extra}">${esc(pct(v))}</td>` : `<td class="r${negCls(v)}${extra}">${esc(amt(v, u))}</td>`
    const diffCell = r.isRate
      ? `<td class="r">${esc(ptv(diff))}</td>`
      : `<td class="r${negCls(diff)}">${esc(amt(diff, u))}</td>`
    const hi = !r.isRate && (r.label === '売上高' || r.label === '営業利益') ? ' mgv' : ''
    return `<tr${cls}><td${nameCls}>${esc(r.label)}</td>${cell(r.actual)}${cell(r.a, hi)}${cell(r.b)}${diffCell}</tr>`
  }).join('')

  const colA = partial ? `着地見込 A<br>残り＝当期平均` : '確定（通期）'
  const colB = partial ? `着地見込 B<br>残り＝前期実績` : '前期実績ベース'

  // ---- 納税・消費税の明細 ----
  const taxRows = (lines: { label: string; amount: number; kind?: string }[]) => lines.map((l) => {
    const cls = l.kind === 'key' ? ' class="key"' : l.kind === 'sub' ? ' class="sub"' : l.kind === 'total' ? ' class="total"' : ''
    const nameCls = l.kind === 'ind' ? ' class="ind1"' : ''
    const val = l.kind === 'total' ? `<td class="r mgv">${esc(amt(l.amount, u))}</td>` : `<td class="r${negCls(l.amount)}">${esc(amt(l.amount, u))}</td>`
    return `<tr${cls}><td${nameCls}>${esc(l.label)}</td>${val}</tr>`
  }).join('')

  // ---- 月次推移グラフの凡例（HTMLで作る。SVGに入れると図が縮んで読めなくなるため） ----
  const legend = `
  <div style="display:flex; gap:4mm; flex-wrap:wrap; font-size:7.2pt; margin:0.5mm 0 0.3mm;">
    <span><span style="display:inline-block; width:5mm; height:2.4mm; background:${CY}; vertical-align:middle;"></span> 売上高（実績）</span>
    <span><span style="display:inline-block; width:5mm; height:2.4mm; background:${CY30}; border:0.2mm solid ${CY}; vertical-align:middle;"></span> 売上高（見込A＝当期平均）</span>
    <span><span style="display:inline-block; width:5mm; height:2.4mm; background:#fff; border:0.2mm dashed #6f6f6f; vertical-align:middle;"></span> 売上高（見込B＝前期実績）</span>
    <span style="margin-left:2mm;"><span style="display:inline-block; width:6mm; border-top:0.6mm solid #000; vertical-align:middle;"></span> 当期純利益（実績）</span>
    <span><span style="display:inline-block; width:6mm; border-top:0.6mm dashed ${CY}; vertical-align:middle;"></span> 同（見込A）</span>
    <span><span style="display:inline-block; width:6mm; border-top:0.5mm dotted #6f6f6f; vertical-align:middle;"></span> 同（見込B）</span>
  </div>`

  return section(`
  ${pageHead({
    no: ctx.pageNo('landing'),
    title: '着地見込と納税予測',
    metaHtml: partial
      ? `残り${L.monthsLeft}か月（${esc(L.restLabel)}）の置き方を2通りで比較<br>期首〜${esc(ctx.monthLabel)}＝実績${L.monthsDone}か月`
      : `通期確定（${L.monthsDone}か月）`,
  })}
  <div class="lead">${lead}</div>

  <div class="grid">
    <div class="col" style="flex:1.5">
      <div class="blk-t">通期の着地見込み<span class="sub">実績${L.monthsDone}か月＋残り${L.monthsLeft}か月の見込み</span></div>
      <div class="unit">${esc(unitLabel(u))}</div>
      <table class="cmp">
        <colgroup><col><col style="width:21mm"><col style="width:23mm"><col style="width:23mm"><col style="width:16mm"></colgroup>
        <thead><tr><th class="l">科目</th><th>実績<br>（${esc(ctx.monthLabels[0])}〜${esc(ctx.monthLabel)}）</th><th>${colA}</th><th>${colB}</th><th>A−B</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="note">A＝残り${L.monthsLeft}か月を「当期の月平均」で置いた見込み。B＝残り${L.monthsLeft}か月を「前期の同じ月の実績」で置いた見込み。どちらも当月までの実績はそのまま使います。</div>
    </div>

    <div class="col">
      <div class="blk-t">納税予測<span class="sub">着地見込 A ベース</span></div>
      <div class="unit">${esc(unitLabel(u))}</div>
      <table class="cmp">
        <colgroup><col><col style="width:24mm"></colgroup>
        <thead class="plain"><tr><th class="l">法人税等</th><th>金額</th></tr></thead>
        <tbody>${taxRows(ctx.corpTax.lines)}</tbody>
      </table>
      <div class="note">実効税率 ${esc(pct(ctx.corpTax.effectiveRate))}（見込課税所得ベース）。中小法人の標準税率による概算で、超過課税・欠損金の繰越控除・各種特例は反映していません。</div>
    </div>

    <div class="col">
      <div class="blk-t">消費税の予測<span class="sub">${ctx.vat.method === 'simple' ? '簡易課税' : ctx.vat.method === 'exempt' ? '免税事業者' : '原則課税'}・着地見込 A</span></div>
      <div class="unit">${esc(unitLabel(u))}</div>
      <table class="cmp">
        <colgroup><col><col style="width:24mm"></colgroup>
        <thead class="plain"><tr><th class="l">区分</th><th>金額</th></tr></thead>
        <tbody>${taxRows(ctx.vat.lines)}</tbody>
      </table>
      <div class="note">${ctx.vat.estimated
        ? '仮受・仮払消費税の実績残高と、課税・非課税の科目区分から推計しています。'
        : '仮受・仮払消費税の残高が試算表に無いため、売上・仕入の金額から推計しています（精度は落ちます）。'}</div>
      <div class="mt2" style="border:0.4mm solid var(--mg); background:${CY15}; padding:1.8mm 2mm;">
        <div style="font-size:7.5pt; font-weight:700;">${ctx.fy.endMonth}月末までに必要な納税資金</div>
        <div style="font-size:15pt; font-weight:700; color:var(--mg); line-height:1.2;">${esc(amt(need, u))} <span style="font-size:8pt; color:var(--ink)">${esc(w)}</span></div>
        <div class="note" style="margin-top:0.6mm">法人税等 ${esc(amt(ctx.corpTax.due, u))} ＋ 消費税 ${esc(amt(ctx.vat.due, u))}</div>
      </div>
    </div>
  </div>

  <div class="blk-t" style="margin-top:1.6mm">当期の月次推移と着地見込<span class="sub">棒＝売上高（左軸・${esc(w)}）／線＝当期純利益（右軸・${esc(w)}）。${partial ? `${esc(L.restLabel)}はA・Bの2通りの見込み` : '通期確定'}</span></div>
  ${legend}
  ${monthlyTrendChart(ctx)}
  <div class="note" style="margin-top:0.3mm">${partial
    ? `${esc(L.restLabel)}は A＝当期の月平均、B＝前期の同じ月の実績。<b>目盛りの単位は会社の規模に合わせて円／千円を切り替えられます</b>（この資料は${esc(w)}）。`
    : `通期が確定しているため見込みの表示はありません。`}</div>
  ${pageFoot(ctx.company, ctx.fyLabel, ctx.ymLabel, ctx.pageNo('landing'))}`)
}
