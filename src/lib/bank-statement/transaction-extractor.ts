import type {
  BankTransaction,
  StatementPage,
  ParseResult,
  RawTableRow,
  ColumnMapping,
} from './types'
import { parsePdfText, renderPdfPageToImage, getPdfPageCount } from './pdf-text-parser'
import { parseExcel } from './excel-parser'
import { updatePageBalances } from './balance-validator'
import { getTemplatePromptAddition, learnBankTemplate } from './bank-template'
import { geminiUpload, ocrPdf, ocrImagesByFileUri } from './gemini-client'

function getGeminiModel(): string {
  if (typeof window === 'undefined') return ''
  return localStorage.getItem('bs-gemini-model') || ''
}

interface OcrPdfPage {
  pageIndex: number
  transactions: {
    date: string
    description: string
    deposit: number | null
    withdrawal: number | null
    balance: number
  }[]
}

interface GeminiFileRef {
  name: string
  uri: string
  mimeType: string
  state: string
}

/**
 * Gemini File API へファイル(Blob)をアップロードし、fileUri を取得する
 * 大きなPDFをリクエスト本体に含めずに済むため、ボディサイズ制限とチャンク分割の遅さを回避できる
 */
async function uploadToGeminiFileApi(blob: Blob, displayName: string, mimeType?: string): Promise<GeminiFileRef> {
  return await geminiUpload(blob, displayName, mimeType)
}

function dataUrlToBlob(dataUrl: string): { blob: Blob; mimeType: string } {
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
  if (!m) throw new Error('画像形式が不正です (data URL ではありません)')
  const mimeType = m[1]
  const bin = atob(m[2])
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return { blob: new Blob([bytes], { type: mimeType }), mimeType }
}

// items を concurrency 本のワーカーで処理（ローリング並列：終わったワーカーから次を取る）
async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  async function loop() {
    while (true) {
      const idx = next++
      if (idx >= items.length) return
      results[idx] = await worker(items[idx], idx)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => loop()),
  )
  return results
}

// 全ページ画像レンダリングを並列実行（OCR と並走させるためのヘルパー）
async function renderAllPagesInParallel(
  file: File,
  pageCount: number,
  scale: number = 2,
  concurrency: number = 4,
): Promise<string[]> {
  const indices = Array.from({ length: pageCount }, (_, i) => i)
  const start = Date.now()
  const urls = await runWithConcurrency(indices, concurrency, async (i) => {
    return renderPdfPageToImage(file, i + 1, scale)
  })
  console.log(`[renderAllPagesInParallel] ${pageCount}ページを ${((Date.now() - start) / 1000).toFixed(1)}s で完了 (並列=${concurrency})`)
  return urls
}

/**
 * Gemini File API を使ってPDFを処理: 先にアップロードして fileUri を取得し、
 * ページ範囲ごとの並列リクエストでは fileUri のみを送信する
 */
async function processPdfInParallel(
  file: File,
  chunkSize: number = 5,
  concurrency: number = 3,
): Promise<{ totalCount: number; pages: OcrPdfPage[] }> {
  const totalPages = await getPdfPageCount(file)
  console.log(`[processPdfInParallel] 開始: file=${file.name}, size=${file.size}, totalPages=${totalPages}, chunkSize=${chunkSize}, concurrency=${concurrency}`)

  // 先にPDFを Gemini File API へアップロード（1回だけ）
  const fileRef = await uploadToGeminiFileApi(file, file.name || 'statement.pdf', 'application/pdf')
  console.log(`[processPdfInParallel] uploaded fileUri=${fileRef.uri}`)

  // 小さいPDFはそのまま1リクエスト
  if (totalPages <= chunkSize) {
    try {
      const data = await ocrPdf({ fileUri: fileRef.uri, mimeType: fileRef.mimeType, geminiModel: getGeminiModel() })
      return { totalCount: data.totalCount || 0, pages: data.pages || [] }
    } catch (e) {
      console.error('[processPdfInParallel] 単一リクエスト失敗:', e)
    }
    return { totalCount: 0, pages: [] }
  }

  // ページ範囲リストを作成（同じファイル参照を使い、プロンプトで範囲指定）
  const ranges: { startPage: number; endPage: number }[] = []
  for (let start = 0; start < totalPages; start += chunkSize) {
    ranges.push({ startPage: start, endPage: Math.min(start + chunkSize, totalPages) })
  }

  console.log(`PDF: ${ranges.length}リクエスト (chunkSize=${chunkSize}, concurrency=${concurrency})`)
  const startTime = Date.now()

  async function fetchRangeWithRetry(range: { startPage: number; endPage: number }) {
    const maxAttempts = 3
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const data = await ocrPdf({
          fileUri: fileRef.uri, mimeType: fileRef.mimeType,
          startPage: range.startPage, endPage: range.endPage, geminiModel: getGeminiModel(),
        })
        if ((data.totalCount || 0) > 0 || attempt === maxAttempts) {
          return data
        }
        console.warn(`Pages ${range.startPage}-${range.endPage - 1} returned 0 transactions, retrying (${attempt}/${maxAttempts})`)
      } catch (e) {
        console.warn(`Pages ${range.startPage}-${range.endPage - 1} error (${attempt}/${maxAttempts}):`, e)
      }
      if (attempt < maxAttempts) {
        await new Promise((res) => setTimeout(res, 2000 * Math.pow(2, attempt - 1)))
      }
    }
    return { totalCount: 0, pages: [] }
  }

  // ローリング並列：終わったワーカーから次の range を取る（テールレイテンシを最小化）
  const allResults = await runWithConcurrency(ranges, concurrency, fetchRangeWithRetry)

  const mergedMap = new Map<number, OcrPdfPage>()
  let totalCount = 0
  for (const data of allResults) {
    totalCount += data.totalCount || 0
    for (const pg of data.pages || []) {
      const existing = mergedMap.get(pg.pageIndex)
      if (existing) existing.transactions.push(...pg.transactions)
      else mergedMap.set(pg.pageIndex, { pageIndex: pg.pageIndex, transactions: pg.transactions })
    }
  }
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`All ${ranges.length} page ranges completed in ${elapsed}s, total=${totalCount} transactions`)

  const pages = Array.from(mergedMap.values()).sort((a, b) => a.pageIndex - b.pageIndex)
  return { totalCount, pages }
}

let idCounter = 0
function generateId(): string {
  return `tx-${Date.now()}-${++idCounter}`
}

/**
 * ヘッダキーワードのX座標から直接列を検出する（範囲ベース）
 * realign不要で、ヘッダ（左寄せ）とデータ（右寄せ）のずれを正しく処理できる
 */
