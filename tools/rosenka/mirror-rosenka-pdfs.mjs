// 路線価図PDFのミラーツール。
// 国税庁のPDFは X-Frame-Options: SAMEORIGIN のため他サイトから iframe 埋め込みできない。
// そこで索引に載っている図面PDFを専用ブランチ（rosenka-pdfs）へミラーし、アプリは
// raw.githubusercontent.com（CORS許可）から取得して blob URL で画面内表示する。
// 原典は国税庁（政府標準利用規約に基づく複製・出典はアプリ内に常時表示）。
//
// 使い方: node tools/rosenka/mirror-rosenka-pdfs.mjs --index-dir <indexJSONの場所> --dest <ミラー先ディレクトリ>
// 既にミラー済みのPDFはスキップする（新年度分だけが差分ダウンロードされる）。

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const NTA = 'https://www.rosenka.nta.go.jp'
const UA = 'aiocr-shiwake-rosenka-pdf-mirror (tax office internal tool; yearly delta sync)'
const DELAY_MS = 150
const MAX_DOWNLOADS = 4000

const args = process.argv.slice(2)
const opt = (name, dflt) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : dflt
}
const INDEX_DIR = opt('--index-dir', 'public/rosenka-data/index')
const DEST = opt('--dest', '.rosenka-pdfs')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function download(url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } })
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('PDFではない応答')
      return buf
    } catch (e) {
      if (attempt === 1) { console.warn(`  失敗: ${url}: ${e.message}`); return null }
      await sleep(2000)
    }
  }
  return null
}

async function main() {
  const files = readdirSync(INDEX_DIR).filter((f) => /^r\d{2}-[a-z]+\.json$/.test(f))
  if (!files.length) { console.error('索引JSONがありません:', INDEX_DIR); process.exit(1) }
  let downloaded = 0
  let skipped = 0
  let failed = 0
  for (const f of files) {
    const idx = JSON.parse(readFileSync(join(INDEX_DIR, f), 'utf8'))
    const sheets = new Set()
    for (const c of idx.cities) for (const arr of Object.values(c.towns)) for (const s of arr) sheets.add(s)
    // 隣接図面ナビの接続先（町丁名索引に出ない図面もあり得る）もミラー対象に含める
    for (const [s, dirs] of Object.entries(idx.adj || {})) {
      sheets.add(s)
      for (const t of Object.values(dirs)) if (t) sheets.add(t)
    }
    const dir = join(DEST, idx.year, idx.prefSlug)
    mkdirSync(dir, { recursive: true })
    console.log(`${idx.year}/${idx.prefSlug}: ${sheets.size}図面`)
    for (const s of Array.from(sheets).sort()) {
      const dest = join(dir, `${s}.pdf`)
      if (existsSync(dest)) { skipped++; continue }
      if (downloaded >= MAX_DOWNLOADS) { console.error('ダウンロード上限に達しました（次回実行で続きを取得）'); break }
      await sleep(DELAY_MS)
      const buf = await download(`${NTA}/main_${idx.year}/${idx.bureau}/${idx.prefSlug}/prices/pdf/${s}.pdf`)
      if (buf) { writeFileSync(dest, buf); downloaded++ }
      else failed++
      if (downloaded % 200 === 0 && downloaded > 0) console.log(`  進捗: ${downloaded}件`)
    }
  }
  console.log(`完了: 新規${downloaded}件 / 既存スキップ${skipped}件 / 失敗${failed}件`)
  // 1件も取得できず既存も無い場合は異常終了（ブランチを空でコミットしないため）
  if (downloaded === 0 && skipped === 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
