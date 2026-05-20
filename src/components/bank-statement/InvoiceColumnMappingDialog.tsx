'use client'

import { useState } from 'react'
import type { RawTableRow } from '@/lib/bank-statement/types'

export interface InvoiceColumnMapping {
  dateColumn: number
  counterpartColumn: number
  contentColumns: number[]      // 摘要（複数列結合可）
  totalAmountColumn: number     // 税込・請求金額
  netAmountColumn: number       // 本体価格（任意）
  taxAmountColumn: number       // 消費税（任意）
  taxRateColumn: number         // 税率（任意）
  invoiceNumberColumn: number   // インボイス番号（仕入のみ任意）
  headerRowIndex: number        // 0 始まり。データ開始行 = headerRowIndex + 1
}

interface Props {
  rows: RawTableRow[]
  isPurchase: boolean
  onConfirm: (mapping: InvoiceColumnMapping) => void
  onCancel: () => void
}

interface RoleDef {
  key: keyof Omit<InvoiceColumnMapping, 'contentColumns' | 'headerRowIndex'> | 'contentColumns'
  label: string
  color: string
  required: boolean
  multi: boolean
  purchaseOnly?: boolean
}

export default function InvoiceColumnMappingDialog({ rows, isPurchase, onConfirm, onCancel }: Props) {
  const ROLES: RoleDef[] = [
    { key: 'dateColumn', label: '請求日', color: 'bg-blue-100 border-blue-400', required: true, multi: false },
    { key: 'counterpartColumn', label: isPurchase ? '請求元' : '請求先', color: 'bg-indigo-100 border-indigo-400', required: true, multi: false },
    { key: 'contentColumns', label: '摘要', color: 'bg-green-100 border-green-400', required: false, multi: true },
    { key: 'totalAmountColumn', label: '請求金額(税込)', color: 'bg-yellow-100 border-yellow-400', required: true, multi: false },
    { key: 'netAmountColumn', label: '本体価格', color: 'bg-amber-100 border-amber-400', required: false, multi: false },
    { key: 'taxAmountColumn', label: '消費税', color: 'bg-orange-100 border-orange-400', required: false, multi: false },
    { key: 'taxRateColumn', label: '税率', color: 'bg-pink-100 border-pink-400', required: false, multi: false },
    { key: 'invoiceNumberColumn', label: 'インボイス番号', color: 'bg-purple-100 border-purple-400', required: false, multi: false, purchaseOnly: true },
  ]
  const visibleRoles = ROLES.filter((r) => !r.purchaseOnly || isPurchase)

  const [mapping, setMapping] = useState<Record<string, number>>({
    dateColumn: -1,
    counterpartColumn: -1,
    totalAmountColumn: -1,
    netAmountColumn: -1,
    taxAmountColumn: -1,
    taxRateColumn: -1,
    invoiceNumberColumn: -1,
  })
  const [contentColumns, setContentColumns] = useState<number[]>([])
  const [headerRowIndex, setHeaderRowIndex] = useState<number>(0)
  const [activeRole, setActiveRole] = useState<string>('dateColumn')

  const sampleRows = rows.slice(0, 30)
  const maxCols = Math.max(...sampleRows.map((r) => r.cells.length), 0)

  const handleColumnClick = (colIndex: number) => {
    if (activeRole === 'contentColumns') {
      setContentColumns((prev) =>
        prev.includes(colIndex) ? prev.filter((c) => c !== colIndex) : [...prev, colIndex].sort((a, b) => a - b)
      )
      setMapping((prev) => {
        const updated = { ...prev }
        for (const key of Object.keys(updated)) {
          if (updated[key] === colIndex) updated[key] = -1
        }
        return updated
      })
    } else {
      setMapping((prev) => {
        const updated = { ...prev }
        for (const key of Object.keys(updated)) {
          if (updated[key] === colIndex && key !== activeRole) updated[key] = -1
        }
        updated[activeRole] = prev[activeRole] === colIndex ? -1 : colIndex
        return updated
      })
      setContentColumns((prev) => prev.filter((c) => c !== colIndex))
    }
  }

  const getColumnRole = (colIndex: number): string | null => {
    if (contentColumns.includes(colIndex)) return 'contentColumns'
    for (const [key, value] of Object.entries(mapping)) {
      if (value === colIndex) return key
    }
    return null
  }

  const getColumnColor = (colIndex: number): string => {
    const role = getColumnRole(colIndex)
    if (!role) return ''
    return visibleRoles.find((r) => r.key === role)?.color || ''
  }

  const canConfirm = mapping.dateColumn >= 0 && mapping.counterpartColumn >= 0 && mapping.totalAmountColumn >= 0

  const handleConfirm = () => {
    onConfirm({
      dateColumn: mapping.dateColumn,
      counterpartColumn: mapping.counterpartColumn,
      contentColumns,
      totalAmountColumn: mapping.totalAmountColumn,
      netAmountColumn: mapping.netAmountColumn,
      taxAmountColumn: mapping.taxAmountColumn,
      taxRateColumn: mapping.taxRateColumn,
      invoiceNumberColumn: mapping.invoiceNumberColumn,
      headerRowIndex,
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-6xl max-h-[90vh] flex flex-col">
        <div className="p-5 border-b border-gray-200">
          <h2 className="text-lg font-bold text-gray-800">列のマッピング（{isPurchase ? '仕入請求書' : '売上請求書'}）</h2>
          <p className="text-sm text-gray-500 mt-1">
            各列の役割を指定してください。<span className="text-red-500 font-bold">請求日・{isPurchase ? '請求元' : '請求先'}・請求金額</span>は必須です。
          </p>
        </div>

        <div className="p-4 border-b border-gray-100">
          <div className="flex gap-2 flex-wrap items-center">
            {visibleRoles.map((role) => {
              const isMulti = role.multi
              const assigned = isMulti ? contentColumns.length > 0 : mapping[role.key as string] >= 0
              const label = isMulti && contentColumns.length > 0
                ? `${role.label} (列${contentColumns.map((c) => c + 1).join(',')})`
                : !isMulti && mapping[role.key as string] >= 0
                  ? `${role.label} (列${mapping[role.key as string] + 1})`
                  : role.label + (role.required ? ' *' : '')
              return (
                <button
                  key={role.key as string}
                  onClick={() => setActiveRole(role.key as string)}
                  className={`px-3 py-1.5 text-sm rounded border ${
                    activeRole === role.key
                      ? `${role.color} border-2 font-bold`
                      : 'bg-gray-50 border-gray-200 text-gray-600'
                  } ${assigned ? 'ring-2 ring-offset-1' : ''} ${role.required && !assigned ? 'text-red-600' : ''}`}
                >
                  {label}
                </button>
              )
            })}
          </div>
          <div className="flex items-center gap-4 mt-3">
            <label className="text-xs text-gray-600 flex items-center gap-2">
              ヘッダー行（このより下がデータ）:
              <input
                type="number"
                min={0}
                max={sampleRows.length - 1}
                value={headerRowIndex}
                onChange={(e) => setHeaderRowIndex(Math.max(0, parseInt(e.target.value || '0')))}
                className="w-16 px-2 py-0.5 text-xs border border-gray-300 rounded"
              />
              <span className="text-gray-400">行目（0=1行目）</span>
            </label>
            <p className="text-xs text-gray-400">
              {activeRole === 'contentColumns' && <span className="text-green-600 font-bold">摘要: 複数列選択可</span>}
            </p>
          </div>
        </div>

        <div className="flex-1 overflow-auto p-4">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr>
                <th className="border border-gray-300 px-2 py-2 bg-gray-50 text-gray-400 min-w-[40px]">#</th>
                {Array.from({ length: maxCols }, (_, i) => (
                  <th
                    key={i}
                    onClick={() => handleColumnClick(i)}
                    className={`border border-gray-300 px-2 py-2 cursor-pointer hover:bg-blue-50 transition-colors min-w-[100px] ${getColumnColor(i)}`}
                  >
                    <div className="text-center">
                      <span className="block text-gray-400">列{i + 1}</span>
                      {getColumnRole(i) && (
                        <span className="block font-bold text-gray-700 mt-0.5">
                          {visibleRoles.find((r) => r.key === getColumnRole(i))?.label}
                          {getColumnRole(i) === 'contentColumns' && contentColumns.length > 1 && (
                            <span className="text-green-600"> ({contentColumns.indexOf(i) + 1})</span>
                          )}
                        </span>
                      )}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sampleRows.map((row, rowIdx) => {
                const isHeader = rowIdx === headerRowIndex
                const isAboveHeader = rowIdx < headerRowIndex
                return (
                  <tr key={rowIdx} className={isHeader ? 'bg-blue-50' : isAboveHeader ? 'bg-gray-100 text-gray-400' : rowIdx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                    <td className="border border-gray-200 px-2 py-1 text-center text-gray-400 text-[10px]">
                      {rowIdx + 1}{isHeader ? ' (HD)' : ''}
                    </td>
                    {Array.from({ length: maxCols }, (_, colIdx) => (
                      <td
                        key={colIdx}
                        className={`border border-gray-200 px-2 py-1 truncate max-w-[180px] ${getColumnColor(colIdx)}`}
                        title={row.cells[colIdx] || ''}
                      >
                        {row.cells[colIdx] || ''}
                      </td>
                    ))}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <div className="p-4 border-t border-gray-200 flex justify-between items-center">
          <div className="text-xs">
            {!canConfirm && (
              <span className="text-red-500 font-bold">※ 請求日・{isPurchase ? '請求元' : '請求先'}・請求金額の3列を必ず指定してください</span>
            )}
            {contentColumns.length > 1 && canConfirm && (
              <span className="text-gray-500">摘要: {contentColumns.length}列を結合します</span>
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={onCancel} className="px-6 py-2 text-sm bg-gray-100 rounded hover:bg-gray-200">キャンセル</button>
            <button onClick={handleConfirm} disabled={!canConfirm}
              className="px-6 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-40">確定</button>
          </div>
        </div>
      </div>
    </div>
  )
}
