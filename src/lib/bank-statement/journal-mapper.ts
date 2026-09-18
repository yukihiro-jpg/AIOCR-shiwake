import type {
  BankTransaction,
  JournalEntry,
  StatementPage,
  PatternEntry,
  AccountItem,
} from './types'
import { findPattern } from './pattern-store'
import { findLoanRepayment } from './loan-schedule-store'
import type { LoanSchedule } from './loan-schedule-store'

let entryIdCounter = 0
function generateEntryId(): string {
  return `je-${Date.now()}-${++entryIdCounter}`
}

/**
 * 通帳取引を仕訳に変換する
 * - 入金: 借方=預金口座、貸方=学習パターンから推定
 * - 出金: 借方=学習パターンから推定、貸方=預金口座
 */
export function mapTransactionsToJournalEntries(
  pages: StatementPage[],
  accountCode: string,
  accountName: string,
  patterns: PatternEntry[],
  accountMaster: AccountItem[],
  accountSubCode?: string,
  accountSubName?: string,
  /** 借入金の返済予定表。償還額と同じ出金を見つけたら、元本と利息に分けた複合仕訳にする */
  loanSchedules?: LoanSchedule[],
): JournalEntry[] {
  const entries: JournalEntry[] = []

  // 諸口科目を科目マスタから検索（無ければ 997 / 諸口 を既定とする）
  const shoguchi = accountMaster.find((a) =>
    a.name === '諸口' || a.shortName === '諸口' || a.code === '997'
  )
  const shoguchiCode = shoguchi?.code || '997'
  const shoguchiName = shoguchi?.shortName || shoguchi?.name || '諸口'

  // 内訳列の科目名（"コード:名前" 形式または名前）から科目マスタを検索
  const matchExtraAccount = (extraName: string): AccountItem | undefined => {
    const codeMatch = extraName.match(/^\s*(\d+)\s*[:：]\s*/)
    const cleanName = codeMatch ? extraName.slice(codeMatch[0].length).trim() : extraName.trim()
    let acc: AccountItem | undefined
    if (codeMatch) acc = accountMaster.find((a) => a.code === codeMatch[1])
    if (!acc && cleanName) {
      acc = accountMaster.find((a) => {
        const n = a.name || '', sn = a.shortName || ''
        if (n && (n === cleanName || n.includes(cleanName) || cleanName.includes(n))) return true
        if (sn && (sn === cleanName || sn.includes(cleanName) || cleanName.includes(sn))) return true
        return false
      })
    }
    return acc
  }

  for (const page of pages) {
    for (const tx of page.transactions) {
      // 入出金がどちらもない行はスキップ（残高のみの行）
      if (!tx.deposit && !tx.withdrawal) continue

      const isDeposit = (tx.deposit ?? 0) > 0
      const amount = isDeposit ? tx.deposit! : tx.withdrawal!

      // 借入金の返済: 予定表に「同じころの日付・同じ償還額」の回があれば、元本と利息に分ける。
      // 内訳は通帳のどこにも書いていないので、パターン学習では原理的に当てられない
      // （元利均等は毎回1円単位で配分が変わる）。予定表が当たったときは予定表を優先する。
      const loan = !isDeposit && loanSchedules && loanSchedules.length
        ? findLoanRepayment(loanSchedules, tx.date, amount)
        : null
      if (loan) {
        entries.push(...buildLoanEntries(
          tx, loan, accountCode, accountName, accountSubCode, accountSubName,
          shoguchiCode, shoguchiName,
        ))
        continue
      }

      // 学習パターンから科目を推定（金額も考慮）
      // 入金/出金の方向も渡し、出金（借方）で学習したパターンが同じ摘要の入金（貸方）に
      // 流用されないようにする（借方学習と貸方学習の分離）
      const pattern = findPattern(patterns, tx.description, amount, accountCode, isDeposit ? 'deposit' : 'withdrawal')

      let entry: JournalEntry

      // パターンの最初の行から科目情報を取得
      const pLine = pattern?.lines?.[0]
      const pDebitCode = pLine?.debitCode || pattern?.debitCode || ''
      const pDebitName = pLine?.debitName || pattern?.debitName || ''
      const pDebitSubCode = pLine?.debitSubCode || ''
      const pDebitSubName = pLine?.debitSubName || ''
      const pCreditCode = pLine?.creditCode || pattern?.creditCode || ''
      const pCreditName = pLine?.creditName || pattern?.creditName || ''
      const pCreditSubCode = pLine?.creditSubCode || ''
      const pCreditSubName = pLine?.creditSubName || ''
      const pTaxCode = pLine?.taxCode || pattern?.taxCode || ''
      const pTaxCategory = pLine?.taxCategory || pattern?.taxCategory || ''
      const pTaxRate = pLine?.taxRate || ''
      const pBusinessType = pLine?.businessType || pattern?.businessType || ''
      const isCompoundPattern = pattern?.lines && pattern.lines.length > 1

      // 内訳列の扱い: 2つ以上に数字があるときだけ「諸口経由の複合仕訳」にする。
      // 1つしか数字が無いときは複合にせず、その内訳科目を相手科目とした通常の単一仕訳にする。
      const breakdownCompound = !!(tx.extras && tx.extras.length > 1) && !isCompoundPattern
      const singleExtra = (tx.extras && tx.extras.length === 1 && !isCompoundPattern) ? tx.extras[0] : null
      const singleExtraAcc = singleExtra ? matchExtraAccount(singleExtra.name) : undefined
      const singleExtraName = singleExtra
        ? (singleExtraAcc?.shortName || singleExtraAcc?.name || (() => { const m = singleExtra.name.match(/^\s*(\d+)\s*[:：]\s*/); return m ? singleExtra.name.slice(m[0].length).trim() : singleExtra.name.trim() })())
        : ''

      if (isCompoundPattern && pLine) {
        // 複合仕訳パターン: パターン全体の科目コードをそのまま使う
        entry = createEntry(tx, {
          debitCode: pLine.debitCode,
          debitName: pLine.debitName,
          debitAmount: amount,
          creditCode: pLine.creditCode,
          creditName: pLine.creditName,
          creditAmount: amount,
          taxCode: pTaxCode,
          taxCategory: pTaxCategory,
          taxRate: pTaxRate,
          businessType: pBusinessType,
        })
      } else if (isDeposit) {
        // 内訳列が2つ以上ある場合: 親仕訳は「通帳 / 諸口」とし、通帳側の動きは取引金額ジャストにする
        const useShoguchi = breakdownCompound
        const counterCode = useShoguchi ? shoguchiCode
          : singleExtra ? (singleExtraAcc?.code || '')
          : pattern ? (pCreditCode !== accountCode ? pCreditCode : pDebitCode !== accountCode ? pDebitCode : '') : ''
        const counterName = useShoguchi ? shoguchiName
          : singleExtra ? singleExtraName
          : pattern ? (pCreditCode !== accountCode ? pCreditName : pDebitCode !== accountCode ? pDebitName : '') : ''
        entry = createEntry(tx, {
          debitCode: accountCode,
          debitName: accountName,
          debitAmount: amount,
          creditCode: counterCode,
          creditName: counterName,
          creditAmount: amount,
          taxCode: useShoguchi ? '' : pTaxCode,
          taxCategory: useShoguchi ? '' : pTaxCategory,
          taxRate: useShoguchi ? '' : pTaxRate,
          businessType: useShoguchi ? '' : pBusinessType,
        })
      } else {
        const useShoguchi = breakdownCompound
        const counterCode = useShoguchi ? shoguchiCode
          : singleExtra ? (singleExtraAcc?.code || '')
          : pattern ? (pDebitCode !== accountCode ? pDebitCode : pCreditCode !== accountCode ? pCreditCode : '') : ''
        const counterName = useShoguchi ? shoguchiName
          : singleExtra ? singleExtraName
          : pattern ? (pDebitCode !== accountCode ? pDebitName : pCreditCode !== accountCode ? pCreditName : '') : ''
        entry = createEntry(tx, {
          debitCode: counterCode,
          debitName: counterName,
          debitAmount: amount,
          creditCode: accountCode,
          creditName: accountName,
          creditAmount: amount,
          taxCode: useShoguchi ? '' : (pattern?.taxCode || ''),
          taxCategory: useShoguchi ? '' : pTaxCategory,
          taxRate: useShoguchi ? '' : pTaxRate,
          businessType: useShoguchi ? '' : pBusinessType,
        })
      }

      // アップロード時に指定された補助科目を通帳側（accountCode側）に設定
      if (accountSubCode) {
        if (entry.debitCode === accountCode) { entry.debitSubCode = accountSubCode; entry.debitSubName = accountSubName || '' }
        if (entry.creditCode === accountCode) { entry.creditSubCode = accountSubCode; entry.creditSubName = accountSubName || '' }
      }

      // パターンの変換後摘要・patternId・補助科目を適用
      if (pattern) {
        entry.patternId = pattern.id
        if (pattern.convertedDescription) {
          // 変換後摘要が明示的に設定されている場合
          if (pattern.matchType === 'exact' || pattern.replaceEntireDescription) {
            entry.description = pattern.convertedDescription
          } else {
            const mt = pattern.matchText || pattern.keyword
            entry.description = tx.description.replace(mt, pattern.convertedDescription)
          }
        } else if (pattern.useLineDescriptions && pLine?.description) {
          // 学習時に画面で直した摘要をそのまま再現する（行ごとに摘要が違う複合仕訳用）
          entry.description = pLine.description
        } else if (pattern.matchType === 'exact' && pattern.lines?.[0]?.description) {
          // 完全一致で変換後摘要なし → パターンの摘要を使用
          entry.description = pattern.lines[0].description
        }
        // 部分一致で変換後摘要なし → 元の摘要をそのまま保持
        // 備考列がある場合はパターン摘要の後に連結
        if (tx.memoText) {
          entry.description = `${entry.description}_${tx.memoText}`.slice(0, 40)
        }
        // 補助科目コードの反映（通帳口座側はアップロード設定を優先、相手科目側のみパターン適用）
        if (pDebitSubCode && entry.debitCode !== accountCode) { entry.debitSubCode = pDebitSubCode; entry.debitSubName = pDebitSubName }
        if (pCreditSubCode && entry.creditCode !== accountCode) { entry.creditSubCode = pCreditSubCode; entry.creditSubName = pCreditSubName }
      }

      entries.push(entry)

      // パターンが複合仕訳（複数行）の場合、追加行を生成
      if (pattern?.lines && pattern.lines.length > 1) {
        for (let li = 1; li < pattern.lines.length; li++) {
          const line = pattern.lines[li]
          const compoundEntry = createCompoundEntry(entry)
          compoundEntry.patternId = pattern.id
          compoundEntry.debitCode = line.debitCode
          compoundEntry.debitName = line.debitName
          compoundEntry.debitSubCode = line.debitSubCode || ''
          compoundEntry.debitSubName = line.debitSubName || ''
          compoundEntry.creditCode = line.creditCode
          compoundEntry.creditName = line.creditName
          compoundEntry.creditSubCode = line.creditSubCode || ''
          compoundEntry.creditSubName = line.creditSubName || ''
          compoundEntry.debitTaxCode = line.taxCode
          compoundEntry.debitTaxType = line.taxCategory
          if (line.taxRate) compoundEntry.debitTaxRate = line.taxRate
          compoundEntry.debitBusinessType = line.businessType
          // 行ごとの摘要を学習しているときは各行の摘要を使う。
          // そうでなければ従来どおり1行目（変換後摘要を適用済み）と同じ摘要にそろえる
          compoundEntry.description = (pattern.useLineDescriptions && line.description)
            ? line.description
            : entry.description
          compoundEntry.originalDescription = tx.description
          // パターンの学習時金額を復元
          compoundEntry.debitAmount = line.amount || 0
          compoundEntry.creditAmount = line.amount || 0
          entries.push(compoundEntry)
        }
      }

      // 追加列から複合仕訳を生成（家賃収入/預り敷金等の内訳列）
      // パターンが複合仕訳（複数行）の場合はパターン側で処理済みなのでスキップ
      // 親仕訳は「通帳 ↔ 諸口」で全額1件、子仕訳は「諸口 ↔ 各科目」とすることで
      // 通帳の動きが内訳数だけ増えるのを防ぎ、実際の通帳推移と一致させる。
      if (breakdownCompound && tx.extras) {
        for (const extra of tx.extras) {
          const compEntry = createCompoundEntry(entry)
          compEntry.description = entry.description
          compEntry.originalDescription = entry.originalDescription
          // 科目マスタから検索
          // 1) extra.name の先頭に "コード:" が付いていればコードで厳密一致
          // 2) なければ name/shortName で名前一致（空文字の誤マッチを防ぐためのガード入り）
          const codeMatch = extra.name.match(/^\s*(\d+)\s*[:：]\s*/)
          const cleanName = codeMatch ? extra.name.slice(codeMatch[0].length).trim() : extra.name.trim()
          let matchedAcc: AccountItem | undefined
          if (codeMatch) {
            matchedAcc = accountMaster.find((a) => a.code === codeMatch[1])
          }
          if (!matchedAcc && cleanName) {
            matchedAcc = accountMaster.find((a) => {
              const n = a.name || ''
              const sn = a.shortName || ''
              if (n && (n === cleanName || n.includes(cleanName) || cleanName.includes(n))) return true
              if (sn && (sn === cleanName || sn.includes(cleanName) || cleanName.includes(sn))) return true
              return false
            })
          }
          if (extra.direction === 'credit') {
            // 収入系内訳: 借方 諸口 / 貸方 該当科目
            compEntry.debitCode = shoguchiCode
            compEntry.debitName = shoguchiName
            compEntry.creditCode = matchedAcc?.code || ''
            compEntry.creditName = matchedAcc?.shortName || matchedAcc?.name || cleanName
          } else {
            // 返金・相殺系内訳: 借方 該当科目 / 貸方 諸口
            compEntry.debitCode = matchedAcc?.code || ''
            compEntry.debitName = matchedAcc?.shortName || matchedAcc?.name || cleanName
            compEntry.creditCode = shoguchiCode
            compEntry.creditName = shoguchiName
          }
          compEntry.debitAmount = extra.amount
          compEntry.creditAmount = extra.amount
          entries.push(compEntry)
        }
      }
    }
  }

  return entries
}

