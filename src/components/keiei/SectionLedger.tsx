'use client'

// 元帳分析: 総勘定元帳CSVを取り込み、A:科目ドリルダウン / B:特記取引 /
// C:毎月定額の固定費 / D:現預金の日次残高 / E:取引先別売上 を表示する。
// 元帳データはIndexedDB（端末ローカル・同期しない）に保存する。
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FiscalYearData } from '@/lib/keiei/types'
import { decodeCsv } from '@/lib/keiei/parse'
import {
  type LedgerData, parseLedgerCsv, ledgerMatchesFy, fyPeriod, detectTaxMode,
  ledgerMonthlyAmounts, isPlAccount, isRevenueAccount,
  notableTxs, recurringPayments, dailyCashSeries, customerSales,
} from '@/lib/keiei/ledger'
import { saveLedger, loadLedger, deleteLedger } from '@/lib/keiei/ledger-store'
import { fmtYen, fmtShort } from '@/lib/keiei/format'

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

const fmtDateShort = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`

export default function SectionLedger({
  clientId,
  fy,
  monthIdx,
}: {
  clientId: string
  fy: FiscalYearData
  monthIdx: number
}) {
  const [ledger, setLedger] = useState<LedgerData | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [accCode, setAccCode] = useState('')
  const [ddMonthIdx, setDdMonthIdx] = useState(monthIdx)

  useEffect(() => { setDdMonthIdx(monthIdx) }, [monthIdx])

  useEffect(() => {
    let alive = true
    setLoaded(false)
    setLedger(null)
    loadLedger(clientId, fy.id)
      .then((d) => { if (alive) setLedger(d) })
      .catch(() => { /* IndexedDB不可の環境では未取込扱い */ })
      .finally(() => { if (alive) setLoaded(true) })
    return () => { alive = false }
  }, [clientId, fy.id])

  const handleFile = useCallback(async (files: FileList) => {
    const list = Array.from(files)
    setErr(''); setMsg('')
    try {
      const f = list[0]
      if (!f) return
      const data = parseLedgerCsv(decodeCsv(await f.arrayBuffer()), f.name)
      if (!data.accounts.length || !data.txCount) {
        setErr('元帳データを読み取れませんでした。会計大将の「総勘定元帳」CSVか確認してください。')
        return
      }
      if (!ledgerMatchesFy(data, fy)) {
        const p = fyPeriod(fy)
        setErr(`この元帳の期間（${data.minDate} 〜 ${data.maxDate}）が、選択中の対象期（${p.start} 〜 ${p.end}）と合いません。上の「対象期」を該当する期に切り替えてから取り込んでください。`)
        return
      }
      await saveLedger(clientId, fy.id, data)
      setLedger(data)
      setMsg(`${fy.label} の元帳を取り込みました（${data.accounts.length}科目・${data.txCount.toLocaleString()}件）。この端末にのみ保存されます。`)
    } catch (e) {
      setErr('取込に失敗しました: ' + (e instanceof Error ? e.message : String(e)))
    }
  }, [clientId, fy])

  const removeLedger = useCallback(async () => {
    if (!window.confirm(`${fy.label} の元帳データをこの端末から削除しますか？（CSVを再取込すれば復元できます）`)) return
    await deleteLedger(clientId, fy.id)
    setLedger(null)
    setMsg('削除しました。')
  }, [clientId, fy])

  // ---- 分析（元帳があるときのみ） ----
  const taxMode = useMemo(() => (ledger ? detectTaxMode(ledger, fy) : 'unknown'), [ledger, fy])
  const plAccounts = useMemo(
    () => (ledger ? ledger.accounts.filter((a) => isPlAccount(a.code)).sort((a, b) => Number(a.code) - Number(b.code)) : []),
    [ledger],
  )
  useEffect(() => {
    if (plAccounts.length && !plAccounts.some((a) => a.code === accCode)) setAccCode(plAccounts[0].code)
  }, [plAccounts, accCode])

  const notable = useMemo(() => (ledger ? notableTxs(ledger, fy, monthIdx) : []), [ledger, fy, monthIdx])
  const recurring = useMemo(() => (ledger ? recurringPayments(ledger, fy) : []), [ledger, fy])
  const cash = useMemo(() => (ledger ? dailyCashSeries(ledger) : { points: [], accounts: [] }), [ledger])
  const customers = useMemo(() => (ledger ? customerSales(ledger, fy, monthIdx) : { list: [], walkIn: 0, total: 0 }), [ledger, fy, monthIdx])

  // ドリルダウン対象
  const ddAccount = plAccounts.find((a) => a.code === accCode) || null
  const ddMonth = fy.fiscalMonths[ddMonthIdx]
  const ddTxs = useMemo(() => {
    if (!ddAccount) return []
    return ddAccount.txs.filter((t) => t.month === ddMonth).sort((a, b) => a.date.localeCompare(b.date))
  }, [ddAccount, ddMonth])
  const ddIsRevenue = ddAccount ? isRevenueAccount(ddAccount.code) : false
  const ddTotal = ddTxs.reduce((s, t) => s + (ddIsRevenue ? t.credit - t.debit : t.debit - t.credit), 0)
  const ddTrialRow = ddAccount ? fy.rows.find((r) => r.code === ddAccount.code) : null
  const ddTrial = ddTrialRow ? ddTrialRow.monthly[ddMonthIdx] || 0 : null
  const ddMonthly = useMemo(() => (ddAccount ? ledgerMonthlyAmounts(ddAccount, fy, ddIsRevenue) : []), [ddAccount, fy, ddIsRevenue])

  if (!loaded) return <div className="text-sm text-gray-400 py-8 text-center">読み込み中…</div>

  return (
    <div className="space-y-5">
      <Section title={`元帳分析（${fy.label}）`} note="総勘定元帳CSVで、増減の中身・特記取引・固定費・日次資金繰り・取引先別売上を見える化">
        <div className="flex items-center gap-3 flex-wrap mb-2">
          <label className="px-4 py-2 bg-[#1a73e8] text-white rounded-full text-sm font-semibold hover:bg-[#1765cc] cursor-pointer shadow-sm">
            ＋ 総勘定元帳CSVを取込（{fy.label}）
            <input type="file" accept=".csv,.txt" className="hidden"
              onChange={(e) => { if (e.target.files?.length) handleFile(e.target.files); e.target.value = '' }} />
          </label>
          {ledger && (
            <>
              <span className="text-xs text-gray-500">
                取込済み: <b>{ledger.fileName}</b>（{ledger.minDate} 〜 {ledger.maxDate}・{ledger.txCount.toLocaleString()}件）
              </span>
              <button onClick={removeLedger} className="text-xs text-gray-400 hover:text-red-600 underline">削除</button>
            </>
          )}
        </div>
        <div className="text-[11px] text-gray-400 leading-relaxed">
          会計大将の総勘定元帳CSV（<b>取引ごと税抜タイプ推奨</b>）。データ量が大きいため<b>この端末にのみ保存</b>され、他のPCと同期しません（各PCで取込してください）。
        </div>
        {ledger && taxMode === 'inclusive' && (
          <div className="mt-2 px-3 py-2 bg-amber-50 text-amber-800 text-xs rounded-lg">
            ⚠ この元帳は<b>税込タイプ</b>（月末一括税抜）とみられます。明細の金額は税込のため、試算表（税抜）と消費税分の差が出ます。可能であれば「取引ごと税抜」タイプでの出力をおすすめします。
          </div>
        )}
        {msg && <div className="mt-2 px-3 py-2 bg-green-50 text-green-700 text-xs rounded-lg">{msg}</div>}
        {err && <div className="mt-2 px-3 py-2 bg-red-50 text-red-700 text-xs rounded-lg">{err}</div>}
      </Section>

      {!ledger ? (
        <div className="text-sm text-gray-400 text-center py-10">
          まだ元帳がありません。会計大将から「総勘定元帳」をCSV出力して取り込んでください。
        </div>
      ) : (
        <>
          {/* A: 科目ドリルダウン */}
          <Section title="科目の明細（ドリルダウン）" note="「この費用、何に使った？」に取引単位で答えます">
            <div className="flex items-center gap-2 flex-wrap mb-3">
              <select value={accCode} onChange={(e) => setAccCode(e.target.value)} className="px-3 py-1.5 border border-gray-300 rounded text-sm">
                {plAccounts.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
              </select>
              <select value={ddMonthIdx} onChange={(e) => setDdMonthIdx(Number(e.target.value))} className="px-3 py-1.5 border border-gray-300 rounded text-sm">
                {fy.fiscalMonths.slice(0, fy.lastFilledIndex + 1).map((m, i) => <option key={i} value={i}>{m}月</option>)}
              </select>
              {ddAccount && (
                <span className="text-xs text-gray-500 ml-1">
                  月合計 <b className="tabular-nums">{fmtYen(ddTotal)}</b>
                  {ddTrial != null && (
                    Math.abs(ddTrial - ddTotal) <= Math.max(1, Math.abs(ddTrial) * 0.005)
                      ? <span className="text-green-600 ml-1">✓ 試算表と一致</span>
                      : <span className="text-amber-600 ml-1">（試算表 {fmtYen(ddTrial)}・差 {fmtShort(ddTotal - ddTrial)}{taxMode === 'inclusive' ? '＝消費税分とみられます' : ''}）</span>
                  )}
                </span>
              )}
            </div>
            {/* 月次ミニバー: どの月が多いか */}
            {ddAccount && (
              <div className="flex items-end gap-1 h-12 mb-3">
                {fy.fiscalMonths.map((m, i) => {
                  const v = ddMonthly[i] || 0
                  const max = Math.max(...ddMonthly.map(Math.abs), 1)
                  return (
                    <button key={i} onClick={() => setDdMonthIdx(i)} title={`${m}月 ${fmtYen(v)}`}
                      className="flex-1 flex flex-col items-center gap-0.5" disabled={i > fy.lastFilledIndex}>
                      <div className={`w-full rounded-t ${i === ddMonthIdx ? 'bg-[#1a73e8]' : i > fy.lastFilledIndex ? 'bg-gray-100' : 'bg-[#c3cdd9] hover:bg-[#7d93b2]'}`}
                        style={{ height: `${Math.max(2, (Math.abs(v) / max) * 36)}px` }} />
                      <span className={`text-[9px] ${i === ddMonthIdx ? 'text-[#1a73e8] font-bold' : 'text-gray-400'}`}>{m}</span>
                    </button>
                  )
                })}
              </div>
            )}
            <div className="overflow-x-auto max-h-96 overflow-y-auto border border-gray-100 rounded-lg">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-gray-50">
                  <tr className="text-gray-500">
                    <th className="text-left px-2 py-1.5 font-medium w-14">日付</th>
                    <th className="text-left px-2 py-1.5 font-medium">相手科目</th>
                    <th className="text-left px-2 py-1.5 font-medium">摘要</th>
                    <th className="text-right px-2 py-1.5 font-medium w-24">{ddIsRevenue ? '売上(貸方)' : '金額(借方)'}</th>
                    <th className="text-right px-2 py-1.5 font-medium w-24">{ddIsRevenue ? '(借方)' : '(貸方)'}</th>
                  </tr>
                </thead>
                <tbody>
                  {ddTxs.length === 0 ? (
                    <tr><td colSpan={5} className="text-center text-gray-400 py-6">この月の取引はありません</td></tr>
                  ) : ddTxs.map((t, i) => (
                    <tr key={i} className="border-t border-gray-50">
                      <td className="px-2 py-1 whitespace-nowrap text-gray-600">{fmtDateShort(t.date)}</td>
                      <td className="px-2 py-1 whitespace-nowrap text-gray-500">{t.counterName}</td>
                      <td className="px-2 py-1 text-gray-800">{t.memo || <span className="text-gray-300">—</span>}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{(ddIsRevenue ? t.credit : t.debit) ? fmtYen(ddIsRevenue ? t.credit : t.debit) : ''}</td>
                      <td className="px-2 py-1 text-right tabular-nums text-gray-400">{(ddIsRevenue ? t.debit : t.credit) ? fmtYen(ddIsRevenue ? t.debit : t.credit) : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          {/* B: 特記取引 */}
          <Section title={`今月の特記取引（${fy.fiscalMonths[monthIdx]}月）`} note="大口・重複疑い・ふだん動かない科目を自動抽出（月次チェックの補助）">
            {notable.length === 0 ? (
              <div className="text-sm text-gray-400 py-4 text-center">特記事項はありません。</div>
            ) : (
              <div className="space-y-1.5">
                {notable.map((n, i) => (
                  <div key={i} className={`flex items-start gap-2 text-xs rounded-lg px-3 py-2 ${n.kind === 'dup' ? 'bg-red-50' : n.kind === 'large' ? 'bg-amber-50' : 'bg-sky-50'}`}>
                    <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-bold text-white ${n.kind === 'dup' ? 'bg-red-500' : n.kind === 'large' ? 'bg-amber-500' : 'bg-sky-500'}`}>
                      {n.kind === 'dup' ? '重複?' : n.kind === 'large' ? '大口' : 'まれ'}
                    </span>
                    <span className="flex-1">
                      <b>{fmtDateShort(n.tx.date)}</b> {n.account}「{n.tx.memo || '（摘要なし）'}」
                      <b className="tabular-nums ml-1">{fmtYen(Math.max(n.tx.debit, n.tx.credit))}</b>
                      <span className="block text-gray-500 mt-0.5">{n.note}</span>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Section>

          {/* C: 毎月定額 */}
          <Section title="毎月定額の支払い（固定費の棚卸し）" note="ほぼ同額で毎月続く支払いを自動抽出。見直し・解約候補の検討に">
            {recurring.length === 0 ? (
              <div className="text-sm text-gray-400 py-4 text-center">
                毎月定額のパターンは見つかりませんでした（摘要の記載が少ない場合は検出できません）。
              </div>
            ) : (
              <>
                <div className="text-xs text-gray-600 mb-2">
                  検出 {recurring.length}件・合計 <b className="tabular-nums">{fmtYen(recurring.reduce((s, r) => s + r.monthlyAmount, 0))}／月</b>
                  （年間換算 <b className="tabular-nums">{fmtShort(recurring.reduce((s, r) => s + r.annual, 0))}</b>）
                </div>
                <div className="overflow-x-auto max-h-80 overflow-y-auto border border-gray-100 rounded-lg">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-gray-50">
                      <tr className="text-gray-500">
                        <th className="text-left px-2 py-1.5 font-medium">科目</th>
                        <th className="text-left px-2 py-1.5 font-medium">摘要（支払先）</th>
                        <th className="text-right px-2 py-1.5 font-medium">月額（平均）</th>
                        <th className="text-center px-2 py-1.5 font-medium">出現月数</th>
                        <th className="text-right px-2 py-1.5 font-medium">年間換算</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recurring.map((r, i) => (
                        <tr key={i} className="border-t border-gray-50">
                          <td className="px-2 py-1 text-gray-600 whitespace-nowrap">{r.account}</td>
                          <td className="px-2 py-1 text-gray-800">{r.memo}</td>
                          <td className="px-2 py-1 text-right tabular-nums font-medium">{fmtYen(r.monthlyAmount)}</td>
                          <td className="px-2 py-1 text-center text-gray-500">{r.months}ヶ月</td>
                          <td className="px-2 py-1 text-right tabular-nums text-gray-600">{fmtYen(r.annual)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </Section>

          {/* D: 現預金の日次残高 */}
          <Section title="現預金の日次残高（月中の資金の谷）" note="月末残高だけでは見えない、月の途中の資金の動き">
            {cash.points.length === 0 ? (
              <div className="text-sm text-gray-400 py-4 text-center">現金・預金科目が見つかりませんでした。</div>
            ) : (
              <DailyCashChart points={cash.points} accounts={cash.accounts} />
            )}
          </Section>

          {/* E: 取引先別売上 */}
          <Section title={`取引先別の売上（期首〜${fy.fiscalMonths[monthIdx]}月 累計）`} note="掛売の摘要から集計。店頭売上（日計）は一括表示。摘要の記載精度に依存します">
            {customers.total === 0 ? (
              <div className="text-sm text-gray-400 py-4 text-center">売上科目の取引が見つかりませんでした。</div>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-gray-500 bg-gray-50">
                        <th className="text-left px-2 py-1.5 font-medium w-8">#</th>
                        <th className="text-left px-2 py-1.5 font-medium">取引先（摘要）</th>
                        <th className="text-left px-2 py-1.5 font-medium">科目</th>
                        <th className="text-right px-2 py-1.5 font-medium">売上高</th>
                        <th className="text-left px-2 py-1.5 font-medium w-44">構成比</th>
                      </tr>
                    </thead>
                    <tbody>
                      {customers.list.slice(0, 15).map((c, i) => (
                        <tr key={i} className="border-t border-gray-50">
                          <td className="px-2 py-1 text-gray-400">{i + 1}</td>
                          <td className="px-2 py-1 text-gray-800 font-medium">{c.customer}</td>
                          <td className="px-2 py-1 text-gray-500 whitespace-nowrap">{c.account}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{fmtYen(c.amount)}</td>
                          <td className="px-2 py-1">
                            <div className="flex items-center gap-1.5">
                              <div className="flex-1 h-2.5 bg-gray-100 rounded overflow-hidden">
                                <div className="h-full bg-[#1a73e8]" style={{ width: `${Math.min(100, c.share)}%` }} />
                              </div>
                              <span className="tabular-nums text-gray-600 w-11 text-right">{c.share.toFixed(1)}%</span>
                            </div>
                          </td>
                        </tr>
                      ))}
                      {customers.walkIn > 0 && (
                        <tr className="border-t border-gray-100 bg-gray-50/60">
                          <td className="px-2 py-1" />
                          <td className="px-2 py-1 text-gray-600">店頭売上（日計・摘要なし）</td>
                          <td className="px-2 py-1" />
                          <td className="px-2 py-1 text-right tabular-nums text-gray-600">{fmtYen(customers.walkIn)}</td>
                          <td className="px-2 py-1">
                            <span className="tabular-nums text-gray-500">{customers.total ? ((customers.walkIn / customers.total) * 100).toFixed(1) : 0}%</span>
                          </td>
                        </tr>
                      )}
                      <tr className="border-t border-gray-200 font-bold">
                        <td className="px-2 py-1.5" />
                        <td className="px-2 py-1.5">売上合計</td>
                        <td className="px-2 py-1.5" />
                        <td className="px-2 py-1.5 text-right tabular-nums">{fmtYen(customers.total)}</td>
                        <td className="px-2 py-1.5" />
                      </tr>
                    </tbody>
                  </table>
                </div>
                {customers.list.length > 15 && (
                  <div className="text-[11px] text-gray-400 mt-1.5">※ 上位15件を表示（ほか {customers.list.length - 15}件）</div>
                )}
              </>
            )}
          </Section>
        </>
      )}
    </div>
  )
}

/** 現預金 日次残高の折れ線（SVG）。月ごとの最低残高日をマーカー表示 */
function DailyCashChart({ points, accounts }: { points: { date: string; balance: number }[]; accounts: string[] }) {
  const W = 860
  const H = 220
  const PAD = { l: 56, r: 10, t: 10, b: 22 }
  const min = Math.min(0, ...points.map((p) => p.balance))
  const max = Math.max(...points.map((p) => p.balance), 1)
  const x = (i: number) => PAD.l + (i / Math.max(1, points.length - 1)) * (W - PAD.l - PAD.r)
  const y = (v: number) => PAD.t + (1 - (v - min) / (max - min || 1)) * (H - PAD.t - PAD.b)
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.balance).toFixed(1)}`).join(' ')
  // 月ごとの最低残高
  const byMonth = new Map<string, { i: number; balance: number }>()
  points.forEach((p, i) => {
    const key = p.date.slice(0, 7)
    const cur = byMonth.get(key)
    if (!cur || p.balance < cur.balance) byMonth.set(key, { i, balance: p.balance })
  })
  const lows = Array.from(byMonth.entries())
  // 月境界ラベル
  const monthTicks: { i: number; label: string }[] = []
  let prevMonth = ''
  points.forEach((p, i) => {
    const m = p.date.slice(0, 7)
    if (m !== prevMonth) { monthTicks.push({ i, label: `${Number(m.slice(5, 7))}月` }); prevMonth = m }
  })
  const worst = lows.reduce((a, b) => (b[1].balance < a[1].balance ? b : a), lows[0])
  return (
    <div>
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[640px]">
          {[0.25, 0.5, 0.75, 1].map((f) => {
            const v = min + (max - min) * f
            return (
              <g key={f}>
                <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke="#eef2f7" />
                <text x={PAD.l - 6} y={y(v) + 3} textAnchor="end" fontSize="10" fill="#9aa3ad">{fmtShort(v)}</text>
              </g>
            )
          })}
          {min < 0 && <line x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} stroke="#ef4444" strokeDasharray="4 3" />}
          {monthTicks.map((t) => (
            <text key={t.i} x={x(t.i)} y={H - 6} fontSize="10" fill="#9aa3ad">{t.label}</text>
          ))}
          <path d={path} fill="none" stroke="#1a73e8" strokeWidth="1.8" />
          {lows.map(([k, v]) => (
            <circle key={k} cx={x(v.i)} cy={y(v.balance)} r="3" fill={v.balance < 0 ? '#ef4444' : '#f59e0b'} />
          ))}
        </svg>
      </div>
      <div className="text-[11px] text-gray-500 mt-1.5 leading-relaxed">
        対象口座: {accounts.join('・')}。●は各月の最低残高日
        {worst && <>（期間中の最低は <b>{worst[1].balance.toLocaleString()}円</b>・{worst[0].replace('-', '年')}月）</>}。
        月末残高が十分でも、月中の谷が浅い場合は支払日・入金サイトの調整や当座枠の検討材料になります。
      </div>
    </div>
  )
}
