// 月次経営レポート の計算エンジン（純粋関数のみ・画面から独立）。
//
// すべて取込済みの月次推移（State.years）から計算する。
// - 科目の特定は「小計コード」→「科目名パターン」の順で行い、
//   会計ソフト側の科目追加・改名にできるだけ耐える。
// - BSの月次値は「月末残高」、PLは「月中発生額」。
// - 進行期は lastFilledIndex までが実績。それ以降の列は無視する。
//
// ここでの簡便CF計算書は貸借対照表の増減から作る間接法で、
// 営業CF＋投資CF＋財務CF ＝ 現預金の増減 が恒等的に一致する方式
// （すべてのBS科目をどれか1つの区分に割り当てる）。

import type { AccountRow, FiscalYearData, State, CostClass } from './types';

// ---------------------------------------------------------------------------
// 基本ユーティリティ
// ---------------------------------------------------------------------------

export const yen = (n: number): string => (Math.round(n) || 0).toLocaleString('ja-JP');
/** 千円単位（表示用）。四捨五入 */
export const senYen = (n: number): string => Math.round(n / 1000).toLocaleString('ja-JP');
export const pct1 = (r: number): string => `${(r * 100).toFixed(1)}%`;

const sum = (a: number[]): number => a.reduce((x, y) => x + y, 0);
const zeros = (): number[] => Array.from({ length: 12 }, () => 0);

/** 列 i が暦の何年何月か（決算月の翌月から始まる12ヶ月）。 */
export function calYm(y: FiscalYearData, i: number): { year: number; month: number } {
  const month = y.fiscalMonths[i] ?? ((y.endMonth + i) % 12) + 1;
  const year = month > y.endMonth ? y.endYear - 1 : y.endYear;
  return { year, month };
}

export function ymLabel(y: FiscalYearData, i: number): string {
  const { year, month } = calYm(y, i);
  return `${year}年${month}月`;
}

// ---------------------------------------------------------------------------
// 科目の特定
// ---------------------------------------------------------------------------

/** 小計行の標準コード（この会計ソフトの月次推移で安定して使われる）。 */
export const CODES = {
  sales: '9534',      // 【純売上高】
  cogs: '9577',       // 【売上原価】
  gross: '9578',      // 〔売上総利益〕
  sga: '9579',        // 【販売費及び一般管理費】
  op: '9580',         // 〔営業利益〕
  nonOpInc: '9550',   // 【営業外収益】
  nonOpExp: '9552',   // 【営業外費用】
  ordinary: '9581',   // 〔経常利益〕
  pretax: '9582',     // 〔税引前当期純利益〕
  net: '9583',        // 〔当期純利益〕
  cash: '9564',       // 【現金及び預金】
  curAsset: '9566',   // 【流動資産】
  fixedAsset: '9567', // 【固定資産】
  assets: '9568',     // 【資産の部】
  curLiab: '9527',    // 【流動負債】
  fixLiab: '9529',    // 【固定負債】
  liab: '9569',       // 【負債の部】
  equity: '9573',     // 【純資産の部】
} as const;

const NAME_PATTERNS: Record<keyof typeof CODES, RegExp> = {
  sales: /純売上高|売上高合計/,
  cogs: /売上原価/,
  gross: /売上総利益/,
  sga: /販売費及び一般管理費|販売管理費/,
  op: /営業利益/,
  nonOpInc: /営業外収益/,
  nonOpExp: /営業外費用/,
  ordinary: /経常利益/,
  pretax: /税引前当期純利益/,
  net: /当期純利益/,
  cash: /現金及び預金|現金・預金/,
  curAsset: /流動資産/,
  fixedAsset: /固定資産/,
  assets: /資産の部/,
  curLiab: /流動負債/,
  fixLiab: /固定負債/,
  liab: /負債の部/,
  equity: /純資産の部/,
};

/** 小計行を特定する（コード→名前の順で照合）。 */
export function findTotal(y: FiscalYearData, key: keyof typeof CODES): AccountRow | null {
  const byCode = y.rows.find(r => r.isSubtotal && r.code === CODES[key]);
  if (byCode) return byCode;
  return y.rows.find(r => r.isSubtotal && NAME_PATTERNS[key].test(r.name)) ?? null;
}

const monthlyOf = (r: AccountRow | null): number[] => (r ? r.monthly.slice(0, 12) : zeros());

/** 名前パターンに一致する明細行（小計以外）の月次合計。 */
export function sumByName(y: FiscalYearData, statement: 'BS' | 'PL', pat: RegExp): number[] {
  const out = zeros();
  for (const r of y.rows) {
    if (r.statement !== statement || r.isSubtotal) continue;
    if (!pat.test(r.name)) continue;
    for (let i = 0; i < 12; i++) out[i] += r.monthly[i];
  }
  return out;
}

export const PAT = {
  depreciation: /減価償却/,
  interestExp: /支払利息|利息割引料/,
  interestInc: /受取利息/,
  receivable: /受取手形|売掛金|電子記録債権|完成工事未収|契約資産/,
  inventory: /^商品$|^製品$|仕掛品|原材料|貯蔵品|未成工事支出金|半製品|棚卸資産/,
  payable: /支払手形|買掛金|電子債務|電子記録債務|工事未払金|営業未払金/,
  debt: /短期借入金|長期借入金|社債|役員借入金/,
  lease: /リース債務/,
  personnel: /役員報酬|給料|給与|賃金|雑給|賞与|退職金|退職給付|法定福利|福利厚生|労務費/,
  taxRow: /法人税.*住民税|法人税等/,
} as const;

// ---------------------------------------------------------------------------
// 年度ごとの主要系列
// ---------------------------------------------------------------------------

