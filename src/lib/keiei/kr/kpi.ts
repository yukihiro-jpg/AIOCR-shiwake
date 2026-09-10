// 主要指標（ダッシュボードの表・Excelの「主要指標」シートで共有する）。
//
// 画面とExcelで数字や判定が食い違わないよう、指標の組み立てはここに一本化する。
// 生の数値（value/prev）と、画面に出す文字列（valueText など）の両方を返す。

import type { FiscalYearData, State } from './types';
import {
  yearSeries, prevYearOf, debtSummary, laborShareOf, ymLabel,
} from './analysis';
import type { YearSeries } from './analysis';

/** 指標1件。単位ごとに数値と表示文字列を持つ。 */
export interface KpiMetric {
  key: string;
  label: string;
  /** 'yen' は円、'pct' は率（0..1）*/
  unit: 'yen' | 'pct';
  value: number | null;
  prev: number | null;
  /** 増減の表示（率なら pt、金額なら円 or %） */
  deltaText: string | null;
  /** 増減が良い方向か */
  tone: 'good' | 'bad' | 'neutral';
  note: string;
  /** 「？」ボタンで開く、この指標の意味の説明（顧問先向けのやさしい言葉で） */
  help: string;
}

const sum = (a: number[]): number => a.reduce((x, y) => x + y, 0);

const yenShortOf = (n: number) => `${Math.round(n / 10000).toLocaleString('ja-JP')}万円`;
const signedYenShortOf = (n: number) => `${n >= 0 ? '+' : ''}${yenShortOf(n)}`;
const signedPctOf = (r: number) => `${r >= 0 ? '+' : ''}${(r * 100).toFixed(1)}%`;
const signedPtOf = (d: number) => `${d >= 0 ? '+' : ''}${d.toFixed(1)}pt`;

/**
 * 指定年度の主要指標。
 * 前期は「同じ月数（前年同期）」で比べる。前期の実績が足りない場合は比較を出さない。
 */
