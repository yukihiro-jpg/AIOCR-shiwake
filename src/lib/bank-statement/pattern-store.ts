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
  // Firebase 自動同期: クライアント選択中のみ debounce 付きで Push
  const cid = getSelectedClientId()
  if (cid) {
    import('./firebase-sync').then(({ schedulePushToFirebase }) => {
      schedulePushToFirebase(cid, 'patterns', patterns)
    }).catch(() => { /* 合言葉未設定でもローカル保存は成功 */ })
  }
}

/**
 * Drive から取得したパターンとローカルのパターンをマージしてローカルに反映。
 * - 両者にあるパターンは useCount が大きい方 + updatedAt が新しい方を採用
 * - 片方にしかないものは両方とも残す
 */
export function mergePatternsFromDrive(remote: PatternEntry[]): { added: number; updated: number } {
  if (typeof window === 'undefined') return { added: 0, updated: 0 }
  const local = getPatterns()
  const map = new Map<string, PatternEntry>()
  for (const p of local) map.set(p.id, p)
  let added = 0
  let updated = 0
  for (const r of remote) {
    const existing = map.get(r.id)
    if (!existing) {
      map.set(r.id, r); added++
    } else {
      // 使用回数が多い方をベース、より新しい lines を採用
      const useCount = Math.max(existing.useCount, r.useCount)
      const merged: PatternEntry = { ...existing, ...r, useCount }
      if (JSON.stringify(existing) !== JSON.stringify(merged)) updated++
      map.set(r.id, merged)
    }
  }
  const result = Array.from(map.values())
  localStorage.setItem(getPatternKey(), JSON.stringify(result))
  return { added, updated }
}

// 学習パターンの方向（借方学習/貸方学習の分離用）
// - 'withdrawal': 出金取引（貸方=通帳口座）から学習 → 相手科目は借方側
// - 'deposit'  : 入金取引（借方=通帳口座）から学習 → 相手科目は貸方側
export type PatternSide = 'deposit' | 'withdrawal'

/**
 * パターンが入金・出金どちらの取引から学習されたかを判定する。
 * 1行目（lines[0]）の借方/貸方どちらに通帳口座コードがあるかで判定し、
 * どちらとも判定できないパターン（クレカ等の口座非依存・旧形式）は
 * null（方向制約なし）を返す。
 */
export function getPatternSide(p: PatternEntry, accountCode?: string): PatternSide | null {
  const acct = p.accountCode || accountCode
  if (!acct) return null
  const l0 = p.lines?.[0]
  const debit = l0 ? l0.debitCode : (p.debitCode || '')
  const credit = l0 ? l0.creditCode : (p.creditCode || '')
  if (credit === acct && debit !== acct) return 'withdrawal'
  if (debit === acct && credit !== acct) return 'deposit'
  return null
}

/** 仕訳行の方向: 借方=通帳口座なら入金、貸方=通帳口座なら出金。判定不能は null */
export function getEntrySide(e: JournalEntry | undefined, accountCode?: string): PatternSide | null {
  if (!e || !accountCode) return null
  if (e.creditCode === accountCode && e.debitCode !== accountCode) return 'withdrawal'
  if (e.debitCode === accountCode && e.creditCode !== accountCode) return 'deposit'
  return null
}

// 2つの方向が矛盾しないか（どちらかが不明なら許容＝旧パターン互換）
function sideCompatible(a: PatternSide | null, b: PatternSide | null): boolean {
  return !a || !b || a === b
}

/**
 * 摘要と金額からパターンを検索
 */
export function findPattern(
  patterns: PatternEntry[],
  description: string,
  amount?: number,
  accountCode?: string,
  side?: PatternSide,
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
      // 方向スコープ: 出金（借方学習）のパターンは出金にのみ、入金（貸方学習）の
      // パターンは入金にのみ適用する（同じ摘要でも借方学習が貸方に影響しないように分離）。
      // 方向が判定できないパターンは従来どおり両方向にマッチする。
      if (side) {
        const pSide = getPatternSide(p, accountCode)
        if (pSide && pSide !== side) return false
      }
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
    taxRate: e.debitTaxRate || "",
    businessType: e.debitBusinessType,
    description: e.description,
    amount: e.debitAmount || e.creditAmount || 0,
  }))

  // 同じキーワード+金額範囲+方向のパターンがあれば更新、なければ新規
  // （出金で学習したパターンを入金の学習が上書きしないよう、方向が食い違う場合は別パターンにする）
  const groupSide = getEntrySide(entries[0], accountCode)
  const existing = patterns.find(
    (p) => p.keyword.toLowerCase() === originalDescription.toLowerCase() &&
      p.amountMin === amountMin && p.amountMax === amountMax &&
      (p.accountCode || '') === (accountCode || '') &&
      sideCompatible(getPatternSide(p, accountCode), groupSide),
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
    taxRate: e.debitTaxRate || "",
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
    taxRate: e.debitTaxRate || "",
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

    // 同じキーワード+科目コード+金額範囲+方向のパターンがあれば更新
    // （出金で学習したパターンを入金の一括学習が上書きしないよう、方向が食い違う場合は別パターンにする）
    const groupSide = getEntrySide(primary, accountCode)
    const existing = patterns.find(
      (p) => p.keyword.toLowerCase() === originalDesc.toLowerCase() &&
        (p.accountCode || '') === (accountCode || '') &&
        isAmountInRange(amount, p.amountMin, p.amountMax) &&
        sideCompatible(getPatternSide(p, accountCode), groupSide),
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
