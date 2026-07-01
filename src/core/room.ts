// 共通コア: 合言葉(ルーム)管理と roomKey / データパス生成（全モジュール共通）。
//
// - 合言葉は端末の localStorage に保存（共通キー "suite-room-passphrase"）。コードには書かない。
// - roomKey = SHA-256(合言葉) の16進小文字（推測不可・RTDBパス安全）。
// - 【重要】roomKey はルーム全データへの鍵。外部に渡るURL等には絶対に含めないこと。
// - modulePath(moduleKey, ...segments) = rooms/{roomKey}/{moduleKey}/{...}

const ROOM_KEY = 'suite-room-passphrase'

export function getRoomPassphrase(): string | null {
  if (typeof window === 'undefined') return null
  const v = localStorage.getItem(ROOM_KEY)
  return v && v.trim() ? v : null
}

export function setRoomPassphrase(passphrase: string): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(ROOM_KEY, passphrase.trim())
  cachedRoomKey = null
}

export function clearRoomPassphrase(): void {
  if (typeof window === 'undefined') return
  localStorage.removeItem(ROOM_KEY)
  cachedRoomKey = null
}

export function hasRoom(): boolean {
  return getRoomPassphrase() != null
}

let cachedRoomKey: string | null = null

export async function roomKey(): Promise<string> {
  if (cachedRoomKey) return cachedRoomKey
  const pass = getRoomPassphrase()
  if (!pass) throw new Error('NO_ROOM')
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pass))
  cachedRoomKey = Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return cachedRoomKey
}

/** rooms/{roomKey}/{moduleKey}/{segments...} を返す */
export async function modulePath(moduleKey: string, ...segments: string[]): Promise<string> {
  const rk = await roomKey()
  const tail = segments.length ? '/' + segments.join('/') : ''
  return `rooms/${rk}/${moduleKey}${tail}`
}
