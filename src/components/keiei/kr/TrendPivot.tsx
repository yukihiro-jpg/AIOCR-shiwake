'use client'

// 月次推移表（損益・貸借の共通部品）。
//
// ・表示モードの切替（当期実績／前期比較／3期比較）
// ・折りたたみ（【】〔〕の小計だけ ⇔ 部分展開 ⇔ 全展開）
// ・表示中の内容そのままのExcelダウンロード
// 表データの組み立ては trend.ts、Excel出力は excel.ts に任せる。

import { useEffect, useMemo, useRef, useState } from 'react';
import type { TrendTable, TrendMode } from '@/lib/keiei/kr/trend';
import { MODE_LABEL, groupKeys, statementRows, rowKind } from '@/lib/keiei/kr/trend';
import { exportTrendXlsx } from '@/lib/keiei/kr/excel';
import { getState } from '@/lib/keiei/kr/api';
import { C } from './ui';

/** グループ（小計）の開閉状態。 */
export interface GroupExpansion {
  /** 開いているグループ（小計行のコード） */
  open: Set<string>;
  toggle: (key: string) => void;
  expandAll: () => void;
  collapseAll: () => void;
  allOpen: boolean;
  allClosed: boolean;
}

/** 年度・帳票が変わったら全展開に戻す開閉状態フック。 */
export function useGroupExpansion(table: TrendTable): GroupExpansion {
  const allKeys = useMemo(() => {
    const rows = statementRows(table.year, table.statement);
    return groupKeys(rows).groups;
  }, [table.year, table.statement]);
  const signature = `${table.year.id}:${table.statement}`;
  const [sig, setSig] = useState(signature);
  const [open, setOpen] = useState<Set<string>>(() => new Set(allKeys));
  // 年度や帳票を切り替えたら全展開に戻す（レンダー中に同期する）
  if (sig !== signature) {
    setSig(signature);
    setOpen(new Set(allKeys));
  }
  return {
    open,
    toggle: (key: string) => setOpen(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    }),
    expandAll: () => setOpen(new Set(allKeys)),
    collapseAll: () => setOpen(new Set()),
    allOpen: allKeys.every(k => open.has(k)),
    allClosed: allKeys.every(k => !open.has(k)),
  };
}

