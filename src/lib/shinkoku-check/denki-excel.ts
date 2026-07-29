// 申告書チェック（電気供給業）: 茨城県「電気供給業とその他の事業を併せて行う法人の計算書」
// Excel（様式第1号・様式第2号・付表1〜3）を読み取る。ブラウザ内で完結・API不使用。
//
// 県からダウンロードした版によって行が増減しうるため、固定セル番地ではなく
// **ラベル文字列をアンカーにして行を特定する**方式にしている。
// 数式セルか手入力かも保持し、「本来は自動計算される欄を手打ちで上書きしていないか」を後段で検査する。
import * as XLSX from 'xlsx'
import { readSpreadsheet } from '@/lib/bank-statement/spreadsheet-reader'

// ---------- セル値の取り出し ----------

/** セル1つ分の読み取り結果。数式セルかどうかを保持する */
export interface Cell {
  /** 表示されている数値（数式ならそのキャッシュ値）。数値でなければ null */
  num: number | null
  /** 文字列表現（ラベル判定用） */
  text: string
  /** 数式セルなら true（＝本来は自動計算される欄） */
  formula: boolean
  /** セルが存在するか（空欄と 0 の区別に使う） */
  present: boolean
}

const EMPTY_CELL: Cell = { num: null, text: '', formula: false, present: false }

function colName(c: number): string {
  // 0→A, 25→Z, 26→AA
  let s = ''
  let n = c
  for (;;) {
    s = String.fromCharCode(65 + (n % 26)) + s
    n = Math.floor(n / 26) - 1
    if (n < 0) break
  }
  return s
}

function readCell(ws: XLSX.WorkSheet, row: number, col: number): Cell {
  const raw = ws[`${colName(col)}${row}`] as XLSX.CellObject | undefined
  if (!raw) return EMPTY_CELL
  const formula = typeof raw.f === 'string' && raw.f.length > 0
  let num: number | null = null
  if (typeof raw.v === 'number' && isFinite(raw.v)) num = raw.v
  const text = raw.v == null ? '' : String(raw.v)
  return { num, text, formula, present: true }
}

/** ラベル比較用の正規化（空白・全角空白・改行を落とす） */
export function normLabel(s: string): string {
  return s.replace(/[\s　]+/g, '')
}

function cellLabel(ws: XLSX.WorkSheet, row: number, col: number): string {
  return normLabel(readCell(ws, row, col).text)
}

/** 行の中から最初に見つかった非空ラベルを返す（結合セル対策で複数列を左から見る） */
function rowLabel(ws: XLSX.WorkSheet, row: number, cols: number[]): string {
  for (const c of cols) {
    const s = cellLabel(ws, row, c)
    if (s) return s
  }
  return ''
}

function sheetRowRange(ws: XLSX.WorkSheet): { first: number; last: number } {
  const ref = ws['!ref']
  if (!ref) return { first: 1, last: 0 }
  const r = XLSX.utils.decode_range(ref)
  return { first: r.s.r + 1, last: r.e.r + 1 }
}

// ---------- 様式第1号（あん分計算の要否判定表） ----------

export interface DenkiForm1 {
  /** 事業期間の表示文字列 */
  period: string
  /** 法人名 */
  company: string
  /** (1)〜(9) 各欄。キーは 1..9 */
  items: Map<number, Cell>
  /** 判定: 従たる事業の売上金額 */
  judgeMinor: Cell
  /** 判定: 主たる事業の売上金額 */
  judgeMajor: Cell
  /** 判定比率（従たる／主たる。小数第3位） */
  judgeRatio: Cell
  /** あん分率の分子（(9)） */
  anbunNumer: Cell
  /** あん分率の分母（(3)+(9)） */
  anbunDenom: Cell
  /** (10) あん分率（小数第8位） */
  anbunRatio: Cell
}

// （１）〜（９）の丸数字ではない全角括弧付き漢数字。Excel上は「（１）」等
const KANSUJI = ['', '１', '２', '３', '４', '５', '６', '７', '８', '９']

