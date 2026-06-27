'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import GlobalNav from '@/core/ui/GlobalNav'
import { hasRoom, setRoomPassphrase } from '@/core/room'
import {
  loadKeieiClients, type KeieiClient,
  loadYears, saveYears, setSelectedClientId,
} from '@/lib/keiei/store'
import { decodeCsv, parseMonthlyCsv, finalizeFiscalYear } from '@/lib/keiei/parse'
import type { FiscalYearData } from '@/lib/keiei/types'
import {
  CODES, getRow, plKpisSingle, plKpisYtd, ytd, singleMonth,
  sortedYears, findPriorYear,
} from '@/lib/keiei/calc'
import { fmtYen, fmtShort, fmtPct, fmtPctSigned } from '@/lib/keiei/format'
import { ComboBarLine, GroupedBars } from './charts'
import { loadSettings, saveSettings } from '@/lib/keiei/store'
import { defaultSettings, type KeieiSettings } from '@/lib/keiei/analysis'
import SectionDetail from './SectionDetail'
import SectionCVP from './SectionCVP'
import SectionCash from './SectionCash'
import SectionReport from './SectionReport'
import { openSubmissionPdf } from '@/lib/keiei/submission'

type View = 'overview' | 'report' | 'detail' | 'cvp' | 'cash'

