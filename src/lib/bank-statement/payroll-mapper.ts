import type { JournalEntry, PayrollData } from './types'
import { createBlankEntry, createCompoundEntry } from './journal-mapper'

export function payrollToEntries(
  data: PayrollData,
  bankAccountCode: string,
  bankAccountName: string,
  itemAccounts: Record<string, { code: string; name: string; subCode?: string; subName?: string }>,
  bankSubCode?: string,
  bankSubName?: string,
): JournalEntry[] {
  const date = data.paymentDate.replace(/-/g, '')
  const desc = `${data.period} 給与`
  const SHOKUCHI = '997'
  const SHOKUCHI_NAME = '諸口'

  // 科目設定済みの項目のみ仕訳化
  const lines: { name: string; amount: number; isDebit: boolean; code: string; accName: string; subCode: string; subName: string }[] = []

  // 役員報酬（借方）
  const execAcc = itemAccounts['役員報酬']
  if (execAcc?.code) {
    const execTotal = data.employees.filter((e) => e.isExecutive)
      .reduce((s, e) => s + (e.items.find((i) => i.name === '課税分合計')?.amount || 0), 0)
    if (execTotal > 0) {
      lines.push({ name: '役員報酬', amount: execTotal, isDebit: true, code: execAcc.code, accName: execAcc.name, subCode: execAcc.subCode || '', subName: execAcc.subName || '' })
    }
  }

  // 給与手当（借方）
  const empAcc = itemAccounts['給与手当']
  if (empAcc?.code) {
    const empTotal = data.employees.filter((e) => !e.isExecutive)
      .reduce((s, e) => s + (e.items.find((i) => i.name === '課税分合計')?.amount || 0), 0)
    if (empTotal > 0) {
      lines.push({ name: '給与手当', amount: empTotal, isDebit: true, code: empAcc.code, accName: empAcc.name, subCode: empAcc.subCode || '', subName: empAcc.subName || '' })
    }
  }

  // 支給項目で科目設定済みのもの（借方）- 役員報酬/給与手当以外
  for (const h of data.payHeaders) {
    const acc = itemAccounts[h]
    if (!acc?.code) continue
    let total = 0
    for (const emp of data.employees) {
      total += emp.items.find((i) => i.name === h)?.amount || 0
    }
    if (total > 0) {
      lines.push({ name: h, amount: total, isDebit: true, code: acc.code, accName: acc.name, subCode: acc.subCode || '', subName: acc.subName || '' })
    }
  }

  // 控除項目で科目設定済みのもの（貸方）
  for (const h of data.deductHeaders) {
    const acc = itemAccounts[h]
    if (!acc?.code) continue
    let total = 0
    for (const emp of data.employees) {
      total += emp.items.find((i) => i.name === h)?.amount || 0
    }
    if (total > 0) {
      lines.push({ name: h, amount: total, isDebit: false, code: acc.code, accName: acc.name, subCode: acc.subCode || '', subName: acc.subName || '' })
    }
  }

  // 引落口座（貸方）= 差引支給額合計
  if (bankAccountCode) {
    const totalNetPay = data.employees.reduce((s, e) => s + e.netPay, 0)
    if (totalNetPay > 0) {
      lines.push({ name: '差引支給額', amount: totalNetPay, isDebit: false, code: bankAccountCode, accName: bankAccountName, subCode: bankSubCode || '', subName: bankSubName || '' })
    }
  }

  if (lines.length === 0) return []

  // 複合仕訳を生成（相手勘定は諸口997）
  const entries: JournalEntry[] = []
  const parent = createBlankEntry()
  parent.date = date
  parent.description = desc
  parent.originalDescription = desc
  const first = lines[0]
  if (first.isDebit) {
    parent.debitCode = first.code; parent.debitName = first.accName
    parent.debitSubCode = first.subCode; parent.debitSubName = first.subName
    parent.creditCode = SHOKUCHI; parent.creditName = SHOKUCHI_NAME
  } else {
    parent.debitCode = SHOKUCHI; parent.debitName = SHOKUCHI_NAME
    parent.creditCode = first.code; parent.creditName = first.accName
    parent.creditSubCode = first.subCode; parent.creditSubName = first.subName
  }
  parent.debitAmount = first.amount
  parent.creditAmount = first.amount
  entries.push(parent)

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    const row = createCompoundEntry(parent)
    row.description = `${desc} ${line.name}`
    row.originalDescription = `${desc} ${line.name}`
    if (line.isDebit) {
      row.debitCode = line.code; row.debitName = line.accName
      row.debitSubCode = line.subCode; row.debitSubName = line.subName
      row.creditCode = SHOKUCHI; row.creditName = SHOKUCHI_NAME
    } else {
      row.debitCode = SHOKUCHI; row.debitName = SHOKUCHI_NAME
      row.creditCode = line.code; row.creditName = line.accName
      row.creditSubCode = line.subCode; row.creditSubName = line.subName
    }
    row.debitAmount = line.amount
    row.creditAmount = line.amount
    entries.push(row)
  }

  return entries
}
