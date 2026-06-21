// 全データのローカルバックアップ（ZIP出力）と復元。
// Google Drive 連携を廃止し、控えは「自分でZIP出力 → 任意の場所(例: Driveに手動アップロード)」で行う。
//
// ZIP 構成:
//   manifest.json                … { version, exportedAt, clients:[{id,name,...}] }
//   clients.json                 … 顧問先一覧（localStorage: bank-statement-clients）
//   data/{clientId}/{key}.json   … 顧問先別データ（STORAGE_KEY_MAP の各キー）

import { STORAGE_KEY_MAP, STORAGE_KEYS, CLIENTS_LIST_KEY } from './storage-keys'

const LAST_BACKUP_KEY = 'bs-last-backup-at'

export function getLastBackupAt(): Date | null {
  if (typeof window === 'undefined') return null
  const v = localStorage.getItem(LAST_BACKUP_KEY)
  if (!v) return null
  const d = new Date(v)
  return isNaN(d.getTime()) ? null : d
}

export function setLastBackupAt(d: Date = new Date()): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(LAST_BACKUP_KEY, d.toISOString())
  // ヘッダーの「前回バックアップ」表示を更新させる
  window.dispatchEvent(new Event('bs-backup-updated'))
}

/** 前回バックアップからの経過日数（未実施なら null）*/
export function daysSinceLastBackup(): number | null {
  const last = getLastBackupAt()
  if (!last) return null
  return Math.floor((Date.now() - last.getTime()) / 86400000)
}

type ClientLike = { id: string; name?: string }

function readClients(): ClientLike[] {
  try {
    const v = JSON.parse(localStorage.getItem(CLIENTS_LIST_KEY) || '[]')
    return Array.isArray(v) ? v : []
  } catch { return [] }
}

/** 全データを ZIP にまとめてダウンロードする。戻り値はファイル名。*/
export async function exportAllAsZip(): Promise<string> {
  const JSZip = (await import('jszip')).default
  const zip = new JSZip()

  const clients = readClients()
  zip.file('clients.json', localStorage.getItem(CLIENTS_LIST_KEY) || '[]')

  const dataDir = zip.folder('data')!
  for (const c of clients) {
    if (!c || !c.id) continue
    const dir = dataDir.folder(c.id)!
    for (const key of STORAGE_KEYS) {
      const raw = localStorage.getItem(STORAGE_KEY_MAP[key](c.id))
      if (raw != null) dir.file(`${key}.json`, raw)
    }
  }

  const exportedAt = new Date()
  zip.file('manifest.json', JSON.stringify({
    version: 1,
    app: 'aiocr-shiwake',
    exportedAt: exportedAt.toISOString(),
    clientCount: clients.length,
    clients: clients.map((c) => ({ id: c.id, name: c.name })),
  }, null, 2))

  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' })
  const pad = (n: number) => String(n).padStart(2, '0')
  const ts = `${exportedAt.getFullYear()}${pad(exportedAt.getMonth() + 1)}${pad(exportedAt.getDate())}-${pad(exportedAt.getHours())}${pad(exportedAt.getMinutes())}`
  const filename = `会計大将変換_バックアップ_${ts}.zip`

  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)

  setLastBackupAt(exportedAt)
  return filename
}

export interface RestoreResult {
  clientsMerged: number
  clientsTotal: number
  keysRestored: number
}

/**
 * ZIP から全データを復元（localStorage に書き戻す）。
 * 顧問先一覧は id でマージ（既存を残しつつ取り込み側を反映）。
 * 顧問先別データは取り込み側で上書き。
 */
export async function importAllFromZip(file: File): Promise<RestoreResult> {
  const JSZip = (await import('jszip')).default
  const zip = await JSZip.loadAsync(file)

  let clientsMerged = 0
  let clientsTotal = 0
  let keysRestored = 0

  // 顧問先一覧をマージ
  const clientsFile = zip.file('clients.json')
  if (clientsFile) {
    try {
      const incoming: ClientLike[] = JSON.parse(await clientsFile.async('string'))
      const existing = readClients()
      const byId = new Map<string, ClientLike>()
      for (const c of existing) if (c && c.id) byId.set(c.id, c)
      for (const c of incoming) if (c && c.id) { byId.set(c.id, { ...byId.get(c.id), ...c }); clientsMerged++ }
      const merged = Array.from(byId.values())
      localStorage.setItem(CLIENTS_LIST_KEY, JSON.stringify(merged))
      clientsTotal = merged.length
    } catch { /* skip */ }
  }

  // 顧問先別データを復元
  const validKeys = new Set(STORAGE_KEYS)
  const entries = Object.keys(zip.files)
  for (const path of entries) {
    const m = path.match(/^data\/([^/]+)\/([^/]+)\.json$/)
    if (!m) continue
    const [, clientId, key] = m
    if (!validKeys.has(key)) continue
    const f = zip.file(path)
    if (!f) continue
    try {
      const raw = await f.async('string')
      localStorage.setItem(STORAGE_KEY_MAP[key](clientId), raw)
      keysRestored++
    } catch { /* skip */ }
  }

  return { clientsMerged, clientsTotal, keysRestored }
}
