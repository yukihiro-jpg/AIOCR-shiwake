// 紙で配る「年末調整の確認シート」（従業員1人につきA4縦1枚・印刷用）。
// スマホでの提出が難しい方向け。会社に登録されている内容（前年の提出、無ければCSVの登録内容）を
// 印字しておき、質問に答える形で「変更なし／変更あり」と変更後の内容を書いてもらう。
// 紙の運用では QR は載せない（紙で出すと決めた方に配るため）。マイナンバーは印字しない。

import { writePrintWindow } from './check-sheet'

export interface ConfirmSheetPerson {
  name: string
  kana: string
  rel: string // 扶養親族の続柄（配偶者では未使用）
  birth: string
  together?: string // 同居・別居（分からなければ空）
}

export interface ConfirmSheetEmployee {
  code: string
  name: string
  kana: string
  birth: string
  postal: string
  address: string
  householder: string // 例: 山田 太郎（本人）。不明なら空
  spouse: ConfirmSheetPerson | null
  dependents: ConfirmSheetPerson[]
  /** 印字の元（シートの隅に小さく出す。例: 令和7年度の提出／会社の登録内容） */
  source: string
}

export interface ConfirmSheetOptions {
  companyName: string
  yearLabel: string
  deadlineText: string
  employees: ConfirmSheetEmployee[]
}

const DOCS = [
  '生命保険料控除証明書', '地震保険料控除証明書', '国民年金保険料の控除証明書', '国民健康保険料の支払証明',
  '小規模企業共済・iDeCoの払込証明書', '住宅借入金等特別控除申告書・残高証明書', '前職の源泉徴収票（今年入社の方）',
]

function esc(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string),
  )
}

/** YYYY-MM-DD（YYYY/MM/DD）を和暦に。読めなければそのまま */
export function warekiOf(s: string): string {
  const m = String(s || '').trim().match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/)
  if (!m) return String(s || '')
  const y = +m[1], mo = +m[2], d = +m[3]
  const t = y * 10000 + mo * 100 + d
  const [era, base] = t >= 20190501 ? ['令和', 2018] : t >= 19890108 ? ['平成', 1988] : t >= 19261225 ? ['昭和', 1925] : t >= 19120730 ? ['大正', 1911] : ['明治', 1867]
  const ey = y - (base as number)
  return `${era}${ey === 1 ? '元' : ey}年${mo}月${d}日`
}

const box = '<span class="bx"></span>'

