'use client'

// 月次レポート・ビューアの共通UI部品（SVGチャート・KPIタイル・スライダー等）。
// 顧問先用アプリ（komon-app/src/apps/keiei-report/components.tsx）から移植。
// 変更点: 'use client' の付与、React.MouseEvent の名前付きimport化、
//        表のクラス名 grid → kr-grid（Tailwind の .grid と衝突するため）。
// グラフはSVGを自前で描いており外部ライブラリに依存しない（CDN禁止の決まりに元から適合）。
//
// チャートの流儀（全チャート共通）:
// - 線は2px・点は8px以上（白フチ2px）、バーは太さ24px以下・上端4px角丸
// - 罫線は実線ヘアライン1本色（点線にしない）、軸ラベルはグレー
// - 2系列以上は必ず凡例を出す。色は「系列の意味」に固定（当期=青、前期=グレー等）
// - ホバーで金額ツールチップ。値は表（各ページのテーブル）でも必ず読める
// - 予測部分は点線で描き実績と区別する

import { useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';

export function useRerender(): () => void {
  const [, set] = useState(0);
  return () => set(x => x + 1);
}

// ---------------------------------------------------------------------------
// 色（dataviz 検証済みパレット）
// ---------------------------------------------------------------------------

export const C = {
  blue: '#2a78d6',    // 当期・主系列
  orange: '#eb6834',  // 第2系列
  aqua: '#1baf7a',    // 第3系列
  red: '#e34948',     // マイナス（分岐の赤極）
  gray: '#b5b3ac',    // 前期などの文脈系列
  grayDark: '#898781',
  grid: '#e1e0d9',
  axis: '#c3c2b7',
  ink: '#0b0b0b',
  inkSub: '#52514e',
  surface: '#fcfcfb',
  good: '#0ca30c',
  warn: '#c98500',
  bad: '#d03b3b',
} as const;

// ---------------------------------------------------------------------------
// 金額の表示
// ---------------------------------------------------------------------------

/** 軸ラベル用の短い金額（1.2億 / 3,500万 / 1,200 円）。 */
export function fmtShort(n: number): string {
  const a = Math.abs(Math.round(n) || 0);
  const sign = n < 0 ? '−' : '';
  if (a >= 1e8) return `${sign}${(a / 1e8).toLocaleString('ja-JP', { maximumFractionDigits: 1 })}億`;
  if (a >= 1e4) return `${sign}${Math.round(a / 1e4).toLocaleString('ja-JP')}万`;
  return `${sign}${Math.round(a).toLocaleString('ja-JP')}`;
}

/** ツールチップ・表用のフル金額。 */
export const fmtYen = (n: number): string => `${(Math.round(n) || 0).toLocaleString('ja-JP')}円`;

/** きりのよい軸目盛りを作る。 */
function niceTicks(min: number, max: number, count = 4): number[] {
  if (min === max) { max = min + 1; }
  const span = max - min;
  const step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => span / s <= count + 0.5) ?? mag * 10;
  const start = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let v = start; v <= max + 1e-9; v += step) out.push(v);
  return out;
}

// ---------------------------------------------------------------------------
// ツールチップ（HTML・チャート共通）
// ---------------------------------------------------------------------------

interface TipState { leftPct: number; topPct: number; title: string; lines: { color?: string; label: string; value: string }[] }

