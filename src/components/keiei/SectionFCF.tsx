'use client'

import type { FiscalYearData } from '@/lib/keiei/types'
import { fcfAnalysis, buildFcfComment, type KeieiSettings } from '@/lib/keiei/analysis'
import { fmtYen, fmtShort } from '@/lib/keiei/format'

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

// 符号付き縦棒（プラス=緑/上, マイナス=赤/下, 合計=ネイビー）
function FcfBars({ items }: { items: { label: string; v: number; total?: boolean }[] }) {
  const W = 760, H = 230, padT = 24, padB = 40, padL = 10, padR = 10
  let max = 0, min = 0
  for (const it of items) { if (it.v > max) max = it.v; if (it.v < min) min = it.v }
  if (max === 0 && min === 0) max = 1
  const range = max - min || 1
  const y = (v: number) => (H - padB) - ((v - min) / range) * ((H - padB) - padT)
  const n = items.length
  const step = (W - padL - padR) / n
  const barW = Math.min(56, step * 0.5)
  const zero = y(0)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 'auto' }}>
      <line x1={padL} y1={zero} x2={W - padR} y2={zero} stroke="#cbd5e1" strokeWidth={1} />
      {items.map((it, i) => {
        const cx = padL + step * i + step / 2
        const top = Math.min(y(it.v), zero)
        const h = Math.abs(y(it.v) - zero)
        const color = it.total ? '#1F3A5F' : it.v >= 0 ? '#1e8e3e' : '#d93025'
        return (
          <g key={i}>
            <rect x={cx - barW / 2} y={top} width={barW} height={h} rx={3} fill={color} opacity={it.total ? 1 : 0.85} />
            <text x={cx} y={it.v >= 0 ? top - 4 : top + h + 12} textAnchor="middle" fontSize={11} fontWeight={700} fill="#334155" stroke="#fff" strokeWidth={3} paintOrder="stroke">{fmtShort(it.v)}</text>
            <text x={cx} y={H - 8} textAnchor="middle" fontSize={11} fill="#475569" fontWeight={it.total ? 700 : 500}>{it.label}</text>
          </g>
        )
      })}
    </svg>
  )
}

function Row({ label, value, bold, sub, indent, plus }: { label: string; value: number; bold?: boolean; sub?: boolean; indent?: boolean; plus?: boolean }) {
  const sign = plus ? (value >= 0 ? '＋' : '－') : ''
  return (
    <tr className={`border-b border-gray-100 ${bold ? 'bg-blue-50/40' : ''}`}>
      <td className={`px-3 py-1.5 ${bold ? 'font-bold text-gray-800' : sub ? 'text-gray-500' : 'text-gray-700'}`} style={{ paddingLeft: indent ? 28 : 12 }}>{sub ? '└ ' : ''}{label}</td>
      <td className={`px-3 py-1.5 text-right tabular-nums ${bold ? 'font-bold' : ''} ${value < 0 ? 'text-red-600' : ''}`}>{plus ? `${sign}${fmtYen(Math.abs(value))}` : fmtYen(value)}</td>
    </tr>
  )
}

