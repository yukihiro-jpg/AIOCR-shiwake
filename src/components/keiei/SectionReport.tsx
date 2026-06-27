'use client'

import { useState, useMemo } from 'react'
import type { FiscalYearData } from '@/lib/keiei/types'
import { CODES, ytd, singleMonth } from '@/lib/keiei/calc'
import { aggregateRows, aggRowValue, type AggRow } from '@/lib/keiei/analysis'

function fmtN(n: number): string {
  if (!n) return '0'
  const a = Math.round(Math.abs(n)).toLocaleString('ja-JP')
  return n < 0 ? `△${a}` : a
}

function Card({ title, subtitle, children, right }: { title: string; subtitle?: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <h2 className="text-sm font-bold text-gray-800">{title}</h2>
        {subtitle && <span className="text-xs text-gray-400">{subtitle}</span>}
        <span className="ml-auto text-[11px] text-gray-400">（単位：円）</span>
        {right}
      </div>
      {children}
    </div>
  )
}

// 行の背景（控えめなゼブラ＋小計/利益の色分け）
function bgHex(r: { isSubtotal: boolean; bracket: string }, even: boolean): string {
  if (r.isSubtotal) return r.bracket === 'profit' ? '#e8eefc' : '#eef1f5'
  return even ? '#f8fafc' : '#ffffff'
}
// 段階利益・小計の行にはっきりした罫線を付ける
function rowBorder(r: { isSubtotal: boolean; bracket: string }): string {
  if (!r.isSubtotal) return ''
  return r.bracket === 'profit'
    ? '[&>td]:border-y-2 [&>td]:border-slate-400'
    : '[&>td]:border-y [&>td]:border-slate-300'
}

function NumTh({ children, accent, center }: { children: React.ReactNode; accent?: boolean; center?: boolean }) {
  return <th className={`${center ? 'text-center' : 'text-right'} px-3 py-1.5 font-semibold ${accent ? 'bg-[#16304f]' : ''}`} style={{ minWidth: 96 }}>{children}</th>
}
function NumTd({ children, cls = '', strong }: { children: React.ReactNode; cls?: string; strong?: boolean }) {
  return <td className={`text-right px-3 py-1 tabular-nums whitespace-nowrap ${strong ? 'font-bold text-gray-900' : ''} ${cls}`} style={{ minWidth: 96 }}>{children}</td>
}

