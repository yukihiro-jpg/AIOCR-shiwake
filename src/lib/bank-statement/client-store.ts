export type TaxType = 'exempt' | 'standard' | 'simplified'

export interface Client {
  id: string
  name: string
  createdAt: string
  taxType?: TaxType
  fiscalYearEndMonth?: number  // 決算月（1-12、例: 3月決算=3）
  lastCsvExportAt?: string      // 最も直近に仕訳CSVを出力した日時(ISO)。全ユーザー横断で共有。
}

const CLIENTS_KEY = 'bank-statement-clients'
const SELECTED_CLIENT_KEY = 'bank-statement-selected-client'

export function getClients(): Client[] {
  if (typeof window === 'undefined') return []
  try {
    const stored = localStorage.getItem(CLIENTS_KEY)
    if (stored) return JSON.parse(stored)
  } catch { /* ignore */ }
  return []
}

export function saveClients(clients: Client[]): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(CLIENTS_KEY, JSON.stringify(clients))
  // 顧問先一覧を Firebase（合言葉設定時）へ id マージで反映 → 他端末の顧問先は消えない
  import('./firebase-sync')
    .then(({ scheduleClientsPush }) => scheduleClientsPush(clients))
    .catch(() => { /* firebase 未設定なら無視 */ })
}

export function addClient(name: string): Client {
  const clients = getClients()
  const client: Client = {
    id: `client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    createdAt: new Date().toISOString(),
  }
  clients.push(client)
  saveClients(clients)
  return client
}

export function deleteClient(id: string): void {
  const clients = getClients().filter((c) => c.id !== id)
  saveClients(clients)
  // 関連データも削除
  if (typeof window !== 'undefined') {
    localStorage.removeItem(`bs-accounts-${id}`)
    localStorage.removeItem(`bs-sub-accounts-${id}`)
    localStorage.removeItem(`bs-patterns-${id}`)
  }
  // Firebase 側の該当顧問先も明示的に削除（マージ方式では消去は明示が必要）
  import('./firebase-sync')
    .then(({ removeClientFromFirebase }) => removeClientFromFirebase(id))
    .catch(() => { /* firebase 未設定なら無視 */ })
}

export function updateClient(id: string, updates: Partial<Client>): void {
  const clients = getClients()
  const idx = clients.findIndex((c) => c.id === id)
  if (idx >= 0) {
    clients[idx] = { ...clients[idx], ...updates }
    saveClients(clients)
  }
}

/**
 * 仕訳CSV出力日を記録（既存よりも新しい場合のみ更新）。
 * saveClients 経由で Firebase(clients_v2) にも反映され、全ユーザー横断で最新化される。
 */
export function recordCsvExport(clientId: string, when: Date = new Date()): void {
  const clients = getClients()
  const idx = clients.findIndex((c) => c.id === clientId)
  if (idx < 0) return
  const iso = when.toISOString()
  const prev = clients[idx].lastCsvExportAt
  if (prev && prev >= iso) return
  clients[idx] = { ...clients[idx], lastCsvExportAt: iso }
  saveClients(clients)
}

export function getSelectedClientId(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem(SELECTED_CLIENT_KEY)
}

export function setSelectedClientId(id: string | null): void {
  if (typeof window === 'undefined') return
  if (id) localStorage.setItem(SELECTED_CLIENT_KEY, id)
  else localStorage.removeItem(SELECTED_CLIENT_KEY)
}

// --- 顧問先別ストレージキー ---
export function clientStorageKey(clientId: string, type: 'accounts' | 'sub-accounts' | 'patterns'): string {
  return `bs-${type}-${clientId}`
}
