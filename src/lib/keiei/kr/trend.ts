// 月次推移表（損益・貸借）の表データモデル。
//
// 画面（TrendPL / TrendBS）と Excel 出力（excel.ts）で同じ構造を使い、
// 「画面で見えているものがそのままExcelになる」ようにする。
//
// 表示モードは3つ:
//   amount  … 当期実績（1科目1段）
//   compare … 前期比較（1科目4段: 当期実績値／前期実績値／同月差／同月比）
//   three   … 3期比較（1科目3段: 当期／前期／前々期の実績値。差・率は出さない）

import type { AccountRow, FiscalYearData, State } from './types';
import { calYm, prevYearOf, yen } from './analysis';

export type TrendMode = 'amount' | 'compare' | 'three';

export const MODE_LABEL: Record<TrendMode, string> = {
  amount: '当期実績', compare: '前期比較', three: '3期比較',
};

/**
 * 月次推移（損益）に出さない行。
 * 繰越利益剰余金の期首・期末は当期の損益ではなく残高の引継ぎなので、
 * 月次の損益推移では表示しない（貸借の繰越利益剰余金で確認できる）。
 */
export const PL_HIDDEN_ROW = /期首繰越利益剰余金|期末繰越利益剰余金/;

/** 表に出す行（損益は繰越利益剰余金の期首・期末を除く）。 */
export function statementRows(y: FiscalYearData, statement: 'PL' | 'BS'): AccountRow[] {
  const rows = y.rows.filter(r => r.statement === statement);
  return statement === 'PL' ? rows.filter(r => !PL_HIDDEN_ROW.test(r.name)) : rows;
}

/** 別年度から同じ科目の行を探す（コード優先・改名に備えて名前でも照合）。 */
export function matchRow(yy: FiscalYearData | null, r: AccountRow, statement: 'PL' | 'BS'): AccountRow | null {
  if (!yy) return null;
  return yy.rows.find(x => x.statement === statement && x.code === r.code)
    ?? yy.rows.find(x => x.statement === statement && x.name === r.name)
    ?? null;
}

// ---------------------------------------------------------------------------
// 折りたたみ（【】〔〕の小計だけ表示 ⇔ 部分展開 ⇔ 全展開）
// ---------------------------------------------------------------------------

/**
 * 各行が属するグループのキー（＝その明細をまとめる小計行のコード）を返す。
 * 試算表は「明細 → その小計」の並びなので、小計行が現れたところで区切る。
 * 小計行自身のキーは自分のコード（常に表示され、開閉ボタンを持つ）。
 */
export function groupKeys(rows: AccountRow[]): { keyOf: Map<AccountRow, string>; groups: string[]; detailCount: Map<string, number> } {
  const keyOf = new Map<AccountRow, string>();
  const groups: string[] = [];
  const detailCount = new Map<string, number>();
  let pending: AccountRow[] = [];
  for (const r of rows) {
    if (r.isSubtotal) {
      const key = r.code;
      keyOf.set(r, key);
      for (const d of pending) keyOf.set(d, key);
      detailCount.set(key, pending.length);
      groups.push(key);
      pending = [];
    } else {
      pending.push(r);
    }
  }
  // 末尾に小計が無い場合は最後のまとまりを独立グループにする
  if (pending.length) {
    const key = `__tail__`;
    for (const d of pending) keyOf.set(d, key);
    detailCount.set(key, pending.length);
    groups.push(key);
  }
  return { keyOf, groups, detailCount };
}

// ---------------------------------------------------------------------------
// セル
// ---------------------------------------------------------------------------

/** 1セル。画面表示（text）とExcel出力（value）の両方を持つ。 */
export interface TCell {
  /** 画面に出す文字列 */
  text: string;
  /** Excelに入れる数値（'—' などは null） */
  value: number | null;
  /** 数値の種類（Excelの書式に使う） */
  kind: 'amount' | 'ratio' | 'none';
  /** マイナス（赤字表示） */
  neg: boolean;
}

const NONE: TCell = { text: '—', value: null, kind: 'none', neg: false };
export const cellAmount = (v: number): TCell =>
  ({ text: yen(v), value: v, kind: 'amount', neg: v < 0 });
const cellDiff = (d: number): TCell =>
  ({ text: d > 0 ? `+${yen(d)}` : yen(d), value: d, kind: 'amount', neg: d < 0 });
const cellRatio = (cur: number, prev: number): TCell => {
  if (prev === 0) return NONE;
  const r = (cur / prev - 1) * 100;
  return { text: `${r > 0 ? '+' : ''}${r.toFixed(1)}%`, value: r, kind: 'ratio', neg: r < 0 };
};

// ---------------------------------------------------------------------------
// 表の組み立て
// ---------------------------------------------------------------------------

/** 1科目の1段（当期実績値・前期実績値・同月差 など）。 */
export interface TrendSeg {
  key: 'cur' | 'prv' | 'prv2' | 'diff' | 'ratio';
  /** 区分列に出すラベル */
  label: string;
  /** 12ヶ月分 */
  months: TCell[];
  /** 報告月までの累計（貸借では使わない） */
  cum: TCell;
  /** 年間累計（貸借では期末残高） */
  annual: TCell;
}

export interface TrendRow {
  row: AccountRow;
  /** 属するグループ（小計行のコード） */
  groupKey: string;
  /** この行が小計行なら、その配下の明細数 */
  detailCount: number;
  segs: TrendSeg[];
}

