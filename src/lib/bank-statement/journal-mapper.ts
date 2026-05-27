import type {
  BankTransaction,
  JournalEntry,
  StatementPage,
  PatternEntry,
  AccountItem,
} from './types'
import { findPattern } from './pattern-store'

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
): JournalEntry[] {
  const entries: JournalEntry[] = []

  for (const page of pages) {
    for (const tx of page.transactions) {
      // 入出金がどちらもない行はスキップ（残高のみの行）
      if (!tx.deposit && !tx.withdrawal) continue

      const isDeposit = (tx.deposit ?? 0) > 0
      const amount = isDeposit ? tx.deposit! : tx.withdrawal!

      // 学習パターンから科目を推定（金額も考慮）
      const pattern = findPattern(patterns, tx.description, amount, accountCode)

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
        const counterCode = pattern ? (pCreditCode !== accountCode ? pCreditCode : pDebitCode !== accountCode ? pDebitCode : '') : ''
        const counterName = pattern ? (pCreditCode !== accountCode ? pCreditName : pDebitCode !== accountCode ? pDebitName : '') : ''
        entry = createEntry(tx, {
          debitCode: accountCode,
          debitName: accountName,
          debitAmount: amount,
          creditCode: counterCode,
          creditName: counterName,
          creditAmount: amount,
          taxCode: pTaxCode,
          taxCategory: pTaxCategory,
          taxRate: pTaxRate,
          businessType: pBusinessType,
        })
      } else {
        const counterCode = pattern ? (pDebitCode !== accountCode ? pDebitCode : pCreditCode !== accountCode ? pCreditCode : '') : ''
        const counterName = pattern ? (pDebitCode !== accountCode ? pDebitName : pCreditCode !== accountCode ? pCreditName : '') : ''
        entry = createEntry(tx, {
          debitCode: counterCode,
          debitName: counterName,
          debitAmount: amount,
          creditCode: accountCode,
          creditName: accountName,
          creditAmount: amount,
          taxCode: pattern?.taxCode || '',
          taxCategory: pTaxCategory,
          taxRate: pTaxRate,
          businessType: pBusinessType,
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
          if (pattern.matchType === 'exact') {
            entry.description = pattern.convertedDescription
          } else {
            const mt = pattern.matchText || pattern.keyword
            entry.description = tx.description.replace(mt, pattern.convertedDescription)
          }
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
          // 複合仕訳の各行も、1行目（変換後摘要を適用済み）と同じ摘要にそろえる
          compoundEntry.description = entry.description
          compoundEntry.originalDescription = tx.description
          // パターンの学習時金額を復元
          compoundEntry.debitAmount = line.amount || 0
          compoundEntry.creditAmount = line.amount || 0
          entries.push(compoundEntry)
        }
      }

      // 追加列から複合仕訳を生成（家賃収入/預り敷金等の内訳列）
      // パターンが複合仕訳（複数行）の場合はパターン側で処理済みなのでスキップ
      if (tx.extras && tx.extras.length > 0 && !(pattern?.lines && pattern.lines.length > 1)) {
        for (const extra of tx.extras) {
          const compEntry = createCompoundEntry(entry)
          compEntry.description = entry.description
          compEntry.originalDescription = entry.originalDescription
          // 科目マスタから名前で検索
          const matchedAcc = accountMaster.find((a) =>
            a.name.includes(extra.name) || a.shortName.includes(extra.name) ||
            extra.name.includes(a.name) || extra.name.includes(a.shortName)
          )
          if (extra.direction === 'credit') {
            compEntry.creditCode = matchedAcc?.code || ''
            compEntry.creditName = matchedAcc?.shortName || matchedAcc?.name || extra.name
            compEntry.debitCode = accountCode
            compEntry.debitName = accountName
          } else {
            compEntry.debitCode = matchedAcc?.code || ''
            compEntry.debitName = matchedAcc?.shortName || matchedAcc?.name || extra.name
            compEntry.creditCode = accountCode
            compEntry.creditName = accountName
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
    description: parentEntry.description,
    isCompound: true,
    parentId: parentEntry.id,
  }
}
