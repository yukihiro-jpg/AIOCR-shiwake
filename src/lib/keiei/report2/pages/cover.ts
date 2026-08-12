// 表紙。左に「本日ご報告する資料」、右に「今月の要点」。
// 要点は ctx の実データから毎回組み立てる（定型文を貼らない）。社長がここだけ読んでも
// 「今月どうだったか・お金は足りるか・税金はいくら要るか」が分かる4文にしている。
import type { ReportV2Context } from '../types'
import { REPORT_V2_PAGES } from '../types'
import { amt, amtWord, esc, pageFoot, section, unitWord } from '../theme'
import { monthValues } from '../context'

export function pageCover(ctx: ReportV2Context): string {
  const u = ctx.unit
  const m = monthValues(ctx.fy, ctx.monthIdx)
  const body = ctx.pages.filter((k) => k !== 'cover')
  const titleOf = (k: string) => REPORT_V2_PAGES.find(([x]) => x === k)?.[1] || ''

  const toc = body.map((k) => `<tr><td style="width:12mm" class="c">${ctx.pageNo(k)}</td><td>${esc(titleOf(k))}</td></tr>`).join('')

  // ---- 今月の要点 ----
  const lines: string[] = []
  lines.push(
    `${esc(ctx.monthLabel)}の売上高は <b>${esc(amtWord(m.sales, u))}</b>、営業利益は <b>${esc(amtWord(m.opProfit, u))}</b>。`,
  )
  if (ctx.landing.partial) {
    lines.push(
      `通期は当期平均で着地すると <span class="mg">売上 ${esc(amt(ctx.landing.salesA, u))}${esc(unitWord(u))}・営業利益 ${esc(amt(ctx.landing.opA, u))}${esc(unitWord(u))}</span>、` +
      `納税は <b>法人税等 ${esc(amt(ctx.corpTax.total, u))}${esc(unitWord(u))}・消費税 ${esc(amt(ctx.vat.annual, u))}${esc(unitWord(u))}</b> の見込みです。`,
    )
  } else {
    lines.push(`通期は <span class="mg">売上 ${esc(amtWord(ctx.landing.salesA, u))}・営業利益 ${esc(amtWord(ctx.landing.opA, u))}</span> で確定しました。`)
  }
  if (ctx.loan.annualRepay > 0 && ctx.loan.coverage != null) {
    lines.push(
      ctx.loan.coverage >= 1
        ? `本業で稼いだ資金に対し、<b>返済原資（年換算 ${esc(amt(ctx.loan.sourceAnnual, u))}${esc(unitWord(u))}）は年間返済 ${esc(amt(ctx.loan.annualRepay, u))}${esc(unitWord(u))}の${ctx.loan.coverage.toFixed(1)}倍</b>を確保できています。`
        : `<b>返済原資（年換算 ${esc(amt(ctx.loan.sourceAnnual, u))}${esc(unitWord(u))}）が年間返済 ${esc(amt(ctx.loan.annualRepay, u))}${esc(unitWord(u))}に届いていません</b>（${ctx.loan.coverage.toFixed(1)}倍）。返済条件の見直しを含めてご相談ください。`,
    )
  }
  const dailyNo = ctx.pageNo('daily')
  if (ctx.daily.minBalance < ctx.daily.minRequired) {
    lines.push(
      `月中の資金は ${ctx.daily.month}月${ctx.daily.minDay}日に <b>${esc(amtWord(ctx.daily.minBalance, u))}</b> まで下がり、` +
      `必要最低残高 ${esc(amtWord(ctx.daily.minRequired, u))} を下回ります${dailyNo ? `（${dailyNo}ページ）` : ''}。支払日の見直しをご検討ください。`,
    )
  } else {
    lines.push(`月中の資金は ${ctx.daily.month}月${ctx.daily.minDay}日の <b>${esc(amtWord(ctx.daily.minBalance, u))}</b> が底で、必要最低残高は下回りません${dailyNo ? `（${dailyNo}ページ）` : ''}。`)
  }

  return section(`
  <div style="height:52mm"></div>
  <div style="border-top:0.9mm solid var(--ink); border-bottom:0.9mm solid var(--ink); padding:7mm 0; position:relative;">
    <div style="position:absolute; left:0; top:-0.9mm; width:60mm; height:0.9mm; background:var(--mg);"></div>
    <div style="font-size:9.5pt; letter-spacing:.5em; color:var(--ink70);">MONTHLY MANAGEMENT REPORT</div>
    <div style="font-size:26pt; font-weight:700; margin-top:2mm; letter-spacing:.06em;">月次経営レポート</div>
    <div style="font-size:12pt; margin-top:3mm;">${esc(ctx.company)}　御中</div>
    <div style="font-size:10pt; color:var(--ink70); margin-top:1.5mm;">${esc(ctx.fyLabel)}（${esc(ctx.periodLabel)}）　<b style="color:var(--mg)">${esc(ctx.ymLabel)}</b></div>
  </div>
  <div style="display:flex; gap:8mm; margin-top:9mm;">
    <div style="flex:1">
      <div class="blk-t">本日ご報告する資料</div>
      <table><tbody>${toc}</tbody></table>
    </div>
    <div style="flex:1.15">
      <div class="blk-t">今月の要点</div>
      <div style="border-left:1.2mm solid var(--mg); background:var(--ink08); padding:2.4mm 3mm; font-size:9.5pt; line-height:1.6;">
        ${lines.map((t) => `<div>${t}</div>`).join('')}
      </div>
      <div class="note">金額はすべて${esc(unitWord(u))}です。マイナスは △ で表しています。</div>
    </div>
  </div>
  ${pageFoot(ctx.company, ctx.fyLabel, ctx.ymLabel, ctx.pageNo('cover'))}`)
}