/** 1年度分の主要系列（月次12列。実績は 0..lastFilledIndex）。 */
export interface YearSeries {
  y: FiscalYearData;
  months: number; // 実績が入っている月数
  // PL（発生額）
  sales: number[]; cogs: number[]; gross: number[]; sga: number[]; op: number[];
  nonOpInc: number[]; nonOpExp: number[]; ordinary: number[]; pretax: number[];
  tax: number[]; net: number[];
  depreciation: number[]; interestExp: number[]; interestInc: number[]; personnel: number[];
  // BS（月末残高）
  cash: number[]; curAsset: number[]; fixedAsset: number[]; assets: number[];
  curLiab: number[]; fixLiab: number[]; liab: number[]; equity: number[];
  receivable: number[]; inventory: number[]; payable: number[];
  debt: number[]; lease: number[];
  /** 固定資産売却益（PL・特別利益）: CFでは営業→投資へ振り替える */
  assetSaleGain: number[];
  /** 固定資産売却損・除却損（PL）: 同上（非資金・投資区分の調整） */
  assetSaleLoss: number[];
}

export function yearSeries(y: FiscalYearData): YearSeries {
  return {
    y,
    months: y.lastFilledIndex + 1,
    sales: monthlyOf(findTotal(y, 'sales')),
    cogs: monthlyOf(findTotal(y, 'cogs')),
    gross: monthlyOf(findTotal(y, 'gross')),
    sga: monthlyOf(findTotal(y, 'sga')),
    op: monthlyOf(findTotal(y, 'op')),
    nonOpInc: monthlyOf(findTotal(y, 'nonOpInc')),
    nonOpExp: monthlyOf(findTotal(y, 'nonOpExp')),
    ordinary: monthlyOf(findTotal(y, 'ordinary')),
    pretax: monthlyOf(findTotal(y, 'pretax')),
    tax: sumByName(y, 'PL', PAT.taxRow),
    net: monthlyOf(findTotal(y, 'net')),
    depreciation: sumByName(y, 'PL', PAT.depreciation),
    interestExp: sumByName(y, 'PL', PAT.interestExp),
    interestInc: sumByName(y, 'PL', PAT.interestInc),
    personnel: sumByName(y, 'PL', PAT.personnel),
    cash: monthlyOf(findTotal(y, 'cash')),
    curAsset: monthlyOf(findTotal(y, 'curAsset')),
    fixedAsset: monthlyOf(findTotal(y, 'fixedAsset')),
    assets: monthlyOf(findTotal(y, 'assets')),
    curLiab: monthlyOf(findTotal(y, 'curLiab')),
    fixLiab: monthlyOf(findTotal(y, 'fixLiab')),
    liab: monthlyOf(findTotal(y, 'liab')),
    equity: monthlyOf(findTotal(y, 'equity')),
    receivable: sumByName(y, 'BS', PAT.receivable),
    inventory: sumByName(y, 'BS', PAT.inventory),
    payable: sumByName(y, 'BS', PAT.payable),
    debt: sumByName(y, 'BS', PAT.debt),
    lease: sumByName(y, 'BS', PAT.lease),
    assetSaleGain: sumByName(y, 'PL', /固定資産売却益/),
    assetSaleLoss: sumByName(y, 'PL', /固定資産(売却|除却)損/),
  };
}

/** 年度を古い順に。 */
export function sortedYears(state: State): FiscalYearData[] {
  return [...state.years].sort((a, b) => a.id.localeCompare(b.id));
}

/** 直前の年度（決算年が1つ前・決算月が同じ）を探す。 */
export function prevYearOf(state: State, y: FiscalYearData): FiscalYearData | null {
  return state.years.find(p => p.endYear === y.endYear - 1 && p.endMonth === y.endMonth) ?? null;
}

// ---------------------------------------------------------------------------
// 時系列（全年度の実績月をつなげた月次タイムライン）
// ---------------------------------------------------------------------------

export interface MonthPoint {
  yearId: string;
  mi: number;          // 年度内の列番号 0..11
  year: number;        // 暦年
  month: number;       // 暦月
  label: string;       // "2026/6"
  s: YearSeries;       // 属する年度の系列
}

/** 実績が入っている月を古い順に並べたタイムライン。 */
export function timeline(state: State): MonthPoint[] {
  const out: MonthPoint[] = [];
  for (const y of sortedYears(state)) {
    const s = yearSeries(y);
    for (let i = 0; i <= y.lastFilledIndex; i++) {
      const { year, month } = calYm(y, i);
      out.push({ yearId: y.id, mi: i, year, month, label: `${year}/${month}`, s });
    }
  }
  return out;
}

/** タイムライン末尾 n ヶ月の合計を取る。 */
export function lastNSum(points: MonthPoint[], pick: (p: MonthPoint) => number, n = 12): number {
  return sum(points.slice(-n).map(pick));
}

// ---------------------------------------------------------------------------
// キャッシュ・フロー計算書（簡便法・間接法）
// ---------------------------------------------------------------------------

export interface CfMonth {
  mi: number;
  label: string;
  // 営業CF
  net: number;          // 当期純利益
  dep: number;          // ＋減価償却費
  dRecv: number;        // 売上債権の増減（増加はマイナス表示側）
  dInv: number;         // 棚卸資産の増減
  dPay: number;         // 仕入債務の増減
  dOtherWc: number;     // その他の営業資産・負債の増減（差額）
  saleAdj: number;      // 固定資産売却損益の振替額（営業CFから投資CFへ）
  opCf: number;
  // 投資CF
  invCf: number;        // −（固定資産の増加＋減価償却費）
  // 財務CF
  dDebt: number;        // 借入金・社債の増減
  dLease: number;       // リース債務の増減
  dEquityEtc: number;   // 増資・配当など（純資産の増減−当期純利益）
  finCf: number;
  // 検算
  dCash: number;        // 現預金の増減（実績）
  total: number;        // 営業＋投資＋財務（＝dCash になるはず）
}

export interface CfResult {
  months: CfMonth[];        // 計算できた月（期首残高が分かる月のみ）
  sums: Omit<CfMonth, 'mi' | 'label'>;
  hasOpening: boolean;      // 前期末残高が取れたか（false なら第2月から）
}

type SeriesPick = (x: YearSeries) => number[];

