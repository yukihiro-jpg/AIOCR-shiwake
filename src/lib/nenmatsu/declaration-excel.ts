// 年末調整 申告内容のExcel出力（ExcelJS）。
// 1社員＝1行（本人）＋配偶者・扶養親族1人につき1行。フォントは Noto Sans JP、
// 罫線・色で本人行と家族行を見分けやすくする。

import type { Declaration } from './declaration'
import { spouseCategory, dependentCategory, numYen } from './declaration'
import { diffDeclaration, changesByTarget, emptyBaseline, CHANGE_MARK, CHANGE_LABEL,
  type Baseline, type Change } from './declaration-diff'

export interface DeclarationExcelEntry {
  employeeName: string
  decl: Declaration
  submittedAt?: string
  isNewHire?: boolean
  /** 変更前（従業員が画面で最初に見た内容）。省略時は比較しない */
  baseline?: Baseline
}

const FONT = 'Noto Sans JP'
const NAVY = 'FF1F3A5F'
const SELF_FILL = 'FFE7EDF5' // 本人行（淡いネイビー）
const FAMILY_FILL = 'FFFFFFFF'
const SPOUSE_TAG_FILL = 'FFFFF3D6' // 家族行の区分セル（淡い金）
// 差分の色。白黒印刷でも分かるよう、記号（★＋−）も必ず併記する
const MOD_FILL = 'FFFFF2A8'   // 修正されたセル（黄）
const ADD_FILL = 'FFD9F2DE'   // 新しく追加された行（緑）
const DEL_FILL = 'FFEDEFF2'   // 本人が外した行（グレー）
const MOD_INK = 'FF8A6100'
const ADD_INK = 'FF14683A'
const DEL_INK = 'FF7A828C'

/** 本人行の項目名 → 列番号（1始まり）。修正されたセルだけを塗るために使う */
const SELF_FIELD_COL: Record<string, number> = {
  lastName: 3, firstName: 3, kanaLast: 4, kanaFirst: 4, birth: 6,
  selfDisability: 8, widow: 9, workingStudent: 10, postal: 13, address: 14,
  householder: 15, householderRelation: 15,
}
/** 家族行の項目名 → 列番号 */
const FAMILY_FIELD_COL: Record<string, number> = {
  name: 3, kana: 4, relation: 5, birth: 6, income: 7, disability: 8, liveTogether: 11,
}

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
  const allChanges: { entry: DeclarationExcelEntry; changes: Change[] }[] = []
  for (const ent of entries) {
    no++
    const d = ent.decl
    // 変更前と突き合わせる。変更前が無い（本年入社など）ときは全項目を新規として扱う
    const base = ent.baseline || (ent.isNewHire || d.isNewHire ? emptyBaseline() : null)
    const changes = base ? diffDeclaration(base, d) : []
    if (base) allChanges.push({ entry: ent, changes })
    const byTarget = changesByTarget(changes)
    const memo: string[] = []
    if (base) {
      const nMod = changes.filter((c) => c.kind === 'modified').length
      const nAdd = changes.filter((c) => c.kind === 'added').length
      const nDel = changes.filter((c) => c.kind === 'removed').length
      const parts = [nMod ? `★修正${nMod}` : '', nAdd ? `＋新規${nAdd}` : '', nDel ? `−削除${nDel}` : ''].filter(Boolean)
      memo.push(parts.length ? parts.join('・') : '変更なし')
    }
    if (ent.isNewHire || d.isNewHire) {
      memo.push(d.hireDate ? `本年入社（入社日 ${d.hireDate.replace(/-/g, '/')}）` : '本年入社')
      if (d.hasPrevJob === true) {
        memo.push(d.prevJobNoSlip
          ? '⚠前職あり・源泉徴収票入手不可（本人が確定申告する旨を案内済み）'
          : '前職あり（源泉徴収票 提出）')
      } else if (d.hasPrevJob === false) {
        memo.push('前職なし')
      }
    }
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
    markChanges(selfRow, byTarget.get('self') || [], SELF_FIELD_COL)

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
      markChanges(r, byTarget.get('spouse') || [], FAMILY_FIELD_COL)
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
      markChanges(r, byTarget.get(`dep${i}`) || [], FAMILY_FIELD_COL)
    })

    // 本人が外した家族は、申告内容には行が無いので取消線のグレー行として残す
    // （「前年いたのに今年いない」を見落とさないため）
    for (const c of changes.filter((x) => x.kind === 'removed')) {
      const r = ws.addRow(['', `${CHANGE_MARK.removed} ${c.label.startsWith('配偶者') ? '配偶者' : '扶養'}（削除）`,
        c.before, '', '', '', null, '', '', '', '', '', '', '', '',
        `本人が外しました（変更前: ${c.before}）`])
      styleRow(r, DEL_FILL, false)
      for (let cc = 1; cc <= HEADERS.length; cc++) {
        const cell = r.getCell(cc)
        cell.font = { name: FONT, size: 9, color: { argb: DEL_INK }, strike: true }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: DEL_FILL } }
      }
      r.getCell(16).font = { name: FONT, size: 9, color: { argb: DEL_INK } }
    }
  }

  buildChangeSheet(wb, allChanges, opts)

  const buf = await wb.xlsx.writeBuffer()
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
}

