// 法人住民税の均等割の「自治体プリセット」。事務所で1つ持ち、全顧問先で共有する。
//
// 【なぜ表をアプリに焼き込まないか】
// 均等割は 都道府県分 ＋ 市町村分 の2階建てで、
//   ・都道府県が上乗せしている（茨城県の森林湖沼環境税など）
//   ・市町村が超過税率を採っている
//   ・資本金等の額と従業者数で区分が変わる
// という三重の事情があり、しかも毎年どこかの自治体が変える。
// コードに税率表を持つと必ず陳腐化して、静かに間違えた金額を出し続けることになる。
// そこで **金額は税理士が登録し、アプリは引くだけ** にしてある。
// 自治体の数は顧問先の数よりずっと少ないので、一度作れば以後は選ぶだけで済む。
//
// 保存先は顧問先ごとではなく事務所単位（`keiei/_equalization`）。
// 顧問先を削除しても消さない（他の顧問先が使っているため）。

import { getDb } from '@/core/firebase'
import { modulePath, hasRoom } from '@/core/room'

const MODULE_KEY = 'keiei'
const NODE = '_equalization'
const LS_KEY = 'keiei-equalization-presets'

/** 資本金等の額の区分（地方税法の区分。金額はプリセット側に持つ） */
export const CAPITAL_BRACKETS = [
  { key: 'a', label: '1千万円以下', max: 10_000_000 },
  { key: 'b', label: '1千万円超〜1億円以下', max: 100_000_000 },
  { key: 'c', label: '1億円超〜10億円以下', max: 1_000_000_000 },
  { key: 'd', label: '10億円超〜50億円以下', max: 5_000_000_000 },
  { key: 'e', label: '50億円超', max: null },
] as const

export type CapitalKey = typeof CAPITAL_BRACKETS[number]['key']

/** 資本金等の額 → 区分。 */
export function capitalBracketOf(capital: number): CapitalKey {
  for (const b of CAPITAL_BRACKETS) {
    if (b.max === null || capital <= b.max) return b.key
  }
  return 'e'
}

export function capitalLabel(key: CapitalKey): string {
  return CAPITAL_BRACKETS.find((b) => b.key === key)?.label ?? ''
}

/** 1つの区分の金額（年額・円） */
export interface EqRate {
  /** 資本金等の区分 */
  capital: CapitalKey
  /** 従業者数が50人超か（市町村分はここで変わる） */
  staffOver50: boolean
  /** 都道府県分 */
  pref: number
  /** 市町村分 */
  city: number
}

/** 自治体ごとのプリセット */
export interface EqPreset {
  id: string
  /** 都道府県名（例: 茨城県） */
  pref: string
  /** 市町村名（例: 水戸市） */
  city: string
  /** 区分ごとの金額。必要な区分だけ登録すればよい */
  rates: EqRate[]
  /** 根拠・注記（条例の名前や確認した日付など。先生のメモ用） */
  note?: string
  updatedAt?: number
}

export const eqPresetLabel = (p: EqPreset): string => `${p.pref}${p.city}`

/** 区分に当てはまる金額を引く。無ければ null（＝手入力してもらう）。 */
export function findRate(
  p: EqPreset | null | undefined, capital: CapitalKey, staffOver50: boolean,
): EqRate | null {
  if (!p) return null
  return p.rates.find((r) => r.capital === capital && r.staffOver50 === staffOver50)
    // 従業者数の区分を登録していないプリセットは、50人以下の行で代用する
    ?? p.rates.find((r) => r.capital === capital && !r.staffOver50)
    ?? null
}

/**
 * src の **都道府県分だけ** を base へ重ねる（市町村分はそのまま残す）。
 *
 * 同じ県に顧問先が何社もあるとき、市町村ごとに県分を入れ直させるのは手間なだけでなく、
 * 打ち間違いで同じ県なのに金額が違うプリセットができてしまう。
 */
export function withPrefRatesFrom(base: EqRate[], src: EqRate[]): EqRate[] {
  const out = base.map((r) => ({ ...r }))
  for (const s of src) {
    if (!s.pref) continue
    const hit = out.find((r) => r.capital === s.capital && r.staffOver50 === s.staffOver50)
    if (hit) hit.pref = s.pref
    else out.push({ capital: s.capital, staffOver50: s.staffOver50, pref: s.pref, city: 0 })
  }
  const ord = 'abcde'
  out.sort((x, y) =>
    ord.indexOf(x.capital) - ord.indexOf(y.capital)
    || Number(x.staffOver50) - Number(y.staffOver50))
  return out
}

/** 同じ都道府県で、都道府県分の金額が入っているプリセットを探す。 */
export function findPrefSource(
  list: EqPreset[], prefName: string, exceptId: string,
): EqPreset | null {
  const key = (prefName || '').trim()
  if (!key) return null
  return list.find(
    (p) => p.id !== exceptId && p.pref.trim() === key && p.rates.some((r) => r.pref > 0),
  ) ?? null
}

function readLocal(): EqPreset[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(LS_KEY)
    return raw ? (JSON.parse(raw) as EqPreset[]) : []
  } catch {
    return []
  }
}

function writeLocal(list: EqPreset[]): void {
  if (typeof window === 'undefined') return
  try { localStorage.setItem(LS_KEY, JSON.stringify(list)) } catch { /* 容量超過などは無視 */ }
}

async function dbfns() {
  const db = await getDb()
  const m = await import('firebase/database')
  return { db, ...m }
}

/**
 * 読み込み。合言葉が設定されていればリモートを優先し、端末にも控えを置く
 * （オフラインや合言葉未設定でも直前の内容で動くようにするため）。
 */
export async function loadEqPresets(): Promise<EqPreset[]> {
  if (!hasRoom()) return readLocal()
  try {
    const { db, ref, get } = await dbfns()
    const snap = await get(ref(db, await modulePath(MODULE_KEY, NODE)))
    const val = snap.val()
    if (!val) return readLocal()
    const list = (Array.isArray(val) ? val : Object.values(val)) as EqPreset[]
    const clean = list.filter((p) => p && p.id).map((p) => ({ ...p, rates: p.rates || [] }))
    writeLocal(clean)
    return clean
  } catch {
    return readLocal()
  }
}

export async function saveEqPresets(list: EqPreset[]): Promise<void> {
  writeLocal(list)
  if (!hasRoom()) return
  const { db, ref, set } = await dbfns()
  await set(ref(db, await modulePath(MODULE_KEY, NODE)), list)
}

export function newEqPresetId(): string {
  return `eq-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}
