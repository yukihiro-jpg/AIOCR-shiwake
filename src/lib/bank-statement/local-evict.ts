// 他の顧問先の学習パターンを「この端末から」外した記録。
//
// localStorage はサイト全体で約5MBしかなく、顧問先を開くたびにその顧問先の学習パターン
// （1社200〜300KB）が端末に残っていくので、顧問先が増えると満杯になって一時保存ができなくなる。
// 同期先（合言葉の部屋）に同じ内容があることを確かめた顧問先だけ端末から外し（firebase-sync の
// evictOtherClientsPatterns）、その顧問先を開いたときに同期の受信で戻す。
//
// 【重要・データ保全】外したあと、受信で戻る前に学習を保存すると「新しい1件だけ」で同期先の
// 全パターンを上書きしてしまう。この記録がある間は savePatterns が保存を止める。

const KEY = 'bs-evicted-patterns'

function read(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]')
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
  } catch { return [] }
}
function write(ids: string[]): void {
  try {
    if (ids.length) localStorage.setItem(KEY, JSON.stringify(ids))
    else localStorage.removeItem(KEY)
  } catch { /* 記録できないときは外す側（evict）で中止する */ }
}

export function isPatternsEvicted(cid: string): boolean {
  if (typeof window === 'undefined' || !cid) return false
  return read().includes(cid)
}
export function markPatternsEvicted(cid: string): boolean {
  const ids = read()
  if (!ids.includes(cid)) write([...ids, cid])
  return read().includes(cid)
}
export function unmarkPatternsEvicted(cid: string): void {
  const ids = read()
  if (ids.includes(cid)) write(ids.filter((x) => x !== cid))
}
