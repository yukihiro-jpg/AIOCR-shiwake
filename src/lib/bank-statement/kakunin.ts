// 仕訳作成（会計入力）中に、選択中の顧問先へ「確認・依頼メモ」を1件追加する。
// 保存先は顧問先情報（komon）と共有の Firebase ノード kakunin/{顧問先キー}。
// 顧問先キーは仕訳作成の選択中クライアントID（= clients_v2 のキー = komon の shiwakeClientId）。

import { getDb } from '@/core/firebase'
import { modulePath, hasRoom } from '@/core/room'

export type KakuninKind = '確認' | '質問' | '資料'

export async function addKakuninItem(clientKey: string, kind: KakuninKind, text: string): Promise<void> {
  const t = (text || '').trim()
  if (!hasRoom()) throw new Error('合言葉（同期）が未設定です。ホーム画面で設定してください')
  if (!clientKey || !t) throw new Error('顧問先または内容が未設定です')
  const { ref, runTransaction } = await import('firebase/database')
  const db = await getDb()
  const r = ref(db, await modulePath('kakunin', clientKey))
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
  const createdAt = new Date().toISOString().slice(0, 10)
  // 【設計ルール】get→set の read-modify-write は同時追加で片方が消えるため、
  // 必ず runTransaction で原子的に追記する（komon側の編集とも共存できる）。
  await runTransaction(r, (cur) => {
    const list = Array.isArray(cur) ? cur.filter(Boolean) : Object.values(cur || {})
    list.push({ id, kind, text: t, status: 'open', createdAt })
    return list
  })
}