function cfBetween(s: YearSeries, i: number, prevOf: (sel: SeriesPick) => number): CfMonth {
  const d = (sel: SeriesPick) => sel(s)[i] - prevOf(sel);
  const net = s.net[i];
  const dep = s.depreciation[i];
  const dRecv = d(x => x.receivable);
  const dInv = d(x => x.inventory);
  const dPay = d(x => x.payable);
  // 営業資産（現預金以外の流動資産）・営業負債（借入・リースを除く負債）
  const dOpAsset = d(x => x.curAsset) - d(x => x.cash);
  const dOpLiab = d(x => x.curLiab) + d(x => x.fixLiab) - d(x => x.debt) - d(x => x.lease);
  const dOtherWc = -(dOpAsset - dRecv - dInv) + (dOpLiab - dPay);
  // 固定資産の売却益（除却損）は純利益に入っているが資産の処分によるもの。
  // 営業CFから除いて投資CF側に振り替える（合計は変わらず恒等一致は保たれる）
  const saleAdj = s.assetSaleGain[i] - s.assetSaleLoss[i];
  const opCf = net + dep - dRecv - dInv + dPay + dOtherWc - saleAdj;
  const invCf = -(d(x => x.fixedAsset) + dep) + saleAdj;
  const dDebt = d(x => x.debt);
  const dLease = d(x => x.lease);
  const dEquityEtc = d(x => x.equity) - net;
  const finCf = dDebt + dLease + dEquityEtc;
  const dCash = d(x => x.cash);
  return {
    mi: i, label: ymLabel(s.y, i),
    net, dep, dRecv, dInv, dPay, dOtherWc, saleAdj, opCf,
    invCf, dDebt, dLease, dEquityEtc, finCf,
    dCash, total: opCf + invCf + finCf,
  };
}

/** 年度の月次CF計算書。前期があれば期首（前期末残高）から。 */
export function cashFlowOf(state: State, y: FiscalYearData): CfResult {
  const s = yearSeries(y);
  const prevY = prevYearOf(state, y);
  const prevS = prevY && prevY.lastFilledIndex === 11 ? yearSeries(prevY) : null;
  const months: CfMonth[] = [];
  for (let i = 0; i <= y.lastFilledIndex; i++) {
    if (i === 0) {
      if (!prevS) continue; // 期首残高が無い年度は第2月から
      months.push(cfBetween(s, 0, sel => sel(prevS)[11]));
    } else {
      months.push(cfBetween(s, i, sel => sel(s)[i - 1]));
    }
  }
  const keys = ['net', 'dep', 'dRecv', 'dInv', 'dPay', 'dOtherWc', 'saleAdj', 'opCf', 'invCf', 'dDebt', 'dLease', 'dEquityEtc', 'finCf', 'dCash', 'total'] as const;
  const sums = Object.fromEntries(keys.map(k => [k, sum(months.map(m => m[k]))])) as CfResult['sums'];
  return { months, sums, hasOpening: !!prevS };
}

/** CF計算書 明細表の行定義（画面とExcelで共有する）。 */
export interface CfRowDef {
  label: string;
  pick: (m: Omit<CfMonth, 'mi' | 'label'>) => number;
  /** 区分計の行（営業CF計・投資CF・財務CF計。ハイライトする） */
  section?: boolean;
  /** 区分計の内訳（1文字下げて表示する） */
  indent?: boolean;
  /** 最下行（現預金の増減） */
  last?: boolean;
  /** 合計が0のときは行ごと隠す（固定資産売却の振替など） */
  optional?: boolean;
}

/**
 * 区分計を先に出し、その内訳をインデントして下に並べる。
 *   営業CF計 → 内訳（利益・減価償却・運転資本…）
 *   投資CF   → 内訳（固定資産の増減・減価償却費の戻し）
 *   財務CF計 → 内訳（借入・リース・増資配当）
 *   現預金の増減（3区分の合計）
 */
export const CF_ROWS: CfRowDef[] = [
  { label: '営業CF計', pick: m => m.opCf, section: true },
  { label: '当期純利益', pick: m => m.net, indent: true },
  { label: '＋減価償却費', pick: m => m.dep, indent: true },
  // 資産の増加は資金の減少になるため符号を反転して「資金への影響額」で並べる
  // （こうすることで内訳の合計＝営業CF計 になる）
  { label: '売上債権の増減（増加は資金減）', pick: m => -m.dRecv, indent: true },
  { label: '棚卸資産の増減（増加は資金減）', pick: m => -m.dInv, indent: true },
  { label: '仕入債務の増減（増加は資金増）', pick: m => m.dPay, indent: true },
  { label: 'その他の運転資本等', pick: m => m.dOtherWc, indent: true },
  // 固定資産の売却損益は利益に入っているが資産処分によるものなので投資CFへ振り替える
  // （売却等が無い年度は行ごと表示しない）
  { label: '固定資産売却損益の振替', pick: m => -m.saleAdj, indent: true, optional: true },

  { label: '投資CF（設備投資等）', pick: m => m.invCf, section: true },
  { label: '固定資産の増減（取得−売却）', pick: m => -(-(m.invCf - m.saleAdj) - m.dep), indent: true },
  { label: '−減価償却費（資金の支出でないため戻す）', pick: m => -m.dep, indent: true },
  { label: '固定資産売却損益の振替', pick: m => m.saleAdj, indent: true, optional: true },

  { label: '財務CF計', pick: m => m.finCf, section: true },
  { label: '借入金・社債の増減', pick: m => m.dDebt, indent: true },
  { label: 'リース債務の増減', pick: m => m.dLease, indent: true },
  { label: '増資・配当等', pick: m => m.dEquityEtc, indent: true },

  { label: '現預金の増減（営業＋投資＋財務）', pick: m => m.dCash, last: true },
];

// ---------------------------------------------------------------------------
// 借入金の返済・調達（FCF とのバランス）
// ---------------------------------------------------------------------------

export interface DebtSummary {
  debtNow: number;          // 有利子負債残高（借入金・社債。最新月）
  leaseNow: number;         // リース債務残高
  cashNow: number;          // 現預金残高（最新月）
  repay: number;            // 期間中の約定返済額（各借入の月次減少の合計）
  borrow: number;           // 期間中の新規調達額（増加の合計）
  months: number;           // 集計した月数
  repayMonthly: number;     // 月あたり返済額
  annualRepay: number;      // 直近12ヶ月の約定返済実績（半年賦・年賦の返済も取りこぼさない）
  fcf: number;              // フリーキャッシュフロー（営業CF＋投資CF）
  opCf: number;
  invCf: number;
  coverage: number | null;  // FCF ÷ 返済額
  redemptionYears: number | null;        // 債務償還年数（有利子負債÷償還原資）
  redemptionYearsNet: number | null;     // 実質（現預金控除後）
  redemptionSource: number; // 償還原資（直近12ヶ月: 経常利益＋減価償却−法人税等）
  liquidityMonths: number | null;        // 手元流動性（現預金÷平均月商）
  interestCoverage: number | null;       // インタレスト・カバレッジ
}

