import type { PayrollData, PayrollEmployee, PayrollLedger, PayrollLedgerEmployee, PayrollLedgerMonth } from './types'
import type { PayrollSummaryOcr } from './gemini-client'

/** 令和などの和暦「令和7年8月」→ 既定の支給日（月末日 YYYY-MM-DD）を推定 */
function periodToDefaultPayDate(period: string): string {
  const m = (period || '').match(/(令和|平成|R|H)?\s*(\d{1,2})\s*年\s*(\d{1,2})\s*月/)
  if (!m) return ''
  const era = m[1] || '令和'
  const y = parseInt(m[2], 10), mo = parseInt(m[3], 10)
  if (!y || !mo) return ''
  const base = era === '平成' || era === 'H' ? 1988 : 2018 // 令和1=2019 → 2018+年
  const gy = base + y
  const last = new Date(gy, mo, 0).getDate() // 当月末日
  return `${gy}-${String(mo).padStart(2, '0')}-${String(last).padStart(2, '0')}`
}

/** 給与明細一覧表OCR結果 → PayrollData（貼り付け解析と同じ構造）。
 *  同名項目は出現順で (2)(3) を付けて一意化し、従業員側も同じ出現順で対応付ける。 */
export function payrollOcrToData(r: PayrollSummaryOcr): PayrollData {
  const payHeaders = uniquifyNames((r.payItemOrder || []).filter(Boolean))
  const deductHeaders = uniquifyNames((r.deductItemOrder || []).filter(Boolean))
  const uniqEntries = (list: { item: string; amount: number }[]) => {
    const seen = new Map<string, number>()
    return (list || []).map((p) => {
      const c = (seen.get(p.item) || 0) + 1
      seen.set(p.item, c)
      return { key: norm(c === 1 ? p.item : `${p.item}(${c})`), amount: toNum(p.amount) }
    })
  }
  const employees: PayrollEmployee[] = (r.employees || [])
    .map((e, idx) => {
      const payMap = new Map<string, number>()
      for (const p of uniqEntries(e.pay || [])) payMap.set(p.key, p.amount)
      const dedMap = new Map<string, number>()
      for (const p of uniqEntries(e.deduct || [])) dedMap.set(p.key, p.amount)
      const items = [
        ...payHeaders.map((h) => ({ name: h, amount: payMap.get(norm(h)) ?? 0 })),
        ...deductHeaders.map((h) => ({ name: h, amount: dedMap.get(norm(h)) ?? 0 })),
      ]
      const totalPay = toNum(e.totalPay) || items.find((i) => norm(i.name) === norm('支給合計額'))?.amount || 0
      const totalDeductions = toNum(e.totalDeductions) || items.find((i) => norm(i.name) === norm('控除合計額'))?.amount || 0
      const netPay = toNum(e.netPay) || items.find((i) => norm(i.name) === norm('差引支給額'))?.amount || (totalPay - totalDeductions)
      return { no: Number(e.no) || idx + 1, name: String(e.name || '').trim(), isExecutive: false, items, totalPay, totalDeductions, netPay }
    })
    .filter((e) => e.name && !/^(合計|計|総合計)$/.test(e.name))
  return {
    period: String(r.period || ''),
    paymentDate: r.paymentDate && /\d{4}-\d{2}-\d{2}/.test(r.paymentDate) ? r.paymentDate : periodToDefaultPayDate(r.period),
    companyName: String(r.companyName || ''),
    employeeCount: employees.length,
    employees, payHeaders, deductHeaders,
  }
}

// ===== 年間・従業員別シート・月列形式の賃金台帳 =====
const Z2H = (s: string) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
const norm = (v: unknown) => Z2H(String(v ?? '')).replace(/[\s　]/g, '')
const toNum = (v: unknown): number => { const n = parseFloat(Z2H(String(v ?? '')).replace(/[,，円]/g, '')); return isFinite(n) ? Math.round(n) : 0 }

