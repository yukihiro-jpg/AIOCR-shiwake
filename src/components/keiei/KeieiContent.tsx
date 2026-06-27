'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import GlobalNav from '@/core/ui/GlobalNav'
import { hasRoom, setRoomPassphrase } from '@/core/room'
import {
  loadSharedClients, type SharedClient,
  loadYears, saveYears, getSelectedClientId, setSelectedClientId,
} from '@/lib/keiei/store'
import { decodeCsv, parseMonthlyCsv, finalizeFiscalYear } from '@/lib/keiei/parse'
import type { FiscalYearData } from '@/lib/keiei/types'
import {
  CODES, getRow, plKpisSingle, plKpisYtd, ytd, singleMonth,
  sortedYears, findPriorYear, yoy,
} from '@/lib/keiei/calc'
import { fmtYen, fmtShort, fmtPct, fmtPctSigned } from '@/lib/keiei/format'
import { ComboBarLine, GroupedBars } from './charts'

export default function KeieiContent() {
  const [roomReady, setRoomReady] = useState(false)
  const [passInput, setPassInput] = useState('')
  const [clients, setClients] = useState<SharedClient[]>([])
  const [clientId, setClientId] = useState('')
  const [years, setYears] = useState<Record<string, FiscalYearData>>({})
  const [yearId, setYearId] = useState('')
  const [monthIdx, setMonthIdx] = useState(0)
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  // 期末年の確認ダイアログ
  const [pending, setPending] = useState<{ data: FiscalYearData; fileName: string } | null>(null)
  const [pendingYear, setPendingYear] = useState(0)

  useEffect(() => { setRoomReady(hasRoom()) }, [])

  // 顧問先リスト読み込み
  useEffect(() => {
    if (!roomReady) return
    loadSharedClients().then((cs) => {
      setClients(cs)
      const saved = getSelectedClientId()
      if (saved && cs.some((c) => c.id === saved)) setClientId(saved)
    }).catch(() => setClients([]))
  }, [roomReady])

  // 顧問先の年度データ読み込み
  useEffect(() => {
    if (!clientId) { setYears({}); return }
    setSelectedClientId(clientId)
    setLoading(true)
    loadYears(clientId).then((y) => {
      setYears(y)
      const sorted = sortedYears(y)
      const newest = sorted[sorted.length - 1]
      if (newest) { setYearId(newest.id); setMonthIdx(newest.lastFilledIndex) }
      else { setYearId(''); }
    }).finally(() => setLoading(false))
  }, [clientId])

  const fy = years[yearId]
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

  const handleFile = useCallback(async (file: File) => {
    setErr(null); setMsg(null)
    try {
      const buf = await file.arrayBuffer()
      const text = decodeCsv(buf)
      const data = parseMonthlyCsv(text)
      setPending({ data, fileName: file.name })
      setPendingYear(guessYear(file.name, data.endMonth))
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'CSVの解析に失敗しました')
    }
  }, [])

  const confirmYear = useCallback(async () => {
    if (!pending || !clientId) return
    const finalized = finalizeFiscalYear(pending.data, pendingYear)
    const next = { ...years, [finalized.id]: finalized }
    setYears(next)
    setYearId(finalized.id)
    setMonthIdx(finalized.lastFilledIndex)
    setPending(null)
    await saveYears(clientId, next)
    setMsg(`${finalized.label} を取り込みました（${finalized.lastFilledIndex + 1}ヶ月分）`)
  }, [pending, pendingYear, years, clientId])

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
      <div className="min-h-screen flex flex-col bg-gray-50">
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
    <div className="min-h-screen flex flex-col bg-gray-50">
      <GlobalNav currentKey="keiei" />

      {/* ヘッダ */}
      <div className="bg-white border-b border-gray-200 px-5 py-3 flex items-center gap-4 flex-wrap">
        <h1 className="text-lg font-bold text-gray-800">📈 月次レポート</h1>
        <select value={clientId} onChange={(e) => setClientId(e.target.value)}
          className="px-3 py-1.5 border border-gray-300 rounded text-sm min-w-[220px]">
          <option value="">顧問先を選択…</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{c.code ? `${c.code} ` : ''}{c.name}</option>)}
        </select>
        {clientId && (
          <label className="ml-auto px-3 py-1.5 bg-blue-600 text-white rounded text-sm font-medium hover:bg-blue-700 cursor-pointer">
            ＋ 月次推移CSVを取込
            <input type="file" accept=".csv" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = '' }} />
          </label>
        )}
      </div>

      {msg && <div className="px-5 py-2 bg-green-50 text-green-700 text-sm border-b border-green-100">{msg}</div>}
      {err && <div className="px-5 py-2 bg-red-50 text-red-700 text-sm border-b border-red-100">{err}</div>}

      {!clientId ? (
        <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">顧問先を選択してください</div>
      ) : loading ? (
        <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">読み込み中…</div>
      ) : sorted.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-gray-500 text-sm gap-2">
          <div className="text-4xl opacity-30">📈</div>
          会計大将の「月次推移 貸借対照表／損益計算書」CSVを3期分取り込んでください。
        </div>
      ) : (
        <div className="flex-1 overflow-auto p-5 space-y-5">
          {/* 期・月の選択＋取込済み一覧 */}
          <div className="bg-white rounded-xl border border-gray-200 p-4">
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
              {sorted.map((y) => (
                <span key={y.id} className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs border ${y.id === yearId ? 'bg-blue-50 border-blue-300 text-blue-700' : 'bg-gray-50 border-gray-200 text-gray-600'}`}>
                  {y.label}（{y.lastFilledIndex + 1}ヶ月）
                  <button onClick={() => deleteYear(y.id)} className="text-gray-400 hover:text-red-600 ml-1">✕</button>
                </span>
              ))}
            </div>
          </div>

          {fy && <Report fy={fy} prior={prior} comp={comp} monthIdx={monthIdx} />}
        </div>
      )}

      {/* 期末年の確認ダイアログ */}
      {pending && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setPending(null)}>
          <div className="bg-white rounded-xl shadow-xl p-5 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-bold text-gray-800 mb-1">取込内容の確認</h3>
            <p className="text-xs text-gray-500 mb-3 break-all">{pending.fileName}</p>
            <div className="text-sm text-gray-700 mb-2">決算期末月：<b>{pending.data.endMonth}月</b>（自動判定）</div>
            <label className="block text-xs text-gray-500 mb-1">期末の西暦年（決算期を確定します）</label>
            <input type="number" value={pendingYear} onChange={(e) => setPendingYear(Number(e.target.value))}
              className="w-full px-3 py-2 border border-gray-300 rounded text-sm mb-2" />
            <div className="text-sm text-blue-700 font-medium mb-4">
              → {pendingYear - 2018 >= 1 ? `令和${pendingYear - 2018}年` : `${pendingYear}年`}{pending.data.endMonth}月期
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setPending(null)} className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded">キャンセル</button>
              <button onClick={confirmYear} className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded font-medium hover:bg-blue-700">取込</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ============ レポート本体 ============
function Report({ fy, prior, comp, monthIdx }: {
  fy: FiscalYearData
  prior: FiscalYearData | null
  comp: FiscalYearData[]
  monthIdx: number
}) {
  const single = plKpisSingle(fy, monthIdx)
  const ytdK = plKpisYtd(fy, monthIdx)
  const pSingle = prior ? plKpisSingle(prior, monthIdx) : null
  const pYtd = prior ? plKpisYtd(prior, monthIdx) : null
  const monthLabel = `${fy.fiscalMonths[monthIdx]}月`

  // 推移グラフ用（単月、入力済み月まで）
  const upto = fy.lastFilledIndex + 1
  const monthLabels = fy.fiscalMonths.slice(0, upto).map((m) => `${m}月`)
  const salesRow = getRow(fy, CODES.sales)
  const opRow = getRow(fy, CODES.opProfit)
  const salesSeries = salesRow ? salesRow.monthly.slice(0, upto) : []
  const opSeries = opRow ? opRow.monthly.slice(0, upto) : []

  // 3期比較
  const metrics: { key: keyof typeof CODES; label: string }[] = [
    { key: 'sales', label: '売上高' },
    { key: 'grossProfit', label: '売上総利益' },
    { key: 'opProfit', label: '営業利益' },
    { key: 'ordProfit', label: '経常利益' },
  ]
  const compLabels = comp.map((y) => y.label)
  const sameMonthGroups = metrics.map((m) => ({
    label: m.label,
    values: comp.map((y) => singleMonth(y, CODES[m.key], monthIdx)),
  }))
  const ytdGroups = metrics.map((m) => ({
    label: m.label,
    values: comp.map((y) => ytd(y, CODES[m.key], monthIdx)),
  }))

  // BS要約
  const asset = singleMonth(fy, CODES.assetTotal, monthIdx)
  const netAsset = singleMonth(fy, CODES.netAsset, monthIdx)
  const cash = singleMonth(fy, CODES.cash, monthIdx)
  const equityRatio = asset ? (netAsset / asset) * 100 : 0

  return (
    <div className="space-y-5">
      {/* A. 単月サマリーカード */}
      <Section title={`${fy.label}　${monthLabel}（単月）の業績`} note={prior ? `（カッコ内は前年同月比）` : '（前年データがあると前年比を表示します）'}>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <KpiCard title="売上高" value={single.sales} yoy={pSingle ? yoy(single.sales, pSingle.sales) : null} />
          <KpiCard title="売上総利益(粗利)" value={single.grossProfit} margin={single.grossMargin} yoy={pSingle ? yoy(single.grossProfit, pSingle.grossProfit) : null} />
          <KpiCard title="営業利益" value={single.opProfit} margin={single.opMargin} yoy={pSingle ? yoy(single.opProfit, pSingle.opProfit) : null} />
          <KpiCard title="経常利益" value={single.ordProfit} margin={single.ordMargin} yoy={pSingle ? yoy(single.ordProfit, pSingle.ordProfit) : null} />
          <KpiCard title="当期純利益" value={single.netProfit} yoy={pSingle ? yoy(single.netProfit, pSingle.netProfit) : null} />
        </div>
      </Section>

      {/* B. 損益推移実績 */}
      <Section title="損益の推移実績（当期・月別）">
        <ComboBarLine labels={monthLabels} bars={salesSeries} barLabel="売上高（棒）" line={opSeries} lineLabel="営業利益（線）" />
      </Section>

      <div className="grid md:grid-cols-2 gap-5">
        {/* C. 3期同月比較 */}
        <Section title={`3期 同月比較（${monthLabel} 単月）`}>
          <GroupedBars groups={sameMonthGroups} seriesLabels={compLabels} />
        </Section>
        {/* D. 3期累計比較 */}
        <Section title={`3期 累計比較（期首〜${monthLabel}）`}>
          <GroupedBars groups={ytdGroups} seriesLabels={compLabels} />
        </Section>
      </div>

      {/* E. かみ砕いた試算表（PL） */}
      <Section title={`損益のまとめ（${monthLabel}単月 ／ 期首〜${monthLabel}累計）`}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-gray-50 text-gray-600 text-xs">
                <th className="text-left px-3 py-2 border-b">科目</th>
                <th className="text-right px-3 py-2 border-b">当月(単月)</th>
                <th className="text-right px-3 py-2 border-b">対売上比</th>
                <th className="text-right px-3 py-2 border-b">累計</th>
                <th className="text-right px-3 py-2 border-b">前年累計</th>
                <th className="text-right px-3 py-2 border-b">前年比</th>
              </tr>
            </thead>
            <tbody>
              <PlRow label="売上高" single={single.sales} ytd={ytdK.sales} sales={ytdK.sales} pYtd={pYtd?.sales} bold />
              <PlRow label="売上原価" single={single.cogs} ytd={ytdK.cogs} sales={ytdK.sales} pYtd={pYtd?.cogs} />
              <PlRow label="売上総利益（粗利）" single={single.grossProfit} ytd={ytdK.grossProfit} sales={ytdK.sales} pYtd={pYtd?.grossProfit} bold highlight />
              <PlRow label="販売費及び一般管理費" single={single.sgna} ytd={ytdK.sgna} sales={ytdK.sales} pYtd={pYtd?.sgna} />
              <PlRow label="営業利益" single={single.opProfit} ytd={ytdK.opProfit} sales={ytdK.sales} pYtd={pYtd?.opProfit} bold highlight />
              <PlRow label="経常利益" single={single.ordProfit} ytd={ytdK.ordProfit} sales={ytdK.sales} pYtd={pYtd?.ordProfit} bold highlight />
              <PlRow label="当期純利益" single={single.netProfit} ytd={ytdK.netProfit} sales={ytdK.sales} pYtd={pYtd?.netProfit} bold />
            </tbody>
          </table>
        </div>
      </Section>

      {/* F. BS要約 */}
      <Section title={`財政状態のまとめ（${monthLabel}末残高）`}>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <MiniStat label="総資産" value={asset} />
          <MiniStat label="純資産（自己資本）" value={netAsset} />
          <MiniStat label="自己資本比率" text={fmtPct(equityRatio)} good={equityRatio >= 30} />
          <MiniStat label="現金及び預金" value={cash} />
        </div>
      </Section>
    </div>
  )
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <div className="flex items-baseline gap-2 mb-3">
        <h2 className="text-sm font-bold text-gray-800">{title}</h2>
        {note && <span className="text-xs text-gray-400">{note}</span>}
      </div>
      {children}
    </div>
  )
}

function KpiCard({ title, value, margin, yoy }: { title: string; value: number; margin?: number; yoy: number | null }) {
  const neg = value < 0
  return (
    <div className={`rounded-lg border p-3 ${neg ? 'border-red-200 bg-red-50' : 'border-gray-200 bg-gray-50'}`}>
      <div className="text-xs text-gray-500 mb-1 truncate">{title}</div>
      <div className={`text-lg font-bold ${neg ? 'text-red-600' : 'text-gray-800'}`}>{fmtShort(value)}</div>
      <div className="text-[11px] text-gray-400">{fmtYen(value)}</div>
      <div className="mt-1 flex items-center gap-2 text-xs">
        {margin != null && <span className="text-gray-500">率 {fmtPct(margin)}</span>}
        {yoy != null && <span className={yoy >= 0 ? 'text-green-600' : 'text-red-500'}>{fmtPctSigned(yoy)}</span>}
      </div>
    </div>
  )
}

function PlRow({ label, single, ytd, sales, pYtd, bold, highlight }: {
  label: string; single: number; ytd: number; sales: number; pYtd?: number; bold?: boolean; highlight?: boolean
}) {
  const ratio = sales ? (ytd / sales) * 100 : 0
  const yy = pYtd != null && pYtd !== 0 ? ((ytd - pYtd) / Math.abs(pYtd)) * 100 : null
  return (
    <tr className={`${highlight ? 'bg-blue-50/40' : ''} border-b border-gray-100`}>
      <td className={`px-3 py-1.5 ${bold ? 'font-bold text-gray-800' : 'text-gray-700'}`}>{label}</td>
      <td className="px-3 py-1.5 text-right tabular-nums">{fmtYen(single)}</td>
      <td className="px-3 py-1.5 text-right text-gray-500">{fmtPct(ratio)}</td>
      <td className={`px-3 py-1.5 text-right tabular-nums ${bold ? 'font-bold' : ''}`}>{fmtYen(ytd)}</td>
      <td className="px-3 py-1.5 text-right tabular-nums text-gray-500">{pYtd != null ? fmtYen(pYtd) : '—'}</td>
      <td className={`px-3 py-1.5 text-right ${yy == null ? 'text-gray-400' : yy >= 0 ? 'text-green-600' : 'text-red-500'}`}>{fmtPctSigned(yy)}</td>
    </tr>
  )
}

function MiniStat({ label, value, text, good }: { label: string; value?: number; text?: string; good?: boolean }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className={`text-base font-bold ${good == null ? 'text-gray-800' : good ? 'text-green-600' : 'text-amber-600'}`}>
        {text != null ? text : fmtShort(value || 0)}
      </div>
      {text == null && <div className="text-[11px] text-gray-400">{fmtYen(value || 0)}</div>}
    </div>
  )
}
