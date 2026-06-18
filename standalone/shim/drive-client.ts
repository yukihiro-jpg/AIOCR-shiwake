// Google Drive 連携のクライアント版（standalone専用）。
// src/app/api/drive/{route,changes/route,status/route}.ts のサーバ実装を、
// GIS トークン + Drive REST(drive.file) で忠実に再現する。
// フォルダ構成: <root>/事務所アプリ共有データ/<顧問先名 or clientId>/<key>.json
import { jsonResponse } from './gemini-common'

export const LS_DRIVE_CLIENT_ID = 'bs-drive-client-id'
export const LS_DRIVE_FOLDER = 'bs-drive-folder-url'
const LS_DRIVE_TOKEN = 'bs-drive-token'

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
const APP_FOLDER_NAME = '事務所アプリ共有データ'

// ---- 設定 ----
export function getDriveClientId(): string {
  try { return localStorage.getItem(LS_DRIVE_CLIENT_ID) || '' } catch { return '' }
}
export function getDriveFolderUrl(): string {
  try { return localStorage.getItem(LS_DRIVE_FOLDER) || '' } catch { return '' }
}
function extractFolderId(url: string): string {
  if (!url) return ''
  let m = url.match(/\/folders\/([a-zA-Z0-9_-]+)/); if (m) return m[1]
  m = url.match(/[?&]id=([a-zA-Z0-9_-]+)/); if (m) return m[1]
  if (/^[a-zA-Z0-9_-]{10,}$/.test(url.trim())) return url.trim()
  return ''
}
function rootId(): string { return extractFolderId(getDriveFolderUrl()) || 'root' }

// ---- トークン（GIS） ----
let accessToken = ''
let tokenExpiry = 0
let accountHint = ''
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tokenClient: any = null

function persist() {
  try { localStorage.setItem(LS_DRIVE_TOKEN, JSON.stringify({ token: accessToken, expiry: tokenExpiry, hint: accountHint })) } catch { /* ignore */ }
}
function loadPersisted() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_DRIVE_TOKEN) || 'null')
    if (s) { accessToken = s.token || ''; tokenExpiry = s.expiry || 0; accountHint = s.hint || '' }
  } catch { /* ignore */ }
}
loadPersisted()

function tokenValid(): boolean { return !!accessToken && Date.now() < tokenExpiry }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function gis(): any { return (window as unknown as { google?: any }).google }

function waitForGis(timeoutMs = 10000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = () => {
      if (gis()?.accounts?.oauth2) { resolve(); return }
      if (Date.now() - start > timeoutMs) { reject(new Error('Google認証スクリプトの読み込みに失敗しました')); return }
      setTimeout(tick, 200)
    }
    tick()
  })
}

function ensureTokenClient(): boolean {
  const clientId = getDriveClientId()
  if (!clientId) return false
  if (!gis()?.accounts?.oauth2) return false
  tokenClient = gis().accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: DRIVE_SCOPE,
    callback: () => { /* per-request で差し替え */ },
  })
  return true
}

function requestToken(interactive: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!ensureTokenClient()) { reject(new Error('Drive OAuth クライアントIDが未設定です')); return }
    tokenClient.callback = (resp: { access_token?: string; expires_in?: number; error?: string }) => {
      if (resp.error || !resp.access_token) { reject(new Error(resp.error || 'token error')); return }
      accessToken = resp.access_token
      tokenExpiry = Date.now() + (((+(resp.expires_in || 3600)) * 1000)) - 120000
      persist()
      resolve(accessToken)
    }
    try {
      const opt: { prompt: string; hint?: string } = { prompt: interactive ? 'consent' : '' }
      if (accountHint) opt.hint = accountHint
      tokenClient.requestAccessToken(opt)
    } catch (e) { reject(e as Error) }
  })
}

async function ensureToken(): Promise<string> {
  if (tokenValid()) return accessToken
  // サイレント取得を試みる（同意済みなら画面なしで取れる）
  await waitForGis()
  return requestToken(false)
}

async function driveFetch(url: string, opts: RequestInit = {}): Promise<Response> {
  const attempt = async () => {
    const tok = await ensureToken()
    const headers = Object.assign({}, opts.headers || {}, { Authorization: 'Bearer ' + tok })
    return fetch(url, Object.assign({}, opts, { headers }))
  }
  let r = await attempt()
  if (r.status === 401) { accessToken = ''; tokenExpiry = 0; r = await attempt() }
  return r
}

