// 月次レポートに取り込んだ試算表データ（月次推移BS/PL・複数期分）と、
// 必要なら当期の元帳明細を、1つのJSONファイルとして書き出す。
// 顧問先へ渡し、別アプリで読み込ませる用途を想定している。
//
// JSONにしている理由：
//  - 決算月の並び（fiscalMonths）が期ごとに違うため、CSVの横持ちだと「1月目」が
//    何月なのかヘッダーだけでは決まらない。JSONなら期ごとに持てて自己完結する
//  - 科目の階層（level）・小計/合計・【】〔〕の区別が型のまま残る
//  - Excelで開かれても壊れない（CSVは科目コードの先頭0が落ちる、5-1が日付になる）
//
// 中身は保存済みの FiscalYearData そのままで、再計算はしない。
// 受け取る側は schema を見て分岐する。フィールドを足すときは schema を上げること。
//
// 【元帳の同梱について】
//  - 入れるのは **当期の1期だけ**。3期ぶん入れるとファイルが3倍になるうえ、
//    顧問先が見たいのはたいてい当期なので割に合わない
//  - 入れる項目は **受け取る側が使うものだけ**（日付・科目・相手科目・摘要・借方・貸方）。
//    消費税コード・税率は税務チェック用で、月次レポートは一切使わない
//  - **名寄せの結果も一緒に入れる**。顧問先の端末で名寄せを計算し直すと重いうえ、
//    事務所と顧問先でまとめ方が食い違って説明が噛み合わなくなる
//  - 元帳には従業員名や役員個人の支払が摘要に入る（「給料支払い（〇〇）」など）。
//    **含めるかどうかは顧問先ごとに選べるようにし、科目単位でも除ける**ようにしてある

import type { FiscalYearData } from './types'
import type { LedgerData } from './ledger'
import { sortedYears } from './calc'

/** 元帳を同梱できるようにしたので 2 へ上げた（1 は試算表のみ。受け取る側は両方読める） */
export const KEIEI_EXPORT_SCHEMA = 'keiei-monthly/2'
/** 元帳を含まないときは従来どおりの版で書き出す（古い受け取り側でも読めるように） */
export const KEIEI_EXPORT_SCHEMA_V1 = 'keiei-monthly/1'

export interface KeieiExportClient {
  code: string
  name: string
}

/** 同梱する元帳の明細1件（キーは短く。受け取る側の LedgerEntry と同じ並び） */
export interface KeieiExportLedgerRow {
  /** 日付 YYYY-MM-DD */
  d: string
  /** 科目コード */
  ac: string
  /** 科目名 */
  an: string
  /** 相手科目名 */
  ca: string
  /** 摘要 */
  no: string
  /** 借方金額 */
  dr: number
  /** 貸方金額 */
  cr: number
}

export interface KeieiExportLedger {
  /** どの期の元帳か（years の id） */
  yearId: string
  from: string
  to: string
  rows: KeieiExportLedgerRow[]
  /** 事務所で確定させた名寄せ（受け取る側は計算し直さない） */
  aliases?: { toGroup: Record<string, string>; label: Record<string, string> }
  /** 除いた科目名（顧問先に見せない指定をしたもの）。何を省いたか分かるように残す */
  excluded?: string[]
}

export interface KeieiExportFile {
  schema: string
  generatedAt: string // ISO8601
  client: KeieiExportClient
  years: FiscalYearData[] // 古い期→新しい期の順
  ledger?: KeieiExportLedger
}

/** 元帳を同梱するときの指定。 */
export interface LedgerExportOptions {
  yearId: string
  data: LedgerData
  aliases?: { toGroup: Record<string, string>; label: Record<string, string> }
  /** この科目名は入れない（給料手当・役員報酬・事業主貸など） */
  excludeAccounts?: string[]
}

/** 元帳の保存形式 → 同梱用の行に詰め替える（使わない項目は落とす）。 */
export function toExportLedger(o: LedgerExportOptions): KeieiExportLedger {
  const skip = new Set(o.excludeAccounts ?? [])
  const rows: KeieiExportLedgerRow[] = []
  for (const acc of o.data.accounts) {
    if (skip.has(acc.name)) continue
    for (const tx of acc.txs) {
      rows.push({
        d: tx.date, ac: acc.code, an: acc.name,
        ca: tx.counterName, no: tx.memo, dr: tx.debit, cr: tx.credit,
      })
    }
  }
  return {
    yearId: o.yearId,
    from: o.data.minDate,
    to: o.data.maxDate,
    rows,
    ...(o.aliases ? { aliases: o.aliases } : {}),
    ...(skip.size ? { excluded: Array.from(skip) } : {}),
  }
}

/**
 * 書き出す中身を組み立てる。
 * `years` は取込済みの全期（`loadYears` の戻り値）。`onlyIds` を渡すとその期だけに絞る。
 */
export function buildKeieiExport(
  client: KeieiExportClient,
  years: Record<string, FiscalYearData>,
  onlyIds?: string[],
  ledger?: KeieiExportLedger,
): KeieiExportFile {
  const pick = onlyIds && onlyIds.length ? new Set(onlyIds) : null
  const list = sortedYears(years).filter((y) => !pick || pick.has(y.id))
  return {
    schema: ledger ? KEIEI_EXPORT_SCHEMA : KEIEI_EXPORT_SCHEMA_V1,
    generatedAt: new Date().toISOString(),
    client: { code: client.code || '', name: client.name || '' },
    years: list,
    ...(ledger ? { ledger } : {}),
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

/**
 * JSON文字列。
 * 試算表の部分は**人が中身を確かめられるよう字下げしたまま**にし、
 * 元帳の明細だけは1行に詰める（明細は人が読むものではなく、件数が桁違いに多い。
 * 実測で字下げありは約1.6倍になる）。JSONとしては同一なので読み込む側は何も変わらない。
 */
export function keieiExportJson(file: KeieiExportFile): string {
  if (!file.ledger) return JSON.stringify(file, null, 2)
  const { ledger, ...rest } = file
  const head = JSON.stringify(rest, null, 2)
  const led = JSON.stringify({
    ...ledger,
    rows: undefined,
  }, null, 2)
  // rows だけを詰めた形に差し替える
  const ledBody = led.replace(/\n\}$/, '')
    + ',\n    "rows": ' + JSON.stringify(ledger.rows) + '\n  }'
  return head.replace(/\n\}$/, '') + ',\n  "ledger": '
    + ledBody.split('\n').map((l, i) => (i === 0 ? l : '  ' + l)).join('\n')
    + '\n}'
}

