import type { JournalEntry } from './types'
import { getSelectedClientId } from './client-store'
import { applyCompoundAutoAmounts } from './csv-generator'

function getTempKey(): string {
  const cid = getSelectedClientId()
  return cid ? `bs-temp-csv-${cid}` : 'bs-temp-csv'
}

/** 「同期先へ確実に送れた仕訳のID」。受信で手元の仕訳を消してよいかの判断に使う（下の mergeIncomingTempEntries） */
function pushedIdsKey(cid: string): string {
  return `bs-temp-pushed-${cid}`
}

export function getTempEntries(): JournalEntry[] {
  if (typeof window === 'undefined') return []
  try {
    const stored = localStorage.getItem(getTempKey())
    if (stored) return JSON.parse(stored)
  } catch { /* ignore */ }
  return []
}

/** この端末（このサイト）が localStorage をどれだけ使っているかの概算バイト数 */
function localStorageUsedBytes(): number {
  let n = 0
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k) continue
      n += k.length + (localStorage.getItem(k) || '').length
    }
  } catch { /* ignore */ }
  return n
}

function warnOnce(flag: string, message: string): void {
  const w = window as unknown as Record<string, boolean>
  if (w[flag]) return
  w[flag] = true
  alert(message)
}

/**
 * 一時保存を書き込む。**書けたかどうかを必ず確かめて返す**。
 *
 * 【重要・データ保全】以前は書き込み結果を確かめずに件数を返していたため、
 * 保存に失敗しても画面には増えた件数が出て、少しあとの同期受信で本当の件数に
 * 戻る（＝仕訳が消えたように見える）事故が起きた。ここで必ず読み直して確認する。
 */
export function saveTempEntries(entries: JournalEntry[]): boolean {
  if (typeof window === 'undefined') return false
  const json = JSON.stringify(entries)
  let ok = false
  try {
    localStorage.setItem(getTempKey(), json)
    // 書けたつもりで書けていない環境（容量超過・プライベートモード等）があるので読み直して確認する
    ok = localStorage.getItem(getTempKey()) === json
  } catch (e) {
    console.warn('[temp-store] localStorage save failed', e)
  }
  if (!ok) {
    warnOnce(
      '__bsTempWarned',
      'この端末に一時保存を書き込めませんでした（保存領域の上限、またはブラウザの設定）。\n' +
      `保存しようとした量：約${Math.round(json.length / 1024)}KB／この端末の使用量：約${Math.round(localStorageUsedBytes() / 1024)}KB（上限はおおむね5,000KB）\n` +
      '直前の仕訳は保存されていません。お手数ですが「CSV出力」で一時保存分を書き出して空にしてから、もう一度お試しください。',
    )
    return false
  }

  const cid = getSelectedClientId()
  if (cid) {
    // 一時保存は「ユーザーが押したときだけ」の操作なので、デバウンスせず即時に送る。
    // （1.5秒待つ間に受信が走ると、送信前の古い内容で手元が巻き戻る事故のもとになる）
    import('./firebase-sync')
      .then(async ({ pushNow }) => {
        // 一時的な通信エラーで諦めないよう、間隔を空けて3回まで試す
        let lastErr: unknown = null
        for (let i = 0; i < 3; i++) {
          try {
            await pushNow(cid, 'temp-entries', entries)
            markTempPushed(cid, entries)
            return
          } catch (err) {
            lastErr = err
            await new Promise((r) => setTimeout(r, 1000 * (i + 1)))
          }
        }
        throw lastErr
      })
      .catch((err) => {
        console.warn('[temp-store] push failed', err)
        const msg = err instanceof Error ? err.message : String(err ?? '')
        warnOnce(
          '__bsTempPushWarned',
          '一時保存を同期先（合言葉の部屋）へ送れませんでした。\n' +
          `この端末には${entries.length}件が保存されているので作業は続けられますが、他の端末には反映されていません。\n` +
          '通信状態を確認し、必要なら「CSV出力」で早めに書き出してください。\n\n' +
          `［エラー内容］${msg}\n［送信量］約${Math.round(json.length / 1024)}KB`,
        )
      })
  }
  return true
}

/** 同期先へ送れた仕訳のIDを記録する（受信マージの判断材料） */
function markTempPushed(cid: string, entries: JournalEntry[]): void {
  try {
    localStorage.setItem(pushedIdsKey(cid), JSON.stringify(entries.map((e) => e.id)))
  } catch { /* 記録できなくても、その場合は「未送信扱い＝消さない」側に倒れるので安全 */ }
}

function getPushedIds(cid: string): Set<string> {
  try {
    const raw = localStorage.getItem(pushedIdsKey(cid))
    const arr = raw ? (JSON.parse(raw) as string[]) : []
    return new Set(Array.isArray(arr) ? arr : [])
  } catch { return new Set() }
}

/**
 * 同期受信した一時保存と手元の一時保存を突き合わせる。
 *
 * 受信をそのまま上書きすると、送信前の仕訳（この端末で保存したばかりの分）が消える。
 * そこで「手元にあって受信に無い仕訳」は、**同期先へ送れたことが確認できているものだけ**捨てる。
 *  - 送信済み → 他端末がCSV出力・削除したということなので受信どおり消す
 *  - 未送信   → まだ相手に届いていないだけなので残す（末尾に付け足す）
 */
export function mergeIncomingTempEntries(cid: string, incoming: JournalEntry[]): JournalEntry[] {
  let local: JournalEntry[] = []
  try {
    const raw = localStorage.getItem(`bs-temp-csv-${cid}`)
    if (raw) local = JSON.parse(raw)
  } catch { /* ignore */ }
  if (!Array.isArray(local) || local.length === 0) return incoming
  const incomingIds = new Set(incoming.map((e) => e && e.id))
  const pushed = getPushedIds(cid)
  const keep = local.filter((e) => e && e.id && !incomingIds.has(e.id) && !pushed.has(e.id))
  return keep.length ? [...incoming, ...keep] : incoming
}

export function appendTempEntries(newEntries: JournalEntry[]): number {
  // 複合仕訳の997自動計算を適用してから保存
  const applied = applyCompoundAutoAmounts(newEntries)
  const existing = getTempEntries()
  const merged = [...existing, ...applied]
  saveTempEntries(merged)
  // 実際に保存できた件数を返す（保存に失敗したときに増えた件数を表示しないため）
  return getTempEntries().length
}

export function clearTempEntries(): void {
  if (typeof window === 'undefined') return
  // 【重要】localStorageだけ消すとRTDB側に旧データが残り、同期の受信で復活して
  // 次回の一括CSV出力に前回分が混ざる。空配列を保存してRTDBにも空を反映する。
  // （saveTempEntries が即時pushするので、ここでの追加pushは不要）
  saveTempEntries([])
  const cid = getSelectedClientId()
  if (cid) markTempPushed(cid, [])
}

export function getTempEntryCount(): number {
  return getTempEntries().length
}
