import type { PatternEntry, PatternLine, JournalEntry } from './types'
import { clientStorageKey, getSelectedClientId } from './client-store'

function getPatternKey(): string {
  const cid = getSelectedClientId()
  return cid ? clientStorageKey(cid, 'patterns') : 'bank-statement-patterns'
}

let idCounter = 0
function generatePatternId(): string {
  return `pat-${Date.now()}-${++idCounter}`
}

export function getPatterns(): PatternEntry[] {
  if (typeof window === 'undefined') return []
  try {
    const stored = localStorage.getItem(getPatternKey())
    if (stored) {
      const parsed = JSON.parse(stored)
      // 旧形式からの変換
      return parsed.map((p: PatternEntry) => {
        if (!p.id) p.id = generatePatternId()
        if (!p.lines) {
          p.lines = [{
            debitCode: p.debitCode || '',
            debitName: p.debitName || '',
            creditCode: p.creditCode || '',
            creditName: p.creditName || '',
            taxCode: p.taxCode || '',
            taxCategory: p.taxCategory || '',
            businessType: p.businessType || '',
            description: p.convertedDescription || '',
            amount: 0,
          }]
        }
        // 旧データでamountが無い行に0を設定
        p.lines = p.lines.map((l) => ({ ...l, amount: l.amount ?? 0 }))
        if (p.amountMin === undefined) p.amountMin = null
        if (p.amountMax === undefined) p.amountMax = null
        return p
      })
    }
  } catch { /* ignore */ }
  return []
}

export function savePatterns(patterns: PatternEntry[]): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(getPatternKey(), JSON.stringify(patterns))
}

/**
 * 摘要と金額からパターンを検索
 */
export function findPattern(
  patterns: PatternEntry[],
  description: string,
  amount?: number,
  accountCode?: string,
): PatternEntry | null {
  if (!description) return null
  const desc = description.toLowerCase()

  const matches = patterns
    .filter((p) => {
      // 科目スコープ: パターンに accountCode が設定されている場合は、
      // 現在の口座科目と一致する場合のみマッチ対象とする。
      // （例：136筑波銀行で学習したパターンが144千葉銀行に誤適用されないように）
      // accountCode を持たない（旧式・口座非依存）パターンは引き続き全口座にマッチする。
      if (p.accountCode && accountCode && p.accountCode !== accountCode) return false
      const matchText = (p.matchText || p.keyword).toLowerCase()
      const isExact = p.matchType === 'exact'
      let keyMatch: boolean
      if (isExact) {
        keyMatch = desc === matchText
      } else {
        // 部分一致: 摘要がマッチテキストを含む or マッチテキストが摘要を含む
        keyMatch = desc.includes(matchText) || matchText.includes(desc)
      }
      if (!keyMatch) return false
      if (amount != null) {
        if (p.amountMin != null && amount < p.amountMin) return false
        if (p.amountMax != null && amount > p.amountMax) return false
      }
      return true
    })
    .sort((a, b) => {
      // 同一科目コードのパターンを最優先
      if (accountCode) {
        const aMatch = a.accountCode === accountCode ? 1 : 0
        const bMatch = b.accountCode === accountCode ? 1 : 0
        if (aMatch !== bMatch) return bMatch - aMatch
      }
      // 完全一致パターンを部分一致より優先
      const aExactType = a.matchType === 'exact' ? 1 : 0
      const bExactType = b.matchType === 'exact' ? 1 : 0
      if (aExactType !== bExactType) return bExactType - aExactType
      // マッチテキストが長い方を優先（より具体的なパターン）
      const aLen = (a.matchText || a.keyword).length
      const bLen = (b.matchText || b.keyword).length
      if (aLen !== bLen) return bLen - aLen
      const aRange = (a.amountMax ?? Infinity) - (a.amountMin ?? 0)
      const bRange = (b.amountMax ?? Infinity) - (b.amountMin ?? 0)
      if (aRange !== bRange) return aRange - bRange
      return b.useCount - a.useCount
    })

  return matches.length > 0 ? matches[0] : null
}

/**
 * 仕訳行からパターンを学習（金額範囲指定版）
 */
