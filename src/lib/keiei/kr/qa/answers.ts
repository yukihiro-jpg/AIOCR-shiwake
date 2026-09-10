// 「AIに質問」の回答づくり。
//
// もっとも重要な設計: **金額の計算をAIにさせない**。
// 数字はすべてこのファイル（＝analysis.ts の計算結果）で確定させ、
// AIには「質問がどれに当たるか」の判定と、確定済みの数字の言い換えだけを任せる。
// そうしないと「それらしいが間違った金額」が顧問先に出てしまう。
//
// Phase 1 ではAIを呼ばず、決まった質問をキーワードで判定して定型文で答える
// （費用ゼロ・完全に正確）。Phase 2 で自由入力の判定だけをAIに置き換える。

import type { AccountRow, FiscalYearData, State } from '../types';
import {
  yearSeries, prevYearOf, sortedYears, calYm, ymLabel, yen, cvpOf, annualizeCvp,
  requiredSales, debtSummary, laborShareOf,
} from '../analysis';
import { findAccounts, sampleExpenseNames } from './accounts';
import type { AccountMatch } from './accounts';
import {
  partnerTotals, partnersOfAccount, findPartner, findLedgerAccount,
} from '../ledger/aggregate';
import type { Ledger, AccountKind } from '../ledger/aggregate';
import type { PartnerGroup } from '../ledger/normalize';

const sum = (a: number[]): number => a.reduce((x, y) => x + y, 0);
const man = (n: number) => `${Math.round(n / 10000).toLocaleString('ja-JP')}万円`;
const pct1 = (r: number) => `${(r * 100).toFixed(1)}%`;

/** 回答に添える根拠。画面はこれを見てグラフや表を描く。 */
export type Evidence =
  | { kind: 'bars'; title: string; labels: string[]; values: (number | null)[]; highlight?: number }
  | { kind: 'table'; title: string; rows: { label: string; value: string; note?: string }[] };

export interface Answer {
  /** 回答の文章（この中の数字はすべて計算済み） */
  text: string;
  /** 根拠（グラフ or 表） */
  evidence?: Evidence;
  /** 「詳しく見る」で飛ぶ画面 */
  link?: { label: string; to: string };
  /** どの集計で答えたか（ログ用） */
  tool: string;
}

/**
 * 質問文から読み取った条件。
 * 「5月は？」のように月を指定された場合、その月で答える。
 */
export interface AskContext {
  /** 質問が指している暦月（1〜12）。指定が無ければ null */
  month?: number | null;
  /** 「上半期」「4〜6月」などの期間（年度内の列番号 0〜11）。無ければ null */
  period?: Period | null;
  /** 何期前と比べるか（1=前期。「一昨年」なら2）。既定は1 */
  yearsBack?: number;
  /** 質問が指している勘定科目。無ければ null */
  account?: AccountMatch | null;
  /** 取り込んである元帳（未取込なら null） */
  ledger?: Ledger | null;
  /** 勘定科目の性質（費用/収益/貸借） */
  kinds?: Map<string, AccountKind>;
  /** 質問が指している取引先。無ければ null */
  partner?: PartnerGroup | null;
  /** 質問が指している元帳の勘定科目名。無ければ null */
  ledgerAccount?: string | null;
}

/** 期間（年度内の列番号）。from・to とも 0〜11 で、両端を含む。 */
export interface Period {
  from: number;
  to: number;
  label: string;
}

/** 顧問先が押せる定型の質問。 */
export interface Preset {
  id: string;
  label: string;
  /** この質問だと判定するためのキーワード（すべて含まれたら一致） */
  keys: string[][];
  run: (state: State, y: FiscalYearData, ctx?: AskContext) => Answer;
}

// ---------------------------------------------------------------------------
// 個々の集計
// ---------------------------------------------------------------------------

/** 月ラベル（実績のある月まで）。 */
function monthLabels(y: FiscalYearData): string[] {
  return Array.from({ length: 12 }, (_, i) => `${calYm(y, i).month}月`);
}
/** 実績のある月だけ値を入れ、未確定の月は null にする。 */
function actual(arr: number[], y: FiscalYearData): (number | null)[] {
  return arr.map((v, i) => (i <= y.lastFilledIndex ? v : null));
}

/** n期前の年度（1=前期）。無ければ null。 */
function yearsBackOf(state: State, y: FiscalYearData, n: number): FiscalYearData | null {
  if (n <= 1) return prevYearOf(state, y);
  return state.years.find(p => p.endYear === y.endYear - n && p.endMonth === y.endMonth) ?? null;
}

/** 実績のある月まで期間を切り詰める。全部が未確定なら empty を立てる。 */
function clampPeriod(p: Period | null, y: FiscalYearData):
(Period & { trimmed: boolean; empty: boolean; wanted: string }) | null {
  if (!p) return null;
  const li = y.lastFilledIndex;
  const to = Math.min(p.to, li);
  const empty = p.from > li;
  const trimmed = !empty && to < p.to;
  const label = trimmed
    ? `${calYm(y, p.from).month}月〜${calYm(y, to).month}月`
    : p.label;
  return { from: p.from, to, label, trimmed, empty, wanted: p.label };
}

/** その暦月（1〜12）が今期の何ヶ月目にあたるか。含まれなければ null。 */
function indexOfCalMonth(y: FiscalYearData, month: number): number | null {
  for (let i = 0; i < 12; i++) if (calYm(y, i).month === month) return i;
  return null;
}

/**
 * 単月の売上と利益。
 * 月の指定があればその月、無ければ報告月（最終実績月）で答える。
 * **聞かれた月と違う月の数字を返してはいけない**（黙って別の月を答えると誤解を招く）。
 * まだ確定していない月を聞かれたら、その旨をはっきり伝える。
 */
