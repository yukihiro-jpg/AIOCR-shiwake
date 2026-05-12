import type { JournalEntry } from './types'
import { createBlankEntry } from './journal-mapper'

let idCounter = 0
function genId(): string { return `rcp-${Date.now()}-${++idCounter}` }

interface ReceiptData {
  receiptIndex: number
  storeName: string
  receiptDate: string
  mainContent: string
  invoiceNumber?: string
  taxLines: { taxRate: string; netAmount: number; taxAmount: number; totalAmount: number }[]
  pageIndex: number
}

/**
 * レシート・領収書 → 仕訳データに変換
 * 貸方は支払原資（現金等）、借方はユーザーが後で設定
 */
export function receiptToEntries(
  receipts: ReceiptData[],
  creditCode: string,
  creditName: string,
): JournalEntry[] {
  const entries: JournalEntry[] = []

  for (const rcp of receipts) {
    const description = `${rcp.storeName}_${rcp.mainContent}`.slice(0, 40)
    const date = rcp.receiptDate.replace(/-/g, '')
    const totalAmount = rcp.taxLines.reduce((s, t) => s + t.totalAmount, 0)
    const hasInvoice = !!rcp.invoiceNumber

    if (rcp.taxLines.length <= 1) {
      const line = rcp.taxLines[0]
      const entry = makeEntry({
        date, debitCode: '', debitName: '', creditCode, creditName,
        amount: totalAmount,
        taxType: line ? getTaxCategory(line.taxRate, hasInvoice) : '',
        taxRate: line?.taxRate, hasInvoice,
        description, originalDescription: `${rcp.storeName}_${rcp.mainContent}`,
      })
      entries.push(entry)
    } else {
      // 複数税率: 997諸口の複合仕訳
      const parentEntry = makeEntry({
        date,
        debitCode: '997', debitName: '諸口',
        creditCode, creditName,
        amount: totalAmount,
        taxType: '',
        description,
        originalDescription: `${rcp.storeName}_${rcp.mainContent}`,
      })
      entries.push(parentEntry)

      for (const line of rcp.taxLines) {
        const childEntry = makeEntry({
          date, debitCode: '', debitName: '',
          creditCode: '997', creditName: '諸口',
          amount: line.totalAmount,
          taxType: getTaxCategory(line.taxRate, hasInvoice),
          taxRate: line.taxRate, hasInvoice,
          description, originalDescription: `${rcp.storeName}_${rcp.mainContent}`,
        })
        childEntry.isCompound = true
        childEntry.parentId = parentEntry.id
        entries.push(childEntry)
      }
    }
  }

  return entries
}

function getTaxCategory(taxRate: string, hasInvoice: boolean): string {
  if (taxRate === '非課税' || taxRate === '0%') return '非仕'
  const rate = taxRate.replace('%', '')
  if (hasInvoice) return `課仕${rate}%`
  return `課仕${rate}%（経過措置）`
}

function taxRateToCode(taxRate: string): string {
  if (taxRate.includes('8')) return '5'
  return '4'
}

function makeEntry(p: {
  date: string; debitCode: string; debitName: string;
  creditCode: string; creditName: string; amount: number;
  taxType: string; taxRate?: string; hasInvoice?: boolean;
  description: string; originalDescription: string;
}): JournalEntry {
  const entry = createBlankEntry()
  entry.id = genId()
  entry.date = p.date
  entry.debitCode = p.debitCode
  entry.debitName = p.debitName
  entry.creditCode = p.creditCode
  entry.creditName = p.creditName
  entry.debitAmount = p.amount
  entry.creditAmount = p.amount
  entry.debitTaxType = p.taxType
  entry.debitTaxRate = p.taxRate ? taxRateToCode(p.taxRate) : ''
  entry.debitBusinessType = p.hasInvoice != null ? (p.hasInvoice ? '0' : '1') : '0'
  entry.description = p.description
  entry.originalDescription = p.originalDescription
  return entry
}
