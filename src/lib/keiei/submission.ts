import type { FiscalYearData } from './types'
import { CODES, singleMonth, ytd } from './calc'
import { aggregateRows, aggRowValue, type AggRow } from './analysis'

export type ReportKey = 'trialPL' | 'trialBS' | 'cmpPL' | 'cmpBS' | 'trendPL' | 'trendBS' | 'trend3PL'
export const REPORT_KEYS: ReportKey[] = ['trialPL', 'trialBS', 'cmpPL', 'cmpBS', 'trendPL', 'trendBS', 'trend3PL']
export const REPORT_LABELS: Record<ReportKey, string> = {
  trialPL: '月次試算表(PL)', trialBS: '月次試算表(BS)',
  cmpPL: '3期比較(PL)', cmpBS: '3期比較(BS)',
  trendPL: '推移表(PL)', trendBS: '推移表(BS)',
  trend3PL: '3期PL推移表（A3縦）',
}
// A3縦で出力する帳票（横幅はA4横と同じ297mm。縦が長く明細の多い表に好適）
const A3_PORTRAIT_KEYS: ReportKey[] = ['trend3PL']

function fmtAcct(n: number): string {
  if (!n) return '0'
  const a = Math.round(Math.abs(n)).toLocaleString('ja-JP')
  return n < 0 ? `△${a}` : a
}
function pct(n: number): string { return `${n >= 0 ? '' : '−'}${Math.abs(n).toFixed(1)}%` }
function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] || c))
}

interface DataRow { r: AggRow; cells: string[] }
function tableHtml(headers: string[], rows: DataRow[]): string {
  const head = `<tr><th class="name">科目</th>${headers.map((h) => `<th class="num">${esc(h)}</th>`).join('')}</tr>`
  const body = rows.map(({ r, cells }) => {
    const cls = r.isSubtotal ? (r.bracket === 'profit' ? 'sub profit' : 'sub') : ''
    const pad = 4 + r.level * 10
    return `<tr class="${cls}"><th class="name" style="padding-left:${pad}px">${esc(r.name)}</th>${cells.map((c) => `<td class="num">${c}</td>`).join('')}</tr>`
  }).join('')
  return `<table class="grid"><thead>${head}</thead><tbody>${body}</tbody></table>`
}

