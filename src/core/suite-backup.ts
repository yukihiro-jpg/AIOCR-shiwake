// 全データバックアップ: 合言葉の部屋（rooms/{roomKey}）配下の全モジュールデータを
// JSONでダウンロード／復元する。アプリの不具合・誤操作・Firebaseアカウント問題に備えた
// 「第二の保険」（第一はFirebaseコンソールの自動バックアップ）。
// 【厳守】バックアップファイルに roomKey・合言葉を含めない（復元は開いている部屋に対して行う）。
//
// 注意: Firebase Storage の画像・ファイル実体（書類スキャン受信・年調の提出画像）は
// 含まれない。それらの退避は各画面のZIP一括DL／Driveへ保存を使う。

import { getDb } from '@/core/firebase'
import { roomKey, hasRoom } from '@/core/room'

const LAST_BACKUP_KEY = 'suite-last-backup-at'

export interface SuiteBackupFile {
  app: 'aiocr-shiwake-suite'
  kind: 'room-backup'
  version: 1
  exportedAt: string
  modules: string[]
  data: Record<string, unknown>
}

export function getSuiteLastBackupAt(): Date | null {
  if (typeof window === 'undefined') return null
  const v = localStorage.getItem(LAST_BACKUP_KEY)
  if (!v) return null
  const d = new Date(v)
  return isNaN(d.getTime()) ? null : d
}

function markBackedUp() {
  try {
    localStorage.setItem(LAST_BACKUP_KEY, new Date().toISOString())
    // 仕訳作成ヘッダーの「前回バックアップ」表示も更新させる
    window.dispatchEvent(new Event('bs-backup-updated'))
  } catch { /* ignore */ }
}

async function fetchRoomData(): Promise<Record<string, unknown>> {
  const db = await getDb()
  const { ref, get } = await import('firebase/database')
  const key = await roomKey()
  const snap = await get(ref(db, `rooms/${key}`))
  return (snap.val() as Record<string, unknown>) || {}
}

function downloadJson(obj: unknown, fileName: string) {
  const blob = new Blob([JSON.stringify(obj)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = fileName
  a.click()
  URL.revokeObjectURL(a.href)
}

function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`
}

/** 部屋の全データをJSONファイルとしてダウンロードする。戻り値はモジュール一覧 */
export async function exportSuiteBackup(): Promise<string[]> {
  if (!hasRoom()) throw new Error('合言葉が設定されていません')
  const data = await fetchRoomData()
  const modules = Object.keys(data)
  if (!modules.length) throw new Error('バックアップ対象のデータがありません（この合言葉の部屋は空です）')
  const file: SuiteBackupFile = {
    app: 'aiocr-shiwake-suite',
    kind: 'room-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    modules,
    data,
  }
  downloadJson(file, `業務総合アプリ_全データバックアップ_${stamp()}.json`)
  markBackedUp()
  return modules
}

/** バックアップファイルを読み込んで検証する（まだ書き込まない） */
export async function readSuiteBackupFile(file: File): Promise<SuiteBackupFile> {
  const text = await file.text()
  let obj: SuiteBackupFile
  try {
    obj = JSON.parse(text)
  } catch {
    throw new Error('JSONとして読み込めませんでした')
  }
  if (obj?.app !== 'aiocr-shiwake-suite' || obj?.kind !== 'room-backup' || !obj?.data || typeof obj.data !== 'object') {
    throw new Error('このアプリの全データバックアップファイルではありません')
  }
  return obj
}

/** 復元（部屋全体を上書き）。直前に現在のデータを自動ダウンロードして退避する */
export async function restoreSuiteBackup(backup: SuiteBackupFile): Promise<void> {
  if (!hasRoom()) throw new Error('合言葉が設定されていません')
  // 巻き戻しすぎた場合に戻れるよう、上書き前の現状を必ず控える
  try {
    const cur = await fetchRoomData()
    if (Object.keys(cur).length) {
      downloadJson(
        { app: 'aiocr-shiwake-suite', kind: 'room-backup', version: 1, exportedAt: new Date().toISOString(), modules: Object.keys(cur), data: cur } satisfies SuiteBackupFile,
        `復元前の自動控え_${stamp()}.json`,
      )
    }
  } catch { /* 現状取得に失敗しても復元自体は続行 */ }
  const db = await getDb()
  const { ref, set } = await import('firebase/database')
  const key = await roomKey()
  await set(ref(db, `rooms/${key}`), backup.data)
  markBackedUp()
}
