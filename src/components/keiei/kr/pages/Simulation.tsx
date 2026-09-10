'use client'

/**
 * 経営シミュレーション (/sim):
 * 進行期の着地予測を基準に、売上・限界利益率・人件費・固定費・設備投資・借入を
 * スライダーで動かし、経常利益と1年後の資金がどう変わるかをその場で確かめる画面。
 * 月次報告の席で「売上が◯%落ちたら」「人を増やしたら」を数字にするために使う。
 * 計算はすべて analysis.ts の simBaseOf / simulate に任せる。
 */
import { useState } from 'react';
import { getState } from '@/lib/keiei/kr/api';
import { sortedYears, simBaseOf, simulate, SIM_DEFAULTS, yen } from '@/lib/keiei/kr/analysis';
import type { SimParams, SimResult } from '@/lib/keiei/kr/analysis';
import { C, LineChart, NeedData, fmtYen, fmtShort } from '../ui';

// ---- 表示フォーマッタ（スライダー・差分列） ----

/** 符号つき %（スライダー表示用） */
const sPct = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)}%`;
/** 符号つき ポイント（スライダー表示用） */
const sPt = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}pt`;
/** 金額（スライダー表示用・億/万の短縮） */
const sYen = (v: number) => `${fmtShort(v)}円`;
/** 符号つき 円（差の列） */
const signedYen = (d: number) => `${d >= 0 ? '+' : '−'}${yen(Math.abs(d))}円`;
/** 符号つき pt（差の列） */
const signedPt = (d: number) => `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(1)}pt`;

// ---- 比較表の行定義 ----

interface CompRow {
  label: string;
  /** セル表示（基準・シミュレーション後 共通） */
  cell: (r: SimResult) => string;
  /** 差（数値）。null は計算不能（—表示） */
  diff: (b: SimResult, a: SimResult) => number | null;
  diffFmt: (d: number) => string;
  /** 差がプラスのとき良い方向か（.pos/.neg の色分け） */
  goodUp: boolean;
  /** これ未満の差は ±0 とみなす */
  eps: number;
  /** 強調行（合計スタイル） */
  total?: boolean;
  /** 項目セルに置くスライダー（この行の数値を動かす条件） */
  slider?: {
    key: keyof SimParams;
    min: number; max: number; step: number;
    format: (v: number) => string;
  };
  /** 項目セルの補足（その条件が何にどう効くか） */
  hint?: string;
}

