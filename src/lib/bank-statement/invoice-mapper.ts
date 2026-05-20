import type { JournalEntry, InvoiceData, AccountItem } from './types'
import { createBlankEntry } from './journal-mapper'

let idCounter = 0
function genId(): string { return `inv-${Date.now()}-${++idCounter}` }

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
        amount: totalAmount, taxType: '',
        description,
      })
      entries.push(parentEntry)

      for (const line of inv.taxLines) {
        const childEntry = makeEntry({
          date,
          debitCode, debitName,
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
  taxType: string; taxRate?: string; hasInvoice?: boolean; description: string;
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
  entry.description = p.description.slice(0, 40)
  entry.originalDescription = p.description
  return entry
}
