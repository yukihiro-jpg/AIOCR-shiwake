'use client'

import { useState } from 'react'
import type { RawTableRow, ColumnMapping } from '@/lib/bank-statement/types'

interface Props {
  rawPages: RawTableRow[][]
  initialMapping?: ColumnMapping
  onConfirm: (mapping: ColumnMapping, options?: { expandAbbreviations?: boolean }) => void
  onCancel: () => void
  /** 'credit-card' のときは 日付/摘要/金額 の3役割（入金・出金・残高なし） */
  mode?: 'bank' | 'credit-card'
}

const BANK_ROLES = [
  { key: 'dateColumn', label: '日付', color: 'bg-blue-100 border-blue-400', multi: false },
  { key: 'descriptionColumn', label: '摘要', color: 'bg-green-100 border-green-400', multi: true },
  { key: 'depositColumn', label: '入金', color: 'bg-yellow-100 border-yellow-400', multi: false },
  { key: 'withdrawalColumn', label: '出金', color: 'bg-red-100 border-red-400', multi: false },
  { key: 'amountColumn', label: '金額(1列)', color: 'bg-teal-100 border-teal-400', multi: false },
  { key: 'directionColumn', label: '受払区分', color: 'bg-orange-100 border-orange-400', multi: false },
  { key: 'balanceColumn', label: '残高', color: 'bg-purple-100 border-purple-400', multi: false },
] as const

const CREDIT_CARD_ROLES = [
  { key: 'dateColumn', label: '利用日', color: 'bg-blue-100 border-blue-400', multi: false },
  { key: 'descriptionColumn', label: '利用内容（摘要）', color: 'bg-green-100 border-green-400', multi: true },
  { key: 'depositColumn', label: '利用金額', color: 'bg-yellow-100 border-yellow-400', multi: false },
] as const

