'use client'

import { useState, useEffect, useMemo } from 'react'
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

  const filtered = useMemo(() => {
    if (!search) return clients
    const q = search.toLowerCase()
    return clients.filter((c) => c.name.toLowerCase().includes(q))
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

  const handleDelete = (id: string, name: string) => {
    const msg =
      `⚠️ 本当に「${name}」を削除しますか？\n\n` +
      `この操作は取り消せません。\n` +
      `・この顧問先の 科目マスタ／補助科目／パターン学習／処理状況／一時保存データ がすべて削除されます。\n` +
      `・共有中のすべての端末（他のユーザーの画面）からも完全に削除され、元に戻せません。\n\n` +
      `削除してよろしければ「OK」を押してください。`
    if (!confirm(msg)) return
    deleteClient(id)
    setClients(getClients())
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
                placeholder="顧問先名で検索..."
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

          {/* 顧問先カードグリッド（4列）*/}
          {filtered.length === 0 ? (
            <div className="p-10 text-center text-gray-400 bg-white rounded-2xl border border-gray-200">
              {clients.length === 0
                ? '顧問先が登録されていません。「＋ 新規登録」から追加してください。'
                : '検索結果がありません'}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {filtered.map((client) => {
                const last = fmtDate(client.lastCsvExportAt)
                return (
                  <div key={client.id}
                    onClick={() => handleSelect(client)}
                    className="group bg-white rounded-2xl border border-gray-200 shadow-sm hover:shadow-md hover:border-blue-300 cursor-pointer transition-all p-4 flex flex-col gap-3"
                  >
                    {/* 顧問先名 */}
                    <div className="font-semibold text-gray-800 group-hover:text-blue-700 leading-snug min-h-[2.6em]">
                      {client.name}
                    </div>

                    {/* 消費税方式 */}
                    <div>
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

                    {/* 直前のCSV出力日 + 削除ボタン */}
                    <div className="mt-auto pt-2 border-t border-gray-100 flex items-center justify-between gap-2">
                      <div className="text-xs min-w-0">
                        <span className="text-gray-400">直前の処理</span>
                        <span className={`ml-1.5 font-medium ${last ? 'text-gray-700' : 'text-gray-300'}`}>
                          {last || '未処理'}
                        </span>
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDelete(client.id, client.name) }}
                        title="この顧問先を削除（取り消せません）"
                        className="shrink-0 inline-flex items-center gap-1 text-xs font-semibold text-red-600 border border-red-300 rounded-md px-2 py-1 hover:bg-red-600 hover:text-white transition-colors"
                      >
                        <span aria-hidden>🗑</span>削除
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          <p className="mt-4 text-xs text-gray-400">
            {clients.length}件の顧問先が登録されています（直前の処理＝最も直近に仕訳CSVを出力した日）
          </p>
        </div>
      </div>
    </div>
  )
}
