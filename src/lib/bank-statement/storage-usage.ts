// この端末（ブラウザ）の保存領域 localStorage の使用量と、満杯のときの説明文。
//
// localStorage はサイト全体（仕訳作成・相続管理・月次レポートなど全モジュール）で
// 共有の約5MBしかない。満杯になると書き込みが例外で止まり、ボタンを押しても
// 「何も起きない」ように見える。黙って止まらないよう、失敗した操作には
// ここで作った文面を出して、何が場所を取っているかまで伝える。

/** 使用量（文字数）。キー名＋値の合計 */
export function localStorageUsedChars(): number {
  let n = 0
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k) continue
      n += k.length + (localStorage.getItem(k) || '').length
    }
  } catch { /* 読めない環境では0 */ }
  return n
}

/** 容量超過の例外か（ブラウザごとに名前が違う） */
export function isQuotaError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false
  const name = (e as { name?: string }).name || ''
  const code = (e as { code?: number }).code
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED' || code === 22 || code === 1014
}

/** 大きいものから上位n件（キー名と大きさKB） */
function largestKeys(n: number): string[] {
  const rows: { k: string; size: number }[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k) continue
      rows.push({ k, size: k.length + (localStorage.getItem(k) || '').length })
    }
  } catch { return [] }
  return rows.sort((a, b) => b.size - a.size).slice(0, n)
    .map((r) => `・${r.k}（約${Math.round(r.size / 1024)}KB）`)
}

/** 保存領域が満杯で書けなかったときの説明文 */
export function storageFullMessage(what: string): string {
  return `${what}を、この端末に保存できませんでした（ブラウザの保存領域がいっぱいです）。\n` +
    `使用量：約${Math.round(localStorageUsedChars() / 1024)}KB（上限はおおむね5,000KB。全モジュール共通）\n\n` +
    '大きいもの：\n' + largestKeys(5).join('\n') + '\n\n' +
    '「一時保存」がたまっている場合は、CSV出力で書き出して空にすると空きができます。'
}
