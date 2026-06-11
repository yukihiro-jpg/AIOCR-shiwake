'use client'

import { useState, useRef, useEffect, useCallback, memo } from 'react'
import type { JournalEntry, AccountItem, SubAccountItem } from '@/lib/bank-statement/types'
import { getTaxCodesForEntry, isBS, isPL, getDefaultTaxCodeByName } from '@/lib/bank-statement/tax-codes'

interface Props {
  entry: JournalEntry
  isSelected: boolean
  accountMaster: AccountItem[]
  subAccountMaster: SubAccountItem[]
  isPageBoundary?: boolean
  pageLabel?: string
  runningBalance?: number
  rowNumber: number
  isCompoundGroup?: boolean
  isCompoundFirst?: boolean
  isCompoundLast?: boolean
  clientTaxType?: string
  compoundAutoAmount?: number
  isBalanceMismatch?: boolean
  hideBalance?: boolean
  isChecked?: boolean
  onSelect: (id: string, e?: React.MouseEvent) => void
  onCheckToggle?: (id: string, e: React.MouseEvent) => void
  onChange: (id: string, field: keyof JournalEntry, value: string | number) => void
  onAddCompound: (id: string) => void
  onDelete: (id: string) => void
  onLearn: (id: string) => void
  onAddBlank: (id: string) => void
  onSubAccountRegister: (parentCode: string, subCode: string, name: string) => void
  onPatternClick?: (patternId: string) => void
}

const REQUIRED_FIELDS: (keyof JournalEntry)[] = ['debitCode', 'creditCode', 'debitTaxCode', 'debitTaxType']

function toHalfWidth(str: string): string {
  return str.replace(/[０-９]/g, (s) => String.fromCharCode(s.charCodeAt(0) - 0xFEE0))
    .replace(/[Ａ-Ｚａ-ｚ]/g, (s) => String.fromCharCode(s.charCodeAt(0) - 0xFEE0))
}

