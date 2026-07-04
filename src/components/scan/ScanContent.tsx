'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import GlobalNav from '@/core/ui/GlobalNav'
import { hasRoom, setRoomPassphrase } from '@/core/room'
import {
  loadScanClients,
  loadScanCompanies,
  registerScanCompany,
  buildScanUrl,
  type ScanClient,
  loadBatches,
  loadCashEntries,
  setBatchStatus,
  setCashStatus,
  getBatchImageUrls,
  getBatchImageBlobs,
  sweepOldScanData,
  deleteBatch,
  saveAnalysis,
  loadAnalysis,
  loadAnalyses,
  markBatchTransferred,
  loadScanCreditHistory,
  pushScanCreditHistory,
  type ScanAnalysis,
  type ScanAnalysisRow,
  type ScanAnalysisKind,
  type ScanAnalysisMeta,
  type ScanCreditAccount,
  type ScanCompany,
  type ScanBatch,
  type ScanCashEntry,
  type ScanStatus,
} from '@/lib/scan/store'
import { analyzeBatchAndSave, subscribeEngineStatus, docTypeToKind } from '@/lib/scan/auto-analyzer'
import { getClients as getBsClients, setSelectedClientId } from '@/lib/bank-statement/client-store'
import DriveSaveDialog from '@/core/ui/DriveSaveDialog'

type SharedClient = ScanClient

// AI解析結果の行（保存形式と同一）
type ReceiptRow = ScanAnalysisRow