function page(o: ConfirmSheetOptions, e: ConfirmSheetEmployee): string {
  const sp = e.spouse
  const deps = e.dependents
  const kana = e.kana ? `（${esc(e.kana)}）` : ''
  return `<section class="page">
<div class="title">
  <div class="c">${esc(o.companyName)}　${esc(o.yearLabel)}</div>
  <h1>年末調整の確認シート</h1>
  <div class="n">${esc(e.name)} 様${e.code ? `（No.${esc(e.code)}）` : ''}</div>
  ${o.deadlineText ? `<div class="d">提出期限　${esc(o.deadlineText)}</div>` : ''}
</div>

<div class="q"><div class="h"><i>1</i>この会社で年末調整を行いますか？</div><div class="b">
  <div class="ans"><span>${box}はい（この会社がメイン）</span><span>${box}いいえ（他社で年末調整を受ける）→ ご住所を確認のうえ、記入日と署名だけで提出してください</span></div>
</div></div>

<div class="q"><div class="h"><i>2</i>ご本人の登録内容に変更はありますか？</div><div class="b">
  <div class="reg"><b>氏名</b>${esc(e.name)}${kana}　<b>生年月日</b>${esc(warekiOf(e.birth)) || '（未登録）'}</div>
  <div class="reg"><b>住所</b>${e.postal ? `〒${esc(e.postal)}　` : ''}${esc(e.address) || '（未登録）'}${e.householder ? `　<b>世帯主</b>${esc(e.householder)}` : ''}</div>
  <div class="ans"><span>${box}変更なし</span><span>${box}変更あり → 正しい内容をご記入ください</span></div>
  <div class="line"></div><div class="line"></div>
  <div class="mt">該当するもの：${box}障害者　${box}寡婦　${box}ひとり親　${box}勤労学生</div>
</div></div>

<div class="q"><div class="h"><i>3</i>配偶者の方について</div><div class="b">
  ${sp
    ? `<div class="reg"><b>登録内容</b>${esc(sp.name)}${sp.kana ? `（${esc(sp.kana)}）` : ''}　${esc(warekiOf(sp.birth))}</div>
  <div class="ans"><span>${box}変更なし</span><span>${box}変更あり（離婚・死別など）</span></div>`
    : `<div class="reg"><b>登録内容</b>配偶者の登録はありません</div>
  <div class="ans"><span>${box}配偶者はいない</span><span>${box}配偶者がいる（結婚など）→ 下にご記入ください</span></div>`}
  <div class="g2 mt"><div><div class="lbl">${sp ? '変更後の内容' : '氏名・フリガナ・生年月日'}</div><div class="line"></div></div><div><div class="lbl">配偶者の今年の収入見込（必ずご記入ください）</div><div class="line yen">円</div></div></div>
</div></div>

<div class="q"><div class="h"><i>4</i>扶養している家族について</div><div class="b">
  ${deps.length
    ? deps.map((d) => `<div class="reg"><b>${esc(d.rel || '扶養')}</b>${esc(d.name)}${d.kana ? `（${esc(d.kana)}）` : ''}　${esc(warekiOf(d.birth))}${d.together ? `　${esc(d.together)}` : ''}<span class="inc">今年の収入見込　＿＿＿＿＿＿円</span></div>`).join('')
    : '<div class="reg"><b>登録内容</b>扶養親族の登録はありません</div>'}
  <div class="ans"><span>${box}変更なし</span><span>${box}${deps.length ? '増えた・減った' : '扶養している家族がいる'} → 下にご記入ください</span></div>
  <div class="g2"><div><div class="lbl">氏名・フリガナ・続柄</div><div class="line"></div>${deps.length > 2 ? '' : '<div class="line"></div>'}</div><div><div class="lbl">生年月日・同居/別居・今年の収入見込</div><div class="line"></div>${deps.length > 2 ? '' : '<div class="line"></div>'}</div></div>
</div></div>

<div class="q"><div class="h"><i>5</i>一緒に出していただく書類（あるものに✓）</div><div class="b"><div class="g2">
  ${DOCS.map((d) => `<div>${box}${d}</div>`).join('')}<div>${box}何もない</div>
</div>
<div class="clip">📎 添付する書類は、<b>このシートのお名前が隠れないように</b>、<b>シートの裏側に重ねてクリップで留めて</b>ご提出ください（のり付け・ホチキス留めはしないでください）。</div>
</div></div>

<div class="sign"><span>内容に相違ありません。</span><div>記入日　　　年　　月　　日</div><div>氏名（自署）</div></div>
<div class="ft"><span>個人情報を含みます。封筒に入れて提出してください。ご不明な点は会社のご担当者へ。</span><span>印字の元：${esc(e.source)}</span></div>
</section>`
}

