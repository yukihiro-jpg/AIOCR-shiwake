// 損益計算書 3期推移（全科目）。
// 科目を縦に、その中で当期・前期・前々期の3段。横は12か月＋合計額（年計）＋累計額（期首〜報告月）。
// 当期の段だけシアン網＋太字にして、目で追う行が迷わないようにしている。
//
// 用紙の逃がし方（ユーザー確定済み）:
//  - 千円表示なら A4横1枚に12か月が収まる
//  - 円表示で A4横のときは 12か月が入らないので、前半6か月／後半6か月の2枚に分ける
//  - 円表示でも A3横を選べば1枚に12か月を収める
import type { ReportV2Context } from '../types'
import { amt, esc, negCls, pageFoot, pageHead, unitWord } from '../theme'

const PER_PAGE = 12 // 1ページあたりの科目数（1科目＝3行）

export function pagesTrend3(ctx: ReportV2Context): string[] {
  const u = ctx.unit
  const t = ctx.trend3
  const w = unitWord(u)
  const a3 = ctx.trendPaper === 'a3'
  // 円表示のA4横は12か月が入らないので前半・後半に割る
  const split: [number, number][] = u === 'yen' && !a3 ? [[0, 5], [6, 11]] : [[0, 11]]

  const chunks: typeof t.rows[] = []
  for (let i = 0; i < t.rows.length; i += PER_PAGE) chunks.push(t.rows.slice(i, i + PER_PAGE))
  if (!chunks.length) chunks.push([])

  const out: string[] = []
  let offset = 0
  for (const [from, to] of split) {
    const span = to - from + 1
    const monthW = a3 ? (span <= 6 ? 26 : 21.5) : (span <= 6 ? 24 : 15.2)
    const cols = `<colgroup><col style="width:${a3 ? 44 : 36}mm"><col style="width:11mm">`
      + t.months.slice(from, to + 1).map(() => `<col style="width:${monthW}mm">`).join('')
      + `<col style="width:19mm"><col style="width:19mm"></colgroup>`
    const head = `<thead><tr><th class="l" rowspan="2">科目</th><th class="l" rowspan="2">期</th>`
      + t.months.slice(from, to + 1).map((m) => `<th>${m}月</th>`).join('')
      + `<th>合計額</th><th>累計額</th></tr>`
      + `<tr>${t.months.slice(from, to + 1).map(() => '<th class="sm"></th>').join('')}<th class="sm">年計</th><th class="sm">期首〜${esc(ctx.monthLabel)}</th></tr></thead>`

    chunks.forEach((rows, ci) => {
      const body = rows.map((r) => {
        const kindCls = r.kind === 'key' ? ' k' : r.kind === 'sub' ? ' g' : ''
        return t.periodLabels.map((pl, pi) => {
          const vals = r.series[pi]
          const year = vals.reduce((s: number, v) => s + (v ?? 0), 0)
          const cumv = vals.slice(0, t.reportIdx + 1).reduce((s: number, v) => s + (v ?? 0), 0)
          const first = pi === 0 ? ' first' : ''
          const cur = pi === 0 ? ' cur' : ''
          const cells = vals.slice(from, to + 1).map((v) =>
            `<td class="r${negCls(v)}">${v == null ? '—' : esc(amt(v, u))}</td>`).join('')
          return `<tr class="b${kindCls}${first}${cur}">`
            + (pi === 0 ? `<td class="nm" rowspan="3">${esc(r.name)}</td>` : '')
            + `<td class="pl">${esc(pl)}</td>${cells}`
            + `<td class="r sumc${negCls(year)}">${esc(amt(year, u))}</td>`
            + `<td class="r sumc${negCls(cumv)}">${esc(amt(cumv, u))}</td></tr>`
        }).join('')
      }).join('')

      const cont = ci > 0 || from > 0
      const rangeLabel = split.length > 1 ? `（${t.months[from]}月〜${t.months[to]}月）` : ''
      // pageHead はタイトルをエスケープするので、続き表示は素の文字列で足す
      const titleSuffix = `${rangeLabel}${cont && !rangeLabel ? '（続き）' : ''}`
      const last = ci === chunks.length - 1 && to === split[split.length - 1][1]
      const note = last
        ? `当期の未入力月は「—」です。金額は画面で<b>円／千円</b>を切り替えられます。${u === 'yen' && !a3 ? '円単位はA4横1枚に12か月が入らないため、<b>前半6か月／後半6か月の2枚に分けて</b>出力しています（用紙をA3横にすれば1枚に収まります）。' : '用紙をA3横にすると列幅を広く取れます。'}`
        : `科目ごとに当期・前期・前々期を3段で並べています。ページが分かれても列幅と見出しは同じです。次のページへ続きます。`
      const no = ctx.pageNo('trend3') + offset
      out.push(`<section class="page${a3 ? ' a3' : ''}">
  ${pageHead({
        no,
        title: `損益計算書 3期推移（全科目）${titleSuffix ? `　${titleSuffix}` : ''}`,
        metaHtml: `各科目を当期・前期・前々期の3段で表示（単月発生額）<br>網かけの段＝<b>当期</b>／合計額＝年計・累計額＝期首〜${esc(ctx.monthLabel)}　単位：${esc(w)}`,
      })}
  <table class="tr3" style="margin-top:2.2mm">
    ${cols}
    ${head}
    <tbody>${body}</tbody>
  </table>
  <div class="note mt2">${note}</div>
  ${pageFoot(ctx.company, ctx.fyLabel, ctx.ymLabel, no)}
</section>`)
      offset++
    })
  }
  return out
}
