'use client'

/**
 * 月次推移（貸借）:
 * 試算表（貸借対照表）の月次推移ピボット表。値はすべて「各月の月末残高」。
 * 行をクリックすると科目ごとの3期比較チャートを表示する。
 * 表示は損益と同じ3モード（当期実績／前期比較／3期比較）で、
 * 【】（）の小計だけを表示する折りたたみ・部分展開・Excel出力に対応する。
 * 残高はストックのため累計列は付けず、最終列は「期末」（取込データの annual）。
 */
import { useState } from 'react';
import { getState } from '@/lib/keiei/kr/api';
import { sortedYears, CODES } from '@/lib/keiei/kr/analysis';
import { buildTrend, matchRow, statementRows, MODE_LABEL } from '@/lib/keiei/kr/trend';
import type { TrendMode } from '@/lib/keiei/kr/trend';
import { C, LineChart, NeedData, YearNav, useYearSelection } from '../ui';
import { TrendPivot, TrendToolbar, useGroupExpansion } from '../TrendPivot';
import type { AccountRow, FiscalYearData } from '@/lib/keiei/kr/types';

export default function TrendBS({ jumpCode }: { jumpCode?: string | null }) {
  const state = getState();
  const years = sortedYears(state);
  const [yearId, setYearId] = useYearSelection(years);
  const [mode, setMode] = useState<TrendMode>('amount');
  // 初期選択は 現金及び預金（資金繰りの起点になる科目）
  const [selCode, setSelCode] = useState<string>(CODES.cash);
  // 上部の検索から科目を指定して来たとき（?code=…）はその科目を選ぶ
  // 移植元は URL の ?code=… で科目を指定していたが、この総合管理アプリは
  // 画面内のタブ切替なのでURLを使わない。親から prop で受け取る形にした。
  const codeParam = jumpCode ?? null;
  const [appliedParam, setAppliedParam] = useState<string | null>(null);
  if (codeParam && codeParam !== appliedParam) {
    setAppliedParam(codeParam);
    setSelCode(codeParam);
  }

  if (!years.length) return (
    <div>
      <h2 className="page-title">月次推移（貸借）</h2>
      <NeedData />
    </div>
  );

  const y = years.find(x => x.id === yearId) ?? years[years.length - 1];
  const bsRows = statementRows(y, 'BS');

  if (!bsRows.length) return (
    <div>
      <h2 className="page-title">月次推移（貸借）</h2>
      <div className="warn-box">この年度には貸借対照表（BS）の行がありません。取込データをご確認ください。</div>
    </div>
  );

  const table = buildTrend(state, y, 'BS', mode);
  const prevY = table.prevYear;
  const prev2Y = table.prev2Year;

  // 選択中の科目（年度切替などで無くなったら現預金→先頭行に戻す）
  const selRow = bsRows.find(r => r.code === selCode)
    ?? bsRows.find(r => r.code === CODES.cash)
    ?? bsRows[0];
  const selPrev = matchRow(prevY, selRow, 'BS');
  const selPrev2 = matchRow(prev2Y, selRow, 'BS');

  /** 年度の実績月だけ値を残す（未到来の月は null にして描かない）。 */
  const clip = (row: AccountRow, yy: FiscalYearData): (number | null)[] =>
    row.monthly.map((v, i) => (i <= yy.lastFilledIndex ? v : null));

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-title">月次推移（貸借）</h2>
          <p className="page-sub">
            試算表（貸借対照表）の月次推移です。<b>BSは各月の月末残高</b>（その時点のストック）を表示します
            （PLのような1ヶ月分の発生額ではありません）。行をクリックするとその科目の3期比較グラフが上に表示されます。
            進行期の未到来月は「—」です。
          </p>
        </div>
        <YearNav years={years} current={y.id} onChange={setYearId} />
      </div>

      <div className="card">
        <h3>{selRow.name}の月次推移<small>3期比較・月末残高（表の行クリックで科目を切替）</small></h3>
        <LineChart labels={table.labels} height={230} series={[
          ...(selPrev2 && prev2Y ? [{ name: prev2Y.label, color: C.gray, values: clip(selPrev2, prev2Y), context: true }] : []),
          ...(selPrev && prevY ? [{ name: prevY.label, color: C.orange, values: clip(selPrev, prevY), context: true }] : []),
          { name: y.label, color: C.blue, values: clip(selRow, y) },
        ]} />
      </div>

      <BSTableCard table={table} mode={mode} setMode={setMode}
        selCode={selRow.code} onSelect={setSelCode} />

      <div className="card">
        <h3>この表の見方</h3>
        <div className="muted">
          貸借対照表（BS）は「その月末時点に何がいくら残っているか」の一覧で、損益計算書（PL）と違って
          1ヶ月分の増減額ではなく残高そのものを見ます。まず「現金及び預金」の推移で資金繰りの体温を確認し、
          売掛金や棚卸資産（在庫）が売上の伸び以上に増えていれば、利益が出ていてもお金が売上債権・在庫に
          寝ている状態なので回収・在庫管理を点検します。借入金の残高が毎月どのくらい減っているかで返済の
          進み具合が分かります。賞与や納税の月は残高が動きやすいため、単月の増減ではなく「前期比較」の
          同月差・同月比で季節要因を除いて比べるのがコツです。行数が多いときは「小計のみ」で
          【】（）の集計行だけにできます。
        </div>
      </div>
    </div>
  );
}

/** 表のカード（モード切替・折りたたみ・Excel出力）。 */
function BSTableCard({ table, mode, setMode, selCode, onSelect }: {
  table: ReturnType<typeof buildTrend>;
  mode: TrendMode;
  setMode: (m: TrendMode) => void;
  selCode: string;
  onSelect: (code: string) => void;
}) {
  const exp = useGroupExpansion(table);
  const prevMissing = mode !== 'amount' && !table.prevYear;
  const prev2Missing = mode === 'three' && !table.prev2Year;

  return (
    <div className="card">
      <h3>貸借対照表の月次推移<small>当期実績値は円単位・各月の月末残高</small></h3>
      <TrendToolbar table={table} mode={mode} setMode={setMode} exp={exp}
        note={mode === 'compare'
          ? `科目ごとに ${MODE_LABEL.compare}（当期実績値／前期実績値／同月差／同月比）の4段で表示します。`
          : mode === 'three'
            ? '科目ごとに 当期／前期／前々期 の月末残高を3段で表示します（差・率は出しません）。'
            : ''} />
      {prevMissing && (
        <div className="warn-box">
          前期（{table.year.endYear - 1}年{table.year.endMonth}月期）のデータが未取込のため、前期の段は「—」になります。
        </div>
      )}
      {prev2Missing && (
        <div className="warn-box">
          前々期（{table.year.endYear - 2}年{table.year.endMonth}月期）のデータが未取込のため、前々期の段は「—」になります。
        </div>
      )}
      <TrendPivot table={table} exp={exp} selCode={selCode} onSelect={onSelect} />
    </div>
  );
}
