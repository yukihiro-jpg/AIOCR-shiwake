// window.fetch を横取りして "/api/..." をクライアント処理に振り替える（standalone 専用）。
// 元アプリのコンポーネント/ライブラリは一切変更しない。
// 未実装のエンドポイント（Drive 等）は素通しせず、分かりやすいエラーを返す。
import { handleGeminiUpload, handleOcrPdf } from './gemini-bank-statement'
import {
  handleOcr,
  handleCreditCard,
  handleReceipt,
  handleInvoice,
  handleExpandDescriptions,
} from './gemini-images'
import { jsonResponse, LS_API_KEY, LS_MODEL, getApiKey, getModel } from './gemini-common'

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return (input as Request).url || ''
}

export function installApiShim() {
  const realFetch = window.fetch.bind(window)

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let path = ''
    try {
      path = new URL(urlOf(input), window.location.href).pathname
    } catch {
      path = urlOf(input)
    }

    // Gemini 系（実装済み）
    if (path === '/api/bank-statement/gemini-upload') return handleGeminiUpload(init)
    if (path === '/api/bank-statement/ocr-pdf') return handleOcrPdf(init)
    if (path === '/api/bank-statement/ocr') return handleOcr(init)
    if (path === '/api/bank-statement/credit-card') return handleCreditCard(init)
    if (path === '/api/bank-statement/receipt') return handleReceipt(init)
    if (path === '/api/bank-statement/invoice') return handleInvoice(init)
    if (path === '/api/bank-statement/expand-descriptions') return handleExpandDescriptions(init)

    // それ以外の /api/... は単一HTML版では未対応 → 分かりやすいエラー
    if (path.startsWith('/api/')) {
      return jsonResponse(
        { error: `単一HTML版では未対応のAPIです（${path}）。この機能は今後のステップで対応します。` },
        501,
      )
    }

    // 通常のリクエスト（CDN等）は素通し
    return realFetch(input, init)
  }
}

// ---- 右下に「⚙ Gemini設定」ボタンを注入（standalone 専用・既存UIは変更しない） ----
export function installSettingsButton() {
  if (document.getElementById('standalone-settings-btn')) return
  const btn = document.createElement('button')
  btn.id = 'standalone-settings-btn'
  btn.textContent = '⚙ Gemini設定'
  btn.style.cssText =
    'position:fixed;right:12px;bottom:12px;z-index:99999;padding:8px 12px;font-size:12px;' +
    'background:#1f2937;color:#fff;border:none;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.3);cursor:pointer;opacity:.85;'
  btn.onmouseenter = () => (btn.style.opacity = '1')
  btn.onmouseleave = () => (btn.style.opacity = '.85')
  btn.onclick = () => {
    const curKey = getApiKey()
    const key = window.prompt(
      'Gemini API キー（Google AI Studio で取得）。この端末のブラウザにのみ保存されます。空欄でキャンセル。',
      curKey,
    )
    if (key !== null) {
      try {
        if (key.trim()) localStorage.setItem(LS_API_KEY, key.trim())
        else localStorage.removeItem(LS_API_KEY)
      } catch { /* ignore */ }
    }
    const model = window.prompt(
      'Gemini モデル名（空欄なら gemini-2.5-flash）。例: gemini-2.5-flash / gemini-2.5-pro',
      getModel(''),
    )
    if (model !== null) {
      try {
        if (model.trim()) localStorage.setItem(LS_MODEL, model.trim())
        else localStorage.removeItem(LS_MODEL)
      } catch { /* ignore */ }
    }
  }
  document.body.appendChild(btn)
}
