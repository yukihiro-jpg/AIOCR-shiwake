'use client'

import { useState } from 'react'
import type { RawTableRow } from '@/lib/bank-statement/types'

export interface ReceiptColumnMapping {
  dateColumn: number
  storeNameColumn: number
  mainContentColumns: number[]    // 主な品名（複数列結合可）
  totalAmountColumn: number       // 支払総額
  amount10Column: number          // 10%対象額（任意）
  amount8Column: number           // 軽減8%対象額（任意）
  amountExemptColumn: number      // 対象外金額（任意）
  invoiceNumberColumn: number     // インボイス番号（任意）
  memoColumn: number              // 備考（任意）
  headerRowIndex: number          // 0 始まり。データ開始行 = headerRowIndex + 1
}

interface Props {
  rows: RawTableRow[]
  onConfirm: (mapping: ReceiptColumnMapping) => void
  onCancel: () => void
}

interface RoleDef {
  key: keyof Omit<ReceiptColumnMapping, 'mainContentColumns' | 'headerRowIndex'> | 'mainContentColumns'
  label: string
  color: string
  required: boolean
  multi: boolean
}

const ROLES: RoleDef[] = [
  { key: 'dateColumn', label: '日付', color: 'bg-blue-100 border-blue-400', required: true, multi: false },
  { key: 'storeNameColumn', label: '相手先名称', color: 'bg-indigo-100 border-indigo-400', required: true, multi: false },
  { key: 'mainContentColumns', label: '主な品名', color: 'bg-green-100 border-green-400', required: false, multi: true },
  { key: 'totalAmountColumn', label: '支払総額', color: 'bg-yellow-100 border-yellow-400', required: true, multi: false },
  { key: 'amount10Column', label: '10%対象額', color: 'bg-amber-100 border-amber-400', required: false, multi: false },
  { key: 'amount8Column', label: '軽減8%対象額', color: 'bg-orange-100 border-orange-400', required: false, multi: false },
  { key: 'amountExemptColumn', label: '対象外金額', color: 'bg-rose-100 border-rose-400', required: false, multi: false },
  { key: 'invoiceNumberColumn', label: 'インボイス番号', color: 'bg-purple-100 border-purple-400', required: false, multi: false },
  { key: 'memoColumn', label: '備考', color: 'bg-slate-100 border-slate-400', required: false, multi: false },
]

export default function ReceiptColumnMappingDialog({ rows, onConfirm, onCancel }: Props) {
  const [mapping, setMapping] = useState<Record<string, number>>({
    dateColumn: -1,
    storeNameColumn: -1,
    totalAmountColumn: -1,
    amount10Column: -1,
    amount8Column: -1,
    amountExemptColumn: -1,
    invoiceNumberColumn: -1,
    memoColumn: -1,
  })
  const [mainContentColumns, setMainContentColumns] = useState<number[]>([])
  const [headerRowIndex, setHeaderRowIndex] = useState<number>(0)
  const [activeRole, setActiveRole] = useState<string>('dateColumn')

  const sampleRows = rows.slice(0, 30)
  const maxCols = Math.max(...sampleRows.map((r) => r.cells.length), 0)

  // ヘッダー行のテキストから自動推定
  const autoDetect = () => {
    const headerRow = rows[headerRowIndex]
    if (!headerRow) return
    const next: Record<string, number> = { ...mapping }
    let contentCols: number[] = []
    const KW: Record<string, string[]> = {
      dateColumn: ['日付', '年月日'],
      storeNameColumn: ['相手先', '取引先', '店名', '使用先'],
      totalAmountColumn: ['支払総額', '総額', '合計', '税込'],
      amount10Column: ['10%', '１０％', '10％'],
      amount8Column: ['軽減', '8%', '８％', '8％'],
      amountExemptColumn: ['対象外', '非課税', '不課税'],
      invoiceNumberColumn: ['インボイス', '登録番号'],
      memoColumn: ['備考', 'メモ'],
    }
    for (let i = 0; i < headerRow.cells.length; i++) {
      const c = headerRow.cells[i].replace(/[\s　]/g, '')
      for (const [key, kws] of Object.entries(KW)) {
        if (next[key] >= 0) continue
        if (kws.some((k) => c.includes(k))) { next[key] = i; break }
      }
      if (c.includes('品名') || c.includes('内容') || c === '摘要') {
        if (!contentCols.includes(i)) contentCols.push(i)
      }
    }
    setMapping(next)
    setMainContentColumns(contentCols)
  }

  const handleColumnClick = (colIndex: number) => {
    if (activeRole === 'mainContentColumns') {
      setMainContentColumns((prev) =>
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
      setMainContentColumns((prev) => prev.filter((c) => c !== colIndex))
    }
  }

  const getColumnRole = (colIndex: number): string | null => {
    if (mainContentColumns.includes(colIndex)) return 'mainContentColumns'
    for (const [key, value] of Object.entries(mapping)) {
      if (value === colIndex) return key
    }
    return null
  }

  const getColumnColor = (colIndex: number): string => {
    const role = getColumnRole(colIndex)
    if (!role) return ''
    return ROLES.find((r) => r.key === role)?.color || ''
  }

  const canConfirm = mapping.dateColumn >= 0 && mapping.storeNameColumn >= 0 && mapping.totalAmountColumn >= 0

  const handleConfirm = () => {
    onConfirm({
      dateColumn: mapping.dateColumn,
      storeNameColumn: mapping.storeNameColumn,
      mainContentColumns,
      totalAmountColumn: mapping.totalAmountColumn,
      amount10Column: mapping.amount10Column,
      amount8Column: mapping.amount8Column,
      amountExemptColumn: mapping.amountExemptColumn,
      invoiceNumberColumn: mapping.invoiceNumberColumn,
      memoColumn: mapping.memoColumn,
      headerRowIndex,
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-6xl max-h-[90vh] flex flex-col">
        <div className="p-5 border-b border-gray-200">
          <h2 className="text-lg font-bold text-gray-800">列のマッピング（レシート・領収書）</h2>
          <p className="text-sm text-gray-500 mt-1">
            各列の役割を指定してください。<span className="text-red-500 font-bold">日付・相手先名称・支払総額</span>は必須です。
            税率別の対象額（10%/軽減8%/対象外）が指定されていれば、複数税率の複合仕訳として変換します。
          </p>
        </div>

        <div className="p-4 border-b border-gray-100">
          <div className="flex gap-2 flex-wrap items-center">
            {ROLES.map((role) => {
              const isMulti = role.multi
              const assigned = isMulti ? mainContentColumns.length > 0 : mapping[role.key as string] >= 0
              const label = isMulti && mainContentColumns.length > 0
                ? `${role.label} (列${mainContentColumns.map((c) => c + 1).join(',')})`
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
            <button onClick={autoDetect} className="px-3 py-1 text-xs bg-blue-50 text-blue-700 border border-blue-200 rounded hover:bg-blue-100">
              ヘッダー行から自動判定
            </button>
            <p className="text-xs text-gray-400">
              {activeRole === 'mainContentColumns' && <span className="text-green-600 font-bold">主な品名: 複数列選択可</span>}
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
                          {ROLES.find((r) => r.key === getColumnRole(i))?.label}
                          {getColumnRole(i) === 'mainContentColumns' && mainContentColumns.length > 1 && (
                            <span className="text-green-600"> ({mainContentColumns.indexOf(i) + 1})</span>
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
              <span className="text-red-500 font-bold">※ 日付・相手先名称・支払総額の3列を必ず指定してください</span>
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
