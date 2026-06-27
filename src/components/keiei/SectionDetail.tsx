'use client'

import type { FiscalYearData } from '@/lib/keiei/types'
import { CODES, getRow, ytd } from '@/lib/keiei/calc'
import { detailsOf, rowYtd } from '@/lib/keiei/analysis'
import { fmtYen, fmtShort, fmtPct } from '@/lib/keiei/format'
import { MultiLine } from './charts'

const LABOR_RE = /給料|給与|役員報酬|賞与|法定福利|雑給|手当|人件|専従者/

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

// 前期同名科目の累計を引く
function priorYtdByName(prior: FiscalYearData | null, subtotalCode: string, name: string, monthIdx: number): number {
  if (!prior) return 0
  const r = detailsOf(prior, subtotalCode).find((a) => a.name.trim() === name)
  return r ? rowYtd(r, monthIdx) : 0
}

export default function SectionDetail({ fy, prior, monthIdx }: { fy: FiscalYearData; prior: FiscalYearData | null; monthIdx: number }) {
  const monthLabel = `${fy.fiscalMonths[monthIdx]}月`
  const upto = monthIdx + 1
  const monthLabels = fy.fiscalMonths.slice(0, upto).map((m) => `${m}月`)

  // 主要数値（当期累計・前期累計）
  const sales = ytd(fy, CODES.sales, monthIdx)
  const cogs = ytd(fy, CODES.cogs, monthIdx)
  const gross = ytd(fy, CODES.grossProfit, monthIdx)
  const sgna = ytd(fy, CODES.sgna, monthIdx)
  const op = ytd(fy, CODES.opProfit, monthIdx)
  const pSales = prior ? ytd(prior, CODES.sales, monthIdx) : null
  const pGross = prior ? ytd(prior, CODES.grossProfit, monthIdx) : null

  const grossMargin = sales ? (gross / sales) * 100 : 0
  const pGrossMargin = pSales && pGross != null ? (pGross / pSales) * 100 : null

  // 人件費
  const sgnaDetails = detailsOf(fy, CODES.sgna)
  const labor = sgnaDetails.filter((a) => LABOR_RE.test(a.name)).reduce((s, a) => s + rowYtd(a, monthIdx), 0)
  const laborRate = sales ? (labor / sales) * 100 : 0
  const pLabor = prior ? detailsOf(prior, CODES.sgna).filter((a) => LABOR_RE.test(a.name)).reduce((s, a) => s + rowYtd(a, monthIdx), 0) : null
  const pLaborRate = pSales && pLabor != null ? (pLabor / pSales) * 100 : null
  const otherFixed = sgna - labor

  // 経費の前年比 増減
  const expDiffs = sgnaDetails.map((a) => {
    const cur = rowYtd(a, monthIdx)
    const pre = priorYtdByName(prior, CODES.sgna, a.name.trim(), monthIdx)
    return { name: a.name.trim(), cur, pre, diff: cur - pre }
  }).filter((x) => Math.abs(x.cur) > 0 || Math.abs(x.pre) > 0)
  const increases = [...expDiffs].filter((x) => x.diff > 0).sort((a, b) => b.diff - a.diff).slice(0, 6)
  const decreases = [...expDiffs].filter((x) => x.diff < 0).sort((a, b) => a.diff - b.diff).slice(0, 6)

  // 販管費ランキング
  const sgnaRank = sgnaDetails.map((a) => ({ name: a.name.trim(), cur: rowYtd(a, monthIdx), pre: priorYtdByName(prior, CODES.sgna, a.name.trim(), monthIdx) }))
    .filter((x) => Math.abs(x.cur) > 0).sort((a, b) => b.cur - a.cur).slice(0, 12)

  // 利益率の推移
  const gpRow = getRow(fy, CODES.grossProfit)?.monthly || []
  const opRow = getRow(fy, CODES.opProfit)?.monthly || []
  const salesRow = getRow(fy, CODES.sales)?.monthly || []
  const ratio = (n: number[], i: number) => (salesRow[i] ? (n[i] / salesRow[i]) * 100 : 0)
  const gmS = monthLabels.map((_, i) => ratio(gpRow, i))
  const omS = monthLabels.map((_, i) => ratio(opRow, i))

  // 経営コメント
  const comments: { tone: 'good' | 'warn' | 'info'; text: string }[] = []
  if (pGrossMargin != null) {
    const d = grossMargin - pGrossMargin
    comments.push({ tone: Math.abs(d) < 0.5 ? 'info' : d >= 0 ? 'good' : 'warn',
      text: `粗利率は ${fmtPct(grossMargin)}（前年 ${fmtPct(pGrossMargin)}、${d >= 0 ? '+' : ''}${d.toFixed(1)}pt）。${d < -0.5 ? '原価率の悪化に注意。値入れ・仕入価格を確認しましょう。' : d > 0.5 ? '収益性が改善しています。' : 'ほぼ横ばいです。'}`})
  }
  if (sales) {
    comments.push({ tone: laborRate > 30 ? 'warn' : 'info',
      text: `人件費は売上の ${fmtPct(laborRate)}${pLaborRate != null ? `（前年 ${fmtPct(pLaborRate)}）` : ''}。${pLaborRate != null && laborRate - pLaborRate > 1 ? '人件費率が上昇しています。売上の伸びと見合っているか確認を。' : ''}`})
  }
  if (increases[0]) comments.push({ tone: 'warn', text: `前年より最も増えた経費は「${increases[0].name}」で ${fmtShort(increases[0].diff)} 増。内容を確認しましょう。` })
  comments.push({ tone: op >= 0 ? 'good' : 'warn',
    text: `営業利益は ${fmtShort(op)}（売上の ${fmtPct(sales ? (op / sales) * 100 : 0)}）。${op < 0 ? '本業が赤字です。固定費の見直しと粗利改善が課題です。' : '本業で利益が出ています。'}`})

  // コスト構造（売上=100）
  const seg = [
    { label: '売上原価（変動費）', val: cogs, color: '#C8A24B' },
    { label: '人件費', val: labor, color: '#ef6b6b' },
    { label: 'その他固定費', val: otherFixed, color: '#94a3b8' },
    { label: op >= 0 ? '営業利益' : '営業損失', val: Math.abs(op), color: op >= 0 ? '#10b981' : '#dc2626' },
  ]
  const segTotal = cogs + labor + otherFixed + Math.abs(op) || 1
  const per = (v: number) => Math.round((v / (sales || 1)) * 1000) / 10 // 売上に対する割合（％）
  const perStr = (v: number) => `${per(v)}%`

  return (
    <div className="space-y-5">
      {/* 経営コメント */}
      <Section title={`社長に伝えたいポイント（${fy.label} 期首〜${monthLabel}）`} note="数字から読み取れる要点">
        <div className="grid md:grid-cols-2 gap-2">
          {comments.map((c, i) => (
            <div key={i} className={`flex gap-2 items-start p-3 rounded-lg text-sm ${c.tone === 'good' ? 'bg-green-50 text-green-800' : c.tone === 'warn' ? 'bg-amber-50 text-amber-800' : 'bg-blue-50 text-blue-800'}`}>
              <span>{c.tone === 'good' ? '✅' : c.tone === 'warn' ? '⚠️' : '💡'}</span>
              <span>{c.text}</span>
            </div>
          ))}
        </div>
      </Section>

      {/* コスト構造 */}
      <Section title="お金の流れ（売上に対する割合）" note={`${fy.label}　期首〜${monthLabel}の累計（実績値）。売上高 ${fmtYen(sales)} に対し、原価・人件費・固定費に何％を使い、利益が何％残るかを表します`}>
        <div className="flex w-full rounded-lg overflow-hidden border border-gray-200 mb-3" style={{ height: 78 }}>
          {seg.map((s, i) => {
            const w = (s.val / segTotal) * 100
            if (w < 0.6) return null
            return (
              <div key={i} className="h-full flex flex-col items-center justify-center text-white text-center px-1 overflow-hidden leading-tight" style={{ width: `${w}%`, background: s.color }} title={`${s.label}：${fmtYen(s.val)}（売上の ${perStr(s.val)}）`}>
                {w > 12 && <span className="text-[11px] font-semibold truncate max-w-full">{s.label}</span>}
                {w > 7 && <span className="text-[13px] font-extrabold">{fmtShort(s.val)}</span>}
                <span className="text-[11px] font-bold">{perStr(s.val)}</span>
              </div>
            )
          })}
        </div>
        <div className="text-sm text-gray-700 leading-relaxed">
          売上高 <b>{fmtYen(sales)}（100%）</b> のうち、<span style={{ color: '#9a7320' }}>原価に <b>{fmtShort(cogs)}（{perStr(cogs)}）</b></span>・<span style={{ color: '#c2554d' }}>人件費に <b>{fmtShort(labor)}（{perStr(labor)}）</b></span>・<span className="text-slate-500">その他固定費に <b>{fmtShort(otherFixed)}（{perStr(otherFixed)}）</b></span> を使い、
          {op >= 0
            ? <>本業の利益（営業利益）が <b className="text-green-700">{fmtShort(op)}（{perStr(op)}）</b> 残ります。</>
            : <>費用が売上を上回り、本業は <b className="text-red-600">{fmtShort(Math.abs(op))}（{perStr(Math.abs(op))}）の赤字（営業損失）</b>になっています。</>}
        </div>
      </Section>

      {/* 経費の前期同期比 増減 */}
      <Section title="経費の増減（前期の同じ期間との比較）"
        note={prior
          ? `前期 ${prior.label} の「期首〜${monthLabel}まで」と、当期 ${fy.label} の「期首〜${monthLabel}まで」を販管費の科目ごとに比べた増減です`
          : '前期のデータを取り込むと比較を表示します'}>
        <div className="grid md:grid-cols-2 gap-x-8 gap-y-3">
          <div>
            <div className="text-sm font-bold text-red-600 mb-2">▲ 前期より増えた経費 TOP（コスト見直しの着眼点）</div>
            {prior ? <DiffBars items={increases} positive /> : <Empty />}
          </div>
          <div>
            <div className="text-sm font-bold text-green-600 mb-2">▼ 前期より減った経費 TOP（改善できている費目）</div>
            {prior ? <DiffBars items={decreases} /> : <Empty />}
          </div>
        </div>
      </Section>

      {/* 販管費ランキング */}
      <Section title="販管費（経費）の大きい順" note={`${fy.label}　期首〜${monthLabel}の累計額が大きい経費の順。「対売上」＝売上に占める割合、「前期比」＝前期同期間からの増減率`}>
        <RankTable items={sgnaRank} sales={sales} hasPrior={!!prior} />
      </Section>

      {/* 利益率の推移 */}
      <Section title={`利益率の推移（当期・期首〜${monthLabel}）`} note="売上に対する利益の割合（％）">
        <MultiLine labels={monthLabels} unit="pct" showTable series={[
          { label: '粗利率', values: gmS, color: '#1F3A5F' },
          { label: '営業利益率', values: omS, color: '#3b82f6' },
        ]} />
      </Section>
    </div>
  )
}

