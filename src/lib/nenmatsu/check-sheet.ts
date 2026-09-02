// 顧問先の経理担当者が年末調整の提出状況を管理するための「提出状況チェック表」（A4縦・印刷用）。
// このアプリに取り込んだ従業員名簿（CSV取込）を社員コード順に並べ、手書きでチェックできる欄を付ける。
// 名簿に無い人（本年入社・取込後の入社）を書き足せるよう、末尾に空欄の行を用意する。
// 案内PDF（guide.ts）と同じく、ブラウザの印刷ダイアログから「PDFに保存」で実ファイルにできる。

export interface CheckSheetEmployee {
  code: string
  lastName: string
  firstName: string
  kanaLast?: string
  kanaFirst?: string
  isNewHire?: boolean
}

export interface CheckSheetOptions {
  companyName: string
  yearLabel: string // 例: 令和8年度（2026年）
  deadlineText: string // 例: 2026年11月30日（月）
  employees: CheckSheetEmployee[]
  /** 手書き追加用の空欄行数（既定 8） */
  blankRows?: number
}

function esc(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string),
  )
}

/** 社員コード順（数値として比較できるものは数値順） */
export function sortEmployeesByCode<T extends { code: string }>(list: T[]): T[] {
  return [...list].sort((a, b) => {
    const ca = (a.code || '').trim(), cb = (b.code || '').trim()
    const na = Number(ca), nb = Number(cb)
    if (ca && cb && !isNaN(na) && !isNaN(nb)) return na - nb
    return ca.localeCompare(cb, 'ja', { numeric: true })
  })
}

/** 1社ぶんの紙面（従業員数によって複数ページに続く） */
function sheet(o: CheckSheetOptions): string {
  const emps = sortEmployeesByCode(o.employees)
  const blank = Math.max(0, o.blankRows ?? 8)
  const cell = '<td class="chk"><span class="box"></span></td>'
  const dateCell = '<td class="date"><span class="slash">/</span></td>'
  const rows = emps
    .map((e, i) => {
      const kana = [e.kanaLast, e.kanaFirst].filter(Boolean).join('　')
      return `<tr>
        <td class="no">${i + 1}</td>
        <td class="code">${esc(e.code)}</td>
        <td class="name"><span class="kana">${esc(kana)}</span><span class="nm">${esc(e.lastName)}　${esc(e.firstName)}</span>${e.isNewHire ? '<span class="tag">本年入社</span>' : ''}</td>
        ${dateCell}${cell}${cell}${cell}
        <td class="memo"></td>
      </tr>`
    })
    .join('')
  const blanks = Array.from({ length: blank }, (_, i) => `<tr class="blank">
        <td class="no">${emps.length + i + 1}</td>
        <td class="code"></td>
        <td class="name"></td>
        ${dateCell}${cell}${cell}${cell}
        <td class="memo"></td>
      </tr>`).join('')

  return `<div class="doc">
  <div class="head">
    <div>
      <div class="co">${esc(o.companyName)}</div>
      <div class="ttl">年末調整 提出状況チェック表</div>
      <div class="sub">経理ご担当者用 ― 従業員からの提出を受け取ったら記入してください</div>
    </div>
    <div class="meta">
      <div class="yr">${esc(o.yearLabel)}</div>
      <div class="dl">提出期限 <b>${esc(o.deadlineText)}</b></div>
      <div class="cnt">名簿の従業員 <b>${emps.length}</b> 名</div>
    </div>
  </div>

  <div class="howto">
    <div><b>スマホ提出</b>：従業員がQRコードから送信すると会計事務所に届きます。本人から「送りました」と聞いたら日付を記入してください。</div>
    <div><b>マイナンバー</b>：スマホでは送信しません。本人・配偶者・扶養親族の分を<b>紙または口頭で会社がお預かり</b>し、✓を付けてください。</div>
    <div><b>前職の源泉徴収票</b>：本年中に前の勤務先があった方のみ。原本を預かった場合は✓（スマホで撮影済みでも原本の確認をおすすめします）。</div>
    <div><b>名簿に無い方</b>（本年入社・取込後の入社）は、下の空欄に社員コードと氏名を手書きで追加してください。</div>
  </div>

  <table>
    <thead>
      <tr>
        <th class="no">№</th>
        <th class="code">社員<br>コード</th>
        <th class="name">氏名</th>
        <th class="date">スマホ提出<br><span class="th-sub">確認した日</span></th>
        <th class="chk">マイナンバー<br><span class="th-sub">受領</span></th>
        <th class="chk">前職<br>源泉徴収票<br><span class="th-sub">該当者のみ</span></th>
        <th class="chk">紙の書類<br><span class="th-sub">預かり有</span></th>
        <th class="memo">備考（未提出の理由・確定申告する等）</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
      ${blank > 0 ? `<tr class="sep"><td colspan="8">✎ 名簿に無い方（本年入社・取込後の入社）― 手書きで追加してください</td></tr>` : ''}
      ${blanks}
    </tbody>
  </table>

  <div class="total">
    <div>提出済 <span class="line"></span> 名</div>
    <div>未提出 <span class="line"></span> 名</div>
    <div>記入者 <span class="line wide"></span></div>
    <div>最終確認日 <span class="line"></span></div>
  </div>
  <div class="foot">この表は担当会計事務所が発行しています。期限までに未提出の方がいる場合は、早めにご担当者へご連絡ください。</div>
</div>`
}

