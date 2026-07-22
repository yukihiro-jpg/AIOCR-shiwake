'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import UploadDialog from '@/components/bank-statement/UploadDialog'
import AccountMasterUploader from '@/components/bank-statement/AccountMasterUploader'
import PatternListDialog from '@/components/bank-statement/PatternListDialog'
import FixedJournalDialog from '@/components/bank-statement/FixedJournalDialog'
import InvoiceRegistryDialog from '@/components/bank-statement/InvoiceRegistryDialog'
import PayrollUploadDialog from '@/components/bank-statement/PayrollUploadDialog'
import StatementViewer from '@/components/bank-statement/StatementViewer'
import JournalEntryTable from '@/components/bank-statement/JournalEntryTable'
import ColumnMappingDialog from '@/components/bank-statement/ColumnMappingDialog'
import InvoiceColumnMappingDialog, { type InvoiceColumnMapping } from '@/components/bank-statement/InvoiceColumnMappingDialog'
import ReceiptColumnMappingDialog, { type ReceiptColumnMapping } from '@/components/bank-statement/ReceiptColumnMappingDialog'
import CsvExportButton from '@/components/bank-statement/CsvExportButton'
import { appendTempEntries, getTempEntryCount, clearTempEntries, getTempEntries } from '@/lib/bank-statement/temp-store'
import { addQuestionItems } from '@/lib/bank-statement/question-store'
import { generateQuestionList, downloadQuestionExcel } from '@/lib/bank-statement/question-list'
import QuestionListDialog from '@/components/bank-statement/QuestionListDialog'
import TempDataDialog from '@/components/bank-statement/TempDataDialog'
import GlobalNav from '@/core/ui/GlobalNav'
import BackupButton from '@/components/bank-statement/BackupButton'
import KakuninQuickAdd from '@/components/bank-statement/KakuninQuickAdd'
import FirebaseRoomDialog from '@/components/bank-statement/FirebaseRoomDialog'
import HeaderMenuDropdown from '@/components/bank-statement/HeaderMenuDropdown'
import { hasRoom, testFirebaseConnection, startFirebaseSync, stopFirebaseSync, startClientsSync, stopClientsSync } from '@/lib/bank-statement/firebase-sync'
import ProcessingStatusTable from '@/components/bank-statement/ProcessingStatusTable'
import { updateProcessingStatus } from '@/lib/bank-statement/processing-status-store'
import { applyCompoundAutoAmounts, downloadCsv } from '@/lib/bank-statement/csv-generator'
import { learnAllFromEntries } from '@/lib/bank-statement/pattern-store'
import ResizableSplitPanel from '@/components/bank-statement/ResizableSplitPanel'
import type {
  StatementPage,
  JournalEntry,
  AccountItem,
  SubAccountItem,
  UploadConfig,
  ParseResult,
  RawTableRow,
  ColumnMapping,
} from '@/lib/bank-statement/types'
import { parseFile, applyColumnMapping } from '@/lib/bank-statement/transaction-extractor'
import { saveExcelMapping, loadExcelMapping } from '@/lib/bank-statement/excel-mapping-store'
import { creditCardOcr, receiptOcrParallel, invoiceOcr, expandDescriptions } from '@/lib/bank-statement/gemini-client'
import { mapTransactionsToJournalEntries } from '@/lib/bank-statement/journal-mapper'
import { getPatterns } from '@/lib/bank-statement/pattern-store'
import { loadAccountMaster, loadSubAccountMaster, loadAccountTaxMaster, getDefaultTaxCode } from '@/lib/bank-statement/account-master'
import { getDefaultTaxCodeByName, isPL } from '@/lib/bank-statement/tax-codes'
import type { AccountTaxItem } from '@/lib/bank-statement/types'
import ClientSelector from '@/components/bank-statement/ClientSelector'
import type { Client } from '@/lib/bank-statement/client-store'
import { getClients, getSelectedClientId, setSelectedClientId, recordCsvExport } from '@/lib/bank-statement/client-store'

// レシート・請求書等「1書類=1画像」ページの一意ID生成（行クリックでの画像表示／行削除での画像削除に使用）
let pageIdCounter = 0
function genPageId(i = 0): string {
  return `pg-${Date.now()}-${i}-${++pageIdCounter}`
}

// 画像ファイル（JPEG/PNG等）を data URL に変換
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error('画像の読み込みに失敗しました'))
    r.readAsDataURL(file)
  })
}