function parseForm1(ws: XLSX.WorkSheet): DenkiForm1 {
  const { last } = sheetRowRange(ws)
  const items = new Map<number, Cell>()
  let period = ''
  let company = ''
  let judgeMinor = EMPTY_CELL
  let judgeMajor = EMPTY_CELL
  let judgeRatio = EMPTY_CELL
  let anbunNumer = EMPTY_CELL
  let anbunDenom = EMPTY_CELL
  let anbunRatio = EMPTY_CELL

  for (let r = 1; r <= last; r++) {
    // 事業期間・法人名（ラベルの右隣）
    for (let c = 0; c <= 8; c++) {
      const lab = cellLabel(ws, r, c)
      if (!period && lab === '事業期間') period = readCell(ws, r, c + 1).text.trim()
      if (!company && lab === '法人名') company = readCell(ws, r, c + 1).text.trim()
    }
    // （１）〜（９）は E列に置かれる。列がずれる版に備えて A〜F を走査する
    for (let c = 0; c <= 5; c++) {
      const lab = cellLabel(ws, r, c)
      const m = lab.match(/^（([１-９])）$/)
      if (!m) continue
      const n = KANSUJI.indexOf(m[1])
      if (n < 1 || items.has(n)) continue
      // 金額は右隣（F列。結合セル F:H の先頭）
      items.set(n, readCell(ws, r, c + 1))
    }
    const labAll = normLabel([0, 1, 2, 3].map((c) => readCell(ws, r, c).text).join(''))
    if (!judgeMinor.present && /従たる事業の売上金額/.test(labAll)) {
      judgeMinor = readCell(ws, r, 5) // F列
      judgeRatio = readCell(ws, r, 7) // H列
    }
    if (!judgeMajor.present && /主たる事業の売上金額/.test(labAll)) {
      judgeMajor = readCell(ws, r, 5)
    }
    if (!anbunRatio.present && /^あん分率/.test(labAll)) {
      anbunNumer = readCell(ws, r, 5)
      anbunRatio = readCell(ws, r, 7)
      anbunDenom = readCell(ws, r + 1, 5)
    }
  }
  return {
    period,
    company,
    items,
    judgeMinor,
    judgeMajor,
    judgeRatio,
    anbunNumer,
    anbunDenom,
    anbunRatio,
  }
}

// ---------- 様式第2号（所得金額に関する計算書） ----------

/** 様式2号の1行。D〜I列の意味は様式のヘッダに対応する */
export interface Form2Row {
  row: number
  /** A/B/C列から拾ったラベル（空の明細行もある） */
  label: string
  total: Cell // D 総額
  shotokuFix: Cell // E 所得課税事業（区分されている）
  shotokuApp: Cell // F 共通経費をあん分（③×①）
  denkiFix: Cell // G 電気供給業（区分されている）
  denkiApp: Cell // H 共通経費をあん分（③−②）
  kyotsu: Cell // I 共通経費③
}

export interface DenkiForm2 {
  /** ①あん分率（様式1号(10)からの転記） */
  anbunRatio: Cell
  rows: Form2Row[]
  /** ラベル→行（見出し行のみ） */
  byLabel: Map<string, Form2Row>
  /** 合計行の課税標準（ｲ+ﾛ＝所得課税事業、ﾊ+ﾆ＝電気供給業） */
  totalShotoku: Cell
  totalDenki: Cell
  totalAll: Cell
}

const F2_COLS = { total: 3, shotokuFix: 4, shotokuApp: 5, denkiFix: 6, denkiApp: 7, kyotsu: 8 }