/** モード切替・折りたたみ・Excel出力のツールバー。 */
export function TrendToolbar({ table, mode, setMode, exp, note }: {
  table: TrendTable;
  mode: TrendMode;
  setMode: (m: TrendMode) => void;
  exp: GroupExpansion;
  note?: string;
}) {
  const [busy, setBusy] = useState(false);
  const company = getState().client?.name ?? '';

  const modeBtn = (m: TrendMode) => (
    <button key={m} className="secondary small" onClick={() => setMode(m)}
      style={mode === m ? { background: C.blue, borderColor: C.blue, color: '#fff' } : undefined}>
      {MODE_LABEL[m]}
    </button>
  );

  const download = async () => {
    setBusy(true);
    try {
      await exportTrendXlsx(table, company);
    } catch (e) {
      console.error('Excel出力に失敗しました', e);
      alert('Excelの作成に失敗しました。時間をおいて再度お試しください。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="trend-toolbar">
        <span className="muted">表示切替:</span>
        {(['amount', 'compare', 'three'] as const).map(modeBtn)}
        <span className="tb-sep" />
        <span className="muted">表示する行:</span>
        <button className="secondary small" onClick={exp.collapseAll} disabled={exp.allClosed}>小計のみ</button>
        <button className="secondary small" onClick={exp.expandAll} disabled={exp.allOpen}>すべて展開</button>
        <span className="tb-grow" />
        <button className="small" onClick={() => void download()} disabled={busy}>
          {busy ? '作成中…' : `⬇ Excelダウンロード（${MODE_LABEL[mode]}）`}
        </button>
      </div>
      {note && <div className="muted" style={{ marginBottom: 8 }}>{note}</div>}
    </>
  );
}

/** 月次推移のピボット表。 */
export function TrendPivot({ table, exp, selCode, onSelect, onDrill, drillable }: {
  table: TrendTable;
  exp: GroupExpansion;
  selCode: string;
  onSelect: (code: string) => void;
  /**
   * 明細へ降りる（元帳が取り込まれているときだけ渡す）。
   * monthIndex=null はその科目の年間ぶん。
   * 小計行は明細の集まりなので対象にしない（元帳には小計という科目が無い）。
   */
  onDrill?: (row: { code: string; name: string }, monthIndex: number | null) => void;
  /** その科目が元帳にあるか（無い科目でクリックできると空振りになる） */
  drillable?: (row: { code: string; name: string }) => boolean;
}) {
  const showSeg = table.mode !== 'amount';
  const showCum = table.hasCum && table.mode !== 'amount';
  // 選択中の科目が画面外なら、その行までスクロールする（検索から来たとき用）
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const row = wrapRef.current?.querySelector('tr.selected');
    row?.scrollIntoView({ block: 'nearest' });
  }, [selCode, table.mode]);

  return (
    <div className="pivot-wrap" ref={wrapRef}>
      <table className="pivot">
        <thead>
          <tr>
            <th>科目</th>
            {showSeg && <th className="seg-head">区分</th>}
            {table.labels.map((l, i) => <th key={i}>{l}</th>)}
            {showCum && <th className="cum">累計（{table.months}ヶ月）</th>}
            <th className="cum">{table.annualLabel}</th>
          </tr>
        </thead>
        <tbody>
          {table.rows.map((tr, idx) => {
            const kind = rowKind(tr.row);
            const isSub = tr.row.isSubtotal;
            // 明細行は、属するグループが開いているときだけ表示する
            if (!isSub && !exp.open.has(tr.groupKey)) return null;
            const open = exp.open.has(tr.row.code);
            const cls = [
              kind === 'group' ? 'sub' : '',
              kind === 'profit' ? 'profit' : '',
              tr.row.code === selCode ? 'selected' : '',
            ].filter(Boolean).join(' ');

            // 明細へ降りられるのは「小計でない科目」かつ「元帳にその科目がある」場合だけ。
            // 当期実績の段（cur）以外は前期・差・比なので、そこからは降りない。
            const canDrill = !!onDrill && !isSub && (!drillable || drillable(tr.row));

            return tr.segs.map((sg, si) => (
              <tr key={`${tr.row.code}-${idx}-${sg.key}`}
                className={`${cls} seg-${sg.key}${si === 0 ? ' g-start' : ''}`.trim()}
                onClick={() => onSelect(tr.row.code)}>
                {si === 0 && (
                  <th className="acct" rowSpan={tr.segs.length}
                    style={{ paddingLeft: 8 + tr.row.level * 12 }}>
                    {isSub && tr.detailCount > 0 && (
                      <button className="grp-toggle" title={open ? '内訳を隠す' : '内訳を表示'}
                        onClick={e => { e.stopPropagation(); exp.toggle(tr.row.code); }}>
                        {open ? '▼' : '▶'}
                      </button>
                    )}
                    <span>{tr.row.name}</span>
                    {isSub && tr.detailCount > 0 && !open && (
                      <span className="grp-count">{tr.detailCount}</span>
                    )}
                    {canDrill && (
                      <button className="drill" title="この科目の明細（元帳）を今期ぶん見る"
                        onClick={e => { e.stopPropagation(); onDrill!(tr.row, null); }}>🔍</button>
                    )}
                  </th>
                )}
                {showSeg && <th className="seg">{sg.label}</th>}
                {sg.months.map((c, i) => {
                  const cellDrill = canDrill && sg.key === 'cur' && c.kind !== 'none';
                  return (
                    <td key={i}
                      className={[
                        c.kind === 'none' ? 'dim' : c.neg ? 'neg' : '',
                        cellDrill ? 'drillable' : '',
                      ].filter(Boolean).join(' ') || undefined}
                      title={cellDrill ? 'クリックでこの月の明細（元帳）を表示' : undefined}
                      onClick={cellDrill
                        ? e => { e.stopPropagation(); onSelect(tr.row.code); onDrill!(tr.row, i); }
                        : undefined}>
                      {c.text}
                    </td>
                  );
                })}
                {showCum && (
                  <td className={`cum${sg.cum.neg ? ' neg' : ''}`}>{sg.cum.text}</td>
                )}
                <td className={`cum${sg.annual.neg ? ' neg' : ''}`}>{sg.annual.text}</td>
              </tr>
            ));
          })}
        </tbody>
      </table>
    </div>
  );
}
