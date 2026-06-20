'use client'

import { useCallback, useState, useMemo, useEffect, useRef } from 'react'
import type {
  JournalEntry,
  AccountItem,
  SubAccountItem,
  StatementPage,
  PatternLine,
} from '@/lib/bank-statement/types'
import {
  createBlankEntry,
  createCompoundEntry,
} from '@/lib/bank-statement/journal-mapper'
import { learnFromEntriesWithRange, getPatterns, savePatterns } from '@/lib/bank-statement/pattern-store'
import type { PatternEntry } from '@/lib/bank-statement/types'
import { saveSubAccountMaster } from '@/lib/bank-statement/account-master'
import { isPL, isBS, getDefaultTaxCodeByName } from '@/lib/bank-statement/tax-codes'
import JournalEntryRow from './JournalEntryRow'
import LearnPatternDialog from './LearnPatternDialog'
import ApplyPatternDialog from './ApplyPatternDialog'
import PatternDetailDialog from './PatternDetailDialog'

interface Props {
  entries: JournalEntry[]
  accountMaster: AccountItem[]
  subAccountMaster: SubAccountItem[]
  selectedEntryId: string | null
  onSelect: (entryId: string | null) => void
  onEntriesChange: (entries: JournalEntry[]) => void
  onSubAccountUpdate: (items: SubAccountItem[]) => void
  pages: StatementPage[]
  bankAccountCode: string
  clientTaxType?: string
  hideBalance?: boolean
  onSelectionChange?: (ids: Set<string>) => void
  onPageChange?: (pageIndex: number) => void
}

