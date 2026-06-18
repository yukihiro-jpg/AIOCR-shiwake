// ブラウザから直接 Google Drive REST API を呼び出すクライアント。
// 以前はサーバー（/api/drive*）で googleapis を使っていたが、静的サイト化に伴い
// クライアント側でアクセストークンを使って Drive v3 REST を直接叩く方式に変更。
//
// 共有ドライブ対応のため supportsAllDrives / includeItemsFromAllDrives を常に付与する。

import { getAccessToken } from './google-auth'

// 設定値はフォルダIDが理想だが、Drive の URL を丸ごと貼られても動くように
// URL からフォルダIDを抽出する（https://drive.google.com/drive/u/0/folders/<ID> 等）。
function extractFolderId(raw: string): string {
  const v = (raw || '').trim()
  if (!v) return ''
  const byPath = v.match(/\/folders\/([a-zA-Z0-9_-]+)/)
  if (byPath) return byPath[1]
  const byQuery = v.match(/[?&]id=([a-zA-Z0-9_-]+)/)
  if (byQuery) return byQuery[1]
  return v
}

const ROOT_FOLDER_ID = extractFolderId(process.env.NEXT_PUBLIC_GOOGLE_DRIVE_FOLDER_ID || '')
const APP_FOLDER_NAME = process.env.NEXT_PUBLIC_GOOGLE_DRIVE_DATA_FOLDER_NAME || '事務所アプリ共有データ'

const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files'
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files'

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken()
  return { Authorization: `Bearer ${token}` }
}

async function driveJson<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = { ...(await authHeaders()), ...(init?.headers || {}) }
  const res = await fetch(url, { ...init, headers })
  if (res.status === 401) throw new Error('NOT_AUTHENTICATED')
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`Drive API HTTP ${res.status}: ${t.slice(0, 300)}`)
  }
  return (await res.json()) as T
}

function sanitizeFolderName(name: string): string {
  return name.replace(/[/\\'"`]/g, '_').trim() || 'unnamed'
}

interface DriveFile { id: string; name?: string; modifiedTime?: string }

async function listFiles(q: string, fields = 'files(id)'): Promise<DriveFile[]> {
  const params = new URLSearchParams({
    q,
    fields,
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
    pageSize: '1000',
  })
  const data = await driveJson<{ files?: DriveFile[] }>(`${DRIVE_FILES}?${params.toString()}`)
  return data.files || []
}

async function findFolderId(name: string, parentId: string): Promise<string | null> {
  const escaped = sanitizeFolderName(name).replace(/'/g, "\\'")
  const files = await listFiles(
    `name='${escaped}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
  )
  return files[0]?.id ?? null
}

async function createFolder(name: string, parentId: string): Promise<string> {
  const data = await driveJson<DriveFile>(`${DRIVE_FILES}?supportsAllDrives=true&fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: sanitizeFolderName(name),
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    }),
  })
  return data.id
}

async function findOrCreateFolder(name: string, parentId: string): Promise<string> {
  return (await findFolderId(name, parentId)) ?? (await createFolder(name, parentId))
}

/** 顧問先フォルダを解決（名前優先 → 旧ID名フォルダはリネーム → 無ければ作成） */
async function getOrMigrateClientFolder(clientId: string, clientName: string, parentId: string): Promise<string> {
  const safeName = sanitizeFolderName(clientName)
  const byName = await findFolderId(safeName, parentId)
  if (byName) return byName

  const byId = await findFolderId(clientId, parentId)
  if (byId) {
    // 旧IDフォルダを顧問先名にリネーム
    try {
      await driveJson(`${DRIVE_FILES}/${byId}?supportsAllDrives=true`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: safeName }),
      })
    } catch { /* リネーム失敗は致命的ではない */ }
    return byId
  }
  return createFolder(safeName, parentId)
}

async function resolveClientFolder(clientId: string, clientName: string | null, appFolder: string): Promise<string> {
  if (clientId === '_global' || !clientName) {
    return findOrCreateFolder(clientId, appFolder)
  }
  return getOrMigrateClientFolder(clientId, clientName, appFolder)
}