function monthResult(state: State, y: FiscalYearData, ctx?: AskContext): Answer {
  const s = yearSeries(y);
  const asked = ctx?.month ?? null;
  let li = y.lastFilledIndex;

  if (asked !== null) {
    const idx = indexOfCalMonth(y, asked);
    const last = calYm(y, y.lastFilledIndex);
    if (idx === null) {
      return {
        tool: 'monthResult',
        text: `${asked}月は今期（${y.label}）に含まれていません。`
          + `今期は ${calYm(y, 0).year}年${calYm(y, 0).month}月 から始まる事業年度です。`,
        link: { label: '月次推移（損益）で見る', to: '/pl' },
      };
    }
    if (idx > y.lastFilledIndex) {
      return {
        tool: 'monthResult',
        text: `${asked}月の実績は、まだ取り込まれていません。`
          + `今期で確定しているのは ${last.year}年${last.month}月 までです。`
          + `${asked}月の数字が出来上がりましたら担当者が取り込みますので、少しお待ちください。`,
        link: { label: `${last.month}月までの推移を見る`, to: '/pl' },
      };
    }
    li = idx;
  }

  const m = calYm(y, li);
  const sales = s.sales[li];
  const ord = s.ordinary[li];
  const gross = s.gross[li];
  const rate = sales > 0 ? gross / sales : 0;
  const prevY = prevYearOf(state, y);
  const prevS = prevY && prevY.lastFilledIndex >= li ? yearSeries(prevY) : null;
  const cmp = prevS
    ? `前年同月（${m.month}月）は売上 ${man(prevS.sales[li])}・経常利益 ${man(prevS.ordinary[li])} でした。`
    : '';
  return {
    tool: 'monthResult',
    text: `${m.year}年${m.month}月の売上高は ${yen(sales)}円、経常利益は ${yen(ord)}円`
      + `（${ord >= 0 ? '黒字' : '赤字'}）です。粗利率は ${pct1(rate)} でした。${cmp}`,
    evidence: {
      kind: 'table', title: `${m.year}年${m.month}月の実績`,
      rows: [
        { label: '売上高', value: `${yen(sales)}円` },
        { label: '売上総利益（粗利）', value: `${yen(gross)}円`, note: `粗利率 ${pct1(rate)}` },
        { label: '販売費及び一般管理費', value: `${yen(s.sga[li])}円` },
        { label: '営業利益', value: `${yen(s.op[li])}円` },
        { label: '経常利益', value: `${yen(ord)}円` },
      ],
    },
    link: { label: 'ダッシュボードで詳しく見る', to: '/' },
  };
}

/** 前年同期との比較。 */
function vsPrev(state: State, y: FiscalYearData): Answer {
  const s = yearSeries(y);
  const li = y.lastFilledIndex;
  const prevY = prevYearOf(state, y);
  const prevS = prevY && prevY.lastFilledIndex >= li ? yearSeries(prevY) : null;
  const take = (arr: number[]) => sum(arr.slice(0, li + 1));
  const sales = take(s.sales);
  const ord = take(s.ordinary);
  if (!prevS) {
    return {
      tool: 'vsPrev',
      text: `前期の同じ月数（${li + 1}ヶ月分）の実績が取り込まれていないため、比較できません。`
        + `今期はここまでで売上高 ${yen(sales)}円、経常利益 ${yen(ord)}円 です。`,
    };
  }
  const pSales = take(prevS.sales);
  const pOrd = take(prevS.ordinary);
  const rate = pSales > 0 ? sales / pSales - 1 : 0;
  return {
    tool: 'vsPrev',
    text: `今期はここまで${li + 1}ヶ月で売上高 ${yen(sales)}円です。`
      + `前年同期の ${yen(pSales)}円 と比べて ${rate >= 0 ? '＋' : '−'}${pct1(Math.abs(rate))}`
      + `（${rate >= 0 ? '増加' : '減少'}）しています。`
      + `経常利益は ${yen(ord)}円 で、前年同期 ${yen(pOrd)}円 との差は ${man(ord - pOrd)} です。`,
    evidence: {
      kind: 'table', title: `前年同期との比較（${li + 1}ヶ月累計）`,
      rows: [
        { label: '売上高', value: `${yen(sales)}円`, note: `前年同期 ${yen(pSales)}円` },
        { label: '売上総利益', value: `${yen(take(s.gross))}円`, note: `前年同期 ${yen(take(prevS.gross))}円` },
        { label: '営業利益', value: `${yen(take(s.op))}円`, note: `前年同期 ${yen(take(prevS.op))}円` },
        { label: '経常利益', value: `${yen(ord)}円`, note: `前年同期 ${yen(pOrd)}円` },
      ],
    },
    link: { label: '月次推移（損益）で科目ごとに見る', to: '/pl' },
  };
}

/** 現預金の増減。 */
function cashTrend(state: State, y: FiscalYearData): Answer {
  const s = yearSeries(y);
  const li = y.lastFilledIndex;
  const now = s.cash[li];
  const start = s.cash[0];
  const prevMonth = li > 0 ? s.cash[li - 1] : null;
  const diff = now - start;
  const ds = debtSummary(state, y);
  return {
    tool: 'cashTrend',
    text: `${ymLabel(y, li)}末の現金預金残高は ${yen(now)}円 です。`
      + (prevMonth !== null
        ? `前月末（${yen(prevMonth)}円）から ${now - prevMonth >= 0 ? '＋' : '−'}${yen(Math.abs(now - prevMonth))}円 ${now - prevMonth >= 0 ? '増えました' : '減りました'}。` : '')
      + `期首（${ymLabel(y, 0)}）と比べると ${diff >= 0 ? '＋' : '−'}${yen(Math.abs(diff))}円 です。`
      + (ds.liquidityMonths !== null
        ? `平均月商の ${ds.liquidityMonths.toFixed(1)}ヶ月分にあたります（目安は3ヶ月分）。` : ''),
    evidence: {
      kind: 'bars', title: '現金預金残高の推移（月末）',
      labels: monthLabels(y), values: actual(s.cash, y), highlight: li,
    },
    link: { label: '月次推移（貸借）で見る', to: '/bs' },
  };
}

