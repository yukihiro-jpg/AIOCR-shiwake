'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
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
import { saveSettings, subscribeSettings } from '@/lib/keiei/store'
import { defaultSettings, type KeieiSettings } from '@/lib/keiei/analysis'
import SectionDetail from './SectionDetail'
import SectionCvpFcf, { type CvpSim } from './SectionCvpFcf'
import SectionCash from './SectionCash'
import SectionReport from './SectionReport'
import SectionBudget from './SectionBudget'
import { buildSummaryStory } from '@/lib/keiei/narrative'

type View = 'overview' | 'report' | 'detail' | 'cvpfcf' | 'cash' | 'budget'

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
    // 設定はリアルタイム購読（他端末の変更を都度反映し、古い値での上書き＝巻き戻りを防ぐ）
    let unsub = () => { /* noop */ }
    let alive = true
    subscribeSettings(clientId, (s) => setSettings(s)).then((u) => { if (alive) unsub = u; else u() })
    setLoading(true)
    loadYears(clientId).then((y) => {
      setYears(y)
      const sorted = sortedYears(y)
      const newest = sorted[sorted.length - 1]
      if (newest) { setYearId(newest.id); setMonthIdx(newest.lastFilledIndex) }
      else { setYearId(''); }
    }).finally(() => setLoading(false))
    return () => { alive = false; unsub() }
  }, [clientId])

  const changeSettings = useCallback((s: KeieiSettings) => {
    setSettings(s)
    if (clientId) saveSettings(clientId, s)
  }, [clientId])

  const current = clients.find((c) => c.id === clientId)
  const fy = years[yearId]

  // ===== 印刷（タブ選択式） =====
  const TABS: [View, string][] = [['overview', '概要'], ['budget', '予算・予実'], ['report', '試算表・3期比較・推移'], ['detail', '明細・経費'], ['cvpfcf', '損益分岐点・FCF分析'], ['cash', '資金繰り・安全性']]
  const TAB_LABEL = (v: View) => TABS.find(([k]) => k === v)?.[1] || ''
  const [printOpen, setPrintOpen] = useState(false)
  // 損益分岐点シミュレーションのスライダー値を親で保持し、画面・印刷で同じ値を使う
  const [cvpSim, setCvpSim] = useState<CvpSim>({ sales: 0, gross: 0, var: 0, fixed: 0 })
  const [printSel, setPrintSel] = useState<View[]>(['overview', 'budget', 'report', 'detail', 'cvpfcf', 'cash'])
  const [printViews, setPrintViews] = useState<View[] | null>(null)
  const printRef = useRef<HTMLDivElement>(null)
  const togglePrintSel = (v: View) => setPrintSel((s) => s.includes(v) ? s.filter((x) => x !== v) : [...s, v])
  const orderedSel = TABS.map(([v]) => v).filter((v) => printSel.includes(v))
  const doPrint = (views: View[]) => { if (!views.length) return; setPrintOpen(false); setPrintViews(views) }
  useEffect(() => {
    const h = (e: MouseEvent) => { if (printRef.current && !printRef.current.contains(e.target as Node)) setPrintOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])
  useEffect(() => {
    if (!printViews) return
    const prev = document.title
    const m = fy ? `${fy.fiscalMonths[monthIdx]}月` : ''
    document.title = `月次レポート_${current?.name || ''}_${fy?.label || ''}_${m}`
    const after = () => { document.title = prev; setPrintViews(null) }
    window.addEventListener('afterprint', after, { once: true })
    const t = setTimeout(() => window.print(), 250)
    return () => { clearTimeout(t); window.removeEventListener('afterprint', after) }
  }, [printViews, fy, current, monthIdx])
  const prior = useMemo(() => (fy ? findPriorYear(years, fy) : null), [years, fy])
  const sorted = useMemo(() => sortedYears(years), [years])
  const comp = useMemo(() => {
    if (!fy) return []
    const idx = sorted.findIndex((y) => y.id === fy.id)
    return sorted.slice(Math.max(0, idx - 2), idx + 1)
  }, [sorted, fy])

  const renderView = (v: View) => {
    if (!fy) return null
    switch (v) {
      case 'overview': return <Overview fy={fy} prior={prior} monthIdx={monthIdx} years={years} settings={settings} clientId={clientId} />
      case 'report': return <SectionReport fy={fy} comp={comp} monthIdx={monthIdx} company={current?.name || ''} />
      case 'detail': return <SectionDetail fy={fy} prior={prior} monthIdx={monthIdx} />
      case 'cvpfcf': return <SectionCvpFcf fy={fy} prior={prior} monthIdx={monthIdx} yearId={yearId} settings={settings} onSettingsChange={changeSettings} years={years} sim={cvpSim} onSimChange={setCvpSim} />
      case 'cash': return <SectionCash fy={fy} monthIdx={monthIdx} settings={settings} onSettingsChange={changeSettings} years={years} />
      case 'budget': return <SectionBudget fy={fy} monthIdx={monthIdx} yearId={yearId} settings={settings} onSettingsChange={changeSettings} years={years} />
    }
  }

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
              {TABS.map(([v, l]) => (
                <button key={v} onClick={() => setView(v)}
                  className={`px-4 py-1.5 text-sm rounded-full transition-colors ${view === v ? 'bg-[#e8f0fe] text-[#1a73e8] font-semibold' : 'bg-white text-gray-600 hover:bg-gray-50 shadow-[0_1px_2px_rgba(60,64,67,0.08)]'}`}>{l}</button>
              ))}
              <div ref={printRef} className="ml-auto relative">
                <button onClick={() => setPrintOpen((o) => !o)} className="px-4 py-1.5 text-sm text-gray-600 rounded-full hover:bg-gray-100">🖨 印刷 ▾</button>
                {printOpen && (
                  <div className="absolute right-0 top-full mt-1 w-80 bg-white border border-gray-200 rounded-xl shadow-xl z-30 p-3">
                    <div className="text-xs font-bold text-gray-700 mb-1">印刷するタブを選択</div>
                    <div className="text-[11px] text-gray-400 mb-2">クリックで選択／解除。選択したタブのみ出力します。</div>
                    <div className="flex flex-wrap gap-1.5 mb-3">
                      {TABS.map(([v, l]) => { const on = printSel.includes(v); return (
                        <button key={v} onClick={() => togglePrintSel(v)}
                          className={`px-2.5 py-1 rounded-full text-xs border transition-colors ${on ? 'bg-[#1F3A5F] text-white border-[#1F3A5F]' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}>{on ? '✓ ' : ''}{l}</button>
                      ) })}
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <button onClick={() => setPrintSel(TABS.map(([v]) => v))} className="text-[11px] text-[#1a73e8] hover:underline">全部選択</button>
                      <div className="flex gap-2">
                        <button onClick={() => doPrint(TABS.map(([v]) => v))} className="px-3 py-1.5 text-xs bg-[#C8A24B] text-white rounded-lg font-bold hover:brightness-95">全部出力</button>
                        <button onClick={() => doPrint(orderedSel)} disabled={!orderedSel.length} className="px-3 py-1.5 text-xs bg-[#1F3A5F] text-white rounded-lg font-bold hover:brightness-110 disabled:opacity-40">選択を出力</button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {fy && (
            <div className="space-y-5">
              {renderView(view)}
            </div>
          )}

          {/* 印刷専用: 選択タブをコンサル報告書調で出力（画面では非表示） */}
          {fy && printViews && (
            <div id="keiei-multiprint">
              <div className="kp-cover">
                <div className="kp-eyebrow">MONTHLY MANAGEMENT REPORT</div>
                <h1 className="kp-title">月次経営レポート</h1>
                <div className="kp-sub"><b>{current?.name}</b> 御中　／　{fy.label}　{fy.fiscalMonths[monthIdx]}月度　／　作成日 {(() => { const d = new Date(); return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日` })()}</div>
                <div className="kp-rule" />
              </div>
              {printViews.map((v, i) => (
                <section key={v} className={i > 0 ? 'kp-section kp-break' : 'kp-section'}>
                  <div className="kp-sec-title">{TAB_LABEL(v)}</div>
                  {renderView(v)}
                </section>
              ))}
              <div className="kp-foot">{current?.name} ｜ 月次経営レポート ｜ {fy.label} {fy.fiscalMonths[monthIdx]}月</div>
            </div>
          )}
        </div>
      )}

      <style jsx global>{`
        #keiei-multiprint { display: none; }
        @media print {
          body * { visibility: hidden; }
          #keiei-multiprint, #keiei-multiprint * { visibility: visible; }
          #keiei-multiprint { display: block; position: absolute; left: 0; top: 0; width: 100%; color: #243042; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          #keiei-multiprint * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          #keiei-multiprint * { overflow: visible !important; max-height: none !important; }
          @page { size: A4; margin: 14mm 12mm; }

          /* コンサル報告書調（ネイビー&ゴールド） */
          #keiei-multiprint .kp-cover { padding-bottom: 8px; margin-bottom: 18px; }
          #keiei-multiprint .kp-eyebrow { font-size: 10px; letter-spacing: 4px; color: #c8a24b; font-weight: 700; }
          #keiei-multiprint .kp-title { font-size: 27px; font-weight: 800; color: #1f3a5f; letter-spacing: 2px; margin: 2px 0; }
          #keiei-multiprint .kp-sub { font-size: 12px; color: #5b6675; }
          #keiei-multiprint .kp-rule { height: 3px; margin-top: 10px; background: linear-gradient(90deg,#1f3a5f 0%,#1f3a5f 72%,#c8a24b 72%,#c8a24b 100%); }
          #keiei-multiprint .kp-break { break-before: page; page-break-before: always; }
          #keiei-multiprint .kp-sec-title { font-size: 16px; font-weight: 800; color: #1f3a5f; border-left: 5px solid #c8a24b; border-bottom: 2px solid #1f3a5f; padding: 0 0 6px 10px; margin: 4px 0 14px; }
          #keiei-multiprint .kp-foot { position: fixed; bottom: 6mm; left: 0; right: 0; text-align: center; font-size: 9px; color: #9aa3ad; }

          /* カードは影を消して軽い罫線に。青系の強調はネイビーへ寄せる */
          #keiei-multiprint .bg-white { box-shadow: none !important; border: 1px solid #d7dde6 !important; border-radius: 6px !important; break-inside: avoid; }
          #keiei-multiprint .rounded-2xl, #keiei-multiprint .rounded-xl, #keiei-multiprint .rounded-lg { border-radius: 6px !important; }
          #keiei-multiprint h2 { color: #1f3a5f !important; }
          #keiei-multiprint .text-blue-700, #keiei-multiprint .text-blue-600 { color: #1f3a5f !important; }
          #keiei-multiprint .kp-section { break-inside: auto; }
          /* 操作系（スライダー・ボタン）は報告書では非表示。数値・入力値は残す */
          #keiei-multiprint input[type='range'], #keiei-multiprint button { display: none !important; }
          #keiei-multiprint input { border-color: #d7dde6 !important; }

          /* 表を二次相続レポートと同系統のコンサル調に：ネイビーのヘッダ・細罫線・ゼブラ */
          #keiei-multiprint table { border-collapse: collapse !important; width: 100%; }
          #keiei-multiprint thead th, #keiei-multiprint thead td { background: #1f3a5f !important; color: #fff !important; border-color: #1f3a5f !important; font-weight: 700; }
          #keiei-multiprint table th, #keiei-multiprint table td { border: 1px solid #d3dae3 !important; }
          #keiei-multiprint tbody tr:nth-child(even) td { background: #f6f8fb !important; }
          /* 合計・強調行（太字）は淡いネイビー地に寄せる */
          #keiei-multiprint tbody tr.font-bold td, #keiei-multiprint tbody tr.font-semibold td { background: #e7edf5 !important; }
          /* 損益・安全性などの良し悪しは緑/赤を維持（コンサル調でも意味色は残す） */
          #keiei-multiprint .text-green-600, #keiei-multiprint .text-green-700 { color: #1a7f37 !important; }
          #keiei-multiprint .text-amber-700, #keiei-multiprint .text-amber-600 { color: #b4690e !important; }
          /* ゴールドの細い区切りをセクション見出し直後に */
          #keiei-multiprint .kp-sec-title { background: linear-gradient(180deg,#fbfcfe,#fff); }
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

// ============ 概要（経営サマリー＋単月業績＋推移グラフ） ============
function Overview({ fy, prior, monthIdx, years, settings, clientId }: { fy: FiscalYearData; prior: FiscalYearData | null; monthIdx: number; years: Record<string, FiscalYearData>; settings: KeieiSettings; clientId: string }) {
  const single = plKpisSingle(fy, monthIdx)
  const pSingle = prior ? plKpisSingle(prior, monthIdx) : null
  const monthLabel = `${fy.fiscalMonths[monthIdx]}月`
  const upto = monthIdx + 1
  const monthLabels = fy.fiscalMonths.slice(0, upto).map((m) => `${m}月`)
  const salesSeries = (getRow(fy, CODES.sales)?.monthly || []).slice(0, upto)
  const opSeries = (getRow(fy, CODES.opProfit)?.monthly || []).slice(0, upto)
  const baseStory = useMemo(() => buildSummaryStory(fy, prior, monthIdx, years, settings), [fy, prior, monthIdx, years, settings])
  return (
    <div className="space-y-5">
      <SummaryStory baseStory={baseStory} storyKey={`${clientId}__${fy.id}__${monthIdx}`} />
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

// 経営サマリー（相続レポートの .story と同思想のカード解説）。
// テンプレ生成文を土台に、任意で Gemini「AI仕上げ」できる。仕上げ後の文は編集も可能。
function SummaryStory({ baseStory, storyKey }: { baseStory: string; storyKey: string }) {
  // 対象（顧問先・期・月）が変わったら仕上げ済みテキストをリセット
  const [aiText, setAiText] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  useEffect(() => { setAiText(null); setEditing(false); setErr(null) }, [storyKey])
  const text = aiText ?? baseStory

  const runPolish = async () => {
    setBusy(true); setErr(null)
    try {
      const { polishSummaryStory } = await import('@/lib/keiei/gemini')
      const out = await polishSummaryStory(baseStory)
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
        <span className="text-lg">📝</span>
        <h2 className="text-[15px] font-bold text-gray-800">今月の経営サマリー</h2>
        <span className="text-[11px] text-gray-400">{aiText ? 'AI仕上げ済み' : 'テンプレ自動生成'}</span>
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

// マーカー付きテキスト（# 見出し / 【小見出し】/ **強調**）を相続風に整形描画
function StoryBody({ text }: { text: string }) {
  const blocks = text.split(/\n\n+/).map((s) => s.trim()).filter(Boolean)
  const renderInline = (s: string, keyBase: string) =>
    s.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
      part.startsWith('**') && part.endsWith('**')
        ? <b key={`${keyBase}-${i}`} className="text-[#1f3a5f] font-bold">{part.slice(2, -2)}</b>
        : <span key={`${keyBase}-${i}`}>{part}</span>)
  return (
    <div className="space-y-3.5">
      {blocks.map((b, i) => {
        if (b.startsWith('# ')) {
          return <div key={i} className="text-[17px] font-extrabold text-[#1f3a5f] leading-snug">{b.slice(2)}</div>
        }
        const m = b.match(/^【([^】]+)】([\s\S]*)$/)
        if (m) {
          return (
            <div key={i} className="border-l-[3px] border-[#c8a24b] pl-3.5">
              <div className="text-[13px] font-bold text-[#1f3a5f] mb-0.5">{m[1]}</div>
              <p className="text-[13.5px] leading-[1.9] text-gray-700">{renderInline(m[2].trim(), `b${i}`)}</p>
            </div>
          )
        }
        return <p key={i} className="text-[13.5px] leading-[1.9] text-gray-700">{renderInline(b, `b${i}`)}</p>
      })}
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

// 前年同月比の表示。黒字↔赤字の符号反転は「黒字転換／赤字転落」等と明示し、
// 単純な%が誤解を招くケース（前年が赤字→当年黒字で+101.7%等）を防ぐ。
function yoyInfo(value: number, prior?: number): { label: string; tone: 'good' | 'bad' | 'muted'; diff: number } | null {
  if (prior == null) return null
  const diff = value - prior
  if (prior === 0) {
    if (value > 0) return { label: '前年0→黒字', tone: 'good', diff }
    if (value < 0) return { label: '前年0→赤字', tone: 'bad', diff }
    return { label: '±0', tone: 'muted', diff }
  }
  if (prior < 0 && value >= 0) return { label: '黒字転換', tone: 'good', diff }
  if (prior >= 0 && value < 0) return { label: '赤字転落', tone: 'bad', diff }
  if (prior < 0 && value < 0) {
    const rate = (diff / Math.abs(prior)) * 100 // >0＝赤字縮小（改善）
    return { label: `赤字${rate >= 0 ? '縮小' : '拡大'}${Math.abs(rate).toFixed(1)}%`, tone: rate >= 0 ? 'good' : 'bad', diff }
  }
  const rate = (diff / Math.abs(prior)) * 100
  return { label: `${rate >= 0 ? '+' : '−'}${Math.abs(rate).toFixed(1)}%`, tone: rate >= 0 ? 'good' : 'bad', diff }
}

function KpiCard({ title, value, margin, prior }: { title: string; value: number; margin?: number; prior?: number }) {
  const neg = value < 0
  const yy = yoyInfo(value, prior)
  const toneCls = yy == null ? 'bg-gray-100 text-gray-400' : yy.tone === 'good' ? 'bg-green-100 text-green-700' : yy.tone === 'bad' ? 'bg-red-100 text-red-600' : 'bg-gray-100 text-gray-500'
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
        {yy == null ? (
          <span className="text-[11px] text-gray-400">データなし</span>
        ) : (
          <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${toneCls}`}>{yy.label}</span>
        )}
      </div>
      {yy != null && (
        <div className="text-[11px] text-gray-400 mt-1 flex items-center justify-between">
          <span>前年同月 {fmtShort(prior as number)}</span>
          <span className={yy.diff >= 0 ? 'text-green-600' : 'text-red-500'}>前年差 {yy.diff >= 0 ? '＋' : '−'}{fmtShort(Math.abs(yy.diff))}</span>
        </div>
      )}
    </div>
  )
}