function JournalEntryRowInner({
  entry, isSelected, accountMaster, subAccountMaster,
  isPageBoundary, pageLabel, runningBalance, rowNumber,
  isCompoundGroup, isCompoundFirst, isCompoundLast, compoundAutoAmount, clientTaxType,
  isBalanceMismatch, hideBalance, isChecked,
  onSelect, onCheckToggle, onChange, onAddCompound, onDelete, onLearn, onAddBlank, onSubAccountRegister, onPatternClick,
}: Props) {
  const amount = entry.debitAmount || entry.creditAmount || 0
  const hasAutoCalc = compoundAutoAmount != null && compoundAutoAmount !== 0
  const displayAmount = hasAutoCalc ? compoundAutoAmount : amount

  // 金額編集state
  const [editingAmount, setEditingAmount] = useState(false)
  const [amountStr, setAmountStr] = useState('')

  const handleAmountSave = useCallback((v: string) => {
    const num = parseInt(v.replace(/[^0-9]/g, '')) || 0
    console.log(`[AmountSave] id=${entry.id}, value="${v}", num=${num}`)
    onChange(entry.id, '_amount' as keyof JournalEntry, num)
    setEditingAmount(false)
  }, [entry.id, onChange])

  const handleDebitCodeChange = (code: string) => {
    // 科目コード+名前+消費税を一括更新（クロージャ問題回避）
    onChange(entry.id, '_debitCodeFull' as keyof JournalEntry, code)
  }
  const handleCreditCodeChange = (code: string) => {
    onChange(entry.id, '_creditCodeFull' as keyof JournalEntry, code)
  }

  const isEmpty = (f: keyof JournalEntry) => { const v = entry[f]; return !v || (typeof v === 'string' && !v.trim()) }
  const emptyBg = (f: keyof JournalEntry) => REQUIRED_FIELDS.includes(f) && isEmpty(f) ? 'bg-rose-50' : ''

  // 消費税セル用: BS同士で税区不要 or 不課税が選択済みの場合は赤色にしない
  const debitAccForTax = accountMaster.find((a) => a.code === entry.debitCode)
  const creditAccForTax = accountMaster.find((a) => a.code === entry.creditCode)
  const isBsBothForTax = !!(debitAccForTax && creditAccForTax && isBS(debitAccForTax.bsPl) && isBS(creditAccForTax.bsPl))
  const isNonTaxable = (entry.debitTaxType || '').includes('不課')
  const taxCellBg = (isBsBothForTax || isNonTaxable) ? '' : emptyBg('debitTaxCode')

  let bgClass: string
  if (isSelected) bgClass = 'bg-sky-100'
  else if (isCompoundGroup) bgClass = 'bg-rose-50'
  else bgClass = rowNumber % 2 === 0 ? 'bg-white' : 'bg-gray-50'

  return (
    <>
      {isPageBoundary && (
        <tr className="bg-teal-600">
          <td colSpan={12} className="px-3 py-1 text-xs font-bold text-white">{pageLabel} ページ</td>
        </tr>
      )}
      <tr
        data-entry-id={entry.id}
        className={`${bgClass} hover:bg-sky-50 cursor-pointer transition-colors`}
        style={{
          borderBottom: '1px solid #cbd5e1',
          // 画面外行のレイアウト/ペイントをブラウザにスキップさせる（大量行での打鍵遅延を緩和）
          contentVisibility: 'auto',
          containIntrinsicSize: '40px',
        }}
        onClick={(e) => onSelect(entry.id, e)}
      >
        {/* 選択チェックボックス */}
        <td style={CB} className="text-center px-1 select-none">
          <input
            type="checkbox"
            checked={!!isChecked}
            onChange={() => { /* クリックで処理 */ }}
            onMouseDown={(e) => {
              // Shift+クリックでブラウザのテキスト範囲選択が走らないように抑止
              if (e.shiftKey) e.preventDefault()
            }}
            onClick={(e) => {
              e.stopPropagation()
              // 既に選択されたテキストがあれば解除
              if (typeof window !== 'undefined') window.getSelection()?.removeAllRanges()
              onCheckToggle?.(entry.id, e)
            }}
            className="w-4 h-4 cursor-pointer accent-blue-600"
            title="クリック=選択, Shift+クリック=範囲選択, Ctrl+クリック=個別追加"
          />
        </td>
        {/* 学習 */}
        <td style={CB} className="text-center">
          {entry.patternId ? (
            <button
              onClick={(e) => { e.stopPropagation(); onPatternClick?.(entry.patternId!) }}
              className="text-amber-500 hover:text-amber-600 text-base font-bold"
              title="パターン学習から生成（クリックで詳細）"
            >
              ★
            </button>
          ) : (
            <span className="text-gray-300 text-sm">—</span>
          )}
        </td>

        {/* 日付 */}
        <td style={CB}>
          <CellInput value={entry.date} onChange={(v) => onChange(entry.id, 'date', v)} placeholder="YYYYMMDD" halfWidth />
        </td>

        {/* 借方科目 */}
        <td style={CB} className={emptyBg('debitCode')}>
          <AccountField code={entry.debitCode} name={entry.debitName}
            subCode={entry.debitSubCode} subName={entry.debitSubName}
            accountMaster={accountMaster} subAccountMaster={subAccountMaster}
            onCodeChange={handleDebitCodeChange}
            onSubCodeChange={(sc, sn) => { onChange(entry.id, '_debitSubFull' as keyof JournalEntry, `${sc}|${sn}`) }}
            onSubAccountRegister={onSubAccountRegister} />
        </td>

        {/* 貸方科目 */}
        <td style={CB} className={emptyBg('creditCode')}>
          <AccountField code={entry.creditCode} name={entry.creditName}
            subCode={entry.creditSubCode} subName={entry.creditSubName}
            accountMaster={accountMaster} subAccountMaster={subAccountMaster}
            onCodeChange={handleCreditCodeChange}
            onSubCodeChange={(sc, sn) => { onChange(entry.id, '_creditSubFull' as keyof JournalEntry, `${sc}|${sn}`) }}
            onSubAccountRegister={onSubAccountRegister} />
        </td>

        {/* 金額 */}
        <td style={CB}>
          {hasAutoCalc ? (
            <span className="block px-2 py-1 text-sm text-right font-bold text-violet-700 tabular-nums">
              {displayAmount.toLocaleString()}
            </span>
          ) : editingAmount ? (
            <input type="text" inputMode="numeric" autoFocus
              value={amountStr}
              onChange={(e) => setAmountStr(e.target.value.replace(/[^0-9]/g, ''))}
              onBlur={() => handleAmountSave(amountStr)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); handleAmountSave(amountStr); navCell(e.currentTarget, 'down') }
                else if (e.key === 'Escape') setEditingAmount(false)
                else if (e.key === 'ArrowUp') { handleAmountSave(amountStr); navCell(e.currentTarget, 'up') }
                else if (e.key === 'ArrowDown') { handleAmountSave(amountStr); navCell(e.currentTarget, 'down') }
              }}
              className="w-full px-1.5 py-1 text-sm text-right bg-blue-50 border-0 outline-none ring-2 ring-blue-400 rounded font-medium tabular-nums" />
          ) : (
            <div tabIndex={0}
              onClick={(e) => { e.stopPropagation(); setAmountStr(amount ? String(amount) : ''); setEditingAmount(true); onSelect(entry.id) }}
              className="w-full px-1.5 py-1 text-sm text-right cursor-text rounded font-medium text-gray-800 tabular-nums hover:bg-gray-100 min-h-[28px]">
              {amount ? amount.toLocaleString() : ''}
            </div>
          )}
        </td>

        {/* 残高 */}
        {!hideBalance && (
          <td
            style={CB}
            className={`text-right px-2 py-1 ${isBalanceMismatch ? 'bg-green-100' : ''}`}
            title={isBalanceMismatch ? 'この取引から通帳残高と計算残高が不一致です' : undefined}
          >
            <span className="text-sm font-medium text-gray-700 tabular-nums">
              {runningBalance != null ? runningBalance.toLocaleString() : ''}
            </span>
          </td>
        )}

        {/* 消費税コード */}
        <td style={CB} className={taxCellBg}>
          <TaxCodeField
            taxCode={entry.debitTaxCode}
            taxType={entry.debitTaxType}
            taxRate={entry.debitTaxRate}
            debitCode={entry.debitCode}
            creditCode={entry.creditCode}
            accountMaster={accountMaster}
            onChange={(code, name) => {
              onChange(entry.id, '_taxFull' as keyof JournalEntry, `${code}|${name}`)
            }}
            onRateChange={(rate) => onChange(entry.id, 'debitTaxRate', rate)}
          />
        </td>

        {/* 事業者取引区分 */}
        <td style={CB} className="text-center">
          {entry.debitBusinessType === '1' ? (
            <button onClick={(e) => { e.stopPropagation(); onChange(entry.id, 'debitBusinessType', '0') }}
              title="インボイス未登録 → クリックで登録者に変更"
              className="text-red-500 font-bold text-sm cursor-pointer hover:text-red-700">※</button>
          ) : (
            <button onClick={(e) => { e.stopPropagation(); onChange(entry.id, 'debitBusinessType', '1') }}
              title="インボイス登録者 → クリックで未登録に変更"
              className="text-gray-300 text-xs cursor-pointer hover:text-red-400">—</button>
          )}
        </td>

        {/* 業種コード（簡易課税のみ表示） */}
        {clientTaxType === 'simplified' && (
          <td style={CB}>
            <select value={entry.debitIndustry || '0'}
              onChange={(e) => onChange(entry.id, 'debitIndustry', e.target.value)}
              className="w-full px-0.5 py-0.5 text-xs bg-transparent border-0 outline-none focus:bg-blue-50 focus:ring-1 focus:ring-blue-400 rounded text-center">
              <option value="0">-</option>
              <option value="1">1種</option>
              <option value="2">2種</option>
              <option value="3">3種</option>
              <option value="4">4種</option>
              <option value="5">5種</option>
              <option value="6">6種</option>
            </select>
          </td>
        )}

        {/* 摘要（40文字制限） */}
        <td style={CB}>
          <DescriptionInput
            value={entry.description}
            onCommit={(v) => onChange(entry.id, 'description', v)} />
        </td>

        {/* 操作 */}
        <td className="px-1 py-1">
          <div className="flex items-center gap-0.5" onMouseDown={(e) => e.stopPropagation()}>
            <button onClick={() => onAddCompound(entry.id)} title="複合仕訳行を追加"
              className="w-6 h-6 flex items-center justify-center text-xs text-violet-600 hover:bg-violet-100 rounded font-bold border border-violet-200">+</button>
            <button onClick={() => onLearn(entry.id)} title="パターン学習"
              className="w-6 h-6 flex items-center justify-center text-xs text-amber-600 hover:bg-amber-100 rounded font-bold border border-amber-200">★</button>
            <RowMenu
              onLearn={() => onLearn(entry.id)}
              onAddBlank={() => onAddBlank(entry.id)}
              onDelete={() => onDelete(entry.id)} />
          </div>
        </td>
      </tr>
    </>
  )
}

