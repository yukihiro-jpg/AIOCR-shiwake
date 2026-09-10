'use client'

/**
 * 労働分配率:
 * 人件費と付加価値（≒売上総利益）のバランスを見るページ。
 * 3期分の労働分配率KPI・月次の累計労働分配率の推移・人件費の内訳（当期と前期の比較）を表示する。
 * 年度は最新期（進行期）を主役に、前期・前々期を文脈として並べる。
 */
import { useState } from 'react';
import { getState, api } from '@/lib/keiei/kr/api';
import {
  sortedYears, yearSeries, laborShareOf, personnelBreakdown, calYm, yen,
} from '@/lib/keiei/kr/analysis';
import { C, Kpi, KpiTable, LineChart, NeedData, fmtShort, useRerender } from '../ui';
import type { FiscalYearData } from '@/lib/keiei/kr/types';

/** 労働分配率の表示（% 小数1桁）。計算不能は '—'。 */
const pct = (r: number | null): string => (r !== null ? `${(r * 100).toFixed(1)}%` : '—');

/**
 * 累計労働分配率（%）の月次系列。
 * 各月時点の「累計人件費 ÷ 累計売上総利益 × 100」。
 * 実績の無い月（lastFilledIndex より後）と累計粗利が0以下の月は null（描画しない）。
 */
function cumulativeRatePct(y: FiscalYearData): (number | null)[] {
  const s = yearSeries(y);
  const out: (number | null)[] = [];
  let personnel = 0;
  let gross = 0;
  for (let i = 0; i < 12; i++) {
    if (i > y.lastFilledIndex) { out.push(null); continue; }
    personnel += s.personnel[i];
    gross += s.gross[i];
    out.push(gross > 0 ? (personnel / gross) * 100 : null);
  }
  return out;
}

