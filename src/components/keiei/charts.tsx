'use client'

import { fmtShort, fmtPct } from '@/lib/keiei/format'

// 共通: 値域(0を含む)から y 座標スケールを作る
function makeScale(values: number[], top: number, bottom: number) {
  let max = 0
  let min = 0
  for (const v of values) {
    if (v > max) max = v
    if (v < min) min = v
  }
  if (max === 0 && min === 0) max = 1
  const range = max - min || 1
  const y = (v: number) => bottom - ((v - min) / range) * (bottom - top)
  return { y, max, min }
}

const PALETTE = ['#1F3A5F', '#3b82f6', '#93c5fd'] // 濃→淡（古い期→新しい期 or 任意）

interface ComboProps {
  labels: string[]
  bars: number[]
  barLabel: string
  barColor?: string
  line?: number[]
  lineLabel?: string
  lineColor?: string
}

/** 棒グラフ＋折れ線の複合（例: 月別売上(棒) ＋ 営業利益(線)） */
export function ComboBarLine({ labels, bars, barLabel, barColor = '#3b82f6', line, lineLabel, lineColor = '#C8A24B' }: ComboProps) {
  const W = 760, H = 240, padL = 16, padR = 16, padT = 26, padB = 26
  const n = labels.length
  const all = [...bars, ...(line || [])]
  const { y } = makeScale(all, padT, H - padB)
  const innerW = W - padL - padR
  const step = innerW / n
  const barW = Math.min(34, step * 0.6)
  const zero = y(0)
  return (
    <div>
      <div className="flex items-center gap-4 mb-1 text-xs text-gray-600">
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-sm" style={{ background: barColor }} />{barLabel}</span>
        {line && <span className="flex items-center gap-1"><span className="inline-block w-4 h-0.5" style={{ background: lineColor }} />{lineLabel}</span>}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 'auto' }}>
        {/* ゼロ線 */}
        <line x1={padL} y1={zero} x2={W - padR} y2={zero} stroke="#cbd5e1" strokeWidth={1} />
        {bars.map((v, i) => {
          const cx = padL + step * i + step / 2
          const top = Math.min(y(v), zero)
          const h = Math.abs(y(v) - zero)
          return (
            <g key={i}>
              <rect x={cx - barW / 2} y={top} width={barW} height={h} rx={2} fill={barColor} opacity={0.9} />
              <text x={cx} y={v >= 0 ? top - 3 : top + h + 10} textAnchor="middle" fontSize={9} fill="#475569">{fmtShort(v)}</text>
              <text x={cx} y={H - 8} textAnchor="middle" fontSize={10} fill="#64748b">{labels[i]}</text>
            </g>
          )
        })}
        {line && (
          <polyline
            fill="none"
            stroke={lineColor}
            strokeWidth={2}
            points={line.map((v, i) => `${padL + step * i + step / 2},${y(v)}`).join(' ')}
          />
        )}
        {line && line.map((v, i) => (
          <circle key={i} cx={padL + step * i + step / 2} cy={y(v)} r={2.5} fill={lineColor} />
        ))}
      </svg>
    </div>
  )
}

interface GroupedProps {
  groups: { label: string; values: (number | null)[] }[]
  seriesLabels: string[]
  colors?: string[]
}