const CB: React.CSSProperties = { borderRight: '1px solid #94a3b8', padding: '2px 4px' }

// 摘要専用の uncontrolled input: 打鍵中は React の state/再レンダを一切発生させない
// 親への反映は blur / Enter 時のみ (628件級でも打鍵が軽い)
function DescriptionInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [local, setLocal] = useState(value)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { setLocal(value) }, [value])
  return (
    <input ref={ref} type="text" value={local}
      onChange={(e) => {
        if (e.target.value.length <= 25) setLocal(e.target.value)
      }}
      onBlur={() => { if (local !== value) onCommit(local) }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          if (local !== value) onCommit(local)
          handleNav(e)
        } else handleNav(e)
      }}
      placeholder="摘要" maxLength={40}
      lang="ja"
      style={{ imeMode: 'active' } as React.CSSProperties}
      className="w-full px-1.5 py-1 text-sm bg-transparent border-0 outline-none focus:bg-blue-50 focus:ring-1 focus:ring-blue-400 rounded text-gray-800" />
  )
}

function CellInput({ value, onChange, placeholder, halfWidth, align }: {
  value: string; onChange: (v: string) => void; placeholder?: string; halfWidth?: boolean; align?: string
}) {
  // Uncontrolled input: 打鍵中は React の state/再レンダを一切発生させず
  // ブラウザ標準の input 動作のみに任せる。親への反映は blur/Enter 時のみ。
  const ref = useRef<HTMLInputElement>(null)
  // 親から value が変化した場合にのみ DOM を同期
  useEffect(() => {
    if (ref.current && ref.current.value !== value) ref.current.value = value
  }, [value])

  const commit = useCallback((raw: string) => {
    const v = halfWidth ? toHalfWidth(raw) : raw
    if (v !== value) onChange(v)
  }, [halfWidth, value, onChange])

  return (
    <input ref={ref} type="text" defaultValue={value}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { commit(e.currentTarget.value); handleNav(e) }
        else handleNav(e)
      }}
      placeholder={placeholder}
      inputMode={halfWidth ? 'numeric' : undefined}
      style={halfWidth ? { imeMode: 'disabled' } as React.CSSProperties : undefined}
      className={`w-full px-1.5 py-1 text-sm bg-transparent border-0 outline-none focus:bg-blue-50 focus:ring-1 focus:ring-blue-400 rounded text-gray-800 ${align === 'right' ? 'text-right font-medium tabular-nums' : ''}`} />
  )
}