/** 売上が一番高かった月。 */
function bestSalesMonth(_state: State, y: FiscalYearData): Answer {
  const s = yearSeries(y);
  const li = y.lastFilledIndex;
  let bi = 0;
  for (let i = 1; i <= li; i++) if (s.sales[i] > s.sales[bi]) bi = i;
  const avg = sum(s.sales.slice(0, li + 1)) / (li + 1);
  const m = calYm(y, bi);
  const ratio = avg > 0 ? s.sales[bi] / avg : 0;
  // 2番目・3番目も添える
  const order = Array.from({ length: li + 1 }, (_, i) => i)
    .sort((a, b) => s.sales[b] - s.sales[a]).slice(1, 3);
  const others = order
    .map(i => `${calYm(y, i).month}月が ${man(s.sales[i])}`).join('、');
  return {
    tool: 'bestSalesMonth',
    text: `今期でもっとも売上が高かったのは ${m.year}年${m.month}月の ${yen(s.sales[bi])}円 です。`
      + `${li + 1}ヶ月の平均（${man(avg)}）の約${ratio.toFixed(1)}倍でした。`
      + (others ? `次いで${others}です。` : ''),
    evidence: {
      kind: 'bars', title: '売上高の月次推移', labels: monthLabels(y),
      values: actual(s.sales, y), highlight: bi,
    },
    link: { label: '月次推移（損益）で科目ごとに見る', to: '/pl' },
  };
}

/** 損益分岐点。 */
function bep(state: State, y: FiscalYearData): Answer {
  const c = cvpOf(state, y);
  const months = y.lastFilledIndex + 1;
  if (c.bepSales === null) {
    return { tool: 'bep', text: '限界利益率が算出できないため、損益分岐点を計算できません。' };
  }
  // 損益分岐点のページと同じ「年間ベース」でそろえる（画面ごとに数字が違うと混乱するため）
  const cy = annualizeCvp(c);
  const bepYear = cy.bepSales ?? 0;
  const salesYear = cy.sales;
  const gap = bepYear - salesYear;
  return {
    tool: 'bep',
    text: `今のコスト構造のままだと、年間で ${yen(Math.round(bepYear))}円 の売上があれば損益がゼロになります。`
      + `今期の売上ペース（年換算 ${yen(Math.round(salesYear))}円）は`
      + (gap > 0
        ? `これを ${yen(Math.round(gap))}円 下回っているため、このままでは赤字が見込まれます。`
        : `これを ${yen(Math.round(-gap))}円 上回っており、黒字が見込まれます。`),
    evidence: {
      kind: 'table', title: '計算の内訳（年換算）',
      rows: [
        { label: '限界利益率', value: pct1(c.mcRate), note: '売上から仕入・外注などを引いた残りの割合' },
        { label: '固定費', value: `${yen(Math.round(cy.fixedNet))}円`, note: '販管費・営業外費用から営業外収益を差し引いた額' },
        { label: '損益分岐点売上高', value: `${yen(Math.round(bepYear))}円`, note: '固定費 ÷ 限界利益率' },
        { label: '今期の売上ペース', value: `${yen(Math.round(salesYear))}円`, note: `${months}ヶ月の実績を年換算` },
      ],
    },
    link: { label: '損益分岐点のページを開く', to: '/bep' },
  };
}

/** 黒字化に必要な売上。 */
function needSales(state: State, y: FiscalYearData): Answer {
  const c = cvpOf(state, y);
  const li = y.lastFilledIndex;
  const months = li + 1;
  const need = requiredSales(c, 0);
  if (need === null) {
    return { tool: 'needSales', text: '限界利益率が算出できないため、必要売上高を計算できません。' };
  }
  const gap = need - c.sales;
  if (gap <= 0) {
    return {
      tool: 'needSales',
      text: `すでに損益分岐点を超えています。${months}ヶ月の売上 ${yen(c.sales)}円 に対し、`
        + `トントンになる売上は ${yen(Math.round(need))}円 なので、${yen(Math.round(-gap))}円 の余裕があります。`,
      link: { label: '損益分岐点のページを開く', to: '/bep' },
    };
  }
  return {
    tool: 'needSales',
    text: `あと ${yen(Math.round(gap))}円 の売上が必要です。`
      + `${months}ヶ月の売上 ${yen(c.sales)}円 に対し、損益がゼロになる売上は ${yen(Math.round(need))}円 です。`
      + `残りの月数で割ると、月あたり ${yen(Math.round(gap / Math.max(1, 12 - months)))}円 の上乗せが目安になります。`,
    evidence: {
      kind: 'table', title: '計算の内訳',
      rows: [
        { label: `今期の売上（${months}ヶ月）`, value: `${yen(c.sales)}円` },
        { label: '損益がゼロになる売上', value: `${yen(Math.round(need))}円` },
        { label: '不足額', value: `${yen(Math.round(gap))}円` },
        { label: '限界利益率', value: pct1(c.mcRate), note: '売上が1万円増えると利益がいくら増えるか' },
      ],
    },
    link: { label: '必要売上高のページを開く', to: '/bep' },
  };
}

