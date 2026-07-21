// 都市計画データ（前処理済み・国土数値情報由来）の読込と地点判定。
// データは tools/rosenka/build-toshi-data.mjs が生成し public/rosenka-data/toshi/ に置く。
// 未生成でもアプリは動作する（「準備中」表示）。

import type { ToshiData, ToshiFeature } from './types'

const BASE = process.env.NEXT_PUBLIC_BASE_PATH || ''

let cached: ToshiData | null | undefined

export async function loadToshiData(prefSlug: string): Promise<ToshiData | null> {
  if (cached !== undefined) return cached
  try {
    const res = await fetch(`${BASE}/rosenka-data/toshi/${prefSlug}.json`, { cache: 'no-cache' })
    cached = res.ok ? ((await res.json()) as ToshiData) : null
  } catch {
    cached = null
  }
  return cached
}

/** ray casting（偶奇規則）。rings[0]=外環、以降は穴 */
function inRings(lng: number, lat: number, rings: [number, number][][]): boolean {
  let inside = false
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]
      const [xj, yj] = ring[j]
      if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside
    }
  }
  return inside
}

export interface ToshiHit {
  kubun: ToshiFeature | null // 区域区分（市街化区域/市街化調整区域）
  youto: ToshiFeature | null // 用途地域
}

/** 地点の都市計画区分を判定。データ未読込なら null */
export function lookupToshi(data: ToshiData, lng: number, lat: number): ToshiHit {
  let kubun: ToshiFeature | null = null
  let youto: ToshiFeature | null = null
  for (const f of data.features) {
    const [minLng, minLat, maxLng, maxLat] = f.bbox
    if (lng < minLng || lng > maxLng || lat < minLat || lat > maxLat) continue
    if (f.layer === 'kubun' && kubun) continue
    if (f.layer === 'youto' && youto) continue
    if (inRings(lng, lat, f.rings)) {
      if (f.layer === 'kubun') kubun = f
      else youto = f
      if (kubun && youto) break
    }
  }
  return { kubun, youto }
}
