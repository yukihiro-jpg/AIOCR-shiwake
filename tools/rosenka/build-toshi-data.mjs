// 都市計画（用途地域）データの生成ツール。
// 国土数値情報 用途地域データ（A29）のシェープファイルを mapshaper で GeoJSON 化したものを
// 入力に、路線価マップが読む軽量JSON（public/rosenka-data/toshi/{pref}.json）へ変換する。
//
// 使い方: node tools/rosenka/build-toshi-data.mjs (--geojson <input.geojson> | --geojson-dir <dir>) --out <output.json>
//   --geojson-dir はディレクトリ内の *.geojson を全て結合する（県zipは市町村別の複数ファイルのため）
//
// 「間違ったものを出さない」方針:
//   属性キーは候補から自動検出し、値の内容（用途地域名らしさ・建蔽率/容積率の範囲）を検証。
//   検証に通らない場合はサンプルを出力して異常終了し、既存データを壊さない。

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

const args = process.argv.slice(2)
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null }
const IN = opt('--geojson')
const IN_DIR = opt('--geojson-dir')
const OUT = opt('--out')
if ((!IN && !IN_DIR) || !OUT) { console.error('使い方: (--geojson <in> | --geojson-dir <dir>) --out <out>'); process.exit(1) }

const YOUTO_RE = /住居|商業|工業|田園/

const inputs = IN_DIR
  ? readdirSync(IN_DIR).filter((f) => f.endsWith('.geojson')).map((f) => join(IN_DIR, f))
  : [IN]
const feats = []
for (const p of inputs) {
  try {
    const gj = JSON.parse(readFileSync(p, 'utf8'))
    if (Array.isArray(gj.features)) feats.push(...gj.features)
  } catch (e) {
    console.warn(`読込失敗（スキップ）: ${p}: ${e.message}`)
  }
}
console.log(`入力: ${inputs.length}ファイル / ${feats.length}フィーチャ`)
if (feats.length < 20) {
  console.error(`フィーチャ数が少なすぎます: ${feats.length}`)
  process.exit(1)
}

// 属性キーの自動検出（値の内容で検証する）。
// サンプルは全件から等間隔に取る（先頭ファイル＝1市だけだと容積率の値域が偏り検出に失敗する）
const step = Math.max(1, Math.floor(feats.length / 500))
const sampleProps = feats.filter((_, i) => i % step === 0).slice(0, 500).map((f) => f.properties || {})
function detectKey(pred) {
  const keys = Object.keys(sampleProps[0] || {})
  for (const k of keys) {
    const vals = sampleProps.map((p) => p[k]).filter((v) => v != null && v !== '')
    if (vals.length >= sampleProps.length * 0.5 && vals.filter(pred).length >= vals.length * 0.9) return k
  }
  return null
}
/** 数値列の統計（9割以上が数値でなければnull） */
function numStats(k) {
  const vals = sampleProps.map((p) => p[k]).filter((v) => v != null && v !== '')
  if (!vals.length) return null
  const nums = vals.map(Number).filter((n) => Number.isFinite(n))
  if (nums.length < vals.length * 0.9) return null
  const pct10 = nums.filter((n) => n % 10 === 0).length / nums.length
  return { min: Math.min(...nums), max: Math.max(...nums), pct10 }
}
const nameKey = detectKey((v) => typeof v === 'string' && YOUTO_RE.test(v))
// 建蔽率: 30〜90%（最大が90以下）／ 容積率: 50〜1500%（最大が100以上）— 値域で列を区別する
let kenpeiKey = null
let yosekiKey = null
for (const k of Object.keys(sampleProps[0] || {})) {
  const s = numStats(k)
  if (!s || s.pct10 < 0.9) continue
  if (!kenpeiKey && s.min >= 30 && s.max <= 90) kenpeiKey = k
  else if (!yosekiKey && s.min >= 50 && s.max >= 100 && s.max <= 1500) yosekiKey = k
}
console.log(`属性キー検出: 用途地域名=${nameKey} 建蔽率=${kenpeiKey} 容積率=${yosekiKey}`)
console.log('数値列の統計:', Object.keys(sampleProps[0] || {}).map((k) => { const s = numStats(k); return s ? `${k}[${s.min}..${s.max}]` : null }).filter(Boolean).join(' '))
if (!nameKey) {
  console.error('用途地域名の属性キーを検出できませんでした。属性サンプル:')
  console.error(JSON.stringify(sampleProps.slice(0, 3), null, 1))
  process.exit(1)
}