/** 増えている経費（販管費の科目別・前年同期差）。 */
function expenseUp(state: State, y: FiscalYearData): Answer {
  const li = y.lastFilledIndex;
  const prevY = prevYearOf(state, y);
  const take = (arr: number[]) => sum(arr.slice(0, li + 1));
  if (!prevY || prevY.lastFilledIndex < li) {
    return { tool: 'expenseUp', text: '前期の同じ月数の実績が無いため、経費の増減を比較できません。' };
  }
  // 販管費の明細行を科目名で突き合わせる
  const rows = y.rows.filter(r => r.statement === 'PL' && !r.isSubtotal);
  const diffs = rows.map(r => {
    const p = prevY.rows.find(x => x.statement === 'PL' && !x.isSubtotal
      && (x.code === r.code || x.name === r.name));
    const now = take(r.monthly);
    const before = p ? take(p.monthly) : 0;
    return { name: r.name, now, before, diff: now - before };
  }).filter(d => d.diff > 0 && d.now > 0);
  diffs.sort((a, b) => b.diff - a.diff);
  const top = diffs.slice(0, 5);
  if (top.length === 0) {
    return { tool: 'expenseUp', text: '前年同期と比べて増えている費用科目はありませんでした。' };
  }
  return {
    tool: 'expenseUp',
    text: `前年同期と比べて増えているのは、${top[0].name}（＋${yen(top[0].diff)}円）が最大です。`
      + `上位${top.length}科目で合計 ＋${yen(sum(top.map(t => t.diff)))}円 増えています。`,
    evidence: {
      kind: 'table', title: `増えている科目（前年同期比・上位${top.length}）`,
      rows: top.map(t => ({
        label: t.name, value: `＋${yen(t.diff)}円`,
        note: `今期 ${man(t.now)} ／ 前年同期 ${man(t.before)}`,
      })),
    },
    link: { label: '月次推移（損益）で確認する', to: '/pl' },
  };
}

/** 借入はあと何年で返せるか。 */
function debtYears(state: State, y: FiscalYearData): Answer {
  const ds = debtSummary(state, y);
  const total = ds.debtNow + ds.leaseNow;
  if (total <= 0) {
    return { tool: 'debtYears', text: '借入金・社債・リース債務の残高はありません（実質無借金です）。' };
  }
  if (ds.redemptionYears === null) {
    return {
      tool: 'debtYears',
      text: `有利子負債（借入・社債・リース）の残高は ${yen(total)}円 です。`
        + 'ただし直近12ヶ月の返済原資（経常利益＋減価償却費−法人税等）がマイナスのため、'
        + '今の利益水準では返済年数を計算できません。まず利益の改善が必要です。',
      link: { label: 'FCF・借入返済バランスを開く', to: '/debt' },
    };
  }
  return {
    tool: 'debtYears',
    text: `有利子負債の残高 ${yen(total)}円 に対し、今の利益水準なら約 ${ds.redemptionYears.toFixed(1)}年 で返し切れる計算です。`
      + `金融機関が健全とみる目安は10年以内なので、${ds.redemptionYears <= 10 ? '目安の範囲内です' : '目安を超えています'}。`,
    evidence: {
      kind: 'table', title: '計算の内訳',
      rows: [
        { label: '有利子負債', value: `${yen(total)}円`, note: '借入金・社債・リース債務' },
        { label: '返済原資（年）', value: `${yen(Math.round(ds.redemptionSource))}円`, note: '経常利益＋減価償却費−法人税等' },
        { label: '債務償還年数', value: `${ds.redemptionYears.toFixed(1)}年`, note: '有利子負債 ÷ 返済原資（目安10年以内）' },
      ],
    },
    link: { label: 'FCF・借入返済バランスを開く', to: '/debt' },
  };
}

/** 人件費（労働分配率）。 */
function laborShare(_state: State, y: FiscalYearData): Answer {
  const ls = laborShareOf(y);
  if (ls.rate === null) {
    return { tool: 'laborShare', text: '付加価値（売上総利益）がマイナスのため、労働分配率を計算できません。' };
  }
  return {
    tool: 'laborShare',
    text: `人件費は ${yen(ls.personnel)}円 で、稼いだ粗利 ${yen(ls.valueAdded)}円 の ${pct1(ls.rate)} にあたります（労働分配率）。`
      + '業種による差が大きい指標なので、他社と比べるより前年の自社と比べてご覧ください。',
    evidence: {
      kind: 'table', title: '計算の内訳',
      rows: [
        { label: '人件費', value: `${yen(ls.personnel)}円`, note: '役員報酬・給料手当・賞与・法定福利費など' },
        { label: '付加価値（売上総利益）', value: `${yen(ls.valueAdded)}円` },
        { label: '労働分配率', value: pct1(ls.rate), note: '人件費 ÷ 付加価値' },
      ],
    },
  };
}

/**
 * 科目を指定した金額（「交際費はいくら？」）。
 * PL科目は期首からの累計（発生額）、BS科目は月末残高で答える。
 * 同じ意味の科目が複数あるとき（在庫＝商品＋仕掛品）は合計し、内訳も出す。
 */
