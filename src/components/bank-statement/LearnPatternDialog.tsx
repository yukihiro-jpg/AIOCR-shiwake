'use client'

import { useState, useEffect } from 'react'
import type { JournalEntry } from '@/lib/bank-statement/types'

interface Props {
  open: boolean
  entry: JournalEntry | null
  relatedEntries: JournalEntry[] // 複合仕訳の場合の全行
  onConfirm: (amountMin: number | null, amountMax: number | null, applyToAll: boolean, matchType?: 'exact' | 'partial', matchText?: string, convertedDesc?: string) => void
  onCancel: () => void
}

export default function LearnPatternDialog({
  open, entry, relatedEntries, onConfirm, onCancel,
}: Props) {
  const [amountMin, setAmountMin] = useState('')
  const [amountMax, setAmountMax] = useState('')
  const [matchType, setMatchType] = useState<'exact' | 'partial'>('partial')
  const [matchText, setMatchText] = useState('')
  const [convertedDesc, setConvertedDesc] = useState('')

  // エントリが変わるたびに一致文言をリセット
  const entryId = entry?.id
  useEffect(() => {
    if (entry) {
      setMatchText(entry.originalDescription || entry.description || '')
      setMatchType('partial')
      setConvertedDesc('')
      setAmountMin('')
      setAmountMax('')
    }
  }, [entryId])

  if (!open || !entry) return null

  const handleRegisterOnly = () => {
    const min = amountMin ? parseInt(amountMin.replace(/[^0-9]/g, '')) : null
    const max = amountMax ? parseInt(amountMax.replace(/[^0-9]/g, '')) : null
    onConfirm(min, max, false, matchType, matchText || undefined, convertedDesc || undefined)
    setAmountMin(''); setAmountMax('')
  }

  const handleRegisterAndApply = () => {
    const min = amountMin ? parseInt(amountMin.replace(/[^0-9]/g, '')) : null
    const max = amountMax ? parseInt(amountMax.replace(/[^0-9]/g, '')) : null
    onConfirm(min, max, true, matchType, matchText || undefined, convertedDesc || undefined)
    setAmountMin(''); setAmountMax('')
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg">
        <div className="px-5 py-4 border-b border-gray-200">
          <h2 className="text-lg font-bold text-gray-800">パターン学習</h2>
        </div>

        <div className="p-5 space-y-4">
          {/* 学習内容プレビュー */}
          <div className="p-3 bg-gray-50 rounded-lg text-sm">
            <div className="text-xs text-gray-500 mb-1">通帳摘要（元）</div>
            <div className="font-medium text-gray-800 mb-2">{entry.originalDescription || '—'}</div>
            <div className="text-xs text-gray-500 mb-1">学習する仕訳</div>
            <table className="w-full text-xs border-collapse mb-1">
              <thead>
                <tr className="text-gray-500">
                  <th className="text-left py-0.5 pr-2">借方CD</th>
                  <th className="text-left py-0.5 pr-2">借方科目</th>
                  <th className="text-left py-0.5 pr-2">貸方CD</th>
                  <th className="text-left py-0.5 pr-2">貸方科目</th>
                  <th className="text-left py-0.5">摘要</th>
                </tr>
              </thead>
              <tbody>
                {relatedEntries.map((e, i) => (
                  <tr key={i}>
                    <td className="py-0.5 pr-2 font-bold text-gray-800">{e.debitCode}</td>
                    <td className="py-0.5 pr-2 text-gray-700">{e.debitName}</td>
                    <td className="py-0.5 pr-2 font-bold text-gray-800">{e.creditCode}</td>
                    <td className="py-0.5 pr-2 text-gray-700">{e.creditName}</td>
                    <td className="py-0.5 text-gray-500">{e.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {relatedEntries.length > 1 && (
              <span className="text-xs text-violet-600 font-medium">（複合仕訳 {relatedEntries.length}行）</span>
            )}
          </div>

          {/* 一致方式設定 */}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-2">一致方式</label>
            <div className="flex gap-3 mb-2">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="radio" checked={matchType === 'partial'} onChange={() => setMatchType('partial')} className="accent-blue-600" />
                <span className="text-sm">部分一致</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="radio" checked={matchType === 'exact'} onChange={() => setMatchType('exact')} className="accent-blue-600" />
                <span className="text-sm">完全一致</span>
              </label>
            </div>
            <input type="text" value={matchText} onChange={(e) => setMatchText(e.target.value)}
              className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
              placeholder="一致判定に使う文言" />
            <p className="text-xs text-gray-400 mt-1">
              {matchType === 'exact'
                ? '摘要がこの文言と完全に一致する場合に適用されます'
                : '摘要にこの文言が含まれる場合に適用されます（完全一致パターンが優先）'}
            </p>
          </div>

          {/* 変換後摘要 */}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-2">
              変換後の摘要（任意）— 空欄なら元の摘要を保持
            </label>
            <input type="text" value={convertedDesc} onChange={(e) => setConvertedDesc(e.target.value)}
              maxLength={40}
              className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
              placeholder={matchType === 'exact' ? '例: 支払手数料' : '例: 荷造運賃（一致部分を置換）'} />
            <p className="text-xs text-gray-400 mt-1">
              {matchType === 'exact'
                ? '設定すると摘要全体がこのテキストに置換されます'
                : '設定すると一致部分のみがこのテキストに置換されます（残りは保持）'}
            </p>
          </div>

          {/* 金額範囲設定 */}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-2">
              金額範囲（任意）— 空欄なら制限なし
            </label>
            <div className="flex items-center gap-2">
              <input type="text" value={amountMin} onChange={(e) => setAmountMin(e.target.value)}
                placeholder="下限" className="flex-1 px-2 py-1 text-sm text-right border border-gray-300 rounded" />
              <span className="text-sm text-gray-500">〜</span>
              <input type="text" value={amountMax} onChange={(e) => setAmountMax(e.target.value)}
                placeholder="上限" className="flex-1 px-2 py-1 text-sm text-right border border-gray-300 rounded" />
            </div>
            <p className="text-xs text-gray-400 mt-1">
              この範囲内の金額のとき、このパターンが適用されます
            </p>
          </div>
        </div>

        <div className="px-5 py-4 border-t border-gray-200 flex gap-2">
          <button onClick={onCancel}
            className="flex-1 py-2 text-sm bg-gray-100 text-gray-700 rounded hover:bg-gray-200">
            キャンセル
          </button>
          <button onClick={handleRegisterOnly}
            className="flex-1 py-2 text-sm bg-blue-100 text-blue-700 font-medium rounded hover:bg-blue-200">
            登録のみ
          </button>
          <button onClick={handleRegisterAndApply}
            className="flex-1 py-2 text-sm bg-blue-600 text-white font-medium rounded hover:bg-blue-700">
            登録＋他データに反映
          </button>
        </div>
      </div>
    </div>
  )
}
