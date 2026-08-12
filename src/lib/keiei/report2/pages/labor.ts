// 労働分配率と生産性。稼いだ粗利のうち人件費に回っている割合と、1人当たりの指標。
// 「読み方」ボックスは、人件費の増減と粗利の増減のどちらが効いたのかを実データから判定して出し分ける。
import type { ReportV2Context } from '../types'
import { amt, esc, negCls, pageFoot, pageHead, pct, ptv, section, unitLabel, unitWord } from '../theme'
import { laborChart } from '../charts'

export function pageLabor(ctx: ReportV2Context): string {
  const u = ctx.unit
  const w = unitWord(u)
  const L = ctx.labor
  const hasEmp = L.employees != null && L.employees > 0
  const diffPt = L.share != null && L.sharePrior != null ? L.share - L.sharePrior : null

  const lead = L.share == null
    ? `売上総利益（粗利）が算定できないため、労働分配率を計算できません。試算表の取込内容をご確認ください。`
    : `労働分配率は <span class="mg">${esc(pct(L.share))}</span>` +
      (L.sharePrior != null
        ? Math.abs(diffPt as number) < 0.05
          ? `（前期同期 ${esc(pct(L.sharePrior))}、<b>ほぼ横ばい</b>）`
          : `（前期同期 ${esc(pct(L.sharePrior))}、<b>${esc(ptv(Math.abs(diffPt as number)))} ${(diffPt as number) < 0 ? '改善' : '悪化'}</b>）`
        : '') +
      `。稼いだ粗利のうち人件費に回っている割合です。` +
      (hasEmp && L.perGross != null
        ? `1人当たり売上総利益は <b>${esc(amt(L.perGross, u))}${esc(w)}</b>${L.perGrossPrior != null ? `（前期 ${esc(amt(L.perGrossPrior, u))}${esc(w)}）` : ''}です。`
        : `従業員数を入力すると、1人当たりの売上高・粗利・人件費も表示されます。`) +
      `一般的な目安は45〜55%で、現在は${L.share < 45 ? '余裕のある' : L.share <= 55 ? '健全な' : '高めの'}水準です。`

  const card = (label: string, value: string, sub: string, hi = false) =>
    `<div class="card${hi ? ' hi' : ''}"><div class="cl">${esc(label)}</div><div class="cv sm">${esc(value)}</div><div class="cs">${esc(sub)}</div></div>`
  const per = (v: number | null, p: number | null) =>
    v == null ? '—' : amt(v, u)
  const perSub = (p: number | null) => (p == null ? '前期の記録なし' : `前期 ${amt(p, u)} ${w}`)

  const rows = L.rows.map((r) => {
    const cls = r.kind === 'key' ? ' class="key"' : r.kind === 'sub' ? ' class="sub"' : ''
    const nameCls = r.kind === 'ind' ? ' class="ind1"' : ''
    const diff = r.pre == null ? null : r.cur - r.pre
    const cell = (v: number | null) =>
      v == null ? '<td class="r">—</td>'
        : r.isRate ? `<td class="r${r.kind === 'key' ? ' mgv' : ''}">${esc(pct(v))}</td>`
          : `<td class="r${negCls(v)}">${esc(amt(v, u))}</td>`
    const diffCell = diff == null ? '<td class="r">—</td>'
      : r.isRate ? `<td class="r">${esc(ptv(diff))}</td>`
        : `<td class="r${negCls(diff)}">${esc(amt(diff, u))}</td>`
    return `<tr${cls}><td${nameCls}>${esc(r.label)}</td>${cell(r.cur)}${cell(r.pre)}${diffCell}</tr>`
  }).join('')

  // ---- 読み方（実データから出し分ける） ----
  const dLabor = L.laborPrior != null ? L.labor - L.laborPrior : null
  const dGross = L.grossPrior != null ? L.gross - L.grossPrior : null
  let howto: string
  if (diffPt == null || dLabor == null || dGross == null) {
    howto = `前期の同時期のデータが無いため、増減の理由は判定できません。前期の試算表CSVを取り込むと比較できます。`
  } else if (Math.abs(diffPt) < 0.05) {
    howto = `労働分配率は前期同期とほぼ同じ水準です。人件費（${esc(amt(dLabor, u))}${esc(w)}）と粗利（${esc(amt(dGross, u))}${esc(w)}）が同じ方向に同じ割合で動いており、<b>稼ぐ力と人件費のバランスは維持できています</b>。`
  } else if (diffPt < 0) {
    howto = dGross > 0 && dGross > dLabor
      ? `労働分配率が下がっているのは、人件費の増加（${esc(amt(dLabor, u))}${esc(w)}）を上回って粗利が増えた（${esc(amt(dGross, u))}${esc(w)}）ためです。人を減らしたわけではなく、<b>1人当たりの生み出す粗利が増えた</b>ことによる改善です。`
      : `労働分配率が下がっているのは、粗利の変化（${esc(amt(dGross, u))}${esc(w)}）に対して人件費が ${esc(amt(dLabor, u))}${esc(w)} にとどまったためです。<b>人件費の抑制による改善</b>なので、必要な人員まで削っていないかは合わせてご確認ください。`
  } else {
    howto = dGross < 0
      ? `労働分配率が上がっているのは、粗利が ${esc(amt(dGross, u))}${esc(w)} 減ったのに人件費が ${esc(amt(dLabor, u))}${esc(w)} 動いたためです。<b>売上・粗利の回復が本筋</b>で、人件費の削減が先ではありません。`
      : `労働分配率が上がっているのは、粗利の増加（${esc(amt(dGross, u))}${esc(w)}）を超えて人件費が増えた（${esc(amt(dLabor, u))}${esc(w)}）ためです。増員・昇給が売上に結びつくまでの先行投資か、恒常的な負担かを見極める時期です。`
  }

  return section(`
  ${pageHead({
    no: ctx.pageNo('labor'),
    title: '労働分配率と生産性',
    metaHtml: hasEmp
      ? `従業員数はアプリで入力（当期 ${L.employees}名${L.employeesPrior != null ? `／前期 ${L.employeesPrior}名` : ''}）<br>${esc(unitLabel(u))}`
      : `従業員数が未入力です（アプリで入力すると1人当たり指標が出ます）<br>${esc(unitLabel(u))}`,
  })}
  <div class="lead">${lead}</div>

  <div class="cards">
    ${card('労働分配率', pct(L.share), `人件費 ${amt(L.labor, u)} ÷ 売上総利益 ${amt(L.gross, u)}`, true)}
    ${card('従業員数', hasEmp ? `${L.employees} 名` : '—', L.employeesPrior != null ? `前期 ${L.employeesPrior}名（${(L.employees ?? 0) - L.employeesPrior >= 0 ? '＋' : '△'}${Math.abs((L.employees ?? 0) - L.employeesPrior)}名）` : '前期の入力なし')}
    ${card('1人当たり売上高', per(L.perSales, L.perSalesPrior), perSub(L.perSalesPrior))}
    ${card('1人当たり売上総利益', per(L.perGross, L.perGrossPrior), perSub(L.perGrossPrior))}
    ${card('1人当たり人件費', per(L.perLabor, L.perLaborPrior), perSub(L.perLaborPrior))}
  </div>

  <div class="grid">
    <div class="col">
      <div class="blk-t">計算の内訳<span class="sub">期首〜${esc(ctx.monthLabel)}（${ctx.monthsDone}か月）累計</span></div>
      <div class="unit">${esc(unitLabel(u))}</div>
      <table class="cmp">
        <colgroup><col><col style="width:24mm"><col style="width:24mm"><col style="width:20mm"></colgroup>
        <thead><tr><th class="l">項目</th><th>当期</th><th>前期同期</th><th>増減</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="note">人件費には役員報酬・給料手当・雑給・賞与・法定福利費・福利厚生費・労務費を含めています（売上原価に含まれる労務費も対象）。</div>
    </div>

    <div class="col">
      <div class="blk-t">労働分配率の推移<span class="sub">期首からの累計ベース（賞与月の跳ねを除くため）</span></div>
      ${laborChart(ctx)}
      <div class="mt2" style="border:0.3mm solid var(--ink); padding:1.8mm 2mm;">
        <div style="font-size:7.5pt; font-weight:700; margin-bottom:0.8mm;">読み方</div>
        <div style="font-size:8pt; line-height:1.5;">${howto}</div>
      </div>
    </div>
  </div>
  ${pageFoot(ctx.company, ctx.fyLabel, ctx.ymLabel, ctx.pageNo('labor'))}`)
}