function safe(name: string): string {
  return (name || '').replace(/[\\/:*?"<>|]/g, '_')
}

export default function ScanContent() {
  const [ready, setReady] = useState(false)
  const [pass, setPass] = useState('')
  const [clients, setClients] = useState<SharedClient[]>([])
  const [companies, setCompanies] = useState<Record<string, ScanCompany>>({})
  const [counts, setCounts] = useState<Record<string, { batch: number; cash: number }>>({})
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [qr, setQr] = useState<{ name: string; url: string; dataUrl: string } | null>(null)
  const [inbox, setInbox] = useState<{ client: SharedClient; company: ScanCompany } | null>(null)

  // 常駐の自動AI解析エンジン（layout.tsx で全ページ起動）の状態を表示に反映
  const [engineMsg, setEngineMsg] = useState('')
  const [analyzingIds, setAnalyzingIds] = useState<Set<string>>(new Set())
  useEffect(() => {
    return subscribeEngineStatus((s) => {
      setEngineMsg(s.message)
      setAnalyzingIds(new Set(s.analyzingIds))
    })
  }, [])

  useEffect(() => {
    setReady(hasRoom())
  }, [])

  const reload = useCallback(async () => {
    if (!hasRoom()) return
    setBusy(true)
    setMsg('')
    try {
      // 顧問先情報で「書類スキャン受信＝利用」にした会社のみ対象。トークン未発行なら自動発行。
      // 公開領域(scan-public)の会社名も毎回書き直す（ルール不備からの自己修復）
      const cl = await loadScanClients()
      const errors: string[] = []
      await Promise.all(
        cl.map((c) =>
          registerScanCompany(c).catch((e) => {
            errors.push(e instanceof Error ? e.message : String(e))
          }),
        ),
      )
      const comps = await loadScanCompanies()
      setClients(cl)
      setCompanies(comps)
      const nextCounts: Record<string, { batch: number; cash: number }> = {}
      await Promise.all(
        Object.values(comps).map(async (c) => {
          try {
            // 保存期間（送信から1年）を過ぎたデータを自動削除してから件数を数える
            try { await sweepOldScanData(c.token) } catch { /* 権限エラー等は下で表示される */ }
            const [batches, cash] = await Promise.all([loadBatches(c.token), loadCashEntries(c.token)])
            nextCounts[c.clientId] = {
              batch: Object.values(batches).filter((b) => b.status !== 'done').length,
              cash: Object.values(cash).filter((c2) => c2.status !== 'done').length,
            }
          } catch (e) {
            errors.push(e instanceof Error ? e.message : String(e))
          }
        }),
      )
      setCounts(nextCounts)
      if (errors.length) {
        const isPerm = errors.some((m) => /permission/i.test(m))
        setMsg(
          isPerm
            ? '⚠️ Firebaseのセキュリティルールに scan-public の許可がありません。Firebaseコンソールのルールに scan-public ブロックを追加してください（追加するまで顧問先の送信もエラーになります）。詳細：' + errors[0]
            : '一部の読み込みに失敗しました：' + errors[0],
        )
      }
    } catch (e) {
      setMsg('読み込みに失敗しました：' + (e instanceof Error ? e.message : ''))
    }
    setBusy(false)
  }, [])

  useEffect(() => {
    if (ready) reload()
  }, [ready, reload])

  function saveRoom() {
    if (!pass.trim()) return
    setRoomPassphrase(pass.trim())
    setReady(true)
  }

  async function copyUrl(company: ScanCompany) {
    const url = buildScanUrl(company)
    try {
      await navigator.clipboard.writeText(url)
      setMsg('アップロードURLをコピーしました。')
    } catch {
      window.prompt('URLをコピーしてください', url)
    }
  }

  async function showQr(company: ScanCompany) {
    const url = buildScanUrl(company)
    const QRCode = (await import('qrcode')).default
    const dataUrl = await QRCode.toDataURL(url, { width: 280, margin: 1 })
    setQr({ name: company.name, url, dataUrl })
  }

  if (!ready) {
    return (
      <div className="min-h-screen flex flex-col bg-gray-50">
        <GlobalNav currentKey="scan" />
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="bg-white rounded-2xl border border-gray-200 p-6 w-full max-w-md">
            <h1 className="text-lg font-bold text-gray-800 mb-2">合言葉の設定</h1>
            <p className="text-sm text-gray-500 mb-4">
              データ共有のための合言葉を入力してください（他のアプリと同じ合言葉です）。
            </p>
            <input
              type="password"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              placeholder="合言葉"
              className="w-full px-3 py-2 border border-gray-300 rounded mb-3"
            />
            <button onClick={saveRoom} className="w-full py-2 bg-blue-600 text-white rounded font-semibold hover:bg-blue-700">
              設定する
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <GlobalNav currentKey="scan" />
      <div className="flex-1 p-6 max-w-5xl w-full mx-auto">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <h1 className="text-xl font-bold text-gray-800">書類スキャン受信 — 顧問先スマホ撮影の回収</h1>
          <button onClick={reload} disabled={busy} className="px-3 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50">
            更新
          </button>
        </div>

        {msg && <div className="mb-4 text-sm bg-blue-50 border border-blue-200 text-blue-800 rounded px-3 py-2">{msg}</div>}
        {engineMsg && (
          <div className="mb-4 text-sm bg-emerald-50 border border-emerald-200 text-emerald-800 rounded px-3 py-2 animate-pulse">
            {engineMsg}
          </div>
        )}

        <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 text-sm text-gray-500">
            「顧問先情報登録」の「アプリ利用」で<strong>書類スキャン受信＝利用</strong>にした会社が表示されます。URL/QRを配布し、受信箱で画像確認・AI解析・Excel/CSV出力ができます。
          </div>
          {clients.length === 0 ? (
            <div className="p-6 text-center text-sm text-gray-500">
              対象会社がありません。「顧問先情報登録」の「アプリ利用」で対象会社の<strong>書類スキャン受信</strong>を<strong>利用</strong>に設定してください。
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-gray-500">
                  <th className="text-left px-4 py-2 font-semibold">コード</th>
                  <th className="text-left px-4 py-2 font-semibold">会社名</th>
                  <th className="text-left px-4 py-2 font-semibold">未処理バッチ</th>
                  <th className="text-left px-4 py-2 font-semibold">未処理現金登録</th>
                  <th className="text-right px-4 py-2 font-semibold">操作</th>
                </tr>
              </thead>
              <tbody>
                {clients.map((client) => {
                  const company = companies[client.id]
                  if (!company) return null
                  const cnt = counts[client.id] || { batch: 0, cash: 0 }
                  return (
                    <tr key={client.id} className="border-t border-gray-100">
                      <td className="px-4 py-3 text-gray-700">{client.code || '—'}</td>
                      <td className="px-4 py-3 font-medium text-gray-800">{client.name}</td>
                      <td className="px-4 py-3">
                        <span className="font-semibold text-blue-700">{cnt.batch}</span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="font-semibold text-blue-700">{cnt.cash}</span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 justify-end flex-wrap">
                          <button onClick={() => copyUrl(company)} className="px-3 py-1.5 text-xs border border-gray-300 rounded hover:bg-gray-50">
                            URLコピー
                          </button>
                          <button onClick={() => showQr(company)} className="px-3 py-1.5 text-xs border border-gray-300 rounded hover:bg-gray-50">
                            QR表示
                          </button>
                          <button onClick={() => setInbox({ client, company })} className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700">
                            受信箱を開く
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {qr && (
        <Overlay onClose={() => setQr(null)}>
          <h2 className="font-bold text-gray-800 mb-1">{qr.name}</h2>
          <p className="text-xs text-gray-500 mb-3">顧問先に配布するQRコード</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={qr.dataUrl} alt="QR" className="mx-auto mb-3" />
          <div className="text-[11px] text-gray-500 break-all bg-gray-50 rounded p-2">{qr.url}</div>
        </Overlay>
      )}

      {inbox && (
        <InboxModal
          client={inbox.client}
          company={inbox.company}
          analyzingIds={analyzingIds}
          onClose={() => setInbox(null)}
          onChanged={reload}
        />
      )}
    </div>
  )
}

function Overlay({ children, onClose, wide }: { children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className={`bg-white rounded-2xl p-6 w-full max-h-[90vh] overflow-auto ${wide ? 'max-w-5xl' : 'max-w-2xl'}`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
        <div className="text-right mt-4">
          <button onClick={onClose} className="px-4 py-2 bg-gray-200 text-gray-700 rounded text-sm">
            閉じる
          </button>
        </div>
      </div>
    </div>
  )
}

function InboxModal({
  client,
  company,
  analyzingIds,
  onClose,
  onChanged,
}: {
  client: SharedClient
  company: ScanCompany
  analyzingIds: Set<string> // 画面全体の自動解析エンジンが処理中のバッチID
  onClose: () => void
  onChanged: () => void
}) {
  const [tab, setTab] = useState<'batches' | 'cash'>('batches')
  const [batches, setBatches] = useState<Record<string, ScanBatch>>({})
  const [cash, setCash] = useState<Record<string, ScanCashEntry>>({})
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [openBatch, setOpenBatch] = useState<ScanBatch | null>(null)
  const [showDone, setShowDone] = useState(false)
  const [analyses, setAnalyses] = useState<Record<string, ScanAnalysis>>({})

  const load = useCallback(async () => {
    setLoading(true)
    setErr('')
    try {
      const [b, c, a] = await Promise.all([
        loadBatches(company.token),
        loadCashEntries(company.token),
        loadAnalyses(company.token),
      ])
      setBatches(b)
      setCash(c)
      setAnalyses(a)
    } catch (e) {
      setErr('読み込みに失敗しました：' + (e instanceof Error ? e.message : ''))
    } finally {
      setLoading(false)
    }
  }, [company.token])

  useEffect(() => {
    load()
  }, [load])

  // 自動解析エンジン（親）の進行に合わせて、一覧の解析済み表示・新着バッチを更新
  useEffect(() => {
    if (loading) return
    Promise.all([loadAnalyses(company.token), loadBatches(company.token)])
      .then(([a, b]) => {
        setAnalyses(a)
        setBatches(b)
      })
      .catch(() => { /* ignore */ })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analyzingIds, company.token])

  async function toggleBatchDone(b: ScanBatch) {
    const next: ScanStatus = b.status === 'done' ? 'new' : 'done'
    try {
      await setBatchStatus(company.token, b.id, next)
      await load()
      onChanged()
    } catch (e) {
      alert('更新に失敗しました：' + (e instanceof Error ? e.message : ''))
    }
  }

  async function toggleCashDone(c: ScanCashEntry) {
    const next: ScanStatus = c.status === 'done' ? 'new' : 'done'
    try {
      await setCashStatus(company.token, c.id, next)
      await load()
      onChanged()
    } catch (e) {
      alert('更新に失敗しました：' + (e instanceof Error ? e.message : ''))
    }
  }

  async function removeBatch(b: ScanBatch) {
    if (!confirm('このバッチを削除しますか？画像も削除され元に戻せません。')) return
    try {
      await deleteBatch(company.token, b)
      setOpenBatch(null)
      await load()
      onChanged()
    } catch (e) {
      alert('削除に失敗しました：' + (e instanceof Error ? e.message : ''))
    }
  }

  function cashCsv() {
    const rows = Object.values(cash).sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))
    const header = ['日付', '種別', '銀行名', '口座番号', '金額', '預入の種類', '状態', '登録日時']
    const lines = [header.join(',')]
    for (const r of rows) {
      lines.push(
        [
          r.date,
          r.entryType,
          r.bankName,
          r.accountNumber || '',
          String(r.amount),
          r.depositType || '',
          r.status === 'done' ? '処理済み' : '未処理',
          r.submittedAt,
        ]
          .map((v) => `"${String(v).replace(/"/g, '""')}"`)
          .join(','),
      )
    }
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' })
    downloadBlob(blob, `${safe(client.name)}_現金出納_${new Date().toISOString().slice(0, 10)}.csv`)
  }

  const batchList = Object.values(batches)
    .filter((b) => showDone || b.status !== 'done')
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))
  const cashList = Object.values(cash)
    .filter((c) => showDone || c.status !== 'done')
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))

  return (
    <Overlay onClose={onClose} wide>
      <h2 className="font-bold text-gray-800 mb-1">{client.name} — 受信箱</h2>
      <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
        <div className="flex gap-2">
          <button
            onClick={() => setTab('batches')}
            className={`px-3 py-1.5 text-sm rounded ${tab === 'batches' ? 'bg-blue-600 text-white' : 'border border-gray-300 text-gray-600'}`}
          >
            撮影バッチ
          </button>
          <button
            onClick={() => setTab('cash')}
            className={`px-3 py-1.5 text-sm rounded ${tab === 'cash' ? 'bg-blue-600 text-white' : 'border border-gray-300 text-gray-600'}`}
          >
            現金引出・預入
          </button>
        </div>
        <label className="flex items-center gap-1.5 text-xs text-gray-500">
          <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />
          処理済みも表示
        </label>
      </div>

      {err && <div className="text-sm bg-red-50 border border-red-200 text-red-700 rounded px-3 py-2 mb-3">{err}</div>}
      {loading ? (
        <p className="text-sm text-gray-500 py-6 text-center">読み込み中...</p>
      ) : tab === 'batches' ? (
        batchList.length === 0 ? (
          <p className="text-sm text-gray-500 py-6 text-center">バッチがありません。</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-gray-500">
                <th className="text-left px-3 py-2">日時</th>
                <th className="text-left px-3 py-2">書類種類</th>
                <th className="text-left px-3 py-2">ページ数</th>
                <th className="text-left px-3 py-2">AI解析</th>
                <th className="text-left px-3 py-2">状態</th>
                <th className="text-right px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {batchList.map((b) => (
                <tr key={b.id} className="border-t border-gray-100">
                  <td className="px-3 py-2 text-gray-600">{new Date(b.submittedAt).toLocaleString('ja-JP')}</td>
                  <td className="px-3 py-2 text-gray-800">
                    {b.docType}
                    {b.bankName ? `（${b.bankName} ${b.accountNumber || ''}）` : ''}
                    {b.userName ? `（${b.userName}）` : ''}
                  </td>
                  <td className="px-3 py-2 text-gray-600">{b.pageCount}枚</td>
                  <td className="px-3 py-2">
                    {analyzingIds.has(b.id) ? (
                      <span className="text-xs text-blue-700 bg-blue-50 rounded px-2 py-0.5 animate-pulse">解析中…</span>
                    ) : analyses[b.id] ? (
                      <span className="text-xs text-emerald-700 bg-emerald-50 rounded px-2 py-0.5">解析済み（{(analyses[b.id].rows || []).length}行）</span>
                    ) : docTypeToKind(b.docType) === null ? (
                      <span className="text-xs text-gray-300" title="この書類種類のAI解析は準備中です">対象外</span>
                    ) : (
                      <span className="text-xs text-gray-400">未解析</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {b.status === 'done' ? (
                      <span className="text-xs text-green-700 bg-green-50 rounded px-2 py-0.5">処理済み</span>
                    ) : (
                      <span className="text-xs text-amber-700 bg-amber-50 rounded px-2 py-0.5">未処理</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button onClick={() => setOpenBatch(b)} className="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700">
                      開く
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      ) : cashList.length === 0 ? (
        <p className="text-sm text-gray-500 py-6 text-center">現金の登録がありません。</p>
      ) : (
        <>
          <div className="text-right mb-2">
            <button onClick={cashCsv} className="px-3 py-1.5 text-xs border border-gray-300 rounded hover:bg-gray-50">
              CSV出力
            </button>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-gray-500">
                <th className="text-left px-3 py-2">日付</th>
                <th className="text-left px-3 py-2">種別</th>
                <th className="text-left px-3 py-2">銀行</th>
                <th className="text-right px-3 py-2">金額</th>
                <th className="text-left px-3 py-2">状態</th>
                <th className="text-right px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {cashList.map((c) => (
                <tr key={c.id} className="border-t border-gray-100">
                  <td className="px-3 py-2 text-gray-600">{c.date}</td>
                  <td className="px-3 py-2 text-gray-800">
                    {c.entryType}
                    {c.depositType ? `（${c.depositType}）` : ''}
                  </td>
                  <td className="px-3 py-2 text-gray-600">
                    {c.bankName} {c.accountNumber || ''}
                  </td>
                  <td className="px-3 py-2 text-right text-gray-800">{c.amount.toLocaleString('ja-JP')}円</td>
                  <td className="px-3 py-2">
                    {c.status === 'done' ? (
                      <span className="text-xs text-green-700 bg-green-50 rounded px-2 py-0.5">処理済み</span>
                    ) : (
                      <span className="text-xs text-amber-700 bg-amber-50 rounded px-2 py-0.5">未処理</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button onClick={() => toggleCashDone(c)} className="px-3 py-1 text-xs border border-gray-300 rounded hover:bg-gray-50">
                      {c.status === 'done' ? '未処理に戻す' : '処理済みにする'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {openBatch && (
        <BatchDetail
          client={client}
          company={company}
          batch={openBatch}
          onClose={() => {
            setOpenBatch(null)
            // 詳細画面での解析・編集を一覧の「解析済み」表示に反映
            loadAnalyses(company.token).then(setAnalyses).catch(() => { /* ignore */ })
          }}
          onToggleDone={() => toggleBatchDone(openBatch)}
          onDelete={() => removeBatch(openBatch)}
        />
      )}
    </Overlay>
  )
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

function BatchDetail({
  client,
  company,
  batch,
  onClose,
  onToggleDone,
  onDelete,
}: {
  client: SharedClient
  company: ScanCompany
  batch: ScanBatch
  onClose: () => void
  onToggleDone: () => void
  onDelete: () => void
}) {
  const [images, setImages] = useState<string[]>([])
  const [loadingImgs, setLoadingImgs] = useState(true)
  const [analyzing, setAnalyzing] = useState(false)
  const [progress, setProgress] = useState('')
  const [rows, setRows] = useState<ReceiptRow[]>([])
  const [analyzeErr, setAnalyzeErr] = useState('')
  const [driveOpen, setDriveOpen] = useState(false)
  const [transferOpen, setTransferOpen] = useState(false)
  const [loadedSaved, setLoadedSaved] = useState(false) // 保存済み解析の読込完了（自動保存の暴発防止）
  const [activeImg, setActiveImg] = useState<number | null>(null)
  const imgRefs = useRef<(HTMLImageElement | null)[]>([])
  const [kind, setKind] = useState<ScanAnalysisKind | null>(docTypeToKind(batch.docType))
  const [meta, setMeta] = useState<ScanAnalysisMeta | undefined>(undefined)

  // 書類種類ごとの表の列ラベル
  const COLS: Record<ScanAnalysisKind, { date: string; name: string; content: string; amount: string }> = {
    receipt: { date: '日付', name: '店名', content: '内容', amount: '税込金額' },
    'credit-card': { date: '利用日', name: '利用店名', content: '備考', amount: '金額' },
    'invoice-sales': { date: '請求日', name: '請求先（宛名）', content: '内容', amount: '税込金額' },
    'invoice-purchase': { date: '請求日', name: '請求元（発行者）', content: '内容', amount: '税込金額' },
  }
  const col = COLS[kind || 'receipt']

  useEffect(() => {
    ;(async () => {
      setLoadingImgs(true)
      try {
        setImages(await getBatchImageUrls(company.token, batch))
      } catch {
        /* ignore */
      } finally {
        setLoadingImgs(false)
      }
      // 保存済みの解析結果があれば復元（閉じても消えない）
      try {
        const saved = await loadAnalysis(company.token, batch.id)
        if (saved && Array.isArray(saved.rows) && saved.rows.length) {
          setRows(saved.rows as ReceiptRow[])
          if (saved.kind) setKind(saved.kind)
          if (saved.meta) setMeta(saved.meta)
        }
      } catch {
        /* ignore */
      }
      setLoadedSaved(true)
    })()
  }, [company.token, batch])

  // 編集内容の自動保存（0.8秒デバウンス・全端末共有）
  useEffect(() => {
    if (!loadedSaved) return
    const t = setTimeout(() => {
      saveAnalysis(company.token, batch.id, rows, kind || 'receipt', meta).catch(() => { /* 次の編集時に再試行 */ })
    }, 800)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, loadedSaved])

  // 行クリック → 元になった画像へスクロール＆ハイライト
  function focusImage(pageIndex: number | null | undefined) {
    if (pageIndex == null || pageIndex < 0) return
    setActiveImg(pageIndex)
    imgRefs.current[pageIndex]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  async function analyze() {
    setAnalyzing(true)
    setAnalyzeErr('')
    try {
      const res = await analyzeBatchAndSave(company.token, batch, (m) => setProgress(m))
      setRows(res.rows)
      setKind(res.kind)
      setMeta(res.meta)
      if (res.errors.length) setAnalyzeErr(`一部の画像で解析に失敗しました：${res.errors.join('、')}`)
    } catch (e) {
      setAnalyzeErr('解析に失敗しました：' + (e instanceof Error ? e.message : ''))
    }
    setAnalyzing(false)
    setProgress('')
  }

  function updateRow(idx: number, patch: Partial<ReceiptRow>) {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)))
  }
  function removeRow(idx: number) {
    setRows((prev) => prev.filter((_, i) => i !== idx))
  }
  function addRow() {
    setRows((prev) => [...prev, { date: '', storeName: '', mainContent: '', invoiceNumber: '', taxRate: '', totalAmount: 0 }])
  }

  function fileBase(): string {
    return `${safe(client.name)}_${safe(batch.docType)}_${batch.submittedAt.slice(0, 10)}`
  }

  // 書類種類に応じた出力ヘッダ
  function exportHeader(): string[] {
    return [col.date, col.name, col.content, 'インボイス番号', '税率', col.amount]
  }

  async function exportExcel() {
    const XLSX = await import('xlsx')
    const aoa: (string | number)[][] = []
    if (kind === 'credit-card' && meta) {
      aoa.push(['引落日', meta.paymentDate || '', '引落総額', meta.totalAmount || 0, 'カード名', meta.cardName || ''])
    }
    aoa.push(exportHeader())
    for (const r of rows) aoa.push([r.date, r.storeName, r.mainContent, r.invoiceNumber, r.taxRate, r.totalAmount])
    const ws = XLSX.utils.aoa_to_sheet(aoa)
    ws['!cols'] = [{ wch: 12 }, { wch: 22 }, { wch: 24 }, { wch: 18 }, { wch: 8 }, { wch: 12 }]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, '解析結果')
    XLSX.writeFile(wb, `${fileBase()}.xlsx`)
  }

  function exportCsv() {
    const header = exportHeader()
    const lines = [header.join(',')]
    for (const r of rows) {
      lines.push(
        [r.date, r.storeName, r.mainContent, r.invoiceNumber, r.taxRate, String(r.totalAmount)]
          .map((v) => `"${String(v).replace(/"/g, '""')}"`)
          .join(','),
      )
    }
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' })
    downloadBlob(blob, `${fileBase()}.csv`)
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl p-6 w-full max-w-6xl max-h-[92vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <h3 className="font-bold text-gray-800">
            {batch.docType} — {new Date(batch.submittedAt).toLocaleString('ja-JP')}（{batch.pageCount}枚）
          </h3>
          <div className="flex gap-2">
            <button
              onClick={() => {
                if ((kind || 'receipt') !== 'receipt') {
                  alert('仕訳作成への転送は現在「レシート・領収書」のみ対応しています（他の書類種類は順次対応予定）。')
                  return
                }
                if (!rows.length) {
                  alert('先にAI解析（または行の追加）を行ってから転送してください。')
                  return
                }
                if (batch.transferredAt && !confirm(`このバッチは ${new Date(batch.transferredAt).toLocaleString('ja-JP')} に仕訳作成へ転送済みです。\nもう一度転送しますか？（二重取込にご注意ください）`)) return
                setTransferOpen(true)
              }}
              className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700"
            >
              📒 仕訳作成へ送る{batch.transferredAt ? '（転送済み）' : ''}
            </button>
            <button onClick={() => setDriveOpen(true)} className="px-3 py-1.5 text-xs border border-emerald-300 text-emerald-700 rounded hover:bg-emerald-50">
              📁 Driveへ保存
            </button>
            <button onClick={onToggleDone} className="px-3 py-1.5 text-xs border border-gray-300 rounded hover:bg-gray-50">
              {batch.status === 'done' ? '未処理に戻す' : '処理済みにする'}
            </button>
            <button onClick={onDelete} className="px-3 py-1.5 text-xs border border-red-300 text-red-600 rounded hover:bg-red-50">
              削除
            </button>
          </div>
        </div>

        {transferOpen && (
          <TransferDialog
            client={client}
            company={company}
            batch={batch}
            rows={rows}
            onClose={() => setTransferOpen(false)}
          />
        )}

        {driveOpen && (
          <DriveSaveDialog
            title={`${client.name}／${batch.docType}（${batch.pageCount}枚）の画像を共有ドライブに保存します`}
            getFiles={async (onProgress) => {
              onProgress('画像を取得しています...')
              const blobs = await getBatchImageBlobs(company.token, batch)
              const base = `${safe(client.name)}_${safe(batch.docType)}_${batch.submittedAt.slice(0, 10)}`
              return blobs.map((b, i) => ({ name: `${base}_${i + 1}.jpg`, blob: b.blob }))
            }}
            onClose={() => setDriveOpen(false)}
          />
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="border border-gray-200 rounded-lg p-2 max-h-[70vh] overflow-auto space-y-2 bg-gray-50">
            {loadingImgs ? (
              <p className="text-sm text-gray-500 text-center py-6">画像を読み込み中...</p>
            ) : images.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-6">画像がありません。</p>
            ) : (
              images.map((src, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={i}
                  ref={(el) => { imgRefs.current[i] = el }}
                  src={src}
                  alt={`page ${i + 1}`}
                  onClick={() => setActiveImg(i)}
                  className={`w-full rounded border-2 transition-colors ${activeImg === i ? 'border-blue-500 ring-2 ring-blue-300' : 'border-gray-200'}`}
                />
              ))
            )}
          </div>

          <div>
            <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
              <button
                onClick={analyze}
                disabled={analyzing || images.length === 0}
                className="px-4 py-2 text-sm bg-emerald-600 text-white rounded font-semibold hover:bg-emerald-700 disabled:opacity-50"
              >
                {analyzing ? progress || 'AI解析中...' : 'AI解析'}
              </button>
              <div className="flex gap-2">
                <button onClick={addRow} className="px-3 py-1.5 text-xs border border-gray-300 rounded hover:bg-gray-50">
                  行を追加
                </button>
                <button
                  onClick={exportExcel}
                  disabled={rows.length === 0}
                  className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                >
                  Excel出力
                </button>
                <button
                  onClick={exportCsv}
                  disabled={rows.length === 0}
                  className="px-3 py-1.5 text-xs border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50"
                >
                  CSV出力
                </button>
              </div>
            </div>

            {analyzeErr && <div className="text-xs text-red-600 mb-2 break-words">{analyzeErr}</div>}

            {kind === 'credit-card' && meta && (
              <div className="text-xs bg-blue-50 border border-blue-200 text-blue-800 rounded px-3 py-2 mb-2">
                💳 {meta.cardName ? `${meta.cardName}／` : ''}引落日 {meta.paymentDate || '不明'}／引落総額 ¥{(meta.totalAmount || 0).toLocaleString('ja-JP')}
              </div>
            )}

            {rows.length === 0 ? (
              <p className="text-sm text-gray-500 py-6 text-center border border-dashed border-gray-200 rounded">
                {kind
                  ? '「AI解析」を押すと結果がここに表示されます。手動で行を追加することもできます。'
                  : `「${batch.docType}」のAI解析は現在準備中です（画像の確認・Drive保存・行の手動追加は利用できます）。`}
              </p>
            ) : (
              <div className="overflow-auto max-h-[60vh] border border-gray-200 rounded">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-gray-50 text-gray-500 sticky top-0">
                      <th className="text-left px-2 py-1.5">{col.date}</th>
                      <th className="text-left px-2 py-1.5">{col.name}</th>
                      <th className="text-left px-2 py-1.5">{col.content}</th>
                      <th className="text-left px-2 py-1.5">インボイス番号</th>
                      <th className="text-left px-2 py-1.5">税率</th>
                      <th className="text-right px-2 py-1.5">{col.amount}</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr
                        key={i}
                        onClick={(e) => {
                          const tag = (e.target as HTMLElement).tagName
                          if (tag !== 'INPUT' && tag !== 'BUTTON') focusImage(r.pageIndex)
                        }}
                        title={r.pageIndex != null ? `クリックで元画像（${(r.pageIndex ?? 0) + 1}枚目）を表示` : undefined}
                        className={`border-t border-gray-100 ${r.pageIndex != null ? 'cursor-pointer hover:bg-blue-50/40' : ''} ${activeImg != null && r.pageIndex === activeImg ? 'bg-blue-50' : ''}`}
                      >
                        <td className="px-1 py-1">
                          <input value={r.date} onChange={(e) => updateRow(i, { date: e.target.value })} className="w-24 px-1 py-1 border border-gray-200 rounded" />
                        </td>
                        <td className="px-1 py-1">
                          <input value={r.storeName} onChange={(e) => updateRow(i, { storeName: e.target.value })} className="w-28 px-1 py-1 border border-gray-200 rounded" />
                        </td>
                        <td className="px-1 py-1">
                          <input value={r.mainContent} onChange={(e) => updateRow(i, { mainContent: e.target.value })} className="w-28 px-1 py-1 border border-gray-200 rounded" />
                        </td>
                        <td className="px-1 py-1">
                          <input value={r.invoiceNumber} onChange={(e) => updateRow(i, { invoiceNumber: e.target.value })} className="w-24 px-1 py-1 border border-gray-200 rounded" />
                        </td>
                        <td className="px-1 py-1">
                          <input value={r.taxRate} onChange={(e) => updateRow(i, { taxRate: e.target.value })} className="w-14 px-1 py-1 border border-gray-200 rounded" />
                        </td>
                        <td className="px-1 py-1">
                          <input
                            value={r.totalAmount}
                            onChange={(e) => updateRow(i, { totalAmount: Number(e.target.value.replace(/[^\d.-]/g, '')) || 0 })}
                            className="w-20 px-1 py-1 border border-gray-200 rounded text-right"
                          />
                        </td>
                        <td className="px-1 py-1 text-right">
                          <button onClick={() => removeRow(i)} className="text-red-500 text-xs">
                            削除
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        <div className="text-right mt-4">
          <button onClick={onClose} className="px-4 py-2 bg-gray-200 text-gray-700 rounded text-sm">
            閉じる
          </button>
        </div>
      </div>
    </div>
  )
}

/** 仕訳作成への転送ダイアログ。
 *  貸方＝「現金」か「それ以外（顧問先の科目リストから選択）」を確認してから転送する。
 *  「それ以外」で選んだ科目は履歴（全端末共有）に記録し、次回から優先表示する。 */
function TransferDialog({
  client,
  company,
  batch,
  rows,
  onClose,
}: {
  client: SharedClient
  company: ScanCompany
  batch: ScanBatch
  rows: ReceiptRow[]
  onClose: () => void
}) {
  const [step, setStep] = useState<'cash' | 'other'>('cash')
  const [history, setHistory] = useState<ScanCreditAccount[]>([])
  const [master, setMaster] = useState<{ code: string; name: string }[]>([])
  const [selCode, setSelCode] = useState('')
  const [selName, setSelName] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  // 仕訳作成側の顧問先を解決（ID直結 → 予備としてコード一致）
  const bsClient = (() => {
    const list = getBsClients()
    return list.find((c) => c.id === client.id) || (client.code ? list.find((c) => (c.code || '').trim() === String(client.code).trim()) : undefined) || null
  })()

  useEffect(() => {
    loadScanCreditHistory(client.id).then(setHistory).catch(() => { /* ignore */ })
    // 顧問先の科目マスタ（仕訳作成が同期している端末ローカルデータ）を読む
    if (bsClient) {
      try {
        const raw = localStorage.getItem(`bs-accounts-${bsClient.id}`)
        if (raw) {
          const arr = JSON.parse(raw) as { code: string; name: string; shortName?: string }[]
          setMaster(arr.map((a) => ({ code: a.code, name: a.shortName || a.name })))
        }
      } catch { /* ignore */ }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client.id])

  // 現金の科目コードは顧問先の科目マスタから探す（無ければ会計大将標準の100）
  function cashAccount(): ScanCreditAccount {
    const hit = master.find((m) => m.name === '現金') || master.find((m) => m.name.includes('現金') && !m.name.includes('過不足'))
    return hit ? { code: hit.code, name: hit.name } : { code: '100', name: '現金' }
  }

  async function send(credit: ScanCreditAccount, remember: boolean) {
    if (!bsClient) return
    setBusy(true)
    setErr('')
    try {
      const images = await getBatchImageUrls(company.token, batch)
      const payload = {
        v: 1,
        clientId: bsClient.id,
        clientName: bsClient.name,
        scanClientName: client.name,
        batchId: batch.id,
        docType: batch.docType,
        submittedAt: batch.submittedAt,
        credit,
        rows,
        images,
      }
      localStorage.setItem('bs-scan-import', JSON.stringify(payload))
      if (remember) {
        try { await pushScanCreditHistory(client.id, credit) } catch { /* ignore */ }
      }
      try { await markBatchTransferred(company.token, batch.id) } catch { /* ignore */ }
      setSelectedClientId(bsClient.id)
      const base = process.env.NEXT_PUBLIC_BASE_PATH || ''
      window.location.assign(`${base}/bank-statement/`)
    } catch (e) {
      setErr('転送の準備に失敗しました：' + (e instanceof Error ? e.message : ''))
      setBusy(false)
    }
  }

  const historyKeys = new Set(history.map((h) => h.code))
  const restMaster = master.filter((m) => !historyKeys.has(m.code))

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[70] p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <h3 className="font-bold text-gray-800 mb-1">📒 仕訳作成へ送る</h3>
        <p className="text-xs text-gray-500 mb-4">
          {client.name}／{batch.docType}・{rows.length}行を仕訳作成に取り込みます。
        </p>

        {!bsClient ? (
          <div className="text-sm bg-red-50 border border-red-200 text-red-700 rounded px-3 py-2">
            仕訳作成にこの顧問先が見つかりません。「顧問先情報登録」でこの顧問先の<b>仕訳作成＝利用</b>にしてから、
            一度仕訳作成を開いて顧問先が表示されることを確認してください。
          </div>
        ) : step === 'cash' ? (
          <div>
            <p className="text-sm font-semibold text-gray-700 mb-3">貸方（支払い方法）は「現金」ですか？</p>
            <button
              onClick={() => send(cashAccount(), false)}
              disabled={busy}
              className="w-full py-3 mb-2 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 disabled:opacity-60"
            >
              {busy ? '転送中...' : '💴 現金で送る'}
            </button>
            <button
              onClick={() => setStep('other')}
              disabled={busy}
              className="w-full py-3 border border-blue-600 text-blue-700 rounded-lg font-semibold hover:bg-blue-50 disabled:opacity-60"
            >
              それ以外の科目から選ぶ
            </button>
          </div>
        ) : (
          <div>
            <p className="text-sm font-semibold text-gray-700 mb-2">貸方科目を選んでください</p>

            {history.length > 0 && (
              <div className="mb-3">
                <div className="text-[11px] text-gray-400 mb-1">よく使う（過去に選択した科目）</div>
                <div className="flex flex-wrap gap-2">
                  {history.map((h) => (
                    <button
                      key={h.code + (h.subCode || '')}
                      onClick={() => send(h, true)}
                      disabled={busy}
                      className="px-3 py-2 text-sm border border-blue-300 text-blue-700 rounded-lg hover:bg-blue-50 disabled:opacity-60"
                    >
                      {h.code} {h.name}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {master.length > 0 ? (
              <div className="mb-3">
                <div className="text-[11px] text-gray-400 mb-1">科目リストから選択</div>
                <select
                  value={selCode}
                  onChange={(e) => {
                    setSelCode(e.target.value)
                    const m = master.find((x) => x.code === e.target.value)
                    setSelName(m?.name || '')
                  }}
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg"
                >
                  <option value="">-- 科目を選択 --</option>
                  {restMaster.map((m) => (
                    <option key={m.code} value={m.code}>
                      {m.code} - {m.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="mb-3">
                <div className="text-[11px] text-amber-600 mb-1">
                  この端末に科目マスタがありません（仕訳作成でこの顧問先を一度開くと同期されます）。コードと科目名を直接入力できます。
                </div>
                <div className="flex gap-2">
                  <input value={selCode} onChange={(e) => setSelCode(e.target.value)} placeholder="コード" className="w-24 px-3 py-2 text-sm border border-gray-300 rounded-lg" />
                  <input value={selName} onChange={(e) => setSelName(e.target.value)} placeholder="科目名（例：役員借入金）" className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-lg" />
                </div>
              </div>
            )}

            {err && <div className="text-xs text-red-600 mb-2">{err}</div>}

            <button
              onClick={() => {
                if (!selCode || !selName) {
                  setErr('科目を選択（入力）してください。')
                  return
                }
                send({ code: selCode, name: selName }, true)
              }}
              disabled={busy}
              className="w-full py-3 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 disabled:opacity-60"
            >
              {busy ? '転送中...' : 'この科目で送る'}
            </button>
            <button onClick={() => setStep('cash')} disabled={busy} className="w-full py-2 mt-2 text-sm text-gray-500 hover:text-gray-700">
              ← 戻る
            </button>
          </div>
        )}

        <div className="text-right mt-4">
          <button onClick={onClose} className="px-4 py-2 bg-gray-200 text-gray-700 rounded text-sm">閉じる</button>
        </div>
      </div>
    </div>
  )
}