function parseForm2(ws: XLSX.WorkSheet): DenkiForm2 {
  const { last } = sheetRowRange(ws)
  let anbunRatio = EMPTY_CELL
  let headerRow = 0
  for (let r = 1; r <= last; r++) {
    const labAll = normLabel([0, 1, 2].map((c) => readCell(ws, r, c).text).join(''))
    if (!anbunRatio.present && /^あん分率/.test(labAll)) anbunRatio = readCell(ws, r, F2_COLS.total)
    if (!headerRow && cellLabel(ws, r, 0) === '科目' && cellLabel(ws, r, F2_COLS.total) === '総額') {
      headerRow = r
    }
  }
  const rows: Form2Row[] = []
  const byLabel = new Map<string, Form2Row>()
  let totalShotoku = EMPTY_CELL
  let totalDenki = EMPTY_CELL
  let totalAll = EMPTY_CELL
  // データ行はヘッダの2行下（ヘッダは2段組）から「合　計」行まで
  const start = headerRow ? headerRow + 2 : 8
  for (let r = start; r <= last; r++) {
    const label = rowLabel(ws, r, [0, 1, 2])
    const rec: Form2Row = {
      row: r,
      label,
      total: readCell(ws, r, F2_COLS.total),
      shotokuFix: readCell(ws, r, F2_COLS.shotokuFix),
      shotokuApp: readCell(ws, r, F2_COLS.shotokuApp),
      denkiFix: readCell(ws, r, F2_COLS.denkiFix),
      denkiApp: readCell(ws, r, F2_COLS.denkiApp),
      kyotsu: readCell(ws, r, F2_COLS.kyotsu),
    }
    if (label === '合計') {
      // 合計行は E列に「課税標準となる所得金額 ｲ+ﾛ」の見出し、F列に金額、H列に電気供給業分
      totalAll = rec.total
      totalShotoku = rec.shotokuApp
      totalDenki = rec.denkiApp
      rows.push(rec)
      break
    }
    // 全列が空の行はスキップ（記載上の注意より下へ抜けないよう合計行で打ち切っている）
    const anyValue =
      rec.total.present ||
      rec.shotokuFix.present ||
      rec.shotokuApp.present ||
      rec.denkiFix.present ||
      rec.denkiApp.present ||
      rec.kyotsu.present
    if (!label && !anyValue) continue
    rows.push(rec)
    if (label && !byLabel.has(label)) byLabel.set(label, rec)
  }
  return { anbunRatio, rows, byLabel, totalShotoku, totalDenki, totalAll }
}

// ---------- 付表1〜3（明細書） ----------

/** 付表の1行。C=総額 D=所得課税事業分 E=電気供給業分 F=共通分 */
export interface FuhyoRow {
  row: number
  label: string
  total: Cell
  shotoku: Cell
  denki: Cell
  kyotsu: Cell
}

export interface FuhyoBlock {
  /** ブロック名（付表2・付表3は「営業外収益」「営業外費用」等で2ブロックある） */
  name: string
  details: FuhyoRow[]
  sum: FuhyoRow
}

const FU_COLS = { total: 2, shotoku: 3, denki: 4, kyotsu: 5 }

function readFuhyoRow(ws: XLSX.WorkSheet, r: number): FuhyoRow {
  // 明細の科目名はB列。A列は「内訳」の見出しなので科目名としては採らない
  const b = cellLabel(ws, r, 1)
  const a = cellLabel(ws, r, 0)
  return {
    row: r,
    label: b || (a === '内訳' ? '' : a),
    total: readCell(ws, r, FU_COLS.total),
    shotoku: readCell(ws, r, FU_COLS.shotoku),
    denki: readCell(ws, r, FU_COLS.denki),
    kyotsu: readCell(ws, r, FU_COLS.kyotsu),
  }
}