export default function KeieiContent() {
  const [roomReady, setRoomReady] = useState(false)
  const [passInput, setPassInput] = useState('')
  const [clients, setClients] = useState<KeieiClient[]>([])
  const [clientId, setClientId] = useState('')
  const [years, setYears] = useState<Record<string, FiscalYearData>>({})
  const [yearId, setYearId] = useState('')
  const [monthIdx, setMonthIdx] = useState(0)
  const [view, setView] = useState<View>('overview')
  const [settings, setSettings] = useState<KeieiSettings>(defaultSettings())
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  // 期末年の確認ダイアログ（複数ファイルまとめて）
  const [pending, setPending] = useState<{ data: FiscalYearData; fileName: string; year: number }[] | null>(null)

  useEffect(() => { setRoomReady(hasRoom()) }, [])

  // Noto Sans JP を読み込む（月次レポート全体に適用）
  useEffect(() => {
    const id = 'noto-sans-jp-font'
    if (typeof document !== 'undefined' && !document.getElementById(id)) {
      const l = document.createElement('link')
      l.id = id; l.rel = 'stylesheet'
      l.href = 'https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700;800&display=swap'
      document.head.appendChild(l)
    }
  }, [])

  // 顧問先リスト読み込み
  useEffect(() => {
    if (!roomReady) return
    // 年調データ受信と同様、利用顧問先を最初から一覧表示する（自動選択はしない）
    loadKeieiClients().then((cs) => setClients(cs)).catch(() => setClients([]))
  }, [roomReady])

  // 顧問先の年度データ読み込み
  useEffect(() => {
    if (!clientId) { setYears({}); return }
    setSelectedClientId(clientId)
    setView('overview')
    loadSettings(clientId).then(setSettings)
    setLoading(true)
    loadYears(clientId).then((y) => {
      setYears(y)
      const sorted = sortedYears(y)
      const newest = sorted[sorted.length - 1]
      if (newest) { setYearId(newest.id); setMonthIdx(newest.lastFilledIndex) }
      else { setYearId(''); }
    }).finally(() => setLoading(false))
  }, [clientId])

  const changeSettings = useCallback((s: KeieiSettings) => {
    setSettings(s)
    if (clientId) saveSettings(clientId, s)
  }, [clientId])

  const current = clients.find((c) => c.id === clientId)
  const fy = years[yearId]

  const handlePrint = useCallback(() => {
    const prev = document.title
    const m = fy ? `${fy.fiscalMonths[monthIdx]}月` : ''
    document.title = `月次レポート_${current?.name || ''}_${fy?.label || ''}_${m}`
    const restore = () => { document.title = prev; window.removeEventListener('afterprint', restore) }
    window.addEventListener('afterprint', restore)
    window.print()
  }, [current, fy, monthIdx])
  const prior = useMemo(() => (fy ? findPriorYear(years, fy) : null), [years, fy])
  const sorted = useMemo(() => sortedYears(years), [years])
  const comp = useMemo(() => {
    if (!fy) return []
    const idx = sorted.findIndex((y) => y.id === fy.id)
    return sorted.slice(Math.max(0, idx - 2), idx + 1)
  }, [sorted, fy])

  // 期末年の推定（ファイル名 R6 / 2024 など）
  const guessYear = (fileName: string, endMonth: number): number => {
    const r = fileName.match(/R(\d{1,2})/i)
    if (r) return 2018 + Number(r[1])
    const y = fileName.match(/20(\d{2})/)
    if (y) return 2000 + Number(y[1])
    const now = new Date()
    const ny = now.getFullYear()
    return now.getMonth() + 1 >= endMonth ? ny : ny - 1
  }

  // 複数CSVをまとめて解析 → 確認ダイアログに並べる
  const handleFiles = useCallback(async (files: FileList) => {
    setErr(null); setMsg(null)
    const items: { data: FiscalYearData; fileName: string; year: number }[] = []
    const errs: string[] = []
    for (const file of Array.from(files)) {
      try {
        const data = parseMonthlyCsv(decodeCsv(await file.arrayBuffer()))
        items.push({ data, fileName: file.name, year: guessYear(file.name, data.endMonth) })
      } catch (e) {
        errs.push(`${file.name}: ${e instanceof Error ? e.message : '解析失敗'}`)
      }
    }
    if (errs.length) setErr(errs.join(' / '))
    if (items.length) {
      // 期末月→期末年で並べ替えて表示（古い順）
      items.sort((a, b) => (a.year * 12 + a.data.endMonth) - (b.year * 12 + b.data.endMonth))
      setPending(items)
    }
  }, [])

  const confirmAll = useCallback(async () => {
    if (!pending || !clientId) return
    const next = { ...years }
    for (const it of pending) {
      const f = finalizeFiscalYear(it.data, it.year)
      next[f.id] = f
    }
    const s = sortedYears(next)
    const newest = s[s.length - 1]
    setYears(next)
    if (newest) { setYearId(newest.id); setMonthIdx(newest.lastFilledIndex) }
    setPending(null)
    await saveYears(clientId, next)
    setMsg(`${pending.length}期分を取り込みました`)
  }, [pending, years, clientId])

  const deleteYear = useCallback(async (id: string) => {
    if (!clientId) return
    if (!window.confirm(`${years[id]?.label || id} のデータを削除しますか？`)) return
    const next = { ...years }
    delete next[id]
    setYears(next)
    if (yearId === id) {
      const s = sortedYears(next)
      setYearId(s.length ? s[s.length - 1].id : '')
    }
    await saveYears(clientId, next)
  }, [clientId, years, yearId])

  // ---- 合言葉ゲート ----
  if (!roomReady) {
    return (
      <div className="min-h-screen flex flex-col bg-[#f6f8fc]" style={{ fontFamily: "'Noto Sans JP', 'Hiragino Sans', 'Yu Gothic UI', sans-serif" }}>
        <GlobalNav currentKey="keiei" />
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="bg-white rounded-xl shadow p-6 w-full max-w-sm">
            <h2 className="text-base font-bold text-gray-800 mb-2">合言葉を入力</h2>
            <p className="text-xs text-gray-500 mb-3">顧問先データを共有するための合言葉を入力してください。</p>
            <input type="password" value={passInput} onChange={(e) => setPassInput(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded mb-3 text-sm" placeholder="合言葉" />
            <button onClick={() => { if (passInput.trim()) { setRoomPassphrase(passInput.trim()); setRoomReady(true) } }}
              className="w-full py-2 bg-blue-600 text-white rounded text-sm font-medium hover:bg-blue-700">開く</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex flex-col bg-[#f6f8fc]" style={{ fontFamily: "'Noto Sans JP', 'Hiragino Sans', 'Yu Gothic UI', sans-serif" }}>
      <GlobalNav currentKey="keiei" />

      {/* ヘッダ（④ Apple×Google調） */}
      <div className="bg-white shadow-[0_1px_2px_rgba(60,64,67,0.1)] px-6 py-3 flex items-center gap-3 flex-wrap">
        <div className="w-9 h-9 rounded-[12px] bg-gradient-to-br from-[#1a73e8] to-[#0071e3] flex items-center justify-center text-lg shrink-0">📈</div>
        <h1 className="text-[19px] font-bold text-gray-800 tracking-tight">月次レポート</h1>
        {clientId && (
          <>
            <button onClick={() => setClientId('')}
              className="px-3 py-1.5 text-sm text-[#1a73e8] rounded-full hover:bg-[#e8f0fe]">← 一覧へ戻る</button>
            <span className="text-sm font-bold text-gray-700">{current ? `${current.code ? current.code + ' ' : ''}${current.name}` : ''}</span>
            <label className="ml-auto px-4 py-2 bg-[#1a73e8] text-white rounded-full text-sm font-semibold hover:bg-[#1765cc] cursor-pointer shadow-sm">
              ＋ CSVを取込
              <input type="file" accept=".csv" multiple className="hidden"
                onChange={(e) => { if (e.target.files?.length) handleFiles(e.target.files); e.target.value = '' }} />
            </label>
          </>
        )}
      </div>

      {msg && <div className="px-5 py-2 bg-green-50 text-green-700 text-sm border-b border-green-100">{msg}</div>}
      {err && <div className="px-5 py-2 bg-red-50 text-red-700 text-sm border-b border-red-100">{err}</div>}

      {clients.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-gray-500 text-sm gap-1">
          <div className="text-4xl opacity-30">📈</div>
          表示できる顧問先がありません。
          <div className="text-xs text-gray-400">顧問先情報の「アプリ利用 ＞ 月次レポート」を<b>利用</b>に設定してください。</div>
        </div>
      ) : !clientId ? (
        <div className="flex-1 overflow-auto p-5">
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-4 py-2 bg-gray-50 border-b border-gray-200 text-xs text-gray-500">
              「顧問先情報登録」の「アプリ利用」で<b>月次レポート＝利用</b>にした顧問先です（コード順）。会社を選ぶと月次レポートを表示します。
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-500 bg-gray-50 border-b border-gray-200">
                  <th className="text-left px-4 py-2 w-24">コード</th>
                  <th className="text-left px-4 py-2">会社名</th>
                  <th className="text-right px-4 py-2 w-28">操作</th>
                </tr>
              </thead>
              <tbody>
                {clients.map((c) => (
                  <tr key={c.id} className="border-b border-gray-100 hover:bg-sky-50 cursor-pointer" onClick={() => setClientId(c.id)}>
                    <td className="px-4 py-2.5 text-gray-600">{c.code || ''}</td>
                    <td className="px-4 py-2.5 font-medium text-gray-800">{c.name}</td>
                    <td className="px-4 py-2.5 text-right">
                      <button onClick={(e) => { e.stopPropagation(); setClientId(c.id) }}
                        className="px-3 py-1 bg-blue-600 text-white rounded text-xs font-medium hover:bg-blue-700">開く</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : loading ? (
        <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">読み込み中…</div>
      ) : sorted.length === 0 ? (
        <div className="flex-1 flex items-center justify-center p-6">
          <label className="w-full max-w-xl border-2 border-dashed border-blue-300 rounded-2xl bg-blue-50/40 hover:bg-blue-50 p-8 flex flex-col items-center gap-3 text-center cursor-pointer">
            <div className="text-5xl opacity-40">📈</div>
            <div className="text-gray-700 font-medium">会計大将の「月次推移 貸借対照表／損益計算書」CSVを取り込みます</div>
            <div className="text-xs text-gray-500 leading-relaxed">
              3期分のCSVファイルを<b>まとめて選択</b>できます（1ファイル＝1期）。<br />
              選択後、ファイルごとに決算期（西暦年）を確認して取り込みます。
            </div>
            <span className="mt-1 px-5 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-bold hover:bg-blue-700">
              ＋ CSVファイルを選択（複数可）
            </span>
            <input type="file" accept=".csv" multiple className="hidden"
              onChange={(e) => { if (e.target.files?.length) handleFiles(e.target.files); e.target.value = '' }} />
          </label>
        </div>
      ) : (
        <div className="flex-1 overflow-auto p-5 space-y-5">
          {/* 期・月の選択＋取込済み一覧 */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-[0_3px_10px_rgba(26,115,232,0.06)] p-4">
            <div className="flex items-center gap-3 flex-wrap mb-3">
              <span className="text-xs text-gray-500">対象期</span>
              <select value={yearId} onChange={(e) => { setYearId(e.target.value); const y = years[e.target.value]; if (y) setMonthIdx(y.lastFilledIndex) }}
                className="px-3 py-1.5 border border-gray-300 rounded text-sm">
                {sorted.slice().reverse().map((y) => <option key={y.id} value={y.id}>{y.label}</option>)}
              </select>
              {fy && (
                <>
                  <span className="text-xs text-gray-500 ml-2">対象月</span>
                  <select value={monthIdx} onChange={(e) => setMonthIdx(Number(e.target.value))}
                    className="px-3 py-1.5 border border-gray-300 rounded text-sm">
                    {fy.fiscalMonths.slice(0, fy.lastFilledIndex + 1).map((m, i) => (
                      <option key={i} value={i}>{m}月</option>
                    ))}
                  </select>
                </>
              )}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-gray-400">取込済み（期ごとに追加・差し替え可）:</span>
              {sorted.map((y, i) => {
                const rel = sorted.length - 1 - i
                const relLabel = rel === 0 ? '当期' : rel === 1 ? '前期' : rel === 2 ? '前々期' : `${rel}期前`
                return (
                  <span key={y.id} className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs border ${y.id === yearId ? 'bg-blue-50 border-blue-300 text-blue-700' : 'bg-gray-50 border-gray-200 text-gray-600'}`}>
                    <span className={`px-1 rounded text-[10px] font-bold ${rel === 0 ? 'bg-blue-600 text-white' : 'bg-gray-300 text-gray-700'}`}>{relLabel}</span>
                    {y.label}（{y.lastFilledIndex + 1}ヶ月）
                    <button onClick={() => deleteYear(y.id)} className="text-gray-400 hover:text-red-600 ml-1">✕</button>
                  </span>
                )
              })}
            </div>
            {/* 分析タブ（④ Apple×Google調のピル）＋印刷 */}
            <div className="flex items-center gap-2 flex-wrap mt-3 pt-3 border-t border-gray-100">
              {([['overview', '概要'], ['report', '試算表・3期比較・推移'], ['detail', '明細・経費'], ['cvp', '損益分岐点'], ['cash', '資金繰り・安全性']] as [View, string][]).map(([v, l]) => (
                <button key={v} onClick={() => setView(v)}
                  className={`px-4 py-1.5 text-sm rounded-full transition-colors ${view === v ? 'bg-[#e8f0fe] text-[#1a73e8] font-semibold' : 'bg-white text-gray-600 hover:bg-gray-50 shadow-[0_1px_2px_rgba(60,64,67,0.08)]'}`}>{l}</button>
              ))}
              <div className="ml-auto flex items-center gap-2">
                {fy && <button onClick={() => openSubmissionPdf(current?.name || '', fy, comp, monthIdx)}
                  className="px-4 py-1.5 text-sm bg-[#1F3A5F] text-white rounded-full hover:bg-[#16304f] font-semibold shadow-sm">🏦 金融機関提出用PDF</button>}
                <button onClick={handlePrint} className="px-4 py-1.5 text-sm text-gray-600 rounded-full hover:bg-gray-100">🖨 印刷</button>
              </div>
            </div>
          </div>

          {fy && (
            <div id="keiei-print-area" className="space-y-5">
              <div className="hidden print:block text-base font-bold text-gray-800">
                月次レポート ｜ {current?.name} ｜ {fy.label} {fy.fiscalMonths[monthIdx]}月
              </div>
              {view === 'overview' && <Overview fy={fy} prior={prior} monthIdx={monthIdx} />}
              {view === 'report' && <SectionReport fy={fy} comp={comp} monthIdx={monthIdx} />}
              {view === 'detail' && <SectionDetail fy={fy} prior={prior} monthIdx={monthIdx} />}
              {view === 'cvp' && <SectionCVP fy={fy} monthIdx={monthIdx} settings={settings} onSettingsChange={changeSettings} years={years} />}
              {view === 'cash' && <SectionCash fy={fy} monthIdx={monthIdx} settings={settings} onSettingsChange={changeSettings} years={years} />}
            </div>
          )}
        </div>
      )}

      <style jsx global>{`
        @media print {
          body * { visibility: hidden; }
          #keiei-print-area, #keiei-print-area * { visibility: visible; }
          #keiei-print-area { position: absolute; left: 0; top: 0; width: 100%; padding: 8px; }
          #keiei-print-area * { overflow: visible !important; max-height: none !important; }
          #keiei-print-area .bg-white { break-inside: avoid; border: 1px solid #e5e7eb; }
          @page { size: A4; margin: 12mm; }
        }
      `}</style>

      {/* 期末年の確認ダイアログ（複数ファイルまとめて） */}
      {pending && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setPending(null)}>
          <div className="bg-white rounded-xl shadow-xl p-5 w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-bold text-gray-800 mb-1">取込内容の確認（{pending.length}ファイル）</h3>
            <p className="text-xs text-gray-500 mb-3">決算期末月は自動判定しました。各ファイルの<b>期末の西暦年</b>を確認してください（決算期を確定します）。</p>
            <div className="space-y-2 max-h-[55vh] overflow-auto">
              {pending.map((it, i) => {
                const dup = pending.some((o, j) => j !== i && o.year === it.year && o.data.endMonth === it.data.endMonth)
                return (
                  <div key={i} className="border border-gray-200 rounded-lg p-3">
                    <div className="text-xs text-gray-500 break-all mb-1.5">{it.fileName}</div>
                    <div className="flex items-center gap-2 flex-wrap text-sm">
                      <span className="text-gray-700">期末 <b>{it.data.endMonth}月</b></span>
                      <span className="text-gray-300">/</span>
                      <span className="text-gray-500 text-xs">期末年</span>
                      <input type="number" value={it.year}
                        onChange={(e) => setPending((p) => p ? p.map((x, j) => j === i ? { ...x, year: Number(e.target.value) } : x) : p)}
                        className="w-24 px-2 py-1 border border-gray-300 rounded text-sm" />
                      <span className="text-blue-700 font-medium ml-1">→ {it.year - 2018 >= 1 ? `令和${it.year - 2018}年` : `${it.year}年`}{it.data.endMonth}月期（{it.data.lastFilledIndex + 1}ヶ月）</span>
                    </div>
                    {dup && <div className="text-xs text-amber-600 mt-1">⚠ 同じ決算期が複数あります。重複すると後のファイルで上書きされます。</div>}
                  </div>
                )
              })}
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setPending(null)} className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded">キャンセル</button>
              <button onClick={confirmAll} className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded font-medium hover:bg-blue-700">取込（{pending.length}期）</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ============ 概要（単月業績＋推移グラフ） ============
function Overview({ fy, prior, monthIdx }: { fy: FiscalYearData; prior: FiscalYearData | null; monthIdx: number }) {
  const single = plKpisSingle(fy, monthIdx)
  const pSingle = prior ? plKpisSingle(prior, monthIdx) : null
  const monthLabel = `${fy.fiscalMonths[monthIdx]}月`
  const upto = monthIdx + 1
  const monthLabels = fy.fiscalMonths.slice(0, upto).map((m) => `${m}月`)
  const salesSeries = (getRow(fy, CODES.sales)?.monthly || []).slice(0, upto)
  const opSeries = (getRow(fy, CODES.opProfit)?.monthly || []).slice(0, upto)
  return (
    <div className="space-y-5">
      <Section title={`${fy.label}　${monthLabel}（単月）の業績`} note={prior ? '各カード下段に前年同月比を表示' : '前年のデータを取り込むと前年同月比を表示します'}>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <KpiCard title="売上高" value={single.sales} prior={pSingle?.sales} />
          <KpiCard title="売上総利益(粗利)" value={single.grossProfit} margin={single.grossMargin} prior={pSingle?.grossProfit} />
          <KpiCard title="営業利益" value={single.opProfit} margin={single.opMargin} prior={pSingle?.opProfit} />
          <KpiCard title="経常利益" value={single.ordProfit} margin={single.ordMargin} prior={pSingle?.ordProfit} />
          <KpiCard title="当期純利益" value={single.netProfit} prior={pSingle?.netProfit} />
        </div>
      </Section>
      <Section title={`損益の推移実績（当期・期首〜${monthLabel}）`}>
        <ComboBarLine labels={monthLabels} bars={salesSeries} barLabel="売上高（棒）" line={opSeries} lineLabel="営業利益（線）" />
      </Section>
    </div>
  )
}

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

function KpiCard({ title, value, margin, prior }: { title: string; value: number; margin?: number; prior?: number }) {
  const neg = value < 0
  const yy = prior != null && prior !== 0 ? ((value - prior) / Math.abs(prior)) * 100 : null
  return (
    <div className={`rounded-xl border p-4 ${neg ? 'border-red-200 bg-red-50/70' : 'border-gray-200 bg-white'} shadow-sm`}>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[13px] font-semibold text-gray-700">{title}</span>
        {margin != null && (
          <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 text-[11px] font-bold whitespace-nowrap">利益率 {fmtPct(margin)}</span>
        )}
      </div>
      <div className={`text-[26px] leading-none font-extrabold ${neg ? 'text-red-600' : 'text-gray-900'}`}>{fmtShort(value)}</div>
      <div className="text-xs text-gray-500 mt-1">{fmtYen(value)}</div>
      <div className="mt-2.5 pt-2 border-t border-gray-200 flex items-center justify-between">
        <span className="text-[11px] text-gray-500">前年同月比</span>
        {prior == null ? (
          <span className="text-[11px] text-gray-400">データなし</span>
        ) : (
          <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${yy == null ? 'bg-gray-100 text-gray-400' : yy >= 0 ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'}`}>{fmtPctSigned(yy)}</span>
        )}
      </div>
      {prior != null && <div className="text-[11px] text-gray-400 mt-1 text-right">前年同月 {fmtShort(prior)}</div>}
    </div>
  )
}

