import type { AccountRow, FiscalYearData, Statement } from './types'

/** BOM/UTF-8/Shift_JIS 自動判定でCSVバイト列をデコード */
export function decodeCsv(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.slice(3))
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('shift_jis').decode(bytes)
  }
}

// CSV1行をフィールド配列に分解（ダブルクォート対応）
function parseCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQ = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ } else inQ = false
      } else cur += ch
    } else {
      if (ch === '"') inQ = true
      else if (ch === ',') { out.push(cur); cur = '' }
      else cur += ch
    }
  }
  out.push(cur)
  return out
}

// 数値セルをパース（カンマ・¥・空白・△▲対応）。空欄は null
function parseNum(raw: string | undefined): number | null {
  if (raw == null) return null
  const s = String(raw).replace(/[,¥￥\s　]/g, '').replace(/[△▲]/g, '-').trim()
  if (s === '') return null
  const n = Number(s)
  return isNaN(n) ? null : n
}

// 科目名の先頭空白（半角/全角）からインデント階層を推定
function indentLevel(name: string): number {
  const m = name.match(/^[\s　]*/)
  const spaces = m ? m[0].length : 0
  return Math.min(3, Math.floor(spaces / 2))
}

/**
 * 会計大将「月次推移 BS/PL」CSV（デコード済みテキスト）をパースして1期分に正規化する。
 * 期末月はヘッダの月並び（…/7月 が末尾）から自動判定する。
 */
export function parseMonthlyCsv(text: string): FiscalYearData {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0)
  if (lines.length < 2) throw new Error('CSVの行数が不足しています。')

  const header = parseCsvLine(lines[0])
  // 月列を検出: 「…/N月」を含む列のインデックスと月番号を拾う
  const monthCols: { col: number; month: number }[] = []
  for (let c = 0; c < header.length; c++) {
    const m = header[c].match(/(\d{1,2})月/)
    if (m) monthCols.push({ col: c, month: Number(m[1]) })
  }
  if (monthCols.length < 12) {
    throw new Error(`月次列を12ヶ月分検出できませんでした（検出 ${monthCols.length} 列）。会計大将の「月次推移」CSVか確認してください。`)
  }
  // 末尾12列を採用（先頭の「金額」「構成比」を取り違えないよう、月並びの最後の12個）
  const last12 = monthCols.slice(-12)
  const fiscalMonths = last12.map((x) => x.month)
  const endMonth = fiscalMonths[fiscalMonths.length - 1]

  const rows: AccountRow[] = []
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i])
    if (cells.length < 4) continue
    const kind = cells[0] || ''
    let statement: Statement
    if (kind.includes('貸借')) statement = 'BS'
    else if (kind.includes('損益')) statement = 'PL'
    else continue
    const code = (cells[1] || '').trim()
    const rawName = cells[2] || ''
    const name = rawName.trim()
    if (!code && !name) continue
    const annual = parseNum(cells[3]) ?? 0
    const ratio = parseNum(cells[4]) ?? 0
    const monthly = last12.map((x) => parseNum(cells[x.col]) ?? 0)
    const bracket: AccountRow['bracket'] = /^[【\[]/.test(name)
      ? 'group'
      : /^[〔\(]/.test(name)
        ? 'profit'
        : ''
    const isSubtotal = bracket !== '' || /^9\d{3}$/.test(code)
    rows.push({ statement, code, name, level: indentLevel(rawName), isSubtotal, bracket, annual, ratio, monthly })
  }

  if (rows.length === 0) throw new Error('科目データを1件も読み取れませんでした。')

  // 期末の西暦年を推定: ファイルに年が無いので「当月迄累計/金額」基準では決められない。
  // → 末尾月(endMonth)から見た年は呼び出し側で確定させる想定。ここでは暫定的に未設定(0)。
  // lastFilledIndex: 資産の部(9568)の月末残高が入っている最終月。無ければ純売上高(9534)。
  const assetTotal = rows.find((r) => r.code === '9568')
  const salesTotal = rows.find((r) => r.code === '9534')
  let lastFilledIndex = 11
  const probe = assetTotal?.monthly || salesTotal?.monthly
  if (probe) {
    let idx = -1
    for (let i = 0; i < 12; i++) if (probe[i] !== 0) idx = i
    if (idx >= 0) lastFilledIndex = idx
  }

  return {
    id: '', // 呼び出し側で期末年を確定してから設定
    endYear: 0,
    endMonth,
    reiwa: 0,
    label: '',
    fiscalMonths,
    lastFilledIndex,
    rows,
    uploadedAt: 0,
  }
}

/** 期末の西暦年を与えて id/label/reiwa を確定する */
export function finalizeFiscalYear(data: FiscalYearData, endYear: number): FiscalYearData {
  const reiwa = endYear - 2018
  return {
    ...data,
    endYear,
    reiwa,
    id: `${endYear}-${String(data.endMonth).padStart(2, '0')}`,
    label: reiwa >= 1 ? `令和${reiwa}年${data.endMonth}月期` : `${endYear}年${data.endMonth}月期`,
    uploadedAt: Date.now(),
  }
}
