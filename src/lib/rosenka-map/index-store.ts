// 路線価索引（静的JSON）の読込と、住所文字列→町丁の照合。
// 照合は「間違ったものを黙って出さない」方針: 完全一致のみ自動確定し、
// 曖昧な場合は候補一覧を返してユーザーに選ばせる。

import type { RosenkaIndex, RosenkaManifest, RosenkaCity, TownMatch } from './types'

const BASE = process.env.NEXT_PUBLIC_BASE_PATH || ''

async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${BASE}${path}`, { cache: 'no-cache' })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

export async function loadManifest(): Promise<RosenkaManifest | null> {
  return fetchJson<RosenkaManifest>('/rosenka-data/index/manifest.json')
}

const indexCache = new Map<string, RosenkaIndex | null>()

export async function loadIndex(year: string, prefSlug: string): Promise<RosenkaIndex | null> {
  const key = `${year}-${prefSlug}`
  if (indexCache.has(key)) return indexCache.get(key) || null
  const idx = await fetchJson<RosenkaIndex>(`/rosenka-data/index/${year}-${prefSlug}.json`)
  // 失敗(null)はキャッシュしない（一時的な通信断のあと年分を切り替え直せば再試行できるように）
  if (idx) indexCache.set(key, idx)
  return idx
}

// ---------- 住所の正規化と照合 ----------

const KANJI_NUM: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }

// 「ヶ/ヵ」と「ケ」の字体差を吸収する（索引は松ケ丘・紫峰ヶ丘のように混在し、
// ジオコーダの表記が逆の字体だと照合0件になるため）。1文字→1文字の置換なので文字位置は変わらない
const foldKana = (s: string) => s.replace(/[ヶヵ]/g, 'ケ')

/** 「二丁目」→「2」、全角数字→半角、「1丁目」→「1」等に正規化 */
export function normalizeTown(s: string): string {
  let t = foldKana(s.trim())
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[ 　]/g, '')
  // 漢数字の丁目（十九丁目まで対応）。いったん「N丁目」に揃える
  t = t.replace(/([一二三四五六七八九]|十[一二三四五六七八九]?)丁目/g, (m, n: string) => {
    if (n.startsWith('十')) return `${10 + (KANJI_NUM[n[1]] || 0)}丁目`
    return `${KANJI_NUM[n] || 0}丁目`
  })
  // 「N丁目」より後ろは番地・号（例: 2丁目1863番地 → 2）。
  // ここで落とさず数字を連結すると「姫子21863」になり丁目と番地の境界が消える
  t = t.replace(/(\d+)丁目.*$/, '$1')
  t = t.replace(/(\d+)丁目/g, '$1')
  // 丁目以下の番地・号は落とす（例: 姫子2-1863 → 姫子2）
  t = t.replace(/(\d+)[-‐‑‒–—―−ー－].*$/, '$1')
  t = t.replace(/^大字/, '')
  return t
}

/** 住所文字列から市区町村と町丁を照合する */
export function matchAddress(idx: RosenkaIndex, address: string): {
  city: RosenkaCity | null
  matches: TownMatch[] // exact が先頭。空なら照合失敗
  rest: string // 市区町村名より後の文字列（表示用）
} {
  const addr = address.replace(/[ 　]/g, '')
  const addrF = foldKana(addr) // ヶ/ケ字体差を吸収して比較（foldは1:1置換のため文字位置はaddrと一致）
  // 市区町村: 名前が長い順に含有一致（「水戸市」より「ひたちなか市」を先に試す等）
  const cities = [...idx.cities].sort((a, b) => b.name.length - a.name.length)
  const city = cities.find((c) => addrF.includes(foldKana(c.name))) || null
  if (!city) return { city: null, matches: [], rest: '' }
  const cityF = foldKana(city.name)
  const rest = addr.slice(addrF.indexOf(cityF) + cityF.length)
  const restNorm = normalizeTown(rest.replace(new RegExp(`^.*?${idx.prefName}`), ''))

  const matches: TownMatch[] = []
  const seen = new Set<string>()
  const push = (town: string, exact: boolean) => {
    if (seen.has(town)) return
    seen.add(town)
    matches.push({ city, town, sheets: city.towns[town] || [], exact })
  }
  const townKeys = Object.keys(city.towns)
  // 1. 完全一致
  for (const k of townKeys) if (normalizeTown(k) === restNorm) push(k, true)
  // 2. 住所側が町丁名で始まる（番地付き住所: 姫子2… → 姫子2）長い順。
  //    ただし切れ目が数字列を分断する候補（戸頭912 に対する 戸頭9 等）は
  //    番地の先頭桁を丁目と誤認している可能性が高いので、分断しない候補を優先
  if (restNorm) {
    const splitsDigit = (n: string) => /\d$/.test(n) && /^\d/.test(restNorm.slice(n.length))
    const starts = townKeys
      .map((k) => ({ k, n: normalizeTown(k) }))
      .filter(({ n }) => n && restNorm.startsWith(n))
      .sort((a, b) =>
        (splitsDigit(a.n) ? 1 : 0) - (splitsDigit(b.n) ? 1 : 0) || b.n.length - a.n.length)
    for (const { k } of starts) push(k, false)
    // 3. 丁目違いの兄弟（姫子 → 姫子1・姫子2…）
    const base = restNorm.replace(/\d+$/, '')
    if (base) {
      for (const k of townKeys) {
        const n = normalizeTown(k)
        if (n.replace(/\d+$/, '') === base) push(k, false)
      }
    }
  }
  return { city, matches, rest }
}
