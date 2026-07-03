// Google ドライブ（共有ドライブ）連携。
// ブラウザから Google Identity Services (GIS) で OAuth トークンを取得し、Drive API v3 を直接叩く。
// クライアントIDは公開情報（秘密ではない）だが、環境依存のため共通設定（端末localStorage）に保存する。
// 対象は共有ドライブ（Shared Drives）。マイドライブは対象外（事務所の共有運用を前提）。

export const GOOGLE_CLIENT_ID_KEY = 'suite-google-client-id'

export function getGoogleClientId(): string {
  if (typeof window === 'undefined') return ''
  return (localStorage.getItem(GOOGLE_CLIENT_ID_KEY) || '').trim()
}

let gisLoading: Promise<void> | null = null
function loadGis(): Promise<void> {
  if (gisLoading) return gisLoading
  gisLoading = new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((window as any).google?.accounts?.oauth2) return resolve()
    const s = document.createElement('script')
    s.src = 'https://accounts.google.com/gsi/client'
    s.async = true
    s.onload = () => resolve()
    s.onerror = () => reject(new Error('Google認証スクリプトの読み込みに失敗しました。通信環境をご確認ください'))
    document.head.appendChild(s)
  })
  return gisLoading
}

let cachedToken: { token: string; exp: number } | null = null

/** アクセストークンを取得（必要ならGoogleのログイン/同意ポップアップを開く）。
 *  必ずボタンクリック等のユーザー操作から呼ぶこと（ポップアップブロック回避）。 */
export async function getAccessToken(): Promise<string> {
  const clientId = getGoogleClientId()
  if (!clientId) {
    throw new Error('GoogleクライアントIDが未設定です。ホーム右上の「⚙️共通設定」で登録してください')
  }
  if (cachedToken && Date.now() < cachedToken.exp - 60_000) return cachedToken.token
  await loadGis()
  return await new Promise<string>((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = (window as any).google
    const tc = g.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: 'https://www.googleapis.com/auth/drive',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      callback: (resp: any) => {
        if (resp.error) return reject(new Error('Google認証に失敗しました：' + resp.error))
        cachedToken = {
          token: resp.access_token,
          exp: Date.now() + (Number(resp.expires_in) || 3600) * 1000,
        }
        resolve(resp.access_token)
      },
      error_callback: () => reject(new Error('Google認証がキャンセルされました')),
    })
    tc.requestAccessToken()
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api(token: string, path: string, init?: RequestInit): Promise<any> {
  const r = await fetch('https://www.googleapis.com/drive/v3/' + path, {
    ...init,
    headers: { ...(init?.headers || {}), Authorization: 'Bearer ' + token },
  })
  if (!r.ok) {
    const t = await r.text().catch(() => '')
    throw new Error(`Drive APIエラー(${r.status})：${t.slice(0, 300)}`)
  }
  return r.json()
}

export interface DriveItem {
  id: string
  name: string
}

/** 共有ドライブの一覧 */
export async function listSharedDrives(token: string): Promise<DriveItem[]> {
  const d = await api(token, 'drives?pageSize=100')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((d.drives || []) as any[]).map((x) => ({ id: x.id, name: x.name }))
}

/** 指定フォルダ直下のフォルダ一覧（共有ドライブ内） */
export async function listFolders(token: string, driveId: string, parentId: string): Promise<DriveItem[]> {
  const q = encodeURIComponent(
    `'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
  )
  const d = await api(
    token,
    `files?q=${q}&corpora=drive&driveId=${driveId}&includeItemsFromAllDrives=true&supportsAllDrives=true&pageSize=200&orderBy=name&fields=files(id,name)`,
  )
  return (d.files || []) as DriveItem[]
}

/** フォルダを作成して返す */
export async function createDriveFolder(token: string, parentId: string, name: string): Promise<DriveItem> {
  const d = await api(token, 'files?supportsAllDrives=true&fields=id,name', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }),
  })
  return d as DriveItem
}

/** ファイルをアップロード（multipart） */
export async function uploadToDrive(token: string, parentId: string, name: string, blob: Blob): Promise<void> {
  const boundary = 'suite_' + Math.random().toString(36).slice(2)
  const meta = { name, parents: [parentId] }
  const body = new Blob(
    [
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${blob.type || 'application/octet-stream'}\r\n\r\n`,
      blob,
      `\r\n--${boundary}--`,
    ],
    { type: `multipart/related; boundary=${boundary}` },
  )
  const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  })
  if (!r.ok) {
    const t = await r.text().catch(() => '')
    throw new Error(`アップロード失敗(${r.status})：${t.slice(0, 300)}`)
  }
}
