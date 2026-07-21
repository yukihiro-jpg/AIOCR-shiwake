// 路線価マップ用の索引データ生成ツール。
// 国税庁 財産評価基準書サイト（rosenka.nta.go.jp）の町丁名索引ページから
// 「市区町村 → 町丁名 → 図番号」の対応表JSONを生成する。
//
// 使い方:
//   node tools/rosenka/build-rosenka-index.mjs                  … 最新3年分・全登録都道府県
//   node tools/rosenka/build-rosenka-index.mjs --years r08,r07  … 年分指定
//   node tools/rosenka/build-rosenka-index.mjs --sample         … 水戸市の索引HTMLの構造を表示して終了（デバッグ用）
//
// 出力: public/rosenka-data/index/{year}-{pref}.json ＋ manifest.json
// 実行環境: GitHub Actions（年次cron・workflow_dispatch）または手元PC。
// 国税庁コンテンツの利用は出典明記（政府標準利用規約）。リクエストは逐次＋間隔400msの省負荷クロール。

import { writeFileSync, readFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const OUT_DIR = join(ROOT, 'public', 'rosenka-data', 'index')

const NTA = 'https://www.rosenka.nta.go.jp'
const UA = 'aiocr-shiwake-rosenka-index-builder (tax office internal tool; low-volume yearly crawl)'
const DELAY_MS = 400
const MAX_REQUESTS = 600

// 対象都道府県（追加するときはここに登録: 国税局スラッグはURLで要確認）
const PREFS = [
  { slug: 'ibaraki', bureau: 'kanto', name: '茨城県' },
]

const KEEP_YEARS = 3 // 生成対象は最新3年分（過去に生成済みのファイルは残す）

let reqCount = 0
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function fetchText(url) {
  if (++reqCount > MAX_REQUESTS) throw new Error(`リクエスト数が上限(${MAX_REQUESTS})を超えました`)
  await sleep(DELAY_MS)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' })
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const buf = await res.arrayBuffer()
      // 国税庁の路線価ページは Shift_JIS
      try {
        return new TextDecoder('shift_jis').decode(buf)
      } catch {
        return new TextDecoder('utf-8').decode(buf)
      }
    } catch (e) {
      if (attempt === 1) throw new Error(`${url}: ${e.message}`)
      await sleep(1500)
    }
  }
  return null
}

const stripTags = (s) => s.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()