function AccountField({
  code, name, subCode, subName, accountMaster, subAccountMaster,
  onCodeChange, onSubCodeChange, onSubAccountRegister,
}: {
  code: string; name: string; subCode?: string; subName?: string
  accountMaster: AccountItem[]; subAccountMaster: SubAccountItem[]
  onCodeChange: (code: string) => void
  onSubCodeChange: (code: string, name: string) => void
  onSubAccountRegister: (parentCode: string, subCode: string, name: string) => void
}) {
  const [show, setShow] = useState(false)
  const [showSub, setShowSub] = useState(false)
  const [val, setVal] = useState(code)
  const [showNew, setShowNew] = useState(false)
  const [nsc, setNsc] = useState('')
  const [nsn, setNsn] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { setVal(code) }, [code])
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setShow(false); setShowSub(false)
        // showNewは閉じない（入力中に消えないように）
      }
    }
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h)
  }, [])

  const filtered = accountMaster
    .filter((a) => a.code.includes(val) || a.name.includes(val) || a.shortName.includes(val) || (a.association || '').includes(val))
    .slice(0, 12)
  const subs = subAccountMaster.filter((s) => s.parentCode === code)

  const confirm = (c: string) => {
    onCodeChange(c)
    setShow(false)
    // 補助科目がある場合は少し遅延してからサジェスト表示（外側クリックイベントとの競合回避）
    const hasSubs = subAccountMaster.filter((s) => s.parentCode === c).length > 0
    if (hasSubs) {
      setTimeout(() => setShowSub(true), 200)
    }
  }

  // 科目名のフォントカラー判定
  const acc = accountMaster.find((a) => a.code === code)
  let nameColor = 'text-gray-800' // BS: 黒
  if (acc) {
    if (isPL(acc.bsPl) && acc.normalBalance === '貸方') {
      nameColor = 'text-blue-600' // PL売上: 青
    } else if (isPL(acc.bsPl) && acc.normalBalance === '借方') {
      nameColor = 'text-red-600' // PL仕入経費: 赤
    }
  }

  return (
    <div ref={ref} className="relative">
      <div className="flex items-center gap-0 min-h-[28px] cursor-text" onClick={() => inputRef.current?.focus()}>
        <input ref={inputRef} type="text" inputMode="numeric" value={val}
          onChange={(e) => { const v = toHalfWidth(e.target.value); setVal(v); setShow(true) /* 打鍵のたびは親に伝播しない */ }}
          onFocus={() => {
            setShow(true)
            // 既に親コードが入っていて補助科目が登録されていれば補助サジェストを表示
            if (code && subAccountMaster.some((s) => s.parentCode === code)) setShowSub(true)
          }}
          onBlur={() => setTimeout(() => { if (val !== code) onCodeChange(val); setShow(false) }, 150)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); if (val !== code) onCodeChange(val); setShow(false); navCell(e.currentTarget, 'down') }
            else handleNav(e)
          }}
          style={{ imeMode: 'disabled' } as React.CSSProperties}
          className="w-12 shrink-0 px-1 py-0.5 text-sm text-gray-800 font-bold bg-transparent border-0 outline-none focus:bg-blue-50 focus:ring-1 focus:ring-blue-400 rounded" />
        <span className={`text-sm font-semibold truncate flex-1 ${nameColor}`}>{name}</span>
        {subName && <span className="text-xs text-gray-500 truncate">[{subName}]</span>}
      </div>

      {show && filtered.length > 0 && (
        <div className="absolute left-0 top-full mt-1 w-64 bg-white border border-gray-300 rounded-lg shadow-xl z-30 max-h-56 overflow-auto">
          {filtered.map((item) => (
            <button key={item.code}
              onMouseDown={(e) => { e.preventDefault(); setVal(item.code); confirm(item.code) }}
              className="w-full px-3 py-1.5 text-left text-sm hover:bg-blue-50 flex gap-2">
              <span className="text-blue-700 font-bold w-10 shrink-0">{item.code}</span>
              <span className="text-gray-800 font-medium">{item.shortName || item.name}</span>
            </button>
          ))}
          <button onMouseDown={(e) => { e.preventDefault(); setShow(false); setShowNew(true) }}
            className="w-full px-3 py-2 text-left text-xs text-blue-600 hover:bg-blue-50 border-t border-gray-100 font-medium">+ 新しく補助科目を登録する</button>
        </div>
      )}

      {showSub && subs.length > 0 && (
        <div className="absolute left-0 top-full mt-1 w-56 bg-white border border-gray-300 rounded-lg shadow-xl z-30 max-h-48 overflow-auto">
          <div className="px-3 py-1 text-xs text-gray-500 border-b border-gray-100 font-medium">補助科目を選択</div>
          {subs.map((s) => (
            <button key={s.subCode}
              onMouseDown={(e) => { e.preventDefault(); onSubCodeChange(s.subCode, s.shortName || s.name); setShowSub(false) }}
              className="w-full px-3 py-1.5 text-left text-sm hover:bg-blue-50 flex gap-2">
              <span className="text-blue-700 font-bold w-8 shrink-0">{s.subCode}</span>
              <span className="text-gray-800">{s.shortName || s.name}</span>
            </button>
          ))}
          <button onMouseDown={(e) => { e.preventDefault(); setShowSub(false); setShowNew(true) }}
            className="w-full px-3 py-2 text-left text-xs text-blue-600 hover:bg-blue-50 border-t border-gray-100 font-medium">+ 新しく補助科目を登録する</button>
        </div>
      )}

      {/* 補助科目がないが新規登録したい場合も表示 */}
      {showSub && subs.length === 0 && (
        <div className="absolute left-0 top-full mt-1 w-56 bg-white border border-gray-300 rounded-lg shadow-xl z-30">
          <div className="px-3 py-2 text-xs text-gray-500">補助科目がありません</div>
          <button onMouseDown={(e) => { e.preventDefault(); setShowSub(false); setShowNew(true) }}
            className="w-full px-3 py-2 text-left text-xs text-blue-600 hover:bg-blue-50 border-t border-gray-100 font-medium">+ 新しく補助科目を登録する</button>
        </div>
      )}

      {showNew && (
        <div
          className="absolute left-0 top-full mt-1 w-64 bg-white border border-gray-300 rounded-lg shadow-xl z-30 p-3"
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="text-xs font-bold text-gray-700 mb-2">補助科目を登録 (科目: {code})</div>
          <div className="space-y-2">
            <input type="text" autoFocus value={nsc}
              onChange={(e) => setNsc(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.currentTarget.parentElement?.querySelectorAll('input')[1] as HTMLInputElement | null)?.focus() } }}
              placeholder="補助コード" className="w-full px-2 py-1 text-sm border border-gray-300 rounded" />
            <input type="text" value={nsn}
              onChange={(e) => setNsn(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && code && nsc && nsn) { e.preventDefault(); onSubAccountRegister(code, nsc, nsn); onSubCodeChange(nsc, nsn); setShowNew(false); setNsc(''); setNsn('') } }}
              placeholder="補助科目名" className="w-full px-2 py-1 text-sm border border-gray-300 rounded" />
            <div className="flex gap-2">
              <button type="button" onClick={() => { setShowNew(false); setNsc(''); setNsn('') }} className="flex-1 py-1 text-xs bg-gray-100 rounded">キャンセル</button>
              <button type="button" disabled={!code || !nsc || !nsn}
                onClick={() => { onSubAccountRegister(code, nsc, nsn); onSubCodeChange(nsc, nsn); setShowNew(false); setNsc(''); setNsn('') }}
                className="flex-1 py-1 text-xs bg-blue-600 text-white rounded disabled:opacity-40">登録</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// 入力速度改善のため memo 化。entry/選択状態のみを比較し、
