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

/** 給与明細一覧表OCR結果 → PayrollData（貼り付け解析と同じ構造） */
export function payrollOcrToData(r: PayrollSummaryOcr): PayrollData {
  const payHeaders = (r.payItemOrder || []).filter(Boolean)
  const deductHeaders = (r.deductItemOrder || []).filter(Boolean)
  const employees: PayrollEmployee[] = (r.employees || [])
    .map((e, idx) => {
      const payMap = new Map<string, number>()
      for (const p of e.pay || []) payMap.set(norm(p.item), toNum(p.amount))
      const dedMap = new Map<string, number>()
      for (const p of e.deduct || []) dedMap.set(norm(p.item), toNum(p.amount))
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
    text = new TextDecoder('shift_jis').decode(bytes)
  }
  const lines = text.split('\n').map((l) => l.replace(/\r$/, '').split(/\t/))
  return parsePayrollRows(lines)
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
