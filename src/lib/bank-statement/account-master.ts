import type { AccountItem, SubAccountItem, AccountTaxItem } from './types'
import { clientStorageKey, getSelectedClientId } from './client-store'

function getAccountKey(): string {
  const cid = getSelectedClientId()
  return cid ? clientStorageKey(cid, 'accounts') : 'bank-statement-account-master'
}

function getSubAccountKey(): string {
  const cid = getSelectedClientId()
  return cid ? clientStorageKey(cid, 'sub-accounts') : 'bank-statement-sub-account-master'
}

// --- 科目マスタ ---

export function loadAccountMaster(): AccountItem[] {
  if (typeof window === 'undefined') return []
  try {
    const stored = localStorage.getItem(getAccountKey())
    if (stored) return JSON.parse(stored)
  } catch { /* ignore */ }
  return []
}

export function saveAccountMaster(items: AccountItem[]): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(getAccountKey(), JSON.stringify(items))
}

/**
 * 科目チェックリストTSV/CSVをパース
 * 列: コード, 正式科目名, 簡略科目名, 連想, ..., 正残区分, BS/PL区分, ...
 */
export function parseAccountMasterFile(text: string): AccountItem[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim())
  if (lines.length === 0) return []

  const delimiter = detectDelimiter(lines[0])
  const startIndex = isHeaderLine(lines[0], ['コード', '科目', 'code']) ? 1 : 0

  const items: AccountItem[] = []
  for (let i = startIndex; i < lines.length; i++) {
    const cells = splitLine(lines[i], delimiter)
    if (cells.length < 2) continue
    const code = cells[0].trim()
    if (!code || !/^\d+$/.test(code)) continue // コードが数字でない行はスキップ

    items.push({
      code,
      name: cells[1]?.trim() || '',
      shortName: cells[2]?.trim() || cells[1]?.trim() || '',
      association: cells[3]?.trim() || '',
      normalBalance: cells[8]?.trim() || '',
      bsPl: cells[9]?.trim() || '',
    })
  }
  return items
}

// --- 補助科目マスタ ---

export function loadSubAccountMaster(): SubAccountItem[] {
  if (typeof window === 'undefined') return []
  try {
    const stored = localStorage.getItem(getSubAccountKey())
    if (stored) return JSON.parse(stored)
  } catch { /* ignore */ }
  return []
}

export function saveSubAccountMaster(items: SubAccountItem[]): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(getSubAccountKey(), JSON.stringify(items))
}

/**
 * 補助科目チェックリストTSV/CSVをパース
 * 列: 科目ｺｰﾄﾞ, 科目簡略名称, 科目別補助ｺｰﾄﾞ, 正式科目名, 簡略科目名, 連想, ...
 */
export function parseSubAccountMasterFile(text: string): SubAccountItem[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim())
  if (lines.length === 0) return []

  const delimiter = detectDelimiter(lines[0])
  const startIndex = isHeaderLine(lines[0], ['科目', 'ｺｰﾄﾞ', '補助', 'code']) ? 1 : 0

  const items: SubAccountItem[] = []
  for (let i = startIndex; i < lines.length; i++) {
    const cells = splitLine(lines[i], delimiter)
    if (cells.length < 4) continue
    const parentCode = cells[0].trim()
    if (!parentCode || !/^\d+$/.test(parentCode)) continue

    items.push({
      parentCode,
      parentName: cells[1]?.trim() || '',
      subCode: cells[2]?.trim() || '0',
      name: cells[3]?.trim() || '',
      shortName: cells[4]?.trim() || cells[3]?.trim() || '',
      association: cells[5]?.trim() || '',
    })
  }
  return items
}

// --- 検索 ---

export function searchAccounts(master: AccountItem[], query: string): AccountItem[] {
  if (!query) return master.slice(0, 20)
  const q = query.toLowerCase()
  return master
    .filter((item) =>
      item.code.includes(q) ||
      item.name.toLowerCase().includes(q) ||
      item.shortName.toLowerCase().includes(q) ||
      (item.association || '').toLowerCase().includes(q),
    )
    .slice(0, 15)
}

export function findAccountByCode(master: AccountItem[], code: string): AccountItem | undefined {
  return master.find((item) => item.code === code)
}

export function getSubAccountsForCode(subMaster: SubAccountItem[], parentCode: string): SubAccountItem[] {
  return subMaster.filter((item) => item.parentCode === parentCode)
}

// --- ユーティリティ ---

function detectDelimiter(line: string): string {
  const tabCount = (line.match(/\t/g) || []).length
  const commaCount = (line.match(/,/g) || []).length
  return tabCount >= commaCount ? '\t' : ','
}

function splitLine(line: string, delimiter: string): string[] {
  if (delimiter === '\t') return line.split('\t')
  // CSV: ダブルクォート対応
  const cells: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { current += '"'; i++ }
      else if (ch === '"') inQuotes = false
      else current += ch
    } else {
      if (ch === '"') inQuotes = true
      else if (ch === ',') { cells.push(current); current = '' }
      else current += ch
    }
  }
  cells.push(current)
  return cells
}