export function learnFromEntriesWithRange(
  originalDescription: string,
  entries: JournalEntry[],
  amountMin: number | null,
  amountMax: number | null,
  accountCode?: string,
): string {
  if (!originalDescription || entries.length === 0) return ''

  const patterns = getPatterns()
  const lines: PatternLine[] = entries.map((e) => ({
    debitCode: e.debitCode,
    debitName: e.debitName,
    debitSubCode: e.debitSubCode || '',
    debitSubName: e.debitSubName || '',
    creditCode: e.creditCode,
    creditName: e.creditName,
    creditSubCode: e.creditSubCode || '',
    creditSubName: e.creditSubName || '',
    taxCode: e.debitTaxCode,
    taxCategory: e.debitTaxType,
    businessType: e.debitBusinessType,
    description: e.description,
    amount: e.debitAmount || e.creditAmount || 0,
  }))

  // 同じキーワード+金額範囲のパターンがあれば更新、なければ新規
  const existing = patterns.find(
    (p) => p.keyword.toLowerCase() === originalDescription.toLowerCase() &&
      p.amountMin === amountMin && p.amountMax === amountMax &&
      (p.accountCode || '') === (accountCode || ''),
  )

  if (existing) {
    existing.useCount++
    existing.lines = lines
    savePatterns(patterns)
    return existing.id
  } else {
    const id = generatePatternId()
    patterns.push({
      id,
      keyword: originalDescription,
      amountMin,
      amountMax,
      accountCode: accountCode || undefined,
      lines,
      useCount: 1,
    })
    savePatterns(patterns)
    return id
  }
}

/**
 * 仕訳行からパターンを学習（1行 or 複合仕訳の複数行）
 */
export function learnFromEntries(
  originalDescription: string,
  entries: JournalEntry[],
  amount: number,
): void {
  if (!originalDescription || entries.length === 0) return

  const patterns = getPatterns()

  const lines: PatternLine[] = entries.map((e) => ({
    debitCode: e.debitCode,
    debitName: e.debitName,
    debitSubCode: e.debitSubCode || '',
    debitSubName: e.debitSubName || '',
    creditCode: e.creditCode,
    creditName: e.creditName,
    creditSubCode: e.creditSubCode || '',
    creditSubName: e.creditSubName || '',
    taxCode: e.debitTaxCode,
    taxCategory: e.debitTaxType,
    businessType: e.debitBusinessType,
    description: e.description,
    amount: e.debitAmount || e.creditAmount || 0,
  }))

  // 同じキーワードで金額範囲が重なるパターンがあれば更新
  const existing = patterns.find(
    (p) => p.keyword.toLowerCase() === originalDescription.toLowerCase() &&
      isAmountInRange(amount, p.amountMin, p.amountMax),
  )

  if (existing) {
    existing.useCount++
    existing.lines = lines
  } else {
    patterns.push({
      id: generatePatternId(),
      keyword: originalDescription,
      amountMin: null,
      amountMax: null,
      lines,
      useCount: 1,
    })
  }

  savePatterns(patterns)
}

/**
 * CSV出力/一時保存時に全仕訳を一括パターン学習
 * パターン学習済みの仕訳でもユーザーが修正した場合は上書きする
 */
