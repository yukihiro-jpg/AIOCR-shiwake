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