export default function Labor() {
  const state = getState();
  const rerender = useRerender();
  const years = sortedYears(state);
  if (!years.length) return (
    <div>
      <h2 className="page-title">労働分配率</h2>
      <NeedData />
    </div>
  );

  // 最新期を主役に、前期・前々期を比較対象にする
  const y = years[years.length - 1];
  const prevY = years.length >= 2 ? years[years.length - 2] : null;
  const prev2Y = years.length >= 3 ? years[years.length - 3] : null;
  const li = y.lastFilledIndex;

  const ls = laborShareOf(y);
  const prevLs = prevY ? laborShareOf(prevY) : null;
  const prev2Ls = prev2Y ? laborShareOf(prev2Y) : null;

  // 前期との差（ポイント）。上昇＝粗利に対して人件費が重くなった方向
  const dPt = ls.rate !== null && prevLs?.rate != null ? (ls.rate - prevLs.rate) * 100 : null;

  // 月ラベル（当年度の12ヶ月。前期・前々期も同じ決算月構成として重ねる）
  const labels = Array.from({ length: 12 }, (_, i) => `${calYm(y, i).month}月`);

  // 人件費の内訳（当期と前期を科目名で突き合わせ）
  const curBd = personnelBreakdown(y);
  const prevBd = prevY ? personnelBreakdown(prevY) : [];
  const names = [...curBd.map(b => b.name)];
  for (const b of prevBd) if (!names.includes(b.name)) names.push(b.name);
  const bdRows = names.map(name => {
    const cur = curBd.find(b => b.name === name)?.amount ?? 0;
    const prv = prevBd.find(b => b.name === name)?.amount ?? 0;
    return { name, cur, prv, diff: cur - prv };
  });
  const totalCur = bdRows.reduce((a, r) => a + r.cur, 0);
  const totalPrv = bdRows.reduce((a, r) => a + r.prv, 0);

  // 増減の符号つき表示
  const signedYen = (n: number): string => `${n >= 0 ? '+' : '−'}${yen(Math.abs(n))}`;

  // ---- 従業員数から見る生産性（年換算して1人当たりにする） ----
  const empCur = state.settings.employees[y.id] ?? 0;
  const empPrev = prevY ? (state.settings.employees[prevY.id] ?? 0) : 0;
  /** 実績月数を12ヶ月に換算する。 */
  const annualize = (v: number, months: number) => (months > 0 ? (v / months) * 12 : 0);
  const perHead = (v: number, months: number, heads: number) =>
    (heads > 0 ? annualize(v, months) / heads : null);
  const sCur = yearSeries(y);
  const sPrev = prevY ? yearSeries(prevY) : null;
  const salesCur = sCur.sales.slice(0, li + 1).reduce((a, b) => a + b, 0);
  const salesPrev = sPrev && prevY
    ? sPrev.sales.slice(0, prevY.lastFilledIndex + 1).reduce((a, b) => a + b, 0) : 0;
  const prevMonths = prevY ? prevY.lastFilledIndex + 1 : 0;
  const fmtHead = (v: number | null) => (v === null ? '—' : `${fmtShort(v)}円`);
  const perHeadRows = [
    {
      label: '1人当たり売上高（年換算）',
      value: fmtHead(perHead(salesCur, ls.months, empCur)),
      prev: empPrev > 0 ? fmtHead(perHead(salesPrev, prevMonths, empPrev)) : undefined,
      delta: undefined, tone: 'neutral' as const,
      note: `売上高 ${fmtShort(annualize(salesCur, ls.months))}円 ÷ ${empCur}人`,
      help: '従業員1人あたりで年間いくらの売上を上げているかです。'
        + '実績月数から1年分に換算して計算しています。'
        + '人を増やしたのに この数字が下がっているときは、増えた人数分の仕事が取れていないサインです。',
    },
    {
      label: '1人当たり付加価値（労働生産性）',
      value: fmtHead(perHead(ls.valueAdded, ls.months, empCur)),
      prev: empPrev > 0 && prevLs ? fmtHead(perHead(prevLs.valueAdded, prevMonths, empPrev)) : undefined,
      delta: undefined, tone: 'neutral' as const,
      note: '粗利を人数で割った値。ここが上がらないと賃上げの原資は生まれません',
      help: '1人が1年間に生み出した粗利（付加価値）です。会社が給料を払う原資はここから出るため、'
        + 'この数字が増えないまま人件費だけを増やすと利益が減ります。'
        + '賃上げを続けられるかどうかは、まずこの労働生産性が上がっているかで判断します。',
    },
    {
      label: '1人当たり人件費（年換算）',
      value: fmtHead(perHead(ls.personnel, ls.months, empCur)),
      prev: empPrev > 0 && prevLs ? fmtHead(perHead(prevLs.personnel, prevMonths, empPrev)) : undefined,
      delta: undefined, tone: 'neutral' as const,
      note: '法定福利費・賞与を含む会社負担ベース（役員報酬を含みます）',
      help: '1人あたりに年間かかっている人件費です。給料や賞与だけでなく、'
        + '会社が負担する社会保険料（法定福利費）や役員報酬も含むため、'
        + '手取りや額面の給与よりも大きい金額になります。',
    },
    {
      label: '1人当たり経常利益（年換算）',
      value: fmtHead(perHead(sCur.ordinary.slice(0, li + 1).reduce((a, b) => a + b, 0), ls.months, empCur)),
      prev: empPrev > 0 && sPrev && prevY
        ? fmtHead(perHead(sPrev.ordinary.slice(0, prevY.lastFilledIndex + 1).reduce((a, b) => a + b, 0), prevMonths, empPrev))
        : undefined,
      delta: undefined, tone: 'neutral' as const,
      note: '人を増やすかどうかの判断材料になります',
      help: '1人あたりが年間どれだけの経常利益を残しているかです。'
        + '採用を検討するときは、増える人件費（1人当たり人件費）に対して'
        + 'この利益を確保できる見込みがあるかが判断の目安になります。',
    },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-title">労働分配率</h2>
          <p className="page-sub">
            稼いだ粗利（付加価値）のうち、どれだけを人件費に充てているかを見るページです。
            {y.label}は{li + 1}ヶ月分の実績で集計しています。グラフの点にカーソルを合わせると値が出ます。
          </p>
        </div>
      </div>

      <div className="kpi-grid">
        <Kpi label={`当期の労働分配率（${y.label}・累計${ls.months}ヶ月）`}
          value={pct(ls.rate)}
          delta={dPt !== null ? `${dPt >= 0 ? '+' : ''}${dPt.toFixed(1)}pt` : undefined}
          tone={dPt !== null ? (dPt >= 1 ? 'bad' : dPt <= -1 ? 'good' : 'neutral') : undefined}
          sub={`人件費 ${fmtShort(ls.personnel)}円 ÷ 付加価値 ${fmtShort(ls.valueAdded)}円`} />
        <Kpi label={prevY ? `前期（${prevY.label}）` : '前期'}
          value={prevLs ? pct(prevLs.rate) : '—'}
          sub={prevLs ? `人件費 ${fmtShort(prevLs.personnel)}円 ÷ 付加価値 ${fmtShort(prevLs.valueAdded)}円` : 'データ未取込'} />
        <Kpi label={prev2Y ? `前々期（${prev2Y.label}）` : '前々期'}
          value={prev2Ls ? pct(prev2Ls.rate) : '—'}
          sub={prev2Ls ? `人件費 ${fmtShort(prev2Ls.personnel)}円 ÷ 付加価値 ${fmtShort(prev2Ls.valueAdded)}円` : 'データ未取込'} />
      </div>

      <div className="card">
        <h3>従業員数から見る生産性<small>年度ごとに人数を入れると1人当たりの指標を計算します</small></h3>
        <EmployeeInput yearId={y.id} label={y.label} onChange={rerender} />
        {empCur > 0 ? (
          <KpiTable currentLabel={`${y.label}（${ls.months}ヶ月・年換算）`}
            prevLabel={prevY && empPrev > 0 ? `前期（${prevY.label}）` : undefined}
            rows={perHeadRows} />
        ) : (
          <div className="muted" style={{ marginTop: 8 }}>
            従業員数を入れると、1人当たり売上高・1人当たり付加価値（労働生産性）・平均人件費を計算します。
            役員を含めるかどうかは毎年同じ基準にしてください（比較の意味が変わります）。
          </div>
        )}
      </div>

      <div className="card">
        <h3>累計労働分配率の月次推移<small>各月時点の 累計人件費 ÷ 累計売上総利益（3期比較）</small></h3>
        <LineChart labels={labels} unitHint="単位: %"
          format={v => `${v.toFixed(1)}%`} axisFormat={v => `${v}%`}
          series={[
            ...(prev2Y ? [{ name: prev2Y.label, color: C.gray, values: cumulativeRatePct(prev2Y), context: true }] : []),
            ...(prevY ? [{ name: prevY.label, color: C.orange, values: cumulativeRatePct(prevY), context: true }] : []),
            { name: y.label, color: C.blue, values: cumulativeRatePct(y) },
          ]} />
        <div className="muted">
          賞与や決算賞与の支給月は単月の分配率が大きく振れるため、累計で均して表示しています。
          当期の線が前期より上にあるほど「粗利に対して人件費が重い」状態です。進行期は実績月までを描いています。
        </div>
      </div>

      <div className="card">
        <h3>人件費の内訳<small>科目別・期間合計（単位: 円）</small></h3>
        <div className="table-scroll">
          <table className="grid">
            <thead>
              <tr>
                <th>科目</th>
                <th className="num">{y.label}（{li + 1}ヶ月）</th>
                <th className="num">{prevY ? `${prevY.label}（${prevY.lastFilledIndex + 1}ヶ月）` : '前期'}</th>
                <th className="num">増減</th>
              </tr>
            </thead>
            <tbody>
              {bdRows.map(r => (
                <tr key={r.name}>
                  <td>{r.name}</td>
                  <td className="num">{yen(r.cur)}</td>
                  <td className="num">{prevY ? yen(r.prv) : '—'}</td>
                  <td className={`num ${r.diff >= 0 ? 'pos' : 'neg'}`}>{prevY ? signedYen(r.diff) : '—'}</td>
                </tr>
              ))}
              <tr className="total">
                <td>人件費 計</td>
                <td className="num">{yen(totalCur)}</td>
                <td className="num">{prevY ? yen(totalPrv) : '—'}</td>
                <td className={`num ${totalCur - totalPrv >= 0 ? 'pos' : 'neg'}`}>{prevY ? signedYen(totalCur - totalPrv) : '—'}</td>
              </tr>
            </tbody>
          </table>
        </div>
        {prevY && li < 11 && (
          <div className="muted" style={{ marginTop: 8 }}>
            ※ 当期は進行期（{li + 1}ヶ月分）のため、前期（{prevY.lastFilledIndex + 1}ヶ月分）との増減には月数の差が含まれます。金額の大小より内訳の構成変化に注目してください。
          </div>
        )}
      </div>

      <div className="card">
        <h3>労働分配率の見方</h3>
        <div className="muted">
          労働分配率 ＝ 人件費 ÷ 付加価値（このレポートでは売上総利益で近似）。
          会社が稼いだ粗利のうち、どれだけを働く人に配分しているかを表します。
          中小企業では <b>50〜70%</b> が一般的な水準です。
          高すぎると（70%超が続くと）利益が残らず、賞与や昇給・設備投資の原資が作れません。
          逆に低すぎると給与水準が見劣りし、人材流出のリスクが高まります。
          改善の基本は「人件費を削る」ことではなく「粗利（付加価値）を増やす」こと
          — 値付けの見直しや高付加価値の仕事へのシフトを先に検討してください。
          <br />
          なお、人件費には次の科目を含めています:
          役員報酬・給料（給与・賃金・雑給）・賞与・退職金（退職給付を含む）・法定福利費・福利厚生費・労務費。
        </div>
      </div>
    </div>
  );
}

/** 年度ごとの従業員数の入力。空にすると「未設定」に戻る。 */
function EmployeeInput({ yearId, label, onChange }: {
  yearId: string; label: string; onChange: () => void;
}) {
  const saved = getState().settings.employees[yearId] ?? 0;
  const [text, setText] = useState(saved > 0 ? String(saved) : '');
  const commit = (v: string) => {
    setText(v);
    api.setEmployees(yearId, Number(v.replace(/[,，\s]/g, '')) || 0);
    onChange();
  };
  return (
    <div className="kr-emp">
      <label htmlFor={`emp-${yearId}`}>{label}の従業員数（役員を含む場合は毎年同じ基準で）</label>
      <div className="kr-emp-row">
        <input id={`emp-${yearId}`} inputMode="numeric" value={text} placeholder="例: 12"
          style={{ width: 96, textAlign: 'right' }}
          onChange={e => commit(e.target.value)} />
        <span className="muted">人</span>
        {saved > 0 && <span className="badge info">保存済み</span>}
      </div>
    </div>
  );
}
