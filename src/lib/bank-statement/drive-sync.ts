// Drive同期のクライアント側ヘルパー（UIから直接呼び出し可能）

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

  const res = await fetch('/api/drive', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error || 'Drive upload failed')
  }
  const result = await res.json()
  return result.count || 0
}

/**
 * 選択中の顧問先のデータをDriveから読み込む
 */
export async function downloadClientFromDrive(clientId: string, clientName: string | null): Promise<number> {
  let downloaded = 0

  // 顧問先一覧も取得
  const globalRes = await fetch('/api/drive?clientId=_global&key=clients')
  if (globalRes.ok) {
    const { data } = await globalRes.json()
    if (data && Array.isArray(data)) {
      localStorage.setItem('bank-statement-clients', JSON.stringify(data))
      downloaded++
    }
  }

  const nameParam = clientName ? `&clientName=${encodeURIComponent(clientName)}` : ''
  for (const key of STORAGE_KEYS) {
    try {
      const res = await fetch(`/api/drive?clientId=${encodeURIComponent(clientId)}${nameParam}&key=${encodeURIComponent(key)}`)
      if (!res.ok) continue
      const { data } = await res.json()
      if (data != null) {
        const storageKey = STORAGE_KEY_MAP[key](clientId)
        localStorage.setItem(storageKey, JSON.stringify(data))
        downloaded++
      }
    } catch { /* skip */ }
  }
  return downloaded
}

/** Drive連携ステータスを確認 */
export async function getDriveConnected(): Promise<boolean> {
  try {
    const res = await fetch('/api/drive/status')
    if (!res.ok) return false
    const data = await res.json()
    return !!data.connected
  } catch { return false }
}
