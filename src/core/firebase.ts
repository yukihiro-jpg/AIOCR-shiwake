// 共通コア: Firebase 初期化 + 匿名認証（総合アプリの全モジュール共通）。
// initializeApp は1回だけ。getDb() で匿名サインイン済みの RTDB を返す。

import { firebaseConfig } from '@/lib/bank-statement/firebase-config'

type DbType = import('firebase/database').Database
let appPromise: Promise<DbType> | null = null

export async function getDb(): Promise<DbType> {
  if (typeof window === 'undefined') throw new Error('NO_WINDOW')
  if (appPromise) return appPromise
  appPromise = (async () => {
    const { initializeApp, getApps } = await import('firebase/app')
    const { getAuth, signInAnonymously } = await import('firebase/auth')
    const { getDatabase } = await import('firebase/database')
    const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig)
    const auth = getAuth(app)
    if (!auth.currentUser) {
      await signInAnonymously(auth)
    }
    return getDatabase(app)
  })()
  return appPromise
}

// ---- サーバー時刻 ----
// 保存期限による自動削除（共有フォルダ1年/4年・年調1年6か月）の基準時刻に使う。
// 端末の時計だけを信じると、日付が未来にずれたPCで開いた瞬間に期限内のデータまで
// 削除されてしまうため、Firebase のサーバー時刻とのずれ（.info/serverTimeOffset）で補正する。
let serverOffsetMs: number | null = null

/** サーバー時刻（ms）。取得できなければ null（＝削除処理は見送るべき） */
export async function serverNow(): Promise<number | null> {
  if (typeof window === 'undefined') return null
  if (serverOffsetMs == null) {
    try {
      const db = await getDb()
      const { ref, onValue } = await import('firebase/database')
      // 【注意】.info の値が既にあると、onValue は登録の途中で（戻り値を返す前に）コールバックを
      // 同期的に呼ぶ。コールバック内で戻り値（解除関数）を直接使うと未初期化で例外になり、
      // resolve されず・タイマーも止まった状態で永久に待ってしまう（年調の送信が
      // 「送信しています…」のまま進まなかった原因）。解除は登録が終わってから行う。
      serverOffsetMs = await new Promise<number>((resolve, reject) => {
        let off: (() => void) | null = null
        let settled = false
        const settle = (fn: () => void) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          fn()
          // 同期コールバックのときは off がまだ無いので、登録が終わった直後に解除する
          setTimeout(() => { try { off?.() } catch { /* ignore */ } }, 0)
        }
        const timer = setTimeout(() => settle(() => reject(new Error('timeout'))), 8000)
        off = onValue(
          ref(db, '.info/serverTimeOffset'),
          (snap) => settle(() => resolve(Number(snap.val()) || 0)),
          (err) => settle(() => reject(err)),
        )
        if (settled) { try { off() } catch { /* ignore */ } }
      })
    } catch {
      return null
    }
  }
  return Date.now() + serverOffsetMs
}

/** 端末の時計がサーバーと1日以上ずれているか（表示の注意喚起などに使う） */
export async function clockSkewMs(): Promise<number | null> {
  const now = await serverNow()
  return now == null ? null : now - Date.now()
}