export function kpiMetrics(state: State, y: FiscalYearData): KpiMetric[] {
  const s = yearSeries(y);
  const li = y.lastFilledIndex;
  const prevY = prevYearOf(state, y);
  const prevS = prevY ? yearSeries(prevY) : null;
  const prevOk = !!prevS && !!prevY && prevY.lastFilledIndex >= li;
  const take = (arr: number[]) => sum(arr.slice(0, li + 1));
  const ds = debtSummary(state, y);
  const ls = laborShareOf(y);
  const prevLs = prevY ? laborShareOf(prevY) : null;

  const yenShort = yenShortOf;
  const signedYenShort = signedYenShortOf;
  const signedPct = signedPctOf;
  const signedPt = signedPtOf;

  const salesYtd = take(s.sales);
  const prevSalesYtd = prevOk ? take(prevS!.sales) : null;
  const grossYtd = take(s.gross);
  const grossRate = salesYtd > 0 ? grossYtd / salesYtd : 0;
  const prevGrossRate = prevOk && take(prevS!.sales) > 0 ? take(prevS!.gross) / take(prevS!.sales) : null;
  const ordYtd = take(s.ordinary);
  const prevOrdYtd = prevOk ? take(prevS!.ordinary) : null;
  const debtNow = ds.debtNow + ds.leaseNow;
  const prevCash = prevOk ? prevS!.cash[li] : null;
  const prevDebt = prevOk ? prevS!.debt[li] + prevS!.lease[li] : null;

  return [
    {
      key: 'sales',
      label: `売上高（累計${li + 1}ヶ月）`,
      unit: 'yen', value: salesYtd, prev: prevSalesYtd,
      deltaText: prevSalesYtd && prevSalesYtd > 0 ? signedPct(salesYtd / prevSalesYtd - 1) : null,
      tone: prevSalesYtd && prevSalesYtd > 0 ? (salesYtd >= prevSalesYtd ? 'good' : 'bad') : 'neutral',
      note: `月平均 ${yenShort(salesYtd / (li + 1))}`,
      help: '事業年度の始まりから報告月までに積み上がった売上高の合計です。前年の同じ月数と比べているので、'
        + '「今年はここまでで去年より多いか少ないか」がそのまま分かります。'
        + '季節による波がある会社は、単月ではなくこの累計で見ると実力が分かります。',
    },
    {
      key: 'grossRate',
      label: '粗利率（累計）',
      unit: 'pct', value: grossRate, prev: prevGrossRate,
      deltaText: prevGrossRate !== null ? signedPt((grossRate - prevGrossRate) * 100) : null,
      tone: prevGrossRate !== null ? (grossRate >= prevGrossRate ? 'good' : 'bad') : 'neutral',
      note: `売上総利益 ${yenShort(grossYtd)}`,
      help: '売上のうち、仕入や外注などの原価を引いたあとに手元に残る割合です。'
        + '（売上高−売上原価）÷ 売上高 で計算します。この粗利で人件費や家賃などの固定費をまかない、'
        + '残りが利益になります。率が下がったときは、値引き・仕入単価の上昇・原価率の高い仕事が増えた、'
        + 'のいずれかが原因であることが多いです。',
    },
    {
      key: 'ordinary',
      label: '経常利益（累計）',
      unit: 'yen', value: ordYtd, prev: prevOrdYtd,
      deltaText: prevOrdYtd !== null ? signedYenShort(ordYtd - prevOrdYtd) : null,
      tone: prevOrdYtd !== null ? (ordYtd >= prevOrdYtd ? 'good' : 'bad') : 'neutral',
      note: ordYtd >= 0 ? '黒字' : '赤字（売上・粗利率・固定費を月次推移で確認）',
      help: '本業の利益（営業利益）に、受取利息などの営業外収益を足し、支払利息などの営業外費用を引いた利益です。'
        + '一時的な特別損益を含まないため、会社の毎年の実力を表す利益として、金融機関も最も重視します。'
        + '税金の計算や借入の返済原資も、この経常利益がもとになります。',
    },
    {
      key: 'cash',
      label: '現預金残高',
      unit: 'yen', value: ds.cashNow, prev: prevCash,
      deltaText: prevCash !== null ? signedYenShort(ds.cashNow - prevCash) : null,
      tone: prevCash !== null ? (ds.cashNow >= prevCash ? 'good' : 'bad') : 'neutral',
      note: ds.liquidityMonths !== null
        ? `平均月商の ${ds.liquidityMonths.toFixed(1)}ヶ月分（${ds.liquidityMonths >= 3 ? '安全圏' : ds.liquidityMonths >= 1.5 ? 'やや注意' : '要注意'}／目安3ヶ月分）`
        : '',
      help: '報告月末に会社が持っている現金と預金の残高です。利益が出ていても入金が先の売掛金が多い、'
        + '借入の返済や設備投資が多い、といった理由で残高は減ることがあります。'
        + '平均月商（1ヶ月あたりの売上）の何ヶ月分あるかを目安にし、3ヶ月分あれば急な入金遅れにも対応できます。',
    },
    {
      key: 'debt',
      label: '有利子負債（借入・社債・リース）',
      unit: 'yen', value: debtNow, prev: prevDebt,
      deltaText: prevDebt !== null ? signedYenShort(debtNow - prevDebt) : null,
      // 借入は減る方が良い
      tone: prevDebt !== null ? (debtNow <= prevDebt ? 'good' : 'bad') : 'neutral',
      note: ds.redemptionYears !== null
        ? `債務償還年数 ${ds.redemptionYears.toFixed(1)}年（目安10年以内）`
        : '償還原資（経常利益＋減価償却−法人税等）がマイナス',
      help: '銀行借入・社債・リース債務の合計、つまり利息を払って調達しているお金の残高です。'
        + '「債務償還年数」は、いまの利益水準であと何年で返し切れるかを表し、'
        + '10年以内が金融機関の見る健全ラインです。これを超えると新しい融資は通りにくくなります。',
    },
    {
      key: 'labor',
      label: '労働分配率（累計）',
      unit: 'pct', value: ls.rate, prev: prevLs?.rate ?? null,
      deltaText: ls.rate !== null && prevLs?.rate != null ? signedPt((ls.rate - prevLs.rate) * 100) : null,
      // 分配率は下がる方が利益は残る
      tone: ls.rate !== null && prevLs?.rate != null ? (ls.rate <= prevLs.rate ? 'good' : 'bad') : 'neutral',
      note: `人件費 ${yenShort(ls.personnel)} ÷ 付加価値 ${yenShort(ls.valueAdded)}`,
      help: '稼いだ粗利（付加価値）のうち、何割を給料・賞与・役員報酬・法定福利費などの人件費に充てたかを表します。'
        + '高すぎると利益が残りませんが、低すぎても人が定着しません。'
        + '業種による差が大きいので、他社の数字よりも自社の前年との比較で見るのが実用的です。',
    },
  ];
}