// runningBalance等の毎回変わる値は無視して不要な再描画を防ぐ
const JournalEntryRow = memo(JournalEntryRowInner, (prev, next) => {
  if (prev.entry !== next.entry) return false
  if (prev.isSelected !== next.isSelected) return false
  if (prev.isChecked !== next.isChecked) return false
  if (prev.isPageBoundary !== next.isPageBoundary) return false
  if (prev.compoundAutoAmount !== next.compoundAutoAmount) return false
  // runningBalance, isBalanceMismatch は毎回変わるが表示のみなので
  // entry自体が変わっていなければ再描画不要（値が古くてもすぐ次の更新で反映される）
  return true
})
export default JournalEntryRow

function RowMenu({ onLearn, onAddBlank, onDelete }: { onLearn: () => void; onAddBlank: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h)
  }, [])
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(!open)} className="w-6 h-6 flex items-center justify-center text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded text-xs">...</button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-36 bg-white border border-gray-200 rounded-lg shadow-xl z-20">
          <button onClick={() => { onLearn(); setOpen(false) }} className="w-full px-3 py-1.5 text-left text-xs hover:bg-gray-50">パターン学習</button>
          <button onClick={() => { onAddBlank(); setOpen(false) }} className="w-full px-3 py-1.5 text-left text-xs hover:bg-gray-50">空白行を追加</button>
          <hr className="border-gray-100" />
          <button onClick={() => { onDelete(); setOpen(false) }} className="w-full px-3 py-1.5 text-left text-xs text-red-600 hover:bg-red-50">削除</button>
        </div>
      )}
    </div>
  )
}

