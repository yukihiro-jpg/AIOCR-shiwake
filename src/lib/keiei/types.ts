// 月次レポート（経営ダッシュボード）モジュールのデータ型
// 会計大将の「月次推移 貸借対照表／損益計算書」CSV（1ファイル=1期分, BS+PL同梱）を
// 正規化して保持する。BS月次列=各月末残高、PL月次列=その月の単月発生額。

export type Statement = 'BS' | 'PL'

export interface AccountRow {
  statement: Statement
  code: string
  name: string
  level: number // 科目名の先頭空白から推定したインデント階層（0=最上位）
  isSubtotal: boolean // 小計・合計・利益行か（9xxxコード or 【】〔〕）
  bracket: '' | 'group' | 'profit' // 【】=group（部・グループ計）, 〔〕=profit（各利益）
  annual: number // 「当月迄累計/金額」列（BS=期末残高 / PL=年間累計）
  ratio: number // 構成比(%)
  monthly: number[] // 12ヶ月。BS=月末残高 / PL=単月発生額。fiscalMonths と同順
}

export interface FiscalYearData {
  id: string // 期末で一意: 例 '2024-07'
  endYear: number // 期末の西暦年（例 2024）
  endMonth: number // 期末の月（例 7）
  reiwa: number // 期末の令和年（endYear-2018）
  label: string // 表示名: 例 '令和6年7月期'
  fiscalMonths: number[] // 月の並び（例 [8,9,10,11,12,1,2,3,4,5,6,7]）
  lastFilledIndex: number // 入力済みの最終月インデックス（期中の場合は途中まで）
  rows: AccountRow[]
  uploadedAt: number // 取込日時（epoch ms）
}

// 顧問先1社分の保存データ
export interface ClientKeieiData {
  years: Record<string, FiscalYearData> // id -> data（最大3期想定だが制限はしない）
}
