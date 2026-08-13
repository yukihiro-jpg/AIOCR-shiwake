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
 * 決めた高さに必ず収めるための縮小スクリプト。
 * `.fitbox`（用紙・面）と、その中の `.fitbody`（縮小の対象）を対にして使う。
 * 高さは data-fit-h に mm で書く（A4縦なら297、A4横を2面に割った1面なら210）。
 *
 * 会社名の長さや提出書類の増減で高さが変わり、数ミリはみ出すだけで次の紙に送られてしまう
 * （「発行元」の1行だけの2枚目が出る）。組み上がってから測って、はみ出した分だけ縮めることで
 * 確実に決めた枚数に収める。
 */
const FIT_ONE_PAGE_JS = `
  function fitOnePage(){
    var boxes = document.querySelectorAll('.fitbox');
    var useZoom = false;
    try { useZoom = CSS.supports('zoom', '0.5'); } catch (e) { useZoom = false; }
    for (var i = 0; i < boxes.length; i++) {
      var box = boxes[i];
      var body = box.querySelector('.fitbody');
      if (!body) continue;
      var cs = getComputedStyle(box);
      var pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
      var mm = parseFloat(box.getAttribute('data-fit-h')) || 297;
      var limit = (mm * 96 / 25.4) - pad - 2;   // 面の高さ − 上下余白（1〜2pxの誤差も見る）
      var k = 1;
      for (var t = 0; t < 8; t++) {
        var h = body.scrollHeight * k;
        if (h <= limit) break;
        k = Math.max(0.6, k * (limit / h) * 0.998);
        if (useZoom) { body.style.zoom = String(k); }
        else { body.style.transformOrigin = 'top left'; body.style.transform = 'scale(' + k + ')'; body.style.width = (100 / k) + '%'; }
        if (k <= 0.6) break;
      }
    }
  }
`

/** 案内1社ぶんの紙面（A4縦1枚）。複数社をまとめて刷るときはこれを並べる。 */
function guideSheet(o: GuideOptions): string {
  const docs = DOC_EXAMPLES.map((d) => `<li>${esc(d)}</li>`).join('')
  const newHire = NEW_HIRE_ITEMS.map((d) => `<li>${esc(d)}</li>`).join('')
  return `  <div class="sheet fitbox" data-fit-h="296"><div class="sheet-body fitbody">

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
        <span class="red">本年入社の方は氏名が表示されません。</span><b>ご自身の情報を一から入力</b>していただきます（下の枠をご覧ください）</div></div>
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
      前年から在籍されている方は前年の内容が画面に表示されますが、<span class="red">本年入社の方は氏名が表示されません。</span>
      <b>扶養控除等（異動）申告書に書く内容を、画面でそのまま入力</b>していただきます（紙の申告書のご提出は不要です）。
      次の内容をお手元にご用意のうえ、操作を始めてください。
    </p>
    <ul>${newHire}</ul>
    <p class="warn2">
      ❗ <b>本年中に前の勤務先があった方</b>は、<b>前職の源泉徴収票の撮影が必須</b>です（複数社ある場合はすべて）。
      お手元にない場合は、前の勤務先へ早めに発行をご依頼ください。間に合わない場合は会社のご担当者へご相談ください。
    </p>
    <p class="mynum">
      🔒 <b>マイナンバー（個人番号）は、この画面では入力しません。</b>
      <span class="red">マイナンバーは別途、担当者へお渡しください。</span>
      （ご本人・配偶者・扶養親族の分が必要です。撮影して送らないようご注意ください。）
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
  </div></div>`
}

/**
 * 案内PDFのHTML。`list` に複数社を渡すと、**1社1枚**で続けて刷る1つの文書になる。
 * 各紙面は `.fitbox`（高さ296mm・はみ出し禁止）なので、会社名が長くても2枚目に送られない。
 */