function Empty() { return <div className="text-xs text-gray-400 py-4 text-center">前期のデータを取り込むと前年比較を表示します。</div> }

function DiffBars({ items, positive }: { items: { name: string; diff: number; cur: number; pre: number }[]; positive?: boolean }) {
  const max = Math.max(1, ...items.map((x) => Math.abs(x.diff)))
  if (!items.length) return <div className="text-xs text-gray-400 py-4 text-center">該当なし</div>
  return (
    <div className="space-y-1.5">
      {items.map((x, i) => (
        <div key={i} className="flex items-center gap-2 text-xs">
          <span className="w-32 shrink-0 truncate text-gray-700" title={x.name}>{x.name}</span>
          <div className="flex-1 bg-gray-100 rounded h-5 overflow-hidden">
            <div className="h-full rounded" style={{ width: `${(Math.abs(x.diff) / max) * 100}%`, background: positive ? '#ef6b6b' : '#10b981' }} />
          </div>
          <span className={`w-16 text-right font-bold ${positive ? 'text-red-600' : 'text-green-600'}`}>{x.diff >= 0 ? '+' : '−'}{fmtShort(Math.abs(x.diff))}</span>
          <span className="w-24 text-right text-[11px] text-gray-400">当期 {fmtShort(x.cur)}</span>
        </div>
      ))}
    </div>
  )
}