interface OneReport { title: string; sub: string; table: string }
function buildOne(key: ReportKey, fy: FiscalYearData, comp: FiscalYearData[], monthIdx: number): OneReport {
  const monthLabel = `${fy.fiscalMonths[monthIdx]}月`
  const months = fy.fiscalMonths.slice(0, monthIdx + 1)
  const rows = aggregateRows(fy)
  const salesYtd = ytd(fy, CODES.sales, monthIdx)
  const assetBal = singleMonth(fy, CODES.assetTotal, monthIdx)

  if (key === 'trialPL') {
    const data = rows.filter((r) => r.statement === 'PL').map((r) => {
      const single = aggRowValue(r, monthIdx, 'single'); const cum = aggRowValue(r, monthIdx, 'cum')
      return { r, cells: [fmtAcct(single), fmtAcct(cum), salesYtd ? `${(cum / salesYtd * 100).toFixed(1)}%` : ''] }
    })
    return { title: '損益計算書（月次試算表）', sub: `${monthLabel}単月 ／ 期首〜${monthLabel}累計`, table: tableHtml(['当月（単月）', '累計', '対売上比'], data) }
  }
  if (key === 'trialBS') {
    const data = rows.filter((r) => r.statement === 'BS').map((r) => {
      const cur = r.monthly[monthIdx] ?? 0; const prev = monthIdx > 0 ? (r.monthly[monthIdx - 1] ?? 0) : 0
      return { r, cells: [fmtAcct(prev), fmtAcct(cur), fmtAcct(cur - prev), assetBal ? `${(cur / assetBal * 100).toFixed(1)}%` : ''] }
    })
    return { title: '貸借対照表（月次試算表）', sub: `${monthLabel}末残高`, table: tableHtml(['前月末残高', '当月末残高', '増減', '構成比'], data) }
  }
  if (key === 'cmpPL' || key === 'cmpBS') {
    const statement = key === 'cmpPL' ? 'PL' : 'BS'
    const mode: 'single' | 'cum' = key === 'cmpPL' ? 'cum' : 'single'
    const maps = comp.map((y) => { const m = new Map<string, AggRow>(); for (const r of aggregateRows(y)) m.set(r.statement + '|' + r.name, r); return m })
    const cur = comp[comp.length - 1], prev = comp.length >= 2 ? comp[comp.length - 2] : null, prev2 = comp.length >= 3 ? comp[comp.length - 3] : null
    const iC = comp.length - 1, iP = comp.length - 2, iP2 = comp.length - 3
    const valFor = (yi: number, r: AggRow) => { const row = maps[yi]?.get(r.statement + '|' + r.name); return row ? aggRowValue(row, monthIdx, mode) : null }
    const data = rows.filter((r) => r.statement === statement).map((r) => {
      const vCur = valFor(iC, r) ?? 0; const vP = iP >= 0 ? valFor(iP, r) : null; const vP2 = iP2 >= 0 ? valFor(iP2, r) : null
      const diff = vP != null ? vCur - vP : null; const rate = vP != null && vP !== 0 ? (vCur - vP) / Math.abs(vP) * 100 : null
      return { r, cells: [vP2 == null ? '—' : fmtAcct(vP2), vP == null ? '—' : fmtAcct(vP), fmtAcct(vCur), diff == null ? '—' : fmtAcct(diff), rate == null ? '—' : pct(rate)] }
    })
    const headers = [prev2 ? prev2.label : '前々期', prev ? prev.label : '前期', `${cur.label}（当期）`, '前期比増減', '増減率']
    return { title: `${statement === 'PL' ? '損益計算書' : '貸借対照表'}（3期比較）`, sub: statement === 'PL' ? `期首〜${monthLabel}累計` : `${monthLabel}末残高`, table: tableHtml(headers, data) }
  }
  if (key === 'trend3PL') return buildTrend3(comp, monthIdx)
  // trendPL / trendBS
  const statement = key === 'trendPL' ? 'PL' : 'BS'
  const cumMode: 'single' | 'cum' = key === 'trendPL' ? 'cum' : 'single'
  const data = rows.filter((r) => r.statement === statement).map((r) => ({
    r, cells: [...months.map((_, i) => fmtAcct(r.monthly[i] ?? 0)), fmtAcct(aggRowValue(r, monthIdx, cumMode))],
  }))
  const headers = [...months.map((m) => `${m}月`), key === 'trendPL' ? '累計' : `${monthLabel}末`]
  return { title: `${statement === 'PL' ? '損益計算書' : '貸借対照表'}（月次推移）`, sub: statement === 'PL' ? `単月発生額 ／ 期首〜${monthLabel}` : `各月末残高 ／ 〜${monthLabel}`, table: tableHtml(headers, data) }
}

// いずれかの期に存在するPL科目を、当期→前期→前々期の順序を尊重してunion（欠落科目は直前科目の後ろに挿入）
function unionPL(comp: FiscalYearData[]): AggRow[] {
  const periods = [comp[comp.length - 1], comp[comp.length - 2] ?? null, comp[comp.length - 3] ?? null]
  const merged: AggRow[] = []
  const pos = new Map<string, number>()
  const rebuild = () => { pos.clear(); merged.forEach((r, i) => pos.set(r.name, i)) }
  const seed = periods.find((y) => y)
  if (seed) for (const r of aggregateRows(seed).filter((r) => r.statement === 'PL')) merged.push(r)
  rebuild()
  const weave = (y: FiscalYearData | null) => {
    if (!y) return
    let last = -1
    for (const r of aggregateRows(y).filter((x) => x.statement === 'PL')) {
      if (pos.has(r.name)) { last = pos.get(r.name)! }
      else { merged.splice(last + 1, 0, r); rebuild(); last = last + 1 }
    }
  }
  weave(periods[1]); weave(periods[2])
  return merged
}

