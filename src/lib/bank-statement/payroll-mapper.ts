import type { JournalEntry, PayrollData, AccountTaxItem } from './types'
import { createBlankEntry, createCompoundEntry } from './journal-mapper'

interface ItemAccount {
  code: string; name: string; subCode?: string; subName?: string
}

export interface PayrollGenerateOptions {
  // 給与手当を従業員ごとの明細行にする（既定＝合計1行）
  salaryIndividual?: boolean
  // 控除項目を「補助科目ごと（個人別）」で計上する。{ 項目名: { 従業員キー: {subCode, subName} } }
  perPersonSubs?: Record<string, Record<string, { subCode: string; subName: string }>>
}

/** 従業員の一意キー。同姓同名がいる場合のみ NO を付けて区別する（補助科目割当・摘要用）。
 *  ダイアログのUIと mapper で必ず同じキーを使うこと。 */
export function payrollPersonKey(emp: { name: string; no: number }, all: { name: string }[]): string {
  const dup = all.filter((e) => e.name === emp.name).length > 1
  return dup ? `${emp.name}(${emp.no})` : emp.name
}

/** 仕訳生成前の貸借バランス検証。
 *  未設定の項目があると、後段の複合仕訳の自動調整（applyCompoundAutoAmounts）が
 *  差額を「差引支給額（引落口座）」行へ黙って押し込み、通帳と一致しない金額で
 *  出力されてしまうため、生成前に必ずこの検証を通すこと（不一致なら生成をブロック）。 */
export function payrollBalanceCheck(
  data: PayrollData,
  itemAccounts: Record<string, ItemAccount>,
  options?: PayrollGenerateOptions,
): { debitTotal: number; creditTotal: number; netPayTotal: number; diff: number; unmapped: { name: string; amount: number }[] } {
  const taxableOf = (e: { items: { name: string; amount: number }[] }) => e.items.find((i) => i.name === '課税分合計')?.amount || 0
  let debitTotal = 0
  if (itemAccounts['役員報酬']?.code) {
    for (const e of data.employees.filter((x) => x.isExecutive)) debitTotal += taxableOf(e)
  }
  if (itemAccounts['給与手当']?.code) {
    for (const e of data.employees.filter((x) => !x.isExecutive)) debitTotal += taxableOf(e)
  }
  const sumItem = (h: string) => data.employees.reduce((s, e) => s + (e.items.find((i) => i.name === h)?.amount || 0), 0)
  const unmapped: { name: string; amount: number }[] = []
  for (const h of data.payHeaders) {
    if (['支給合計額', '課税分合計', '控除合計額'].includes(h)) continue // 集計列は対象外
    const t = sumItem(h)
    if (itemAccounts[h]?.code) debitTotal += t
    // 非課税支給（通勤手当等）は課税分合計に含まれないため要マッピング。「(非)通勤費」等の表記にも対応
    else if (t > 0 && (h === '非課税額' || /非課税|^[（(]非[）)]/.test(h))) unmapped.push({ name: h, amount: t })
  }
  let creditTotal = 0
  for (const h of data.deductHeaders) {
    if (['控除合計額', '社会保険料合計', '課税対象額', '差引支給額'].includes(h)) continue
    const t = sumItem(h)
    if (itemAccounts[h]?.code) creditTotal += t
    else if (t > 0) unmapped.push({ name: h, amount: t })
  }
  const netPayTotal = data.employees.reduce((s, e) => s + e.netPay, 0)
  const diff = debitTotal - (creditTotal + netPayTotal)
  void options
  return { debitTotal, creditTotal, netPayTotal, diff, unmapped }
}

