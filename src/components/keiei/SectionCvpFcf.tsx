'use client'

import { useState } from 'react'
import type { FiscalYearData } from '@/lib/keiei/types'
import {
  cvp, classifiableCodes, costValue, classifyOf, suggestVarFix,
  fcfAnalysis, buildFcfComment, repaymentContext, repaymentSolve,
  type KeieiSettings,
} from '@/lib/keiei/analysis'
import { fmtYen, fmtShort, fmtPct } from '@/lib/keiei/format'

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

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)) }
function parseNum(s: string) { return Number(s.replace(/[^0-9.\-]/g, '')) || 0 }

export type CvpSim = { sales: number; gross: number; var: number; fixed: number }
export default function SectionCvpFcf({ fy, prior, monthIdx, yearId, settings, onSettingsChange, years, sim, onSimChange }: {
  fy: FiscalYearData
  prior: FiscalYearData | null
  monthIdx: number
  yearId: string
  settings: KeieiSettings
  onSettingsChange: (s: KeieiSettings) => void
  years: Record<string, FiscalYearData>
  sim?: CvpSim
  onSimChange?: (s: CvpSim) => void
}) {
  const base = cvp(fy, monthIdx, settings)
  const fcf = fcfAnalysis(fy, prior, monthIdx)
  const ctx = repaymentContext(fy, prior, monthIdx, settings)
  const monthLabel = `${fy.fiscalMonths[monthIdx]}月`
  const [showEditor, setShowEditor] = useState(false)
  // シミュレータ（売上%／粗利率pt／変動費率pt／固定費%）
  // 親（KeieiContent）が状態を保持している場合はそれを使い、印刷時もユーザー調整値を反映する。
  // 単体利用（親未指定）のときはローカル状態にフォールバック。
  const [localSim, setLocalSim] = useState<CvpSim>({ sales: 0, gross: 0, var: 0, fixed: 0 })
  const s0 = sim ?? localSim
  const setSim = onSimChange ?? setLocalSim
  const salesAdj = s0.sales, grossAdj = s0.gross, varAdj = s0.var, fixedAdj = s0.fixed
  const setSalesAdj = (v: number) => setSim({ ...s0, sales: v })
  const setGrossAdj = (v: number) => setSim({ ...s0, gross: v })
  const setVarAdj = (v: number) => setSim({ ...s0, var: v })
  const setFixedAdj = (v: number) => setSim({ ...s0, fixed: v })

  const baseVarRate = base.sales ? base.variable / base.sales : 0
  const compute = (salesMul: number, marginPt: number, fixedMul: number) => {
    const sales = base.sales * salesMul
    const mr = clamp(base.marginalRate + marginPt, 0.01, 0.99)
    const fixed = base.fixed * fixedMul
    const marginal = sales * mr
    const op = marginal - fixed
    const bep = mr ? fixed / mr : 0
    const safety = sales ? (sales - bep) / sales : 0
    // 売上総利益（粗利）＝売上高×限界利益率（＝限界利益）。粗利率の変動でここが動く
    const gross = marginal
    return { sales, mr: mr * 100, gross, fixed, op, bep, safety: safety * 100 }
  }
  const baseM = compute(1, 0, 1)
  const afterM = compute(1 + salesAdj / 100, (grossAdj - varAdj) / 100, 1 + fixedAdj / 100)
  const impSales = compute(1 + salesAdj / 100, 0, 1)
  const impGross = compute(1, grossAdj / 100, 1)
  const impVar = compute(1, -varAdj / 100, 1)
  const impFixed = compute(1, 0, 1 + fixedAdj / 100)

  // ===== 借入返済の充足（CVP × FCF, 期首〜選択月の累計ベース） =====
  // 月額元本・月額リースをユーザー入力し、経過月数（期首〜選択月）を乗じて返済額を算出
  const loanMonthly = settings.repayLoanMonthly?.[yearId] ?? 0
  const leaseMonthly = settings.repayLeaseMonthly?.[yearId] ?? 0
  const setLoanMonthly = (v: number) => onSettingsChange({ ...settings, repayLoanMonthly: { ...(settings.repayLoanMonthly || {}), [yearId]: Math.max(0, Math.round(v)) } })
  const setLeaseMonthly = (v: number) => onSettingsChange({ ...settings, repayLeaseMonthly: { ...(settings.repayLeaseMonthly || {}), [yearId]: Math.max(0, Math.round(v)) } })
  const plannedRepay = (loanMonthly + leaseMonthly) * ctx.months // 期首〜選択月の返済額（累計）
  const sol = repaymentSolve(ctx, plannedRepay, afterM.op) // 現在のスライダー状態での充足
  const solBase = repaymentSolve(ctx, plannedRepay, ctx.opProfitYtd) // 現状（無調整）での必要改善
  // 参考: 実績の月平均返済（自動読取りは使わないが目安として表示）
  const refMonthlyRepay = ctx.months > 0 ? Math.max(0, -(ctx.loanChg + ctx.leaseChg)) / ctx.months : 0

  // ===== 損益分岐点の逆算 =====
  const [fixSales, setFixSales] = useState<number>(Math.round(base.sales))
  const [fixRate, setFixRate] = useState<number>(Number((base.marginalRate * 100).toFixed(1)))
  const [bepRate, setBepRate] = useState<number | null>(null)
  const [bepSales, setBepSales] = useState<number | null>(null)
  const calcBepRate = () => setBepRate(fixSales > 0 ? (base.fixed / fixSales) * 100 : null)
  const calcBepSales = () => setBepSales(fixRate > 0 ? base.fixed / (fixRate / 100) : null)

  const cls = classifyOf(fy, settings)
  const costs = classifiableCodes(fy).map((c) => ({ code: c.code, name: c.name, value: costValue(fy, c.code, monthIdx), kind: cls(c.code) }))
    .filter((x) => Math.abs(x.value) > 0)
  const setKind = (code: string, kind: 'variable' | 'fixed') => onSettingsChange({ ...settings, varfix: { ...settings.varfix, [code]: kind } })
  const autoSuggest = () => onSettingsChange({ ...settings, varfix: { ...settings.varfix, ...suggestVarFix(years) } })
  const resetDefault = () => onSettingsChange({ ...settings, varfix: {} })

  // FCFコメント
  const auto = buildFcfComment(fcf, fmtShort)
  const comment = settings.fcfComments?.[yearId] ?? auto
  const setComment = (text: string) => onSettingsChange({ ...settings, fcfComments: { ...(settings.fcfComments || {}), [yearId]: text } })
  const resetComment = () => { const next = { ...(settings.fcfComments || {}) }; delete next[yearId]; onSettingsChange({ ...settings, fcfComments: next }) }
  const tax = fcf.ordProfit - fcf.afterTax
  const isRaise = fcf.financeBalance > 0
  const repayActual = Math.max(0, -fcf.financeBalance) // 期中の実際の純返済額
  const cfCoversRepay = fcf.operatingCf >= repayActual
  // 本業赤字=要注意 / 借入調達 or 本業CFが返済に届かず手元資金依存=注意 / 本業CFで返済を賄えた=健全
  const evalState: 'good' | 'warn' | 'bad' = fcf.operatingCf < 0 ? 'bad' : (!isRaise && cfCoversRepay ? 'good' : 'warn')
  const evalSub = evalState === 'good' ? '本業の現金で返済を賄えている'
    : evalState === 'bad' ? '本業から現金が流出'
      : isRaise ? '本業は黒字だが借入で調達'
        : '本業は黒字だが返済に届かず手元資金に依存'

  return (
    <div className="space-y-5">
      {/* 1. 損益分岐点（現状） */}
      <Section title={`損益分岐点（期首〜${monthLabel} 累計ベース）`} note="変動費/固定費の分類に基づく概算">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
          <Stat label="売上高" value={base.sales} />
          <Stat label="限界利益" value={base.marginal} sub={`率 ${fmtPct(base.marginalRate * 100)}`} />
          <Stat label="固定費" value={base.fixed} />
          <Stat label="損益分岐点売上" value={base.bep} accent />
          <Stat label="経営安全率" text={fmtPct(base.safety * 100)} good={base.safety >= 0} />
        </div>
        <BepBar rows={[
          { label: '現状の売上', val: base.sales, color: '#3b82f6' },
          { label: '損益分岐点売上', val: base.bep, color: '#e0a91b' },
        ]} />
        <div className="text-xs text-gray-500 mt-2">
          限界利益率 {fmtPct(base.marginalRate * 100)} ／ 変動費 {fmtShort(base.variable)}（変動費率 {fmtPct(baseVarRate * 100)}） ／ 固定費 {fmtShort(base.fixed)}。
          {base.safety < 0 ? '　現状は損益分岐点を下回っています（営業赤字）。' : `　損益分岐点を ${fmtShort(base.sales - base.bep)} 上回っています。`}
        </div>

        {/* 損益分岐点の逆算 */}
        <div className="mt-4 border-t border-gray-100 pt-4">
          <div className="text-sm font-bold text-gray-700 mb-1">損益分岐点の逆算</div>
          <div className="text-[11px] text-gray-400 mb-3">固定費 {fmtShort(base.fixed)}（期首〜{monthLabel} 累計）を前提に、売上高または限界利益率を固定して損益分岐点を求めます。</div>
          <div className="grid md:grid-cols-2 gap-3">
            <div className="rounded-xl border border-gray-200 p-3 bg-gray-50/40">
              <div className="text-xs text-gray-600 mb-2">売上高を固定 → 損益分岐点となる<b>限界利益率</b></div>
              <div className="flex items-center gap-2">
                <MoneyInput value={fixSales} onChange={setFixSales} className="flex-1 min-w-0 px-2 py-1.5 border border-gray-300 rounded text-right tabular-nums text-sm" />
                <span className="text-xs text-gray-400">円</span>
                <button onClick={calcBepRate} className="px-3 py-1.5 text-xs bg-amber-500 text-white rounded font-bold hover:bg-amber-600 whitespace-nowrap">算出</button>
              </div>
              {bepRate != null && (
                <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2">
                  <span className="text-[11px] text-gray-600">損益分岐点となる限界利益率</span>
                  <div className="text-[20px] font-extrabold text-amber-700 leading-tight">
                    {bepRate.toFixed(1)}%
                    <span className="text-[12px] font-semibold text-gray-500 ml-1">（現状 {fmtPct(base.marginalRate * 100)} との差は {bepRate - base.marginalRate * 100 >= 0 ? '+' : '−'}{Math.abs(bepRate - base.marginalRate * 100).toFixed(1)}pt）</span>
                  </div>
                </div>
              )}
            </div>
            <div className="rounded-xl border border-gray-200 p-3 bg-gray-50/40">
              <div className="text-xs text-gray-600 mb-2">限界利益率を固定 → 損益分岐点となる<b>売上高</b></div>
              <div className="flex items-center gap-2">
                <input type="number" value={fixRate} step={0.1} onChange={(e) => setFixRate(Number(e.target.value))}
                  className="flex-1 min-w-0 px-2 py-1.5 border border-gray-300 rounded text-right tabular-nums text-sm" />
                <span className="text-xs text-gray-400">%</span>
                <button onClick={calcBepSales} className="px-3 py-1.5 text-xs bg-amber-500 text-white rounded font-bold hover:bg-amber-600 whitespace-nowrap">算出</button>
              </div>
              {bepSales != null && (
                <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2">
                  <span className="text-[11px] text-gray-600">損益分岐点売上</span>
                  <div className="text-[20px] font-extrabold text-amber-700 leading-tight">
                    {fmtShort(bepSales)}
                    <span className="text-[12px] font-semibold text-gray-500 ml-1">（現状 {fmtShort(base.sales)} との差は {bepSales - base.sales >= 0 ? '+' : '−'}{fmtShort(Math.abs(bepSales - base.sales))}）</span>
                  </div>
                  <div className="text-[11px] text-gray-500">{fmtYen(bepSales)}</div>
                </div>
              )}
            </div>
          </div>
        </div>
      </Section>

      {/* 2. CVPシミュレーション × 借入返済（核心） */}
      <Section title="損益分岐点シミュレーション × 借入返済" note="スライダーを動かすと、損益分岐点と「借入返済を賄えるか」が即時に変わります">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
          <Slider label="売上" value={salesAdj} min={-30} max={30} unit="%" onChange={setSalesAdj} />
          <Slider label="粗利率" value={grossAdj} min={-10} max={10} unit="pt" onChange={setGrossAdj} />
          <Slider label="変動費率" value={varAdj} min={-10} max={10} unit="pt" onChange={setVarAdj} />
          <Slider label="固定費" value={fixedAdj} min={-30} max={30} unit="%" onChange={setFixedAdj} />
        </div>

        {/* 借入返済の充足パネル */}
        <div className={`rounded-xl border p-4 mb-4 ${sol.covered ? 'border-green-200 bg-green-50/60' : 'border-amber-300 bg-amber-50/60'}`}>
          <div className="text-sm font-bold text-gray-800 mb-3">借入返済の充足（期首〜{monthLabel} 累計ベース）</div>
          {/* 月額返済の入力 → 返済額（累計）を算出 */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
            <div className="rounded-xl border border-gray-200 bg-white p-3">
              <label className="text-[12px] font-semibold text-gray-600 block mb-1">月額元本返済額</label>
              <div className="flex items-center gap-1.5">
                <MoneyInput value={loanMonthly} onChange={setLoanMonthly} className="flex-1 min-w-0 px-2 py-1.5 border border-gray-300 rounded text-right tabular-nums text-sm" />
                <span className="text-xs text-gray-400">円/月</span>
              </div>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white p-3">
              <label className="text-[12px] font-semibold text-gray-600 block mb-1">月額リース債務返済額</label>
              <div className="flex items-center gap-1.5">
                <MoneyInput value={leaseMonthly} onChange={setLeaseMonthly} className="flex-1 min-w-0 px-2 py-1.5 border border-gray-300 rounded text-right tabular-nums text-sm" />
                <span className="text-xs text-gray-400">円/月</span>
              </div>
            </div>
            <div className="rounded-xl border border-[#1F3A5F]/30 bg-white p-3">
              <div className="text-[12px] font-semibold text-gray-600 mb-1">返済額（期首〜{monthLabel}）</div>
              <div className="text-[20px] leading-tight font-extrabold text-[#1F3A5F] tabular-nums">{plannedRepay.toLocaleString('ja-JP')}</div>
              <div className="text-[11px] text-gray-400 mt-0.5">（月額元本＋月額リース）× {ctx.months}ヶ月</div>
            </div>
          </div>
          <div className="text-[11px] text-gray-400 mb-3">（参考）実績の月平均返済額 ≒ {fmtShort(refMonthlyRepay)}／月。上の欄に月額を入力すると、経過月数を乗じた返済額がシミュレーションに使われます。</div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
            <MiniStat label={`返済額（期首〜${monthLabel}）`} value={plannedRepay} />
            <MiniStat label="現状の営業CF（累計）" value={ctx.opCfYtd} good={ctx.opCfYtd >= plannedRepay} />
            <MiniStat label="シミュレーション後の営業CF" value={sol.cfSim} good={sol.covered} hint="スライダー反映後" />
            <div className={`rounded-xl border p-3 ${sol.covered ? 'border-green-300 bg-green-50' : 'border-amber-300 bg-amber-50'}`}>
              <div className="text-[12px] font-semibold text-gray-600 mb-1">返済の充足</div>
              <div className={`text-[18px] leading-tight font-extrabold ${sol.covered ? 'text-green-700' : 'text-amber-700'}`}>{sol.covered ? '✅ 賄える' : '⚠ 不足'}</div>
              <div className="text-[11px] text-gray-500 mt-1">{sol.covered ? `余力 ${fmtShort(sol.surplus)}` : `不足 ${fmtShort(sol.shortfall)}`}</div>
            </div>
          </div>
          {/* 営業CF vs 返済額 バー */}
          <BepBar rows={[
            { label: '営業CF（後）', val: Math.max(0, sol.cfSim), color: sol.covered ? '#1e8e3e' : '#ef8a00' },
            { label: '返済額', val: plannedRepay, color: '#1F3A5F' },
          ]} small />
          {/* 必要改善ガイド（現状＝無調整からの必要量） */}
          <div className={`text-sm mt-3 leading-relaxed ${sol.covered ? 'text-green-800' : 'text-gray-700'}`}>
            {plannedRepay <= 0 ? (
              <>月額元本返済額・月額リース債務返済額を入力すると、返済を賄うのに必要な売上・粗利率の改善量を試算します。</>
            ) : ctx.opCfYtd >= plannedRepay ? (
              <>現状の営業CF（累計 <b>{fmtShort(ctx.opCfYtd)}</b>）で返済額 <b>{fmtShort(plannedRepay)}</b> を賄えています。</>
            ) : solBase.reachableByMargin ? (
              <>現状の営業CFでは返済に <b className="text-amber-700">{fmtShort(solBase.shortfall)}</b> 不足します。返済を賄うには
                <b className="text-blue-700"> 売上を {solBase.salesGapPct >= 0 ? '+' : ''}{solBase.salesGapPct.toFixed(1)}%</b>（約 {fmtShort(ctx.salesYtd + solBase.salesGap)} へ）、
                <b className="text-blue-700"> または粗利率を {solBase.marginRateGapPt >= 0 ? '+' : ''}{solBase.marginRateGapPt.toFixed(1)}pt</b>（{fmtPct(ctx.marginalRate * 100)}→{fmtPct(solBase.reqMarginalRate * 100)}）
                改善する必要があります。上のスライダーで試算できます。</>
            ) : (
              <>現状の営業CFでは返済に <b className="text-amber-700">{fmtShort(solBase.shortfall)}</b> 不足します。固定費の削減も含めて改善が必要です（上のスライダーで試算）。</>
            )}
          </div>
          <div className="text-[11px] text-gray-400 mt-2">※ 営業CF（累計）＝（営業利益＋営業外損益）×(1−実効税率{(ctx.taxRate * 100).toFixed(0)}%)＋減価償却−運転資本増減。営業外損益・減価償却・運転資本・税率は実績ベースで一定とし、売上・粗利率・固定費の変化のみを反映しています。返済額はアップロードファイルからの自動読取りではなく、上の月額入力×経過月数で算出します。</div>
        </div>

        {/* 影響度の表 */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm table-fixed">
            <colgroup><col style={{ width: '16%' }} /><col style={{ width: '14%' }} /><col style={{ width: '14%' }} /><col style={{ width: '14%' }} /><col style={{ width: '14%' }} /><col style={{ width: '14%' }} /><col style={{ width: '14%' }} /></colgroup>
            <thead><tr className="text-xs text-gray-600 bg-gray-50">
              <th className="text-left px-3 py-2">指標</th>
              <th className="text-right px-3 py-2">現状</th>
              <th className="text-right px-3 py-2">シミュレーション後</th>
              <th className="text-right px-3 py-2">売上高による影響額</th>
              <th className="text-right px-3 py-2">粗利率による影響額</th>
              <th className="text-right px-3 py-2">変動費率による影響額</th>
              <th className="text-right px-3 py-2">固定比率による影響額</th>
            </tr></thead>
            <tbody>
              <AttrRow label="売上高" sel="sales" baseM={baseM} afterM={afterM} imp={[impSales, impGross, impVar, impFixed]} />
              <AttrRow label="限界利益率" sel="mr" pct baseM={baseM} afterM={afterM} imp={[impSales, impGross, impVar, impFixed]} />
              <AttrRow label="固定費" sel="fixed" baseM={baseM} afterM={afterM} imp={[impSales, impGross, impVar, impFixed]} />
              <AttrRow label="売上総利益" sel="gross" bold baseM={baseM} afterM={afterM} imp={[impSales, impGross, impVar, impFixed]} />
              <AttrRow label="営業利益" sel="op" bold baseM={baseM} afterM={afterM} imp={[impSales, impGross, impVar, impFixed]} />
              <AttrRow label="損益分岐点売上" sel="bep" bold baseM={baseM} afterM={afterM} imp={[impSales, impGross, impVar, impFixed]} />
              <AttrRow label="経営安全率" sel="safety" pct baseM={baseM} afterM={afterM} imp={[impSales, impGross, impVar, impFixed]} />
            </tbody>
          </table>
        </div>
        <div className="text-xs text-gray-400 mt-2">※「影響額」は各要素だけを動かしたときの現状からの差。粗利率↑と変動費率↓は同じ向き（限界利益率を上げる）に効きます。損益分岐点を下げるには固定費↓・粗利率↑が有効です。</div>
      </Section>

      {/* 3. フリーキャッシュフロー分析（実績） */}
      <Section title={`フリーキャッシュフロー分析（実績・${fy.label} 期首〜${monthLabel}）`} note={fcf.hasPrior ? '期首＝前期末残高で算定' : '前期データがないため当期初月末を期首として概算'}>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
          <div className="rounded-xl border border-gray-100 bg-white p-4 shadow-[0_3px_10px_rgba(26,115,232,0.06)]">
            <div className="text-[13px] font-semibold text-gray-600 mb-1.5">簡易営業CF（フリーCF）</div>
            <div className={`text-[22px] leading-none font-extrabold ${fcf.operatingCf >= 0 ? 'text-green-600' : 'text-red-600'}`}>{fmtShort(fcf.operatingCf)}</div>
            <div className="text-[11px] text-gray-400 mt-1.5">本業で生む現金（累計）</div>
          </div>
          <div className="rounded-xl border border-gray-100 bg-white p-4 shadow-[0_3px_10px_rgba(26,115,232,0.06)]">
            <div className="text-[13px] font-semibold text-gray-600 mb-1.5">借入・リース増減（財務収支）</div>
            <div className={`text-[22px] leading-none font-extrabold ${isRaise ? 'text-amber-600' : fcf.financeBalance < 0 ? 'text-blue-600' : 'text-gray-900'}`}>{fcf.financeBalance >= 0 ? '＋' : '−'}{fmtShort(Math.abs(fcf.financeBalance))}</div>
            <div className="text-[11px] text-gray-400 mt-1.5">{isRaise ? '追加融資（調達）' : fcf.financeBalance < 0 ? '返済（資金流出）' : '増減なし'}</div>
          </div>
          <div className="rounded-xl border border-gray-100 bg-white p-4 shadow-[0_3px_10px_rgba(26,115,232,0.06)]">
            <div className="text-[13px] font-semibold text-gray-600 mb-1.5">現金の純増減（営業CF＋財務）</div>
            <div className={`text-[22px] leading-none font-extrabold ${fcf.netCash >= 0 ? 'text-gray-900' : 'text-red-600'}`}>{fmtShort(fcf.netCash)}</div>
            <div className="text-[11px] text-gray-400 mt-1.5">参考 実際の現預金増減 {fmtShort(fcf.cashActualChg)}</div>
          </div>
          <div className={`rounded-xl border p-4 shadow-[0_3px_10px_rgba(26,115,232,0.06)] ${evalState === 'good' ? 'border-green-200 bg-green-50' : evalState === 'warn' ? 'border-amber-200 bg-amber-50' : 'border-red-200 bg-red-50'}`}>
            <div className="text-[13px] font-semibold text-gray-600 mb-1.5">評価</div>
            <div className={`text-[20px] leading-none font-extrabold ${evalState === 'good' ? 'text-green-700' : evalState === 'warn' ? 'text-amber-700' : 'text-red-700'}`}>{evalState === 'good' ? '✅ 健全' : evalState === 'warn' ? '△ 注意' : '⚠ 要注意'}</div>
            <div className="text-[11px] text-gray-400 mt-1.5">{evalSub}</div>
          </div>
        </div>
        <FcfBars items={[
          { label: '税引後利益', v: fcf.afterTax },
          { label: '減価償却費', v: fcf.depreciation },
          { label: '運転資本増減', v: -fcf.wcIncrease },
          { label: '営業CF', v: fcf.operatingCf, total: true },
          { label: '財務収支', v: fcf.financeBalance, total: true },
          { label: '現金増減', v: fcf.netCash, total: true },
        ]} />
        <div className="overflow-x-auto mt-4">
          <table className="w-full text-sm border-collapse">
            <tbody>
              <Row label="経常利益（累計）" value={fcf.ordProfit} />
              <Row label={`法人税等（概算・実効税率 ${(fcf.taxRate * 100).toFixed(1)}%）`} value={-tax} />
              <Row label="税引後利益" value={fcf.afterTax} bold />
              <Row label="減価償却費（累計）" value={fcf.depreciation} plus />
              <Row label="運転資本の増減（増加＝資金減）" value={-fcf.wcIncrease} plus />
              <Row label="売上債権の増減" value={-fcf.recvChg} sub indent />
              <Row label="棚卸資産の増減" value={-fcf.invChg} sub indent />
              <Row label="仕入債務の増減" value={fcf.payChg} sub indent />
              <Row label="＝ 簡易営業キャッシュフロー（フリーCF）" value={fcf.operatingCf} bold />
              <Row label="借入金の増減（＋調達／−返済）" value={fcf.loanChg} plus />
              <Row label="リース債務の増減（＋調達／−返済）" value={fcf.leaseChg} plus />
              <Row label="＝ 財務収支" value={fcf.financeBalance} bold />
              <Row label="現金の増減（営業CF＋財務収支）" value={fcf.netCash} bold />
              <Row label="（参考）実際の現預金 増減" value={fcf.cashActualChg} />
            </tbody>
          </table>
        </div>
        <div className="text-[11px] text-gray-400 mt-2">※ 運転資本＝売上債権＋棚卸資産−仕入債務。営業CF＝税引後利益＋減価償却費−運転資本の増加。投資支出（設備投資）は本データから把握できないため含みません。</div>
      </Section>

      {/* 4. 変動費／固定費の分類 */}
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

      {/* 5. コメント（編集可能） */}
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

function Stat({ label, value, sub, text, accent, good }: { label: string; value?: number; sub?: string; text?: string; accent?: boolean; good?: boolean }) {
  return (
    <div className={`rounded-xl border p-4 shadow-sm ${accent ? 'border-amber-300 bg-amber-50' : 'border-gray-200 bg-white'}`}>
      <div className="text-[13px] font-semibold text-gray-600 mb-1.5">{label}</div>
      <div className={`text-[22px] leading-none font-extrabold ${good == null ? (accent ? 'text-amber-700' : 'text-gray-900') : good ? 'text-green-600' : 'text-red-600'}`}>{text != null ? text : fmtShort(value || 0)}</div>
      {sub && <div className="text-[11px] text-gray-500 mt-1.5">{sub}</div>}
    </div>
  )
}

function MiniStat({ label, value, good, hint }: { label: string; value: number; good?: boolean; hint?: string }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-3">
      <div className="text-[12px] font-semibold text-gray-600 mb-1">{label}</div>
      <div className={`text-[18px] leading-tight font-extrabold ${good == null ? 'text-gray-900' : good ? 'text-green-600' : 'text-amber-700'}`}>{fmtShort(value)}</div>
      {hint && <div className="text-[11px] text-gray-400 mt-1">{hint}</div>}
    </div>
  )
}

function BepBar({ rows, small }: { rows: { label: string; val: number; color: string }[]; small?: boolean }) {
  const max = Math.max(...rows.map((r) => r.val), 1)
  return (
    <div className={small ? 'space-y-1.5' : 'space-y-2.5'}>
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-3 text-sm">
          <div className="w-32 shrink-0 text-gray-700 font-medium">{r.label}</div>
          <div className={`flex-1 bg-gray-100 rounded-md relative overflow-hidden ${small ? 'h-7' : 'h-8'}`}>
            <div className="h-full rounded-md flex items-center justify-end pr-2" style={{ width: `${(r.val / max) * 100}%`, background: r.color }}>
              <span className="text-white text-xs font-bold whitespace-nowrap">{fmtShort(r.val)}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

function MoneyInput({ value, onChange, className }: { value: number; onChange: (v: number) => void; className?: string }) {
  // 編集中は「入力したそのままの文字列」を表示し、カンマ整形は離脱時のみ行う。
  // （入力毎に toLocaleString でカンマを挿入するとカーソル位置がずれ、数字が重複入力される不具合になる）
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

function Slider({ label, value, min, max, unit, step = 1, onChange }: { label: string; value: number; min: number; max: number; unit: string; step?: number; onChange: (v: number) => void }) {
  const dec = () => onChange(clamp(Number((value - step).toFixed(1)), min, max))
  const inc = () => onChange(clamp(Number((value + step).toFixed(1)), min, max))
  return (
    <div>
      <div className="flex items-center justify-between mb-1 gap-1">
        <span className="text-xs text-gray-600">{label}</span>
        <button onClick={() => onChange(0)} title="基準値（±0）に戻す"
          className="text-[11px] text-gray-400 hover:text-blue-600 px-1 rounded">⟲ 基準に戻す</button>
      </div>
      <div className="flex items-center gap-1.5 mb-1.5">
        <button onClick={dec} aria-label="減らす" className="w-7 h-7 shrink-0 rounded-md border border-gray-200 bg-white text-gray-600 hover:bg-blue-50 hover:border-blue-200 font-bold leading-none">←</button>
        <div className="flex-1 text-center text-[20px] font-extrabold text-blue-700 tabular-nums leading-none">{value >= 0 ? '+' : ''}{value}{unit}</div>
        <button onClick={inc} aria-label="増やす" className="w-7 h-7 shrink-0 rounded-md border border-gray-200 bg-white text-gray-600 hover:bg-blue-50 hover:border-blue-200 font-bold leading-none">→</button>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full" />
    </div>
  )
}

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

type Metric = { sales: number; mr: number; gross: number; fixed: number; op: number; bep: number; safety: number }
function AttrRow({ label, sel, pct, bold, baseM, afterM, imp }: {
  label: string; sel: keyof Metric; pct?: boolean; bold?: boolean; baseM: Metric; afterM: Metric; imp: Metric[]
}) {
  const baseV = baseM[sel]; const afterV = afterM[sel]
  const fAbs = (v: number) => (pct ? `${v.toFixed(1)}%` : fmtYen(v))
  const fDelta = (v: number) => {
    if (Math.abs(v) < (pct ? 0.05 : 0.5)) return '—'
    const s = v >= 0 ? '+' : '−'
    return pct ? `${s}${Math.abs(v).toFixed(1)}pt` : `${s}${fmtYen(Math.abs(v))}`
  }
  const cellCls = (v: number) => v > 0.05 ? 'text-green-600' : v < -0.05 ? 'text-red-600' : 'text-gray-300'
  const deltas = imp.map((m) => m[sel] - baseV)
  return (
    <tr className="border-b border-gray-100">
      <td className={`px-3 py-1.5 ${bold ? 'font-bold' : ''}`}>{label}</td>
      <td className="px-3 py-1.5 text-right tabular-nums text-gray-500">{fAbs(baseV)}</td>
      <td className={`px-3 py-1.5 text-right tabular-nums font-bold ${bold ? (afterV >= baseV ? 'text-green-600' : 'text-red-600') : 'text-gray-800'}`}>{fAbs(afterV)}</td>
      {deltas.map((d, i) => (
        <td key={i} className={`px-3 py-1.5 text-right tabular-nums ${cellCls(d)}`}>{fDelta(d)}</td>
      ))}
    </tr>
  )
}