function detectColumnsByKeywordPositions(rows: RawTableRow[]): ColumnMapping | null {
  // ヘッダキーワードが最も多い行を探す（本文中の「内容」等の誤検出を防ぐ）
  let bestRow: RawTableRow | null = null
  let bestCount = 0
  for (const row of rows) {
    if (!row.cellPositions || row.cellPositions.length < 3) continue
    if (row.cells.some((c) => isDateCell(c))) continue
    let count = 0
    for (const cell of row.cells) {
      const cl = (cell || '').replace(/[\s　]/g, '')
      if (!cl) continue
      if (HEADER_DATE.some((k) => cl.includes(k))) count++
      else if (HEADER_WITHDRAW.some((k) => cl.includes(k))) count++
      else if (HEADER_DEPOSIT.some((k) => cl.includes(k))) count++
      else if (HEADER_DESC.some((k) => cl.includes(k))) count++
      else if (HEADER_BALANCE.some((k) => cl.includes(k))) count++
      else if (HEADER_SIGNED.some((k) => cl.includes(k))) count++
    }
    if (count > bestCount) { bestCount = count; bestRow = row }
  }
  if (!bestRow || bestCount < 2) return null

  let dateX = -1, descX = -1, depositX = -1, withdrawX = -1, balanceX = -1, signedX = -1
  // メインヘッダ行からキーワード位置を取得
  for (let i = 0; i < bestRow.cells.length; i++) {
    const cl = (bestRow.cells[i] || '').replace(/[\s　]/g, '')
    if (!cl) continue
    const x = bestRow.cellPositions![i]
    if (dateX < 0 && matchHeaderKeyword(cl, HEADER_DATE)) dateX = x
    if (descX < 0 && matchHeaderKeyword(cl, HEADER_DESC)) descX = x
    if (withdrawX < 0 && matchHeaderKeyword(cl, HEADER_WITHDRAW)) withdrawX = x
    if (depositX < 0 && matchHeaderKeyword(cl, HEADER_DEPOSIT)) depositX = x
    if (balanceX < 0 && matchHeaderKeyword(cl, HEADER_BALANCE)) balanceX = x
    // 符号付き金額列（「金額」「取引金額」等）
    if (signedX < 0 && depositX < 0 && withdrawX < 0 && matchHeaderKeyword(cl, HEADER_SIGNED)) signedX = x
  }
  // 残高が別行にある場合、前後5行から探す
  if (balanceX < 0) {
    const bestIdx = rows.indexOf(bestRow)
    for (let ri = Math.max(0, bestIdx - 5); ri <= Math.min(rows.length - 1, bestIdx + 5); ri++) {
      const row = rows[ri]
      if (!row.cellPositions) continue
      for (let i = 0; i < row.cells.length; i++) {
        const cl = (row.cells[i] || '').replace(/[\s　]/g, '')
        if (balanceX < 0 && matchHeaderKeyword(cl, HEADER_BALANCE)) {
          balanceX = row.cellPositions[i]
        }
      }
    }
  }

  if (dateX < 0 || balanceX < 0 || (depositX < 0 && withdrawX < 0 && signedX < 0)) return null

  const cols: { type: string; x: number }[] = []
  if (dateX >= 0) cols.push({ type: 'date', x: dateX })
  if (descX >= 0) cols.push({ type: 'desc', x: descX })
  if (withdrawX >= 0) cols.push({ type: 'withdraw', x: withdrawX })
  if (depositX >= 0) cols.push({ type: 'deposit', x: depositX })
  if (signedX >= 0 && depositX < 0 && withdrawX < 0) cols.push({ type: 'signed', x: signedX })
  if (balanceX >= 0) cols.push({ type: 'balance', x: balanceX })
  cols.sort((a, b) => a.x - b.x)

  const xPositions = cols.map((c) => c.x)
  const signedIdx = cols.findIndex((c) => c.type === 'signed')

  return {
    dateColumn: cols.findIndex((c) => c.type === 'date'),
    descriptionColumn: cols.findIndex((c) => c.type === 'desc'),
    withdrawalColumn: signedIdx >= 0 ? signedIdx : cols.findIndex((c) => c.type === 'withdraw'),
    depositColumn: signedIdx >= 0 ? signedIdx : cols.findIndex((c) => c.type === 'deposit'),
    balanceColumn: cols.findIndex((c) => c.type === 'balance'),
    signedAmountColumn: signedIdx >= 0 ? signedIdx : undefined,
    columnXPositions: xPositions,
  }
}

/**
 * PDFテキスト抽出の空セルずれを解消する（フォールバック用）
 * ヘッダキーワードを含む全行のX座標を集めてクラスタリングし、
 * 列境界を確定してから各行を固定幅配列に再構築する
 */
function realignPdfRowsToColumns(allPages: RawTableRow[][]): void {
  const allRows = allPages.flat()
  const rowsWithPos = allRows.filter((r) => r.cellPositions && r.cellPositions.length > 0)
  if (rowsWithPos.length < 5) return

  const ALL_KEYWORDS = [...HEADER_DATE, ...HEADER_DESC, ...HEADER_DEPOSIT, ...HEADER_WITHDRAW, ...HEADER_BALANCE, ...HEADER_SIGNED, ...HEADER_DIRECTION]

  // ヘッダキーワードを含む行からX座標を収集（差引残高が別行でも拾える）
  const headerPositions: number[] = []
  for (const row of rowsWithPos) {
    if (row.cells.some((c) => isDateCell(c))) continue
    const hasKeyword = row.cells.some((c) => {
      const cl = (c || '').replace(/[\s　]/g, '')
      return cl && ALL_KEYWORDS.some((k) => cl.includes(k))
    })
    if (hasKeyword) {
      headerPositions.push(...row.cellPositions!)
    }
  }
  if (headerPositions.length < 3) return

  // クラスタリング（近い座標を同一列にまとめる）
  headerPositions.sort((a, b) => a - b)
  const THRESHOLD = 55
  const clusters: { sum: number; count: number }[] = [{ sum: headerPositions[0], count: 1 }]
  for (let i = 1; i < headerPositions.length; i++) {
    const last = clusters[clusters.length - 1]
    const center = last.sum / last.count
    if (headerPositions[i] - center < THRESHOLD) {
      last.sum += headerPositions[i]
      last.count++
    } else {
      clusters.push({ sum: headerPositions[i], count: 1 })
    }
  }
  const columnPositions = clusters.map((c) => c.sum / c.count)
  if (columnPositions.length < 3) return


  const numCols = columnPositions.length
  for (const page of allPages) {
    for (const row of page) {
      if (!row.cellPositions || row.cellPositions.length === 0) continue
      const newCells = new Array(numCols).fill('')
      for (let i = 0; i < row.cells.length; i++) {
        const x = row.cellPositions[i]
        let bestCol = 0
        let bestDist = Math.abs(columnPositions[0] - x)
        for (let c = 1; c < numCols; c++) {
          const dist = Math.abs(columnPositions[c] - x)
          if (dist < bestDist) { bestDist = dist; bestCol = c }
        }
        if (newCells[bestCol]) {
          newCells[bestCol] += ' ' + row.cells[i]
        } else {
          newCells[bestCol] = row.cells[i]
        }
      }
      row.cells = newCells
      row.cellPositions = undefined
    }
  }
}

// 日付パターン（和暦・西暦・年なし等）
const DATE_PATTERNS = [
  // R6.4.1, R06.04.01, H31.4.1
  /([RrHhSsTt]\d{1,2})[./年](\d{1,2})[./月](\d{1,2})日?/,
  // 令和6年4月1日, 平成31年4月1日
  /(令和|平成|昭和|大正)(\d{1,2})年(\d{1,2})月(\d{1,2})日?/,
  // 2024/4/1, 2024-04-01, 2024.4.1
  /(20\d{2})[/\-.](\d{1,2})[/\-.](\d{1,2})/,
  // 2025年12月1日, 2024年4月15日（西暦＋年月日）
  /(20\d{2})年(\d{1,2})月(\d{1,2})日?/,
  // 20240401, 20260101 (YYYYMMDD 8桁)
  /^(20|21)\d{6}$/,
  // 7.4.1, 6-12-25（和暦の年.月.日、元号なし）
  /^(\d{1,2})[./\-](\d{1,2})[./\-](\d{1,2})$/,
  // 4/1, 04/01（年なし）
  /^(\d{1,2})[/.](\d{1,2})$/,
  // 0401（4桁の月日）
  /^(\d{2})(\d{2})$/,
]

// 金額パターン
const AMOUNT_PATTERN = /^[¥￥]?\s*[\d,]+$/