/**
 * 返済予定表から、1回分の返済の仕訳を組み立てる。
 *
 * 元本と利息の両方があるときは「諸口」を経由した複合仕訳にする。
 * 親を「諸口 / 通帳」で償還額まるごとにすることで、**通帳側の動きは1回だけ**になり、
 * 実際の通帳の残高推移と一致する（内訳列の複合仕訳と同じ形）。
 * 据置期間中のように片方しか無い回は、諸口を挟まずそのまま1本の仕訳にする。
 */
function buildLoanEntries(
  tx: BankTransaction,
  loan: { schedule: LoanSchedule; row: { total: number; principal: number; interest: number } },
  accountCode: string, accountName: string,
  accountSubCode: string | undefined, accountSubName: string | undefined,
  shoguchiCode: string, shoguchiName: string,
): JournalEntry[] {
  const s = loan.schedule
  const legs = [
    {
      code: s.principalCode, name: s.principalName,
      sub: s.principalSubCode, subName: s.principalSubName, amount: loan.row.principal,
    },
    {
      code: s.interestCode, name: s.interestName,
      sub: s.interestSubCode, subName: s.interestSubName, amount: loan.row.interest,
    },
  ].filter((l) => l.amount > 0)
  const blank = { taxCode: '', taxCategory: '', businessType: '' }
  const out: JournalEntry[] = []

  if (legs.length === 1) {
    const l = legs[0]
    const e = createEntry(tx, {
      debitCode: l.code, debitName: l.name, debitAmount: l.amount,
      creditCode: accountCode, creditName: accountName, creditAmount: l.amount, ...blank,
    })
    e.debitSubCode = l.sub || ''
    e.debitSubName = l.subName || ''
    if (accountSubCode) { e.creditSubCode = accountSubCode; e.creditSubName = accountSubName || '' }
    e.loanScheduleId = s.id
    return [e]
  }

  const parent = createEntry(tx, {
    debitCode: shoguchiCode, debitName: shoguchiName, debitAmount: loan.row.total,
    creditCode: accountCode, creditName: accountName, creditAmount: loan.row.total, ...blank,
  })
  if (accountSubCode) { parent.creditSubCode = accountSubCode; parent.creditSubName = accountSubName || '' }
  parent.loanScheduleId = s.id
  out.push(parent)

  for (const l of legs) {
    const c = createCompoundEntry(parent)
    c.debitCode = l.code
    c.debitName = l.name
    c.debitSubCode = l.sub || ''
    c.debitSubName = l.subName || ''
    c.creditCode = shoguchiCode
    c.creditName = shoguchiName
    c.debitAmount = l.amount
    c.creditAmount = l.amount
    c.originalDescription = tx.description
    c.loanScheduleId = s.id
    out.push(c)
  }
  return out
}

