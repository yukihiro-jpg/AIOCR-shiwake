'use client'

import { useState } from 'react'
import type { JournalEntry } from '@/lib/bank-statement/types'
import { downloadCsv, applyCompoundAutoAmounts } from '@/lib/bank-statement/csv-generator'
import { learnAllFromEntries } from '@/lib/bank-statement/pattern-store'

interface Props {
  entries: JournalEntry[]
  dateFrom: string
  dateTo: string
  onDateFromChange: (v: string) => void
  onDateToChange: (v: string) => void
}

export default function CsvExportButton({ entries, dateFrom, dateTo, onDateFromChange, onDateToChange }: Props) {
  const [showPanel, setShowPanel] = useState(false)

  const filteredEntries = entries.filter((e) => {
    if (!e.date) return false
    const d = e.date.replace(/\D/g, '') // YYYYMMDD
    const from = dateFrom.replace(/\D/g, '')
    const to = dateTo.replace(/\D/g, '')
    if (from && d < from) return false
    if (to && d > to) return false
    return true
  })

  const handleExport = () => {
    if (filteredEntries.length === 0) {
      alert('指定期間内のデータがありません')
      return
    }
    // 複合仕訳の997自動計算金額を反映
    const finalEntries = applyCompoundAutoAmounts(filteredEntries)
    downloadCsv(finalEntries)
    // 一括パターン学習（自動計算後の金額で学習）
    const learned = learnAllFromEntries(finalEntries)
    console.log(`${learned}件のパターンを学習しました`)
    setShowPanel(false)
  }

  return (
    <div className="relative">
      <button onClick={() => setShowPanel(!showPanel)}
        className="fbtn fbtn-blue">
        CSV出力
      </button>

      {showPanel && (
        <div className="absolute right-0 top-full mt-2 w-72 bg-white border border-gray-200 rounded-lg shadow-xl z-50 p-4">
          <h3 className="text-sm font-bold text-gray-800 mb-3">CSV抽出期間</h3>
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <label className="text-xs text-gray-600 w-10">開始</label>
              <input type="date" value={dateFrom} onChange={(e) => onDateFromChange(e.target.value)}
                className="flex-1 px-2 py-1 text-sm border border-gray-300 rounded" />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs text-gray-600 w-10">終了</label>
              <input type="date" value={dateTo} onChange={(e) => onDateToChange(e.target.value)}
                className="flex-1 px-2 py-1 text-sm border border-gray-300 rounded" />
            </div>
          </div>
          <p className="text-xs text-gray-500 mt-2">対象: {filteredEntries.length}件 / 全{entries.length}件</p>
          <div className="flex gap-2 mt-3">
            <button onClick={() => setShowPanel(false)}
              className="flex-1 py-1.5 text-xs bg-gray-100 rounded hover:bg-gray-200">閉じる</button>
            <button onClick={handleExport}
              className="flex-1 py-1.5 text-xs bg-green-600 text-white rounded hover:bg-green-700">出力</button>
          </div>
        </div>
      )}
    </div>
  )
}
