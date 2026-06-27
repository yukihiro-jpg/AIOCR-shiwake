import type { FiscalYearData } from './types'
import { CODES, singleMonth, ytd } from './calc'
import { aggregateRows } from './analysis'

// 会計報告らしい表記: 負数は △、3桁区切り
function fmtAcct(n: number): string {
  const a = Math.round(Math.abs(n)).toLocaleString('ja-JP')
  return n < 0 ? `△${a}` : a
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] || c))
}

/** 推移試算表（PL/BS）＋3期比較を、金融機関提出向けの詳細PDF用HTMLとして生成 */
export function buildSubmissionHtml(company: string, fy: FiscalYearData, comp: FiscalYearData[], monthIdx: number): string {
  const months = fy.fiscalMonths.slice(0, monthIdx + 1)
  const monthLabel = `${fy.fiscalMonths[monthIdx]}月`
  const monthHdr = months.map((m) => `<th class="num">${m}月</th>`).join('')

  const agg = aggregateRows(fy) // 補助科目を畳んで科目単位に
  const rowsHtml = (statement: 'PL' | 'BS') => agg.filter((r) => r.statement === statement).map((r) => {
    const cells = months.map((_, i) => `<td class="num">${fmtAcct(r.monthly[i] ?? 0)}</td>`).join('')
    // PL=累計（単月の合算） / BS=対象月末残高
    let cum = 0
    if (statement === 'PL') for (let i = 0; i <= monthIdx; i++) cum += r.monthly[i] ?? 0
    else cum = r.monthly[monthIdx] ?? 0
    const cls = r.isSubtotal ? (r.bracket === 'profit' ? 'sub profit' : 'sub') : ''
    const pad = 4 + r.level * 10
    return `<tr class="${cls}"><th class="name" style="padding-left:${pad}px">${esc(r.name.trim())}</th>${cells}<td class="num cum">${fmtAcct(cum)}</td></tr>`
  }).join('')

  const plTable = `
    <h2>月次推移損益計算書（単月）　<small>期首〜${monthLabel}</small></h2>
    <table class="grid"><thead><tr><th class="name">科目</th>${monthHdr}<th class="num cum">累計</th></tr></thead>
    <tbody>${rowsHtml('PL')}</tbody></table>`

  const bsTable = `
    <h2>月次推移貸借対照表（各月末残高）　<small>〜${monthLabel}</small></h2>
    <table class="grid"><thead><tr><th class="name">科目</th>${monthHdr}<th class="num cum">${monthLabel}末</th></tr></thead>
    <tbody>${rowsHtml('BS')}</tbody></table>`

  // 3期比較（主要指標：単月／累計）
  const metrics: [string, string][] = [
    ['売上高', CODES.sales], ['売上総利益', CODES.grossProfit], ['営業利益', CODES.opProfit],
    ['経常利益', CODES.ordProfit], ['当期純利益', CODES.netProfit],
  ]
  const compHdr = comp.map((y) => `<th class="num" colspan="2">${esc(y.label)}</th>`).join('')
  const compSub = comp.map(() => `<th class="num">${monthLabel}単月</th><th class="num">累計</th>`).join('')
  const compRows = metrics.map(([label, code]) => {
    const cells = comp.map((y) => `<td class="num">${fmtAcct(singleMonth(y, code, monthIdx))}</td><td class="num cum">${fmtAcct(ytd(y, code, monthIdx))}</td>`).join('')
    return `<tr><th class="name">${label}</th>${cells}</tr>`
  }).join('')
  const compTable = comp.length >= 2 ? `
    <h2>3期比較（主要指標）</h2>
    <table class="grid"><thead><tr><th class="name" rowspan="2">科目</th>${compHdr}</tr><tr>${compSub}</tr></thead>
    <tbody>${compRows}</tbody></table>` : ''

  const today = new Date()
  const dateStr = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`
  const title = `月次推移試算表_${company || '顧問先'}_${fy.label}_${monthLabel}`

  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${esc(title)}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:'Noto Sans JP','Hiragino Sans','Yu Gothic UI','Meiryo',sans-serif;color:#111;font-size:9px;padding:6mm;}
    .head{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2px solid #1F3A5F;padding-bottom:6px;margin-bottom:10px;}
    .head .ttl{font-size:16px;font-weight:800;color:#1F3A5F;}
    .head .co{font-size:13px;font-weight:700;margin-top:2px;}
    .head .meta{font-size:10px;color:#444;text-align:right;line-height:1.6;}
    h2{font-size:11px;color:#1F3A5F;margin:14px 0 4px;border-left:4px solid #C8A24B;padding-left:6px;}
    h2 small{font-size:9px;color:#777;font-weight:400;}
    table.grid{width:100%;border-collapse:collapse;table-layout:auto;}
    table.grid th,table.grid td{border:1px solid #cfd6e0;padding:2px 4px;white-space:nowrap;}
    table.grid thead th{background:#1F3A5F;color:#fff;font-weight:600;text-align:center;font-size:8.5px;}
    table.grid th.name{text-align:left;background:#f3f5f8;color:#222;position:sticky;left:0;}
    table.grid thead th.name{background:#1F3A5F;color:#fff;}
    td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;}
    td.cum,th.cum{background:#eef3fb;font-weight:600;}
    tr.sub td,tr.sub th{background:#eef1f5;font-weight:700;}
    tr.sub.profit td,tr.sub.profit th{background:#e7eefc;color:#1F3A5F;}
    .foot{margin-top:10px;font-size:8px;color:#888;}
    @media print{ @page{ size:A4 landscape; margin:8mm; } body{padding:0;} h2{break-after:avoid;} tr{break-inside:avoid;} table{break-inside:auto;} }
  </style></head>
  <body onload="setTimeout(function(){window.focus();window.print();},250)">
    <div class="head">
      <div><div class="ttl">月次推移試算表</div><div class="co">${esc(company || '顧問先')}　御中</div></div>
      <div class="meta">${esc(fy.label)}<br>対象：期首〜${monthLabel}<br>作成日：${dateStr}</div>
    </div>
    ${plTable}
    ${bsTable}
    ${compTable}
    <div class="foot">※ 会計大将の月次推移データに基づき作成。金額は単位:円。△はマイナス。損益は単月発生額・累計、貸借は各月末残高。</div>
  </body></html>`
}

/** 提出用PDFを印刷ダイアログで開く（iframe経由でポップアップブロックを回避） */
export function openSubmissionPdf(company: string, fy: FiscalYearData, comp: FiscalYearData[], monthIdx: number): void {
  const html = buildSubmissionHtml(company, fy, comp, monthIdx)
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