async function readFileContent(fileName: string, folderId: string): Promise<string | null> {
  const escaped = fileName.replace(/'/g, "\\'")
  const files = await listFiles(`name='${escaped}' and '${folderId}' in parents and trashed=false`)
  if (files.length === 0) return null
  const headers = await authHeaders()
  const res = await fetch(`${DRIVE_FILES}/${files[0].id}?alt=media&supportsAllDrives=true`, { headers })
  if (res.status === 401) throw new Error('NOT_AUTHENTICATED')
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`Drive read HTTP ${res.status}: ${t.slice(0, 200)}`)
  }
  return await res.text()
}

async function writeFileContent(fileName: string, folderId: string, content: string): Promise<void> {
  const escaped = fileName.replace(/'/g, "\\'")
  const existing = await listFiles(`name='${escaped}' and '${folderId}' in parents and trashed=false`)
  const headers = await authHeaders()

  if (existing.length > 0) {
    // 既存ファイルの内容を更新（メタデータは変更不要）
    const res = await fetch(`${DRIVE_UPLOAD}/${existing[0].id}?uploadType=media&supportsAllDrives=true`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: content,
    })
    if (res.status === 401) throw new Error('NOT_AUTHENTICATED')
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      throw new Error(`Drive update HTTP ${res.status}: ${t.slice(0, 200)}`)
    }
    return
  }

  // 新規作成（メタデータ＋内容を multipart で送信）
  const boundary = '-------bs' + Math.random().toString(36).slice(2)
  const metadata = { name: fileName, parents: [folderId] }
  const body =
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) + '\r\n' +
    `--${boundary}\r\n` +
    'Content-Type: application/json\r\n\r\n' +
    content + '\r\n' +
    `--${boundary}--`
  const res = await fetch(`${DRIVE_UPLOAD}?uploadType=multipart&supportsAllDrives=true&fields=id`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  })
  if (res.status === 401) throw new Error('NOT_AUTHENTICATED')
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`Drive create HTTP ${res.status}: ${t.slice(0, 200)}`)
  }
}

// ============================================================
// 高レベル API（旧 /api/drive の GET/POST/PUT/changes 相当）
// ============================================================

/** 1キー読み込み（旧 GET /api/drive） */
export async function driveRead(clientId: string, clientName: string | null, key: string): Promise<unknown> {
  const appFolder = await findOrCreateFolder(APP_FOLDER_NAME, ROOT_FOLDER_ID)
  const clientFolder = await resolveClientFolder(clientId, clientName, appFolder)
  const data = await readFileContent(`${key}.json`, clientFolder)
  return data ? JSON.parse(data) : null
}

/** 1キー書き込み（旧 POST /api/drive） */
export async function driveWrite(clientId: string, clientName: string | null, key: string, data: unknown): Promise<void> {
  const appFolder = await findOrCreateFolder(APP_FOLDER_NAME, ROOT_FOLDER_ID)
  const clientFolder = await resolveClientFolder(clientId, clientName, appFolder)
  await writeFileContent(`${key}.json`, clientFolder, JSON.stringify(data))
}

/** 複数キー一括書き込み（旧 PUT /api/drive） */
export async function driveBulkWrite(
  items: { clientId: string; clientName?: string | null; key: string; data: unknown }[],
): Promise<number> {
  const appFolder = await findOrCreateFolder(APP_FOLDER_NAME, ROOT_FOLDER_ID)
  const folderCache: Record<string, string> = {}
  for (const item of items) {
    const cid = item.clientId || '_global'
    const cname = item.clientName || null
    if (!folderCache[cid]) folderCache[cid] = await resolveClientFolder(cid, cname, appFolder)
    await writeFileContent(`${item.key}.json`, folderCache[cid], JSON.stringify(item.data))
  }
  return items.length
}

/** 顧問先フォルダ内のファイル一覧（旧 GET /api/drive/changes） */
export async function driveListChanges(
  clientId: string,
  clientName: string | null,
): Promise<{ files: { name: string; modifiedTime: string }[] }> {
  const appFolder = await findFolderId(APP_FOLDER_NAME, ROOT_FOLDER_ID)
  if (!appFolder) return { files: [] }

  let clientFolder: string | null = null
  if (clientName && clientId !== '_global') clientFolder = await findFolderId(clientName, appFolder)
  if (!clientFolder) clientFolder = await findFolderId(clientId, appFolder)
  if (!clientFolder) return { files: [] }

  const files = await listFiles(
    `'${clientFolder}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
    'files(name, modifiedTime)',
  )
  return { files: files.map((f) => ({ name: f.name || '', modifiedTime: f.modifiedTime || '' })) }
}
