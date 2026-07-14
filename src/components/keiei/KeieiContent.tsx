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
import { ComboBarLine, GroupedBars, Waterfall, Bullet, HBars } from './charts'
import { saveSettings, subscribeSettings } from '@/lib/keiei/store'
import { defaultSettings, cvp, safety, profitBridge, landingScenarios, detailsOf, rowYtd, type KeieiSettings } from '@/lib/keiei/analysis'
import SectionDetail from './SectionDetail'
import SectionCvpFcf, { type CvpSim } from './SectionCvpFcf'
import SectionCash from './SectionCash'
import SectionReport from './SectionReport'
import SectionBudget from './SectionBudget'
import SectionIssues from './SectionIssues'
import { StoryBody } from './StoryCard'
import { buildSummaryStory } from '@/lib/keiei/narrative'
import { detectIssues, laborShare } from '@/lib/keiei/issues'
import SectionAnken from './SectionAnken'
import SectionLedger from './SectionLedger'
import SectionAudit from './SectionAudit'
import { parseLedgerCsv, findMatchingFy } from '@/lib/keiei/ledger'
import { saveLedger, deleteLedger } from '@/lib/keiei/ledger-store'
import { buildPrintReportHtml, PRINT_VIEWS, type PrintView } from '@/lib/keiei/print-report'

