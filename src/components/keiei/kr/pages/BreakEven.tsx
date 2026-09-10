'use client'

import { useState } from 'react';
import { getState, api } from '@/lib/keiei/kr/api';
import {
  sortedYears, yearSeries, cvpOf, annualizeCvp, requiredSales, requiredSalesForRepay,
  debtSummary, plSections, defaultCostClass, signedRowValue, yen,
} from '@/lib/keiei/kr/analysis';
import type { PlSection } from '@/lib/keiei/kr/analysis';
import type { AccountRow, CostClass } from '@/lib/keiei/kr/types';
import {
  C, CompareBars, Kpi, Meter, NeedData, YearNav, YenInput, useYearSelection, useRerender,
  fmtShort, fmtYen,
} from '../ui';

/**
 * 損益分岐点・必要売上高（CVP分析）:
 * 限界利益率と固定費から損益分岐点売上高・安全余裕率を計算し、
 * 「目標利益」「借入返済原資の確保」に必要な売上高を逆算する。
 * 変動費/固定費の分類は科目ごとに切り替えられ、即座に再計算される。
 */
export default function BreakEven() {
  const state = getState();
  const years = sortedYears(state);
  const [yearId, setYearId] = useYearSelection(years);
  // 目標経常利益（②の逆算に使う。初期値 1,000万円）
  const [targetProfit, setTargetProfit] = useState(10_000_000);
  const rerender = useRerender();

  if (!years.length) return (
    <div>
      <h2 className="page-title">損益分岐点・必要売上高</h2>
      <NeedData />
    </div>
  );

  const y = years.find(x => x.id === yearId) ?? years[years.length - 1];
  const s = yearSeries(y);
  const li = y.lastFilledIndex;
  const cvp = cvpOf(state, y);
  const months = cvp.months;
  const ds = debtSummary(state, y);
  const taxRate = state.settings.taxRate;

  // 変動費率（売上に比例して出ていく費用の割合）
  const varRate = cvp.sales > 0 ? cvp.variable / cvp.sales : 0;

  // 必要売上高の逆算は「年間ベース」でそろえる（進行期は実績を年換算）。
  // 年間返済額と期間途中の固定費を混ぜると意味のない金額になるため
  const cvpYear = annualizeCvp(cvp);

  // ③ 借入返済原資の確保: 直近12ヶ月の実績返済額と減価償却費（年換算）から逆算
  const annualRepay = ds.annualRepay;
  const depActual = s.depreciation.slice(0, li + 1).reduce((a, b) => a + b, 0);
  const annualDep = (depActual / Math.max(1, months)) * 12;
  const repayReq = requiredSalesForRepay(cvpYear, annualRepay, annualDep, taxRate);

  // ② 目標経常利益に必要な売上（年間）
  const targetReq = requiredSales(cvpYear, targetProfit);

  // 実績（年換算）との差のセル（プラス＝すでに上回っている・マイナス＝不足）
  const diffCell = (req: number | null) => {
    if (req === null) return <td className="num">—</td>;
    const d = cvpYear.sales - req;
    return (
      <td className={`num ${d >= 0 ? 'pos' : 'neg'}`}>
        {d >= 0 ? `+${yen(d)}円（達成）` : `−${yen(-d)}円（不足）`}
      </td>
    );
  };

  // 年間売上と月商換算のセル
  const salesCells = (req: number | null) => req === null
    ? (<><td className="num">—</td><td className="num">—</td></>)
    : (<>
        <td className="num">{fmtYen(req)}</td>
        <td className="num">{fmtYen(req / 12)}</td>
      </>);

  // ---- 変動費/固定費の分類 ----
  const SECTION_LABEL: Record<string, string> = {
    cogs: '売上原価', sga: '販売費及び一般管理費', nonOpExp: '営業外費用',
  };
  const take = (arr: number[]) => arr.slice(0, li + 1).reduce((a, b) => a + b, 0);
  const costRows = plSections(y)
    .filter(x => x.section === 'cogs' || x.section === 'sga' || x.section === 'nonOpExp')
    .filter(x => signedRowValue(x.row, take) !== 0);

  const classToggle = (row: AccountRow, section: PlSection) => {
    const def = defaultCostClass(section)!;
    const cur: CostClass = state.settings.costClass[row.code] ?? def;
    const set = (cls: CostClass) => {
      if (cls === cur) return;
      // 既定と同じ分類に戻したときは上書きを消す（null）
      api.setCostClass(row.code, cls === def ? null : cls);
      rerender();
    };
    return (
      <span className="cc-toggle">
        <button className={cur === 'variable' ? 'on-var' : ''} onClick={() => set('variable')}>変動</button>
        <button className={cur === 'fixed' ? 'on-fix' : ''} onClick={() => set('fixed')}>固定</button>
      </span>
    );
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-title">損益分岐点・必要売上高</h2>
          <p className="page-sub">
            {y.label}・実績 {months}ヶ月分で計算しています。下の「変動費・固定費の分類」を切り替えると、その場で全体が再計算されます。
          </p>
        </div>
        <YearNav years={years} current={y.id} onChange={setYearId} />
      </div>

      <div className="kpi-grid">
        <Kpi label="限界利益率" value={`${(cvp.mcRate * 100).toFixed(1)}%`}
          sub={`限界利益（売上−変動費） ${fmtShort(cvp.sales - cvp.variable)}円`} />
        <Kpi label={`損益分岐点売上高（${months}ヶ月）`}
          value={cvp.bepSales !== null ? `${fmtShort(cvp.bepSales)}円` : '—'}
          sub={cvp.bepSales !== null ? `月商換算 ${fmtShort(cvp.bepSales / Math.max(1, months))}円/月` : '限界利益率がプラスでないため計算不能'} />
        <Kpi label="安全余裕率"
          value={cvp.safety !== null ? `${(cvp.safety * 100).toFixed(1)}%` : '—'}
          delta={cvp.safety !== null ? (cvp.safety >= 0.2 ? '良好' : cvp.safety >= 0.1 ? 'やや注意' : '要改善') : undefined}
          tone={cvp.safety !== null ? (cvp.safety >= 0.2 ? 'good' : cvp.safety >= 0.1 ? 'neutral' : 'bad') : undefined}
          sub="売上があと何%落ちても赤字にならないか" />
        <Kpi label="変動費率" value={`${(varRate * 100).toFixed(1)}%`}
          sub={`変動費 ${fmtShort(cvp.variable)}円 ÷ 売上 ${fmtShort(cvp.sales)}円`} />
      </div>

      {cvp.bepSales === null && (
        <div className="warn-box">
          限界利益率がプラスでない（変動費が売上を上回っている）ため、損益分岐点を計算できません。
          変動費・固定費の分類が実態と合っているか、下の一覧で確認してください。
        </div>
      )}

      <div className="card">
        <h3>実績売上と必要売上の比較<small>年間ベース（実績 {months}ヶ月を年換算）</small></h3>
        <CompareBars baseIndex={0} bars={[
          {
            label: '実績売上（年換算）', value: cvpYear.sales, color: C.blue,
            note: `実績 ${months}ヶ月 ÷ ${months} × 12`,
          },
          {
            label: '損益分岐点（年間）', value: cvpYear.bepSales ?? 0, color: '#c98500',
            note: '利益ゼロになる売上',
          },
          {
            label: '返済確保に必要な売上（年間）', value: repayReq.sales ?? 0, color: '#6d46d9',
            note: '借入返済まで資金が回る売上',
          },
        ]} />
        <Meter ratio={cvp.safety} good={0.2} warn={0.1}
          text={cvp.safety !== null
            ? `安全余裕率 ${(cvp.safety * 100).toFixed(1)}%（目安: 20%以上で良好・10%未満は要改善）`
            : '安全余裕率は計算できません'} />
        <div className="muted">
          実績売上が損益分岐点を上回っていれば黒字です。ただし借入返済は費用にならないため、
          返済まで含めて資金が回るかは「返済確保に必要な売上」との比較で確認します。
        </div>
      </div>

      <div className="card">
        <h3>必要売上高の逆算<small>目標から逆算した「いくら売ればよいか」</small></h3>
        <div className="table-scroll">
          <table className="grid">
            <thead>
              <tr>
                <th>目標</th>
                <th className="num">必要売上高（年間）</th>
                <th className="num">月商換算</th>
                <th className="num">実績・年換算（{fmtYen(cvpYear.sales)}）との差</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>① 利益ゼロ（損益分岐点）</td>
                {salesCells(cvpYear.bepSales)}
                {diffCell(cvpYear.bepSales)}
              </tr>
              <tr>
                <td>
                  ② 目標経常利益{' '}
                  <YenInput value={targetProfit} onChange={setTargetProfit} />
                  {' '}円 を確保
                </td>
                {salesCells(targetReq)}
                {diffCell(targetReq)}
              </tr>
              <tr>
                <td>③ 借入返済原資を確保</td>
                {salesCells(repayReq.sales)}
                {diffCell(repayReq.sales)}
              </tr>
            </tbody>
          </table>
        </div>
        <div className="muted" style={{ marginTop: 8 }}>
          ③の計算: 年間返済額 {yen(annualRepay)}円（直近12ヶ月の返済実績。半年賦・年賦の返済も含む）に対し、
          減価償却費 {yen(annualDep)}円（実績 {months}ヶ月を年換算）は資金流出のない費用なので充当できます。
          不足分は税引後利益で賄う必要があるため、必要税引前利益 ＝（返済額 − 減価償却費）÷（1 −
          実効税率 {taxRate}%）＝ {yen(repayReq.pretaxNeeded)}円 として売上に逆算しています。
        </div>
      </div>

      <div className="card">
        <h3>変動費・固定費の分類<small>切り替えるとこのページ全体が再計算されます</small></h3>
        <div className="muted" style={{ marginBottom: 8 }}>
          既定では「売上原価 ＝ 変動費」「販売費及び一般管理費・営業外費用 ＝ 固定費」として計算しています。
          外注費や運賃など売上に比例して増減する販管費は「変動」に、
          労務費や工場家賃など売上が減っても変わらない原価は「固定」に切り替えると、実態に近い損益分岐点になります。
        </div>
        <div className="table-scroll">
          <table className="grid">
            <thead>
              <tr>
                <th>科目</th>
                <th>区分</th>
                <th className="num">金額（実績 {months}ヶ月）</th>
                <th>分類</th>
              </tr>
            </thead>
            <tbody>
              {costRows.map(({ row, section }) => {
                const def = defaultCostClass(section)!;
                const cur: CostClass = state.settings.costClass[row.code] ?? def;
                return (
                  <tr key={row.code}>
                    <td>{row.name}</td>
                    <td className="muted">{SECTION_LABEL[section]}</td>
                    <td className="num">{fmtYen(signedRowValue(row, take))}</td>
                    <td>
                      {classToggle(row, section)}
                      {cur !== def && <span className="badge info" style={{ marginLeft: 8 }}>既定から変更</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h3>このページの見方</h3>
        <div className="muted">
          <b>損益分岐点売上高</b>は、利益がちょうどゼロになる売上高です（固定費 ÷ 限界利益率で計算）。
          これを下回ると赤字、上回った分に限界利益率を掛けた金額が利益になります。<br />
          <b>安全余裕率</b>は「売上があと何%落ちても赤字にならないか」を示す余裕度で、
          20%以上あれば景気変動への耐性があり、10%を切ると売上の少しの減少で赤字に転落する体質です。<br />
          <b>借入の返済は税引後利益から</b>行います。返済額は経費にならないため、利益がゼロ（損益分岐点ちょうど）では
          返済資金が足りません。減価償却費（お金の出ていかない経費）を充当してもなお不足する分は、
          税金を払った後の利益で確保する必要があり、その分だけ「返済確保に必要な売上」は損益分岐点より高くなります。
          まずは③の必要売上高を月商ベースで意識するのがおすすめです。
        </div>
      </div>
    </div>
  );
}
