import { getSelectedClientId } from './client-store'

export interface FixedJournalLine {
  debitCode: string
  debitName: string
  debitSubCode?: string
  debitSubName?: string
  creditCode: string
  creditName: string
  creditSubCode?: string
  creditSubName?: string
  taxCode?: string
  taxType: string
  amount: number
}

export interface FixedJournalEntry {
  id: string
  lines: FixedJournalLine[]
  description: string
}

function getKey(): string {
  const cid = getSelectedClientId()
  return cid ? `bs-fixed-journals-${cid}` : 'bs-fixed-journals'
}

export function getFixedJournals(): FixedJournalEntry[] {
  if (typeof window === 'undefined') return []
  try {
    const stored = localStorage.getItem(getKey())
    if (stored) {
      const parsed = JSON.parse(stored)
      // 旧形式互換
      return parsed.map((p: FixedJournalEntry) => {
        if (!p.lines) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const old = p as any
          p.lines = [{
            debitCode: old.debitCode || '', debitName: old.debitName || '',
            creditCode: old.creditCode || '', creditName: old.creditName || '',
            taxType: old.taxType || '', amount: old.amount || 0,
          }]
        }
        return p
      })
    }
  } catch { /* ignore */ }
  return []
}

export function saveFixedJournals(items: FixedJournalEntry[]): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(getKey(), JSON.stringify(items))
}

export function addFixedJournal(entry: Omit<FixedJournalEntry, 'id'>): FixedJournalEntry {
  const items = getFixedJournals()
  const newItem: FixedJournalEntry = {
    ...entry,
    id: `fj-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  }
  items.push(newItem)
  saveFixedJournals(items)
  return newItem
}

export function deleteFixedJournal(id: string): void {
  const items = getFixedJournals().filter((i) => i.id !== id)
  saveFixedJournals(items)
}

export function updateFixedJournal(id: string, update: Omit<FixedJournalEntry, 'id'>): void {
  const items = getFixedJournals()
  const idx = items.findIndex((i) => i.id === id)
  if (idx >= 0) {
    items[idx] = { ...items[idx], ...update }
    saveFixedJournals(items)
  }
}
