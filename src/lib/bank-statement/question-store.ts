// 仮払金「質問リスト」の蓄積ストア（顧問先ごと）。
// 一時保存(temp)は CSV 出力時にクリアされるため、質問対象の仮払金は
// 別途このストアに溜めておき、月内のどのタイミングでも質問リストを出力できるようにする。
// Drive 同期対象（STORAGE_KEY_MAP の 'questions'）。

import type { JournalEntry } from './types'
import { getSelectedClientId } from './client-store'

function getKey(): string {
  const cid = getSelectedClientId()
  return cid ? `bs-questions-${cid}` : 'bs-questions'
}

export function getQuestionItems(): JournalEntry[] {
  if (typeof window === 'undefined') return []
  try {
    const s = localStorage.getItem(getKey())
    if (s) return JSON.parse(s)
  } catch { /* ignore */ }
  return []
}

export function saveQuestionItems(items: JournalEntry[]): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(getKey(), JSON.stringify(items))
  const cid = getSelectedClientId()
  if (cid) {
    import('./drive-sync').then(({ schedulePushToDrive }) => {
      schedulePushToDrive(cid, 'questions', items)
    })
  }
}

/** 質問対象の仮払金エントリを追記（id重複は除外） */
export function addQuestionItems(entries: JournalEntry[]): void {
  if (!entries || entries.length === 0) return
  const existing = getQuestionItems()
  const seen = new Set(existing.map((e) => e.id))
  const merged = [...existing]
  for (const e of entries) {
    if (!seen.has(e.id)) { merged.push(e); seen.add(e.id) }
  }
  saveQuestionItems(merged)
}

/** 蓄積をクリア（顧問先へ送付済みのとき） */
export function clearQuestionItems(): void {
  saveQuestionItems([])
}

export function getQuestionItemCount(): number {
  return getQuestionItems().length
}
