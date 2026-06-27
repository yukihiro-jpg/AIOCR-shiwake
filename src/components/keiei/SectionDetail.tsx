'use client'

import { useState } from 'react'
import type { FiscalYearData } from '@/lib/keiei/types'
import { CODES, getRow, ytd, singleMonth } from '@/lib/keiei/calc'
import { detailsOf, rowYtd } from '@/lib/keiei/analysis'
import { fmtYen, fmtShort, fmtPct } from '@/lib/keiei/format'
import { MultiLine, HBars } from './charts'

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

function rankItems(fy: FiscalYearData, subtotalCode: string, monthIdx: number, salesYtd: number, topN = 12) {
  const details = detailsOf(fy, subtotalCode)
    .map((a) => ({ label: a.name.trim(), value: rowYtd(a, monthIdx) }))
    .filter((x) => Math.abs(x.value) > 0)
    .sort((a, b) => b.value - a.value)
  const top = details.slice(0, topN)
  const rest = details.slice(topN)
  if (rest.length) top.push({ label: `その他 ${rest.length}科目`, value: rest.reduce((s, x) => s + x.value, 0) })
  return top.map((x) => ({ ...x, sub: salesYtd ? fmtPct((x.value / salesYtd) * 100) : '' }))
}

export default function SectionDetail({ fy, monthIdx }: { fy: FiscalYearData; monthIdx: number }) {
  const [tab, setTab] = useState<'PL' | 'BS'>('PL')
  const upto = fy.lastFilledIndex + 1
  const monthLabels = fy.fiscalMonths.slice(0, upto).map((m) => `${m}月`)
  const monthLabel = `${fy.fiscalMonths[monthIdx]}月`

  // 利益率の推移（単月）
  const sales = getRow(fy, CODES.sales)?.monthly || []
  const gp = getRow(fy, CODES.grossProfit)?.monthly || []
  const op = getRow(fy, CODES.opProfit)?.monthly || []
  const ord = getRow(fy, CODES.ordProfit)?.monthly || []
  const ratioAt = (num: number[], i: number) => (sales[i] ? (num[i] / sales[i]) * 100 : 0)
  const gmS = monthLabels.map((_, i) => ratioAt(gp, i))
  const omS = monthLabels.map((_, i) => ratioAt(op, i))
  const ordS = monthLabels.map((_, i) => ratioAt(ord, i))

  const salesYtd = ytd(fy, CODES.sales, monthIdx)

  // 主要BS推移（残高、当期月別）
  const cashS = (getRow(fy, CODES.cash)?.monthly || []).slice(0, upto)
  const netS = (getRow(fy, CODES.netAsset)?.monthly || []).slice(0, upto)
  const assetS = (getRow(fy, CODES.assetTotal)?.monthly || []).slice(0, upto)

  // 全科目明細
  const plRows = fy.rows.filter((r) => r.statement === 'PL')
  const bsRows = fy.rows.filter((r) => r.statement === 'BS')
  const baseFor = (statement: 'PL' | 'BS') => statement === 'PL' ? salesYtd : singleMonth(fy, CODES.assetTotal, monthIdx)

  return (
    <div className="space-y-5">
      <Section title="利益率の推移（当期・月別）" note="売上に対する各利益の割合">
        <MultiLine labels={monthLabels} unit="pct" series={[
          { label: '粗利率', values: gmS, color: '#1F3A5F' },
          { label: '営業利益率', values: omS, color: '#3b82f6' },
          { label: '経常利益率', values: ordS, color: '#C8A24B' },
        ]} />
      </Section>

      <div className="grid md:grid-cols-2 gap-5">
        <Section title={`販管費 科目別ランキング（期首〜${monthLabel} 累計）`} note="どの経費が効いているか">
          <HBars items={rankItems(fy, CODES.sgna, monthIdx, salesYtd)} color="#ef6b6b" />
        </Section>
        <Section title={`売上の内訳（期首〜${monthLabel} 累計）`}>
          <HBars items={rankItems(fy, CODES.sales, monthIdx, salesYtd)} color="#3b82f6" />
        </Section>
      </div>

      <Section title="主要BS科目の推移（当期・各月末残高）">
        <MultiLine labels={monthLabels} unit="yen" series={[
          { label: '総資産', values: assetS, color: '#1F3A5F' },
          { label: '純資産', values: netS, color: '#3b82f6' },
          { label: '現預金', values: cashS, color: '#10b981' },
        ]} />
      </Section>

      <Section title={`全科目明細（${monthLabel}単月／期首〜${monthLabel}累計）`}>
        <div className="flex gap-1 mb-2">
          {(['PL', 'BS'] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-3 py-1 text-xs rounded ${tab === t ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
              {t === 'PL' ? '損益計算書' : '貸借対照表'}
            </button>
          ))}
        </div>
        <div className="overflow-auto max-h-[460px] border border-gray-100 rounded">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-gray-50">
              <tr className="text-gray-500">
                <th className="text-left px-3 py-1.5">科目</th>
                <th className="text-right px-3 py-1.5">当月(単月)</th>
                <th className="text-right px-3 py-1.5">{tab === 'PL' ? '累計' : '残高'}</th>
                <th className="text-right px-3 py-1.5">構成比</th>
              </tr>
            </thead>
            <tbody>
              {(tab === 'PL' ? plRows : bsRows).map((r, i) => {
                const single = r.monthly[monthIdx] ?? 0
                const cum = rowYtd(r, monthIdx)
                const base = baseFor(tab)
                const ratio = base ? (cum / base) * 100 : 0
                return (
                  <tr key={i} className={`border-b border-gray-50 ${r.isSubtotal ? (r.bracket === 'profit' ? 'bg-blue-50/50 font-bold' : 'bg-gray-50 font-semibold') : ''}`}>
                    <td className="px-3 py-1" style={{ paddingLeft: 12 + r.level * 12 }}>{r.name.trim()}</td>
                    <td className="px-3 py-1 text-right tabular-nums">{fmtYen(single)}</td>
                    <td className="px-3 py-1 text-right tabular-nums">{fmtYen(cum)}</td>
                    <td className="px-3 py-1 text-right text-gray-400">{base ? fmtPct(ratio) : ''}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <div className="text-[11px] text-gray-400 mt-1">※ 構成比は{tab === 'PL' ? '売上高' : '総資産'}に対する割合（累計ベース）。{fmtShort(baseFor(tab))} 基準。</div>
      </Section>
    </div>
  )
}
