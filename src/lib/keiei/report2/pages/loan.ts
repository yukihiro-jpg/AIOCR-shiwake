// 借入金とフリーキャッシュフロー。毎月の返済原資が確保できているかを1枚で示す。
import type { ReportV2Context } from '../types'
import { amt, esc, negCls, pageFoot, pageHead, pct, section, unitLabel, unitWord } from '../theme'
import { loanChart } from '../charts'

export function pageLoan(ctx: ReportV2Context): string {
  const u = ctx.unit
  const w = unitWord(u)
  const l = ctx.loan

  // 借入がまったく無い会社でも紙面が破綻しないようにする
  if (l.interestBearing <= 0) {
    return section(`
    ${pageHead({ no: ctx.pageNo('loan'), title: '借入金とフリーキャッシュフロー', metaHtml: esc(unitLabel(u)) })}
    <div class="lead">当月末時点で<b>金融機関からの借入金・リース債務はありません</b>。本業で生み出した資金（フリーCF ${esc(amt(l.fcf, u))}${esc(w)}）は、そのまま設備投資や手元資金の厚みに使えます。自己資本比率は ${esc(pct(l.equityRatio))} です。</div>
    <div class="cards">
      <div class="card hi"><div class="cl">フリーCF（${ctx.monthsDone}か月）</div><div class="cv">${esc(amt(l.fcf, u))}</div><div class="cs">営業${amt(l.operatingCf, u)}＋投資${amt(l.investingCf, u)}</div></div>
      <div class="card"><div class="cl">自己資本比率</div><div class="cv sm">${esc(pct(l.equityRatio))}</div><div class="cs">目安：30%以上</div></div>
      <div class="card"><div class="cl">返済原資（年換算）</div><div class="cv sm">${esc(amt(l.sourceAnnual, u))}</div><div class="cs">税引後利益＋減価償却</div></div>
    </div>
    ${pageFoot(ctx.company, ctx.fyLabel, ctx.ymLabel, ctx.pageNo('loan'))}`)
  }

  const cov = l.coverage
  const lead = `年間返済額は <b>${esc(amt(l.annualRepay, u))}${esc(w)}</b>（月 ${esc(amt(l.monthlyRepay, u))}${esc(w)}）に対し、返済原資（税引後利益＋減価償却の年換算）は ` +
    (cov == null
      ? `<b>${esc(amt(l.sourceAnnual, u))}${esc(w)}</b>です。`
      : cov >= 1
        ? `<span class="mg">${esc(amt(l.sourceAnnual, u))}${esc(w)}・返済額の${cov.toFixed(1)}倍</span>。毎月の返済は無理なく賄えています。`
        : `<b>${esc(amt(l.sourceAnnual, u))}${esc(w)}にとどまり、返済額の${cov.toFixed(1)}倍しかありません</b>。返済のたびに手元資金が減る構造です。`) +
    (l.payoffYears != null
      ? `債務償還年数は <b>${l.payoffYears.toFixed(1)}年</b>で、金融機関の目安（10年以内）を${l.payoffYears <= 10 ? '満たしています' : '超えています'}。`
      : '返済原資がマイナスのため債務償還年数は算定できません。')

  const card = (label: string, value: string, sub: string, hi = false) =>
    `<div class="card${hi ? ' hi' : ''}"><div class="cl">${esc(label)}</div><div class="cv sm">${esc(value)}</div><div class="cs">${esc(sub)}</div></div>`

  const srcRows = [
    ['税引後当期純利益', l.afterTaxYtd, l.afterTaxAnnual, ''],
    ['減価償却費', l.depYtd, l.depAnnual, ''],
    ['返済原資（簡易CF）', l.sourceYtd, l.sourceAnnual, 'key'],
    ['約定返済額', -l.monthlyRepay * ctx.monthsDone, -l.annualRepay, ''],
    ['返済後に残る資金', l.restYtd, l.restAnnual, 'sub'],
  ].map(([label, a, b, kind]) => {
    const cls = kind === 'key' ? ' class="key"' : kind === 'sub' ? ' class="sub"' : ''
    return `<tr${cls}><td>${esc(String(label))}</td>` +
      `<td class="r${negCls(a as number)}">${esc(amt(a as number, u))}</td>` +
      `<td class="r${kind === 'key' ? ' mgv' : negCls(b as number)}">${esc(amt(b as number, u))}</td></tr>`
  }).join('')

  const schedRows = l.schedule.map((s) =>
    `<tr><td>${esc(s.label)}</td><td class="r">${esc(amt(s.repay, u))}</td><td class="r">${esc(amt(s.closing, u))}</td></tr>`).join('')

  return section(`
  ${pageHead({
    no: ctx.pageNo('loan'),
    title: '借入金とフリーキャッシュフロー',
    metaHtml: `毎月の返済原資が確保できているか<br>${esc(unitLabel(u))}`,
  })}
  <div class="lead">${lead}</div>

  <div class="cards">
    ${card('返済カバー率', cov == null ? '—' : `${cov.toFixed(1)} 倍`, `返済原資 ${amt(l.sourceAnnual, u)} ÷ 年間返済 ${amt(l.annualRepay, u)}`, true)}
    ${card(`有利子負債（${ctx.monthLabel}末）`, amt(l.interestBearing, u), `借入 ${amt(l.loanBal, u)}／リース ${amt(l.leaseBal, u)}`)}
    ${card('債務償還年数', l.payoffYears == null ? '—' : `${l.payoffYears.toFixed(1)} 年`, '目安：10年以内')}
    ${card(`フリーCF（${ctx.monthsDone}か月）`, amt(l.fcf, u), `営業 ${amt(l.operatingCf, u)}＋投資 ${amt(l.investingCf, u)}`)}
    ${card('自己資本比率', pct(l.equityRatio), '目安：30%以上')}
  </div>

  <div class="grid">
    <div class="col">
      <div class="blk-t">借入金残高と毎月の返済<span class="sub">棒＝有利子負債残高／線＝毎月の返済原資（簡易CF）</span></div>
      ${loanChart(ctx)}
      <div class="note">返済原資＝税引後当期純利益＋減価償却費（期首からの累計を経過月数で割った月平均）。棒は各月末の借入金＋リース債務の残高です。</div>
    </div>
    <div class="col">
      <div class="blk-t">返済原資の内訳<span class="sub">期首〜${esc(ctx.monthLabel)}（${ctx.monthsDone}か月）と年換算</span></div>
      <div class="unit">${esc(unitLabel(u))}</div>
      <table class="cmp">
        <colgroup><col><col style="width:24mm"><col style="width:24mm"></colgroup>
        <thead><tr><th class="l">項目</th><th>${ctx.monthsDone}か月</th><th>年換算</th></tr></thead>
        <tbody>${srcRows}</tbody>
      </table>
      <div class="blk-t mt2">来期以降の返済予定<span class="sub">現在の約定返済が続いた場合</span></div>
      <table class="cmp">
        <colgroup><col><col style="width:26mm"><col style="width:26mm"></colgroup>
        <thead class="plain"><tr><th class="l">年度</th><th>返済額</th><th>期末残高</th></tr></thead>
        <tbody>${schedRows}</tbody>
      </table>
      <div class="note">新規の借入・借換えがない前提の単純な見通しです。設備投資の予定がある場合は、投資額と返済原資を合わせてご相談ください。</div>
    </div>
  </div>
  ${pageFoot(ctx.company, ctx.fyLabel, ctx.ymLabel, ctx.pageNo('loan'))}`)
}
