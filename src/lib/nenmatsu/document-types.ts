// 年末調整で従業員に撮影・提出してもらう控除証明書等（9種類）。
// 元アプリ（test-project）の document-types を踏襲。

export interface NenmatsuDocType {
  /** 安全なキー（Firebase パス・ファイル名に使用） */
  key: string
  /** 表示名 */
  name: string
  /** 補足説明（任意） */
  note?: string
  /** 2年目以降のみ対象など、本年入社/新規には不要な書類か */
  secondYearOnly?: boolean
}

export const NENMATSU_DOC_TYPES: NenmatsuDocType[] = [
  { key: 'life_insurance', name: '生命保険料控除証明書' },
  { key: 'earthquake_insurance', name: '地震保険料控除証明書' },
  { key: 'national_pension', name: '国民年金保険料控除証明書' },
  { key: 'national_health', name: '国民健康保険の支払証明' },
  { key: 'small_mutual', name: '小規模企業共済掛金払込証明書' },
  { key: 'ideco', name: 'iDeCo掛金払込証明書' },
  {
    key: 'housing_loan_declaration',
    name: '住宅借入金等特別控除申告書',
    note: '2年目以降',
    secondYearOnly: true,
  },
  {
    key: 'housing_loan_balance',
    name: '住宅取得資金に係る借入金の年末残高証明書',
    note: '2年目以降',
    secondYearOnly: true,
  },
  { key: 'prev_withholding', name: '前職の源泉徴収票' },
]

export const DOC_BY_KEY: Record<string, NenmatsuDocType> = Object.fromEntries(
  NENMATSU_DOC_TYPES.map((d) => [d.key, d]),
)