export function buildConfirmSheetHtml(o: ConfirmSheetOptions): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<title>年末調整 確認シート ${esc(o.companyName)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{background:#e8eaed;font-family:"Noto Sans JP","Hiragino Sans","Yu Gothic",Meiryo,sans-serif;color:#1f2937}
@page{size:A4;margin:0}
.page{width:210mm;min-height:297mm;margin:10mm auto;background:#fff;position:relative;box-shadow:0 2px 12px rgba(0,0,0,.12);padding:9mm 12mm 16mm;break-after:page;page-break-after:always}
.page:last-of-type{break-after:auto;page-break-after:auto}
@media print{body{background:#fff}.page{margin:0;box-shadow:none}.noprint{display:none}}
.title{background:#0f766e;color:#fff;border-radius:4mm;padding:3mm 5mm}
.title .c{font-size:10px;opacity:.85}.title h1{font-size:20px;margin:.5mm 0}.title .n{font-size:14px;font-weight:700}
.title .d{font-size:10px;margin-top:1.5mm;background:rgba(255,255,255,.18);display:inline-block;padding:.6mm 2.5mm;border-radius:2mm}
.q{margin-top:2.4mm;border:1px solid #d6e4e1;border-radius:3mm;overflow:hidden;break-inside:avoid}
.q .h{display:flex;align-items:center;gap:2.5mm;background:#ecf6f4;padding:1.4mm 3mm;font-size:11.5px;font-weight:700;color:#134e4a}
.q .h i{font-style:normal;background:#0f766e;color:#fff;border-radius:50%;width:6mm;height:6mm;display:flex;align-items:center;justify-content:center;font-size:10.5px;flex:none}
.q .b{padding:1.6mm 3.5mm;font-size:10px;line-height:1.65}
.ans{display:flex;flex-wrap:wrap;gap:1mm 6mm;font-size:10.5px;font-weight:500;margin-top:.8mm}
.reg{background:#f8fafc;border-radius:2mm;padding:1.1mm 2.5mm;margin:.7mm 0;font-size:10px}
.reg b{color:#0f766e;font-weight:700;margin-right:1.5mm}
.reg .inc{float:right;color:#374151}
.line{border-bottom:1px solid #9ca3af;height:6mm;margin-top:.3mm}
.line.yen{text-align:right;line-height:6.5mm}
.lbl{font-size:8.5px;color:#6b7280}
.mt{margin-top:1.2mm}
.g2{display:grid;grid-template-columns:1fr 1fr;gap:.6mm 5mm}
.clip{margin-top:1.8mm;background:#fff7ed;border:1px solid #fdba74;border-radius:2mm;padding:1.4mm 2.5mm;font-size:9.5px;color:#7c2d12;line-height:1.6}
.bx{display:inline-block;width:3.6mm;height:3.6mm;border:1.2px solid #374151;vertical-align:-.6mm;margin-right:1.2mm;border-radius:.6mm}
.sign{display:flex;gap:6mm;margin-top:3.5mm;font-size:10px;align-items:flex-end;break-inside:avoid}
.sign div{flex:1;border-bottom:1px solid #374151;padding-bottom:1mm}
.ft{position:absolute;left:12mm;right:12mm;bottom:6mm;display:flex;justify-content:space-between;gap:4mm;font-size:8.5px;color:#6b7280;border-top:1px solid #e5e7eb;padding-top:2mm}
.noprint{position:fixed;top:10px;right:10px;z-index:2}
.noprint button{font-family:inherit;font-size:13px;padding:8px 16px;background:#0f766e;color:#fff;border:none;border-radius:8px;cursor:pointer}
</style></head><body>
<div class="noprint"><button onclick="window.print()">🖨 印刷 / PDFに保存</button></div>
${o.employees.map((e) => page(o, e)).join('\n')}
<script>
(function(){
  function go(){ try{ window.focus(); window.print(); }catch(e){} }
  var ready = (document.fonts && document.fonts.ready) ? document.fonts.ready : Promise.resolve();
  Promise.race([ready, new Promise(function(r){ setTimeout(r, 3000) })]).then(function(){ setTimeout(go, 350) });
})();
</script>
</body></html>`
}

/** 先に開いたウインドウ（openPrintWindowNow）へ書き込む */
export function openConfirmSheetPrint(o: ConfirmSheetOptions, w: Window | null): boolean {
  if (!w) return false
  writePrintWindow(w, buildConfirmSheetHtml(o))
  return true
}
