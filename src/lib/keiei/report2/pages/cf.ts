// キャッシュ・フロー計算書（間接法・営業／投資／財務の3区分）。
// 3区分の符号の組み合わせは8通りあり、その型によって「何が起きているか」がまったく違うので、
// 該当する型を判定して見出し直下のコメントを自動で切り替える（旧レポートは固定文だった）。
import type { ReportV2Context } from '../types'
import { amt, esc, negCls, pageFoot, pageHead, section, unitLabel, unitWord } from '../theme'
import { CF_PATTERN_ROWS, cfPatternMark } from '../cf-comment'

const RESIDUAL_WARN = 2_000_000 // 差額がこれを超えたら要確認として注記を出す

export function pageCf(ctx: ReportV2Context): string {
  const u = ctx.unit
  const w = unitWord(u)
  const cf = ctx.cashflow
  const sub = (k: 'op' | 'inv' | 'fin') => cf.sections.find((s) => s.key === k)?.subtotal ?? 0
  const op = sub('op'), inv = sub('inv'), fin = sub('fin')
  const mark = cfPatternMark(ctx.cfPattern.sign)

  const signed = (v: number) => `${v >= 0 ? '＋' : '△'}${amt(Math.abs(v), u)}`

  const lead = `<b>営業 ${esc(signed(op))} ／ 投資 ${esc(signed(inv))} ／ 財務 ${esc(signed(fin))}</b> の組み合わせ` +
    `（${esc(ctx.cfPattern.sign)}${mark !== '—' ? `＝${esc(mark)}` : ''}）です。` +
    `<span class="mg">${esc(ctx.cfPattern.title)}</span>で、現預金は期首から <b>${esc(signed(cf.actualCashChange))}${esc(w)}</b> 変化しました。` +
    `${esc(ctx.cfPattern.body)}`

  const sectionTable = (key: 'op' | 'inv' | 'fin') => {
    const s = cf.sections.find((x) => x.key === key)
    if (!s) return ''
    const rows = s.items.map((it) =>
      `<tr><td>${esc(it.label)}</td><td class="r${negCls(it.amount)}">${esc(amt(it.amount, u))}</td></tr>`).join('')
    return `<table class="cmp">
      <colgroup><col><col style="width:24mm"></colgroup>
      <thead class="plain"><tr><th class="l">${esc(s.title)}</th><th>金額</th></tr></thead>
      <tbody>${rows}
        <tr class="total"><td>${esc(s.title.replace('によるキャッシュフロー', 'CF 小計'))}</td><td class="r${negCls(s.subtotal)}">${esc(amt(s.subtotal, u))}</td></tr>
      </tbody>
    </table>`
  }

  const summary = `<table class="cmp">
    <colgroup><col><col style="width:26mm"></colgroup>
    <thead class="plain"><tr><th class="l">現預金の増減</th><th>金額</th></tr></thead>
    <tbody>
      <tr><td>期首の現預金</td><td class="r">${esc(amt(cf.openingCash, u))}</td></tr>
      <tr><td>営業活動によるCF</td><td class="r${negCls(op)}">${esc(amt(op, u))}</td></tr>
      <tr><td>投資活動によるCF</td><td class="r${negCls(inv)}">${esc(amt(inv, u))}</td></tr>
      <tr><td>財務活動によるCF</td><td class="r${negCls(fin)}">${esc(amt(fin, u))}</td></tr>
      <tr class="key"><td>増減 合計</td><td class="r${negCls(cf.netCf)}">${esc(amt(cf.netCf, u))}</td></tr>
      <tr class="total"><td>${esc(ctx.monthLabel)}末の現預金</td><td class="r mgv">${esc(amt(cf.closingCash, u))}</td></tr>
    </tbody>
  </table>`

  const patternRows = CF_PATTERN_ROWS.map((r) => {
    const on = r.sign === ctx.cfPattern.sign
    return `<tr${on ? ' class="key"' : ''}><td class="c">${esc(r.mark)}</td><td class="c">${esc(r.op)}</td><td class="c">${esc(r.inv)}</td><td class="c">${esc(r.fin)}</td><td>${esc(r.meaning)}</td></tr>`
  }).join('')

  const residualNote = Math.abs(cf.residual) > RESIDUAL_WARN
    ? `<div class="note"><b>※ 3区分の合計と実際の現預金増減に ${esc(amt(cf.residual, u))}${esc(w)} の差があります。</b>取込んだ試算表に振替伝票の相殺や科目の付替えが含まれている可能性があるため、内訳をご確認ください。</div>`
    : `<div class="note">3区分の合計は貸借対照表の恒等式そのものなので、実際の現預金増減と一致します（差額 ${esc(amt(cf.residual, u))}${esc(w)}）。</div>`

  return section(`
  ${pageHead({
    no: ctx.pageNo('cf'),
    title: 'キャッシュ・フロー計算書（間接法）',
    metaHtml: `期首〜${esc(ctx.ymLabel)}（${cf.months}か月）<br>${esc(unitLabel(u))}`,
  })}
  <div class="lead">${lead}</div>

  <div class="grid">
    <div class="col" style="flex:1.35">${sectionTable('op')}</div>
    <div class="col">${sectionTable('inv')}${sectionTable('fin')}</div>
    <div class="col" style="flex:0.95">
      ${summary}
      ${residualNote}
      <div class="blk-t mt2">3つのCFの組み合わせ<span class="sub">網かけが当社の型</span></div>
      <table class="cmp">
        <colgroup><col style="width:7mm"><col style="width:7mm"><col style="width:7mm"><col style="width:7mm"><col></colgroup>
        <thead class="plain"><tr><th class="l">＃</th><th>営業</th><th>投資</th><th>財務</th><th class="l">意味</th></tr></thead>
        <tbody>${patternRows}</tbody>
      </table>
    </div>
  </div>
  ${pageFoot(ctx.company, ctx.fyLabel, ctx.ymLabel, ctx.pageNo('cf'))}`)
}
