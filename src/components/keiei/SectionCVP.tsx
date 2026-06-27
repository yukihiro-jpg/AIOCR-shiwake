'use client'

import { useState } from 'react'
import type { FiscalYearData } from '@/lib/keiei/types'
import {
  cvp, classifiableCodes, costValue, classifyOf, suggestVarFix,
  type KeieiSettings,
} from '@/lib/keiei/analysis'
import { fmtYen, fmtShort, fmtPct } from '@/lib/keiei/format'

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <div className="flex items-baseline gap-2 mb-3">
        <h2 className="text-sm font-bold text-gray-800">{title}</h2>
        {note && <span className="text-xs text-gray-400">{note}</span>}
      </div>
      {children}
    </div>
  )
}

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)) }

export default function SectionCVP({ fy, monthIdx, settings, onSettingsChange, years }: {
  fy: FiscalYearData
  monthIdx: number
  settings: KeieiSettings
  onSettingsChange: (s: KeieiSettings) => void
  years: Record<string, FiscalYearData>
}) {
  const base = cvp(fy, monthIdx, settings)
  const monthLabel = `${fy.fiscalMonths[monthIdx]}月`
  const [showEditor, setShowEditor] = useState(false)
  // シミュレータ
  const [salesAdj, setSalesAdj] = useState(0)
  const [varAdj, setVarAdj] = useState(0)
  const [fixedAdj, setFixedAdj] = useState(0)

  const baseVarRate = base.sales ? base.variable / base.sales : 0
  const simSales = base.sales * (1 + salesAdj / 100)
  const simVarRate = clamp(baseVarRate + varAdj / 100, 0, 0.99)
  const simVariable = simSales * simVarRate
  const simFixed = base.fixed * (1 + fixedAdj / 100)
  const simMarginal = simSales - simVariable
  const simMarginalRate = simSales ? simMarginal / simSales : 0
  const simBep = simMarginalRate ? simFixed / simMarginalRate : 0
  const simOp = simMarginal - simFixed
  const simSafety = simSales ? (simSales - simBep) / simSales : 0

  const cls = classifyOf(fy, settings)
  const costs = classifiableCodes(fy).map((c) => ({ code: c.code, name: c.name, value: costValue(fy, c.code, monthIdx), kind: cls(c.code) }))
    .filter((x) => Math.abs(x.value) > 0)

  const setKind = (code: string, kind: 'variable' | 'fixed') => {
    onSettingsChange({ ...settings, varfix: { ...settings.varfix, [code]: kind } })
  }
  const autoSuggest = () => onSettingsChange({ ...settings, varfix: { ...settings.varfix, ...suggestVarFix(years) } })
  const resetDefault = () => onSettingsChange({ ...settings, varfix: {} })

  return (
    <div className="space-y-5">
      <Section title={`損益分岐点（期首〜${monthLabel} 累計ベース）`} note="変動費/固定費の分類に基づく概算">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
          <Stat label="売上高" value={base.sales} />
          <Stat label="限界利益" value={base.marginal} sub={`率 ${fmtPct(base.marginalRate * 100)}`} />
          <Stat label="固定費" value={base.fixed} />
          <Stat label="損益分岐点売上" value={base.bep} accent />
          <Stat label="経営安全率" text={fmtPct(base.safety * 100)} good={base.safety >= 0} />
        </div>
        {/* 売上 vs 損益分岐点 のバー */}
        <BepBar sales={base.sales} bep={base.bep} />
        <div className="text-xs text-gray-500 mt-2">
          限界利益率 {fmtPct(base.marginalRate * 100)} ／ 変動費 {fmtShort(base.variable)}（変動費率 {fmtPct(baseVarRate * 100)}） ／ 固定費 {fmtShort(base.fixed)}。
          {base.safety < 0 ? '　現状は損益分岐点を下回っています（営業赤字）。' : `　損益分岐点を ${fmtShort(base.sales - base.bep)} 上回っています。`}
        </div>
      </Section>

      <Section title="CVPシミュレーション" note="スライダーを動かすと損益分岐点・営業利益が即時に変わります">
        <div className="grid md:grid-cols-3 gap-4 mb-4">
          <Slider label="売上" value={salesAdj} min={-30} max={30} unit="%" onChange={setSalesAdj} />
          <Slider label="変動費率" value={varAdj} min={-10} max={10} unit="pt" onChange={setVarAdj} />
          <Slider label="固定費" value={fixedAdj} min={-30} max={30} unit="%" onChange={setFixedAdj} />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-xs text-gray-500 bg-gray-50">
              <th className="text-left px-3 py-2">指標</th><th className="text-right px-3 py-2">現状</th><th className="text-right px-3 py-2">シミュレーション後</th>
            </tr></thead>
            <tbody>
              <SimRow label="売上高" a={base.sales} b={simSales} />
              <SimRow label="限界利益率" a={base.marginalRate * 100} b={simMarginalRate * 100} pct />
              <SimRow label="固定費" a={base.fixed} b={simFixed} />
              <SimRow label="営業利益" a={base.opProfit} b={simOp} bold />
              <SimRow label="損益分岐点売上" a={base.bep} b={simBep} bold />
              <SimRow label="経営安全率" a={base.safety * 100} b={simSafety * 100} pct />
            </tbody>
          </table>
        </div>
        <div className="text-xs text-gray-400 mt-2">※ 損益分岐点売上を下げるには「固定費を下げる」「変動費率を下げる（＝限界利益率を上げる）」が効きます。スライダーで効果の大きさを比較できます。</div>
      </Section>

      <Section title="変動費／固定費の分類" note="売上原価＝変動・販管費＝固定が既定。実態に合わせて修正できます">
        <div className="flex gap-2 mb-3">
          <button onClick={() => setShowEditor((v) => !v)} className="px-3 py-1.5 text-xs bg-gray-100 rounded hover:bg-gray-200">{showEditor ? '閉じる' : '分類を編集'}</button>
          <button onClick={autoSuggest} className="px-3 py-1.5 text-xs bg-blue-50 text-blue-700 border border-blue-200 rounded hover:bg-blue-100">売上との相関で自動推定</button>
          <button onClick={resetDefault} className="px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-100 rounded">既定に戻す</button>
        </div>
        {showEditor && (
          <div className="overflow-auto max-h-[360px] border border-gray-100 rounded">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-gray-50"><tr className="text-gray-500">
                <th className="text-left px-3 py-1.5">科目</th><th className="text-right px-3 py-1.5">累計</th><th className="text-center px-3 py-1.5">分類</th>
              </tr></thead>
              <tbody>
                {costs.map((c) => (
                  <tr key={c.code} className="border-b border-gray-50">
                    <td className="px-3 py-1">{c.name}</td>
                    <td className="px-3 py-1 text-right tabular-nums">{fmtYen(c.value)}</td>
                    <td className="px-3 py-1">
                      <div className="flex justify-center gap-1">
                        {(['variable', 'fixed'] as const).map((k) => (
                          <button key={k} onClick={() => setKind(c.code, k)}
                            className={`px-2 py-0.5 rounded text-[11px] ${c.kind === k ? (k === 'variable' ? 'bg-amber-500 text-white' : 'bg-slate-600 text-white') : 'bg-gray-100 text-gray-500'}`}>
                            {k === 'variable' ? '変動費' : '固定費'}
                          </button>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  )
}

function Stat({ label, value, sub, text, accent, good }: { label: string; value?: number; sub?: string; text?: string; accent?: boolean; good?: boolean }) {
  return (
    <div className={`rounded-xl border p-4 shadow-sm ${accent ? 'border-amber-300 bg-amber-50' : 'border-gray-200 bg-white'}`}>
      <div className="text-[13px] font-semibold text-gray-600 mb-1.5">{label}</div>
      <div className={`text-[22px] leading-none font-extrabold ${good == null ? (accent ? 'text-amber-700' : 'text-gray-900') : good ? 'text-green-600' : 'text-red-600'}`}>{text != null ? text : fmtShort(value || 0)}</div>
      {sub && <div className="text-[11px] text-gray-500 mt-1.5">{sub}</div>}
    </div>
  )
}

function BepBar({ sales, bep }: { sales: number; bep: number }) {
  const max = Math.max(sales, bep, 1)
  const Row = ({ label, val, color }: { label: string; val: number; color: string }) => (
    <div className="flex items-center gap-3 text-sm">
      <div className="w-28 shrink-0 text-gray-700 font-medium">{label}</div>
      <div className="flex-1 bg-gray-100 rounded-md h-8 relative overflow-hidden">
        <div className="h-full rounded-md flex items-center justify-end pr-2" style={{ width: `${(val / max) * 100}%`, background: color }}>
          <span className="text-white text-xs font-bold whitespace-nowrap">{fmtShort(val)}</span>
        </div>
      </div>
    </div>
  )
  return (
    <div className="space-y-2.5">
      <Row label="現状の売上" val={sales} color="#3b82f6" />
      <Row label="損益分岐点売上" val={bep} color="#e0a91b" />
    </div>
  )
}

function Slider({ label, value, min, max, unit, onChange }: { label: string; value: number; min: number; max: number; unit: string; onChange: (v: number) => void }) {
  return (
    <div>
      <div className="flex justify-between text-xs mb-1"><span className="text-gray-600">{label}</span><span className="font-bold text-blue-700">{value >= 0 ? '+' : ''}{value}{unit}</span></div>
      <input type="range" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full" />
    </div>
  )
}

function SimRow({ label, a, b, pct, bold }: { label: string; a: number; b: number; pct?: boolean; bold?: boolean }) {
  const f = (v: number) => (pct ? fmtPct(v) : fmtYen(v))
  const up = b >= a
  return (
    <tr className="border-b border-gray-100">
      <td className={`px-3 py-1.5 ${bold ? 'font-bold' : ''}`}>{label}</td>
      <td className="px-3 py-1.5 text-right tabular-nums text-gray-500">{f(a)}</td>
      <td className={`px-3 py-1.5 text-right tabular-nums font-medium ${bold ? (up ? 'text-green-600' : 'text-red-600') : 'text-gray-800'}`}>{f(b)}</td>
    </tr>
  )
}
