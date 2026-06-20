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
    if (!confirm(`「${name}」を削除しますか？\n科目マスタ・パターン学習データも削除されます。`)) return
    deleteClient(id)
    setClients(getClients())
  }

  const handleSelect = (client: Client) => {
    setSelectedClientId(client.id)
    onSelect(client)
  }

  return (
    <div className="h-screen flex flex-col bg-gray-100 bank-statement-app">
      <header className="bg-gray-800 px-6 py-3 shrink-0">
        <h1 className="text-lg font-bold text-white">会計大将インポートデータ変換</h1>
        <p className="text-sm text-gray-400">顧問先を選択してください</p>
      </header>

      <div className="flex-1 flex justify-center overflow-auto py-8">
        <div className="w-full max-w-lg">
          {/* 検索 + 追加 */}
          <div className="mb-4 flex gap-2">
            <div className="flex-1 relative">
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="顧問先名で検索..."
                className="w-full px-4 py-2.5 text-sm border border-gray-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent"
              />
              {search && (
                <button onClick={() => setSearch('')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                  &times;
                </button>
              )}
            </div>
            <button
              onClick={() => setShowAdd(!showAdd)}
              className="px-4 py-2.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium shrink-0"
            >
              + 新規登録
            </button>
          </div>

          {/* 新規登録フォーム */}
          {showAdd && (
            <div className="mb-4 p-4 bg-white rounded-lg border border-gray-200 shadow-sm">
              <div className="text-sm font-medium text-gray-700 mb-2">新しい顧問先を登録</div>
              <div className="flex gap-2 items-center">
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleAdd() }}
                  placeholder="顧問先名を入力"
                  autoFocus
                  className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-400"
                />
                <select value={newFiscalMonth} onChange={(e) => setNewFiscalMonth(parseInt(e.target.value))}
                  className="px-2 py-2 text-sm border border-gray-300 rounded">
                  {[1,2,3,4,5,6,7,8,9,10,11,12].map((m) => <option key={m} value={m}>{m}月決算</option>)}
                </select>
                <button onClick={handleAdd}
                  className="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 whitespace-nowrap">
                  登録
                </button>
                <button onClick={() => { setShowAdd(false); setNewName('') }}
                  className="px-3 py-2 text-sm bg-gray-100 rounded hover:bg-gray-200">
                  取消
                </button>
              </div>
            </div>
          )}

          {/* 顧問先一覧 */}
          <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
            {filtered.length === 0 ? (
              <div className="p-8 text-center text-gray-400">
                {clients.length === 0
                  ? '顧問先が登録されていません。「+ 新規登録」から追加してください。'
                  : '検索結果がありません'}
              </div>
            ) : (
              <ul className="divide-y divide-gray-100">
                {filtered.map((client) => (
                  <li key={client.id}
                    className="flex items-center justify-between px-5 py-3 hover:bg-blue-50 cursor-pointer transition-colors group"
                    onClick={() => handleSelect(client)}
                  >
                    <div className="flex-1">
                      <span className="text-sm font-medium text-gray-800 group-hover:text-blue-700">
                        {client.name}
                      </span>
                      <span className="ml-2 text-xs text-gray-400">
                        {client.taxType === 'exempt' ? '免税' : client.taxType === 'simplified' ? '簡易課税' : '原則課税'}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <select value={client.taxType || 'standard'}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => {
                          updateClient(client.id, { taxType: e.target.value as TaxType })
                          setClients(getClients())
                        }}
                        className="text-xs border border-gray-200 rounded px-1 py-0.5 bg-white">
                        <option value="standard">原則課税</option>
                        <option value="simplified">簡易課税</option>
                        <option value="exempt">免税</option>
                      </select>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDelete(client.id, client.name) }}
                        className="text-xs text-gray-400 hover:text-red-600 opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        削除
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <p className="mt-3 text-xs text-gray-400 text-center">
            {clients.length}件の顧問先が登録されています
          </p>
        </div>
      </div>
    </div>
  )
}