/** 「内訳」〜「合計」を1ブロックとして拾う。付表2・付表3は2ブロック入っている */
function parseFuhyo(ws: XLSX.WorkSheet, sheetName: string): FuhyoBlock[] {
  const { last } = sheetRowRange(ws)
  const out: FuhyoBlock[] = []
  let blockStart = 0
  let blockName = ''
  let pendingName = ''
  for (let r = 1; r <= last; r++) {
    const a = cellLabel(ws, r, 0)
    // 「１　営業外収益」「２　営業外費用」のような小見出しをブロック名として覚えておく
    const m = a.match(/^[０-９0-9１-９]+[　\s]*(.+)$/)
    if (m && !/^内訳$/.test(a) && !readCell(ws, r, FU_COLS.total).present && m[1].length <= 12) {
      pendingName = m[1]
    }
    if (a === '内訳') {
      blockStart = r
      blockName = pendingName || sheetName
      continue
    }
    if (a === '合計' && blockStart) {
      const details: FuhyoRow[] = []
      for (let d = blockStart; d < r; d++) {
        const rec = readFuhyoRow(ws, d)
        // ラベルも金額も無い行は明細として扱わない
        if (!rec.label && !rec.shotoku.present && !rec.denki.present && !rec.kyotsu.present) {
          // 総額列だけ数式で 0 が入っている空行は無視するが、行位置は保つ
          if (!rec.total.present) continue
          if (rec.total.formula && (rec.total.num ?? 0) === 0) continue
        }
        details.push(rec)
      }
      out.push({ name: blockName, details, sum: readFuhyoRow(ws, r) })
      blockStart = 0
      pendingName = ''
    }
  }
  return out
}

// ---------- ワークブック全体 ----------

export interface DenkiWorkbook {
  fileName: string
  form1: DenkiForm1
  form2: DenkiForm2
  /** 付表1（販管費） */
  fuhyo1: FuhyoBlock[]
  /** 付表2（営業外収益・営業外費用） */
  fuhyo2: FuhyoBlock[]
  /** 付表3（税務加算・税務減算） */
  fuhyo3: FuhyoBlock[]
  /** 読み取り時に気づいた注意（シートが見つからない等） */
  warnings: string[]
  /** 計算結果が保存されていない主要欄の数。
   *  0でない場合、そのExcelは「Excelで開いて保存し直す」まで正しく検証できない。 */
  missingValues: number
  /** 本来は自動計算される欄が手入力の数値で上書きされている箇所の数 */
  handTyped: number
}

/** 様式に必ず数式が入っている欄。ここが空なら「計算結果が保存されていない」と判断する。
 *  （xlsxの仕様上、数式だけで計算結果が保存されていないセルは値として読み出せない） */
function coreDerivedCells(wb: Omit<DenkiWorkbook, 'missingValues' | 'handTyped'>): Cell[] {
  const c: (Cell | undefined)[] = [
    wb.form1.items.get(3),
    wb.form1.items.get(9),
    wb.form1.anbunRatio,
    wb.form2.anbunRatio,
    wb.form2.totalAll,
    wb.form2.totalShotoku,
    wb.form2.totalDenki,
  ]
  return c.filter((x): x is Cell => !!x)
}

/** 計算結果が保存されていない欄の数（0でなければ照合そのものが成り立たない） */
function countMissingValues(wb: Omit<DenkiWorkbook, 'missingValues' | 'handTyped'>): number {
  const core = coreDerivedCells(wb)
  const missing = 7 - core.filter((x) => x.present).length
  // 1〜2個なら県の様式の版違いで場所を取り違えた可能性がある。3個以上なら保存の問題
  return missing >= 3 ? missing : 0
}

/** 本来は自動計算される欄が、手入力の数値で上書きされている箇所 */
function findHandTyped(wb: Omit<DenkiWorkbook, 'missingValues' | 'handTyped'>): number {
  return coreDerivedCells(wb).filter((x) => x.present && !x.formula).length
}

/** シート名のゆらぎ（様式1号／様式第1号／参考様式第1号 …）を吸収して探す */
function findSheet(wb: XLSX.WorkBook, res: RegExp[]): XLSX.WorkSheet | null {
  for (const re of res) {
    const name = wb.SheetNames.find((n) => re.test(normLabel(n)))
    if (name) return wb.Sheets[name]
  }
  return null
}

export class DenkiExcelError extends Error {}

