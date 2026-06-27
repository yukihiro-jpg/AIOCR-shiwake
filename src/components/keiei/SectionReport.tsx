'use client'

import { useState, useMemo } from 'react'
import type { FiscalYearData } from '@/lib/keiei/types'
import { CODES, ytd, singleMonth } from '@/lib/keiei/calc'
import { aggregateRows, aggRowValue, type AggRow } from '@/lib/keiei/analysis'

// 会計報告表記: 負数は △、3桁区切り、0は空欄
function fmtN(n: number): string {
  if (!n) return '0'
  const a = Math.round(Math.abs(n)).toLocaleString('ja-JP')
  return n < 0 ? `△${a}` : a
}
function fmtPctN(n: number): string { return `${n.toFixed(1)}%` }

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <div className="flex items-baseline gap-3 mb-2">
        <h2 className="text-sm font-bold text-gray-800">{title}</h2>
        {subtitle && <span className="text-xs text-gray-400">{subtitle}</span>}
        <span className="ml-auto text-[11px] text-gray-400">（単位：円）</span>
      </div>
      {children}
    </div>
  )
}

function rowCls(r: { isSubtotal: boolean; bracket: string }) {
  if (!r.isSubtotal) return ''
  return r.bracket === 'profit' ? 'bg-blue-50 font-bold text-[#1F3A5F]' : 'bg-gray-100 font-bold'
}

export default function SectionReport({ fy, comp, monthIdx }: {
  fy: FiscalYearData; comp: FiscalYearData[]; monthIdx: number
}) {
  const [sub, setSub] = useState<'trial' | 'compare' | 'trend'>('trial')
  const [cmpMode, setCmpMode] = useState<'single' | 'cum'>('cum')
  const monthLabel = `${fy.fiscalMonths[monthIdx]}月`
  const months = fy.fiscalMonths.slice(0, monthIdx + 1)

  const rows = useMemo(() => aggregateRows(fy), [fy])
  const plRows = rows.filter((r) => r.statement === 'PL')
  const bsRows = rows.filter((r) => r.statement === 'BS')
  const salesYtd = ytd(fy, CODES.sales, monthIdx)
  const assetBal = singleMonth(fy, CODES.assetTotal, monthIdx)

  return (
    <div className="space-y-4">
      <div className="flex gap-1 flex-wrap">
        {([['trial', '月次試算表'], ['compare', '3期比較'], ['trend', '推移試算表']] as ['trial' | 'compare' | 'trend', string][]).map(([v, l]) => (
          <button key={v} onClick={() => setSub(v)}
            className={`px-3 py-1.5 text-sm rounded-lg ${sub === v ? 'bg-slate-700 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>{l}</button>
        ))}
      </div>

      {/* ===== 月次試算表 ===== */}
      {sub === 'trial' && (
        <>
          <Card title="損益計算書（月次試算表）" subtitle={`${monthLabel}単月 ／ 期首〜${monthLabel}累計`}>
            <TrialPL rows={plRows} monthIdx={monthIdx} salesYtd={salesYtd} />
          </Card>
          <Card title="貸借対照表（月次試算表）" subtitle={`${monthLabel}末残高`}>
            <TrialBS rows={bsRows} monthIdx={monthIdx} assetBal={assetBal} />
          </Card>
        </>
      )}

      {/* ===== 3期比較 ===== */}
      {sub === 'compare' && (
        <>
          <div className="flex gap-1">
            {([['single', `${monthLabel} 単月`], ['cum', `期首〜${monthLabel} 累計`]] as ['single' | 'cum', string][]).map(([v, l]) => (
              <button key={v} onClick={() => setCmpMode(v)}
                className={`px-3 py-1 text-xs rounded ${cmpMode === v ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>{l}</button>
            ))}
          </div>
          {comp.length < 2 && <div className="text-xs text-amber-600">比較できる前期データがありません。前期・前々期のCSVも取り込んでください。</div>}
          <Card title="損益計算書（3期比較）" subtitle={cmpMode === 'single' ? `${monthLabel} 単月` : `期首〜${monthLabel} 累計`}>
            <CompareTable rows={plRows} comp={comp} monthIdx={monthIdx} mode={cmpMode} />
          </Card>
          <Card title="貸借対照表（3期比較）" subtitle={`${monthLabel}末残高`}>
            <CompareTable rows={bsRows} comp={comp} monthIdx={monthIdx} mode="single" />
          </Card>
        </>
      )}

      {/* ===== 推移試算表 ===== */}
      {sub === 'trend' && (
        <>
          <Card title="損益計算書（月次推移）" subtitle={`単月発生額 ／ 期首〜${monthLabel}`}>
            <TrendGrid rows={plRows} months={months} monthIdx={monthIdx} cumLabel="累計" cumMode="cum" />
          </Card>
          <Card title="貸借対照表（月次推移）" subtitle={`各月末残高 ／ 〜${monthLabel}`}>
            <TrendGrid rows={bsRows} months={months} monthIdx={monthIdx} cumLabel={`${monthLabel}末`} cumMode="single" />
          </Card>
        </>
      )}
    </div>
  )
}