export function buildGuideHtml(o: GuideOptions | GuideOptions[]): string {
  const list = Array.isArray(o) ? o : [o]
  const first = list[0]
  const title =
    list.length > 1 ? `年末調整のご案内 — ${list.length}社` : `年末調整のご案内 — ${esc(first?.companyName || '')}`
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
  @page { size:A4; margin:0; }
  /* 画面でも印刷でも同じ幅で組む（幅が変わると行の折り返しが変わり、1枚に収まるかの判定がずれる）。
     高さも固定＋overflow:hidden にしてあるので、複数社をまとめて刷っても必ず1社1枚になる */
  .sheet { width:210mm; height:296.5mm; margin:0 auto; padding:12mm; background:#fff; overflow:hidden; }
  .sheet + .sheet { margin-top:8mm; break-before:page; page-break-before:always; }
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
  .newhire .mynum { font-size:12px; line-height:1.65; color:#1f2937; background:#fff; border:1px solid #cbd5e1;
    border-radius:8px; padding:7px 10px; margin-top:6px; }
  .red { color:#dc2626; font-weight:700; }
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
  @media print { body { background:#fff; } .sheet { margin:0; } .sheet + .sheet { margin-top:0; } .noprint { display:none; } }
  .noprint { position:fixed; top:10px; right:10px; }
  .noprint button { font-family:inherit; font-size:13px; padding:8px 16px; background:#2563eb; color:#fff; border:none; border-radius:8px; cursor:pointer; }
</style>
</head>
<body>
  <div class="noprint"><button onclick="window.print()">🖨 印刷 / PDFに保存</button></div>
${list.map(guideSheet).join('\n')}

<script>
  ${FIT_ONE_PAGE_JS}
  (function(){
    function go(){ try{ window.focus(); window.print(); }catch(e){} }
    // すべてのQR画像とフォントの読み込みを待ってから測る（読み込み前に測ると高さがずれる）
    var imgs = Array.prototype.slice.call(document.querySelectorAll('.qrbox img'));
    var fontsReady = (document.fonts && document.fonts.ready) ? document.fonts.ready : Promise.resolve();
    var imgsReady = Promise.all(imgs.map(function(img){
      return img.complete ? Promise.resolve() : new Promise(function(r){ img.onload = r; img.onerror = r; });
    }));
    Promise.all([fontsReady, imgsReady]).then(function(){ fitOnePage(); setTimeout(go, 350); });
  })();
</script>
</body>
</html>`
}

/** 案内PDFを印刷用の別ウインドウで開く。配列を渡すと1社1枚でまとめて刷る。 */
export function openGuidePrint(o: GuideOptions | GuideOptions[]): boolean {
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
  // A4横1枚に同じ内容を左右2面（各A5相当）並べる。真ん中で切ると2枚になるので、
  // 顧問先が1枚なくしてももう1枚が残る（掲示用と保管用に分けて使ってもらう想定）。
  const slip = (side: 'l' | 'r') => `
    <div class="slip fitbox ${side}" data-fit-h="210"><div class="slip-body fitbody">
      <div class="co">${esc(o.companyName)}</div>
      <div class="ttl">年末調整のお手続き</div>
      <div class="yr">${esc(o.yearLabel)}</div>

      <div class="lead">
        スマートフォンのカメラで下のQRコードを読み取り、画面の案内に沿って手続きしてください。<br>
        最初の画面で「在籍中の従業員の方」か「本年入社の方」を選んでください。
      </div>
      <div class="alert">
        <span class="red">本年${o.fyGregorian ? `（${esc(String(o.fyGregorian))}年）` : ''}に入社された方は氏名が表示されません。</span>
        ご自身の情報（住所・世帯主・配偶者・扶養親族など）の<b>入力</b>もお願いします。<br>
        <b>マイナンバーは別途、担当者へお渡しください</b>（この画面では入力しません）。
      </div>

      <div class="qrwrap">
        <div class="cap">スマホで読み取ってください</div>
        <img src="${esc(o.qrDataUrl)}" alt="QRコード">
        <div class="url">${esc(o.url)}</div>
      </div>

      ${o.deadlineText ? `<div class="dl">📅 提出期限<span class="date">${esc(o.deadlineText)}</span></div>` : ''}

      <div class="note">
        <b>読み取れないとき：</b>上のURLをブラウザ（Safari / Chrome）のアドレス欄に直接入力しても開けます。<br>
        <b>カメラが使えないとき：</b>LINE などのアプリ内の画面ではカメラが使えないことがあります。
        右上のメニューから「ブラウザで開く」を選んで開き直してください。
      </div>
      <div class="foot">この案内は担当会計事務所が発行しています。ご不明な点はご担当者までお問い合わせください。</div>
    </div></div>`

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
  @page { size:A4 landscape; margin:0; }
  /* A4横（297×210mm）を左右2面に割る。画面でも印刷でも同じ幅で組む */
  .sheet { width:297mm; height:210mm; margin:0 auto; background:#fff; display:flex; position:relative; }
  .slip { width:148.5mm; height:210mm; padding:9mm 8mm; text-align:center; }
  /* 切り取り線（真ん中）。切る位置が一目で分かるようにハサミ印も出す */
  .cut { position:absolute; left:148.5mm; top:0; bottom:0; width:0;
    border-left:0.4mm dashed #9ca3af; }
  .cut::before { content:'✂'; position:absolute; left:-3.2mm; top:2mm; font-size:12px; color:#9ca3af; background:#fff; }
  .cut::after { content:'✂'; position:absolute; left:-3.2mm; bottom:2mm; font-size:12px; color:#9ca3af; background:#fff; }
  .co { font-size:12.5px; color:#6b7280; font-weight:500; }
  .ttl { font-size:22px; font-weight:900; color:#1e3a8a; margin-top:2px; letter-spacing:.02em; }
  .yr { font-size:11.5px; color:#6b7280; margin-top:3px; }
  .lead { font-size:11.5px; line-height:1.7; margin-top:7px; text-align:left; }
  .alert { font-size:11px; line-height:1.65; margin-top:6px; text-align:left;
    border:1.2px solid #fca5a5; background:#fef2f2; border-radius:8px; padding:6px 9px; }
  .red { color:#dc2626; font-weight:700; }
  .qrwrap { margin:8px auto 0; width:104mm; border:1.5px solid #111827; border-radius:12px; padding:5mm 4mm 4mm; }
  .qrwrap img { width:74mm; height:74mm; display:block; margin:0 auto; }
  .qrwrap .cap { font-size:12.5px; font-weight:700; margin-bottom:3mm; }
  .url { font-size:9px; color:#2563eb; word-break:break-all; margin-top:3mm; line-height:1.5; }
  .dl { margin:8px auto 0; border:1.5px solid #dc2626; background:#fef2f2; border-radius:10px;
    padding:5px 10px; font-size:12.5px; color:#991b1b; font-weight:700; }
  .dl .date { font-size:16px; font-weight:900; color:#dc2626; margin-left:5px; }
  .note { font-size:9.5px; color:#6b7280; line-height:1.7; margin-top:8px; text-align:left; }
  .note b { color:#374151; }
  .foot { margin-top:6px; font-size:8.5px; color:#9ca3af; text-align:left; }
  @media print { body { background:#fff; } .sheet { margin:0; } .noprint { display:none; } }
  .noprint { position:fixed; top:10px; right:10px; z-index:2; }
  .noprint button { font-family:inherit; font-size:13px; padding:8px 16px; background:#2563eb; color:#fff;
    border:none; border-radius:8px; cursor:pointer; }
</style>
</head>
<body>
  <div class="noprint"><button onclick="window.print()">🖨 印刷 / PDFに保存</button></div>
  <div class="sheet">
    ${slip('l')}
    <div class="cut"></div>
    ${slip('r')}
  </div>

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