function RankTable({ items, sales, hasPrior }: { items: { name: string; cur: number; pre: number }[]; sales: number; hasPrior: boolean }) {
  const max = Math.max(1, ...items.map((x) => x.cur))
  return (
    <div className="space-y-1">
      {items.map((x, i) => {
        const yy = hasPrior && x.pre !== 0 ? ((x.cur - x.pre) / Math.abs(x.pre)) * 100 : null
        return (
          <div key={i} className="flex items-center gap-2 text-xs">
            <span className="w-40 shrink-0 truncate text-gray-700" title={x.name}>{x.name}</span>
            <div className="flex-1 bg-gray-100 rounded h-5 overflow-hidden"><div className="h-full bg-[#3b82f6] rounded" style={{ width: `${(x.cur / max) * 100}%` }} /></div>
            <span className="w-20 text-right tabular-nums text-gray-800 font-medium">{fmtShort(x.cur)}</span>
            <span className="w-12 text-right text-gray-400">{sales ? fmtPct((x.cur / sales) * 100) : ''}</span>
            {hasPrior && <span className={`w-16 text-right ${yy == null ? 'text-gray-300' : yy >= 0 ? 'text-red-500' : 'text-green-600'}`}>{yy == null ? '—' : `${yy >= 0 ? '+' : ''}${yy.toFixed(0)}%`}</span>}
          </div>
        )
      })}
    </div>
  )
}
