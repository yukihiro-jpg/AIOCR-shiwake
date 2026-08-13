// 新報告書 v2 の紙面スタイルと共通の組立ヘルパー。
//
// 2色（黒＋シアン）で刷ることを前提にした設計:
//  - 色に意味を持たせるのは「シアン＝いま見てほしいところ」だけ。
//    マイナス・悪化は色ではなく △ と太字で示すので、白黒コピーでも意味が消えない。
//  - 濃さの段階は黒の網（8/18/45/70%）とシアンの網（15/30%）に限定する。
//  - 用紙は A4横（297×210mm）で直接組版する。A3へ拡大しない。
import type { Unit } from './types'

export const CY = '#0089c7'       // シアン（見出し帯・当期・注目値）
export const CY30 = '#a8dcf2'     // シアン30%網
export const CY15 = '#e2f4fc'     // シアン15%網
export const INK70 = '#4d4d4d'
export const INK45 = '#8c8c8c'
export const INK18 = '#d6d6d6'
export const INK08 = '#efefef'

export function esc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ===== 数値表記 =====
/** 単位の割り算（千円なら1000で割って四捨五入） */
export function toUnit(n: number, unit: Unit): number {
  return unit === 'thousand' ? Math.round(n / 1000) : Math.round(n)
}
/** 金額（マイナスは △ で表す。色は付けない） */
export function amt(n: number, unit: Unit): string {
  const v = toUnit(n, unit)
  if (v === 0) return '0'
  return (v < 0 ? '△' : '') + Math.abs(v).toLocaleString('en-US')
}
/** 金額（未入力は「—」） */
export function amtOrDash(n: number | null | undefined, unit: Unit): string {
  if (n == null || !isFinite(n)) return '—'
  return amt(n, unit)
}
/** 符号付き金額（増減欄。プラスにも符号を付けたいとき） */
export function amtSigned(n: number, unit: Unit): string {
  const v = toUnit(n, unit)
  if (v === 0) return '0'
  return (v < 0 ? '△' : '＋') + Math.abs(v).toLocaleString('en-US')
}
/** マイナスなら太字クラスを返す（△＋太字がマイナスの表現） */
export function negCls(n: number | null | undefined): string {
  return n != null && isFinite(n) && n < 0 ? ' neg' : ''
}
export const pct = (n: number | null | undefined, d = 1): string =>
  n == null || !isFinite(n) ? '—' : `${n < 0 ? '△' : ''}${Math.abs(n).toFixed(d)}%`
export const ptv = (n: number | null | undefined, d = 1): string =>
  n == null || !isFinite(n) ? '—' : `${n < 0 ? '△' : ''}${Math.abs(n).toFixed(d)}pt`
export const unitLabel = (u: Unit): string => (u === 'thousand' ? '単位：千円' : '単位：円')
export const unitWord = (u: Unit): string => (u === 'thousand' ? '千円' : '円')

/** 金額を文章に埋め込むとき（単位語つき） */
export function amtWord(n: number, unit: Unit): string {
  return `${amt(n, unit)}${unitWord(unit)}`
}

// ===== 紙面の部品 =====
export interface PageHeadOpts {
  /** ページ番号バッジ（表紙の目次と一致する通し番号）。'参考' などの文字列も可 */
  no: number | string
  title: string
  /** 右肩の補足（改行は <br> で渡す。すでにエスケープ済みの文字列） */
  metaHtml?: string
}
export function pageHead(o: PageHeadOpts): string {
  return `<div class="phead">
    <div style="display:flex; align-items:flex-end;"><span class="no">${esc(String(o.no))}</span><h1>${esc(o.title)}</h1></div>
    ${o.metaHtml ? `<div class="meta">${o.metaHtml}</div>` : ''}
  </div>
  <div class="rule"></div>`
}
export function pageFoot(company: string, fyLabel: string, monthLabel: string, no: number | string): string {
  return `<div class="pfoot"><span>${esc(company)}</span><span>月次経営レポート ｜ ${esc(fyLabel)} ${esc(monthLabel)}</span><span>― ${esc(String(no))} ―</span></div>`
}
export function section(inner: string): string {
  return `<section class="page">${inner}</section>`
}
/** 自動コメント（リード文）。強調は <b>、注目値は <span class="mg"> を使う */
export function lead(html: string): string {
  return `<div class="lead">${html}</div>`
}
export function blkTitle(title: string, sub?: string): string {
  return `<div class="blk-t">${esc(title)}${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</div>`
}
export function note(html: string, cls = ''): string {
  return `<div class="note${cls ? ' ' + cls : ''}">${html}</div>`
}

