import { getDb } from '@/core/firebase'
import { modulePath, hasRoom } from '@/core/room'
import type { ClientKeieiData, FiscalYearData } from './types'

export interface KeieiClient {
  id: string
  name: string
  code?: string
}

const MODULE_KEY = 'keiei'
const lsKey = (cid: string) => `keiei-years-${cid}`

async function dbfns() {
  const db = await getDb()
  const m = await import('firebase/database')
  return { db, ...m }
}

/** 顧問先情報で「月次レポート＝利用」にした顧問先のみを読み込む（komonが連携書き込み） */
export async function loadKeieiClients(): Promise<KeieiClient[]> {
  if (!hasRoom()) return []
  try {
    const { db, ref, get } = await dbfns()
    const snap = await get(ref(db, await modulePath(MODULE_KEY, '_clients')))
    const val = snap.val() || {}
    return Object.values(val)
      .map((c: unknown) => c as KeieiClient)
      .filter((c) => c && c.id && c.name)
      .sort((a, b) => (a.code || '').localeCompare(b.code || '', 'ja', { numeric: true }))
  } catch {
    return []
  }
}

export function loadYearsLocal(cid: string): Record<string, FiscalYearData> {
  if (typeof window === 'undefined' || !cid) return {}
  try {
    const raw = localStorage.getItem(lsKey(cid))
    if (raw) {
      const parsed = JSON.parse(raw) as ClientKeieiData
      return parsed.years || {}
    }
  } catch { /* ignore */ }
  return {}
}

export function saveYearsLocal(cid: string, years: Record<string, FiscalYearData>): void {
  if (typeof window === 'undefined' || !cid) return
  try {
    localStorage.setItem(lsKey(cid), JSON.stringify({ years }))
  } catch { /* ignore */ }
}

export async function fetchYearsRemote(cid: string): Promise<Record<string, FiscalYearData> | null> {
  if (!hasRoom() || !cid) return null
  try {
    const { db, ref, get } = await dbfns()
    const snap = await get(ref(db, await modulePath(MODULE_KEY, cid, 'years')))
    return (snap.val() as Record<string, FiscalYearData>) || {}
  } catch { return null }
}

export async function pushYearsRemote(cid: string, years: Record<string, FiscalYearData>): Promise<void> {
  if (!hasRoom() || !cid) return
  try {
    const { db, ref, set } = await dbfns()
    await set(ref(db, await modulePath(MODULE_KEY, cid, 'years')), years)
  } catch { /* ignore */ }
}

/** リモート優先で読み込み（無ければローカル）。読み込んだ内容はローカルにも反映 */
export async function loadYears(cid: string): Promise<Record<string, FiscalYearData>> {
  const remote = await fetchYearsRemote(cid)
  if (remote && Object.keys(remote).length > 0) {
    saveYearsLocal(cid, remote)
    return remote
  }
  return loadYearsLocal(cid)
}

/** ローカル＋リモートへ保存 */
export async function saveYears(cid: string, years: Record<string, FiscalYearData>): Promise<void> {
  saveYearsLocal(cid, years)
  await pushYearsRemote(cid, years)
}

// ===== 設定（変動/固定分類・有利子負債除外）の保存 =====
import type { KeieiSettings } from './analysis'
import { defaultSettings } from './analysis'
const lsSettings = (cid: string) => `keiei-settings-${cid}`

export async function loadSettings(cid: string): Promise<KeieiSettings> {
  // リモート優先
  if (hasRoom() && cid) {
    try {
      const { db, ref, get } = await dbfns()
      const snap = await get(ref(db, await modulePath(MODULE_KEY, cid, 'settings')))
      const v = snap.val() as KeieiSettings | null
      if (v) { saveSettingsLocal(cid, v); return { ...defaultSettings(), ...v } }
    } catch { /* ignore */ }
  }
  if (typeof window !== 'undefined' && cid) {
    try { const raw = localStorage.getItem(lsSettings(cid)); if (raw) return { ...defaultSettings(), ...JSON.parse(raw) } } catch { /* ignore */ }
  }
  return defaultSettings()
}

function saveSettingsLocal(cid: string, s: KeieiSettings) {
  if (typeof window === 'undefined' || !cid) return
  try { localStorage.setItem(lsSettings(cid), JSON.stringify(s)) } catch { /* ignore */ }
}

export async function saveSettings(cid: string, s: KeieiSettings): Promise<void> {
  saveSettingsLocal(cid, s)
  if (hasRoom() && cid) {
    try { const { db, ref, set } = await dbfns(); await set(ref(db, await modulePath(MODULE_KEY, cid, 'settings')), s) } catch { /* ignore */ }
  }
}

/** 設定をリアルタイム購読する。リモート変更を都度反映し、他端末の保存で
 *  手元が古いまま上書き保存（last-write-wins）してしまう巻き戻りを防ぐ。 */
export async function subscribeSettings(cid: string, cb: (s: KeieiSettings) => void): Promise<() => void> {
  if (!hasRoom() || !cid) {
    // 合言葉未設定時はローカルのみ（1回だけ返す）
    if (typeof window !== 'undefined' && cid) {
      try { const raw = localStorage.getItem(lsSettings(cid)); if (raw) cb({ ...defaultSettings(), ...JSON.parse(raw) }) } catch { /* ignore */ }
    }
    return () => { /* noop */ }
  }
  try {
    const { db, ref, onValue } = await dbfns()
    const r = ref(db, await modulePath(MODULE_KEY, cid, 'settings'))
    const unsub = onValue(r, (snap) => {
      const v = snap.val() as KeieiSettings | null
      if (v) { saveSettingsLocal(cid, v); cb({ ...defaultSettings(), ...v }) }
    })
    return () => { try { unsub() } catch { /* ignore */ } }
  } catch {
    // 購読失敗時はローカルにフォールバック
    if (typeof window !== 'undefined') {
      try { const raw = localStorage.getItem(lsSettings(cid)); if (raw) cb({ ...defaultSettings(), ...JSON.parse(raw) }) } catch { /* ignore */ }
    }
    return () => { /* noop */ }
  }
}

const SEL_KEY = 'keiei-selected-client'
export function getSelectedClientId(): string {
  if (typeof window === 'undefined') return ''
  return localStorage.getItem(SEL_KEY) || ''
}
export function setSelectedClientId(id: string): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(SEL_KEY, id)
}