// 3期PL推移表：各科目を当期/前期/前々期の3行で縦に並べ、月次推移＋合計（年計）＋期首〜選択月累計を表示
function buildTrend3(comp: FiscalYearData[], monthIdx: number): OneReport {
  const cur = comp[comp.length - 1]
  const periods = [comp[comp.length - 1], comp[comp.length - 2] ?? null, comp[comp.length - 3] ?? null]
  const labels = ['当期', '前期', '前々期']
  const months = cur.fiscalMonths
  const monthLabel = `${cur.fiscalMonths[monthIdx]}月`
  const maps = periods.map((y) => { const m = new Map<string, AggRow>(); if (y) for (const r of aggregateRows(y).filter((r) => r.statement === 'PL')) m.set(r.name, r); return m })
  const order = unionPL(comp)
  const cum = (row: AggRow | undefined) => { if (!row) return null; let s = 0; for (let i = 0; i <= monthIdx; i++) s += row.monthly[i] ?? 0; return s }

  const head = `<tr><th class="name">科目</th><th class="num kbnh">期</th>${months.map((m) => `<th class="num">${m}月</th>`).join('')}<th class="num">合計額<br><span class="th2">年計</span></th><th class="num">累計額<br><span class="th2">期首〜${esc(monthLabel)}</span></th></tr>`
  const body = order.map((base) => {
    const baseCls = base.isSubtotal ? (base.bracket === 'profit' ? 'sub profit' : 'sub') : ''
    const pad = 4 + base.level * 10
    const rows = periods.map((y, pi) => {
      const row = y ? maps[pi].get(base.name) : undefined
      const nameCell = pi === 0 ? `<th class="name" rowspan="3" style="padding-left:${pad}px">${esc(base.name)}</th>` : ''
      const totalV = row ? row.annual : null
      const cumV = cum(row)
      const monthCells = months.map((_, mi) => `<td class="num">${row ? fmtAcct(row.monthly[mi] ?? 0) : '—'}</td>`).join('')
      const rowCls = `${baseCls} r${pi}`.trim()
      return `<tr class="${rowCls}">${nameCell}<td class="num kbn">${labels[pi]}</td>${monthCells}<td class="num tot">${totalV == null ? '—' : fmtAcct(totalV)}</td><td class="num tot">${cumV == null ? '—' : fmtAcct(cumV)}</td></tr>`
    }).join('')
    return `<tbody class="acct">${rows}</tbody>` // 科目ごとに1tbody＝改ページで3行が分断されない
  }).join('')

  return {
    title: '損益計算書（3期推移）',
    sub: `当期・前期・前々期 ／ 単月発生額 ／ 合計＝年計・累計＝期首〜${monthLabel}`,
    table: `<table class="grid t3"><thead>${head}</thead>${body}</table>`,
  }
}

