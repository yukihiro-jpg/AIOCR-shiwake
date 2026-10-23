// 年末調整 申告内容のExcel出力（ExcelJS）。
// 1社員＝1行（本人）＋配偶者・扶養親族1人につき1行。フォントは Noto Sans JP、
// 罫線・色で本人行と家族行を見分けやすくする。
// 本人行には「甲欄／乙欄」と「配偶者・扶養親族」のまとめも出す（家族行を追わなくても1行で分かるように）。
// 列は COLS のキーで指定する（列を足したときに番号のずれで別の列を塗らないため）。

import type { Declaration } from './declaration'
import { spouseCategory, dependentCategory, numYen, normalizeDeclaration } from './declaration'
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

type ColKey = 'no' | 'tag' | 'taxCat' | 'name' | 'kana' | 'relation' | 'birth' | 'income' | 'disability' | 'widow'
  | 'student' | 'together' | 'category' | 'family' | 'postal' | 'address' | 'householder' | 'memo'
type Align = 'left' | 'center' | 'right'
// 列幅はヘッダ・データとも1行で収まる幅にする（見切れ防止）。wrap の列だけ折り返す
const COLS: { key: ColKey; header: string; width: number; align: Align; wrap?: boolean }[] = [
  { key: 'no', header: 'No', width: 5, align: 'center' },
  { key: 'tag', header: '区分', width: 11, align: 'left' },
  { key: 'taxCat', header: '甲欄・乙欄', width: 10, align: 'center' },
  { key: 'name', header: '氏名', width: 16, align: 'left' },
  { key: 'kana', header: 'フリガナ', width: 16, align: 'left' },
  { key: 'relation', header: '続柄', width: 10, align: 'left' },
  { key: 'birth', header: '生年月日', width: 12, align: 'center' },
  { key: 'income', header: '年収（円）', width: 12, align: 'right' },
  { key: 'disability', header: '障害者区分', width: 15, align: 'center' },
  { key: 'widow', header: '寡婦・ひとり親', width: 15, align: 'center' },
  { key: 'student', header: '勤労学生', width: 10, align: 'center' },
  { key: 'together', header: '同居・別居', width: 10, align: 'center' },
  { key: 'category', header: '控除区分（目安）', width: 36, align: 'left', wrap: true },
  { key: 'family', header: '配偶者・扶養親族', width: 44, align: 'left', wrap: true },
  { key: 'postal', header: '郵便番号', width: 10, align: 'center' },
  { key: 'address', header: '住所', width: 36, align: 'left', wrap: true },
  { key: 'householder', header: '世帯主（続柄）', width: 18, align: 'left' },
  { key: 'memo', header: '備考', width: 32, align: 'left', wrap: true },
]
const HEADERS = COLS.map((c) => c.header)
const col = (k: ColKey) => COLS.findIndex((c) => c.key === k) + 1
type RowVals = Partial<Record<ColKey, string | number | null>>
const rowArray = (v: RowVals) => COLS.map((c) => (v[c.key] === undefined ? '' : v[c.key]))

/** 本人行の項目名 → 列。修正されたセルだけを塗るために使う */
const SELF_FIELD_COL: Record<string, ColKey> = {
  taxCategory: 'taxCat',
  lastName: 'name', firstName: 'name', kanaLast: 'kana', kanaFirst: 'kana', birth: 'birth',
  selfDisability: 'disability', widow: 'widow', workingStudent: 'student', postal: 'postal', address: 'address',
  householder: 'householder', householderRelation: 'householder',
}
/** 家族行の項目名 → 列 */
const FAMILY_FIELD_COL: Record<string, ColKey> = {
  name: 'name', kana: 'kana', relation: 'relation', birth: 'birth', income: 'income', disability: 'disability', liveTogether: 'together',
}