function parseDate(text: string, defaultYear?: number): string | null {
  // スペースを除去して正規化（「2025年 4月 10日」→「2025年4月10日」）
  const cleaned = text.trim().replace(/\s+/g, '')

  // 和暦略称: R6.4.1
  const m1 = cleaned.match(
    /^([RrHhSsTt])(\d{1,2})[./年](\d{1,2})[./月](\d{1,2})日?$/,
  )
  if (m1) {
    const year = eraToWestern(m1[1].toUpperCase(), parseInt(m1[2]))
    if (year) return formatDate(year, parseInt(m1[3]), parseInt(m1[4]))
  }

  // 和暦正式: 令和6年4月1日
  const m2 = cleaned.match(
    /^(令和|平成|昭和|大正)(\d{1,2})年(\d{1,2})月(\d{1,2})日?$/,
  )
  if (m2) {
    const eraMap: Record<string, string> = {
      令和: 'R',
      平成: 'H',
      昭和: 'S',
      大正: 'T',
    }
    const year = eraToWestern(eraMap[m2[1]], parseInt(m2[2]))
    if (year) return formatDate(year, parseInt(m2[3]), parseInt(m2[4]))
  }

  // 西暦: 2024/4/1
  const m3 = cleaned.match(/^(20\d{2})[/\-.](\d{1,2})[/\-.](\d{1,2})$/)
  if (m3) {
    return formatDate(parseInt(m3[1]), parseInt(m3[2]), parseInt(m3[3]))
  }

  // 西暦＋年月日: 2025年12月1日
  const m3c = cleaned.match(/^(20\d{2})年(\d{1,2})月(\d{1,2})日?$/)
  if (m3c) {
    return formatDate(parseInt(m3c[1]), parseInt(m3c[2]), parseInt(m3c[3]))
  }

  // YYYYMMDD 8桁: 20260101, 20240401
  const m3b = cleaned.match(/^(20\d{2}|21\d{2})(\d{2})(\d{2})$/)
  if (m3b) {
    const y = parseInt(m3b[1])
    const mo = parseInt(m3b[2])
    const d = parseInt(m3b[3])
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return formatDate(y, mo, d)
  }

  // 和暦 年.月.日（元号なし）: 7.4.1 → 令和7年 → 2025-04-01
  const m3d = cleaned.match(/^(\d{1,2})[./\-](\d{1,2})[./\-](\d{1,2})$/)
  if (m3d) {
    const eraYear = parseInt(m3d[1])
    const month = parseInt(m3d[2])
    const day = parseInt(m3d[3])
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return formatDate(2018 + eraYear, month, day)
    }
  }

  // 月/日のみ
  const m4 = cleaned.match(/^(\d{1,2})[/.](\d{1,2})$/)
  if (m4) {
    const year = defaultYear || new Date().getFullYear()
    return formatDate(year, parseInt(m4[1]), parseInt(m4[2]))
  }

  // 4桁月日 0401
  const m5 = cleaned.match(/^(\d{2})(\d{2})$/)
  if (m5) {
    const month = parseInt(m5[1])
    const day = parseInt(m5[2])
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const year = defaultYear || new Date().getFullYear()
      return formatDate(year, month, day)
    }
  }

  return null
}

function eraToWestern(era: string, year: number): number | null {
  const bases: Record<string, number> = { R: 2018, H: 1988, S: 1925, T: 1911 }
  const base = bases[era]
  return base ? base + year : null
}

// 全角数字→半角
function zenToHan(s: string): string {
  return (s || '').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
}

/** 年セル単独の解釈（西暦4桁・和暦元号つき・和暦数字のみ に対応）。西暦の年を返す */
function parseYearCell(text: string): number | null {
  const t = zenToHan(text).trim()
  if (!t) return null
  // 元号（正式名）: 令和7 / 平成30
  let m = t.match(/(令和|平成|昭和|大正)\s*(\d{1,2})/)
  if (m) {
    const map: Record<string, string> = { 令和: 'R', 平成: 'H', 昭和: 'S', 大正: 'T' }
    return eraToWestern(map[m[1]], parseInt(m[2], 10))
  }
  // 元号（略記）: R7 / H30 / R.7
  m = t.match(/^([RrHhSsTt])\.?\s*(\d{1,2})/)
  if (m) return eraToWestern(m[1].toUpperCase(), parseInt(m[2], 10))
  // 数字のみ
  const digits = t.replace(/[^\d]/g, '')
  if (!digits) return null
  const n = parseInt(digits, 10)
  if (n >= 1868) return n // 西暦（4桁）
  if (n >= 1 && n <= 99) return 2018 + n // 和暦（元号省略時は令和として扱う）
  return null
}

/** 月・日セル単独を数値化（範囲チェック付き） */
function parseIntInRange(text: string, min: number, max: number): number | null {
  const digits = zenToHan(text).replace(/[^\d]/g, '')
  if (!digits) return null
  const n = parseInt(digits, 10)
  return n >= min && n <= max ? n : null
}

function formatDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function parseAmount(text: string): number | null {
  let cleaned = text.replace(/[¥￥,、\s]/g, '').replace(/▲|△|-/g, '-')
  // 括弧表記 (1,234) を負数として処理（会計のマイナス表記）
  if (/^\([\d]+\)$/.test(cleaned)) cleaned = cleaned.slice(1, -1)
  if (!cleaned || cleaned === '-' || cleaned === '*') return null
  const num = parseInt(cleaned, 10)
  return isNaN(num) ? null : Math.abs(num)
}

// 符号付き金額を取り出す（正=入金, 負=出金の単一列向け）
function parseSignedAmount(text: string): number | null {
  // ▲△△▼( )はすべてマイナスとして扱う
  let cleaned = text.replace(/[¥￥,、\s\u3000]/g, '')
  // カッコ表記 (1,000) を負数として扱う
  if (/^\(.+\)$/.test(cleaned)) cleaned = '-' + cleaned.slice(1, -1)
  cleaned = cleaned.replace(/[▲△]/g, '-')
  if (!cleaned || cleaned === '-' || cleaned === '*') return null
  const num = parseInt(cleaned, 10)
  return isNaN(num) ? null : num
}

function isDateCell(text: string): boolean {
  const normalized = text.trim().replace(/\s+/g, '')
  return DATE_PATTERNS.some((p) => p.test(normalized))
}

function isAmountCell(text: string): boolean {
  const cleaned = text.replace(/[¥￥,、\s▲△\-]/g, '')
  return /^\d+$/.test(cleaned) && cleaned.length > 0
}

// ヘッダー行で使われる列名キーワード
const HEADER_DATE = ['日付', '年月日', '取引日', '計算日']
const HEADER_DESC = ['摘要', 'お取引内容', '取引内容', '内容', '記事', '備考']
const HEADER_DEPOSIT = ['入金', '預入', '預り', 'お預入れ', 'お預入', '入金金額', '入金額', '預入金額', 'ご入金額', 'ご入金']
const HEADER_WITHDRAW = ['出金', '引出', '払戻', 'お引出', 'お支払い', '出金金額', '出金額', '引出金額', '支払金額', 'お支払額', '支払額', 'お支払']
const HEADER_BALANCE = ['残高', '差引残高', '残額', 'お預り残高']
// 入出金が1列で符号付の場合の列名
const HEADER_SIGNED = ['入出金', '出入金', '入出金額', '取引金額', 'お取引金額', '金額']
// 受払区分列（受入=入金、払出=出金で方向を示す）
const HEADER_DIRECTION = ['受払区分', '受払', '入出区分']

function matchHeaderKeyword(cell: string, keywords: string[]): boolean {
  // 全角/半角スペース・改行等を除去して比較（「残　高（円）」等の表記ゆれに対応）
  const c = cell.replace(/[\s\u3000]/g, '')
  if (!c) return false
  return keywords.some((k) => {
    const kn = k.replace(/[\s\u3000]/g, '')
    return c === kn || c.includes(kn)
  })
}

/**
 * ヘッダー行からマッピングを検出する（行内に日付セルがなく、
 * 「入金/出金/残高」等のキーワードが揃っている行）
 */
