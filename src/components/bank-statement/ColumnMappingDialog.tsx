'use client'

import { useState } from 'react'
import type { RawTableRow, ColumnMapping } from '@/lib/bank-statement/types'

interface Props {
  rawPages: RawTableRow[][]
  initialMapping?: ColumnMapping
  onConfirm: (mapping: ColumnMapping) => void
  onCancel: () => void
}

const COLUMN_ROLES = [
  { key: 'dateColumn', label: '日付', color: 'bg-blue-100 border-blue-400', multi: false },
  { key: 'descriptionColumn', label: '摘要', color: 'bg-green-100 border-green-400', multi: true },
  { key: 'depositColumn', label: '入金', color: 'bg-yellow-100 border-yellow-400', multi: false },
  { key: 'withdrawalColumn', label: '出金', color: 'bg-red-100 border-red-400', multi: false },
  { key: 'balanceColumn', label: '残高', color: 'bg-purple-100 border-purple-400', multi: false },
] as const

export default function ColumnMappingDialog({ rawPages, initialMapping, onConfirm, onCancel }: Props) {
  const [mapping, setMapping] = useState<Record<string, number>>({
    dateColumn: initialMapping?.dateColumn ?? -1,
    depositColumn: initialMapping?.depositColumn ?? -1,
    withdrawalColumn: initialMapping?.withdrawalColumn ?? -1,
    balanceColumn: initialMapping?.balanceColumn ?? -1,
  })
  const [descColumns, setDescColumns] = useState<number[]>(
    initialMapping?.descriptionColumns || (initialMapping?.descriptionColumn != null && initialMapping.descriptionColumn >= 0 ? [initialMapping.descriptionColumn] : [])
  )
  const [activeRole, setActiveRole] = useState<string>('dateColumn')

  const sampleRows = rawPages[0]?.slice(0, 25) || []
  const maxCols = Math.max(...sampleRows.map((r) => r.cells.length), 0)

  const handleColumnClick = (colIndex: number) => {
    if (activeRole === 'descriptionColumn') {
      // 摘要は複数列トグル
      setDescColumns((prev) =>
        prev.includes(colIndex) ? prev.filter((c) => c !== colIndex) : [...prev, colIndex].sort((a, b) => a - b)
      )
      // 他の役割から外す
      setMapping((prev) => {
        const updated = { ...prev }
        for (const key of Object.keys(updated)) {
          if (updated[key] === colIndex) updated[key] = -1
        }
        return updated
      })
    } else {
      // 単一列: トグル
      setMapping((prev) => {
        const updated = { ...prev }
        // 既に別の役割がある列をクリアして上書き
        for (const key of Object.keys(updated)) {
          if (updated[key] === colIndex && key !== activeRole) updated[key] = -1
        }
        updated[activeRole] = prev[activeRole] === colIndex ? -1 : colIndex
        return updated
      })
      // 摘要から外す
      setDescColumns((prev) => prev.filter((c) => c !== colIndex))
    }
  }

  const getColumnRole = (colIndex: number): string | null => {
    if (descColumns.includes(colIndex)) return 'descriptionColumn'
    for (const [key, value] of Object.entries(mapping)) {
      if (value === colIndex) return key
    }
    return null
  }

  const getColumnColor = (colIndex: number): string => {
    const role = getColumnRole(colIndex)
    if (!role) return ''
    return COLUMN_ROLES.find((r) => r.key === role)?.color || ''
  }

  const canConfirm =
    mapping.dateColumn >= 0 &&
    (mapping.balanceColumn >= 0 || mapping.depositColumn >= 0 || mapping.withdrawalColumn >= 0)

  const handleConfirm = () => {
    onConfirm({
      dateColumn: mapping.dateColumn,
      descriptionColumn: descColumns.length > 0 ? descColumns[0] : -1,
      descriptionColumns: descColumns.length > 1 ? descColumns : undefined,
      depositColumn: mapping.depositColumn >= 0 ? mapping.depositColumn : mapping.withdrawalColumn,
      withdrawalColumn: mapping.withdrawalColumn >= 0 ? mapping.withdrawalColumn : mapping.depositColumn,
      balanceColumn: mapping.balanceColumn,
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-5xl max-h-[90vh] flex flex-col">
        <div className="p-5 border-b border-gray-200">
          <h2 className="text-lg font-bold text-gray-800">列のマッピング</h2>
          <p className="text-sm text-gray-500 mt-1">
            各列の役割を指定してください。摘要は複数列を選択できます。
          </p>
        </div>

        <div className="p-4 border-b border-gray-100">
          <div className="flex gap-2 flex-wrap items-center">
            {COLUMN_ROLES.map((role) => {
              const isDesc = role.key === 'descriptionColumn'
              const assigned = isDesc ? descColumns.length > 0 : mapping[role.key] >= 0
              const label = isDesc && descColumns.length > 0
                ? `${role.label} (列${descColumns.map((c) => c + 1).join(',')})`
                : !isDesc && mapping[role.key] >= 0
                  ? `${role.label} (列${mapping[role.key] + 1})`
                  : role.label
              return (
                <button
                  key={role.key}
                  onClick={() => setActiveRole(role.key)}
                  className={`px-3 py-1.5 text-sm rounded border ${
                    activeRole === role.key
                      ? `${role.color} border-2 font-bold`
                      : 'bg-gray-50 border-gray-200 text-gray-600'
                  } ${assigned ? 'ring-2 ring-offset-1' : ''}`}
                >
                  {label}
                </button>
              )
            })}
          </div>
          <p className="text-xs text-gray-400 mt-2">
            上のボタンで役割を選択 → 下のテーブルで列ヘッダーをクリック
            {activeRole === 'descriptionColumn' && <span className="text-green-600 font-bold ml-1">（摘要: 複数列選択可）</span>}
          </p>
        </div>

        <div className="flex-1 overflow-auto p-4">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr>
                {Array.from({ length: maxCols }, (_, i) => (
                  <th
                    key={i}
                    onClick={() => handleColumnClick(i)}
                    className={`border border-gray-300 px-2 py-2 cursor-pointer hover:bg-blue-50 transition-colors min-w-[80px] ${getColumnColor(i)}`}
                  >
                    <div className="text-center">
                      <span className="block text-gray-400">列{i + 1}</span>
                      {getColumnRole(i) && (
                        <span className="block font-bold text-gray-700 mt-0.5">
                          {COLUMN_ROLES.find((r) => r.key === getColumnRole(i))?.label}
                          {getColumnRole(i) === 'descriptionColumn' && descColumns.length > 1 && (
                            <span className="text-green-600"> ({descColumns.indexOf(i) + 1})</span>
                          )}
                        </span>
                      )}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sampleRows.map((row, rowIdx) => (
                <tr key={rowIdx} className={rowIdx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                  {Array.from({ length: maxCols }, (_, colIdx) => (
                    <td
                      key={colIdx}
                      className={`border border-gray-200 px-2 py-1 truncate max-w-[150px] ${getColumnColor(colIdx)}`}
                      title={row.cells[colIdx] || ''}
                    >
                      {row.cells[colIdx] || ''}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="p-4 border-t border-gray-200 flex justify-between items-center">
          <div className="text-xs text-gray-500">
            {descColumns.length > 1 && `摘要: ${descColumns.length}列を結合して摘要にします`}
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
