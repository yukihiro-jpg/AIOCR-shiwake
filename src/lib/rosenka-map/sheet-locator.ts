// 検索地点（ピン）に最も近い路線価図を自動選択するためのロジック。
//
// 仕組み:
//  1. 索引の sheetGrid（隣接リンクから復元した図面の格子座標。列=東+1/行=北+1）は
//     ビルド時に確定している（矛盾0を実測済み）。
//  2. 格子→実座標（経度・緯度）はアフィン変換 lng = a + b*列, lat = c + d*行 で表せる
//     （路線価図は北を上にした等間隔の図割りのため）。
//  3. この a,b,c,d を「町丁の代表座標（ジオコーダ・キャッシュ付き）」数点から最小二乗で推定する。
//     町丁の代表点は、その町丁が載る図面群の中心付近に来るので、
//     アンカー1点 = （その町丁の図面群の平均格子座標, ジオコーダの座標）の対応になる。
//  4. 推定した変換で候補図それぞれの中心を計算し、ピンに近い順に並べる。
//
// 変換は成分（≒市）ごとに localStorage へキャッシュするので、ジオコーダ呼び出しは
// 市ごとに最初の1回だけ（それも既存の geocodeTownCached のキャッシュに乗る）。

import type { RosenkaIndex } from './types'

export interface SheetFit {
  a: number // lng = a + b*col
  b: number
  c: number // lat = c + d*row
  d: number
  n: number // 使用したアンカー数
}

const FIT_CACHE_KEY = 'rosenka-sheet-fit-cache'
const FIT_MIN_ANCHORS = 4

function fitCacheId(idx: RosenkaIndex, comp: number): string {
  return `${idx.year}-${idx.prefSlug}-${comp}`
}

function loadFitCache(): Record<string, SheetFit> {
  try {
    const raw = localStorage.getItem(FIT_CACHE_KEY)
    if (raw) return JSON.parse(raw)
  } catch { /* ignore */ }
  return {}
}

export function getCachedFit(idx: RosenkaIndex, comp: number): SheetFit | null {
  return loadFitCache()[fitCacheId(idx, comp)] || null
}

function saveFit(idx: RosenkaIndex, comp: number, fit: SheetFit): void {
  try {
    const c = loadFitCache()
    c[fitCacheId(idx, comp)] = fit
    localStorage.setItem(FIT_CACHE_KEY, JSON.stringify(c))
  } catch { /* ignore */ }
}

interface Anchor {
  col: number
  row: number
  lng: number
  lat: number
}

/** 1軸の単回帰 y = p + q*x（最小二乗）。x の広がりが無ければ null */
function linreg(xs: number[], ys: number[]): { p: number; q: number } | null {
  const n = xs.length
  if (n < 2) return null
  const mx = xs.reduce((s, v) => s + v, 0) / n
  const my = ys.reduce((s, v) => s + v, 0) / n
  let sxx = 0
  let sxy = 0
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) * (xs[i] - mx)
    sxy += (xs[i] - mx) * (ys[i] - my)
  }
  if (sxx < 0.5) return null // 全アンカーがほぼ同じ列（行）では傾きを決められない
  const q = sxy / sxx
  return { p: my - q * mx, q }
}

/** アンカー群からアフィン変換を推定。外れ値（残差が中央値の3倍超）を1回だけ除いて再推定する */
export function fitGridToWorld(anchors: Anchor[]): SheetFit | null {
  const doFit = (as: Anchor[]): SheetFit | null => {
    if (as.length < FIT_MIN_ANCHORS) return null
    const fx = linreg(as.map((x) => x.col), as.map((x) => x.lng))
    const fy = linreg(as.map((x) => x.row), as.map((x) => x.lat))
    if (!fx || !fy) return null
    // 妥当性: 東=経度増・北=緯度増、1図の幅は 100m〜3km 相当（度換算の目安）
    if (fx.q < 0.0008 || fx.q > 0.04) return null
    if (fy.q < 0.0006 || fy.q > 0.03) return null
    return { a: fx.p, b: fx.q, c: fy.p, d: fy.q, n: as.length }
  }
  const first = doFit(anchors)
  if (!first) return null
  // 外れ値除去（ジオコーダが別の場所を返した町丁を1回だけ落とす）
  const res = anchors.map((x) => {
    const dLng = (first.a + first.b * x.col - x.lng) / first.b
    const dLat = (first.c + first.d * x.row - x.lat) / first.d
    return Math.hypot(dLng, dLat) // 格子セル単位の残差
  })
  const sorted = [...res].sort((x, y) => x - y)
  const med = sorted[Math.floor(sorted.length / 2)] || 0
  const keep = anchors.filter((_, i) => res[i] <= Math.max(med * 3, 1.5))
  if (keep.length >= FIT_MIN_ANCHORS && keep.length < anchors.length) {
    return doFit(keep) || first
  }
  return first
}

export function sheetCenter(fit: SheetFit, col: number, row: number): [number, number] {
  return [fit.a + fit.b * col, fit.c + fit.d * row]
}

