import type { JournalEntry, PayrollLedger, AccountTaxItem } from './types'
import { createBlankEntry, createCompoundEntry } from './journal-mapper'

interface Acct { code: string; name: string; subCode?: string; subName?: string }

export interface LedgerAccounts {
  salary: Acct        // 給与手当（借方・デフォルト）
  executive: Acct     // 役員報酬（借方・役員のみ）
  unpaid: Acct        // 未払金（貸方・差引支給額）
  welfare: Acct       // 法定福利費（貸方・社会保険料）
  withholding: Acct   // 預り金（貸方・親科目）
  incomeSub?: { code: string; name: string }   // 預り金 補助：源泉所得税
  residentSub?: { code: string; name: string } // 預り金 補助：住民税
}

// 計上日ルール（解析時に登録）
export type LedgerDateRule =
  | { type: 'monthEnd' }
  | { type: 'monthStart' }
  | { type: 'day'; day: number; nextMonth: boolean }

const z = (n: number) => String(n).padStart(2, '0')
function ymd(year: number, month: number, day: number): string { return `${year}${z(month)}${z(day)}` }
function lastDay(year: number, month: number): number { return new Date(year, month, 0).getDate() }

export function ledgerDateFor(year: number, month: number, rule: LedgerDateRule): string {
  if (rule.type === 'monthStart') return ymd(year, month, 1)
  if (rule.type === 'monthEnd') return ymd(year, month, lastDay(year, month))
  // type === 'day'
  let y = year, m = month
  if (rule.nextMonth) { m += 1; if (m > 12) { m = 1; y += 1 } }
  const d = Math.min(Math.max(1, rule.day || 1), lastDay(y, m))
  return ymd(y, m, d)
}

/** 年間賃金台帳 → 人別×月別の複合仕訳（諸口997経由） */
export function payrollLedgerToEntries(
  ledger: PayrollLedger,
  fromMonth: number,
  toMonth: number,
  accts: LedgerAccounts,
  dateRule: LedgerDateRule,
  accountTaxMaster?: AccountTaxItem[],
): JournalEntry[] {
  const SHOKUCHI = '997', SHOKUCHI_NAME = '諸口'
  const getTax = (code: string): { taxCode: string; taxName: string } => {
    if (!accountTaxMaster || !code) return { taxCode: '', taxName: '' }
    const t = accountTaxMaster.find((x) => x.accountCode === code)
    if (!t || t.categoryCode === '0') return { taxCode: '', taxName: '' }
    if (t.categoryCode === '1') return { taxCode: t.salesTaxCode, taxName: t.salesTaxName }
    return { taxCode: t.purchaseTaxCode, taxName: t.purchaseTaxName }
  }
  const lo = Math.min(fromMonth, toMonth), hi = Math.max(fromMonth, toMonth)
  const out: JournalEntry[] = []

  for (const emp of ledger.employees) {
    const debit = emp.isExecutive ? accts.executive : accts.salary
    for (const mo of emp.months) {
      if (mo.month < lo || mo.month > hi) continue
      if (mo.gross <= 0) continue
      const date = ledgerDateFor(ledger.year || new Date().getFullYear(), mo.month, dateRule)
      const desc = `${mo.month}月分　${emp.name}`

      // 貸方側の明細（諸口の相手）
      const credits: { acc: Acct; amount: number }[] = []
      if (mo.netPay > 0) credits.push({ acc: accts.unpaid, amount: mo.netPay })
      if (mo.socialInsurance > 0) credits.push({ acc: accts.welfare, amount: mo.socialInsurance })
      if (mo.incomeTax > 0) credits.push({ acc: { ...accts.withholding, subCode: accts.incomeSub?.code, subName: accts.incomeSub?.name }, amount: mo.incomeTax })
      if (mo.residentTax > 0) credits.push({ acc: { ...accts.withholding, subCode: accts.residentSub?.code, subName: accts.residentSub?.name }, amount: mo.residentTax })

      // 親：借方 給与/役員報酬（総支給額）／ 貸方 諸口
      const parent = createBlankEntry()
      parent.date = date
      parent.description = desc
      parent.originalDescription = desc
      parent.debitCode = debit.code; parent.debitName = debit.name
      parent.debitSubCode = debit.subCode || ''; parent.debitSubName = debit.subName || ''
      parent.creditCode = SHOKUCHI; parent.creditName = SHOKUCHI_NAME
      const dtax = getTax(debit.code)
      if (dtax.taxCode) { parent.debitTaxCode = dtax.taxCode; parent.debitTaxType = dtax.taxName }
      parent.debitAmount = mo.gross
      parent.creditAmount = mo.gross
      out.push(parent)

      // 子：借方 諸口 ／ 貸方 各科目
      for (const c of credits) {
        const row = createCompoundEntry(parent)
        row.description = desc
        row.originalDescription = desc
        row.debitCode = SHOKUCHI; row.debitName = SHOKUCHI_NAME
        row.creditCode = c.acc.code; row.creditName = c.acc.name
        row.creditSubCode = c.acc.subCode || ''; row.creditSubName = c.acc.subName || ''
        const ctax = getTax(c.acc.code)
        if (ctax.taxCode) { row.debitTaxCode = ctax.taxCode; row.debitTaxType = ctax.taxName }
        row.debitAmount = c.amount
        row.creditAmount = c.amount
        out.push(row)
      }
    }
  }
  return out
}
