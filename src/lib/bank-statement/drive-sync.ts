// Drive同期のクライアント側ヘルパー（UIから直接呼び出し可能）

export const STORAGE_KEY_MAP: Record<string, (cid: string) => string> = {
  'patterns': (cid) => `bs-patterns-${cid}`,
  'account-master': (cid) => `bs-accounts-${cid}`,
  'sub-account-master': (cid) => `bs-sub-accounts-${cid}`,
  'account-tax-master': (cid) => `bs-account-tax-${cid}`,
  'temp-entries': (cid) => `bs-temp-csv-${cid}`,
  'fixed-journals': (cid) => `bs-fixed-journals-${cid}`,
  'bank-templates': (cid) => `bs-bank-templates-${cid}`,
  'processing-status': (cid) => `bank-statement-client-${cid}-processing-status`,
  'payroll-settings': (cid) => `bs-payroll-settings-${cid}`,
}
export const STORAGE_KEYS = Object.keys(STORAGE_KEY_MAP)

/**
 * 選択中の顧問先のデータをDriveへアップロード
 */
export async function uploadClientToDrive(clientId: string, clientName: string | null): Promise<number> {
  const items: { clientId: string; clientName: string | null; key: string; data: unknown }[] = []

  for (const key of STORAGE_KEYS) {
    const storageKey = STORAGE_KEY_MAP[key](clientId)
    const raw = localStorage.getItem(storageKey)
    if (raw) {
      try { items.push({ clientId, clientName, key, data: JSON.parse(raw) }) } catch { /* skip */ }
    }
  }

  // 顧問先一覧（グローバル）も同時にアップロード
  const clientListRaw = localStorage.getItem('bank-statement-clients')
  if (clientListRaw) {
    try { items.push({ clientId: '_global', clientName: null, key: 'clients', data: JSON.parse(clientListRaw) }) } catch { /* skip */ }
  }

  // 顧問先固有アイテムが1件もない場合はマーカーを追加してフォルダだけでも生成
  const hasClientItem = items.some((i) => i.clientId === clientId)
  if (!hasClientItem) {
    items.push({ clientId, clientName, key: '_marker', data: { updated: new Date().toISOString() } })
  }

  const res = await fetch('/api/drive', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error || 'Drive upload failed')
  }
  const result = await res.json()
  return result.count || 0
}

/**
 * 選択中の顧問先のデータをDriveから読み込む
 */
export async function downloadClientFromDrive(clientId: string, clientName: string | null): Promise<number> {
  let downloaded = 0

  // 顧問先一覧も取得
  const globalRes = await fetch('/api/drive?clientId=_global&key=clients')
  if (globalRes.ok) {
    const { data } = await globalRes.json()
    if (data && Array.isArray(data)) {
      localStorage.setItem('bank-statement-clients', JSON.stringify(data))
      downloaded++
    }
  }

  const nameParam = clientName ? `&clientName=${encodeURIComponent(clientName)}` : ''
  for (const key of STORAGE_KEYS) {
    try {
      const res = await fetch(`/api/drive?clientId=${encodeURIComponent(clientId)}${nameParam}&key=${encodeURIComponent(key)}`)
      if (!res.ok) continue
      const { data } = await res.json()
      if (data != null) {
        const storageKey = STORAGE_KEY_MAP[key](clientId)
        localStorage.setItem(storageKey, JSON.stringify(data))
        downloaded++
      }
    } catch { /* skip */ }
  }
  return downloaded
}

/** Drive連携ステータスを確認 */
export async function getDriveConnected(): Promise<boolean> {
  try {
    const res = await fetch('/api/drive/status')
    if (!res.ok) return false
    const data = await res.json()
    return !!data.connected
  } catch { return false }
}

// ---- 自動同期インフラ（debounce push + polling） ----

const DEBOUNCE_MS = 3000
const POLL_MS = 30000
const META_KEY_PREFIX = 'drive-sync-meta:'  // META_KEY_PREFIX + key:clientId → 最終同期 modifiedTime

const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
const lastPushedAt = new Map<string, number>()
const syncStatusListeners = new Set<(status: SyncStatus) => void>()

export interface SyncStatus {
  connected: boolean
  lastSyncAt: Date | null
  pendingPushes: number
  pushing: boolean
  error: string | null
}

let currentStatus: SyncStatus = {
  connected: false,
  lastSyncAt: null,
  pendingPushes: 0,
  pushing: false,
  error: null,
}

function emitStatus(patch: Partial<SyncStatus>) {
  currentStatus = { ...currentStatus, ...patch }
  syncStatusListeners.forEach((fn) => {
    try { fn(currentStatus) } catch { /* ignore */ }
  })
}

export function getSyncStatus(): SyncStatus {
  return currentStatus
}

