// 月次レポート・ビューア（顧問先用アプリから移植した画面群）と、
// この総合管理アプリが持っている月次推移データをつなぐアダプタ。
//
// 移植方針:
//   ビューア側（kr/ 配下）は顧問先用アプリの型（kr/types.ts の State）をそのまま使い、
//   計算ロジックには一切手を入れない。両アプリのデータの形はほぼ同じ（JSONの
//   schema 'keiei-monthly/1' は完全一致・勘定科目の小計コードも同じ）なので、
//   ここで詰め替えるだけで動く。1,600行の計算コードを書き換えるより壊れにくい。
//
// 【重要】報告月の反映方法:
//   ビューア側の計算はすべて y.lastFilledIndex（＝入力済みの最終月）を基準にしている。
//   この総合管理アプリは「報告月」をユーザーが選べるので、そのままだと
//   月を選び直しても数字が変わらない画面になる（エラーが出ないので気づきにくい）。
//   そこで **最新期の lastFilledIndex を選択月まで下げて渡す**。
//   これで全画面が選択月ベースになる（各計算関数を書き換える必要がない）。

import type { FiscalYearData as AppYear, AccountRow as AppRow } from '../types'
import type { State, FiscalYearData, AccountRow, CostClass } from './types'
import { STATE_VERSION } from './types'
import { sortedYears } from '../calc'
import type { KeieiSettings } from '../analysis'

/** ビューア側だけが使う設定。既存の KeieiSettings に相乗りして保存する（新しい保存先は作らない） */
export interface KrExtraSettings {
  taxRate?: number // 実効税率（%）
  equalization?: number // 法人住民税の均等割（円/年）
  costClass?: Record<string, CostClass> // 科目コード→変動費/固定費
  notes?: Record<string, string> // 所見メモ
  employees?: Record<string, number> // 年度ごとの従業員数
  // 取引先の名寄せの手動指定（表記→グループ / グループ→表示名）。自動判定より優先する
  krAliases?: { toGroup: Record<string, string>; label: Record<string, string> }
}

export const KR_DEFAULT_TAX_RATE = 34
export const KR_DEFAULT_EQUALIZATION = 70000

/**
 * 1行分の詰め替え。
 * RTDB は null・空文字・空配列を保存時に落とすため、欠けたフィールドをここで補う
 * （JSON取込の経路には移植元の正規化があるが、保存済みデータを直接開く経路には無い）。
 */
function toKrRow(r: AppRow): AccountRow {
  return {
    code: String(r.code ?? ''),
    name: String(r.name ?? ''),
    statement: r.statement === 'BS' ? 'BS' : 'PL',
    monthly: Array.isArray(r.monthly) ? r.monthly.map((v) => Number(v) || 0) : [],
    annual: Number(r.annual) || 0,
    ratio: Number(r.ratio) || 0,
    isSubtotal: !!r.isSubtotal,
    bracket: r.bracket ?? '',
    level: Number(r.level) || 0,
  }
}

/** 1期分の詰め替え。monthIdx を渡すとその月までを実績として扱う */
function toKrYear(y: AppYear, monthIdx?: number): FiscalYearData {
  const rows = Array.isArray(y.rows) ? y.rows.map(toKrRow) : []
  const filled = Math.max(0, Math.min(11, Number(y.lastFilledIndex) || 0))
  return {
    id: y.id,
    label: y.label,
    endYear: y.endYear,
    endMonth: y.endMonth,
    fiscalMonths: Array.isArray(y.fiscalMonths) && y.fiscalMonths.length === 12
      ? y.fiscalMonths
      : Array.from({ length: 12 }, (_, i) => ((y.endMonth + i) % 12) + 1),
    lastFilledIndex: monthIdx == null ? filled : Math.max(0, Math.min(monthIdx, filled)),
    rows,
  }
}

/**
 * この総合管理アプリの保存データ（期id→データ）を、ビューアの State に詰め替える。
 * monthIdx は「報告月」の列インデックス（0始まり）。最新期にだけ効かせる。
 */
export function toKrState(
  years: Record<string, AppYear>,
  opts: {
    monthIdx?: number
    client?: { code: string; name: string } | null
    settings?: KeieiSettings & KrExtraSettings
  } = {},
): State {
  const list = sortedYears(years)
  const latestId = list.length ? list[list.length - 1].id : ''
  const s = opts.settings
  return {
    version: STATE_VERSION,
    client: opts.client ?? null,
    generatedAt: '',
    // 移植先は期ごとに epoch ms を持つ。ビューアは全体で1つのISO文字列なので最大値を変換する
    uploadedAt: list.length
      ? new Date(Math.max(...list.map((y) => Number(y.uploadedAt) || 0))).toISOString()
      : '',
    years: list.map((y) => toKrYear(y, y.id === latestId ? opts.monthIdx : undefined)),
    settings: {
      taxRate: s?.taxRate ?? KR_DEFAULT_TAX_RATE,
      equalization: s?.equalization ?? KR_DEFAULT_EQUALIZATION,
      // varfix（既存の損益分岐点設定）とは粒度が違うので別キーで持つ
      costClass: s?.costClass ?? {},
      notes: s?.notes ?? {},
      employees: s?.employees ?? {},
      aiConsent: null,
      qaLog: [],
    },
  }
}

/**
 * ビューア側の期データ（JSON取込で受け取ったもの）を、この総合管理アプリの保存形式へ戻す。
 * reiwa・uploadedAt はビューア側に無いので補完し、bracket は保存側の型に絞る。
 */
export function toAppYear(y: FiscalYearData, uploadedAt: number): AppYear {
  const bracketOf = (b: string): '' | 'group' | 'profit' =>
    b === 'group' || b === 'profit' ? b : ''
  return {
    id: y.id,
    endYear: y.endYear,
    endMonth: y.endMonth,
    reiwa: y.endYear - 2018,
    label: y.label || `令和${y.endYear - 2018}年${y.endMonth}月期`,
    fiscalMonths: y.fiscalMonths,
    lastFilledIndex: Math.max(0, Math.min(11, y.lastFilledIndex)),
    rows: y.rows.map((r) => ({
      statement: r.statement,
      code: r.code,
      name: r.name,
      level: r.level,
      isSubtotal: r.isSubtotal,
      bracket: bracketOf(r.bracket),
      annual: r.annual,
      ratio: r.ratio,
      monthly: r.monthly,
    })),
    uploadedAt,
  }
}