function detectMappingFromHeaderRow(rows: RawTableRow[]): ColumnMapping | null {
  for (const row of rows) {
    if (row.cells.some((c) => isDateCell(c))) continue
    let dateCol = -1
    let descCol = -1
    let depositCol = -1
    let withdrawCol = -1
    let balanceCol = -1
    let signedCol = -1

    // Pass1: 「入出金/出入金」列を最優先で確定（単位カッコ除去後の完全一致のみ）
    // ※'入出金内容' は '入出金' を含むが、ここでは完全一致のみ合格させて誤爆を防ぐ
    for (let i = 0; i < row.cells.length; i++) {
      const raw = row.cells[i] || ''
      const stripped = raw
        .replace(/[\s\u3000]/g, '')
        .replace(/[（\(][^）\)]*[）\)]/g, '') // (円) 等を除去
      if (signedCol < 0 && ['入出金', '出入金', '入出金額', '出入金額'].includes(stripped)) {
        signedCol = i
      }
    }

    // Pass2: 日付・摘要を先に確定
    // ('入出金内容' を摘要として捕捉し、後段で '出金' に誤マッチしないようにする)
    for (let i = 0; i < row.cells.length; i++) {
      if (i === signedCol) continue
      const cell = row.cells[i]
      if (!cell) continue
      if (dateCol < 0 && matchHeaderKeyword(cell, HEADER_DATE)) { dateCol = i; continue }
      if (descCol < 0 && matchHeaderKeyword(cell, HEADER_DESC)) { descCol = i; continue }
    }

    // Pass3: 残りのセルを金額系 + 受払区分に分類
    let directionCol = -1
    for (let i = 0; i < row.cells.length; i++) {
      if (i === signedCol || i === dateCol || i === descCol) continue
      const cell = row.cells[i]
      if (!cell) continue
      if (depositCol < 0 && matchHeaderKeyword(cell, HEADER_DEPOSIT)) { depositCol = i; continue }
      if (withdrawCol < 0 && matchHeaderKeyword(cell, HEADER_WITHDRAW)) { withdrawCol = i; continue }
      if (balanceCol < 0 && matchHeaderKeyword(cell, HEADER_BALANCE)) { balanceCol = i; continue }
      if (directionCol < 0 && matchHeaderKeyword(cell, HEADER_DIRECTION)) { directionCol = i; continue }
      if (signedCol < 0 && matchHeaderKeyword(cell, HEADER_SIGNED)) { signedCol = i; continue }
    }
    // 受払区分 + 金額1列モード: 受入/払出で方向を決定、金額列は1つ
    if (dateCol >= 0 && directionCol >= 0 && signedCol >= 0 && depositCol < 0 && withdrawCol < 0) {
      return {
        dateColumn: dateCol,
        descriptionColumn: descCol,
        depositColumn: signedCol,
        withdrawalColumn: signedCol,
        balanceColumn: balanceCol,
        signedAmountColumn: signedCol,
        directionColumn: directionCol,
      }
    }
    // 符号付1列モード: 日付 + 入出金列 があり、入金/出金の専用列は無い
    if (dateCol >= 0 && signedCol >= 0 && depositCol < 0 && withdrawCol < 0) {
      return {
        dateColumn: dateCol,
        descriptionColumn: descCol,
        depositColumn: signedCol,
        withdrawalColumn: signedCol,
        balanceColumn: balanceCol,
        signedAmountColumn: signedCol,
      }
    }
    // 通常モード: 日付 + 残高 + (入金 or 出金)
    if (dateCol >= 0 && balanceCol >= 0 && (depositCol >= 0 || withdrawCol >= 0)) {
      // 各列のX座標を記録（データ行の空セルずれ対策）
      const xPositions = row.cellPositions
      const mapping: ColumnMapping = {
        dateColumn: dateCol,
        descriptionColumn: descCol,
        depositColumn: depositCol >= 0 ? depositCol : withdrawCol,
        withdrawalColumn: withdrawCol >= 0 ? withdrawCol : depositCol,
        balanceColumn: balanceCol,
        columnXPositions: xPositions,
      }
      // 追加列の検出: 標準列以外で「入金」「出金」方向が指定されている列
      const usedCols = new Set([dateCol, descCol, depositCol, withdrawCol, balanceCol, signedCol].filter((c) => c >= 0))
      const extraCols: { col: number; name: string; direction: 'credit' | 'debit' }[] = []
      let memoCol = -1
      // 1つ上の行で「入金」「出金」のカテゴリ行があるか探す
      const rowIdx = rows.indexOf(row)
      const dirRow = rowIdx > 0 ? rows[rowIdx - 1] : null
      // 方向行を解析: 結合セル対応（空セルは直前の方向を引き継ぐ）
      const colDirections: Record<number, 'credit' | 'debit'> = {}
      if (dirRow) {
        let lastDir: 'credit' | 'debit' | null = null
        for (let i = 0; i < dirRow.cells.length; i++) {
          const dirCell = (dirRow.cells[i] || '').replace(/[\s　]/g, '')
          if (dirCell.includes('入金') || dirCell === '入' || dirCell.includes('貸方')) {
            lastDir = 'credit'
          } else if (dirCell.includes('出金') || dirCell === '出' || dirCell.includes('借方')) {
            lastDir = 'debit'
          } else if (dirCell) {
            lastDir = null
          }
          if (lastDir && i >= 0) colDirections[i] = lastDir
        }
      }
      for (let i = 0; i < row.cells.length; i++) {
        if (usedCols.has(i)) continue
        const cellName = (row.cells[i] || '').replace(/[\s　]/g, '').trim()
        if (!cellName) continue
        if (cellName === '備考' || cellName === '備考欄') { memoCol = i; continue }
        const dir = colDirections[i]
        if (dir) {
          extraCols.push({ col: i, name: cellName, direction: dir })
        }
      }
      if (extraCols.length > 0) {
        mapping.extraColumns = extraCols
        console.log(`[ExtraCols] ${extraCols.length}列の追加列を検出:`, extraCols.map((c) => `${c.name}(${c.direction})`).join(', '))
      }
      if (memoCol >= 0) mapping.memoColumn = memoCol
      return mapping
    }
  }

  // フォールバック: 複数行にまたがるヘッダの検出
  // お取引照合表等で「取引日」と「お支払金額」が別行に分かれている場合
  for (let ri = 0; ri < Math.min(rows.length, 30); ri++) {
    const row = rows[ri]
    if (row.cells.some((c) => isDateCell(c))) continue
    // この行と前後2行のセルを全て結合して検索
    const mergedCells: string[] = []
    for (let ci = 0; ci < Math.max(row.cells.length, 20); ci++) {
      const parts: string[] = []
      for (let rj = Math.max(0, ri - 2); rj <= Math.min(rows.length - 1, ri + 2); rj++) {
        const cell = (rows[rj]?.cells[ci] || '').replace(/[\s　]/g, '')
        if (cell) parts.push(cell)
      }
      mergedCells[ci] = parts.join('')
    }
    // マージしたセルでヘッダ検出を試行
    let dateCol2 = -1, descCol2 = -1, depositCol2 = -1, withdrawCol2 = -1, balanceCol2 = -1
    for (let ci = 0; ci < mergedCells.length; ci++) {
      const mc = mergedCells[ci]
      if (!mc) continue
      if (dateCol2 < 0 && HEADER_DATE.some((k) => mc.includes(k))) dateCol2 = ci
      else if (descCol2 < 0 && HEADER_DESC.some((k) => mc.includes(k))) descCol2 = ci
      else if (depositCol2 < 0 && HEADER_DEPOSIT.some((k) => mc.includes(k))) depositCol2 = ci
      else if (withdrawCol2 < 0 && HEADER_WITHDRAW.some((k) => mc.includes(k))) withdrawCol2 = ci
      else if (balanceCol2 < 0 && HEADER_BALANCE.some((k) => mc.includes(k))) balanceCol2 = ci
    }
    if (dateCol2 >= 0 && balanceCol2 >= 0 && (depositCol2 >= 0 || withdrawCol2 >= 0)) {
      return {
        dateColumn: dateCol2,
        descriptionColumn: descCol2,
        depositColumn: depositCol2 >= 0 ? depositCol2 : withdrawCol2,
        withdrawalColumn: withdrawCol2 >= 0 ? withdrawCol2 : depositCol2,
        balanceColumn: balanceCol2,
        columnXPositions: row.cellPositions,
      }
    }
  }

  return null
}

/**
 * 列の役割を自動検出する
 */
