// Drive同期のクライアント側ヘルパー（UIから直接呼び出し可能）
// 静的サイト化に伴い、サーバー（/api/drive*）ではなく drive-client / google-auth を直接呼ぶ。

import { driveRead, driveWrite, driveBulkWrite, driveListChanges } from './drive-client'
import { isConnected as authIsConnected } from './google-auth'

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
  'questions': (cid) => `bs-questions-${cid}`,
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

  return await driveBulkWrite(items)
}

/**
 * 選択中の顧問先のデータをDriveから読み込む
 */
export async function downloadClientFromDrive(clientId: string, clientName: string | null): Promise<number> {
  let downloaded = 0

  // 顧問先一覧も取得
  try {
    const data = await driveRead('_global', null, 'clients')
    if (data && Array.isArray(data)) {
      localStorage.setItem('bank-statement-clients', JSON.stringify(data))
      downloaded++
    }
  } catch { /* skip */ }

  for (const key of STORAGE_KEYS) {
    try {
      const data = await driveRead(clientId, clientName, key)
      if (data != null) {
        const storageKey = STORAGE_KEY_MAP[key](clientId)
        localStorage.setItem(storageKey, JSON.stringify(data))
        downloaded++
      }
    } catch { /* skip */ }
  }
  return downloaded
}

/**
 * 旧アプリ（bat版）が共有ドライブに残した JSON ファイルを、手元でダウンロードして取り込む。
 * 各ファイルの中身は localStorage の値そのものなので、ファイル名（key）から
 * STORAGE_KEY_MAP を引いて localStorage に書き戻すだけでよい。
 *
 * - `clients.json` → グローバルの顧問先一覧（bank-statement-clients）に id でマージ
 * - `patterns.json` など顧問先固有のキー → 指定した clientId 配下に書き込み
 * - `_marker.json` など対象外のキーはスキップ
 *
 * 取り込み後はアプリ自身が作成したデータとして扱われるため、
 * その後「保存」すれば drive.file 権限でも Drive 同期できるようになる。
 */
export async function importClientFromJsonFiles(
  clientId: string | null,
  files: FileList | File[],
): Promise<{ imported: string[]; skipped: string[]; clientsMerged: number }> {
  const imported: string[] = []
  const skipped: string[] = []
  let clientsMerged = 0

  for (const file of Array.from(files)) {
    const key = file.name.replace(/\.json$/i, '')
    let parsed: unknown
    try {
      parsed = JSON.parse(await file.text())
    } catch {
      skipped.push(`${file.name}（JSONとして読めません）`)
      continue
    }

    // 顧問先一覧はグローバル。既存と id でマージ（取り込み側を優先）。
    if (key === 'clients') {
      try {
        const existingRaw = localStorage.getItem('bank-statement-clients')
        const existing: Array<{ id: string; name: string }> = existingRaw ? JSON.parse(existingRaw) : []
        const incoming: Array<{ id: string; name: string }> = Array.isArray(parsed) ? parsed : []
        const byId = new Map<string, { id: string; name: string }>()
        for (const c of existing) if (c && c.id) byId.set(c.id, c)
        for (const c of incoming) if (c && c.id) byId.set(c.id, c)
        const merged = Array.from(byId.values())
        localStorage.setItem('bank-statement-clients', JSON.stringify(merged))
        clientsMerged = incoming.length
        imported.push('顧問先一覧')
      } catch {
        skipped.push('clients.json（マージ失敗）')
      }
      continue
    }

    const keyFn = STORAGE_KEY_MAP[key]
    if (!keyFn) {
      skipped.push(`${file.name}（対象外のキー）`)
      continue
    }
    if (!clientId) {
      skipped.push(`${file.name}（顧問先が未選択）`)
      continue
    }
    localStorage.setItem(keyFn(clientId), JSON.stringify(parsed))
    imported.push(key)
  }

  return { imported, skipped, clientsMerged }
}

/**
 * 全顧問先のデータをまとめて Drive にアップロード
 * 進捗を逐次レポートしながら全件処理。
 */
export async function uploadAllClientsToDrive(
  onProgress?: (current: number, total: number, clientName: string) => void,
): Promise<{ uploaded: number; total: number; failed: string[] }> {
  const clientListRaw = localStorage.getItem('bank-statement-clients')
  if (!clientListRaw) return { uploaded: 0, total: 0, failed: [] }
  let clients: Array<{ id: string; name: string }> = []
  try { clients = JSON.parse(clientListRaw) } catch { return { uploaded: 0, total: 0, failed: [] } }

  let uploaded = 0
  const failed: string[] = []
  for (let i = 0; i < clients.length; i++) {
    const c = clients[i]
    if (!c.id) continue
    onProgress?.(i + 1, clients.length, c.name || c.id)
    try {
      await uploadClientToDrive(c.id, c.name || null)
      uploaded++
    } catch (err) {
      console.warn(`[drive-sync] upload failed for ${c.name || c.id}:`, err)
      failed.push(c.name || c.id)
    }
  }
  return { uploaded, total: clients.length, failed }
}

/** Drive連携ステータスを確認 */
export async function getDriveConnected(): Promise<boolean> {
  return authIsConnected()
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
  try {
    await driveWrite(clientId, null, key, data)
  } catch (err) {
    if (err instanceof Error && err.message === 'NOT_AUTHENTICATED') {
      throw new Error('Drive 未連携（ログインしてください）')
    }
    throw err
  }
}

/**
 * Drive 上の現在のフォルダ内ファイル一覧を取得して、ローカルの最終同期メタと比較。
 * 変更があったキーのリストを返す。
 */
export async function detectRemoteChanges(clientId: string, clientName: string | null): Promise<string[]> {
  try {
    let json: { files: Array<{ name: string; modifiedTime: string }> }
    try {
      json = await driveListChanges(clientId, clientName)
    } catch (e) {
      if (e instanceof Error && e.message === 'NOT_AUTHENTICATED') emitStatus({ connected: false })
      return []
    }
    emitStatus({ connected: true, error: null })
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