function GTable({ head, children }: { head: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto max-h-[600px] border border-gray-100 rounded-lg">
      <table className="text-xs border-collapse" style={{ width: 'max-content', minWidth: '100%' }}>
        <thead className="sticky top-0 z-10 bg-[#1F3A5F] text-white">{head}</thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

function NameTd({ r, even }: { r: AggRow; even: boolean }) {
  return (
    <td className={`text-left px-3 py-1 whitespace-nowrap sticky left-0 font-medium ${r.isSubtotal ? (r.bracket === 'profit' ? 'text-[#1F3A5F]' : 'text-gray-800') : 'text-gray-700'}`}
      style={{ paddingLeft: 12 + r.level * 12, background: bgHex(r, even), width: 220, maxWidth: 220, zIndex: 5 }}>
      <span className="block truncate" title={r.name}>{r.name}</span>
    </td>
  )
}

export default function SectionReport({ fy, comp, monthIdx }: {
  fy: FiscalYearData; comp: FiscalYearData[]; monthIdx: number
}) {
  type Tab = 'trialPL' | 'trialBS' | 'cmpPL' | 'cmpBS' | 'trendPL' | 'trendBS'
  const [tab, setTab] = useState<Tab>('trialPL')
  const [cmpMode, setCmpMode] = useState<'single' | 'cum'>('cum')
  const monthLabel = `${fy.fiscalMonths[monthIdx]}月`
  const months = fy.fiscalMonths.slice(0, monthIdx + 1)

  const rows = useMemo(() => aggregateRows(fy), [fy])
  const plRows = rows.filter((r) => r.statement === 'PL')
  const bsRows = rows.filter((r) => r.statement === 'BS')
  const salesYtd = ytd(fy, CODES.sales, monthIdx)
  const assetBal = singleMonth(fy, CODES.assetTotal, monthIdx)

  const tabs: [Tab, string][] = [
    ['trialPL', '月次試算表(PL)'], ['trialBS', '月次試算表(BS)'],
    ['cmpPL', '3期比較(PL)'], ['cmpBS', '3期比較(BS)'],
    ['trendPL', '推移表(PL)'], ['trendBS', '推移表(BS)'],
  ]

  return (
    <div className="space-y-4">
      <div className="flex gap-5 flex-wrap border-b border-gray-200">
        {tabs.map(([v, l]) => (
          <button key={v} onClick={() => setTab(v)}
            className={`px-1 py-2 text-sm border-b-2 -mb-px transition-colors ${tab === v ? 'border-[#1F3A5F] text-[#1F3A5F] font-bold' : 'border-transparent text-gray-500 hover:text-gray-800'}`}>{l}</button>
        ))}
      </div>

      {tab === 'trialPL' && (
        <Card title="損益計算書（月次試算表）" subtitle={`${monthLabel}単月 ／ 期首〜${monthLabel}累計`}>
          <GTable head={<tr><th className="text-left px-3 py-1.5 sticky left-0 bg-[#1F3A5F]" style={{ width: 220 }}>科目</th><NumTh>当月（単月）</NumTh><NumTh accent>累計</NumTh><NumTh>対売上比</NumTh></tr>}>
            {plRows.map((r, i) => {
              const single = aggRowValue(r, monthIdx, 'single'); const cum = aggRowValue(r, monthIdx, 'cum'); const even = i % 2 === 1
              return (
                <tr key={i} className={`border-b border-gray-100 ${rowBorder(r)}`} style={{ background: bgHex(r, even) }}>
                  <NameTd r={r} even={even} />
                  <NumTd cls="text-gray-700">{fmtN(single)}</NumTd>
                  <NumTd strong>{fmtN(cum)}</NumTd>
                  <td className="text-right px-3 py-1 text-gray-500" style={{ minWidth: 72 }}>{salesYtd ? `${((cum / salesYtd) * 100).toFixed(1)}%` : ''}</td>
                </tr>
              )
            })}
          </GTable>
        </Card>
      )}

      {tab === 'trialBS' && (
        <Card title="貸借対照表（月次試算表）" subtitle={`${monthLabel}末残高`}>
          <GTable head={<tr><th className="text-left px-3 py-1.5 sticky left-0 bg-[#1F3A5F]" style={{ width: 220 }}>科目</th><NumTh>前月末残高</NumTh><NumTh accent>当月末残高</NumTh><NumTh>増減</NumTh><NumTh>構成比</NumTh></tr>}>
            {bsRows.map((r, i) => {
              const cur = r.monthly[monthIdx] ?? 0; const prev = monthIdx > 0 ? (r.monthly[monthIdx - 1] ?? 0) : 0; const even = i % 2 === 1
              return (
                <tr key={i} className={`border-b border-gray-100 ${rowBorder(r)}`} style={{ background: bgHex(r, even) }}>
                  <NameTd r={r} even={even} />
                  <NumTd cls="text-gray-500">{fmtN(prev)}</NumTd>
                  <NumTd strong>{fmtN(cur)}</NumTd>
                  <NumTd cls={cur - prev < 0 ? 'text-red-500' : ''}>{fmtN(cur - prev)}</NumTd>
                  <td className="text-right px-3 py-1 text-gray-500" style={{ minWidth: 72 }}>{assetBal ? `${((cur / assetBal) * 100).toFixed(1)}%` : ''}</td>
                </tr>
              )
            })}
          </GTable>
        </Card>
      )}

      {(tab === 'cmpPL' || tab === 'cmpBS') && (
        <CompareView statement={tab === 'cmpPL' ? 'PL' : 'BS'} rows={tab === 'cmpPL' ? plRows : bsRows}
          comp={comp} monthIdx={monthIdx} monthLabel={monthLabel}
          mode={tab === 'cmpPL' ? cmpMode : 'single'} setMode={setCmpMode} />
      )}

      {tab === 'trendPL' && (
        <Card title="損益計算書（月次推移）" subtitle={`単月発生額 ／ 期首〜${monthLabel}`}>
          <TrendGrid rows={plRows} months={months} monthIdx={monthIdx} cumLabel="累計" cumMode="cum" />
        </Card>
      )}
      {tab === 'trendBS' && (
        <Card title="貸借対照表（月次推移）" subtitle={`各月末残高 ／ 〜${monthLabel}`}>
          <TrendGrid rows={bsRows} months={months} monthIdx={monthIdx} cumLabel={`${monthLabel}末`} cumMode="single" />
        </Card>
      )}
    </div>
  )
}

function CompareView({ statement, rows, comp, monthIdx, monthLabel, mode, setMode }: {
  statement: 'PL' | 'BS'; rows: AggRow[]; comp: FiscalYearData[]; monthIdx: number; monthLabel: string
  mode: 'single' | 'cum'; setMode: (m: 'single' | 'cum') => void
}) {
  const maps = useMemo(() => comp.map((y) => {
    const m = new Map<string, AggRow>()
    for (const r of aggregateRows(y)) m.set(r.statement + '|' + r.name, r)
    return m
  }), [comp])
  const cur = comp[comp.length - 1]
  const prev = comp.length >= 2 ? comp[comp.length - 2] : null
  const prev2 = comp.length >= 3 ? comp[comp.length - 3] : null
  const idxCur = comp.length - 1, idxPrev = comp.length - 2, idxPrev2 = comp.length - 3
  const valFor = (yi: number, r: AggRow): number | null => {
    const row = maps[yi]?.get(r.statement + '|' + r.name)
    return row ? aggRowValue(row, monthIdx, mode) : null
  }
  const toggle = statement === 'PL' ? (
    <div className="flex gap-1">
      {([['single', `${monthLabel}単月`], ['cum', `期首〜${monthLabel}累計`]] as ['single' | 'cum', string][]).map(([v, l]) => (
        <button key={v} onClick={() => setMode(v)} className={`px-2.5 py-1 text-xs rounded-full ${mode === v ? 'bg-[#1a73e8] text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>{l}</button>
      ))}
    </div>
  ) : null
  return (
    <Card title={`${statement === 'PL' ? '損益計算書' : '貸借対照表'}（3期比較）`}
      subtitle={statement === 'PL' ? (mode === 'single' ? `${monthLabel}単月` : `期首〜${monthLabel}累計`) : `${monthLabel}末残高`}
      right={toggle}>
      {comp.length < 2 && <div className="text-xs text-amber-600 mb-2">比較できる前期データがありません。前期・前々期のCSVも取り込んでください。</div>}
      <GTable head={<tr>
        <th className="text-left px-3 py-1.5 sticky left-0 bg-[#1F3A5F]" style={{ width: 220 }}>科目</th>
        <NumTh>{prev2 ? prev2.label : '前々期'}</NumTh>
        <NumTh>{prev ? prev.label : '前期'}</NumTh>
        <NumTh accent>{cur.label}（当期）</NumTh>
        <NumTh>前期比増減</NumTh>
        <NumTh>増減率</NumTh>
      </tr>}>
        {rows.map((r, i) => {
          const vCur = valFor(idxCur, r) ?? 0
          const vPrev = idxPrev >= 0 ? valFor(idxPrev, r) : null
          const vPrev2 = idxPrev2 >= 0 ? valFor(idxPrev2, r) : null
          const diff = vPrev != null ? vCur - vPrev : null
          const rate = vPrev != null && vPrev !== 0 ? ((vCur - vPrev) / Math.abs(vPrev)) * 100 : null
          const even = i % 2 === 1
          return (
            <tr key={i} className={`border-b border-gray-100 ${rowBorder(r)}`} style={{ background: bgHex(r, even) }}>
              <NameTd r={r} even={even} />
              <NumTd cls="text-gray-500">{vPrev2 == null ? '—' : fmtN(vPrev2)}</NumTd>
              <NumTd cls="text-gray-500">{vPrev == null ? '—' : fmtN(vPrev)}</NumTd>
              <NumTd strong>{fmtN(vCur)}</NumTd>
              <NumTd cls={diff != null && diff < 0 ? 'text-red-500' : ''}>{diff == null ? '—' : fmtN(diff)}</NumTd>
              <td className={`text-right px-3 py-1 ${rate == null ? 'text-gray-400' : rate >= 0 ? 'text-green-600' : 'text-red-500'}`} style={{ minWidth: 72 }}>{rate == null ? '—' : `${rate >= 0 ? '+' : ''}${rate.toFixed(1)}%`}</td>
            </tr>
          )
        })}
      </GTable>
    </Card>
  )
}

function TrendGrid({ rows, months, monthIdx, cumLabel, cumMode }: { rows: AggRow[]; months: number[]; monthIdx: number; cumLabel: string; cumMode: 'single' | 'cum' }) {
  return (
    <div className="overflow-x-auto max-h-[600px] border border-gray-100 rounded-lg">
      <table className="text-[11px] border-collapse" style={{ width: 'max-content', minWidth: '100%' }}>
        <thead className="sticky top-0 z-10 bg-[#1F3A5F] text-white">
          <tr>
            <th className="text-left px-3 py-1.5 sticky left-0 bg-[#1F3A5F]" style={{ width: 200, zIndex: 20 }}>科目</th>
            {months.map((m, i) => <th key={i} className="text-center px-2.5 py-1.5 whitespace-nowrap" style={{ minWidth: 78 }}>{m}月</th>)}
            <th className="text-center px-2.5 py-1.5 whitespace-nowrap bg-[#16304f]" style={{ minWidth: 90 }}>{cumLabel}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const even = i % 2 === 1
            return (
              <tr key={i} className={`border-b border-gray-100 ${rowBorder(r)}`} style={{ background: bgHex(r, even) }}>
                <td className={`text-left px-3 py-1 whitespace-nowrap sticky left-0 font-medium ${r.isSubtotal ? (r.bracket === 'profit' ? 'text-[#1F3A5F]' : 'text-gray-800') : 'text-gray-700'}`}
                  style={{ paddingLeft: 12 + r.level * 10, background: bgHex(r, even), width: 200, maxWidth: 200, zIndex: 5 }}>
                  <span className="block truncate" title={r.name}>{r.name}</span>
                </td>
                {months.map((_, mi) => <td key={mi} className="text-right px-2.5 py-1 tabular-nums whitespace-nowrap">{fmtN(r.monthly[mi] ?? 0)}</td>)}
                <td className="text-right px-2.5 py-1 tabular-nums whitespace-nowrap font-bold text-gray-900">{fmtN(aggRowValue(r, monthIdx, cumMode))}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