/** グループ化棒グラフ（例: 指標ごと(売上/粗利/営業利益…) × 3期） */
export function GroupedBars({ groups, seriesLabels, colors = PALETTE }: GroupedProps) {
  const W = 760, H = 260, padL = 16, padR = 16, padT = 26, padB = 30
  const n = groups.length
  const s = seriesLabels.length
  const all: number[] = []
  for (const g of groups) for (const v of g.values) if (v != null) all.push(v)
  const { y } = makeScale(all.length ? all : [0], padT, H - padB)
  const innerW = W - padL - padR
  const step = innerW / n
  const groupW = step * 0.74
  const barW = groupW / Math.max(1, s)
  const zero = y(0)
  return (
    <div>
      <div className="flex items-center gap-4 mb-1 text-xs text-gray-600 flex-wrap">
        {seriesLabels.map((l, i) => (
          <span key={i} className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-sm" style={{ background: colors[i % colors.length] }} />{l}</span>
        ))}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 'auto' }}>
        <line x1={padL} y1={zero} x2={W - padR} y2={zero} stroke="#cbd5e1" strokeWidth={1} />
        {groups.map((g, gi) => {
          const gx = padL + step * gi + step / 2 - groupW / 2
          return (
            <g key={gi}>
              {g.values.map((v, si) => {
                if (v == null) return null
                const x = gx + barW * si
                const top = Math.min(y(v), zero)
                const h = Math.abs(y(v) - zero)
                return (
                  <g key={si}>
                    <rect x={x} y={top} width={barW * 0.86} height={h} rx={2} fill={colors[si % colors.length]} />
                    <text x={x + barW * 0.43} y={v >= 0 ? top - 3 : top + h + 9} textAnchor="middle" fontSize={8} fill="#475569">{fmtShort(v)}</text>
                  </g>
                )
              })}
              <text x={padL + step * gi + step / 2} y={H - 9} textAnchor="middle" fontSize={11} fill="#334155" fontWeight={600}>{g.label}</text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

interface MultiLineProps {
  labels: string[]
  series: { label: string; values: number[]; color: string }[]
  unit?: 'yen' | 'pct'
}

/** 複数折れ線（利益率の推移／借入残高の推移など） */
export function MultiLine({ labels, series, unit = 'yen' }: MultiLineProps) {
  const W = 760, H = 240, padL = 16, padR = 16, padT = 24, padB = 26
  const all = series.flatMap((s) => s.values)
  const { y } = makeScale(all.length ? all : [0], padT, H - padB)
  const n = labels.length
  const step = (W - padL - padR) / Math.max(1, n - 1)
  const fmt = (v: number) => (unit === 'pct' ? fmtPct(v) : fmtShort(v))
  const zero = y(0)
  return (
    <div>
      <div className="flex items-center gap-4 mb-1 text-xs text-gray-600 flex-wrap">
        {series.map((s, i) => (
          <span key={i} className="flex items-center gap-1"><span className="inline-block w-4 h-0.5" style={{ background: s.color }} />{s.label}</span>
        ))}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 'auto' }}>
        <line x1={padL} y1={zero} x2={W - padR} y2={zero} stroke="#e2e8f0" strokeWidth={1} />
        {labels.map((l, i) => (
          <text key={i} x={padL + step * i} y={H - 8} textAnchor="middle" fontSize={10} fill="#64748b">{l}</text>
        ))}
        {series.map((s, si) => (
          <g key={si}>
            <polyline fill="none" stroke={s.color} strokeWidth={2}
              points={s.values.map((v, i) => `${padL + step * i},${y(v)}`).join(' ')} />
            {s.values.map((v, i) => <circle key={i} cx={padL + step * i} cy={y(v)} r={2.5} fill={s.color} />)}
          </g>
        ))}
        {series.length === 1 && series[0].values.map((v, i) => (
          <text key={i} x={padL + step * i} y={y(v) - 5} textAnchor="middle" fontSize={8} fill="#475569">{fmt(v)}</text>
        ))}
      </svg>
    </div>
  )
}

interface HBarsProps { items: { label: string; value: number; sub?: string }[]; color?: string }

/** 横棒ランキング（経費の科目別など） */
export function HBars({ items, color = '#3b82f6' }: HBarsProps) {
  const max = Math.max(1, ...items.map((it) => Math.abs(it.value)))
  return (
    <div className="space-y-1.5">
      {items.map((it, i) => (
        <div key={i} className="flex items-center gap-2 text-xs">
          <div className="w-40 shrink-0 truncate text-gray-700" title={it.label}>{it.label}</div>
          <div className="flex-1 bg-gray-100 rounded h-5 relative overflow-hidden">
            <div className="h-full rounded" style={{ width: `${(Math.abs(it.value) / max) * 100}%`, background: color }} />
          </div>
          <div className="w-24 shrink-0 text-right tabular-nums text-gray-700">{fmtShort(it.value)}</div>
          {it.sub != null && <div className="w-12 shrink-0 text-right text-gray-400">{it.sub}</div>}
        </div>
      ))}
    </div>
  )
}
