'use client'

// 月次レポート「報告書」タブ。
//
// 設計の要点（ユーザー合意済み）:
// - 画面に出しているのは印刷とまったく同じHTML（buildMonthlyReportV2Html）。
//   iframe に流し込んで縮小表示しているだけなので、画面で見えている紙面がそのまま印刷される。
// - 損益分岐点シミュレーションと資金繰りの前提（必要最低残高・入出金サイクル）は
//   この画面で動かすと即座に紙面が組み直される。動かした状態がそのまま印刷される。
// - 経営課題のコメントは報告書には入れない（画面の「経営課題」タブだけで確認する）。
import { useEffect, useMemo, useRef, useState } from 'react'
import type { FiscalYearData } from '@/lib/keiei/types'
import type { KeieiSettings } from '@/lib/keiei/analysis'
import {
  buildMonthlyReportV2Html, REPORT_V2_PAGES, defaultBepSim, defaultDailyCycle, v2SettingsOf,
  type BepSimState, type ReportV2PageKey, type ReportV2Settings, type Unit,
} from '@/lib/keiei/report2'

const PAGE_W = 297 /* mm */ * (96 / 25.4) // 297mm を px に（iframe の中身の実寸）

function Fieldset({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border border-gray-200 rounded-xl p-3">
      <div className="text-[11px] font-bold text-gray-500 mb-2">{title}</div>
      <div className="space-y-2">{children}</div>
    </div>
  )
}

function NumField({ label, value, onChange, suffix, step = 1, width = 'w-24' }: {
  label: string; value: number | ''; onChange: (v: number | '') => void; suffix?: string; step?: number; width?: string
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-gray-700">
      <span className="flex-1 min-w-0">{label}</span>
      <input
        type="number" step={step} value={value}
        onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
        className={`${width} px-2 py-1 border border-gray-300 rounded text-right text-xs`}
      />
      {suffix && <span className="text-[11px] text-gray-400 w-8">{suffix}</span>}
    </label>
  )
}