/** ワークブックが「年間・従業員別シート・月列形式」かを判定 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isPayrollLedgerWorkbook(wb: { SheetNames: string[]; Sheets: Record<string, unknown> }, X: any): boolean {
  // どれか1シートに「○月」見出しが複数 ＆ 総支給額/差引支給 行があればその形式とみなす
  return wb.SheetNames.some((sn) => sheetLooksLikeLedger(wb.Sheets[sn], X))
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sheetRows(ws: unknown, X: any): unknown[][] {
  return X.utils.sheet_to_json(ws, { header: 1, raw: true, blankrows: false, defval: null }) as unknown[][]
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sheetLooksLikeLedger(ws: unknown, X: any): boolean {
  const rows = sheetRows(ws, X)
  let monthHdr = false, totalRow = false
  for (const r of rows) {
    if (!r) continue
    const monthCells = r.filter((c) => /^[０-９0-9]{1,2}月$/.test(norm(c))).length
    if (monthCells >= 6) monthHdr = true
    if (r.some((c) => { const n = norm(c); return n === '総支給額' || n === '差引支給金額' || n === '差引支給額' })) totalRow = true
  }
  return monthHdr && totalRow
}

/** ワークブック全体を年間賃金台帳としてパース（従業員別シート×月） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parsePayrollLedgerWorkbook(wb: { SheetNames: string[]; Sheets: Record<string, unknown> }, X: any): PayrollLedger {
  let year = 0
  let companyName = ''
  const employees: PayrollLedgerEmployee[] = []
  for (const sn of wb.SheetNames) {
    const ws = wb.Sheets[sn]
    if (!sheetLooksLikeLedger(ws, X)) continue   // 原紙・Sheet1 等はスキップ
    const rows = sheetRows(ws, X)
    // 年（"2026年 賃金台帳"）
    for (const r of rows) { const m = norm((r || []).join('')).match(/(\d{4})年/); if (m) { year = year || parseInt(m[1]); break } }
    // 月見出し行 → 月→列のマップ
    let monthCol = new Map<number, number>()
    for (const r of rows) {
      if (!r) continue
      const m = new Map<number, number>()
      r.forEach((c, ci) => { const mm = norm(c).match(/^([０-９0-9]{1,2})月$/); if (mm) m.set(parseInt(Z2H(mm[1])), ci) })
      if (m.size >= 6) { monthCol = m; break }
    }
    if (!monthCol.size) continue
    // 氏名：基本はシート名（イメージと一致しやすい）。シート名が汎用名なら台帳内の「名前」ラベル直下セルを採用
    let name = sn.trim()
    if (/^(sheet\d*|シート\d*|原紙|template)$/i.test(name) || !name) {
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i]; if (!r) continue
        const li = r.findIndex((c) => norm(c) === '名前')
        if (li >= 0) {
          const below = (rows[i + 1] || [])[li]   // ラベルの直下セル＝氏名
          if (below != null && norm(below).length >= 2 && !/^\d+$/.test(norm(below))) name = String(below).replace(/[\s　]+/g, '').trim()
          break
        }
      }
    }
    // 会社名（㈱/㈲/株式会社/有限会社 を含むセル）
    if (!companyName) { for (const r of rows) { const c = (r || []).find((x) => /㈱|㈲|株式会社|有限会社/.test(String(x ?? ''))); if (c) { companyName = String(c).trim(); break } } }
    // 各項目行（ラベル一致）の値を月ごとに取得
    const rowByLabel = (labels: string[]): unknown[] | null => {
      for (const r of rows) { if (r && r.some((c) => labels.includes(norm(c)))) return r }
      return null
    }
    const grossR = rowByLabel(['総支給額'])
    const siR = rowByLabel(['社会保険料合計'])
    const itaxR = rowByLabel(['所得税', '源泉所得税'])
    const rtaxR = rowByLabel(['住民税'])
    const netR = rowByLabel(['差引支給金額', '差引支給額'])
    const months: PayrollLedgerMonth[] = []
    for (const [mo, col] of Array.from(monthCol.entries()).sort((a, b) => a[0] - b[0])) {
      const gross = grossR ? toNum(grossR[col]) : 0
      if (gross <= 0) continue   // 支給のない月は対象外
      months.push({
        month: mo,
        gross,
        socialInsurance: siR ? toNum(siR[col]) : 0,
        incomeTax: itaxR ? toNum(itaxR[col]) : 0,
        residentTax: rtaxR ? toNum(rtaxR[col]) : 0,
        netPay: netR ? toNum(netR[col]) : 0,
      })
    }
    if (months.length) employees.push({ name, isExecutive: false, months })
  }
  return { kind: 'ledger', year, companyName, employees }
}

/** ファイルを年間賃金台帳としてパース（.xls/.xlsx） */
export async function parsePayrollLedgerFile(file: File): Promise<PayrollLedger> {
  const XLSX = await import('xlsx')
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf, { type: 'array' })
  return parsePayrollLedgerWorkbook(wb as never, XLSX)
}