const ROWS: CompRow[] = [
  {
    label: '売上高',
    cell: r => fmtYen(r.sales),
    diff: (b, a) => a.sales - b.sales, diffFmt: signedYen, goodUp: true, eps: 0.5,
    slider: { key: 'salesPct', min: -30, max: 30, step: 1, format: sPct },
  },
  {
    label: '限界利益（かっこ内は限界利益率）',
    cell: r => `${fmtYen(r.mc)}（${(r.mcRate * 100).toFixed(1)}%）`,
    diff: (b, a) => a.mc - b.mc, diffFmt: signedYen, goodUp: true, eps: 0.5,
    slider: { key: 'mcRatePt', min: -10, max: 10, step: 0.5, format: sPt },
  },
  {
    label: '人件費',
    cell: r => fmtYen(r.personnel),
    diff: (b, a) => a.personnel - b.personnel, diffFmt: signedYen, goodUp: false, eps: 0.5,
    slider: { key: 'personnelPct', min: -20, max: 20, step: 1, format: sPct },
  },
  {
    label: 'その他固定費（営業外収益控除後）',
    cell: r => fmtYen(r.otherFixed),
    diff: (b, a) => a.otherFixed - b.otherFixed, diffFmt: signedYen, goodUp: false, eps: 0.5,
    slider: { key: 'otherFixedPct', min: -20, max: 20, step: 1, format: sPct },
  },
  {
    label: '経常利益', total: true,
    cell: r => fmtYen(r.ordinary),
    diff: (b, a) => a.ordinary - b.ordinary, diffFmt: signedYen, goodUp: true, eps: 0.5,
  },
  {
    label: '法人税等（概算）',
    cell: r => fmtYen(r.tax),
    diff: (b, a) => a.tax - b.tax, diffFmt: signedYen, goodUp: false, eps: 0.5,
  },
  {
    label: '税引後利益',
    cell: r => fmtYen(r.after),
    diff: (b, a) => a.after - b.after, diffFmt: signedYen, goodUp: true, eps: 0.5,
  },
  {
    label: '返済原資（税引後利益＋減価償却費）',
    cell: r => fmtYen(r.repayFund),
    diff: (b, a) => a.repayFund - b.repayFund, diffFmt: signedYen, goodUp: true, eps: 0.5,
  },
  {
    label: '約定返済額（年間）',
    cell: r => fmtYen(r.repay),
    diff: (b, a) => a.repay - b.repay, diffFmt: signedYen, goodUp: false, eps: 0.5,
  },
  {
    label: '追加の設備投資（資金の支出）',
    cell: r => fmtYen(r.invest),
    diff: (b, a) => a.invest - b.invest, diffFmt: signedYen, goodUp: false, eps: 0.5,
    slider: { key: 'invest', min: 0, max: 50_000_000, step: 1_000_000, format: sYen },
    hint: '損益（経常利益）は動かさず、下の「年間の資金増減」と「12ヶ月後の現預金」だけを減らします。',
  },
  {
    label: '新規借入（資金の入金）',
    cell: r => fmtYen(r.borrow),
    diff: (b, a) => a.borrow - b.borrow, diffFmt: signedYen, goodUp: true, eps: 0.5,
    slider: { key: 'borrow', min: 0, max: 50_000_000, step: 1_000_000, format: sYen },
    hint: '同じく損益には影響せず、「年間の資金増減」と「12ヶ月後の現預金」を増やします。',
  },
  {
    label: '年間の資金増減（返済原資−返済−投資＋借入）',
    cell: r => fmtYen(r.cashDelta),
    diff: (b, a) => a.cashDelta - b.cashDelta, diffFmt: signedYen, goodUp: true, eps: 0.5,
  },
  {
    label: '12ヶ月後の現預金', total: true,
    cell: r => fmtYen(r.cashEnd),
    diff: (b, a) => a.cashEnd - b.cashEnd, diffFmt: signedYen, goodUp: true, eps: 0.5,
  },
  {
    label: '損益分岐点売上高',
    cell: r => (r.bepSales !== null ? fmtYen(r.bepSales) : '—'),
    diff: (b, a) => (b.bepSales !== null && a.bepSales !== null ? a.bepSales - b.bepSales : null),
    diffFmt: signedYen, goodUp: false, eps: 0.5,
  },
  {
    label: '安全余裕率',
    cell: r => (r.safety !== null ? `${(r.safety * 100).toFixed(1)}%` : '—'),
    diff: (b, a) => (b.safety !== null && a.safety !== null ? (a.safety - b.safety) * 100 : null),
    diffFmt: signedPt, goodUp: true, eps: 0.05,
  },
];

