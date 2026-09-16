// 元帳の集計。
//
// ■ 二重計上をしない
// 総勘定元帳は同じ取引が2つの科目に現れる（現金の側と通信費の側）。
// 全部を足すと2倍になるので、**必ず勘定科目で範囲を絞ってから**集計する。
//   ・「〇〇への支払合計」… 費用・仕入の科目に計上された分だけ
//   ・「修繕費の相手先別」… 修繕費に計上された分だけ
// この前提は回答文にも明記する。

import type { State } from '../types';
import { plSections, sortedYears } from '../analysis';
import type { LedgerEntry } from './entry';
import { clusterPartners, nameKey } from './normalize';
import type { AliasMap, PartnerGroup } from './normalize';

/** 勘定科目の性質。 */
export type AccountKind = 'expense' | 'revenue' | 'bs';

/**
 * 勘定科目がどの性質かを、既に取り込んである月次推移から判定する。
 * 月次推移に無い科目は名前から推測する（元帳だけ先に取り込んだ場合に備えて）。
 */
export function accountKinds(state: State): Map<string, AccountKind> {
  const map = new Map<string, AccountKind>();
  for (const y of sortedYears(state)) {
    for (const { row, section } of plSections(y)) {
      if (row.isSubtotal) continue;
      const kind: AccountKind = section === 'sales' || section === 'nonOpInc' ? 'revenue' : 'expense';
      map.set(row.name, kind);
    }
    for (const r of y.rows) {
      if (r.statement === 'BS' && !r.isSubtotal && !map.has(r.name)) map.set(r.name, 'bs');
    }
  }
  return map;
}

/** 月次推移に無い科目の当て推量。 */
function guessKind(name: string): AccountKind {
  if (/売上|収入|受取|雑収/.test(name)) return 'revenue';
  if (/費|料|税|償却|給|賞与|報酬|公課|仕入|外注|損/.test(name)) return 'expense';
  return 'bs';
}

export function kindOf(kinds: Map<string, AccountKind>, name: string): AccountKind {
  return kinds.get(name) ?? guessKind(name);
}

/** 元帳全体をまとめて扱うための入れ物。 */
export interface Ledger {
  entries: LedgerEntry[];
  from: string;
  to: string;
  groups: PartnerGroup[];
  /** 表記のキー → グループid */
  keyToGroup: Map<string, string>;
}

/** 明細から取引先グループを組み立てる。 */
export function buildLedger(
  entries: LedgerEntry[], from: string, to: string, aliases: AliasMap,
): Ledger {
  // 資金移動の行も含めて名寄せする。金額の集計では貸借科目を数えないので、
  // 資金移動が取引先の金額に混ざることはない（そちらは現金・預金の科目に載る）。
  const counts = new Map<string, number>();
  for (const e of entries) {
    if (!e.p) continue;
    counts.set(e.p, (counts.get(e.p) ?? 0) + 1);
  }
  const groups = clusterPartners(
    Array.from(counts).map(([name, count]) => ({ name, count })), aliases,
  );
  const keyToGroup = new Map<string, string>();
  for (const g of groups) for (const v of g.variants) keyToGroup.set(nameKey(v.name), g.id);
  return { entries, from, to, groups, keyToGroup };
}

/** 明細がどのグループの取引か。 */
export function groupIdOf(led: Ledger, e: LedgerEntry): string | null {
  if (!e.p) return null;
  return led.keyToGroup.get(nameKey(e.p)) ?? null;
}

