'use client'

import { useState, useEffect, useMemo } from 'react'
import type { PatternEntry, PatternLine } from '@/lib/bank-statement/types'
import {
  getPatterns,
  savePatterns,
  deletePattern,
  exportPatterns,
  importPatterns,
  clearPatterns,
} from '@/lib/bank-statement/pattern-store'

interface Props {
  open: boolean
  onClose: () => void
}

export default function PatternListDialog({ open, onClose }: Props) {
  const [patterns, setPatterns] = useState<PatternEntry[]>([])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editData, setEditData] = useState<EditState | null>(null)
  const [filterDuplicates, setFilterDuplicates] = useState(false)
  const [searchText, setSearchText] = useState('')

  useEffect(() => {
    if (open) { setPatterns(getPatterns()); setEditingId(null); setEditData(null) }
  }, [open])

  // 同一キーワードのパターンをグループ化して重複検出
  const duplicateKeywords = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const p of patterns) {
      const key = p.keyword.toLowerCase()
      counts[key] = (counts[key] || 0) + 1
    }
    return new Set(Object.entries(counts).filter(([, c]) => c > 1).map(([k]) => k))
  }, [patterns])

  const visiblePatterns = useMemo(() => {
    let list = patterns
    if (filterDuplicates) {
      list = list.filter((p) => duplicateKeywords.has(p.keyword.toLowerCase()))
    }
    if (searchText.trim()) {
      const q = searchText.trim().toLowerCase()
      list = list.filter((p) =>
        p.keyword.toLowerCase().includes(q) ||
        p.lines.some((l) =>
          l.debitCode.includes(q) || l.debitName.toLowerCase().includes(q) ||
          l.creditCode.includes(q) || l.creditName.toLowerCase().includes(q) ||
          (l.debitSubName || '').toLowerCase().includes(q) ||
          (l.creditSubName || '').toLowerCase().includes(q) ||
          (l.description || '').toLowerCase().includes(q)
        ) ||
        (p.accountCode || '').includes(q)
      )
    }
    return list
  }, [patterns, filterDuplicates, duplicateKeywords, searchText])

  if (!open) return null

  const startEdit = (p: PatternEntry) => {
    setEditingId(p.id)
    setEditData({
      amountMin: p.amountMin != null ? String(p.amountMin) : '',
      amountMax: p.amountMax != null ? String(p.amountMax) : '',
      lines: p.lines.map((l) => ({ ...l })),
    })
  }

  const handleSave = (id: string) => {
    if (!editData) return
    const updated = patterns.map((p) => {
      if (p.id !== id) return p
      return {
        ...p,
        amountMin: editData.amountMin ? parseInt(editData.amountMin) : null,
        amountMax: editData.amountMax ? parseInt(editData.amountMax) : null,
        lines: editData.lines,
      }
    })
    savePatterns(updated)
    setPatterns(updated)
    setEditingId(null)
    setEditData(null)
  }

  const updateLine = (lineIdx: number, field: keyof PatternLine, value: string | number) => {
    if (!editData) return
    setEditData({
      ...editData,
      lines: editData.lines.map((l, i) => i === lineIdx ? { ...l, [field]: value } : l),
    })
  }

  const addEditLine = () => {
    if (!editData) return
    setEditData({
      ...editData,
      lines: [...editData.lines, { debitCode: '', debitName: '', creditCode: '', creditName: '', taxCode: '', taxCategory: '', businessType: '', description: '', amount: 0 }],
    })
  }

  const removeEditLine = (lineIdx: number) => {
    if (!editData || editData.lines.length <= 1) return
    setEditData({
      ...editData,
      lines: editData.lines.filter((_, i) => i !== lineIdx),
    })
  }

  const handleDelete = (id: string) => {
    if (!confirm('このパターンを削除しますか？')) return
    deletePattern(id)
    setPatterns(getPatterns())
  }

  const handleExport = () => {
    const data = exportPatterns()
    const blob = new Blob([data], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `パターン学習_${new Date().toISOString().slice(0, 10)}.json`
    a.click()
  }

  const handleImport = async () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json'
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (!file) return
      const text = await file.text()
      const count = importPatterns(text)
      setPatterns(getPatterns())
      alert(`${count}件のパターンをインポートしました`)
    }
    input.click()
  }

  const handleClear = () => {
    if (confirm('すべてのパターン学習データを削除しますか？')) {
      clearPatterns()
      setPatterns([])
    }
  }

  const isDuplicate = (p: PatternEntry) => duplicateKeywords.has(p.keyword.toLowerCase())

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-5xl max-h-[85vh] flex flex-col">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-bold text-gray-800">学習済みパターン一覧 ({patterns.length}件)</h2>
            {duplicateKeywords.size > 0 && (
              <button
                onClick={() => setFilterDuplicates((v) => !v)}
                className={`px-2 py-0.5 text-xs font-bold rounded ${
                  filterDuplicates
                    ? 'bg-amber-500 text-white'
                    : 'bg-amber-100 text-amber-700 hover:bg-amber-200'
                }`}>
                重複の可能性あり {duplicateKeywords.size}件
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={handleImport} className="px-3 py-1 text-xs bg-gray-100 rounded hover:bg-gray-200">インポート</button>
            <button onClick={handleExport} className="px-3 py-1 text-xs bg-blue-100 text-blue-700 rounded hover:bg-blue-200">エクスポート</button>
            <button onClick={handleClear} className="px-3 py-1 text-xs bg-red-100 text-red-700 rounded hover:bg-red-200">全削除</button>
          </div>
        </div>
        {/* 検索バー */}
        <div className="px-6 py-2 border-b border-gray-100 flex items-center gap-3">
          <div className="relative flex-1 max-w-sm">
            <input type="text" value={searchText} onChange={(e) => setSearchText(e.target.value)}
              placeholder="摘要・科目CD・科目名・補助科目で検索..."
              className="w-full pl-8 pr-8 py-1.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400" />
            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 text-sm">🔍</span>
            {searchText && (
              <button onClick={() => setSearchText('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-sm">✕</button>
            )}
          </div>
          <span className="text-xs text-gray-500">
            {visiblePatterns.length !== patterns.length
              ? `${visiblePatterns.length} / ${patterns.length}件`
              : `${patterns.length}件`}
          </span>
        </div>

        <div className="flex-1 overflow-auto">
          <table className="w-full text-sm border-collapse">
            <thead className="sticky top-0 bg-gray-100 z-10">
              <tr>
                <th className="px-3 py-2 text-left border-b border-gray-300 font-medium w-40">通帳摘要（元）</th>
                <th className="px-3 py-2 text-left border-b border-gray-300 font-medium">借方</th>
                <th className="px-3 py-2 text-left border-b border-gray-300 font-medium">貸方</th>
                <th className="px-3 py-2 text-left border-b border-gray-300 font-medium w-20">税CD</th>
                <th className="px-3 py-2 text-center border-b border-gray-300 font-medium w-20">インボイス</th>
                <th className="px-3 py-2 text-left border-b border-gray-300 font-medium w-28">摘要</th>
                <th className="px-3 py-2 text-center border-b border-gray-300 font-medium w-20">下限</th>
                <th className="px-3 py-2 text-center border-b border-gray-300 font-medium w-20">上限</th>
                <th className="px-3 py-2 text-center border-b border-gray-300 font-medium w-12">回数</th>
                <th className="px-3 py-2 text-center border-b border-gray-300 font-medium w-24">操作</th>
              </tr>
            </thead>
            <tbody>
              {visiblePatterns.map((p) => {
                const isEditing = editingId === p.id
                const dup = isDuplicate(p)
                const displayLines = isEditing && editData ? editData.lines : p.lines
                return displayLines.map((line, li) => (
                  <tr key={`${p.id}-${li}`}
                    className={`border-b border-gray-100 hover:bg-gray-50 ${dup ? 'bg-amber-50' : ''}`}>
                    {li === 0 && (
                      <td className="px-3 py-2 align-top" rowSpan={displayLines.length}>
                        <div className="flex flex-col gap-0.5">
                          <span className="font-medium text-gray-800 text-xs break-all">{p.keyword}</span>
                          {p.accountCode && (
                            <span className="text-[10px] text-blue-600 bg-blue-50 px-1 rounded inline-block w-fit">科目:{p.accountCode}</span>
                          )}
                          {p.matchType && (
                            <span className={`text-[10px] px-1 rounded inline-block w-fit ${p.matchType === 'exact' ? 'text-red-600 bg-red-50' : 'text-green-600 bg-green-50'}`}>
                              {p.matchType === 'exact' ? '完全一致' : '部分一致'}
                              {p.matchText && p.matchText !== p.keyword ? `「${p.matchText}」` : ''}
                            </span>
                          )}
                          {p.convertedDescription && (
                            <span className="text-[10px] text-purple-600 bg-purple-50 px-1 rounded inline-block w-fit">→{p.convertedDescription}</span>
                          )}
                          {dup && (
                            <span className="text-xs text-amber-600 font-bold">* 重複あり</span>
                          )}
                          {displayLines.length > 1 && (
                            <span className="text-xs text-violet-600 font-medium">複合{displayLines.length}行</span>
                          )}
                        </div>
                      </td>
                    )}
                    {/* 借方 */}
                    <td className="px-2 py-1">
                      {isEditing && editData ? (
                        <div className="flex flex-col gap-0.5">
                          <div className="flex gap-0.5">
                            <input type="text" value={editData.lines[li]?.debitCode || ''} onChange={(e) => updateLine(li, 'debitCode', e.target.value)}
                              className="w-14 px-1 py-0.5 text-xs border border-gray-300 rounded" placeholder="CD" />
                            <input type="text" value={editData.lines[li]?.debitName || ''} onChange={(e) => updateLine(li, 'debitName', e.target.value)}
                              className="flex-1 px-1 py-0.5 text-xs border border-gray-200 rounded" placeholder="科目名" />
                          </div>
                          <div className="flex gap-0.5">
                            <input type="text" value={editData.lines[li]?.debitSubCode || ''} onChange={(e) => updateLine(li, 'debitSubCode', e.target.value)}
                              className="w-14 px-1 py-0.5 text-xs border border-gray-200 rounded" placeholder="補助CD" />
                            <input type="text" value={editData.lines[li]?.debitSubName || ''} onChange={(e) => updateLine(li, 'debitSubName', e.target.value)}
                              className="flex-1 px-1 py-0.5 text-xs border border-gray-200 rounded" placeholder="補助名" />
                          </div>
                        </div>
                      ) : (
                        <div className="text-xs">
                          <span className="font-bold text-gray-800">{line.debitCode}</span>
                          <span className="ml-1 text-gray-600">{line.debitName}</span>
                          {line.debitSubCode && (
                            <span className="ml-1 text-gray-400">[{line.debitSubCode} {line.debitSubName}]</span>
                          )}
                        </div>
                      )}
                    </td>
                    {/* 貸方 */}
                    <td className="px-2 py-1">
                      {isEditing && editData ? (
                        <div className="flex flex-col gap-0.5">
                          <div className="flex gap-0.5">
                            <input type="text" value={editData.lines[li]?.creditCode || ''} onChange={(e) => updateLine(li, 'creditCode', e.target.value)}
                              className="w-14 px-1 py-0.5 text-xs border border-gray-300 rounded" placeholder="CD" />
                            <input type="text" value={editData.lines[li]?.creditName || ''} onChange={(e) => updateLine(li, 'creditName', e.target.value)}
                              className="flex-1 px-1 py-0.5 text-xs border border-gray-200 rounded" placeholder="科目名" />
                          </div>
                          <div className="flex gap-0.5">
                            <input type="text" value={editData.lines[li]?.creditSubCode || ''} onChange={(e) => updateLine(li, 'creditSubCode', e.target.value)}
                              className="w-14 px-1 py-0.5 text-xs border border-gray-200 rounded" placeholder="補助CD" />
                            <input type="text" value={editData.lines[li]?.creditSubName || ''} onChange={(e) => updateLine(li, 'creditSubName', e.target.value)}
                              className="flex-1 px-1 py-0.5 text-xs border border-gray-200 rounded" placeholder="補助名" />
                          </div>
                        </div>
                      ) : (
                        <div className="text-xs">
                          <span className="font-bold text-gray-800">{line.creditCode}</span>
                          <span className="ml-1 text-gray-600">{line.creditName}</span>
                          {line.creditSubCode && (
                            <span className="ml-1 text-gray-400">[{line.creditSubCode} {line.creditSubName}]</span>
                          )}
                        </div>
                      )}
                    </td>
                    {/* 税CD + 行削除 */}
                    <td className="px-2 py-1">
                      {isEditing && editData ? (
                        <div className="flex items-center gap-0.5">
                          <input type="text" value={editData.lines[li]?.taxCode || ''} onChange={(e) => updateLine(li, 'taxCode', e.target.value)}
                            className="flex-1 px-1 py-0.5 text-xs border border-gray-300 rounded" placeholder="税CD" />
                          {editData.lines.length > 1 && (
                            <button onClick={() => removeEditLine(li)} title="この行を削除"
                              className="w-5 h-5 text-xs text-red-500 hover:bg-red-50 rounded flex items-center justify-center shrink-0">×</button>
                          )}
                        </div>
                      ) : (
                        <span className="text-xs text-gray-600">{line.taxCode} {line.taxCategory ? `(${line.taxCategory})` : ''}</span>
                      )}
                    </td>
                    {/* インボイス登録状況（businessType: '0'=登録 '1'=未登録） */}
                    <td className="px-2 py-1 text-center">
                      {isEditing && editData ? (
                        <button
                          type="button"
                          onClick={() => updateLine(li, 'businessType', (editData.lines[li]?.businessType === '1') ? '0' : '1')}
                          title={editData.lines[li]?.businessType === '1' ? 'インボイス未登録（クリックで登録者に変更）' : 'インボイス登録者（クリックで未登録に変更）'}
                          className={`px-1.5 py-0.5 text-xs rounded border ${
                            editData.lines[li]?.businessType === '1'
                              ? 'text-red-600 border-red-300 bg-red-50 font-bold'
                              : 'text-gray-500 border-gray-300 bg-white'
                          }`}>
                          {editData.lines[li]?.businessType === '1' ? '※未登録' : '登録'}
                        </button>
                      ) : (
                        line.businessType === '1' ? (
                          <span className="text-red-500 font-bold text-sm" title="インボイス未登録">※</span>
                        ) : (
                          <span className="text-gray-300 text-xs" title="インボイス登録者">—</span>
                        )
                      )}
                    </td>
                    {/* 摘要 */}
                    <td className="px-2 py-1">
                      {isEditing && editData ? (
                        <input type="text" value={editData.lines[li]?.description || ''} onChange={(e) => updateLine(li, 'description', e.target.value)}
                          className="w-full px-1 py-0.5 text-xs border border-gray-300 rounded" placeholder="摘要" />
                      ) : (
                        <span className="text-xs text-gray-500">{line.description || '—'}</span>
                      )}
                    </td>
                    {/* 金額範囲・回数・操作 (最初の行のみ) */}
                    {li === 0 && (
                      <>
                        <td className="px-2 py-1 text-center align-top" rowSpan={displayLines.length}>
                          {isEditing && editData ? (
                            <input type="text" value={editData.amountMin} onChange={(e) => setEditData({ ...editData, amountMin: e.target.value })}
                              className="w-16 px-1 py-0.5 text-xs border border-gray-300 rounded text-right" placeholder="なし" />
                          ) : (
                            <span className="text-xs text-gray-600">{p.amountMin != null ? p.amountMin.toLocaleString() : '—'}</span>
                          )}
                        </td>
                        <td className="px-2 py-1 text-center align-top" rowSpan={displayLines.length}>
                          {isEditing && editData ? (
                            <input type="text" value={editData.amountMax} onChange={(e) => setEditData({ ...editData, amountMax: e.target.value })}
                              className="w-16 px-1 py-0.5 text-xs border border-gray-300 rounded text-right" placeholder="なし" />
                          ) : (
                            <span className="text-xs text-gray-600">{p.amountMax != null ? p.amountMax.toLocaleString() : '—'}</span>
                          )}
                        </td>
                        <td className="px-2 py-1 text-center text-xs text-gray-500 align-top" rowSpan={displayLines.length}>{p.useCount}</td>
                        <td className="px-2 py-1 text-center align-top" rowSpan={isEditing ? (editData?.lines.length || p.lines.length) : p.lines.length}>
                          {isEditing ? (
                            <div className="flex flex-col gap-1">
                              <button onClick={() => handleSave(p.id)} className="text-xs text-blue-600 hover:underline font-bold">保存</button>
                              <button onClick={addEditLine} className="text-xs text-violet-600 hover:underline">+行追加</button>
                              <button onClick={() => { setEditingId(null); setEditData(null) }} className="text-xs text-gray-500 hover:underline">取消</button>
                            </div>
                          ) : (
                            <div className="flex flex-col gap-1">
                              <button onClick={() => startEdit(p)} className="text-xs text-blue-600 hover:underline">編集</button>
                              <button onClick={() => handleDelete(p.id)} className="text-xs text-red-600 hover:underline">削除</button>
                            </div>
                          )}
                        </td>
                      </>
                    )}
                  </tr>
                ))
              })}
              {visiblePatterns.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-3 py-8 text-center text-gray-400">
                    {filterDuplicates ? '重複しているパターンはありません。' : 'パターンがまだ学習されていません。'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="px-6 py-3 border-t border-gray-200">
          <button onClick={onClose}
            className="px-4 py-2 text-sm bg-gray-100 rounded hover:bg-gray-200">閉じる</button>
        </div>
      </div>
    </div>
  )
}

interface EditState {
  amountMin: string
  amountMax: string
  lines: PatternLine[]
}
