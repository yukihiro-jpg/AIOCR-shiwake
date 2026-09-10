'use client'

/**
 * ダッシュボード（顧問先モード）:
 * 損益計算書の並びどおりに、売上高から税引前当期利益までと現金預金残高を
 * 縦に並べた「業績サマリー」。税理士モードのダッシュボードより項目を絞り、
 * 各行の「？」で用語の説明が開く。
 */
import { useState } from 'react';
import { getState } from '@/lib/keiei/kr/api';
import { sortedYears, yearSeries, prevYearOf, calYm, ymLabel } from '@/lib/keiei/kr/analysis';
import { plSummaryMetrics } from '@/lib/keiei/kr/kpi';
import type { KpiMetric } from '@/lib/keiei/kr/kpi';
import { C, ComboChart, KpiTable, NeedData, YearNav, useYearSelection, fmtShort } from '../ui';
import type { KpiRow } from '../ui';

export default function ClientDashboard({ canAsk, onAsk }: {
  canAsk: boolean;
  onAsk: () => void;
}) {
  const state = getState();
  const years = sortedYears(state);
  const [yearId, setYearId] = useYearSelection(years);
  const [memoKeyLoaded, setMemoKeyLoaded] = useState<string>('');
  const [memo, setMemo] = useState('');

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
  const prevOk = !!prevS && !!prevY && prevY.lastFilledIndex >= li;

  // 税理士が入れた所見メモを読み込む（顧問先には読み取り専用で見せる）
  if (memoKeyLoaded !== y.id) {
    setMemoKeyLoaded(y.id);
    setMemo(state.settings.notes[y.id] ?? '');
  }

  const fmtMetric = (m: KpiMetric, v: number | null): string | undefined => {
    if (v === null) return undefined;
    return m.unit === 'pct' ? `${(v * 100).toFixed(1)}%` : `${fmtShort(v)}円`;
  };
  const rows: KpiRow[] = plSummaryMetrics(state, y).map(m => ({
    label: m.label,
    value: fmtMetric(m, m.value) ?? '—',
    prev: fmtMetric(m, m.prev),
    delta: m.deltaText ?? undefined,
    tone: m.tone,
    note: m.note,
    help: m.help,
  }));

  const labels = Array.from({ length: 12 }, (_, i) => `${calYm(y, i).month}月`);
  const vals = (arr: number[], year = y) =>
    arr.map((v, i) => (i <= year.lastFilledIndex ? v : null));

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-title">ダッシュボード</h2>
          <p className="page-sub">
            {y.label}・{li + 1}ヶ月分（{ymLabel(y, 0)}〜{ymLabel(y, li)}）の累計です。
            金額はすべて円単位。各行の「？」で言葉の意味が開きます。
          </p>
        </div>
        <YearNav years={years} current={y.id} onChange={setYearId} />
      </div>

      <KpiTable rows={rows}
        headLabel="業績サマリー"
        currentLabel={`${y.label}（${li + 1}ヶ月）`}
        prevLabel={prevOk ? `前年同期（${prevY!.label}）` : undefined} />

      {canAsk && (
        <div className="card kr-askcta">
          <div>
            <b>この数字について質問できます</b>
            <div className="muted">「一番売上が高かった月は？」「あといくら売れば黒字？」など。</div>
          </div>
          <button onClick={onAsk}>💬 AIに質問する</button>
        </div>
      )}

      <div className="card">
        <h3>売上高の月次推移<small>{prevY ? '前期との比較' : '当期'}</small></h3>
        <ComboChart labels={labels} height={230} bars={[
          ...(prevS ? [{ name: prevY!.label, color: C.gray, values: vals(prevS.sales, prevY!) }] : []),
          { name: y.label, color: C.blue, values: vals(s.sales) },
        ]} />
      </div>

      <div className="card">
        <h3>経常利益の月次推移<small>{prevY ? '前期との比較' : '当期'}</small></h3>
        <ComboChart labels={labels} height={230} bars={[
          ...(prevS ? [{ name: prevY!.label, color: C.gray, values: vals(prevS.ordinary, prevY!) }] : []),
          { name: y.label, color: C.blue, values: vals(s.ordinary) },
        ]} />
      </div>

      {memo.trim() !== '' && (
        <div className="card">
          <h3>担当者からのコメント<small>{y.label}</small></h3>
          <div className="kr-memo-view">{memo}</div>
        </div>
      )}
    </div>
  );
}