export function subscribeSyncStatus(fn: (status: SyncStatus) => void): () => void {
  syncStatusListeners.add(fn)
  fn(currentStatus)
  return () => { syncStatusListeners.delete(fn) }
}

function metaStorageKey(clientId: string, key: string): string {
  return `${META_KEY_PREFIX}${clientId}:${key}`
}

function setSyncMeta(clientId: string, key: string, modifiedTime: string | null) {
  try {
    const k = metaStorageKey(clientId, key)
    if (modifiedTime) localStorage.setItem(k, modifiedTime)
    else localStorage.removeItem(k)
  } catch { /* ignore */ }
}

function getSyncMeta(clientId: string, key: string): string | null {
  try { return localStorage.getItem(metaStorageKey(clientId, key)) } catch { return null }
}

/**
 * データ保存時に debounce 付きで Drive へ Push をスケジュール。
 * 同じ (clientId, key) に対する Push は最新で上書きされる。
 */
export function schedulePushToDrive(clientId: string, key: string, data: unknown): void {
  const mapKey = `${clientId}:${key}`
  const prev = debounceTimers.get(mapKey)
  if (prev) clearTimeout(prev)
  emitStatus({ pendingPushes: debounceTimers.size + 1 })
  const t = setTimeout(() => {
    debounceTimers.delete(mapKey)
    emitStatus({ pendingPushes: debounceTimers.size, pushing: true })
    pushOneToDrive(clientId, key, data)
      .then(() => {
        lastPushedAt.set(mapKey, Date.now())
        emitStatus({ pushing: debounceTimers.size > 0, lastSyncAt: new Date(), error: null })
      })
      .catch((err: Error) => {
        console.warn('[drive-sync] push failed', err)
        emitStatus({ pushing: debounceTimers.size > 0, error: err.message })
      })
  }, DEBOUNCE_MS)
  debounceTimers.set(mapKey, t)
}

async function pushOneToDrive(clientId: string, key: string, data: unknown): Promise<void> {
  const res = await fetch('/api/drive', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, key, data }),
  })
  if (!res.ok) {
    if (res.status === 401) throw new Error('Drive 未連携（ログインしてください）')
    const text = await res.text().catch(() => '')
    throw new Error(`Drive Push 失敗 (${res.status}): ${text}`)
  }
}

/**
 * Drive 上の現在のフォルダ内ファイル一覧を取得して、ローカルの最終同期メタと比較。
 * 変更があったキーのリストを返す。
 */
export async function detectRemoteChanges(clientId: string, clientName: string | null): Promise<string[]> {
  try {
    const nameParam = clientName ? `&clientName=${encodeURIComponent(clientName)}` : ''
    const res = await fetch(`/api/drive/changes?clientId=${encodeURIComponent(clientId)}${nameParam}`, { cache: 'no-store' })
    if (!res.ok) {
      if (res.status === 401) emitStatus({ connected: false })
      return []
    }
    emitStatus({ connected: true, error: null })
    const json = await res.json() as { files: Array<{ name: string; modifiedTime: string }> }
    const changed: string[] = []
    for (const f of json.files || []) {
      const key = f.name.replace(/\.json$/, '')
      const prev = getSyncMeta(clientId, key)
      if (!prev || f.modifiedTime > prev) {
        // 直近自分が Push した直後の差分はスキップ（自分の更新が反映されただけ）
        const mapKey = `${clientId}:${key}`
        const pushed = lastPushedAt.get(mapKey)
        if (pushed && Date.now() - pushed < 5000) {
          setSyncMeta(clientId, key, f.modifiedTime)
          continue
        }
        changed.push(key)
        setSyncMeta(clientId, key, f.modifiedTime)
      }
    }
    if (changed.length > 0) emitStatus({ lastSyncAt: new Date() })
    return changed
  } catch (err) {
    console.warn('[drive-sync] poll failed', err)
    return []
  }
}

let pollHandle: ReturnType<typeof setInterval> | null = null

/**
 * ポーリングを開始。callback(changedKeys) が呼ばれたら呼び出し側で再読込・マージを行う。
 */
export function startAutoSyncPolling(clientId: string, clientName: string | null, callback: (changedKeys: string[]) => void): void {
  stopAutoSyncPolling()
  // 初回 connected 判定
  getDriveConnected().then((c) => emitStatus({ connected: c }))
  const tick = async () => {
    const changed = await detectRemoteChanges(clientId, clientName)
    if (changed.length > 0) callback(changed)
  }
  tick() // 即実行
  pollHandle = setInterval(tick, POLL_MS)
}

export function stopAutoSyncPolling(): void {
  if (pollHandle) { clearInterval(pollHandle); pollHandle = null }
}
