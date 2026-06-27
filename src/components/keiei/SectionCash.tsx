'use client'

import type { FiscalYearData } from '@/lib/keiei/types'
import { singleMonth } from '@/lib/keiei/calc'
import { safety, debtAccounts, landingScenarios, type KeieiSettings } from '@/lib/keiei/analysis'
import { fmtYen, fmtShort, fmtPct } from '@/lib/keiei/format'
import { MultiLine, GroupedBars } from './charts'

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-[0_3px_10px_rgba(26,115,232,0.06)] p-5">
      <div className="flex items-baseline gap-2 mb-3">
        <h2 className="text-sm font-bold text-gray-800">{title}</h2>
        {note && <span className="text-xs text-gray-400">{note}</span>}
      </div>
      {children}
    </div>
  )
}

function yearsText(v: number | null): string { return v == null ? '—' : `${v.toFixed(1)}年` }

export default function SectionCash({ fy, monthIdx, settings, onSettingsChange, years }: {
  fy: FiscalYearData
  monthIdx: number
  settings: KeieiSettings
  onSettingsChange: (s: KeieiSettings) => void
  years: Record<string, FiscalYearData>
}) {
  const s = safety(fy, monthIdx, settings)
  const { loans, leases } = debtAccounts(fy)
  const ex = settings.loanExclude || {}
  const monthLabel = `${fy.fiscalMonths[monthIdx]}月`
  const upto = monthIdx + 1 // 対象月までの推移
  const monthLabels = fy.fiscalMonths.slice(0, upto).map((m) => `${m}月`)

  // 借入・リース残高の推移
  const loanSeries = monthLabels.map((_, i) => loans.filter((a) => !ex[a.code]).reduce((t, a) => t + (a.monthly[i] ?? 0), 0))
  const leaseSeries = monthLabels.map((_, i) => leases.filter((a) => !ex[a.code]).reduce((t, a) => t + (a.monthly[i] ?? 0), 0))

  const toggleExclude = (code: string) => onSettingsChange({ ...settings, loanExclude: { ...ex, [code]: !ex[code] } })

  // 着地見込み
  const landing = landingScenarios(years, fy)
  const metrics: { key: 'sales' | 'opProfit' | 'ordProfit'; label: string }[] = [
    { key: 'sales', label: '売上高' }, { key: 'opProfit', label: '営業利益' }, { key: 'ordProfit', label: '経常利益' },
  ]

  return (
    <div className="space-y-5">
      <Section title={`資金繰り・安全性（${monthLabel}時点）`} note={`期中は ${s.months}ヶ月実績を年換算`}>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-3">
          <Stat label="簡易CF（年換算）" value={s.simpleCfAnnual} sub="税引後利益＋減価償却" />
          <Stat label="債務償還年数①" text={yearsText(s.payoffLoans)} good={s.payoffLoans != null && s.payoffLoans <= 10} sub="金融機関借入" />
          <Stat label="債務償還年数②" text={yearsText(s.payoffLoansLease)} good={s.payoffLoansLease != null && s.payoffLoansLease <= 10} sub="＋リース債務" />
          <Stat label="手元流動性" text={`${s.liquidityMonths.toFixed(1)}ヶ月`} good={s.liquidityMonths >= 1} sub="現預金÷月商" />
          <Stat label="自己資本比率" text={fmtPct(s.equityRatio)} good={s.equityRatio >= 30} />
        </div>
        <div className="mt-2 text-xs text-gray-500 leading-relaxed">
          実効税率 <b>{fmtPct(s.taxRate * 100)}</b>（中小法人・所得連動の概算）で税引後利益を算定し、減価償却費を加えた簡易CFです。
          金融機関有利子負債 <b>{fmtShort(s.loans)}</b>、リース債務 <b>{fmtShort(s.leases)}</b>、現預金 <b>{fmtShort(s.cash)}</b>、月商 <b>{fmtShort(s.monthlySales)}</b>。
          債務償還年数は「有利子負債 ÷ 年間簡易CF」。一般に10年以内が目安です。
        </div>
      </Section>

      <Section title={`借入・リース残高の推移（各月末・期首〜${monthLabel}）`} note="残高の減少＝元金の返済が進んでいる目安">
        <MultiLine labels={monthLabels} unit="yen" showTable series={[
          { label: '金融機関借入', values: loanSeries, color: '#1F3A5F' },
          { label: 'リース債務', values: leaseSeries, color: '#C8A24B' },
        ]} />
      </Section>

      {(loans.length > 0 || leases.length > 0) && (
        <Section title="有利子負債の内訳（残高）" note="名称から自動判定。役員借入等は除外できます">
          <table className="w-full text-xs">
            <thead><tr className="text-gray-500 bg-gray-50"><th className="text-left px-3 py-1.5">科目</th><th className="text-left px-3 py-1.5">区分</th><th className="text-right px-3 py-1.5">残高</th><th className="text-center px-3 py-1.5">計算対象</th></tr></thead>
            <tbody>
              {[...loans.map((a) => ({ a, kind: '金融機関' })), ...leases.map((a) => ({ a, kind: 'リース' }))].map(({ a, kind }) => (
                <tr key={a.code} className="border-b border-gray-50">
                  <td className="px-3 py-1">{a.name.trim()}</td>
                  <td className="px-3 py-1 text-gray-500">{kind}</td>
                  <td className="px-3 py-1 text-right tabular-nums">{fmtYen(singleMonth(fy, a.code, monthIdx))}</td>
                  <td className="px-3 py-1 text-center">
                    <button onClick={() => toggleExclude(a.code)} className={`px-2 py-0.5 rounded text-[11px] ${ex[a.code] ? 'bg-gray-100 text-gray-400' : 'bg-green-100 text-green-700'}`}>{ex[a.code] ? '除外中' : '対象'}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      <Section title="着地見込み（通期予測）" note={landing.partial ? `${monthLabel}までの実績＋残月をシナリオ別に予測` : '当期は通期確定済み'}>
        {landing.partial ? (
          <>
            <GroupedBars
              groups={metrics.map((m) => ({ label: m.label, values: landing.scenarios.map((sc) => sc[m.key]) }))}
              seriesLabels={landing.scenarios.map((sc) => sc.label)}
              colors={['#94a3b8', '#3b82f6', '#10b981']}
            />
            <div className="overflow-x-auto mt-3">
              <table className="w-full text-sm">
                <thead><tr className="text-xs text-gray-500 bg-gray-50"><th className="text-left px-3 py-2">シナリオ</th><th className="text-right px-3 py-2">売上高</th><th className="text-right px-3 py-2">営業利益</th><th className="text-right px-3 py-2">経常利益</th></tr></thead>
                <tbody>
                  {landing.scenarios.map((sc) => (
                    <tr key={sc.key} className="border-b border-gray-100">
                      <td className="px-3 py-1.5 font-medium">{sc.label}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{fmtYen(sc.sales)}</td>
                      <td className={`px-3 py-1.5 text-right tabular-nums ${sc.opProfit < 0 ? 'text-red-600' : ''}`}>{fmtYen(sc.opProfit)}</td>
                      <td className={`px-3 py-1.5 text-right tabular-nums ${sc.ordProfit < 0 ? 'text-red-600' : ''}`}>{fmtYen(sc.ordProfit)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="text-[11px] text-gray-400 mt-1">※ 保守＝残月を前年同月実績。標準＝前期・前々期の同月平均×今期ペース。楽観＝前年同月+5%。前年データがないシナリオは概算精度が落ちます。</div>
          </>
        ) : (
          <div className="text-sm text-gray-600">当期は12ヶ月すべて入力済みのため、着地は確定値です。期中データを取り込むと予測を表示します。</div>
        )}
      </Section>
    </div>
  )
}

function Stat({ label, value, sub, text, good }: { label: string; value?: number; sub?: string; text?: string; good?: boolean }) {
  return (
    <div className="rounded-xl border border-gray-100 bg-white p-4 shadow-[0_3px_10px_rgba(26,115,232,0.06)]">
      <div className="text-[13px] font-semibold text-gray-600 mb-1.5 truncate">{label}</div>
      <div className={`text-[22px] leading-none font-extrabold ${good == null ? 'text-gray-900' : good ? 'text-green-600' : 'text-amber-600'}`}>{text != null ? text : fmtShort(value || 0)}</div>
      {sub && <div className="text-[11px] text-gray-400 mt-1.5">{sub}</div>}
    </div>
  )
}
