'use client'

import { useEffect, useState, useCallback } from 'react'
import { getProcessingStatuses, saveProcessingStatuses, updateStatusDetail, type ProcessingStatus } from '@/lib/bank-statement/processing-status-store'
import { getClients, updateClient, type Client } from '@/lib/bank-statement/client-store'

interface Props {
  clientId: string | null
  refreshKey?: number
}

const DOC_TYPES = ['通帳', '現金出納帳', 'ｸﾚｼﾞｯﾄ', '賃金台帳', 'その他']

export default function ProcessingStatusTable({ clientId, refreshKey }: Props) {
  const [statuses, setStatuses] = useState<ProcessingStatus[]>([])
  const [client, setClient] = useState<Client | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showFiscalDialog, setShowFiscalDialog] = useState(false)
  const [fiscalMonth, setFiscalMonth] = useState(3)

  useEffect(() => {
    setStatuses(getProcessingStatuses())
    if (clientId) {
      const c = getClients().find((cl) => cl.id === clientId) || null
      setClient(c)
      if (c) setFiscalMonth(c.fiscalYearEndMonth || 3)
    }
  }, [clientId, refreshKey])

  // 決算月から12ヶ月の配列を生成
  const endMonth = client?.fiscalYearEndMonth || 3
  const months: string[] = []
  for (let i = 1; i <= 12; i++) {
    const m = ((endMonth) % 12) + i
    const adjusted = m > 12 ? m - 12 : m
    months.push(String(adjusted))
  }

  const saveFiscalMonth = useCallback(() => {
    if (!clientId) return
    updateClient(clientId, { fiscalYearEndMonth: fiscalMonth })
    setClient((prev) => prev ? { ...prev, fiscalYearEndMonth: fiscalMonth } : prev)
    setShowFiscalDialog(false)
  }, [clientId, fiscalMonth])

  const handleDetailChange = useCallback((code: string, field: string, value: string) => {
    setStatuses((prev) => {
      const updated = prev.map((s) => s.accountCode === code ? { ...s, [field]: value } : s)
      saveProcessingStatuses(updated)
      return updated
    })
  }, [])

  const handleAddRow = useCallback(() => {
    const code = prompt('追加する科目CDを入力してください')
    if (!code) return
    const name = prompt('科目名を入力してください') || ''
    const existing = getProcessingStatuses()
    if (existing.some((s) => s.accountCode === code)) {
      alert('この科目CDは既に登録されています')
      return
    }
    existing.push({
      accountCode: code, accountName: name,
      lastDate: '', lastUpdated: new Date().toISOString(),
      monthlyProgress: {},
    })
    saveProcessingStatuses(existing)
    setStatuses(existing)
  }, [])

  const handleDeleteRow = useCallback((code: string) => {
    if (!confirm(`科目CD ${code} を進捗管理表から削除しますか？`)) return
    const updated = getProcessingStatuses().filter((s) => s.accountCode !== code)
    saveProcessingStatuses(updated)
    setStatuses(updated)
  }, [])

  // 科目CD昇順
  const sorted = [...statuses].sort((a, b) => a.accountCode.localeCompare(b.accountCode))

  // 会計年度の計算（決算月を基準に）
  const now = new Date()
  const currentMonth = now.getMonth() + 1
  const currentYear = now.getFullYear()
  const fiscalStartYear = currentMonth > endMonth ? currentYear : currentYear - 1

  function getYearMonth(monthNum: number): string {
    const m = parseInt(monthNum as unknown as string)
    const y = m > endMonth ? fiscalStartYear : fiscalStartYear + 1
    return `${y}-${String(m).padStart(2, '0')}`
  }

  if (!client?.fiscalYearEndMonth && clientId) {
    return (
      <div className="mt-6 max-w-4xl mx-auto">
        <div className="bg-amber-50 border border-amber-300 rounded-lg p-4 text-center">
          <div className="text-sm font-bold text-amber-800 mb-2">決算月が設定されていません</div>
          <div className="text-xs text-amber-600 mb-3">進捗管理表を表示するには決算月を設定してください</div>
          <div className="flex items-center justify-center gap-2">
            <select value={fiscalMonth} onChange={(e) => setFiscalMonth(parseInt(e.target.value))}
              className="px-2 py-1 border rounded text-sm">
              {[1,2,3,4,5,6,7,8,9,10,11,12].map((m) => (
                <option key={m} value={m}>{m}月決算</option>
              ))}
            </select>
            <button onClick={saveFiscalMonth} className="px-3 py-1 bg-blue-600 text-white text-sm rounded hover:bg-blue-700">設定</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="mt-6 mx-auto" style={{ maxWidth: '95vw' }}>
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-bold text-gray-700">
          進捗管理表
          <span className="ml-2 text-xs text-gray-400 font-normal">
            ({fiscalStartYear + 1}年{endMonth}月期 / {months[0]}月〜{months[11]}月)
          </span>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setShowFiscalDialog(true)}
            className="px-2 py-1 text-xs bg-gray-200 rounded hover:bg-gray-300">決算月変更</button>
          <button onClick={handleAddRow}
            className="px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700">+ 科目追加</button>
        </div>
      </div>

      {showFiscalDialog && (
        <div className="mb-3 p-2 bg-gray-50 border rounded flex items-center gap-2">
          <select value={fiscalMonth} onChange={(e) => setFiscalMonth(parseInt(e.target.value))} className="px-2 py-1 border rounded text-sm">
            {[1,2,3,4,5,6,7,8,9,10,11,12].map((m) => <option key={m} value={m}>{m}月決算</option>)}
          </select>
          <button onClick={saveFiscalMonth} className="px-2 py-1 bg-blue-600 text-white text-xs rounded">保存</button>
          <button onClick={() => setShowFiscalDialog(false)} className="px-2 py-1 bg-gray-200 text-xs rounded">キャンセル</button>
        </div>
      )}

      <div className="bg-white rounded-lg border border-gray-200 overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-gray-100 border-b border-gray-200">
            <tr>
              <th className="px-2 py-1.5 text-left font-medium w-16">科目CD</th>
              <th className="px-2 py-1.5 text-left font-medium w-20">科目名</th>
              <th className="px-2 py-1.5 text-left font-medium w-16">種別</th>
              <th className="px-2 py-1.5 text-left font-medium w-20">正式名称</th>
              {months.map((m) => (
                <th key={m} className="px-1 py-1.5 text-center font-medium w-14">{m}月</th>
              ))}
              <th className="px-2 py-1.5 text-center font-medium w-24">更新日時</th>
              <th className="px-1 py-1.5 w-6"></th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr><td colSpan={16 + months.length} className="px-4 py-6 text-center text-gray-400">
                「+ 科目追加」ボタンで管理する科目を追加してください
              </td></tr>
            ) : sorted.map((s) => {
              const isEditing = editingId === s.accountCode
              return (
                <tr key={s.accountCode} className="border-b border-gray-100 hover:bg-gray-50"
                  onClick={() => setEditingId(isEditing ? null : s.accountCode)}>
                  <td className="px-2 py-1 font-bold">{s.accountCode}</td>
                  <td className="px-2 py-1">{s.accountName || '—'}</td>
                  <td className="px-2 py-1">
                    {isEditing ? (
                      <select value={s.docType || ''} onClick={(e) => e.stopPropagation()}
                        onChange={(e) => handleDetailChange(s.accountCode, 'docType', e.target.value)}
                        className="w-full px-1 py-0.5 border rounded text-xs">
                        <option value="">-</option>
                        {DOC_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                    ) : <span className="text-gray-500">{s.docType || '—'}</span>}
                  </td>
                  <td className="px-2 py-1">
                    {isEditing ? (
                      <input type="text" value={s.bankName || ''} onClick={(e) => e.stopPropagation()}
                        onChange={(e) => handleDetailChange(s.accountCode, 'bankName', e.target.value)}
                        placeholder="銀行名等" className="w-full px-1 py-0.5 border rounded text-xs" />
                    ) : <span className="text-gray-500">{s.bankName || '—'}</span>}
                  </td>
                  {months.map((m) => {
                    const ym = getYearMonth(m)
                    const day = s.monthlyProgress?.[ym]
                    const hasData = !!day
                    return (
                      <td key={m} className={`px-1 py-1 text-center ${hasData ? 'bg-blue-100 text-blue-800 font-bold' : 'text-gray-300'}`}>
                        {hasData ? `${parseInt(m)}/${day}` : ''}
                      </td>
                    )
                  })}
                  <td className="px-2 py-1 text-center text-gray-400">
                    {s.lastUpdated ? new Date(s.lastUpdated).toLocaleDateString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}
                  </td>
                  <td className="px-1 py-1">
                    {isEditing && (
                      <button onClick={(e) => { e.stopPropagation(); handleDeleteRow(s.accountCode) }}
                        className="text-red-400 hover:text-red-600" title="削除">×</button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-1 text-xs text-gray-400">行をクリックして種別・正式名称を編集</div>
    </div>
  )
}
