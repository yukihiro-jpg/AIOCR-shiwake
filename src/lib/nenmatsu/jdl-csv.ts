// JDL 年末調整CSV のパーサ（Shift_JIS）。
// 構造: 先頭4行ヘッダー → 5行目カラムヘッダー → 6行目〜データ → 末尾2行フッター。
// 退職者を除いて取り込む（入退状況区分に「退職」を含む行＝「退職」「中途入社退職」を除外。
// 「在職」だけでなく「中途入社」（本年の途中で入社した方）も在籍中の従業員として取り込む）。
// 主要カラム: 社員C(0), 姓(1)+名(2), フリガナ姓(3)+名(4), 生年月日(7), 入退状況(27)。

import type { NenmatsuEmployee } from './store'
import type { DisabilityType, WidowType } from './declaration'

/** ArrayBuffer を Shift_JIS として読む（不可なら UTF-8 フォールバック） */
export function decodeShiftJis(buf: ArrayBuffer): string {
  try {
    return new TextDecoder('shift-jis').decode(buf)
  } catch {
    return new TextDecoder('utf-8').decode(buf)
  }
}

/** 1行のCSVを、ダブルクオート対応で分割 */
function parseLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQ = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else inQ = false
      } else cur += ch
    } else {
      if (ch === '"') inQ = true
      else if (ch === ',') {
        out.push(cur)
        cur = ''
      } else cur += ch
    }
  }
  out.push(cur)
  return out
}

const COL = {
  code: 0,
  lastName: 1,
  firstName: 2,
  kanaLast: 3,
  kanaFirst: 4,
  birth: 7,
  addr1: 11,
  addr2: 12,
  status: 27,
}

export interface JdlParseResult {
  employees: NenmatsuEmployee[]
  total: number // 在職フィルタ前のデータ行数
  skipped: number // 退職で除外した数
}

export function parseJdlCsv(text: string): JdlParseResult {
  const allLines = text.split(/\r\n|\r|\n/).filter((l) => l.length > 0)
  // 先頭4行ヘッダー＋5行目カラムヘッダー＝計5行スキップ、末尾2行フッターを除外
  const dataLines = allLines.slice(5, Math.max(5, allLines.length - 2))
  const employees: NenmatsuEmployee[] = []
  let skipped = 0
  for (const line of dataLines) {
    const cells = parseLine(line)
    const code = (cells[COL.code] || '').trim()
    if (!code) continue
    const status = (cells[COL.status] || '').trim()
    // 「退職」を含む行（退職・中途入社退職）だけ除外する。「在職」「中途入社」や空欄は取り込む。
    // 以前は「在職」を含む行だけを取り込んでいたため、全員が「中途入社」の会社で0件になっていた
    if (/退職|退社/.test(status)) {
      skipped++
      continue
    }
    const birthRaw = jtrim(cells[COL.birth] || '')
    const addr = [cells[COL.addr1], cells[COL.addr2]].map((x) => jtrim(x || '')).filter(Boolean).join('')
    employees.push({
      id: 'e_' + code.replace(/[^0-9A-Za-z]/g, '_'),
      code,
      lastName: jtrim(cells[COL.lastName] || ''),
      firstName: jtrim(cells[COL.firstName] || ''),
      kanaLast: jtrim(cells[COL.kanaLast] || ''),
      kanaFirst: jtrim(cells[COL.kanaFirst] || ''),
      birthRaw,
      birth: normalizeBirth(birthRaw),
      address: addr,
      rawCells: cells.map((x) => jtrim(x || '')),
    })
  }
  // フリガナ順で並べ替え
  employees.sort((a, b) =>
    (a.kanaLast + a.kanaFirst).localeCompare(b.kanaLast + b.kanaFirst, 'ja'),
  )
  return { employees, total: dataLines.length, skipped }
}

