// 元帳の読み込み（移植したビューア用）。
//
// 【入口はひとつ】
// 移植元は元帳を Firestore に分割保存していたが、この総合管理アプリには
// 元から元帳の取込・保存がある（src/lib/keiei/ledger.ts で解析し、
// src/lib/keiei/ledger-store.ts が IndexedDB に保存。税務チェックの会計監査も
// 同じデータを見る）。取込の入口を2つ持つと同じCSVを2回取り込むことになり、
// 監査側とデータがずれるため、**保存先も解析も既存の1本に統一**した。
//
// ここは「既存の保存形式（LedgerData）→ ビューアの集計が受け取る形（LedgerEntry）」
// への詰め替えだけを行う。

import { listLedgers } from '../../ledger-store'
import { api, getKrAliases } from '../api'
import type { LedgerData } from '../../ledger'
import type { LedgerEntry } from './entry'
import { partnerFromNote } from './normalize'
import type { AliasMap } from './normalize'
import { emptyAliases } from './normalize'

/** 画面に出す取込情報（移植元の LedgerMeta と同じ役割） */
export interface KrLedgerMeta {
  importedAt: string
  from: string
  to: string
  count: number
  fileName: string
  /** 名寄せの手動指定（設定に保存する） */
  aliases: AliasMap
}

/** 既存の保存形式 → ビューアの明細に詰め替える */
export function toEntries(data: LedgerData): LedgerEntry[] {
  const out: LedgerEntry[] = []
  for (const acc of data.accounts) {
    for (const tx of acc.txs) {
      out.push({
        d: tx.date,
        ac: acc.code,
        an: acc.name,
        ca: tx.counterName,
        no: tx.memo,
        // 摘要から取引先らしい部分を取り出す（元帳CSVに取引先の列が無いため）
        p: partnerFromNote(tx.memo),
        dr: tx.debit,
        cr: tx.credit,
      })
    }
  }
  return out
}

/**
 * 顧問先の取込済み元帳をすべて読み、明細をひとつにまとめて返す。
 * 期ごとに分けて保存されているので、期をまたいだ集計（「〇〇への支払合計」等）が
 * できるよう連結する。
 */
export async function loadKrLedger(
  clientId: string,
  aliases: AliasMap = emptyAliases(),
): Promise<{ meta: KrLedgerMeta | null; entries: LedgerEntry[] }> {
  if (!clientId) return { meta: null, entries: [] }
  const list = await listLedgers(clientId)
  if (!list.length) return { meta: null, entries: [] }
  const entries = list.flatMap((l) => toEntries(l.data))
  if (!entries.length) return { meta: null, entries: [] }
  const dates = entries.map((e) => e.d).filter(Boolean).sort()
  const newest = list.reduce((a, b) => (a.data.importedAt > b.data.importedAt ? a : b))
  return {
    meta: {
      importedAt: newest.data.importedAt,
      from: dates[0] || '',
      to: dates[dates.length - 1] || '',
      count: entries.length,
      fileName: list.map((l) => l.data.fileName).join('、'),
      aliases,
    },
    entries,
  }
}

/** 名寄せの手動指定を保存する（既存の設定に相乗りするので新しい保存先は作らない） */
export async function saveAliases(_clientId: string, aliases: AliasMap): Promise<void> {
  api.setAliases({ toGroup: { ...aliases.toGroup }, label: { ...aliases.label } })
}

/** 保存されている名寄せの手動指定 */
export function loadAliases(): AliasMap {
  const a = getKrAliases()
  return { toGroup: a.toGroup || {}, label: a.label || {} }
}