function detectColumnMapping(rows: RawTableRow[]): ColumnMapping | null {
  if (rows.length < 2) return null

  // まずヘッダー行から列名で検出を試みる（精度が高い）
  const headerMapping = detectMappingFromHeaderRow(rows)
  if (headerMapping) return headerMapping

  const maxCols = Math.max(...rows.map((r) => r.cells.length))
  if (maxCols < 3) return null

  // 各列のスコアリング
  const dateScores = new Array(maxCols).fill(0)
  const amountScores = new Array(maxCols).fill(0)
  const textScores = new Array(maxCols).fill(0)

  for (const row of rows) {
    for (let col = 0; col < row.cells.length; col++) {
      const cell = row.cells[col]
      if (!cell) continue
      if (isDateCell(cell)) dateScores[col]++
      if (isAmountCell(cell)) amountScores[col]++
      if (cell.length > 2 && !isAmountCell(cell) && !isDateCell(cell))
        textScores[col]++
    }
  }

  // 日付列: dateScoreが最大の列
  const dateColumn = dateScores.indexOf(Math.max(...dateScores))
  if (dateScores[dateColumn] === 0) return null

  // 金額列を特定（dateColumn以外でamountScoreが高い列）
  const amountCols = amountScores
    .map((score, idx) => ({ idx, score }))
    .filter((c) => c.idx !== dateColumn && c.score > 0)
    .sort((a, b) => b.score - a.score)

  if (amountCols.length < 2) return null

  // 摘要列: textScoreが最大の列
  const descriptionColumn = textScores
    .map((score, idx) => ({ idx, score }))
    .filter((c) => c.idx !== dateColumn && !amountCols.some((a) => a.idx === c.idx))
    .sort((a, b) => b.score - a.score)[0]?.idx ?? -1

  // 金額列の割り当て: 入金、出金、残高
  // 一般的な通帳の列順: 日付, 摘要, 出金, 入金, 残高
  // または: 日付, 摘要, 入金, 出金, 残高
  // 残高は通常最後の金額列
  if (amountCols.length >= 3) {
    // 3列以上の金額列: 最後を残高、前2つを入金/出金
    const sortedByIdx = [...amountCols.slice(0, 3)].sort((a, b) => a.idx - b.idx)
    return {
      dateColumn,
      descriptionColumn: descriptionColumn >= 0 ? descriptionColumn : -1,
      depositColumn: sortedByIdx[0].idx,
      withdrawalColumn: sortedByIdx[1].idx,
      balanceColumn: sortedByIdx[2].idx,
    }
  } else {
    // 2列の金額列: 後の列を残高、前の列を入出金（混合）
    const sortedByIdx = [...amountCols].sort((a, b) => a.idx - b.idx)
    return {
      dateColumn,
      descriptionColumn: descriptionColumn >= 0 ? descriptionColumn : -1,
      depositColumn: sortedByIdx[0].idx,
      withdrawalColumn: sortedByIdx[0].idx, // 同じ列
      balanceColumn: sortedByIdx[1].idx,
    }
  }
}

/**
 * ヘッダー行に「取引区分」列があれば、その列インデックスを返す
 * 「摘要」列と併存する場合のみ有効とする（同列なら無視）
 */
function detectTransactionTypeColumn(
  rows: RawTableRow[],
  descriptionColumn: number,
): number {
  const HEADER_KEYWORDS = ['取引区分', '区分', '種別', 'お取引内容', '取引内容', '取引種別']
  for (const row of rows) {
    // ヘッダー行らしいか：日付セルを含まず、テキストセルが複数ある
    const hasDate = row.cells.some((c) => isDateCell(c))
    if (hasDate) continue
    const hasDesc = row.cells.some((c) => matchHeaderKeyword(c, ['摘要']))
    if (!hasDesc) continue
    for (let i = 0; i < row.cells.length; i++) {
      if (i === descriptionColumn) continue
      if (matchHeaderKeyword(row.cells[i], HEADER_KEYWORDS)) {
        return i
      }
    }
  }
  return -1
}

/**
 * RawTableRowsからBankTransactionに変換
 */