/** ファイルが年間賃金台帳形式かを判定（.xls/.xlsx） */
export async function detectPayrollLedgerFile(file: File): Promise<boolean> {
  const name = file.name.toLowerCase()
  if (!(name.endsWith('.xlsx') || name.endsWith('.xls'))) return false
  const XLSX = await import('xlsx')
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf, { type: 'array' })
  return wb.SheetNames.some((sn) => sheetLooksLikeLedger(wb.Sheets[sn], XLSX))
}

export function parsePayrollText(text: string): PayrollData {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, '').split('\t'))
  return parsePayrollRows(lines)
}

export async function parsePayrollFile(file: File): Promise<PayrollData> {
  const name = file.name.toLowerCase()
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    const XLSX = await import('xlsx')
    const buf = await file.arrayBuffer()
    const wb = XLSX.read(buf, { type: 'array' })
    const ws = wb.Sheets[wb.SheetNames[0]]
    const rows: string[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })
      .map((r: unknown) => (r as unknown[]).map((c) => String(c ?? '')))
    return parsePayrollRows(rows)
  }
  const buf = await file.arrayBuffer()
  const bytes = new Uint8Array(buf)
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    text = new TextDecoder('shift_jis').decode(bytes) // 会計ソフトのCSVはShift-JISが多い
  }
  text = text.replace(/^﻿/, '')
  const rawLines = text.split(/\r?\n/).filter((l) => l.length > 0)
  // 区切り文字を自動判定（タブ or カンマ）。CSVはカンマ、貼り付け由来はタブ。
  const sample = rawLines.find((l) => l.includes('基本給')) || rawLines[0] || ''
  const useTab = sample.split('\t').length > sample.split(',').length
  const rows = rawLines.map((l) => (useTab ? l.split('\t') : splitCsvLine(l)))
  return parsePayrollRows(rows)
}

/** CSV1行を分割（ダブルクォート対応） */
function splitCsvLine(line: string): string[] {
  const cols: string[] = []
  let field = ''
  let inQuote = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inQuote) {
      if (c === '"') { if (line[i + 1] === '"') { field += '"'; i++ } else inQuote = false } else field += c
    } else {
      if (c === '"') inQuote = true
      else if (c === ',') { cols.push(field); field = '' }
      else field += c
    }
  }
  cols.push(field)
  return cols
}