/**
 * 借入ごとの月次減少＝約定返済、増加＝新規調達 として期間集計する。
 * 短期借入金は手形借入の書換・折返しで残高が上下し「返済額」の実態を
 * 表さないため、約定返済の集計からは除外する（残高には含める）。
 */
export function debtSummary(state: State, y: FiscalYearData): DebtSummary {
  const s = yearSeries(y);
  const li = y.lastFilledIndex;
  const prevY = prevYearOf(state, y);
  const prevS = prevY && prevY.lastFilledIndex === 11 ? yearSeries(prevY) : null;

  // 約定返済を見る行: 長期借入金・社債・役員借入金・リース債務（短期借入金は除く）
  const debtRows = y.rows.filter(r => r.statement === 'BS' && !r.isSubtotal
    && (PAT.debt.test(r.name) || PAT.lease.test(r.name)) && !/短期借入金/.test(r.name));
  const prevRow = (r: AccountRow): number | null => {
    if (!prevS) return null;
    const p = prevY!.rows.find(x => x.statement === 'BS' && !x.isSubtotal
      && (x.code === r.code || x.name === r.name));
    return p ? p.monthly[11] : null;
  };
  let repay = 0; let borrow = 0;
  for (const r of debtRows) {
    for (let i = 0; i <= li; i++) {
      const prev = i === 0 ? prevRow(r) : r.monthly[i - 1];
      if (prev === null) continue;
      const diff = r.monthly[i] - prev;
      if (diff < 0) repay += -diff; else borrow += diff;
    }
  }
  const monthsCounted = prevS ? li + 1 : li; // 期首残高が無ければ第2月から

  // 直近12ヶ月の約定返済実績。進行期は前期の月を継ぎ足して12ヶ月にする。
  // 「月平均×12」だと半年賦・年賦の返済（社債の定時償還など）を取りこぼすため、
  // 実際の残高系列から直近12回分の月次減少を合計する
  let annualRepay = 0;
  if (prevS) {
    for (const r of debtRows) {
      const p = prevY!.rows.find(x => x.statement === 'BS' && !x.isSubtotal
        && (x.code === r.code || x.name === r.name));
      const series = [...(p ? p.monthly : [0]), ...r.monthly.slice(0, li + 1)].slice(-13);
      for (let i = 1; i < series.length; i++) {
        const diff = series[i] - series[i - 1];
        if (diff < 0) annualRepay += -diff;
      }
    }
    // 前期にだけ存在した借入（当期に行が無い＝完済等）は残高0に落ちたものとして数える
    const prevOnly = prevY!.rows.filter(pr => pr.statement === 'BS' && !pr.isSubtotal
      && (PAT.debt.test(pr.name) || PAT.lease.test(pr.name)) && !/短期借入金/.test(pr.name)
      && !y.rows.some(r => r.statement === 'BS' && !r.isSubtotal && (r.code === pr.code || r.name === pr.name)));
    for (const pr of prevOnly) {
      const series = [...pr.monthly, ...Array.from({ length: li + 1 }, () => 0)].slice(-13);
      for (let i = 1; i < series.length; i++) {
        const diff = series[i] - series[i - 1];
        if (diff < 0) annualRepay += -diff;
      }
    }
  } else {
    annualRepay = monthsCounted > 0 ? (repay / monthsCounted) * 12 : 0;
  }

  const cf = cashFlowOf(state, y);
  const fcf = cf.sums.opCf + cf.sums.invCf;

  // 償還原資などは「この年度の最終実績月」で終わる直近12ヶ月で集計する
  // （過年度を表示しているときに進行期の数字が混ざらないように）
  const tlAll = timeline(state);
  const endIdx = (() => {
    for (let i = tlAll.length - 1; i >= 0; i--) {
      if (tlAll[i].yearId === y.id) return i;
    }
    return tlAll.length - 1;
  })();
  const tl = tlAll.slice(0, endIdx + 1);
  const ord12 = lastNSum(tl, p => p.s.ordinary[p.mi]);
  const dep12 = lastNSum(tl, p => p.s.depreciation[p.mi]);
  const tax12 = lastNSum(tl, p => p.s.tax[p.mi]);
  const sales12 = lastNSum(tl, p => p.s.sales[p.mi]);
  const source = ord12 + dep12 - tax12;

  const debtNow = s.debt[li];
  const leaseNow = s.lease[li];
  const cashNow = s.cash[li];
  const avgSales = tl.length ? sales12 / Math.min(12, tl.length) : 0;
  const int12 = lastNSum(tl, p => p.s.interestExp[p.mi]);
  const op12 = lastNSum(tl, p => p.s.op[p.mi]);
  const intInc12 = lastNSum(tl, p => p.s.interestInc[p.mi]);

  return {
    debtNow, leaseNow, cashNow,
    repay, borrow, months: monthsCounted,
    repayMonthly: monthsCounted > 0 ? repay / monthsCounted : 0,
    annualRepay,
    fcf, opCf: cf.sums.opCf, invCf: cf.sums.invCf,
    coverage: repay > 0 ? fcf / repay : null,
    redemptionYears: source > 0 ? (debtNow + leaseNow) / source : null,
    redemptionYearsNet: source > 0 ? Math.max(0, debtNow + leaseNow - cashNow) / source : null,
    redemptionSource: source,
    liquidityMonths: avgSales > 0 ? cashNow / avgSales : null,
    interestCoverage: int12 > 0 ? (op12 + intInc12) / int12 : null,
  };
}

// ---------------------------------------------------------------------------
// 変動費・固定費の分類と損益分岐点（CVP）
// ---------------------------------------------------------------------------