/** 選択した帳票を1ファイル（項目ごとに改ページ）として印刷ダイアログで開く */
export function openReportsPdf(company: string, fy: FiscalYearData, comp: FiscalYearData[], monthIdx: number, keys: ReportKey[]): void {
  if (!keys.length) return
  const monthLabel = `${fy.fiscalMonths[monthIdx]}月`
  const today = new Date()
  const dateStr = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`
  const co = company || '顧問先'
  const sections = keys.map((k) => {
    const o = buildOne(k, fy, comp, monthIdx)
    const a3 = A3_PORTRAIT_KEYS.includes(k) ? ' a3p' : ''
    return `<section class="report${a3}">
      <div class="head"><div><div class="ttl">${esc(o.title)}</div><div class="co">${esc(co)}　御中　<span class="sub2">${esc(o.sub)}</span></div></div>
      <div class="meta">${esc(fy.label)}<br>対象：期首〜${monthLabel}<br>作成日：${dateStr}</div></div>
      ${o.table}</section>`
  }).join('')
  const title = keys.length === 1 ? `${REPORT_LABELS[keys[0]]}_${co}_${fy.label}_${monthLabel}` : `月次帳票_${co}_${fy.label}_${monthLabel}`

  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${esc(title)}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:'Noto Sans JP','Hiragino Sans','Yu Gothic UI','Meiryo',sans-serif;color:#111;font-size:9px;}
    .report{padding:6mm;break-before:page;}
    .report:first-child{break-before:auto;}
    .head{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2px solid #1F3A5F;padding-bottom:6px;margin-bottom:10px;}
    .head .ttl{font-size:15px;font-weight:800;color:#1F3A5F;}
    .head .co{font-size:12px;font-weight:700;margin-top:2px;}
    .head .co .sub2{font-size:10px;color:#666;font-weight:400;}
    .head .meta{font-size:10px;color:#444;text-align:right;line-height:1.6;}
    table.grid{width:100%;border-collapse:collapse;}
    table.grid th,table.grid td{border:1px solid #cfd6e0;padding:2px 4px;white-space:nowrap;}
    table.grid thead th{background:#1F3A5F;color:#fff;font-weight:600;text-align:center;font-size:8.5px;}
    table.grid th.name{text-align:left;background:#f3f5f8;color:#222;}
    table.grid thead th.name{background:#1F3A5F;color:#fff;}
    td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;}
    tr.sub td,tr.sub th{background:#eef1f5;font-weight:700;}
    tr.sub.profit td,tr.sub.profit th{background:#e7eefc;color:#1F3A5F;}
    /* 3期PL推移表（科目ごとに当期/前期/前々期の3行） */
    table.t3{font-size:7.5px;}
    table.t3 th.name{vertical-align:top;}
    table.t3 td.kbn,table.t3 th.kbnh{text-align:center;width:30px;}
    table.t3 td.kbn{color:#1F3A5F;font-weight:600;}
    table.t3 td.tot{background:#eef4ff;font-weight:700;}
    table.t3 thead th .th2{font-weight:400;font-size:6.5px;opacity:.85;}
    table.t3 tr.r1 td,table.t3 tr.r2 td{color:#555;}
    table.t3 tr.sub td,table.t3 tr.sub th{background:#eef1f5;}
    table.t3 tr.sub.profit td,table.t3 tr.sub.profit th{background:#e7eefc;color:#1F3A5F;}
    table.t3 tr.sub.profit td.tot{background:#dbe6fb;}
    table.t3 tr.profit.r0 td,table.t3 tr.profit.r0 th{border-top:2px solid #1F3A5F;}
    table.t3 tr.profit.r2 td,table.t3 tr.profit.r2 th{border-bottom:2px solid #1F3A5F;}
    table.t3 tbody.acct{break-inside:avoid;}
    table.t3 thead th{position:sticky;top:0;}
    .report.a3p{page:a3p;}
    @media print{
      @page{ size:A4 landscape; margin:8mm; }
      @page a3p{ size:A3 portrait; margin:8mm; }
      tr{break-inside:avoid;} table{break-inside:auto;}
    }
  </style></head>
  <body onload="setTimeout(function(){window.focus();window.print();},250)">${sections}</body></html>`

  const iframe = document.createElement('iframe')
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;'
  document.body.appendChild(iframe)
  const doc = iframe.contentWindow?.document
  if (!doc) return
  doc.open(); doc.write(html); doc.close()
  const cleanup = () => setTimeout(() => iframe.remove(), 1000)
  iframe.contentWindow?.addEventListener('afterprint', cleanup)
  setTimeout(cleanup, 60000)
}