function Tip({ tip }: { tip: TipState | null }) {
  if (!tip) return null;
  const right = tip.leftPct > 60;
  return (
    <div className="kr-tip" style={{
      left: `${tip.leftPct}%`, top: `${tip.topPct}%`,
      transform: right ? 'translate(-100%, -8px)' : 'translate(10px, -8px)',
    }}>
      <div className="kr-tip-title">{tip.title}</div>
      {tip.lines.map((l, i) => (
        <div key={i} className="kr-tip-line">
          {l.color && <i style={{ background: l.color }} />}
          <span>{l.label}</span><b>{l.value}</b>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 折れ線チャート（複数系列・予測点線・ホバークロスヘア）
// ---------------------------------------------------------------------------

export interface LineSeries {
  name: string;
  color: string;
  values: (number | null)[];   // null は欠測（描画しない）
  /** この番号以降の区間を点線で描く（予測）。省略で全区間実線 */
  dashedFrom?: number;
  /** 文脈系列（細め・マーカー無し） */
  context?: boolean;
}

export function LineChart({ labels, series, height = 240, unitHint = '', format = fmtYen, axisFormat = fmtShort }: {
  labels: string[];
  series: LineSeries[];
  height?: number;
  unitHint?: string;
  /** ツールチップの値表示（既定は円） */
  format?: (n: number) => string;
  /** 軸目盛りの表示（既定は 億/万 の短縮） */
  axisFormat?: (n: number) => string;
}) {
  const W = 760; const H = height;
  const padL = 58; const padR = 14; const padT = 14; const padB = 26;
  const [hover, setHover] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const all = series.flatMap(s => s.values.filter((v): v is number => v !== null));
  const dataMin = Math.min(0, ...all);
  const dataMax = Math.max(0, ...all);
  const ticks = niceTicks(dataMin, dataMax);
  const lo = Math.min(dataMin, ticks[0] ?? 0);
  const hi = Math.max(dataMax, ticks[ticks.length - 1] ?? 1);
  const x = (i: number) => padL + (labels.length <= 1 ? 0 : (i / (labels.length - 1)) * (W - padL - padR));
  const yv = (v: number) => padT + (1 - (v - lo) / Math.max(1, hi - lo)) * (H - padT - padB);

  const onMove = (e: ReactMouseEvent) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0; let bestD = Infinity;
    for (let i = 0; i < labels.length; i++) {
      const d = Math.abs(x(i) - px);
      if (d < bestD) { bestD = d; best = i; }
    }
    setHover(best);
  };

  const tip: TipState | null = hover === null ? null : {
    leftPct: (x(hover) / W) * 100,
    topPct: 8,
    title: labels[hover],
    lines: series
      .filter(s => s.values[hover] !== null && s.values[hover] !== undefined)
      .map(s => ({ color: s.color, label: s.name, value: format(s.values[hover] as number) })),
  };

  return (
    <div>
      {series.length >= 2 && (
        <div className="kr-legend">
          {series.map(s => <span key={s.name}><i style={{ background: s.color }} />{s.name}</span>)}
          {unitHint && <span className="kr-unit">{unitHint}</span>}
        </div>
      )}
      <div className="kr-chart" ref={wrapRef} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img">
          {ticks.map(t => (
            <g key={t}>
              <line x1={padL} x2={W - padR} y1={yv(t)} y2={yv(t)}
                stroke={t === 0 ? C.axis : C.grid} strokeWidth={1} />
              <text x={padL - 6} y={yv(t) + 3.5} textAnchor="end" fontSize={10.5} fill={C.grayDark}>{axisFormat(t)}</text>
            </g>
          ))}
          {labels.map((l, i) => (
            (labels.length <= 13 || i % 2 === 0) && (
              <text key={i} x={x(i)} y={H - 8} textAnchor="middle" fontSize={10.5} fill={C.grayDark}>{l}</text>
            )
          ))}
          {hover !== null && (
            <line x1={x(hover)} x2={x(hover)} y1={padT} y2={H - padB} stroke={C.axis} strokeWidth={1} />
          )}
          {series.map(s => {
            const solid: string[] = []; const dashed: string[] = [];
            let prevOk = false;
            s.values.forEach((v, i) => {
              if (v === null || v === undefined) { prevOk = false; return; }
              const pt = `${x(i)},${yv(v)}`;
              const seg = s.dashedFrom !== undefined && i >= s.dashedFrom ? dashed : solid;
              // 点線区間の始点は実線の最終点から続ける
              if (seg === dashed && dashed.length === 0 && solid.length > 0) dashed.push(solid[solid.length - 1]);
              if (!prevOk) seg.push(pt); else seg.push(pt);
              prevOk = true;
            });
            const w = s.context ? 1.5 : 2;
            return (
              <g key={s.name}>
                {solid.length > 1 && <polyline points={solid.join(' ')} fill="none" stroke={s.color} strokeWidth={w} strokeLinejoin="round" strokeLinecap="round" />}
                {dashed.length > 1 && <polyline points={dashed.join(' ')} fill="none" stroke={s.color} strokeWidth={w} strokeDasharray="5 4" strokeLinejoin="round" strokeLinecap="round" />}
                {!s.context && s.values.map((v, i) => v === null || v === undefined ? null : (
                  <circle key={i} cx={x(i)} cy={yv(v)} r={hover === i ? 4.5 : 3.5}
                    fill={s.color} stroke={C.surface} strokeWidth={2} />
                ))}
              </g>
            );
          })}
        </svg>
        <Tip tip={tip} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 棒チャート（正負対応・単一色 or 正負で青/赤）
// ---------------------------------------------------------------------------

export function BarChart({ labels, values, height = 220, color = C.blue, diverging = false, name = '', format = fmtYen, axisFormat = fmtShort }: {
  labels: string[];
  values: (number | null)[];
  height?: number;
  color?: string;
  /** true なら プラス=青 / マイナス=赤 で塗る（CFの月次など極性が主題のとき） */
  diverging?: boolean;
  name?: string;
  format?: (n: number) => string;
  axisFormat?: (n: number) => string;
}) {
  const W = 760; const H = height;
  const padL = 58; const padR = 14; const padT = 12; const padB = 26;
  const [hover, setHover] = useState<number | null>(null);

  const nums = values.filter((v): v is number => v !== null);
  const lo = Math.min(0, ...nums);
  const hi = Math.max(0, ...nums);
  const ticks = niceTicks(lo, hi);
  const yv = (v: number) => padT + (1 - (v - lo) / Math.max(1, hi - lo)) * (H - padT - padB);
  const slot = (W - padL - padR) / Math.max(1, labels.length);
  const bw = Math.min(24, slot - 2);

  const tip: TipState | null = hover === null || values[hover] === null ? null : {
    leftPct: ((padL + slot * hover + slot / 2) / W) * 100,
    topPct: 8,
    title: labels[hover],
    lines: [{ label: name || '金額', value: format(values[hover] as number) }],
  };

  return (
    <div className="kr-chart" onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img">
        {ticks.map(t => (
          <g key={t}>
            <line x1={padL} x2={W - padR} y1={yv(t)} y2={yv(t)}
              stroke={t === 0 ? C.axis : C.grid} strokeWidth={1} />
            <text x={padL - 6} y={yv(t) + 3.5} textAnchor="end" fontSize={10.5} fill={C.grayDark}>{axisFormat(t)}</text>
          </g>
        ))}
        {labels.map((l, i) => (
          (labels.length <= 13 || i % 2 === 0) && (
            <text key={i} x={padL + slot * i + slot / 2} y={H - 8} textAnchor="middle" fontSize={10.5} fill={C.grayDark}>{l}</text>
          )
        ))}
        {values.map((v, i) => {
          if (v === null) return null;
          const cx = padL + slot * i + slot / 2;
          const y0 = yv(0); const y1 = yv(v);
          const top = Math.min(y0, y1); const h = Math.max(1, Math.abs(y0 - y1));
          const fill = diverging ? (v >= 0 ? C.blue : C.red) : color;
          const r = Math.min(4, bw / 2, h);
          // 上端（マイナスは下端）だけ角丸にするパス
          const up = v >= 0;
          const path = up
            ? `M${cx - bw / 2},${top + h} V${top + r} Q${cx - bw / 2},${top} ${cx - bw / 2 + r},${top} H${cx + bw / 2 - r} Q${cx + bw / 2},${top} ${cx + bw / 2},${top + r} V${top + h} Z`
            : `M${cx - bw / 2},${top} V${top + h - r} Q${cx - bw / 2},${top + h} ${cx - bw / 2 + r},${top + h} H${cx + bw / 2 - r} Q${cx + bw / 2},${top + h} ${cx + bw / 2},${top + h - r} V${top} Z`;
          return (
            <path key={i} d={path} fill={fill} opacity={hover === null || hover === i ? 1 : 0.45}
              onMouseEnter={() => setHover(i)} />
          );
        })}
        {/* 当たり判定を広く */}
        {labels.map((_, i) => (
          <rect key={i} x={padL + slot * i} y={padT} width={slot} height={H - padT - padB}
            fill="transparent" onMouseEnter={() => setHover(i)} />
        ))}
      </svg>
      <Tip tip={tip} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 棒チャート（複数系列・横並び）／棒＋線の複合チャート
// ---------------------------------------------------------------------------

export interface BarSeries {
  name: string;
  color: string;
  values: (number | null)[];
  /** この番号以降を予測として淡く描く（省略で全部実績） */
  dashedFrom?: number;
}

/** 上端（マイナスは下端）だけ角丸にする棒のパス。 */
function barPath(cx: number, bw: number, y0: number, y1: number): string {
  const top = Math.min(y0, y1);
  const h = Math.max(1, Math.abs(y0 - y1));
  const r = Math.min(4, bw / 2, h);
  return y1 <= y0
    ? `M${cx - bw / 2},${top + h} V${top + r} Q${cx - bw / 2},${top} ${cx - bw / 2 + r},${top} H${cx + bw / 2 - r} Q${cx + bw / 2},${top} ${cx + bw / 2},${top + r} V${top + h} Z`
    : `M${cx - bw / 2},${top} V${top + h - r} Q${cx - bw / 2},${top + h} ${cx - bw / 2 + r},${top + h} H${cx + bw / 2 - r} Q${cx + bw / 2},${top + h} ${cx + bw / 2},${top + h - r} V${top} Z`;
}

/**
 * 棒＋線の複合チャート（同じ金額軸を共有する。軸は必ず1本）。
 * bars: 単月の金額など／lines: 累計の金額など。
 * bars だけ渡せば複数系列の棒グラフになる。
 */
export function ComboChart({ labels, bars = [], lines = [], height = 230, unitHint = '', format = fmtYen, axisFormat = fmtShort }: {
  labels: string[];
  bars?: BarSeries[];
  lines?: LineSeries[];
  height?: number;
  unitHint?: string;
  format?: (n: number) => string;
  axisFormat?: (n: number) => string;
}) {
  const W = 760; const H = height;
  const padL = 58; const padR = 14; const padT = 14; const padB = 26;
  const [hover, setHover] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const all = [...bars, ...lines].flatMap(s => s.values.filter((v): v is number => v !== null));
  const ticks = niceTicks(Math.min(0, ...all), Math.max(0, ...all));
  const lo = Math.min(0, ...all, ticks[0] ?? 0);
  const hi = Math.max(0, ...all, ticks[ticks.length - 1] ?? 1);
  const yv = (v: number) => padT + (1 - (v - lo) / Math.max(1, hi - lo)) * (H - padT - padB);
  const slot = (W - padL - padR) / Math.max(1, labels.length);
  const cxOf = (i: number) => padL + slot * i + slot / 2;
  // 系列を横並びに置く（棒どうしは2pxのすき間で分ける）
  const groupW = Math.min(slot - 6, 30 * Math.max(1, bars.length));
  const bw = bars.length ? Math.max(3, groupW / bars.length - 2) : 0;
  const barX = (i: number, si: number) => cxOf(i) - groupW / 2 + (bw + 2) * si + bw / 2;

  const tip: TipState | null = hover === null ? null : {
    leftPct: (cxOf(hover) / W) * 100, topPct: 6,
    title: labels[hover],
    lines: [...bars, ...lines]
      .filter(s => s.values[hover] !== null && s.values[hover] !== undefined)
      .map(s => ({ color: s.color, label: s.name, value: format(s.values[hover] as number) })),
  };

  const onMove = (e: ReactMouseEvent) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = ((e.clientX - rect.left) / rect.width) * W;
    setHover(Math.max(0, Math.min(labels.length - 1, Math.floor((px - padL) / slot))));
  };

  return (
    <div>
      {bars.length + lines.length >= 2 && (
        <div className="kr-legend">
          {bars.map(s => <span key={`b-${s.name}`}><i style={{ background: s.color }} />{s.name}</span>)}
          {lines.map(s => <span key={`l-${s.name}`}><i className="ln" style={{ background: s.color }} />{s.name}</span>)}
          {unitHint && <span className="kr-unit">{unitHint}</span>}
        </div>
      )}
      <div className="kr-chart" ref={wrapRef} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img">
          {ticks.map(t => (
            <g key={t}>
              <line x1={padL} x2={W - padR} y1={yv(t)} y2={yv(t)} stroke={t === 0 ? C.axis : C.grid} strokeWidth={1} />
              <text x={padL - 6} y={yv(t) + 3.5} textAnchor="end" fontSize={10.5} fill={C.grayDark}>{axisFormat(t)}</text>
            </g>
          ))}
          {labels.map((l, i) => (
            (labels.length <= 13 || i % 2 === 0) && (
              <text key={i} x={cxOf(i)} y={H - 8} textAnchor="middle" fontSize={10.5} fill={C.grayDark}>{l}</text>
            )
          ))}
          {bars.map((s, si) => (
            <g key={s.name}>
              {s.values.map((v, i) => v === null || v === undefined ? null : (
                <path key={i} d={barPath(barX(i, si), bw, yv(0), yv(v))} fill={s.color}
                  opacity={(s.dashedFrom !== undefined && i >= s.dashedFrom ? 0.45 : 1)
                    * (hover === null || hover === i ? 1 : 0.55)} />
              ))}
            </g>
          ))}
          {lines.map(s => {
            const solid: string[] = []; const dashed: string[] = [];
            s.values.forEach((v, i) => {
              if (v === null || v === undefined) return;
              const pt = `${cxOf(i)},${yv(v)}`;
              const seg = s.dashedFrom !== undefined && i >= s.dashedFrom ? dashed : solid;
              if (seg === dashed && dashed.length === 0 && solid.length > 0) dashed.push(solid[solid.length - 1]);
              seg.push(pt);
            });
            return (
              <g key={s.name}>
                {solid.length > 1 && <polyline points={solid.join(' ')} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
                {dashed.length > 1 && <polyline points={dashed.join(' ')} fill="none" stroke={s.color} strokeWidth={2} strokeDasharray="5 4" strokeLinejoin="round" strokeLinecap="round" />}
                {s.values.map((v, i) => v === null || v === undefined ? null : (
                  <circle key={i} cx={cxOf(i)} cy={yv(v)} r={hover === i ? 4.5 : 3.5}
                    fill={s.color} stroke={C.surface} strokeWidth={2} />
                ))}
              </g>
            );
          })}
          {labels.map((_, i) => (
            <rect key={i} x={padL + slot * i} y={padT} width={slot} height={H - padT - padB}
              fill="transparent" onMouseEnter={() => setHover(i)} />
          ))}
        </svg>
        <Tip tip={tip} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 横棒の比較チャート（少数の項目を金額付きで比べる）
// ---------------------------------------------------------------------------

export interface CompareBar {
  label: string;
  value: number;
  color: string;
  /** 補足（達成状況など） */
  note?: string;
}

/**
 * 横棒で数値を比較する。各棒に金額を直接書くので、
 * カーソルを合わせなくても数字が読める。
 * baseIndex を指定すると、その棒を基準にした差額を右に出す。
 */
export function CompareBars({ bars, baseIndex = 0, format = fmtYen }: {
  bars: CompareBar[];
  baseIndex?: number;
  format?: (n: number) => string;
}) {
  const max = Math.max(1, ...bars.map(b => Math.abs(b.value)));
  const base = bars[baseIndex]?.value ?? 0;
  return (
    <div className="kr-cmpbars">
      {bars.map((b, i) => {
        const w = (Math.abs(b.value) / max) * 100;
        const diff = i === baseIndex ? null : b.value - base;
        return (
          <div className="kr-cmpbar" key={b.label}>
            <div className="kr-cmpbar-head">
              <span className="kr-cmpbar-label">{b.label}</span>
              <b className="kr-cmpbar-value">{format(b.value)}</b>
            </div>
            <div className="kr-cmpbar-track">
              <div className="kr-cmpbar-fill" style={{ width: `${w}%`, background: b.color }} />
              {i !== baseIndex && (
                <div className="kr-cmpbar-mark" style={{ left: `${(Math.abs(base) / max) * 100}%` }}
                  title="実績の水準" />
              )}
            </div>
            <div className="kr-cmpbar-note">
              {b.note}
              {diff !== null && (
                <span className={diff > 0 ? 'short' : 'ok'}>
                  {diff > 0 ? `あと ${format(diff)} 不足` : `${format(-diff)} 上回っている`}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ウォーターフォール（CF計算書: 期首現預金→営業→投資→財務→期末）
// ---------------------------------------------------------------------------

export function Waterfall({ items, height = 240 }: {
  items: { label: string; value: number; kind: 'total' | 'flow' }[];
  height?: number;
}) {
  const W = 760; const H = height;
  const padL = 58; const padR = 14; const padT = 14; const padB = 30;
  const [hover, setHover] = useState<number | null>(null);

  // 累積位置を計算
  let run = 0;
  const bars = items.map(it => {
    if (it.kind === 'total') { run = it.value; return { ...it, from: 0, to: it.value }; }
    const from = run; run += it.value;
    return { ...it, from, to: run };
  });
  const lo = Math.min(0, ...bars.flatMap(b => [b.from, b.to]));
  const hi = Math.max(0, ...bars.flatMap(b => [b.from, b.to]));
  const ticks = niceTicks(lo, hi);
  const yv = (v: number) => padT + (1 - (v - lo) / Math.max(1, hi - lo)) * (H - padT - padB);
  const slot = (W - padL - padR) / bars.length;
  const bw = Math.min(46, slot - 18);

  const tip: TipState | null = hover === null ? null : {
    leftPct: ((padL + slot * hover + slot / 2) / W) * 100, topPct: 6,
    title: bars[hover].label,
    lines: [{ label: bars[hover].kind === 'total' ? '残高' : '増減', value: fmtYen(bars[hover].value) }],
  };

  return (
    <div className="kr-chart" onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img">
        {ticks.map(t => (
          <g key={t}>
            <line x1={padL} x2={W - padR} y1={yv(t)} y2={yv(t)} stroke={t === 0 ? C.axis : C.grid} strokeWidth={1} />
            <text x={padL - 6} y={yv(t) + 3.5} textAnchor="end" fontSize={10.5} fill={C.grayDark}>{fmtShort(t)}</text>
          </g>
        ))}
        {bars.map((b, i) => {
          const cx = padL + slot * i + slot / 2;
          const y1 = yv(b.from); const y2 = yv(b.to);
          const top = Math.min(y1, y2); const h = Math.max(2, Math.abs(y1 - y2));
          const fill = b.kind === 'total' ? C.grayDark : b.value >= 0 ? C.blue : C.red;
          return (
            <g key={i} onMouseEnter={() => setHover(i)}>
              <rect x={cx - bw / 2} y={top} width={bw} height={h} rx={3} fill={fill}
                opacity={hover === null || hover === i ? (b.kind === 'total' ? 0.55 : 1) : 0.4} />
              {i < bars.length - 1 && b.kind !== 'total' && (
                <line x1={cx + bw / 2} x2={padL + slot * (i + 1) + slot / 2 - bw / 2}
                  y1={yv(b.to)} y2={yv(b.to)} stroke={C.axis} strokeWidth={1} />
              )}
              {i < bars.length - 1 && b.kind === 'total' && (
                <line x1={cx + bw / 2} x2={padL + slot * (i + 1) + slot / 2 - bw / 2}
                  y1={yv(b.value)} y2={yv(b.value)} stroke={C.axis} strokeWidth={1} />
              )}
              <text x={cx} y={top - 5} textAnchor="middle" fontSize={10.5} fill={C.inkSub}>{fmtShort(b.value)}</text>
              <text x={cx} y={H - 8} textAnchor="middle" fontSize={10.5} fill={C.grayDark}>{b.label}</text>
            </g>
          );
        })}
      </svg>
      <Tip tip={tip} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// メーター（安全余裕率・返済カバー率など 0..基準値のゲージ）
// ---------------------------------------------------------------------------

export function Meter({ ratio, text, good = 1, warn = 0.5 }: {
  /** 0..1+ の達成率（1超は満タン表示） */
  ratio: number | null;
  text: string;
  /** これ以上で良好（緑） */
  good?: number;
  /** これ以上で注意（黄）・未満は赤 */
  warn?: number;
}) {
  const r = ratio === null ? 0 : Math.max(0, Math.min(1, ratio / good));
  const color = ratio === null ? C.gray : ratio >= good ? C.good : ratio >= warn ? C.warn : C.bad;
  return (
    <div className="kr-meter">
      <div className="kr-meter-track"><div className="kr-meter-fill" style={{ width: `${r * 100}%`, background: color }} /></div>
      <div className="kr-meter-text">{text}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// KPIタイル
// ---------------------------------------------------------------------------

export function Kpi({ label, value, sub, delta, tone }: {
  label: string;
  value: string;
  sub?: string;
  /** 前期比などの補足（signed文字列）。tone で色付け */
  delta?: string;
  tone?: 'good' | 'bad' | 'neutral';
}) {
  return (
    <div className="kr-kpi">
      <div className="lbl">{label}</div>
      <div className="val">{value}</div>
      {(delta || sub) && (
        <div className="sub">
          {delta && <span className={`delta ${tone ?? 'neutral'}`}>{delta}</span>}
          {sub && <span>{sub}</span>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 主要指標の表（KPIカードの代わり。月次報告でそのまま読み上げられる並び）
// ---------------------------------------------------------------------------

export interface KpiRow {
  label: string;
  /** 当期の値（表示済みの文字列） */
  value: string;
  /** 前年同期の値 */
  prev?: string;
  /** 増減（+12.3% / +1.2pt など） */
  delta?: string;
  tone?: 'good' | 'bad' | 'neutral';
  /** 補足（内訳・判定など） */
  note?: string;
  /** 「？」ボタンを押すと開く、その指標の意味の説明 */
  help?: string;
}

export function KpiTable({ rows, currentLabel, prevLabel, headLabel = '主要指標' }: {
  rows: KpiRow[];
  /** 当期列の見出し（例: 令和8年9月期 累計9ヶ月） */
  currentLabel: string;
  /** 前期列の見出し（例: 前年同期）。無ければ前期列を出さない */
  prevLabel?: string;
  /** 1列目の見出し（例: 主要指標／報告月の単月実績） */
  headLabel?: string;
}) {
  const hasPrev = !!prevLabel && rows.some(r => r.prev !== undefined);
  // 開いている説明（1つずつ開く。もう一度押すと閉じる）
  const [openHelp, setOpenHelp] = useState<string | null>(null);
  return (
    <div className="card table-scroll">
      <table className="kr-grid kpi-table">
        <thead>
          <tr>
            <th style={{ width: 230 }}>{headLabel}</th>
            <th className="num" style={{ width: 180 }}>{currentLabel}</th>
            {hasPrev && <th className="num" style={{ width: 170 }}>{prevLabel}</th>}
            {hasPrev && <th className="num" style={{ width: 120 }}>増減</th>}
            <th>補足</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const open = openHelp === r.label;
            return (
              <tr key={r.label}>
                <th scope="row">{r.label}</th>
                <td className="num val">{r.value}</td>
                {hasPrev && <td className="num">{r.prev ?? '—'}</td>}
                {hasPrev && (
                  <td className={`num delta ${r.tone ?? 'neutral'}`}>{r.delta ?? '—'}</td>
                )}
                <td className="note">
                  <span className="note-text">{r.note ?? ''}</span>
                  {r.help && (
                    <button type="button" className={`kr-help-btn${open ? ' open' : ''}`}
                      aria-expanded={open}
                      title={`「${r.label}」の説明を${open ? '閉じる' : '見る'}`}
                      aria-label={`「${r.label}」の説明を${open ? '閉じる' : '見る'}`}
                      onClick={() => setOpenHelp(open ? null : r.label)}>？</button>
                  )}
                  {r.help && open && <div className="kr-help-box">{r.help}</div>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 金額の入力（#,### 形式で表示し、入力中は素の数字を扱う）
// ---------------------------------------------------------------------------

export function YenInput({ value, onChange, width = 130, step = 1_000_000 }: {
  value: number;
  onChange: (v: number) => void;
  width?: number;
  /** ↑↓キーでの増減幅 */
  step?: number;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const commit = (text: string) => {
    const n = Math.max(0, Math.round(Number(text.replace(/[,，\s]/g, '')) || 0));
    onChange(n);
    setEditing(null);
  };
  return (
    <input
      className="kr-yen-input"
      inputMode="numeric"
      style={{ width, textAlign: 'right' }}
      value={editing ?? value.toLocaleString('ja-JP')}
      onChange={e => setEditing(e.target.value)}
      onBlur={e => commit(e.target.value)}
      onKeyDown={e => {
        if (e.key === 'Enter') { commit((e.target as HTMLInputElement).value); (e.target as HTMLInputElement).blur(); }
        if (e.key === 'ArrowUp') { e.preventDefault(); onChange(value + step); setEditing(null); }
        if (e.key === 'ArrowDown') { e.preventDefault(); onChange(Math.max(0, value - step)); setEditing(null); }
      }} />
  );
}

// ---------------------------------------------------------------------------
// スライダー行（シミュレーション用）
// ---------------------------------------------------------------------------

export function SliderRow({ label, value, min, max, step, format, onChange, onReset }: {
  label: string;
  value: number;
  min: number; max: number; step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
  onReset?: () => void;
}) {
  return (
    <div className="kr-slider">
      <div className="kr-slider-head">
        <span>{label}</span>
        <b>{format(value)}</b>
        {onReset && value !== 0 && <button className="link" onClick={onReset}>リセット</button>}
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 年度切替（前年度 ◀ ▶ 翌年度）
// ---------------------------------------------------------------------------

export function YearNav({ years, current, onChange }: {
  years: { id: string; label: string; lastFilledIndex?: number }[];
  current: string;
  onChange: (id: string) => void;
}) {
  const idx = years.findIndex(y => y.id === current);
  return (
    <div className="kr-yearnav">
      <button className="secondary small" disabled={idx <= 0}
        onClick={() => onChange(years[idx - 1].id)} title="前の事業年度">◀ 前期</button>
      <div className="kr-yeartabs" role="tablist" aria-label="事業年度">
        {years.map(y => {
          const running = y.lastFilledIndex !== undefined && y.lastFilledIndex < 11;
          return (
            <button key={y.id} role="tab" aria-selected={y.id === current}
              className={`kr-yeartab${y.id === current ? ' on' : ''}`}
              onClick={() => onChange(y.id)}>
              <span className={`kr-yeartab-badge${running ? ' running' : ''}`}>
                {running ? '進行期' : '確定'}
              </span>
              {y.label}
            </button>
          );
        })}
      </div>
      <button className="secondary small" disabled={idx < 0 || idx >= years.length - 1}
        onClick={() => onChange(years[idx + 1].id)} title="次の事業年度">翌期 ▶</button>
    </div>
  );
}

/** データ未取込のときの案内。 */
export function NeedData() {
  return (
    <div className="card kr-needdata">
      <b>まだ月次データが取り込まれていません。</b>
      <div>左メニューの「データ取込」から、会計ソフトで書き出した月次推移のJSONファイルを取り込んでください。</div>
    </div>
  );
}

/** 選択中の年度を管理する共通フック（最新年度が既定）。 */
export function useYearSelection(years: { id: string }[]): [string, (id: string) => void] {
  const latest = years.length ? years[years.length - 1].id : '';
  const [sel, setSel] = useState<string>(latest);
  const valid = useMemo(() => years.some(y => y.id === sel) ? sel : latest, [years, sel, latest]);
  return [valid, setSel];
}
