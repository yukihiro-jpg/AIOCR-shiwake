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
      serverOffsetMs = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => { off(); reject(new Error('timeout')) }, 8000)
        const off = onValue(
          ref(db, '.info/serverTimeOffset'),
          (snap) => { clearTimeout(timer); off(); resolve(Number(snap.val()) || 0) },
          (err) => { clearTimeout(timer); reject(err) },
        )
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