// 消費税名を短縮表示
function shortTaxName(name: string): string {
  if (!name) return ''
  if (name.includes('不課税')) return '不課'
  if (name.includes('非課税売上')) return '非売'
  if (name.includes('非課税仕入')) return '非仕'
  if (name.includes('課税売上')) return '課売'
  if (name.includes('課税仕入')) return '課仕'
  if (name.includes('非売')) return '非売'
  if (name.includes('非仕')) return '非仕'
  if (name.includes('課売')) return '課売'
  if (name.includes('課仕')) return '課仕'
  return name.slice(0, 2)
}

// 税率コードの表示名
function taxRateLabel(rate: string): string {
  if (rate === '4') return '10%'
  if (rate === '5') return '8%軽'
  if (rate === '3') return '8%'
  if (rate === '0' || !rate) return ''
  return rate
}

// 消費税コード選択フィールド
function TaxCodeField({
  taxCode, taxType, taxRate, debitCode, creditCode, accountMaster, onChange, onRateChange,
}: {
  taxCode: string; taxType: string; taxRate: string
  debitCode: string; creditCode: string
  accountMaster: AccountItem[]
  onChange: (code: string, name: string) => void
  onRateChange: (rate: string) => void
}) {
  const [show, setShow] = useState(false)
  const [inputVal, setInputVal] = useState(taxCode)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => { setInputVal(taxCode) }, [taxCode])
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setShow(false) }
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h)
  }, [])

  const taxCodes = getTaxCodesForEntry(debitCode, creditCode, accountMaster)
  const filtered = inputVal
    ? taxCodes.filter((t) => t.code.includes(inputVal) || t.name.includes(inputVal))
    : taxCodes

  const debitAcc = accountMaster.find((a) => a.code === debitCode)
  const creditAcc = accountMaster.find((a) => a.code === creditCode)
  const isBsOnly = debitAcc && creditAcc && isBS(debitAcc.bsPl) && isBS(creditAcc.bsPl)

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (filtered.length > 0 && inputVal) {
        const match = filtered[0]
        setInputVal(match.code)
        onChange(match.code, match.name)
        setShow(false)
      }
      navCell(e.currentTarget, 'down')
    } else { handleNav(e) }
  }

  if (isBsOnly) return <span className="text-xs text-gray-300 px-1">—</span>

  // 課税取引の場合のみ税率選択を表示
  const showRate = taxCode && taxCode !== '0' && taxCode !== '30' && taxCode !== '40' && taxCode !== '41'

  return (
    <div ref={ref} className="relative">
      <div className="flex items-center gap-0">
        <input type="text" value={inputVal}
          onChange={(e) => { setInputVal(e.target.value); setShow(true) /* 親への伝播は blur/Enter まで遅延 */ }}
          onFocus={() => setShow(true)}
          onBlur={() => setTimeout(() => {
            if (inputVal === taxCode) { setShow(false); return }
            const m = taxCodes.find((t) => t.code === inputVal)
            if (m) onChange(m.code, m.name)
            else if (inputVal) onChange(inputVal, '')
            setShow(false)
          }, 150)}
          onKeyDown={handleKeyDown}
          placeholder="CD"
          className="w-7 shrink-0 px-0 py-0.5 text-xs font-bold bg-transparent border-0 outline-none focus:bg-blue-50 focus:ring-1 focus:ring-blue-400 rounded text-center" />
        <span className="text-xs text-gray-600 shrink-0">{shortTaxName(taxType)}</span>
        {showRate && (
          <select key={taxRate || '4'} value={taxRate === '5' || taxRate === '3' ? taxRate : '4'}
            onChange={(e) => onRateChange(e.target.value)}
            className="ml-0.5 text-xs bg-transparent border-0 outline-none text-blue-600 font-medium cursor-pointer py-0 px-0">
            <option value="4">10%</option>
            <option value="5">8%軽</option>
            <option value="3">8%</option>
          </select>
        )}
      </div>
      {show && filtered.length > 0 && (
        <div className="absolute left-0 top-full mt-1 w-56 bg-white border border-gray-300 rounded-lg shadow-xl z-30 max-h-48 overflow-auto">
          {filtered.map((t) => (
            <button key={`${t.category}-${t.code}`}
              onMouseDown={(e) => { e.preventDefault(); setInputVal(t.code); onChange(t.code, t.name); setShow(false) }}
              className="w-full px-3 py-1.5 text-left text-xs hover:bg-blue-50 flex gap-2">
              <span className="text-blue-700 font-bold w-6 shrink-0">{t.code}</span>
              <span className="text-gray-700">{t.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function handleNav(e: React.KeyboardEvent<HTMLInputElement>) {
  const el = e.currentTarget
  // Shift キーを押している間はセル内のテキスト範囲選択中なので、隣セルに移動しない
  if (e.shiftKey) return
  if (e.key === 'Enter') { e.preventDefault(); navCell(el, 'down') }
  else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); navCell(el, e.key === 'ArrowUp' ? 'up' : 'down') }
  else if (e.key === 'ArrowLeft' && el.selectionStart === 0) navCell(el, 'left')
  else if (e.key === 'ArrowRight' && el.selectionStart === el.value.length) navCell(el, 'right')
}

function navCell(current: HTMLElement, dir: 'up' | 'down' | 'left' | 'right' | 'next-row'): boolean {
  const td = current.closest('td'); if (!td) return false
  const tr = td.closest('tr'); if (!tr) return false
  const cells = Array.from(tr.querySelectorAll('td')); const ci = cells.indexOf(td)
  let tgt: Element | null = null

  if (dir === 'left') { for (let i = ci - 1; i >= 0; i--) if (cells[i].querySelector('input')) { tgt = cells[i]; break } }
  else if (dir === 'right') { for (let i = ci + 1; i < cells.length; i++) if (cells[i].querySelector('input')) { tgt = cells[i]; break } }
  else if (dir === 'next-row') {
    const tbody = tr.closest('tbody'); if (!tbody) return false
    const rows = Array.from(tbody.querySelectorAll('tr')); const ri = rows.indexOf(tr)
    // 次の行を探す（ヘッダー行など input がない行はスキップ）
    for (let r = ri + 1; r < rows.length; r++) {
      const next = rows[r]
      for (const c of Array.from(next.querySelectorAll('td'))) {
        if (c.querySelector('input')) { tgt = c; break }
      }
      if (tgt) break
    }
  } else {
    const tbody = tr.closest('tbody'); if (!tbody) return false
    const rows = Array.from(tbody.querySelectorAll('tr')); const ri = rows.indexOf(tr)
    const t = dir === 'up' ? rows[ri - 1] : rows[ri + 1]
    if (t) { const tc = Array.from(t.querySelectorAll('td')); if (tc[ci]) tgt = tc[ci] }
  }
  if (tgt) { const inp = tgt.querySelector('input') as HTMLInputElement | null; if (inp) { inp.focus(); return true } }
  return false
}
