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
  /** 対象年（西暦）。「本年（2026年）に入社された方へ」の文面に使う */
  fyGregorian?: number
}

/** 提出書類の例（案内に載せる代表的なもの） */
const DOC_EXAMPLES = [
  '生命保険料控除証明書',
  '地震保険料控除証明書',
  '国民年金・国民健康保険の支払証明',
  'iDeCo・小規模企業共済の払込証明書',
  '住宅ローン控除の書類（2年目以降）',
  '本年中に前職がある方は前職の源泉徴収票（必須）',
]

/**
 * 本年入社の方に入力していただく項目（扶養控除等申告書＝いわゆる「マル扶」の記載事項）。
 * 前年に在籍していた方は前年の内容が初期表示されるので確認・修正だけで済むが、
 * 本年入社の方は控えが無いため**すべて一から入力**していただく必要がある。
 * 案内を見た時点で手元に用意してもらえるよう、具体的に何を書くのかまで挙げる。
 */
const NEW_HIRE_ITEMS = [
  'ご本人の氏名・フリガナ・生年月日',
  '郵便番号・現住所',
  '世帯主の氏名と、ご本人から見た続柄',
  '入社日',
  '配偶者の氏名・フリガナ・生年月日・本年の収入見込み',
  '扶養親族の氏名・フリガナ・続柄・生年月日・本年の収入見込み・同居/別居',
  '障害者・寡婦（ひとり親）・勤労学生に当てはまる場合はその区分',
]

function esc(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string),
  )
}

/**
 * A4 1枚に必ず収めるための縮小スクリプト。
 * 会社名の長さ・提出書類の増減で高さが変わり、数ミリはみ出すだけで2枚目に送られてしまう
 * （2枚目に「発行元」の1行だけ、という無駄な紙が出る）。組み上がってから測って、
 * はみ出した分だけ本文を縮めることで確実に1枚に収める。
 */
const FIT_ONE_PAGE_JS = `
  function fitOnePage(){
    var sheet = document.querySelector('.sheet-body');
    var page = document.querySelector('.sheet');
    if (!sheet || !page) return;
    var cs = getComputedStyle(page);
    var pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    var limit = (297 * 96 / 25.4) - pad - 2;   // A4縦の高さ − 上下余白（1〜2pxの誤差も見る）
    var useZoom = false;
    try { useZoom = CSS.supports('zoom', '0.5'); } catch (e) { useZoom = false; }
    var k = 1;
    for (var i = 0; i < 8; i++) {
      var h = sheet.scrollHeight * k;
      if (h <= limit) break;
      k = Math.max(0.6, k * (limit / h) * 0.998);
      if (useZoom) { sheet.style.zoom = String(k); }
      else { sheet.style.transformOrigin = 'top left'; sheet.style.transform = 'scale(' + k + ')'; sheet.style.width = (100 / k) + '%'; }
      if (k <= 0.6) break;
    }
  }
`