export default function BankStatementContent() {
  // 顧問先選択
  const [selectedClient, setSelectedClient] = useState<Client | null>(null)
  const [showClientSelector, setShowClientSelector] = useState(true)
  // アプリ終了処理
  const [exitingApp, setExitingApp] = useState(false)

  const [pages, setPages] = useState<StatementPage[]>([])
  const [journalEntries, setJournalEntries] = useState<JournalEntry[]>([])
  const [accountMaster, setAccountMaster] = useState<AccountItem[]>([])
  const [subAccountMaster, setSubAccountMaster] = useState<SubAccountItem[]>([])
  const [accountTaxMaster, setAccountTaxMaster] = useState<AccountTaxItem[]>([])
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null)
  const [currentPageIndex, setCurrentPageIndex] = useState(0)
  const [uploadConfig, setUploadConfig] = useState<UploadConfig | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [loadingProgress, setLoadingProgress] = useState(0)
  const [parseElapsed, setParseElapsed] = useState<string | null>(null)
  const pdfFileRef = useRef<File | null>(null)
  const uploadConfigRef = useRef<UploadConfig | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [lastPeriodFrom, setLastPeriodFrom] = useState('')
  const [lastPeriodTo, setLastPeriodTo] = useState('')
  const [showPatternList, setShowPatternList] = useState(false)
  const [showFixedJournal, setShowFixedJournal] = useState(false)
  const [showInvoiceRegistry, setShowInvoiceRegistry] = useState(false)
  const [showPayroll, setShowPayroll] = useState(false)
  const [geminiModel, setGeminiModel] = useState(() => {
    if (typeof window === 'undefined') return 'gemini-2.5-flash'
    const stored = localStorage.getItem('bs-gemini-model')
    // 旧プレビューモデル名を正式リリース名に移行
    if (stored === 'gemini-3-flash-preview') {
      localStorage.setItem('bs-gemini-model', 'gemini-3.5-flash')
      return 'gemini-3.5-flash'
    }
    return stored || 'gemini-2.5-flash'
  })
  const [geminiApiKey, setGeminiApiKey] = useState(() => {
    if (typeof window === 'undefined') return ''
    return localStorage.getItem('bs-gemini-api-key') || ''
  })
  const [showGeminiKey, setShowGeminiKey] = useState(false)
  const [showQuestionList, setShowQuestionList] = useState(false)
  const [showTempData, setShowTempData] = useState(false)
  const [tempCount, setTempCount] = useState(() => getTempEntryCount())
  const [selectedEntryIds, setSelectedEntryIds] = useState<Set<string>>(new Set())
  const [processingStatusVersion, setProcessingStatusVersion] = useState(0)
  // Firebase 合言葉（ルーム）
  const [showRoomDialog, setShowRoomDialog] = useState(false)
  const [roomReady, setRoomReady] = useState(false)
  const [clientsRefresh, setClientsRefresh] = useState(0)

  // 起動時: 合言葉が未設定なら入力ダイアログ、設定済みなら接続して同期準備
  useEffect(() => {
    if (hasRoom()) {
      testFirebaseConnection().then((ok) => setRoomReady(ok))
    } else {
      setShowRoomDialog(true)
    }
  }, [])

  // 顧問先一覧のリアルタイム同期（顧問先選択画面でも動くよう独立）
  useEffect(() => {
    if (!roomReady) return
    startClientsSync(() => setClientsRefresh((v) => v + 1))
    return () => { stopClientsSync() }
  }, [roomReady])

  // 顧問先選択ハンドラ
  const handleClientSelect = useCallback(async (client: Client) => {
    setSelectedClient(client)
    setShowClientSelector(false)
    setAccountMaster(loadAccountMaster())
    setSubAccountMaster(loadSubAccountMaster())
    setAccountTaxMaster(loadAccountTaxMaster())
    setPages([])
    setJournalEntries([])
  }, [])

  // 書類スキャン受信からの転送（bs-scan-import）を取り込む。
  // 顧問先はID直結（転送側で解決済み）なので取り違えが起きない。
  const scanImportDone = useRef(false)
  useEffect(() => {
    if (scanImportDone.current) return
    scanImportDone.current = true
    let payload: {
      clientId: string
      clientName: string
      docType: string
      submittedAt: string
      credit: { code: string; name: string; subCode?: string; subName?: string }
      rows: { date: string; storeName: string; mainContent: string; invoiceNumber: string; taxRate: string; totalAmount: number; pageIndex?: number | null }[]
      images: string[]
    } | null = null
    try {
      const raw = localStorage.getItem('bs-scan-import')
      if (!raw) return
      localStorage.removeItem('bs-scan-import') // 二重取込防止（先に消す）
      payload = JSON.parse(raw)
    } catch {
      return
    }
    if (!payload || !payload.rows?.length) return
    const client = getClients().find((c) => c.id === payload!.clientId)
    if (!client) {
      alert(`書類スキャン受信からの転送データがありますが、顧問先「${payload.clientName}」が見つかりませんでした。`)
      return
    }
    ;(async () => {
      setSelectedClientId(client.id)
      await handleClientSelect(client)
      // 画像ページ（元レシート表示用）
      const idPages = (payload!.images || []).map((url, i) => ({
        pageIndex: i,
        transactions: [],
        openingBalance: 0,
        closingBalance: 0,
        isBalanceValid: true,
        balanceDifference: 0,
        imageDataUrl: url,
        id: genPageId(i),
      }))
      setPages(idPages)
      setCurrentPageIndex(0)
      // 解析行 → 仕訳（1行=1レシート扱い。貸方は転送時に選択した科目）
      const { receiptToEntries } = await import('@/lib/bank-statement/receipt-mapper')
      const receipts = payload!.rows.map((r, i) => ({
        receiptIndex: i,
        storeName: r.storeName,
        receiptDate: r.date,
        mainContent: r.mainContent,
        invoiceNumber: r.invoiceNumber || undefined,
        taxLines: [{ taxRate: r.taxRate || '10%', netAmount: 0, taxAmount: 0, totalAmount: r.totalAmount }],
        pageIndex: typeof r.pageIndex === 'number' ? r.pageIndex : 0,
      }))
      const entries = receiptToEntries(
        receipts,
        payload!.credit.code,
        payload!.credit.name,
        payload!.credit.subCode,
        payload!.credit.subName,
        undefined,
        (rcp) => idPages[rcp.pageIndex]?.id,
      )
      const cfg: UploadConfig = {
        documentType: 'receipt',
        accountCode: payload!.credit.code,
        accountName: payload!.credit.name,
        creditCode: payload!.credit.code,
        creditName: payload!.credit.name,
        creditSubCode: payload!.credit.subCode,
        creditSubName: payload!.credit.subName,
        file: new File([], 'scan-import'),
      }
      setUploadConfig(cfg)
      uploadConfigRef.current = cfg
      setJournalEntries(entries)
      setInfo(`書類スキャン受信（${payload!.docType}・${new Date(payload!.submittedAt).toLocaleDateString('ja-JP')}受信）から ${entries.length} 件の仕訳を取り込みました。借方科目を設定してください。`)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleClientSelect])

  const handleExitApp = useCallback(async () => {
    if (!window.confirm('アプリを終了してブラウザのタブを閉じます。よろしいですか？\n（データはFirebaseとこのPCに保存済みです）')) return
    setExitingApp(true)
    // デバウンス待機中のFirebase push（一時保存クリア等）を送り切ってから閉じる。
    // これを待たずに閉じるとRTDBに旧データが残り、次回起動時に復活してしまう。
    try {
      const { flushPendingPushes } = await import('@/lib/bank-statement/firebase-sync')
      await flushPendingPushes()
    } catch { /* firebase 未設定なら無視 */ }
    window.close()
    // window.close() が効かない環境用の代替メッセージ
    setTimeout(() => {
      setExitingApp(false)
      alert('このブラウザタブを閉じてください。')
    }, 500)
  }, [])

  // 表示中のページだけを削除（そのページから作成された仕訳も一緒に削除。他ページは残す）
  const handleDeleteCurrentPage = useCallback(() => {
    const page = pages[currentPageIndex]
    if (!page) return
    if (!window.confirm(`表示中のページ（${currentPageIndex + 1}/${pages.length}）と、このページから作成された仕訳を削除しますか？\n（他のページと仕訳はそのまま残ります）`)) return
    const txIds = new Set(page.transactions.map((t) => t.id))
    // このページ由来の仕訳（レシート等は sourcePageId、通帳等は transactionId で紐付く）
    const removedIds = new Set<string>()
    for (const e of journalEntries) {
      if ((page.id && e.sourcePageId === page.id) || (e.transactionId && txIds.has(e.transactionId))) removedIds.add(e.id)
    }
    // 複合仕訳の子（親が消える場合は子も消す）
    for (const e of journalEntries) {
      if (e.parentId && removedIds.has(e.parentId)) removedIds.add(e.id)
    }
    const remainingPages = pages.filter((_, i) => i !== currentPageIndex)
    if (remainingPages.length === 0) {
      setPages([]); setJournalEntries([]); setUploadConfig(null); setError(null)
      setInfo('最後のページを削除したため、アップロードファイルをすべて削除しました')
      return
    }
    setPages(remainingPages)
    setJournalEntries((prev) => prev.filter((e) => !removedIds.has(e.id)))
    setCurrentPageIndex((i) => Math.min(i, remainingPages.length - 1))
    setInfo(`ページを削除しました（仕訳${removedIds.size}件も削除）`)
  }, [pages, currentPageIndex, journalEntries])

  const handleBackToClientList = useCallback(() => {
    setSelectedClientId(null)
    setSelectedClient(null)
    setShowClientSelector(true)
    setPages([])
    setJournalEntries([])
  }, [])

  // 列マッピング用state（hooksは条件分岐の前に定義する必要がある）
  const [showColumnMapping, setShowColumnMapping] = useState(false)
  const [rawPages, setRawPages] = useState<RawTableRow[][] | null>(null)
  const [pendingSourceType, setPendingSourceType] = useState<ParseResult['sourceType'] | null>(null)
  // 請求書（Excel/CSV）列マッピング用
  const [showInvoiceColumnMapping, setShowInvoiceColumnMapping] = useState(false)
  const [invoiceRawRows, setInvoiceRawRows] = useState<RawTableRow[] | null>(null)
  // クレジットカード（Excel/CSV）列マッピング用（自動検出失敗時のフォールバック）
  const [showCcColumnMapping, setShowCcColumnMapping] = useState(false)
  const [ccRawRows, setCcRawRows] = useState<RawTableRow[] | null>(null)
  // レシート・領収書（Excel/CSV）列マッピング用
  const [showReceiptColumnMapping, setShowReceiptColumnMapping] = useState(false)
  const [receiptRawRows, setReceiptRawRows] = useState<RawTableRow[] | null>(null)
  // 日付一括変更（クレジットカード等）
  const [showBulkDateDialog, setShowBulkDateDialog] = useState(false)
  const [bulkDate, setBulkDate] = useState('')
  const [bulkDateAddToDesc, setBulkDateAddToDesc] = useState(false)
  const [pendingImageUrls, setPendingImageUrls] = useState<string[] | null>(null)

  // 以下は顧問先選択後の処理

  const applyParseResultFn = useCallback(
    (result: ParseResult, config: UploadConfig) => {
      setPages((prev) => [...prev, ...result.pages])

      // 画像PDF（OCR）の通帳: 仕訳クリック時の参照ハイライト用に、各取引の
      // 画像上の位置をバックグラウンドで特定して付与する（失敗しても仕訳に影響なし）
      if (result.sourceType === 'pdf-ocr' && result.pages.some((p) => p.imageDataUrl && p.transactions.length > 0)) {
        import('@/lib/bank-statement/region-locator')
          .then(({ annotateRegionsForPages }) => annotateRegionsForPages(result.pages, geminiModel))
          .then((regionMap) => {
            if (!regionMap || regionMap.size === 0) return
            setPages((prev) => prev.map((p) => {
              if (!p.transactions.some((t) => regionMap.has(t.id))) return p
              return {
                ...p,
                transactions: p.transactions.map((t) => {
                  const rg = regionMap.get(t.id)
                  return rg ? { ...t, refRegion: rg } : t
                }),
              }
            }))
          })
          .catch((e) => console.log('参照ハイライトの領域特定をスキップ:', e))
      }

      // 期間を保存（次回の「前回の期間をセット」用）
      if (config.periodFrom) setLastPeriodFrom(config.periodFrom)
      if (config.periodTo) setLastPeriodTo(config.periodTo)

      const patterns = getPatterns()
      const entries = mapTransactionsToJournalEntries(
        result.pages,
        config.accountCode,
        config.accountName,
        patterns,
        accountMaster,
        config.accountSubCode,
        config.accountSubName,
      )
      // 科目別消費税CDを自動設定（パターン学習で設定済みでないもの）
      const taxMaster = loadAccountTaxMaster()
      const entriesWithTax = entries.map((e) => {
        const updated = { ...e }
        // 科目名が空の場合、科目チェックリストから補完
        if (updated.debitCode && !updated.debitName) {
          const acc = accountMaster.find((a) => a.code === updated.debitCode)
          if (acc) updated.debitName = acc.shortName || acc.name
        }
        if (updated.creditCode && !updated.creditName) {
          const acc = accountMaster.find((a) => a.code === updated.creditCode)
          if (acc) updated.creditName = acc.shortName || acc.name
        }
        // 事業者取引区分: パターン学習で未設定なら0（インボイス登録事業者）をデフォルト
        if (!updated.debitBusinessType) {
          updated.debitBusinessType = '0'
        }
        // 消費税CD
        const needsTaxCode = !updated.debitTaxCode || updated.debitTaxCode === '0'
        const needsTaxRate = !updated.debitTaxRate
        if (needsTaxCode || needsTaxRate) {
          const debitAcc = accountMaster.find((a) => a.code === updated.debitCode)
          const creditAcc = accountMaster.find((a) => a.code === updated.creditCode)
          // 科目の正残から売上/仕入区分を判定（借方・貸方どちらに来ても科目の性質で決める）。
          // 貸方正残のPL科目＝売上系、借方正残のPL科目＝経費/仕入系。BS科目（現金等）は対象外。
          const preferOf = (acc?: { bsPl?: string; normalBalance?: string }): 'sales' | 'purchase' | null =>
            acc && isPL(acc.bsPl) ? (acc.normalBalance === '貸方' ? 'sales' : acc.normalBalance === '借方' ? 'purchase' : null) : null
          // 1. 科目別消費税マスタを参照（空欄のときのみ補完。パターン等で既に設定済みの値は尊重）
          //    売上科目を借方（売上返金）に入れても課税売上、経費科目を貸方に入れても課税仕入/対象外のまま。
          const debitTax = getDefaultTaxCode(taxMaster, updated.debitCode, preferOf(debitAcc))
          const creditTax = getDefaultTaxCode(taxMaster, updated.creditCode, preferOf(creditAcc))
          const tax = debitTax || creditTax
          if (tax) {
            if (needsTaxCode) {
              updated.debitTaxCode = tax.taxCode
              updated.debitTaxType = tax.taxName
            }
            if (needsTaxRate && tax.taxRate) {
              updated.debitTaxRate = tax.taxRate
            }
          } else if (needsTaxCode) {
            // 2. 科目名ベースのデフォルト判定（パターン学習未済・マスタ未登録の場合）
            //    エントリ内のPL科目（売上/経費）を借方・貸方問わず探し、その科目の性質で判定する。
            const debitPrefer = preferOf(debitAcc)
            const creditPrefer = preferOf(creditAcc)
            let category: 'sales' | 'purchase' | null = null
            let targetName = ''
            if (debitPrefer) {
              category = debitPrefer
              targetName = debitAcc?.name || debitAcc?.shortName || ''
            } else if (creditPrefer) {
              category = creditPrefer
              targetName = creditAcc?.name || creditAcc?.shortName || ''
            }
            const nameTax = getDefaultTaxCodeByName(targetName, category)
            if (nameTax) {
              updated.debitTaxCode = nameTax.taxCode
              updated.debitTaxType = nameTax.taxName
            }
          }
        }
        // 消費税率: 標準税率10%→4、軽減税率8%→5
        if (!updated.debitTaxRate && updated.debitTaxCode && updated.debitTaxCode !== '0') {
          updated.debitTaxRate = '4' // デフォルトは標準税率10%（=4）
        }
        return updated
      })
      // 処理対象期間でフィルタ
      const from = config.periodFrom?.replace(/-/g, '') || ''
      const to = config.periodTo?.replace(/-/g, '') || ''

      // 期間前の最終取引の残高を開始残高として設定
      if (from && result.pages.length > 0) {
        let lastBalanceBeforePeriod = 0
        let found = false
        for (const page of result.pages) {
          for (const tx of page.transactions) {
            const txDate = tx.date.replace(/-/g, '')
            if (txDate < from) {
              lastBalanceBeforePeriod = tx.balance
              found = true
            }
          }
        }
        if (found) {
          result.pages[0].openingBalance = lastBalanceBeforePeriod
        }
      }

      const filtered = entriesWithTax.filter((e) => {
        if (!e.date) return true
        if (from && e.date < from) return false
        if (to && e.date > to) return false
        return true
      })

      // 期間フィルタ後のページも開始残高を反映
      if (from) {
        setPages((prev) => {
          if (prev.length > 0 && result.pages[0]) {
            const updated = [...prev]
            updated[0] = { ...updated[0], openingBalance: result.pages[0].openingBalance }
            return updated
          }
          return prev
        })
      }

      setJournalEntries((prev) => [...prev, ...filtered])

      // 取引はあるが仕訳が0件の場合に警告
      const totalTx = result.pages.reduce((s, p) => s + p.transactions.length, 0)
      if (totalTx > 0 && filtered.length === 0) {
        if (from || to) {
          setError(`${totalTx}件の取引がありますが、処理対象期間（${from || '?'}〜${to || '?'}）に該当する仕訳がありません。期間設定を確認してください。`)
        } else {
          setError(`${totalTx}件の取引がありますが、仕訳データが作成されませんでした。入金・出金列が正しくマッピングされているか確認してください。`)
        }
      }
    },
    [accountMaster, geminiModel],
  )

  const handleUpload = useCallback(
    async (config: UploadConfig) => {
      setIsLoading(true)
      setLoadingProgress(10)
      setError(null)
      setUploadConfig(config)
      uploadConfigRef.current = config

      // 経過時間タイマーは try の外で保持し、finally で必ず停止する。
      // （途中でエラー／通信ハングが起きても秒数カウンターが動き続けないようにする）
      let progressTimer: ReturnType<typeof setInterval> | null = null
      try {
        setLoadingProgress(15)
        setParseElapsed(null)
        const startTime = Date.now()
        progressTimer = setInterval(() => {
          const elapsed = (Date.now() - startTime) / 1000
          const progress = Math.min(15 + 80 * (1 - Math.exp(-elapsed / 8)), 95)
          setLoadingProgress(Math.round(progress))
          setParseElapsed(`${elapsed.toFixed(0)}秒`)
        }, 500)

        if (config.documentType === 'yucho') {
          // ゆうちょ受払通知票: テキストPDFをスクリプトで即時解析
          const { parseYuchoPdf } = await import('@/lib/bank-statement/yucho-parser')
          const result = await parseYuchoPdf(config.file)
          clearInterval(progressTimer)
          setLoadingProgress(100)
          const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1)
          setParseElapsed(`${elapsedSec}秒`)
          pdfFileRef.current = result.pdfFile
          setPages((prev) => [...prev, ...result.pages])
          setCurrentPageIndex(0)
          // 仕訳変換（通帳と同じmapper使用）
          const { mapTransactionsToJournalEntries } = await import('@/lib/bank-statement/journal-mapper')
          const { getPatterns } = await import('@/lib/bank-statement/pattern-store')
          const patterns = getPatterns()
          const entries = mapTransactionsToJournalEntries(
            result.pages, config.accountCode, config.accountName, patterns, accountMaster,
            config.accountSubCode, config.accountSubName,
          )
          setJournalEntries((prev) => [...prev, ...entries])
          setInfo(`ゆうちょ受払通知票から${result.pages.length}件の取引を抽出しました（${elapsedSec}秒）`)
          setIsLoading(false)
          setLoadingProgress(0)
          return
        }

        if (config.documentType === 'payroll') {
          clearInterval(progressTimer)
          setIsLoading(false)
          setShowPayroll(true)
          return
        }

        if (config.documentType === 'credit-card') {
          const fName = config.file.name.toLowerCase()
          const isCsvOrExcel = fName.endsWith('.csv') || fName.endsWith('.xlsx') || fName.endsWith('.xls') || fName.endsWith('.ods')

          if (isCsvOrExcel) {
            // クレジットカード CSV/Excel 処理（コード解析、Gemini不要）
            const { parseCreditCardCsv, creditCardToEntries } = await import('@/lib/bank-statement/credit-card-mapper')
            const ccData = await parseCreditCardCsv(config.file)
            if (!ccData || ccData.transactions.length === 0) {
              // 自動検出に失敗 → 列マッピング画面で手動指定（現金出納帳と同様）
              let rows: RawTableRow[] = []
              if (fName.endsWith('.csv')) {
                const { decodeCsvText } = await import('@/lib/bank-statement/transaction-extractor')
                const text = decodeCsvText(await config.file.arrayBuffer())
                rows = text.split(/\r?\n/).filter((l) => l.trim().length > 0)
                  .map((l, i) => ({ cells: parseCsvLine(l), rowIndex: i }))
              } else {
                const { parseExcel } = await import('@/lib/bank-statement/excel-parser')
                const sheets = await parseExcel(config.file)
                rows = sheets[0]?.rows || []
              }
              clearInterval(progressTimer)
              setLoadingProgress(0)
              if (rows.length === 0) throw new Error('クレジットカードのファイルから行を読み取れませんでした。')
              setUploadConfig(config)
              uploadConfigRef.current = config
              setCcRawRows(rows)
              setShowCcColumnMapping(true)
              setIsLoading(false)
              return
            }
            const entries = creditCardToEntries(ccData, config.creditCode!, config.creditName!, config.creditSubCode, config.creditSubName)
            // 左側表示用に仮想ページを生成（元データの一覧表示）
            const ccPages: StatementPage[] = [{
              pageIndex: 0,
              transactions: ccData.transactions.map((t, i) => ({
                id: `cc-tx-${Date.now()}-${i}`,
                pageIndex: 0,
                rowIndex: i,
                date: t.usageDate,
                description: t.storeName,
                deposit: t.amount > 0 ? t.amount : null,
                withdrawal: t.amount < 0 ? Math.abs(t.amount) : null,
                balance: 0,
              })),
              openingBalance: 0,
              closingBalance: ccData.totalAmount,
              isBalanceValid: true,
              balanceDifference: 0,
            }]
            setPages((prev) => [...prev, ...ccPages])
            // accountCode にカード科目をセット（残高計算用）
            setUploadConfig({ ...config, accountCode: config.creditCode || '', accountName: config.creditName || '' })
            setJournalEntries((prev) => [...prev, ...entries])
            setInfo(`クレジットカードCSV: ${entries.length}件の取引を検出（引落総額: ¥${ccData.totalAmount.toLocaleString()}）`)
            clearInterval(progressTimer)
            setLoadingProgress(100)
            setIsLoading(false)
            return
          }

          // クレジットカード PDF 処理（Gemini OCR）
          const { renderPdfPageToImage, getPdfPageCount } = await import('@/lib/bank-statement/pdf-text-parser')
          const pageCount = await getPdfPageCount(config.file)
          const imageDataUrls: string[] = []
          for (let i = 0; i < pageCount; i++) {
            imageDataUrls.push(await renderPdfPageToImage(config.file, i + 1, 2))
          }

          const ccData = await creditCardOcr(imageDataUrls, geminiModel)
          const { creditCardToEntries } = await import('@/lib/bank-statement/credit-card-mapper')
          const entries = creditCardToEntries(ccData, config.creditCode!, config.creditName!, config.creditSubCode, config.creditSubName)

          // PDFページ画像を表示用にセット
          const dummyPages = imageDataUrls.map((url, i) => ({
            pageIndex: i,
            transactions: [],
            openingBalance: 0,
            closingBalance: 0,
            isBalanceValid: true,
            balanceDifference: 0,
            imageDataUrl: url,
          }))
          setPages((prev) => [...prev, ...dummyPages])

          setJournalEntries((prev) => [...prev, ...entries])
          setInfo(`クレジットカード明細: ${entries.length}件の取引を検出（引落日: ${ccData.paymentDate}、引落総額: ¥${(ccData.totalAmount || 0).toLocaleString()}）`)
          clearInterval(progressTimer)
          setLoadingProgress(100)
          setIsLoading(false)
          return
        }

        if (config.documentType === 'receipt') {
          // Excel/CSV: 列マッピングダイアログを表示
          const fName = config.file.name.toLowerCase()
          if (fName.endsWith('.xlsx') || fName.endsWith('.xls') || fName.endsWith('.ods') || fName.endsWith('.csv')) {
            let rows: RawTableRow[] = []
            if (fName.endsWith('.csv')) {
              const { decodeCsvText } = await import('@/lib/bank-statement/transaction-extractor')
              const text = decodeCsvText(await config.file.arrayBuffer())
              rows = text.split(/\r?\n/).filter((l) => l.trim().length > 0)
                .map((l, i) => ({ cells: parseCsvLine(l), rowIndex: i }))
            } else {
              const { parseExcel } = await import('@/lib/bank-statement/excel-parser')
              const sheets = await parseExcel(config.file)
              // 「レシート」「領収」を含むシートを優先、なければ先頭シート
              const sheet = sheets.find((s) => /レシート|領収/.test(s.sheetName)) || sheets[0]
              rows = sheet?.rows || []
            }
            clearInterval(progressTimer)
            setLoadingProgress(0)
            if (rows.length === 0) throw new Error('レシートファイルから行を読み取れませんでした。')
            setUploadConfig(config)
            uploadConfigRef.current = config
            setReceiptRawRows(rows)
            setShowReceiptColumnMapping(true)
            setIsLoading(false)
            return
          }

          // 画像ファイル（JPEG/PNG等）か、PDFかを判定
          const rcptName = config.file.name.toLowerCase()
          const isImageFile =
            /\.(jpe?g|png|webp|heic|heif)$/.test(rcptName) || config.file.type.startsWith('image/')

          // PDFのみ：まずテキストPDF解析を試行（無料・高速。画像PDF/画像ファイルはスキップ）
          if (!isImageFile) {
            const { parseReceiptTextPdf } = await import('@/lib/bank-statement/receipt-parser')
            const textResult = await parseReceiptTextPdf(config.file, (receipt, pageIdx, totalPages) => {
              setLoadingProgress(Math.round(15 + 25 * (pageIdx + 1) / totalPages))
            })

            if (textResult.isTextPdf && textResult.receipts.length > 0) {
              // テキストPDF: スクリプトのみで解析完了
              clearInterval(progressTimer)
              setLoadingProgress(100)
              const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1)
              setParseElapsed(`${elapsedSec}秒`)
              const idPages = textResult.pages.map((p, i) => ({ ...p, id: p.id || genPageId(i) }))
              setPages((prev) => [...prev, ...idPages])
              setCurrentPageIndex(0)
              const { receiptToEntries } = await import('@/lib/bank-statement/receipt-mapper')
              const entries = receiptToEntries(textResult.receipts.map((r) => ({
                receiptIndex: r.pageIndex,
                storeName: r.storeName,
                receiptDate: r.date,
                mainContent: r.description,
                invoiceNumber: r.invoiceNumber,
                taxLines: [{ taxRate: '10%', netAmount: 0, taxAmount: 0, totalAmount: r.totalAmount }],
                pageIndex: r.pageIndex,
              })), config.creditCode!, config.creditName!, config.creditSubCode, config.creditSubName, undefined,
              (rcp) => idPages[rcp.pageIndex]?.id)
              setJournalEntries((prev) => [...prev, ...entries])
              setInfo(`${textResult.receipts.length}件のレシートをテキスト解析しました（${elapsedSec}秒）`)
              setIsLoading(false)
              setLoadingProgress(0)
              return
            }
          }

          // 画像PDF / 画像ファイル: Gemini APIで解析（1枚=1リクエストで並列処理 → 最短時間）
          let imageDataUrls: string[]
          if (isImageFile) {
            const imgFiles = [config.file, ...(config.extraImages || [])]
            imageDataUrls = await Promise.all(imgFiles.map(fileToDataUrl))
          } else {
            // PDFは一度だけ開いて全ページ画像化（ページ毎の再パースを避ける）
            const { renderAllPdfPages } = await import('@/lib/bank-statement/pdf-text-parser')
            imageDataUrls = await renderAllPdfPages(config.file, 2, (idx, _url, total) => {
              // 画像化: 15→40%
              setLoadingProgress(Math.round(15 + 25 * (idx + 1) / total))
            })
          }

          const rcptTotal = imageDataUrls.length
          setInfo(`${rcptTotal}枚を並列解析しています…`)
          const data = await receiptOcrParallel(imageDataUrls, geminiModel, {
            concurrency: rcptTotal, // アップロード枚数ぶん並列（関数側で上限16本にキャップ）
            onProgress: (d, t) => {
              // OCR: 40→95%
              setLoadingProgress(Math.round(40 + 55 * d / t))
              setInfo(`レシートを解析中… ${d}/${t} 枚`)
            },
          })
          clearInterval(progressTimer)
          setLoadingProgress(100)

          const receipts = data.receipts || []
          if (receipts.length === 0) throw new Error('レシートデータを抽出できませんでした')

          // 横・上下逆スキャンの自動補正: Geminiが返す orientation（正位置にするための時計回り角度）で
          // 解析元画像を回転してから表示する（各ページの最初のレシートの値を採用）
          const { rotateImageDataUrl } = await import('@/lib/bank-statement/image-utils')
          const pageOrientation = new Map<number, number>()
          for (const r of receipts) {
            const deg = Number(r.orientation) || 0
            if (!pageOrientation.has(r.pageIndex) && (deg === 90 || deg === 180 || deg === 270)) {
              pageOrientation.set(r.pageIndex, deg)
            }
          }
          const uprightUrls = await Promise.all(
            imageDataUrls.map((url, i) => rotateImageDataUrl(url, pageOrientation.get(i) || 0)),
          )

          const statementPages = uprightUrls.map((url, i) => ({
            pageIndex: i, transactions: [],
            openingBalance: 0, closingBalance: 0, isBalanceValid: true, balanceDifference: 0,
            imageDataUrl: url,
            id: genPageId(i),
          }))
          setPages((prev) => [...prev, ...statementPages])

          const { receiptToEntries } = await import('@/lib/bank-statement/receipt-mapper')
          const entries = receiptToEntries(
            receipts, config.creditCode!, config.creditName!, config.creditSubCode, config.creditSubName, undefined,
            // レシートのページ番号→解析元ページIDを紐付け（行クリックで左に表示／行削除で画像も削除）
            (rcp) => statementPages[rcp.pageIndex]?.id,
          )
          setJournalEntries((prev) => [...prev, ...entries])
          setInfo(`${receipts.length}件のレシートから${entries.length}件の仕訳を生成しました`)
          setIsLoading(false)
          setLoadingProgress(0)
          return
        }

        if (config.documentType === 'cash-book') {
          // 現金出納帳処理（通帳と同じロジック）
          const result = await parseFile(config.file, config.accountCode)
          clearInterval(progressTimer)
          setLoadingProgress(100)

          if (result.pdfFile) pdfFileRef.current = result.pdfFile

          if (result.needsColumnMapping && result.rawPages) {
            setRawPages(result.rawPages)
            setPendingSourceType(result.sourceType)
            setPendingImageUrls(result.pageImageUrls || null)
            setShowColumnMapping(true)
            setIsLoading(false)
            return
          }

          if (result.ocrFailed) {
            setPages(result.pages)
            setCurrentPageIndex(0)
            setJournalEntries([])
            const detail = result.ocrErrorMessage ? `\n原因: ${result.ocrErrorMessage}` : ''
            setError(`現金出納帳のテキスト抽出に失敗しました。${detail}`)
            setIsLoading(false)
            setLoadingProgress(0)
            return
          }

          applyParseResultFn(result, config)
          if (result.corrections && result.corrections.length > 0) {
            setInfo(`入出金の自動補正を行いました:\n${result.corrections.join('\n')}`)
          }
          setIsLoading(false)
          setLoadingProgress(0)
          return
        }

        if (config.documentType === 'sales-invoice' || config.documentType === 'purchase-invoice') {
          // Excel/CSV: 列マッピングダイアログで処理
          const ext = config.file.name.toLowerCase().split('.').pop() || ''
          if (ext === 'xlsx' || ext === 'xls' || ext === 'ods' || ext === 'csv') {
            const { parseExcel } = await import('@/lib/bank-statement/excel-parser')
            let sheetRows: RawTableRow[] = []
            if (ext === 'csv') {
              const { decodeCsvText } = await import('@/lib/bank-statement/transaction-extractor')
              const buffer = await config.file.arrayBuffer()
              const text = decodeCsvText(buffer)  // UTF-8 / UTF-8 BOM / Shift_JIS 自動判定
              const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0)
              sheetRows = lines.map((l, i) => ({
                cells: parseCsvLine(l),
                rowIndex: i,
              }))
            } else {
              const sheets = await parseExcel(config.file)
              if (!sheets.length) throw new Error('Excel ファイルにシートがありません')
              sheetRows = sheets[0].rows
            }
            clearInterval(progressTimer)
            setLoadingProgress(0)
            if (sheetRows.length === 0) throw new Error('行データが見つかりませんでした')
            setInvoiceRawRows(sheetRows)
            setShowInvoiceColumnMapping(true)
            setIsLoading(false)
            return
          }

          // PDF: Gemini OCR 処理
          const { renderPdfPageToImage, getPdfPageCount } = await import('@/lib/bank-statement/pdf-text-parser')
          const pageCount = await getPdfPageCount(config.file)
          const imageDataUrls: string[] = []
          for (let i = 0; i < pageCount; i++) {
            imageDataUrls.push(await renderPdfPageToImage(config.file, i + 1, 2))
          }

          const invoiceType = config.documentType === 'purchase-invoice' ? 'purchase' : 'sales'
          const data = await invoiceOcr(imageDataUrls, invoiceType, geminiModel)
          clearInterval(progressTimer)
          setLoadingProgress(100)

          const invoices = data.invoices || []
          if (invoices.length === 0) throw new Error('請求書データを抽出できませんでした')

          // ページ画像を表示用に設定
          const statementPages = imageDataUrls.map((url, i) => ({
            pageIndex: i, transactions: [],
            openingBalance: 0, closingBalance: 0, isBalanceValid: true, balanceDifference: 0,
            imageDataUrl: url,
          }))
          setPages(statementPages)
          setCurrentPageIndex(0)

          // 仕訳生成
          const { salesInvoiceToEntries, purchaseInvoiceToEntries, applyPatternsToInvoiceEntries } = await import('@/lib/bank-statement/invoice-mapper')
          // 借方・貸方どちらか片方未入力の場合は空文字で渡し、ユーザーが後で補完できる
          const dCode = config.debitCode || ''
          const dName = config.debitName || ''
          const cCode = config.creditCode || ''
          const cName = config.creditName || ''
          const dSubCode = config.debitSubCode || ''
          const dSubName = config.debitSubName || ''
          const cSubCode = config.creditSubCode || ''
          const cSubName = config.creditSubName || ''
          const rawEntries = config.documentType === 'sales-invoice'
            ? salesInvoiceToEntries(invoices, dCode, dName, cCode, cName, dSubCode, dSubName, cSubCode, cSubName)
            : purchaseInvoiceToEntries(invoices, dCode, dName, cCode, cName, dSubCode, dSubName, cSubCode, cSubName)
          // 学習パターンを適用（請求先名_内容 + 金額でマッチ）
          const { getPatterns } = await import('@/lib/bank-statement/pattern-store')
          const entries = applyPatternsToInvoiceEntries(rawEntries, getPatterns())
          setJournalEntries((prev) => [...prev, ...entries])
          setInfo(`${invoices.length}件の請求書から${entries.length}件の仕訳を生成しました`)
          setIsLoading(false)
          setLoadingProgress(0)
          return
        }

        // 通帳処理（従来通り）
        const result = await parseFile(config.file, config.accountCode)
        clearInterval(progressTimer)
        setLoadingProgress(100)
        const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1)
        setParseElapsed(`${elapsedSec}秒`)
        // テキストPDFのオンデマンド画像生成用にファイルを保持
        if (result.pdfFile) {
          pdfFileRef.current = result.pdfFile
        }

        if (result.needsColumnMapping && result.rawPages) {
          setRawPages(result.rawPages)
          setPendingSourceType(result.sourceType)
          setPendingImageUrls(result.pageImageUrls || null)
          setShowColumnMapping(true)
          setIsLoading(false)
          return
        }

        if (result.ocrFailed) {
          // OCR失敗: 画像のみ表示して手動入力モード
          setPages(result.pages)
          setCurrentPageIndex(0)
          setJournalEntries([])
          const detail = result.ocrErrorMessage ? `\n原因: ${result.ocrErrorMessage}` : ''
          setError(`Gemini OCRによるテキスト抽出に失敗しました。${detail}\n左側のPDF画像を参照しながら、右側の「+ 空白行追加」ボタンから手動で仕訳を入力してください。`)
          setIsLoading(false)
          return
        }

        applyParseResultFn(result, config)

        // 入出金自動補正があった場合に通知
        if (result.corrections && result.corrections.length > 0) {
          setInfo(`入出金の自動補正を行いました（残高検算により修正）:\n${result.corrections.join('\n')}`)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'ファイルの解析に失敗しました')
      } finally {
        if (progressTimer) clearInterval(progressTimer) // どの経路でも必ずタイマーを止める
        setIsLoading(false)
        setLoadingProgress(0)
      }
    },
    [applyParseResultFn],
  )

  // Firebase リアルタイム同期: 顧問先選択中、合言葉設定済みなら購読開始。
  // リモート変更を localStorage へ反映済みなので、表示中の state を再ロードする。
  useEffect(() => {
    if (!selectedClient || !roomReady) return
    let cancelled = false
    ;(async () => {
      await startFirebaseSync(selectedClient.id, (changedKeys) => {
        const masterKeys = ['account-master', 'sub-account-master', 'account-tax-master']
        if (changedKeys.some((k) => masterKeys.includes(k))) {
          setAccountMaster(loadAccountMaster())
          setSubAccountMaster(loadSubAccountMaster())
          setAccountTaxMaster(loadAccountTaxMaster())
        }
        if (changedKeys.includes('processing-status')) {
          setProcessingStatusVersion((v) => v + 1)
        }
        if (changedKeys.includes('temp-entries')) {
          setTempCount(getTempEntryCount())
        }
        setInfo('他の端末の変更を取り込みました')
      })
      if (cancelled) stopFirebaseSync()
    })()
    return () => {
      cancelled = true
      stopFirebaseSync()
    }
  }, [selectedClient, roomReady])

  // ページ遷移時にオンデマンドで画像を生成（テキストPDF用）
  useEffect(() => {
    if (!pdfFileRef.current || pages.length === 0) return
    const page = pages[currentPageIndex]
    if (!page || page.imageDataUrl) return
    let cancelled = false
    ;(async () => {
      const { renderPdfPageToImage } = await import('@/lib/bank-statement/pdf-text-parser')
      const url = await renderPdfPageToImage(pdfFileRef.current!, currentPageIndex + 1, 2)
      if (!cancelled) {
        setPages((prev) => prev.map((p, i) => i === currentPageIndex ? { ...p, imageDataUrl: url } : p))
      }
    })()
    return () => { cancelled = true }
  }, [currentPageIndex, pages])

  const handleColumnMappingConfirm = useCallback(
    async (mapping: ColumnMapping, options?: { expandAbbreviations?: boolean }) => {
      if (!rawPages || !pendingSourceType || !uploadConfig) return

      // 列マッピングを科目CD別に学習保存（Excel/CSV/PDF表 すべて対象）。
      // 顧問先ごと1キーに集約し、Firebase同期・ZIPバックアップの対象にする。
      if (uploadConfig.accountCode) {
        const cid = localStorage.getItem('bank-statement-selected-client') || ''
        saveExcelMapping(cid, uploadConfig.accountCode, mapping)
      }

      setShowColumnMapping(false)
      setIsLoading(true)

      try {
        const result: ParseResult = applyColumnMapping(rawPages, mapping, pendingSourceType)

        // 摘要の略記補完（AI）: 全ページの取引摘要を順番に Gemini へ渡して名前部分を補完
        if (options?.expandAbbreviations) {
          const flat: { pi: number; ti: number }[] = []
          const descriptions: string[] = []
          result.pages.forEach((page, pi) => {
            page.transactions.forEach((tx, ti) => {
              flat.push({ pi, ti })
              descriptions.push(tx.description || '')
            })
          })
          if (descriptions.length > 0) {
            setInfo('摘要の略記を AI で補完中...')
            try {
              {
                const data = await expandDescriptions(descriptions, geminiModel)
                const expanded: string[] = data.descriptions || []
                if (expanded.length === descriptions.length) {
                  flat.forEach((loc, i) => {
                    result.pages[loc.pi].transactions[loc.ti].description = expanded[i]
                  })
                }
                if (data.warning) setError(`摘要補完の注意: ${data.warning}（元の摘要を使用しました）`)
              }
            } catch (e) {
              setError(`摘要補完に失敗しました（元の摘要を使用）: ${e instanceof Error ? e.message : ''}`)
            }
          }
        }

        // 列マッピング結果のページに画像URLを付与
        if (pendingImageUrls) {
          result.pages = result.pages.map((page, i) => ({
            ...page,
            imageDataUrl: pendingImageUrls[i] || page.imageDataUrl,
          }))
        }
        applyParseResultFn(result, uploadConfig)
      } catch (err) {
        setError(err instanceof Error ? err.message : '列マッピングの適用に失敗しました')
      } finally {
        setIsLoading(false)
        setRawPages(null)
        setPendingSourceType(null)
        setPendingImageUrls(null)
      }
    },
    [rawPages, pendingSourceType, uploadConfig, applyParseResultFn, pendingImageUrls, geminiModel],
  )

