'use client'

import { getState } from '@/lib/keiei/kr/api';
import {
  sortedYears, prevYearOf, debtSummary, timeline, ymLabel, yen, PAT,
} from '@/lib/keiei/kr/analysis';
import type { AccountRow } from '@/lib/keiei/kr/types';
import {
  C, KpiTable, LineChart, Meter, NeedData, YearNav, useYearSelection, fmtShort, fmtYen,
} from '../ui';

/**
 * FCF・借入返済バランス:
 * フリーキャッシュフロー（営業CF＋投資CF）と借入の約定返済が釣り合っているか、
 * 債務償還年数・手元流動性・インタレスト・カバレッジで借入の健全性を
 * 金融機関目線で確認するページ。計算はすべて analysis.ts の debtSummary に任せる。
 */
export default function Debt() {
  const state = getState();
  const years = sortedYears(state);
  const [yearId, setYearId] = useYearSelection(years);
  if (!years.length) return (
    <div>
      <h2 className="page-title">FCF・借入返済バランス</h2>
      <NeedData />
    </div>
  );

  const y = years.find(x => x.id === yearId) ?? years[years.length - 1];
  const li = y.lastFilledIndex;
  const ds = debtSummary(state, y);
  /** 倍率・年数の表示（マイナス記号は金額表示（−）と揃える） */
  const num = (v: number, digits: number) => v.toFixed(digits).replace('-', '−');

  // 期首残高: 前期が12ヶ月そろっていれば前期末、無ければ当期第1月の残高で代用
  const prevY = prevYearOf(state, y);
  const prevFull = prevY && prevY.lastFilledIndex === 11 ? prevY : null;
  const openingOf = (r: AccountRow): number => {
    if (prevFull) {
      const p = prevFull.rows.find(x => x.statement === 'BS' && !x.isSubtotal
        && (x.code === r.code || x.name === r.name));
      return p ? p.monthly[11] : 0; // 前期に無い科目は当期の新規調達（期首0）
    }
    return r.monthly[0];
  };

  // 借入系の明細行（借入金・社債・役員借入金・リース債務。小計は除く）
  const debtRows = y.rows.filter(r => r.statement === 'BS' && !r.isSubtotal
    && (PAT.debt.test(r.name) || PAT.lease.test(r.name)));
  const tableRows = debtRows
    .map(r => ({ r, open: openingOf(r), now: r.monthly[li] }))
    .filter(x => x.open !== 0 || x.now !== 0);
  const totalOpen = tableRows.reduce((a, x) => a + x.open, 0);
  const totalNow = tableRows.reduce((a, x) => a + x.now, 0);

  // 増減の表示（減少＝返済が進んだ→青 / 増加＝新規調達→赤）
  const diffCell = (d: number) => (
    <td className={`num ${d > 0 ? 'neg' : d < 0 ? 'pos' : ''}`}>
      {d === 0 ? '±0' : `${d > 0 ? '+' : '−'}${yen(Math.abs(d))}`}
    </td>
  );

  // 全期間タイムライン（現預金 vs 有利子負債）
  const tl = timeline(state);

  const debtTotalNow = ds.debtNow + ds.leaseNow;
  const noDebt = debtTotalNow <= 0;

  // 債務償還年数の判定バッジ
  const redemptionBadge = noDebt
    ? <span className="badge good">無借金</span>
    : ds.redemptionYears === null
      ? <span className="badge bad">計算不能（償還原資マイナス）</span>
      : ds.redemptionYears <= 10
        ? <span className="badge good">良好（10年以内）</span>
        : ds.redemptionYears <= 15
          ? <span className="badge warn">注意（10年超）</span>
          : <span className="badge bad">要改善（15年超）</span>;

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-title">FCF・借入返済バランス</h2>
          <p className="page-sub">
            {y.label}・{li + 1}ヶ月分の実績で集計しています。
            事業が生み出した自由に使えるお金（FCF＝営業CF＋投資CF）で借入の約定返済が
            賄えているか、借入残高が利益に対して重すぎないかを確認します。
            {!prevFull && ' ※前期データが無いため、CF・返済額の集計は第2月からです（期首残高が不明なため）。'}
          </p>
        </div>
        <YearNav years={years} current={y.id} onChange={setYearId} />
      </div>

      <KpiTable currentLabel={`${y.label}（${ds.months}ヶ月）`} rows={[
        {
          label: `FCF（累計 ${ds.months}ヶ月）`,
          value: ds.months > 0 ? `${fmtShort(ds.fcf)}円` : '—',
          delta: ds.months > 0 ? (ds.fcf >= 0 ? 'プラス' : 'マイナス') : undefined,
          tone: ds.months > 0 ? (ds.fcf >= 0 ? 'good' : 'bad') : undefined,
          note: ds.months > 0
            ? `営業CF（${fmtShort(ds.opCf)}円） ＋ 投資CF（${fmtShort(ds.invCf)}円）`
            : '集計できる月がありません',
          help: 'FCF（フリーキャッシュフロー）は、本業で稼いだお金（営業CF）から、設備などへの投資で'
            + '出ていったお金（投資CF）を差し引いて、会社が自由に使えるお金がいくら残ったかを表します。'
            + 'この残りで借入を返したり、次の投資や配当に回したりします。'
            + 'プラスなら事業が自力でお金を生んでいる状態、マイナスなら手元資金か新しい借入で'
            + '不足を埋めている状態です。',
        },
        {
          label: `約定返済額（累計 ${ds.months}ヶ月）`,
          value: ds.months > 0 ? `${fmtShort(ds.repay)}円` : '—',
          note: ds.months > 0
            ? `月平均 ${fmtShort(ds.repayMonthly)}円 ／ 新規調達 ${fmtShort(ds.borrow)}円`
            : '',
          help: '金融機関との契約どおりに返した借入の元金の合計です（利息は経費なので含みません）。'
            + '手形の書換・折返しで残高が上下する短期借入金は、実際の返済ではないため集計から除いています。'
            + '「新規調達」は同じ期間に新しく借り入れた金額です。',
        },
        {
          label: '返済カバー率',
          value: ds.coverage !== null ? `${num(ds.coverage, 2)}倍` : '—',
          delta: ds.coverage !== null ? (ds.coverage >= 1 ? '健全' : '返済が先行') : undefined,
          tone: ds.coverage !== null ? (ds.coverage >= 1 ? 'good' : 'bad') : undefined,
          note: 'FCF ÷ 約定返済額（1倍以上が目安）',
          help: '稼いだお金（FCF）で、その期間の元金返済を何倍まかなえたかです。'
            + '1倍以上なら事業が生んだお金の範囲で返済できており、借入は自然に減っていきます。'
            + '1倍を下回る状態が続くと、現預金を取り崩すか借換えが必要になるため、'
            + '利益の改善か返済条件の見直しを検討する合図になります。',
        },
        {
          label: '債務償還年数',
          value: ds.redemptionYears !== null ? `${num(ds.redemptionYears, 1)}年` : noDebt ? '0年' : '—',
          delta: ds.redemptionYears !== null ? (ds.redemptionYears <= 10 ? '目安内' : '目安超過') : undefined,
          tone: ds.redemptionYears !== null ? (ds.redemptionYears <= 10 ? 'good' : 'bad') : undefined,
          note: ds.redemptionYearsNet !== null
            ? `有利子負債 ÷ 償還原資。実質 ${num(ds.redemptionYearsNet, 1)}年（現預金控除後）／目安10年以内`
            : noDebt ? '有利子負債はありません' : '償還原資（経常利益＋減価償却−法人税等）がマイナスです',
          help: 'いまの利益水準のまま返し続けたとき、借入をあと何年で返し切れるかを表します。'
            + '有利子負債（借入・社債・リース）÷ 償還原資（経常利益＋減価償却費−法人税等）で計算します。'
            + '減価償却費はお金が出ていかない費用なので足し戻し、税金は必ず出ていくので引きます。'
            + '金融機関は10年以内を健全とみており、融資審査でもっとも重視する指標のひとつです。',
        },
        {
          label: '手元流動性',
          value: ds.liquidityMonths !== null ? `${num(ds.liquidityMonths, 1)}ヶ月分` : '—',
          delta: ds.liquidityMonths !== null
            ? (ds.liquidityMonths >= 3 ? '安全圏' : ds.liquidityMonths >= 1.5 ? 'やや注意' : '要注意') : undefined,
          tone: ds.liquidityMonths !== null ? (ds.liquidityMonths >= 3 ? 'good' : 'bad') : undefined,
          note: `現預金 ${fmtShort(ds.cashNow)}円 ÷ 平均月商（目安3ヶ月分）`,
          help: '手元の現預金が、1ヶ月あたりの売上（平均月商）の何ヶ月分あるかを表します。'
            + '売上が急に止まっても何ヶ月持ちこたえられるか、という体力の指標です。'
            + '3ヶ月分あれば入金の遅れや設備の故障にも慌てず対応でき、'
            + '1.5ヶ月分を下回ると資金繰りに余裕がない状態です。',
        },
        {
          label: 'インタレスト・カバレッジ',
          value: ds.interestCoverage !== null ? `${num(ds.interestCoverage, 1)}倍` : '—',
          delta: ds.interestCoverage !== null ? (ds.interestCoverage >= 2 ? '余裕あり' : '要注意') : undefined,
          tone: ds.interestCoverage !== null ? (ds.interestCoverage >= 2 ? 'good' : 'bad') : undefined,
          note: '（営業利益＋受取利息）÷ 支払利息（直近12ヶ月）',
          help: '本業の利益で、借入の利息を何倍まかなえているかを表します。'
            + '（営業利益＋受取利息）÷ 支払利息 で計算し、2倍以上あれば利息の負担は重くありません。'
            + '1倍を下回ると、稼ぎで利息すら払えていない状態を意味します。',
        },
      ]} />

      <div className="row">
        <div className="card">
          <h3>返済カバー率<small>FCF で約定返済をどれだけ賄えているか</small></h3>
          <Meter ratio={ds.coverage} good={1} warn={0.5}
            text={ds.coverage !== null
              ? `カバー率 ${num(ds.coverage, 2)}倍（FCF ${fmtShort(ds.fcf)}円 ÷ 約定返済 ${fmtShort(ds.repay)}円）`
              : '期間中の約定返済が無いため計算できません'} />
          {ds.coverage !== null && (ds.coverage >= 1
            ? <div className="ok-box">事業が生み出した現金の範囲内で返済が回っています。借入に頼らず返済できている健全な状態です。</div>
            : <div className="warn-box">FCF が約定返済額に届いていません。この状態が続くと現預金の取り崩しや借換え（新規調達）が必要になります。利益改善か返済条件の見直しを検討してください。</div>)}
        </div>
        <div className="card">
          <h3>債務償還年数<small>いまの稼ぐ力で借入を何年で返せるか</small></h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '6px 0 10px' }}>
            <span style={{ fontSize: 24, fontWeight: 800, color: '#14293c' }}>
              {ds.redemptionYears !== null ? `${num(ds.redemptionYears, 1)}年` : noDebt ? '0年' : '—'}
            </span>
            {redemptionBadge}
          </div>
          <div className="muted">
            有利子負債（借入・社債・リース）: {fmtYen(debtTotalNow)}<br />
            償還原資（直近12ヶ月: 経常利益＋減価償却費−法人税等）: {fmtYen(ds.redemptionSource)}<br />
            {ds.redemptionYearsNet !== null && `実質債務償還年数（現預金 ${fmtShort(ds.cashNow)}円 を控除後）: ${num(ds.redemptionYearsNet, 1)}年`}
          </div>
          {ds.redemptionYears === null && !noDebt && (
            <div className="warn-box">直近12ヶ月の償還原資がマイナスのため計算できません。まず利益の黒字化が先決です。</div>
          )}
        </div>
      </div>

      <div className="card">
        <h3>現預金と有利子負債の推移<small>全期間（月末残高）</small></h3>
        <LineChart labels={tl.map(p => p.label)} height={240} series={[
          { name: '現預金', color: C.blue, values: tl.map(p => p.s.cash[p.mi]) },
          { name: '有利子負債（借入・社債・リース）', color: C.red, values: tl.map(p => p.s.debt[p.mi] + p.s.lease[p.mi]) },
        ]} />
        <div className="muted">
          2本の線の差が「実質的な借入の重さ」です。現預金が有利子負債を上回れば実質無借金。
          差が縮んでいく（負債線が現預金線に近づく・追い越す）月は、原因を「CF計算書」のページで確認してください。
        </div>
      </div>

      <div className="card">
        <h3>借入の内訳<small>{y.label}・科目別残高（{prevFull ? '期首＝前期末' : `期首＝${ymLabel(y, 0)}`} → 最新 {ymLabel(y, li)}）</small></h3>
        {tableRows.length === 0 ? (
          <div className="ok-box">借入金・社債・リース債務の残高はありません（無借金です）。</div>
        ) : (
          <div className="table-scroll">
            <table className="grid">
              <thead>
                <tr>
                  <th>科目</th>
                  <th className="num">期首残高（円）</th>
                  <th className="num">最新残高（円）</th>
                  <th className="num">増減（円）</th>
                </tr>
              </thead>
              <tbody>
                {tableRows.map(({ r, open, now }) => (
                  <tr key={`${r.code}:${r.name}`}>
                    <td>{r.name}{/短期借入金/.test(r.name) && ' ※'}</td>
                    <td className="num">{yen(open)}</td>
                    <td className="num">{yen(now)}</td>
                    {diffCell(now - open)}
                  </tr>
                ))}
                <tr className="total">
                  <td>合計</td>
                  <td className="num">{yen(totalOpen)}</td>
                  <td className="num">{yen(totalNow)}</td>
                  {diffCell(totalNow - totalOpen)}
                </tr>
              </tbody>
            </table>
          </div>
        )}
        <div className="muted" style={{ marginTop: 8 }}>
          増減は<span className="pos">青が減少（返済が進んだ）</span>・<span className="neg">赤が増加（新規調達）</span>です。
          ※印の短期借入金は手形の書換・折返しで残高が上下し実態の返済額を表さないため、
          上のKPI「約定返済額」の集計からは除外しています（残高には含みます）。
        </div>
      </div>

      <div className="card">
        <h3>このページの見方</h3>
        <div className="muted">
          <b>債務償還年数</b>は「いまの利益水準で借入をあと何年で返し切れるか」を示し、
          金融機関が融資審査で最も重視する指標のひとつです。<b>10年以内</b>が健全の目安で、
          これを超えると「借入が利益に対して重い」と判断され、新規融資が通りにくくなります。
          分母の<b>償還原資</b>は「経常利益＋減価償却費−法人税等」で計算します。
          減価償却費はお金が出ていかない費用なので利益に足し戻し、法人税等は必ず出ていくお金なので差し引く、
          つまり「1年間で返済に回せる現金」という意味です。<br /><br />
          もうひとつの目安が <b>FCF（フリーキャッシュフロー）＞ 約定返済額</b>（返済カバー率1倍以上）です。
          事業が生み出した現金で毎月の返済が賄えていれば、借入は自然に減っていきます。
          下回っている場合は、現預金を取り崩すか借換えで凌いでいる状態なので、
          利益の改善（損益分岐点ページ）か返済期間の見直し（リスケ・借換えの一本化）を検討します。
          あわせて手元流動性（現預金÷平均月商）は<b>月商3ヶ月分以上</b>を確保しておくと、
          急な入金遅れや設備故障にも慌てず対応できます。
        </div>
      </div>
    </div>
  );
}
