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
import BackupButton from '@/components/bank-statement/BackupButton'
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
import { creditCardOcr, receiptOcr, invoiceOcr, expandDescriptions } from '@/lib/bank-statement/gemini-client'
import { mapTransactionsToJournalEntries } from '@/lib/bank-statement/journal-mapper'
import { getPatterns } from '@/lib/bank-statement/pattern-store'
import { loadAccountMaster, loadSubAccountMaster, loadAccountTaxMaster, getDefaultTaxCode } from '@/lib/bank-statement/account-master'
import { getDefaultTaxCodeByName, isPL } from '@/lib/bank-statement/tax-codes'
import type { AccountTaxItem } from '@/lib/bank-statement/types'
import ClientSelector from '@/components/bank-statement/ClientSelector'
import type { Client } from '@/lib/bank-statement/client-store'
import { getSelectedClientId, setSelectedClientId, recordCsvExport } from '@/lib/bank-statement/client-store'

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

  const handleExitApp = useCallback(async () => {
    if (!window.confirm('アプリを終了してブラウザのタブを閉じます。よろしいですか？\n（データはFirebaseとこのPCに保存済みです）')) return
    setExitingApp(true)
    window.close()
    // window.close() が効かない環境用の代替メッセージ
    setTimeout(() => {
      setExitingApp(false)
      alert('このブラウザタブを閉じてください。')
    }, 500)
  }, [])

  const handleBackToClientList = useCallback(() => {
    setSelectedClientId(null)
    setSelectedClient(null)
    setShowClientSelector(true)
    setPages([])
    setJournalEntries([])
  }, [])

  // この端末の全データ（顧問先・科目マスタ・パターン等）を Firebase へ一括アップロード。
  // 主に「全データを持つ事務所PC」から1回実行し、他PCへ反映させる初期移行用。
  const [fbUploading, setFbUploading] = useState(false)
  const handleFirebaseFullUpload = useCallback(async () => {
    if (!hasRoom()) { alert('先にヘッダー右上の「共有設定」で合言葉を設定してください。'); return }
    if (!window.confirm(
      'この端末の すべての顧問先データ（科目マスタ・補助科目・パターン学習・処理状況など）を Firebase へアップロードし、他のPCと共有します。\n\n' +
      'この端末が最も完全なデータを持っている場合に実行してください。\n実行しますか？',
    )) return
    setFbUploading(true)
    try {
      const { pushEverythingToFirebase } = await import('@/lib/bank-statement/firebase-sync')
      const r = await pushEverythingToFirebase()
      alert(`Firebaseへアップロードしました：顧問先 ${r.uploaded}/${r.total}件。\n\n他のPCで同じ合言葉を開き、各顧問先を選択すると反映されます。`)
    } catch (e) {
      alert('アップロードに失敗しました: ' + (e instanceof Error ? e.message : 'unknown'))
    }
    setFbUploading(false)
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
          // 1. 科目別消費税マスタを参照（空欄のときのみ補完。パターン等で既に設定済みの値は尊重）
          const debitTax = getDefaultTaxCode(taxMaster, updated.debitCode)
          const creditTax = getDefaultTaxCode(taxMaster, updated.creditCode)
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
            const debitAcc = accountMaster.find((a) => a.code === updated.debitCode)
            const creditAcc = accountMaster.find((a) => a.code === updated.creditCode)
            // PL売上/仕入の判定
            let category: 'sales' | 'purchase' | null = null
            if (creditAcc && isPL(creditAcc.bsPl) && creditAcc.normalBalance === '貸方') {
              category = 'sales'
            } else if (debitAcc && isPL(debitAcc.bsPl) && debitAcc.normalBalance === '借方') {
              category = 'purchase'
            }
            const nameTax = getDefaultTaxCodeByName(
              category === 'sales' ? (creditAcc?.name || creditAcc?.shortName || '') : (debitAcc?.name || debitAcc?.shortName || ''),
              category,
            )
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
    [accountMaster],
  )

  const handleUpload = useCallback(
    async (config: UploadConfig) => {
      setIsLoading(true)
      setLoadingProgress(10)
      setError(null)
      setUploadConfig(config)
      uploadConfigRef.current = config

      try {
        setLoadingProgress(15)
        setParseElapsed(null)
        const startTime = Date.now()
        const progressTimer = setInterval(() => {
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
          const isCsvOrExcel = fName.endsWith('.csv') || fName.endsWith('.xlsx') || fName.endsWith('.xls')

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
          if (fName.endsWith('.xlsx') || fName.endsWith('.xls') || fName.endsWith('.csv')) {
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

          // レシート・領収書処理: まずテキストPDF解析を試行（無料・高速）
          const { parseReceiptTextPdf } = await import('@/lib/bank-statement/receipt-parser')
          const textResult = await parseReceiptTextPdf(config.file, (receipt, pageIdx, totalPages) => {
            setLoadingProgress(Math.round(15 + 80 * (pageIdx + 1) / totalPages))
          })

          if (textResult.isTextPdf && textResult.receipts.length > 0) {
            // テキストPDF: スクリプトのみで解析完了
            clearInterval(progressTimer)
            setLoadingProgress(100)
            const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1)
            setParseElapsed(`${elapsedSec}秒`)
            setPages((prev) => [...prev, ...textResult.pages])
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
            })), config.creditCode!, config.creditName!, config.creditSubCode, config.creditSubName)
            setJournalEntries((prev) => [...prev, ...entries])
            setInfo(`${textResult.receipts.length}件のレシートをテキスト解析しました（${elapsedSec}秒）`)
            setIsLoading(false)
            setLoadingProgress(0)
            return
          }

          // 画像PDF: Gemini APIにフォールバック
          const { renderPdfPageToImage, getPdfPageCount } = await import('@/lib/bank-statement/pdf-text-parser')
          const pageCount = await getPdfPageCount(config.file)
          const imageDataUrls: string[] = []
          for (let i = 0; i < pageCount; i++) {
            imageDataUrls.push(await renderPdfPageToImage(config.file, i + 1, 2))
          }

          const data = await receiptOcr(imageDataUrls, geminiModel)
          clearInterval(progressTimer)
          setLoadingProgress(100)

          const receipts = data.receipts || []
          if (receipts.length === 0) throw new Error('レシートデータを抽出できませんでした')

          const statementPages = imageDataUrls.map((url, i) => ({
            pageIndex: i, transactions: [],
            openingBalance: 0, closingBalance: 0, isBalanceValid: true, balanceDifference: 0,
            imageDataUrl: url,
          }))
          setPages((prev) => [...prev, ...statementPages])

          const { receiptToEntries } = await import('@/lib/bank-statement/receipt-mapper')
          const entries = receiptToEntries(receipts, config.creditCode!, config.creditName!, config.creditSubCode, config.creditSubName)
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
          if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') {
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

      // 列マッピングを科目CD別に学習保存（Excel/CSV/PDF表 すべて対象）
      if (uploadConfig.accountCode) {
        try {
          const cid = localStorage.getItem('bank-statement-selected-client') || ''
          const key = `bs-excel-mapping-${cid}-${uploadConfig.accountCode}`
          localStorage.setItem(key, JSON.stringify(mapping))
        } catch { /* ignore */ }
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

        const { receiptToEntries } = await import('@/lib/bank-statement/receipt-mapper')
        const entries = receiptToEntries(
          receipts,
          uploadConfig.creditCode!,
          uploadConfig.creditName!,
          uploadConfig.creditSubCode,
          uploadConfig.creditSubName,
          true, // 列マッピング経由は常にインボイス登録事業者扱い（経過措置※を付けない）
        )

        // 左側プレビュー用に仮想ページを生成
        const previewPage: StatementPage = {
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
        if (entry && entry.transactionId) {
          const page = pages.find((p) =>
            p.transactions.some((t) => t.id === entry.transactionId),
          )
          if (page && page.pageIndex !== currentPageIndex) {
            setCurrentPageIndex(page.pageIndex)
          }
        }
      }
    },
    [journalEntries, pages, currentPageIndex],
  )

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
      const dates = completed.map((e) => e.date).filter((d) => d && d.length === 8)
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
                label: fbUploading ? 'アップロード中…' : '全データをFirebaseへアップロード（この端末→共有）',
                icon: '☁️',
                title: '全データを持つPC（事務所PC）から1回実行すると、他のPCにも科目マスタ・パターン等が反映されます',
                disabled: fbUploading,
                onClick: handleFirebaseFullUpload,
              },
              { divider: true },
              {
                label: '科目マスタ',
                render: (
                  <div className="-mx-1">
                    <AccountMasterUploader
                      embedded
                      accountMaster={accountMaster}
                      subAccountMaster={subAccountMaster}
                      accountTaxMaster={accountTaxMaster}
                      onAccountUpdate={handleAccountMasterUpdate}
                      onSubAccountUpdate={handleSubAccountMasterUpdate}
                      onAccountTaxUpdate={(items) => {
                        setAccountTaxMaster(items)
                        // マスタ更新時、既存仕訳は空欄のときだけ補完（既に設定済みの値は尊重）
                        setJournalEntries((prev) => prev.map((e) => {
                          const debitTax = getDefaultTaxCode(items, e.debitCode)
                          const creditTax = getDefaultTaxCode(items, e.creditCode)
                          const tax = debitTax || creditTax
                          if (!tax) return e
                          const updated = { ...e }
                          let changed = false
                          if (!updated.debitTaxCode || updated.debitTaxCode === '0') {
                            updated.debitTaxCode = tax.taxCode
                            updated.debitTaxType = tax.taxName
                            changed = true
                          }
                          if (!updated.debitTaxRate && tax.taxRate) {
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
                      type="password"
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
                onExported={() => { if (selectedClient) recordCsvExport(selectedClient.id) }} />
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
              onFileDelete={() => { setPages([]); setJournalEntries([]); setUploadConfig(null); setError(null); setInfo('アップロードファイルを削除しました') }}
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
            try {
              const cid = localStorage.getItem('bank-statement-selected-client') || ''
              const key = `bs-excel-mapping-${cid}-${uploadConfig.accountCode}`
              const saved = localStorage.getItem(key)
              return saved ? JSON.parse(saved) : undefined
            } catch { return undefined }
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
        onGenerate={async (data, bankCode, bankName, deductAccounts, bankSubCode, bankSubName) => {
          const { payrollToEntries } = await import('@/lib/bank-statement/payroll-mapper')
          const entries = payrollToEntries(data, bankCode, bankName, deductAccounts, bankSubCode, bankSubName, accountTaxMaster)
          setJournalEntries((prev) => [...prev, ...entries])
          setInfo(`${data.period} 賃金台帳から${entries.length}件の仕訳を生成しました（${data.employees.length}名）`)
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
