import { getDb } from '@/core/firebase'
import { modulePath, hasRoom } from '@/core/room'
import { loadSharedClients } from '@/lib/nenmatsu/store'
import type { ClientKeieiData, FiscalYearData } from './types'

export type { SharedClient } from '@/lib/nenmatsu/store'
export { loadSharedClients }

const MODULE_KEY = 'keiei'
const lsKey = (cid: string) => `keiei-years-${cid}`

async function dbfns() {
  const db = await getDb()
  const m = await import('firebase/database')
  return { db, ...m }
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

const SEL_KEY = 'keiei-selected-client'
export function getSelectedClientId(): string {
  if (typeof window === 'undefined') return ''
  return localStorage.getItem(SEL_KEY) || ''
}
export function setSelectedClientId(id: string): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(SEL_KEY, id)
}
