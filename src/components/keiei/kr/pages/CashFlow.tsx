'use client'

/**
 * CF計算書（簡便法）:
 * 貸借対照表の月次増減から作る間接法の月次キャッシュ・フロー計算書。
 * 上段: 期首現預金 → 営業CF → 投資CF → 財務CF → 期末現預金 のウォーターフォール。
 * 中段: 月次の現預金増減バー（プラス=青・マイナス=赤）。
 * 下段: 区分別の明細表（各月＋合計）。計算はすべて analysis.ts の cashFlowOf に委ねる。
 */
import { getState } from '@/lib/keiei/kr/api';
import { sortedYears, yearSeries, cashFlowOf, calYm, yen, CF_ROWS } from '@/lib/keiei/kr/analysis';
import type { CfMonth, CfRowDef } from '@/lib/keiei/kr/analysis';
import {
  Waterfall, BarChart, NeedData, YearNav, useYearSelection,
} from '../ui';


export default function CashFlow() {
  const state = getState();
  const years = sortedYears(state);
  const [yearId, setYearId] = useYearSelection(years);
  if (!years.length) return (
    <div>
      <h2 className="page-title">CF計算書（簡便法）</h2>
      <NeedData />
    </div>
  );

  const y = years.find(x => x.id === yearId) ?? years[years.length - 1];
  const s = yearSeries(y);
  const li = y.lastFilledIndex;
  const cf = cashFlowOf(state, y);

  // 期末現預金は最終実績月のBS残高。期首はそこから期間中の増減を巻き戻して求める
  const closing = s.cash[li];
  const opening = closing - cf.sums.dCash;

  // 明細表・バーの列は年度の12ヶ月。計算できた月（cf.months）を列番号で引く
  const monthAt = new Map(cf.months.map(m => [m.mi, m]));
  const monthLabels = Array.from({ length: 12 }, (_, i) => `${calYm(y, i).month}月`);

  // 表のセル（計算できない月・未到来の月は '—'）
  const cell = (i: number, row: CfRowDef) => {
    const m = monthAt.get(i);
    if (!m) return <td key={i} className="num dim">—</td>;
    const v = row.pick(m);
    return <td key={i} className={`num${v < 0 ? ' neg' : ''}`}>{yen(v)}</td>;
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-title">CF計算書（簡便法）</h2>
          <p className="page-sub">
            {y.label}・{cf.months.length}ヶ月分を集計しています。貸借対照表の増減から作る間接法の簡便版で、
            「利益は出ているのにお金が増えない」理由を営業・投資・財務の3区分に分けて確認できます。
          </p>
        </div>
        <YearNav years={years} current={y.id} onChange={setYearId} />
      </div>

      {!cf.hasOpening && (
        <div className="warn-box">
          前期データが無いため期首（前期末）の残高が分からず、第2月からの集計になっています。
          前期の月次データを取り込むと期首からの通年集計になります。
        </div>
      )}

      {cf.months.length === 0 ? (
        <div className="card">
          <b>この年度はまだ集計できる月がありません。</b>
          <div className="muted">前期データが無い年度は第2月から集計するため、実績が2ヶ月以上入ると表示されます。</div>
        </div>
      ) : (
        <>
          <div className="card">
            <h3>現預金の増減の内訳<small>期首から期末までの動き（{cf.months.length}ヶ月累計）</small></h3>
            <Waterfall items={[
              { label: '期首現預金', value: opening, kind: 'total' },
              { label: '営業CF', value: cf.sums.opCf, kind: 'flow' },
              { label: '投資CF', value: cf.sums.invCf, kind: 'flow' },
              { label: '財務CF', value: cf.sums.finCf, kind: 'flow' },
              { label: '期末現預金', value: closing, kind: 'total' },
            ]} />
            <div className="muted">
              営業CF（本業の稼ぎ）がプラスで、その範囲で投資と借入返済（財務CFのマイナス）が
              まかなえているのが健全な形です。
            </div>
          </div>

          <div className="card">
            <h3>月次の現預金増減<small>プラス=増加・マイナス=減少</small></h3>
            <BarChart diverging name="現預金の増減"
              labels={monthLabels}
              values={Array.from({ length: 12 }, (_, i) => monthAt.get(i)?.dCash ?? null)} />
          </div>

          <div className="card">
            <h3>月次CF計算書の明細<small>単位: 円</small></h3>
            <div className="table-scroll">
              <table className="grid">
                <thead>
                  <tr>
                    <th className="cf-item">項目</th>
                    {monthLabels.map((l, i) => <th key={i} className="num">{l}</th>)}
                    <th className="num">合計</th>
                  </tr>
                </thead>
                <tbody>
                  {CF_ROWS.filter(row => !row.optional || row.pick(cf.sums) !== 0).map(row => {
                    const total = row.pick(cf.sums);
                    return (
                      <tr key={row.label}
                        className={row.last ? 'total' : row.section ? 'cf-section' : undefined}>
                        <td className={`cf-item${row.indent ? ' cf-indent' : ''}`}>{row.label}</td>
                        {Array.from({ length: 12 }, (_, i) => cell(i, row))}
                        <td className={`num${total < 0 ? ' neg' : ''}`}>{yen(total)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="muted" style={{ marginTop: 8 }}>
              ※ 各区分は「区分計」を先に、その内訳を1文字下げて並べています。内訳はいずれも
              「資金への影響額」で表示しているため、内訳を足すとその区分の計と一致します。
              売上債権・棚卸資産は増えるとお金が減るため符号を反転（プラス＝回収が進んで資金増）、
              仕入債務は増えるとお金が残るためそのまま表示しています。
            </div>
          </div>
        </>
      )}

      <div className="card">
        <h3>このCF計算書の見方</h3>
        <div className="muted">
          この表は会計帳簿とは別に作るものではなく、毎月の貸借対照表の増減から機械的に組み立てる
          「間接法」の簡便なキャッシュ・フロー計算書です。すべてのBS科目を営業・投資・財務のどれか1つの
          区分に割り当てているため、「営業CF＋投資CF＋財務CF＝現預金の増減」が必ず一致します
          （現預金の実際の増減と食い違うことはありません）。損益計算書の利益と現預金の動きのズレは、
          主に売掛金・在庫・買掛金といった運転資本の増減、設備投資、借入の調達・返済で生まれます。
          「利益は出ているのに現預金が減っている月」は、この表でどの区分が原因かを確認してください。
        </div>
      </div>
    </div>
  );
}
