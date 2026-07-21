import type { JournalEntry } from './types'
import { getSelectedClientId } from './client-store'
import { applyCompoundAutoAmounts } from './csv-generator'

function getTempKey(): string {
  const cid = getSelectedClientId()
  return cid ? `bs-temp-csv-${cid}` : 'bs-temp-csv'
}

export function getTempEntries(): JournalEntry[] {
  if (typeof window === 'undefined') return []
  try {
    const stored = localStorage.getItem(getTempKey())
    if (stored) return JSON.parse(stored)
  } catch { /* ignore */ }
  return []
}

export function saveTempEntries(entries: JournalEntry[]): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(getTempKey(), JSON.stringify(entries))
  const cid = getSelectedClientId()
  if (cid) {
    import('./firebase-sync')
      .then(({ schedulePushToFirebase }) => schedulePushToFirebase(cid, 'temp-entries', entries))
      .catch(() => { /* firebase 未設定なら無視 */ })
  }
}

export function appendTempEntries(newEntries: JournalEntry[]): number {
  // 複合仕訳の997自動計算を適用してから保存
  const applied = applyCompoundAutoAmounts(newEntries)
  const existing = getTempEntries()
  const merged = [...existing, ...applied]
  saveTempEntries(merged)
  return merged.length
}

export function clearTempEntries(): void {
  if (typeof window === 'undefined') return
  // 【重要】localStorageだけ消すとRTDB側に旧データが残り、同期の受信で復活して
  // 次回の一括CSV出力に前回分が混ざる。空配列を保存してRTDBにも空を反映する。
  saveTempEntries([])
  // saveTempEntries のpushは1.5秒デバウンスされるため、その間にタブを閉じると
  // RTDBに旧データが残って次回復活する。クリアだけはデバウンスを待たず即時送信する。
  const cid = getSelectedClientId()
  if (cid) {
    import('./firebase-sync')
      .then(({ pushNow }) => pushNow(cid, 'temp-entries', []))
      .catch(() => { /* firebase 未設定なら無視 */ })
  }
}

export function getTempEntryCount(): number {
  return getTempEntries().length
}
