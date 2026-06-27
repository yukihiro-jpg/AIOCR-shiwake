import type { FiscalYearData } from './types'
import { CODES, singleMonth, ytd } from './calc'
import { aggregateRows, aggRowValue, type AggRow } from './analysis'

export type ReportKey = 'trialPL' | 'trialBS' | 'cmpPL' | 'cmpBS' | 'trendPL' | 'trendBS'
export const REPORT_KEYS: ReportKey[] = ['trialPL', 'trialBS', 'cmpPL', 'cmpBS', 'trendPL', 'trendBS']
export const REPORT_LABELS: Record<ReportKey, string> = {
  trialPL: '月次試算表(PL)', trialBS: '月次試算表(BS)',
  cmpPL: '3期比較(PL)', cmpBS: '3期比較(BS)',
  trendPL: '推移表(PL)', trendBS: '推移表(BS)',
}

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
  // trendPL / trendBS
  const statement = key === 'trendPL' ? 'PL' : 'BS'
  const cumMode: 'single' | 'cum' = key === 'trendPL' ? 'cum' : 'single'
  const data = rows.filter((r) => r.statement === statement).map((r) => ({
    r, cells: [...months.map((_, i) => fmtAcct(r.monthly[i] ?? 0)), fmtAcct(aggRowValue(r, monthIdx, cumMode))],
  }))
  const headers = [...months.map((m) => `${m}月`), key === 'trendPL' ? '累計' : `${monthLabel}末`]
  return { title: `${statement === 'PL' ? '損益計算書' : '貸借対照表'}（月次推移）`, sub: statement === 'PL' ? `単月発生額 ／ 期首〜${monthLabel}` : `各月末残高 ／ 〜${monthLabel}`, table: tableHtml(headers, data) }
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
    return `<section class="report">
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
    @media print{ @page{ size:A4 landscape; margin:8mm; } tr{break-inside:avoid;} table{break-inside:auto;} }
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
