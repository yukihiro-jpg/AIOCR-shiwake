'use client'

// 経営課題タブ。
// ハイブリッド方式：課題の検出・数値は lib/keiei/issues.ts の確定ロジックが行い、
// AI（Gemini）は総括文章の言い回しを整えるだけ（数値・判定には関与しない）。
// あわせて「感度分析」「借入返済能力」「労働分配率」の意思決定用レポートを表示する。

import { useState, useMemo, useEffect } from 'react'
import type { FiscalYearData } from '@/lib/keiei/types'
import type { KeieiSettings } from '@/lib/keiei/analysis'
import { detectIssues, buildIssuesStory, type Issue, type IssueSeverity } from '@/lib/keiei/issues'
import { fmtShort } from '@/lib/keiei/format'
import { StoryBody } from './StoryCard'

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-[0_3px_10px_rgba(26,115,232,0.06)] p-5">
      <div className="flex items-baseline gap-2 mb-3 flex-wrap">
        <h2 className="text-[15px] font-bold text-gray-800">{title}</h2>
        {note && <span className="text-xs text-gray-400">{note}</span>}
      </div>
      {children}
    </div>
  )
}

const SEV: Record<IssueSeverity, { label: string; icon: string; card: string; chip: string }> = {
  danger: { label: '最優先', icon: '🔴', card: 'border-red-200 bg-red-50/50', chip: 'bg-red-100 text-red-700' },
  warn: { label: '注意', icon: '🟡', card: 'border-amber-200 bg-amber-50/50', chip: 'bg-amber-100 text-amber-700' },
  good: { label: '良い点', icon: '🟢', card: 'border-green-200 bg-green-50/40', chip: 'bg-green-100 text-green-700' },
}

