import type { JournalEntry, PayrollData } from './types'
import { createBlankEntry, createCompoundEntry } from './journal-mapper'

export function payrollToEntries(
  data: PayrollData,
  bankAccountCode: string,
  bankAccountName: string,
  deductionAccounts: Record<string, { code: string; name: string; subCode?: string; subName?: string }>,
): JournalEntry[] {
  const date = data.paymentDate.replace(/-/g, '')

  // 役員と従業員の支給合計を計算
  let executivePay = 0
  let employeePay = 0
  for (const emp of data.employees) {
    if (emp.isExecutive) executivePay += emp.totalPay
    else employeePay += emp.totalPay
  }

  // 控除項目を集計（全従業員合計）
  const deductionTotals = new Map<string, number>()
  for (const emp of data.employees) {
    for (const item of emp.items) {
      if (data.payHeaders.includes(item.name)) continue
      if (item.amount <= 0) continue
      deductionTotals.set(item.name, (deductionTotals.get(item.name) || 0) + item.amount)
    }
  }

  // 差引支給額合計
  const totalNetPay = data.employees.reduce((s, e) => s + e.netPay, 0)

  // 仕訳エントリ作成
  const entries: JournalEntry[] = []

  // 親行: 役員報酬（借方）/ 普通預金（貸方）
  const parent = createBlankEntry()
  parent.date = date
  parent.description = `${data.period} 給与`
  parent.originalDescription = `${data.period} 給与`

  if (executivePay > 0) {
    parent.debitCode = deductionAccounts['役員報酬']?.code || ''
    parent.debitName = deductionAccounts['役員報酬']?.name || '役員報酬'
    parent.debitAmount = executivePay
    parent.creditCode = bankAccountCode
    parent.creditName = bankAccountName
    parent.creditAmount = executivePay
  } else {
    parent.debitCode = deductionAccounts['給与手当']?.code || ''
    parent.debitName = deductionAccounts['給与手当']?.name || '給与手当'
    parent.debitAmount = employeePay
    parent.creditCode = bankAccountCode
    parent.creditName = bankAccountName
    parent.creditAmount = employeePay
  }
  entries.push(parent)

  // 複合行: 給与手当（役員報酬がある場合のみ追加）
  if (executivePay > 0 && employeePay > 0) {
    const empEntry = createCompoundEntry(parent)
    empEntry.debitCode = deductionAccounts['給与手当']?.code || ''
    empEntry.debitName = deductionAccounts['給与手当']?.name || '給与手当'
    empEntry.debitAmount = employeePay
    empEntry.creditCode = bankAccountCode
    empEntry.creditName = bankAccountName
    empEntry.creditAmount = employeePay
    empEntry.description = parent.description
    entries.push(empEntry)
  }

  // 複合行: 各控除項目（貸方に控除科目）
  for (const [name, amount] of Array.from(deductionTotals.entries())) {
    if (amount <= 0) continue
    const acc = deductionAccounts[name]
    const row = createCompoundEntry(parent)
    row.debitCode = bankAccountCode
    row.debitName = bankAccountName
    row.debitAmount = amount
    row.creditCode = acc?.code || ''
    row.creditName = acc?.name || name
    row.creditSubCode = acc?.subCode || ''
    row.creditSubName = acc?.subName || ''
    row.creditAmount = amount
    row.description = `${parent.description} ${name}`
    entries.push(row)
  }

  // 複合行: 差引支給額（貸方：普通預金 → 借方も普通預金になるのでスキップ。親行で計上済み）
  // ※ 実際の仕訳構造は: 借方(役員報酬+給与) = 貸方(各控除+差引支給額)
  // 差引支給額は既に親行のcreditで計上されている形にする

  return entries
}
