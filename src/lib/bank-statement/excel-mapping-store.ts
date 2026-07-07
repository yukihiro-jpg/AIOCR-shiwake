// 列マッピング学習の保存。
// 顧問先ごとに1キー（bs-excel-mapping-{cid}）へ「科目CD → マッピング」のオブジェクトで保存する。
// これにより STORAGE_KEY_MAP の 'excel-mapping' として Firebase同期／ZIPバックアップの対象にできる。
// 旧形式（科目CDごとに個別キー bs-excel-mapping-{cid}-{accountCode}）は読み込み時に移行する。

import type { ColumnMapping } from './types'

const keyOf = (cid: string) => `bs-excel-mapping-${cid}`
const legacyKeyOf = (cid: string, accountCode: string) => `bs-excel-mapping-${cid}-${accountCode}`

function loadAll(cid: string): Record<string, ColumnMapping> {
  try {
    const raw = localStorage.getItem(keyOf(cid))
    if (raw) return (JSON.parse(raw) as Record<string, ColumnMapping>) || {}
  } catch { /* ignore */ }
  return {}
}

export function saveExcelMapping(cid: string, accountCode: string, mapping: ColumnMapping): void {
  if (!accountCode) return
  try {
    const all = loadAll(cid)
    all[accountCode] = mapping
    localStorage.setItem(keyOf(cid), JSON.stringify(all))
    // 他端末へも配信（受信は firebase-sync の STORAGE_KEY_MAP 経由）。push を忘れると受信専用になる
    if (cid) {
      import('./firebase-sync').then((m) => m.schedulePushToFirebase(cid, 'excel-mapping', all)).catch(() => { /* ignore */ })
    }
  } catch { /* ignore */ }
}

export function loadExcelMapping(cid: string, accountCode: string): ColumnMapping | undefined {
  if (!accountCode) return undefined
  const all = loadAll(cid)
  if (all[accountCode]) return all[accountCode]
  // 旧形式（個別キー）からの後方互換読み込み＋新形式への移行
  try {
    const raw = localStorage.getItem(legacyKeyOf(cid, accountCode))
    if (raw) {
      const m = JSON.parse(raw) as ColumnMapping
      saveExcelMapping(cid, accountCode, m)
      return m
    }
  } catch { /* ignore */ }
  return undefined
}
