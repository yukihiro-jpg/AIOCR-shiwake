'use client'

import { useState, useEffect, useMemo } from 'react'
import GlobalNav from '@/core/ui/GlobalNav'
import type { Client } from '@/lib/bank-statement/client-store'
import { getClients, addClient, deleteClient, setSelectedClientId, updateClient, type TaxType } from '@/lib/bank-statement/client-store'

interface Props {
  onSelect: (client: Client) => void
  // 値が変わると顧問先一覧を再読込（Firebase からの遠隔追加を反映）
  refreshSignal?: number
}

export default function ClientSelector({ onSelect, refreshSignal }: Props) {
  const [clients, setClients] = useState<Client[]>([])
  const [search, setSearch] = useState('')
  const [newName, setNewName] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [newFiscalMonth, setNewFiscalMonth] = useState(3)

  useEffect(() => {
    setClients(getClients())
  }, [refreshSignal])

  // 顧問先コード順に並べる（コードあり→数値/文字で昇順、コード無しは末尾を名前順）
  const sortByCode = (a: Client, b: Client) => {
    const ca = (a.code || '').trim(), cb = (b.code || '').trim()
    if (ca && cb) {
      const na = Number(ca), nb = Number(cb)
      if (ca !== '' && cb !== '' && !isNaN(na) && !isNaN(nb)) return na - nb
      return ca.localeCompare(cb, 'ja')
    }
    if (ca && !cb) return -1
    if (!ca && cb) return 1
    return (a.name || '').localeCompare(b.name || '', 'ja')
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const list = q
      ? clients.filter((c) => c.name.toLowerCase().includes(q) || (c.code || '').toLowerCase().includes(q))
      : clients
    return [...list].sort(sortByCode)
  }, [clients, search])

  const handleAdd = () => {
    if (!newName.trim()) return
    const client = addClient(newName.trim())
    updateClient(client.id, { fiscalYearEndMonth: newFiscalMonth })
    setClients(getClients())
    setNewName('')
    setNewFiscalMonth(3)
    setShowAdd(false)
  }

  // 削除は名前を打たせて確認する（confirm 1回だと誤クリックで全端末から消える・戻せない）
  const [deleteTarget, setDeleteTarget] = useState<Client | null>(null)
  const [deleteTyped, setDeleteTyped] = useState('')
  const deleteMatch = deleteTarget != null && deleteTyped.trim() !== '' && deleteTyped.trim() === deleteTarget.name.trim()
  const handleDelete = () => {
    if (!deleteTarget || !deleteMatch) return
    deleteClient(deleteTarget.id)
    setClients(getClients())
    setDeleteTarget(null)
    setDeleteTyped('')
  }

  const handleSelect = (client: Client) => {
    setSelectedClientId(client.id)
    onSelect(client)
  }

  const taxLabel = (t?: TaxType) => t === 'exempt' ? '免税' : t === 'simplified' ? '簡易課税' : '原則課税'
  const taxBadgeClass = (t?: TaxType) =>
    t === 'exempt' ? 'bg-gray-100 text-gray-600'
    : t === 'simplified' ? 'bg-amber-50 text-amber-700'
    : 'bg-blue-50 text-blue-700'
  const fmtDate = (iso?: string) => {
    if (!iso) return null
    const d = new Date(iso)
    if (isNaN(d.getTime())) return null
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`
  }

  return (
    <div className="h-screen flex flex-col bank-statement-app fusion">
      <GlobalNav currentKey="aiocr-shiwake" />
      <header className="fusion-bar px-6 py-3 shrink-0 flex items-center gap-3">
        <div className="fusion-logo">会</div>
        <div>
          <h1 className="text-base font-semibold text-gray-800 leading-tight">会計大将インポートデータ変換</h1>
          <p className="text-xs text-gray-500">顧問先を選択してください</p>
        </div>
      </header>

      <div className="flex-1 overflow-auto px-6 py-6">
        <div className="w-full max-w-6xl mx-auto">
          {/* 検索 + 追加 */}
          <div className="mb-5 flex gap-2">
            <div className="flex-1 relative max-w-md">
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="顧問先コード・名前で検索..."
                className="w-full px-4 py-2.5 text-sm border border-gray-300 rounded-full bg-white focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent"
              />
              {search && (
                <button onClick={() => setSearch('')}
                  className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                  &times;
                </button>
              )}
            </div>
            <button
              onClick={() => setShowAdd(!showAdd)}
              className="fbtn fbtn-blue shrink-0"
            >
              ＋ 新規登録
            </button>
          </div>

          {/* 新規登録フォーム */}
          {showAdd && (
            <div className="mb-5 p-4 bg-white rounded-2xl border border-gray-200 shadow-sm max-w-2xl">
              <div className="text-sm font-medium text-gray-700 mb-2">新しい顧問先を登録</div>
              <div className="flex gap-2 items-center flex-wrap">
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleAdd() }}
                  placeholder="顧問先名を入力"
                  autoFocus
                  className="flex-1 min-w-[200px] px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400"
                />
                <select value={newFiscalMonth} onChange={(e) => setNewFiscalMonth(parseInt(e.target.value))}
                  className="px-2 py-2 text-sm border border-gray-300 rounded-lg">
                  {[1,2,3,4,5,6,7,8,9,10,11,12].map((m) => <option key={m} value={m}>{m}月決算</option>)}
                </select>
                <button onClick={handleAdd} className="fbtn fbtn-blue">登録</button>
                <button onClick={() => { setShowAdd(false); setNewName('') }} className="fbtn fbtn-soft">取消</button>
              </div>
            </div>
          )}

          {/* 顧問先リスト（1行＝1顧問先・コード順）*/}
          {filtered.length === 0 ? (
            <div className="p-10 text-center text-gray-400 bg-white rounded-2xl border border-gray-200">
              {clients.length === 0
                ? '顧問先が登録されていません。「＋ 新規登録」から追加してください。'
                : '検索結果がありません'}
            </div>
          ) : (
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              {/* 見出し行（スマホでは非表示） */}
              <div className="hidden sm:grid grid-cols-[64px_1fr_116px_120px_64px] items-center gap-3 px-4 h-9 text-[11px] tracking-wider text-gray-400 bg-gray-50/70">
                <span>コード</span><span>顧問先</span><span>消費税</span><span>直前の処理</span><span></span>
              </div>
              {filtered.map((client) => {
                const last = fmtDate(client.lastCsvExportAt)
                return (
                  <div key={client.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => handleSelect(client)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleSelect(client) }}
                    className="group border-t border-gray-100 cursor-pointer hover:bg-blue-50/60 focus:outline-none focus-visible:bg-blue-50
                               grid grid-cols-[1fr_auto] sm:grid-cols-[64px_1fr_116px_120px_64px] items-center gap-x-3 gap-y-0.5 px-4 py-2 sm:py-0 sm:h-[52px]"
                  >
                    {/* コード */}
                    <span className="text-[11px] sm:text-[13px] text-gray-400 tabular-nums col-start-1 row-start-1">{client.code || '—'}</span>

                    {/* 消費税方式（スマホでは右上） */}
                    <div className="col-start-2 row-start-1 sm:col-start-3 sm:row-start-1 justify-self-end sm:justify-self-start">
                      <select value={client.taxType || 'standard'}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => {
                          updateClient(client.id, { taxType: e.target.value as TaxType })
                          setClients(getClients())
                        }}
                        className={`text-xs font-semibold rounded-full px-2.5 py-1 border-0 cursor-pointer ${taxBadgeClass(client.taxType)}`}>
                        <option value="standard">原則課税</option>
                        <option value="simplified">簡易課税</option>
                        <option value="exempt">免税</option>
                      </select>
                    </div>

                    {/* 顧問先名 */}
                    <span className="col-start-1 row-start-2 sm:col-start-2 sm:row-start-1 font-semibold text-[15px] text-gray-800 group-hover:text-blue-700 leading-snug sm:truncate">
                      {client.name}
                    </span>

                    {/* 直前のCSV出力日 */}
                    <span className={`col-start-2 row-start-2 sm:col-start-4 sm:row-start-1 justify-self-end sm:justify-self-start text-xs sm:text-[13px] tabular-nums ${last ? 'text-gray-700' : 'text-gray-300'}`}>
                      <span className="sm:hidden text-gray-400 mr-1">直前</span>{last || '未処理'}
                    </span>

                    {/* 削除（PCのみ・行にマウスを乗せたときだけ表示） */}
                    <div className="hidden sm:flex justify-end sm:col-start-5 sm:row-start-1">
                      <button
                        onClick={(e) => { e.stopPropagation(); setDeleteTyped(''); setDeleteTarget(client) }}
                        title="この顧問先を削除（名前の入力で確認します）"
                        className="inline-flex items-center gap-1 text-xs font-semibold text-red-600 border border-red-300 rounded-md px-2 py-1
                                   opacity-0 group-hover:opacity-100 focus:opacity-100 hover:bg-red-600 hover:text-white transition-all"
                      >
                        <span aria-hidden>🗑</span>削除
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* 削除確認ダイアログ（名前を正確に入力しないと削除できない） */}
          {deleteTarget && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
              onClick={() => { setDeleteTarget(null); setDeleteTyped('') }}>
              <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
                <h2 className="text-base font-bold text-red-700">顧問先を削除します（取り消せません）</h2>
                <p className="mt-3 text-sm text-gray-700 leading-relaxed">
                  <span className="font-semibold">{deleteTarget.code ? `${deleteTarget.code}　` : ''}{deleteTarget.name}</span> の
                  科目マスタ・補助科目・パターン学習・処理状況・一時保存データがすべて消え、
                  共有中の<b>すべての端末</b>からも削除されます。
                </p>
                <p className="mt-4 text-xs text-gray-500">確認のため、顧問先名を正確に入力してください（コードは不要）</p>
                <input
                  type="text"
                  value={deleteTyped}
                  onChange={(e) => setDeleteTyped(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && deleteMatch) handleDelete(); if (e.key === 'Escape') { setDeleteTarget(null); setDeleteTyped('') } }}
                  placeholder={deleteTarget.name}
                  autoFocus
                  className="mt-1.5 w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-red-400 focus:outline-none"
                />
                {deleteTyped.trim() !== '' && !deleteMatch && (
                  <p className="mt-1 text-xs text-red-500">名前が一致しません</p>
                )}
                <div className="mt-5 flex justify-end gap-2">
                  <button onClick={() => { setDeleteTarget(null); setDeleteTyped('') }}
                    className="rounded px-4 py-2 text-sm text-gray-600 hover:bg-gray-100">キャンセル</button>
                  <button onClick={handleDelete} disabled={!deleteMatch}
                    className="rounded bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed">
                    削除する
                  </button>
                </div>
              </div>
            </div>
          )}

          <p className="mt-4 text-xs text-gray-400">
            {clients.length}件の顧問先が登録されています（直前の処理＝最も直近に仕訳CSVを出力した日）。
            削除は行にマウスを乗せると右端に出ます
          </p>
        </div>
      </div>
    </div>
  )
}