/** PL の明細行がどの区分（売上・原価・販管費・営業外…）に属するか。 */
export type PlSection = 'sales' | 'cogs' | 'sga' | 'nonOpInc' | 'nonOpExp' | 'other';

/** PL 明細行を並び順から区分に割り当てる（小計行が区切り）。 */
export function plSections(y: FiscalYearData): { row: AccountRow; section: PlSection }[] {
  const out: { row: AccountRow; section: PlSection }[] = [];
  let pending: AccountRow[] = [];
  const flush = (section: PlSection) => {
    for (const row of pending) out.push({ row, section });
    pending = [];
  };
  for (const r of y.rows) {
    if (r.statement !== 'PL') continue;
    if (r.isSubtotal) {
      if (r.code === CODES.sales || /純売上高/.test(r.name)) flush('sales');
      else if (r.code === CODES.cogs || /売上原価/.test(r.name)) flush('cogs');
      else if (r.code === CODES.sga || /販売費及び一般管理費/.test(r.name)) flush('sga');
      else if (r.code === CODES.nonOpInc || /営業外収益/.test(r.name)) flush('nonOpInc');
      else if (r.code === CODES.nonOpExp || /営業外費用/.test(r.name)) flush('nonOpExp');
      else flush('other');
      continue;
    }
    pending.push(r);
  }
  flush('other');
  return out;
}

/** 既定の変動費/固定費判定：原価＝変動費、販管費・営業外費用＝固定費。 */
export function defaultCostClass(section: PlSection): CostClass | null {
  if (section === 'cogs') return 'variable';
  if (section === 'sga' || section === 'nonOpExp') return 'fixed';
  return null; // 売上・営業外収益・その他は費用ではない
}

export interface CvpInput {
  sales: number;       // 期間売上高
  variable: number;    // 変動費
  fixed: number;       // 固定費（販管費＋営業外費用のうち固定・営業外収益は控除）
  nonOpInc: number;    // 営業外収益（固定費から控除して経常ベースに）
  months: number;      // 集計月数
}

export interface CvpResult extends CvpInput {
  mcRate: number;          // 限界利益率
  bepSales: number | null; // 損益分岐点売上高（期間）
  safety: number | null;   // 安全余裕率
  ordinary: number;        // 経常利益（検算用）
  fixedNet: number;        // 営業外収益控除後の固定費
}

/**
 * 明細行の符号つき金額。期末棚卸高は売上原価の控除項目
 * （原価計 ＝ 期首棚卸＋仕入等−期末棚卸）なのでマイナスとして扱う。
 */
export function signedRowValue(row: AccountRow, take: (arr: number[]) => number): number {
  const v = take(row.monthly);
  return /期末/.test(row.name) && /棚卸/.test(row.name) ? -v : v;
}

/**
 * 期間のCVP集計。costClass の上書きを反映する。
 * period: 年度の実績月すべて（進行期は途中まで）。
 *
 * 基準は小計（売上原価計＝変動費・販管費＋営業外費用＝固定費）から取り、
 * 科目単位の上書きは差分として動かす。こうすると上書きが無い限り
 * 限界利益 − 固定費（営業外収益控除後）＝ 経常利益 が必ず成立する。
 */
export function cvpOf(state: State, y: FiscalYearData): CvpResult {
  const s = yearSeries(y);
  const li = y.lastFilledIndex;
  const take = (arr: number[]) => sum(arr.slice(0, li + 1));
  let variable = take(s.cogs);
  let fixed = take(s.sga) + take(s.nonOpExp);
  for (const { row, section } of plSections(y)) {
    const def = defaultCostClass(section);
    if (!def) continue;
    const cls = state.settings.costClass[row.code] ?? def;
    if (cls === def) continue;
    const v = signedRowValue(row, take);
    if (def === 'variable' && cls === 'fixed') { variable -= v; fixed += v; }
    if (def === 'fixed' && cls === 'variable') { fixed -= v; variable += v; }
  }
  const sales = take(s.sales);
  const nonOpInc = take(s.nonOpInc);
  const fixedNet = fixed - nonOpInc;
  const mcRate = sales > 0 ? (sales - variable) / sales : 0;
  const bepSales = mcRate > 0 ? fixedNet / mcRate : null;
  return {
    sales, variable, fixed, nonOpInc, months: li + 1,
    mcRate,
    bepSales,
    safety: bepSales !== null && sales > 0 ? (sales - bepSales) / sales : null,
    ordinary: take(s.ordinary),
    fixedNet,
  };
}

/**
 * CVP集計を12ヶ月に年換算する（率は変わらない）。
 * 進行期（実績が12ヶ月未満）の必要売上高を「年間いくら」で示すときに使う。
 */
export function annualizeCvp(cvp: CvpResult): CvpResult {
  const k = cvp.months > 0 ? 12 / cvp.months : 1;
  const sales = cvp.sales * k;
  const bepSales = cvp.bepSales !== null ? cvp.bepSales * k : null;
  return {
    ...cvp,
    sales,
    variable: cvp.variable * k,
    fixed: cvp.fixed * k,
    nonOpInc: cvp.nonOpInc * k,
    fixedNet: cvp.fixedNet * k,
    ordinary: cvp.ordinary * k,
    months: 12,
    bepSales,
    safety: bepSales !== null && sales > 0 ? (sales - bepSales) / sales : null,
  };
}

/** 目標経常利益を出すのに必要な売上高。 */
export function requiredSales(cvp: CvpResult, targetProfit: number): number | null {
  if (cvp.mcRate <= 0) return null;
  return (cvp.fixedNet + targetProfit) / cvp.mcRate;
}

/**
 * 借入返済原資を確保するための必要売上高。
 * 返済原資 ＝ 税引後利益＋減価償却費 ≧ 年間返済額 となる売上を逆算する。
 * 必要税引前利益 ＝ (年間返済額 − 減価償却費) ÷ (1 − 実効税率)
 */
export function requiredSalesForRepay(
  cvp: CvpResult, annualRepay: number, annualDep: number, taxRatePct: number,
): { pretaxNeeded: number; sales: number | null } {
  const shortage = Math.max(0, annualRepay - annualDep);
  const pretaxNeeded = shortage / Math.max(0.01, 1 - taxRatePct / 100);
  return { pretaxNeeded, sales: requiredSales(cvp, pretaxNeeded) };
}