/** 茨城県の区分計算書Excelを読み取る。想定外のファイルなら DenkiExcelError を投げる */
export function parseDenkiWorkbook(buffer: ArrayBuffer, fileName: string): DenkiWorkbook {
  let wb: XLSX.WorkBook
  try {
    wb = readSpreadsheet(buffer, { cellFormula: true })
  } catch (e) {
    throw new DenkiExcelError(
      'Excelファイルとして読み取れませんでした（' + (e instanceof Error ? e.message : String(e)) + '）',
    )
  }
  const warnings: string[] = []
  const ws1 = findSheet(wb, [/^(参考)?様式(第)?1号$/, /^(参考)?様式(第)?１号$/, /様式.*1.*号/, /要否判定/])
  const ws2 = findSheet(wb, [/^(参考)?様式(第)?2号$/, /^(参考)?様式(第)?２号$/, /様式.*2.*号/, /所得金額に関する計算書/])
  if (!ws1 || !ws2) {
    throw new DenkiExcelError(
      '「様式1号（あん分計算の要否判定表）」と「様式2号（所得金額に関する計算書）」のシートが見つかりません。' +
        '茨城県の「電気供給業とその他の事業を併せて行う法人の計算書」のExcelをそのままアップロードしてください。' +
        `（読み取れたシート: ${wb.SheetNames.join('、') || 'なし'}）`,
    )
  }
  const wsF1 = findSheet(wb, [/^付表1$/, /^付表１$/, /付表.*1/, /販売費及び一般管理費に関する明細書/])
  const wsF2 = findSheet(wb, [/^付表2$/, /^付表２$/, /付表.*2/, /営業外収益及び費用に関する明細書/])
  const wsF3 = findSheet(wb, [/^付表3$/, /^付表３$/, /付表.*3/, /税務加算及び減算/])
  if (!wsF1) warnings.push('付表1（販売費及び一般管理費）のシートが見つかりませんでした。')
  if (!wsF2) warnings.push('付表2（営業外収益・費用）のシートが見つかりませんでした。')
  if (!wsF3) warnings.push('付表3（税務加算・減算）のシートが見つかりませんでした。')

  const form1 = parseForm1(ws1)
  const form2 = parseForm2(ws2)
  if (!form2.rows.length) {
    throw new DenkiExcelError('様式2号から明細行を読み取れませんでした。様式が改変されていないかご確認ください。')
  }
  if (form1.items.size === 0) {
    warnings.push('様式1号の（１）〜（９）欄を読み取れませんでした。')
  }
  const parsed = {
    fileName,
    form1,
    form2,
    fuhyo1: wsF1 ? parseFuhyo(wsF1, '販売費及び一般管理費') : [],
    fuhyo2: wsF2 ? parseFuhyo(wsF2, '営業外損益') : [],
    fuhyo3: wsF3 ? parseFuhyo(wsF3, '税務加算・減算') : [],
    warnings,
  }
  return {
    ...parsed,
    missingValues: countMissingValues(parsed),
    handTyped: findHandTyped(parsed),
  }
}

// ---------- 端数処理（様式の記載上の注意に対応） ----------

/** 1円未満切捨（様式2号の「②共通をあん分」欄）。負数は0方向へ丸めるExcelのROUNDDOWNに合わせる */
export function roundDown0(v: number): number {
  return v >= 0 ? Math.floor(v) : -Math.floor(-v)
}

/** 小数第n位まで（第n+1位以下切捨）。あん分率は第8位まで */
export function roundDownDigits(v: number, digits: number): number {
  const k = Math.pow(10, digits)
  return roundDown0(v * k) / k
}

/** 四捨五入（判定比率は小数第3位） */
export function roundHalfUpDigits(v: number, digits: number): number {
  const k = Math.pow(10, digits)
  // Excel の ROUND は「絶対値で四捨五入」。負数でも同じ挙動になるよう符号を分離する
  const s = v < 0 ? -1 : 1
  return (s * Math.round(Math.abs(v) * k + Number.EPSILON * Math.abs(v) * k)) / k
}