export function payrollToEntries(
  data: PayrollData,
  bankAccountCode: string,
  bankAccountName: string,
  itemAccounts: Record<string, ItemAccount>,
  bankSubCode?: string,
  bankSubName?: string,
  accountTaxMaster?: AccountTaxItem[],
  options?: PayrollGenerateOptions,
): JournalEntry[] {
  const date = data.paymentDate.replace(/-/g, '')
  const isBonus = !!data.isBonus || data.period.includes('賞与')
  const suffix = isBonus ? '賞与' : '給与'
  const desc = data.period.includes(suffix) ? data.period : `${data.period} ${suffix}`
  const SHOKUCHI = '997'
  const SHOKUCHI_NAME = '諸口'

  function getTaxInfo(code: string): { taxCode: string; taxName: string; taxRate: string } {
    if (!accountTaxMaster || !code) return { taxCode: '', taxName: '', taxRate: '' }
    const tax = accountTaxMaster.find((t) => t.accountCode === code)
    if (!tax || tax.categoryCode === '0') return { taxCode: '', taxName: '', taxRate: '' }
    if (tax.categoryCode === '1') return { taxCode: tax.salesTaxCode, taxName: tax.salesTaxName, taxRate: tax.salesTaxRate || '' }
    return { taxCode: tax.purchaseTaxCode, taxName: tax.purchaseTaxName, taxRate: tax.purchaseTaxRate || '' }
  }

  /** 税区分を科目の計上side（借方/貸方）に付ける。消費税コード・税率は会計大将CSVの共通欄
   *  （借方側）に載せる仕様のため、side に関わらず debitTaxCode/debitTaxRate へ設定する。
   *  これをしないと貸方科目（例: 給与から控除して通信費/旅費交通費へ振替）で税区分が
   *  諸口側に付き、会計大将取込時に「不明取引」になる。 */
  function applyTax(e: JournalEntry, isDebit: boolean, t: { taxCode: string; taxName: string; taxRate: string }) {
    if (!t.taxCode) return
    e.debitTaxCode = t.taxCode
    if (t.taxRate) e.debitTaxRate = t.taxRate
    if (isDebit) e.debitTaxType = t.taxName
    else e.creditTaxType = t.taxName
  }

  // 科目設定済みの項目のみ仕訳化
  const lines: { name: string; amount: number; isDebit: boolean; code: string; accName: string; subCode: string; subName: string }[] = []

  // 役員報酬（借方）— 役員は「一人ずつ個別の金額」で仕訳（摘要に氏名を入れる。同姓同名はNO付き）
  const execAcc = itemAccounts['役員報酬']
  if (execAcc?.code) {
    for (const e of data.employees.filter((x) => x.isExecutive)) {
      const amt = e.items.find((i) => i.name === '課税分合計')?.amount || 0
      if (amt > 0) {
        lines.push({ name: `役員報酬 ${payrollPersonKey(e, data.employees)}`, amount: amt, isDebit: true, code: execAcc.code, accName: execAcc.name, subCode: execAcc.subCode || '', subName: execAcc.subName || '' })
      }
    }
  }

  // 給与手当（借方）— 既定は合計1行。options.salaryIndividual で従業員ごとの明細行に
  const empAcc = itemAccounts['給与手当']
  if (empAcc?.code) {
    const emps = data.employees.filter((e) => !e.isExecutive)
    if (options?.salaryIndividual) {
      for (const e of emps) {
        const amt = e.items.find((i) => i.name === '課税分合計')?.amount || 0
        if (amt > 0) {
          lines.push({ name: `給与手当 ${payrollPersonKey(e, data.employees)}`, amount: amt, isDebit: true, code: empAcc.code, accName: empAcc.name, subCode: empAcc.subCode || '', subName: empAcc.subName || '' })
        }
      }
    } else {
      const empTotal = emps.reduce((s, e) => s + (e.items.find((i) => i.name === '課税分合計')?.amount || 0), 0)
      if (empTotal > 0) {
        lines.push({ name: '給与手当', amount: empTotal, isDebit: true, code: empAcc.code, accName: empAcc.name, subCode: empAcc.subCode || '', subName: empAcc.subName || '' })
      }
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
    // マイナスの支給項目（控除的な調整）は貸方へ振り替えて貸借を保つ
    if (total !== 0) {
      lines.push({ name: h, amount: Math.abs(total), isDebit: total > 0, code: acc.code, accName: acc.name, subCode: acc.subCode || '', subName: acc.subName || '' })
    }
  }

  // 控除項目で科目設定済みのもの（貸方。社会保険修正・年末調整還付などのマイナス合計は借方へ振り替える）
  for (const h of data.deductHeaders) {
    const acc = itemAccounts[h]
    if (!acc?.code) continue
    const perPerson = options?.perPersonSubs?.[h]
    if (perPerson) {
      // 補助科目ごと（個人別）：金額がある従業員だけ、各人の補助科目で1行ずつ（摘要に氏名）
      for (const emp of data.employees) {
        const amt = emp.items.find((i) => i.name === h)?.amount || 0
        if (amt === 0) continue
        const key = payrollPersonKey(emp, data.employees)
        const sub = perPerson[key] || perPerson[emp.name] || { subCode: acc.subCode || '', subName: acc.subName || '' }
        lines.push({ name: `${h} ${key}`, amount: Math.abs(amt), isDebit: amt < 0, code: acc.code, accName: acc.name, subCode: sub.subCode || '', subName: sub.subName || '' })
      }
    } else {
      let total = 0
      for (const emp of data.employees) {
        total += emp.items.find((i) => i.name === h)?.amount || 0
      }
      if (total !== 0) {
        lines.push({ name: h, amount: Math.abs(total), isDebit: total < 0, code: acc.code, accName: acc.name, subCode: acc.subCode || '', subName: acc.subName || '' })
      }
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
  const first = lines[0]
  // 先頭行が役員報酬（氏名付き）等の場合は摘要に反映
  const parentDesc = first.name && first.name !== '差引支給額' ? `${desc} ${first.name}` : desc
  parent.description = parentDesc
  parent.originalDescription = parentDesc
  const firstTax = getTaxInfo(first.code)
  if (first.isDebit) {
    parent.debitCode = first.code; parent.debitName = first.accName
    parent.debitSubCode = first.subCode; parent.debitSubName = first.subName
    parent.creditCode = SHOKUCHI; parent.creditName = SHOKUCHI_NAME
  } else {
    parent.debitCode = SHOKUCHI; parent.debitName = SHOKUCHI_NAME
    parent.creditCode = first.code; parent.creditName = first.accName
    parent.creditSubCode = first.subCode; parent.creditSubName = first.subName
  }
  applyTax(parent, first.isDebit, firstTax)
  parent.debitAmount = first.amount
  parent.creditAmount = first.amount
  entries.push(parent)

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    const lineTax = getTaxInfo(line.code)
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
    applyTax(row, line.isDebit, lineTax)
    row.debitAmount = line.amount
    row.creditAmount = line.amount
    entries.push(row)
  }

  return entries
}