export default function JournalEntryTable({
  entries, accountMaster, subAccountMaster, selectedEntryId,
  onSelect, onEntriesChange, onSubAccountUpdate, pages, bankAccountCode, clientTaxType,
  hideBalance, onSelectionChange, onPageChange,
}: Props) {
  const [selectedRange, setSelectedRange] = useState<Set<string>>(new Set())
  // 範囲選択のアンカー（最後にクリックされた行ID）。クロージャ古さの影響を受けないよう ref で管理。
  const lastClickedIdRef = useRef<string | null>(null)
  const selectedEntryIdRef = useRef<string | null>(selectedEntryId)
  useEffect(() => { selectedEntryIdRef.current = selectedEntryId }, [selectedEntryId])
  const selectedRangeRef = useRef<Set<string>>(selectedRange)
  useEffect(() => { selectedRangeRef.current = selectedRange }, [selectedRange])
  const [showBulkEdit, setShowBulkEdit] = useState(false)
  const [bulkField, setBulkField] = useState<string>('')
  const [bulkValue, setBulkValue] = useState<string>('')
  // 未入力行のみを表示するフィルタ
  const [showOnlyIncomplete, setShowOnlyIncomplete] = useState(false)
  // 借方/貸方が空の行のみ表示するフィルタ（スナップショット方式）
  const [filterEmptyDebit, setFilterEmptyDebit] = useState(false)
  const [filterEmptyCredit, setFilterEmptyCredit] = useState(false)
  const [filteredDebitIds, setFilteredDebitIds] = useState<Set<string> | null>(null)
  const [filteredCreditIds, setFilteredCreditIds] = useState<Set<string> | null>(null)
  // 摘要検索フィルタ（スナップショット方式）
  const [descSearchText, setDescSearchText] = useState('')
  const [descFilterIds, setDescFilterIds] = useState<Set<string> | null>(null)
  // 科目別一覧表示
  const [showAccountSummary, setShowAccountSummary] = useState(false)
  // 科目別フィルタ（摘要検索とは独立、AND条件で適用）
  const [accountFilterIds, setAccountFilterIds] = useState<Set<string> | null>(null)
  const [accountFilterType, setAccountFilterType] = useState<'debit' | 'credit' | null>(null)
  const [accountFilterCode, setAccountFilterCode] = useState('')

  // 未処理トグル: クリック時点の空欄行IDを記録、再クリックで解除
  const toggleFilterEmptyDebit = useCallback(() => {
    if (filterEmptyDebit) {
      setFilterEmptyDebit(false)
      setFilteredDebitIds(null)
    } else {
      const ids = new Set(entriesRef.current.filter((e) => !e.debitCode).map((e) => e.id))
      setFilteredDebitIds(ids)
      setFilterEmptyDebit(true)
    }
  }, [filterEmptyDebit])

  const toggleFilterEmptyCredit = useCallback(() => {
    if (filterEmptyCredit) {
      setFilterEmptyCredit(false)
      setFilteredCreditIds(null)
    } else {
      const ids = new Set(entriesRef.current.filter((e) => !e.creditCode).map((e) => e.id))
      setFilteredCreditIds(ids)
      setFilterEmptyCredit(true)
    }
  }, [filterEmptyCredit])

  // 選択変更を親に通知
  const onSelectionChangeRef = useRef(onSelectionChange)
  useEffect(() => { onSelectionChangeRef.current = onSelectionChange }, [onSelectionChange])
  useEffect(() => { onSelectionChangeRef.current?.(selectedRange) }, [selectedRange])

  // ハンドラを安定参照にするため、最新 entries/accountMaster を ref に保持
  const entriesRef = useRef(entries)
  const accountMasterRef = useRef(accountMaster)
  useEffect(() => { entriesRef.current = entries }, [entries])
  useEffect(() => { accountMasterRef.current = accountMaster }, [accountMaster])

  // パターン学習ダイアログ
  const [learnDialogEntry, setLearnDialogEntry] = useState<JournalEntry | null>(null)
  const [learnRelatedEntries, setLearnRelatedEntries] = useState<JournalEntry[]>([])
  // 反映確認ダイアログ
  const [applyTargetEntries, setApplyTargetEntries] = useState<JournalEntry[]>([])
  const [applyPatternLines, setApplyPatternLines] = useState<PatternLine[]>([])
  // 反映対象パターンのメタ情報（摘要変換を確実に適用するため getPatterns 再検索に頼らない）
  const [applyPatternMeta, setApplyPatternMeta] = useState<{ id: string; matchType?: 'exact' | 'partial'; matchText?: string; convertedDescription?: string; replaceEntireDescription?: boolean } | null>(null)
  const [applyAmountRange, setApplyAmountRange] = useState<{ min: number | null; max: number | null } | null>(null)
  const [showApplyDialog, setShowApplyDialog] = useState(false)
  // パターン詳細ダイアログ
  const [patternDetailId, setPatternDetailId] = useState<string | null>(null)

  // パターン学習ダイアログ確定
  const handleLearnConfirm = useCallback(
    (amountMin: number | null, amountMax: number | null, applyToAll: boolean, matchType?: 'exact' | 'partial', matchText?: string, convertedDesc?: string, overrideExisting?: boolean, replaceEntireDescription?: boolean) => {
      if (!learnDialogEntry || learnRelatedEntries.length === 0) return
      const originalDesc = learnDialogEntry.originalDescription || learnDialogEntry.description
      if (!originalDesc) { setLearnDialogEntry(null); return }

      const patternId = learnFromEntriesWithRange(originalDesc, learnRelatedEntries, amountMin, amountMax, bankAccountCode)
      if (patternId) {
        const patterns = getPatterns()
        const pat = patterns.find((p: PatternEntry) => p.id === patternId)
        if (pat) {
          if (matchType) pat.matchType = matchType
          if (matchText) pat.matchText = matchText
          if (convertedDesc !== undefined) pat.convertedDescription = convertedDesc
          pat.replaceEntireDescription = !!replaceEntireDescription
          savePatterns(patterns)
        }
      }
      const learnedIds = new Set(learnRelatedEntries.map((e) => e.id))
      const primaryId = learnDialogEntry.id
      const effectiveMatchTextRaw = matchText || originalDesc
      const isExactMatch = matchType === 'exact'
      const fullReplace = isExactMatch || !!replaceEntireDescription
      const effectiveMatchText = effectiveMatchTextRaw.toLowerCase()

      // ある仕訳に対する変換後摘要を計算（変換後摘要が空なら元の摘要を維持）
      const computeDesc = (e: JournalEntry): string => {
        if (!convertedDesc) return e.description
        const sourceText = e.originalDescription || e.description || ''
        if (fullReplace) return convertedDesc
        return effectiveMatchTextRaw ? sourceText.replace(effectiveMatchTextRaw, convertedDesc) : convertedDesc
      }
      // この仕訳がパターンの一致条件を満たすか
      const matchesPattern = (e: JournalEntry): boolean => {
        if (e.parentId) return false
        const eDesc = (e.originalDescription || e.description || '').toLowerCase()
        if (!eDesc) return false
        if (isExactMatch ? eDesc !== effectiveMatchText : !eDesc.includes(effectiveMatchText)) return false
        const amt = e.debitAmount || e.creditAmount || 0
        if (amountMin != null && amt < amountMin) return false
        if (amountMax != null && amt > amountMax) return false
        return true
      }

      // 学習元の主行 + （applyToAll時）一致する他の行に、patternId と変換後摘要を即時反映する
      const updatedEntries = entries.map((e) => {
        if (learnedIds.has(e.id)) {
          const updated: JournalEntry = { ...e, patternId }
          if (convertedDesc && e.id === primaryId) updated.description = computeDesc(e)
          return updated
        }
        if (applyToAll && convertedDesc && matchesPattern(e)) {
          // 別パターン適用済みは override 時のみ上書き
          if (e.patternId && e.patternId !== patternId && !overrideExisting) return e
          return { ...e, patternId, description: computeDesc(e) }
        }
        return e
      })

      if (applyToAll) {
        const targets = updatedEntries.filter((e) => {
          if (learnedIds.has(e.id)) return false
          if (e.patternId && e.patternId !== patternId && !overrideExisting) return false
          return matchesPattern(e)
        })

        const patterns = getPatterns()
        const pat = patterns.find((p) => p.id === patternId)
        if (!pat) { onEntriesChange(updatedEntries); setLearnDialogEntry(null); return }

        setApplyTargetEntries(targets)
        setApplyPatternLines(pat.lines)
        setApplyPatternMeta({ id: pat.id, matchType: pat.matchType, matchText: pat.matchText || pat.keyword, convertedDescription: pat.convertedDescription, replaceEntireDescription: pat.replaceEntireDescription })
        setApplyAmountRange({ min: amountMin, max: amountMax })
        setShowApplyDialog(true)
        onEntriesChange(updatedEntries)
      } else {
        onEntriesChange(updatedEntries)
      }

      setLearnDialogEntry(null)
      setLearnRelatedEntries([])
    },
    [learnDialogEntry, learnRelatedEntries, entries, onEntriesChange],
  )

  // 反映確定
  const handleApplyConfirm = useCallback(() => {
    if (applyTargetEntries.length === 0 || applyPatternLines.length === 0) {
      setShowApplyDialog(false); return
    }

    const targetIds = new Set(applyTargetEntries.map((e) => e.id))
    const firstLine = applyPatternLines[0]
    const isCompoundPattern = applyPatternLines.length > 1

    // パターンから相手勘定コード・名称を取得（通帳科目と違う側）
    const getCounterpart = (line: typeof firstLine) => {
      if (line.debitCode !== bankAccountCode) {
        return { code: line.debitCode, name: line.debitName }
      }
      return { code: line.creditCode, name: line.creditName }
    }

    const newEntries: JournalEntry[] = []
    for (const e of entries) {
      // 再反映対象の行に紐づく「既存のパターン生成・複合子行」は除去する
      // （この後で複合パターンの子行を作り直すため。残すと反映のたびに子行が増殖する）
      if (e.parentId && targetIds.has(e.parentId) && e.patternId) {
        continue
      }
      if (!targetIds.has(e.id)) {
        newEntries.push(e)
        continue
      }
      const updatedEntry = { ...e }

      if (isCompoundPattern) {
        updatedEntry.debitCode = firstLine.debitCode
        updatedEntry.debitName = firstLine.debitName
        updatedEntry.debitSubCode = firstLine.debitSubCode || ''
        updatedEntry.debitSubName = firstLine.debitSubName || ''
        updatedEntry.creditCode = firstLine.creditCode
        updatedEntry.creditName = firstLine.creditName
        updatedEntry.creditSubCode = firstLine.creditSubCode || ''
        updatedEntry.creditSubName = firstLine.creditSubName || ''
      } else {
        const counter = getCounterpart(firstLine)
        if (bankAccountCode && e.debitCode === bankAccountCode) {
          // 通帳科目が借方にある → 相手科目を貸方へ
          updatedEntry.creditCode = counter.code
          updatedEntry.creditName = counter.name
          updatedEntry.creditSubCode = firstLine.creditSubCode || firstLine.debitSubCode || ''
          updatedEntry.creditSubName = firstLine.creditSubName || firstLine.debitSubName || ''
        } else if (bankAccountCode && e.creditCode === bankAccountCode) {
          // 通帳科目が貸方にある → 相手科目を借方へ
          updatedEntry.debitCode = counter.code
          updatedEntry.debitName = counter.name
          updatedEntry.debitSubCode = firstLine.debitSubCode || firstLine.creditSubCode || ''
          updatedEntry.debitSubName = firstLine.debitSubName || firstLine.creditSubName || ''
        } else {
          // 固定科目が特定できない（クレカ等で空欄、または両側とも固定科目と異なる）
          // → パターンの借方・貸方をそのまま適用する
          updatedEntry.debitCode = firstLine.debitCode
          updatedEntry.debitName = firstLine.debitName
          updatedEntry.debitSubCode = firstLine.debitSubCode || ''
          updatedEntry.debitSubName = firstLine.debitSubName || ''
          updatedEntry.creditCode = firstLine.creditCode
          updatedEntry.creditName = firstLine.creditName
          updatedEntry.creditSubCode = firstLine.creditSubCode || ''
          updatedEntry.creditSubName = firstLine.creditSubName || ''
        }
      }

      // 摘要: 反映対象パターン（applyPatternMeta）の変換後摘要を適用
      // getPatterns の再検索ではなく、今まさに反映中のパターンを直接使うことで確実に反映する
      const meta = applyPatternMeta
      if (meta) {
        updatedEntry.patternId = meta.id
        const converted = meta.convertedDescription
        if (converted) {
          if (meta.matchType === 'exact' || meta.replaceEntireDescription) {
            // 完全一致 or 全体置換指定: 摘要全体を変換後テキストに置換
            updatedEntry.description = converted
          } else {
            // 部分一致: 一致部分のみを変換後テキストに置換、残りは保持
            const mt = meta.matchText || ''
            updatedEntry.description = mt
              ? (e.originalDescription || e.description || '').replace(mt, converted)
              : converted
          }
        }
      }
      updatedEntry.debitTaxCode = firstLine.taxCode
      updatedEntry.debitTaxType = firstLine.taxCategory
      if (firstLine.taxRate) updatedEntry.debitTaxRate = firstLine.taxRate
      updatedEntry.debitBusinessType = firstLine.businessType
      newEntries.push(updatedEntry)

      // 複合仕訳パターンの追加行をそのまま展開
      if (isCompoundPattern) {
        for (let i = 1; i < applyPatternLines.length; i++) {
          const line = applyPatternLines[i]
          const compoundEntry = createCompoundEntry(updatedEntry)
          compoundEntry.patternId = updatedEntry.patternId
          compoundEntry.debitCode = line.debitCode
          compoundEntry.debitName = line.debitName
          compoundEntry.debitSubCode = line.debitSubCode || ''
          compoundEntry.debitSubName = line.debitSubName || ''
          compoundEntry.creditCode = line.creditCode
          compoundEntry.creditName = line.creditName
          compoundEntry.creditSubCode = line.creditSubCode || ''
          compoundEntry.creditSubName = line.creditSubName || ''
          compoundEntry.debitTaxCode = line.taxCode
          compoundEntry.debitTaxType = line.taxCategory
          if (line.taxRate) compoundEntry.debitTaxRate = line.taxRate
          compoundEntry.debitBusinessType = line.businessType
          // 複合仕訳の各行も、1行目（変換後摘要を適用済み）と同じ摘要にそろえる
          compoundEntry.description = updatedEntry.description
          compoundEntry.originalDescription = e.originalDescription
          // パターンの学習時金額を復元（997自動計算対象の最終行以外）
          compoundEntry.debitAmount = line.amount || 0
          compoundEntry.creditAmount = line.amount || 0
          newEntries.push(compoundEntry)
        }
      }
    }

    onEntriesChange(newEntries)
    setShowApplyDialog(false)
    setApplyTargetEntries([])
    setApplyPatternLines([])
    setApplyPatternMeta(null)
    setApplyAmountRange(null)
  }, [applyTargetEntries, applyPatternLines, applyPatternMeta, entries, onEntriesChange, bankAccountCode])

  const handleRowSelect = useCallback(
    (entryId: string, e?: React.MouseEvent) => {
      // ref で最新の entries / lastClickedId / selectedRange を参照（クロージャ古さ回避）
      const list = entriesRef.current
      const currentRange = selectedRangeRef.current

      // Shift+クリック: lastClickedId からの範囲選択（lastClickedId 未設定なら現在の単一選択を起点に）
      if (e?.shiftKey) {
        const anchorId = lastClickedIdRef.current || selectedEntryIdRef.current
        if (anchorId) {
          e.preventDefault()
          const s = list.findIndex((en) => en.id === anchorId)
          const ed = list.findIndex((en) => en.id === entryId)
          if (s >= 0 && ed >= 0) {
            const [from, to] = s < ed ? [s, ed] : [ed, s]
            const range = new Set<string>()
            for (let i = from; i <= to; i++) range.add(list[i].id)
            setSelectedRange(range)
            setShowBulkEdit(true)
            // アンカーは維持し、selectedEntryId を移動させない（サイドパネルが暴れないように）
          }
          return
        }
      }
      // Ctrl/Cmd+クリック: 個別にトグル追加
      if (e && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        const newRange = new Set(currentRange)
        if (newRange.size === 0 && selectedEntryIdRef.current) newRange.add(selectedEntryIdRef.current)
        if (newRange.has(entryId)) newRange.delete(entryId)
        else newRange.add(entryId)
        setSelectedRange(newRange)
        setShowBulkEdit(newRange.size > 0)
        lastClickedIdRef.current = entryId
        return
      }
      // 通常クリック: 単一選択・範囲解除（アンカー更新）
      setSelectedRange(new Set())
      setShowBulkEdit(false)
      lastClickedIdRef.current = entryId
      onSelect(entryId)
    },
    [onSelect],
  )

  // チェックボックスのクリック処理（範囲/個別トグル対応）
  const handleCheckToggle = useCallback(
    (entryId: string, e: React.MouseEvent) => {
      const list = entriesRef.current
      const currentRange = selectedRangeRef.current
      // Shift+クリック: アンカー（最後にクリックされた行 or 単一選択行）から範囲選択
      if (e.shiftKey) {
        const anchorId = lastClickedIdRef.current || selectedEntryIdRef.current
        if (anchorId) {
          const s = list.findIndex((en) => en.id === anchorId)
          const ed = list.findIndex((en) => en.id === entryId)
          if (s >= 0 && ed >= 0) {
            const [from, to] = s < ed ? [s, ed] : [ed, s]
            const newRange = new Set(currentRange)
            for (let i = from; i <= to; i++) newRange.add(list[i].id)
            setSelectedRange(newRange)
            setShowBulkEdit(newRange.size > 0)
          }
          return
        }
      }
      // 通常/Ctrl+クリック: 単独でトグル
      const newRange = new Set(currentRange)
      if (newRange.has(entryId)) newRange.delete(entryId)
      else newRange.add(entryId)
      setSelectedRange(newRange)
      setShowBulkEdit(newRange.size > 0)
      lastClickedIdRef.current = entryId
    },
    [],
  )

  // 現在のフィルタで表示されている行のIDを算出
  const getVisibleEntryIds = useCallback((): Set<string> => {
    const visible = new Set<string>()
    for (const entry of entriesRef.current) {
      // 借方未処理フィルタ
      if (filterEmptyDebit && filteredDebitIds && !filteredDebitIds.has(entry.id)) continue
      // 貸方未処理フィルタ
      if (filterEmptyCredit && filteredCreditIds && !filteredCreditIds.has(entry.id)) continue
      // 摘要検索フィルタ（スナップショット）
      if (descFilterIds && !descFilterIds.has(entry.id)) continue
      if (accountFilterIds && !accountFilterIds.has(entry.id)) continue
      // 未入力のみ表示フィルタ
      if (showOnlyIncomplete) {
        const debitAcc = accountMasterRef.current.find((a) => a.code === entry.debitCode)
        const creditAcc = accountMasterRef.current.find((a) => a.code === entry.creditCode)
        const isBsBoth = !!(debitAcc && creditAcc && isBS(debitAcc.bsPl) && isBS(creditAcc.bsPl))
        const taxOk = !!entry.debitTaxCode || isBsBoth
        if (entry.debitCode && entry.creditCode && taxOk) continue
      }
      visible.add(entry.id)
    }
    return visible
  }, [filterEmptyDebit, filteredDebitIds, filterEmptyCredit, filteredCreditIds, showOnlyIncomplete])

  // 全選択/全解除（フィルタ表示中は表示行のみを対象）
  const handleSelectAll = useCallback(() => {
    if (entries.length === 0) return
    const visibleIds = getVisibleEntryIds()
    if (visibleIds.size === 0) return
    // 既に全表示行が選択済み → 解除
    const allVisible = Array.from(visibleIds).every((id) => selectedRange.has(id))
    if (allVisible && selectedRange.size > 0) {
      setSelectedRange(new Set())
      setShowBulkEdit(false)
    } else {
      setSelectedRange(visibleIds)
      setShowBulkEdit(true)
    }
  }, [entries, selectedRange, getVisibleEntryIds])

  // 選択行の削除（複合仕訳の子も連鎖削除）
  const handleDeleteSelected = useCallback(() => {
    const ids = new Set<string>()
    if (selectedRange.size > 0) {
      selectedRange.forEach((id) => ids.add(id))
    } else if (selectedEntryId) {
      ids.add(selectedEntryId)
    }
    if (ids.size === 0) return
    // 親を削除する場合は子(parentId==親id)も削除
    for (const e of entries) {
      if (e.parentId && ids.has(e.parentId)) ids.add(e.id)
    }
    if (!window.confirm(`選択された ${ids.size} 件の仕訳を削除します。よろしいですか？`)) return
    onEntriesChange(entries.filter((e) => !ids.has(e.id)))
    setSelectedRange(new Set())
    setShowBulkEdit(false)
    onSelect(null)
  }, [entries, selectedRange, selectedEntryId, onEntriesChange, onSelect])

  // Delete キーで選択削除（入力フィールド内では無効）
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Delete') return
      const el = document.activeElement as HTMLElement | null
      if (el) {
        const tag = el.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable) return
      }
      if (selectedRange.size === 0 && !selectedEntryId) return
      ev.preventDefault()
      handleDeleteSelected()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleDeleteSelected, selectedRange.size, selectedEntryId])

  // ↑/↓ キーで選択行を上下に移動（左ペインのハイライトも連動）。入力フィールド内では無効。
  useEffect(() => {
    const onArrow = (ev: KeyboardEvent) => {
      if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') return
      const el = document.activeElement as HTMLElement | null
      if (el) {
        const tag = el.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable) return
      }
      const list = entriesRef.current
      if (list.length === 0) return
      // 現在のフィルタで表示されている行のみを、表示順で対象にする
      const visibleIds = getVisibleEntryIds()
      const ordered = list.filter((e) => visibleIds.has(e.id))
      if (ordered.length === 0) return
      ev.preventDefault()
      const curId = selectedEntryIdRef.current
      let idx = curId ? ordered.findIndex((e) => e.id === curId) : -1
      if (idx < 0) {
        idx = ev.key === 'ArrowDown' ? 0 : ordered.length - 1
      } else {
        idx = ev.key === 'ArrowDown' ? Math.min(ordered.length - 1, idx + 1) : Math.max(0, idx - 1)
      }
      const nextId = ordered[idx].id
      onSelect(nextId)
      // 右ペインの選択行も画面内に収める
      requestAnimationFrame(() => {
        document.querySelector(`[data-entry-id="${nextId}"]`)?.scrollIntoView({ block: 'nearest' })
      })
    }
    window.addEventListener('keydown', onArrow)
    return () => window.removeEventListener('keydown', onArrow)
  }, [getVisibleEntryIds, onSelect])

  // 行内の入力欄（日付・借方/貸方科目・金額等）にフォーカスが入ったら、その行を選択状態にする。
  // これにより、セル編集中に ↑/↓ で navCell が隣行の入力へフォーカス移動した際も、
  // 行選択（＝左プレビューのハイライト）が追随する。
  useEffect(() => {
    const onFocusIn = (ev: FocusEvent) => {
      const target = ev.target as HTMLElement | null
      if (!target) return
      const rowEl = target.closest('[data-entry-id]') as HTMLElement | null
      if (!rowEl) return
      const id = rowEl.getAttribute('data-entry-id')
      if (!id || id === selectedEntryIdRef.current) return
      onSelect(id)
    }
    window.addEventListener('focusin', onFocusIn)
    return () => window.removeEventListener('focusin', onFocusIn)
  }, [onSelect])

  const applyBulkEdit = useCallback(() => {
    if (!bulkField || selectedRange.size === 0) return
    const acc = accountMaster.find((a) => a.code === bulkValue)
    onEntriesChange(
      entries.map((entry) => {
        if (!selectedRange.has(entry.id)) return entry
        const u = { ...entry, [bulkField]: bulkValue }
        if (bulkField === 'debitCode' && acc) {
          u.debitName = acc.shortName || acc.name
          // PL科目の場合は消費税CDも自動設定
          if (isPL(acc.bsPl) && acc.normalBalance === '借方') {
            const tax = getDefaultTaxCodeByName(acc.name || acc.shortName, 'purchase')
            if (tax) { u.debitTaxCode = tax.taxCode; u.debitTaxType = tax.taxName; u.debitTaxRate = '4' }
          } else if (isPL(acc.bsPl) && acc.normalBalance === '貸方') {
            const tax = getDefaultTaxCodeByName(acc.name || acc.shortName, 'sales')
            if (tax) { u.debitTaxCode = tax.taxCode; u.debitTaxType = tax.taxName; u.debitTaxRate = '4' }
          } else if (isBS(acc.bsPl)) {
            // BS科目の場合: 相手科目もBSかチェック
            const otherAcc = accountMaster.find((a) => a.code === u.creditCode)
            if (otherAcc && isBS(otherAcc.bsPl)) {
              u.debitTaxCode = ''; u.debitTaxType = ''; u.debitTaxRate = ''
            }
          }
        }
        if (bulkField === 'creditCode' && acc) {
          u.creditName = acc.shortName || acc.name
          // PL科目の場合は消費税CDも自動設定
          if (isPL(acc.bsPl) && acc.normalBalance === '貸方') {
            const tax = getDefaultTaxCodeByName(acc.name || acc.shortName, 'sales')
            if (tax) { u.debitTaxCode = tax.taxCode; u.debitTaxType = tax.taxName; u.debitTaxRate = '4' }
          } else if (isPL(acc.bsPl) && acc.normalBalance === '借方') {
            const tax = getDefaultTaxCodeByName(acc.name || acc.shortName, 'purchase')
            if (tax) { u.debitTaxCode = tax.taxCode; u.debitTaxType = tax.taxName; u.debitTaxRate = '4' }
          } else if (isBS(acc.bsPl)) {
            const otherAcc = accountMaster.find((a) => a.code === u.debitCode)
            if (otherAcc && isBS(otherAcc.bsPl)) {
              u.debitTaxCode = ''; u.debitTaxType = ''; u.debitTaxRate = ''
            }
          }
        }
        return u
      }),
    )
    setShowBulkEdit(false); setSelectedRange(new Set()); setBulkValue('')
  }, [bulkField, bulkValue, selectedRange, entries, onEntriesChange, accountMaster])

  const handleEntryChange = useCallback(
    (id: string, field: keyof JournalEntry, value: string | number | boolean) => {
      const currentEntries = entriesRef.current
      const currentAccountMaster = accountMasterRef.current
      onEntriesChange(currentEntries.map((e) => {
        if (e.id !== id) return e
        // _amount は debitAmount と creditAmount の両方を同時更新
        if (field === '_amount' as keyof JournalEntry) {
          return { ...e, debitAmount: value as number, creditAmount: value as number }
        }
        // _debitCodeFull: 借方コード+科目名+消費税を一括更新
        if (field === '_debitCodeFull' as keyof JournalEntry) {
          const code = value as string
          const acc = currentAccountMaster.find((a) => a.code === code)
          const updated = { ...e, debitCode: code, debitName: acc ? (acc.shortName || acc.name) : '' }
          if (acc && isPL(acc.bsPl) && acc.normalBalance === '借方' && !e.debitTaxCode) {
            const tax = getDefaultTaxCodeByName(acc.name || acc.shortName, 'purchase')
            if (tax) { updated.debitTaxCode = tax.taxCode; updated.debitTaxType = tax.taxName; updated.debitTaxRate = '4' }
          }
          return updated
        }
        // _creditCodeFull: 貸方コード+科目名+消費税を一括更新
        if (field === '_creditCodeFull' as keyof JournalEntry) {
          const code = value as string
          const acc = currentAccountMaster.find((a) => a.code === code)
          const updated = { ...e, creditCode: code, creditName: acc ? (acc.shortName || acc.name) : '' }
          if (acc && isPL(acc.bsPl) && acc.normalBalance === '貸方' && !e.debitTaxCode) {
            const tax = getDefaultTaxCodeByName(acc.name || acc.shortName, 'sales')
            if (tax) { updated.debitTaxCode = tax.taxCode; updated.debitTaxType = tax.taxName; updated.debitTaxRate = '4' }
          }
          return updated
        }
        // _taxFull: 消費税CD+名称を一括更新
        if (field === '_taxFull' as keyof JournalEntry) {
          const [code, name] = (value as string).split('|')
          return { ...e, debitTaxCode: code || '', debitTaxType: name || '' }
        }
        // _debitSubFull: 借方補助コード+名称を一括更新（2回のsetStateで片方が消える問題の回避）
        if (field === '_debitSubFull' as keyof JournalEntry) {
          const [code, name] = (value as string).split('|')
          return { ...e, debitSubCode: code || '', debitSubName: name || '' }
        }
        // _creditSubFull: 貸方補助コード+名称を一括更新
        if (field === '_creditSubFull' as keyof JournalEntry) {
          const [code, name] = (value as string).split('|')
          return { ...e, creditSubCode: code || '', creditSubName: name || '' }
        }
        return { ...e, [field]: value }
      }))
    },
    [onEntriesChange],
  )

  const handleAddCompoundRow = useCallback(
    (parentId: string) => {
      const currentEntries = entriesRef.current
      const entry = currentEntries.find((e) => e.id === parentId)
      if (!entry) return
      const realParentId = entry.parentId || entry.id
      const idx = currentEntries.findIndex((e) => e.id === realParentId)
      let insertIdx = idx + 1
      while (insertIdx < currentEntries.length && currentEntries[insertIdx].parentId === realParentId) insertIdx++
      const parent = currentEntries.find((e) => e.id === realParentId)!
      const newEntry = createCompoundEntry(parent)
      const newEntries = [...currentEntries]
      newEntries.splice(insertIdx, 0, newEntry)
      onEntriesChange(newEntries)
    },
    [onEntriesChange],
  )

  // ハンドラの参照を安定させるため ref 経由で最新値にアクセス
  const subAccountMasterRef = useRef(subAccountMaster)
  useEffect(() => { subAccountMasterRef.current = subAccountMaster }, [subAccountMaster])

  const handleSubAccountRegister = useCallback(
    (parentCode: string, subCode: string, name: string) => {
      const parentAcc = accountMasterRef.current.find((a) => a.code === parentCode)
      const newItem: SubAccountItem = {
        parentCode,
        parentName: parentAcc?.shortName || parentAcc?.name || '',
        subCode,
        name,
        shortName: name,
      }
      const updated = [...subAccountMasterRef.current, newItem]
      saveSubAccountMaster(updated)
      onSubAccountUpdate(updated)
    },
    [onSubAccountUpdate],
  )

  // 行メニュー用の安定ハンドラ（id ベース）
  const handleLearnRequest = useCallback((id: string) => {
    const list = entriesRef.current
    const entry = list.find((e) => e.id === id)
    if (!entry) return
    if (!entry.originalDescription && !entry.description) return
    const groupId = entry.parentId || entry.id
    const groupEntries = list.filter((e) => e.id === groupId || e.parentId === groupId)
    setLearnDialogEntry(entry)
    setLearnRelatedEntries(groupEntries.length > 0 ? groupEntries : [entry])
  }, [])

  const handleAddBlankAfter = useCallback((id: string) => {
    const list = entriesRef.current
    const i = list.findIndex((e) => e.id === id)
    const ne = [...list]
    ne.splice(i + 1, 0, createBlankEntry())
    onEntriesChange(ne)
  }, [onEntriesChange])

  const handleDeleteEntry = useCallback((id: string) => {
    const list = entriesRef.current
    // 複合仕訳の子も連鎖削除
    const ids = new Set<string>([id])
    for (const e of list) if (e.parentId === id) ids.add(e.id)
    onEntriesChange(list.filter((e) => !ids.has(e.id)))
  }, [onEntriesChange])

  // 諸口コードを科目チェックリストから検索（997固定ではない）
  const shoguchiCode = useMemo(() => {
    const item = accountMaster.find((a) =>
      a.name.includes('諸口') || a.shortName.includes('諸口')
    )
    return item?.code || '997'
  }, [accountMaster])

  // 複合仕訳グループと諸口自動計算
  const compoundInfo = useMemo(() => {
    const info: Record<string, { isGroup: boolean; isFirst: boolean; isLast: boolean; autoAmount: number }> = {}

    // 複合仕訳グループを構築
    // entries配列を順番に走査し、entriesの順序でグループメンバーを記録
    const groupMembers: Record<string, JournalEntry[]> = {}
    for (const e of entries) {
      // この行は「親」か「子」か判定
      const hasChildren = entries.some((c) => c.parentId === e.id)
      const groupKey = e.parentId || (hasChildren ? e.id : null)
      if (groupKey) {
        if (!groupMembers[groupKey]) groupMembers[groupKey] = []
        groupMembers[groupKey].push(e)
      }
    }

    // デバッグ用
    if (typeof window !== 'undefined') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__compoundDebug = groupMembers
    }

    // 997の貸借一致で自動計算
    for (const [, members] of Object.entries(groupMembers)) {
      if (members.length === 0) continue
      const firstEntry = members[0]
      const lastEntry = members[members.length - 1]

      // 最終行以外の997借方合計・貸方合計
      let debit997Total = 0
      let credit997Total = 0
      for (const m of members) {
        if (m.id === lastEntry.id) continue // 最終行は除外
        const amt = m.debitAmount || m.creditAmount || 0
        if (m.debitCode === shoguchiCode) debit997Total += amt
        if (m.creditCode === shoguchiCode) credit997Total += amt
      }

      // 最終行の自動計算: 997の貸借が一致する金額
      console.log(`[997Calc] group size=${members.length}, debit997Total=${debit997Total}, credit997Total=${credit997Total}, lastEntry.debitCode=${lastEntry.debitCode}, lastEntry.creditCode=${lastEntry.creditCode}`)
      let autoAmount = 0
      if (lastEntry.debitCode === shoguchiCode) {
        autoAmount = credit997Total - debit997Total
      } else if (lastEntry.creditCode === shoguchiCode) {
        autoAmount = debit997Total - credit997Total
      }

      for (const m of members) {
        info[m.id] = {
          isGroup: true,
          isFirst: m.id === firstEntry.id,
          isLast: m.id === lastEntry.id,
          autoAmount: m.id === lastEntry.id ? autoAmount : 0,
        }
      }
    }
    return info
  }, [entries, shoguchiCode])

  const getPageIndex = (entry: JournalEntry, pgs: StatementPage[]): number => {
    if (!entry.transactionId) return -1
    for (const page of pgs) { if (page.transactions.some((t) => t.id === entry.transactionId)) return page.pageIndex }
    return -1
  }

  // 科目別集計
  const accountSummary = useMemo(() => {
    const debitMap = new Map<string, { code: string; name: string; count: number; total: number; ids: string[] }>()
    const creditMap = new Map<string, { code: string; name: string; count: number; total: number; ids: string[] }>()
    for (const e of entries) {
      if (e.debitCode) {
        const key = e.debitCode
        const cur = debitMap.get(key) || { code: e.debitCode, name: e.debitName, count: 0, total: 0, ids: [] }
        cur.count++
        cur.total += e.debitAmount || 0
        cur.ids.push(e.id)
        debitMap.set(key, cur)
      }
      if (e.creditCode) {
        const key = e.creditCode
        const cur = creditMap.get(key) || { code: e.creditCode, name: e.creditName, count: 0, total: 0, ids: [] }
        cur.count++
        cur.total += e.creditAmount || 0
        cur.ids.push(e.id)
        creditMap.set(key, cur)
      }
    }
    return {
      debit: Array.from(debitMap.values()).sort((a, b) => a.code.localeCompare(b.code)),
      credit: Array.from(creditMap.values()).sort((a, b) => a.code.localeCompare(b.code)),
    }
  }, [entries])

  const runningBalances = useMemo(() => {
    const balances: number[] = []
    const opening = pages.length > 0 ? pages[0].openingBalance : 0
    let running = opening
    for (const entry of entries) {
      const amount = entry.debitAmount || entry.creditAmount || 0
      if (entry.debitCode === bankAccountCode) running += amount
      else if (entry.creditCode === bankAccountCode) running -= amount
      balances.push(running)
    }
    return balances
  }, [entries, pages, bankAccountCode])

  // 取引ID→通帳残高のルックアップ
  const txBalanceMap = useMemo(() => {
    const m = new Map<string, number>()
    for (const p of pages) for (const t of p.transactions) m.set(t.id, t.balance)
    return m
  }, [pages])

  // 不一致が最初に発生した仕訳のインデックス（全体で1箇所）
  const firstMismatchIndex = useMemo(() => {
    const opening = pages.length > 0 ? pages[0].openingBalance : 0
    let running = opening
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]
      const amt = e.debitAmount || e.creditAmount || 0
      let affects = false
      if (e.debitCode === bankAccountCode) { running += amt; affects = true }
      else if (e.creditCode === bankAccountCode) { running -= amt; affects = true }
      if (!affects) continue
      if (!e.transactionId) continue
      const expected = txBalanceMap.get(e.transactionId)
      if (expected == null) continue
      if (Math.abs(running - expected) >= 1) return i
    }
    return -1
  }, [entries, pages, bankAccountCode, txBalanceMap])

  // 残高不一致チェック（全ページ）
  const balanceMismatch = useMemo(() => {
    const mismatches: { pageIndex: number; calculated: number; expected: number; diff: number }[] = []
    for (const page of pages) {
      if (page.transactions.length === 0) continue
      const pageEntries = entries.filter((e) =>
        page.transactions.some((t) => t.id === e.transactionId)
      )
      let deposit = 0, withdrawal = 0
      for (const e of pageEntries) {
        const amt = e.debitAmount || e.creditAmount || 0
        if (e.debitCode === bankAccountCode) deposit += amt
        else if (e.creditCode === bankAccountCode) withdrawal += amt
      }
      const calculated = page.openingBalance + deposit - withdrawal
      const diff = calculated - page.closingBalance
      if (Math.abs(diff) >= 1) {
        mismatches.push({ pageIndex: page.pageIndex, calculated, expected: page.closingBalance, diff })
      }
    }
    return mismatches
  }, [entries, pages, bankAccountCode])

  return (
    <div className="flex flex-col h-full bg-white">
      <div className="px-4 py-2 bg-white border-b border-gray-200 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2.5">
          <span className="text-sm font-semibold text-gray-800 whitespace-nowrap">仕訳データ</span>
          <span className="px-2.5 py-0.5 text-[11px] font-semibold rounded-full bg-blue-50 text-blue-700">{entries.length}件</span>
          {!hideBalance && balanceMismatch.length > 0 && (
            <span className="px-2.5 py-0.5 bg-red-100 text-red-700 text-[11px] font-bold rounded-full animate-pulse">
              残高不一致 {balanceMismatch.length}ページ
            </span>
          )}
          {!hideBalance && balanceMismatch.length === 0 && pages.length > 0 && entries.length > 0 && (
            <span className="px-2.5 py-0.5 bg-green-100 text-green-700 text-[11px] font-bold rounded-full">
              残高一致
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowOnlyIncomplete((v) => !v)}
            disabled={entries.length === 0}
            title="借方/貸方/消費税のいずれかが未入力の行のみ表示"
            className={`fbtn ${showOnlyIncomplete ? 'fbtn-amber' : 'fbtn-soft'}`}>
            {showOnlyIncomplete ? '未入力のみ表示中' : '未入力のみ表示'}
          </button>
          <button
            onClick={handleSelectAll}
            disabled={entries.length === 0}
            className="fbtn fbtn-soft">
            {selectedRange.size === entries.length && entries.length > 0 ? '全解除' : '全選択'}
          </button>
          <button
            onClick={handleDeleteSelected}
            disabled={selectedRange.size === 0 && !selectedEntryId}
            title="選択した仕訳を削除 (Shift+クリック=範囲, Ctrl+クリック=個別追加)"
            className="fbtn fbtn-redsoft">
            選択削除 {selectedRange.size > 0 ? `(${selectedRange.size})` : ''}
          </button>
          <button onClick={() => {
            // 科目チェックリストから仮払金を検索
            const karibarai = accountMaster.find((a) =>
              a.name.includes('仮払') || a.shortName.includes('仮払')
            )
            if (!karibarai) {
              alert('科目チェックリストに「仮払金」が見つかりません。\n科目チェックリストを先に登録してください。')
              return
            }
            // 未入力の借方・貸方コードに仮払金を一括設定（ユーザー入力済みは除外）
            const updated = entries.map((e) => {
              const u = { ...e }
              if (!u.debitCode && !u.patternId) {
                u.debitCode = karibarai.code
                u.debitName = karibarai.shortName || karibarai.name
              }
              if (!u.creditCode && !u.patternId) {
                u.creditCode = karibarai.code
                u.creditName = karibarai.shortName || karibarai.name
              }
              return u
            })
            onEntriesChange(updated)
          }}
            className="fbtn fbtn-amber">
            仮払金一括登録
          </button>
          <button onClick={() => {
            const idx = selectedEntryId ? entries.findIndex((e) => e.id === selectedEntryId) : 0
            const ne = [...entries]
            ne.splice(Math.max(idx, 0), 0, createBlankEntry())
            onEntriesChange(ne)
          }}
            className="fbtn fbtn-soft">＋ 選択行の上に1行追加</button>
        </div>
      </div>

      {/* 摘要検索フィルタ */}
      <div className="px-4 py-1.5 bg-gray-100 border-b border-gray-300 flex items-center gap-2 shrink-0">
        <span className="text-xs text-gray-600 shrink-0">摘要検索:</span>
        <input
          type="text"
          value={descSearchText}
          onChange={(e) => setDescSearchText(e.target.value)}
          placeholder="キーワードで絞り込み"
          className="flex-1 px-2 py-1 text-xs border border-gray-300 rounded bg-white max-w-[200px]"
        />
        {descSearchText && (
          <button
            onClick={() => {
              const keyword = descSearchText.trim()
              if (!keyword) return
              const ids = new Set(entries.filter((e) =>
                e.description.includes(keyword) || e.originalDescription?.includes(keyword)
              ).map((e) => e.id))
              setDescFilterIds(ids)
            }}
            className="px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700">
            絞込 ({entries.filter((e) => e.description.includes(descSearchText.trim()) || e.originalDescription?.includes(descSearchText.trim())).length}件)
          </button>
        )}
        {(descFilterIds || accountFilterIds) && (
          <button
            onClick={() => { setDescSearchText(''); setDescFilterIds(null); setAccountFilterIds(null); setAccountFilterType(null); setAccountFilterCode('') }}
            className="px-2 py-1 text-xs bg-gray-500 text-white rounded hover:bg-gray-600">
            全件表示
          </button>
        )}
        {(descFilterIds || accountFilterIds) && (
          <span className="text-xs text-blue-600 font-bold">
            {entries.filter((e) => {
              if (accountFilterIds && !accountFilterIds.has(e.id)) return false
              if (descFilterIds && !descFilterIds.has(e.id)) return false
              return true
            }).length}件表示中
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {/* 一括編集UI（チェック選択時のみ表示。行を増やさず摘要検索行の右側に表示） */}
          {showBulkEdit && selectedRange.size > 0 && (
            <div className="flex items-center gap-1.5 px-2 py-0.5 bg-blue-100 border border-blue-300 rounded">
              <span className="text-xs font-bold text-blue-800 shrink-0 whitespace-nowrap">{selectedRange.size}件選択中</span>
              <select value={bulkField} onChange={(e) => setBulkField(e.target.value)}
                className="px-1.5 py-0.5 text-xs border border-blue-300 rounded bg-white">
                <option value="">変更項目</option>
                <option value="debitCode">借方CD</option>
                <option value="creditCode">貸方CD</option>
                <option value="debitTaxCode">消費税CD</option>
                <option value="debitTaxType">税区分</option>
                <option value="description">摘要</option>
              </select>
              <input type="text" value={bulkValue} onChange={(e) => setBulkValue(e.target.value)}
                placeholder="値" className="px-1.5 py-0.5 text-xs border border-blue-300 rounded w-24" />
              <button onClick={applyBulkEdit} disabled={!bulkField}
                className="px-2 py-0.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-40">適用</button>
              <button onClick={handleDeleteSelected}
                className="px-2 py-0.5 text-xs bg-rose-600 text-white rounded hover:bg-rose-700">削除</button>
              <button onClick={() => { setShowBulkEdit(false); setSelectedRange(new Set()) }}
                className="px-1.5 py-0.5 text-xs text-blue-600 hover:underline whitespace-nowrap">解除</button>
            </div>
          )}
          <button
            onClick={() => setShowAccountSummary((v) => !v)}
            className={`px-2 py-1 text-xs rounded shrink-0 ${showAccountSummary ? 'bg-indigo-600 text-white' : 'bg-white text-gray-700 border border-gray-300 hover:bg-gray-50'}`}>
            科目別一覧
          </button>
        </div>
      </div>

      {/* 科目別一覧 */}
      {showAccountSummary && (
        <div className="px-4 py-2 bg-indigo-50 border-b border-indigo-200 shrink-0 max-h-[300px] overflow-auto">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="text-xs font-bold text-indigo-800 mb-1">借方科目別</div>
              <table className="w-full text-xs">
                <thead><tr className="bg-indigo-100"><th className="px-2 py-1 text-left">CD</th><th className="px-2 py-1 text-left">科目名</th><th className="px-2 py-1 text-right">件数</th><th className="px-2 py-1 text-right">合計額</th></tr></thead>
                <tbody>
                  {accountSummary.debit.map((a) => (
                    <tr key={a.code} className="hover:bg-indigo-100 cursor-pointer border-b border-indigo-100"
                      onClick={() => { setAccountFilterIds(new Set(a.ids)); setAccountFilterType('debit'); setAccountFilterCode(a.code) }}>
                      <td className="px-2 py-0.5 font-mono">{a.code}</td>
                      <td className="px-2 py-0.5">{a.name}</td>
                      <td className="px-2 py-0.5 text-right">{a.count}</td>
                      <td className="px-2 py-0.5 text-right">{a.total.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div>
              <div className="text-xs font-bold text-indigo-800 mb-1">貸方科目別</div>
              <table className="w-full text-xs">
                <thead><tr className="bg-indigo-100"><th className="px-2 py-1 text-left">CD</th><th className="px-2 py-1 text-left">科目名</th><th className="px-2 py-1 text-right">件数</th><th className="px-2 py-1 text-right">合計額</th></tr></thead>
                <tbody>
                  {accountSummary.credit.map((a) => (
                    <tr key={a.code} className="hover:bg-indigo-100 cursor-pointer border-b border-indigo-100"
                      onClick={() => { setAccountFilterIds(new Set(a.ids)); setAccountFilterType('credit'); setAccountFilterCode(a.code) }}>
                      <td className="px-2 py-0.5 font-mono">{a.code}</td>
                      <td className="px-2 py-0.5">{a.name}</td>
                      <td className="px-2 py-0.5 text-right">{a.count}</td>
                      <td className="px-2 py-0.5 text-right">{a.total.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* 科目別フィルタ中の一括変更バー */}
      {accountFilterType && (accountFilterIds || descFilterIds) && (() => {
        const visibleIds = entries.filter((e) => {
          if (accountFilterIds && !accountFilterIds.has(e.id)) return false
          if (descFilterIds && !descFilterIds.has(e.id)) return false
          return true
        }).map((e) => e.id)
        return (
          <div className="px-4 py-2 bg-amber-50 border-b border-amber-300 flex items-center gap-2 shrink-0">
            <span className="text-xs font-bold text-amber-800">
              {accountFilterType === 'debit' ? '借方' : '貸方'}科目「{accountFilterCode}」{descFilterIds ? '(絞込中)' : ''} {visibleIds.length}件を一括変更:
            </span>
            <input
              type="text"
              placeholder="新しい科目CD"
              className="px-2 py-1 text-xs border border-amber-400 rounded w-20 font-mono"
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                const newCode = (e.target as HTMLInputElement).value.trim()
                if (!newCode) return
                const acc = accountMaster.find((a) => a.code === newCode)
                const newName = acc ? (acc.shortName || acc.name) : ''
                const idSet = new Set(visibleIds)
                // 消費税コード自動設定
                let taxCode = ''
                let taxName = ''
                let taxRate = ''
                if (acc && isPL(acc.bsPl)) {
                  const taxType = acc.normalBalance === '借方' ? 'purchase' : 'sales'
                  const tax = getDefaultTaxCodeByName(acc.name || acc.shortName, taxType)
                  if (tax) { taxCode = tax.taxCode; taxName = tax.taxName; taxRate = '4' }
                }
                onEntriesChange(entries.map((entry) => {
                  if (!idSet.has(entry.id)) return entry
                  const updated = { ...entry }
                  if (accountFilterType === 'debit') {
                    updated.debitCode = newCode
                    updated.debitName = newName
                  } else {
                    updated.creditCode = newCode
                    updated.creditName = newName
                  }
                  if (taxCode && !entry.debitTaxCode) {
                    updated.debitTaxCode = taxCode
                    updated.debitTaxType = taxName
                    updated.debitTaxRate = taxRate
                  }
                  return updated
                }))
                ;(e.target as HTMLInputElement).value = ''
              }}
            />
            <span className="text-xs text-amber-600">科目CDを入力してEnter（消費税も自動設定）</span>
          </div>
        )
      })()}

      {/* 残高不一致の詳細 */}
      {!hideBalance && balanceMismatch.length > 0 && (
        <div className="px-4 py-2 bg-red-50 border-b border-red-200 shrink-0">
          <div className="text-xs font-bold text-red-700 mb-1">残高不一致の詳細</div>
          {balanceMismatch.map((m) => (
            <div key={m.pageIndex}
              className="text-xs text-red-600 cursor-pointer hover:text-red-800 hover:underline"
              onClick={() => {
                onPageChange?.(m.pageIndex)
                // 該当ページの最初の仕訳行までスクロール
                const pageFirstEntry = entries.find((e) => {
                  const page = pages.find((p) => p.transactions.some((t) => t.id === e.transactionId))
                  return page?.pageIndex === m.pageIndex
                })
                if (pageFirstEntry) {
                  setTimeout(() => {
                    document.querySelector(`[data-entry-id="${pageFirstEntry.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                  }, 50)
                }
              }}>
              P{m.pageIndex + 1}: 計算残高 &yen;{m.calculated.toLocaleString()} / 通帳残高 &yen;{m.expected.toLocaleString()}（差額 &yen;{Math.abs(m.diff).toLocaleString()}）
            </div>
          ))}
        </div>
      )}

      <div className="flex-1 overflow-auto">
        <table className="w-full text-sm border-collapse min-w-[950px]">
          <thead className="sticky top-0 bg-[#f3f6fb] text-gray-500 z-10 border-b border-gray-200">
            <tr>
              <th className="px-1 py-2 text-center w-8 font-medium" style={{ borderRight: '1px solid #e5e7eb' }}>
                <input
                  type="checkbox"
                  checked={entries.length > 0 && selectedRange.size === entries.length}
                  ref={(el) => {
                    if (el) el.indeterminate = selectedRange.size > 0 && selectedRange.size < entries.length
                  }}
                  onChange={handleSelectAll}
                  className="w-4 h-4 cursor-pointer accent-blue-600"
                  title="全選択 / 全解除"
                />
              </th>
              <th className="px-2 py-2 text-center w-12 font-medium" style={{ borderRight: '1px solid #e5e7eb' }}>学習</th>
              <th className="px-2 py-2 text-center w-24 font-medium" style={{ borderRight: '1px solid #e5e7eb' }}>日付</th>
              <th className="px-2 py-2 text-center w-44 font-medium" style={{ borderRight: '1px solid #e5e7eb' }}>
                <div className="flex items-center justify-center gap-1">
                  <span>借方科目</span>
                  <label className="flex items-center gap-0.5 cursor-pointer text-xs font-normal opacity-80 hover:opacity-100">
                    <input type="checkbox" checked={filterEmptyDebit}
                      onChange={toggleFilterEmptyDebit}
                      className="w-3 h-3 accent-amber-400 cursor-pointer" />
                    <span className={filterEmptyDebit ? 'text-amber-600 font-semibold' : ''}>未処理</span>
                  </label>
                </div>
              </th>
              <th className="px-2 py-2 text-center w-44 font-medium" style={{ borderRight: '1px solid #e5e7eb' }}>
                <div className="flex items-center justify-center gap-1">
                  <span>貸方科目</span>
                  <label className="flex items-center gap-0.5 cursor-pointer text-xs font-normal opacity-80 hover:opacity-100">
                    <input type="checkbox" checked={filterEmptyCredit}
                      onChange={toggleFilterEmptyCredit}
                      className="w-3 h-3 accent-amber-400 cursor-pointer" />
                    <span className={filterEmptyCredit ? 'text-amber-600 font-semibold' : ''}>未処理</span>
                  </label>
                </div>
              </th>
              <th className="px-2 py-2 text-center w-24 font-medium" style={{ borderRight: '1px solid #e5e7eb' }}>金額</th>
              {!hideBalance && (
                <th className="px-2 py-2 text-center w-28 font-medium" style={{ borderRight: '1px solid #e5e7eb' }}>残高</th>
              )}
              <th className="px-1 py-2 text-center w-24 font-medium" style={{ borderRight: '1px solid #e5e7eb' }}>消費税</th>
              <th className="px-1 py-2 text-center w-16 font-medium" style={{ borderRight: '1px solid #e5e7eb' }} title="インボイス">iv</th>
              {clientTaxType === 'simplified' && (
                <th className="px-2 py-2 text-center w-12 font-medium" style={{ borderRight: '1px solid #e5e7eb' }}>業種</th>
              )}
              <th className="px-2 py-2 text-center font-medium" style={{ borderRight: '1px solid #e5e7eb', minWidth: '180px' }}>摘要</th>
              <th className="px-1 py-2 w-20 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry, idx) => {
              // 借方科目の未処理フィルタ: クリック時に空欄だった行のみ表示（入力後も残る）
              if (filterEmptyDebit && filteredDebitIds && !filteredDebitIds.has(entry.id)) return null
              // 貸方科目の未処理フィルタ: 同上
              if (filterEmptyCredit && filteredCreditIds && !filteredCreditIds.has(entry.id)) return null
              // 摘要検索フィルタ（スナップショット: 摘要変更後も消えない）
              if (descFilterIds && !descFilterIds.has(entry.id)) return null
              if (accountFilterIds && !accountFilterIds.has(entry.id)) return null
              // 未入力のみ表示フィルタ:
              // 借方CD空 or 貸方CD空 or 消費税CD空(ただしBS同士で—表示の場合は未入力扱いしない)
              if (showOnlyIncomplete) {
                const debitAcc = accountMaster.find((a) => a.code === entry.debitCode)
                const creditAcc = accountMaster.find((a) => a.code === entry.creditCode)
                const isBsBoth = !!(debitAcc && creditAcc && isBS(debitAcc.bsPl) && isBS(creditAcc.bsPl))
                const taxOk = !!entry.debitTaxCode || isBsBoth
                if (entry.debitCode && entry.creditCode && taxOk) {
                  return null
                }
              }
              const prevEntry = idx > 0 ? entries[idx - 1] : null
              const cp = getPageIndex(entry, pages)
              const pp = prevEntry ? getPageIndex(prevEntry, pages) : cp
              const isPageBoundary = idx > 0 && cp !== pp && cp >= 0 && pp >= 0
              const ci = compoundInfo[entry.id]

              return (
                <JournalEntryRow
                  key={entry.id}
                  entry={entry}
                  isSelected={entry.id === selectedEntryId || selectedRange.has(entry.id)}
                  accountMaster={accountMaster}
                  subAccountMaster={subAccountMaster}
                  isPageBoundary={isPageBoundary}
                  pageLabel={isPageBoundary ? `P${cp + 1}` : undefined}
                  runningBalance={runningBalances[idx]}
                  rowNumber={idx}
                  isCompoundGroup={ci?.isGroup}
                  isCompoundFirst={ci?.isFirst}
                  isCompoundLast={ci?.isLast}
                  compoundAutoAmount={ci?.isLast ? ci.autoAmount : undefined}
                  isBalanceMismatch={!hideBalance && firstMismatchIndex >= 0 && idx >= firstMismatchIndex}
                  hideBalance={hideBalance}
                  isChecked={selectedRange.has(entry.id)}
                  onCheckToggle={handleCheckToggle}
                  onSelect={handleRowSelect}
                  onChange={handleEntryChange}
                  onLearn={handleLearnRequest}
                  onAddBlank={handleAddBlankAfter}
                  onAddCompound={handleAddCompoundRow}
                  onDelete={handleDeleteEntry}
                  onSubAccountRegister={handleSubAccountRegister}
                  clientTaxType={clientTaxType}
                  onPatternClick={(pid) => setPatternDetailId(pid)}
                />
              )
            })}
          </tbody>
        </table>
      </div>

      {/* パターン学習ダイアログ */}
      <LearnPatternDialog
        open={learnDialogEntry !== null}
        entry={learnDialogEntry}
        relatedEntries={learnRelatedEntries}
        onConfirm={handleLearnConfirm}
        onCancel={() => { setLearnDialogEntry(null); setLearnRelatedEntries([]) }}
      />

      {/* 反映確認ダイアログ */}
      <ApplyPatternDialog
        open={showApplyDialog}
        targetEntries={applyTargetEntries}
        patternLines={applyPatternLines}
        onConfirm={handleApplyConfirm}
        onCancel={() => {
          setShowApplyDialog(false)
          setApplyTargetEntries([])
          setApplyPatternLines([])
          setApplyPatternMeta(null)
          setApplyAmountRange(null)
        }}
      />

      {/* パターン詳細ダイアログ */}
      <PatternDetailDialog
        open={patternDetailId !== null}
        patternId={patternDetailId}
        onClose={() => setPatternDetailId(null)}
      />
    </div>
  )
}
