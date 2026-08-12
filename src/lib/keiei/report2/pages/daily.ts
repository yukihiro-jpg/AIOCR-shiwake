// 月次資金繰り表（日繰り）。
// 月初と月末だけを見ると増えていても、月中で資金が底をつくことがある。
// どの日に底が来るか・必要最低残高（既定＝月商の1/3）を割る期間はいつかを1枚で見せる。
import type { ReportV2Context } from '../types'
import { amt, esc, pageFoot, pageHead, section, unitLabel, unitWord } from '../theme'
import { dailyCashChart } from '../charts'

export function pageDaily(ctx: ReportV2Context): string {
  const u = ctx.unit
  const w = unitWord(u)
  const d = ctx.daily
  const short = Math.max(0, d.minRequired - d.minBalance)

  // ---- 危険水域の日をまとめて「26〜27日」の形にする ----
  const ranges: string[] = []
  let start: number | null = null
  let prev: number | null = null
  for (const day of d.dangerDays) {
    if (start == null) { start = day; prev = day; continue }
    if (prev != null && day === prev + 1) { prev = day; continue }
    ranges.push(start === prev ? `${start}日` : `${start}〜${prev}日`)
    start = day; prev = day
  }
  if (start != null) ranges.push(start === prev ? `${start}日` : `${start}〜${prev}日`)

  const lead = short > 0
    ? `月初 ${esc(amt(d.opening, u))}${esc(w)} → 月末 ${esc(amt(d.closing, u))}${esc(w)}。月の初めと終わりだけを見れば足りていますが、月中は一本調子ではありません。` +
      `<span class="mg">${esc(ranges.join('・'))}は必要最低残高 ${esc(amt(d.minRequired, u))}${esc(w)}を下回り、${d.minDay}日に ${esc(amt(d.minBalance, u))}${esc(w)}まで落ち込みます</span>` +
      `（不足 ${esc(amt(short, u))}${esc(w)}）。<b>入金が1日でも遅れると資金がショートします。</b>` +
      `引落日を月末へ寄せる・回収を前倒しする・当座貸越枠を用意する、のいずれかをご検討ください。`
    : `月初 ${esc(amt(d.opening, u))}${esc(w)} → 月末 ${esc(amt(d.closing, u))}${esc(w)}。` +
      `月中の最低残高は${d.minDay}日の <b>${esc(amt(d.minBalance, u))}${esc(w)}</b> で、<span class="mg">必要最低残高 ${esc(amt(d.minRequired, u))}${esc(w)}を下回る日はありません</span>。` +
      `当面の支払いに支障が出る心配はない資金繰りです。`

  const card = (label: string, value: string, sub: string, hi = false) =>
    `<div class="card${hi ? ' hi' : ''}"><div class="cl">${esc(label)}</div><div class="cv sm">${esc(value)}</div><div class="cs">${esc(sub)}</div></div>`

  // ---- 日別表（左右2ブロック） ----
  const half = Math.ceil(d.daysInMonth / 2)
  const block = (from: number, to: number) => {
    const rows = d.rows.filter((r) => r.day >= from && r.day <= to).map((r) => {
      const cls = r.bottom ? ' class="bt"' : r.danger ? ' class="dg"' : ''
      const note = r.bottom ? (r.note ? `${r.note}／★ この日が今月の底` : '★ この日が今月の底') : r.note
      return `<tr${cls}><td class="c">${r.day}</td><td class="c">${esc(r.dow)}</td>` +
        `<td class="r">${r.income ? esc(amt(r.income, u)) : ''}</td>` +
        `<td class="r">${r.outgo ? esc(amt(r.outgo, u)) : ''}</td>` +
        `<td class="r"><b>${esc(amt(r.balance, u))}</b></td>` +
        `<td class="nt">${esc(note)}</td></tr>`
    }).join('')
    return `<table class="day">
      <colgroup><col style="width:7mm"><col style="width:7mm"><col style="width:17mm"><col style="width:17mm"><col style="width:19mm"><col></colgroup>
      <thead><tr><th class="l">日</th><th class="l">曜</th><th>入金</th><th>出金</th><th>当日残高</th><th class="l">主な入出金</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`
  }

  return section(`
  ${pageHead({
    no: ctx.pageNo('daily'),
    title: '月次資金繰り表（日繰り）',
    metaHtml: `${d.year}年${d.month}月1日 〜 ${d.month}月${d.daysInMonth}日<br>${esc(unitLabel(u))}`,
  })}
  <div class="lead">${lead}</div>

  <div class="cards">
    ${card('月初残高', amt(d.opening, u), `${d.month}月1日`)}
    ${card('入金合計', amt(d.incomeTotal, u), '売掛回収・その他入金')}
    ${card('出金合計', amt(d.outgoTotal, u), '仕入・人件費・経費・返済')}
    ${card('月中の最低残高', amt(d.minBalance, u), short > 0 ? `${d.month}/${d.minDay}・必要最低残高に ${amt(short, u)}不足` : `${d.month}/${d.minDay}・必要最低残高は確保`, true)}
    ${card('月末残高', amt(d.closing, u), `${d.month}月${d.daysInMonth}日`)}
  </div>

  <div style="font-size:8.5pt; font-weight:700; margin-top:2mm;">日次の現預金残高<span style="font-weight:400; font-size:7.5pt; color:var(--ink70); margin-left:2mm;">網かけの帯＝必要最低残高を下回る危険水域（必要最低残高の既定＝月商の1/3。顧問先ごとに変更できます）</span></div>
  ${dailyCashChart(ctx)}

  <div class="grid" style="margin-top:1.5mm; gap:4mm">
    <div class="col">${block(1, half)}</div>
    <div class="col">${block(half + 1, d.daysInMonth)}</div>
  </div>
  <div class="note">入出金は会計データの実績（当月の売上・仕入・人件費・経費・返済）を、登録済みの支払・回収サイクル（締日・支払日）から日付に割り当てた<b>推計</b>です。月初残高＋入金−出金は必ず月末残高に一致します。予定を画面で修正すると、この表とグラフはその場で計算し直されます。${d.reliable ? '' : '　※ 前月末の残高が取込データに無いため、当月の増減から逆算しています。'}</div>
  ${pageFoot(ctx.company, ctx.fyLabel, ctx.ymLabel, ctx.pageNo('daily'))}`)
}
