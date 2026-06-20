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
    try { await pushNow(GLOBAL_CLIENT_ID, 'clients', JSON.parse(clientsRaw)); n++ } catch { /* skip */ }
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
  // 顧問先一覧そのものも反映
  if (clientsRaw) { try { await pushNow(GLOBAL_CLIENT_ID, 'clients', clients) } catch { /* ignore */ } }
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

  if (clientId === GLOBAL_CLIENT_ID && key === 'clients') {
    if (value == null) return false
    const cur = localStorage.getItem(CLIENTS_LIST_STORAGE_KEY)
    if (cur === incoming) return false
    localStorage.setItem(CLIENTS_LIST_STORAGE_KEY, incoming)
    return true
  }

  const keyFn = STORAGE_KEY_MAP[key]
  if (!keyFn) return false
  const storageKey = keyFn(clientId)
  if (value == null) return false
  const cur = localStorage.getItem(storageKey)
  if (cur === incoming) return false
  localStorage.setItem(storageKey, incoming)
  return true
}

/**
 * 顧問先一覧（グローバル）をリアルタイム購読する。
 * 顧問先未選択（顧問先選択画面）でも動くよう、データ購読とは独立。
 */
export async function startClientsSync(onChange: () => void): Promise<void> {
  stopClientsSync()
  if (!hasRoom()) return
  try {
    const { ref, onValue } = await import('firebase/database')
    const db = await getDb()
    emit({ connected: true, error: null })
    const rk = await roomKey()
    const clientsRef = ref(db, `rooms/${rk}/${APP_SUBTREE}/${GLOBAL_CLIENT_ID}/clients`)
    clientsUnsub = onValue(
      clientsRef,
      (snap) => {
        if (applyRemoteToLocal(GLOBAL_CLIENT_ID, 'clients', snap.val())) {
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