// ---- フォルダ/ファイル操作（Drive REST） ----
function sanitize(name: string): string { return name.replace(/[/\\'"`]/g, '_').trim() || 'unnamed' }
function esc(name: string): string { return sanitize(name).replace(/'/g, "\\'") }

async function listFiles(q: string, fields = 'files(id,name)'): Promise<Array<{ id: string; name: string; modifiedTime?: string }>> {
  const url = 'https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(q) +
    '&fields=' + encodeURIComponent(fields) +
    '&pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true'
  const r = await driveFetch(url)
  if (!r.ok) throw new Error('Drive list HTTP ' + r.status)
  return (await r.json()).files || []
}
async function createFolder(name: string, parentId: string): Promise<string> {
  const r = await driveFetch('https://www.googleapis.com/drive/v3/files?fields=id&supportsAllDrives=true', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: sanitize(name), mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }),
  })
  if (!r.ok) throw new Error('Drive createFolder HTTP ' + r.status)
  return (await r.json()).id
}
async function findOrCreateFolder(name: string, parentId: string): Promise<string> {
  const files = await listFiles(`name='${esc(name)}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`)
  if (files.length) return files[0].id
  return createFolder(name, parentId)
}
async function getOrMigrateClientFolder(clientId: string, clientName: string, parentId: string): Promise<string> {
  const byName = await listFiles(`name='${esc(clientName)}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`)
  if (byName.length) return byName[0].id
  const byId = await listFiles(`name='${esc(clientId)}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`)
  if (byId.length) {
    try {
      await driveFetch(`https://www.googleapis.com/drive/v3/files/${byId[0].id}?supportsAllDrives=true`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: sanitize(clientName) }),
      })
    } catch { /* リネーム失敗は致命的でない */ }
    return byId[0].id
  }
  return createFolder(clientName, parentId)
}
async function resolveClientFolder(clientId: string, clientName: string | null, appFolder: string): Promise<string> {
  if (clientId === '_global' || !clientName) return findOrCreateFolder(clientId, appFolder)
  return getOrMigrateClientFolder(clientId, clientName, appFolder)
}
async function readFileContent(fileName: string, folderId: string): Promise<string | null> {
  const files = await listFiles(`name='${esc(fileName)}' and '${folderId}' in parents and trashed=false`)
  if (!files.length) return null
  const r = await driveFetch(`https://www.googleapis.com/drive/v3/files/${files[0].id}?alt=media&supportsAllDrives=true`)
  if (!r.ok) return null
  return await r.text()
}
async function writeFileContent(fileName: string, folderId: string, content: string): Promise<void> {
  const files = await listFiles(`name='${esc(fileName)}' and '${folderId}' in parents and trashed=false`)
  if (files.length) {
    const r = await driveFetch(`https://www.googleapis.com/upload/drive/v3/files/${files[0].id}?uploadType=media&supportsAllDrives=true`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: content,
    })
    if (!r.ok) throw new Error('Drive update HTTP ' + r.status)
  } else {
    const boundary = '-------drive' + Date.now()
    const meta = { name: fileName, parents: [folderId] }
    const body = '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) +
      '\r\n--' + boundary + '\r\nContent-Type: application/json\r\n\r\n' + content + '\r\n--' + boundary + '--'
    const r = await driveFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id', {
      method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body,
    })
    if (!r.ok) throw new Error('Drive create HTTP ' + r.status)
  }
}

// 認証エラーを 401 として返すラッパ
function authError(err: unknown): Response | null {
  const msg = err instanceof Error ? err.message : String(err)
  if (/未設定|token error|access_denied|popup|認証|HTTP 401|NOT_AUTHENTICATED/.test(msg)) {
    return jsonResponse({ error: 'NOT_AUTHENTICATED' }, 401)
  }
  return null
}

