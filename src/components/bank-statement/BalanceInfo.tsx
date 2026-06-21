'use client'

import { useState } from 'react'
import type { StatementPage, JournalEntry } from '@/lib/bank-statement/types'

interface Props {
  page: StatementPage
  entries?: JournalEntry[]
  bankAccountCode?: string
  onBalanceOverride?: (pageIndex: number, field: 'openingBalance' | 'closingBalance', value: number) => void
}

export default function BalanceInfo({ page, entries, bankAccountCode, onBalanceOverride }: Props) {
  const { openingBalance, closingBalance } = page
  const [editingField, setEditingField] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')

  let totalDeposit = 0
  let totalWithdrawal = 0

  if (entries && bankAccountCode) {
    const pageEntries = entries.filter((e) =>
      page.transactions.some((t) => t.id === e.transactionId),
    )
    for (const entry of pageEntries) {
      const amount = entry.debitAmount || entry.creditAmount || 0
      if (entry.debitCode === bankAccountCode) totalDeposit += amount
      else if (entry.creditCode === bankAccountCode) totalWithdrawal += amount
    }
  } else {
    totalDeposit = page.transactions.reduce((sum, t) => sum + (t.deposit ?? 0), 0)
    totalWithdrawal = page.transactions.reduce((sum, t) => sum + (t.withdrawal ?? 0), 0)
  }

  const calculatedClosing = openingBalance + totalDeposit - totalWithdrawal
  const difference = calculatedClosing - closingBalance
  const isValid = Math.abs(difference) < 1

  const startEdit = (field: string, currentValue: number) => {
    setEditingField(field)
    setEditValue(String(currentValue))
  }

  const confirmEdit = (field: 'openingBalance' | 'closingBalance') => {
    const num = parseInt(editValue.replace(/[^0-9-]/g, '')) || 0
    onBalanceOverride?.(page.pageIndex, field, num)
    setEditingField(null)
  }

  return (
    <div className="px-4 py-3 bg-[#fafbfd] border-t border-gray-200 shrink-0">
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        <div className="space-y-0.5">
          <div className="flex justify-between items-center">
            <span className="text-gray-500">開始残高:</span>
            {editingField === 'opening' ? (
              <input type="text" autoFocus value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={() => confirmEdit('openingBalance')}
                onKeyDown={(e) => { if (e.key === 'Enter') confirmEdit('openingBalance') }}
                className="w-28 px-1 py-0 text-sm text-right border border-blue-400 rounded outline-none" />
            ) : (
              <span className="font-medium text-gray-800 cursor-pointer hover:text-blue-600"
                onClick={() => startEdit('opening', openingBalance)}>
                &yen;{openingBalance.toLocaleString()}
              </span>
            )}
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">入金合計:</span>
            <span className="font-medium text-blue-700">+&yen;{totalDeposit.toLocaleString()}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">出金合計:</span>
            <span className="font-medium text-red-600">-&yen;{totalWithdrawal.toLocaleString()}</span>
          </div>
        </div>

        <div className="space-y-0.5">
          <div className="flex justify-between">
            <span className="text-gray-500">計算残高:</span>
            <span className={`font-medium ${isValid ? 'text-gray-800' : 'text-red-600'}`}>
              &yen;{calculatedClosing.toLocaleString()}
            </span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-gray-500">通帳残高:</span>
            {editingField === 'closing' ? (
              <input type="text" autoFocus value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={() => confirmEdit('closingBalance')}
                onKeyDown={(e) => { if (e.key === 'Enter') confirmEdit('closingBalance') }}
                className="w-28 px-1 py-0 text-sm text-right border border-blue-400 rounded outline-none" />
            ) : (
              <span className="font-medium text-gray-800 cursor-pointer hover:text-blue-600"
                onClick={() => startEdit('closing', closingBalance)}>
                &yen;{closingBalance.toLocaleString()}
              </span>
            )}
          </div>
          <div className="flex justify-between items-center">
            <span className="text-gray-500">検証:</span>
            {isValid ? (
              <span className="px-2.5 py-0.5 bg-green-100 text-green-700 rounded-full text-xs font-bold">OK 一致</span>
            ) : (
              <span className="px-2.5 py-0.5 bg-red-100 text-red-700 rounded-full text-xs font-bold">
                不一致 &yen;{Math.abs(difference).toLocaleString()}
              </span>
            )}
          </div>
        </div>
      </div>
      <p className="text-xs text-gray-400 mt-1">残高をクリックして手動修正できます</p>
    </div>
  )
}
