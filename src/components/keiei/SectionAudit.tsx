'use client'

// 会計監査: 直近2期＋進行期の総勘定元帳CSVを蓄積し、対象期・対象月を選んで
// 過去実績と突合。税務的に修正すべき可能性のある取引を別ウィンドウに一覧表示する。
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FiscalYearData } from '@/lib/keiei/types'
import { decodeCsv } from '@/lib/keiei/parse'
import { type LedgerData, parseLedgerCsv, findMatchingFy } from '@/lib/keiei/ledger'
import { saveLedger, deleteLedger, listLedgers } from '@/lib/keiei/ledger-store'
import { auditMonth, buildAuditReportHtml, type AuditResult } from '@/lib/keiei/audit'

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

export default function SectionAudit({
  clientId,
  years,
  company,
}: {
  clientId: string
  years: Record<string, FiscalYearData>
  company: string
}) {
  const [ledgers, setLedgers] = useState<{ yearId: string; data: LedgerData }[]>([])
  const [loaded, setLoaded] = useState(false)
  const [targetId, setTargetId] = useState('')
  const [targetYm, setTargetYm] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [lastResult, setLastResult] = useState<AuditResult | null>(null)

  const refresh = useCallback(async () => {
    try {
      const list = await listLedgers(clientId)
      setLedgers(list)
      // 対象期の初期値＝最新の元帳
      if (list.length && !list.some((x) => x.yearId === targetId)) {
        setTargetId(list[list.length - 1].yearId)
      }
    } catch { setLedgers([]) }
  }, [clientId, targetId])

  useEffect(() => {
    setLoaded(false)
    setLastResult(null)
    refresh().finally(() => setLoaded(true))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId])

  const ledgerLabel = useCallback((yearId: string, data: LedgerData) => {
    const fy = years[yearId]
    if (fy) return fy.label
    return `${data.minDate?.replace(/-/g, '/')} 〜 ${data.maxDate?.replace(/-/g, '/')}`
  }, [years])

  const handleFiles = useCallback(async (files: FileList) => {
    const list = Array.from(files)
    setErr(''); setMsg('')
    setBusy(true)
    const ok: string[] = []
    const bad: string[] = []
    try {
      for (const f of list) {
        try {
          const data = parseLedgerCsv(decodeCsv(await f.arrayBuffer()), f.name)
          if (!data.txCount) { bad.push(`${f.name}: 元帳データを読み取れませんでした`); continue }
          // 試算表がある期はその期IDに、無い期（過去期など）は日付範囲から擬似IDで保存
          const fy = findMatchingFy(data, years)
          const yearId = fy ? fy.id : `raw-${(data.minDate || '').slice(0, 7)}_${(data.maxDate || '').slice(0, 7)}`
          await saveLedger(clientId, yearId, data)
          ok.push(`${fy ? fy.label : `${data.minDate}〜${data.maxDate}`}（${data.txCount.toLocaleString()}件）`)
        } catch (e) {
          bad.push(`${f.name}: ${e instanceof Error ? e.message : '取込失敗'}`)
        }
      }
      await refresh()
      if (ok.length) setMsg(`元帳を取り込みました: ${ok.join('、')}。この端末にのみ保存されます。`)
      if (bad.length) setErr(bad.join(' / '))
    } finally { setBusy(false) }
  }, [clientId, years, refresh])

  const removeOne = useCallback(async (yearId: string, data: LedgerData) => {
    if (!window.confirm(`${ledgerLabel(yearId, data)} の元帳をこの端末から削除しますか？（CSVを再取込すれば復元できます）`)) return
    await deleteLedger(clientId, yearId)
    await refresh()
  }, [clientId, refresh, ledgerLabel])

  const target = ledgers.find((x) => x.yearId === targetId) || null

  // 対象月の候補＝対象元帳に取引がある月（新しい順）
  const ymOptions = useMemo(() => {
    if (!target) return []
    const set = new Set<string>()
    for (const acc of target.data.accounts) for (const tx of acc.txs) set.add(tx.date.slice(0, 7))
    return Array.from(set).sort().reverse()
  }, [target])
  useEffect(() => {
    if (ymOptions.length && !ymOptions.includes(targetYm)) setTargetYm(ymOptions[0])
  }, [ymOptions, targetYm])

  const runAudit = useCallback(() => {
    if (!target || !targetYm) return
    setErr(''); setMsg('')
    setBusy(true)
    try {
      const history = ledgers.filter((x) => x.yearId !== target.yearId).map((x) => x.data)
      const result = auditMonth(target.data, targetYm, history)
      setLastResult(result)
      const html = buildAuditReportHtml(result, company)
      const w = window.open('', '_blank')
      if (!w) {
        setErr('ポップアップがブロックされました。ブラウザの設定で許可してから、もう一度「解析開始」を押してください。')
        return
      }
      w.document.open(); w.document.write(html); w.document.close()
      setMsg(`解析が完了しました: 検出 ${result.findings.length}件（別ウィンドウに表示）`)
    } catch (e) {
      setErr('解析に失敗しました: ' + (e instanceof Error ? e.message : String(e)))
    } finally { setBusy(false) }
  }, [target, targetYm, ledgers, company])

  if (!loaded) return <div className="text-sm text-gray-400 py-8 text-center">読み込み中…</div>

  return (
    <div className="space-y-5">
      <Section title="会計監査 — 元帳データの登録" note="直近2期分と進行期の総勘定元帳CSVを取り込みます（期は日付から自動判定）">
        <div className="flex items-center gap-3 flex-wrap mb-2">
          <label className="px-4 py-2 bg-[#1a73e8] text-white rounded-full text-sm font-semibold hover:bg-[#1765cc] cursor-pointer shadow-sm">
            ＋ 総勘定元帳CSVを取込（複数可）
            <input type="file" accept=".csv,.txt" multiple className="hidden"
              onChange={(e) => { if (e.target.files?.length) handleFiles(e.target.files); e.target.value = '' }} />
          </label>
          <span className="text-[11px] text-gray-400">
            過去期の試算表が未取込でも登録できます。データはこの端末にのみ保存（元帳分析タブと共用）。
          </span>
        </div>
        {ledgers.length === 0 ? (
          <div className="text-sm text-gray-400 py-4 text-center">まだ元帳がありません。進行期＋直近2期分のCSVを取り込んでください。</div>
        ) : (
          <div className="space-y-1.5">
            {ledgers.map(({ yearId, data }) => (
              <div key={yearId} className="flex items-center gap-3 text-xs bg-gray-50 rounded-lg px-3 py-2">
                <span className="font-bold text-gray-700">{ledgerLabel(yearId, data)}</span>
                <span className="text-gray-500">{data.fileName}</span>
                <span className="text-gray-400">{data.minDate?.replace(/-/g, '/')} 〜 {data.maxDate?.replace(/-/g, '/')}・{data.txCount.toLocaleString()}件</span>
                <button onClick={() => removeOne(yearId, data)} className="ml-auto text-gray-300 hover:text-red-500" title="削除">✕</button>
              </div>
            ))}
          </div>
        )}
        {msg && <div className="mt-2 px-3 py-2 bg-green-50 text-green-700 text-xs rounded-lg">{msg}</div>}
        {err && <div className="mt-2 px-3 py-2 bg-red-50 text-red-700 text-xs rounded-lg">{err}</div>}
      </Section>

      <Section title="解析の実行" note="対象月の取引を、それ以前の全実績（過去期＋進行期の過去月）と突合します">
        <div className="flex items-end gap-3 flex-wrap">
          <label className="text-xs text-gray-500">
            対象期
            <select value={targetId} onChange={(e) => { setTargetId(e.target.value); setTargetYm('') }}
              className="block mt-1 px-3 py-2 border border-gray-300 rounded text-sm min-w-[220px]">
              {ledgers.map(({ yearId, data }) => (
                <option key={yearId} value={yearId}>{ledgerLabel(yearId, data)}</option>
              ))}
            </select>
          </label>
          <label className="text-xs text-gray-500">
            対象月
            <select value={targetYm} onChange={(e) => setTargetYm(e.target.value)}
              className="block mt-1 px-3 py-2 border border-gray-300 rounded text-sm">
              {ymOptions.map((ym) => {
                const [y, m] = ym.split('-')
                return <option key={ym} value={ym}>{y}年{Number(m)}月</option>
              })}
            </select>
          </label>
          <button
            onClick={runAudit}
            disabled={busy || !target || !targetYm || ledgers.length === 0}
            className="px-5 py-2.5 rounded-lg bg-[#1F3A5F] text-white text-sm font-bold hover:brightness-110 disabled:opacity-40"
          >
            {busy ? '解析中…' : '🔍 解析開始（別ウィンドウに表示）'}
          </button>
          {ledgers.length === 1 && (
            <span className="text-[11px] text-amber-700 bg-amber-50 rounded px-2 py-1.5">
              ⚠ 元帳が1冊だけです。過去期の元帳も取り込むと、比較の精度が上がります（進行期内の過去月だけでも解析は可能）。
            </span>
          )}
        </div>
        {lastResult && (
          <div className="mt-3 text-xs text-gray-600 bg-gray-50 rounded-lg px-3 py-2">
            直近の解析: {lastResult.targetLabel} — 対象 {lastResult.targetCount.toLocaleString()}取引 ／ 比較 {lastResult.historyDesc} ／
            検出 <b className={lastResult.findings.length ? 'text-red-600' : 'text-green-600'}>{lastResult.findings.length}件</b>
          </div>
        )}
        <div className="text-[11px] text-gray-400 mt-3 leading-relaxed">
          判定内容: ①同一科目×同一摘要の<b>税区分の逸脱</b>
          ②<b>源泉徴収の処理漏れ</b>（過去に預り金仕訳を伴った支払い）
          ③<b>補助金・保険金等の課税誤り</b>（原則不課税の入金が課税処理）
          ④同一摘要の<b>計上科目の相違</b>
          ⑤<b>科目全体の税区分実績からの逸脱</b>（初出の取引にも適用）
          ⑥消耗品費・修繕費等への<b>10万円以上／40万円以上の支出</b>（資産計上の確認）
          ⑦<b>毎月定額支払の計上漏れ・二重計上</b>
          ⑧<b>役員報酬の定期同額</b>チェック
          ⑩<b>現金残高のマイナス</b>検出
          ⑪<b>免税事業者等取引（インボイス経過措置）の一貫性</b>。
          すべてブラウザ内の機械判定で、外部・AIには送信されません。
        </div>
      </Section>
    </div>
  )
}
