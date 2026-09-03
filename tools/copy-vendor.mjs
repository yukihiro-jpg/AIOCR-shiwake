// 外部CDNから読んでいたライブラリを、npm で固定したものから public/vendor/ へ複製する。
//
// 目的（セキュリティ）: CDN が改ざんされると、そのスクリプトはアプリと同じ権限で動くため
// 合言葉・APIキー・全データが流出する。npm のロックファイルで版を固定した実体を
// 自分のサイト（GitHub Pages）から配信すれば、第三者のCDNに依存しなくなる。
//
// 実行タイミング: `npm run build` の先頭（package.json の build スクリプト）。
// public/vendor/ は生成物なので git には入れない（.gitignore 済み）。
//
// 【残っている外部読込】
//   - SheetJS (xlsx 0.20.x) … npm に無く SheetJS 自身のCDNからしか取れない。komon は
//     そのまま cdn.sheetjs.com から読む。ネット接続のある環境で
//       npm i https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz
//     を行えばここへ移せる（node_modules/xlsx が 0.20 系なら自動で複製する）
//   - Google Identity Services (accounts.google.com/gsi/client) … Googleドライブ保存用。
//     Google が直接配信する動的スクリプトで自前配信できない
//   - OCR の日本語学習データ (tessdata.projectnaptha.com) … 実行コードではないデータ

import { cpSync, mkdirSync, existsSync, rmSync, readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const NM = join(ROOT, 'node_modules')
const OUT = join(ROOT, 'public', 'vendor')

const want = [
  // pdf.js（通帳・カード明細・申告書PDFの読み取り）。アプリ本体は legacy ビルドを import
  // しているので、ワーカーも同じ legacy ビルドを使う
  ['pdfjs-dist/legacy/build/pdf.min.js', 'pdfjs/pdf.min.js'],
  ['pdfjs-dist/legacy/build/pdf.worker.min.js', 'pdfjs/pdf.worker.min.js'],
  ['pdfjs-dist/cmaps', 'pdfjs/cmaps'],
  ['pdfjs-dist/standard_fonts', 'pdfjs/standard_fonts'],
  // tesseract.js（化けたカード明細の摘要OCR）。ワーカー＋WASMコア
  ['tesseract.js/dist/worker.min.js', 'tesseract/worker.min.js'],
  // コアは *.wasm.js（WASMを内包した実行ファイル）だけ読まれる。.wasm 単体と小さな .js は不要
  ['tesseract.js-core', 'tesseract/core', /\.wasm\.js$/],
  // 顧問先情報・相続管理（単一HTMLモジュール）が使うライブラリ
  ['exceljs/dist/exceljs.min.js', 'exceljs.min.js'],
  ['html2canvas/dist/html2canvas.min.js', 'html2canvas.min.js'],
  ['jspdf/dist/jspdf.umd.min.js', 'jspdf.umd.min.js'],
  ['file-saver/dist/FileSaver.min.js', 'FileSaver.min.js'],
  // 資料回収の一括PDF（1社1ファイル）をZIPにまとめて1回のダウンロードで渡すため
  ['jszip/dist/jszip.min.js', 'jszip.min.js'],
]

// SheetJS は 0.20 系のときだけ自前配信へ切り替える（0.18 系には既知の脆弱性があるため、
// 古い版を配るくらいなら SheetJS 公式CDNの 0.20.3 を読む方がまし）
try {
  const v = JSON.parse(readFileSync(join(NM, 'xlsx', 'package.json'), 'utf8')).version
  if (/^0\.(20|2[1-9]|[3-9]\d)\./.test(v)) want.push(['xlsx/dist/xlsx.full.min.js', 'xlsx.full.min.js'])
  else console.log(`[copy-vendor] xlsx ${v} は旧版のため複製しない（komon は SheetJS CDN の 0.20.3 を使用）`)
} catch { /* xlsx 無し */ }

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
let bytes = 0
for (const [src, dst, only] of want) {
  const from = join(NM, src)
  if (!existsSync(from)) {
    console.error(`[copy-vendor] 見つかりません: ${src}（npm install を実行してください）`)
    process.exit(1)
  }
  const to = join(OUT, dst)
  mkdirSync(dirname(to), { recursive: true })
  cpSync(from, to, {
    recursive: true,
    filter: (p) => !/\.map$|LICENSE|README|package\.json$/.test(p) && (!only || statSync(p).isDirectory() || only.test(p)),
  })
  bytes += dirSize(to)
}
// 生成物であることを明記（誤ってコミットされたときに気づけるように）
writeFileSync(join(OUT, 'README.txt'), 'このフォルダは tools/copy-vendor.mjs がビルド時に生成します。直接編集しないでください。\n')
console.log(`[copy-vendor] ${want.length} 件を public/vendor/ へ複製（${(bytes / 1024 / 1024).toFixed(1)} MB）`)

function dirSize(p) {
  const st = statSync(p)
  if (st.isFile()) return st.size
  let n = 0
  for (const f of readdirSync(p)) n += dirSize(join(p, f))
  return n
}
