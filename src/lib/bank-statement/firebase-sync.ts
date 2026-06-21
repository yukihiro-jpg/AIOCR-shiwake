// Firebase Realtime Database による顧問先データのリアルタイム同期。
//
// 設計方針:
//  - 主データストアは Firebase RTDB（2人以上での即時共有）。Drive は別途アーカイブ。
//  - 認証は匿名認証。アクセス境界は「合言葉（ルーム）」。合言葉は各自が入力し
//    localStorage に保存（コードには書かない）。ルームキーは合言葉の SHA-256 ハッシュ。
//  - 既存の localStorage ベースのストアはそのまま使い、保存時に本モジュールへ push、
//    リモート変更を受信したら localStorage に書き戻して UI に再読込を促す。
//
// data path: rooms/{roomKey}/aiocr-shiwake/{clientId}/{key}
//   - 顧問先一覧（グローバル）は clientId='_global', key='clients'

import { APP_SUBTREE } from './firebase-config'
import { STORAGE_KEY_MAP } from './storage-keys'
import { getDb } from '@/core/firebase'
import { getRoomPassphrase, setRoomPassphrase, clearRoomPassphrase, hasRoom, modulePath } from '@/core/room'

// 合言葉(ルーム)管理は core/room に集約。既存の import 互換のため再エクスポートする。
export { getRoomPassphrase, setRoomPassphrase, clearRoomPassphrase, hasRoom }

const GLOBAL_CLIENT_ID = '_global'
const CLIENTS_LIST_STORAGE_KEY = 'bank-statement-clients'

// データパス（rooms/{roomKey}/aiocr-shiwake/...）。core の modulePath 経由。
async function dataPath(clientId: string, key: string): Promise<string> {
  return modulePath(APP_SUBTREE, clientId, key)
}

// ---- ステータス ----

export interface FbStatus {
  connected: boolean
  lastSyncAt: Date | null
  pushing: boolean
  error: string | null
}
let status: FbStatus = { connected: false, lastSyncAt: null, pushing: false, error: null }
const statusListeners = new Set<(s: FbStatus) => void>()
function emit(patch: Partial<FbStatus>) {
  status = { ...status, ...patch }
  statusListeners.forEach((fn) => { try { fn(status) } catch { /* ignore */ } })
}
export function getFbStatus(): FbStatus { return status }
export function subscribeFbStatus(fn: (s: FbStatus) => void): () => void {
  statusListeners.add(fn)
  fn(status)
  return () => { statusListeners.delete(fn) }
}

// ---- Push（debounce 付き） ----

const DEBOUNCE_MS = 1500
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
// 自分が直近に push した内容（受信時の自己エコー抑止用）
const lastPushedJson = new Map<string, string>()

export function schedulePushToFirebase(clientId: string, key: string, data: unknown): void {
  if (!hasRoom()) return
  const mapKey = `${clientId}:${key}`
  const prev = debounceTimers.get(mapKey)
  if (prev) clearTimeout(prev)
  const t = setTimeout(() => {
    debounceTimers.delete(mapKey)
    pushNow(clientId, key, data).catch((err) => {
      console.warn('[firebase-sync] push failed', err)
      emit({ error: err instanceof Error ? err.message : 'push error' })
    })
  }, DEBOUNCE_MS)
  debounceTimers.set(mapKey, t)
}

export async function pushNow(clientId: string, key: string, data: unknown): Promise<void> {
  if (!hasRoom()) return
  emit({ pushing: true })
  try {
    const { ref, set } = await import('firebase/database')
    const db = await getDb()
    const path = await dataPath(clientId, key)
    lastPushedJson.set(`${clientId}:${key}`, JSON.stringify(data ?? null))
    await set(ref(db, path), data ?? null)
    emit({ pushing: debounceTimers.size > 0, connected: true, lastSyncAt: new Date(), error: null })
  } catch (err) {
    emit({ pushing: debounceTimers.size > 0 })
    throw err
  }
}

// 顧問先1件分の全データ + 顧問先一覧を Firebase へ反映（手動保存・初期移行用）
export async function pushAllToFirebase(clientId: string): Promise<number> {
  if (!hasRoom()) return 0
  let n = 0
  for (const key of Object.keys(STORAGE_KEY_MAP)) {
    const raw = localStorage.getItem(STORAGE_KEY_MAP[key](clientId))
    if (raw == null) continue
    try { await pushNow(clientId, key, JSON.parse(raw)); n++ } catch { /* skip */ }
  }
  const clientsRaw = localStorage.getItem(CLIENTS_LIST_STORAGE_KEY)
  if (clientsRaw) {
    try { await pushClientsToFirebase(JSON.parse(clientsRaw)); n++ } catch { /* skip */ }
  }
  return n
}