/**
 * 報告月（その年度の最終実績月）の「単月」の指標。
 * 累計だけでは見えない当月の動きを見るための表。前期の同じ月と比べる。
 */
export function monthKpiMetrics(state: State, y: FiscalYearData): KpiMetric[] {
  const s = yearSeries(y);
  const li = y.lastFilledIndex;
  const prevY = prevYearOf(state, y);
  const prevS = prevY ? yearSeries(prevY) : null;
  // 前期の同じ月の実績が無ければ比較しない
  const prevOk = !!prevS && !!prevY && prevY.lastFilledIndex >= li;
  /** 前年同月の値（比較できないときは null） */
  const pv = (sel: (x: YearSeries) => number[]): number | null =>
    (prevOk ? sel(prevS!)[li] : null);
  // 前月（年度の初月は前月が無い）
  const hasLast = li > 0;

  const deltaYen = (now: number, prev: number | null) =>
    prev === null ? null : signedYenShortOf(now - prev);
  const cmp = (now: number, prev: number | null, higherIsBetter = true): KpiMetric['tone'] => {
    if (prev === null) return 'neutral';
    return (higherIsBetter ? now >= prev : now <= prev) ? 'good' : 'bad';
  };
  const vsLast = (arr: number[]) =>
    hasLast ? `前月 ${yenShortOf(arr[li - 1])}` : '前月の実績なし';

  const sales = s.sales[li];
  const prevSales = pv(x => x.sales);
  const gross = s.gross[li];
  const rate = sales > 0 ? gross / sales : 0;
  const prevRate = prevOk && prevS!.sales[li] > 0 ? prevS!.gross[li] / prevS!.sales[li] : null;
  const sga = s.sga[li];
  const op = s.op[li];
  const ord = s.ordinary[li];
  const dCash = hasLast ? s.cash[li] - s.cash[li - 1] : 0;
  const prevDCash = prevOk && li > 0 ? prevS!.cash[li] - prevS!.cash[li - 1] : null;

  return [
    {
      key: 'mSales', label: '売上高（単月）', unit: 'yen',
      value: sales, prev: prevSales,
      deltaText: prevSales !== null && prevSales > 0 ? signedPctOf(sales / prevSales - 1) : deltaYen(sales, prevSales),
      tone: cmp(sales, prevSales), note: vsLast(s.sales),
      help: '報告月の1ヶ月だけの売上高です。累計では平準化されて見えない「その月の勢い」が分かります。'
        + '前年の同じ月と比べているので、季節による繁閑の影響を受けずに増減を判断できます。',
    },
    {
      key: 'mGrossRate', label: '粗利率（単月）', unit: 'pct',
      value: rate, prev: prevRate,
      deltaText: prevRate !== null ? signedPtOf((rate - prevRate) * 100) : null,
      tone: cmp(rate, prevRate), note: `売上総利益 ${yenShortOf(gross)}`,
      help: 'その月だけの粗利率です。単月は棚卸や仕入の計上時期によって大きく振れることがあるため、'
        + '1ヶ月の数字だけで判断せず、上の累計の粗利率とあわせて見てください。',
    },
    {
      key: 'mSga', label: '販売費及び一般管理費（単月）', unit: 'yen',
      value: sga, prev: pv(x => x.sga),
      deltaText: deltaYen(sga, pv(x => x.sga)),
      // 経費は少ない方が良い
      tone: cmp(sga, pv(x => x.sga), false),
      note: vsLast(s.sga),
      help: '人件費・家賃・水道光熱費・広告費など、売上原価以外の経費のその月の合計です。'
        + '毎月ほぼ一定なのが普通なので、前月・前年同月から大きく動いた月は、賞与・保険・修繕など'
        + '一時的な支出が入っていないかを月次推移（損益）で確認してください。',
    },
    {
      key: 'mOp', label: '営業利益（単月）', unit: 'yen',
      value: op, prev: pv(x => x.op),
      deltaText: deltaYen(op, pv(x => x.op)),
      tone: cmp(op, pv(x => x.op)),
      note: vsLast(s.op),
      help: '売上総利益から販売費及び一般管理費を引いた、本業だけで稼いだ利益です。'
        + '利息や補助金など本業以外の要素を含まないため、事業そのものが儲かっているかがはっきり分かります。',
    },
    {
      key: 'mOrdinary', label: '経常利益（単月）', unit: 'yen',
      value: ord, prev: pv(x => x.ordinary),
      deltaText: deltaYen(ord, pv(x => x.ordinary)),
      tone: cmp(ord, pv(x => x.ordinary)),
      note: ord >= 0 ? '当月は黒字' : '当月は赤字',
      help: '営業利益に受取利息などを足し、支払利息などを引いた、その月の最終的な実力利益です。'
        + '毎月の黒字・赤字はこの数字で判断します。',
    },
    {
      key: 'mCash', label: '現預金の増減（単月）', unit: 'yen',
      value: hasLast ? dCash : null, prev: prevDCash,
      deltaText: hasLast ? deltaYen(dCash, prevDCash) : null,
      tone: hasLast ? cmp(dCash, prevDCash) : 'neutral',
      note: hasLast
        ? `月末残高 ${yenShortOf(s.cash[li])}（前月末 ${yenShortOf(s.cash[li - 1])}）`
        : `月末残高 ${yenShortOf(s.cash[li])}`,
      help: 'その月に現金・預金が増えたか減ったかです。利益が黒字でも、売掛金の回収が遅い月、'
        + '仕入や納税・借入返済が重なった月はマイナスになります。'
        + '「なぜ減ったのか」はCF計算書のページで営業・投資・財務のどこが原因かを確認できます。',
    },
  ];
}

