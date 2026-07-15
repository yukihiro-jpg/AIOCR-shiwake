// 申告書チェック: 結果レポートを新規ウインドウに生成する（印刷・保存用）
import { groupDocHeaders, type AnalyzeResult, type CheckResult } from './types'

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function fmt(v: number | null): string {
  if (v == null) return '（検出不可）'
  return v.toLocaleString('ja-JP')
}

const STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  ok: { label: '✓ 一致', cls: 'ok' },
  warn: { label: '⚠ 要確認', cls: 'warn' },
  info: { label: '参考', cls: 'info' },
  na: { label: '－ 対象なし', cls: 'na' },
}

export function buildShinkokuReportHtml(
  result: AnalyzeResult,
  fileNames: string[],
  noTextPages: number[],
): string {
  const groups: { name: string; items: CheckResult[] }[] = []
  for (const c of result.checks) {
    let g = groups.find((x) => x.name === c.group)
    if (!g) {
      g = { name: c.group, items: [] }
      groups.push(g)
    }
    g.items.push(c)
  }
  const warnCount = result.checks.filter((c) => c.status === 'warn').length
  const okCount = result.checks.filter((c) => c.status === 'ok').length
  const now = new Date()
  const dateStr = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`

  const groupHtml = groups
    .map(
      (g) => `
  <section class="grp">
    <h2>${esc(g.name)}</h2>
    <table>
      <thead><tr><th class="tl">チェック項目</th><th class="tr">${esc(groupDocHeaders(g.name)[0])}</th><th class="tr">${esc(groupDocHeaders(g.name)[1])}</th><th class="tr">差額</th><th class="tc w-judge">判定</th></tr></thead>
      <tbody>
        ${g.items
          .map((c) => {
            const st = STATUS_LABEL[c.status] || STATUS_LABEL.na
            const diff =
              c.diff == null
                ? '<span class="dim">－</span>'
                : c.diff === 0
                  ? '<span class="okv">0</span>'
                  : `<span class="warnv">${esc(fmt(c.diff))}</span>`
            return `<tr>
          <td class="tl"><div class="nm">${esc(c.name)}</div>${c.note ? `<div class="note">${esc(c.note)}</div>` : ''}</td>
          <td class="tr"><div class="lbl">${esc(c.leftLabel)}</div><div class="val${c.leftValue == null ? ' dim' : ''}">${esc(fmt(c.leftValue))}</div></td>
          <td class="tr"><div class="lbl">${esc(c.rightLabel)}</div><div class="val${c.rightValue == null ? ' dim' : ''}">${esc(fmt(c.rightValue))}</div></td>
          <td class="tr val">${diff}</td>
          <td class="tc"><span class="badge ${st.cls}">${st.label}</span></td>
        </tr>`
          })
          .join('\n')}
      </tbody>
    </table>
  </section>`,
    )
    .join('\n')

  const pagesHtml = result.pageSummary
    .map(
      (s) =>
        `<div class="pg"><span>p${s.page}</span><span class="${s.detected.includes('対象外') ? 'dim' : ''}">${esc(s.detected)}</span></div>`,
    )
    .join('\n')

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>申告書チェック結果 ${esc(dateStr)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Hiragino Kaku Gothic ProN", "Yu Gothic", Meiryo, sans-serif; color: #1f2937; background: #f3f4f6; padding: 24px; font-size: 12px; }
  .sheet { max-width: 900px; margin: 0 auto; background: #fff; border-radius: 12px; padding: 28px 32px; box-shadow: 0 1px 4px rgba(0,0,0,.08); }
  h1 { font-size: 18px; margin-bottom: 4px; }
  .meta { color: #6b7280; font-size: 11px; margin-bottom: 4px; }
  .summary { margin: 14px 0 18px; padding: 10px 14px; background: #f8fafc; border: 1px solid #e5e7eb; border-radius: 8px; font-size: 13px; }
  .summary b.okc { color: #15803d; }
  .summary b.warnc { color: #b45309; }
  .grp { margin-bottom: 18px; page-break-inside: avoid; }
  .grp h2 { font-size: 13px; background: #f3f4f6; border: 1px solid #e5e7eb; border-bottom: none; border-radius: 8px 8px 0 0; padding: 7px 12px; }
  table { width: 100%; border-collapse: collapse; border: 1px solid #e5e7eb; }
  th { font-size: 10px; color: #6b7280; font-weight: 600; padding: 5px 8px; border-bottom: 1px solid #e5e7eb; background: #fafafa; }
  td { padding: 6px 8px; border-bottom: 1px solid #f3f4f6; vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  .tl { text-align: left; } .tr { text-align: right; white-space: nowrap; } .tc { text-align: center; }
  .w-judge { width: 76px; }
  .nm { font-weight: 600; }
  .note { font-size: 10px; color: #6b7280; margin-top: 2px; white-space: normal; }
  .lbl { font-size: 10px; color: #6b7280; }
  .val { font-family: ui-monospace, "SF Mono", Consolas, monospace; }
  .dim { color: #9ca3af; }
  .okv { color: #15803d; }
  .warnv { color: #b45309; font-weight: 700; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 10px; font-weight: 700; white-space: nowrap; }
  .badge.ok { background: #dcfce7; color: #166534; }
  .badge.warn { background: #fef3c7; color: #92400e; }
  .badge.info { background: #e0f2fe; color: #075985; }
  .badge.na { background: #f3f4f6; color: #6b7280; }
  .notext { margin: 0 0 14px; padding: 8px 12px; background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; color: #92400e; font-size: 11px; }
  .pages { margin-top: 18px; page-break-inside: avoid; }
  .pages h2 { font-size: 13px; margin-bottom: 6px; }
  .pages .cols { columns: 2; column-gap: 28px; }
  .pg { display: flex; justify-content: space-between; font-size: 10px; color: #4b5563; padding: 2px 0; border-bottom: 1px solid #f3f4f6; break-inside: avoid; }
  .disclaimer { margin-top: 18px; font-size: 10px; color: #6b7280; line-height: 1.7; }
  .toolbar { max-width: 900px; margin: 0 auto 14px; display: flex; gap: 8px; }
  .toolbar button { padding: 8px 18px; font-size: 13px; font-weight: 700; border: none; border-radius: 8px; cursor: pointer; background: #2563eb; color: #fff; }
  .toolbar button:hover { background: #1d4ed8; }
  @media print {
    body { background: #fff; padding: 0; }
    .sheet { box-shadow: none; border-radius: 0; padding: 0; max-width: none; }
    .toolbar { display: none; }
  }
</style>
</head>
<body>
  <div class="toolbar"><button onclick="window.print()">🖨 印刷 / PDF保存</button></div>
  <div class="sheet">
    <h1>🧾 申告書チェック結果</h1>
    <div class="meta">実行日時：${esc(dateStr)}</div>
    <div class="meta">対象ファイル：${fileNames.map(esc).join('、') || '－'}</div>
    <div class="summary">✓ 一致 <b class="okc">${okCount}</b> 件 ／ ⚠ 要確認 <b class="warnc">${warnCount}</b> 件（全 ${result.checks.length} 項目）</div>
    ${
      noTextPages.length
        ? `<div class="notext">⚠ テキスト情報のないページ（スキャン画像など）が ${noTextPages.length} ページありました（ページ: ${noTextPages.slice(0, 10).join(', ')}${noTextPages.length > 10 ? ' …' : ''}）。これらのページはチェックできません。</div>`
        : ''
    }
    ${groupHtml}
    <div class="pages">
      <h2>📑 ページの認識結果（${result.pageSummary.length}ページ）</h2>
      <div class="cols">
        ${pagesHtml}
      </div>
    </div>
    <p class="disclaimer">※ 本チェックはPDFのテキスト情報から機械的に金額を照合するものです。様式・会計ソフトのレイアウトによっては金額を検出できない場合があります（「検出不可」表示）。⚠の項目も誤りとは限りません（各項目の注記参照）。最終判断は必ず元の書類でご確認ください。データはすべて端末内で処理され、外部には送信されません。</p>
  </div>
</body>
</html>`
}

/** チェック結果を新規ウインドウに表示する。ポップアップブロック時は false を返す */
export function openShinkokuReport(
  result: AnalyzeResult,
  fileNames: string[],
  noTextPages: number[],
): boolean {
  const w = window.open('', '_blank')
  if (!w) return false
  w.document.open()
  w.document.write(buildShinkokuReportHtml(result, fileNames, noTextPages))
  w.document.close()
  return true
}
