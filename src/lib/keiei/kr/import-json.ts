// 取込JSONの検証・正規化・年度マージ。
//
// 会計ソフトから吐き出した月次推移JSON（keiei-monthly/1）を受け取り、
// State に取り込める形へ正規化する。壊れたファイル・別スキーマは
// 例外を投げて取り込まない（既存データを上書きしない）。

import type { AccountRow, FiscalYearData, State } from './types';
import { IMPORT_SCHEMA } from './types';

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** 取込前のプレビュー情報。 */
export interface ImportPreview {
  client: { code: string; name: string };
  generatedAt: string;
  years: { id: string; label: string; months: number; rows: number }[];
}

/** 取込JSON全体。検証済み。 */
export interface ParsedImport {
  client: { code: string; name: string };
  generatedAt: string;
  years: FiscalYearData[];
}

function normalizeRow(r: Record<string, unknown>): AccountRow {
  const monthlyRaw = Array.isArray(r.monthly) ? r.monthly : [];
  const monthly = Array.from({ length: 12 }, (_, i) => num(monthlyRaw[i]));
  return {
    code: str(r.code),
    name: str(r.name),
    statement: r.statement === 'PL' ? 'PL' : 'BS',
    monthly,
    annual: num(r.annual),
    ratio: num(r.ratio),
    isSubtotal: r.isSubtotal === true,
    bracket: str(r.bracket),
    level: num(r.level),
  };
}

function normalizeYear(y: Record<string, unknown>): FiscalYearData {
  const fmRaw = Array.isArray(y.fiscalMonths) ? y.fiscalMonths : [];
  const rows = (Array.isArray(y.rows) ? y.rows : [])
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .map(normalizeRow);
  const endYear = num(y.endYear);
  const endMonth = num(y.endMonth);
  const li = num(y.lastFilledIndex);
  return {
    id: str(y.id) || `${endYear}-${String(endMonth).padStart(2, '0')}`,
    label: str(y.label) || `${endYear}年${endMonth}月期`,
    endYear,
    endMonth,
    fiscalMonths: Array.from({ length: 12 }, (_, i) => num(fmRaw[i])),
    lastFilledIndex: Math.min(11, Math.max(0, li)),
    rows,
  };
}

/** JSONテキストを検証して取込データにする。不正なら Error を投げる。 */
export function parseImport(text: string): ParsedImport {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new Error('JSONファイルとして読み込めませんでした。書き出したファイルをそのまま選択してください。');
  }
  if (!obj || typeof obj !== 'object') throw new Error('ファイルの内容が想定と異なります。');
  const d = obj as Record<string, unknown>;
  if (d.schema !== IMPORT_SCHEMA) {
    throw new Error(`このファイルは対応形式（${IMPORT_SCHEMA}）ではありません。月次推移の書き出しファイルを選択してください。`);
  }
  const client = (d.client && typeof d.client === 'object' ? d.client : {}) as Record<string, unknown>;
  const yearsRaw = Array.isArray(d.years) ? d.years : [];
  if (yearsRaw.length === 0) throw new Error('事業年度のデータが入っていません。');
  const years = yearsRaw
    .filter((y): y is Record<string, unknown> => !!y && typeof y === 'object')
    .map(normalizeYear)
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const y of years) {
    if (!y.rows.length) throw new Error(`${y.label} に科目データがありません。`);
  }
  return {
    client: { code: str(client.code), name: str(client.name) },
    generatedAt: str(d.generatedAt),
    years,
  };
}

export function previewOf(p: ParsedImport): ImportPreview {
  return {
    client: p.client,
    generatedAt: p.generatedAt,
    years: p.years.map(y => ({
      id: y.id,
      label: y.label,
      months: y.lastFilledIndex + 1,
      rows: y.rows.length,
    })),
  };
}

/**
 * 取込データを State の years にマージする。
 * 同じ年度id は新しい取込で置き換え、含まれない過去の年度は残す
 * （書き出し側が直近3期しか含まなくても、古い期のデータが消えないように）。
 */
export function mergeYears(existing: FiscalYearData[], incoming: FiscalYearData[]): FiscalYearData[] {
  const map = new Map<string, FiscalYearData>();
  for (const y of existing) map.set(y.id, y);
  for (const y of incoming) map.set(y.id, y);
  // Array.from を使う（この移植先は tsconfig の target が古く、Map の分割代入が使えないため）
  return Array.from(map.values()).sort((a, b) => a.id.localeCompare(b.id));
}

/** State の保存サイズ概算（表示用）。移植先は Firebase RTDB なので 1MiB 制限の警告は使わない。 */
export function approxStateBytes(state: State): number {
  return new TextEncoder().encode(JSON.stringify(state)).length;
}