type View = 'overview' | 'report' | 'detail' | 'cvpfcf' | 'issues' | 'cash' | 'budget' | 'anken' | 'ledger' | 'audit'

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

  // 設定保存のデバウンス（コメント欄などキーストローク毎に全設定を書くとRTDB書込が膨れ、
  // 自分のエコーとカーソルが競合するため、600ms まとめて保存する）
  const settingsSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingSettingsRef = useRef<KeieiSettings | null>(null)
  const lastAppliedJsonRef = useRef<string>('')
  const flushSettings = useCallback((cid: string) => {
    if (settingsSaveTimer.current) { clearTimeout(settingsSaveTimer.current); settingsSaveTimer.current = null }
    const s = pendingSettingsRef.current
    if (s) { pendingSettingsRef.current = null; lastAppliedJsonRef.current = JSON.stringify(s); saveSettings(cid, s) }
  }, [])

  // 顧問先の年度データ読み込み
  useEffect(() => {
    if (!clientId) { setYears({}); return }
    setSelectedClientId(clientId)
    setView('overview')
    // 設定はリアルタイム購読（他端末の変更を都度反映し、古い値での上書き＝巻き戻りを防ぐ）
    let unsub = () => { /* noop */ }
    let alive = true
    subscribeSettings(clientId, (s) => {
      // 自分の保存のエコー（同一内容）は無視して、入力中の再レンダー・カーソル競合を防ぐ
      const j = JSON.stringify(s)
      if (j === lastAppliedJsonRef.current) return
      lastAppliedJsonRef.current = j
      setSettings(s)
    }).then((u) => { if (alive) unsub = u; else u() })
    setLoading(true)
    loadYears(clientId).then((y) => {
      setYears(y)
      const sorted = sortedYears(y)
      const newest = sorted[sorted.length - 1]
      if (newest) { setYearId(newest.id); setMonthIdx(newest.lastFilledIndex) }
      else {
        setYearId('')
        // 試算表CSV未取込で案件台帳を使う顧問先は、最初から案件台帳タブを開く
        if (clients.find((c) => c.id === clientId)?.name?.includes('藤井設計')) setView('anken')
      }
    }).finally(() => setLoading(false))
    const cid = clientId
    return () => { alive = false; unsub(); flushSettings(cid) }
  }, [clientId, flushSettings])

  const changeSettings = useCallback((s: KeieiSettings) => {
    setSettings(s)
    lastAppliedJsonRef.current = JSON.stringify(s)
    if (!clientId) return
    pendingSettingsRef.current = s
    if (settingsSaveTimer.current) clearTimeout(settingsSaveTimer.current)
    settingsSaveTimer.current = setTimeout(() => flushSettings(clientId), 600)
  }, [clientId, flushSettings])

  const current = clients.find((c) => c.id === clientId)
  const fy = years[yearId]

  // ===== 印刷（タブ選択式・新規ウィンドウに「1資料＝横A4・1枚」の報告書を生成） =====
  // 案件台帳タブは設計業務の契約管理Excelを使う顧問先（藤井設計）のみ表示。専用のPDF/Excel出力を持つため印刷選択には含めない
  const hasAnken = !!current?.name?.includes('藤井設計')
  const PRINT_TABS: [View, string][] = PRINT_VIEWS as unknown as [View, string][]
  // 損益計算書（3期推移・A3縦）は印刷専用。画面タブは「試算表・3期比較・推移」内に既にあるため重複させない
  const SCREEN_TABS: [View, string][] = PRINT_TABS.filter(([v]) => (v as string) !== 'trend3pl')
  // 元帳分析・会計監査は端末ローカルデータ（IndexedDB）を使うため印刷選択には含めない
  const TABS: [View, string][] = [...SCREEN_TABS, ['ledger', '元帳分析'] as [View, string], ['audit', '会計監査'] as [View, string], ...(hasAnken ? [['anken', '案件台帳'] as [View, string]] : [])]
  const [printOpen, setPrintOpen] = useState(false)
  // 損益分岐点シミュレーションのスライダー値を親で保持（画面タブ用）
  const [cvpSim, setCvpSim] = useState<CvpSim>({ sales: 0, gross: 0, var: 0, fixed: 0 })
  const [printSel, setPrintSel] = useState<View[]>(['overview', 'budget', 'report', 'detail', 'cvpfcf', 'issues', 'cash', 'trend3pl' as View])
  const printRef = useRef<HTMLDivElement>(null)
  const togglePrintSel = (v: View) => setPrintSel((s) => s.includes(v) ? s.filter((x) => x !== v) : [...s, v])
  const orderedSel = PRINT_TABS.map(([v]) => v).filter((v) => printSel.includes(v))
  useEffect(() => {
    const h = (e: MouseEvent) => { if (printRef.current && !printRef.current.contains(e.target as Node)) setPrintOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])
  const prior = useMemo(() => (fy ? findPriorYear(years, fy) : null), [years, fy])
  // 選択タブの報告書を新規ウィンドウで生成（表紙に選択資料の番号付き目次。未選択の資料は番号が繰り上がる）
  const doPrint = (views: View[]) => {
    if (!views.length || !fy) return
    setPrintOpen(false)
    setErr(null)
    const html = buildPrintReportHtml({
      views: views as PrintView[],
      company: current?.name || '',
      fy, prior, years, monthIdx, settings,
    })
    const w = window.open('', '_blank')
    if (!w) {
      setErr('ポップアップがブロックされました。ブラウザの設定で許可してから、もう一度「印刷」を押してください。')
      return
    }
    w.document.open(); w.document.write(html); w.document.close()
  }
  const sorted = useMemo(() => sortedYears(years), [years])
  const comp = useMemo(() => {
    if (!fy) return []
    const idx = sorted.findIndex((y) => y.id === fy.id)
    return sorted.slice(Math.max(0, idx - 2), idx + 1)
  }, [sorted, fy])

  const renderView = (v: View) => {
    if (v === 'anken') return <SectionAnken clientId={clientId} company={current?.name || ''} />
    if (v === 'audit') return <SectionAudit clientId={clientId} years={years} company={current?.name || ''} />
    if (!fy) return null
    if (v === 'ledger') return <SectionLedger clientId={clientId} fy={fy} monthIdx={monthIdx} reloadKey={ledgerReload} />
    switch (v) {
      case 'overview': return <Overview fy={fy} prior={prior} monthIdx={monthIdx} years={years} settings={settings} clientId={clientId} />
      case 'report': return <SectionReport fy={fy} comp={comp} monthIdx={monthIdx} company={current?.name || ''} />
      case 'detail': return <SectionDetail fy={fy} prior={prior} monthIdx={monthIdx} />
      case 'cvpfcf': return <SectionCvpFcf fy={fy} prior={prior} monthIdx={monthIdx} yearId={yearId} settings={settings} onSettingsChange={changeSettings} years={years} sim={cvpSim} onSimChange={setCvpSim} />
      case 'issues': return <SectionIssues fy={fy} monthIdx={monthIdx} yearId={yearId} settings={settings} onSettingsChange={changeSettings} years={years} company={current?.name || ''} />
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
    // 保持は直近5期まで。古い期は自動削除してFirebase使用量を節約する
    // （分析は3期比較までなので5期あれば十分。端末ローカルの元帳も合わせて削除）
    const KEEP_YEARS = 5
    const all = sortedYears(next)
    const pruned: string[] = []
    for (const y of all.slice(0, Math.max(0, all.length - KEEP_YEARS))) {
      delete next[y.id]
      pruned.push(y.label)
      try { deleteLedger(clientId, y.id) } catch { /* ignore */ }
    }
    const s = sortedYears(next)
    const newest = s[s.length - 1]
    setYears(next)
    if (newest) { setYearId(newest.id); setMonthIdx(newest.lastFilledIndex) }
    setPending(null)
    await saveYears(clientId, next)
    setMsg(`${pending.length}期分を取り込みました` + (pruned.length ? `（5期を超えた ${pruned.join('・')} は自動削除しました）` : ''))
  }, [pending, years, clientId])

  // 総勘定元帳CSVの取込（元帳の日付から対象期を自動判定）
  const [ledgerReload, setLedgerReload] = useState(0)
  const handleLedgerFiles = useCallback(async (files: FileList) => {
    const list = Array.from(files)
    setErr(null); setMsg(null)
    if (!Object.keys(years).length) {
      setErr('先に月次推移試算表CSVを取り込んでください（元帳はその期に紐づけて保存されます）。')
      return
    }
    const okMsgs: string[] = []
    const errs: string[] = []
    for (const file of list) {
      try {
        const data = parseLedgerCsv(decodeCsv(await file.arrayBuffer()), file.name)
        if (!data.txCount) { errs.push(`${file.name}: 元帳データを読み取れませんでした`); continue }
        const fyMatch = findMatchingFy(data, years)
        if (!fyMatch) {
          errs.push(`${file.name}: 元帳の期間（${data.minDate}〜${data.maxDate}）に合う期が見つかりません。その期の試算表CSVを先に取り込んでください`)
          continue
        }
        await saveLedger(clientId, fyMatch.id, data)
        okMsgs.push(`${fyMatch.label}（${data.txCount.toLocaleString()}件）`)
      } catch (e) {
        errs.push(`${file.name}: ${e instanceof Error ? e.message : '取込失敗'}`)
      }
    }
    if (okMsgs.length) {
      setMsg(`総勘定元帳を取り込みました: ${okMsgs.join('、')}。「元帳分析」タブで確認できます（この端末にのみ保存）。`)
      setLedgerReload((n) => n + 1)
      setView('ledger')
    }
    if (errs.length) setErr(errs.join(' / '))
  }, [years, clientId])

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
            <div className="ml-auto flex items-center gap-2">
              <label className="px-4 py-2 bg-[#1a73e8] text-white rounded-full text-sm font-semibold hover:bg-[#1765cc] cursor-pointer shadow-sm whitespace-nowrap"
                title="会計大将の「月次推移 貸借対照表／損益計算書」CSV。1ファイル＝1期分。複数期まとめて選択できます">
                📈 試算表CSVを取込
                <input type="file" accept=".csv" multiple className="hidden"
                  onChange={(e) => { if (e.target.files?.length) handleFiles(e.target.files); e.target.value = '' }} />
              </label>
              <label className="px-4 py-2 bg-white text-[#1a73e8] border border-[#1a73e8] rounded-full text-sm font-semibold hover:bg-[#e8f0fe] cursor-pointer shadow-sm whitespace-nowrap"
                title="会計大将の「総勘定元帳」CSV。日付からどの期かを自動判定して保存します（この端末のみ）">
                📒 総勘定元帳CSVを取込
                <input type="file" accept=".csv" multiple className="hidden"
                  onChange={(e) => { if (e.target.files?.length) handleLedgerFiles(e.target.files); e.target.value = '' }} />
              </label>
            </div>
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
      ) : sorted.length === 0 && !hasAnken ? (
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
          {/* 期・月の選択＋取込済み一覧（試算表CSV取込後のみ表示。案件台帳のみの利用時は不要なため） */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-[0_3px_10px_rgba(26,115,232,0.06)] p-4">
            {sorted.length > 0 && (<>
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
              <span className="text-xs text-gray-400">取込済み（期ごとに追加・差し替え可。翌期は新しい期の試算表CSVを取り込むだけで当期になります。保持は直近5期まで＝古い期は自動削除）:</span>
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
            </>)}
            {/* 分析タブ（④ Apple×Google調のピル）＋印刷 */}
            <div className={`flex items-center gap-2 flex-wrap ${sorted.length > 0 ? 'mt-3 pt-3 border-t border-gray-100' : ''}`}>
              {TABS.map(([v, l]) => (
                <button key={v} onClick={() => setView(v)}
                  className={`px-4 py-1.5 text-sm rounded-full transition-colors ${view === v ? 'bg-[#e8f0fe] text-[#1a73e8] font-semibold' : 'bg-white text-gray-600 hover:bg-gray-50 shadow-[0_1px_2px_rgba(60,64,67,0.08)]'}`}>{l}</button>
              ))}
              {fy && <div ref={printRef} className="ml-auto relative">
                <button onClick={() => setPrintOpen((o) => !o)} className="px-4 py-1.5 text-sm text-gray-600 rounded-full hover:bg-gray-100">🖨 印刷 ▾</button>
                {printOpen && (
                  <div className="absolute right-0 top-full mt-1 w-80 bg-white border border-gray-200 rounded-xl shadow-xl z-30 p-3">
                    <div className="text-xs font-bold text-gray-700 mb-1">印刷する資料を選択</div>
                    <div className="text-[11px] text-gray-400 mb-2">1資料＝横A4・1枚に要約して出力します。表紙に選択した資料の番号付き目次が付きます。</div>
                    <div className="flex flex-wrap gap-1.5 mb-3">
                      {PRINT_TABS.map(([v, l]) => { const on = printSel.includes(v); return (
                        <button key={v} onClick={() => togglePrintSel(v)}
                          className={`px-2.5 py-1 rounded-full text-xs border transition-colors ${on ? 'bg-[#1F3A5F] text-white border-[#1F3A5F]' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}>{on ? '✓ ' : ''}{l}</button>
                      ) })}
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <button onClick={() => setPrintSel(PRINT_TABS.map(([v]) => v))} className="text-[11px] text-[#1a73e8] hover:underline">全部選択</button>
                      <div className="flex gap-2">
                        <button onClick={() => doPrint(PRINT_TABS.map(([v]) => v))} className="px-3 py-1.5 text-xs bg-[#C8A24B] text-white rounded-lg font-bold hover:brightness-95">全部出力</button>
                        <button onClick={() => doPrint(orderedSel)} disabled={!orderedSel.length} className="px-3 py-1.5 text-xs bg-[#1F3A5F] text-white rounded-lg font-bold hover:brightness-110 disabled:opacity-40">選択を出力</button>
                      </div>
                    </div>
                  </div>
                )}
              </div>}
            </div>
          </div>

          {(fy || view === 'anken' || view === 'audit') && (
            <div className="space-y-5">
              {renderView(view)}
            </div>
          )}
        </div>
      )}

      {/* 期末年の確認ダイアログ（複数ファイルまとめて） */}
      {pending && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) (() => setPending(null))() }}>
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

// ============ 社長の1枚（意思決定ダッシュボード） ============
// 「3つの大きな数字」「信号機スコアカード」「ゲージ3本」「利益ブリッジ」「主要指標3期比較」「増えた経費トップ5」を
// A4一枚感覚でまとめる。数字は万円・億円の概数（詳細な円単位は各タブ・付録の表が担保）。
function Dashboard({ fy, prior, monthIdx, years, settings }: {
  fy: FiscalYearData; prior: FiscalYearData | null; monthIdx: number
  years: Record<string, FiscalYearData>; settings: KeieiSettings
}) {
  const monthLabel = `${fy.fiscalMonths[monthIdx]}月`
  const single = plKpisSingle(fy, monthIdx)
  const priorIdx = prior ? Math.min(monthIdx, prior.lastFilledIndex) : 0
  const pSingle = prior ? plKpisSingle(prior, priorIdx) : null
  const s = useMemo(() => safety(fy, monthIdx, settings), [fy, monthIdx, settings])
  const c = useMemo(() => cvp(fy, monthIdx, settings), [fy, monthIdx, settings])
  const labor = useMemo(() => laborShare(years, fy, monthIdx), [years, fy, monthIdx])
  const land = useMemo(() => landingScenarios(years, fy), [years, fy])
  const bridge = useMemo(() => profitBridge(fy, prior, monthIdx), [fy, prior, monthIdx])
  const budget = settings.budgets?.[fy.id]
  const issuesResult = useMemo(() => {
    try { return detectIssues({ years, fy, monthIdx, settings, yearId: fy.id, budget }) } catch { return null }
  }, [years, fy, monthIdx, settings, budget])

  const std = land.scenarios.find((x) => x.key === 'standard') || land.scenarios[0]
  const opBudgetFull = budget && budget.sales > 0 ? budget.sales * (budget.grossMargin / 100) - budget.sgna : null
  const priorFullOp = prior ? (getRow(prior, CODES.opProfit)?.annual ?? null) : null
  const landCompare = opBudgetFull != null
    ? { label: '予算比', diff: std.opProfit - opBudgetFull }
    : priorFullOp != null ? { label: '前期比', diff: std.opProfit - priorFullOp } : null

  // 増えた経費トップ5（販管費の明細を前年同期のYTDと比較）
  const sgnaUp = useMemo(() => {
    if (!prior) return []
    const preMap = new Map<string, number>()
    for (const a of detailsOf(prior, CODES.sgna)) preMap.set(a.name.trim(), rowYtd(a, priorIdx))
    return detailsOf(fy, CODES.sgna)
      .map((a) => { const cur = rowYtd(a, monthIdx); const pre = preMap.get(a.name.trim()) ?? 0; return { label: a.name.trim(), value: cur - pre, cur, pre } })
      .filter((x) => x.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, 5)
  }, [fy, prior, monthIdx, priorIdx])

  const opYoy = pSingle ? yoyInfo(single.opProfit, pSingle.opProfit) : null
  const bepRatio = c.sales > 0 && c.bep > 0 ? (c.bep / c.sales) * 100 : null

  const BigCard = ({ label, main, sub, tone }: { label: string; main: React.ReactNode; sub?: React.ReactNode; tone?: 'good' | 'bad' | null }) => (
    <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
      <div className="text-[13px] font-semibold text-gray-500 mb-1.5">{label}</div>
      <div className={`text-[34px] leading-none font-extrabold tabular-nums ${tone === 'bad' ? 'text-red-600' : 'text-gray-900'}`}>{main}</div>
      {sub && <div className="text-[12.5px] mt-2">{sub}</div>}
    </div>
  )
  const sevChip = (sev: 'danger' | 'warn' | 'good') =>
    sev === 'danger' ? 'bg-red-50 text-red-700 border-red-200' : sev === 'warn' ? 'bg-amber-50 text-amber-800 border-amber-200' : 'bg-green-50 text-green-700 border-green-200'
  const sevIcon = (sev: 'danger' | 'warn' | 'good') => (sev === 'danger' ? '🔴' : sev === 'warn' ? '🟡' : '🟢')

  return (
    <div className="bg-gradient-to-b from-[#f7f9fc] to-white rounded-2xl border border-gray-200 p-5 shadow-sm">
      <div className="flex items-baseline gap-3 mb-4">
        <h2 className="text-[16px] font-extrabold text-gray-900">社長の1枚</h2>
        <span className="text-xs text-gray-400">{fy.label} {monthLabel}時点 ／ 金額は概数（詳細は各タブの表）</span>
      </div>

      {/* ① 3つの大きな数字 */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
        <BigCard label={`今月の営業利益（${monthLabel}単月）`}
          main={fmtShort(single.opProfit)}
          tone={single.opProfit < 0 ? 'bad' : null}
          sub={opYoy ? (
            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-bold ${opYoy.tone === 'good' ? 'bg-green-100 text-green-700' : opYoy.tone === 'bad' ? 'bg-red-100 text-red-600' : 'bg-gray-100 text-gray-500'}`}>
              {opYoy.tone === 'good' ? '▲' : opYoy.tone === 'bad' ? '▼' : '－'} 前年同月比 {opYoy.label}
            </span>
          ) : <span className="text-gray-400">前年データなし</span>} />
        <BigCard label={land.partial ? '通期の着地見込み（営業利益・標準）' : '通期の営業利益（確定）'}
          main={fmtShort(std.opProfit)}
          tone={std.opProfit < 0 ? 'bad' : null}
          sub={landCompare ? (
            <span className={landCompare.diff >= 0 ? 'text-green-700 font-bold' : 'text-red-600 font-bold'}>
              {landCompare.label} {landCompare.diff >= 0 ? '＋' : '−'}{fmtShort(Math.abs(landCompare.diff))}
            </span>
          ) : <span className="text-gray-400">売上見込み {fmtShort(std.sales)}</span>} />
        <BigCard label="手元資金（現預金）"
          main={s.monthlySales > 0 ? `月商 ${s.liquidityMonths.toFixed(1)}か月分` : fmtShort(s.cash)}
          tone={s.monthlySales > 0 && s.liquidityMonths < 1 ? 'bad' : null}
          sub={<span className="text-gray-500">残高 {fmtShort(s.cash)}（目安：2〜3か月分）</span>} />
      </div>

      {/* ② 信号機スコアカード */}
      {issuesResult && issuesResult.issues.length > 0 && (
        <div className="mb-4">
          <div className="flex items-baseline gap-2 mb-2">
            <span className="text-[13px] font-bold text-gray-700">今月の信号</span>
            <span className="text-[12px] text-gray-500">
              🔴 {issuesResult.issues.filter((i) => i.severity === 'danger').length}　🟡 {issuesResult.issues.filter((i) => i.severity === 'warn').length}　🟢 {issuesResult.issues.filter((i) => i.severity === 'good').length}
              　<span className="text-gray-400">詳細は「経営課題」タブへ</span>
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {issuesResult.issues.map((i, n) => (
              <span key={n} className={`px-2.5 py-1 rounded-full border text-[12px] font-semibold ${sevChip(i.severity)}`}>{sevIcon(i.severity)} {i.category}</span>
            ))}
          </div>
        </div>
      )}

      {/* ③ ゲージ3本 */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-x-6 gap-y-1 mb-4 bg-white rounded-xl border border-gray-200 p-4">
        {bepRatio != null && (
          <Bullet title="損益分岐点比率" valueLabel={`${bepRatio.toFixed(0)}%`} value={Math.min(bepRatio, 120)} max={120}
            zones={[{ to: 75, color: '#bfe6c8', label: '安全(〜75%)' }, { to: 90, color: '#fbe8b6', label: '注意(〜90%)' }, { to: 120, color: '#f6c6c2', label: '危険(90%〜)' }]}
            subtitle="売上があと何%落ちたら赤字か（低いほど安全）" />
        )}
        {labor.share != null && (
          <Bullet title="労働分配率" valueLabel={`${labor.share.toFixed(0)}%`} value={Math.min(labor.share, 100)} max={100}
            zones={[{ to: 50, color: '#bfe6c8', label: '健全(〜50%)' }, { to: 60, color: '#e8f0d8', label: '' }, { to: 70, color: '#fbe8b6', label: '警戒(60〜70%)' }, { to: 100, color: '#f6c6c2', label: '危険(70%〜)' }]}
            subtitle="粗利のうち人件費が占める割合（外注費・派遣費は含まない）" />
        )}
        {s.monthlySales > 0 && (
          <Bullet title="手元資金の月商倍率" valueLabel={`${s.liquidityMonths.toFixed(1)}か月`} value={Math.min(s.liquidityMonths, 6)} max={6}
            zones={[{ to: 1, color: '#f6c6c2', label: '危険(〜1)' }, { to: 2, color: '#fbe8b6', label: '注意(〜2)' }, { to: 3, color: '#e8f0d8', label: '' }, { to: 6, color: '#bfe6c8', label: '安心(3〜)' }]}
            subtitle="現預金が月商の何か月分あるか（多いほど安心）" />
        )}
      </div>

      {/* ④ 利益ブリッジ（前年同期→当期） */}
      {bridge && (
        <div className="bg-white rounded-xl border border-gray-200 p-4 mb-4">
          <div className="flex items-baseline gap-2 mb-1">
            <span className="text-[13px] font-bold text-gray-700">なぜ利益が変わったか（前年同期 → 当期・期首〜{monthLabel}累計）</span>
            <span className="text-[11px] text-gray-400">緑＝利益を押し上げた要因／赤＝押し下げた要因</span>
          </div>
          <Waterfall startLabel="前年の営業利益" startValue={bridge.preOp} steps={bridge.steps} endLabel="当期の営業利益" endValue={bridge.curOp} />
        </div>
      )}

      {/* ⑤ 増えた経費トップ5 */}
      {sgnaUp.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <div className="flex items-baseline gap-2 mb-2">
            <span className="text-[13px] font-bold text-gray-700">前年より増えた経費トップ5（期首〜{monthLabel}累計）</span>
            <span className="text-[11px] text-gray-400">棒＝増加額。科目別の明細は「明細・経費」タブへ</span>
          </div>
          <HBars items={sgnaUp.map((x) => ({ label: x.label, value: x.value, sub: x.pre > 0 ? `+${(((x.cur - x.pre) / x.pre) * 100).toFixed(0)}%` : '新規' }))} color="#d97706" />
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
      <Dashboard fy={fy} prior={prior} monthIdx={monthIdx} years={years} settings={settings} />
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

