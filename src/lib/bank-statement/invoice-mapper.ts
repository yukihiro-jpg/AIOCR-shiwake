import type { JournalEntry, InvoiceData, AccountItem } from './types'
import { createBlankEntry } from './journal-mapper'

let idCounter = 0
function genId(): string { return `inv-${Date.now()}-${++idCounter}` }

/**
 * 列マッピング設定（Excel/CSV 取り込み用）
 */
export interface InvoiceRowMapping {
  dateColumn: number
  counterpartColumn: number
  contentColumns: number[]
  totalAmountColumn: number
  netAmountColumn: number
  taxAmountColumn: number
  taxRateColumn: number
  invoiceNumberColumn: number
  headerRowIndex: number
}

/**
 * Excel/CSV から読み込んだ生の行配列 + 列マッピング → InvoiceData[]
 * 行ごとに 1 件の請求書として扱う（同明細の複数税率は taxLines に複数追加されない=単一行=単一税率）
 */
export function rowsToInvoiceData(
  rows: { cells: string[] }[],
  mapping: InvoiceRowMapping,
): InvoiceData[] {
  const invoices: InvoiceData[] = []
  let idx = 0
  for (let i = mapping.headerRowIndex + 1; i < rows.length; i++) {
    const cells = rows[i]?.cells || []
    const dateRaw = cells[mapping.dateColumn] || ''
    const totalRaw = cells[mapping.totalAmountColumn] || ''
    const total = parseAmount(totalRaw)
    // 日付も金額も空ならスキップ（空行・合計行など）
    if (!dateRaw && total === 0) continue
    if (total === 0) continue

    const counterpart = (cells[mapping.counterpartColumn] || '').trim()
    const content = (mapping.contentColumns || [])
      .map((c) => (cells[c] || '').trim())
      .filter((s) => s)
      .join(' ')
    const netAmount = mapping.netAmountColumn >= 0 ? parseAmount(cells[mapping.netAmountColumn]) : 0
    const taxAmount = mapping.taxAmountColumn >= 0 ? parseAmount(cells[mapping.taxAmountColumn]) : 0
    const taxRate = mapping.taxRateColumn >= 0 ? normalizeTaxRate(cells[mapping.taxRateColumn] || '') : '10%'
    const invoiceNumber = mapping.invoiceNumberColumn >= 0 ? (cells[mapping.invoiceNumberColumn] || '').trim() : ''

    invoices.push({
      invoiceIndex: idx++,
      counterpartName: counterpart,
      invoiceNumber: invoiceNumber || undefined,
      invoiceDate: normalizeDate(dateRaw),
      mainContent: content,
      taxLines: [{
        taxRate,
        netAmount: netAmount || (total - taxAmount),
        taxAmount: taxAmount || 0,
        totalAmount: total,
      }],
      totalAmount: total,
      pageStart: 0,
      pageEnd: 0,
    })
  }
  return invoices
}

function parseAmount(raw: string | number | undefined): number {
  if (raw == null) return 0
  if (typeof raw === 'number') return raw
  const cleaned = String(raw).replace(/[,¥￥\s]/g, '').replace(/[△▲−–-]/g, '-').trim()
  const n = parseFloat(cleaned)
  return isFinite(n) ? n : 0
}

function normalizeDate(raw: string): string {
  if (!raw) return ''
  const s = String(raw).trim()
  // 既に YYYY-MM-DD（excel-parser が変換済み）
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  // YYYY/MM/DD or YYYY.MM.DD
  const m1 = s.match(/^(\d{4})[/.\-年](\d{1,2})[/.\-月](\d{1,2})/)
  if (m1) return `${m1[1]}-${m1[2].padStart(2, '0')}-${m1[3].padStart(2, '0')}`
  // 和暦 令和N年M月D日
  const m2 = s.match(/^令和(\d{1,2})年(\d{1,2})月(\d{1,2})日?/)
  if (m2) {
    const y = 2018 + parseInt(m2[1])
    return `${y}-${m2[2].padStart(2, '0')}-${m2[3].padStart(2, '0')}`
  }
  return s
}

function normalizeTaxRate(raw: string): string {
  const s = String(raw).trim()
  if (!s) return '10%'
  if (s.includes('非課税') || s.includes('非税')) return '非課税'
  if (s.includes('8')) return '8%'
  if (s.includes('10')) return '10%'
  if (s.includes('0')) return '0%'
  return s
}

/**
 * 売上請求書 → 仕訳データに変換
 * 税率が1つ: 借方 売掛金 / 貸方 売上
 * 税率が複数: 借方 売掛金 / 貸方 997諸口 → 997諸口 / 売上(10%) → 997諸口 / 売上(8%)
 */
