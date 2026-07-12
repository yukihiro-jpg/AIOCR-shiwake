// 年末調整 申告内容のExcel出力（ExcelJS）。
// 1社員＝1行（本人）＋配偶者・扶養親族1人につき1行。フォントは Noto Sans JP、
// 罫線・色で本人行と家族行を見分けやすくする。

import type { Declaration } from './declaration'
import { spouseCategory, dependentCategory, numYen } from './declaration'

export interface DeclarationExcelEntry {
  employeeName: string
  decl: Declaration
  submittedAt?: string
  isNewHire?: boolean
}

const FONT = 'Noto Sans JP'
const NAVY = 'FF1F3A5F'
const SELF_FILL = 'FFE7EDF5' // 本人行（淡いネイビー）
const FAMILY_FILL = 'FFFFFFFF'
const SPOUSE_TAG_FILL = 'FFFFF3D6' // 家族行の区分セル（淡い金）

const HEADERS = [
  'No', '区分', '氏名', 'フリガナ', '続柄', '生年月日', '年収（円）',
  '障害者区分', '寡婦・ひとり親', '勤労学生', '同居・別居', '控除区分（目安）',
  '郵便番号', '住所', '世帯主（続柄）', '備考',
] as const

// 列幅はヘッダ・データとも1行で収まる幅にする（見切れ防止）
const WIDTHS = [5, 11, 16, 16, 10, 12, 12, 15, 15, 10, 10, 36, 10, 36, 18, 32]

function fmtDate(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
}

export async function buildDeclarationExcelBlob(
  entries: DeclarationExcelEntry[],
  opts: { companyName: string; fyLabel: string; fyGregorian: number },
): Promise<Blob> {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('申告内容', { views: [{ state: 'frozen', ySplit: 3 }] })
  ws.columns = WIDTHS.map((w) => ({ width: w }))

  // タイトル
  const title = ws.addRow([`${opts.companyName}　年末調整 申告内容一覧（${opts.fyLabel}）`])
  ws.mergeCells(1, 1, 1, HEADERS.length)
  title.getCell(1).font = { name: FONT, size: 14, bold: true, color: { argb: NAVY } }
  title.height = 24
  const sub = ws.addRow([`提出 ${entries.length}名`])
  ws.mergeCells(2, 1, 2, HEADERS.length)
  sub.getCell(1).font = { name: FONT, size: 9, color: { argb: 'FF5B6675' } }

  // ヘッダ（折り返しなしで1行に収める。高さも余裕を持たせて見切れを防ぐ）
  const head = ws.addRow([...HEADERS])
  head.height = 24
  head.eachCell((c) => {
    c.font = { name: FONT, size: 9, bold: true, color: { argb: 'FFFFFFFF' } }
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }
    c.alignment = { vertical: 'middle', horizontal: 'center' }
    c.border = thinBorder('FF1F3A5F')
  })

  let no = 0
  for (const ent of entries) {
    no++
    const d = ent.decl
    const memo: string[] = []
    if (ent.isNewHire || d.isNewHire) memo.push(d.hireDate ? `本年入社（入社日 ${d.hireDate.replace(/-/g, '/')}）` : '本年入社')
    if (d.noChange) memo.push('前年と相違なし')
    if (ent.submittedAt) memo.push(`提出 ${fmtDate(ent.submittedAt)}`)

    // 本人行
    const selfRow = ws.addRow([
      no, '本人',
      `${d.lastName} ${d.firstName}`.trim() || ent.employeeName,
      `${d.kanaLast} ${d.kanaFirst}`.trim(),
      '—',
      d.birth || '',
      null,
      d.selfDisability === '非該当' ? '' : d.selfDisability,
      d.widow === '非該当' ? '' : d.widow,
      d.workingStudent ? '該当' : '',
      '',
      '',
      d.postal || '',
      d.address || '',
      d.householder ? `${d.householder}（${d.householderRelation}）` : '',
      memo.join('・'),
    ])
    styleRow(selfRow, SELF_FILL, true)

    // 配偶者行
    if (d.spouse.exists) {
      const r = ws.addRow([
        '', '└ 配偶者',
        d.spouse.name, d.spouse.kana, '配偶者',
        d.spouse.birth || '',
        d.spouse.income ? numYen(d.spouse.income) : null,
        '', '', '', '',
        spouseCategory(d.spouse),
        '', '', '', `${`${d.lastName} ${d.firstName}`.trim() || ent.employeeName} の配偶者`,
      ])
      styleRow(r, FAMILY_FILL, false)
    }

    // 扶養親族行
    d.dependents.forEach((dep, i) => {
      const r = ws.addRow([
        '', `└ 扶養${i + 1}`,
        dep.name, dep.kana, dep.relation || '',
        dep.birth || '',
        dep.income ? numYen(dep.income) : null,
        dep.disability === '非該当' ? '' : dep.disability,
        '', '',
        dep.liveTogether ? '同居' : '別居',
        dependentCategory(dep, opts.fyGregorian),
        '', '', '', `${`${d.lastName} ${d.firstName}`.trim() || ent.employeeName} の扶養親族`,
      ])
      styleRow(r, FAMILY_FILL, false)
    })
  }

  const buf = await wb.xlsx.writeBuffer()
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
}

function thinBorder(argb = 'FFD3DAE3') {
  const s = { style: 'thin' as const, color: { argb } }
  return { top: s, bottom: s, left: s, right: s }
}

function styleRow(row: import('exceljs').Row, fill: string, isSelf: boolean) {
  // 高さは固定しない（wrapTextの列はExcelが開いたときに自動で行高を広げるため、固定すると見切れる）
  for (let c = 1; c <= HEADERS.length; c++) {
    const cell = row.getCell(c)
    cell.font = { name: FONT, size: 9, bold: isSelf && (c === 2 || c === 3), color: { argb: 'FF243042' } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } }
    cell.border = thinBorder()
    cell.alignment = { vertical: 'middle', horizontal: c === 7 ? 'right' : c === 1 || c === 6 || (c >= 8 && c <= 11) || c === 13 ? 'center' : 'left', wrapText: c === 12 || c === 14 || c === 16 }
    if (c === 7) cell.numFmt = '#,##0'
  }
  if (!isSelf) {
    // 家族行の区分セルは淡い金で「本人の下にぶら下がる家族」であることを示す
    row.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SPOUSE_TAG_FILL } }
  }
}
