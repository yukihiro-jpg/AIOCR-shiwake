'use client'

import { useState } from 'react';
import { getState, api } from '@/lib/keiei/kr/api';
import {
  sortedYears, yearSeries, prevYearOf, calYm, insightsOf, timeline,
} from '@/lib/keiei/kr/analysis';
import { kpiMetrics, monthKpiMetrics } from '@/lib/keiei/kr/kpi';
import type { KpiMetric } from '@/lib/keiei/kr/kpi';
import {
  C, ComboChart, KpiTable, LineChart, NeedData, YearNav, useYearSelection, fmtShort,
} from '../ui';
import type { KpiRow } from '../ui';

/**
 * ダッシュボード:
 * 月次報告の冒頭で見る1枚。主要指標の表・売上/経常利益の3期比較・現預金と借入の推移・
 * 自動所見（ルールベースのコメント）・税理士の所見メモ。
 */
export default function Dashboard() {
  const state = getState();
  const years = sortedYears(state);
  const [yearId, setYearId] = useYearSelection(years);
  const [memoKeyLoaded, setMemoKeyLoaded] = useState<string>('');
  const [memo, setMemo] = useState('');
  const [saved, setSaved] = useState(false);

  if (!years.length) return (
    <div>
      <h2 className="page-title">ダッシュボード</h2>
      <NeedData />
    </div>
  );

  const y = years.find(x => x.id === yearId) ?? years[years.length - 1];
  const s = yearSeries(y);
  const li = y.lastFilledIndex;
  const prevY = prevYearOf(state, y);
  const prevS = prevY ? yearSeries(prevY) : null;
  const prev2Y = prevY ? prevYearOf(state, prevY) : null;
  const prev2S = prev2Y ? yearSeries(prev2Y) : null;
  // 前期の同じ月まで実績が揃っているか（揃っていない月は比較しない）
  const prevOk = !!prevS && !!prevY && prevY.lastFilledIndex >= li;


  // 年度を切り替えたらメモを読み直す（レンダー中に同期する）
  if (memoKeyLoaded !== y.id) {
    setMemoKeyLoaded(y.id);
    setMemo(state.settings.notes[y.id] ?? '');
    setSaved(false);
  }

  // ---- 主要指標の表（kpi.ts と共有。Excelの「主要指標」シートも同じ数字） ----
  const fmtMetric = (m: KpiMetric, v: number | null): string | undefined => {
    if (v === null) return undefined;
    return m.unit === 'pct' ? `${(v * 100).toFixed(1)}%` : `${fmtShort(v)}円`;
  };
  const toRow = (m: KpiMetric): KpiRow => ({
    label: m.label,
    value: fmtMetric(m, m.value) ?? '—',
    prev: fmtMetric(m, m.prev),
    delta: m.deltaText ?? undefined,
    tone: m.tone,
    note: m.note,
    help: m.help,
  });
  const rows: KpiRow[] = kpiMetrics(state, y).map(toRow);
  // 報告月（最終実績月）の単月の数字
  const monthRows: KpiRow[] = monthKpiMetrics(state, y).map(toRow);
  const rep = calYm(y, li);

  // ---- チャート ----
  const labels = Array.from({ length: 12 }, (_, i) => `${calYm(y, i).month}月`);
  const vals = (arr: number[], year = y) =>
    arr.map((v, i) => (i <= year.lastFilledIndex ? v : null));
  const tl = timeline(state);

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-title">ダッシュボード</h2>
          <p className="page-sub">
            {y.label}・{li + 1}ヶ月分の実績で集計しています。金額はすべて円単位、グラフの棒や点にカーソルを合わせると金額が出ます。
          </p>
        </div>
        <YearNav years={years} current={y.id} onChange={setYearId} />
      </div>

      <KpiTable rows={rows}
        currentLabel={`${y.label}（${li + 1}ヶ月）`}
        prevLabel={prevOk ? `前年同期（${prevY!.label}）` : undefined} />

      <KpiTable rows={monthRows}
        headLabel={`報告月の単月実績（${rep.year}年${rep.month}月）`}
        currentLabel={`${rep.month}月 単月`}
        prevLabel={prevOk ? '前年同月' : undefined} />

      <div className="card">
        <h3>自動所見<small>数値から機械的に読み取れるポイント</small></h3>
        <ul className="kr-insights">
          {insightsOf(state, y).map((ins, i) => (
            <li key={i}><span className={`dot ${ins.tone}`} />{ins.text}</li>
          ))}
        </ul>
      </div>

      <div className="card">
        <h3>売上高の月次推移<small>3期比較（単月）</small></h3>
        <ComboChart labels={labels} height={230} bars={[
          ...(prev2S ? [{ name: prev2Y!.label, color: C.gray, values: vals(prev2S.sales, prev2Y!) }] : []),
          ...(prevS ? [{ name: prevY!.label, color: C.orange, values: vals(prevS.sales, prevY!) }] : []),
          { name: y.label, color: C.blue, values: vals(s.sales) },
        ]} />
      </div>

      <div className="card">
        <h3>経常利益の月次推移<small>3期比較（単月）</small></h3>
        <ComboChart labels={labels} height={230} bars={[
          ...(prev2S ? [{ name: prev2Y!.label, color: C.gray, values: vals(prev2S.ordinary, prev2Y!) }] : []),
          ...(prevS ? [{ name: prevY!.label, color: C.orange, values: vals(prevS.ordinary, prevY!) }] : []),
          { name: y.label, color: C.blue, values: vals(s.ordinary) },
        ]} />
      </div>

      <div className="card">
        <h3>現預金と有利子負債の推移<small>全期間（月末残高）</small></h3>
        <LineChart labels={tl.map(p => p.label)} height={230} series={[
          { name: '現預金', color: C.blue, values: tl.map(p => p.s.cash[p.mi]) },
          { name: '有利子負債（借入・社債・リース）', color: C.red, values: tl.map(p => p.s.debt[p.mi] + p.s.lease[p.mi]) },
        ]} />
        <div className="muted">現預金が有利子負債を上回っていれば実質無借金です。差が縮む月は資金繰りの動きを「CF計算書」で確認してください。</div>
      </div>

      <div className="card">
        <h3>所見メモ<small>{y.label}の報告メモ（自動保存ではありません）</small></h3>
        <textarea value={memo} placeholder="例: 6月は大型案件の入金で現預金が増加。7月は賞与支給と納税で減少見込み。"
          onChange={e => { setMemo(e.target.value); setSaved(false); }} />
        <div style={{ marginTop: 8, display: 'flex', gap: 10, alignItems: 'center' }}>
          <button onClick={() => { api.setNote(y.id, memo); setSaved(true); }}>メモを保存</button>
          {saved && <span className="kr-note-saved">✔ 保存しました</span>}
        </div>
      </div>
    </div>
  );
}
