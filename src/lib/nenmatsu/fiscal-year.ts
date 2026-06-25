// 年末調整（年調データ受信）の対象年度（令和）。
// 今日の日付に応じて「令和8年度〜翌年度」を自動生成するため、年が変わっても
// コード修正なしで年度が増えます（令和11、12…も自動で選べるようになります）。
// 令和N年 ＝ 西暦(2018 + N)。例：令和8年＝2026年。

export interface FiscalYear {
  id: string // 内部ID（パス安全）: 例 'R8'
  gregorian: number // 西暦
  reiwa: number // 令和の年
  label: string // 表示名: 例 '令和8年度（2026年）'
  deadlineMMDD: string // 書類提出期限（表示用、MM-DD）
}

const START_REIWA = 8 // 令和8年度（2026年）から
const REIWA_BASE = 2018 // 令和1年 = 2019年 → 西暦 = 2018 + 令和

function currentGregorian(): number {
  try {
    return new Date().getFullYear()
  } catch {
    return 2026
  }
}

function buildFiscalYears(): FiscalYear[] {
  const curReiwa = currentGregorian() - REIWA_BASE
  // 少なくとも令和10まで、かつ常に「翌年度」まで用意する
  const endReiwa = Math.max(10, curReiwa + 1)
  const out: FiscalYear[] = []
  for (let r = START_REIWA; r <= endReiwa; r++) {
    const g = REIWA_BASE + r
    out.push({ id: 'R' + r, gregorian: g, reiwa: r, label: `令和${r}年度（${g}年）`, deadlineMMDD: '11-30' })
  }
  return out
}

export const FISCAL_YEARS: FiscalYear[] = buildFiscalYears()

export const FY_BY_ID: Record<string, FiscalYear> = Object.fromEntries(
  FISCAL_YEARS.map((y) => [y.id, y]),
)

/** 既定で選択する年度（現在の年に最も近い令和年度、なければ末尾＝最新） */
export function defaultFiscalYearId(currentGregorianYear: number): string {
  const exact = FISCAL_YEARS.find((y) => y.gregorian === currentGregorianYear)
  if (exact) return exact.id
  return FISCAL_YEARS[FISCAL_YEARS.length - 1].id
}
