'use client'

/**
 * 納税資金予測 (/tax):
 * 進行期（最新年度）の着地予測をもとに、決算で必要になる法人税等・消費税を簡易試算し、
 * 中間納付の目安と毎月の納税準備（月割積立額）を示すページ。
 * 計算はすべて analysis.ts（forecastOf / corpTaxEstimate / consumptionTaxForecast）に任せる。
 */
import { useState } from 'react';
import { getState } from '@/lib/keiei/kr/api';
import {
  sortedYears, yearSeries, prevYearOf, calYm, forecastOf,
  corpTaxEstimate, consumptionTaxForecast, yen,
} from '@/lib/keiei/kr/analysis';
import { C, ComboChart, Kpi, LineChart, Meter, NeedData, SliderRow, fmtShort } from '../ui';

const sum = (a: number[]): number => a.reduce((x, y) => x + y, 0);

/** スライダー範囲（70〜130%）に収めた整数％。 */
const clampPct = (adj: number): number => Math.min(130, Math.max(70, Math.round(adj * 100)));

export default function TaxForecast() {
  const state = getState();
  const years = sortedYears(state);
  // 進行期（最新年度）固定。年度切替は不要
  const y = years.length ? years[years.length - 1] : null;
  // 売上調整率（%）。初期値は forecastOf の自動値（当期累計の前年同期比）
  const [adjPct, setAdjPct] = useState<number>(() =>
    y ? clampPct(forecastOf(state, y).salesAdj) : 100);

  if (!y) return (
    <div>
      <h2 className="page-title">納税資金予測</h2>
      <NeedData />
    </div>
  );

  const li = y.lastFilledIndex;
  const s = yearSeries(y);
  const prevY = prevYearOf(state, y);
  const prevS = prevY ? yearSeries(prevY) : null;
  const prevComplete = !!prevY && prevY.lastFilledIndex === 11;

  const autoPct = clampPct(forecastOf(state, y).salesAdj);
  const fc = forecastOf(state, y, adjPct / 100);
  const tax = corpTaxEstimate(fc.landing.pretax, state.settings.equalization);
  const ct = consumptionTaxForecast(state, y);
  const isLoss = fc.landing.pretax <= 0;
  const hasCt = ct.received !== 0 || ct.paid !== 0;

  // 前期通期との比較（前期が通年揃っているときだけ）
  const prevFullSales = prevComplete && prevS ? sum(prevS.sales.slice(0, 12)) : null;
  const salesDelta = prevFullSales !== null && prevFullSales > 0 ? fc.landing.sales / prevFullSales - 1 : null;
  const prevFullOrd = prevComplete && prevS ? sum(prevS.ordinary.slice(0, 12)) : null;

  // 中間納付の目安（法人税等: 前期年額の1/2。前期の法人税等が40万円超のとき）
  const prevTaxAnnual = prevComplete && prevS ? sum(prevS.tax.slice(0, 12)) : null;
  const corpInterim = prevTaxAnnual !== null && prevTaxAnnual > 400_000 ? prevTaxAnnual / 2 : null;

  // 中間納付の目安（消費税: 前期年税額48万円超で中間あり）
  const ctPrev = ct.prevActual;
  let ctInterimJudge: string;
  let ctInterimAmount = '—';
  if (ctPrev === null) {
    ctInterimJudge = '前期の年税額が不明のため判定できません（前期末の未払消費税等から取得）';
  } else if (ctPrev <= 480_000) {
    ctInterimJudge = `対象外の見込み（前期の確定納付額 ${yen(ctPrev)}円 ≦ 48万円）`;
  } else if (ctPrev <= 4_000_000) {
    ctInterimJudge = `対象の見込み（前期の確定納付額 ${yen(ctPrev)}円 ＞ 48万円・年1回）`;
    ctInterimAmount = `約 ${yen(ctPrev / 2)}円`;
  } else {
    ctInterimJudge = `対象の見込み（前期の確定納付額 ${yen(ctPrev)}円・年3回以上に分割）`;
    ctInterimAmount = `約 ${yen(ctPrev / 4)}円 × 年3回程度`;
  }
  // 注: 判定は本来「前期の年税額（中間納付控除前）」で行うが、月次推移からは
  // 確定納付額しか取れないため目安として使う（実際の判定は申告書で確認）

  // 納税準備: （法人税等予測＋消費税年額予測）÷ 12 の月割積立
  const ctAnnualForReserve = hasCt ? Math.max(0, ct.annual) : 0;
  const annualTax = tax.total + ctAnnualForReserve;
  const monthlyReserve = annualTax / 12;
  const cashNow = s.cash[li];
  const cashRatio = annualTax > 0 ? cashNow / annualTax : null;

  // チャート: 単月の経常利益＝棒／累計の経常利益＝線（当期＝赤・前期＝灰）
  const labels = Array.from({ length: 12 }, (_, i) => `${calYm(y, i).month}月`);
  const prevVals = prevS
    ? prevS.ordinary.map((v, i) => (i <= prevY!.lastFilledIndex ? v : null))
    : null;
  const curVals = fc.months.map(m => m.ordinary);
  /** 月次の値を累計に直す（null の月以降は累計も出さない）。 */
  const cumulate = (vals: (number | null)[]): (number | null)[] => {
    let acc = 0;
    return vals.map(v => (v === null ? null : (acc += v)));
  };
  const curCum = cumulate(curVals);
  const prevCum = prevVals ? cumulate(prevVals) : null;

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-title">納税資金予測</h2>
          <p className="page-sub">
            {y.label}（実績 {li + 1}ヶ月）をもとに通期の着地を予測し、決算で必要になる納税額と
            毎月の積立目安を試算します。売上調整率のスライダーを動かすと全体が連動します。
          </p>
        </div>
      </div>

      <div className="kpi-grid">
        <Kpi label="通期売上見込" value={`${fmtShort(fc.landing.sales)}円`}
          delta={salesDelta !== null ? `${salesDelta >= 0 ? '+' : ''}${(salesDelta * 100).toFixed(1)}%` : undefined}
          tone={salesDelta !== null ? (salesDelta >= 0 ? 'good' : 'bad') : undefined}
          sub={prevFullSales !== null ? `前期実績 ${fmtShort(prevFullSales)}円` : `実績累計 ${fmtShort(fc.ytdSales)}円`} />
        <Kpi label="通期経常利益見込" value={`${fmtShort(fc.landing.ordinary)}円`}
          delta={fc.landing.ordinary >= 0 ? '黒字見込み' : '赤字見込み'}
          tone={fc.landing.ordinary >= 0 ? 'good' : 'bad'}
          sub={prevFullOrd !== null ? `前期実績 ${fmtShort(prevFullOrd)}円` : undefined} />
        <Kpi label="税引前利益見込" value={`${fmtShort(fc.landing.pretax)}円`}
          sub="特別損益は実績分のみ織り込み" />
        <Kpi label="実績月数" value={`${fc.actualMonths}ヶ月`}
          sub={fc.actualMonths >= 12 ? '通期の実績が揃っています' : `残り ${12 - fc.actualMonths}ヶ月は予測`} />
      </div>

      <div className="card">
        <h3>着地予測の前提<small>残りの月の売上は「前年同月 × 調整率」で見込みます</small></h3>
        <div className="kr-auto-note">
          {fc.prevYtdSales > 0 ? (
            <>
              初期値の <b>{autoPct}%</b> は
              <b> 当期の売上累計 {yen(fc.ytdSales)}円 ÷ 前年同期 {yen(fc.prevYtdSales)}円 = {autoPct}%</b> から自動計算しています
              （「今のペースが決算まで続いたら」という前提）。
              {adjPct !== autoPct && <span className="badge info" style={{ marginLeft: 8 }}>手動で {adjPct}% に変更中</span>}
            </>
          ) : '前年同期の売上が無いため、当期実績の平均をもとに残りの月を見込んでいます。'}
        </div>
        <SliderRow label={`残りの月の売上調整率（前年同月比）${adjPct === autoPct ? '（自動計算値）' : ''}`}
          value={adjPct} min={70} max={130} step={1}
          format={v => `${v}%`}
          onChange={setAdjPct}
          onReset={adjPct !== autoPct ? () => setAdjPct(autoPct) : undefined} />
        <div className="muted">
          受注の見込みに合わせて動かしてください。100%にすると「前年と同じ売上に戻る」前提、
          {autoPct}%のままなら「前年比 {100 - autoPct}%減が続く」前提での着地になります。
        </div>
        {!fc.hasPrevYear && (
          <div className="warn-box">
            前期の通年データが取り込まれていないため、残りの月の売上・固定費は当期実績の平均で見込んでいます。
            予測の精度を上げるには前期の月次データも取り込んでください。
          </div>
        )}
      </div>

      <div className="card">
        <h3>月次経常利益（実績＋予測）<small>棒＝単月／線＝累計。淡い棒と点線が予測</small></h3>
        <ComboChart labels={labels} height={250}
          bars={[
            ...(prevVals ? [{ name: `${prevY!.label} 単月`, color: C.gray, values: prevVals }] : []),
            { name: `${y.label} 単月`, color: C.red, values: curVals, dashedFrom: fc.actualMonths },
          ]}
          lines={[
            ...(prevCum ? [{ name: `${prevY!.label} 累計`, color: C.gray, values: prevCum }] : []),
            { name: `${y.label} 累計`, color: C.red, values: curCum, dashedFrom: fc.actualMonths },
          ]} />
        <div className="muted">
          予測（淡い棒・点線）は「売上＝前年同月×調整率、変動費＝売上×当期の変動費率、固定費＝前年同月」の簡便計算です。
          単月では黒字・赤字が月ごとに振れますが、決算の着地は累計（線）の右端で判断します。
        </div>
      </div>

      <div className="row">
        <div className="card">
          <h3>法人税等の見込み<small>課税所得 ≒ 税引前利益 {yen(tax.income)}円 で近似</small></h3>
          {isLoss && (
            <div className="warn-box">
              通期見込みが赤字（利益ゼロ以下）のため、所得にかかる法人税・事業税などは発生しない見込みです。
              納税は住民税の均等割 {yen(tax.equalization)}円のみとなります（均等割は赤字でも必ず発生します）。
            </div>
          )}
          <table className="grid">
            <thead>
              <tr><th>税目</th><th className="num">見込税額（円）</th><th>計算の目安</th></tr>
            </thead>
            <tbody>
              <tr><td>法人税</td><td className="num">{yen(tax.corpTax)}</td><td>所得800万円以下 15%・超過分 23.2%</td></tr>
              <tr><td>地方法人税</td><td className="num">{yen(tax.localCorpTax)}</td><td>法人税 × 10.3%</td></tr>
              <tr><td>住民税（法人税割）</td><td className="num">{yen(tax.inhabitantTax)}</td><td>法人税 × 7%</td></tr>
              <tr><td>住民税（均等割）</td><td className="num">{yen(tax.equalization)}</td><td>赤字でも発生（設定の年額）</td></tr>
              <tr><td>事業税</td><td className="num">{yen(tax.bizTax)}</td><td>所得に応じて 3.5〜7%</td></tr>
              <tr><td>特別法人事業税</td><td className="num">{yen(tax.specialBizTax)}</td><td>事業税 × 37%</td></tr>
              <tr className="total"><td>合計</td><td className="num">{yen(tax.total)}</td><td></td></tr>
            </tbody>
          </table>
        </div>

        <div className="card">
          <h3>消費税の見込み<small>仮受−仮払の残高を年換算する簡便法</small></h3>
          {hasCt ? (
            <>
              <table className="grid">
                <thead>
                  <tr><th>項目</th><th className="num">金額（円）</th></tr>
                </thead>
                <tbody>
                  <tr><td>仮受消費税の残高（売上で預かった分）</td><td className="num">{yen(ct.received)}</td></tr>
                  <tr><td>仮払消費税の残高（仕入等で支払った分）</td><td className="num">{yen(ct.paid)}</td></tr>
                  <tr><td>差引（経過 {ct.elapsed}ヶ月分の納税義務の概算）</td><td className="num">{yen(ct.net)}</td></tr>
                  <tr className="total">
                    <td>年額予測（単純年換算）</td>
                    <td className="num">{ct.annual < 0 ? <span className="neg">{yen(ct.annual)}（還付見込み）</span> : yen(ct.annual)}</td>
                  </tr>
                </tbody>
              </table>
              <div className="muted">
                前期の確定納付額: {ctPrev !== null ? `${yen(ctPrev)}円` : '—（前期末の未払消費税等から取得できません）'}
                {ctPrev !== null && '（前期末の未払消費税等。中間納付があった場合はその控除後の金額です）'}
              </div>
              {ct.net < 0 && (
                <div className="warn-box">
                  仮払消費税が仮受消費税を上回っています。大きな設備投資があった場合や、
                  中間納付が仮払消費税に含まれている場合、この年換算は実際の年税額より小さく（還付側に）出ます。
                  前期の納付実績も参考に、余裕をもって資金を見込んでください。
                </div>
              )}
            </>
          ) : (
            <div className="muted">仮受消費税・仮払消費税の残高が見つからないため予測できません（税込経理・免税事業者の場合など）。</div>
          )}
          <div className="muted">
            消費税はお客様から預かった税金の精算であり、赤字でも納税が発生します。資金繰り上もっとも注意が必要な税金です。
          </div>
        </div>
      </div>

      <div className="card">
        <h3>中間納付の目安<small>期中に前払いする税金（決算の納税とは別に資金が要ります）</small></h3>
        <table className="grid">
          <thead>
            <tr><th>税目</th><th>判定の目安</th><th className="num">中間納付額の目安</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>法人税等（予定納税）</td>
              <td>{prevTaxAnnual === null
                ? '前期の通年データが無いため判定できません'
                : prevTaxAnnual > 400_000
                  ? `対象の見込み（前期の法人税等 ${yen(prevTaxAnnual)}円 ＞ 40万円）`
                  : `対象外の見込み（前期の法人税等 ${yen(prevTaxAnnual)}円 ≦ 40万円）`}</td>
              <td className="num">{corpInterim !== null ? `約 ${yen(corpInterim)}円` : '—'}</td>
            </tr>
            <tr>
              <td>消費税（中間申告）</td>
              <td>{ctInterimJudge}</td>
              <td className="num">{ctInterimAmount}</td>
            </tr>
          </tbody>
        </table>
        <div className="muted">
          中間納付は原則、期首から6ヶ月経過後の2ヶ月以内（年1回の場合）に前期実績の約半分を前払いします。
          決算の納税と時期がずれるため、資金繰りにあらかじめ織り込んでください。
        </div>
      </div>

      <div className="card">
        <h3>納税準備（月割積立）<small>決算・中間納付で慌てないための毎月の積立目安</small></h3>
        <div className="kpi-grid">
          <Kpi label="年間の納税見込み合計" value={`${fmtShort(annualTax)}円`}
            sub={`法人税等 ${fmtShort(tax.total)}円 ＋ 消費税 ${fmtShort(ctAnnualForReserve)}円`} />
          <Kpi label="月割の積立目安" value={`${fmtShort(monthlyReserve)}円`}
            sub="納税見込み合計 ÷ 12ヶ月" />
          <Kpi label="現預金残高（最新月）" value={`${fmtShort(cashNow)}円`}
            delta={cashRatio !== null ? (cashRatio >= 1 ? '納税分を確保' : '積み増しが必要') : undefined}
            tone={cashRatio !== null ? (cashRatio >= 1 ? 'good' : 'bad') : undefined}
            sub={cashRatio !== null ? `納税見込みの ${(cashRatio * 100).toFixed(0)}%` : undefined} />
        </div>
        <Meter ratio={cashRatio} good={1} warn={0.5}
          text={cashRatio !== null
            ? `現預金 ${fmtShort(cashNow)}円 ÷ 納税見込み ${fmtShort(annualTax)}円 ＝ ${(cashRatio * 100).toFixed(0)}%（100%以上なら納税資金は手元にあります）`
            : '納税見込みが0円のため比較していません'} />
        {cashRatio !== null && (cashRatio < 1 ? (
          <div className="warn-box">
            現預金が年間の納税見込みを下回っています。毎月 {yen(monthlyReserve)}円 を納税準備の口座に
            分けて積み立てると、納付時期の資金不足を防げます。
          </div>
        ) : (
          <div className="ok-box">
            現預金残高は年間の納税見込みを上回っています。納税分 {fmtShort(annualTax)}円 は
            運転資金とは分けて考えておくと安心です。
          </div>
        ))}
      </div>

      <div className="card">
        <h3>このページの見方<small>顧問先への説明ポイント</small></h3>
        <div className="muted">
          利益が出ると、決算日からおよそ2ヶ月後に法人税等と消費税をまとめて納めます。
          「利益は出ているのにお金が無い」の典型が、この納税資金の準備不足です。
          上の月割積立額を毎月別口座に移しておけば、決算や中間納付の時期に慌てずに済みます。
          売上調整率のスライダーを動かすと「売上がこのまま推移したら納税はいくらになるか」をその場で確認できます。
        </div>
        <div className="warn-box">
          ※ 本ページの税額は簡易計算（標準税率・中小法人の目安）です。繰越欠損金・別表調整・
          軽減税率の適用状況は考慮していないため、正式な税額は申告計算で確定します。
        </div>
      </div>
    </div>
  );
}