interface EntryParams {
  debitCode: string
  debitName: string
  debitAmount: number
  creditCode: string
  creditName: string
  creditAmount: number
  taxCode: string
  taxCategory: string
  taxRate?: string
  businessType: string
}

function createEntry(tx: BankTransaction, params: EntryParams): JournalEntry {
  return {
    id: generateEntryId(),
    transactionId: tx.id,
    date: tx.date.replace(/-/g, ''),
    debitCode: params.debitCode,
    debitName: params.debitName,
    debitSubCode: '',
    debitSubName: '',
    debitTaxType: '',
    debitIndustry: '',
    debitTaxInclude: '',
    debitAmount: params.debitAmount,
    debitTaxAmount: 0,
    debitTaxCode: params.taxCode,
    debitTaxRate: params.taxRate || '',
    debitBusinessType: params.businessType,
    creditCode: params.creditCode,
    creditName: params.creditName,
    creditSubCode: '',
    creditSubName: '',
    creditTaxType: '',
    creditIndustry: '',
    creditTaxInclude: '',
    creditAmount: params.creditAmount,
    creditTaxAmount: 0,
    creditTaxCode: params.taxCode,
    creditTaxRate: '',
    creditBusinessType: params.businessType,
    description: tx.description,
    originalDescription: tx.description,
    isCompound: false,
    parentId: null,
  }
}