/** 「2026/07/05」「2026-7-5」「令和8年7月5日」→ YYYY-MM-DD */
function normPayDate(v: string): string {
  const s = Z2H(String(v ?? '')).trim()
  let m = s.match(/(\d{4})[/\-年.](\d{1,2})[/\-月.](\d{1,2})/)
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
  m = s.match(/令和(\d+)年(\d{1,2})月(\d{1,2})日/)
  if (m) return `${2018 + parseInt(m[1], 10)}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
  return ''
}

/** 同名ヘッダを「名前(2)」「名前(3)」に改名して一意化する。
 *  同名のままだと mapper/ダイアログの name 突合で「先頭列の二重計上＋2列目の消失」が起きるため必須。 */
function uniquifyNames(names: string[]): string[] {
  const seen = new Map<string, number>()
  return names.map((n) => {
    const c = (seen.get(n) || 0) + 1
    seen.set(n, c)
    return c === 1 ? n : `${n}(${c})`
  })
}

/** ヘッダ名から列位置を特定して解析（氏名ラベルがある一般的なCSV/Excel形式）。
 *  条件を満たさなければ null を返し、従来の位置ベース解析にフォールバックする。 */
function parseByHeader(
  rows: string[][], detailRowIdx: number, H: string[],
  meta: { period: string; paymentDate: string; companyName: string },
): PayrollData | null {
  const nz = (s: string) => (s || '').replace(/[\s　]/g, '')
  const find = (pred: (h: string) => boolean, from = 0) => {
    for (let i = from; i < H.length; i++) { if (H[i] && pred(nz(H[i]))) return i }
    return -1
  }
  const nameIdx = find((h) => /^(氏名|名前|従業員名|社員名|従業員氏名)$/.test(h))
  if (nameIdx < 0) return null
  const payTotalIdx = find((h) => h === '支給合計額' || h === '総支給額' || h === '支給合計')
  const taxableIdx = find((h) => h === '課税分合計' || h === '課税支給額' || h === '課税合計' || h === '税法上支給額' || h === '課税支給合計')
  const dedEndIdx = find((h) => h === '控除合計額' || h === '控除合計')
  const netIdx = find((h) => h === '差引支給額' || h === '差引支給' || h === '差引支給額計')
  const payDateIdx = find((h) => /支給日|支払日/.test(h))
  const noIdx = find((h) => /^(no|№|社員番号|従業員番号|社員コード|従業員コード|コード)$/i.test(h))
  // 支給項目の末尾＝課税分合計（無ければ支給合計額）
  const payEndAnchor = taxableIdx >= 0 ? taxableIdx : payTotalIdx
  // 給与でも賞与でも扱えるよう、支給項目の開始＝「氏名」の次にある最初の非空ヘッダとする
  // （給与＝基本給、賞与＝賞与 など。会社ごとの先頭列差にも強い）
  let payStartIdx = -1
  for (let i = nameIdx + 1; i < H.length; i++) { if (nz(H[i])) { payStartIdx = i; break } }
  if (payStartIdx < 0) return null
  // 賃金台帳として妥当か（支給合計/課税分合計・控除合計/差引支給額のいずれかが必要）
  if (payEndAnchor < 0 && dedEndIdx < 0 && netIdx < 0) return null
  const isBonus = /賞与|賞与額|一時金/.test(nz(H[payStartIdx])) || (find((h) => h === '基本給') < 0 && find((h) => /賞与/.test(h), nameIdx + 1) >= 0)
  // 支給項目の範囲: 氏名の次〜支給合計/総支給額の直前（無ければ課税分合計まで）。
  // 「…課税計 →(非)通勤費 → 総支給額」のように課税計の後ろに非課税支給列がある形式にも対応する。
  const payEndBase = payTotalIdx >= 0
    ? Math.max(payTotalIdx - 1, taxableIdx)
    : payEndAnchor
  let dedStartIdx = -1
  const anchor = Math.max(payEndBase, payTotalIdx, payStartIdx)
  for (let i = anchor + 1; i < H.length; i++) { if (nz(H[i]) && i !== payTotalIdx) { dedStartIdx = i; break } }
  const payEnd = payEndBase >= 0 ? payEndBase : (dedStartIdx >= 0 ? dedStartIdx - 1 : H.length - 1)
  const payCols: { name: string; idx: number }[] = []
  for (let i = payStartIdx; i <= payEnd && i < H.length; i++) { if (nz(H[i]) && i !== payTotalIdx) payCols.push({ name: H[i].trim(), idx: i }) }
  const dedCols: { name: string; idx: number }[] = []
  if (dedStartIdx >= 0) {
    const end = dedEndIdx >= 0 ? dedEndIdx : H.length - 1
    for (let i = dedStartIdx; i <= end && i < H.length; i++) { if (nz(H[i])) dedCols.push({ name: H[i].trim(), idx: i }) }
  }
  // 控除合計より右は通常「通勤費月額・基準額」等の情報列だが、ソフトによっては
  // 追加の控除項目がそこに置かれる（例: 子育て支援金＝社会保険料計に含まれる徴収額）。
  // 既知の控除名だけを拾い、控除合計の直前へ挿入する（金額列を誤って控除扱いしないため限定列挙）。
  if (dedEndIdx >= 0) {
    for (let i = dedEndIdx + 1; i < H.length; i++) {
      const n = nz(H[i])
      if (/^(こども・?)?子育て支援金$/.test(n) || /子ども・子育て支援金/.test(n)) {
        const at = dedCols.findIndex((c) => c.idx === dedEndIdx)
        const entry = { name: H[i].trim(), idx: i }
        if (at >= 0) dedCols.splice(at, 0, entry)
        else dedCols.push(entry)
      }
    }
  }
  if (!payCols.length) return null
  // ソフト固有の項目名を、mapper/ダイアログが前提とする標準名へ正規化する
  // （役員報酬・給与手当の金額は項目名「課税分合計」で参照されるため名称一致が必須）
  for (const c of payCols) { if (c.idx === taxableIdx && nz(c.name) !== '課税分合計') c.name = '課税分合計' }
  for (const c of dedCols) {
    const n = nz(c.name)
    if (n === '控除合計') c.name = '控除合計額'
    else if (n === '社会保険料計' || n === '社会保険合計' || n === '社保合計') c.name = '社会保険料合計'
  }

  // 同名ヘッダ（例:「手当」が2列）を (2)(3) 付きで一意化してから name 突合に使う
  const payNames = uniquifyNames(payCols.map((c) => c.name))
  payCols.forEach((c, i) => { c.name = payNames[i] })
  const dedNames = uniquifyNames(dedCols.map((c) => c.name))
  dedCols.forEach((c, i) => { c.name = dedNames[i] })

  const payHeaders = payCols.map((c) => c.name)
  const deductHeaders = dedCols.map((c) => c.name)
  const employees: PayrollEmployee[] = []
  let paymentDate = meta.paymentDate
  for (let i = detailRowIdx + 1; i < rows.length; i++) {
    const row = rows[i]
    if (!row) continue
    const name = (row[nameIdx] || '').trim()
    if (/^(合計|計|総合計|合計欄)$/.test(name)) break
    if (!name) continue
    const items = [
      ...payCols.map((c) => ({ name: c.name, amount: parseNum(row[c.idx]) })),
      ...dedCols.map((c) => ({ name: c.name, amount: parseNum(row[c.idx]) })),
    ]
    const totalPay = payTotalIdx >= 0 ? parseNum(row[payTotalIdx]) : 0
    const totalDeductions = dedEndIdx >= 0 ? parseNum(row[dedEndIdx]) : 0
    const netPay = netIdx >= 0 ? parseNum(row[netIdx]) : (totalPay - totalDeductions)
    const no = noIdx >= 0 ? (parseInt((row[noIdx] || '').replace(/[^\d]/g, ''), 10) || employees.length + 1) : employees.length + 1
    if (!paymentDate && payDateIdx >= 0) paymentDate = normPayDate(row[payDateIdx])
    employees.push({ no, name, isExecutive: false, items, totalPay, totalDeductions, netPay })
  }
  if (!employees.length) return null
  // 列ズレ検知（安全弁）：支給合計/差引の列があるのに全員0なら、ヘッダとデータ行の列が
  // 揃っていない可能性が高い → null を返して従来の位置ベース解析へフォールバックする。
  if ((payTotalIdx >= 0 || netIdx >= 0) &&
      employees.every((e) => e.totalPay === 0 && e.netPay === 0 && e.items.every((it) => it.amount === 0))) {
    return null
  }

  let period = meta.period
  if (!period && paymentDate) { const mm = paymentDate.match(/^(\d{4})-(\d{2})/); if (mm) period = `${mm[1]}-${mm[2]}` }
  return { period, paymentDate, companyName: meta.companyName, employeeCount: employees.length, employees, payHeaders, deductHeaders, isBonus }
}

function parsePayrollRows(rows: string[][]): PayrollData {
  let period = ''
  let paymentDate = ''
  let companyName = ''
  let employeeCount = 0

  // 1. メタ情報（先頭10行）
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const line = rows[i].join(' ')
    // 「令和7年4月」「令和7年2回目」両方対応
    const pm = line.match(/令和(\d+)年(\d+)(月|回目)/)
    if (pm && !period) {
      const y = 2018 + parseInt(pm[1])
      if (pm[3] === '回目') {
        period = `${y}-賞与${pm[2]}回`
      } else {
        period = `${y}-${pm[2].padStart(2, '0')}`
      }
    }
    // 西暦表記「2025年06月度」「2025年6月分」にも対応（選択月列など）
    if (!period) {
      const sm = line.match(/(20\d{2})年(\d{1,2})月(?:度|分)?/)
      if (sm) period = `${sm[1]}-${sm[2].padStart(2, '0')}`
    }
    const cm = line.match(/計[：:](\d+)名/)
    if (cm) employeeCount = parseInt(cm[1])
    const dm = line.match(/支給日[：:]令和(\d+)年(\d+)月(\d+)日/)
    if (dm) paymentDate = `${2018 + parseInt(dm[1])}-${dm[2].padStart(2, '0')}-${dm[3].padStart(2, '0')}`
    if (!companyName && /会社|事務所|製作所/.test(line)) {
      companyName = rows[i].find((c) => c.trim().length > 2)?.trim() || ''
    }
  }

  // 2. 詳細ヘッダ行（「基本給」または「賞与」を含む行）
  let detailRowIdx = -1
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].some((c) => c.trim() === '基本給' || c.trim() === '賞与')) {
      detailRowIdx = i
      break
    }
  }
  if (detailRowIdx < 0) throw new Error('ヘッダ行（基本給/賞与）が見つかりません')

  const detailHeaders = rows[detailRowIdx].map((c) => c.trim())

  // ヘッダ行に「氏名」ラベルがある形式（例: 給与,NO,従業員コード,氏名,基本給,…）は
  // 列位置をヘッダ名から特定して解析する（会社ごとのヘッダ差・先頭メタ列に強い）。
  const byHeader = parseByHeader(rows, detailRowIdx, detailHeaders, { period, paymentDate, companyName })
  if (byHeader) return byHeader

  // 3. オフセットを計算
  // データ行のcol数 - ヘッダ行のcol数（NO+氏名の分）、または支給合計額の位置で検証
  let firstDataIdx = -1
  let dataOffset = 0

  // 支給合計額のヘッダ位置（検証用）
  let payTotalHeaderIdx = -1
  for (let i = 0; i < detailHeaders.length; i++) {
    if (detailHeaders[i] === '支給合計額') { payTotalHeaderIdx = i; break }
  }

  for (let i = detailRowIdx + 1; i < rows.length; i++) {
    const first = (rows[i][0] || '').trim()
    if (/^\d+$/.test(first)) {
      if (firstDataIdx < 0) firstDataIdx = i
      // 方法1: 列数差でオフセット推定
      const colDiff = rows[i].length - detailHeaders.length
      if (colDiff > 0 && colDiff <= 3) {
        dataOffset = colDiff
        // 検証: 支給合計額の位置に数値があるか
        if (payTotalHeaderIdx >= 0) {
          const val = parseNum(rows[i][dataOffset + payTotalHeaderIdx])
          if (val > 0) break
        } else {
          break
        }
      }
      // 方法2: 列数差が0の場合（ヘッダにNO/氏名の空列がある）
      if (colDiff <= 0) {
        dataOffset = 0
        break
      }
    }
  }
  if (firstDataIdx < 0) throw new Error('従業員データ行が見つかりません')
  console.log(`[payroll] dataOffset=${dataOffset}, detailHeaders.length=${detailHeaders.length}, payTotalHeaderIdx=${payTotalHeaderIdx}`)

  // 4. 支給/控除の区切りを検出
  let payEndIdx = -1  // 支給合計額のヘッダインデックス
  let deductStartIdx = -1
  let deductEndIdx = -1

  for (let i = 0; i < detailHeaders.length; i++) {
    const h = detailHeaders[i].replace(/[\s　]/g, '')
    if (h === '支給合計額' && payEndIdx < 0) payEndIdx = i
    if ((h === '健康保険料' || h.includes('保険料')) && deductStartIdx < 0) deductStartIdx = i
    if (h === '控除合計額' && deductEndIdx < 0) deductEndIdx = i
  }

  // 差引支給額はデータ行の最終列
  // 大見出し行から探す
  const mainHeaderIdx = detailRowIdx - 1 >= 0 ? detailRowIdx - 1 : -1
  if (mainHeaderIdx >= 0) {
    const mainHeaders = rows[mainHeaderIdx]
    for (let i = 0; i < mainHeaders.length; i++) {
    }
  }

  // 支給項目ヘッダ（基本給 ～ 課税分合計。支給合計額・非課税額・課税分合計も含む）
  const payHeaders: string[] = []
  const payEndFull = deductStartIdx >= 0 ? deductStartIdx : detailHeaders.length
  for (let i = 0; i < payEndFull; i++) {
    const h = detailHeaders[i]?.trim()
    if (h) payHeaders.push(h)
    else payHeaders.push(`支給${i + 1}`)
  }

  // 控除項目ヘッダ（健康保険料 ～ 控除合計額。全項目含む）
  const deductHeaders: string[] = []
  if (deductStartIdx >= 0) {
    const dEnd = deductEndIdx >= 0 ? deductEndIdx + 1 : detailHeaders.length
    for (let i = deductStartIdx; i < dEnd; i++) {
      const h = detailHeaders[i]?.trim()
      if (h) deductHeaders.push(h)
      else deductHeaders.push(`控除${i - deductStartIdx + 1}`)
    }
  }

  console.log(`[payroll] offset=${dataOffset}, payHeaders=${payHeaders.length}, deductHeaders=${deductHeaders.length}, payEnd=${payEndIdx}, deductStart=${deductStartIdx}, deductEnd=${deductEndIdx}`)

  // 5. 従業員データ解析
  const employees: PayrollEmployee[] = []
  for (let i = firstDataIdx; i < rows.length; i++) {
    const row = rows[i]
    if (!row || row.length < 3) continue
    const firstCell = (row[0] || '').trim()
    if (firstCell === '合計' || firstCell === '計') break
    const no = parseInt(firstCell)
    if (isNaN(no)) continue

    const name = (row[1] || '').trim()
    if (!name) continue

    const items: { name: string; amount: number }[] = []

    // 支給項目（データのcol[offset] ～ col[offset+payEnd-1]）
    for (let j = 0; j < payHeaders.length; j++) {
      const colIdx = dataOffset + j
      items.push({ name: payHeaders[j], amount: parseNum(row[colIdx]) })
    }

    // 控除項目
    for (let j = 0; j < deductHeaders.length; j++) {
      const colIdx = dataOffset + deductStartIdx + j
      items.push({ name: deductHeaders[j], amount: parseNum(row[colIdx]) })
    }

    const totalPay = payEndIdx >= 0 ? parseNum(row[dataOffset + payEndIdx]) : 0
    const totalDeductions = deductEndIdx >= 0 ? parseNum(row[dataOffset + deductEndIdx]) : 0
    // 差引支給額: データ行の最終列（メインヘッダのインデックスは列ずれするため使わない）
    const netPay = parseNum(row[row.length - 1]) || (totalPay - totalDeductions)

    employees.push({
      no, name, isExecutive: false,
      items, totalPay, totalDeductions, netPay,
    })
  }

  return {
    period, paymentDate, companyName,
    employeeCount: employeeCount || employees.length,
    employees, payHeaders, deductHeaders,
  }
}

function parseNum(s: string | undefined): number {
  if (!s) return 0
  const cleaned = s.replace(/[,、\s]/g, '')
  const n = parseInt(cleaned, 10)
  return isNaN(n) ? 0 : n
}
