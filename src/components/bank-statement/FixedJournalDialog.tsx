'use client'

import { useState, useEffect } from 'react'
import type { AccountItem, SubAccountItem, AccountTaxItem, JournalEntry } from '@/lib/bank-statement/types'
import { getFixedJournals, addFixedJournal, deleteFixedJournal, updateFixedJournal, type FixedJournalEntry, type FixedJournalLine } from '@/lib/bank-statement/fixed-journal-store'
import { createBlankEntry, createCompoundEntry } from '@/lib/bank-statement/journal-mapper'
import { appendTempEntries } from '@/lib/bank-statement/temp-store'
import { isPL } from '@/lib/bank-statement/tax-codes'

interface Props {
  open: boolean
  onClose: () => void
  accountMaster: AccountItem[]
  subAccountMaster?: SubAccountItem[]
  accountTaxMaster?: AccountTaxItem[]
  onTempCountChange: (count: number) => void
}

function emptyLine(): FixedJournalLine {
  return { debitCode: '', debitName: '', debitSubCode: '', debitSubName: '', creditCode: '', creditName: '', creditSubCode: '', creditSubName: '', taxCode: '', taxType: '', amount: 0 }
}

export default function FixedJournalDialog({ open, onClose, accountMaster, subAccountMaster, accountTaxMaster, onTempCountChange }: Props) {
  const [items, setItems] = useState<FixedJournalEntry[]>([])
  const [showAdd, setShowAdd] = useState(false)
  const [editingItemId, setEditingItemId] = useState<string | null>(null)
  const [formLines, setFormLines] = useState<FixedJournalLine[]>([emptyLine()])
  const [formDesc, setFormDesc] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkDate, setBulkDate] = useState('')
  // 一括生成用: 範囲年月 + 日付
  const [rangeMode, setRangeMode] = useState(false)
  const [rangeFrom, setRangeFrom] = useState('')  // YYYY-MM
  const [rangeTo, setRangeTo] = useState('')      // YYYY-MM
  const [rangeDay, setRangeDay] = useState('末日') // 1〜28,末日
  const [showPreview, setShowPreview] = useState(false)
  const [previewEntries, setPreviewEntries] = useState<JournalEntry[]>([])

  useEffect(() => { if (open) setItems(getFixedJournals()) }, [open])
  if (!open) return null

  const resolveCode = (code: string) => {
    const acc = accountMaster.find((a) => a.code === code)
    return acc?.shortName || acc?.name || ''
  }

  const autoTaxCode = (code: string): { taxCode: string; taxType: string } => {
    if (!accountTaxMaster || !code) return { taxCode: '', taxType: '' }
    const tax = accountTaxMaster.find((t) => t.accountCode === code)
    if (!tax || tax.categoryCode === '0') return { taxCode: '', taxType: '' }
    if (tax.categoryCode === '1') return { taxCode: tax.salesTaxCode, taxType: tax.salesTaxName }
    return { taxCode: tax.purchaseTaxCode, taxType: tax.purchaseTaxName }
  }

  const updateLine = (idx: number, field: keyof FixedJournalLine, value: string | number) => {
    setFormLines((prev) => prev.map((l, i) => {
      if (i !== idx) return l
      const updated = { ...l, [field]: value }
      if (field === 'debitCode') {
        updated.debitName = resolveCode(value as string)
        updated.debitSubCode = ''; updated.debitSubName = ''
        // PL科目なら消費税コード自動設定
        const acc = accountMaster.find((a) => a.code === value)
        if (acc && isPL(acc.bsPl) && !updated.taxCode) {
          const tax = autoTaxCode(value as string)
          if (tax.taxCode) { updated.taxCode = tax.taxCode; updated.taxType = tax.taxType }
        }
      }
      if (field === 'creditCode') {
        updated.creditName = resolveCode(value as string)
        updated.creditSubCode = ''; updated.creditSubName = ''
        const acc = accountMaster.find((a) => a.code === value)
        if (acc && isPL(acc.bsPl) && !updated.taxCode) {
          const tax = autoTaxCode(value as string)
          if (tax.taxCode) { updated.taxCode = tax.taxCode; updated.taxType = tax.taxType }
        }
      }
      return updated
    }))
  }

  const getSubAccounts = (code: string) =>
    code && subAccountMaster ? subAccountMaster.filter((s) => s.parentCode === code) : []

  const addLine = (afterIdx: number) => {
    const next = [...formLines]
    next.splice(afterIdx + 1, 0, emptyLine())
    setFormLines(next)
  }

  const removeLine = (idx: number) => {
    if (formLines.length <= 1) return
    setFormLines((prev) => prev.filter((_, i) => i !== idx))
  }

  const handleRegister = () => {
    if (formLines.every((l) => !l.debitCode && !l.creditCode)) return
    if (editingItemId) {
      updateFixedJournal(editingItemId, { lines: formLines, description: formDesc.slice(0, 25) })
      setEditingItemId(null)
    } else {
      addFixedJournal({ lines: formLines, description: formDesc.slice(0, 25) })
    }
    setItems(getFixedJournals())
    setShowAdd(false)
    setFormLines([emptyLine()])
    setFormDesc('')
  }

  const handleEdit = (item: FixedJournalEntry) => {
    setEditingItemId(item.id)
    setFormLines(item.lines.map((l) => ({ ...l })))
    setFormDesc(item.description)
    setShowAdd(true)
  }

  const toggleSelect = (id: string) => {
    const next = new Set(selectedIds)
    next.has(id) ? next.delete(id) : next.add(id)
    setSelectedIds(next)
  }

  // 指定年月+日で YYYYMMDD を生成（末日は自動判定）
  const getDateStr = (yearMonth: string, day: string): string => {
    const [y, m] = yearMonth.split('-').map(Number)
    if (!y || !m) return ''
    let d: number
    if (day === '末日') {
      d = new Date(y, m, 0).getDate() // 翌月0日 = 当月末日
    } else {
      d = parseInt(day)
      const maxDay = new Date(y, m, 0).getDate()
      if (d > maxDay) d = maxDay
    }
    return `${y}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`
  }

  // 範囲年月からすべての年月を列挙
  const getMonthsInRange = (): string[] => {
    if (!rangeFrom || !rangeTo) return []
    const [fy, fm] = rangeFrom.split('-').map(Number)
    const [ty, tm] = rangeTo.split('-').map(Number)
    if (!fy || !fm || !ty || !tm) return []
    const months: string[] = []
    let cy = fy, cm = fm
    while (cy < ty || (cy === ty && cm <= tm)) {
      months.push(`${cy}-${String(cm).padStart(2, '0')}`)
      cm++
      if (cm > 12) { cm = 1; cy++ }
    }
    return months
  }

  const createEntriesForDate = (date: string): JournalEntry[] => {
    const entries: JournalEntry[] = []
    for (const item of items) {
      if (!selectedIds.has(item.id)) continue
      const applyLine = (entry: JournalEntry, l: FixedJournalLine) => {
        entry.debitCode = l.debitCode; entry.debitName = l.debitName
        entry.debitSubCode = l.debitSubCode || ''; entry.debitSubName = l.debitSubName || ''
        entry.creditCode = l.creditCode; entry.creditName = l.creditName
        entry.creditSubCode = l.creditSubCode || ''; entry.creditSubName = l.creditSubName || ''
        entry.debitAmount = l.amount; entry.creditAmount = l.amount
        entry.debitTaxCode = l.taxCode || ''; entry.debitTaxType = l.taxType || ''
      }
      if (item.lines.length === 1) {
        const e = createBlankEntry()
        e.date = date; applyLine(e, item.lines[0])
        e.description = item.description; e.originalDescription = item.description
        entries.push(e)
      } else {
        const parent = createBlankEntry()
        parent.date = date; applyLine(parent, item.lines[0])
        parent.description = item.description; parent.originalDescription = item.description
        entries.push(parent)
        for (let i = 1; i < item.lines.length; i++) {
          const l = item.lines[i]
          const child = createCompoundEntry(parent)
          applyLine(child, l)
          child.debitCode = l.debitCode; child.debitName = l.debitName
          child.creditCode = l.creditCode; child.creditName = l.creditName
          child.debitAmount = l.amount; child.creditAmount = l.amount
          child.debitTaxType = l.taxType; child.description = item.description; child.originalDescription = item.description
          entries.push(child)
        }
      }
    }
    return entries
  }

  const handleCreateEntries = () => {
    if (selectedIds.size === 0) { alert('対象を選択してください'); return }

    if (rangeMode) {
      // 範囲年月モード
      const months = getMonthsInRange()
      if (months.length === 0) { alert('開始年月と終了年月を選択してください'); return }
      const allEntries: JournalEntry[] = []
      for (const ym of months) {
        const dateStr = getDateStr(ym, rangeDay)
        if (dateStr) allEntries.push(...createEntriesForDate(dateStr))
      }
      setPreviewEntries(allEntries)
      setShowPreview(true)
    } else {
      // 単一日付モード（従来）
      if (!bulkDate) { alert('日付を選択してください'); return }
      const date = bulkDate.replace(/-/g, '')
      setPreviewEntries(createEntriesForDate(date))
      setShowPreview(true)
    }
  }

  const handleConfirmSave = () => {
    const count = appendTempEntries(previewEntries)
    onTempCountChange(count)
    setShowPreview(false); setSelectedIds(new Set()); setBulkDate('')
    alert(`${previewEntries.length}件の仕訳を一時保存しました（合計${count}件）`)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-5xl max-h-[85vh] flex flex-col">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-lg font-bold text-gray-800">定型処理仕訳</h2>
          <button onClick={() => { setShowAdd(!showAdd); if (!showAdd) { setFormLines([emptyLine()]); setFormDesc(''); setEditingItemId(null) } }}
            className="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700">+ 新規登録</button>
        </div>

        {/* 登録フォーム（1行表示 + 複合仕訳行追加） */}
        {showAdd && (
          <div className="px-6 py-3 bg-blue-50 border-b border-blue-200 space-y-1">
            {formLines.map((line, idx) => (
              <div key={idx} className="flex items-center gap-1">
                <button onClick={() => addLine(idx)} className="w-6 h-6 text-xs text-blue-600 hover:bg-blue-100 rounded font-bold border border-blue-300">+</button>
                <button onClick={() => removeLine(idx)} disabled={formLines.length <= 1}
                  className="w-6 h-6 text-xs text-red-500 hover:bg-red-50 rounded font-bold border border-red-200 disabled:opacity-30">-</button>
                <input type="text" value={line.debitCode} onChange={(e) => updateLine(idx, 'debitCode', e.target.value)}
                  placeholder="借方CD" className="w-14 px-1 py-1 text-sm border border-gray-300 rounded text-center" />
                <span className="text-xs text-gray-500 w-14 truncate">{line.debitName}</span>
                {getSubAccounts(line.debitCode).length > 0 && (
                  <select value={line.debitSubCode || ''} onChange={(e) => {
                    const sub = getSubAccounts(line.debitCode).find((s) => s.subCode === e.target.value)
                    setFormLines((prev) => prev.map((l, j) => j === idx ? { ...l, debitSubCode: e.target.value, debitSubName: sub?.shortName || sub?.name || '' } : l))
                  }} className="w-20 px-0.5 py-1 text-xs border border-gray-300 rounded">
                    <option value="">補助</option>
                    {getSubAccounts(line.debitCode).map((s) => <option key={s.subCode} value={s.subCode}>{s.shortName || s.name}</option>)}
                  </select>
                )}
                <input type="text" value={line.creditCode} onChange={(e) => updateLine(idx, 'creditCode', e.target.value)}
                  placeholder="貸方CD" className="w-14 px-1 py-1 text-sm border border-gray-300 rounded text-center" />
                <span className="text-xs text-gray-500 w-14 truncate">{line.creditName}</span>
                {getSubAccounts(line.creditCode).length > 0 && (
                  <select value={line.creditSubCode || ''} onChange={(e) => {
                    const sub = getSubAccounts(line.creditCode).find((s) => s.subCode === e.target.value)
                    setFormLines((prev) => prev.map((l, j) => j === idx ? { ...l, creditSubCode: e.target.value, creditSubName: sub?.shortName || sub?.name || '' } : l))
                  }} className="w-20 px-0.5 py-1 text-xs border border-gray-300 rounded">
                    <option value="">補助</option>
                    {getSubAccounts(line.creditCode).map((s) => <option key={s.subCode} value={s.subCode}>{s.shortName || s.name}</option>)}
                  </select>
                )}
                <input type="text" value={line.amount || ''} onChange={(e) => updateLine(idx, 'amount', parseInt(e.target.value.replace(/[^0-9]/g, '')) || 0)}
                  placeholder="金額" className="w-20 px-1 py-1 text-sm border border-gray-300 rounded text-right" />
                <input type="text" value={line.taxCode || ''} onChange={(e) => setFormLines((prev) => prev.map((l, j) => j === idx ? { ...l, taxCode: e.target.value } : l))}
                  placeholder="税CD" className="w-12 px-1 py-1 text-xs border border-gray-300 rounded text-center" />
                <span className="text-xs text-gray-500 w-16 truncate">{line.taxType}</span>
              </div>
            ))}
            <div className="flex items-center gap-2 pt-1">
              <input type="text" value={formDesc} onChange={(e) => setFormDesc(e.target.value.slice(0, 25))}
                maxLength={25} placeholder="摘要（25文字以内）" className="flex-1 px-2 py-1 text-sm border border-gray-300 rounded" />
              <button onClick={handleRegister} className="px-4 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-700">
                {editingItemId ? '更新' : '登録'}
              </button>
              <button onClick={() => { setShowAdd(false); setEditingItemId(null); setFormLines([emptyLine()]); setFormDesc('') }}
                className="px-3 py-1 text-sm bg-gray-200 rounded">取消</button>
            </div>
            {editingItemId && <p className="text-xs text-amber-600 font-bold">編集中 — 変更を反映するには「更新」を押してください</p>}
            {formLines.length > 1 && <p className="text-xs text-blue-600">複合仕訳（{formLines.length}行）として{editingItemId ? '更新' : '登録'}されます</p>}
          </div>
        )}

        {/* 一括日付入力 + 作成ボタン */}
        {items.length > 0 && (
          <div className="px-6 py-3 bg-gray-50 border-b border-gray-200 space-y-2">
            <div className="flex items-center gap-3">
              <button onClick={() => setSelectedIds(selectedIds.size === items.length ? new Set() : new Set(items.map((i) => i.id)))}
                className="text-xs text-blue-600 hover:underline">
                {selectedIds.size === items.length ? '全解除' : '全選択'}
              </button>
              <span className="text-xs text-gray-500">{selectedIds.size}件選択</span>
              <label className="flex items-center gap-1 text-xs cursor-pointer">
                <input type="checkbox" checked={rangeMode} onChange={() => setRangeMode((v) => !v)}
                  className="w-3.5 h-3.5 accent-blue-600" />
                <span className={rangeMode ? 'text-blue-600 font-bold' : 'text-gray-500'}>範囲年月で一括生成</span>
              </label>
            </div>
            <div className="flex items-center gap-2">
              {rangeMode ? (
                <>
                  <input type="month" value={rangeFrom} onChange={(e) => setRangeFrom(e.target.value)}
                    className="px-2 py-1 text-sm border border-gray-300 rounded" />
                  <span className="text-xs text-gray-500">〜</span>
                  <input type="month" value={rangeTo} onChange={(e) => setRangeTo(e.target.value)}
                    className="px-2 py-1 text-sm border border-gray-300 rounded" />
                  <select value={rangeDay} onChange={(e) => setRangeDay(e.target.value)}
                    className="px-2 py-1 text-sm border border-gray-300 rounded">
                    {Array.from({ length: 28 }, (_, i) => (
                      <option key={i + 1} value={String(i + 1)}>{i + 1}日</option>
                    ))}
                    <option value="末日">末日</option>
                  </select>
                  <span className="text-xs text-gray-400">
                    {(() => {
                      const months = getMonthsInRange()
                      return months.length > 0 ? `${months.length}ヶ月分` : ''
                    })()}
                  </span>
                </>
              ) : (
                <input type="date" value={bulkDate} onChange={(e) => setBulkDate(e.target.value)}
                  className="px-2 py-1 text-sm border border-gray-300 rounded" />
              )}
              <button onClick={handleCreateEntries}
                disabled={selectedIds.size === 0 || (rangeMode ? !rangeFrom || !rangeTo : !bulkDate)}
                className="px-4 py-1 text-sm bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-40">
                {rangeMode ? '一括仕訳作成' : '仕訳作成'}
              </button>
            </div>
          </div>
        )}

        {/* 一覧 */}
        <div className="flex-1 overflow-auto">
          <table className="w-full text-sm border-collapse">
            <thead className="sticky top-0 bg-gray-100">
              <tr>
                <th className="px-2 py-2 w-10 text-center border-b border-gray-300"></th>
                <th className="px-2 py-2 text-left border-b border-gray-300">借方科目</th>
                <th className="px-2 py-2 text-left border-b border-gray-300">貸方科目</th>
                <th className="px-2 py-2 text-right border-b border-gray-300">金額</th>
                <th className="px-2 py-2 text-left border-b border-gray-300 w-16">税区</th>
                <th className="px-2 py-2 text-left border-b border-gray-300">摘要</th>
                <th className="px-2 py-2 w-12 border-b border-gray-300"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="px-2 py-2 text-center">
                    <input type="checkbox" checked={selectedIds.has(item.id)} onChange={() => toggleSelect(item.id)} />
                  </td>
                  <td className="px-2 py-2">
                    {item.lines.map((l, i) => (
                      <div key={i} className="text-xs"><span className="text-blue-700 font-bold">{l.debitCode}</span> {l.debitName}</div>
                    ))}
                    {item.lines.length > 1 && <span className="text-xs text-violet-600">複合{item.lines.length}行</span>}
                  </td>
                  <td className="px-2 py-2">
                    {item.lines.map((l, i) => (
                      <div key={i} className="text-xs"><span className="text-blue-700 font-bold">{l.creditCode}</span> {l.creditName}</div>
                    ))}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">
                    {item.lines.map((l, i) => (
                      <div key={i} className="text-xs">{l.amount.toLocaleString()}</div>
                    ))}
                  </td>
                  <td className="px-2 py-2">
                    {item.lines.map((l, i) => (
                      <div key={i} className="text-xs">{l.taxType}</div>
                    ))}
                  </td>
                  <td className="px-2 py-2 text-xs text-gray-600">{item.description}</td>
                  <td className="px-2 py-2 text-center space-x-2">
                    <button onClick={() => handleEdit(item)}
                      className="text-xs text-blue-600 hover:underline">編集</button>
                    <button onClick={() => { deleteFixedJournal(item.id); setItems(getFixedJournals()) }}
                      className="text-xs text-red-500 hover:underline">削除</button>
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr><td colSpan={7} className="px-3 py-8 text-center text-gray-400">定型仕訳が登録されていません</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* プレビュー確認 */}
        {showPreview && (
          <div className="px-6 py-4 bg-green-50 border-t border-green-200">
            <h3 className="text-sm font-bold text-green-800 mb-3">作成される仕訳（{previewEntries.length}件）</h3>
            <div className="max-h-48 overflow-auto mb-3 border border-green-200 rounded">
              <table className="w-full text-sm border-collapse">
                <thead className="bg-green-100 sticky top-0">
                  <tr>
                    <th className="px-3 py-1.5 text-left text-xs font-medium border-b border-green-200">日付</th>
                    <th className="px-3 py-1.5 text-left text-xs font-medium border-b border-green-200">借方コード</th>
                    <th className="px-3 py-1.5 text-left text-xs font-medium border-b border-green-200">借方科目名</th>
                    <th className="px-3 py-1.5 text-left text-xs font-medium border-b border-green-200">貸方コード</th>
                    <th className="px-3 py-1.5 text-left text-xs font-medium border-b border-green-200">貸方科目名</th>
                    <th className="px-3 py-1.5 text-right text-xs font-medium border-b border-green-200">金額</th>
                    <th className="px-3 py-1.5 text-left text-xs font-medium border-b border-green-200">摘要</th>
                  </tr>
                </thead>
                <tbody>
                  {previewEntries.map((e, i) => (
                    <tr key={i} className="border-b border-green-100">
                      <td className="px-3 py-1 text-xs">{e.date}</td>
                      <td className="px-3 py-1 text-xs text-blue-700 font-bold">{e.debitCode}</td>
                      <td className="px-3 py-1 text-xs">{e.debitName}</td>
                      <td className="px-3 py-1 text-xs text-blue-700 font-bold">{e.creditCode}</td>
                      <td className="px-3 py-1 text-xs">{e.creditName}</td>
                      <td className="px-3 py-1 text-xs text-right tabular-nums font-medium">{e.debitAmount.toLocaleString()}</td>
                      <td className="px-3 py-1 text-xs text-gray-600">{e.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-sm text-green-800 font-medium mb-2">この仕訳をCSVデータとして一時保存しますか？</p>
            <div className="flex gap-2">
              <button onClick={handleConfirmSave} className="px-4 py-1.5 text-sm bg-green-600 text-white rounded hover:bg-green-700">はい</button>
              <button onClick={() => setShowPreview(false)} className="px-4 py-1.5 text-sm bg-gray-200 rounded hover:bg-gray-300">いいえ</button>
            </div>
          </div>
        )}

        <div className="px-6 py-3 border-t border-gray-200">
          <button onClick={onClose} className="px-4 py-2 text-sm bg-gray-100 rounded hover:bg-gray-200">閉じる</button>
        </div>
      </div>
    </div>
  )
}