/** 和暦(S37.7.5 等) / 西暦 を YYYY-MM-DD に正規化（照合用） */
export function normalizeBirth(raw: string): string {
  if (!raw) return ''
  const s = raw.trim().replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
  // 和暦: 元号アルファベット or 漢字 + 年.月.日
  const eraMap: Record<string, number> = {
    M: 1867, 明: 1867,
    T: 1911, 大: 1911,
    S: 1925, 昭: 1925,
    H: 1988, 平: 1988,
    R: 2018, 令: 2018,
  }
  let m = s.match(/^([MTSHR明大昭平令])\.?\s*(\d{1,2})[.\-/年]\s*(\d{1,2})[.\-/月]\s*(\d{1,2})/)
  if (m) {
    const base = eraMap[m[1]]
    const y = base + Number(m[2])
    return `${y}-${pad(m[3])}-${pad(m[4])}`
  }
  // 西暦: 1900-2100
  m = s.match(/^(\d{4})[.\-/年]\s*(\d{1,2})[.\-/月]\s*(\d{1,2})/)
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`
  return ''
}

function pad(n: string | number): string {
  return String(n).padStart(2, '0')
}

// ===== JDL CSV の列マッピング（実データ確認済み） =====
// 郵便番号は 9列目(本番=上3桁)＋10列目(枝番=下4桁) に分かれている。
// 扶養者1は 65列目から「続柄(65)・氏名(66)・フリガナ(67)・生年月日(68)・親族区分・障害区分・非居住者区分・所得見積額」が8列間隔で並ぶ。
export const JDL_MAP = {
  postalUpper: 9, // 郵便番号 上3桁
  postalLower: 10, // 郵便番号 下4桁
  depStart: 65, // 扶養者1の開始列
  depStride: 8, // 1扶養あたりの列数
  depCount: 10, // 最大10人
  oRelation: 0, // 開始からのオフセット：続柄
  oName: 1, // 氏名
  oKana: 2, // フリガナ
  oBirth: 3, // 生年月日
  oKubun: 4, // 親族区分（年少扶養・一般扶養・特定扶養・老人扶養 等）
  oDisability: 5, // 障害区分
  oIncome: 7, // 所得見積額
  // 本人の状態・世帯主・甲乙（前年の扶養控除等申告書の内容）
  householder: 17, // 世帯主の氏名
  householderRelation: 18, // 社員との続柄文字（世帯主から見た続柄。本人・夫・父 等）
  taxTable: 33, // 税表区分（甲欄・乙欄）
  selfDisability: 35, // 本人の状態 障害者区分
  selfWidow: 36, // 本人の状態 寡婦／ひとり親区分
  selfStudent: 37, // 本人の状態 学生区分
  // 配偶者は扶養者欄とは別の列にある（扶養者欄には入らない）
  spouseIncome: 40, // 配偶者の合計所得金額（年収ではない）
  spouseDeduction: 41, // 配偶者の控除区分（配偶者控除・配偶者特別控除・控除なし）
  spouseRelation: 48, // 配偶者の続柄区分（妻・夫。配偶者がいなくても入っていることがある）
  spouseName: 49,
  spouseKana: 50,
  spouseBirth: 51,
  spouseDisability: 53,
}

export interface CsvDependent {
  relation: string
  name: string
  kana: string
  birthRaw: string
  birth: string
  income: string
  /** 親族区分（年少扶養・一般扶養 等。空もある） */
  kubun: string
  disability: DisabilityType
}

export interface CsvSpouse {
  name: string
  kana: string
  birthRaw: string
  birth: string
  disability: DisabilityType
  /** 前年の申告での合計所得金額（円・年収ではない）と控除区分。確認シートの参考表示用 */
  prevIncome: string
  deduction: string
}

/** 本人の状態など（前年の扶養控除等申告書の内容） */
export interface CsvSelfStatus {
  disability: DisabilityType
  widow: WidowType
  student: boolean
  householder: string
  householderRelation: string
  /** 'kou'＝甲欄 'otsu'＝乙欄 ''＝不明 */
  taxTable: '' | 'kou' | 'otsu'
}

/** JDLの障害区分の文字を、申告内容の区分に揃える（読めないものは非該当） */
export function jdlDisability(v: string): DisabilityType {
  const t = jtrim(v).replace(/[\s　]/g, '')
  if (!t || /非該当|なし/.test(t)) return '非該当'
  if (/同居/.test(t) && /特別/.test(t)) return '同居特別障害者'
  if (/特別/.test(t)) return '特別障害者'
  if (/障害/.test(t) || /一般/.test(t)) return '一般障害者'
  return '非該当'
}

/** JDLの寡婦／ひとり親区分の文字を、申告内容の区分に揃える */
export function jdlWidow(v: string): WidowType {
  const t = jtrim(v).replace(/[\s　]/g, '')
  if (!t || /非該当|なし/.test(t)) return '非該当'
  if (/ひとり親|ひとりおや/.test(t)) return 'ひとり親'
  if (/寡婦/.test(t)) return '寡婦'
  return '非該当'
}

/** 本人の状態などの列がJDLの並びどおりか（別形式のCSVで的外れな列を読まないため） */
function jdlLayoutOk(cells: string[]): boolean {
  if (cells.length < 60) return false
  const t = jtrim(cells[JDL_MAP.taxTable] || '')
  return !t || /^[甲乙丙](欄)?$/.test(t)
}

/** 取込済みの行データ(rawCells)から本人の状態・世帯主・甲乙を抽出 */
export function extractSelfStatus(cells: string[] | undefined): CsvSelfStatus | null {
  if (!cells || !jdlLayoutOk(cells)) return null
  const tt = jtrim(cells[JDL_MAP.taxTable] || '')
  const householder = jtrim(cells[JDL_MAP.householder] || '').replace(/[\s　]+/g, ' ')
  const st = jtrim(cells[JDL_MAP.selfStudent] || '')
  return {
    disability: jdlDisability(cells[JDL_MAP.selfDisability] || ''),
    widow: jdlWidow(cells[JDL_MAP.selfWidow] || ''),
    student: !!st && !/非該当|なし/.test(st), // 「勤労学生」「該当」など
    householder,
    householderRelation: householder ? jtrim(cells[JDL_MAP.householderRelation] || '') : '',
    taxTable: tt.startsWith('甲') ? 'kou' : tt.startsWith('乙') ? 'otsu' : '',
  }
}

/** 取込済みの行データ(rawCells)から配偶者を抽出（氏名が無ければ配偶者なし） */
export function extractSpouse(cells: string[] | undefined): CsvSpouse | null {
  if (!cells || !jdlLayoutOk(cells)) return null
  const name = jtrim(cells[JDL_MAP.spouseName] || '').replace(/[\s　]+/g, ' ')
  if (!name) return null
  const birthRaw = jtrim(cells[JDL_MAP.spouseBirth] || '')
  return {
    name,
    kana: jtrim(cells[JDL_MAP.spouseKana] || '').replace(/[\s　]+/g, ' '),
    birthRaw,
    birth: normalizeBirth(birthRaw),
    disability: jdlDisability(cells[JDL_MAP.spouseDisability] || ''),
    prevIncome: jtrim(cells[JDL_MAP.spouseIncome] || '').replace(/[^0-9]/g, ''),
    deduction: jtrim(cells[JDL_MAP.spouseDeduction] || ''),
  }
}

export function extractPostal(cells: string[] | undefined): string {
  if (!cells) return ''
  const a = jtrim(cells[JDL_MAP.postalUpper] || '')
  const b = jtrim(cells[JDL_MAP.postalLower] || '')
  if (!a && !b) return ''
  return [a, b].filter(Boolean).join('-')
}

/** 取込済みの行データ(rawCells)から扶養親族を抽出 */
export function extractDependents(cells: string[] | undefined): CsvDependent[] {
  if (!cells) return []
  const out: CsvDependent[] = []
  for (let i = 0; i < JDL_MAP.depCount; i++) {
    const b = JDL_MAP.depStart + i * JDL_MAP.depStride
    const name = jtrim(cells[b + JDL_MAP.oName] || '')
    const relation = jtrim(cells[b + JDL_MAP.oRelation] || '')
    const birthRaw = jtrim(cells[b + JDL_MAP.oBirth] || '')
    if (!name && !relation && !birthRaw) continue
    out.push({
      name,
      kana: jtrim(cells[b + JDL_MAP.oKana] || ''),
      relation,
      birthRaw,
      birth: normalizeBirth(birthRaw),
      income: jtrim(cells[b + JDL_MAP.oIncome] || ''),
      kubun: jtrim(cells[b + JDL_MAP.oKubun] || ''),
      disability: jdlDisability(cells[b + JDL_MAP.oDisability] || ''),
    })
  }
  return out
}

/** 前後の半角・全角スペースを除去 */
export function jtrim(s: string): string {
  return String(s ?? '').replace(/^[\s　]+|[\s　]+$/g, '')
}
