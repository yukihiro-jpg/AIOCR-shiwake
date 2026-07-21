// 路線価マップ: 型定義
//
// 索引データ（public/rosenka-data/）は tools/rosenka/build-rosenka-index.mjs が
// 国税庁 財産評価基準書サイト（rosenka.nta.go.jp）の町丁名索引から年1回自動生成する。
// アプリは静的JSONを読むだけで、国税庁サイトへは PDF表示（iframe/別タブ）とリンクのみ。

/** 年別・都道府県別の路線価索引 */
export interface RosenkaIndex {
  year: string // 'r08' など（main_r08 の年度部分）
  yearLabel: string // '令和8年分'
  bureau: string // 国税局スラッグ（茨城=kanto）
  prefSlug: string // 都道府県スラッグ（ibaraki）
  prefName: string // 茨城県
  generatedAt: string
  cities: RosenkaCity[]
  /** 隣接図面（東西南北ナビ）: 図番号 → {n:北, s:南, e:東, w:西} の図番号 */
  adj?: Record<string, { n?: string; s?: string; e?: string; w?: string }>
}

export interface RosenkaCity {
  code: string // 国税庁の市区町村ページコード（例 c17202=水戸市）
  name: string // 市区町村名
  towns: Record<string, string[]> // 町丁名 → 図番号（5桁）の配列
}

/** 利用可能な年・都道府県の一覧 */
export interface RosenkaManifest {
  updatedAt: string
  years: { id: string; label: string }[]
  prefs: { slug: string; name: string; bureau: string }[]
}

/** 住所→町丁の照合結果 */
export interface TownMatch {
  city: RosenkaCity
  town: string // 索引上の町丁名キー
  sheets: string[] // 図番号
  exact: boolean // 正規化後に完全一致したか
}

/** 都市計画データ（前処理済み・国土数値情報由来） */
export interface ToshiFeature {
  layer: 'youto' | 'kubun' // 用途地域 / 区域区分
  name: string // 例: 近隣商業地域 / 市街化区域
  kenpei?: number // 建蔽率(%)
  yoseki?: number // 容積率(%)
  bbox: [number, number, number, number] // [minLng, minLat, maxLng, maxLat]
  rings: [number, number][][] // 外環＋穴（経度,緯度）
}

export interface ToshiData {
  source: string
  year: string // 出典データの年度表示
  prefName: string
  features: ToshiFeature[]
}

const NTA_BASE = 'https://www.rosenka.nta.go.jp'

export function rosenkaPdfUrl(idx: RosenkaIndex, sheet: string): string {
  return `${NTA_BASE}/main_${idx.year}/${idx.bureau}/${idx.prefSlug}/prices/pdf/${sheet}.pdf`
}
export function rosenkaViewerUrl(idx: RosenkaIndex, sheet: string): string {
  return `${NTA_BASE}/main_${idx.year}/${idx.bureau}/${idx.prefSlug}/prices/html/${sheet}f.htm`
}
export function rosenkaCityIndexUrl(idx: RosenkaIndex, cityCode: string): string {
  return `${NTA_BASE}/main_${idx.year}/${idx.bureau}/${idx.prefSlug}/prices/${cityCode}fr.htm`
}
export function rosenkaYearTopUrl(year: string): string {
  return `${NTA_BASE}/main_${year}/index.htm`
}
/** 評価倍率表の市区町村選択ページ（路線価図が無い＝倍率地域の市町村の案内用） */
export function rosenkaRatiosUrl(idx: RosenkaIndex): string {
  return `${NTA_BASE}/main_${idx.year}/${idx.bureau}/${idx.prefSlug}/ratios/city_frm.htm`
}
export const NTA_TOP_URL = NTA_BASE + '/'

// 路線価図PDFのミラー（国税庁PDFは X-Frame-Options: SAMEORIGIN のため直接iframe不可。
// GitHub Actions が rosenka-pdfs ブランチへミラーし、CORS可の raw から取得して blob 表示する）
export function rosenkaMirrorPdfUrl(idx: RosenkaIndex, sheet: string): string {
  return `https://raw.githubusercontent.com/yukihiro-jpg/AIOCR-shiwake/rosenka-pdfs/${idx.year}/${idx.prefSlug}/${sheet}.pdf`
}