// ===== スタイル =====
export const REPORT_V2_CSS = `
:root{
  --ink:#000000; --ink70:${INK70}; --ink45:${INK45}; --ink18:${INK18}; --ink08:${INK08};
  --mg:${CY}; --mg30:${CY30}; --mg15:${CY15};
}
@page { size: A4 landscape; margin: 0; }
*{ box-sizing:border-box; margin:0; padding:0; }
html,body{ background:#8e8e8e; }
body{
  font-family:"Noto Sans JP","Hiragino Sans","Yu Gothic",Meiryo,sans-serif;
  color:var(--ink); font-size:9.5pt; line-height:1.5;
  font-feature-settings:"palt" 1; font-variant-numeric: tabular-nums lining-nums;
  -webkit-print-color-adjust:exact; print-color-adjust:exact;
}
.page{
  width:297mm; height:210mm; padding:8.5mm 10mm 7mm; background:#fff;
  margin:0 auto 6mm; position:relative; overflow:hidden;
}
.page.a3{ width:420mm; height:297mm; padding:11mm 13mm 9mm; }
@media print{
  html,body{background:#fff;}
  .page{ margin:0; page-break-after:always; }
  .page:last-child{page-break-after:auto;}
  .toolbar{display:none;}
}
.phead{ display:flex; align-items:flex-end; justify-content:space-between; }
.phead .no{ font-size:8pt; font-weight:700; color:#fff; background:var(--mg);
  padding:0.3mm 1.6mm; margin-right:2mm; letter-spacing:.04em; }
.phead h1{ font-size:15pt; font-weight:700; letter-spacing:.02em; }
.phead .meta{ font-size:8.5pt; color:var(--ink70); text-align:right; line-height:1.3; }
.phead .meta b{ color:var(--ink); }
.rule{ height:0; border-top:0.7mm solid var(--ink); margin:1.4mm 0 0; position:relative; }
.rule::after{ content:""; position:absolute; left:0; top:-0.7mm; width:38mm; height:0.7mm; background:var(--mg); }

.lead{ margin-top:2.6mm; padding:2.2mm 2.8mm 2.2mm 3.4mm; background:var(--ink08);
  border-left:1.2mm solid var(--mg); font-size:9.5pt; line-height:1.5; }
.lead b{ font-weight:700; }
.lead .mg{ color:var(--mg); font-weight:700; }

.grid{ display:flex; gap:4mm; margin-top:3mm; }
.col{ flex:1; min-width:0; }
.blk-t{ font-size:9.5pt; font-weight:700; padding-bottom:0.8mm; margin-bottom:1.2mm;
  border-bottom:0.35mm solid var(--ink); }
.blk-t .sub{ font-weight:400; font-size:7.5pt; color:var(--ink70); margin-left:1.5mm; }
.note{ font-size:7.5pt; color:var(--ink45); line-height:1.4; margin-top:1.2mm; }
.mt1{ margin-top:1.2mm; } .mt2{ margin-top:2.5mm; } .mt4{ margin-top:4mm; }

table{ width:100%; border-collapse:collapse; }
th,td{ padding:1.05mm 1.5mm; border-bottom:0.2mm solid var(--ink18); }
thead th{ background:var(--mg); color:#fff; font-weight:700; font-size:8.5pt;
  text-align:right; border-bottom:0.35mm solid var(--ink); white-space:nowrap; }
thead th.l{ text-align:left; }
thead.plain th{ background:var(--ink08); color:var(--ink); border-bottom:0.35mm solid var(--ink); }
td.r{ text-align:right; white-space:nowrap; }
td.c{ text-align:center; }
tr.sub td{ background:var(--ink08); font-weight:700; }
tr.key td{ background:var(--mg15); font-weight:700;
  border-top:0.3mm solid var(--mg30); border-bottom:0.3mm solid var(--mg30); }
tr.total td{ background:var(--ink08); font-weight:700;
  border-top:0.4mm solid var(--ink); border-bottom:0.4mm solid var(--ink); }
td.ind1{ padding-left:4mm; } td.ind2{ padding-left:7mm; }
td.nm{ white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.neg{ font-weight:700; }
.mgv{ color:var(--mg); font-weight:700; }
.unit{ font-size:7.5pt; color:var(--ink70); text-align:right; margin-bottom:0.8mm; }
.cmp th,.cmp td{ padding:0.6mm 1.3mm; font-size:8pt; }

.cards{ display:flex; gap:2.4mm; margin-top:3mm; }
.card{ flex:1; border:0.3mm solid var(--ink); padding:1.6mm 2mm; min-width:0; }
.card .cl{ font-size:7.5pt; color:var(--ink70); }
.card .cv{ font-size:14pt; font-weight:700; line-height:1.2; }
.card .cv.sm{ font-size:11.5pt; }
.card .cs{ font-size:7.5pt; color:var(--ink70); }
.card.hi{ border:0.5mm solid var(--mg); background:var(--mg15); }
.card.hi .cv{ color:var(--mg); }

.badge{ display:inline-block; font-size:7pt; font-weight:700; padding:0.2mm 1.4mm;
  border:0.3mm solid var(--ink); }
.badge.mg{ background:var(--mg); color:#fff; border-color:var(--mg); }

.pfoot{ position:absolute; left:10mm; right:10mm; bottom:3.5mm;
  border-top:0.2mm solid var(--ink18); padding-top:1mm;
  font-size:7.5pt; color:var(--ink45); display:flex; justify-content:space-between; }
.page.a3 .pfoot{ left:13mm; right:13mm; bottom:5mm; }

/* 3期推移PL（列合わせ） */
.tr3{ width:100%; border-collapse:collapse; }
.tr3 th,.tr3 td{ font-size:7.2pt; padding:0.45mm 0.9mm; line-height:1.25; border-bottom:0.15mm solid var(--ink18); }
.tr3 thead th{ background:var(--mg); color:#fff; font-weight:700; text-align:right; border-bottom:0.35mm solid var(--ink); }
.tr3 thead th.l{ text-align:left; }
.tr3 thead th.sm{ font-size:6.2pt; font-weight:400; background:var(--mg); border-bottom:0.35mm solid var(--ink); }
.tr3 td.nm{ font-weight:700; border-right:0.25mm solid var(--ink); vertical-align:middle; }
.tr3 td.pl{ color:var(--ink70); font-size:6.8pt; border-right:0.15mm solid var(--ink18); white-space:nowrap; }
.tr3 td.r{ text-align:right; white-space:nowrap; }
.tr3 td.sumc{ background:var(--ink08); font-weight:700; }
.tr3 tr.cur td{ font-weight:700; }
.tr3 tr.cur td.r{ background:var(--mg15); }
.tr3 tr.cur td.pl{ background:var(--mg15); color:var(--mg); font-weight:700; }
.tr3 tr.first td{ border-top:0.35mm solid var(--ink); }
.tr3 tr.k.first td{ border-top:0.55mm solid var(--ink); }
.tr3 tr.k td.nm{ background:var(--mg15); }
.tr3 tr.g td.nm{ background:var(--ink08); }
.tr3 tr.cur td.sumc{ background:var(--mg30); }

/* 当事業年度の月次損益推移（報告月の列だけシアン網） */
.tr3.mpl th,.tr3.mpl td{ padding:0.75mm 0.9mm; }
.tr3.mpl td.nm{ font-weight:400; border-right:0.25mm solid var(--ink); }
.tr3.mpl tr.key td.nm,.tr3.mpl tr.sub td.nm,.tr3.mpl tr.total td.nm{ font-weight:700; }
.tr3.mpl td.ind1{ padding-left:3mm; }
.tr3.mpl td.cm{ background:var(--mg15); font-weight:700; }
.tr3.mpl tr.key td{ background:var(--mg15); }
.tr3.mpl tr.key td.cm{ background:var(--mg30); }
.tr3.mpl tr.sub td{ background:var(--ink08); }
.tr3.mpl tr.total td{ background:var(--ink08); border-top:0.4mm solid var(--ink); border-bottom:0.4mm solid var(--ink); }

/* 日繰り表 */
.day th,.day td{ font-size:7.4pt; padding:0.5mm 1.2mm; }
.day td.nt{ font-size:7pt; color:var(--ink70); white-space:nowrap; overflow:hidden; }
.day tr.dg td{ background:var(--ink08); }
.day tr.bt td{ background:var(--mg15); font-weight:700; }

.pg-body{ transform-origin:top left; }

.toolbar{ position:fixed; right:10px; bottom:10px; background:#fff; border:1px solid #000;
  padding:6px 10px; font-size:12px; z-index:9; }
`

