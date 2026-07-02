// 顧問先（従業員）向けの「年末調整のご案内」を A4 の印刷用ページとして生成する。
// 文字は Noto Sans JP（Google Fonts）。ブラウザの印刷ダイアログから「PDFに保存」で
// 実ファイルとしてダウンロードできる（日本語フォント埋め込みPDFを自前生成せずに済み、
// どの端末・ブラウザでも文字化けしないため印刷経由を採用）。

export interface GuideOptions {
  companyName: string
  yearLabel: string // 例: 令和8年度（2026年）
  url: string
  qrDataUrl: string // QRコードの data URL（PNG）
  deadlineText: string // 例: 2026年11月30日（月）
}

/** 提出書類の例（案内に載せる代表的なもの） */
const DOC_EXAMPLES = [
  '生命保険料控除証明書',
  '地震保険料控除証明書',
  '国民年金・国民健康保険の支払証明',
  'iDeCo・小規模企業共済の払込証明書',
  '住宅ローン控除の書類（2年目以降）',
  '本年中に前職がある方は前職の源泉徴収票',
]

function esc(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string),
  )
}

export function buildGuideHtml(o: GuideOptions): string {
  const docs = DOC_EXAMPLES.map((d) => `<li>${esc(d)}</li>`).join('')
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>年末調整のご案内 — ${esc(o.companyName)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700;900&display=swap" rel="stylesheet">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body { font-family:'Noto Sans JP', sans-serif; color:#1f2937; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  body { padding:14mm; }
  @page { size:A4; margin:0; }
  .head { display:flex; justify-content:space-between; align-items:flex-end; border-bottom:3px solid #2563eb; padding-bottom:8px; margin-bottom:14px; }
  .head .co { font-size:15px; color:#6b7280; font-weight:500; }
  .head .ttl { font-size:26px; font-weight:900; color:#1e3a8a; letter-spacing:.02em; }
  .head .yr { font-size:13px; color:#6b7280; }
  .lead { font-size:13.5px; line-height:1.8; margin-bottom:14px; }
  .cols { display:flex; gap:16px; align-items:stretch; }
  .steps { flex:1; }
  .step { display:flex; gap:10px; margin-bottom:11px; }
  .step .n { flex:none; width:26px; height:26px; border-radius:50%; background:#2563eb; color:#fff; font-weight:700; font-size:14px; display:flex; align-items:center; justify-content:center; }
  .step .tx { font-size:13.5px; line-height:1.55; padding-top:2px; }
  .step .tx b { font-weight:700; }
  .qrbox { flex:none; width:210px; border:1.5px solid #e5e7eb; border-radius:12px; padding:12px; text-align:center; background:#f9fafb; }
  .qrbox img { width:170px; height:170px; }
  .qrbox .cap { font-size:12px; font-weight:700; margin-bottom:8px; color:#111827; }
  .qrbox .url { font-size:9.5px; color:#2563eb; word-break:break-all; margin-top:8px; line-height:1.5; }
  .docs { margin:16px 0; background:#f8fafc; border:1px solid #e5e7eb; border-radius:12px; padding:12px 16px; }
  .docs h3 { font-size:13.5px; margin-bottom:6px; color:#111827; }
  .docs ul { columns:2; column-gap:20px; list-style:none; }
  .docs li { font-size:12.5px; line-height:1.9; padding-left:16px; position:relative; break-inside:avoid; }
  .docs li::before { content:'✓'; position:absolute; left:0; color:#2563eb; font-weight:700; }
  .warn { border:2px solid #dc2626; background:#fef2f2; border-radius:12px; padding:14px 16px; margin-bottom:14px; }
  .warn .dl { font-size:15px; color:#991b1b; font-weight:700; margin-bottom:6px; }
  .warn .dl .date { font-size:22px; font-weight:900; color:#dc2626; margin-left:6px; }
  .warn .msg { font-size:13px; color:#7f1d1d; line-height:1.7; font-weight:500; }
  .note { font-size:11.5px; color:#6b7280; line-height:1.8; border-top:1px dashed #d1d5db; padding-top:10px; }
  .note b { color:#374151; }
  .foot { margin-top:12px; text-align:right; font-size:11px; color:#9ca3af; }
  @media print { body { padding:14mm; } .noprint { display:none; } }
  .noprint { position:fixed; top:10px; right:10px; }
  .noprint button { font-family:inherit; font-size:13px; padding:8px 16px; background:#2563eb; color:#fff; border:none; border-radius:8px; cursor:pointer; }
</style>
</head>
<body>
  <div class="noprint"><button onclick="window.print()">🖨 印刷 / PDFに保存</button></div>

  <div class="head">
    <div>
      <div class="co">${esc(o.companyName)}</div>
      <div class="ttl">年末調整のご案内</div>
    </div>
    <div class="yr">${esc(o.yearLabel)}</div>
  </div>

  <div class="lead">
    今年の年末調整の手続きを、<b>スマートフォン</b>で行っていただけます。下のQRコードを読み取り、画面の案内に沿って
    生命保険料控除証明書などの<b>書類を撮影して送信</b>してください。数分で完了します。
  </div>

  <div class="cols">
    <div class="steps">
      <div class="step"><div class="n">1</div><div class="tx">スマホのカメラで<b>右のQRコード</b>を読み取る（またはURLを開く）</div></div>
      <div class="step"><div class="n">2</div><div class="tx"><b>お名前と生年月日</b>でご本人を確認</div></div>
      <div class="step"><div class="n">3</div><div class="tx">前年からの変更（住所・扶養親族など）を確認・入力</div></div>
      <div class="step"><div class="n">4</div><div class="tx">当てはまる<b>控除証明書などを撮影</b>して「送信」を押す</div></div>
    </div>
    <div class="qrbox">
      <div class="cap">スマホで読み取ってください</div>
      <img src="${esc(o.qrDataUrl)}" alt="QRコード">
      <div class="url">${esc(o.url)}</div>
    </div>
  </div>

  <div class="docs">
    <h3>ご用意いただく書類の例（お持ちの方のみ）</h3>
    <ul>${docs}</ul>
  </div>

  <div class="warn">
    <div class="dl">📅 提出期限<span class="date">${esc(o.deadlineText)}</span></div>
    <div class="msg">
      期限を過ぎると、<b>会社での年末調整ができなくなります</b>。その場合はご自身での確定申告（翌年の申告）が必要になり、
      還付が遅れることがあります。<b>必ず期限までに</b>ご提出をお願いいたします。
    </div>
  </div>

  <div class="note">
    <b>ご利用について：</b> iPhone・Android のスマートフォン、パソコンのどれでも、Chrome / Safari でご利用いただけます。<br>
    <b>うまく撮影できないとき：</b> LINE などのアプリ内の画面で開くとカメラが使えないことがあります。その場合は右上のメニューから
    「<b>ブラウザで開く（Safari / Chrome）</b>」を選んで開き直してください。スマホに保存済みの写真を選んで送ることもできます。
  </div>

  <div class="foot">この案内は担当会計事務所が発行しています。ご不明な点はご担当者までお問い合わせください。</div>

<script>
  (function(){
    function go(){ try{ window.focus(); window.print(); }catch(e){} }
    var img = document.querySelector('.qrbox img');
    var fontsReady = (document.fonts && document.fonts.ready) ? document.fonts.ready : Promise.resolve();
    var imgReady = (img && !img.complete) ? new Promise(function(r){ img.onload = r; img.onerror = r; }) : Promise.resolve();
    Promise.all([fontsReady, imgReady]).then(function(){ setTimeout(go, 350); });
  })();
</script>
</body>
</html>`
}

export function openGuidePrint(o: GuideOptions): boolean {
  const w = window.open('', '_blank', 'width=820,height=1040')
  if (!w) return false
  w.document.open()
  w.document.write(buildGuideHtml(o))
  w.document.close()
  return true
}