/** frameset ならフレームURL一覧を返す */
function frameSrcs(html, baseUrl) {
  const out = []
  const re = /<i?frame[^>]+src\s*=\s*["']?([^"'\s>]+)/gi
  let m
  while ((m = re.exec(html))) out.push(new URL(m[1], baseUrl).href)
  return out
}

/** ページ（frameset なら中のフレームも）を集めて返す */
async function fetchWithFrames(url, depth = 0) {
  const html = await fetchText(url)
  if (html == null) return []
  const pages = [{ url, html }]
  if (depth < 2 && /<frameset|<frame\s/i.test(html)) {
    for (const src of frameSrcs(html, url)) {
      // 同一ディレクトリ配下のみ辿る（外部・上位への逸脱防止）
      if (!src.startsWith(NTA)) continue
      pages.push(...(await fetchWithFrames(src, depth + 1)))
    }
  }
  return pages
}

/** 市区町村一覧（city_frm.htm 配下）から {code, name} を抽出 */
async function fetchCities(year, pref) {
  const url = `${NTA}/main_${year}/${pref.bureau}/${pref.slug}/prices/city_frm.htm`
  const pages = await fetchWithFrames(url)
  if (!pages.length) return null // 年分が存在しない
  const cities = new Map()
  for (const p of pages) {
    const re = /<a[^>]+href\s*=\s*["']?(?:\.\/)?([a-z]\d{5})fr\.htm["']?[^>]*>([\s\S]*?)<\/a>/gi
    let m
    while ((m = re.exec(p.html))) {
      const code = m[1]
      const name = stripTags(m[2])
      if (name && !cities.has(code)) cities.set(code, name)
    }
  }
  return Array.from(cities.entries()).map(([code, name]) => ({ code, name }))
}

/** 町丁名索引ページ（{code}fr.htm 配下）から 町丁名→図番号[] を抽出 */
async function fetchTowns(year, pref, cityCode, debug = false) {
  const url = `${NTA}/main_${year}/${pref.bureau}/${pref.slug}/prices/${cityCode}fr.htm`
  const pages = await fetchWithFrames(url)
  const towns = {}
  for (const p of pages) {
    if (!/html\/\d{5}f\.htm/.test(p.html)) continue
    // 行単位（<tr>）で「先頭セル=町丁名、行内のリンク=図番号」を抽出
    const rows = p.html.split(/<tr[\s>]/i)
    for (const row of rows) {
      const sheets = []
      const linkRe = /href\s*=\s*["']?[^"'>]*html\/(\d{5})f\.htm/gi
      let lm
      while ((lm = linkRe.exec(row))) sheets.push(lm[1])
      if (!sheets.length) continue
      // 町丁名: リンクを含まないテキストセルのうち「最後」のもの。
      // （五十音セクションの先頭行は <td rowspan>あ</td><td>青柳町</td><td>リンク…</td> の形になり、
      //   最初のセルは見出しの仮名1文字のため、リンク直前のセルを町丁名として採用する）
      let town = ''
      const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi
      let cm
      while ((cm = cellRe.exec(row))) {
        const cellHtml = cm[1]
        if (/f\.htm/.test(cellHtml)) continue // 図番号リンクのセル
        const text = stripTags(cellHtml)
        if (text && !/^[\d\s,]+$/.test(text)) town = text
      }
      if (!town) continue
      if (/^[ぁ-んァ-ヶ]$/.test(town)) continue // 五十音見出しのみの行は除外
      if (!towns[town]) towns[town] = []
      for (const s of sheets) if (!towns[town].includes(s)) towns[town].push(s)
    }
    if (debug) {
      console.log(`--- サンプル(${p.url}) 先頭2000文字 ---`)
      console.log(p.html.slice(0, 2000))
    }
  }
  return towns
}

/** 最新年分の自動判定: 令和N = 西暦-2018。存在チェックして最新から KEEP_YEARS 分 */
async function detectYears() {
  const latestGuess = new Date().getFullYear() - 2018
  const years = []
  for (let n = latestGuess; n >= latestGuess - KEEP_YEARS - 1 && years.length < KEEP_YEARS; n--) {
    if (n < 1) break
    const y = `r${String(n).padStart(2, '0')}`
    const html = await fetchText(`${NTA}/main_${y}/index.htm`)
    if (html != null) years.push(y)
    else console.log(`main_${y}: 未公開（スキップ）`)
  }
  return years
}

const yearLabel = (y) => {
  const m = y.match(/^r(\d+)$/)
  return m ? `令和${Number(m[1])}年分` : y
}

async function main() {
  const args = process.argv.slice(2)
  const debug = args.includes('--sample')
  const yearsArg = args.find((a) => a.startsWith('--years'))
  const years = yearsArg
    ? (yearsArg.split('=')[1] || args[args.indexOf(yearsArg) + 1]).split(',')
    : await detectYears()
  if (!years.length) {
    console.error('公開中の年分が見つかりませんでした（国税庁サイトへ到達できない可能性）')
    process.exit(1)
  }
  console.log(`対象年分: ${years.join(', ')}`)
  mkdirSync(OUT_DIR, { recursive: true })

  for (const pref of PREFS) {
    for (const year of years) {
      const outPath = join(OUT_DIR, `${year}-${pref.slug}.json`)
      const cities = await fetchCities(year, pref)
      if (cities == null) { console.log(`${year}/${pref.slug}: 年分ページなし・スキップ`); continue }
      if (!cities.length) {
        console.error(`${year}/${pref.slug}: 市区町村一覧を抽出できませんでした（ページ構造の確認が必要）`)
        const pages = await fetchWithFrames(`${NTA}/main_${year}/${pref.bureau}/${pref.slug}/prices/city_frm.htm`)
        for (const p of pages.slice(0, 3)) {
          console.log(`--- 構造サンプル(${p.url}) 先頭1500文字 ---`)
          console.log(p.html.slice(0, 1500))
        }
        continue
      }
      console.log(`${year}/${pref.slug}: ${cities.length}市区町村`)
      const outCities = []
      let townTotal = 0
      for (const c of cities) {
        const towns = await fetchTowns(year, pref, c.code, debug && c.name === '水戸市')
        const n = Object.keys(towns).length
        townTotal += n
        console.log(`  ${c.code} ${c.name}: ${n}町丁`)
        outCities.push({ code: c.code, name: c.name, towns })
        if (debug && c.name === '水戸市') return // サンプルモードは水戸市のみで終了
      }
      if (townTotal === 0) {
        console.error(`${year}/${pref.slug}: 町丁を1件も抽出できませんでした。JSONは出力しません（既存データ保護）`)
        continue
      }
      const idx = {
        year, yearLabel: yearLabel(year), bureau: pref.bureau, prefSlug: pref.slug, prefName: pref.name,
        generatedAt: new Date().toISOString(),
        cities: outCities,
      }
      writeFileSync(outPath, JSON.stringify(idx))
      console.log(`書き出し: ${outPath}（${townTotal}町丁）`)
    }
  }

  // manifest: 出力ディレクトリの実在ファイルから生成（過去年分も保持）
  const files = existsSync(OUT_DIR) ? readdirSync(OUT_DIR).filter((f) => /^r\d{2}-[a-z]+\.json$/.test(f)) : []
  const yearSet = new Map()
  const prefSet = new Map()
  for (const f of files) {
    const [y, slugJson] = f.split('-')
    const slug = slugJson.replace('.json', '')
    yearSet.set(y, { id: y, label: yearLabel(y) })
    const known = PREFS.find((p) => p.slug === slug)
    try {
      const data = JSON.parse(readFileSync(join(OUT_DIR, f), 'utf8'))
      prefSet.set(slug, { slug, name: data.prefName || known?.name || slug, bureau: data.bureau || known?.bureau || '' })
    } catch { /* skip broken */ }
  }
  const manifest = {
    updatedAt: new Date().toISOString(),
    years: Array.from(yearSet.values()).sort((a, b) => b.id.localeCompare(a.id)),
    prefs: Array.from(prefSet.values()),
  }
  writeFileSync(join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 1))
  console.log(`manifest.json 更新: 年分=${manifest.years.map((y) => y.id).join(',')} / 県=${manifest.prefs.map((p) => p.slug).join(',')}`)
  console.log(`総リクエスト数: ${reqCount}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
