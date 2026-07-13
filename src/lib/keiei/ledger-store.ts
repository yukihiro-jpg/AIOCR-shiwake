// 総勘定元帳データの保存（IndexedDB・端末ローカル）。
// 元帳は1期あたり数千〜数万行と大きく、RTDBに載せると容量・通信量が膨らむため
// インボイス登録番号簿と同じ方針で「各PCで取込・同期しない」意図的ローカル保存とする。
// 元CSVは顧問先の会計データから何度でも出力できるため、消えても再取込で復元可能。

import type { LedgerData } from './ledger'

const DB_NAME = 'keiei-ledger'
const STORE = 'ledgers'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

const key = (clientId: string, yearId: string) => `${clientId}|${yearId}`

export async function saveLedger(clientId: string, yearId: string, data: LedgerData): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(data, key(clientId, yearId))
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  db.close()
}

export async function loadLedger(clientId: string, yearId: string): Promise<LedgerData | null> {
  const db = await openDb()
  const out = await new Promise<LedgerData | null>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(key(clientId, yearId))
    req.onsuccess = () => resolve((req.result as LedgerData) || null)
    req.onerror = () => reject(req.error)
  })
  db.close()
  return out
}

/** この顧問先の保存済み元帳を一覧する（会計監査用） */
export async function listLedgers(clientId: string): Promise<{ yearId: string; data: LedgerData }[]> {
  const db = await openDb()
  const out = await new Promise<{ yearId: string; data: LedgerData }[]>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const store = tx.objectStore(STORE)
    const req = store.getAllKeys()
    req.onsuccess = () => {
      const keys = (req.result as string[]).filter((k) => typeof k === 'string' && k.startsWith(clientId + '|'))
      const items: { yearId: string; data: LedgerData }[] = []
      let remain = keys.length
      if (!remain) { resolve([]); return }
      for (const k of keys) {
        const g = store.get(k)
        g.onsuccess = () => {
          if (g.result) items.push({ yearId: String(k).slice(clientId.length + 1), data: g.result as LedgerData })
          if (--remain === 0) resolve(items)
        }
        g.onerror = () => { if (--remain === 0) resolve(items) }
      }
    }
    req.onerror = () => reject(req.error)
  })
  db.close()
  out.sort((a, b) => (a.data.minDate || '').localeCompare(b.data.minDate || ''))
  return out
}

export async function deleteLedger(clientId: string, yearId: string): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(key(clientId, yearId))
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  db.close()
}