export function buildGuideHtml(o: GuideOptions): string {
  const docs = DOC_EXAMPLES.map((d) => `<li>${esc(d)}</li>`).join('')
  const newHire = NEW_HIRE_ITEMS.map((d) => `<li>${esc(d)}</li>`).join('')
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
  body { background:#e5e7eb; }
  @page { size:A4; margin:0; }
  /* 画面でも印刷でも同じ幅で組む（幅が変わると行の折り返しが変わり、1枚に収まるかの判定がずれる） */
  .sheet { width:210mm; min-height:297mm; margin:0 auto; padding:12mm; background:#fff; }
  .head { display:flex; justify-content:space-between; align-items:flex-end; border-bottom:3px solid #2563eb; padding-bottom:8px; margin-bottom:14px; }
  .head .co { font-size:15px; color:#6b7280; font-weight:500; }
  .head .ttl { font-size:26px; font-weight:900; color:#1e3a8a; letter-spacing:.02em; }
  .head .yr { font-size:13px; color:#6b7280; }
  .lead { font-size:13.5px; line-height:1.75; margin-bottom:11px; }
  .cols { display:flex; gap:16px; align-items:stretch; }
  .steps { flex:1; }
  .step { display:flex; gap:10px; margin-bottom:8px; }
  .step .n { flex:none; width:26px; height:26px; border-radius:50%; background:#2563eb; color:#fff; font-weight:700; font-size:14px; display:flex; align-items:center; justify-content:center; }
  .step .tx { font-size:13.5px; line-height:1.55; padding-top:2px; }
  .step .tx b { font-weight:700; }
  .qrbox { flex:none; width:210px; border:1.5px solid #e5e7eb; border-radius:12px; padding:12px; text-align:center; background:#f9fafb; }
  .qrbox img { width:170px; height:170px; }
  .qrbox .cap { font-size:12px; font-weight:700; margin-bottom:8px; color:#111827; }
  .qrbox .url { font-size:9.5px; color:#2563eb; word-break:break-all; margin-top:8px; line-height:1.5; }
  .newhire { margin:12px 0; border:2px solid #0284c7; background:#f0f9ff; border-radius:12px; padding:11px 15px; }
  .newhire h3 { font-size:14px; color:#075985; margin-bottom:5px; }
  .newhire .lead2 { font-size:12.5px; line-height:1.7; margin-bottom:6px; }
  .newhire ul { display:grid; grid-template-columns:1fr 1fr; column-gap:20px; list-style:none; }
  .newhire li { font-size:12px; line-height:1.68; padding-left:15px; position:relative; break-inside:avoid; }
  .newhire li::before { content:'▸'; position:absolute; left:0; color:#0284c7; font-weight:700; }
  .newhire .warn2 { font-size:12px; line-height:1.65; color:#7f1d1d; background:#fef2f2; border:1px solid #fecaca;
    border-radius:8px; padding:7px 10px; margin-top:7px; }
  .docs { margin:12px 0; background:#f8fafc; border:1px solid #e5e7eb; border-radius:12px; padding:10px 16px; }
  .docs h3 { font-size:13.5px; margin-bottom:6px; color:#111827; }
  .docs ul { display:grid; grid-template-columns:1fr 1fr; column-gap:20px; list-style:none; }
  .docs li { font-size:12.3px; line-height:1.72; padding-left:16px; position:relative; break-inside:avoid; }
  .docs li::before { content:'✓'; position:absolute; left:0; color:#2563eb; font-weight:700; }
  .warn { border:2px solid #dc2626; background:#fef2f2; border-radius:12px; padding:11px 16px; margin-bottom:11px; }
  .warn .dl { font-size:15px; color:#991b1b; font-weight:700; margin-bottom:6px; }
  .warn .dl .date { font-size:22px; font-weight:900; color:#dc2626; margin-left:6px; }
  .warn .msg { font-size:12.5px; color:#7f1d1d; line-height:1.62; font-weight:500; }
  .note { font-size:10.8px; color:#6b7280; line-height:1.62; border-top:1px dashed #d1d5db; padding-top:7px; }
  .note b { color:#374151; }
  .foot { margin-top:7px; text-align:right; font-size:10.5px; color:#9ca3af; }
  @media print { body { background:#fff; } .sheet { margin:0; min-height:0; } .noprint { display:none; } }
  .noprint { position:fixed; top:10px; right:10px; }
  .noprint button { font-family:inherit; font-size:13px; padding:8px 16px; background:#2563eb; color:#fff; border:none; border-radius:8px; cursor:pointer; }
</style>
</head>
<body>
  <div class="noprint"><button onclick="window.print()">🖨 印刷 / PDFに保存</button></div>
  <div class="sheet"><div class="sheet-body">

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
      <div class="step"><div class="n">2</div><div class="tx">最初の画面で <b>「在籍中の従業員の方」</b> か <b>「本年入社の方」</b>${o.fyGregorian ? `（${esc(String(o.fyGregorian))}年に入社された方）` : ''} を選ぶ</div></div>
      <div class="step"><div class="n">3</div><div class="tx"><b>お名前と生年月日</b>でご本人を確認</div></div>
      <div class="step"><div class="n">4</div><div class="tx"><b>在籍中の方</b>は前年の内容が表示されます。変更（住所・扶養親族など）があれば直してください<br>
        <b>本年入社の方</b>は控えがないため、<b>ご自身の情報を一から入力</b>していただきます（下の枠をご覧ください）</div></div>
      <div class="step"><div class="n">5</div><div class="tx">当てはまる<b>控除証明書などを撮影</b>して「送信」を押す</div></div>
    </div>
    <div class="qrbox">
      <div class="cap">スマホで読み取ってください</div>
      <img src="${esc(o.qrDataUrl)}" alt="QRコード">
      <div class="url">${esc(o.url)}</div>
    </div>
  </div>

  <div class="newhire">
    <h3>🆕 ${esc(o.fyGregorian ? String(o.fyGregorian) + '年' : '本年')}に入社された方へ ― 個人情報のご入力をお願いします</h3>
    <p class="lead2">
      前年から在籍されている方は前年の内容が画面に表示されますが、<b>本年入社の方は控えがありません</b>。
      <b>扶養控除等（異動）申告書に書く内容を、画面でそのまま入力</b>していただきます（紙の申告書のご提出は不要です）。
      次の内容をお手元にご用意のうえ、操作を始めてください。
    </p>
    <ul>${newHire}</ul>
    <p class="warn2">
      ❗ <b>本年中に前の勤務先があった方</b>は、<b>前職の源泉徴収票の撮影が必須</b>です（複数社ある場合はすべて）。
      お手元にない場合は、前の勤務先へ早めに発行をご依頼ください。間に合わない場合は会社のご担当者へご相談ください。
    </p>
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
    <b>撮影のコツ：</b> <b>明るい場所</b>で、書類の<b>真上から全体が大きく</b>入るように撮影し、
    影・照明の反射・折り目に注意してください。小さな文字が読める写真ならOKです。<br>
    <b>うまく撮影できないとき：</b> LINE などのアプリ内の画面で開くとカメラが使えないことがあります。その場合は右上のメニューから
    「<b>ブラウザで開く（Safari / Chrome）</b>」を選んで開き直してください。スマホに保存済みの写真を選んで送ることもできます。
  </div>

  <div class="foot">この案内は担当会計事務所が発行しています。ご不明な点はご担当者までお問い合わせください。</div>
  </div></div>

<script>
  ${FIT_ONE_PAGE_JS}
  (function(){
    function go(){ try{ window.focus(); window.print(); }catch(e){} }
    var img = document.querySelector('.qrbox img');
    var fontsReady = (document.fonts && document.fonts.ready) ? document.fonts.ready : Promise.resolve();
    var imgReady = (img && !img.complete) ? new Promise(function(r){ img.onload = r; img.onerror = r; }) : Promise.resolve();
    Promise.all([fontsReady, imgReady]).then(function(){ fitOnePage(); setTimeout(go, 350); });
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

// ===== QRコードだけの印刷（掲示・回覧用） =====
// 「QR表示」で出したQRコードをそのまま貼り出せるようにする。案内PDFは1人1枚配る想定だが、
// 休憩室や事務所に1枚貼っておきたいという使い方があるため、QRを大きく1枚に印刷できる形も用意した。

export interface QrSheetOptions {
  companyName: string
  yearLabel: string
  url: string
  /** 印刷用の大きめQR（幅1024px程度で生成したもの） */
  qrDataUrl: string
  /** 提出期限（省略可。空なら期限の行を出さない） */
  deadlineText?: string
  /** 対象年（西暦）。「本年（2026年）に入社された方」の文面に使う */
  fyGregorian?: number
}

export function buildQrSheetHtml(o: QrSheetOptions): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>年末調整 QRコード — ${esc(o.companyName)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700;900&display=swap" rel="stylesheet">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body { font-family:'Noto Sans JP', sans-serif; color:#1f2937;
    -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  body { background:#e5e7eb; }
  @page { size:A4; margin:0; }
  /* 画面でも印刷でも同じ幅で組む */
  .sheet { width:210mm; min-height:297mm; margin:0 auto; padding:18mm; background:#fff; text-align:center; }
  .co { font-size:16px; color:#6b7280; font-weight:500; }
  .ttl { font-size:30px; font-weight:900; color:#1e3a8a; margin-top:4px; letter-spacing:.02em; }
  .yr { font-size:14px; color:#6b7280; margin-top:6px; }
  .lead { font-size:15px; line-height:1.8; margin:16px auto 0; max-width:150mm; }
  .qrwrap { margin:14px auto 0; width:120mm; border:2px solid #111827; border-radius:14px; padding:10mm 6mm 7mm; }
  .qrwrap img { width:100mm; height:100mm; display:block; margin:0 auto; }
  .qrwrap .cap { font-size:15px; font-weight:700; margin-bottom:6mm; }
  .url { font-size:11px; color:#2563eb; word-break:break-all; margin-top:6mm; line-height:1.6; }
  .dl { margin:12px auto 0; max-width:150mm; border:2px solid #dc2626; background:#fef2f2; border-radius:12px;
    padding:9px 14px; font-size:15px; color:#991b1b; font-weight:700; }
  .dl .date { font-size:20px; font-weight:900; color:#dc2626; margin-left:6px; }
  .note { font-size:12px; color:#6b7280; line-height:1.8; margin:14px auto 0; max-width:150mm; text-align:left; }
  .note b { color:#374151; }
  .foot { margin-top:14px; font-size:11px; color:#9ca3af; }
  @media print { body { background:#fff; } .sheet { margin:0; min-height:0; } .noprint { display:none; } }
  .noprint { position:fixed; top:10px; right:10px; }
  .noprint button { font-family:inherit; font-size:13px; padding:8px 16px; background:#2563eb; color:#fff;
    border:none; border-radius:8px; cursor:pointer; }
</style>
</head>
<body>
  <div class="noprint"><button onclick="window.print()">🖨 印刷 / PDFに保存</button></div>
  <div class="sheet"><div class="sheet-body">

  <div class="co">${esc(o.companyName)}</div>
  <div class="ttl">年末調整のお手続き</div>
  <div class="yr">${esc(o.yearLabel)}</div>

  <div class="lead">
    スマートフォンのカメラで下のQRコードを読み取り、画面の案内に沿って手続きしてください。<br>
    最初の画面で「在籍中の従業員の方」か「本年入社の方」を選んでください。<br>
    <b>本年${o.fyGregorian ? `（${esc(String(o.fyGregorian))}年）` : ''}に入社された方</b>は、
    ご自身の情報（住所・世帯主・配偶者・扶養親族など）の<b>入力</b>もお願いします。
  </div>

  <div class="qrwrap">
    <div class="cap">スマホで読み取ってください</div>
    <img src="${esc(o.qrDataUrl)}" alt="QRコード">
    <div class="url">${esc(o.url)}</div>
  </div>

  ${o.deadlineText ? `<div class="dl">📅 提出期限<span class="date">${esc(o.deadlineText)}</span></div>` : ''}

  <div class="note">
    <b>読み取れないとき：</b> 上のURLをブラウザ（Safari / Chrome）のアドレス欄に直接入力しても開けます。<br>
    <b>カメラが使えないとき：</b> LINE などのアプリ内の画面ではカメラが使えないことがあります。
    右上のメニューから「ブラウザで開く」を選んで開き直してください。
  </div>

  <div class="foot">この案内は担当会計事務所が発行しています。ご不明な点はご担当者までお問い合わせください。</div>
  </div></div>

<script>
  ${FIT_ONE_PAGE_JS}
  (function(){
    function go(){ try{ window.focus(); window.print(); }catch(e){} }
    var img = document.querySelector('.qrwrap img');
    var fontsReady = (document.fonts && document.fonts.ready) ? document.fonts.ready : Promise.resolve();
    var imgReady = (img && !img.complete) ? new Promise(function(r){ img.onload = r; img.onerror = r; }) : Promise.resolve();
    Promise.all([fontsReady, imgReady]).then(function(){ fitOnePage(); setTimeout(go, 350); });
  })();
</script>
</body>
</html>`
}

export function openQrSheetPrint(o: QrSheetOptions): boolean {
  const w = window.open('', '_blank', 'width=820,height=1040')
  if (!w) return false
  w.document.open()
  w.document.write(buildQrSheetHtml(o))
  w.document.close()
  return true
}