/** 日付が期間内か（from/to は YYYY-MM-DD。省略可）。 */
function inRange(d: string, from?: string, to?: string): boolean {
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

export interface Breakdown {
  name: string;
  amount: number;
  count: number;
}

/**
 * 取引先の数え方。
 *
 * 既定は「名寄せしたグループ全体」＝摘要の書き方が違っていても同じ取引先として合算する。
 * variant を指定すると **その表記だけ** を数える。
 * 名寄せは推測なので、まとめ過ぎ（別会社が1つになっている）を疑ったときに
 * 「この書き方だけで見る」へ切り替えられるようにするための仕組み。
 */
export interface PartnerScope {
  groupId: string;
  /** この表記（と、キーが同じ表記）だけを数える。null なら名寄せしたグループ全体 */
  variant?: string | null;
}

/** 明細がその数え方に入るか。 */
function inScope(led: Ledger, e: LedgerEntry, scope: PartnerScope): boolean {
  if (scope.variant) return !!e.p && nameKey(e.p) === nameKey(scope.variant);
  return groupIdOf(led, e) === scope.groupId;
}

/**
 * ある取引先の金額。
 * 費用（仕入・経費）と収益（売上）を分けて出す。
 * 費用は 借方−貸方、収益は 貸方−借方 で、いずれもプラスが「増えた側」。
 */
export function partnerTotals(
  led: Ledger, kinds: Map<string, AccountKind>, scope: string | PartnerScope,
  opts: { from?: string; to?: string } = {},
): { expense: number; revenue: number; byAccount: Breakdown[]; count: number } {
  const sc: PartnerScope = typeof scope === 'string' ? { groupId: scope } : scope;
  const acc = new Map<string, Breakdown>();
  let expense = 0; let revenue = 0; let count = 0;
  for (const e of led.entries) {
    if (!inScope(led, e, sc)) continue;
    if (!inRange(e.d, opts.from, opts.to)) continue;
    const k = kindOf(kinds, e.an);
    if (k === 'bs') continue;               // 買掛金・売掛金の側は二重計上になるので数えない
    const v = k === 'expense' ? e.dr - e.cr : e.cr - e.dr;
    if (v === 0) continue;
    if (k === 'expense') expense += v; else revenue += v;
    count++;
    const b = acc.get(e.an) ?? { name: e.an, amount: 0, count: 0 };
    b.amount += v; b.count++;
    acc.set(e.an, b);
  }
  return {
    expense, revenue, count,
    byAccount: Array.from(acc.values()).sort((a, b) => b.amount - a.amount),
  };
}

/**
 * ある勘定科目の相手先別ランキング。
 * 費用科目なら 借方−貸方、収益科目なら 貸方−借方。
 */
export function partnersOfAccount(
  led: Ledger, kinds: Map<string, AccountKind>, accountName: string,
  opts: { from?: string; to?: string } = {},
): { rows: Breakdown[]; total: number; kind: AccountKind } {
  const kind = kindOf(kinds, accountName);
  const byGroup = new Map<string, Breakdown>();
  const name = new Map<string, string>();
  for (const g of led.groups) name.set(g.id, g.name);
  let total = 0;
  for (const e of led.entries) {
    if (e.an !== accountName) continue;
    if (!inRange(e.d, opts.from, opts.to)) continue;
    const v = kind === 'revenue' ? e.cr - e.dr : e.dr - e.cr;
    if (v === 0) continue;
    total += v;
    const gid = groupIdOf(led, e) ?? `__${e.p || 'その他'}`;
    const label = name.get(gid) ?? (e.p || 'その他');
    const b = byGroup.get(gid) ?? { name: label, amount: 0, count: 0 };
    b.amount += v; b.count++;
    byGroup.set(gid, b);
  }
  return {
    rows: Array.from(byGroup.values()).sort((a, b) => b.amount - a.amount),
    total, kind,
  };
}

/** 取引先ごとの合計（一覧画面用）。 */
export function partnerSummary(
  led: Ledger, kinds: Map<string, AccountKind>,
): (PartnerGroup & { expense: number; revenue: number })[] {
  const exp = new Map<string, number>();
  const rev = new Map<string, number>();
  for (const e of led.entries) {
    const gid = groupIdOf(led, e);
    if (!gid) continue;
    const k = kindOf(kinds, e.an);
    if (k === 'bs') continue;
    if (k === 'expense') exp.set(gid, (exp.get(gid) ?? 0) + e.dr - e.cr);
    else rev.set(gid, (rev.get(gid) ?? 0) + e.cr - e.dr);
  }
  return led.groups
    .map(g => ({ ...g, expense: exp.get(g.id) ?? 0, revenue: rev.get(g.id) ?? 0 }))
    .sort((a, b) => (b.expense + b.revenue) - (a.expense + a.revenue));
}

/**
 * 質問文に出てくる取引先を探す。
 * 表記のゆれを吸収したキーで、質問文の中に含まれているかを見る。
 * いちばん長く一致したものを採る（「山新友部店」と「山新」なら前者）。
 *
 * どの表記で当たったかも返す。質問者が書いた表記そのものだけで
 * 数え直したいとき（名寄せのまとめ過ぎを疑うとき）の起点になる。
 */
export function findPartnerHit(
  led: Ledger, q: string,
): { group: PartnerGroup; variant: string } | null {
  const t = nameKey(q);
  if (!t) return null;
  let best: { group: PartnerGroup; variant: string } | null = null;
  let bestLen = 0;
  for (const g of led.groups) {
    for (const v of g.variants) {
      const k = nameKey(v.name);
      // 2文字以下は誤爆するので対象にしない
      if (k.length < 3 || k.length <= bestLen) continue;
      if (t.includes(k)) { best = { group: g, variant: v.name }; bestLen = k.length; }
    }
  }
  return best;
}

export function findPartner(led: Ledger, q: string): PartnerGroup | null {
  return findPartnerHit(led, q)?.group ?? null;
}

/**
 * ある取引先の月別金額。
 * months は年度の各月の期間（YYYY-MM-DD の from/to）を並べたもので、
 * 呼び出し側（回答の組み立て）が決算月に合わせて作る。
 */
export function partnerMonthly(
  led: Ledger, kinds: Map<string, AccountKind>, scope: string | PartnerScope,
  months: { from: string; to: string }[],
): { expense: number[]; revenue: number[]; counts: number[]; total: { expense: number; revenue: number; count: number } } {
  const sc: PartnerScope = typeof scope === 'string' ? { groupId: scope } : scope;
  const expense = months.map(() => 0);
  const revenue = months.map(() => 0);
  const counts = months.map(() => 0);
  const total = { expense: 0, revenue: 0, count: 0 };
  for (const e of led.entries) {
    if (!inScope(led, e, sc)) continue;
    const k = kindOf(kinds, e.an);
    if (k === 'bs') continue;               // 買掛金・売掛金の側は二重計上になる
    const v = k === 'expense' ? e.dr - e.cr : e.cr - e.dr;
    if (v === 0) continue;
    const i = months.findIndex(m => e.d >= m.from && e.d <= m.to);
    if (i < 0) continue;                    // 年度の外（前期以前の元帳）は数えない
    if (k === 'expense') { expense[i] += v; total.expense += v; }
    else { revenue[i] += v; total.revenue += v; }
    counts[i]++; total.count++;
  }
  return { expense, revenue, counts, total };
}

/**
 * 試算表の科目 → 元帳の科目名 を引くための対応表。
 * 科目名が最優先。試算表と元帳で表記が違うことがある（車輌費／車両費など）ので、
 * 名前で当たらなければ科目コードでも引けるようにしておく。
 * 明細は数万件になりうるので、**1回だけ作って使い回す**（行ごとに走査しない）。
 */
export interface AccountIndex {
  byName: Set<string>;
  byCode: Map<string, string>;
}

export function buildAccountIndex(led: Ledger): AccountIndex {
  const byName = new Set<string>();
  const byCode = new Map<string, string>();
  for (const e of led.entries) {
    byName.add(e.an);
    if (e.ac && !byCode.has(e.ac)) byCode.set(e.ac, e.an);
  }
  return { byName, byCode };
}

export function ledgerAccountOf(idx: AccountIndex, name: string, code?: string): string | null {
  if (idx.byName.has(name)) return name;
  if (code) return idx.byCode.get(code) ?? null;
  return null;
}

/**
 * ある勘定科目の明細（月次推移の数字から中身へ降りるため）。
 * 科目名で絞る。同じ名前の科目が複数の期に跨っていても、期間で切れば足りる。
 */
export function entriesOfAccount(
  led: Ledger, kinds: Map<string, AccountKind>, accountName: string,
  opts: { from?: string; to?: string } = {},
): { rows: LedgerEntry[]; total: number; kind: AccountKind; byPartner: Breakdown[] } {
  const kind = kindOf(kinds, accountName);
  const rows: LedgerEntry[] = [];
  const byGroup = new Map<string, Breakdown>();
  const label = new Map<string, string>();
  for (const g of led.groups) label.set(g.id, g.name);
  let total = 0;
  for (const e of led.entries) {
    if (e.an !== accountName) continue;
    if (!inRange(e.d, opts.from, opts.to)) continue;
    const v = kind === 'revenue' ? e.cr - e.dr : e.dr - e.cr;
    rows.push(e);
    total += v;
    const gid = groupIdOf(led, e) ?? `__${e.p || 'その他'}`;
    const b = byGroup.get(gid) ?? { name: label.get(gid) ?? (e.p || 'その他'), amount: 0, count: 0 };
    b.amount += v; b.count++;
    byGroup.set(gid, b);
  }
  rows.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  return {
    rows, total, kind,
    byPartner: Array.from(byGroup.values()).sort((a, b) => b.amount - a.amount),
  };
}

/** 元帳に載っている勘定科目名（ドリルダウンできるかの判定に使う）。 */
export function ledgerAccountNames(led: Ledger): Set<string> {
  return new Set(led.entries.map(e => e.an));
}

/**
 * 摘要の表記ごとの金額（取引先の整理で「どの書き方がいくらか」を出すため）。
 * 表記は数百〜数万になりうるので、**全明細を1回だけ走査して一括で作る**
 * （表記ごとに集計関数を呼ぶと二乗になる）。
 */
export function variantAmounts(
  led: Ledger, kinds: Map<string, AccountKind>,
): Map<string, { amount: number; count: number }> {
  const out = new Map<string, { amount: number; count: number }>();
  for (const e of led.entries) {
    if (!e.p) continue;
    const k = kindOf(kinds, e.an);
    if (k === 'bs') continue;               // 買掛金・売掛金の側は二重計上になる
    const v = k === 'expense' ? e.dr - e.cr : e.cr - e.dr;
    if (v === 0) continue;
    const key = nameKey(e.p);
    const b = out.get(key) ?? { amount: 0, count: 0 };
    b.amount += v; b.count++;
    out.set(key, b);
  }
  return out;
}

/** 元帳にある勘定科目のうち、質問文に出てくるもの。 */
export function findLedgerAccount(led: Ledger, q: string): string | null {
  const t = nameKey(q);
  const names = new Set(led.entries.map(e => e.an));
  let best: string | null = null;
  for (const n of Array.from(names)) {
    const k = nameKey(n);
    if (k.length < 2) continue;
    if (t.includes(k) && (!best || k.length > nameKey(best).length)) best = n;
  }
  return best;
}