function extractTransactions(
  rows: RawTableRow[],
  mapping: ColumnMapping,
  pageIndex: number,
): BankTransaction[] {
  const transactions: BankTransaction[] = []
  const txTypeCol = mapping.transactionTypeColumn
  const hasTxType = typeof txTypeCol === 'number' && txTypeCol >= 0
  const hasBalanceCol = mapping.balanceColumn >= 0
  let runningBalance = 0 // 残高列がない場合のために running 集計
  let lastDate: string | null = null // 日付空欄時の引継ぎ用
  // 年・月・日が別セルの場合。設定されていればこちらを優先して日付を組み立てる
  const yCol = mapping.yearColumn
  const moCol = mapping.monthColumn
  const dCol = mapping.dayColumn
  const hasSplitDate = (typeof moCol === 'number' && moCol >= 0) && (typeof dCol === 'number' && dCol >= 0)
  let lastY: number | null = null // 年は空欄が続くことが多いので各成分を引き継ぐ
  let lastMo: number | null = null
  let lastD: number | null = null

  // X座標の範囲ベースでセルを取得（ヘッダ位置から次のヘッダ位置の範囲内を検索）
  const headerXPos = mapping.columnXPositions
  function getCellByColumn(row: RawTableRow, colIdx: number): string {
    if (colIdx < 0) return ''
    if (headerXPos && headerXPos[colIdx] != null && row.cellPositions && row.cellPositions.length > 0) {
      const leftX = headerXPos[colIdx]
      const rightX = colIdx + 1 < headerXPos.length ? headerXPos[colIdx + 1] : leftX + 300
      const prevX = colIdx > 0 ? headerXPos[colIdx - 1] : leftX - 100
      const leftBound = (prevX + leftX) / 2
      let result = ''
      for (let i = 0; i < row.cellPositions.length; i++) {
        const x = row.cellPositions[i]
        if (x >= leftBound && x < rightX) {
          result += (result ? ' ' : '') + (row.cells[i] || '')
        }
      }
      return result
    }
    return row.cells[colIdx] || ''
  }

  for (const row of rows) {
    // 合計行スキップ: いずれかのセルに「合計」「計」等が含まれていればスキップ
    if (row.cells.some((c) => {
      const cl = (c || '').replace(/[\s　]/g, '')
      return cl === '合計' || cl === '計' || cl === '小計' || cl === '総計'
    })) continue
    let date: string | null = null
    if (hasSplitDate) {
      // 年・月・日が別セル。各成分を読み、空欄は直前の値を引き継いで組み立てる
      const yCell = typeof yCol === 'number' && yCol >= 0 ? parseYearCell(getCellByColumn(row, yCol)) : null
      const moCell = parseIntInRange(getCellByColumn(row, moCol!), 1, 12)
      const dCell = parseIntInRange(getCellByColumn(row, dCol!), 1, 31)
      if (yCell != null) lastY = yCell
      if (moCell != null) lastMo = moCell
      if (dCell != null) lastD = dCell
      // 摘要・金額などの実データがある行のみ日付を確定（ヘッダや空行を除外）
      const hasOtherData = row.cells.some((c, i) => i !== yCol && i !== moCol && i !== dCol && c && c.trim())
      if (lastMo != null && lastD != null && hasOtherData) {
        const yy = lastY != null ? lastY : new Date().getFullYear()
        date = formatDate(yy, lastMo, lastD)
      }
    } else {
      const dateText = getCellByColumn(row, mapping.dateColumn)
      date = parseDate(dateText)
      if (!date && dateText) {
        // 見出しが中央寄せ・データが左寄せの通帳PDF（常陽銀行の入出金明細等）では、
        // X範囲の併合で日付セルに摘要が混ざる（「2026/03/06 ご融資」）ことがある
        // → 先頭のトークンだけで日付を再試行する（摘要は extraDesc 側で拾われる）
        const firstToken = dateText.trim().split(/[\s　]+/)[0]
        if (firstToken && firstToken !== dateText.trim()) date = parseDate(firstToken)
      }
      if (!date && lastDate && row.cells.some((c, i) => i !== mapping.dateColumn && c && c.trim())) {
        // 日付が空でも他の列にデータがある → 直前の日付を引き継ぐ
        if (row.cells.some((c) => /合計|小計|総計/.test(c || ''))) continue
        date = lastDate
      }
    }
    if (!date) continue // 日付もデータもない行はスキップ（ヘッダー等）
    lastDate = date

    let baseDesc = ''
    if (mapping.descriptionColumns && mapping.descriptionColumns.length > 0) {
      // 複数列の摘要を結合
      baseDesc = mapping.descriptionColumns
        .map((col) => (row.cells[col] || '').trim())
        .filter(Boolean)
        .join(' ')
    } else if (mapping.descriptionColumn >= 0) {
      baseDesc = getCellByColumn(row, mapping.descriptionColumn)
    }
    // 勘定日が摘要に結合されている場合、先頭の d.d.d を除去
    baseDesc = baseDesc.replace(/^\d{1,2}\.\s?\d{1,2}\.\s?\d{1,2}/, '').trim()
    const txTypeText = hasTxType ? getCellByColumn(row, txTypeCol!).trim() : ''
    // 取引区分がある場合は「取引区分 摘要」として結合
    let description =
      txTypeText && baseDesc.trim()
        ? `${txTypeText} ${baseDesc.trim()}`
        : txTypeText || baseDesc

    let balance: number | null = null
    let deposit: number | null = null
    let withdrawal: number | null = null

    // PDF テキスト抽出（cellPositions あり）: 右から数値スキャンで残高→金額を確定
    if (headerXPos && row.cellPositions && row.cellPositions.length > 0) {
      const depositX = headerXPos[mapping.depositColumn] ?? 0
      const descX = headerXPos[mapping.descriptionColumn] ?? 0
      const balanceX = headerXPos[mapping.balanceColumn] ?? 9999
      const isSigned = typeof mapping.signedAmountColumn === 'number' && mapping.signedAmountColumn >= 0

      for (let i = row.cells.length - 1; i >= 0; i--) {
        const val = parseAmount(row.cells[i])
        if (val === null) continue
        if (balance === null) {
          const balCleaned = row.cells[i].replace(/[¥￥,、\s　]/g, '').replace(/[▲△]/g, '-')
          const balNum = parseInt(balCleaned, 10)
          if (isNaN(balNum)) continue
          balance = balNum
        } else {
          if (isSigned) {
            // 符号付き1列金額: マイナス=出金、プラス=入金
            const signed = parseSignedAmount(row.cells[i])
            if (signed != null) {
              if (signed > 0) deposit = signed
              else if (signed < 0) withdrawal = Math.abs(signed)
            }
          } else {
            const x = row.cellPositions[i] ?? 0
            if (x < depositX) withdrawal = val
            else deposit = val
          }
          break
        }
      }
      if (balance === null) continue

      // 非数値テキストを摘要に追加（振込先カタカナ・摘要列等）
      const dateX2 = headerXPos[mapping.dateColumn] ?? 0
      let extraDesc = ''
      for (let j = 0; j < row.cells.length; j++) {
        const cx = row.cellPositions[j] ?? 0
        if (cx <= dateX2) continue
        const cell = (row.cells[j] || '').trim()
        if (!cell) continue
        const textPart = cell.replace(/^[-\d,.\s]+/, '').trim()
        if (textPart && !/^[-\d,]+$/.test(textPart)) {
          extraDesc += (extraDesc ? ' ' : '') + textPart
        }
      }
      if (extraDesc) {
        description = description ? `${description} ${extraDesc}` : extraDesc
      }
    } else {
      // Excel/CSV: 従来のインデックスベース抽出
      if (hasBalanceCol) {
        const balanceText = getCellByColumn(row, mapping.balanceColumn)
        // 残高は符号を保持（括弧表記やマイナスも対応）
        let balCleaned = balanceText.replace(/[¥￥,、\s　]/g, '').replace(/[▲△]/g, '-')
        if (/^\(.+\)$/.test(balCleaned)) balCleaned = '-' + balCleaned.slice(1, -1)
        const balNum = parseInt(balCleaned, 10)
        if (isNaN(balNum)) { balance = parseAmount(balanceText); if (balance === null) continue }
        else balance = balNum
      }

      // 受払区分 + 金額1列モード
      if (typeof mapping.directionColumn === 'number' && mapping.directionColumn >= 0 &&
          typeof mapping.signedAmountColumn === 'number' && mapping.signedAmountColumn >= 0) {
        const dirText = getCellByColumn(row, mapping.directionColumn).trim()
        const amtText = getCellByColumn(row, mapping.signedAmountColumn)
        const amt = parseAmount(amtText)
        if (amt != null && amt > 0) {
          const isDeposit = /受入|受$|入金|収入/.test(dirText)
          if (isDeposit) deposit = amt
          else withdrawal = amt
        }
      }
      // 符号付き1列モード
      else if (typeof mapping.signedAmountColumn === 'number' && mapping.signedAmountColumn >= 0) {
        const signedText = getCellByColumn(row, mapping.signedAmountColumn)
        const signed = parseSignedAmount(signedText)
        if (signed != null) {
          if (signed > 0) deposit = signed
          else if (signed < 0) withdrawal = Math.abs(signed)
        }
      } else {
        const depositText = getCellByColumn(row, mapping.depositColumn)
        const withdrawalText =
          mapping.withdrawalColumn !== mapping.depositColumn
            ? getCellByColumn(row, mapping.withdrawalColumn)
            : ''
        deposit = parseAmount(depositText)
        withdrawal =
          mapping.withdrawalColumn !== mapping.depositColumn
            ? parseAmount(withdrawalText)
            : null
      }

      if (!hasBalanceCol) {
        runningBalance += (deposit ?? 0) - (withdrawal ?? 0)
        balance = runningBalance
      }
    }

    // 追加列（複合仕訳用の内訳列）
    let extras: { name: string; amount: number; direction: 'credit' | 'debit'; memo?: string }[] | undefined
    if (mapping.extraColumns && mapping.extraColumns.length > 0) {
      const ex: typeof extras = []
      for (const ec of mapping.extraColumns) {
        const amtText = getCellByColumn(row, ec.col)
        const amt = parseAmount(amtText)
        if (amt != null && amt > 0) {
          ex.push({ name: ec.name, amount: amt, direction: ec.direction })
        }
      }
      if (ex.length > 0) extras = ex
    }
    // 備考列 → 別フィールドに保持（パターン適用後にも摘要に連結するため）
    let memoText: string | undefined
    let descWithMemo = description
    if (typeof mapping.memoColumn === 'number' && mapping.memoColumn >= 0) {
      const memo = getCellByColumn(row, mapping.memoColumn).trim()
      if (memo) {
        memoText = memo
        descWithMemo = `${description}_${memo}`.slice(0, 40)
      }
    }

    transactions.push({
      id: generateId(),
      pageIndex,
      rowIndex: row.rowIndex,
      date,
      description: descWithMemo,
      deposit: deposit ?? null,
      withdrawal: withdrawal ?? null,
      balance: balance!,
      boundingBox: row.boundingBox,
      extras,
      memoText,
    })
  }

  return transactions
}

/**
 * メインのパースエントリポイント
 */
export async function parseFile(file: File, accountCode?: string): Promise<ParseResult> {
  const fileName = file.name.toLowerCase()

  if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls') || fileName.endsWith('.ods')) {
    return parseExcelFile(file)
  } else if (fileName.endsWith('.csv')) {
    return parseCsvFile(file)
  } else if (fileName.endsWith('.pdf')) {
    return parsePdfFile(file, accountCode)
  } else {
    throw new Error(
      '対応していないファイル形式です。PDF (.pdf), Excel (.xlsx, .xls, .ods), CSV (.csv) のいずれかを選択してください。',
    )
  }
}

/**
 * CSVを読み込んで解析（UTF-8, Shift-JIS 自動判定）
 */
