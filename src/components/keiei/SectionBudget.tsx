'use client'

import { useState } from 'react'
import type { FiscalYearData } from '@/lib/keiei/types'
import { suggestBudget, budgetVsActual } from '@/lib/keiei/budget'
import type { KeieiSettings, YearBudget } from '@/lib/keiei/analysis'
import { fmtYen, fmtShort, fmtPct } from '@/lib/keiei/format'
import { GroupedBars } from './charts'

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-[0_3px_10px_rgba(26,115,232,0.06)] p-5">
      <div className="flex items-baseline gap-2 mb-3">
        <h2 className="text-[15px] font-bold text-gray-800">{title}</h2>
        {note && <span className="text-xs text-gray-400">{note}</span>}
      </div>
      {children}
    </div>
  )
}

function parseNum(s: string) { return Number(s.replace(/[^0-9.\-]/g, '')) || 0 }
function MoneyInput({ value, onChange, className }: { value: number; onChange: (v: number) => void; className?: string }) {
  const [focused, setFocused] = useState(false)
  const [draft, setDraft] = useState('')
  return (
    <input type="text" inputMode="numeric"
      value={focused ? draft : (value ? value.toLocaleString('ja-JP') : '')}
      onFocus={() => { setDraft(value ? String(value) : ''); setFocused(true) }}
      onChange={(e) => { setDraft(e.target.value); onChange(parseNum(e.target.value)) }}
      onBlur={() => setFocused(false)}
      placeholder="0" className={className} />
  )
}

