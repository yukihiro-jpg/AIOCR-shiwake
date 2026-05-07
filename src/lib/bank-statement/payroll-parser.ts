import type { PayrollData, PayrollEmployee } from './types'

export function parsePayrollText(text: string): PayrollData {
  const lines = text.split('\n').map((l) => l.split('\t'))
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
  // CSV / テキスト
  const buf = await file.arrayBuffer()
  const bytes = new Uint8Array(buf)
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    text = new TextDecoder('shift_jis').decode(bytes)
  }
  const lines = text.split('\n').map((l) => l.replace(/\r$/, '').split(/\t|,/))
  return parsePayrollRows(lines)
}

function parsePayrollRows(rows: string[][]): PayrollData {
  let period = ''
  let paymentDate = ''
  let companyName = ''
  let employeeCount = 0

  // 1. メタ情報を抽出（先頭10行から検索）
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const line = rows[i].join('\t')
    const periodMatch = line.match(/令和(\d+)年(\d+)月/)
    if (periodMatch && !period) {
      const year = 2018 + parseInt(periodMatch[1])
      period = `${year}-${periodMatch[2].padStart(2, '0')}`
    }
    const countMatch = line.match(/計[：:](\d+)名/)
    if (countMatch) employeeCount = parseInt(countMatch[1])
    const dateMatch = line.match(/支給日[：:]令和(\d+)年(\d+)月(\d+)日/)
    if (dateMatch) {
      const y = 2018 + parseInt(dateMatch[1])
      paymentDate = `${y}-${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}`
    }
    if (!companyName && /会社|事務所|事業|製作所/.test(line)) {
      companyName = rows[i].find((c) => c.trim().length > 2)?.trim() || ''
    }
  }

  // 2. ヘッダ行を検出（「基本給」を含む行）
  let headerRowIdx = -1
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].some((c) => c.includes('基本給'))) {
      headerRowIdx = i
      break
    }
  }
  if (headerRowIdx < 0) throw new Error('ヘッダ行（基本給）が見つかりません')

  // 大見出し行（「支給」「控除」「差引支給額」を含む行）
  const mainHeaderIdx = headerRowIdx - 1 >= 0 ? headerRowIdx - 1 : headerRowIdx
  const mainHeaders = rows[mainHeaderIdx]
  const detailHeaders = rows[headerRowIdx]

  // 3. 列の役割を特定
  // NO列と氏名列を見つける
  let noCol = -1, nameCol = -1
  for (let i = 0; i < detailHeaders.length; i++) {
    const h = detailHeaders[i].trim()
    if (noCol < 0 && /^NO$/i.test(h)) noCol = i
    if (nameCol < 0 && h === '氏名') nameCol = i
  }
  // NOが見つからない場合、大見出しから探す
  if (noCol < 0) {
    for (let i = 0; i < mainHeaders.length; i++) {
      if (/^NO$/i.test(mainHeaders[i].trim())) noCol = i
    }
  }
  if (nameCol < 0) {
    for (let i = 0; i < mainHeaders.length; i++) {
      if (mainHeaders[i].trim() === '氏名') nameCol = i
    }
  }

  // 支給項目と控除項目の開始/終了列を特定
  let payStartCol = nameCol + 1
  let payEndCol = -1  // 支給合計額の列
  let deductStartCol = -1
  let deductEndCol = -1  // 控除合計額の列
  let netPayCol = -1

  // 「支給合計額」「控除合計額」「差引支給額」列を検出
  for (let i = 0; i < detailHeaders.length; i++) {
    const h = detailHeaders[i].replace(/[\s　]/g, '')
    if (h === '支給合計額') payEndCol = i
    if (h === '控除合計額') deductEndCol = i
    if (h === '差引支給額') netPayCol = i
  }
  // 大見出しから「差引支給額」を探す
  if (netPayCol < 0) {
    for (let i = 0; i < mainHeaders.length; i++) {
      if (mainHeaders[i].replace(/[\s　]/g, '').includes('差引支給額')) netPayCol = i
    }
  }

  // 控除開始列 = 支給合計額の次の非空ヘッダ列
  if (payEndCol >= 0) {
    // 支給合計額の後に「非課税額」「課税分合計」がある場合がある
    for (let i = payEndCol + 1; i < detailHeaders.length; i++) {
      const h = detailHeaders[i].replace(/[\s　]/g, '')
      if (h === '健康保険料' || h === '社会保険料' || h.includes('保険') || h.includes('所得税')) {
        deductStartCol = i
        break
      }
    }
    if (deductStartCol < 0) deductStartCol = payEndCol + 3 // フォールバック
  }

  // ヘッダ名のリスト
  const payHeaders: string[] = []
  for (let i = payStartCol; i < (payEndCol >= 0 ? payEndCol : detailHeaders.length); i++) {
    const h = detailHeaders[i]?.trim()
    if (h) payHeaders.push(h)
    else payHeaders.push(`支給${i - payStartCol + 1}`)
  }
  const deductHeaders: string[] = []
  if (deductStartCol >= 0 && deductEndCol >= 0) {
    for (let i = deductStartCol; i < deductEndCol; i++) {
      const h = detailHeaders[i]?.trim()
      if (h) deductHeaders.push(h)
      else deductHeaders.push(`控除${i - deductStartCol + 1}`)
    }
  }

  // 4. 従業員データを解析
  const employees: PayrollEmployee[] = []
  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const row = rows[i]
    if (!row || row.length < 3) continue
    const firstCell = (row[noCol >= 0 ? noCol : 0] || '').trim()
    // 合計行で終了
    if (firstCell === '合計' || firstCell === '計') break
    // NO が数字の行のみ
    const no = parseInt(firstCell)
    if (isNaN(no)) continue

    const name = (row[nameCol >= 0 ? nameCol : 1] || '').trim()
    if (!name) continue

    // 全項目を { name, amount } で収集
    const items: { name: string; amount: number }[] = []

    // 支給項目
    for (let j = 0; j < payHeaders.length; j++) {
      const colIdx = payStartCol + j
      const amt = parseNum(row[colIdx])
      items.push({ name: payHeaders[j], amount: amt })
    }
    // 控除項目
    for (let j = 0; j < deductHeaders.length; j++) {
      const colIdx = deductStartCol + j
      const amt = parseNum(row[colIdx])
      items.push({ name: deductHeaders[j], amount: amt })
    }

    const totalPay = payEndCol >= 0 ? parseNum(row[payEndCol]) : items.filter((_, idx) => idx < payHeaders.length).reduce((s, i) => s + i.amount, 0)
    const totalDeductions = deductEndCol >= 0 ? parseNum(row[deductEndCol]) : items.filter((_, idx) => idx >= payHeaders.length).reduce((s, i) => s + i.amount, 0)
    const netPay = netPayCol >= 0 ? parseNum(row[netPayCol]) : totalPay - totalDeductions

    employees.push({
      no, name, isExecutive: false,
      items, totalPay, totalDeductions, netPay,
    })
  }

  return {
    period, paymentDate, companyName, employeeCount: employeeCount || employees.length,
    employees, payHeaders, deductHeaders,
  }
}

function parseNum(s: string | undefined): number {
  if (!s) return 0
  const cleaned = s.replace(/[,、\s]/g, '')
  const n = parseInt(cleaned, 10)
  return isNaN(n) ? 0 : n
}
