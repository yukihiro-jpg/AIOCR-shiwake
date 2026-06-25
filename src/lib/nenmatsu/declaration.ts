// 年末調整 申告内容（本人・配偶者・扶養親族）の型と、令和7年税制改正対応の控除区分判定。
// 金額はすべて「年収（円）」で扱う。

export type DisabilityType = '非該当' | '一般障害者' | '特別障害者' | '同居特別障害者'
export type WidowType = '非該当' | '寡婦' | 'ひとり親'

export interface DepInfo {
  name: string
  kana: string
  relation: string // 続柄（子・父・母 等）
  birth: string // YYYY-MM-DD
  income: string // 年収（円）
  liveTogether: boolean // 同居
  disability: DisabilityType
}

export interface SpouseInfo {
  exists: boolean
  name: string
  kana: string
  birth: string
  income: string // 年収（円）
}

export interface Declaration {
  isNewHire: boolean
  lastName: string
  firstName: string
  kanaLast: string
  kanaFirst: string
  birth: string
  postal: string
  address: string
  householder: string // 世帯主氏名
  householderRelation: string // 続柄
  selfDisability: DisabilityType
  widow: WidowType
  workingStudent: boolean
  spouse: SpouseInfo
  dependents: DepInfo[]
  noChange?: boolean // 既存従業員で「前年と相違なし」
  confirmedAt?: string
}

export function emptySpouse(): SpouseInfo {
  return { exists: false, name: '', kana: '', birth: '', income: '' }
}
export function emptyDependent(): DepInfo {
  return { name: '', kana: '', relation: '', birth: '', income: '', liveTogether: true, disability: '非該当' }
}
export function emptyDeclaration(isNewHire: boolean): Declaration {
  return {
    isNewHire,
    lastName: '',
    firstName: '',
    kanaLast: '',
    kanaFirst: '',
    birth: '',
    postal: '',
    address: '',
    householder: '',
    householderRelation: '本人',
    selfDisability: '非該当',
    widow: '非該当',
    workingStudent: false,
    spouse: emptySpouse(),
    dependents: [],
  }
}

export function numYen(x: string): number {
  return Number(String(x ?? '').replace(/[^0-9.\-]/g, '')) || 0
}

/** その年の12/31時点の満年齢 */
export function ageAtYearEnd(birth: string, fyGregorian: number): number | null {
  const m = (birth || '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return null
  const by = Number(m[1])
  return fyGregorian - by // 12/31基準の概算（月日は省略）
}

/** 扶養親族の控除区分（令和7年改正：扶養123万・特定親族特別控除188万） */
export function dependentCategory(d: DepInfo, fyGregorian: number): string {
  const age = ageAtYearEnd(d.birth, fyGregorian)
  if (age == null) return '（生年月日を入力）'
  const inc = numYen(d.income)
  if (age < 16) return '年少扶養（控除対象外・住民税の対象）'
  if (age >= 19 && age <= 22) {
    if (inc <= 1230000) return '特定扶養親族'
    if (inc <= 1880000) return '特定親族特別控除（新設）'
    return '控除対象外（年収188万円超）'
  }
  if (inc > 1230000) return '控除対象外（年収123万円超）'
  if (age >= 70) return d.liveTogether ? '同居老親等' : '老人扶養親族'
  return '一般の控除対象扶養親族'
}

/** 配偶者の控除区分（配偶者控除／配偶者特別控除） */
export function spouseCategory(s: SpouseInfo): string {
  if (!s.exists) return '—'
  const inc = numYen(s.income)
  if (inc <= 1230000) return '配偶者控除（同一生計配偶者）'
  if (inc <= 2016000) return '配偶者特別控除'
  return '控除対象外（年収201.6万円超）'
}

/** 勤労学生の目安（給与150万円以下） */
export function workingStudentOk(income: string): boolean {
  return numYen(income) <= 1500000
}

/** 郵便番号→住所（zipcloud）。失敗時は空文字（手入力に委ねる） */
export async function lookupPostal(zip: string): Promise<string> {
  const z = (zip || '').replace(/[^0-9]/g, '')
  if (z.length !== 7) return ''
  try {
    const res = await fetch(`https://zipcloud.ibsnet.co.jp/api/search?zipcode=${z}`)
    const j = await res.json()
    const r = j?.results?.[0]
    if (r) return `${r.address1}${r.address2}${r.address3}`
  } catch {
    /* CORS等で失敗したら手入力 */
  }
  return ''
}