function IssueCard({ i }: { i: Issue }) {
  const s = SEV[i.severity]
  return (
    <div className={`rounded-xl border p-4 ${s.card}`}>
      <div className="flex items-center gap-2 flex-wrap mb-1.5">
        <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${s.chip}`}>{s.icon} {s.label}</span>
        <span className="text-[11px] text-gray-500 bg-white/70 border border-gray-200 rounded-full px-2 py-0.5">{i.category}</span>
        <span className="text-[13.5px] font-bold text-gray-800">{i.title}</span>
      </div>
      <p className="text-[13px] leading-[1.85] text-gray-700">{i.body}</p>
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

export default function SectionIssues({ fy, monthIdx, yearId, settings, onSettingsChange, years, company }: {
  fy: FiscalYearData
  monthIdx: number
  yearId: string
  settings: KeieiSettings
  onSettingsChange: (s: KeieiSettings) => void
  years: Record<string, FiscalYearData>
  company: string
}) {
  const result = useMemo(
    () => detectIssues({ years, fy, monthIdx, settings, yearId, budget: settings.budgets?.[yearId] }),
    [years, fy, monthIdx, settings, yearId],
  )
  const baseStory = useMemo(() => buildIssuesStory(result, company), [result, company])
  const { issues, sens, debt, labor, monthLabel } = result
  const counts = {
    danger: issues.filter((i) => i.severity === 'danger').length,
    warn: issues.filter((i) => i.severity === 'warn').length,
    good: issues.filter((i) => i.severity === 'good').length,
  }

  const setRepay = (k: 'repayLoanMonthly' | 'repayLeaseMonthly', v: number) =>
    onSettingsChange({ ...settings, [k]: { ...(settings[k] || {}), [yearId]: v } })

  return (
    <div className="space-y-5">
      {/* 総括ストーリー（テンプレ確定生成 → 任意でAI仕上げ） */}
      <IssuesStory baseStory={baseStory} storyKey={`${yearId}__${monthIdx}`} />

      {/* 課題の一覧 */}
      <Section title="検出された課題・変化" note={`期首〜${monthLabel}の実績から自動判定（🔴${counts.danger}件・🟡${counts.warn}件・🟢${counts.good}件）`}>
        {issues.length ? (
          <div className="space-y-2.5">{issues.map((i, n) => <IssueCard key={n} i={i} />)}</div>
        ) : (
          <div className="text-sm text-gray-500 py-4 text-center">チェック対象の課題は検出されませんでした（比較用の前期データを取り込むと検出精度が上がります）。</div>
        )}
        <div className="text-[11px] text-gray-400 mt-3 leading-relaxed">
          ※ 判定はすべて試算表の数値から機械的に行っています（AIの推測は含みません）。閾値の目安：売上減少3%/10%、粗利率低下0.3pt/1pt、損益分岐点比率90%/100%、労働分配率60%/70%、手元資金 月商1〜2か月、債務償還年数7年/10年、自己資本比率10%/30% など。
        </div>
      </Section>

      {/* 感度分析 */}
      <Section title="感度分析（もし〜なら、営業利益はいくら変わるか）" note="打ち手の優先順位づけに。年間換算の概算">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-xs text-gray-500 bg-gray-50">
              <th className="text-left px-3 py-2">シナリオ</th>
              <th className="text-right px-3 py-2" style={{ width: 170 }}>営業利益への影響（年間）</th>
              <th className="text-left px-3 py-2">補足</th>
            </tr></thead>
            <tbody>
              {sens.scenarios.map((s, i) => (
                <tr key={i} className="border-b border-gray-100">
                  <td className="px-3 py-2 font-medium text-gray-800">{s.label}</td>
                  <td className={`px-3 py-2 text-right tabular-nums font-bold ${s.deltaAnnual >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {s.deltaAnnual >= 0 ? '＋' : '−'}{fmtShort(Math.abs(s.deltaAnnual))}
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-500">{s.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="text-[11px] text-gray-400 mt-2 leading-relaxed">
          ※ 期首〜{monthLabel}の実績（売上 {fmtShort(sens.base.salesAnnual)}／年換算、限界利益率 {(sens.base.marginalRate * 100).toFixed(1)}%）に基づく概算。変動費・固定費の区分は「損益分岐点・FCF分析」タブの設定を使用しています。細かなシミュレーションは同タブのスライダーで行えます。
        </div>
      </Section>

      {/* 借入返済能力 */}
      <Section title="借入返済能力" note="債務償還年数と返済原資のバランス">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-4">
          <div className="rounded-xl border border-gray-200 bg-gray-50/40 p-4">
            <div className="text-[12px] font-semibold text-gray-600 mb-1">有利子負債（借入＋リース）</div>
            <div className="text-[20px] font-extrabold tabular-nums text-gray-900">{fmtShort(debt.loanBal + debt.leaseBal)}</div>
            <div className="text-[11px] text-gray-400 mt-0.5">{monthLabel}末残高</div>
          </div>
          <div className="rounded-xl border border-gray-200 bg-gray-50/40 p-4">
            <div className="text-[12px] font-semibold text-gray-600 mb-1">簡易CF（返済原資・年換算）</div>
            <div className={`text-[20px] font-extrabold tabular-nums ${debt.simpleCfAnnual < 0 ? 'text-red-600' : 'text-gray-900'}`}>{fmtShort(debt.simpleCfAnnual)}</div>
            <div className="text-[11px] text-gray-400 mt-0.5">税引後利益＋減価償却費</div>
          </div>
          <div className={`rounded-xl border p-4 ${debt.payoffYears == null ? 'border-gray-200 bg-gray-50/40' : debt.payoffYears > 10 ? 'border-red-200 bg-red-50/60' : debt.payoffYears > 7 ? 'border-amber-200 bg-amber-50/60' : 'border-green-200 bg-green-50/60'}`}>
            <div className="text-[12px] font-semibold text-gray-600 mb-1">債務償還年数</div>
            <div className="text-[20px] font-extrabold tabular-nums text-gray-900">{debt.payoffYears == null ? '—' : `${debt.payoffYears.toFixed(1)}年`}</div>
            <div className="text-[11px] text-gray-400 mt-0.5">目安：5年以内◎／10年超は過大</div>
          </div>
          <div className={`rounded-xl border p-4 ${debt.coverage == null ? 'border-gray-200 bg-gray-50/40' : debt.coverage >= 1 ? 'border-green-200 bg-green-50/60' : 'border-red-200 bg-red-50/60'}`}>
            <div className="text-[12px] font-semibold text-gray-600 mb-1">返済カバー率</div>
            <div className="text-[20px] font-extrabold tabular-nums text-gray-900">{debt.coverage == null ? '—' : `${(debt.coverage * 100).toFixed(0)}%`}</div>
            <div className="text-[11px] text-gray-400 mt-0.5">簡易CF ÷ 年間返済額（100%未満は原資不足）</div>
          </div>
        </div>
        <div className="flex items-center gap-4 flex-wrap text-sm">
          <label className="flex items-center gap-2 text-xs text-gray-600">
            月額返済額（借入元本）
            <MoneyInput value={settings.repayLoanMonthly?.[yearId] || 0} onChange={(v) => setRepay('repayLoanMonthly', v)}
              className="w-32 px-2 py-1.5 border border-gray-300 rounded text-right tabular-nums text-sm" />円
          </label>
          <label className="flex items-center gap-2 text-xs text-gray-600">
            月額リース返済
            <MoneyInput value={settings.repayLeaseMonthly?.[yearId] || 0} onChange={(v) => setRepay('repayLeaseMonthly', v)}
              className="w-32 px-2 py-1.5 border border-gray-300 rounded text-right tabular-nums text-sm" />円
          </label>
          <span className="text-[11px] text-gray-400">年間返済額：{fmtShort(debt.annualRepay)}（損益分岐点・FCF分析タブと共通の設定です）</span>
        </div>
      </Section>

      {/* 労働分配率 */}
      <Section title="労働分配率（人件費 ÷ 粗利）" note="昇給・賞与・採用の判断材料。目安：50%前後が健全、60%超は警戒">
        {labor.share == null ? (
          <div className="text-sm text-gray-500 py-4 text-center">人件費に該当する科目（役員報酬・給料手当・法定福利費など）が試算表から見つからないか、粗利がマイナスのため計算できません。</div>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
              <div className="rounded-xl border border-[#1F3A5F]/30 bg-[#f4f8ff] p-4">
                <div className="text-[12px] font-semibold text-gray-600 mb-1">当期の労働分配率（期首〜{monthLabel}）</div>
                <div className={`text-[24px] font-extrabold tabular-nums ${labor.share >= 70 ? 'text-red-600' : labor.share >= 60 ? 'text-amber-600' : 'text-[#1F3A5F]'}`}>{labor.share.toFixed(1)}%</div>
                <div className="text-[11px] text-gray-400 mt-0.5">人件費 {fmtShort(labor.labor)} ÷ 粗利 {fmtShort(labor.gross)}</div>
              </div>
              <div className="md:col-span-2 rounded-xl border border-gray-200 bg-white p-4">
                <div className="text-[12px] font-semibold text-gray-600 mb-2">3期の推移（同じ経過月数で比較）</div>
                <div className="space-y-2">
                  {([['前々期', labor.prior2Share], ['前期', labor.priorShare], ['当期', labor.share]] as [string, number | null][]).map(([l, v], i) => (
                    <div key={i} className="flex items-center gap-2 text-xs">
                      <div className="w-14 shrink-0 text-gray-600">{l}</div>
                      <div className="flex-1 bg-gray-100 rounded h-5 relative overflow-hidden">
                        {v != null && <div className={`h-full rounded ${i === 2 ? 'bg-[#1a73e8]' : 'bg-slate-400'}`} style={{ width: `${Math.min(100, Math.max(0, v))}%` }} />}
                        {/* 目安ライン（60%） */}
                        <div className="absolute top-0 bottom-0 border-l border-dashed border-amber-500" style={{ left: '60%' }} />
                      </div>
                      <div className="w-16 shrink-0 text-right tabular-nums font-semibold text-gray-800">{v == null ? '—' : `${v.toFixed(1)}%`}</div>
                    </div>
                  ))}
                </div>
                <div className="text-[11px] text-gray-400 mt-2">点線＝警戒ラインの60%</div>
              </div>
            </div>
            <details className="text-xs text-gray-600">
              <summary className="cursor-pointer text-[#1a73e8] hover:underline">人件費として集計した科目の内訳（{labor.accounts.length}科目）</summary>
              <table className="mt-2 text-xs">
                <tbody>
                  {labor.accounts.map((a, i) => (
                    <tr key={i} className="border-b border-gray-100">
                      <td className="pr-6 py-1">{a.name}</td>
                      <td className="text-right tabular-nums py-1">{fmtShort(a.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="text-[11px] text-gray-400 mt-1.5">※ 科目名に「役員報酬・給料・給与・賃金・賞与・雑給・法定福利・福利厚生・退職・人件費・労務費」等を含むものを自動集計しています。</div>
            </details>
          </>
        )}
      </Section>
    </div>
  )
}

// 総括ストーリーのカード（経営サマリーの SummaryStory と同パターン）。
// テンプレ確定生成を土台に、任意で Gemini「AI仕上げ」。仕上げ後は編集も可能。
// AIが失敗・空応答でもテンプレ文がそのまま残る（ユーザーの見ている文章を消さない）。
function IssuesStory({ baseStory, storyKey }: { baseStory: string; storyKey: string }) {
  const [aiText, setAiText] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  useEffect(() => { setAiText(null); setEditing(false); setErr(null) }, [storyKey])
  const text = aiText ?? baseStory

  const runPolish = async () => {
    setBusy(true); setErr(null)
    try {
      const { polishIssuesStory } = await import('@/lib/keiei/gemini')
      const out = await polishIssuesStory(baseStory)
      setAiText(out)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'AI仕上げに失敗しました')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-[0_3px_10px_rgba(26,115,232,0.06)] overflow-hidden">
      <div className="flex items-center gap-2 px-5 py-3 border-b border-gray-100 bg-gradient-to-r from-[#f4f8ff] to-white">
        <span className="text-lg">🧭</span>
        <h2 className="text-[15px] font-bold text-gray-800">経営課題の総括</h2>
        <span className="text-[11px] text-gray-400">{aiText ? 'AI仕上げ済み' : 'テンプレ自動生成（数値は機械判定）'}</span>
        <div className="ml-auto flex items-center gap-1.5">
          {aiText && (
            <button onClick={() => setEditing((e) => !e)}
              className="px-3 py-1.5 text-xs text-gray-600 rounded-full hover:bg-gray-100">{editing ? '編集を終了' : '✎ 編集'}</button>
          )}
          {aiText && (
            <button onClick={() => { setAiText(null); setEditing(false) }}
              className="px-3 py-1.5 text-xs text-gray-600 rounded-full hover:bg-gray-100">元に戻す</button>
          )}
          <button onClick={runPolish} disabled={busy}
            className="px-4 py-1.5 text-xs bg-[#1a73e8] text-white rounded-full font-semibold hover:bg-[#1765cc] disabled:opacity-50">
            {busy ? '仕上げ中…' : aiText ? '✨ 再仕上げ' : '✨ AIで仕上げ'}
          </button>
        </div>
      </div>
      {err && <div className="px-5 py-2 bg-amber-50 text-amber-700 text-xs border-b border-amber-100">{err}</div>}
      <div className="p-5">
        {editing ? (
          <textarea value={text} onChange={(e) => setAiText(e.target.value)}
            className="w-full h-80 p-3 border border-gray-300 rounded-lg text-sm leading-relaxed font-[inherit]" />
        ) : (
          <StoryBody text={text} />
        )}
      </div>
    </div>
  )
}
