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

import { firebaseConfig, APP_SUBTREE } from './firebase-config'
import { STORAGE_KEY_MAP } from './drive-sync'

const ROOM_STORAGE_KEY = 'bs-fb-room' // 合言葉（生）。この端末のみ保存。
const GLOBAL_CLIENT_ID = '_global'
const CLIENTS_LIST_STORAGE_KEY = 'bank-statement-clients'

// ---- ルーム（合言葉）管理 ----

export function getRoomPassphrase(): string | null {
  if (typeof window === 'undefined') return null
  const v = localStorage.getItem(ROOM_STORAGE_KEY)
  return v && v.trim() ? v : null
}

export function setRoomPassphrase(passphrase: string): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(ROOM_STORAGE_KEY, passphrase.trim())
  cachedRoomKey = null // 再計算させる
}

export function clearRoomPassphrase(): void {
  if (typeof window === 'undefined') return
  localStorage.removeItem(ROOM_STORAGE_KEY)
  cachedRoomKey = null
}

export function hasRoom(): boolean {
  return getRoomPassphrase() != null
}

let cachedRoomKey: string | null = null

// 合言葉 → SHA-256 16進。RTDB のパスに使える安全な文字列（推測不可）。
async function roomKey(): Promise<string> {
  if (cachedRoomKey) return cachedRoomKey
  const pass = getRoomPassphrase()
  if (!pass) throw new Error('NO_ROOM')
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pass))
  cachedRoomKey = Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return cachedRoomKey
}

// ---- Firebase 初期化（クライアントのみ・遅延ロード） ----

type DbType = import('firebase/database').Database
let appPromise: Promise<DbType> | null = null

async function getDb(): Promise<DbType> {
  if (typeof window === 'undefined') throw new Error('NO_WINDOW')
  if (appPromise) return appPromise
  appPromise = (async () => {
    const { initializeApp, getApps } = await import('firebase/app')
    const { getAuth, signInAnonymously } = await import('firebase/auth')
    const { getDatabase } = await import('firebase/database')
    const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig)
    const auth = getAuth(app)
    if (!auth.currentUser) {
      await signInAnonymously(auth)
    }
    return getDatabase(app)
  })()
  return appPromise
}

async function dataPath(clientId: string, key: string): Promise<string> {
  const rk = await roomKey()
  return `rooms/${rk}/${APP_SUBTREE}/${clientId}/${key}`
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

type ClientLike = { id: string; name?: string }

function readLocalClients(): ClientLike[] {
  try {
    const v = JSON.parse(localStorage.getItem(CLIENTS_LIST_STORAGE_KEY) || '[]')
    return Array.isArray(v) ? v : []
  } catch { return [] }
}

async function clientsMapPath(): Promise<string> {
  const rk = await roomKey()
  return `rooms/${rk}/${APP_SUBTREE}/${GLOBAL_CLIENT_ID}/${CLIENTS_MAP_NODE}`
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

// 顧問先削除を明示的に Firebase へ反映（該当 id の子のみ削除）
export async function removeClientFromFirebase(id: string): Promise<void> {
  if (!hasRoom() || !id) return
  const { ref, set } = await import('firebase/database')
  const db = await getDb()
  await set(ref(db, `${await clientsMapPath()}/${id}`), null)
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
    const node = ref(db, await clientsMapPath())

    // 接続時: 手元の顧問先を寄与（他端末の分は消えない）
    const localInit = readLocalClients()
    if (localInit.length) pushClientsToFirebase(localInit).catch(() => { /* ignore */ })

    clientsUnsub = onValue(
      node,
      (snap) => {
        const val = (snap.val() as Record<string, ClientLike> | null) || {}
        const incoming = Object.values(val).filter((c) => c && c.id)
        const local = readLocalClients()

        // id で union マージ（リモートの項目を優先して上書き、手元の項目は残す）
        const byId = new Map<string, ClientLike>()
        for (const c of local) if (c && c.id) byId.set(c.id, c)
        for (const c of incoming) if (c && c.id) byId.set(c.id, { ...byId.get(c.id), ...c })
        const merged = Array.from(byId.values())

        // Firebase にまだ無い手元の顧問先があれば寄与（union 収束）
        const incomingIds = new Set(incoming.map((c) => c.id))
        const localOnly = local.filter((c) => c && c.id && !incomingIds.has(c.id))
        if (localOnly.length) pushClientsToFirebase(localOnly).catch(() => { /* ignore */ })

        const mergedJson = JSON.stringify(merged)
        if (mergedJson !== JSON.stringify(local)) {
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

    const rk = await roomKey()
    const clientRef = ref(db, `rooms/${rk}/${APP_SUBTREE}/${clientId}`)
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