export function buildCheckSheetHtml(o: CheckSheetOptions | CheckSheetOptions[]): string {
  const list = Array.isArray(o) ? o : [o]
  const title =
    list.length > 1 ? `年末調整 提出状況チェック表 — ${list.length}社` : `年末調整 提出状況チェック表 — ${esc(list[0]?.companyName || '')}`
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700;900&display=swap" rel="stylesheet">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body { font-family:'Noto Sans JP', sans-serif; color:#1f2937; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  body { background:#e5e7eb; }
  @page { size:A4; margin:11mm 11mm 12mm; }
  .doc { width:210mm; min-height:297mm; margin:0 auto; padding:11mm 11mm 12mm; background:#fff; }
  .doc + .doc { margin-top:8mm; break-before:page; page-break-before:always; }
  .head { display:flex; justify-content:space-between; align-items:flex-end; border-bottom:2.5px solid #1e3a8a; padding-bottom:6px; margin-bottom:8px; }
  .co { font-size:13px; color:#6b7280; font-weight:500; }
  .ttl { font-size:21px; font-weight:900; color:#1e3a8a; letter-spacing:.02em; }
  .sub { font-size:11px; color:#374151; margin-top:2px; }
  .meta { text-align:right; font-size:11.5px; color:#374151; line-height:1.7; }
  .meta .dl b { color:#dc2626; font-size:13px; }
  .howto { font-size:10.2px; line-height:1.6; color:#374151; background:#f8fafc; border:1px solid #e5e7eb; border-radius:8px; padding:6px 10px; margin-bottom:8px; }
  .howto div { padding-left:10px; position:relative; }
  .howto div::before { content:'・'; position:absolute; left:0; }
  table { width:100%; border-collapse:collapse; table-layout:fixed; }
  thead { display:table-header-group; }
  th, td { border:1px solid #9ca3af; font-size:11px; vertical-align:middle; }
  th { background:#eef2ff; font-weight:700; padding:4px 2px; text-align:center; line-height:1.3; font-size:10px; }
  th .th-sub { font-weight:500; font-size:9px; color:#6b7280; }
  tbody tr { height:9.2mm; break-inside:avoid; page-break-inside:avoid; }
  tbody tr:nth-child(even) td { background:#fafafa; }
  td { padding:2px 4px; }
  th.no, td.no { width:8mm; text-align:center; color:#6b7280; }
  th.code, td.code { width:15mm; text-align:center; font-variant-numeric:tabular-nums; }
  th.name { width:44mm; }
  td.name { position:relative; }
  td.name .kana { display:block; font-size:8px; color:#6b7280; line-height:1.1; }
  td.name .nm { display:block; font-size:12px; font-weight:700; line-height:1.2; }
  td.name .tag { position:absolute; right:3px; top:50%; transform:translateY(-50%); font-size:8.5px; font-weight:700; color:#075985; background:#e0f2fe; border:1px solid #7dd3fc; border-radius:4px; padding:1px 4px; }
  th.date, td.date { width:22mm; text-align:center; }
  td.date .slash { color:#d1d5db; font-size:13px; }
  th.chk, td.chk { width:19mm; text-align:center; }
  td.chk .box { display:inline-block; width:5mm; height:5mm; border:1.2px solid #6b7280; border-radius:2px; vertical-align:middle; }
  td.memo { }
  tr.sep td { height:6.5mm; background:#fff7ed !important; color:#9a3412; font-size:10px; font-weight:700; padding:2px 6px; border-left:1px solid #9ca3af; border-right:1px solid #9ca3af; }
  tr.blank td.code, tr.blank td.name { background:#fffdf5 !important; }
  .total { display:flex; gap:18px; justify-content:flex-end; margin-top:8px; font-size:11.5px; font-weight:700; color:#1f2937; break-inside:avoid; }
  .total .line { display:inline-block; width:16mm; border-bottom:1px solid #374151; height:1em; vertical-align:bottom; margin:0 3px; }
  .total .line.wide { width:34mm; }
  .foot { margin-top:6px; text-align:right; font-size:9.5px; color:#9ca3af; }
  @media print { body { background:#fff; } .doc { margin:0; padding:0; min-height:0; width:auto; } .doc + .doc { margin-top:0; } .noprint { display:none; } }
  .noprint { position:fixed; top:10px; right:10px; z-index:2; }
  .noprint button { font-family:inherit; font-size:13px; padding:8px 16px; background:#2563eb; color:#fff; border:none; border-radius:8px; cursor:pointer; }
</style>
</head>
<body>
  <div class="noprint"><button onclick="window.print()">🖨 印刷 / PDFに保存</button></div>
${list.map(sheet).join('\n')}
<script>
  (function(){
    function go(){ try{ window.focus(); window.print(); }catch(e){} }
    var fontsReady = (document.fonts && document.fonts.ready) ? document.fonts.ready : Promise.resolve();
    fontsReady.then(function(){ setTimeout(go, 350); });
  })();
</script>
</body>
</html>`
}

/**
 * 印刷用の別ウインドウを「ボタンを押した瞬間」に開く。
 * iPhone の Safari などは、クリック直後の同期処理でしか window.open を許可しない。
 * 名簿の読み込みや QR 生成（await）のあとに開くとポップアップブロックになるため、
 * 先に空のウインドウを開いておき、データが揃ってから writePrintWindow で中身を流し込む。
 */
export function openPrintWindowNow(label = '作成中…'): Window | null {
  const w = window.open('', '_blank', 'width=820,height=1040')
  if (!w) return null
  try {
    w.document.open()
    w.document.write(
      `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${esc(label)}</title></head>` +
        `<body style="font-family:sans-serif;color:#6b7280;padding:40px;text-align:center">${esc(label)}</body></html>`,
    )
    w.document.close()
  } catch { /* 表示できなくても中身は後で書き直す */ }
  return w
}

/** openPrintWindowNow で開いたウインドウに印刷用HTMLを書き込む */
export function writePrintWindow(w: Window, html: string): void {
  w.document.open()
  w.document.write(html)
  w.document.close()
}

/** チェック表を印刷用の別ウインドウで開く。配列を渡すと会社ごとに改ページしてまとめて刷る。
 *  `w` に openPrintWindowNow で先に開いたウインドウを渡せる（スマホのポップアップブロック対策）。 */
export function openCheckSheetPrint(o: CheckSheetOptions | CheckSheetOptions[], w?: Window | null): boolean {
  const win = w ?? window.open('', '_blank', 'width=820,height=1040')
  if (!win) return false
  writePrintWindow(win, buildCheckSheetHtml(o))
  return true
}
