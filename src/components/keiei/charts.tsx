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

const PALETTE = ['#c3cdd9', '#7d93b2', '#1a73e8'] // 前々期＝薄グレー → 前期＝グレー青 → 当期＝青（当期が主役）

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
  const lineLabelColor = '#8a6a1f'
  return (
    <div>
      <div className="flex items-center gap-5 mb-2 text-[13px] text-gray-700 font-medium">
        <span className="flex items-center gap-1.5"><span className="inline-block w-4 h-4 rounded" style={{ background: barColor }} />{barLabel}</span>
        {line && <span className="flex items-center gap-1.5"><span className="inline-block w-6 h-[3px] rounded" style={{ background: lineColor }} /><span className="inline-block w-2.5 h-2.5 rounded-full -ml-4" style={{ background: lineColor }} />{lineLabel}</span>}
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
              <text x={cx} y={v >= 0 ? top - 4 : top + h + 12} textAnchor="middle" fontSize={11} fontWeight={600} fill="#334155" stroke="#fff" strokeWidth={3} paintOrder="stroke">{fmtShort(v)}</text>
              <text x={cx} y={H - 7} textAnchor="middle" fontSize={12} fill="#475569" fontWeight={500}>{labels[i]}</text>
            </g>
          )
        })}
        {line && (
          <polyline fill="none" stroke={lineColor} strokeWidth={2.5}
            points={line.map((v, i) => `${padL + step * i + step / 2},${y(v)}`).join(' ')} />
        )}
        {line && line.map((v, i) => {
          const cx = padL + step * i + step / 2
          // ラベルは常に点の上に置き、月ラベル(下端)と重ならないようにする
          const ly = Math.max(padT + 9, y(v) - 9)
          return (
            <g key={i}>
              <circle cx={cx} cy={y(v)} r={3.5} fill={lineColor} stroke="#fff" strokeWidth={1.5} />
              <text x={cx} y={ly} textAnchor="middle" fontSize={11} fontWeight={700} fill={lineLabelColor} stroke="#fff" strokeWidth={3} paintOrder="stroke">{fmtShort(v)}</text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

interface GroupedProps {
  groups: { label: string; values: (number | null)[] }[]
  seriesLabels: string[]
  colors?: string[]
  staggerLabels?: boolean // 月次12グループ×2系列など、隣接バーの数値ラベルが重なる場合に高さを系列ごとにずらす
}

/** グループ化棒グラフ（例: 指標ごと(売上/粗利/営業利益…) × 3期） */
export function GroupedBars({ groups, seriesLabels, colors = PALETTE, staggerLabels }: GroupedProps) {
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
                const dy = staggerLabels ? (s - 1 - si) * 11 : 0
                return (
                  <g key={si}>
                    <rect x={x} y={top} width={barW * 0.86} height={h} rx={2} fill={colors[si % colors.length]} />
                    <text x={x + barW * 0.43} y={v >= 0 ? top - 4 - dy : top + h + 10 + dy} textAnchor="middle" fontSize={9.5} fontWeight={600} fill="#334155" stroke="#fff" strokeWidth={2.5} paintOrder="stroke">{fmtShort(v)}</text>
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
  showTable?: boolean
}

/** 複数折れ線（利益率の推移／借入残高の推移など）。showTable で各月の数値表も表示 */
export function MultiLine({ labels, series, unit = 'yen', showTable }: MultiLineProps) {
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
      {showTable && (
        <div className="overflow-x-auto mt-2">
          <table className="w-full text-[11px] border-collapse">
            <thead>
              <tr className="text-gray-500">
                <th className="text-left px-2 py-1 sticky left-0 bg-white"></th>
                {labels.map((l, i) => <th key={i} className="text-right px-2 py-1 whitespace-nowrap">{l}</th>)}
              </tr>
            </thead>
            <tbody>
              {series.map((s, si) => (
                <tr key={si} className="border-t border-gray-100">
                  <td className="text-left px-2 py-1 whitespace-nowrap sticky left-0 bg-white">
                    <span className="inline-block w-2.5 h-2.5 rounded-sm mr-1 align-middle" style={{ background: s.color }} />{s.label}
                  </td>
                  {s.values.map((v, i) => <td key={i} className="text-right px-2 py-1 tabular-nums">{fmt(v)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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


interface WaterfallProps {
  startLabel: string
  startValue: number
  steps: { label: string; delta: number }[]
  endLabel: string
  endValue: number
}

/** ウォーターフォール（利益ブリッジ）: 前年営業利益 → 増減要因 → 当期営業利益 */
export function Waterfall({ startLabel, startValue, steps, endLabel, endValue }: WaterfallProps) {
  const W = 760, H = 280, padL = 16, padR = 16, padT = 34, padB = 40
  const items = [
    { label: startLabel, kind: 'total' as const, from: 0, to: startValue },
    ...(() => {
      let acc = startValue
      return steps.map((st) => { const from = acc; acc += st.delta; return { label: st.label, kind: 'step' as const, from, to: acc } })
    })(),
    { label: endLabel, kind: 'total' as const, from: 0, to: endValue },
  ]
  const vals = items.flatMap((it) => [it.from, it.to])
  const { y } = makeScale(vals, padT, H - padB)
  const n = items.length
  const step = (W - padL - padR) / n
  const barW = Math.min(88, step * 0.62)
  const zero = y(0)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 'auto' }}>
      <line x1={padL} y1={zero} x2={W - padR} y2={zero} stroke="#cbd5e1" strokeWidth={1} />
      {items.map((it, i) => {
        const cx = padL + step * i + step / 2
        const isTotal = it.kind === 'total'
        const v = isTotal ? it.to : it.to - it.from
        const yTop = Math.min(y(it.from), y(it.to))
        const h = Math.max(2, Math.abs(y(it.to) - y(it.from)))
        const fill = isTotal ? (i === 0 ? '#8fa3bd' : '#1a73e8') : v >= 0 ? '#1e8e3e' : '#d93025'
        // 次の棒への接続線
        const next = items[i + 1]
        const connY = y(it.to)
        return (
          <g key={i}>
            <rect x={cx - barW / 2} y={yTop} width={barW} height={h} rx={3} fill={fill} opacity={isTotal ? 1 : 0.92} />
            {next && next.kind === 'step' && (
              <line x1={cx + barW / 2} y1={connY} x2={padL + step * (i + 1) + step / 2 - barW / 2} y2={connY} stroke="#94a3b8" strokeDasharray="3 3" />
            )}
            <text x={cx} y={yTop - 6} textAnchor="middle" fontSize={12.5} fontWeight={700}
              fill={isTotal ? '#1f2937' : v >= 0 ? '#166534' : '#b91c1c'} stroke="#fff" strokeWidth={3} paintOrder="stroke">
              {isTotal ? fmtShort(v) : `${v >= 0 ? '+' : '−'}${fmtShort(Math.abs(v))}`}
            </text>
            <text x={cx} y={H - 22} textAnchor="middle" fontSize={12} fill="#334155" fontWeight={600}>{it.label.slice(0, 8)}</text>
            {it.label.length > 8 && <text x={cx} y={H - 8} textAnchor="middle" fontSize={12} fill="#334155" fontWeight={600}>{it.label.slice(8)}</text>}
          </g>
        )
      })}
    </svg>
  )
}

interface BulletZone { to: number; color: string; label?: string }
interface BulletProps {
  title: string
  valueLabel: string // 例: "84%" "1.8か月"
  value: number
  max: number
  zones: BulletZone[] // 昇順。value/max と同じ単位
  subtitle?: string
}

/** ゲージ（ブレットグラフ）: 危険/注意/安全ゾーンの上に現在値マーカーを置く */
export function Bullet({ title, valueLabel, value, max, zones, subtitle }: BulletProps) {
  const v = Math.max(0, Math.min(value, max))
  const pct = (x: number) => `${(Math.max(0, Math.min(x, max)) / max) * 100}%`
  let prev = 0
  return (
    <div className="py-1.5">
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-[13px] font-bold text-gray-800">{title}</span>
        <span className="text-[17px] font-extrabold text-gray-900 tabular-nums">{valueLabel}</span>
      </div>
      <div className="relative h-5 rounded-full overflow-hidden bg-gray-100">
        {zones.map((z, i) => {
          const left = pct(prev)
          const width = `${((Math.min(z.to, max) - prev) / max) * 100}%`
          prev = z.to
          return <div key={i} className="absolute top-0 bottom-0" style={{ left, width, background: z.color }} />
        })}
        <div className="absolute top-[-2px] bottom-[-2px] w-[3px] bg-gray-900 rounded" style={{ left: `calc(${pct(v)} - 1.5px)` }} />
      </div>
      <div className="flex justify-between text-[10.5px] text-gray-400 mt-0.5">
        {zones.map((z, i) => <span key={i}>{z.label || ''}</span>)}
      </div>
      {subtitle && <div className="text-[11px] text-gray-500 mt-0.5">{subtitle}</div>}
    </div>
  )
}