// 全顧問先を Firebase へ移行
export async function pushEverythingToFirebase(
  onProgress?: (current: number, total: number, name: string) => void,
): Promise<{ uploaded: number; total: number }> {
  if (!hasRoom()) return { uploaded: 0, total: 0 }
  const clientsRaw = localStorage.getItem(CLIENTS_LIST_STORAGE_KEY)
  let clients: Array<{ id: string; name: string }> = []
  if (clientsRaw) { try { clients = JSON.parse(clientsRaw) } catch { /* ignore */ } }
  let uploaded = 0
  for (let i = 0; i < clients.length; i++) {
    const c = clients[i]
    if (!c.id) continue
    onProgress?.(i + 1, clients.length, c.name || c.id)
    try { await pushAllToFirebase(c.id); uploaded++ } catch { /* skip */ }
  }
  // 顧問先一覧そのものも反映（id マージ）
  if (clients.length) { try { await pushClientsToFirebase(clients) } catch { /* ignore */ } }
  return { uploaded, total: clients.length }
}

// ---- 受信（リアルタイム購読） ----

let dataUnsubs: Array<() => void> = []
let clientsUnsub: (() => void) | null = null

function applyRemoteToLocal(clientId: string, key: string, value: unknown): boolean {
  const mapKey = `${clientId}:${key}`
  const incoming = JSON.stringify(value ?? null)
  // 自分が直近 push した内容と同一ならスキップ（自己エコー）
  if (lastPushedJson.get(mapKey) === incoming) return false

  const keyFn = STORAGE_KEY_MAP[key]
  if (!keyFn) return false
  const storageKey = keyFn(clientId)
  if (value == null) return false
  const cur = localStorage.getItem(storageKey)
  if (cur === incoming) return false
  localStorage.setItem(storageKey, incoming)
  return true
}

// 顧問先一覧は「id をキーにしたマップ」で持つ（重要・データ保全）。
//   rooms/{rk}/aiocr-shiwake/_global/clients_v2/{clientId} = { id, name, ... }
// 配列を丸ごと set すると「少ない一覧が多い一覧を上書きして消す」事故が起きるため、
// 各端末は自分の顧問先だけを update() で書き、受信時は id で union マージする。
// → どの端末で開いても他端末の顧問先が消えることはない。
const CLIENTS_MAP_NODE = 'clients_v2'
// 削除した顧問先の「墓標」。{ id: 削除時刻 }。全端末がこれを尊重し復活させない。
const CLIENTS_DELETED_NODE = 'clients_deleted'

type ClientLike = { id: string; name?: string }

function readLocalClients(): ClientLike[] {
  try {
    const v = JSON.parse(localStorage.getItem(CLIENTS_LIST_STORAGE_KEY) || '[]')
    return Array.isArray(v) ? v : []
  } catch { return [] }
}

async function globalPath(): Promise<string> {
  return modulePath(APP_SUBTREE, GLOBAL_CLIENT_ID)
}

async function clientsMapPath(): Promise<string> {
  return modulePath(APP_SUBTREE, GLOBAL_CLIENT_ID, CLIENTS_MAP_NODE)
}

// 手元の顧問先を Firebase へ寄与（update なので他端末の顧問先は消えない）
export async function pushClientsToFirebase(clients: ClientLike[]): Promise<void> {
  if (!hasRoom()) return
  const valid = clients.filter((c) => c && c.id)
  if (valid.length === 0) return
  const { ref, update } = await import('firebase/database')
  const db = await getDb()
  const map: Record<string, unknown> = {}
  for (const c of valid) map[c.id] = c
  await update(ref(db, await clientsMapPath()), map)
}

let clientsPushTimer: ReturnType<typeof setTimeout> | null = null
export function scheduleClientsPush(clients: ClientLike[]): void {
  if (!hasRoom()) return
  if (clientsPushTimer) clearTimeout(clientsPushTimer)
  clientsPushTimer = setTimeout(() => {
    clientsPushTimer = null
    pushClientsToFirebase(clients).catch((err) => console.warn('[firebase-sync] clients push failed', err))
  }, DEBOUNCE_MS)
}

// 顧問先削除を Firebase へ反映: 該当 id を消し、「墓標」を立てて復活を防ぐ
export async function removeClientFromFirebase(id: string): Promise<void> {
  if (!hasRoom() || !id) return
  const { ref, update } = await import('firebase/database')
  const db = await getDb()
  // 墓標を立てる（他端末がローカルに残していても、これを見て削除・再寄与しない）
  await update(ref(db, `${await globalPath()}/${CLIENTS_DELETED_NODE}`), { [id]: Date.now() })
  // 実体も削除
  await update(ref(db, `${await clientsMapPath()}`), { [id]: null })
}

