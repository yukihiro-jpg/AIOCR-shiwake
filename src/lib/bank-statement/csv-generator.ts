import type { JournalEntry } from './types'

const CSV_HEADERS = [
  '伝票日付',                    // 1
  '(借方)勘定科目コード',          // 2
  '(借方)勘定科目名称',           // 3
  '(借方)科目別補助コード',        // 4
  '(借方)科目別補助名称',         // 5
  '(借方)消費税売上/仕入区分',     // 6
  '(借方)業種コード',             // 7
  '(借方)税込/税抜区分',          // 8
  '(貸方)勘定科目コード',          // 9
  '(貸方)勘定科目名称',           // 10
  '(貸方)科目別補助コード',        // 11
  '(貸方)科目別補助名称',         // 12
  '(貸方)消費税売上/仕入区分',     // 13
  '(貸方)業種コード',             // 14
  '(貸方)税込/税抜区分',          // 15
  '消費税コード',                 // 16
  '消費税率',                    // 17
  '事業者取引区分',               // 18
  '金額(入力金額)',               // 19
  '摘要',                       // 20
]

// 消費税売上/仕入区分を数値に変換 (0:なし, 1:売上, 2:仕入)
function taxCategoryToNum(taxType: string): string {
  if (!taxType) return '0'
  if (taxType.includes('売上') || taxType.includes('売')) return '1'
  if (taxType.includes('仕入') || taxType.includes('仕')) return '2'
  return '0'
}

// 課税取引かどうか判定（消費税CDが0/30/40/空でなければ課税）
function isTaxable(taxCode: string): boolean {
  if (!taxCode || taxCode === '0' || taxCode === '30' || taxCode === '40' || taxCode === '41') return false
  return true
}

function entryToRow(entry: JournalEntry, clientTaxType?: string): string[] {
  const debitIndustry = clientTaxType === 'simplified' ? (entry.debitIndustry || '0') : '0'
  const creditIndustry = clientTaxType === 'simplified' ? (entry.creditIndustry || '0') : '0'

  // 税込/税抜区分: 課税取引かつPL科目の側を1、それ以外は0
  const debitTaxCat = taxCategoryToNum(entry.debitTaxType)
  const creditTaxCat = taxCategoryToNum(entry.creditTaxType)
  const taxable = isTaxable(entry.debitTaxCode)
  // 課税取引で税区分の付いた側（売上/仕入いずれも）を税込=1にする。
  // 通常は借方=仕入・貸方=売上だが、賃金台帳の控除振替のように仕入科目が貸方に来る
  // ケースもあるため、区分が0でない側を税込とする（会計大将の「不明取引」防止）。
  const debitTaxInclude = taxable && debitTaxCat !== '0' ? '1' : '0'
  const creditTaxInclude = taxable && creditTaxCat !== '0' ? '1' : '0'

  return [
    entry.date,                                           // 1 伝票日付
    entry.debitCode,                                      // 2 借方勘定科目コード
    entry.debitName,                                      // 3 借方勘定科目名称
    entry.debitSubCode,                                   // 4 借方科目別補助コード
    entry.debitSubName,                                   // 5 借方科目別補助名称
    debitTaxCat,                                          // 6 借方消費税売上/仕入区分（数値）
    debitIndustry,                                        // 7 借方業種コード（数値）
    debitTaxInclude,                                      // 8 借方税込/税抜区分
    entry.creditCode,                                     // 9 貸方勘定科目コード
    entry.creditName,                                     // 10 貸方勘定科目名称
    entry.creditSubCode,                                  // 11 貸方科目別補助コード
    entry.creditSubName,                                  // 12 貸方科目別補助名称
    creditTaxCat,                                         // 13 貸方消費税売上/仕入区分（数値）
    creditIndustry,                                       // 14 貸方業種コード（数値）
    creditTaxInclude,                                     // 15 貸方税込/税抜区分
    entry.debitTaxCode || '0',                             // 16 消費税コード
    entry.debitTaxRate || '0',                             // 17 消費税率（数値）
    entry.debitBusinessType || '0',                        // 18 事業者取引区分
    entry.debitAmount ? String(entry.debitAmount) : '',     // 19 金額
    entry.description,                                     // 20 摘要
  ]
}

function escapeCsvField(field: string): string {
  if (field.includes(',') || field.includes('"') || field.includes('\n')) {
    return `"${field.replace(/"/g, '""')}"`
  }
  return field
}

/**
 * 複合仕訳の最終行の金額を997貸借一致で自動計算して適用する
 * CSV出力前、学習前に呼び出して金額を確定する
 */