function isHeaderLine(line: string, keywords: string[]): boolean {
  const lower = line.toLowerCase()
  return keywords.some((k) => lower.includes(k.toLowerCase()))
}

// --- 科目別消費税登録マスタ ---

function getAccountTaxKey(): string {
  const cid = getSelectedClientId()
  return cid ? `bs-account-tax-${cid}` : 'bs-account-tax'
}

export function loadAccountTaxMaster(): AccountTaxItem[] {
  if (typeof window === 'undefined') return []
  try {
    const stored = localStorage.getItem(getAccountTaxKey())
    if (stored) return JSON.parse(stored)
  } catch { /* ignore */ }
  return []
}

export function saveAccountTaxMaster(items: AccountTaxItem[]): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(getAccountTaxKey(), JSON.stringify(items))
}

/**
 * 科目別消費税登録チェックリストTSV/CSVをパース
 * 列: A科目別補助区分, B科目コード, C科目名称, D科目区分, E科目名称,
 *     F仕入消費税コード, G仕入消費税名称, H仕入消費税率区分, I仕入消費税率,
 *     J売上消費税コード, K売上消費税名称, L売上消費税率区分, M売上消費税率, N売上消費税率
 */
export function parseAccountTaxMasterFile(text: string): AccountTaxItem[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim())
  if (lines.length === 0) return []

  const delimiter = detectDelimiter(lines[0])
  const startIndex = isHeaderLine(lines[0], ['科目', 'コード', 'ｺｰﾄﾞ', '消費税']) ? 1 : 0

  const items: AccountTaxItem[] = []
  // 診断: 最初の数行の cells を出力
  if (typeof window !== 'undefined') {
    console.log('[parseTax] startIndex=', startIndex, 'delimiter=', JSON.stringify(delimiter), 'totalLines=', lines.length)
    for (let k = 0; k < Math.min(3, lines.length - startIndex); k++) {
      const c = splitLine(lines[startIndex + k], delimiter)
      console.log(`[parseTax] line ${startIndex + k}: cells.length=${c.length}`, c)
    }
  }
  for (let i = startIndex; i < lines.length; i++) {
    const cells = splitLine(lines[i], delimiter)
    if (cells.length < 7) continue

    const subFlag = cells[0]?.trim() || ''
    const accountCode = cells[1]?.trim() || ''
    const accountName = cells[2]?.trim() || ''
    const categoryCode = cells[3]?.trim() || '0'
    const categoryName = cells[4]?.trim() || ''
    const purchaseTaxCode = cells[5]?.trim() || '0'
    const purchaseTaxName = cells[6]?.trim() || ''
    const purchaseTaxRate = cells[7]?.trim() || ''  // 税率区分（4=10%, 5=8%軽減 等）
    const salesTaxCode = cells[9]?.trim() || '0'
    const salesTaxName = cells[10]?.trim() || ''
    const salesTaxRate = cells[11]?.trim() || ''

    // +マーク行のみが科目の親行（補助科目行はスキップ）
    if (subFlag !== '+' && accountCode && /^\d+$/.test(accountCode)) {
      // 補助科目でない行（subFlagが空 or +）
      items.push({
        accountCode,
        accountName,
        categoryCode,
        categoryName,
        purchaseTaxCode,
        purchaseTaxName,
        purchaseTaxRate,
        salesTaxCode,
        salesTaxName,
        salesTaxRate,
      })
    } else if (subFlag === '+') {
      items.push({
        accountCode,
        accountName,
        categoryCode,
        categoryName,
        purchaseTaxCode,
        purchaseTaxName,
        purchaseTaxRate,
        salesTaxCode,
        salesTaxName,
        salesTaxRate,
      })
    }
  }
  return items
}

/**
 * 科目コードから消費税コードを取得
 * category: 1=売上, 2=仕入 で判定しコードを返す
 */
export function getDefaultTaxCode(
  accountTaxMaster: AccountTaxItem[],
  accountCode: string,
): { taxCode: string; taxName: string; taxRate?: string } | null {
  const item = accountTaxMaster.find((t) => t.accountCode === accountCode)
  if (!item) return null

  if (item.categoryCode === '1') {
    // 売上: 売上消費税コードを使用
    if (item.salesTaxCode && item.salesTaxCode !== '0') {
      return { taxCode: item.salesTaxCode, taxName: item.salesTaxName || '', taxRate: item.salesTaxRate }
    }
  }
  if (item.categoryCode === '2') {
    // 仕入: 仕入消費税コードを使用
    if (item.purchaseTaxCode && item.purchaseTaxCode !== '0') {
      return { taxCode: item.purchaseTaxCode, taxName: item.purchaseTaxName || '', taxRate: item.purchaseTaxRate }
    }
  }

  // 対象外や0の場合はnull
  return null
}