export default function ColumnMappingDialog({ rawPages, initialMapping, onConfirm, onCancel, mode = 'bank' }: Props) {
  const isCreditCard = mode === 'credit-card'
  const COLUMN_ROLES = isCreditCard ? CREDIT_CARD_ROLES : BANK_ROLES
  const [mapping, setMapping] = useState<Record<string, number>>({
    dateColumn: initialMapping?.dateColumn ?? -1,
    depositColumn: initialMapping?.depositColumn ?? -1,
    withdrawalColumn: initialMapping?.withdrawalColumn ?? -1,
    amountColumn: initialMapping?.signedAmountColumn ?? -1,
    directionColumn: initialMapping?.directionColumn ?? -1,
    balanceColumn: initialMapping?.balanceColumn ?? -1,
  })
  const [descColumns, setDescColumns] = useState<number[]>(
    initialMapping?.descriptionColumns || (initialMapping?.descriptionColumn != null && initialMapping.descriptionColumn >= 0 ? [initialMapping.descriptionColumn] : [])
  )
  const [activeRole, setActiveRole] = useState<string>('dateColumn')
  const [expandAbbreviations, setExpandAbbreviations] = useState(false)
  // 内訳列（複合仕訳生成用）。ボタンで有効化したときだけ使用
  const [extrasEnabled, setExtrasEnabled] = useState<boolean>(
    !!(initialMapping?.extraColumns && initialMapping.extraColumns.length > 0)
  )
  const [extraColumns, setExtraColumns] = useState<{ col: number; name: string; direction: 'credit' | 'debit' }[]>(
    initialMapping?.extraColumns ? [...initialMapping.extraColumns] : []
  )

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

  // 金額の指定方法: 入金/出金の2列、または「金額(1列)」（符号付き or 受払区分と併用）
  const useSingleAmount = !isCreditCard && mapping.amountColumn >= 0
  const useDirection = useSingleAmount && mapping.directionColumn >= 0
  const hasAmount = isCreditCard
    ? mapping.depositColumn >= 0
    : (mapping.depositColumn >= 0 || mapping.withdrawalColumn >= 0 || mapping.amountColumn >= 0)
  const canConfirm = mapping.dateColumn >= 0 && hasAmount

  const handleConfirm = () => {
    // 内訳列: 有効かつ列が選択済みのものだけ採用
    const validExtras = extrasEnabled
      ? extraColumns.filter((e) => e.col >= 0 && e.name.trim().length > 0)
      : []
    onConfirm({
      dateColumn: mapping.dateColumn,
      descriptionColumn: descColumns.length > 0 ? descColumns[0] : -1,
      descriptionColumns: descColumns.length > 1 ? descColumns : undefined,
      depositColumn: useSingleAmount ? -1 : (mapping.depositColumn >= 0 ? mapping.depositColumn : mapping.withdrawalColumn),
      withdrawalColumn: useSingleAmount ? -1 : (mapping.withdrawalColumn >= 0 ? mapping.withdrawalColumn : mapping.depositColumn),
      balanceColumn: mapping.balanceColumn,
      signedAmountColumn: useSingleAmount ? mapping.amountColumn : undefined,
      directionColumn: useDirection ? mapping.directionColumn : undefined,
      extraColumns: validExtras.length > 0 ? validExtras : undefined,
    }, { expandAbbreviations })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-5xl max-h-[90vh] flex flex-col">
        <div className="p-5 border-b border-gray-200">
          <h2 className="text-lg font-bold text-gray-800">列のマッピング{isCreditCard ? '（クレジットカード）' : ''}</h2>
          <p className="text-sm text-gray-500 mt-1">
            {isCreditCard
              ? '各列の役割を指定してください。利用日・利用金額は必須です。'
              : '各列の役割を指定してください。摘要は複数列を選択できます。'}
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
          {!isCreditCard && (
            <p className="text-xs text-gray-500 mt-1 bg-gray-50 rounded px-2 py-1">
              金額の指定は次の3通り：
              <b>①入金・出金の2列</b> ／
              <b>②金額(1列)</b>（プラス=入金・マイナス=出金の符号付き1列）／
              <b>③金額(1列)＋受払区分</b>（金額はすべて正の数。「受入/入金」→入金、「払出/出金」→出金で振り分け）
            </p>
          )}
          {!isCreditCard && (
            <div className="mt-3 pt-3 border-t border-gray-100">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-sm font-bold text-gray-700">内訳列を使う</span>
                  <span className="ml-2 text-xs text-gray-500">
                    1取引（1行）を複合仕訳に展開（通帳の動きは取引金額1回のみ・諸口を経由して各内訳に振り分け）
                  </span>
                </div>
                <button
                  onClick={() => setExtrasEnabled((v) => !v)}
                  className={`px-3 py-1 text-xs rounded font-medium ${
                    extrasEnabled ? 'bg-emerald-600 text-white' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                  }`}
                >
                  {extrasEnabled ? 'ON' : 'OFF'}
                </button>
              </div>
              {extrasEnabled && (
                <div className="mt-2 space-y-1.5">
                  {extraColumns.map((ec, i) => (
                    <div key={i} className="flex items-center gap-2 bg-gray-50 rounded px-2 py-1.5">
                      <select
                        value={ec.col}
                        onChange={(e) => setExtraColumns((prev) => prev.map((x, j) => j === i ? { ...x, col: parseInt(e.target.value) } : x))}
                        className="text-xs border border-gray-300 rounded px-1 py-0.5"
                      >
                        <option value={-1}>列を選択</option>
                        {Array.from({ length: maxCols }, (_, k) => (
                          <option key={k} value={k}>列{k + 1}</option>
                        ))}
                      </select>
                      <input
                        type="text"
                        value={ec.name}
                        onChange={(e) => setExtraColumns((prev) => prev.map((x, j) => j === i ? { ...x, name: e.target.value } : x))}
                        placeholder="科目名（例: 家賃、ガス代、預り敷金返済）"
                        className="flex-1 text-xs border border-gray-300 rounded px-2 py-0.5"
                      />
                      <select
                        value={ec.direction}
                        onChange={(e) => setExtraColumns((prev) => prev.map((x, j) => j === i ? { ...x, direction: e.target.value as 'credit' | 'debit' } : x))}
                        className="text-xs border border-gray-300 rounded px-1 py-0.5"
                      >
                        <option value="credit">収入（貸方科目）</option>
                        <option value="debit">返金/相殺（借方科目）</option>
                      </select>
                      <button
                        onClick={() => setExtraColumns((prev) => prev.filter((_, j) => j !== i))}
                        className="px-2 text-xs text-red-500 hover:text-red-700"
                        title="この内訳列を削除"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                  <button
                    onClick={() => setExtraColumns((prev) => [...prev, { col: -1, name: '', direction: 'credit' }])}
                    className="text-xs px-2 py-1 bg-blue-50 text-blue-700 rounded hover:bg-blue-100"
                  >
                    + 内訳列を追加
                  </button>
                  <p className="text-[11px] text-gray-500 mt-1">
                    収入の内訳（家賃・ガス代等）は「収入」、敷金返済や返金は「返金/相殺」を選択。<br />
                    各内訳が「諸口 ↔ 該当科目」の複合仕訳として展開され、通帳側の動きは取引金額1回だけになります。
                  </p>
                </div>
              )}
            </div>
          )}
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

        {!isCreditCard && (
          <div className="px-4 pt-3 border-t border-gray-200">
            <label className="flex items-center gap-2 text-xs text-gray-700 cursor-pointer">
              <input type="checkbox" checked={expandAbbreviations}
                onChange={(e) => setExpandAbbreviations(e.target.checked)}
                className="w-4 h-4 accent-blue-600" />
              摘要の略記（〃・同上・先頭スペースで支払先名を省略）を AI で補完する
              <span className="text-gray-400">（現金出納帳などで名前部分が省略されている顧問先向け）</span>
            </label>
          </div>
        )}
        <div className="p-4 flex justify-between items-center">
          <div className="text-xs">
            {descColumns.length > 1 && <span className="text-gray-500">摘要: {descColumns.length}列を結合して摘要にします</span>}
            {mapping.dateColumn >= 0 && !hasAmount && (
              <span className="text-red-500 font-bold">※ {isCreditCard ? '利用金額' : '入金/出金、または金額(1列)'}の列を選択してください</span>
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