/**
 * 業績サマリー（顧問先モードのダッシュボード）。
 * 損益計算書の並び順そのままに、売上高から税引前当期利益までを縦に並べ、
 * 最後に現金預金残高を置く。前年同期（同じ月数）と比べる。
 */
export function plSummaryMetrics(state: State, y: FiscalYearData): KpiMetric[] {
  const s = yearSeries(y);
  const li = y.lastFilledIndex;
  const prevY = prevYearOf(state, y);
  const prevS = prevY ? yearSeries(prevY) : null;
  // 前期の同じ月数まで実績が揃っているときだけ比較する
  const prevOk = !!prevS && !!prevY && prevY.lastFilledIndex >= li;
  const take = (arr: number[]) => sum(arr.slice(0, li + 1));
  /** 前年同期の値（比較できないときは null） */
  const pv = (sel: (x: YearSeries) => number[]): number | null =>
    (prevOk ? sum(sel(prevS!).slice(0, li + 1)) : null);

  const sales = take(s.sales);
  const cogs = take(s.cogs);
  const gross = take(s.gross);
  const grossRate = sales > 0 ? gross / sales : 0;
  const sga = take(s.sga);
  const op = take(s.op);
  // 営業外損益 ＝ 営業外収益 − 営業外費用
  const nonOp = take(s.nonOpInc) - take(s.nonOpExp);
  const ordinary = take(s.ordinary);
  // 特別損益 ＝ 税引前当期純利益 − 経常利益（特別利益−特別損失に一致する）
  const pretax = take(s.pretax);
  const special = pretax - ordinary;
  const cash = s.cash[li];

  const prevSales = pv(x => x.sales);
  const prevGross = pv(x => x.gross);
  const prevGrossRate = prevOk && prevSales && prevSales > 0 && prevGross !== null
    ? prevGross / prevSales : null;
  const prevOrdinary = pv(x => x.ordinary);
  const prevPretax = pv(x => x.pretax);
  const prevNonOp = prevOk ? sum(prevS!.nonOpInc.slice(0, li + 1)) - sum(prevS!.nonOpExp.slice(0, li + 1)) : null;
  const prevSpecial = prevPretax !== null && prevOrdinary !== null ? prevPretax - prevOrdinary : null;
  const prevCash = prevOk ? prevS!.cash[li] : null;

  /** 金額の指標1件を組み立てる（増減は金額差、良し悪しは higher で決める） */
  const yenRow = (
    key: string, label: string, value: number, prev: number | null,
    higherIsBetter: boolean, note: string, help: string,
  ): KpiMetric => ({
    key, label, unit: 'yen', value, prev,
    deltaText: prev === null ? null : signedYenShortOf(value - prev),
    tone: prev === null ? 'neutral'
      : (higherIsBetter ? value >= prev : value <= prev) ? 'good' : 'bad',
    note, help,
  });

  return [
    yenRow('sales', '売上高', sales, prevSales, true,
      `月平均 ${yenShortOf(sales / (li + 1))}`,
      '本業で得た収益の合計です。値引や返品を差し引いた「純売上高」で集計しています。'
      + '事業年度の始まりから報告月までの累計です。'),
    yenRow('cogs', '売上原価', cogs, pv(x => x.cogs), false,
      sales > 0 ? `売上に対する比率 ${((cogs / sales) * 100).toFixed(1)}%` : '',
      '売上を上げるために直接かかった費用です。仕入・外注費のほか、期首と期末の棚卸で調整した金額が入ります。'
      + '売上と連動して増減するのが普通で、増え方が売上より大きいときは原価率の悪化を意味します。'),
    yenRow('gross', '売上総利益（粗利）', gross, prevGross, true,
      `売上高 − 売上原価`,
      '売上から売上原価を引いた利益で、「粗利」とも呼びます。'
      + 'この粗利で人件費や家賃などの経費をまかない、残りが会社の利益になります。'
      + '会社が生み出した価値そのものを表す数字です。'),
    {
      key: 'grossRate', label: '売上総利益率（粗利率）', unit: 'pct',
      value: grossRate, prev: prevGrossRate,
      deltaText: prevGrossRate === null ? null : signedPtOf((grossRate - prevGrossRate) * 100),
      tone: prevGrossRate === null ? 'neutral' : (grossRate >= prevGrossRate ? 'good' : 'bad'),
      note: `売上総利益 ${yenShortOf(gross)} ÷ 売上高 ${yenShortOf(sales)}`,
      help: '売上のうち、原価を引いたあとに手元に残る割合です。'
        + '率が下がったときは、値引き・仕入単価の上昇・原価率の高い仕事が増えた、のいずれかが原因であることが多く、'
        + '同じ売上でも利益が減ります。',
    },
    yenRow('sga', '販売費及び一般管理費', sga, pv(x => x.sga), false,
      `売上高比 ${sales > 0 ? ((sga / sales) * 100).toFixed(1) : '—'}%`,
      '人件費・家賃・水道光熱費・広告費など、売上原価以外の経費の合計です。'
      + '毎月ほぼ一定なのが普通なので、大きく動いた月は賞与・保険・修繕など一時的な支出が入っていないか確認します。'),
    yenRow('op', '営業利益', op, pv(x => x.op), true,
      op >= 0 ? '本業は黒字' : '本業が赤字',
      '売上総利益から販売費及び一般管理費を引いた、本業だけで稼いだ利益です。'
      + '利息や補助金など本業以外の要素を含まないため、事業そのものが儲かっているかがはっきり分かります。'),
    yenRow('nonOp', '営業外損益', nonOp, prevNonOp, true,
      `営業外収益 ${yenShortOf(take(s.nonOpInc))} − 営業外費用 ${yenShortOf(take(s.nonOpExp))}`,
      '本業以外で毎期発生する損益です。受取利息・受取家賃・補助金などの収益から、'
      + '支払利息などの費用を差し引いた金額を表示しています。プラスなら本業以外で収入が上回っている状態です。'),
    yenRow('ordinary', '経常利益', ordinary, prevOrdinary, true,
      ordinary >= 0 ? '黒字' : '赤字',
      '営業利益に営業外損益を加えた、会社の毎年の実力を表す利益です。'
      + '一時的な特別損益を含まないため、金融機関がもっとも重視します。'
      + '税金の計算や借入の返済原資も、この経常利益がもとになります。'),
    yenRow('special', '特別損益', special, prevSpecial, true,
      `特別利益 − 特別損失`,
      'その期にだけ起きた臨時の損益です。固定資産の売却損益や、保険金の受取などが入ります。'
      + '毎期は発生しないため、会社の実力を見るときはこれを除いた経常利益で判断します。'),
    yenRow('pretax', '税引前当期利益', pretax, prevPretax, true,
      `経常利益 ${yenShortOf(ordinary)} ＋ 特別損益 ${yenShortOf(special)}`,
      '経常利益に特別損益を加えた、税金を計算する前の利益です。'
      + 'ここから法人税等を差し引いたものが最終的な当期純利益になります。'),
    yenRow('cash', '現金預金残高', cash, prevCash, true,
      `${ymLabel(y, li)}末の残高`,
      '報告月末に会社が持っている現金と預金の残高です。'
      + '利益が出ていても、入金が先の売掛金が多い月や、仕入・納税・借入返済が重なった月は減ることがあります。'
      + '利益とお金の動きは一致しません。'),
  ];
}