// ---- エンドポイントハンドラ ----
export async function handleDriveGet(params: URLSearchParams): Promise<Response> {
  try {
    const clientId = params.get('clientId') || '_global'
    const clientName = params.get('clientName')
    const key = params.get('key')
    if (!key) return jsonResponse({ error: 'key is required' }, 400)
    const appFolder = await findOrCreateFolder(APP_FOLDER_NAME, rootId())
    const clientFolder = await resolveClientFolder(clientId, clientName, appFolder)
    const data = await readFileContent(`${key}.json`, clientFolder)
    return jsonResponse({ data: data ? JSON.parse(data) : null })
  } catch (err) {
    return authError(err) || jsonResponse({ error: `Drive read failed: ${err instanceof Error ? err.message : String(err)}` }, 500)
  }
}
export async function handleDrivePost(body: { clientId?: string; clientName?: string | null; key?: string; data?: unknown }): Promise<Response> {
  try {
    const { clientId = '_global', clientName = null, key, data } = body || {}
    if (!key) return jsonResponse({ error: 'key is required' }, 400)
    const appFolder = await findOrCreateFolder(APP_FOLDER_NAME, rootId())
    const clientFolder = await resolveClientFolder(clientId, clientName, appFolder)
    await writeFileContent(`${key}.json`, clientFolder, JSON.stringify(data))
    return jsonResponse({ success: true })
  } catch (err) {
    return authError(err) || jsonResponse({ error: `Drive write failed: ${err instanceof Error ? err.message : String(err)}` }, 500)
  }
}
export async function handleDrivePut(body: { items?: Array<{ clientId: string; clientName?: string | null; key: string; data: unknown }> }): Promise<Response> {
  try {
    const items = body?.items || []
    const appFolder = await findOrCreateFolder(APP_FOLDER_NAME, rootId())
    const folderCache: Record<string, string> = {}
    for (const item of items) {
      const cid = item.clientId || '_global'
      const cname = item.clientName || null
      if (!folderCache[cid]) folderCache[cid] = await resolveClientFolder(cid, cname, appFolder)
      await writeFileContent(`${item.key}.json`, folderCache[cid], JSON.stringify(item.data))
    }
    return jsonResponse({ success: true, count: items.length })
  } catch (err) {
    return authError(err) || jsonResponse({ error: `Drive bulk write failed: ${err instanceof Error ? err.message : String(err)}` }, 500)
  }
}
export async function handleDriveChanges(params: URLSearchParams): Promise<Response> {
  try {
    const clientId = params.get('clientId') || '_global'
    const clientName = params.get('clientName')
    const appFolder = await listFiles(`name='${esc(APP_FOLDER_NAME)}' and '${rootId()}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`)
    if (!appFolder.length) return jsonResponse({ files: [] })
    let clientFolder: string | null = null
    if (clientName && clientId !== '_global') {
      const f = await listFiles(`name='${esc(clientName)}' and '${appFolder[0].id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`)
      if (f.length) clientFolder = f[0].id
    }
    if (!clientFolder) {
      const f = await listFiles(`name='${esc(clientId)}' and '${appFolder[0].id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`)
      if (f.length) clientFolder = f[0].id
    }
    if (!clientFolder) return jsonResponse({ files: [] })
    const files = await listFiles(`'${clientFolder}' in parents and trashed=false and mimeType!='application/vnd.google-apps.folder'`, 'files(name,modifiedTime)')
    return jsonResponse({ files: files.map((f) => ({ name: f.name || '', modifiedTime: f.modifiedTime || '' })) })
  } catch (err) {
    return authError(err) || jsonResponse({ error: `Drive changes failed: ${err instanceof Error ? err.message : String(err)}` }, 500)
  }
}
export function handleDriveStatusGet(): Response {
  return jsonResponse({ connected: tokenValid() })
}
export function handleDriveStatusDelete(): Response {
  try { if (accessToken) gis()?.accounts?.oauth2?.revoke?.(accessToken, () => {}) } catch { /* ignore */ }
  accessToken = ''; tokenExpiry = 0; accountHint = ''
  try { localStorage.removeItem(LS_DRIVE_TOKEN) } catch { /* ignore */ }
  return jsonResponse({ success: true })
}

// ---- ログイン（DriveSyncButton の <a href="/api/auth/google"> から呼ぶ） ----
export async function driveLogin(): Promise<void> {
  if (!getDriveClientId()) {
    alert('先に「⚙ 設定」で Drive OAuth クライアントID を入力してください。')
    return
  }
  try {
    await waitForGis()
    await requestToken(true)
    // 次回サイレント更新用にアカウントを記憶
    try {
      const r = await driveFetch('https://www.googleapis.com/drive/v3/about?fields=user')
      const j = await r.json()
      if (j?.user?.emailAddress) { accountHint = j.user.emailAddress; persist() }
    } catch { /* ignore */ }
    // 元アプリと同様、接続後はページを再読込して接続状態を反映
    window.location.search = '?drive=connected'
  } catch (e) {
    alert('Google Drive へのログインに失敗しました: ' + (e instanceof Error ? e.message : String(e)))
  }
}