function accountAmount(state: State, y: FiscalYearData, ctx?: AskContext): Answer {
  const acc = ctx?.account ?? null;
  if (!acc || acc.rows.length === 0) {
    const eg = sampleExpenseNames(y);
    return {
      tool: 'accountAmount',
      text: 'どの科目のことか分かりませんでした。'
        + (eg.length ? `御社の帳簿では ${eg.join('・')} などの科目名でお聞きいただけます。` : ''),
      link: { label: '月次推移（損益）で科目一覧を見る', to: '/pl' },
    };
  }
  const isBs = acc.rows[0].statement === 'BS';
  const li = y.lastFilledIndex;
  // 月の指定があればその月で答える（未確定なら断る）
  let idx = li;
  if (ctx?.month != null) {
    const i = indexOfCalMonth(y, ctx.month);
    if (i === null || i > li) {
      const last = calYm(y, li);
      return {
        tool: 'accountAmount',
        text: `${ctx.month}月の実績はまだ取り込まれていません。`
          + `今期で確定しているのは ${last.year}年${last.month}月 までです。`,
        link: { label: '月次推移（損益）で見る', to: '/pl' },
      };
    }
    idx = i;
  }
  // 期間の指定があれば、その範囲で合計する（BSは期間末の残高）
  const p = clampPeriod(ctx?.period ?? null, y);
  const from = p ? p.from : 0;
  const to = p ? p.to : idx;

  /** PLは範囲合計、BSは範囲末の残高。 */
  const valueOf = (rows: AccountRow[], f: number, t: number): number =>
    (isBs
      ? sum(rows.map(r => r.monthly[t] ?? 0))
      : sum(rows.map(r => sum(r.monthly.slice(f, t + 1)))));

  const now = valueOf(acc.rows, from, to);
  const spanLabel = p ? p.label
    : (ctx?.month != null
      ? `${calYm(y, to).year}年${calYm(y, to).month}月`
      : (isBs ? `${ymLabel(y, to)}末` : `今期${to + 1}ヶ月の累計`));

  // 前年同期（同じ列番号で揃える）
  const back = Math.max(1, ctx?.yearsBack ?? 1);
  const prevY = yearsBackOf(state, y, back);
  const prevRows = prevY
    ? acc.rows.map(r => prevY.rows.find(x => x.code === r.code || x.name === r.name))
      .filter((r): r is AccountRow => !!r)
    : [];
  const comparable = prevY !== null && prevRows.length > 0 && prevY.lastFilledIndex >= to;
  const before = comparable ? valueOf(prevRows, from, to) : 0;
  const diff = now - before;
  const rate = before !== 0 ? diff / Math.abs(before) : null;

  const cmp = comparable
    ? `${back === 1 ? '前年同期' : `${back}期前の同期`}は ${yen(before)}円 だったので、`
      + `${diff >= 0 ? '＋' : '−'}${yen(Math.abs(diff))}円`
      + (rate !== null ? `（${diff >= 0 ? '＋' : '−'}${pct1(Math.abs(rate))}）` : '')
      + `${diff >= 0 ? '増えています' : '減っています'}。`
    : '';

  // 内訳（複数科目をまとめたとき）
  const rows = acc.rows.length > 1
    ? acc.rows.map(r => ({
      label: r.name,
      value: `${yen(valueOf([r], from, to))}円`,
    }))
    : [];

  return {
    tool: 'accountAmount',
    text: `${spanLabel}の${acc.label}は ${yen(now)}円 です。${cmp}`,
    evidence: rows.length
      ? { kind: 'table', title: `${acc.label}の内訳（${spanLabel}）`, rows }
      : {
        kind: 'bars',
        title: `${acc.label}の${isBs ? '月末残高' : '月別の発生額'}`,
        labels: monthLabels(y),
        values: actual(
          Array.from({ length: 12 }, (_, i) => valueOf(acc.rows, isBs ? i : i, i)), y),
        highlight: to,
      },
    link: { label: `月次推移（${isBs ? '貸借' : '損益'}）で見る`, to: isBs ? '/bs' : '/pl' },
  };
}

/** 期間（上半期・第2四半期・4〜6月）の業績。 */
function periodResult(state: State, y: FiscalYearData, ctx?: AskContext): Answer {
  const p = clampPeriod(ctx?.period ?? null, y);
  if (!p) {
    return {
      tool: 'periodResult',
      text: 'どの期間のことか分かりませんでした。'
        + '「上半期」「第2四半期」「4〜6月」のようにお聞きください。',
      link: { label: '月次推移（損益）で見る', to: '/pl' },
    };
  }
  if (p.empty) {
    const last = calYm(y, y.lastFilledIndex);
    return {
      tool: 'periodResult',
      text: `${p.wanted} の実績は、まだ取り込まれていません。`
        + `今期で確定しているのは ${last.year}年${last.month}月 までです。`,
      link: { label: '月次推移（損益）で見る', to: '/pl' },
    };
  }
  const s = yearSeries(y);
  const take = (arr: number[]) => sum(arr.slice(p.from, p.to + 1));
  const sales = take(s.sales);
  const gross = take(s.gross);
  const ord = take(s.ordinary);
  const rate = sales > 0 ? gross / sales : 0;
  const note = p.trimmed
    ? `（${p.wanted}のうち、実績のある ${p.label} で集計しました）`
    : '';

  const prevY = yearsBackOf(state, y, Math.max(1, ctx?.yearsBack ?? 1));
  const prevS = prevY && prevY.lastFilledIndex >= p.to ? yearSeries(prevY) : null;
  const pTake = (arr: number[]) => sum(arr.slice(p.from, p.to + 1));
  const cmp = prevS
    ? `前年の同じ期間は売上 ${man(pTake(prevS.sales))}・経常利益 ${man(pTake(prevS.ordinary))} でした。`
    : '';

  return {
    tool: 'periodResult',
    text: `${p.label}の売上高は ${yen(sales)}円、経常利益は ${yen(ord)}円`
      + `（${ord >= 0 ? '黒字' : '赤字'}）です。粗利率は ${pct1(rate)} でした。${note}${cmp}`,
    evidence: {
      kind: 'table', title: `${p.label}の実績（${p.to - p.from + 1}ヶ月）`,
      rows: [
        { label: '売上高', value: `${yen(sales)}円` },
        { label: '売上総利益（粗利）', value: `${yen(gross)}円`, note: `粗利率 ${pct1(rate)}` },
        { label: '販売費及び一般管理費', value: `${yen(take(s.sga))}円` },
        { label: '営業利益', value: `${yen(take(s.op))}円` },
        { label: '経常利益', value: `${yen(ord)}円` },
      ],
    },
    link: { label: '月次推移（損益）で見る', to: '/pl' },
  };
}