// ---------------------------------------------------------------------------
// 進行期の着地予測
// ---------------------------------------------------------------------------

export interface ForecastMonth {
  mi: number;
  label: string;
  actual: boolean;      // 実績か予測か
  sales: number;
  variable: number;
  fixed: number;        // 固定費（販管費＋営業外費用）
  nonOpInc: number;
  ordinary: number;
}

export interface ForecastResult {
  months: ForecastMonth[];
  salesAdj: number;             // 使用した売上調整率（前年同月比）
  ytdSales: number; prevYtdSales: number;
  landing: {                    // 通期着地
    sales: number; variable: number; fixedNet: number;
    ordinary: number; pretax: number;
  };
  actualMonths: number;
  hasPrevYear: boolean;
}

/**
 * 進行期の通期着地予測。
 * 残月の売上 ＝ 前年同月売上 × 調整率（既定は当期累計の前年同期比）、
 * 変動費 ＝ 売上 × 当期実績の変動費率、固定費 ＝ 前年同月（無ければ当期平均）。
 */
export function forecastOf(state: State, y: FiscalYearData, salesAdjOverride?: number): ForecastResult {
  const s = yearSeries(y);
  const li = y.lastFilledIndex;
  const prevY = prevYearOf(state, y);
  const prevS = prevY && prevY.lastFilledIndex === 11 ? yearSeries(prevY) : null;
  // 変動費率は帳簿の売上原価率そのまま（CVPの分類上書きの影響を受けない）。
  // 残月の固定費も帳簿の販管費＋営業外費用で見るため、両者の整合が取れる
  const salesActual = sum(s.sales.slice(0, li + 1));
  const varRate = salesActual > 0 ? sum(s.cogs.slice(0, li + 1)) / salesActual : 0;

  const ytdSales = salesActual;
  const prevYtdSales = prevS ? sum(prevS.sales.slice(0, li + 1)) : 0;
  const autoAdj = prevYtdSales > 0 ? Math.min(1.5, Math.max(0.5, ytdSales / prevYtdSales)) : 1;
  const salesAdj = salesAdjOverride ?? autoAdj;

  // 当期実績の固定費（月次）: 販管費＋営業外費用
  const fixedActual = (i: number) => s.sga[i] + s.nonOpExp[i];
  const avgFixed = li >= 0 ? sum(Array.from({ length: li + 1 }, (_, i) => fixedActual(i))) / (li + 1) : 0;
  const avgNonOpInc = li >= 0 ? sum(s.nonOpInc.slice(0, li + 1)) / (li + 1) : 0;

  const months: ForecastMonth[] = [];
  for (let i = 0; i < 12; i++) {
    if (i <= li) {
      months.push({
        mi: i, label: ymLabel(y, i), actual: true,
        sales: s.sales[i],
        variable: s.cogs[i],
        fixed: fixedActual(i),
        nonOpInc: s.nonOpInc[i],
        ordinary: s.ordinary[i],
      });
    } else {
      const sales = (prevS ? prevS.sales[i] : ytdSales / Math.max(1, li + 1)) * salesAdj;
      const variable = sales * varRate;
      const fixed = prevS ? prevS.sga[i] + prevS.nonOpExp[i] : avgFixed;
      const nonOpInc = prevS ? prevS.nonOpInc[i] : avgNonOpInc;
      months.push({
        mi: i, label: ymLabel(y, i), actual: false,
        sales, variable, fixed, nonOpInc,
        ordinary: sales - variable - fixed + nonOpInc,
      });
    }
  }
  const landingSales = sum(months.map(m => m.sales));
  const landingVar = sum(months.map(m => m.variable));
  const landingOrd = sum(months.map(m => m.ordinary));
  // 特別損益は実績分のみ織り込む（予測しない）
  const specialActual = sum(s.pretax.slice(0, li + 1)) - sum(s.ordinary.slice(0, li + 1));
  return {
    months, salesAdj, ytdSales, prevYtdSales,
    landing: {
      sales: landingSales,
      variable: landingVar,
      fixedNet: sum(months.map(m => m.fixed - m.nonOpInc)),
      ordinary: landingOrd,
      pretax: landingOrd + specialActual,
    },
    actualMonths: li + 1,
    hasPrevYear: !!prevS,
  };
}

// ---------------------------------------------------------------------------
// 納税額の簡易試算（中小法人・資本金1億円以下を想定）
// ---------------------------------------------------------------------------

export interface CorpTaxDetail {
  income: number;        // 課税所得（≒税引前利益で近似）
  corpTax: number;       // 法人税（軽減税率15%/23.2%）
  localCorpTax: number;  // 地方法人税（法人税×10.3%）
  inhabitantTax: number; // 住民税法人税割（法人税×7%）
  equalization: number;  // 住民税均等割
  bizTax: number;        // 事業税（所得割）
  specialBizTax: number; // 特別法人事業税（事業税×37%）
  total: number;
}

/**
 * 法人税等の簡易計算（標準税率・中小法人の目安）。
 * 課税所得は税引前利益で近似する（繰越欠損金・別表調整は考慮しない）。
 */
export function corpTaxEstimate(income: number, equalization: number): CorpTaxDetail {
  const inc = Math.max(0, income);
  const corpTax = Math.min(inc, 8_000_000) * 0.15 + Math.max(0, inc - 8_000_000) * 0.232;
  const localCorpTax = corpTax * 0.103;
  const inhabitantTax = corpTax * 0.07;
  const bizTax = Math.min(inc, 4_000_000) * 0.035
    + Math.max(0, Math.min(inc, 8_000_000) - 4_000_000) * 0.053
    + Math.max(0, inc - 8_000_000) * 0.07;
  const specialBizTax = bizTax * 0.37;
  const round = (n: number) => Math.floor(n / 100) * 100;
  const parts = {
    corpTax: round(corpTax), localCorpTax: round(localCorpTax),
    inhabitantTax: round(inhabitantTax), equalization,
    bizTax: round(bizTax), specialBizTax: round(specialBizTax),
  };
  return {
    income: inc, ...parts,
    total: parts.corpTax + parts.localCorpTax + parts.inhabitantTax
      + parts.equalization + parts.bizTax + parts.specialBizTax,
  };
}