/** 本人行に出す「配偶者・扶養親族」のまとめ（家族行と同じ内容を1セルに） */
function familySummary(d: Declaration, fyGregorian: number): string {
  if (d.taxCategory === 'otsu') return '（乙欄のため扶養控除の対象外）'
  const lines: string[] = []
  if (d.spouse.exists) {
    lines.push(`配偶者：${d.spouse.name || '（氏名なし）'}（${spouseCategory(d.spouse)}）`)
  }
  d.dependents.forEach((dep, i) => {
    const extra = [dependentCategory(dep, fyGregorian), dep.disability && dep.disability !== '非該当' ? dep.disability : '']
      .filter(Boolean).join('・')
    lines.push(`扶養${i + 1}：${[dep.relation, dep.name].filter(Boolean).join(' ') || '（氏名なし）'}（${extra}）`)
  })
  if (!lines.length) return 'なし'
  const head = `配偶者${d.spouse.exists ? 'あり' : 'なし'}・扶養親族${d.dependents.length}人`
  return [head, ...lines].join('\n')
}

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
  ws.columns = COLS.map((c) => ({ width: c.width }))

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
    // 呼び出し元で補っていなくても落ちないように（扶養0人は dependents が無い状態で届く）
    const d = normalizeDeclaration(ent.decl) || ent.decl
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
    if (d.taxCategory === 'otsu') memo.push('乙欄（他社で年末調整・この会社では対象外）')
    const taxCat = d.taxCategory === 'otsu' ? '乙欄' : '甲欄'
    if (d.noChange) memo.push('前年と相違なし')
    if (ent.submittedAt) memo.push(`提出 ${fmtDate(ent.submittedAt)}`)

    // 本人行
    const selfRow = ws.addRow(rowArray({
      no, tag: '本人', taxCat,
      name: `${d.lastName} ${d.firstName}`.trim() || ent.employeeName,
      kana: `${d.kanaLast} ${d.kanaFirst}`.trim(),
      relation: '—',
      birth: d.birth || '',
      income: null,
      disability: d.selfDisability === '非該当' ? '' : d.selfDisability,
      widow: d.widow === '非該当' ? '' : d.widow,
      student: d.workingStudent ? '該当' : '',
      family: familySummary(d, opts.fyGregorian),
      postal: d.postal || '',
      address: d.address || '',
      householder: d.householder ? `${d.householder}（${d.householderRelation}）` : '',
      memo: memo.join('・'),
    }))
    styleRow(selfRow, SELF_FILL, true)
    // 乙欄は目立たせる（この会社では年末調整しない人を見落とさないため）
    if (d.taxCategory === 'otsu') {
      const c = selfRow.getCell(col('taxCat'))
      c.font = { name: FONT, size: 9, bold: true, color: { argb: 'FFB42318' } }
    }
    markChanges(selfRow, byTarget.get('self') || [], SELF_FIELD_COL)

    // 配偶者行
    if (d.spouse.exists) {
      const r = ws.addRow(rowArray({
        tag: '└ 配偶者',
        name: d.spouse.name, kana: d.spouse.kana, relation: '配偶者',
        birth: d.spouse.birth || '',
        income: d.spouse.income ? numYen(d.spouse.income) : null,
        category: spouseCategory(d.spouse),
        memo: `${`${d.lastName} ${d.firstName}`.trim() || ent.employeeName} の配偶者`,
      }))
      styleRow(r, FAMILY_FILL, false)
      markChanges(r, byTarget.get('spouse') || [], FAMILY_FIELD_COL)
    }

    // 扶養親族行
    d.dependents.forEach((dep, i) => {
      const r = ws.addRow(rowArray({
        tag: `└ 扶養${i + 1}`,
        name: dep.name, kana: dep.kana, relation: dep.relation || '',
        birth: dep.birth || '',
        income: dep.income ? numYen(dep.income) : null,
        disability: dep.disability === '非該当' ? '' : dep.disability,
        together: dep.liveTogether ? '同居' : '別居',
        category: dependentCategory(dep, opts.fyGregorian),
        memo: `${`${d.lastName} ${d.firstName}`.trim() || ent.employeeName} の扶養親族`,
      }))
      styleRow(r, FAMILY_FILL, false)
      markChanges(r, byTarget.get(`dep${i}`) || [], FAMILY_FIELD_COL)
    })

    // 本人が外した家族は、申告内容には行が無いので取消線のグレー行として残す
    // （「前年いたのに今年いない」を見落とさないため）
    for (const c of changes.filter((x) => x.kind === 'removed')) {
      const r = ws.addRow(rowArray({
        tag: `${CHANGE_MARK.removed} ${c.label.startsWith('配偶者') ? '配偶者' : '扶養'}（削除）`,
        name: c.before, income: null,
        memo: `本人が外しました（変更前: ${c.before}）`,
      }))
      styleRow(r, DEL_FILL, false)
      for (let cc = 1; cc <= HEADERS.length; cc++) {
        const cell = r.getCell(cc)
        cell.font = { name: FONT, size: 9, color: { argb: DEL_INK }, strike: true }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: DEL_FILL } }
      }
      r.getCell(col('memo')).font = { name: FONT, size: 9, color: { argb: DEL_INK } }
    }
  }

  buildChangeSheet(wb, allChanges, opts)

  const buf = await wb.xlsx.writeBuffer()
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
}

/** 修正されたセルを黄色に、新しく追加された行を緑にする。
 *  白黒で印刷しても分かるよう、区分セルに記号（★＋）を足し、変更前の値をセルのメモに残す。 */
function markChanges(row: import('exceljs').Row, changes: Change[], fieldCol: Record<string, ColKey>) {
  if (!changes.length) return
  const added = changes.find((c) => c.kind === 'added' && !c.field)
  if (added) {
    for (let c = 1; c <= HEADERS.length; c++) {
      const cell = row.getCell(c)
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ADD_FILL } }
      cell.font = { ...(cell.font || { name: FONT, size: 9 }), color: { argb: ADD_INK } }
    }
    const tag = row.getCell(col('tag'))
    tag.value = `${CHANGE_MARK.added} ${String(tag.value ?? '')}`.trim()
    tag.font = { name: FONT, size: 9, bold: true, color: { argb: ADD_INK } }
    return
  }
  let marked = 0
  for (const ch of changes) {
    if (!ch.field) continue
    const key = fieldCol[ch.field]
    if (!key) continue
    const cell = row.getCell(col(key))
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: MOD_FILL } }
    cell.font = { ...(cell.font || { name: FONT, size: 9 }), bold: true, color: { argb: MOD_INK } }
    cell.note = `変更前: ${ch.before || '（なし）'}`
    marked++
  }
  if (marked) {
    const tag = row.getCell(col('tag'))
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
  COLS.forEach((def, i) => {
    const cell = row.getCell(i + 1)
    cell.font = { name: FONT, size: 9, bold: isSelf && (def.key === 'tag' || def.key === 'name' || def.key === 'taxCat'), color: { argb: 'FF243042' } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } }
    cell.border = thinBorder()
    cell.alignment = { vertical: 'middle', horizontal: def.align, wrapText: !!def.wrap }
    if (def.key === 'income') cell.numFmt = '#,##0'
  })
  if (!isSelf) {
    // 家族行の区分セルは淡い金で「本人の下にぶら下がる家族」であることを示す
    row.getCell(col('tag')).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SPOUSE_TAG_FILL } }
  }
}