export function salesInvoiceToEntries(
  invoices: InvoiceData[],
  debitCode: string,
  debitName: string,
  creditCode: string,
  creditName: string,
  debitSubCode?: string,
  debitSubName?: string,
  creditSubCode?: string,
  creditSubName?: string,
): JournalEntry[] {
  const entries: JournalEntry[] = []

  for (const inv of invoices) {
    const description = `${inv.counterpartName}_${inv.mainContent}`
    const date = inv.invoiceDate.replace(/-/g, '')
    // taxLines が空でも請求書全体の totalAmount（請求金額/振込金額）を採用
    const taxLineTotal = inv.taxLines.reduce((s, t) => s + (t.totalAmount || 0), 0)
    const totalAmount = taxLineTotal > 0 ? taxLineTotal : (inv.totalAmount || 0)

    if (inv.taxLines.length <= 1) {
      const line = inv.taxLines[0]
      const entry = makeEntry({
        date, debitCode, debitName, creditCode, creditName,
        debitSubCode, debitSubName, creditSubCode, creditSubName,
        amount: totalAmount,
        taxType: line ? getTaxCategory('sales', line.taxRate, true) : '',
        taxRate: line?.taxRate,
        hasInvoice: true,
        description,
      })
      entries.push(entry)
    } else {
      const parentEntry = makeEntry({
        date, debitCode, debitName,
        debitSubCode, debitSubName,
        creditCode: '997', creditName: '諸口',
        amount: totalAmount, taxType: '',
        description,
      })
      entries.push(parentEntry)

      for (const line of inv.taxLines) {
        const childEntry = makeEntry({
          date,
          debitCode: '997', debitName: '諸口',
          creditCode, creditName,
          creditSubCode, creditSubName,
          amount: line.totalAmount,
          taxType: getTaxCategory('sales', line.taxRate, true),
          taxRate: line.taxRate,
          hasInvoice: true,
          description,
        })
        childEntry.isCompound = true
        childEntry.parentId = parentEntry.id
        entries.push(childEntry)
      }
    }
  }

  return entries
}

/**
 * 仕入請求書 → 仕訳データに変換
 */
export function purchaseInvoiceToEntries(
  invoices: InvoiceData[],
  debitCode: string,
  debitName: string,
  creditCode: string,
  creditName: string,
  debitSubCode?: string,
  debitSubName?: string,
  creditSubCode?: string,
  creditSubName?: string,
): JournalEntry[] {
  const entries: JournalEntry[] = []

  for (const inv of invoices) {
    const description = `${inv.counterpartName}_${inv.mainContent}`
    const date = inv.invoiceDate.replace(/-/g, '')
    // taxLines が空でも請求書全体の totalAmount（請求金額/振込金額）を採用
    const taxLineTotal = inv.taxLines.reduce((s, t) => s + (t.totalAmount || 0), 0)
    const totalAmount = taxLineTotal > 0 ? taxLineTotal : (inv.totalAmount || 0)
    const hasInvoice = !!inv.invoiceNumber

    if (inv.taxLines.length <= 1) {
      const line = inv.taxLines[0]
      const entry = makeEntry({
        date, debitCode, debitName, creditCode, creditName,
        debitSubCode, debitSubName, creditSubCode, creditSubName,
        amount: totalAmount,
        taxType: line ? getTaxCategory('purchase', line.taxRate, hasInvoice) : '',
        taxRate: line?.taxRate,
        hasInvoice,
        description,
      })
      entries.push(entry)
    } else {
      const parentEntry = makeEntry({
        date, debitCode: '997', debitName: '諸口',
        creditCode, creditName,
        creditSubCode, creditSubName,
        amount: totalAmount, taxType: '',
        description,
      })
      entries.push(parentEntry)

      for (const line of inv.taxLines) {
        const childEntry = makeEntry({
          date,
          debitCode, debitName,
          debitSubCode, debitSubName,
          creditCode: '997', creditName: '諸口',
          amount: line.totalAmount,
          taxType: getTaxCategory('purchase', line.taxRate, hasInvoice),
          taxRate: line.taxRate,
          hasInvoice,
          description,
        })
        childEntry.isCompound = true
        childEntry.parentId = parentEntry.id
        entries.push(childEntry)
      }
    }
  }

  return entries
}

function getTaxCategory(type: 'sales' | 'purchase', taxRate: string, hasInvoice: boolean): string {
  if (taxRate === '非課税' || taxRate === '0%') return type === 'sales' ? '非売' : '非仕'

  const rate = taxRate.replace('%', '')
  if (type === 'sales') {
    return `課売${rate}%`
  } else {
    if (hasInvoice) return `課仕${rate}%`
    return `課仕${rate}%（経過措置）`
  }
}

function taxRateToCode(taxRate: string): string {
  if (taxRate.includes('8')) return '5' // 軽減税率8% → 5
  return '4' // 標準税率10% → 4
}

function makeEntry(p: {
  date: string; debitCode: string; debitName: string;
  creditCode: string; creditName: string; amount: number;
  debitSubCode?: string; debitSubName?: string;
  creditSubCode?: string; creditSubName?: string;
  taxType: string; taxRate?: string; hasInvoice?: boolean; description: string;
}): JournalEntry {
  const entry = createBlankEntry()
  entry.id = genId()
  entry.date = p.date
  entry.debitCode = p.debitCode
  entry.debitName = p.debitName
  entry.debitSubCode = p.debitSubCode || ''
  entry.debitSubName = p.debitSubName || ''
  entry.creditCode = p.creditCode
  entry.creditName = p.creditName
  entry.creditSubCode = p.creditSubCode || ''
  entry.creditSubName = p.creditSubName || ''
  entry.debitAmount = p.amount
  entry.creditAmount = p.amount
  entry.debitTaxType = p.taxType
  entry.debitTaxRate = p.taxRate ? taxRateToCode(p.taxRate) : ''
  entry.debitBusinessType = p.hasInvoice != null ? (p.hasInvoice ? '0' : '1') : '0'
  entry.description = p.description.slice(0, 40)
  entry.originalDescription = p.description
  return entry
}