export interface ConsumptionTaxForecast {
  received: number;   // 仮受消費税（最新残高）
  paid: number;       // 仮払消費税（最新残高）
  net: number;        // 差引（≒ここまでの納税義務の概算）
  elapsed: number;    // 経過月数
  annual: number;     // 年額予測（単純年換算）
  /** 前期末の未払消費税等 ＝ 前期の確定納付額（中間納付があった場合はその控除後） */
  prevActual: number | null;
}

/** 消費税の年額予測（仮受−仮払の残高を年換算する簡便法）。 */
export function consumptionTaxForecast(state: State, y: FiscalYearData): ConsumptionTaxForecast {
  const li = y.lastFilledIndex;
  const recv = sumByName(y, 'BS', /仮受消費税/);
  const paid = sumByName(y, 'BS', /仮払消費税/);
  const received = recv[li];
  const paidV = paid[li];
  const net = received - paidV;
  const elapsed = li + 1;
  const prevY = prevYearOf(state, y);
  let prevActual: number | null = null;
  if (prevY) {
    const unpaid = sumByName(prevY, 'BS', /未払消費税/);
    prevActual = unpaid[11] > 0 ? unpaid[11] : null;
  }
  return {
    received, paid: paidV, net, elapsed,
    annual: elapsed > 0 ? (net / elapsed) * 12 : 0,
    prevActual,
  };
}

// ---------------------------------------------------------------------------
// 労働分配率
// ---------------------------------------------------------------------------

export interface LaborShare {
  personnel: number;   // 人件費計（期間。原価内の労務費等も含む）
  gross: number;       // 売上総利益（期間）
  valueAdded: number;  // 付加価値（売上総利益＋原価に含めた人件費）
  rate: number | null; // 労働分配率 ＝ 人件費 ÷ 付加価値
  months: number;
}

export function laborShareOf(y: FiscalYearData): LaborShare {
  const s = yearSeries(y);
  const li = y.lastFilledIndex;
  const take = (arr: number[]) => sum(arr.slice(0, li + 1));
  const personnel = take(s.personnel);
  const gross = take(s.gross);
  // 原価に労務費等の人件費がある場合、粗利からは既に引かれているので
  // 付加価値へ足し戻す（製造業・建設業で分配率が過大にならないように）
  let personnelInCogs = 0;
  for (const { row, section } of plSections(y)) {
    if (section === 'cogs' && PAT.personnel.test(row.name)) {
      personnelInCogs += signedRowValue(row, take);
    }
  }
  const valueAdded = gross + personnelInCogs;
  return {
    personnel, gross, valueAdded,
    rate: valueAdded > 0 ? personnel / valueAdded : null,
    months: li + 1,
  };
}

/** 人件費の内訳（科目別・期間合計）。 */
export function personnelBreakdown(y: FiscalYearData): { name: string; amount: number }[] {
  const li = y.lastFilledIndex;
  return y.rows
    .filter(r => r.statement === 'PL' && !r.isSubtotal && PAT.personnel.test(r.name))
    .map(r => ({ name: r.name, amount: sum(r.monthly.slice(0, li + 1)) }))
    .filter(x => x.amount !== 0);
}

// ---------------------------------------------------------------------------
// シミュレーション
// ---------------------------------------------------------------------------

export interface SimParams {
  salesPct: number;      // 売上高の増減（%）
  mcRatePt: number;      // 限界利益率の増減（ポイント）
  personnelPct: number;  // 人件費の増減（%）
  otherFixedPct: number; // その他固定費の増減（%）
  invest: number;        // 追加の設備投資（年額・円）
  borrow: number;        // 新規借入（年額・円）
}

export const SIM_DEFAULTS: SimParams = {
  salesPct: 0, mcRatePt: 0, personnelPct: 0, otherFixedPct: 0, invest: 0, borrow: 0,
};

export interface SimBase {
  label: string;         // 基準（例: 進行期の着地予測）
  sales: number;         // 年間売上
  mcRate: number;        // 限界利益率
  personnel: number;     // 人件費（年）
  otherFixed: number;    // その他固定費（営業外収益控除後・年）
  dep: number;           // 減価償却費（年）
  repay: number;         // 約定返済額（年）
  cashNow: number;       // 現預金残高
  equalization: number;
}

export interface SimResult {
  sales: number; mc: number; mcRate: number;
  personnel: number; otherFixed: number; fixed: number;
  ordinary: number;
  tax: number; after: number;
  repayFund: number;       // 返済原資（税引後＋減価償却）
  repay: number;
  invest: number;          // 追加の設備投資（資金の支出）
  borrow: number;          // 新規借入（資金の入金）
  cashDelta: number;       // 年間の資金増減（返済原資−返済−投資＋借入）
  cashEnd: number;         // 12ヶ月後の現預金見込み
  bepSales: number | null;
  safety: number | null;
  cashPath: number[];      // 現預金の月次推移（12点）
}

/** スライダーの値を適用した年間シミュレーション。 */
export function simulate(base: SimBase, p: SimParams): SimResult {
  const sales = base.sales * (1 + p.salesPct / 100);
  const mcRate = Math.min(0.99, Math.max(0.01, base.mcRate + p.mcRatePt / 100));
  const mc = sales * mcRate;
  const personnel = base.personnel * (1 + p.personnelPct / 100);
  const otherFixed = base.otherFixed * (1 + p.otherFixedPct / 100);
  const fixed = personnel + otherFixed;
  const ordinary = mc - fixed;
  const tax = corpTaxEstimate(ordinary, base.equalization).total;
  const after = ordinary - tax;
  const repayFund = after + base.dep;
  const cashDelta = repayFund - base.repay - p.invest + p.borrow;
  const bepSales = mcRate > 0 ? fixed / mcRate : null;
  const cashPath = Array.from({ length: 12 }, (_, i) => base.cashNow + (cashDelta / 12) * (i + 1));
  return {
    sales, mc, mcRate, personnel, otherFixed, fixed, ordinary,
    tax, after, repayFund, repay: base.repay,
    invest: p.invest, borrow: p.borrow, cashDelta,
    cashEnd: base.cashNow + cashDelta,
    bepSales,
    safety: bepSales !== null && sales > 0 ? (sales - bepSales) / sales : null,
    cashPath,
  };
}

