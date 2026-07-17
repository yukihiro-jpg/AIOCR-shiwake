import type { JournalEntry, CreditCardData, CreditCardTransaction } from './types'
import { findPattern, getPatterns } from './pattern-store'

let idCounter = 0
function generateEntryId(): string {
  return `cc-${Date.now()}-${++idCounter}`
}

function formatUsageDate(usageDate: string): string {
  if (!usageDate) return ''
  const m = usageDate.match(/(\d{1,2})-(\d{1,2})$/)
  if (m) return `${parseInt(m[1])}月${parseInt(m[2])}日`
  const m2 = usageDate.match(/(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (m2) return `${parseInt(m2[2])}月${parseInt(m2[3])}日`
  return usageDate
}

export function creditCardToEntries(
  data: CreditCardData,
  creditCardAccountCode: string,
  creditCardAccountName: string,
  creditCardSubCode?: string,
  creditCardSubName?: string,
): JournalEntry[] {
  const patterns = getPatterns()

  return data.transactions.map((tx) => {
    const amount = Math.abs(tx.amount)
    const isRefund = tx.amount < 0
    const descBase = tx.storeName || ''
    let description = descBase.slice(0, 40)
    const usageDateStr = tx.usageDate.replace(/-/g, '')
    // パターン学習用: 日付部分を除去（毎月変わるためパターンマッチの邪魔になる）
    const storeNameForPattern = stripDateFromDescription(descBase)

    const pattern = findPattern(patterns, storeNameForPattern, amount, creditCardAccountCode)

    let expenseCode = ''
    let expenseName = ''
    let expenseSubCode = ''
    let expenseSubName = ''
    let taxCode = ''
    let taxCategory = ''
    let taxRate = ''
    let businessType = ''
    let patternId: string | null = null

    if (pattern) {
      const line = pattern.lines[0]
      if (line) {
        if (line.debitCode !== creditCardAccountCode) {
          expenseCode = line.debitCode
          expenseName = line.debitName
          expenseSubCode = line.debitSubCode || ''
          expenseSubName = line.debitSubName || ''
        } else if (line.creditCode !== creditCardAccountCode) {
          expenseCode = line.creditCode
          expenseName = line.creditName
          expenseSubCode = line.creditSubCode || ''
          expenseSubName = line.creditSubName || ''
        }
        taxCode = line.taxCode || ''
        taxCategory = line.taxCategory || ''
        taxRate = line.taxRate || ''
        businessType = line.businessType || ''
      }
      patternId = pattern.id

      // 変換後摘要を適用（通帳・現金出納帳の journal-mapper と同じ挙動）
      if (pattern.convertedDescription) {
        if (pattern.matchType === 'exact' || pattern.replaceEntireDescription) {
          description = pattern.convertedDescription.slice(0, 40)
        } else {
          const mt = pattern.matchText || pattern.keyword
          description = descBase.replace(mt, pattern.convertedDescription).slice(0, 40)
        }
      } else if (pattern.matchType === 'exact' && line?.description) {
        // 完全一致で変換後摘要なし → パターンの摘要を使用
        description = line.description.slice(0, 40)
      }
      // 部分一致で変換後摘要なし → 元の摘要をそのまま保持
    }

    // マイナス金額（返品・キャンセル）→ 貸借逆転
    // 消費税CDは常に設定（返品でも課税仕入のまま）
    const entry: JournalEntry = {
      id: generateEntryId(),
      transactionId: null,
      date: usageDateStr,
      debitCode: isRefund ? creditCardAccountCode : expenseCode,
      debitName: isRefund ? creditCardAccountName : expenseName,
      debitSubCode: isRefund ? (creditCardSubCode || '') : expenseSubCode,
      debitSubName: isRefund ? (creditCardSubName || '') : expenseSubName,
      debitTaxType: taxCategory,
      debitIndustry: '',
      debitTaxInclude: '',
      debitAmount: amount,
      debitTaxAmount: 0,
      debitTaxCode: taxCode,
      debitTaxRate: taxRate || (taxCode ? '4' : ''),
      debitBusinessType: businessType,
      creditCode: isRefund ? expenseCode : creditCardAccountCode,
      creditName: isRefund ? expenseName : creditCardAccountName,
      creditSubCode: isRefund ? expenseSubCode : (creditCardSubCode || ''),
      creditSubName: isRefund ? expenseSubName : (creditCardSubName || ''),
      creditTaxType: '',
      creditIndustry: '',
      creditTaxInclude: '',
      creditAmount: amount,
      creditTaxAmount: 0,
      creditTaxCode: '',
      creditTaxRate: '',
      creditBusinessType: '',
      description,
      originalDescription: storeNameForPattern,
      patternId,
      isCompound: false,
      parentId: null,
    }
    return entry
  })
}

/**
 * 利用内容から日付部分を除去してパターン学習キーを生成
 * 例:
 *   "Ｂｉｚ月額料金　１２月　１ＩＤ" → "Ｂｉｚ月額料金　１ＩＤ"
 *   "東京電力 電気料金等 ０７年０３月分" → "東京電力 電気料金等"
 *   "〇〇 2025年4月分" → "〇〇"
 */
function stripDateFromDescription(desc: string): string {
  return desc
    // "07年03月分" "2025年4月分" "０７年０３月分" 等
    .replace(/[０-９0-9]{2,4}年[０-９0-9]{1,2}月分?/g, '')
    // "12月" "１２月" 等（単独の月表記）
    .replace(/[０-９0-9]{1,2}月/g, '')
    // "2025/4" "2025/04" 等
    .replace(/[0-9]{4}\/[0-9]{1,2}/g, '')
    // 余分なスペースを整理
    .replace(/[\s　]+/g, ' ')
    .trim()
}

// 除外キーワード（これらを含む行は解析対象外）
const EXCLUDE_KEYWORDS = ['前回分口座振替金額', '口座振替', '繰越残高', '前回請求額', 'ご利用可能額']

/**
 * クレジットカード CSV/Excel をパースして CreditCardData に変換
 */
export async function parseCreditCardCsv(file: File): Promise<CreditCardData | null> {
  const fileName = file.name.toLowerCase()
  let rows: string[][]

  if (fileName.endsWith('.csv')) {
    const buffer = await file.arrayBuffer()
    const text = decodeCsvText(buffer)
    rows = parseCsvText(text)
  } else {
    const XLSX = await import('xlsx')
    const { readSpreadsheet } = await import('./spreadsheet-reader')
    const buffer = await file.arrayBuffer()
    const wb = readSpreadsheet(buffer)
    const sheet = wb.Sheets[wb.SheetNames[0]]
    if (!sheet) return null
    rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, defval: '' })
      .map((r) => r.map((c) => String(c).trim()))
      .filter((r) => r.some((c) => c))
  }

  if (rows.length < 2) return null

  // ヘッダ行を検出
  let headerRow = -1
  let dateCol = -1
  let descCol = -1
  let amountCol = -1

  const DATE_KW = ['ご利用日', '利用日', '取引日', '日付', 'ご利用年月日', '利用年月日', '年月日', 'ご利用日付']
  const DESC_KW = ['ご利用内容', '利用内容', '利用先', '利用店名', '加盟店', '店名', '摘要', '内容', 'ご利用先']
  const AMT_KW = ['ご利用額', '利用額', '金額', '利用金額', 'ご利用金額', '請求金額', 'お支払金額', '支払金額']

  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    const r = rows[i]
    let dCol = -1, dsCol = -1, aCol = -1
    for (let j = 0; j < r.length; j++) {
      const c = r[j].replace(/[\s　]/g, '')
      if (dCol < 0 && DATE_KW.some((k) => c.includes(k))) dCol = j
      else if (dsCol < 0 && DESC_KW.some((k) => c.includes(k))) dsCol = j
      else if (aCol < 0 && AMT_KW.some((k) => c.includes(k))) aCol = j
    }
    if (dCol >= 0 && aCol >= 0) {
      headerRow = i
      dateCol = dCol
      descCol = dsCol >= 0 ? dsCol : -1
      amountCol = aCol
      break
    }
  }

  if (headerRow < 0 || dateCol < 0 || amountCol < 0) return null

  // データ行をパース
  const transactions: CreditCardTransaction[] = []
  let paymentDate = ''

  for (let i = headerRow + 1; i < rows.length; i++) {
    const r = rows[i]
    const dateText = (r[dateCol] || '').trim()
    if (!dateText) continue

    // 日付パース: 2025/4/17 → 2025-04-17
    const dm = dateText.match(/(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})/)
    if (!dm) continue
    const date = `${dm[1]}-${String(dm[2]).padStart(2, '0')}-${String(dm[3]).padStart(2, '0')}`

    const desc = descCol >= 0 ? (r[descCol] || '').trim() : ''
    const amtText = (r[amountCol] || '').replace(/[¥￥,、\s]/g, '')
    const amount = parseInt(amtText, 10)
    if (isNaN(amount)) continue

    // 除外キーワードチェック
    if (EXCLUDE_KEYWORDS.some((kw) => desc.includes(kw))) continue

    if (!paymentDate || date > paymentDate) paymentDate = date

    transactions.push({
      usageDate: date,
      storeName: desc,
      amount: amount,
      memo: amount < 0 ? '返品・取消' : '',
    })
  }

  if (transactions.length === 0) return null

  // 引落日は最も遅い利用日の翌月27日を仮設定（後でユーザーが変更可能）
  const totalAmount = transactions.reduce((s, t) => s + t.amount, 0)

  return {
    paymentDate: paymentDate || new Date().toISOString().slice(0, 10),
    totalAmount,
    cardName: '',
    transactions,
  }
}

// CSV テキストデコード（UTF-8 BOM / UTF-8 / Shift_JIS 自動判定）
function decodeCsvText(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    return new TextDecoder('utf-8').decode(bytes.slice(3))
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('shift_jis').decode(bytes)
  }
}

// CSV パース（ダブルクォート対応）
function parseCsvText(text: string): string[][] {
  const rows: string[][] = []
  let cur: string[] = []
  let field = ''
  let inQuote = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuote) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ }
        else inQuote = false
      } else { field += c }
    } else {
      if (c === '"') inQuote = true
      else if (c === ',') { cur.push(field); field = '' }
      else if (c === '\r') { /* skip */ }
      else if (c === '\n') { cur.push(field); rows.push(cur); cur = []; field = '' }
      else field += c
    }
  }
  if (field.length > 0 || cur.length > 0) { cur.push(field); rows.push(cur) }
  return rows.filter((r) => r.some((c) => c.trim().length > 0))
}