async function parseCsvFile(file: File): Promise<ParseResult> {
  const buffer = await file.arrayBuffer()
  const text = decodeCsvText(buffer)
  const rows = parseCsvText(text)
  if (rows.length === 0) {
    return { pages: [], rawPages: [[]], sourceType: 'excel', needsColumnMapping: true }
  }
  const rawRows: RawTableRow[] = rows.map((cells, i) => ({ cells, rowIndex: i }))
  const allRawPages = [rawRows]
  // Excel/CSVは常に列マッピングダイアログを表示（ユーザーが確認・修正可能）
  return { pages: [], rawPages: allRawPages, sourceType: 'excel', needsColumnMapping: true }
}

// BOM/Shift-JIS判定付きデコード
export function decodeCsvText(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  // UTF-8 BOM
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    return new TextDecoder('utf-8').decode(bytes.slice(3))
  }
  // UTF-8 として試してみて、化けたら Shift_JIS
  try {
    const asUtf8 = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return asUtf8
  } catch {
    return new TextDecoder('shift_jis').decode(bytes)
  }
}

// CSV をパース（ダブルクォート対応）
function parseCsvText(text: string): string[][] {
  const rows: string[][] = []
  let cur: string[] = []
  let field = ''
  let inQuote = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuote) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ }
        else inQuote = false
      } else {
        field += c
      }
    } else {
      if (c === '"') inQuote = true
      else if (c === ',') { cur.push(field); field = '' }
      else if (c === '\r') { /* skip, handled by \n */ }
      else if (c === '\n') { cur.push(field); rows.push(cur); cur = []; field = '' }
      else field += c
    }
  }
  if (field.length > 0 || cur.length > 0) { cur.push(field); rows.push(cur) }
  return rows.filter((r) => r.some((c) => c.trim().length > 0))
}

async function parsePdfFile(file: File, accountCode?: string): Promise<ParseResult> {
  const t0 = Date.now()
  const { pages: rawPages, isTextPdf } = await parsePdfText(file)

  if (!isTextPdf) {
    // スキャンPDF: PDF を直接 Gemini に「1ページ=1リクエスト」で並列送信
    // 同時に左パネル表示用の画像レンダリングも並走させる（OCRの裏に隠す）
    console.log('Scanned/complex PDF detected, trying PDF-direct Gemini first (page-parallel)')
    try {
      const pdfPageCount = await getPdfPageCount(file)
      const [data, imageUrls] = await Promise.all([
        processPdfInParallel(file, 1, 15),
        renderAllPagesInParallel(file, pdfPageCount, 2, 4),
      ])
      if (data.totalCount > 0) {
        const statementPages: StatementPage[] = []
        for (let i = 0; i < pdfPageCount; i++) {
          const pg = data.pages.find((p) => p.pageIndex === i)
          const txs: BankTransaction[] = (pg?.transactions || []).map((t, ri) => ({
            id: generateId(), pageIndex: i, rowIndex: ri,
            date: t.date, description: t.description || '',
            deposit: t.deposit ?? null, withdrawal: t.withdrawal ?? null, balance: t.balance ?? 0,
          }))
          statementPages.push({
            pageIndex: i, transactions: txs,
            openingBalance: 0, closingBalance: 0, isBalanceValid: true, balanceDifference: 0,
            imageDataUrl: imageUrls[i],
          })
        }
        console.log(`PDF-direct OCR succeeded (scanned path): ${data.totalCount} transactions`)
        if (accountCode) {
          const allTx = statementPages.flatMap((p) => p.transactions)
          if (allTx.length > 0) learnBankTemplate(accountCode, accountCode, allTx)
        }
        return { pages: updatePageBalances(statementPages), sourceType: 'pdf-ocr', needsColumnMapping: false }
      }
      console.log('PDF-direct OCR returned 0 transactions (scanned path), falling back to image OCR')
    } catch (e) {
      console.log('PDF-direct OCR error (scanned path), falling back to image OCR:', e)
    }

    // 従来の画像ベースOCR
    const imageDataUrls: string[] = []
    const pageCount = rawPages.length > 0 ? rawPages.length : await getPdfPageCount(file)
    console.log(`Falling back to image-based OCR: ${pageCount} pages`)
    for (let i = 0; i < pageCount; i++) {
      const imageDataUrl = await renderPdfPageToImage(file, i + 1, 2)
      imageDataUrls.push(imageDataUrl)
    }

    try {
      // 各ページ画像を Gemini File API へ並列アップロード（リクエスト本体に画像を含めない）
      const uploadStart = Date.now()
      const imageRefs = await Promise.all(
        imageDataUrls.map(async (url, i) => {
          const { blob, mimeType } = dataUrlToBlob(url)
          const ref = await uploadToGeminiFileApi(blob, `page-${i + 1}.png`, mimeType)
          return { fileUri: ref.uri, mimeType: ref.mimeType }
        }),
      )
      console.log(`Image upload: ${imageRefs.length}枚を ${((Date.now() - uploadStart) / 1000).toFixed(1)}s でアップロード`)

      const data = await ocrImagesByFileUri(
        imageRefs,
        accountCode ? getTemplatePromptAddition(accountCode) : '',
        getGeminiModel(),
      )
      const apiCorrections: string[] = data.corrections || []
      if (apiCorrections.length > 0) {
        console.log('入出金自動補正:', apiCorrections)
      }

      const geminiPages = data.pages as {
        pageIndex: number
        transactions: {
          date: string
          description: string
          deposit: number | null
          withdrawal: number | null
          balance: number
        }[]
        error?: string
      }[]

      // 全ページの取引数を集計
      const totalTransactions = geminiPages.reduce(
        (sum, gp) => sum + (gp.transactions?.length || 0), 0
      )
      console.log(`Gemini OCR: ${geminiPages.length}ページ, ${totalTransactions}件の取引を検出`)

      // Geminiが取引データを返さなかった場合
      if (totalTransactions === 0) {
        const pageErrors = geminiPages
          .filter((gp) => gp.error)
          .map((gp) => gp.error)
        const errorDetail = pageErrors.length > 0
          ? pageErrors.join(', ')
          : 'Gemini APIは応答しましたが、取引データを検出できませんでした'

        const emptyPages: StatementPage[] = imageDataUrls.map((url, i) => ({
          pageIndex: i,
          transactions: [],
          openingBalance: 0,
          closingBalance: 0,
          isBalanceValid: true,
          balanceDifference: 0,
          imageDataUrl: url,
        }))
        return {
          pages: emptyPages,
          pageImageUrls: imageDataUrls,
          sourceType: 'pdf-ocr',
          needsColumnMapping: false,
          ocrFailed: true,
          ocrErrorMessage: errorDetail,
        }
      }

      const statementPages: StatementPage[] = geminiPages.map((gp, i) => {
        const transactions: BankTransaction[] = (gp.transactions || []).map((t, rowIdx) => ({
          id: generateId(),
          pageIndex: i,
          rowIndex: rowIdx,
          date: t.date,
          description: t.description || '',
          deposit: t.deposit ?? null,
          withdrawal: t.withdrawal ?? null,
          balance: t.balance ?? 0,
        }))

        return {
          pageIndex: i,
          transactions,
          openingBalance: 0,
          closingBalance: 0,
          isBalanceValid: true,
          balanceDifference: 0,
          imageDataUrl: imageDataUrls[i],
        }
      })

      // テンプレート自動学習
      if (accountCode) {
        const allTx = statementPages.flatMap((p) => p.transactions)
        if (allTx.length > 0) {
          learnBankTemplate(accountCode, accountCode, allTx)
        }
      }

      return {
        pages: updatePageBalances(statementPages),
        sourceType: 'pdf-ocr',
        needsColumnMapping: false,
        corrections: apiCorrections.length > 0 ? apiCorrections : undefined,
      }
    } catch (err) {
      // Gemini API失敗: 画像のみ表示して手動入力モード
      const errorMessage = err instanceof Error ? err.message : 'OCR処理に失敗しました'
      console.error('Gemini OCR error:', errorMessage)
      const emptyPages: StatementPage[] = imageDataUrls.map((url, i) => ({
        pageIndex: i,
        transactions: [],
        openingBalance: 0,
        closingBalance: 0,
        isBalanceValid: true,
        balanceDifference: 0,
        imageDataUrl: url,
      }))
      return {
        pages: emptyPages,
        pageImageUrls: imageDataUrls,
        sourceType: 'pdf-ocr',
        needsColumnMapping: false,
        ocrFailed: true,
        ocrErrorMessage: errorMessage,
      }
    }
  }

  // テキストPDF
  const allRawPages = rawPages.map((p) => p.rows)
  let mapping = detectColumnsByKeywordPositions(allRawPages.flat())
  if (!mapping) {
    realignPdfRowsToColumns(allRawPages)
    mapping = detectColumnMappingFromAllPages(allRawPages)
  }

  if (!mapping) {
    // テキスト抽出はできたが列検出に失敗 → Gemini OCRにフォールバック
    console.log('Text PDF column detection failed, trying PDF-direct Gemini')

    // 1段目: PDF を直接 Gemini に「1ページ=1リクエスト」で並列送信
    // 画像レンダリングも OCR と並走させる（裏に隠す）
    try {
      const pageCount = await getPdfPageCount(file)
      const [data, imgUrls] = await Promise.all([
        processPdfInParallel(file, 1, 15),
        renderAllPagesInParallel(file, pageCount, 2, 4),
      ])
      if (data.totalCount > 0) {
        const statementPages: StatementPage[] = []
        for (let i = 0; i < pageCount; i++) {
          const pageData = data.pages.find((p) => p.pageIndex === i)
          const txs: BankTransaction[] = (pageData?.transactions || []).map((t, ri) => ({
            id: generateId(), pageIndex: i, rowIndex: ri,
            date: t.date, description: t.description || '',
            deposit: t.deposit ?? null, withdrawal: t.withdrawal ?? null, balance: t.balance ?? 0,
          }))
          statementPages.push({
            pageIndex: i, transactions: txs,
            openingBalance: 0, closingBalance: 0, isBalanceValid: true, balanceDifference: 0,
            imageDataUrl: imgUrls[i],
          })
        }
        console.log(`PDF-direct OCR succeeded: ${data.totalCount} transactions`)
        return { pages: updatePageBalances(statementPages), sourceType: 'pdf-ocr', needsColumnMapping: false }
      }
      console.log('PDF-direct OCR returned 0 transactions, falling back to image OCR')
    } catch (e) {
      console.log('PDF-direct OCR error, falling back to image OCR:', e)
    }

    // 2段目: 画像ベースのOCR（従来ロジック）
    console.log('Falling back to image-based Gemini OCR')
    const imageDataUrls: string[] = []
    const pageCount = await getPdfPageCount(file)
    for (let i = 0; i < pageCount; i++) {
      imageDataUrls.push(await renderPdfPageToImage(file, i + 1, 3))
    }

    try {
      const uploadStart = Date.now()
      const imageRefs = await Promise.all(
        imageDataUrls.map(async (url, i) => {
          const { blob, mimeType } = dataUrlToBlob(url)
          const ref = await uploadToGeminiFileApi(blob, `page-${i + 1}.png`, mimeType)
          return { fileUri: ref.uri, mimeType: ref.mimeType }
        }),
      )
      console.log(`Image upload: ${imageRefs.length}枚を ${((Date.now() - uploadStart) / 1000).toFixed(1)}s でアップロード`)

      const data = await ocrImagesByFileUri(
        imageRefs,
        accountCode ? getTemplatePromptAddition(accountCode) : '',
        getGeminiModel(),
      )
      const apiCorrections: string[] = data.corrections || []
      const geminiPages = data.pages as {
        pageIndex: number
        transactions: { date: string; description: string; deposit: number | null; withdrawal: number | null; balance: number }[]
      }[]

      const totalTx = geminiPages.reduce((s, gp) => s + (gp.transactions?.length || 0), 0)
      if (totalTx === 0) throw new Error('Gemini OCRでも取引データを検出できませんでした')

      const statementPages: StatementPage[] = geminiPages.map((gp, i) => ({
        pageIndex: i,
        transactions: (gp.transactions || []).map((t, ri) => ({
          id: generateId(), pageIndex: i, rowIndex: ri,
          date: t.date, description: t.description || '',
          deposit: t.deposit ?? null, withdrawal: t.withdrawal ?? null,
          balance: t.balance ?? 0,
        })),
        openingBalance: 0, closingBalance: 0, isBalanceValid: true, balanceDifference: 0,
        imageDataUrl: imageDataUrls[i],
      }))

      return {
        pages: updatePageBalances(statementPages),
        sourceType: 'pdf-text' as const,
        needsColumnMapping: false,
        corrections: apiCorrections.length > 0 ? apiCorrections : undefined,
      }
    } catch {
      // Gemini OCRも失敗 → 列マッピングダイアログを表示
      return {
        pages: [],
        rawPages: allRawPages,
        sourceType: 'pdf-text' as const,
        needsColumnMapping: true,
      }
    }
  }

  // テキストPDF: 取引抽出（画像はページ表示時にオンデマンド生成）
  const statementPages: StatementPage[] = []
  for (let i = 0; i < rawPages.length; i++) {
    const transactions = extractTransactions(rawPages[i].rows, mapping, i)
    statementPages.push({
      pageIndex: i,
      transactions,
      openingBalance: 0,
      closingBalance: 0,
      isBalanceValid: true,
      balanceDifference: 0,
    })
  }
  // 最初のページの画像だけ先に生成
  if (statementPages.length > 0) {
    statementPages[0].imageDataUrl = await renderPdfPageToImage(file, 1, 2)
  }

  return {
    pages: updatePageBalances(statementPages),
    pdfFile: file,
    sourceType: 'pdf-text',
    needsColumnMapping: false,
  }
}