export default function SectionFCF({ fy, prior, monthIdx, yearId, settings, onSettingsChange }: {
  fy: FiscalYearData; prior: FiscalYearData | null; monthIdx: number; yearId: string
  settings: KeieiSettings; onSettingsChange: (s: KeieiSettings) => void
}) {
  const r = fcfAnalysis(fy, prior, monthIdx)
  const monthLabel = `${fy.fiscalMonths[monthIdx]}月`
  const tax = r.ordProfit - r.afterTax
  // 財務収支（借入＋リースの増減）: ＋＝追加融資（調達）, −＝返済
  const isRaise = r.financeBalance > 0
  // 評価: 本業赤字=要注意 / 本業黒字でも借入増(調達依存)=注意 / 本業黒字＆純返済=健全
  const evalState: 'good' | 'warn' | 'bad' = r.operatingCf < 0 ? 'bad' : (isRaise ? 'warn' : 'good')

  const auto = buildFcfComment(r, fmtShort)
  const comment = settings.fcfComments?.[yearId] ?? auto
  const setComment = (text: string) => onSettingsChange({ ...settings, fcfComments: { ...(settings.fcfComments || {}), [yearId]: text } })
  const resetComment = () => {
    const next = { ...(settings.fcfComments || {}) }
    delete next[yearId]
    onSettingsChange({ ...settings, fcfComments: next })
  }

  const bars = [
    { label: '税引後利益', v: r.afterTax },
    { label: '減価償却費', v: r.depreciation },
    { label: '運転資本増減', v: -r.wcIncrease },
    { label: '営業CF', v: r.operatingCf, total: true },
    { label: '財務収支', v: r.financeBalance, total: true },
    { label: '現金増減', v: r.netCash, total: true },
  ]

  return (
    <div className="space-y-5">
      {/* 評価サマリー */}
      <Section title={`フリーキャッシュフロー分析（${fy.label} 期首〜${monthLabel}）`} note={r.hasPrior ? '期首＝前期末残高で算定' : '前期データがないため当期8月末を期首として概算'}>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
          <div className="rounded-xl border border-gray-100 bg-white p-4 shadow-[0_3px_10px_rgba(26,115,232,0.06)]">
            <div className="text-[13px] font-semibold text-gray-600 mb-1.5">簡易営業CF（フリーCF）</div>
            <div className={`text-[22px] leading-none font-extrabold ${r.operatingCf >= 0 ? 'text-green-600' : 'text-red-600'}`}>{fmtShort(r.operatingCf)}</div>
            <div className="text-[11px] text-gray-400 mt-1.5">本業で生む現金</div>
          </div>
          <div className="rounded-xl border border-gray-100 bg-white p-4 shadow-[0_3px_10px_rgba(26,115,232,0.06)]">
            <div className="text-[13px] font-semibold text-gray-600 mb-1.5">借入・リース増減（財務収支）</div>
            <div className={`text-[22px] leading-none font-extrabold ${isRaise ? 'text-amber-600' : r.financeBalance < 0 ? 'text-blue-600' : 'text-gray-900'}`}>{r.financeBalance >= 0 ? '＋' : '−'}{fmtShort(Math.abs(r.financeBalance))}</div>
            <div className="text-[11px] text-gray-400 mt-1.5">{isRaise ? '追加融資（調達）' : r.financeBalance < 0 ? '返済（資金流出）' : '増減なし'}</div>
          </div>
          <div className="rounded-xl border border-gray-100 bg-white p-4 shadow-[0_3px_10px_rgba(26,115,232,0.06)]">
            <div className="text-[13px] font-semibold text-gray-600 mb-1.5">現金の純増減（営業CF＋財務）</div>
            <div className={`text-[22px] leading-none font-extrabold ${r.netCash >= 0 ? 'text-gray-900' : 'text-red-600'}`}>{fmtShort(r.netCash)}</div>
            <div className="text-[11px] text-gray-400 mt-1.5">参考 実際の現預金増減 {fmtShort(r.cashActualChg)}</div>
          </div>
          <div className={`rounded-xl border p-4 shadow-[0_3px_10px_rgba(26,115,232,0.06)] ${evalState === 'good' ? 'border-green-200 bg-green-50' : evalState === 'warn' ? 'border-amber-200 bg-amber-50' : 'border-red-200 bg-red-50'}`}>
            <div className="text-[13px] font-semibold text-gray-600 mb-1.5">評価</div>
            <div className={`text-[20px] leading-none font-extrabold ${evalState === 'good' ? 'text-green-700' : evalState === 'warn' ? 'text-amber-700' : 'text-red-700'}`}>{evalState === 'good' ? '✅ 健全' : evalState === 'warn' ? '△ 注意' : '⚠ 要注意'}</div>
            <div className="text-[11px] text-gray-400 mt-1.5">{evalState === 'good' ? '本業の現金で返済できている' : evalState === 'warn' ? '本業は黒字だが借入で調達' : '本業から現金が流出'}</div>
          </div>
        </div>
        <FcfBars items={bars} />
      </Section>

      {/* 明細表 */}
      <Section title="フリーキャッシュフローの内訳" note="推移BS/PLから算定（簡易・間接法）">
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <tbody>
              <Row label="経常利益（累計）" value={r.ordProfit} />
              <Row label={`法人税等（概算・実効税率 ${(r.taxRate * 100).toFixed(1)}%）`} value={-tax} />
              <Row label="税引後利益" value={r.afterTax} bold />
              <Row label="減価償却費（累計）" value={r.depreciation} plus />
              <Row label="運転資本の増減（増加＝資金減）" value={-r.wcIncrease} plus />
              <Row label="売上債権の増減" value={-r.recvChg} sub indent />
              <Row label="棚卸資産の増減" value={-r.invChg} sub indent />
              <Row label="仕入債務の増減" value={r.payChg} sub indent />
              <Row label="＝ 簡易営業キャッシュフロー（フリーCF）" value={r.operatingCf} bold />
              <Row label="借入金の増減（＋調達／−返済）" value={r.loanChg} plus />
              <Row label="リース債務の増減（＋調達／−返済）" value={r.leaseChg} plus />
              <Row label="＝ 財務収支" value={r.financeBalance} bold />
              <Row label="現金の増減（営業CF＋財務収支）" value={r.netCash} bold />
              <Row label="（参考）実際の現預金 増減" value={r.cashActualChg} />
            </tbody>
          </table>
        </div>
        <div className="text-[11px] text-gray-400 mt-2">※ 運転資本＝売上債権＋棚卸資産−仕入債務。営業CF＝税引後利益＋減価償却費−運転資本の増加。投資支出（設備投資）は本データから把握できないため含みません。</div>
      </Section>

      {/* コメント（編集可能） */}
      <Section title="コメント（評価・所見）" note="自動生成された文章を編集できます">
        <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={5}
          className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-blue-200" />
        <div className="flex justify-end mt-2">
          <button onClick={resetComment} className="px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-100 rounded">自動コメントに戻す</button>
        </div>
      </Section>
    </div>
  )
}
