// 数値表示ヘルパー（社長にも分かりやすい単位で表示する）

export function fmtYen(n: number): string {
  const sign = n < 0 ? '-' : ''
  return `${sign}¥${Math.abs(Math.round(n)).toLocaleString('ja-JP')}`
}

/** 億・万を使った読みやすい表記。例: 621075347 -> "6.2億", 15400000 -> "1,540万" */
export function fmtShort(n: number): string {
  const sign = n < 0 ? '-' : ''
  const a = Math.abs(n)
  if (a >= 100000000) {
    const oku = a / 100000000
    return `${sign}${oku >= 10 ? Math.round(oku).toLocaleString() : oku.toFixed(1)}億`
  }
  if (a >= 10000) {
    return `${sign}${Math.round(a / 10000).toLocaleString()}万`
  }
  return `${sign}${Math.round(a).toLocaleString()}`
}

export function fmtPct(n: number, digits = 1): string {
  return `${n.toFixed(digits)}%`
}

/** 前年比などの符号付き%。null は「—」 */
export function fmtPctSigned(n: number | null, digits = 1): string {
  if (n == null || !isFinite(n)) return '—'
  const s = n >= 0 ? '+' : ''
  return `${s}${n.toFixed(digits)}%`
}