/** 期間の指定を元帳の日付範囲に直す。 */
function ledgerRange(y: FiscalYearData, ctx?: AskContext): { from?: string; to?: string; label: string } {
  const ymd = (i: number, end: boolean) => {
    const m = calYm(y, i);
    if (!end) return `${m.year}-${String(m.month).padStart(2, '0')}-01`;
    const last = new Date(m.year, m.month, 0).getDate();
    return `${m.year}-${String(m.month).padStart(2, '0')}-${last}`;
  };
  const p = clampPeriod(ctx?.period ?? null, y);
  if (p && !p.empty) return { from: ymd(p.from, false), to: ymd(p.to, true), label: p.label };
  if (ctx?.month != null) {
    const i = indexOfCalMonth(y, ctx.month);
    if (i !== null && i <= y.lastFilledIndex) {
      return { from: ymd(i, false), to: ymd(i, true), label: `${calYm(y, i).year}年${ctx.month}月` };
    }
  }
  return { label: '取り込んである元帳の全期間' };
}

/** 元帳が未取込のときの案内。 */
function needLedger(tool: string): Answer {
  return {
    tool,
    text: '取引先ごとの集計は、元帳（総勘定元帳）を取り込むとお答えできるようになります。'
      + '担当者にご相談ください。',
    link: { label: '月次推移（損益）で科目ごとに見る', to: '/pl' },
  };
}

/** ある取引先との取引金額（「〇〇にいくら払った？」）。 */
function partnerTotal(_state: State, y: FiscalYearData, ctx?: AskContext): Answer {
  const led = ctx?.ledger ?? null;
  const kinds = ctx?.kinds;
  if (!led || !kinds) return needLedger('partnerTotal');
  const p = ctx?.partner ?? null;
  if (!p) {
    const eg = led.groups.slice(0, 5).map(g => g.name).join('・');
    return {
      tool: 'partnerTotal',
      text: 'どちらの取引先のことか分かりませんでした。'
        + (eg ? `${eg} などの名前でお聞きいただけます。` : ''),
    };
  }
  const r = ledgerRange(y, ctx);
  const t = partnerTotals(led, kinds, p.id, r);
  if (t.count === 0) {
    return {
      tool: 'partnerTotal',
      text: `${r.label}に ${p.name} との取引は見当たりませんでした。`,
    };
  }
  const parts: string[] = [];
  if (t.expense > 0) parts.push(`お支払い・仕入が ${yen(t.expense)}円`);
  if (t.revenue > 0) parts.push(`売上が ${yen(t.revenue)}円`);
  const variants = p.variants.length > 1
    ? `（摘要では ${p.variants.slice(0, 3).map(v => v.name).join('・')}`
      + `${p.variants.length > 3 ? ' ほか' : ''} と書かれているものをまとめています）`
    : '';
  return {
    tool: 'partnerTotal',
    text: `${r.label}の ${p.name} との取引は、${parts.join('、')} です。${variants}`
      + '（費用と売上の科目に計上された金額です。入出金そのものではありません）',
    evidence: {
      kind: 'table', title: `${p.name}／科目の内訳（${r.label}）`,
      rows: t.byAccount.slice(0, 12).map(b => ({
        label: b.name, value: `${yen(b.amount)}円`, note: `${b.count}件`,
      })),
    },
  };
}

/** ある科目の相手先別ランキング（「修繕費を相手先別に」）。 */
function partnerRanking(_state: State, y: FiscalYearData, ctx?: AskContext): Answer {
  const led = ctx?.ledger ?? null;
  const kinds = ctx?.kinds;
  if (!led || !kinds) return needLedger('partnerRanking');
  const name = ctx?.ledgerAccount ?? ctx?.account?.rows[0]?.name ?? null;
  if (!name) {
    return {
      tool: 'partnerRanking',
      text: 'どの科目の相手先をお調べしますか。'
        + '「修繕費を相手先別に」のように科目名を入れてお聞きください。',
    };
  }
  const r = ledgerRange(y, ctx);
  const out = partnersOfAccount(led, kinds, name, r);
  if (out.rows.length === 0) {
    return {
      tool: 'partnerRanking',
      text: `${r.label}の ${name} には、元帳に明細が見当たりませんでした。`,
    };
  }
  const top = out.rows.slice(0, 10);
  const share = out.total !== 0 ? top[0].amount / out.total : 0;
  return {
    tool: 'partnerRanking',
    text: `${r.label}の ${name} は合計 ${yen(out.total)}円 です。`
      + `いちばん多いのは ${top[0].name}（${yen(top[0].amount)}円`
      + `${share > 0 ? `・全体の${pct1(share)}` : ''}）でした。`,
    evidence: {
      kind: 'table', title: `${name}の相手先別（${r.label}・上位${top.length}先）`,
      rows: top.map(b => ({
        label: b.name, value: `${yen(b.amount)}円`,
        note: `${b.count}件${out.total !== 0 ? ` ・ ${pct1(b.amount / out.total)}` : ''}`,
      })),
    },
    link: { label: '月次推移（損益）で見る', to: '/pl' },
  };
}

