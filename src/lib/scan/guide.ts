// 顧問先向け「書類スキャン・ファイル便のご案内」（A4印刷/PDF保存用）と、URL送付用メール文の生成。
// 年調の guide.ts と同じ方式：Noto Sans JP を使った印刷用ページを開き、「PDFに保存」でダウンロードできる。

const OFFICE_NAME = '日下部税理士事務所'

export interface ScanGuideOptions {
  companyName: string
  memberName?: string // メンバー用URLの場合
  url: string
  qrDataUrl: string
}

function esc(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string),
  )
}

export function buildScanGuideHtml(o: ScanGuideOptions): string {
  const who = o.memberName ? `${o.companyName}　${o.memberName} 様` : `${o.companyName} 様`
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>書類スキャン・ファイル便のご案内 — ${esc(o.companyName)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700;900&display=swap" rel="stylesheet">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body { font-family:'Noto Sans JP', sans-serif; color:#1f2937; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  body { padding:14mm; }
  @page { size:A4; margin:0; }
  .head { display:flex; justify-content:space-between; align-items:flex-end; border-bottom:3px solid #2563eb; padding-bottom:8px; margin-bottom:12px; }
  .head .co { font-size:14px; color:#6b7280; font-weight:500; }
  .head .ttl { font-size:24px; font-weight:900; color:#1e3a8a; letter-spacing:.02em; }
  .lead { font-size:13px; line-height:1.8; margin-bottom:12px; }
  .cols { display:flex; gap:16px; align-items:stretch; margin-bottom:12px; }
  .steps { flex:1; }
  .sec { margin-bottom:10px; }
  .sec h3 { font-size:13.5px; color:#1e3a8a; margin-bottom:4px; }
  .sec p { font-size:12px; line-height:1.7; color:#374151; }
  .qrbox { flex:none; width:200px; border:1.5px solid #e5e7eb; border-radius:12px; padding:12px; text-align:center; background:#f9fafb; }
  .qrbox img { width:160px; height:160px; }
  .qrbox .cap { font-size:11.5px; font-weight:700; margin-bottom:6px; color:#111827; }
  .qrbox .url { font-size:9px; color:#2563eb; word-break:break-all; margin-top:6px; line-height:1.5; }
  .member { background:#eff6ff; border:1.5px solid #bfdbfe; border-radius:10px; padding:8px 12px; font-size:12.5px; color:#1e40af; font-weight:700; margin-bottom:12px; }
  .note { font-size:11px; color:#6b7280; line-height:1.8; border-top:1px dashed #d1d5db; padding-top:8px; }
  .note b { color:#374151; }
  .foot { margin-top:10px; text-align:right; font-size:11px; color:#9ca3af; }
  .noprint { position:fixed; top:10px; right:10px; }
  .noprint button { font-family:inherit; font-size:13px; padding:8px 16px; background:#2563eb; color:#fff; border:none; border-radius:8px; cursor:pointer; }
  @media print { .noprint { display:none; } }
</style>
</head>
<body>
  <div class="noprint"><button onclick="window.print()">🖨 印刷 / PDFに保存</button></div>

  <div class="head">
    <div>
      <div class="co">${esc(who)}</div>
      <div class="ttl">書類スキャン・ファイル便のご案内</div>
    </div>
  </div>

  ${o.memberName ? `<div class="member">🔑 このQRコード・URLは ${esc(o.memberName)} 様専用です。ご本人のみでご利用ください（宛名付きファイルの受け取りに使われます）。</div>` : ''}

  <div class="lead">
    スマートフォンやパソコンから、会計資料を当事務所へ簡単に送っていただけるページをご用意しました。
    右のQRコードを読み取る（またはURLを開く）だけで、<b>アプリのインストールやログインは不要</b>です。
  </div>

  <div class="cols">
    <div class="steps">
      <div class="sec">
        <h3>📷 書類をスマホで撮影して送る</h3>
        <p>レシート・領収書・通帳・請求書などを撮影して「まとめて送信する」を押すだけ。書類の種類を選んでから撮影してください。</p>
      </div>
      <div class="sec">
        <h3>📎 ファイルを送る（PDF・Excel等）</h3>
        <p>パソコンからはドラッグ＆ドロップで送れます。フォルダ名やコメントを付けて整理することもできます。お手元の元ファイルはそのまま残ります。</p>
      </div>
      <div class="sec">
        <h3>📥 事務所からのファイルを受け取る</h3>
        <p>当事務所からお送りするファイルは、同じページの「事務所からのファイル」に表示されます。「保存」を押してお受け取りください。</p>
      </div>
      <div class="sec">
        <h3>💴 現金引出・預入の登録</h3>
        <p>通帳を介さない現金の動きは、金額と日付の入力だけで登録できます。</p>
      </div>
    </div>
    <div class="qrbox">
      <div class="cap">スマホで読み取ってください</div>
      <img src="${esc(o.qrDataUrl)}" alt="QRコード">
      <div class="url">${esc(o.url)}</div>
    </div>
  </div>

  <div class="note">
    <b>ご利用環境：</b>iPhone・Android・パソコンの Chrome / Safari でご利用いただけます。カメラが開かないときは LINE 等のアプリ内ではなく Safari / Chrome で開き直してください（アルバムからの写真選択はどのアプリでも可能です）。<br>
    <b>保存期間：</b>送信いただいた画像は1年、ファイルは90日で自動削除されます（お手元の元データには影響しません）。事務所からのファイルは90日以内にお受け取りください。<br>
    <b>URLの取り扱い：</b>このURLを知っている方はページを開けます。社外への転送はお控えください。
  </div>

  <div class="foot">${esc(OFFICE_NAME)}</div>

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

export function openScanGuidePrint(o: ScanGuideOptions): boolean {
  const w = window.open('', '_blank', 'width=820,height=1040')
  if (!w) return false
  w.document.open()
  w.document.write(buildScanGuideHtml(o))
  w.document.close()
  return true
}

/** URL送付用のメール文（件名＋本文）を生成 */
export function buildScanMailText(o: { companyName: string; memberName?: string; url: string }): string {
  const to = o.memberName ? `${o.companyName}\n${o.memberName} 様` : `${o.companyName} 御中`
  return `件名：会計資料の送付用ページのご案内（${OFFICE_NAME}）

${to}

いつもお世話になっております。${OFFICE_NAME}です。

会計資料（レシート・通帳・請求書など）の写真やPDF・Excelファイルを、
スマートフォンやパソコンから簡単にお送りいただけるページをご用意しました。

▼下記のURLをタップ（クリック）して開いてください
${o.url}

・アプリのインストールやログインは不要です
・撮影して「まとめて送信」を押すだけで当事務所に届きます
・PDFやExcelなどのファイルもこのページから送れます
・当事務所からお送りするファイルも、このページで受け取れます
${o.memberName ? `・このURLは ${o.memberName} 様専用です。他の方への転送はお控えください` : '・このURLは貴社専用です。社外への転送はお控えください'}

※ ブックマーク（お気に入り）またはホーム画面への追加をおすすめします。
※ カメラが開かない場合は、LINEなどのアプリ内ではなく
　 Safari / Chrome で開き直してください。

ご不明な点がございましたら、お気軽にご連絡ください。

${OFFICE_NAME}`
}
