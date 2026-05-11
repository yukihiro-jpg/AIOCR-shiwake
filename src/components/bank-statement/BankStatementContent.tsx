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
import CsvExportButton from '@/components/bank-statement/CsvExportButton'
import { appendTempEntries, getTempEntryCount, clearTempEntries, getTempEntries } from '@/lib/bank-statement/temp-store'
import { generateQuestionList, downloadQuestionExcel } from '@/lib/bank-statement/question-list'
import QuestionListDialog from '@/components/bank-statement/QuestionListDialog'
import TempDataDialog from '@/components/bank-statement/TempDataDialog'
import DriveSyncButton from '@/components/bank-statement/DriveSyncButton'
import { uploadClientToDrive, downloadClientFromDrive, getDriveConnected } from '@/lib/bank-statement/drive-sync'
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
import { mapTransactionsToJournalEntries } from '@/lib/bank-statement/journal-mapper'
import { getPatterns } from '@/lib/bank-statement/pattern-store'
import { loadAccountMaster, loadSubAccountMaster, loadAccountTaxMaster, getDefaultTaxCode } from '@/lib/bank-statement/account-master'
import { getDefaultTaxCodeByName, isPL } from '@/lib/bank-statement/tax-codes'
import type { AccountTaxItem } from '@/lib/bank-statement/types'
import ClientSelector from '@/components/bank-statement/ClientSelector'
import type { Client } from '@/lib/bank-statement/client-store'
import { getSelectedClientId, setSelectedClientId } from '@/lib/bank-statement/client-store'

