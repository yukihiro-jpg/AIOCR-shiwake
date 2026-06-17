// 単一HTML版（standalone）専用のクライアント側 Gemini 基盤。
// 元アプリの src/ には手を加えず、standalone 側で /api/... を横取りするための共通部品。

// ---- 設定（localStorage） ----
export const LS_API_KEY = 'bs-gemini-api-key'
export const LS_MODEL = 'bs-gemini-model'

export function getApiKey(): string {
  try {
    return localStorage.getItem(LS_API_KEY) || ''
  } catch {
    return ''
  }
}

export function getModel(fallback = 'gemini-2.5-flash'): string {
  try {
    return localStorage.getItem(LS_MODEL) || fallback
  } catch {
    return fallback
  }
}

// APIキー未設定時にユーザーへ入力を促す
export function ensureApiKey(): string {
  let key = getApiKey()
  if (!key) {
    const entered = window.prompt(
      'Gemini API キーを入力してください（Google AI Studio で取得）。\nこの端末のブラウザにのみ保存されます。',
      '',
    )
    if (entered && entered.trim()) {
      key = entered.trim()
      try {
        localStorage.setItem(LS_API_KEY, key)
      } catch {
        /* ignore */
      }
    }
  }
  if (!key) {
    throw new Error('Gemini API キーが未設定です（右下の「⚙ Gemini設定」から設定できます）')
  }
  return key
}

// ---- ローカル「ファイル」ストア ----
// 元アプリは Gemini File API に PDF をアップロードして fileUri を得るが、
// ブラウザからの File API アップロードは CORS 非対応。
// そこで standalone では「アップロード相当」をローカル保持し、後段で inlineData として送る。
interface StoredFile {
  base64: string
  mimeType: string
  displayName: string
}
const fileStore = new Map<string, StoredFile>()

export function storeLocalFile(base64: string, mimeType: string, displayName: string): string {
  const uri = `local://${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  fileStore.set(uri, { base64, mimeType, displayName })
  return uri
}

export function getLocalFile(uri: string): StoredFile | undefined {
  return fileStore.get(uri)
}

// ---- base64 変換（大きいファイルでもスタックを溢れさせない） ----
export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < buf.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + chunk)) as unknown as number[])
  }
  return btoa(binary)
}

// data URL("data:...;base64,xxxx") から base64 と mimeType を取り出す
export function dataUrlToParts(dataUrl: string): { base64: string; mimeType: string } {
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
  if (!m) throw new Error('data URL 形式が不正です')
  return { mimeType: m[1], base64: m[2] }
}

// JSON レスポンスを作る小ヘルパー
export function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
