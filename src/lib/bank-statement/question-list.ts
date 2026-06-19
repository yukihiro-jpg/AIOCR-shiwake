import XLSX from 'xlsx-js-style'
import type { JournalEntry, AccountItem } from './types'
import { getTempEntries } from './temp-store'
import { getQuestionItems } from './question-store'

interface QuestionRow {
  no: number
  date: string
  bankAccount: string
  direction: string
  amount: number
  originalDescription: string
  question: string
  answer: string
}

export function generateQuestionList(
  accountMaster: AccountItem[],
  clientName: string,
): QuestionRow[] {
  const karibaraiAcc = accountMaster.find((a) =>
    a.name.includes('仮払') || a.shortName.includes('仮払')
  )
  if (!karibaraiAcc) return []
  const kariCode = karibaraiAcc.code

  // 蓄積ストア（過去にCSV出力済み分）＋ 現在の一時保存（未出力分）を統合（id重複除去）
  const byId = new Map<string, JournalEntry>()
  for (const e of getQuestionItems()) byId.set(e.id, e)
  for (const e of getTempEntries()) byId.set(e.id, e)
  const entries = Array.from(byId.values())
    .filter((e) => e.debitCode === kariCode || e.creditCode === kariCode)
    // 「質問しない」(本物の仮払金) は除外。未設定は質問対象。
    .filter((e) => e.needsQuestion !== false)
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''))

  const rows: QuestionRow[] = []
  let no = 1

  for (const e of entries) {
    const isDebitKari = e.debitCode === kariCode
    const isCreditKari = e.creditCode === kariCode
    if (!isDebitKari && !isCreditKari) continue

    const counterCode = isDebitKari ? e.creditCode : e.debitCode
    const counterName = isDebitKari ? e.creditName : e.debitName
    const counterAcc = accountMaster.find((a) => a.code === counterCode)
    const bankAccount = counterAcc?.shortName || counterAcc?.name || counterName || counterCode

    const direction = isDebitKari ? '出金' : '入金'
    const amount = e.debitAmount || e.creditAmount || 0
    // ユーザーが摘要を変換している場合はそちらを表示（通帳摘要列・確認事項内の括弧とも）
    const displayDesc = e.description || e.originalDescription || ''
    const question = generateQuestion(direction, amount, displayDesc, bankAccount)

    rows.push({ no: no++, date: formatDate(e.date), bankAccount, direction, amount, originalDescription: displayDesc, question, answer: '' })
  }
  return rows
}

function generateQuestion(direction: string, amount: number, desc: string, bankAccount: string): string {
  const amountStr = amount.toLocaleString()
  if (direction === '出金') {
    let q = `${bankAccount}から${amountStr}円の出金があります（${desc || '摘要不明'}）。`
    if (amount >= 100000) q += '\nこのお支払いの内容と、契約書・請求書等の証憑をお教えください。'
    else if (amount >= 10000) q += '\nこのお支払いの内容と、領収書またはレシートがあればご提供ください。'
    else q += '\nこのお支払いの内容をお教えください。レシート等があればご提供ください。'
    if (desc.includes('ｶｰﾄﾞ') || desc.includes('カード')) q += '\n※カード払いの明細があればご確認ください。'
    if (desc.includes('振込') || desc.includes('ﾌﾘｺﾐ')) q += '\n※振込先の請求書があればご確認ください。'
    return q
  } else {
    let q = `${bankAccount}に${amountStr}円の入金があります（${desc || '摘要不明'}）。`
    q += '\nこの入金は売上代金の入金でしょうか？それとも立替金の返金や借入金等でしょうか？'
    if (amount >= 1000000) q += '\n※高額のため、契約書や入金明細等があればご確認ください。'
    return q
  }
}

function formatDate(date: string): string {
  if (!date || date.length !== 8) return date
  return `${date.slice(0, 4)}/${date.slice(4, 6)}/${date.slice(6, 8)}`
}

// スタイル定義
const FONT_BASE = { name: 'Segoe UI', sz: 10 }
const FONT_TITLE = { name: 'Segoe UI', sz: 14, bold: true }
const FONT_SUBTITLE = { name: 'Segoe UI', sz: 10, color: { rgb: '555555' } }
const FONT_HEADER = { name: 'Segoe UI', sz: 10, bold: true, color: { rgb: 'FFFFFF' } }

const BORDER_SOLID = { style: 'thin', color: { rgb: '333333' } }
const BORDER_DOT = { style: 'dotted', color: { rgb: '999999' } }

