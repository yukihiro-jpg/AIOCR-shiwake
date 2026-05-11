import type { BankTransaction, StatementPage } from './types'
import { parsePdfText, renderPdfPageToImage } from './pdf-text-parser'
import { updatePageBalances } from './balance-validator'

let idCounter = 0
function genId(): string {
  return `yucho-${Date.now()}-${++idCounter}`
}

/**
 * ゆうちょ受払通知票PDFを解析する
 * 各ページが1つの通知（日付+入出金+残高）に対応
 * OCR済みテキストPDF前提（Gemini不要）
 */
export async function parseYuchoPdf(file: File): Promise<{ pages: StatementPage[]; pdfFile: File }> {
  const { pages: rawPages, isTextPdf } = await parsePdfText(file)
  if (!isTextPdf) throw new Error('テキストPDFではありません。ScanSnapの「検索可能なPDFを作成する」を有効にしてスキャンしてください。')

  const statementPages: StatementPage[] = []

  for (let i = 0; i < rawPages.length; i++) {
    const rows = rawPages[i].rows
    const allText = rows.map((r) => r.cells.join(' ')).join('\n')

    // 日付を抽出: 令和 7年 6月 2日
    const date = extractDate(allText)
    if (!date) continue

    // 入金・出金・残高を抽出
    const { deposit, withdrawal, balance, description } = extractAmounts(rows)

    const tx: BankTransaction = {
      id: genId(),
      pageIndex: i,
      rowIndex: 0,
      date,
      description,
      deposit: deposit > 0 ? deposit : null,
      withdrawal: withdrawal > 0 ? withdrawal : null,
      balance,
    }

    statementPages.push({
      pageIndex: i,
      transactions: [tx],
      openingBalance: 0,
      closingBalance: 0,
      isBalanceValid: true,
      balanceDifference: 0,
    })
  }

  // 最初のページの画像だけ生成
  if (statementPages.length > 0) {
    statementPages[0].imageDataUrl = await renderPdfPageToImage(file, statementPages[0].pageIndex + 1, 2)
  }

  return { pages: updatePageBalances(statementPages), pdfFile: file }
}

function extractDate(text: string): string {
  // 令和 7年 6月 2日 / 令和7年6月2日
  const m = text.match(/令和\s*(\d+)\s*年\s*(\d+)\s*月\s*(\d+)\s*日/)
  if (m) {
    const year = 2018 + parseInt(m[1])
    return `${year}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
  }
  return ''
}

function extractAmounts(rows: { cells: string[] }[]): { deposit: number; withdrawal: number; balance: number; description: string } {
  const allText = rows.map((r) => r.cells.join(' ')).join('\n')
  let deposit = 0
  let withdrawal = 0
  let balance = 0
  const descParts: string[] = []

  // 全テキストから数値を含む行を解析
  for (const row of rows) {
    const line = row.cells.join(' ')

    // 現在高（残高）
    if (/現\s*在\s*高/.test(line)) {
      balance = extractNumber(line)
      continue
    }

    // 入金系
    if (/払込金[（(]一般[）)]/.test(line) || /払込金[（(]新帳票[）)]/.test(line) ||
        /払込金[（(]DT[）)]/.test(line) || /払込金[（(]MT[）)]/.test(line)) {
      const amt = extractNumberAfterCount(row.cells)
      if (amt > 0) { deposit += amt; descParts.push('払込金') }
    }
    if (/自動払込み/.test(line)) {
      const amt = extractNumberAfterCount(row.cells)
      if (amt > 0) { deposit += amt; descParts.push('自動払込み') }
    }
    if (/振替受入れ/.test(line)) {
      const amt = extractNumberAfterCount(row.cells)
      if (amt > 0) { deposit += amt; descParts.push('振替受入れ') }
    }
    if (/公金払込み/.test(line)) {
      const amt = extractNumberAfterCount(row.cells)
      if (amt > 0) { deposit += amt; descParts.push('公金払込み') }
    }
    if (/その他受入金/.test(line)) {
      const amt = extractNumberAfterCount(row.cells)
      if (amt > 0) { deposit += amt; descParts.push('その他受入金') }
    }

    // 出金系
    if (/現金払出し/.test(line)) {
      const amt = extractNumberAfterCount(row.cells)
      if (amt > 0) { withdrawal += amt; descParts.push('現金払出し') }
    }
    if (/振替払出し/.test(line)) {
      const amt = extractNumberAfterCount(row.cells)
      if (amt > 0) { withdrawal += amt; descParts.push('振替払出し') }
    }
    if (/加入者即時払/.test(line)) {
      const amt = extractNumberAfterCount(row.cells)
      if (amt > 0) { withdrawal += amt; descParts.push('加入者即時払') }
    }
    if (/小切手払渡し/.test(line)) {
      const amt = extractNumberAfterCount(row.cells)
      if (amt > 0) { withdrawal += amt; descParts.push('小切手払渡し') }
    }
    if (/簡\s*易\s*払/.test(line)) {
      const amt = extractNumberAfterCount(row.cells)
      if (amt > 0) { withdrawal += amt; descParts.push('簡易払') }
    }
    if (/その他払出金/.test(line)) {
      const amt = extractNumberAfterCount(row.cells)
      if (amt > 0) { withdrawal += amt; descParts.push('その他払出金') }
    }

    // 料金（出金扱い）
    if (/^[\s]*料\s*金/.test(line) && !/払込料金|払出料金|振替料金|その他料金|税込|内税|非課税/.test(line)) {
      const amt = extractNumber(line)
      if (amt > 0) { withdrawal += amt; descParts.push('料金') }
    }
  }

  const uniqueDesc = Array.from(new Set(descParts))
  return { deposit, withdrawal, balance, description: uniqueDesc.join(' ') || '受払通知' }
}

function extractNumber(text: string): number {
  // カンマ区切り・全角数字対応の数値抽出（最大の数値を返す）
  const nums = text.match(/[\d０-９][,，\d０-９]*/g)
  if (!nums) return 0
  let max = 0
  for (const n of nums) {
    const cleaned = n.replace(/[,，]/g, '')
      .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    const val = parseInt(cleaned, 10)
    if (!isNaN(val) && val > max) max = val
  }
  return max
}

function extractNumberAfterCount(cells: string[]): number {
  // セル内の数値を抽出（件数と金額を区別：大きい方を金額とする）
  const nums: number[] = []
  for (const cell of cells) {
    const matches = cell.match(/[\d０-９][,，\d０-９]*/g)
    if (matches) {
      for (const m of matches) {
        const cleaned = m.replace(/[,，]/g, '')
          .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
        const val = parseInt(cleaned, 10)
        if (!isNaN(val)) nums.push(val)
      }
    }
  }
  // 最大値を金額とする（件数は小さい数値）
  return nums.length > 0 ? Math.max(...nums) : 0
}