export interface TrendTable {
  statement: 'PL' | 'BS';
  mode: TrendMode;
  /** 月ラベル（"10月" など） */
  labels: string[];
  /** 実績月数 */
  months: number;
  /** 累計列を出すか（損益のみ） */
  hasCum: boolean;
  /** 年間累計（貸借は「期末」）の見出し */
  annualLabel: string;
  year: FiscalYearData;
  prevYear: FiscalYearData | null;
  prev2Year: FiscalYearData | null;
  rows: TrendRow[];
}

const sum = (a: number[]): number => a.reduce((x, y) => x + y, 0);

/** 年度の実績月だけを金額セルにし、未到来の月は '—' にする。 */
function monthCells(r: AccountRow | null, yy: FiscalYearData | null, limit: number): TCell[] {
  return Array.from({ length: 12 }, (_, i) => {
    if (!r || !yy || i > limit || i > yy.lastFilledIndex) return NONE;
    return cellAmount(r.monthly[i]);
  });
}

/** 月次推移表を組み立てる。 */
export function buildTrend(
  state: State, y: FiscalYearData, statement: 'PL' | 'BS', mode: TrendMode,
): TrendTable {
  const li = y.lastFilledIndex;
  const prevY = prevYearOf(state, y);
  const prev2Y = prevY ? prevYearOf(state, prevY) : null;
  const rows = statementRows(y, statement);
  const { keyOf, detailCount } = groupKeys(rows);
  const labels = Array.from({ length: 12 }, (_, i) => `${calYm(y, i).month}月`);
  const hasCum = statement === 'PL';

  const segsOf = (r: AccountRow): TrendSeg[] => {
    const pr = matchRow(prevY, r, statement);
    const pr2 = matchRow(prev2Y, r, statement);
    const curMonths = monthCells(r, y, li);
    const curCum = cellAmount(sum(r.monthly.slice(0, li + 1)));
    const curAnnual = cellAmount(r.annual);
    const cur: TrendSeg = {
      key: 'cur', label: '当期実績値', months: curMonths,
      cum: curCum,
      annual: statement === 'BS' && li < 11 ? { ...curAnnual, kind: 'amount' } : curAnnual,
    };
    if (mode === 'amount') return [cur];

    // 前期の段
    const prvMonths = monthCells(pr, prevY, 11);
    const prvCumOk = pr && prevY && prevY.lastFilledIndex >= li;
    const prv: TrendSeg = {
      key: 'prv', label: '前期実績値', months: prvMonths,
      cum: prvCumOk ? cellAmount(sum(pr!.monthly.slice(0, li + 1))) : NONE,
      annual: pr ? cellAmount(pr.annual) : NONE,
    };

    if (mode === 'three') {
      const prv2Months = monthCells(pr2, prev2Y, 11);
      const prv2CumOk = pr2 && prev2Y && prev2Y.lastFilledIndex >= li;
      const prv2: TrendSeg = {
        key: 'prv2', label: '前々期実績値', months: prv2Months,
        cum: prv2CumOk ? cellAmount(sum(pr2!.monthly.slice(0, li + 1))) : NONE,
        annual: pr2 ? cellAmount(pr2.annual) : NONE,
      };
      return [cur, prv, prv2];
    }

    // 前期比較（差・率）
    const cmp = Array.from({ length: 12 }, (_, i) => {
      if (!pr || !prevY || i > li || i > prevY.lastFilledIndex) return { d: NONE, p: NONE };
      return { d: cellDiff(r.monthly[i] - pr.monthly[i]), p: cellRatio(r.monthly[i], pr.monthly[i]) };
    });
    const cumCur = sum(r.monthly.slice(0, li + 1));
    const cumPrv = prvCumOk ? sum(pr!.monthly.slice(0, li + 1)) : null;
    const fullYearBoth = !!pr && prevY?.lastFilledIndex === 11 && li === 11;
    const diffSeg: TrendSeg = {
      key: 'diff', label: '同月差', months: cmp.map(c => c.d),
      cum: cumPrv !== null ? cellDiff(cumCur - cumPrv) : NONE,
      annual: fullYearBoth ? cellDiff(r.annual - pr!.annual) : NONE,
    };
    const ratioSeg: TrendSeg = {
      key: 'ratio', label: '同月比', months: cmp.map(c => c.p),
      cum: cumPrv !== null ? cellRatio(cumCur, cumPrv) : NONE,
      annual: fullYearBoth ? cellRatio(r.annual, pr!.annual) : NONE,
    };
    return [cur, prv, diffSeg, ratioSeg];
  };

  return {
    statement, mode, labels, months: li + 1, hasCum,
    annualLabel: statement === 'PL' ? '年間累計' : '期末',
    year: y, prevYear: prevY, prev2Year: prev2Y,
    rows: rows.map(r => ({
      row: r,
      groupKey: keyOf.get(r) ?? r.code,
      detailCount: r.isSubtotal ? (detailCount.get(r.code) ?? 0) : 0,
      segs: segsOf(r),
    })),
  };
}

/** 行の見た目の種類（小計＝group／利益＝profit／明細）。 */
export function rowKind(r: AccountRow): 'group' | 'profit' | 'detail' {
  if (r.bracket === 'profit') return 'profit';
  if (r.isSubtotal) return 'group';
  return 'detail';
}
