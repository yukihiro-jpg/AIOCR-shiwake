// 勘定科目の使用履歴（顧問先ごと）。ユーザーが過去に選んだ科目を「よく使う科目」として
// 候補の上部に優先表示するために使う。端末内 localStorage に保存（顧問先ごとに分離）。

function key(clientId: string): string {
  return `bs-${clientId || 'default'}-acc-usage`
}

type UsageMap = Record<string, number>

export function getAccountUsage(clientId: string): UsageMap {
  if (typeof window === 'undefined') return {}
  try {
    const raw = localStorage.getItem(key(clientId))
    if (raw) {
      const o = JSON.parse(raw)
      if (o && typeof o === 'object') return o as UsageMap
    }
  } catch { /* ignore */ }
  return {}
}

/** 科目コードの使用を1回分記録する */
export function recordAccountUse(clientId: string, code: string): void {
  if (typeof window === 'undefined') return
  const c = String(code || '').trim()
  if (!c) return
  try {
    const m = getAccountUsage(clientId)
    m[c] = (m[c] || 0) + 1
    localStorage.setItem(key(clientId), JSON.stringify(m))
  } catch { /* ignore */ }
}

/** 使用回数の多い順に科目コードを返す（よく使う科目） */
export function getFrequentCodes(clientId: string, limit = 8): string[] {
  const m = getAccountUsage(clientId)
  return Object.keys(m)
    .filter((c) => m[c] > 0)
    .sort((a, b) => m[b] - m[a])
    .slice(0, limit)
}
