import type { PayrollData, PayrollEmployee } from './types'

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
