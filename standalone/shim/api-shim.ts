// window.fetch を横取りして "/api/..." をクライアント処理に振り替える（standalone 専用）。
// 元アプリのコンポーネント/ライブラリは一切変更しない。
import { handleGeminiUpload, handleOcrPdf } from './gemini-bank-statement'
import {
  handleOcr,
  handleCreditCard,
  handleReceipt,
  handleInvoice,
  handleExpandDescriptions,
} from './gemini-images'
import {
  handleDriveGet,
  handleDrivePost,
  handleDrivePut,
  handleDriveChanges,
  handleDriveStatusGet,
  handleDriveStatusDelete,
  driveLogin,
  getDriveClientId,
  getDriveFolderUrl,
  LS_DRIVE_CLIENT_ID,
  LS_DRIVE_FOLDER,
} from './drive-client'
import { jsonResponse, LS_API_KEY, LS_MODEL, getApiKey, getModel } from './gemini-common'

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return (input as Request).url || ''
}

export function installApiShim() {
  const realFetch = window.fetch.bind(window)

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let u: URL | null = null
    try { u = new URL(urlOf(input), window.location.href) } catch { /* noop */ }
    const path = u ? u.pathname : urlOf(input)
    const method = (init?.method || (typeof input !== 'string' && !(input instanceof URL) ? (input as Request).method : '') || 'GET').toUpperCase()

    // Gemini 系
    if (path === '/api/bank-statement/gemini-upload') return handleGeminiUpload(init)
    if (path === '/api/bank-statement/ocr-pdf') return handleOcrPdf(init)
    if (path === '/api/bank-statement/ocr') return handleOcr(init)
    if (path === '/api/bank-statement/credit-card') return handleCreditCard(init)
    if (path === '/api/bank-statement/receipt') return handleReceipt(init)
    if (path === '/api/bank-statement/invoice') return handleInvoice(init)
    if (path === '/api/bank-statement/expand-descriptions') return handleExpandDescriptions(init)

    // Drive 系
    if (path === '/api/drive') {
      if (method === 'POST') return handleDrivePost(JSON.parse((init?.body as string) || '{}'))
      if (method === 'PUT') return handleDrivePut(JSON.parse((init?.body as string) || '{}'))
      return handleDriveGet(u ? u.searchParams : new URLSearchParams())
    }
    if (path === '/api/drive/changes') return handleDriveChanges(u ? u.searchParams : new URLSearchParams())
    if (path === '/api/drive/status') {
      if (method === 'DELETE') return handleDriveStatusDelete()
      return handleDriveStatusGet()
    }

    // それ以外の /api/... は未対応
    if (path.startsWith('/api/')) {
      return jsonResponse({ error: `単一HTML版では未対応のAPIです（${path}）。` }, 501)
    }

    return realFetch(input, init)
  }

  // DriveSyncButton の <a href="/api/auth/google"> クリックを GIS ログインに振り替える
  document.addEventListener('click', (ev) => {
    const a = (ev.target as HTMLElement)?.closest?.('a[href="/api/auth/google"]') as HTMLAnchorElement | null
    if (!a) return
    ev.preventDefault()
    driveLogin()
  }, true)
}

// ---- 右下「⚙ 設定」ボタン + 設定パネル（standalone専用・既存UIは変更しない） ----
export function installSettingsButton() {
  if (document.getElementById('standalone-settings-btn')) return
  const btn = document.createElement('button')
  btn.id = 'standalone-settings-btn'
  btn.textContent = '⚙ 設定'
  btn.style.cssText =
    'position:fixed;right:12px;bottom:12px;z-index:99999;padding:8px 12px;font-size:12px;' +
    'background:#1f2937;color:#fff;border:none;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.3);cursor:pointer;opacity:.85;'
  btn.onmouseenter = () => (btn.style.opacity = '1')
  btn.onmouseleave = () => (btn.style.opacity = '.85')
  btn.onclick = openSettingsPanel
  document.body.appendChild(btn)
}

function field(label: string, id: string, value: string, placeholder: string, hint: string): string {
  return `<label style="display:block;margin-bottom:12px;font-size:13px;color:#111;">
    <span style="display:block;font-weight:600;margin-bottom:3px;">${label}</span>
    <input id="${id}" type="text" value="${value.replace(/"/g, '&quot;')}" placeholder="${placeholder}"
      style="width:100%;padding:7px 9px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;box-sizing:border-box;" />
    <span style="display:block;color:#6b7280;font-size:11px;margin-top:3px;">${hint}</span>
  </label>`
}

function openSettingsPanel() {
  if (document.getElementById('standalone-settings-ov')) return
  const ov = document.createElement('div')
  ov.id = 'standalone-settings-ov'
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:100000;display:flex;align-items:center;justify-content:center;'
  ov.innerHTML = `
    <div style="background:#fff;border-radius:12px;padding:22px;max-width:520px;width:92%;max-height:86vh;overflow:auto;box-shadow:0 20px 60px rgba(0,0,0,.3);">
      <div style="font-size:16px;font-weight:700;margin-bottom:14px;color:#111;">設定（この端末のブラウザに保存）</div>
      <div style="font-size:12px;font-weight:700;color:#374151;margin:6px 0;">Gemini（OCR）</div>
      ${field('Gemini API キー', 'set-gemini-key', getApiKey(), 'AIza...', 'Google AI Studio で取得したキー')}
      ${field('Gemini モデル（任意）', 'set-gemini-model', getModel(''), 'gemini-2.5-flash', '空欄なら gemini-2.5-flash')}
      <div style="font-size:12px;font-weight:700;color:#374151;margin:14px 0 6px;border-top:1px solid #e5e7eb;padding-top:12px;">Google Drive（保存・同期）</div>
      ${field('OAuth クライアントID', 'set-drive-client', getDriveClientId(), 'xxxx.apps.googleusercontent.com', 'Google Cloud Console で発行。承認済みJavaScript生成元に ' + window.location.origin + ' を登録')}
      ${field('保存先フォルダURL（任意）', 'set-drive-folder', getDriveFolderUrl(), 'https://drive.google.com/drive/folders/XXXX', '空欄ならマイドライブ直下に「事務所アプリ共有データ」を作成')}
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px;">
        <button id="set-cancel" style="padding:8px 16px;font-size:13px;border:1px solid #cbd5e1;background:#fff;border-radius:6px;cursor:pointer;">閉じる</button>
        <button id="set-save" style="padding:8px 16px;font-size:13px;border:none;background:#2563eb;color:#fff;border-radius:6px;cursor:pointer;">保存</button>
      </div>
    </div>`
  document.body.appendChild(ov)
  const close = () => ov.remove()
  ov.addEventListener('click', (e) => { if (e.target === ov) close() })
  ;(document.getElementById('set-cancel') as HTMLButtonElement).onclick = close
  ;(document.getElementById('set-save') as HTMLButtonElement).onclick = () => {
    const set = (k: string, id: string) => {
      const v = (document.getElementById(id) as HTMLInputElement).value.trim()
      try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k) } catch { /* ignore */ }
    }
    set(LS_API_KEY, 'set-gemini-key')
    set(LS_MODEL, 'set-gemini-model')
    set(LS_DRIVE_CLIENT_ID, 'set-drive-client')
    set(LS_DRIVE_FOLDER, 'set-drive-folder')
    close()
  }
}