/**
 * ページに収まらない紙面を自動で縮めて、**何があっても文字が切れないようにする**安全網。
 *
 * 科目数は顧問先ごとにまったく違う（販管費が12科目の会社もあれば40科目の会社もある）ので、
 * 行数を決め打ちにすると必ずどこかで溢れる。そこで「組んでから測って、はみ出していたら
 * その分だけ縮める」方式にした。縮むのは本文だけで、フッター（会社名・ページ番号）は
 * 絶対配置なので位置も大きさも変わらない。
 *
 * - 縮小は zoom（対応していないブラウザは transform+幅補正）。どちらも**先に幅を広く取ってから
 *   縮める**ので、行の折り返し位置は変わらず、単に文字が小さくなるだけになる。
 * - 下限は0.45。ここまで縮めばA4横に収まらない紙面は事実上無い（＝切れることはない）。
 * - 画面プレビュー（iframe）でも印刷ウィンドウでも同じスクリプトが動くので、見た目が一致する。
 */
const AUTOFIT_JS = `
(function(){
  var MIN_SCALE = 0.45;   // これ以上は縮めない（読めなくなるため）
  var GAP_MM = 1.5;       // フッターとの間に必ず空ける隙間
  var useZoom = (function(){ try { return CSS.supports('zoom','0.5'); } catch(e){ return false; } })();
  function mm(v){ return v * 96 / 25.4; }
  function bodyOf(pg){
    var b = pg.querySelector('.pg-body');
    if (b) return b;
    var kids = [];
    for (var i = 0; i < pg.childNodes.length; i++) {
      var n = pg.childNodes[i];
      if (n.nodeType === 1 && n.className && String(n.className).indexOf('pfoot') >= 0) continue;
      kids.push(n);
    }
    b = document.createElement('div');
    b.className = 'pg-body';
    pg.insertBefore(b, pg.firstChild);
    for (var j = 0; j < kids.length; j++) b.appendChild(kids[j]);
    return b;
  }
  function apply(b, k){
    if (useZoom) { b.style.zoom = k === 1 ? '' : String(k); return; }
    b.style.transform = k === 1 ? '' : 'scale(' + k + ')';
    b.style.width = k === 1 ? '' : (100 / k) + '%';
  }
  function fit(){
    var pages = document.querySelectorAll('.page');
    for (var i = 0; i < pages.length; i++) {
      var pg = pages[i];
      var b = bodyOf(pg);
      apply(b, 1);
      var foot = pg.querySelector('.pfoot');
      var padTop = parseFloat(window.getComputedStyle(pg).paddingTop) || 0;
      var limit = (foot ? foot.offsetTop : pg.clientHeight) - padTop - mm(GAP_MM);
      if (!(limit > 0)) continue;
      var k = 1;
      for (var t = 0; t < 8; t++) {
        var h = b.scrollHeight * k;
        if (h <= limit + 0.5) break;
        k = Math.max(MIN_SCALE, k * (limit / h) * 0.998);
        apply(b, k);
        if (k <= MIN_SCALE) break;
      }
    }
  }
  function run(){
    fit();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fit);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
  window.addEventListener('load', fit);
  window.addEventListener('beforeprint', fit);
})();
`

/** 完成HTML（印刷用の1枚もの）を組み立てる */
export function wrapHtml(title: string, body: string, preview = false): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700;800&display=swap" rel="stylesheet">
<style>${REPORT_V2_CSS}</style>
</head>
<body>
${body}
${preview ? '' : '<div class="toolbar">A4・横で印刷してください（余白なし）　<button onclick="window.print()">🖨 印刷 / PDF保存</button></div>'}
<script>${AUTOFIT_JS}</script>
</body>
</html>`
}