async function parseExcelFile(file: File): Promise<ParseResult> {
  const excelResults = await parseExcel(file)
  const allRawPages = excelResults.map((r) => r.rows)
  // Excel/CSVは常に列マッピングダイアログを表示（ユーザーが確認・修正可能）
  return {
    pages: [],
    rawPages: allRawPages,
    sourceType: 'excel',
    needsColumnMapping: true,
  }
}

// 旧parseExcelFile互換（自動検出パス - 列マッピング確定後に呼ばれる）
function _parseExcelAuto(allRawPages: RawTableRow[][]): ParseResult {
  const mapping = detectColumnMappingFromAllPages(allRawPages)
  if (!mapping) {
    return { pages: [], rawPages: allRawPages, sourceType: 'excel', needsColumnMapping: true }
  }
  const statementPages: StatementPage[] = allRawPages.map((rows, i) => {
    const transactions = extractTransactions(rows, mapping, i)
    return {
      pageIndex: i,
      transactions,
      openingBalance: 0,
      closingBalance: 0,
      isBalanceValid: true,
      balanceDifference: 0,
      // Excelの場合はHTML表示
    }
  })

  return {
    pages: updatePageBalances(statementPages),
    sourceType: 'excel',
    needsColumnMapping: false,
  }
}

function detectColumnMappingFromAllPages(allPages: RawTableRow[][]): ColumnMapping | null {
  // 全ページの行を結合して列検出
  const allRows = allPages.flat()
  const mapping = detectColumnMapping(allRows)
  if (!mapping) return null
  const txTypeCol = detectTransactionTypeColumn(allRows, mapping.descriptionColumn)
  if (txTypeCol >= 0) mapping.transactionTypeColumn = txTypeCol
  return mapping
}

/**
 * 列マッピングを手動適用してParseResultを生成
 */
export function applyColumnMapping(
  rawPages: RawTableRow[][],
  mapping: ColumnMapping,
  sourceType: ParseResult['sourceType'],
): ParseResult {
  const statementPages: StatementPage[] = rawPages.map((rows, i) => {
    const transactions = extractTransactions(rows, mapping, i)
    return {
      pageIndex: i,
      transactions,
      openingBalance: 0,
      closingBalance: 0,
      isBalanceValid: true,
      balanceDifference: 0,
    }
  })

  return {
    pages: updatePageBalances(statementPages),
    sourceType,
    needsColumnMapping: false,
  }
}
