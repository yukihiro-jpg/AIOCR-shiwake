import { getSelectedClientId } from './client-store'

export interface ProcessingStatus {
  accountCode: string
  accountName: string
  lastDate: string       // YYYYMMDD の最終取引日
  lastUpdated: string    // ISO タイムスタンプ（この状態が更新された日時）
  transactionCount?: number
  // 進捗管理用
  docType?: string       // 種別（通帳/現金出納帳/ｸﾚｼﾞｯﾄ/賃金台帳等）
  bankName?: string      // 銀行名
  accountType?: string   // 口座種類（普通/当座等）
  accountNumber?: string // 口座番号
  receiveMethod?: string // 受取方法（紙コピー/PDF/CSV）
  monthlyProgress?: Record<string, string>  // "YYYY-MM" → 最終処理日 "DD"
}

function getKey(): string {
  const cid = getSelectedClientId()
  return cid ? `bank-statement-client-${cid}-processing-status` : 'bank-statement-processing-status'
}

export function getProcessingStatuses(): ProcessingStatus[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(getKey())
    if (raw) return JSON.parse(raw)
  } catch { /* ignore */ }
  return []
}

export function saveProcessingStatuses(statuses: ProcessingStatus[]): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(getKey(), JSON.stringify(statuses))
}

/**
 * 1つの科目の最終処理日を更新。既存より新しい日付の場合のみ上書き。
 */
export function updateProcessingStatus(
  accountCode: string,
  accountName: string,
  dates: string[],
  transactionCount?: number,
): void {
  if (!accountCode || dates.length === 0) return
  const latestDate = dates.reduce((a, b) => (a > b ? a : b))
  const statuses = getProcessingStatuses()
  const idx = statuses.findIndex((s) => s.accountCode === accountCode)
  const now = new Date().toISOString()

  // 月別進捗を計算（各月の最終日を記録）
  const monthlyUpdates: Record<string, string> = {}
  for (const d of dates) {
    if (d.length < 8) continue
    const ym = `${d.slice(0, 4)}-${d.slice(4, 6)}`
    const day = d.slice(6, 8)
    if (!monthlyUpdates[ym] || day > monthlyUpdates[ym]) monthlyUpdates[ym] = day
  }

  if (idx >= 0) {
    if (latestDate > statuses[idx].lastDate) {
      statuses[idx].lastDate = latestDate
    }
    statuses[idx].accountName = accountName || statuses[idx].accountName
    statuses[idx].lastUpdated = now
    if (transactionCount != null) statuses[idx].transactionCount = transactionCount
    // 月別進捗をマージ
    const existing = statuses[idx].monthlyProgress || {}
    for (const [ym, day] of Object.entries(monthlyUpdates)) {
      if (!existing[ym] || day > existing[ym]) existing[ym] = day
    }
    statuses[idx].monthlyProgress = existing
  } else {
    statuses.push({ accountCode, accountName, lastDate: latestDate, lastUpdated: now, transactionCount, monthlyProgress: monthlyUpdates })
  }
  saveProcessingStatuses(statuses)
}

export function updateStatusDetail(
  accountCode: string,
  detail: { docType?: string; bankName?: string; accountType?: string; accountNumber?: string },
): void {
  const statuses = getProcessingStatuses()
  const idx = statuses.findIndex((s) => s.accountCode === accountCode)
  if (idx >= 0) {
    Object.assign(statuses[idx], detail)
    saveProcessingStatuses(statuses)
  }
}

// YYYYMMDD → YYYY/MM/DD
export function formatLastDate(yyyymmdd: string): string {
  if (!yyyymmdd || yyyymmdd.length !== 8) return yyyymmdd
  return `${yyyymmdd.slice(0, 4)}/${yyyymmdd.slice(4, 6)}/${yyyymmdd.slice(6, 8)}`
}