export default function BankStatementContent() {
  // 顧問先選択
  const [selectedClient, setSelectedClient] = useState<Client | null>(null)
  const [showClientSelector, setShowClientSelector] = useState(true)
  // 顧問先選択直後のDrive取込確認バナー
  const [showDriveImportBanner, setShowDriveImportBanner] = useState(false)
  const [driveImporting, setDriveImporting] = useState(false)
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
  const [showQuestionList, setShowQuestionList] = useState(false)
  const [showTempData, setShowTempData] = useState(false)
  const [tempCount, setTempCount] = useState(() => getTempEntryCount())
  const [selectedEntryIds, setSelectedEntryIds] = useState<Set<string>>(new Set())
  const [processingStatusVersion, setProcessingStatusVersion] = useState(0)

  // 顧問先選択ハンドラ
  const handleClientSelect = useCallback(async (client: Client) => {
    setSelectedClient(client)
    setShowClientSelector(false)
    setAccountMaster(loadAccountMaster())
    setSubAccountMaster(loadSubAccountMaster())
    setAccountTaxMaster(loadAccountTaxMaster())
    setPages([])
    setJournalEntries([])
    // Drive連携中なら取込確認バナーを表示
    const driveOn = await getDriveConnected()
    if (driveOn) setShowDriveImportBanner(true)
  }, [])

  const handleDriveImport = useCallback(async () => {
    if (!selectedClient) return
    setDriveImporting(true)
    try {
      await downloadClientFromDrive(selectedClient.id, selectedClient.name)
      // 読込後にマスタを再ロード
      setAccountMaster(loadAccountMaster())
      setSubAccountMaster(loadSubAccountMaster())
      setAccountTaxMaster(loadAccountTaxMaster())
      setInfo('Driveから最新データを取り込みました')
    } catch (e) {
      setError(`Drive読込エラー: ${e instanceof Error ? e.message : 'unknown'}`)
    }
    setDriveImporting(false)
    setShowDriveImportBanner(false)
  }, [selectedClient])

  const handleExitApp = useCallback(async () => {
    if (!selectedClient) {
      window.close()
      return
    }
    if (!window.confirm('アプリを終了します。現在の顧問先データを Drive に保存してからブラウザを閉じます。よろしいですか？')) return
    setExitingApp(true)
    try {
      await uploadClientToDrive(selectedClient.id, selectedClient.name)
    } catch (e) {
      const ok = window.confirm(`Drive 保存でエラーが発生しました: ${e instanceof Error ? e.message : 'unknown'}\n\nこのまま終了しますか？`)
      if (!ok) { setExitingApp(false); return }
    }
    window.close()
    // window.close() が効かない環境用の代替メッセージ
    setTimeout(() => {
      setExitingApp(false)
      alert('保存が完了しました。このブラウザタブを閉じてください。')
    }, 500)
  }, [selectedClient])

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
        if (!updated.debitTaxCode || updated.debitTaxCode === '0') {
          // 1. 科目別消費税マスタから検索
          const debitTax = getDefaultTaxCode(taxMaster, updated.debitCode)
          const creditTax = getDefaultTaxCode(taxMaster, updated.creditCode)
          const tax = debitTax || creditTax
          if (tax) {
            updated.debitTaxCode = tax.taxCode
            updated.debitTaxType = tax.taxName
          } else {
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
      const filtered = entriesWithTax.filter((e) => {
        if (!e.date) return true
        if (from && e.date < from) return false
        if (to && e.date > to) return false
        return true
      })
      setJournalEntries((prev) => [...prev, ...filtered])
    },
    [accountMaster],
  )

  const handleUpload = useCallback(
    async (config: UploadConfig) => {
      setIsLoading(true)
      setLoadingProgress(10)
      setError(null)
      setUploadConfig(config)

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
              throw new Error('クレジットカード CSV の解析に失敗しました。ヘッダ行（ご利用日/ご利用内容/金額）が見つかりません。')
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

          const response = await fetch('/api/bank-statement/credit-card', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ images: imageDataUrls }),
          })

          if (!response.ok) {
            const data = await response.json().catch(() => ({}))
            throw new Error(data.error || 'クレジットカード明細の解析に失敗しました')
          }

          const ccData = await response.json()
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
            })), config.creditCode!, config.creditName!)
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

          const response = await fetch('/api/bank-statement/receipt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ images: imageDataUrls }),
          })
          clearInterval(progressTimer)
          setLoadingProgress(100)

          if (!response.ok) {
            const data = await response.json().catch(() => ({}))
            throw new Error(data.error || 'レシート解析に失敗しました')
          }

          const data = await response.json()
          const receipts = data.receipts || []
          if (receipts.length === 0) throw new Error('レシートデータを抽出できませんでした')

          const statementPages = imageDataUrls.map((url, i) => ({
            pageIndex: i, transactions: [],
            openingBalance: 0, closingBalance: 0, isBalanceValid: true, balanceDifference: 0,
            imageDataUrl: url,
          }))
          setPages((prev) => [...prev, ...statementPages])

          const { receiptToEntries } = await import('@/lib/bank-statement/receipt-mapper')
          const entries = receiptToEntries(receipts, config.creditCode!, config.creditName!)
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
          // 請求書処理
          const { renderPdfPageToImage, getPdfPageCount } = await import('@/lib/bank-statement/pdf-text-parser')
          const pageCount = await getPdfPageCount(config.file)
          const imageDataUrls: string[] = []
          for (let i = 0; i < pageCount; i++) {
            imageDataUrls.push(await renderPdfPageToImage(config.file, i + 1, 2))
          }

          const invoiceType = config.documentType === 'purchase-invoice' ? 'purchase' : 'sales'
          const response = await fetch('/api/bank-statement/invoice', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ images: imageDataUrls, type: invoiceType }),
          })
          clearInterval(progressTimer)
          setLoadingProgress(100)

          if (!response.ok) {
            const data = await response.json().catch(() => ({}))
            throw new Error(data.error || '請求書解析に失敗しました')
          }

          const data = await response.json()
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
          const { salesInvoiceToEntries, purchaseInvoiceToEntries } = await import('@/lib/bank-statement/invoice-mapper')
          const entries = config.documentType === 'sales-invoice'
            ? salesInvoiceToEntries(invoices, config.debitCode!, config.debitName!, config.creditCode!, config.creditName!)
            : purchaseInvoiceToEntries(invoices, config.debitCode!, config.debitName!, config.creditCode!, config.creditName!)
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
    (mapping: ColumnMapping) => {
      if (!rawPages || !pendingSourceType || !uploadConfig) return

      setShowColumnMapping(false)
      setIsLoading(true)

      try {
        const result: ParseResult = applyColumnMapping(rawPages, mapping, pendingSourceType)
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
    [rawPages, pendingSourceType, uploadConfig, applyParseResultFn, pendingImageUrls],
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

    // 処理状況を更新: 現在アップロードされた通帳の科目コード単位で最終取引日を記録
    if (uploadConfig?.accountCode) {
      const dates = completed.map((e) => e.date).filter((d) => d && d.length === 8)
      if (dates.length > 0) {
        updateProcessingStatus(
          uploadConfig.accountCode,
          uploadConfig.accountName || '',
          dates,
          completed.length,
        )
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
  }, [journalEntries, selectedEntryIds, accountMaster, uploadConfig])

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
    showClientSelector ? (
      <ClientSelector onSelect={handleClientSelect} />
    ) : (
    <div className="h-screen flex flex-col bg-gray-100 bank-statement-app">
      {/* ヘッダー */}
      <header className="bg-gray-800 px-4 py-2 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <h1 className="text-base font-bold text-white">会計大将インポートデータ変換</h1>
          {selectedClient && (
            <span className="text-sm text-blue-300 font-medium">{selectedClient.name}</span>
          )}
          <button onClick={handleBackToClientList}
            className="text-xs text-gray-400 hover:text-white hover:underline">
            顧問先一覧
          </button>
          <UploadDialog
            accountMaster={accountMaster}
            subAccountMaster={subAccountMaster}
            onUpload={handleUpload}
            isLoading={isLoading}
            lastPeriodFrom={lastPeriodFrom}
            lastPeriodTo={lastPeriodTo}
          />
        </div>
        <div className="flex items-center gap-2">
          <DriveSyncButton clientId={selectedClient?.id || null} clientName={selectedClient?.name || null} />
          <AccountMasterUploader
            accountMaster={accountMaster}
            subAccountMaster={subAccountMaster}
            accountTaxMaster={accountTaxMaster}
            onAccountUpdate={handleAccountMasterUpdate}
            onSubAccountUpdate={handleSubAccountMasterUpdate}
            onAccountTaxUpdate={setAccountTaxMaster}
          />
          <button onClick={() => setShowPatternList(true)}
            className="px-3 py-1.5 text-xs font-medium bg-white/10 hover:bg-white/20 text-white rounded border border-white/20">
            パターン一覧
          </button>
          <button onClick={() => setShowFixedJournal(true)}
            className="px-3 py-1.5 text-xs font-medium bg-white/10 hover:bg-white/20 text-white rounded border border-white/20">
            定型仕訳
          </button>
          <button onClick={() => setShowInvoiceRegistry(true)}
            className="px-3 py-1.5 text-xs font-medium bg-white/10 hover:bg-white/20 text-white rounded border border-white/20">
            インボイス登録簿
          </button>
          {journalEntries.length > 0 && (
            <>
              <button onClick={handleTempSave}
                className="px-3 py-1.5 text-xs font-medium bg-amber-500 hover:bg-amber-600 text-white rounded">
                {selectedEntryIds.size > 0 ? `選択分を一時保存 (${selectedEntryIds.size}件)` : '一時保存'}
              </button>
              <CsvExportButton entries={journalEntries}
                dateFrom={dateFrom} dateTo={dateTo}
                onDateFromChange={setDateFrom} onDateToChange={setDateTo} />
            </>
          )}
          {tempCount > 0 && (
            <div className="flex items-center gap-1">
              <button onClick={() => setShowTempData(true)}
                className="px-3 py-1.5 text-xs font-medium bg-gray-500 hover:bg-gray-600 text-white rounded">
                一時保存確認 ({tempCount}件)
              </button>
              <button onClick={handleTempExport}
                className="px-3 py-1.5 text-xs font-medium bg-green-600 hover:bg-green-700 text-white rounded">
                一括CSV出力
              </button>
              <button onClick={handleQuestionList}
                className="px-3 py-1.5 text-xs font-medium bg-purple-600 hover:bg-purple-700 text-white rounded">
                仮払金質問リスト
              </button>
              <button onClick={handleTempClear}
                className="px-2 py-1.5 text-xs text-gray-400 hover:text-red-400" title="一時保存をクリア">
                &times;
              </button>
            </div>
          )}
          {/* スペースを空けてアプリ終了ボタン */}
          {selectedClient && (
            <button onClick={handleExitApp} disabled={exitingApp}
              title="Drive保存してブラウザを閉じる"
              className="ml-4 px-3 py-1.5 text-xs font-medium bg-red-600 hover:bg-red-700 text-white rounded disabled:opacity-50">
              {exitingApp ? '保存中...' : 'アプリ終了'}
            </button>
          )}
        </div>
      </header>

      {/* 顧問先選択直後の Drive 取込確認バナー */}
      {showDriveImportBanner && selectedClient && (
        <div className="bg-blue-50 border-b border-blue-200 px-4 py-2 flex items-center justify-between">
          <span className="text-sm text-blue-800">
            顧問先「{selectedClient.name}」のDrive保存データを取り込みますか？
            <span className="text-xs text-gray-500 ml-2">（科目マスタ・パターン学習等が最新になります）</span>
          </span>
          <div className="flex items-center gap-2">
            <button onClick={handleDriveImport} disabled={driveImporting}
              className="px-3 py-1 text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white rounded disabled:opacity-50">
              {driveImporting ? '取込中...' : '取り込む'}
            </button>
            <button onClick={() => setShowDriveImportBanner(false)} disabled={driveImporting}
              className="px-3 py-1 text-xs font-medium bg-white border border-gray-300 text-gray-700 rounded hover:bg-gray-100">
              スキップ
            </button>
          </div>
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
      ) : journalEntries.length > 0 ? (
        // ページ画像なし（CSV/Excel等）の場合は仕訳テーブルのみ全幅表示
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
      ) : (
        <div className="flex-1 overflow-auto p-6">
          <div className="text-center text-gray-500 mb-4">
            <p className="text-lg mb-2">通帳PDFまたはExcelファイルをアップロードしてください</p>
            <p className="text-sm">
              ヘッダーの「アップロード」ボタンからファイルを選択できます
            </p>
          </div>
          <ProcessingStatusTable clientId={selectedClient?.id || null} refreshKey={processingStatusVersion} accountMaster={accountMaster} />
        </div>
      )}

      {/* 列マッピングダイアログ */}
      {showColumnMapping && rawPages && (
        <ColumnMappingDialog
          rawPages={rawPages}
          onConfirm={handleColumnMappingConfirm}
          onCancel={() => {
            setShowColumnMapping(false)
            setRawPages(null)
            setPendingSourceType(null)
          }}
        />
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
    )
  )
}
