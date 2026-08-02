// 口コミ依頼ページ（相続人向け）の公開データ読み取り。
// URLに載るのはランダムトークンだけ（roomKey・合言葉は絶対に載せない）。
// 公開ノードには「文章づくりに使う特徴フラグ」しか置かない（氏名・金額・人数は保存しない）。

import { getDb } from '@/core/firebase'
import type { ReviewFlags } from './draft'

export const SOUZOKU_REVIEW_ROOT = 'souzoku-review'
/** 発行から6か月で自動失効（事務所側の掃除が実削除を行う） */
export const REVIEW_RETENTION_DAYS = 183

export interface ReviewPublic {
  officeName: string
  reviewUrl: string
  flags: ReviewFlags
  expiresAt: string
}

async function dbfns() {
  const db = await getDb()
  const { ref, get } = await import('firebase/database')
  return { db, ref, get }
}

/** トークンから公開情報を読む。無効・期限切れなら null */
export async function loadReviewPublic(token: string): Promise<ReviewPublic | null> {
  if (!token || !/^[0-9a-f]{16,64}$/.test(token)) return null
  const { db, ref, get } = await dbfns()
  const snap = await get(ref(db, `${SOUZOKU_REVIEW_ROOT}/${token}`))
  const v = snap.val() as (ReviewPublic & { expiresAt?: string }) | null
  if (!v || !v.reviewUrl) return null
  if (v.expiresAt && Date.parse(v.expiresAt) < Date.now()) return null
  return {
    officeName: v.officeName || '',
    reviewUrl: v.reviewUrl,
    flags: v.flags || {},
    expiresAt: v.expiresAt || '',
  }
}