export function learnAllFromEntries(entries: JournalEntry[], accountCode?: string): number {
  let learnedCount = 0

  // transactionIdでグループ化（複合仕訳対応）
  const groups: Record<string, JournalEntry[]> = {}
  for (const e of entries) {
    const groupId = e.parentId || e.id
    if (!groups[groupId]) groups[groupId] = []
    groups[groupId].push(e)
  }

  // パターン配列を1つだけ読み込み、全操作をこの配列上で行う
  const patterns = getPatterns()

  for (const [, group] of Object.entries(groups)) {
    const primary = group[0]
    const originalDesc = primary.originalDescription
    if (!originalDesc) continue
    const amount = primary.debitAmount || primary.creditAmount || 0

    const lines: PatternLine[] = group.map((e) => ({
      debitCode: e.debitCode,
      debitName: e.debitName,
      debitSubCode: e.debitSubCode || '',
      debitSubName: e.debitSubName || '',
      creditCode: e.creditCode,
      creditName: e.creditName,
      creditSubCode: e.creditSubCode || '',
      creditSubName: e.creditSubName || '',
      taxCode: e.debitTaxCode,
      taxCategory: e.debitTaxType,
      businessType: e.debitBusinessType,
      description: e.description,
      amount: e.debitAmount || e.creditAmount || 0,
    }))

    // 既存パターンと内容が同じかチェック
    if (primary.patternId) {
      const existingPattern = patterns.find((p) => p.id === primary.patternId)
      if (existingPattern) {
        const isSame = existingPattern.lines.length === group.length &&
          existingPattern.lines.every((line, i) =>
            line.debitCode === group[i].debitCode &&
            line.creditCode === group[i].creditCode &&
            (line.debitSubCode || '') === (group[i].debitSubCode || '') &&
            (line.creditSubCode || '') === (group[i].creditSubCode || '') &&
            line.description === group[i].description &&
            line.taxCode === group[i].debitTaxCode &&
            line.businessType === group[i].debitBusinessType
          )
        if (isSame) {
          existingPattern.useCount++
          continue
        }
        // 内容が変わっている → 上書き
        existingPattern.lines = lines
        existingPattern.useCount++
        learnedCount++
        continue
      }
    }

    // 同じキーワード+科目コード+金額範囲のパターンがあれば更新
    const existing = patterns.find(
      (p) => p.keyword.toLowerCase() === originalDesc.toLowerCase() &&
        (p.accountCode || '') === (accountCode || '') &&
        isAmountInRange(amount, p.amountMin, p.amountMax),
    )
    if (existing) {
      existing.lines = lines
      existing.useCount++
    } else {
      patterns.push({
        id: generatePatternId(),
        keyword: originalDesc,
        amountMin: null,
        amountMax: null,
        accountCode: accountCode || undefined,
        lines,
        useCount: 1,
      })
    }
    learnedCount++
  }

  // 全操作完了後に1回だけ保存（上書き競合なし）
  savePatterns(patterns)
  return learnedCount
}

// 旧互換: learnPattern関数
export function learnPattern(
  originalDescription: string,
  convertedDescription: string,
  debitCode: string,
  debitName: string,
  creditCode: string,
  creditName: string,
  taxCode: string,
  taxCategory: string,
  businessType: string,
): void {
  const patterns = getPatterns()
  const existing = patterns.find(
    (p) => p.keyword.toLowerCase() === originalDescription.toLowerCase(),
  )

  const line: PatternLine = {
    debitCode, debitName, creditCode, creditName,
    taxCode, taxCategory, businessType,
    description: convertedDescription,
    amount: 0,
  }

  if (existing) {
    existing.useCount++
    existing.lines = [line]
  } else {
    patterns.push({
      id: generatePatternId(),
      keyword: originalDescription,
      amountMin: null,
      amountMax: null,
      lines: [line],
      useCount: 1,
    })
  }

  savePatterns(patterns)
}

export function deletePattern(id: string): void {
  const patterns = getPatterns().filter((p) => p.id !== id)
  savePatterns(patterns)
}

export function updatePatternAmountRange(
  id: string,
  amountMin: number | null,
  amountMax: number | null,
): void {
  const patterns = getPatterns()
  const p = patterns.find((p) => p.id === id)
  if (p) {
    p.amountMin = amountMin
    p.amountMax = amountMax
    savePatterns(patterns)
  }
}

export function clearPatterns(): void {
  if (typeof window === 'undefined') return
  localStorage.removeItem(getPatternKey())
}

export function exportPatterns(): string {
  return JSON.stringify(getPatterns(), null, 2)
}

export function importPatterns(json: string): number {
  const imported: PatternEntry[] = JSON.parse(json)
  if (!Array.isArray(imported)) return 0
  savePatterns(imported)
  return imported.length
}

function isAmountInRange(amount: number, min: number | null, max: number | null): boolean {
  if (min != null && amount < min) return false
  if (max != null && amount > max) return false
  return true
}