export default function Simulation() {
  const state = getState();
  const years = sortedYears(state);
  const [params, setParams] = useState<SimParams>({ ...SIM_DEFAULTS });
  if (!years.length) return (
    <div>
      <h2 className="page-title">経営シミュレーション</h2>
      <NeedData />
    </div>
  );

  // 基準は常に最新年度（進行期）の着地予測
  const y = years[years.length - 1];
  const li = y.lastFilledIndex;
  const base = simBaseOf(state, y);
  const b = simulate(base, SIM_DEFAULTS); // 基準
  const a = simulate(base, params);       // シミュレーション後

  const set = <K extends keyof SimParams>(k: K) => (v: number) =>
    setParams(p => ({ ...p, [k]: v }));
  const changed = (Object.keys(SIM_DEFAULTS) as (keyof SimParams)[])
    .some(k => params[k] !== SIM_DEFAULTS[k]);

  // 判定（悪い順に列挙。すべて良好なら ok-box）
  const warns: string[] = [];
  if (a.ordinary < 0) {
    warns.push(`経常赤字になります（経常利益 ${fmtYen(a.ordinary)}）。売上・限界利益率・固定費のいずれかを見直してください。`);
  }
  if (a.cashDelta < 0) {
    warns.push(`年${yen(-a.cashDelta)}円ペースで資金が減少します（12ヶ月後の現預金は ${fmtYen(a.cashEnd)} の見込み）。`);
  }
  if (a.repayFund < a.repay) {
    warns.push(`返済原資 ${fmtYen(a.repayFund)} が約定返済額 ${fmtYen(a.repay)} に足りません（借入に依存した資金繰りになります）。`);
  }

  const pathLabels = Array.from({ length: 12 }, (_, i) => `${i + 1}ヶ月後`);

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-title">経営シミュレーション</h2>
          <p className="page-sub">
            基準は「{base.label}」（実績 {li + 1}ヶ月分をこのままのペースで1年間続けた場合の年間見込み）です。
            比較表の項目にあるスライダーを動かすと、同じ行の数値と下の判定・現預金グラフがその場で再計算されます。
          </p>
        </div>
        <button className="secondary" disabled={!changed}
          onClick={() => setParams({ ...SIM_DEFAULTS })}>すべてリセット</button>
      </div>

      {warns.length > 0
        ? warns.map((w, i) => <div key={i} className="warn-box">{w}</div>)
        : (
          <div className="ok-box">
            経常黒字を確保し、返済原資（{fmtYen(a.repayFund)}）が約定返済額（{fmtYen(a.repay)}）を上回っています。
            資金は年{yen(a.cashDelta)}円ペースで増加する見込みです。
          </div>
        )}

      <div className="card">
        <h3>基準との比較<small>項目のスライダーを動かすと、右の数値がその場で変わります（年間ベース・円）</small></h3>
        <div className="table-scroll">
          <table className="grid">
            <thead>
              <tr>
                <th>項目</th>
                <th className="num">基準（着地予測）</th>
                <th className="num">シミュレーション後</th>
                <th className="num">差</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map(row => {
                const d = row.diff(b, a);
                const zero = d !== null && Math.abs(d) < row.eps;
                const favorable = d !== null && (d > 0) === row.goodUp;
                return (
                  <tr key={row.label} className={row.total ? 'total' : undefined}>
                    <td className="sim-item">
                      <div className="sim-item-label">{row.label}</div>
                      {row.slider && (
                        <div className="sim-item-slider">
                          <input type="range" aria-label={`${row.label}の増減`}
                            min={row.slider.min} max={row.slider.max} step={row.slider.step}
                            value={params[row.slider.key]}
                            onChange={e => set(row.slider!.key)(Number(e.target.value))} />
                          <b>{row.slider.format(params[row.slider.key])}</b>
                        </div>
                      )}
                      {row.hint && <div className="sim-item-hint">{row.hint}</div>}
                    </td>
                    <td className="num">{row.cell(b)}</td>
                    <td className="num">{row.cell(a)}</td>
                    <td className={`num${d === null || zero ? '' : favorable ? ' pos' : ' neg'}`}>
                      {d === null ? '—' : zero ? '±0' : row.diffFmt(d)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="muted">
          ※「追加の設備投資」「新規借入」は資金の動きだけに効きます。簡便のため、
          追加投資による減価償却費の増加や、新規借入の支払利息・翌年以降の返済額の増加は
          織り込んでいません（経常利益・法人税等・損益分岐点売上高は変わりません）。
        </div>
      </div>

      <div className="card">
        <h3>現預金の12ヶ月推移<small>基準とシミュレーション後の比較</small></h3>
        <LineChart labels={pathLabels} height={230} series={[
          { name: '基準（着地予測ペース）', color: C.gray, values: b.cashPath, context: true },
          { name: 'シミュレーション後', color: C.blue, values: a.cashPath },
        ]} />
        <div className="muted">
          現在の現預金 {fmtYen(base.cashNow)} を起点に、年間の資金増減を12等分して機械的に
          伸ばした線です。賞与・納税など月ごとの偏りは含みません。
        </div>
      </div>

      <div className="card">
        <h3>この画面の見方</h3>
        <div className="muted">
          基準の「{base.label}」は、進行中の {y.label} を実績 {li + 1}ヶ月分のペースで
          1年間続けたと仮定した着地予測です。月次報告の席でスライダーを動かしながら、
          「売上が10%落ちたら経常利益と1年後の資金はどうなるか」「人を1人増やしたら
          （人件費を数%上げたら）利益は残るか」「設備投資を借入で行ったら返済は回るか」を
          その場で数字にして確認できます。スライダーは大きく2種類あります。
          売上高・限界利益率・人件費・その他固定費は<b>損益（経常利益）から下すべて</b>を
          動かします（経常利益→法人税等→税引後利益→返済原資→資金増減→12ヶ月後の現預金、
          さらに損益分岐点売上高・安全余裕率）。一方、追加の設備投資・新規借入は
          <b>資金の動きだけ</b>を動かします（年間の資金増減と12ヶ月後の現預金・下の推移グラフ）。
          設備投資は資金を減らし、新規借入は資金を増やすので、この2つを同額にすると
          資金は基準のままで「投資を借入で賄えるか」を確認できます。
          見るべきポイントは経常利益のさらに下、
          「返済原資（税引後利益＋減価償却費）」です。これが約定返済額を上回っていないと、
          損益が黒字でも資金は年々減っていきます。なお法人税等は中小法人の標準税率による
          概算で、繰越欠損金や特別損益は考慮していません。
        </div>
      </div>
    </div>
  );
}