// 複合仕訳で最も多く使われている諸口コードを推定
function detectShoguchiCode(entries: JournalEntry[]): string | null {
  const codeCount: Record<string, number> = {}
  for (const e of entries) {
    if (e.parentId || entries.some((c) => c.parentId === e.id)) {
      // 複合仕訳内の行
      if (e.debitName?.includes('諸口')) { codeCount[e.debitCode] = (codeCount[e.debitCode] || 0) + 1 }
      if (e.creditName?.includes('諸口')) { codeCount[e.creditCode] = (codeCount[e.creditCode] || 0) + 1 }
    }
  }
  const sorted = Object.entries(codeCount).sort((a, b) => b[1] - a[1])
  return sorted.length > 0 ? sorted[0][0] : null
}

export function applyCompoundAutoAmounts(entries: JournalEntry[], shoguchiCode?: string): JournalEntry[] {
  // 諸口コードを判定（指定なければ複合仕訳内で最も多く使われるコードを推定）
  const sgCode = shoguchiCode || detectShoguchiCode(entries) || '997'

  // グループ化
  const groupMembers: Record<string, JournalEntry[]> = {}
  for (const e of entries) {
    const hasChildren = entries.some((c) => c.parentId === e.id)
    const groupKey = e.parentId || (hasChildren ? e.id : null)
    if (groupKey) {
      if (!groupMembers[groupKey]) groupMembers[groupKey] = []
      groupMembers[groupKey].push(e)
    }
  }

  // 最終行の金額を自動計算して反映
  const updatedIds = new Map<string, number>()
  for (const [, members] of Object.entries(groupMembers)) {
    if (members.length === 0) continue
    const lastEntry = members[members.length - 1]

    let debit997Total = 0
    let credit997Total = 0
    for (const m of members) {
      if (m.id === lastEntry.id) continue
      const amt = m.debitAmount || m.creditAmount || 0
      if (m.debitCode === sgCode) debit997Total += amt
      if (m.creditCode === sgCode) credit997Total += amt
    }

    let autoAmount = 0
    if (lastEntry.debitCode === sgCode) {
      autoAmount = credit997Total - debit997Total
    } else if (lastEntry.creditCode === sgCode) {
      autoAmount = debit997Total - credit997Total
    }

    if (autoAmount !== 0) {
      updatedIds.set(lastEntry.id, autoAmount)
    }
  }

  // 新しいentries配列を返す
  return entries.map((e) => {
    const autoAmount = updatedIds.get(e.id)
    if (autoAmount != null) {
      return { ...e, debitAmount: autoAmount, creditAmount: autoAmount }
    }
    return e
  })
}

export function generateCsv(entries: JournalEntry[], clientTaxType?: string): string {
  const lines: string[] = []
  lines.push(CSV_HEADERS.map(escapeCsvField).join(','))
  for (const entry of entries) {
    const row = entryToRow(entry, clientTaxType)
    lines.push(row.map(escapeCsvField).join(','))
  }
  return lines.join('\r\n')
}

export function downloadCsv(entries: JournalEntry[], fileName?: string, clientTaxType?: string): void {
  const appliedEntries = applyCompoundAutoAmounts(entries)
  const csvContent = generateCsv(appliedEntries, clientTaxType)

  // Shift-JIS (ANSI) エンコードで出力
  const sjisBytes = unicodeToShiftJIS(csvContent)
  const blob = new Blob([sjisBytes], {
    type: 'text/csv;charset=shift_jis',
  })

  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName || `仕訳データ_${formatDateForFileName()}.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

function formatDateForFileName(): string {
  const now = new Date()
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
}

/**
 * Unicode文字列をShift-JIS (ANSI) のバイト配列に変換
 */
function unicodeToShiftJIS(str: string): ArrayBuffer {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
    const Encoding = require('encoding-japanese') as any
    const unicodeArray = Encoding.stringToCode(str)
    const sjisArray: number[] = Encoding.convert(unicodeArray, { to: 'SJIS', from: 'UNICODE' })
    const buf = new ArrayBuffer(sjisArray.length)
    const view = new DataView(buf)
    for (let i = 0; i < sjisArray.length; i++) view.setUint8(i, sjisArray[i])
    return buf
  } catch {
    console.warn('encoding-japanese not available, falling back to UTF-8 with BOM')
    const bom = '﻿'
    const encoder = new TextEncoder()
    return encoder.encode(bom + str).buffer
  }
}