/**
 * 顧問先一覧（グローバル）をリアルタイム購読する。
 * 顧問先未選択（顧問先選択画面）でも動くよう、データ購読とは独立。
 * 受信時は id で union マージし、手元にしか無い顧問先は Firebase へ寄与する。
 */
export async function startClientsSync(onChange: () => void): Promise<void> {
  stopClientsSync()
  if (!hasRoom()) return
  try {
    const { ref, onValue } = await import('firebase/database')
    const db = await getDb()
    emit({ connected: true, error: null })
    // _global 配下（顧問先マップ + 墓標）を購読
    const node = ref(db, await globalPath())

    clientsUnsub = onValue(
      node,
      (snap) => {
        const root = (snap.val() as Record<string, unknown> | null) || {}
        const mapObj = (root[CLIENTS_MAP_NODE] as Record<string, ClientLike> | undefined) || {}
        const tombstones = (root[CLIENTS_DELETED_NODE] as Record<string, number> | undefined) || {}
        const isDeleted = (id: string) => Object.prototype.hasOwnProperty.call(tombstones, id)

        // 墓標に載っている顧問先は除外（リモート・手元の両方から）
        const incoming = Object.values(mapObj).filter((c) => c && c.id && !isDeleted(c.id))
        const local = readLocalClients().filter((c) => c && c.id && !isDeleted(c.id))

        // id で union マージ（リモート優先で上書き、手元の項目は残す）
        const byId = new Map<string, ClientLike>()
        for (const c of local) if (c && c.id) byId.set(c.id, c)
        for (const c of incoming) if (c && c.id) byId.set(c.id, { ...byId.get(c.id), ...c })
        const merged = Array.from(byId.values())

        // Firebase にまだ無い手元の顧問先を寄与（墓標分は除外済み・union 収束）
        const incomingIds = new Set(incoming.map((c) => c.id))
        const localOnly = local.filter((c) => c && c.id && !incomingIds.has(c.id))
        if (localOnly.length) pushClientsToFirebase(localOnly).catch(() => { /* ignore */ })

        // 墓標により手元から消える分も含め、localStorage を merged に更新
        const mergedJson = JSON.stringify(merged)
        if (mergedJson !== JSON.stringify(readLocalClients())) {
          localStorage.setItem(CLIENTS_LIST_STORAGE_KEY, mergedJson)
          emit({ lastSyncAt: new Date() })
          onChange()
        }
      },
      (err: Error) => { emit({ connected: false, error: err.message }) },
    )
  } catch (err) {
    emit({ connected: false, error: err instanceof Error ? err.message : 'sync error' })
  }
}

export function stopClientsSync(): void {
  if (clientsUnsub) { try { clientsUnsub() } catch { /* ignore */ } clientsUnsub = null }
}

/**
 * 選択中顧問先のデータ（{clientId} 配下）をリアルタイム購読する。
 * リモート変更を localStorage に反映し、変更があったキー配列で callback を呼ぶ。
 */
export async function startFirebaseSync(
  clientId: string,
  onChange: (changedKeys: string[]) => void,
): Promise<void> {
  stopFirebaseSync()
  if (!hasRoom()) return
  try {
    const { ref, onValue } = await import('firebase/database')
    const db = await getDb()
    emit({ connected: true, error: null })

    const clientRef = ref(db, await modulePath(APP_SUBTREE, clientId))
    const unsub = onValue(
      clientRef,
      (snap) => {
        const val = snap.val() as Record<string, unknown> | null
        if (!val) return
        const changed: string[] = []
        for (const key of Object.keys(val)) {
          if (applyRemoteToLocal(clientId, key, val[key])) changed.push(key)
        }
        if (changed.length > 0) {
          emit({ lastSyncAt: new Date() })
          onChange(changed)
        }
      },
      (err: Error) => { emit({ connected: false, error: err.message }) },
    )
    dataUnsubs = [unsub]
  } catch (err) {
    emit({ connected: false, error: err instanceof Error ? err.message : 'sync error' })
  }
}

export function stopFirebaseSync(): void {
  dataUnsubs.forEach((u) => { try { u() } catch { /* ignore */ } })
  dataUnsubs = []
}

/** 接続テスト（合言葉入力直後の検証用）。匿名サインインが通れば true。 */
export async function testFirebaseConnection(): Promise<boolean> {
  try { await getDb(); emit({ connected: true, error: null }); return true }
  catch (err) { emit({ connected: false, error: err instanceof Error ? err.message : 'error' }); return false }
}