function Slider({ label, value, min, max, step, onChange, display }: {
  label: string; value: number; min: number; max: number; step: number
  onChange: (v: number) => void; display: string
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-gray-700">{label}</span>
        <span className="font-bold text-[#0089c7]">{display}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-[#0089c7]"
      />
    </div>
  )
}

export default function SectionReport2({
  fy, prior, years, monthIdx, settings, onSettingsChange, company,
}: {
  fy: FiscalYearData
  prior: FiscalYearData | null
  years: Record<string, FiscalYearData>
  monthIdx: number
  settings: KeieiSettings
  onSettingsChange: (s: KeieiSettings) => void
  company: string
}) {
  const [unit, setUnit] = useState<Unit>('thousand')
  const [trendPaper, setTrendPaper] = useState<'a4' | 'a3'>('a4')
  const [sim, setSim] = useState<BepSimState>(defaultBepSim())
  const [sel, setSel] = useState<ReportV2PageKey[]>(REPORT_V2_PAGES.map(([k]) => k))
  const [panelOpen, setPanelOpen] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const v2 = v2SettingsOf(settings, fy.id)
  const cycle = defaultDailyCycle()

  // v2 設定の更新（期ごとに保存）
  const patchV2 = (p: Partial<ReportV2Settings>) => {
    const all = (settings as KeieiSettings & { v2?: Record<string, ReportV2Settings> }).v2 || {}
    onSettingsChange({ ...settings, v2: { ...all, [fy.id]: { ...v2, ...p } } } as KeieiSettings)
  }

  const input = useMemo(() => ({
    company, fy, prior, years, monthIdx, settings,
    pages: sel, unit, trendPaper, sim,
  }), [company, fy, prior, years, monthIdx, settings, sel, unit, trendPaper, sim])

  // 紙面の組立（重い処理ではないが、スライダー操作中の連続再組立を1フレームに間引く）
  const [html, setHtml] = useState('')
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        setHtml(buildMonthlyReportV2Html({ ...input, preview: true }))
        setErr(null)
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e))
      }
    }, 60)
    return () => clearTimeout(t)
  }, [input])

  // 画面幅に合わせて紙面を縮小表示する
  const wrapRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0.5)
  useEffect(() => {
    const fit = () => {
      const w = wrapRef.current?.clientWidth || 0
      if (w > 0) setScale(Math.min(1, w / PAGE_W))
    }
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [])

  const doPrint = () => {
    setErr(null)
    const w = window.open('', '_blank')
    if (!w) { setErr('ポップアップがブロックされました。ブラウザの設定で許可してから、もう一度押してください。'); return }
    w.document.open()
    w.document.write(buildMonthlyReportV2Html({ ...input, preview: false }))
    w.document.close()
  }

  // プレビューの高さ＝ページ数×1ページ分（A4横210mm＋余白6mm）。
  // 3期推移PLは科目数と単位で枚数が変わるので、少し多めに見積もっておく（余りは灰色の余白になるだけ）
  const frameH = Math.round((sel.length + (sel.includes('trend3') ? 3 : 1) + 1) * (216 * (96 / 25.4)))

  const toggle = (k: ReportV2PageKey) =>
    setSel((s) => (s.includes(k) ? s.filter((x) => x !== k) : REPORT_V2_PAGES.map(([x]) => x).filter((x) => s.includes(x) || x === k)))

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <button onClick={doPrint} className="px-4 py-2 text-sm bg-[#0089c7] text-white rounded-lg font-bold hover:brightness-95">
          🖨 報告書を印刷 / PDF保存
        </button>
        <button onClick={() => setPanelOpen((v) => !v)} className="px-3 py-2 text-xs border border-gray-300 rounded-lg hover:bg-gray-50">
          {panelOpen ? '設定を閉じる' : '設定を開く'}
        </button>
        <div className="flex items-center gap-1 text-xs">
          <span className="text-gray-500">金額</span>
          {([['thousand', '千円'], ['yen', '円']] as [Unit, string][]).map(([u, l]) => (
            <button key={u} onClick={() => setUnit(u)}
              className={`px-2.5 py-1 rounded-lg border ${unit === u ? 'bg-[#0089c7] text-white border-[#0089c7]' : 'border-gray-300 text-gray-600'}`}>{l}</button>
          ))}
        </div>
        <div className="flex items-center gap-1 text-xs">
          <span className="text-gray-500">3期推移PLの用紙</span>
          {([['a4', 'A4横'], ['a3', 'A3横']] as ['a4' | 'a3', string][]).map(([p, l]) => (
            <button key={p} onClick={() => setTrendPaper(p)}
              className={`px-2.5 py-1 rounded-lg border ${trendPaper === p ? 'bg-[#0089c7] text-white border-[#0089c7]' : 'border-gray-300 text-gray-600'}`}>{l}</button>
          ))}
        </div>
        <span className="text-[11px] text-gray-400">
          {unit === 'yen' && trendPaper === 'a4' ? '※ 円単位のA4横は3期推移PLを前半6か月／後半6か月に分けて出力します' : ''}
        </span>
      </div>

      {err && <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{err}</div>}

      {panelOpen && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <Fieldset title="収録する資料">
            {REPORT_V2_PAGES.map(([k, l]) => (
              <label key={k} className="flex items-center gap-2 text-xs text-gray-700">
                <input type="checkbox" checked={sel.includes(k)} onChange={() => toggle(k)} />
                <span className="flex-1 min-w-0 truncate">{l}</span>
              </label>
            ))}
          </Fieldset>

          <Fieldset title="損益分岐点シミュレーション（動かすと図がその場で動きます）">
            <Slider label="売上高" value={sim.salesPct} min={-30} max={30} step={0.5}
              onChange={(v) => setSim({ ...sim, salesPct: v })}
              display={`${sim.salesPct >= 0 ? '＋' : '△'}${Math.abs(sim.salesPct).toFixed(1)}%`} />
            <Slider label="売上総利益率" value={sim.marginPt} min={-10} max={10} step={0.1}
              onChange={(v) => setSim({ ...sim, marginPt: v })}
              display={`${sim.marginPt >= 0 ? '＋' : '△'}${Math.abs(sim.marginPt).toFixed(1)}pt`} />
            <Slider label="販管費（年間）" value={sim.sgnaDelta / 10000} min={-5000} max={5000} step={10}
              onChange={(v) => setSim({ ...sim, sgnaDelta: v * 10000 })}
              display={`${sim.sgnaDelta >= 0 ? '＋' : '△'}${Math.abs(Math.round(sim.sgnaDelta / 10000)).toLocaleString()}万円`} />
            <button onClick={() => setSim(defaultBepSim())} className="text-[11px] text-[#0089c7] hover:underline">実績の状態に戻す</button>
          </Fieldset>

          <Fieldset title="資金繰り（日繰り）の前提">
            <label className="flex items-center gap-2 text-xs text-gray-700">
              <span className="flex-1">必要最低残高</span>
              <select
                value={v2.minCashMode ?? 'third'}
                onChange={(e) => patchV2({ minCashMode: e.target.value as 'third' | 'manual' })}
                className="px-2 py-1 border border-gray-300 rounded text-xs">
                <option value="third">月商の1/3（既定）</option>
                <option value="manual">手入力</option>
              </select>
            </label>
            {(v2.minCashMode ?? 'third') === 'manual' && (
              <NumField label="必要最低残高" suffix="万円" step={10}
                value={v2.minCashManual != null ? Math.round(v2.minCashManual / 10000) : ''}
                onChange={(v) => patchV2({ minCashManual: v === '' ? undefined : v * 10000 })} />
            )}
            <NumField label="売掛の回収日" suffix="日" value={v2.recvPayDay ?? cycle.recvPayDay} onChange={(v) => patchV2({ recvPayDay: v === '' ? undefined : v })} width="w-16" />
            <NumField label="買掛の支払日" suffix="日" value={v2.payPayDay ?? cycle.payPayDay} onChange={(v) => patchV2({ payPayDay: v === '' ? undefined : v })} width="w-16" />
            <NumField label="給与の支給日" suffix="日" value={v2.salaryDay ?? cycle.salaryDay} onChange={(v) => patchV2({ salaryDay: v === '' ? undefined : v })} width="w-16" />
            <NumField label="社保・源泉の納付日" suffix="日" value={v2.socialDay ?? cycle.socialDay} onChange={(v) => patchV2({ socialDay: v === '' ? undefined : v })} width="w-16" />
            <NumField label="カード・諸経費の振替日" suffix="日" value={v2.cardDay ?? cycle.cardDay} onChange={(v) => patchV2({ cardDay: v === '' ? undefined : v })} width="w-16" />
            <NumField label="借入の返済日" suffix="日" value={v2.loanDay ?? cycle.loanDay} onChange={(v) => patchV2({ loanDay: v === '' ? undefined : v })} width="w-16" />
          </Fieldset>

          <Fieldset title="納税予測・生産性">
            <NumField label="中間納付済の法人税等" suffix="万円" step={10}
              value={v2.taxPrepaid != null ? Math.round(v2.taxPrepaid / 10000) : ''}
              onChange={(v) => patchV2({ taxPrepaid: v === '' ? undefined : v * 10000 })} />
            <label className="flex items-center gap-2 text-xs text-gray-700">
              <span className="flex-1">消費税の課税方式</span>
              <select value={v2.vatMethod ?? 'general'}
                onChange={(e) => patchV2({ vatMethod: e.target.value as 'general' | 'simple' | 'exempt' })}
                className="px-2 py-1 border border-gray-300 rounded text-xs">
                <option value="general">原則課税</option>
                <option value="simple">簡易課税</option>
                <option value="exempt">免税</option>
              </select>
            </label>
            {(v2.vatMethod ?? 'general') === 'simple' && (
              <NumField label="みなし仕入率" suffix="%" value={v2.vatDeemedRate ?? 80} onChange={(v) => patchV2({ vatDeemedRate: v === '' ? undefined : v })} width="w-16" />
            )}
            <NumField label="中間納付済・予定の消費税" suffix="万円" step={10}
              value={v2.vatPrepaid != null ? Math.round(v2.vatPrepaid / 10000) : ''}
              onChange={(v) => patchV2({ vatPrepaid: v === '' ? undefined : v * 10000 })} />
            <NumField label="従業員数（当期）" suffix="名" value={v2.employees ?? ''} onChange={(v) => patchV2({ employees: v === '' ? undefined : v })} width="w-16" />
            <NumField label="従業員数（前期）" suffix="名" value={v2.employeesPrior ?? ''} onChange={(v) => patchV2({ employeesPrior: v === '' ? undefined : v })} width="w-16" />
          </Fieldset>
        </div>
      )}

      <div ref={wrapRef} className="bg-[#8e8e8e] rounded-2xl overflow-hidden" style={{ height: Math.round(frameH * scale) }}>
        <div style={{ width: PAGE_W, height: frameH, transform: `scale(${scale})`, transformOrigin: 'top left' }}>
          <iframe
            title="月次経営レポート プレビュー"
            srcDoc={html}
            style={{ width: PAGE_W, height: frameH, border: 0, display: 'block' }}
          />
        </div>
      </div>
      <div className="text-[11px] text-gray-400">
        画面に表示しているものが、そのまま印刷される紙面です。上の設定やスライダーを動かすと、その場で組み直されます。
      </div>
    </div>
  )
}
