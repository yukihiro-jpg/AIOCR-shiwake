// 年末調整の対象年度（令和）。元アプリは R8〜R10 を定義。
// id は Firebase パスに使う安全な文字列、label は画面表示。

export interface FiscalYear {
  /** 内部ID（パス安全）: 例 'R8' */
  id: string
  /** 西暦 */
  gregorian: number
  /** 令和の年 */
  reiwa: number
  /** 表示名: 例 '令和8年度（2026年）' */
  label: string
  /** 書類提出期限（表示用、MM-DD） */
  deadlineMMDD: string
}

export const FISCAL_YEARS: FiscalYear[] = [
  { id: 'R8', gregorian: 2026, reiwa: 8, label: '令和8年度（2026年）', deadlineMMDD: '11-30' },
  { id: 'R9', gregorian: 2027, reiwa: 9, label: '令和9年度（2027年）', deadlineMMDD: '11-30' },
  { id: 'R10', gregorian: 2028, reiwa: 10, label: '令和10年度（2028年）', deadlineMMDD: '11-30' },
]

export const FY_BY_ID: Record<string, FiscalYear> = Object.fromEntries(
  FISCAL_YEARS.map((y) => [y.id, y]),
)

/** 既定で選択する年度（現在の年に最も近い令和年度、なければ先頭） */
export function defaultFiscalYearId(currentGregorian: number): string {
  const exact = FISCAL_YEARS.find((y) => y.gregorian === currentGregorian)
  if (exact) return exact.id
  return FISCAL_YEARS[0].id
}
