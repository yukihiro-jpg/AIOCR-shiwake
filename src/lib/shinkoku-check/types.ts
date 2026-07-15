// 申告書チェック: 型定義

// PDFから抽出したテキストトークン（座標付き）
export interface Tok {
  s: string
  x: number
  y: number
}

// 同一Y座標帯のトークンをまとめた行
export interface Line {
  y: number
  toks: Tok[]
}

export interface Page {
  num: number // 通し番号（1始まり）
  fileName: string
  lines: Line[]
}

export type PageKind =
  | 'pl' // 損益計算書（販管費・製造原価明細含む決算書の金額ページ）
  | 'bs' // 貸借対照表
  | 'fs-cont' // 決算書の続きページ
  | 'beppyo4'
  | 'beppyo51'
  | 'beppyo52'
  | 'beppyo61'
  | 'beppyo16'
  | 'uchiwake' // 勘定科目内訳明細書（subTypeで種類判別）
  | 'gaikyo' // 法人事業概況説明書
  | 'beppyo15'
  | 'shohizei-fuhyo' // 消費税 付表1-3（税率別消費税額計算表）
  | 'shohizei-1' // 消費税申告書 第一表
  | 'other'

export interface ClassifiedPage extends Page {
  kind: PageKind
  subType?: string // 内訳書の種類名
}

export type CheckStatus = 'ok' | 'warn' | 'na' | 'info'

export interface CheckResult {
  group: string
  name: string
  leftLabel: string
  leftValue: number | null
  rightLabel: string
  rightValue: number | null
  diff: number | null
  status: CheckStatus
  note?: string
}

export interface AnalyzeResult {
  checks: CheckResult[]
  pageSummary: { page: number; fileName: string; detected: string }[]
}

// グループ名「A ⇔ B」から結果表の列見出しに使う書類名を取り出す
// （「書類A/書類B」の汎称をやめ、実際の書類名をヘッダに表示するため）
export function groupDocHeaders(group: string): [string, string] {
  const parts = group.replace(/（参考）\s*$/, '').split(' ⇔ ')
  if (parts.length === 2 && parts[0] && parts[1]) return [parts[0], parts[1]]
  return ['照合元', '照合先']
}