/** シミュレーションの基準値（進行期の着地予測ベース）を作る。 */
export function simBaseOf(state: State, y: FiscalYearData): SimBase {
  const fc = forecastOf(state, y);
  const s = yearSeries(y);
  const li = y.lastFilledIndex;
  const ds = debtSummary(state, y);
  const take = (arr: number[]) => sum(arr.slice(0, li + 1));
  // 人件費の年額（実績を年換算…着地の固定費のうち人件費割合で按分）
  const personnelActual = take(s.personnel);
  const fixedActual = take(s.sga) + take(s.nonOpExp) - take(s.nonOpInc);
  const personnelShare = fixedActual > 0 ? personnelActual / fixedActual : 0.5;
  const fixedNet = fc.landing.fixedNet;
  const personnel = fixedNet * personnelShare;
  const salesActual = take(s.sales);
  const mcRate = fc.landing.sales > 0
    ? (fc.landing.sales - fc.landing.variable) / fc.landing.sales
    : salesActual > 0 ? (salesActual - take(s.cogs)) / salesActual : 0;
  // 約定返済は直近12ヶ月の実績（半年賦・年賦の返済も含む）
  const annualRepay = ds.annualRepay;
  const dep12 = (take(s.depreciation) / Math.max(1, li + 1)) * 12;
  return {
    label: `${y.label}の着地予測`,
    sales: fc.landing.sales,
    mcRate,
    personnel,
    otherFixed: fixedNet - personnel,
    dep: dep12,
    repay: annualRepay,
    cashNow: s.cash[li],
    equalization: state.settings.equalization,
  };
}

// ---------------------------------------------------------------------------
// 自動所見（ダッシュボードのコメント）
// ---------------------------------------------------------------------------

export interface Insight { tone: 'good' | 'warn' | 'bad' | 'info'; text: string }

export function insightsOf(state: State, target?: FiscalYearData): Insight[] {
  const years = sortedYears(state);
  if (!years.length) return [];
  const y = target ?? years[years.length - 1];
  const s = yearSeries(y);
  const li = y.lastFilledIndex;
  const prevY = prevYearOf(state, y);
  const prevS = prevY ? yearSeries(prevY) : null;
  const out: Insight[] = [];
  const take = (arr: number[], n = li + 1) => sum(arr.slice(0, n));

  // 売上の前年比
  if (prevS) {
    const cur = take(s.sales);
    const prv = take(prevS.sales);
    if (prv > 0) {
      const r = cur / prv - 1;
      out.push({
        tone: r >= 0.03 ? 'good' : r <= -0.03 ? 'bad' : 'info',
        text: `売上高（累計 ${li + 1}ヶ月）は前年同期比 ${(r * 100).toFixed(1)}%（${yen(cur)}円 / 前年 ${yen(prv)}円）。`,
      });
    }
  }
  // 粗利率（主要指標の表と同じ「前年同期」で比べる）
  {
    const gr = take(s.sales) > 0 ? take(s.gross) / take(s.sales) : 0;
    const prevOk = !!prevS && !!prevY && prevY.lastFilledIndex >= li;
    const prevGr = prevOk && take(prevS!.sales) > 0 ? take(prevS!.gross) / take(prevS!.sales) : null;
    if (prevGr !== null) {
      const d = (gr - prevGr) * 100;
      out.push({
        tone: d >= 1 ? 'good' : d <= -1 ? 'warn' : 'info',
        text: `粗利率は ${(gr * 100).toFixed(1)}%（前年同期 ${(prevGr * 100).toFixed(1)}%、${d >= 0 ? '+' : ''}${d.toFixed(1)}pt）。`,
      });
    }
  }
  // 経常利益
  {
    const ord = take(s.ordinary);
    out.push({
      tone: ord >= 0 ? 'good' : 'bad',
      text: ord >= 0
        ? `経常利益は累計 ${yen(ord)}円の黒字です。`
        : `経常利益は累計 ${yen(ord)}円の赤字です。原因（売上・粗利率・固定費）を月次推移で確認してください。`,
    });
  }
  // 現預金と手元流動性
  {
    const ds = debtSummary(state, y);
    if (ds.liquidityMonths !== null) {
      const m = ds.liquidityMonths;
      out.push({
        tone: m >= 3 ? 'good' : m >= 1.5 ? 'warn' : 'bad',
        text: `現預金は ${yen(ds.cashNow)}円で、平均月商の ${m.toFixed(1)}ヶ月分です${m >= 3 ? '（目安の3ヶ月分を確保）' : '（目安は3ヶ月分以上）'}。`,
      });
    }
    if (ds.redemptionYears !== null) {
      out.push({
        tone: ds.redemptionYears <= 10 ? 'good' : 'warn',
        text: `債務償還年数は ${ds.redemptionYears.toFixed(1)}年です（10年以内が金融機関の目安）。`,
      });
    } else if (ds.debtNow + ds.leaseNow > 0) {
      out.push({ tone: 'warn', text: '直近12ヶ月の償還原資（経常利益＋減価償却−法人税等）がマイナスのため、債務償還年数を計算できません。' });
    }
  }
  // 労働分配率
  {
    const ls = laborShareOf(y);
    const prevLs = prevY ? laborShareOf(prevY) : null;
    if (ls.rate !== null) {
      const cmp = prevLs?.rate != null ? `（前期 ${(prevLs.rate * 100).toFixed(1)}%）` : '';
      out.push({
        tone: ls.rate <= 0.6 ? 'good' : ls.rate <= 0.75 ? 'warn' : 'bad',
        text: `労働分配率は ${(ls.rate * 100).toFixed(1)}%${cmp}。粗利の${ls.rate > 0.75 ? '大半が人件費に回っており、粗利の確保か生産性の改善が必要です' : 'うち人件費に回る割合です（60%以下が目安）'}。`,
      });
    }
  }
  return out;
}