const round = (n) => Math.round(n * 1e5) / 1e5

/** GeoJSON座標 → 丸め済みリング配列。短すぎるリングは捨てる */
function toRings(coords) {
  const rings = []
  for (const ring of coords) {
    if (!Array.isArray(ring) || ring.length < 4) continue
    rings.push(ring.map(([lng, lat]) => [round(lng), round(lat)]))
  }
  return rings
}

const out = []
let badGeom = 0
for (const f of feats) {
  const p = f.properties || {}
  const name = String(p[nameKey] || '').trim()
  if (!name) continue
  const kenpei = kenpeiKey ? Number(p[kenpeiKey]) || undefined : undefined
  const yoseki = yosekiKey ? Number(p[yosekiKey]) || undefined : undefined
  const g = f.geometry
  if (!g) { badGeom++; continue }
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []
  if (!polys.length) { badGeom++; continue }
  for (const poly of polys) {
    const rings = toRings(poly)
    if (!rings.length) { badGeom++; continue }
    let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity
    for (const [lng, lat] of rings[0]) {
      minLng = Math.min(minLng, lng); maxLng = Math.max(maxLng, lng)
      minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat)
    }
    const feat = {
      layer: 'youto',
      name,
      bbox: [round(minLng), round(minLat), round(maxLng), round(maxLat)],
      rings,
    }
    if (kenpei) feat.kenpei = kenpei
    if (yoseki) feat.yoseki = yoseki
    out.push(feat)
  }
}

// 最終検証: 用途地域名らしい名称が9割以上
const nameOk = out.filter((f) => YOUTO_RE.test(f.name)).length
if (out.length < 20 || nameOk / out.length < 0.9) {
  console.error(`検証失敗: 総数=${out.length} 用途地域名らしきもの=${nameOk}`)
  console.error('名称サンプル:', Array.from(new Set(out.map((f) => f.name))).slice(0, 20).join(' / '))
  process.exit(1)
}

// 茨城県の範囲チェック（経度139.6〜140.9 / 緯度35.7〜37.0 におおむね収まること）
const inPref = out.filter((f) => f.bbox[0] > 139.0 && f.bbox[2] < 141.5 && f.bbox[1] > 35.0 && f.bbox[3] < 37.5).length
if (inPref / out.length < 0.95) {
  console.error(`座標範囲の検証失敗（緯度経度が想定外。座標系がJGD経緯度でない可能性）: 範囲内 ${inPref}/${out.length}`)
  console.error('bboxサンプル:', JSON.stringify(out.slice(0, 3).map((f) => f.bbox)))
  process.exit(1)
}

const data = {
  source: '国土数値情報 用途地域データ（国土交通省）を加工して作成',
  year: '2019年度（令和元年度）版',
  prefName: '茨城県',
  features: out,
}
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify(data))
const sizeMb = (JSON.stringify(data).length / 1024 / 1024).toFixed(1)
const names = new Map()
for (const f of out) names.set(f.name, (names.get(f.name) || 0) + 1)
console.log(`書き出し: ${OUT}（ポリゴン${out.length}件・${sizeMb}MB・ジオメトリ不正${badGeom}件）`)
console.log('用途地域の内訳:', Array.from(names.entries()).map(([n, c]) => `${n}:${c}`).join(' '))