// ---------------------------------------------------------------------------
// 質問の一覧と判定
// ---------------------------------------------------------------------------

export const PRESETS: Preset[] = [
  { id: 'monthResult', label: '今月の売上と利益は？', run: monthResult,
    keys: [['今月'], ['単月'], ['先月']] },
  { id: 'vsPrev', label: '前年と比べてどう？', run: vsPrev,
    keys: [['前年'], ['前期'], ['去年'], ['昨年']] },
  { id: 'cashTrend', label: '現金は増えている？', run: cashTrend,
    keys: [['現金'], ['預金'], ['資金'], ['お金']] },
  { id: 'bestSalesMonth', label: '一番売上が高かった月は？', run: bestSalesMonth,
    keys: [['売上', '高かった'], ['売上', '一番'], ['売上', 'ピーク'], ['売上', '最高'], ['売上', '多い月']] },
  { id: 'bep', label: '損益分岐点はいくら？', run: bep,
    keys: [['損益分岐'], ['分岐点'], ['トントン']] },
  { id: 'needSales', label: 'あといくら売れば黒字？', run: needSales,
    keys: [['黒字'], ['必要', '売上'], ['あといくら']] },
  { id: 'expenseUp', label: '増えている経費は？', run: expenseUp,
    keys: [['経費'], ['費用'], ['販管費'], ['コスト']] },
  { id: 'debtYears', label: '借入はあと何年で返せる？', run: debtYears,
    keys: [['借入'], ['借金'], ['返済'], ['融資']] },
  { id: 'laborShare', label: '人件費は多すぎる？', run: laborShare,
    keys: [['人件費'], ['労働分配'], ['給料'], ['人件']] },
  // 以下は定型ボタンには出さない（質問文から科目・期間を読み取ったときだけ使う）
  { id: 'accountAmount', label: '', keys: [], run: accountAmount },
  { id: 'periodResult', label: '', keys: [], run: periodResult },
  { id: 'partnerTotal', label: '', keys: [], run: partnerTotal },
  { id: 'partnerRanking', label: '', keys: [], run: partnerRanking },
];

/** 画面のボタンに出す質問（label が空のものは内部用なので出さない）。 */
export const PRESET_CHIPS: Preset[] = PRESETS.filter(p => p.label !== '');

/**
 * 税務判断・節税の相談は答えない。
 * 顧問先はこの画面を税理士からの案内として見るため、
 * AIや自動応答が税務の結論を出すと誤解と責任の問題になる。
 */
const TAX_WORDS = [
  '経費', '損金', '節税', '税務', '申告', '控除', '償却方法', '課税', '非課税',
  'インボイス', '消費税', '法人税', '所得税', '源泉', '年末調整', '相続', '贈与',
];
/** 「経費」は費用の質問でも使うので、税務判断の言い回しと一緒のときだけ止める */
const TAX_CONTEXT = ['なる', 'なり', 'できる', 'でき', '落と', '認め', 'いい', '良い', 'よい', '可能', 'べき', '対象'];

export function isTaxQuestion(q: string): boolean {
  const hasWord = TAX_WORDS.some(w => q.includes(w));
  if (!hasWord) return false;
  // 「経費」単独＋増減の質問（例: 増えている経費は？）は集計の質問として扱う
  const onlyExpense = q.includes('経費') && !TAX_WORDS.filter(w => w !== '経費').some(w => q.includes(w));
  if (onlyExpense && !TAX_CONTEXT.some(w => q.includes(w))) return false;
  return TAX_CONTEXT.some(w => q.includes(w)) || !onlyExpense;
}

/**
 * 質問文から「◯月」を取り出す（全角数字も可）。無ければ null。
 * 「9ヶ月」「何ヶ月」は月の指定ではないので拾わない（間に『ヶ』が入るため一致しない）。
 */
export function extractMonth(q: string): number | null {
  const m = /([0-9０-９]{1,2})\s*月/.exec(q);
  if (!m) return null;
  const half = m[1].replace(/[０-９]/g, d => String.fromCharCode(d.charCodeAt(0) - 0xFEE0));
  const n = Number(half);
  return n >= 1 && n <= 12 ? n : null;
}

/** 「5月はどうだった？」のように、月＋業績を聞いていると分かる言い回し。 */
const MONTH_RESULT_WORDS = [
  '儲', '利益', '売上', '業績', '実績', '成績', '決算', 'どうだった', 'どうでした', 'どんな',
];

/** 全角数字を半角にする。 */
function toHalf(s: string): string {
  return s.replace(/[０-９]/g, d => String.fromCharCode(d.charCodeAt(0) - 0xFEE0));
}

/** 「第一四半期」の漢数字。全角数字は toHalf で半角に直してから引く。 */
const KANJI_NUM: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4 };

/**
 * 質問文から期間（上半期・第2四半期・4〜6月）を取り出す。
 * 返すのは年度内の列番号（0〜11）。今期に無い月を指していれば null。
 */