function bgFor(r: { isSubtotal: boolean; bracket: string }): string {
  if (!r.isSubtotal) return '#ffffff'
  return r.bracket === 'profit' ? '#eff6ff' : '#f3f4f6'
}
function NameTd({ r }: { r: AggRow }) {
  return <td className="text-left px-2 py-1 whitespace-nowrap sticky left-0" style={{ paddingLeft: 8 + r.level * 12, background: bgFor(r) }}>{r.name}</td>
}

function TrialPL({ rows, monthIdx, salesYtd }: { rows: AggRow[]; monthIdx: number; salesYtd: number }) {
  return (
    <div className="overflow-x-auto max-h-[560px]">
      <table className="w-full text-xs border-collapse">
        <thead className="sticky top-0 z-10">
          <tr className="bg-[#1F3A5F] text-white">
            <th className="text-left px-2 py-1.5 sticky left-0 bg-[#1F3A5F]">科目</th>
            <th className="text-right px-2 py-1.5">当月（単月）</th>
            <th className="text-right px-2 py-1.5">累計</th>
            <th className="text-right px-2 py-1.5">対売上比</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const single = aggRowValue(r, monthIdx, 'single')
            const cum = aggRowValue(r, monthIdx, 'cum')
            return (
              <tr key={i} className={`border-b border-gray-100 ${rowCls(r)}`}>
                <NameTd r={r} />
                <td className="text-right px-2 py-1 tabular-nums">{fmtN(single)}</td>
                <td className="text-right px-2 py-1 tabular-nums">{fmtN(cum)}</td>
                <td className="text-right px-2 py-1 text-gray-500">{salesYtd ? fmtPctN((cum / salesYtd) * 100) : ''}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function TrialBS({ rows, monthIdx, assetBal }: { rows: AggRow[]; monthIdx: number; assetBal: number }) {
  return (
    <div className="overflow-x-auto max-h-[560px]">
      <table className="w-full text-xs border-collapse">
        <thead className="sticky top-0 z-10">
          <tr className="bg-[#1F3A5F] text-white">
            <th className="text-left px-2 py-1.5 sticky left-0 bg-[#1F3A5F]">科目</th>
            <th className="text-right px-2 py-1.5">前月末残高</th>
            <th className="text-right px-2 py-1.5">当月末残高</th>
            <th className="text-right px-2 py-1.5">増減</th>
            <th className="text-right px-2 py-1.5">構成比</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const cur = r.monthly[monthIdx] ?? 0
            const prev = monthIdx > 0 ? (r.monthly[monthIdx - 1] ?? 0) : 0
            return (
              <tr key={i} className={`border-b border-gray-100 ${rowCls(r)}`}>
                <NameTd r={r} />
                <td className="text-right px-2 py-1 tabular-nums text-gray-500">{fmtN(prev)}</td>
                <td className="text-right px-2 py-1 tabular-nums">{fmtN(cur)}</td>
                <td className={`text-right px-2 py-1 tabular-nums ${cur - prev < 0 ? 'text-red-500' : ''}`}>{fmtN(cur - prev)}</td>
                <td className="text-right px-2 py-1 text-gray-500">{assetBal ? fmtPctN((cur / assetBal) * 100) : ''}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function CompareTable({ rows, comp, monthIdx, mode }: { rows: AggRow[]; comp: FiscalYearData[]; monthIdx: number; mode: 'single' | 'cum' }) {
  // 各比較期の集約マップ
  const maps = useMemo(() => comp.map((y) => {
    const m = new Map<string, AggRow>()
    for (const r of aggregateRows(y)) m.set(r.statement + '|' + r.name, r)
    return m
  }), [comp])
  const cur = comp[comp.length - 1]
  const prev = comp.length >= 2 ? comp[comp.length - 2] : null
  const prev2 = comp.length >= 3 ? comp[comp.length - 3] : null
  const valFor = (yearIdx: number, r: AggRow): number | null => {
    const row = maps[yearIdx]?.get(r.statement + '|' + r.name)
    return row ? aggRowValue(row, monthIdx, mode) : null
  }
  const idxCur = comp.length - 1, idxPrev = comp.length - 2, idxPrev2 = comp.length - 3
  return (
    <div className="overflow-x-auto max-h-[560px]">
      <table className="w-full text-xs border-collapse">
        <thead className="sticky top-0 z-10">
          <tr className="bg-[#1F3A5F] text-white">
            <th className="text-left px-2 py-1.5 sticky left-0 bg-[#1F3A5F]">科目</th>
            <th className="text-right px-2 py-1.5">{prev2 ? prev2.label : '前々期'}</th>
            <th className="text-right px-2 py-1.5">{prev ? prev.label : '前期'}</th>
            <th className="text-right px-2 py-1.5">{cur.label}（当期）</th>
            <th className="text-right px-2 py-1.5">前期比増減</th>
            <th className="text-right px-2 py-1.5">増減率</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const vCur = valFor(idxCur, r) ?? 0
            const vPrev = idxPrev >= 0 ? valFor(idxPrev, r) : null
            const vPrev2 = idxPrev2 >= 0 ? valFor(idxPrev2, r) : null
            const diff = vPrev != null ? vCur - vPrev : null
            const rate = vPrev != null && vPrev !== 0 ? ((vCur - vPrev) / Math.abs(vPrev)) * 100 : null
            return (
              <tr key={i} className={`border-b border-gray-100 ${rowCls(r)}`}>
                <NameTd r={r} />
                <td className="text-right px-2 py-1 tabular-nums text-gray-500">{vPrev2 == null ? '—' : fmtN(vPrev2)}</td>
                <td className="text-right px-2 py-1 tabular-nums text-gray-500">{vPrev == null ? '—' : fmtN(vPrev)}</td>
                <td className="text-right px-2 py-1 tabular-nums font-medium">{fmtN(vCur)}</td>
                <td className={`text-right px-2 py-1 tabular-nums ${diff != null && diff < 0 ? 'text-red-500' : ''}`}>{diff == null ? '—' : fmtN(diff)}</td>
                <td className={`text-right px-2 py-1 ${rate == null ? 'text-gray-400' : rate >= 0 ? 'text-green-600' : 'text-red-500'}`}>{rate == null ? '—' : `${rate >= 0 ? '+' : ''}${rate.toFixed(1)}%`}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function TrendGrid({ rows, months, monthIdx, cumLabel, cumMode }: { rows: AggRow[]; months: number[]; monthIdx: number; cumLabel: string; cumMode: 'single' | 'cum' }) {
  return (
    <div className="overflow-x-auto max-h-[560px]">
      <table className="text-[11px] border-collapse" style={{ minWidth: '100%' }}>
        <thead className="sticky top-0 z-10">
          <tr className="bg-[#1F3A5F] text-white">
            <th className="text-left px-2 py-1.5 sticky left-0 bg-[#1F3A5F] z-20">科目</th>
            {months.map((m, i) => <th key={i} className="text-right px-2 py-1.5 whitespace-nowrap">{m}月</th>)}
            <th className="text-right px-2 py-1.5 whitespace-nowrap bg-[#16304f]">{cumLabel}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={`border-b border-gray-100 ${rowCls(r)}`}>
              <td className="text-left px-2 py-1 whitespace-nowrap sticky left-0 z-10" style={{ paddingLeft: 8 + r.level * 10, background: bgFor(r) }}>{r.name}</td>
              {months.map((_, mi) => <td key={mi} className="text-right px-2 py-1 tabular-nums whitespace-nowrap">{fmtN(r.monthly[mi] ?? 0)}</td>)}
              <td className="text-right px-2 py-1 tabular-nums whitespace-nowrap bg-blue-50 font-medium">{fmtN(aggRowValue(r, monthIdx, cumMode))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
