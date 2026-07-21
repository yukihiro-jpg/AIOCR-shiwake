// 国土地理院 API（ジオコーダ）。CORS許可・キー不要・無保証のため、
// 必ずタイムアウトを付け、失敗しても検索継続できる設計にする。

export interface GeocodeHit {
  title: string // 例: 茨城県水戸市姫子二丁目
  lng: number
  lat: number
}

const CACHE_KEY = 'rosenka-map-geocode-cache'
const CACHE_MAX = 800

function loadCache(): Record<string, [number, number]> {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (raw) return JSON.parse(raw)
  } catch { /* ignore */ }
  return {}
}
function saveCache(c: Record<string, [number, number]>): void {
  try {
    const keys = Object.keys(c)
    if (keys.length > CACHE_MAX) for (const k of keys.slice(0, keys.length - CACHE_MAX)) delete c[k]
    localStorage.setItem(CACHE_KEY, JSON.stringify(c))
  } catch { /* ignore */ }
}

/** 住所文字列を検索して候補一覧を返す（最大10件） */
export async function geocode(query: string, timeoutMs = 10000): Promise<GeocodeHit[]> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(
      `https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(query)}`,
      { signal: ctrl.signal },
    )
    if (!res.ok) throw new Error(`ジオコーダ応答 ${res.status}`)
    const json = (await res.json()) as Array<{
      geometry?: { coordinates?: [number, number] }
      properties?: { title?: string }
    }>
    const hits: GeocodeHit[] = []
    for (const f of json || []) {
      const c = f.geometry?.coordinates
      const t = f.properties?.title
      if (!c || !t) continue
      hits.push({ title: t, lng: c[0], lat: c[1] })
      if (hits.length >= 10) break
    }
    return hits
  } finally {
    clearTimeout(timer)
  }
}

export interface ReverseHit {
  muniCd: string // 市区町村コード（JIS X 0402。先頭ゼロ無しで返ることがある）
  lv01Nm: string // 町丁名（例: 姫子二丁目）
}

/** 逆ジオコーダ: 緯度経度→市区町村コード＋町丁名（地図クリック用） */
export async function reverseGeocode(lat: number, lng: number, timeoutMs = 8000): Promise<ReverseHit | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(
      `https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=${lat}&lon=${lng}`,
      { signal: ctrl.signal },
    )
    if (!res.ok) return null
    const j = (await res.json()) as { results?: { muniCd?: string | number; lv01Nm?: string } }
    const r = j?.results
    if (!r?.muniCd) return null
    return { muniCd: String(r.muniCd), lv01Nm: String(r.lv01Nm || '') }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 町丁名の座標を取得（キャッシュ付き・図郭の推定範囲の計算用） */
export async function geocodeTownCached(prefName: string, cityName: string, town: string): Promise<[number, number] | null> {
  const q = `${prefName}${cityName}${town.replace(/(\d+)$/, '$1丁目')}`
  const cache = loadCache()
  if (cache[q]) return cache[q]
  try {
    const hits = await geocode(q, 8000)
    // 市区町村名まで一致する最初の候補のみ採用（別市の同名町丁の誤採用防止）
    const hit = hits.find((h) => h.title.includes(cityName)) || null
    if (!hit) return null
    cache[q] = [hit.lng, hit.lat]
    saveCache(cache)
    return cache[q]
  } catch {
    return null
  }
}