// 日付一括変更を適用
  const handleBulkDateApply = useCallback(() => {
    if (!bulkDate) { setError('変更後の日付を選択してください'); return }
    const newDate = bulkDate.replace(/-/g, '')
    setJournalEntries((prev) => prev.map((e) => {
      let description = e.description
      // 「解析時の日付を摘要に追加」: 元の日付（現在の e.date）から "_M月D日利用分" を付与（重複防止）
      if (bulkDateAddToDesc && e.date && e.date.length === 8 && !/利用分$/.test(description)) {
        const m = parseInt(e.date.slice(4, 6))
        const d = parseInt(e.date.slice(6, 8))
        if (m && d) description = `${e.description}_${m}月${d}日利用分`
      }
      return { ...e, date: newDate, description }
    }))
    setShowBulkDateDialog(false)
    setInfo(`仕訳データの日付を ${bulkDate} に一括変更しました${bulkDateAddToDesc ? '（摘要に利用日を追加）' : ''}`)
  }, [bulkDate, bulkDateAddToDesc])

  const handleCcColumnMappingConfirm = useCallback(
    async (mapping: ColumnMapping) => {
      if (!ccRawRows || !uploadConfig) return
      setShowCcColumnMapping(false)
      setIsLoading(true)
      try {
        const dateCol = mapping.dateColumn
        const amountCol = mapping.depositColumn >= 0 ? mapping.depositColumn : mapping.withdrawalColumn
        const descCols = mapping.descriptionColumns && mapping.descriptionColumns.length > 0
          ? mapping.descriptionColumns
          : (mapping.descriptionColumn >= 0 ? [mapping.descriptionColumn] : [])

        const parseDate = (raw: string): string => {
          const s = String(raw || '').trim()
          let m = s.match(/(\d{4})[/.\-年](\d{1,2})[/.\-月](\d{1,2})/)
          if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
          return ''
        }
        const parseAmt = (raw: string): number => {
          const c = String(raw || '').replace(/[,¥￥\s　]/g, '').replace(/[△▲]/g, '-')
          const n = parseInt(c, 10)
          return isNaN(n) ? NaN : n
        }

        const transactions: { usageDate: string; storeName: string; amount: number; memo: string }[] = []
        for (const row of ccRawRows) {
          const date = parseDate(row.cells[dateCol] || '')
          if (!date) continue // ヘッダー・空行スキップ
          const amount = parseAmt(row.cells[amountCol] || '')
          if (isNaN(amount) || amount === 0) continue
          const storeName = descCols.map((c) => (row.cells[c] || '').trim()).filter(Boolean).join(' ')
          transactions.push({ usageDate: date, storeName, amount, memo: amount < 0 ? '返品・取消' : '' })
        }
        if (transactions.length === 0) throw new Error('有効なクレジットカード取引が見つかりませんでした（日付・金額の列を確認してください）。')

        const paymentDate = transactions.reduce((a, t) => (t.usageDate > a ? t.usageDate : a), '')
        const totalAmount = transactions.reduce((s, t) => s + t.amount, 0)
        const ccData = { paymentDate: paymentDate || new Date().toISOString().slice(0, 10), totalAmount, cardName: '', transactions }

        const { creditCardToEntries } = await import('@/lib/bank-statement/credit-card-mapper')
        const entries = creditCardToEntries(ccData, uploadConfig.creditCode!, uploadConfig.creditName!, uploadConfig.creditSubCode, uploadConfig.creditSubName)
        const ccPages: StatementPage[] = [{
          pageIndex: 0,
          transactions: ccData.transactions.map((t, i) => ({
            id: `cc-tx-${Date.now()}-${i}`, pageIndex: 0, rowIndex: i,
            date: t.usageDate, description: t.storeName,
            deposit: t.amount > 0 ? t.amount : null,
            withdrawal: t.amount < 0 ? Math.abs(t.amount) : null,
            balance: 0,
          })),
          openingBalance: 0, closingBalance: totalAmount, isBalanceValid: true, balanceDifference: 0,
        }]
        setPages((prev) => [...prev, ...ccPages])
        setUploadConfig({ ...uploadConfig, accountCode: uploadConfig.creditCode || '', accountName: uploadConfig.creditName || '' })
        setJournalEntries((prev) => [...prev, ...entries])
        setInfo(`クレジットカード（列マッピング）: ${entries.length}件の取引を検出（合計: ¥${totalAmount.toLocaleString()}）`)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'クレジットカードの取り込みに失敗しました')
      } finally {
        setIsLoading(false)
        setCcRawRows(null)
      }
    },
    [ccRawRows, uploadConfig],
  )

  const handleReceiptColumnMappingConfirm = useCallback(
    async (mapping: ReceiptColumnMapping) => {
      if (!receiptRawRows || !uploadConfig) return
      setShowReceiptColumnMapping(false)
      setIsLoading(true)
      try {
        const parseDate = (raw: string): string => {
          const s = String(raw || '').trim()
          // Excel パーサが YYYY-MM-DD に変換済み
          const m = s.match(/(\d{4})[/.\-年](\d{1,2})[/.\-月](\d{1,2})/)
          if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
          return ''
        }
        const parseAmt = (raw: string): number => {
          const c = String(raw || '').replace(/[,¥￥\s　]/g, '').replace(/[△▲]/g, '-')
          const n = parseInt(c, 10)
          return isNaN(n) ? 0 : n
        }

        interface ReceiptRow {
          receiptIndex: number
          storeName: string
          receiptDate: string
          mainContent: string
          invoiceNumber?: string
          taxLines: { taxRate: string; netAmount: number; taxAmount: number; totalAmount: number }[]
          pageIndex: number
        }

        const receipts: ReceiptRow[] = []
        const dataRows = receiptRawRows.slice(mapping.headerRowIndex + 1)
        for (let i = 0; i < dataRows.length; i++) {
          const row = dataRows[i]
          const date = parseDate(row.cells[mapping.dateColumn] || '')
          if (!date) continue
          const storeName = (row.cells[mapping.storeNameColumn] || '').trim()
          if (!storeName) continue
          const total = parseAmt(row.cells[mapping.totalAmountColumn] || '')
          if (total <= 0) continue

          const mainContent = mapping.mainContentColumns.length > 0
            ? mapping.mainContentColumns.map((c) => (row.cells[c] || '').trim()).filter(Boolean).join(' ')
            : ''
          const invoiceNumber = mapping.invoiceNumberColumn >= 0
            ? (row.cells[mapping.invoiceNumberColumn] || '').trim()
            : ''
          const memo = mapping.memoColumn >= 0 ? (row.cells[mapping.memoColumn] || '').trim() : ''

          const amt10 = mapping.amount10Column >= 0 ? parseAmt(row.cells[mapping.amount10Column] || '') : 0
          const amt8 = mapping.amount8Column >= 0 ? parseAmt(row.cells[mapping.amount8Column] || '') : 0
          const amtEx = mapping.amountExemptColumn >= 0 ? parseAmt(row.cells[mapping.amountExemptColumn] || '') : 0

          const taxLines: ReceiptRow['taxLines'] = []
          if (amt10 > 0) taxLines.push({ taxRate: '10%', netAmount: 0, taxAmount: 0, totalAmount: amt10 })
          if (amt8 > 0) taxLines.push({ taxRate: '8%', netAmount: 0, taxAmount: 0, totalAmount: amt8 })
          if (amtEx > 0) taxLines.push({ taxRate: '対象外', netAmount: 0, taxAmount: 0, totalAmount: amtEx })

          // 内訳が無い、または合計が支払総額と一致しない場合は支払総額1行（10%既定）にフォールバック
          const breakdownSum = taxLines.reduce((s, t) => s + t.totalAmount, 0)
          if (taxLines.length === 0 || breakdownSum !== total) {
            taxLines.length = 0
            taxLines.push({ taxRate: '10%', netAmount: 0, taxAmount: 0, totalAmount: total })
          }

          receipts.push({
            receiptIndex: i,
            storeName,
            receiptDate: date,
            mainContent: memo ? `${mainContent}${mainContent ? ' ' : ''}(${memo})` : mainContent,
            invoiceNumber: invoiceNumber || undefined,
            taxLines,
            pageIndex: i,
          })
        }

        if (receipts.length === 0) throw new Error('有効なレシート行が見つかりませんでした（日付・相手先・支払総額を確認してください）')

        const previewPageId = genPageId(0)
        const { receiptToEntries } = await import('@/lib/bank-statement/receipt-mapper')
        const entries = receiptToEntries(
          receipts,
          uploadConfig.creditCode!,
          uploadConfig.creditName!,
          uploadConfig.creditSubCode,
          uploadConfig.creditSubName,
          true, // 列マッピング経由は常にインボイス登録事業者扱い（経過措置※を付けない）
          () => previewPageId, // Excel取込は1プレビューページに全行を紐付け
        )

        // 左側プレビュー用に仮想ページを生成
        const previewPage: StatementPage = {
          id: previewPageId,
          pageIndex: 0,
          transactions: receipts.map((r, i) => ({
            id: `rcpt-prev-${Date.now()}-${i}`,
            pageIndex: 0,
            rowIndex: i,
            date: r.receiptDate,
            description: `${r.storeName}${r.mainContent ? '_' + r.mainContent : ''}`,
            deposit: null,
            withdrawal: r.taxLines.reduce((s, t) => s + t.totalAmount, 0),
            balance: 0,
          })),
          openingBalance: 0,
          closingBalance: 0,
          isBalanceValid: true,
          balanceDifference: 0,
        }
        setPages((prev) => [...prev, previewPage])
        setJournalEntries((prev) => [...prev, ...entries])
        setInfo(`${receipts.length}件のレシートから${entries.length}件の仕訳を生成しました`)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'レシートの取り込みに失敗しました')
      } finally {
        setIsLoading(false)
        setReceiptRawRows(null)
      }
    },
    [receiptRawRows, uploadConfig],
  )

  const handleInvoiceColumnMappingConfirm = useCallback(
    async (mapping: InvoiceColumnMapping) => {
      if (!invoiceRawRows || !uploadConfig) return
      setShowInvoiceColumnMapping(false)
      setIsLoading(true)
      try {
        const { rowsToInvoiceData, salesInvoiceToEntries, purchaseInvoiceToEntries, applyPatternsToInvoiceEntries } =
          await import('@/lib/bank-statement/invoice-mapper')
        const invoices = rowsToInvoiceData(invoiceRawRows, mapping)
        if (invoices.length === 0) throw new Error('有効な請求書行が見つかりませんでした（金額・日付が空かもしれません）')

        const dCode = uploadConfig.debitCode || ''
        const dName = uploadConfig.debitName || ''
        const cCode = uploadConfig.creditCode || ''
        const cName = uploadConfig.creditName || ''
        const dSubCode = uploadConfig.debitSubCode || ''
        const dSubName = uploadConfig.debitSubName || ''
        const cSubCode = uploadConfig.creditSubCode || ''
        const cSubName = uploadConfig.creditSubName || ''
        const rawEntries = uploadConfig.documentType === 'sales-invoice'
          ? salesInvoiceToEntries(invoices, dCode, dName, cCode, cName, dSubCode, dSubName, cSubCode, cSubName)
          : purchaseInvoiceToEntries(invoices, dCode, dName, cCode, cName, dSubCode, dSubName, cSubCode, cSubName)
        // 学習パターンを適用（請求先名_内容 + 金額でマッチ）
        const { getPatterns } = await import('@/lib/bank-statement/pattern-store')
        const entries = applyPatternsToInvoiceEntries(rawEntries, getPatterns())
        setJournalEntries((prev) => [...prev, ...entries])
        setInfo(`${invoices.length}件の請求書から${entries.length}件の仕訳を生成しました`)
      } catch (err) {
        setError(err instanceof Error ? err.message : '請求書取り込みに失敗しました')
      } finally {
        setIsLoading(false)
        setInvoiceRawRows(null)
      }
    },
    [invoiceRawRows, uploadConfig],
  )

  const handleEntrySelect = useCallback(
    (entryId: string | null) => {
      setSelectedEntryId(entryId)
      if (entryId) {
        const entry = journalEntries.find((e) => e.id === entryId)
        if (entry) {
          // レシート・請求書等: 解析元ページ(sourcePageId)を左ペインに表示
          let idx = -1
          if (entry.sourcePageId) {
            idx = pages.findIndex((p) => p.id === entry.sourcePageId)
          }
          // 通帳・CC等: 取引IDを含むページを表示
          if (idx < 0 && entry.transactionId) {
            idx = pages.findIndex((p) => p.transactions.some((t) => t.id === entry.transactionId))
          }
          if (idx >= 0 && idx !== currentPageIndex) {
            setCurrentPageIndex(idx)
          }
        }
      }
    },
    [journalEntries, pages, currentPageIndex],
  )

  // 仕訳行を削除したら、その解析元の画像ページ（id付き=レシート等の1書類1画像）も
  // どの仕訳からも参照されなくなった時点で一緒に削除する
  useEffect(() => {
    setPages((prev) => {
      if (!prev.some((p) => p.id)) return prev
      const referenced = new Set(
        journalEntries.map((e) => e.sourcePageId).filter((x): x is string => !!x),
      )
      const next = prev.filter((p) => !p.id || referenced.has(p.id))
      return next.length === prev.length ? prev : next
    })
  }, [journalEntries])

  // ページ削除で現在ページが範囲外になったら補正
  useEffect(() => {
    if (currentPageIndex > 0 && currentPageIndex >= pages.length) {
      setCurrentPageIndex(Math.max(0, pages.length - 1))
    }
  }, [pages.length, currentPageIndex])

  const handleAccountMasterUpdate = useCallback((items: AccountItem[]) => {
    setAccountMaster(items)
  }, [])

  const handleSubAccountMasterUpdate = useCallback((items: SubAccountItem[]) => {
    setSubAccountMaster(items)
  }, [])

  const handleBalanceOverride = useCallback(
    (pageIndex: number, field: 'openingBalance' | 'closingBalance', value: number) => {
      setPages((prev) =>
        prev.map((p) => p.pageIndex === pageIndex ? { ...p, [field]: value } : p),
      )
    },
    [],
  )

  // CSV一時保存（チェック選択がある場合は選択分のみ保存、残りは画面に残す）
  const handleTempSave = useCallback(() => {
    if (journalEntries.length === 0) {
      alert('保存する仕訳データがありません')
      return
    }
    const hasSelection = selectedEntryIds.size > 0

    // 保存対象: チェックされたもの or 全部
    // 複合仕訳の子も含めるため parentId が選択された親のものも含める
    const targetIds = new Set<string>()
    if (hasSelection) {
      selectedEntryIds.forEach((id) => targetIds.add(id))
      // 親が選択されている場合は子も含める
      for (const e of journalEntries) {
        if (e.parentId && targetIds.has(e.parentId)) targetIds.add(e.id)
      }
    }

    const entriesToSave = hasSelection
      ? journalEntries.filter((e) => targetIds.has(e.id))
      : journalEntries

    // 科目名が空の場合、科目チェックリストから補完
    const completed = entriesToSave.map((e) => {
      const u = { ...e }
      if (u.debitCode && !u.debitName) {
        const acc = accountMaster.find((a) => a.code === u.debitCode)
        if (acc) u.debitName = acc.shortName || acc.name
      }
      if (u.creditCode && !u.creditName) {
        const acc = accountMaster.find((a) => a.code === u.creditCode)
        if (acc) u.creditName = acc.shortName || acc.name
      }
      return u
    })
    // パターン学習（上書き保存）
    const applied = applyCompoundAutoAmounts(completed)
    learnAllFromEntries(applied, uploadConfig?.accountCode)
    // 一時保存に追記
    const totalCount = appendTempEntries(completed)
    setTempCount(totalCount)

    // 処理状況を更新: uploadConfigRef から確実に科目コードを取得
    const cfgAccountCode = uploadConfigRef.current?.accountCode
    if (cfgAccountCode) {
      // 日付は "2025/04/01" 等の区切り付きでも反映できるよう数字だけに正規化する
      const dates = completed.map((e) => (e.date || '').replace(/\D/g, '')).filter((d) => d.length === 8)
      if (dates.length > 0) {
        updateProcessingStatus(cfgAccountCode, uploadConfigRef.current?.accountName || '', dates, completed.length)
        setProcessingStatusVersion((v) => v + 1)
      }
    }

    if (hasSelection) {
      // 選択分を保存、残りは画面に残す
      setJournalEntries(journalEntries.filter((e) => !targetIds.has(e.id)))
      setSelectedEntryIds(new Set())
      setInfo(`${entriesToSave.length}件を一時保存しました（合計${totalCount}件）。残り${journalEntries.length - entriesToSave.length}件が表示中です。`)
      // 賃金台帳: 全件保存後は画面クリア
      if (uploadConfig?.documentType === 'payroll' && journalEntries.length === entriesToSave.length) {
        setPages([]); setUploadConfig(null); setError(null)
      }
    } else {
      // 全部保存: 全クリア
      setPages([])
      setJournalEntries([])
      setUploadConfig(null)
      setError(null)
      setInfo(`${journalEntries.length}件を一時保存しました（合計${totalCount}件）`)
    }
  }, [journalEntries, selectedEntryIds, accountMaster])

  // 一時保存データをまとめてCSV出力
  const handleTempExport = useCallback(() => {
    const tempEntries = getTempEntries()
    if (tempEntries.length === 0) {
      alert('一時保存されたデータがありません')
      return
    }
    // 科目名補完（仮払金一括登録等で名前が空の場合）
    const completed = tempEntries.map((e) => {
      const u = { ...e }
      if (u.debitCode && !u.debitName) {
        const acc = accountMaster.find((a) => a.code === u.debitCode)
        if (acc) u.debitName = acc.shortName || acc.name
      }
      if (u.creditCode && !u.creditName) {
        const acc = accountMaster.find((a) => a.code === u.creditCode)
        if (acc) u.creditName = acc.shortName || acc.name
      }
      return u
    })
    downloadCsv(completed, undefined, selectedClient?.taxType)
    if (selectedClient) recordCsvExport(selectedClient.id)
    // 仮払金の質問対象を蓄積ストアへ追記（CSV出力でtempはクリアされるため、ここで退避）
    const kariAcc = accountMaster.find((a) => a.name.includes('仮払') || a.shortName.includes('仮払'))
    if (kariAcc) {
      const qItems = completed.filter(
        (e) => (e.debitCode === kariAcc.code || e.creditCode === kariAcc.code) && e.needsQuestion !== false,
      )
      addQuestionItems(qItems)
    }
    clearTempEntries()
    setTempCount(0)
    // 賃金台帳等: CSV出力後は画面クリア
    if (journalEntries.length > 0) {
      setPages([]); setJournalEntries([]); setUploadConfig(null); setError(null)
    }
    setInfo('一時保存データをCSV出力しました。一時保存はクリアされました。')
  }, [accountMaster, selectedClient])

  const handleTempClear = useCallback(() => {
    if (!confirm('一時保存データをすべて削除しますか？')) return
    clearTempEntries()
    setTempCount(0)
  }, [])

  const handleQuestionList = useCallback(() => {
    setShowQuestionList(true)
  }, [])

  const selectedTransactionId = (() => {
    if (!selectedEntryId) return null
    const entry = journalEntries.find((e) => e.id === selectedEntryId)
    return entry?.transactionId ?? null
  })()

  return (
    <>
    <FirebaseRoomDialog
      open={showRoomDialog}
      firstTime={!roomReady}
      onClose={() => setShowRoomDialog(false)}
      onConfirmed={() => setRoomReady(true)}
    />
    {showClientSelector ? (
      <ClientSelector onSelect={handleClientSelect} refreshSignal={clientsRefresh} />
    ) : (
    <div className="h-screen flex flex-col bank-statement-app fusion">
      <GlobalNav currentKey="aiocr-shiwake" />
      {/* ヘッダー */}
      <header className="fusion-bar px-5 py-2 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <div className="fusion-logo">会</div>
          <h1 className="text-base font-semibold text-gray-800 whitespace-nowrap">会計大将インポートデータ変換</h1>
          {selectedClient && (
            <span className="fusion-chip text-xs">{selectedClient.name}</span>
          )}
          <button onClick={handleBackToClientList}
            className="fusion-link text-xs whitespace-nowrap">
            顧問先一覧
          </button>
        </div>
        <div className="flex items-center gap-2">
          {/* 会計入力中に顧問先へ確認・依頼をメモ（顧問先情報の「確認・依頼」に集約） */}
          {selectedClient && <KakuninQuickAdd clientId={selectedClient.id} clientName={selectedClient.name} />}
          {/* バックアップ（全データZIP出力・復元）＋前回バックアップ日 */}
          <BackupButton />
          {/* リアルタイム共有（Firebase 合言葉） */}
          <button onClick={() => setShowRoomDialog(true)}
            title={roomReady ? 'リアルタイム共有中（合言葉設定済み）' : '合言葉を設定して共有を有効化'}
            className="fbtn fbtn-soft">
            {roomReady ? '🟢 共有中' : '⚪ 共有設定'}
          </button>
          {/* 常用ボタン */}
          <button onClick={() => setShowPatternList(true)}
            className="fbtn fbtn-soft">
            パターン一覧
          </button>
          <button onClick={() => setShowFixedJournal(true)}
            className="fbtn fbtn-soft">
            定型仕訳
          </button>
          {/* メニュー: 保存/全件/読込・科目マスタ・インボイス登録簿・Gemini モデル */}
          <HeaderMenuDropdown
            buttonLabel="メニュー"
            items={[
              {
                label: 'バックアップ',
                render: (<BackupButton inMenu />),
              },
              { divider: true },
              {
                label: '科目マスタ',
                render: (
                  <div className="-mx-3 -my-1.5">
                    <AccountMasterUploader
                      embedded
                      accountMaster={accountMaster}
                      subAccountMaster={subAccountMaster}
                      accountTaxMaster={accountTaxMaster}
                      onAccountUpdate={handleAccountMasterUpdate}
                      onSubAccountUpdate={handleSubAccountMasterUpdate}
                      onAccountTaxUpdate={(items) => {
                        setAccountTaxMaster(items)
                        // マスタ更新時、既存仕訳は空欄のときだけ補完（既に設定済みの値は尊重）。
                        // 売上科目を借方（売上返金）に入れても課税売上、経費科目を貸方に入れても
                        // 課税仕入/対象外のまま。科目の正残から売上/仕入区分を判定して側依存を排除する。
                        const preferOf = (code: string): 'sales' | 'purchase' | null => {
                          const acc = accountMaster.find((a) => a.code === code)
                          return acc && isPL(acc.bsPl)
                            ? (acc.normalBalance === '貸方' ? 'sales' : acc.normalBalance === '借方' ? 'purchase' : null)
                            : null
                        }
                        setJournalEntries((prev) => prev.map((e) => {
                          const debitTax = getDefaultTaxCode(items, e.debitCode, preferOf(e.debitCode))
                          const creditTax = getDefaultTaxCode(items, e.creditCode, preferOf(e.creditCode))
                          const tax = debitTax || creditTax
                          if (!tax) return e
                          const updated = { ...e }
                          let changed = false
                          if (!updated.debitTaxCode || updated.debitTaxCode === '0') {
                            updated.debitTaxCode = tax.taxCode
                            // レシート由来(taxLocked)は読み取った税区分を維持し、消費税CDのみ補完
                            if (!updated.taxLocked) updated.debitTaxType = tax.taxName
                            changed = true
                          }
                          // レシート由来は読み取った税率を固定（科目別消費税マスタで上書きしない）
                          if (!updated.taxLocked && !updated.debitTaxRate && tax.taxRate) {
                            updated.debitTaxRate = tax.taxRate
                            changed = true
                          }
                          return changed ? updated : e
                        }))
                      }}
                    />
                  </div>
                ),
              },
              {
                label: 'インボイス登録簿',
                icon: '📋',
                onClick: () => setShowInvoiceRegistry(true),
              },
              { divider: true },
              {
                label: 'Gemini モデル',
                render: (
                  <div>
                    <label className="block text-[10px] text-gray-500 mb-0.5">Gemini モデル</label>
                    <select value={geminiModel} onChange={(e) => {
                      setGeminiModel(e.target.value)
                      localStorage.setItem('bs-gemini-model', e.target.value)
                    }} className="w-full px-2 py-1 text-xs border border-gray-300 rounded">
                      <option value="gemini-3.5-flash">Gemini 3.5 Flash</option>
                      <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
                      <option value="gemini-2.5-pro">Gemini 2.5 Pro</option>
                    </select>
                  </div>
                ),
              },
              {
                label: 'Gemini APIキー設定',
                render: (
                  <div>
                    <label className="block text-[10px] text-gray-500 mb-0.5">Gemini APIキー（この端末に保存）</label>
                    <input
                      type={showGeminiKey ? 'text' : 'password'}
                      value={geminiApiKey}
                      placeholder="AIza... を貼り付け"
                      onChange={(e) => {
                        const v = e.target.value.trim()
                        setGeminiApiKey(v)
                        if (v) localStorage.setItem('bs-gemini-api-key', v)
                        else localStorage.removeItem('bs-gemini-api-key')
                      }}
                      className="w-full px-2 py-1 text-xs border border-gray-300 rounded font-mono"
                    />
                    <div className="flex gap-2 mt-1.5">
                      <button type="button" onClick={() => setShowGeminiKey((s) => !s)} className="text-xs px-2 py-1 border border-gray-300 rounded bg-white hover:bg-gray-50">{showGeminiKey ? '🙈 隠す' : '🔎 表示'}</button>
                      <button type="button" onClick={() => { if (!geminiApiKey) return; navigator.clipboard?.writeText(geminiApiKey).then(() => alert('APIキーをコピーしました')).catch(() => setShowGeminiKey(true)) }} className="text-xs px-2 py-1 border border-gray-300 rounded bg-white hover:bg-gray-50">📋 コピー</button>
                    </div>
                    <p className="text-[11px] mt-1 px-2 py-1 bg-gray-50 rounded text-gray-600">
                      現在この端末に保存されているキー：<b>{geminiApiKey ? `設定済み（末尾 ${geminiApiKey.slice(-4)}・${geminiApiKey.length}文字）` : '未設定'}</b>
                      {!geminiApiKey && typeof window !== 'undefined' && (localStorage.getItem('suite-gemini-api-key') || '').trim() && (
                        <>　→ ホーム画面の<b>共通キー</b>を使用します（末尾 {(localStorage.getItem('suite-gemini-api-key') || '').trim().slice(-4)}）</>
                      )}
                    </p>
                    <p className="text-[10px] text-gray-400 mt-0.5 leading-snug">
                      OCRに必要。<a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer" className="text-blue-500 underline">Google AI Studio</a> で取得し各自で入力してください。
                    </p>
                  </div>
                ),
              },
            ]}
          />
          {journalEntries.length > 0 && (
            <>
              {uploadConfig?.documentType === 'credit-card' && (
                <button onClick={() => setShowBulkDateDialog(true)}
                  title="全仕訳の日付をまとめて変更"
                  className="fbtn fbtn-indigo">
                  日付一括変更
                </button>
              )}
              <button onClick={handleTempSave}
                className="fbtn fbtn-amber">
                {selectedEntryIds.size > 0 ? `選択分を一時保存 (${selectedEntryIds.size}件)` : '一時保存'}
              </button>
              <CsvExportButton entries={journalEntries}
                dateFrom={dateFrom} dateTo={dateTo}
                onDateFromChange={setDateFrom} onDateToChange={setDateTo}
                onExported={(exported) => {
                  if (selectedClient) recordCsvExport(selectedClient.id)
                  // 一時保存を経由しない直接CSV出力でも進捗管理表へ解析日を反映する
                  const cfgAccountCode = uploadConfigRef.current?.accountCode
                  if (cfgAccountCode) {
                    const dates = exported.map((e) => (e.date || '').replace(/\D/g, '')).filter((d) => d.length === 8)
                    if (dates.length > 0) {
                      updateProcessingStatus(cfgAccountCode, uploadConfigRef.current?.accountName || '', dates, exported.length)
                      setProcessingStatusVersion((v) => v + 1)
                    }
                  }
                }} />
            </>
          )}
          {tempCount > 0 && (
            <div className="flex items-center gap-1.5">
              <button onClick={() => setShowTempData(true)}
                className="fbtn fbtn-gray">
                一時保存確認 ({tempCount}件)
              </button>
              <button onClick={handleTempExport}
                className="fbtn fbtn-green">
                一括CSV出力
              </button>
              <button onClick={handleQuestionList}
                className="fbtn fbtn-purple">
                仮払金質問リスト
              </button>
              <button onClick={handleTempClear}
                className="px-1.5 text-sm text-gray-400 hover:text-red-500" title="一時保存をクリア">
                &times;
              </button>
            </div>
          )}
          {/* スペースを空けてアプリ終了ボタン */}
          {selectedClient && (
            <button onClick={handleExitApp} disabled={exitingApp}
              title="ブラウザのタブを閉じます（データは保存済み）"
              className="fbtn fbtn-red ml-3">
              {exitingApp ? '終了中...' : 'アプリ終了'}
            </button>
          )}
        </div>
      </header>

      {/* 取込履歴（パンくず）*/}
      {pages.length > 0 && (
        <div className="fusion-crumb shrink-0">
          <span className="s">取込</span> ＞ <span className="s">{docTypeLabel(uploadConfig?.documentType)}</span>
          {parseElapsed && <> ＞ <b>解析完了 {parseElapsed}（{journalEntries.length}件）</b></>}
        </div>
      )}

      {/* エラー表示 */}
      {error && (
        <div className="bg-red-50 border-b border-red-200 px-4 py-3 text-sm text-red-700 flex items-start gap-2">
          <span className="whitespace-pre-wrap flex-1">{error}</span>
          <button
            onClick={() => setError(null)}
            className="text-red-400 hover:text-red-700 shrink-0 text-lg leading-none"
          >
            &times;
          </button>
        </div>
      )}

      {/* 自動補正通知 */}
      {info && (
        <div className="bg-amber-50 border-b border-amber-200 px-4 py-3 text-sm text-amber-800 flex items-start gap-2">
          <span className="whitespace-pre-wrap flex-1">{info}</span>
          <button
            onClick={() => setInfo(null)}
            className="text-amber-400 hover:text-amber-700 shrink-0 text-lg leading-none"
          >
            &times;
          </button>
        </div>
      )}

      {/* ローディング */}
      {isLoading && (
        <div className="bg-blue-50 border-b border-blue-200 px-4 py-2 shrink-0">
          <div className="flex items-center gap-3">
            <span className="text-sm text-blue-700 shrink-0">ファイルを解析中...</span>
            <div className="flex-1 h-2 bg-blue-200 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-600 rounded-full transition-all duration-300"
                style={{ width: `${loadingProgress}%` }}
              />
            </div>
            <span className="text-xs text-blue-500 w-16 text-right">{loadingProgress}% {parseElapsed || ''}</span>
          </div>
        </div>
      )}

      {/* 解析時間 */}
      {parseElapsed && !isLoading && pages.length > 0 && (
        <div className="bg-green-50 border-b border-green-200 px-4 py-1 text-xs text-green-700 shrink-0">
          解析完了: {parseElapsed} ({pages.reduce((s, p) => s + p.transactions.length, 0)}件の取引を抽出)
        </div>
      )}

      {/* メインコンテンツ */}
      {pages.length > 0 ? (
        <div className="flex-1 flex min-h-0 p-3">
        <ResizableSplitPanel
          defaultLeftPercent={35}
          minLeftPercent={20}
          maxLeftPercent={60}
          left={
            <StatementViewer
              pages={pages}
              currentPageIndex={currentPageIndex}
              onPageChange={setCurrentPageIndex}
              entries={journalEntries}
              selectedTransactionId={selectedTransactionId}
              bankAccountCode={uploadConfig?.accountCode || ''}
              hideBalance={uploadConfig?.documentType === 'credit-card' || uploadConfig?.documentType === 'payroll'}
              onBalanceOverride={handleBalanceOverride}
              onFileDelete={() => {
                if (!window.confirm('アップロードした全ファイルと画面上の仕訳をすべて削除しますか？\n（一時保存済みの仕訳は消えません）')) return
                setPages([]); setJournalEntries([]); setUploadConfig(null); setError(null); setInfo('アップロードファイルをすべて削除しました')
              }}
              onPageDelete={handleDeleteCurrentPage}
            />
          }
          right={
            <JournalEntryTable
              entries={journalEntries}
              accountMaster={accountMaster}
              subAccountMaster={subAccountMaster}
              selectedEntryId={selectedEntryId}
              onSelect={handleEntrySelect}
              onEntriesChange={setJournalEntries}
              onSubAccountUpdate={handleSubAccountMasterUpdate}
              pages={pages}
              bankAccountCode={uploadConfig?.accountCode || ''}
              clientTaxType={selectedClient?.taxType || 'standard'}
              hideBalance={uploadConfig?.documentType === 'credit-card' || uploadConfig?.documentType === 'payroll'}
              onSelectionChange={setSelectedEntryIds}
              onPageChange={setCurrentPageIndex}
              clientId={selectedClient?.id || ''}
            />
          }
        />
        </div>
      ) : journalEntries.length > 0 ? (
        // ページ画像なし（CSV/Excel等）の場合は仕訳テーブルのみ全幅表示
        <div className="flex-1 flex min-h-0 p-3">
        <div className="flex-1 flex flex-col overflow-hidden rounded-2xl border border-[#e8eaed] bg-white">
        <JournalEntryTable
          entries={journalEntries}
          accountMaster={accountMaster}
          subAccountMaster={subAccountMaster}
          selectedEntryId={selectedEntryId}
          onSelect={handleEntrySelect}
          onEntriesChange={setJournalEntries}
          onSubAccountUpdate={handleSubAccountMasterUpdate}
          pages={pages}
          bankAccountCode={uploadConfig?.accountCode || ''}
          clientTaxType={selectedClient?.taxType || 'standard'}
          hideBalance={uploadConfig?.documentType === 'credit-card' || uploadConfig?.documentType === 'payroll'}
          onSelectionChange={setSelectedEntryIds}
          clientId={selectedClient?.id || ''}
        />
        </div>
        </div>
      ) : (
        <div className="flex-1 overflow-auto p-6">
          {/* インライン版アップロード UI（書類タイプを横一列に表示） */}
          <div className="mb-6">
            <h2 className="text-base font-bold text-gray-700 mb-2">ファイルのアップロード</h2>
            <UploadDialog
              inline
              accountMaster={accountMaster}
              subAccountMaster={subAccountMaster}
              onUpload={handleUpload}
              isLoading={isLoading}
              lastPeriodFrom={lastPeriodFrom}
              lastPeriodTo={lastPeriodTo}
            />
          </div>
          <ProcessingStatusTable clientId={selectedClient?.id || null} refreshKey={processingStatusVersion} accountMaster={accountMaster} />
        </div>
      )}

      {/* 列マッピングダイアログ */}
      {showColumnMapping && rawPages && (
        <ColumnMappingDialog
          rawPages={rawPages}
          accountMaster={accountMaster}
          initialMapping={(() => {
            if (!uploadConfig?.accountCode) return undefined
            const cid = localStorage.getItem('bank-statement-selected-client') || ''
            return loadExcelMapping(cid, uploadConfig.accountCode)
          })()}
          onConfirm={handleColumnMappingConfirm}
          onCancel={() => {
            setShowColumnMapping(false)
            setRawPages(null)
            setPendingSourceType(null)
          }}
        />
      )}

      {/* 請求書 Excel/CSV 用 列マッピングダイアログ */}
      {showInvoiceColumnMapping && invoiceRawRows && uploadConfig && (
        <InvoiceColumnMappingDialog
          rows={invoiceRawRows}
          isPurchase={uploadConfig.documentType === 'purchase-invoice'}
          onConfirm={handleInvoiceColumnMappingConfirm}
          onCancel={() => {
            setShowInvoiceColumnMapping(false)
            setInvoiceRawRows(null)
          }}
        />
      )}

      {/* クレジットカード Excel/CSV 用 列マッピングダイアログ（自動検出失敗時） */}
      {showCcColumnMapping && ccRawRows && (
        <ColumnMappingDialog
          mode="credit-card"
          rawPages={[ccRawRows]}
          accountMaster={accountMaster}
          onConfirm={handleCcColumnMappingConfirm}
          onCancel={() => {
            setShowCcColumnMapping(false)
            setCcRawRows(null)
          }}
        />
      )}

      {/* レシート・領収書 Excel/CSV 用 列マッピングダイアログ */}
      {showReceiptColumnMapping && receiptRawRows && (
        <ReceiptColumnMappingDialog
          rows={receiptRawRows}
          onConfirm={handleReceiptColumnMappingConfirm}
          onCancel={() => {
            setShowReceiptColumnMapping(false)
            setReceiptRawRows(null)
          }}
        />
      )}

      {/* 日付一括変更ダイアログ */}
      {showBulkDateDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md">
            <div className="p-5 border-b border-gray-200">
              <h2 className="text-lg font-bold text-gray-800">日付の一括変更</h2>
              <p className="text-xs text-gray-500 mt-1">表示中の全仕訳（{journalEntries.length}件）の日付をまとめて変更します。</p>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">変更後の日付</label>
                <input type="date" value={bulkDate} onChange={(e) => setBulkDate(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
                <p className="text-xs text-gray-400 mt-1">例: クレジットカードの引落日に揃える</p>
              </div>
              <label className="flex items-start gap-2 text-sm text-gray-700 cursor-pointer">
                <input type="checkbox" checked={bulkDateAddToDesc}
                  onChange={(e) => setBulkDateAddToDesc(e.target.checked)}
                  className="w-4 h-4 mt-0.5 accent-indigo-600" />
                <span>
                  解析時の日付を摘要に追加する
                  <span className="block text-xs text-gray-400 mt-0.5">
                    各仕訳の摘要末尾に、元々解析されていた利用日を「_〇月〇日利用分」として追加します。
                  </span>
                </span>
              </label>
            </div>
            <div className="p-4 border-t border-gray-200 flex gap-2">
              <button onClick={() => setShowBulkDateDialog(false)}
                className="flex-1 py-2 bg-gray-100 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-200">
                キャンセル
              </button>
              <button onClick={handleBulkDateApply} disabled={!bulkDate}
                className={`flex-1 py-2 text-sm font-bold rounded-lg ${
                  bulkDate ? 'bg-indigo-600 text-white hover:bg-indigo-700' : 'bg-gray-200 text-gray-400 cursor-not-allowed'
                }`}>
                一括変更を実行
              </button>
            </div>
          </div>
        </div>
      )}

      {/* パターン一覧ダイアログ */}
      <PatternListDialog open={showPatternList} onClose={() => setShowPatternList(false)} />

      {/* 定型仕訳ダイアログ */}
      <FixedJournalDialog
        open={showFixedJournal}
        onClose={() => setShowFixedJournal(false)}
        accountMaster={accountMaster}
        subAccountMaster={subAccountMaster}
        accountTaxMaster={accountTaxMaster}
        onTempCountChange={setTempCount}
      />

      <InvoiceRegistryDialog
        open={showInvoiceRegistry}
        onClose={() => setShowInvoiceRegistry(false)}
      />

      <PayrollUploadDialog
        open={showPayroll}
        onClose={() => setShowPayroll(false)}
        accountMaster={accountMaster}
        subAccountMaster={subAccountMaster}
        accountTaxMaster={accountTaxMaster}
        onGenerate={async (data, bankCode, bankName, deductAccounts, bankSubCode, bankSubName, options) => {
          const { payrollToEntries } = await import('@/lib/bank-statement/payroll-mapper')
          const entries = payrollToEntries(data, bankCode, bankName, deductAccounts, bankSubCode, bankSubName, accountTaxMaster, options)
          setJournalEntries((prev) => [...prev, ...entries])
          setInfo(`${data.period} 賃金台帳から${entries.length}件の仕訳を生成しました（${data.employees.length}名）`)
        }}
        onGenerateEntries={(entries, info) => {
          setJournalEntries((prev) => [...prev, ...entries])
          setInfo(info)
        }}
      />

      <TempDataDialog
        open={showTempData}
        onClose={() => setShowTempData(false)}
        onCountChange={setTempCount}
      />

      <QuestionListDialog
        open={showQuestionList}
        onClose={() => setShowQuestionList(false)}
        accountMaster={accountMaster}
        client={selectedClient}
      />
    </div>
    )}
    </>
    )
}

// 取込パンくず用: 書類種別ラベル
function docTypeLabel(t?: string): string {
  const map: Record<string, string> = {
    'bank-statement': '通帳', 'passbook': '通帳', 'bank': '通帳',
    'cash': '現金出納帳', 'cashbook': '現金出納帳',
    'credit-card': 'クレジットカード', 'creditcard': 'クレジットカード',
    'invoice': '請求書', 'sales-invoice': '売上請求書', 'purchase-invoice': '仕入請求書',
    'receipt': 'レシート・領収書', 'yucho': 'ゆうちょ受払通知', 'payroll': '賃金台帳',
  }
  return (t && map[t]) || '取込データ'
}

// 簡易 CSV 1行パーサ（ダブルクオート対応）
function parseCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuote = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ } else { inQuote = false }
      } else {
        cur += ch
      }
    } else {
      if (ch === '"') inQuote = true
      else if (ch === ',') { out.push(cur); cur = '' }
      else cur += ch
    }
  }
  out.push(cur)
  return out.map((s) => s.trim())
}