export function extractPeriod(q: string, y: FiscalYearData): Period | null {
  const t = toHalf(q.replace(/\s/g, ''));

  // 「4〜6月」「4月から6月」
  const r = /([0-9]{1,2})月?(?:[〜~～\-ー]|から)([0-9]{1,2})月/.exec(t);
  if (r) {
    const a = indexOfCalMonth(y, Number(r[1]));
    const b = indexOfCalMonth(y, Number(r[2]));
    if (a !== null && b !== null && a <= b) {
      return { from: a, to: b, label: `${r[1]}月〜${r[2]}月` };
    }
  }
  // 「第2四半期」「2Q」
  const qm = /第([1-4一二三四])四半期/.exec(t) ?? /([1-4])Q/i.exec(t);
  if (qm) {
    const n = KANJI_NUM[qm[1]] ?? Number(qm[1]);
    if (n >= 1 && n <= 4) {
      return { from: (n - 1) * 3, to: (n - 1) * 3 + 2, label: `第${n}四半期` };
    }
  }
  // 「上半期」「下期」
  if (/上半期|上期|前半/.test(t)) return { from: 0, to: 5, label: '上半期' };
  if (/下半期|下期|後半/.test(t)) return { from: 6, to: 11, label: '下半期' };
  return null;
}

/** 「一昨年」「3期前」など、何期前と比べたいか。既定は1（前期）。 */
export function extractYearsBack(q: string): number {
  const t = toHalf(q.replace(/\s/g, ''));
  if (/一昨年|一昨期|おととし/.test(t)) return 2;
  const m = /([2-9])(?:期前|年前)/.exec(t);
  if (m) return Number(m[1]);
  return 1;
}

/**
 * 質問文からプリセットを探す（見つからなければ null）。
 *
 * 順番に意味がある。
 *   1) 定型ボタンのラベルと完全一致 … ボタンは必ずそのボタンの集計で答える
 *   2) 期間の指定（上半期・4〜6月） … 「上半期の売上は？」を単月と取り違えない
 *   3) 科目名（交際費・家賃） … 「交際費は前年と比べて？」を会社全体の比較にしない
 *   4) キーワード
 *   5) 月＋業績
 */
/** 「相手先別」「取引先ごと」のように、内訳を聞いていると分かる言い回し。 */
const RANKING_WORDS = /相手先|取引先|支払先|得意先|仕入先|業者別|先別|別に|ランキング|内訳|誰に|どこに/;
/** 「〇〇に払った」のように取引先との金額を聞いていると分かる言い回し。 */
const PARTNER_WORDS = /払っ|支払|払った|いくら|合計|取引|買っ|発注|仕入れ/;

export function matchPreset(q: string, y?: FiscalYearData, ledger?: Ledger | null): Preset | null {
  const t = q.replace(/\s/g, '');
  const find = (id: string) => PRESETS.find(p => p.id === id) ?? null;

  for (const p of PRESETS) {
    if (p.label !== '' && p.label.replace(/\s/g, '') === t) return p;
  }
  if (y) {
    const acc = findAccounts(y, t);
    const period = extractPeriod(t, y);
    // 元帳が取り込まれているときだけ、取引先の質問に答えられる
    if (ledger) {
      const ranking = RANKING_WORDS.test(t);
      const partner = findPartner(ledger, t);
      // 「修繕費を相手先別に」… 科目が分かっていて、内訳を聞いている
      if (ranking && (acc || findLedgerAccount(ledger, t))) return find('partnerRanking');
      // 「〇〇商事にいくら払った？」… 取引先が分かっている
      if (partner && (PARTNER_WORDS.test(t) || !acc)) return find('partnerTotal');
      if (ranking) return find('partnerRanking');
    }
    // 科目の指定があれば科目を優先（「上半期の交際費」は科目＋期間で答える）
    if (acc) return find('accountAmount');
    if (period) return find('periodResult');
  }
  for (const p of PRESETS) {
    for (const group of p.keys) {
      if (group.length && group.every(k => t.includes(k))) return p;
    }
  }
  // 「5月はどのくらい儲かった？」のように月を指した業績の質問は、その月の実績として扱う
  if (extractMonth(t) !== null && MONTH_RESULT_WORDS.some(w => t.includes(w))) {
    return find('monthResult');
  }
  // 科目らしい言葉（〜費・〜料・〜手当・〜報酬）なのに帳簿に無いとき。
  // 「読み取れませんでした」で終わらせず、実際にある科目名を案内する。
  if (y && /.{1,6}(費|料|手当|報酬)/.test(t)) return find('accountAmount');
  // 取引先を聞いているのに元帳が未取込のとき。
  // 「読み取れませんでした」ではなく「元帳を取り込めば答えられる」と伝える。
  // ※ ここは広げすぎない。「銀行への支払いはいつまで続くか」のような、
  //    別の集計（借入の返済年数）で答えるべき質問を横取りしないこと。
  if (RANKING_WORDS.test(t)
    || /に(いくら|何円)[^。]{0,8}(払|支払)/.test(t)
    || /との取引/.test(t)) {
    return find('partnerTotal');
  }
  return null;
}

/** 質問文から読み取れる条件をまとめる。 */
export function readContext(
  q: string, y: FiscalYearData,
  ledger?: Ledger | null, kinds?: Map<string, AccountKind>,
): AskContext {
  const t = q.replace(/\s/g, '');
  const period = extractPeriod(t, y);
  return {
    // 期間の指定があるときは、その中の数字を単月と取り違えない
    month: period ? null : extractMonth(t),
    period,
    yearsBack: extractYearsBack(t),
    account: findAccounts(y, t),
    ledger: ledger ?? null,
    kinds,
    partner: ledger ? findPartner(ledger, t) : null,
    ledgerAccount: ledger ? findLedgerAccount(ledger, t) : null,
  };
}

/** 表示できる年度（最新＝進行期）を返す。 */
export function latestYear(state: State): FiscalYearData | null {
  const ys = sortedYears(state);
  return ys.length ? ys[ys.length - 1] : null;
}
