// クライアント側 Google OAuth（Google Identity Services / GIS トークンクライアント）。
// 以前はサーバー（/api/auth/*）で client_secret を使ってトークン交換していたが、
// 静的サイト（GitHub Pages）化に伴い、ブラウザ側でアクセストークンを取得する方式に変更。
//
// - client_id は公開情報なので NEXT_PUBLIC_GOOGLE_CLIENT_ID に埋め込む
// - アクセストークンはメモリ＋localStorage に保持（有効期限つき）
// - 暗黙フローのためリフレッシュトークンは無い → 期限切れ時は silent 再取得を試みる

const CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || ''
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive'
const TOKEN_STORAGE = 'bs-google-token'
const GIS_SRC = 'https://accounts.google.com/gsi/client'

interface StoredToken {
  accessToken: string
  expiresAt: number // epoch ms
}

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    google?: any
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

let gisLoaded: Promise<void> | null = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tokenClient: any = null
let memoryToken: StoredToken | null = null

function loadStoredToken(): StoredToken | null {
  if (memoryToken) return memoryToken
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(TOKEN_STORAGE)
    if (!raw) return null
    memoryToken = JSON.parse(raw)
    return memoryToken
  } catch {
    return null
  }
}

function saveToken(t: StoredToken | null) {
  memoryToken = t
  if (typeof window === 'undefined') return
  try {
    if (t) localStorage.setItem(TOKEN_STORAGE, JSON.stringify(t))
    else localStorage.removeItem(TOKEN_STORAGE)
  } catch { /* ignore */ }
}

/** GIS スクリプトを読み込む */
function loadGis(): Promise<void> {
  if (gisLoaded) return gisLoaded
  gisLoaded = new Promise((resolve, reject) => {
    if (typeof window === 'undefined') { reject(new Error('window がありません')); return }
    if (window.google?.accounts?.oauth2) { resolve(); return }
    const existing = document.querySelector(`script[src="${GIS_SRC}"]`)
    if (existing) {
      existing.addEventListener('load', () => resolve())
      existing.addEventListener('error', () => reject(new Error('GIS スクリプトの読み込みに失敗しました')))
      return
    }
    const script = document.createElement('script')
    script.src = GIS_SRC
    script.async = true
    script.defer = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('GIS スクリプトの読み込みに失敗しました'))
    document.head.appendChild(script)
  })
  return gisLoaded
}

async function ensureTokenClient() {
  if (!CLIENT_ID) {
    throw new Error('NEXT_PUBLIC_GOOGLE_CLIENT_ID が未設定です（ビルド時に埋め込む必要があります）')
  }
  await loadGis()
  if (!tokenClient) {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: DRIVE_SCOPE,
      callback: () => { /* リクエストごとに差し替える */ },
    })
  }
  return tokenClient
}

/**
 * アクセストークンを要求する。
 * @param interactive true ならアカウント選択/同意の UI を出す（ユーザー操作起点で呼ぶこと）。
 *                    false なら silent（既存セッションから無音で取得）を試みる。
 */
function requestToken(interactive: boolean): Promise<StoredToken> {
  return new Promise(async (resolve, reject) => {
    try {
      const client = await ensureTokenClient()
      client.callback = (resp: { access_token?: string; expires_in?: number; error?: string }) => {
        if (resp.error || !resp.access_token) {
          reject(new Error(resp.error || 'アクセストークンを取得できませんでした'))
          return
        }
        const token: StoredToken = {
          accessToken: resp.access_token,
          // expires_in は秒。安全のため 60 秒早めに期限切れ扱い。
          expiresAt: Date.now() + ((resp.expires_in || 3600) - 60) * 1000,
        }
        saveToken(token)
        resolve(token)
      }
      client.requestAccessToken({ prompt: interactive ? 'consent' : '' })
    } catch (e) {
      reject(e)
    }
  })
}

/** 連携済み（有効なトークンがある）か */
export function isConnected(): boolean {
  const t = loadStoredToken()
  return !!t && t.expiresAt > Date.now()
}

/** 明示的にログイン（ユーザー操作起点で呼ぶ）。アカウント選択・同意画面が出る。 */
export async function signIn(): Promise<void> {
  await requestToken(true)
}

/** ログアウト（トークンを失効・破棄） */
export async function signOut(): Promise<void> {
  const t = loadStoredToken()
  if (t?.accessToken && window.google?.accounts?.oauth2?.revoke) {
    try { window.google.accounts.oauth2.revoke(t.accessToken, () => {}) } catch { /* ignore */ }
  }
  saveToken(null)
}

/**
 * 有効なアクセストークンを取得する。
 * 期限切れ・未取得なら silent 再取得を試み、それも失敗したら NOT_AUTHENTICATED を投げる。
 */
export async function getAccessToken(): Promise<string> {
  const t = loadStoredToken()
  if (t && t.expiresAt > Date.now()) return t.accessToken
  try {
    const fresh = await requestToken(false)
    return fresh.accessToken
  } catch {
    throw new Error('NOT_AUTHENTICATED')
  }
}
