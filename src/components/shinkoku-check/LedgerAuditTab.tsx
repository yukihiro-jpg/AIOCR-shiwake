'use client'

// 会計監査タブ: 顧問先を選び、総勘定元帳CSVを取り込んで解析する。
// 消費税マスタ（仕訳作成の科目別消費税）は共有ストレージから自動取得する
// （同一端末は localStorage、他端末は RTDB の per-client ノードを一発読み。再アップロード不要）。
import { useCallback, useEffect, useState } from 'react'
import { hasRoom, modulePath } from '@/core/room'
import { getDb } from '@/core/firebase'
import type { FiscalYearData } from '@/lib/keiei/types'
import { loadYears } from '@/lib/keiei/store'
import type { AccountTaxItem } from '@/lib/bank-statement/types'
import { STORAGE_KEY_MAP, CLIENTS_LIST_KEY } from '@/lib/bank-statement/storage-keys'
import { APP_SUBTREE } from '@/lib/bank-statement/firebase-config'
import SectionAudit from './SectionAudit'

interface ShiwakeClient { id: string; name: string; code?: string }

const SEL_KEY = 'shinkoku-audit-selected-client' // 端末ローカル（表示選択のみ・同期しない）

/** 仕訳作成と共有の顧問先一覧（localStorage → RTDB clients_v2 をマージ） */
async function loadShiwakeClients(): Promise<ShiwakeClient[]> {
  const map = new Map<string, ShiwakeClient>()
  try {
    const raw = localStorage.getItem(CLIENTS_LIST_KEY)
    if (raw) {
      for (const c of JSON.parse(raw) as ShiwakeClient[]) {
        if (c?.id && c?.name) map.set(c.id, { id: c.id, name: c.name, code: c.code })
      }
    }
  } catch { /* ignore */ }
  if (hasRoom()) {
    try {
      const db = await getDb()
      const { ref, get } = await import('firebase/database')
      const snap = await get(ref(db, await modulePath(APP_SUBTREE, '_global', 'clients_v2')))
      const val = (snap.val() || {}) as Record<string, ShiwakeClient>
      for (const c of Object.values(val)) {
        if (c?.id && c?.name) map.set(c.id, { id: c.id, name: c.name, code: c.code })
      }
    } catch { /* ignore */ }
  }
  return Array.from(map.values()).sort((a, b) =>
    (a.code || '').localeCompare(b.code || '', 'ja', { numeric: true }) || a.name.localeCompare(b.name, 'ja'))
}

/** 消費税マスタ: localStorage優先、無ければRTDBの per-client ノードを一発読み */
async function loadTaxMasterFor(cid: string): Promise<AccountTaxItem[]> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_MAP['account-tax-master'](cid))
    if (raw) {
      const v = JSON.parse(raw)
      if (Array.isArray(v) && v.length) return v as AccountTaxItem[]
    }
  } catch { /* ignore */ }
  if (hasRoom()) {
    try {
      const db = await getDb()
      const { ref, get } = await import('firebase/database')
      const snap = await get(ref(db, await modulePath(APP_SUBTREE, cid, 'account-tax-master')))
      const v = snap.val()
      if (Array.isArray(v) && v.length) return v as AccountTaxItem[]
    } catch { /* ignore */ }
  }
  return []
}

export default function LedgerAuditTab() {
  const [clients, setClients] = useState<ShiwakeClient[]>([])
  const [clientsLoaded, setClientsLoaded] = useState(false)
  const [clientId, setClientId] = useState('')
  const [years, setYears] = useState<Record<string, FiscalYearData>>({})
  const [taxMaster, setTaxMaster] = useState<AccountTaxItem[]>([])
  const [masterLoaded, setMasterLoaded] = useState(false)

  useEffect(() => {
    loadShiwakeClients().then((cs) => {
      setClients(cs)
      const saved = localStorage.getItem(SEL_KEY)
      if (saved && cs.some((c) => c.id === saved)) setClientId(saved)
    }).finally(() => setClientsLoaded(true))
  }, [])

  useEffect(() => {
    if (!clientId) { setYears({}); setTaxMaster([]); setMasterLoaded(false); return }
    localStorage.setItem(SEL_KEY, clientId)
    setMasterLoaded(false)
    // 期ラベル用（月次レポートの試算表データがあれば期名を表示できる。無くても動作する）
    loadYears(clientId).then(setYears).catch(() => setYears({}))
    loadTaxMasterFor(clientId).then(setTaxMaster).finally(() => setMasterLoaded(true))
  }, [clientId])

  const selected = clients.find((c) => c.id === clientId) || null

  const selectClient = useCallback((id: string) => setClientId(id), [])

  if (!clientsLoaded) return <div className="text-sm text-gray-400 py-8 text-center">顧問先一覧を読み込み中…</div>

  if (!clients.length) {
    return (
      <div className="bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-lg p-4">
        顧問先が見つかりません。仕訳作成（または顧問先情報登録）で顧問先を登録すると、ここに表示されます。
        合言葉（ホーム画面の共通設定）が未設定の場合は、設定すると全端末の顧問先が表示されます。
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-2xl border border-gray-100 shadow-[0_3px_10px_rgba(26,115,232,0.06)] p-5">
        <div className="flex items-end gap-3 flex-wrap">
          <label className="text-xs text-gray-500">
            顧問先（仕訳作成と共有）
            <select value={clientId} onChange={(e) => selectClient(e.target.value)}
              className="block mt-1 px-3 py-2 border border-gray-300 rounded text-sm min-w-[260px]">
              <option value="">— 顧問先を選択 —</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>{c.code ? `${c.code} ` : ''}{c.name}</option>
              ))}
            </select>
          </label>
          {selected && masterLoaded && (
            taxMaster.length > 0 ? (
              <span className="text-[11px] text-green-700 bg-green-50 rounded px-2 py-1.5 mb-0.5">
                ✓ 消費税マスタ {taxMaster.length}科目を自動読込（仕訳作成の科目別消費税と共有・再アップロード不要）
              </span>
            ) : (
              <span className="text-[11px] text-amber-700 bg-amber-50 rounded px-2 py-1.5 mb-0.5">
                ⚠ 消費税マスタが未登録です。仕訳作成の「科目マスタ」で科目別消費税チェックリストを取り込むと、
                マスタ照合チェック（⑫）が有効になります（履歴ベースのチェックは今のままでも動作します）。
              </span>
            )
          )}
        </div>
      </div>

      {selected ? (
        <SectionAudit clientId={selected.id} years={years} company={selected.name} taxMaster={taxMaster} />
      ) : (
        <div className="text-sm text-gray-400 py-6 text-center">顧問先を選択してください。</div>
      )}
    </div>
  )
}
