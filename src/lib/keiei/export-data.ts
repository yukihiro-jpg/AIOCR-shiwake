// 月次レポートに取り込んだ試算表データ（月次推移BS/PL・複数期分）を、
// 1つのJSONファイルとして書き出す。顧問先へ渡し、別アプリで読み込ませる用途を想定している。
//
// JSONにしている理由：
//  - 決算月の並び（fiscalMonths）が期ごとに違うため、CSVの横持ちだと「1月目」が
//    何月なのかヘッダーだけでは決まらない。JSONなら期ごとに持てて自己完結する
//  - 科目の階層（level）・小計/合計・【】〔〕の区別が型のまま残る
//  - Excelで開かれても壊れない（CSVは科目コードの先頭0が落ちる、5-1が日付になる）
//
// 中身は保存済みの FiscalYearData そのままで、再計算はしない。
// 受け取る側は schema を見て分岐する。フィールドを足すときは schema を上げること。

import type { FiscalYearData } from './types'
import { sortedYears } from './calc'

export const KEIEI_EXPORT_SCHEMA = 'keiei-monthly/1'

export interface KeieiExportClient {
  code: string
  name: string
}

export interface KeieiExportFile {
  schema: string
  generatedAt: string // ISO8601
  client: KeieiExportClient
  years: FiscalYearData[] // 古い期→新しい期の順
}

/**
 * 書き出す中身を組み立てる。
 * `years` は取込済みの全期（`loadYears` の戻り値）。`onlyIds` を渡すとその期だけに絞る。
 */
export function buildKeieiExport(
  client: KeieiExportClient,
  years: Record<string, FiscalYearData>,
  onlyIds?: string[],
): KeieiExportFile {
  const pick = onlyIds && onlyIds.length ? new Set(onlyIds) : null
  const list = sortedYears(years).filter((y) => !pick || pick.has(y.id))
  return {
    schema: KEIEI_EXPORT_SCHEMA,
    generatedAt: new Date().toISOString(),
    client: { code: client.code || '', name: client.name || '' },
    years: list,
  }
}

/** ファイル名。顧問先コードと出力日を入れて、複数社ぶんを扱うときの取り違えを防ぐ */
export function keieiExportFileName(client: KeieiExportClient, at: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const day = `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}`
  const name = (client.name || '顧問先').replace(/[\\/:*?"<>|]/g, '_')
  const code = (client.code || '').replace(/[\\/:*?"<>|]/g, '_')
  return `月次データ_${code ? code + '_' : ''}${name}_${day}.json`
}

/** JSON文字列（読みやすいように2スペース字下げ。サイズは3期でも数百KB程度） */
export function keieiExportJson(file: KeieiExportFile): string {
  return JSON.stringify(file, null, 2)
}