const HEADER_FILL = { fgColor: { rgb: '4472C4' } }

const headerStyle = {
  font: FONT_HEADER,
  fill: HEADER_FILL,
  border: { top: BORDER_SOLID, bottom: BORDER_SOLID, left: BORDER_SOLID, right: BORDER_SOLID },
  alignment: { vertical: 'center', horizontal: 'center', wrapText: true },
}

const cellStyle = (align?: string) => ({
  font: FONT_BASE,
  border: { top: BORDER_DOT, bottom: BORDER_DOT, left: BORDER_SOLID, right: BORDER_SOLID },
  alignment: { vertical: 'top', horizontal: align || 'left', wrapText: true },
})

const outerBorderBottom = {
  font: FONT_BASE,
  border: { top: BORDER_DOT, bottom: BORDER_SOLID, left: BORDER_SOLID, right: BORDER_SOLID },
  alignment: { vertical: 'top', wrapText: true },
}

export function downloadQuestionExcel(
  rows: QuestionRow[],
  clientName: string,
  officeName?: string,
): void {
  const wb = XLSX.utils.book_new()

  // ヘッダー情報
  const aoa: (string | number)[][] = [
    [`${clientName} 様　仮払金確認のお願い`],
    [`作成日: ${new Date().toLocaleDateString('ja-JP')}${officeName ? `　　作成者: ${officeName}` : ''}`],
    ['下記の取引について、内容のご確認をお願いいたします。「回答」欄にご記入のうえ、ご返送ください。'],
    [],
    ['No', '日付', '口座', '入出金', '金額', '通帳摘要', '確認事項', '回答'],
  ]

  for (const r of rows) {
    aoa.push([r.no, r.date, r.bankAccount, r.direction, r.amount, r.originalDescription, r.question, r.answer])
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa)

  // 列幅
  ws['!cols'] = [
    { wch: 4 }, { wch: 12 }, { wch: 18 }, { wch: 6 },
    { wch: 12 }, { wch: 25 }, { wch: 50 }, { wch: 30 },
  ]

  // 行高さ
  ws['!rows'] = [
    { hpt: 24 }, // タイトル
    { hpt: 16 }, // 作成日
    { hpt: 16 }, // 説明
    { hpt: 8 },  // 空行
    { hpt: 20 }, // ヘッダー
  ]
  for (let i = 0; i < rows.length; i++) {
    ws['!rows']!.push({ hpt: 50 })
  }

  // スタイル適用
  // タイトル行
  const titleCell = ws['A1']
  if (titleCell) { titleCell.s = { font: FONT_TITLE } }
  const subtitleCell = ws['A2']
  if (subtitleCell) { subtitleCell.s = { font: FONT_SUBTITLE } }
  const descCell = ws['A3']
  if (descCell) { descCell.s = { font: { ...FONT_BASE, color: { rgb: '666666' } } } }

  // ヘッダー行 (行5 = index 4)
  const headerRow = 4
  const cols = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']
  for (const col of cols) {
    const ref = `${col}${headerRow + 1}`
    if (ws[ref]) ws[ref].s = headerStyle
  }

  // データ行
  for (let i = 0; i < rows.length; i++) {
    const rowIdx = headerRow + 1 + i
    const isLast = i === rows.length - 1
    for (let c = 0; c < cols.length; c++) {
      const ref = `${cols[c]}${rowIdx + 1}`
      if (!ws[ref]) continue
      if (isLast) {
        // 最終行: 下線を実線
        const align = c === 0 ? 'center' : c === 4 ? 'right' : 'left'
        ws[ref].s = { ...outerBorderBottom, alignment: { ...outerBorderBottom.alignment, horizontal: align } }
      } else {
        const align = c === 0 ? 'center' : c === 4 ? 'right' : 'left'
        ws[ref].s = cellStyle(align)
      }
      // 金額列の数値フォーマット
      if (c === 4 && typeof ws[ref].v === 'number') {
        ws[ref].z = '#,##0'
      }
    }
  }

  // タイトル行をマージ
  ws['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 7 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: 7 } },
    { s: { r: 2, c: 0 }, e: { r: 2, c: 7 } },
  ]

  // 目盛り線を非表示
  ws['!sheetViews'] = [{ showGridLines: false }]

  XLSX.utils.book_append_sheet(wb, ws, '仮払金確認')
  XLSX.writeFile(wb, `仮払金確認_${clientName}_${new Date().toISOString().slice(0, 10)}.xlsx`)
}