/**
 * 空白の仕訳行を作成する
 */
export function createBlankEntry(afterEntryId?: string): JournalEntry {
  return {
    id: generateEntryId(),
    transactionId: null,
    date: '',
    debitCode: '',
    debitName: '',
    debitSubCode: '',
    debitSubName: '',
    debitTaxType: '',
    debitIndustry: '',
    debitTaxInclude: '',
    debitAmount: 0,
    debitTaxAmount: 0,
    debitTaxCode: '',
    debitTaxRate: '',
    debitBusinessType: '',
    creditCode: '',
    creditName: '',
    creditSubCode: '',
    creditSubName: '',
    creditTaxType: '',
    creditIndustry: '',
    creditTaxInclude: '',
    creditAmount: 0,
    creditTaxAmount: 0,
    creditTaxCode: '',
    creditTaxRate: '',
    creditBusinessType: '',
    description: '',
    originalDescription: '',
    isCompound: false,
    parentId: null,
  }
}

/**
 * 複合仕訳の追加行を作成する
 */
export function createCompoundEntry(parentEntry: JournalEntry): JournalEntry {
  return {
    ...createBlankEntry(),
    transactionId: parentEntry.transactionId,
    date: parentEntry.date,
    naibuMonth: parentEntry.naibuMonth, // 決算月の複合仕訳は子行も同じ内部月にする
    description: parentEntry.description,
    isCompound: true,
    parentId: parentEntry.id,
  }
}