export default function SectionBudget({ fy, monthIdx, yearId, settings, onSettingsChange, years }: {
  fy: FiscalYearData
  monthIdx: number
  yearId: string
  settings: KeieiSettings
  onSettingsChange: (s: KeieiSettings) => void
  years: Record<string, FiscalYearData>
}) {
  const monthLabel = `${fy.fiscalMonths[monthIdx]}月`
  const budget = settings.budgets?.[yearId]

  const saveBudget = (b: YearBudget) => onSettingsChange({ ...settings, budgets: { ...(settings.budgets || {}), [yearId]: b } })
  const removeBudget = () => { const next = { ...(settings.budgets || {}) }; delete next[yearId]; onSettingsChange({ ...settings, budgets: next }) }
  const createFromSuggest = () => saveBudget(suggestBudget(years, fy))

  if (!budget) {
    const sug = suggestBudget(years, fy)
    return (
      <Section title="予算・予実対比" note="通期の売上・粗利率・販管費だけで作れる簡易予算">
        <div className="rounded-xl border-2 border-dashed border-blue-200 bg-blue-50/40 p-6 text-center">
          <div className="text-4xl opacity-40 mb-2">🎯</div>
          <div className="text-gray-700 font-semibold mb-1">この期の予算はまだ作成されていません</div>
          <div className="text-xs text-gray-500 mb-4 leading-relaxed">
            通期の「売上高・粗利率・販管費」の3つを決めるだけで、営業利益予算まで自動計算します。<br />
            月次の予実対比は、前年の季節性（無ければ均等）で予算を各月へ割り付けて算定します。
          </div>
          <button onClick={createFromSuggest}
            className="px-5 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-bold hover:bg-blue-700">
            前年実績をもとに予算を作成
          </button>
          <div className="text-[11px] text-gray-400 mt-2">
            提案値：売上 {fmtShort(sug.sales)}／粗利率 {sug.grossMargin}%／販管費 {fmtShort(sug.sgna)}（作成後に自由に調整できます）
          </div>
        </div>
      </Section>
    )
  }

  const grossFull = budget.sales * (budget.grossMargin / 100)
  const opFull = grossFull - budget.sgna
  const va = budgetVsActual(years, fy, monthIdx, budget)
  const auto = buildBudgetComment(va, monthLabel)
  const comment = budget.comment ?? auto

  return (
    <div className="space-y-5">
      {/* 予算の入力 */}
      <Section title="予算の作成（通期）" note="3つの値を入れるだけ。営業利益は自動計算されます">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <div className="rounded-xl border border-gray-200 bg-gray-50/40 p-3">
            <label className="text-[12px] font-semibold text-gray-600 block mb-1">通期 売上高</label>
            <div className="flex items-center gap-1.5">
              <MoneyInput value={budget.sales} onChange={(v) => saveBudget({ ...budget, sales: v })} className="flex-1 min-w-0 px-2 py-1.5 border border-gray-300 rounded text-right tabular-nums text-sm" />
              <span className="text-xs text-gray-400">円</span>
            </div>
          </div>
          <div className="rounded-xl border border-gray-200 bg-gray-50/40 p-3">
            <label className="text-[12px] font-semibold text-gray-600 block mb-1">粗利率</label>
            <div className="flex items-center gap-1.5">
              <input type="number" step={0.1} value={budget.grossMargin} onChange={(e) => saveBudget({ ...budget, grossMargin: Number(e.target.value) })}
                className="flex-1 min-w-0 px-2 py-1.5 border border-gray-300 rounded text-right tabular-nums text-sm" />
              <span className="text-xs text-gray-400">%</span>
            </div>
          </div>
          <div className="rounded-xl border border-gray-200 bg-gray-50/40 p-3">
            <label className="text-[12px] font-semibold text-gray-600 block mb-1">通期 販管費</label>
            <div className="flex items-center gap-1.5">
              <MoneyInput value={budget.sgna} onChange={(v) => saveBudget({ ...budget, sgna: v })} className="flex-1 min-w-0 px-2 py-1.5 border border-gray-300 rounded text-right tabular-nums text-sm" />
              <span className="text-xs text-gray-400">円</span>
            </div>
          </div>
          <div className="rounded-xl border border-[#1F3A5F]/30 bg-[#f4f8ff] p-3">
            <div className="text-[12px] font-semibold text-gray-600 mb-1">営業利益（予算・自動）</div>
            <div className={`text-[20px] leading-tight font-extrabold tabular-nums ${opFull < 0 ? 'text-red-600' : 'text-[#1F3A5F]'}`}>{fmtShort(opFull)}</div>
            <div className="text-[11px] text-gray-400 mt-0.5">粗利 {fmtShort(grossFull)} − 販管費 {fmtShort(budget.sgna)}</div>
          </div>
        </div>
        <div className="flex items-center gap-2 mt-3">
          <button onClick={createFromSuggest} className="px-3 py-1.5 text-xs bg-blue-50 text-blue-700 border border-blue-200 rounded hover:bg-blue-100">前年実績で作り直す</button>
          <button onClick={removeBudget} className="px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-100 rounded">予算を削除</button>
        </div>
      </Section>

      {/* 予実対比（YTD） */}
      <Section title={`予実対比（期首〜${monthLabel} 累計）`} note={va.hasPriorSeason ? '前年の季節性で予算を月配分' : '前年データが無いため均等配分で概算'}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-xs text-gray-500 bg-gray-50">
              <th className="text-left px-3 py-2">指標</th>
              <th className="text-right px-3 py-2">予算(YTD)</th>
              <th className="text-right px-3 py-2">実績(YTD)</th>
              <th className="text-right px-3 py-2">差異</th>
              <th className="text-right px-3 py-2">達成率</th>
            </tr></thead>
            <tbody>
              {va.lines.map((l) => {
                const diff = l.actualYtd - l.budgetYtd
                return (
                  <tr key={l.label} className="border-b border-gray-100">
                    <td className="px-3 py-2 font-medium text-gray-800">{l.label}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-gray-500">{fmtYen(l.budgetYtd)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums font-bold ${l.actualYtd < 0 ? 'text-red-600' : 'text-gray-900'}`}>{fmtYen(l.actualYtd)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums font-bold ${diff >= 0 ? 'text-green-600' : 'text-red-600'}`}>{diff >= 0 ? '＋' : '−'}{fmtShort(Math.abs(diff))}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {l.achieveYtd == null ? '—' : <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${l.achieveYtd >= 100 ? 'bg-green-100 text-green-700' : l.achieveYtd >= 90 ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-600'}`}>{l.achieveYtd.toFixed(0)}%</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <div className="mt-4">
          <GroupedBars
            groups={va.lines.map((l) => ({ label: l.label, values: [l.budgetYtd, l.actualYtd] }))}
            seriesLabels={['予算(YTD)', '実績(YTD)']}
            colors={['#94a3b8', '#1a73e8']}
          />
        </div>
        <div className="text-[11px] text-gray-400 mt-2">※ 予算(YTD)＝通期予算 × 進捗（売上・粗利は季節性配分、販管費は月数按分 {va.months}/12）。達成率＝実績÷予算。</div>
      </Section>

      {/* 通期予算 vs 着地見込み */}
      <Section title="通期予算 vs 着地見込み" note="今のペースで着地した場合、予算に対してどうか">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {va.lines.map((l) => {
            if (l.landingFull == null) return (
              <div key={l.label} className="rounded-xl border border-gray-200 bg-white p-4">
                <div className="text-[13px] font-semibold text-gray-600 mb-1">{l.label}</div>
                <div className="text-[13px] text-gray-500">予算 {fmtShort(l.budgetFull)}</div>
                <div className="text-[11px] text-gray-400 mt-1">着地見込みは売上・営業利益で表示</div>
              </div>
            )
            const gap = l.landingFull - l.budgetFull
            const ok = gap >= 0
            return (
              <div key={l.label} className={`rounded-xl border p-4 ${ok ? 'border-green-200 bg-green-50/60' : 'border-amber-200 bg-amber-50/60'}`}>
                <div className="text-[13px] font-semibold text-gray-600 mb-1">{l.label}</div>
                <div className="text-[13px] text-gray-500 tabular-nums">予算 {fmtShort(l.budgetFull)} <span className="text-gray-400">／</span> 着地 <b className="text-gray-900">{fmtShort(l.landingFull)}</b></div>
                <div className={`text-[18px] leading-tight font-extrabold tabular-nums mt-1 ${ok ? 'text-green-700' : 'text-amber-700'}`}>
                  {ok ? '＋' : '−'}{fmtShort(Math.abs(gap))} <span className="text-[12px] font-semibold">{ok ? '予算超過見込み' : '未達見込み'}</span>
                </div>
              </div>
            )
          })}
        </div>
      </Section>

      {/* コメント */}
      <Section title="予実のコメント（所見）" note="自動生成された文章を編集できます">
        <textarea value={comment} onChange={(e) => saveBudget({ ...budget, comment: e.target.value })} rows={4}
          className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-blue-200" />
        <div className="flex justify-end mt-2">
          <button onClick={() => saveBudget({ ...budget, comment: undefined })} className="px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-100 rounded">自動コメントに戻す</button>
        </div>
      </Section>
    </div>
  )
}

function buildBudgetComment(va: ReturnType<typeof budgetVsActual>, monthLabel: string): string {
  const sales = va.lines[0]
  const op = va.lines[2]
  const parts: string[] = []
  if (sales.achieveYtd != null) {
    parts.push(`期首〜${monthLabel}の売上高は予算比 ${sales.achieveYtd.toFixed(0)}%（${sales.actualYtd - sales.budgetYtd >= 0 ? '予算を上回る' : '予算に届かない'} ${fmtShort(Math.abs(sales.actualYtd - sales.budgetYtd))}）です。`)
  }
  if (op.achieveYtd != null) {
    parts.push(`営業利益は予算比 ${op.achieveYtd.toFixed(0)}%で、${op.actualYtd - op.budgetYtd >= 0 ? '計画を上回って推移' : '計画を下回って推移'}しています。`)
  }
  if (op.landingFull != null) {
    const gap = op.landingFull - op.budgetFull
    parts.push(`このペースの通期着地は営業利益 ${fmtShort(op.landingFull)} で、通期予算 ${fmtShort(op.budgetFull)} に対し ${gap >= 0 ? `${fmtShort(gap)} 超過` : `${fmtShort(Math.abs(gap))} 未達`}の見込みです。`)
    if (gap < 0) parts.push('残り期間で売上の上乗せ、粗利率の改善、固定費の見直しのいずれかが必要です。')
  }
  return parts.join('')
}
