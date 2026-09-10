'use client'

/**
 * 月次推移（損益）:
 * 試算表PLの全科目を12ヶ月のピボット表で一覧するページ。
 * 行をクリックすると科目を選択でき、表の上に3期比較の棒グラフを表示する。
 * 表示は3モード:
 *   当期実績 … 当期の実績値のみ（1科目1段）
 *   前期比較 … 当期実績値／前期実績値／同月差／同月比（1科目4段）
 *   3期比較 … 当期／前期／前々期の実績値（1科目3段。差・率は出さない）
 * 【】〔〕の小計だけを表示する折りたたみ、科目グループごとの部分展開、
 * 表示中の内容そのままのExcelダウンロードに対応する。
 */
import { useState } from 'react';
import { getState } from '@/lib/keiei/kr/api';
import { sortedYears, calYm, CODES } from '@/lib/keiei/kr/analysis';
import { buildTrend, matchRow, statementRows, MODE_LABEL } from '@/lib/keiei/kr/trend';
import type { TrendMode } from '@/lib/keiei/kr/trend';
import { C, ComboChart, NeedData, YearNav, useYearSelection } from '../ui';
import { TrendPivot, TrendToolbar, useGroupExpansion } from '../TrendPivot';
import type { AccountRow, FiscalYearData } from '@/lib/keiei/kr/types';

export default function TrendPL({ jumpCode }: { jumpCode?: string | null }) {
  const state = getState();
  const years = sortedYears(state);
  const [yearId, setYearId] = useYearSelection(years);
  const [mode, setMode] = useState<TrendMode>('amount');
  // 初期選択は 純売上高（9534）
  const [selCode, setSelCode] = useState<string>(CODES.sales);
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
      <h2 className="page-title">月次推移（損益）</h2>
      <NeedData />
    </div>
  );

  const y = years.find(x => x.id === yearId) ?? years[years.length - 1];
  const li = y.lastFilledIndex;
  const plRows = statementRows(y, 'PL');

  if (!plRows.length) return (
    <div>
      <h2 className="page-title">月次推移（損益）</h2>
      <div className="warn-box">この年度には損益計算書（PL）の行がありません。取込データをご確認ください。</div>
    </div>
  );

  const table = buildTrend(state, y, 'PL', mode);
  const prevY = table.prevYear;
  const prev2Y = table.prev2Year;

  // 選択科目（年度を切り替えて同じコードが無ければ純売上高→先頭行にフォールバック）
  const selRow = plRows.find(r => r.code === selCode)
    ?? plRows.find(r => r.code === CODES.sales)
    ?? plRows[0];
  const prevSel = matchRow(prevY, selRow, 'PL');
  const prev2Sel = matchRow(prev2Y, selRow, 'PL');

  const labels = table.labels;
  const chartVals = (yy: FiscalYearData, r: AccountRow): (number | null)[] =>
    Array.from({ length: 12 }, (_, i) => (i <= yy.lastFilledIndex ? r.monthly[i] : null));

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-title">月次推移（損益）</h2>
          <p className="page-sub">
            {y.label}・{li + 1}ヶ月分の実績です。
            {li < 11 && `進行期のため ${calYm(y, li).month}月まで表示し、それ以降の月は「—」になります。`}
            表の行をクリックすると、その科目の3期比較グラフが上に表示されます。
          </p>
        </div>
        <YearNav years={years} current={y.id} onChange={setYearId} />
      </div>

      <div className="card">
        <h3>{selRow.name}の月次推移<small>3期比較（表の行クリックで科目を切替）</small></h3>
        <ComboChart labels={labels} height={230} bars={[
          ...(prev2Y && prev2Sel ? [{ name: prev2Y.label, color: C.gray, values: chartVals(prev2Y, prev2Sel) }] : []),
          ...(prevY && prevSel ? [{ name: prevY.label, color: C.orange, values: chartVals(prevY, prevSel) }] : []),
          { name: y.label, color: C.blue, values: chartVals(y, selRow) },
        ]} />
      </div>

      <PLTableCard table={table} mode={mode} setMode={setMode}
        selCode={selRow.code} onSelect={setSelCode} />

      <div className="card">
        <h3>このページの見方</h3>
        <div className="muted">
          毎月の損益を12ヶ月横に並べた表です。まず「前期比較」で売上高と売上総利益（粗利）が前年より伸びているかをご覧ください
          （科目ごとに 当期実績値・前期実績値・同月差・同月比 の4段になります）。「3期比較」にすると当期・前期・前々期の実績値が
          3段で並び、2期前からの流れが分かります。赤い数字はマイナス・前年割れです。単月の凸凹は入金・請求のタイミングで
          起こることも多いので、傾向は右端の「累計（報告月まで）」で判断します。行数が多いときは「小計のみ」を押すと
          【】〔〕の集計行だけになり、見たい科目の ▶ を押せばその部分だけ開けます。
        </div>
      </div>
    </div>
  );
}

/** 表のカード（モード切替・折りたたみ・Excel出力）。 */
function PLTableCard({ table, mode, setMode, selCode, onSelect }: {
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
      <h3>損益計算書の月次推移<small>当期実績値は円単位</small></h3>
      <TrendToolbar table={table} mode={mode} setMode={setMode} exp={exp}
        note={mode === 'compare'
          ? `科目ごとに ${MODE_LABEL.compare}（当期実績値／前期実績値／同月差／同月比）の4段で表示します。`
          : mode === 'three'
            ? '科目ごとに 当期／前期／前々期 の実績値を3段で表示します（差・率は出しません）。'
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