/** 候補図をピンに近い順に並べ替える（格子座標の無い図は元の順のまま末尾）。 */
export function orderSheetsByPin(
  idx: RosenkaIndex,
  sheets: string[],
  pin: { lng: number; lat: number },
  fit: SheetFit,
): string[] {
  const grid = idx.sheetGrid || {}
  const withPos: { s: string; d: number }[] = []
  const without: string[] = []
  for (const s of sheets) {
    const g = grid[s]
    if (!g) { without.push(s); continue }
    const [lng, lat] = sheetCenter(fit, g[0], g[1])
    // 経度は緯度に比べ実距離が縮む（cos緯度）が、同一市内の比較では比率が一定のため簡易換算で足りる
    const d = Math.hypot((lng - pin.lng) * 0.81, lat - pin.lat)
    withPos.push({ s, d })
  }
  withPos.sort((x, y) => x.d - y.d)
  return [...withPos.map((x) => x.s), ...without]
}

/** アンカーに使う町丁を選ぶ（純関数）。
 *  図面数が少ない町丁ほど「代表点＝図面中心」の対応が正確なので優先し、
 *  格子上で互いに離れた町丁を貪欲に選んで、傾き（1図あたりの度数）が安定するようにする。 */
export function pickAnchorTowns(
  idx: RosenkaIndex,
  comp: number,
  limit = 10,
): { cityName: string; town: string; col: number; row: number }[] {
  const grid = idx.sheetGrid || {}
  const cands: { cityName: string; town: string; col: number; row: number; nSheets: number }[] = []
  for (const city of idx.cities) {
    for (const [town, sheets] of Object.entries(city.towns)) {
      const gs = sheets.map((s) => grid[s]).filter((g) => g && g[2] === comp)
      if (!gs.length || gs.length !== sheets.length) continue // 成分をまたぐ町丁はアンカーにしない
      if (gs.length > 4) continue // 広すぎる町丁は代表点の対応が緩いので除外
      const col = gs.reduce((s, g) => s + g![0], 0) / gs.length
      const row = gs.reduce((s, g) => s + g![1], 0) / gs.length
      cands.push({ cityName: city.name, town, col, row, nSheets: gs.length })
    }
  }
  cands.sort((a, b) => a.nSheets - b.nSheets)
  // 貪欲に「既に選んだものから最も遠い」候補を追加（列・行の広がりを確保）
  const picked: typeof cands = []
  while (picked.length < limit && cands.length) {
    let bestI = 0
    let bestD = -1
    for (let i = 0; i < cands.length; i++) {
      const c = cands[i]
      let dmin = Infinity
      for (const p of picked) dmin = Math.min(dmin, Math.hypot(c.col - p.col, c.row - p.row))
      const d = picked.length ? dmin : 0
      if (d > bestD) { bestD = d; bestI = i }
    }
    picked.push(cands.splice(bestI, 1)[0])
  }
  return picked
}

/** 変換を用意する（キャッシュ→無ければアンカーをジオコーディングして推定）。
 *  geocodeTown は gsi.geocodeTownCached を注入（テスト時は疑似座標に差し替え可能）。 */
export async function ensureFit(
  idx: RosenkaIndex,
  comp: number,
  geocodeTown: (prefName: string, cityName: string, town: string) => Promise<[number, number] | null>,
): Promise<SheetFit | null> {
  const cached = getCachedFit(idx, comp)
  if (cached && cached.n >= FIT_MIN_ANCHORS) return cached
  const towns = pickAnchorTowns(idx, comp)
  const anchors: Anchor[] = []
  for (const t of towns) {
    const p = await geocodeTown(idx.prefName, t.cityName, t.town)
    if (p) anchors.push({ col: t.col, row: t.row, lng: p[0], lat: p[1] })
  }
  const fit = fitGridToWorld(anchors)
  if (fit) saveFit(idx, comp, fit)
  return fit
}

/** ピンに最も近い図を先頭にした並びを返す。推定できなければ null（呼び出し側は現状維持）。 */
export async function locateSheets(
  idx: RosenkaIndex,
  sheets: string[],
  pin: { lng: number; lat: number },
  geocodeTown: (prefName: string, cityName: string, town: string) => Promise<[number, number] | null>,
): Promise<string[] | null> {
  if (!idx.sheetGrid || sheets.length < 2) return null
  // 候補図の多数派の成分で推定する（町丁が成分をまたぐことはまず無い）
  const compCount = new Map<number, number>()
  for (const s of sheets) {
    const g = idx.sheetGrid[s]
    if (g) compCount.set(g[2], (compCount.get(g[2]) || 0) + 1)
  }
  if (!compCount.size) return null
  const comp = Array.from(compCount.entries()).sort((a, b) => b[1] - a[1])[0][0]
  const fit = await ensureFit(idx, comp, geocodeTown)
  if (!fit) return null
  return orderSheetsByPin(idx, sheets, pin, fit)
}
