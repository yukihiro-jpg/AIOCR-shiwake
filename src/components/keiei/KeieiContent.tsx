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
import { saveSettings, subscribeSettings } from '@/lib/keiei/store'
import { defaultSettings, cvp, safety, profitBridge, landingScenarios, detailsOf, rowYtd, type KeieiSettings } from '@/lib/keiei/analysis'
import KrShell from '@/components/keiei/kr/KrShell'
import { parseLedgerCsv, findMatchingFy } from '@/lib/keiei/ledger'
import { saveLedger, deleteLedger } from '@/lib/keiei/ledger-store'
import { buildKeieiExport, keieiExportFileName, keieiExportJson } from '@/lib/keiei/export-data'

// 画面は移植した月次レポート・ビューア1つ（旧タブは 2026-09 に廃止し、顧問先用アプリと同じ画面へ統一）

export default function KeieiContent() {
  const [roomReady, setRoomReady] = useState(false)
  const [passInput, setPassInput] = useState('')
  const [clients, setClients] = useState<KeieiClient[]>([])
  const [clientId, setClientId] = useState('')
  const [years, setYears] = useState<Record<string, FiscalYearData>>({})
  const [yearId, setYearId] = useState('')
  const [monthIdx, setMonthIdx] = useState(0)
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

  const prior = useMemo(() => (fy ? findPriorYear(years, fy) : null), [years, fy])
  const sorted = useMemo(() => sortedYears(years), [years])

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
      setMsg(`総勘定元帳を取り込みました: ${okMsgs.join('、')}（この端末にのみ保存）。取引先ごとの集計や税務チェックの会計監査で使えます。`)
      setLedgerReload((n) => n + 1)
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

  // 取り込んだ試算表データ（取込済みの全期）を1つのJSONファイルとして書き出す。
  // 顧問先へ渡して別アプリに読み込ませる想定。再計算はせず保存内容をそのまま出す。
  const exportJson = useCallback(() => {
    const list = sortedYears(years)
    if (!list.length) return
    const client = { code: current?.code || '', name: current?.name || '' }
    const file = buildKeieiExport(client, years)
    const blob = new Blob([keieiExportJson(file)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = keieiExportFileName(client)
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
    setMsg(`取込データ（${list.length}期）をJSONファイルで書き出しました。`)
  }, [years, current])

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
              <button
                onClick={exportJson}
                title="取り込んだ全期の月次推移BS/PLを1つのJSONファイルで保存します（顧問先へ渡して別アプリで読み込む用）"
                className="ml-auto px-3 py-1 text-xs border border-[#1a73e8] text-[#1a73e8] rounded-full hover:bg-[#e8f0fe] whitespace-nowrap"
              >
                📤 取込データを書き出し（JSON・{sorted.length}期）
              </button>
            </div>
            </>)}
          </div>

          {/* 画面は移植した月次レポート・ビューア（顧問先用アプリと同じもの）に一本化した */}
          <div className="space-y-5">
            <KrShell
              clientId={clientId}
              years={years}
              settings={settings}
              monthIdx={monthIdx}
              clientName={current?.name || ''}
              clientCode={current?.code}
              onDataChanged={() => { loadYears(clientId).then(setYears).catch(() => { /* 失敗時は次の操作で再取得 */ }) }}
            />
          </div>
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