/** 修正されたセルを黄色に、新しく追加された行を緑にする。
 *  白黒で印刷しても分かるよう、区分セルに記号（★＋）を足し、変更前の値をセルのメモに残す。 */
function markChanges(row: import('exceljs').Row, changes: Change[], fieldCol: Record<string, number>) {
  if (!changes.length) return
  const added = changes.find((c) => c.kind === 'added' && !c.field)
  if (added) {
    for (let c = 1; c <= HEADERS.length; c++) {
      const cell = row.getCell(c)
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ADD_FILL } }
      cell.font = { ...(cell.font || { name: FONT, size: 9 }), color: { argb: ADD_INK } }
    }
    const tag = row.getCell(2)
    tag.value = `${CHANGE_MARK.added} ${String(tag.value ?? '')}`.trim()
    tag.font = { name: FONT, size: 9, bold: true, color: { argb: ADD_INK } }
    return
  }
  let marked = 0
  for (const ch of changes) {
    if (!ch.field) continue
    const col = fieldCol[ch.field]
    if (!col) continue
    const cell = row.getCell(col)
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: MOD_FILL } }
    cell.font = { ...(cell.font || { name: FONT, size: 9 }), bold: true, color: { argb: MOD_INK } }
    cell.note = `変更前: ${ch.before || '（なし）'}`
    marked++
  }
  if (marked) {
    const tag = row.getCell(2)
    tag.value = `${CHANGE_MARK.modified} ${String(tag.value ?? '')}`.trim()
    tag.font = { name: FONT, size: 9, bold: true, color: { argb: MOD_INK } }
  }
}

/** 2枚目「変更点」。変更のあった人だけを並べる（変更が無ければ、その旨だけ書く） */
function buildChangeSheet(
  wb: import('exceljs').Workbook,
  all: { entry: DeclarationExcelEntry; changes: Change[] }[],
  opts: { companyName: string; fyLabel: string },
) {
  const HEAD = ['従業員', '区分', '項目', '変更前', '変更後', '比較のもと'] as const
  const W = [18, 8, 30, 34, 34, 18]
  const ws = wb.addWorksheet('変更点', { views: [{ state: 'frozen', ySplit: 4 }] })
  ws.columns = W.map((w) => ({ width: w }))

  const title = ws.addRow([`${opts.companyName}　年末調整 変更点一覧（${opts.fyLabel}）`])
  ws.mergeCells(1, 1, 1, HEAD.length)
  title.getCell(1).font = { name: FONT, size: 14, bold: true, color: { argb: NAVY } }
  title.height = 24

  const changed = all.filter((x) => x.changes.length > 0)
  const sub = ws.addRow([`変更のあった方 ${changed.length}名 / 提出 ${all.length}名　（★修正・＋新規・−削除）`])
  ws.mergeCells(2, 1, 2, HEAD.length)
  sub.getCell(1).font = { name: FONT, size: 9, color: { argb: 'FF5B6675' } }
  const note = ws.addRow(['「変更前」は、従業員がスマホで最初に見た内容（前年の提出、無ければ会社の登録内容）です。'])
  ws.mergeCells(3, 1, 3, HEAD.length)
  note.getCell(1).font = { name: FONT, size: 9, color: { argb: 'FF5B6675' } }

  const head = ws.addRow([...HEAD])
  head.height = 22
  head.eachCell((c) => {
    c.font = { name: FONT, size: 9, bold: true, color: { argb: 'FFFFFFFF' } }
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }
    c.alignment = { vertical: 'middle', horizontal: 'center' }
    c.border = thinBorder('FF1F3A5F')
  })

  if (!changed.length) {
    const r = ws.addRow(['変更はありません（全員が会社の登録内容のままです）'])
    ws.mergeCells(r.number, 1, r.number, HEAD.length)
    r.getCell(1).font = { name: FONT, size: 10, color: { argb: 'FF5B6675' } }
    return
  }

  for (const { entry, changes } of changed) {
    const name = `${entry.decl.lastName} ${entry.decl.firstName}`.trim() || entry.employeeName
    changes.forEach((c, i) => {
      const fill = c.kind === 'modified' ? MOD_FILL : c.kind === 'added' ? ADD_FILL : DEL_FILL
      const ink = c.kind === 'modified' ? MOD_INK : c.kind === 'added' ? ADD_INK : DEL_INK
      const r = ws.addRow([
        i === 0 ? name : '',
        `${CHANGE_MARK[c.kind]} ${CHANGE_LABEL[c.kind]}`,
        c.label,
        c.before || '（なし）',
        c.after || '（なし）',
        i === 0 ? (entry.baseline?.sourceLabel || '（比較対象なし）') : '',
      ])
      for (let cc = 1; cc <= HEAD.length; cc++) {
        const cell = r.getCell(cc)
        cell.font = { name: FONT, size: 9, bold: cc === 1, color: { argb: cc === 2 ? ink : 'FF243042' } }
        cell.border = thinBorder()
        cell.alignment = { vertical: 'middle', horizontal: cc === 2 ? 'center' : 'left', wrapText: cc >= 3 }
      }
      r.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } }
      if (c.kind === 'removed') r.getCell(4).font = { name: FONT, size: 9, color: { argb: DEL_INK }, strike: true }
    })
  }
  ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: ws.rowCount, column: HEAD.length } }
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
