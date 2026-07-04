'use client'

import { useEffect, useState, useCallback, useRef, Fragment } from 'react'
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
  loadFiles,
  setFileStatus,
  deleteScanFile,
  getScanFileBlob,
  markFileDownloaded,
  markFileDriveSaved,
  SCAN_FILE_RETENTION_DAYS,
  SCAN_FILE_MAX_BYTES,
  SCAN_FILE_MAX_TOTAL,
  type ScanFile,
  addScanMember,
  removeScanMember,
  buildScanUrlFromToken,
  sendInboxFile,
  loadInbox,
  deleteInboxFile,
  type ScanMember,
  type ScanInboxFile,
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
  const [counts, setCounts] = useState<Record<string, { batch: number; cash: number; file: number }>>({})
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [qr, setQr] = useState<{ name: string; url: string; dataUrl: string } | null>(null)
  const [inbox, setInbox] = useState<{ client: SharedClient; company: ScanCompany } | null>(null)
  const [membersFor, setMembersFor] = useState<{ client: SharedClient; company: ScanCompany } | null>(null)

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
      const nextCounts: Record<string, { batch: number; cash: number; file: number }> = {}
      await Promise.all(
        Object.values(comps).map(async (c) => {
          try {
            // 保存期間（画像1年・ファイル90日）を過ぎたデータを自動削除してから件数を数える
            try { await sweepOldScanData(c.token) } catch { /* 権限エラー等は下で表示される */ }
            for (const m of Object.values(c.members || {})) {
              try { await sweepOldScanData(m.token) } catch { /* ignore */ }
            }
            const [batches, cash, files] = await Promise.all([
              loadBatches(c.token),
              loadCashEntries(c.token),
              loadFiles(c.token),
            ])
            nextCounts[c.clientId] = {
              batch: Object.values(batches).filter((b) => b.status !== 'done').length,
              cash: Object.values(cash).filter((c2) => c2.status !== 'done').length,
              file: Object.values(files).filter((f) => f.status !== 'done').length,
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
                  <th className="text-left px-4 py-2 font-semibold">未処理ファイル</th>
                  <th className="text-right px-4 py-2 font-semibold">操作</th>
                </tr>
              </thead>
              <tbody>
                {clients.map((client) => {
                  const company = companies[client.id]
                  if (!company) return null
                  const cnt = counts[client.id] || { batch: 0, cash: 0, file: 0 }
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
                        <span className="font-semibold text-blue-700">{cnt.file}</span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 justify-end flex-wrap">
                          <button onClick={() => copyUrl(company)} className="px-3 py-1.5 text-xs border border-gray-300 rounded hover:bg-gray-50">
                            URLコピー
                          </button>
                          <button onClick={() => showQr(company)} className="px-3 py-1.5 text-xs border border-gray-300 rounded hover:bg-gray-50">
                            QR表示
                          </button>
                          <button onClick={() => setMembersFor({ client, company })} className="px-3 py-1.5 text-xs border border-gray-300 rounded hover:bg-gray-50">
                            👥 メンバー{company.members && Object.keys(company.members).length ? `（${Object.keys(company.members).length}）` : ''}
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

      {membersFor && (
        <MembersDialog
          client={membersFor.client}
          company={membersFor.company}
          onClose={() => setMembersFor(null)}
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
  const [tab, setTab] = useState<'batches' | 'cash' | 'files'>('batches')
  const [batches, setBatches] = useState<Record<string, ScanBatch>>({})
  const [cash, setCash] = useState<Record<string, ScanCashEntry>>({})
  const [files, setFiles] = useState<Record<string, ScanFile>>({})
  const [fileDriveOpen, setFileDriveOpen] = useState(false)
  const [fileMsg, setFileMsg] = useState('')
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [openBatch, setOpenBatch] = useState<ScanBatch | null>(null)
  const [showDone, setShowDone] = useState(false)
  const [analyses, setAnalyses] = useState<Record<string, ScanAnalysis>>({})

  const load = useCallback(async () => {
    setLoading(true)
    setErr('')
    try {
      const [b, c, a, f] = await Promise.all([
        loadBatches(company.token),
        loadCashEntries(company.token),
        loadAnalyses(company.token),
        loadFiles(company.token),
      ])
      setBatches(b)
      setCash(c)
      setAnalyses(a)
      setFiles(f)
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
          <button
            onClick={() => setTab('files')}
            className={`px-3 py-1.5 text-sm rounded ${tab === 'files' ? 'bg-blue-600 text-white' : 'border border-gray-300 text-gray-600'}`}
          >
            📎 ファイル
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
                    {b.member && <span className="ml-1 text-[10px] text-purple-700 bg-purple-50 border border-purple-200 rounded px-1.5 py-0.5">👤{b.member}</span>}
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
      ) : tab === 'files' ? (
        <FilesTab
          client={client}
          company={company}
          files={files}
          showDone={showDone}
          msg={fileMsg}
          setMsg={setFileMsg}
          driveOpen={fileDriveOpen}
          setDriveOpen={setFileDriveOpen}
          onChanged={async () => {
            await load()
            onChanged()
          }}
        />
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
                    {c.member && <span className="ml-1 text-[10px] text-purple-700 bg-purple-50 border border-purple-200 rounded px-1.5 py-0.5">👤{c.member}</span>}
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

  // 書類種類ごとの表の列定義（key=行データのフィールド、num=数値入力）
  type ColSpec = { key: keyof ReceiptRow; label: string; num?: boolean; w: string }
  const COLSPECS: Record<ScanAnalysisKind, ColSpec[]> = {
    receipt: [
      { key: 'date', label: '日付', w: 'w-24' },
      { key: 'storeName', label: '店名', w: 'w-28' },
      { key: 'mainContent', label: '内容', w: 'w-28' },
      { key: 'invoiceNumber', label: 'インボイス番号', w: 'w-24' },
      { key: 'taxRate', label: '税率', w: 'w-14' },
      { key: 'totalAmount', label: '税込金額', num: true, w: 'w-20' },
    ],
    'invoice-sales': [
      { key: 'date', label: '請求日', w: 'w-24' },
      { key: 'storeName', label: '請求先（宛名）', w: 'w-32' },
      { key: 'mainContent', label: '内容', w: 'w-28' },
      { key: 'taxRate', label: '税率', w: 'w-14' },
      { key: 'totalAmount', label: '税込金額', num: true, w: 'w-20' },
    ],
    'invoice-purchase': [
      { key: 'date', label: '請求日', w: 'w-24' },
      { key: 'storeName', label: '請求元（発行者）', w: 'w-32' },
      { key: 'mainContent', label: '内容', w: 'w-28' },
      { key: 'invoiceNumber', label: 'インボイス番号', w: 'w-24' },
      { key: 'taxRate', label: '税率', w: 'w-14' },
      { key: 'totalAmount', label: '税込金額', num: true, w: 'w-20' },
    ],
    'credit-card': [
      { key: 'date', label: '利用日', w: 'w-24' },
      { key: 'storeName', label: '利用店名', w: 'w-36' },
      { key: 'mainContent', label: '備考', w: 'w-28' },
      { key: 'totalAmount', label: '金額', num: true, w: 'w-20' },
    ],
    passbook: [
      { key: 'date', label: '日付', w: 'w-24' },
      { key: 'storeName', label: '摘要', w: 'w-36' },
      { key: 'deposit', label: '入金', num: true, w: 'w-20' },
      { key: 'withdrawal', label: '出金', num: true, w: 'w-20' },
      { key: 'balance', label: '残高', num: true, w: 'w-24' },
    ],
    cashbook: [
      { key: 'date', label: '日付', w: 'w-24' },
      { key: 'storeName', label: '摘要', w: 'w-36' },
      { key: 'deposit', label: '入金', num: true, w: 'w-20' },
      { key: 'withdrawal', label: '出金', num: true, w: 'w-20' },
      { key: 'balance', label: '残高', num: true, w: 'w-24' },
    ],
    loan: [
      { key: 'date', label: '返済日', w: 'w-24' },
      { key: 'totalAmount', label: '返済額', num: true, w: 'w-20' },
      { key: 'deposit', label: 'うち元金', num: true, w: 'w-20' },
      { key: 'withdrawal', label: 'うち利息', num: true, w: 'w-20' },
      { key: 'balance', label: '返済後残高', num: true, w: 'w-24' },
    ],
    lease: [
      { key: 'date', label: '支払日', w: 'w-24' },
      { key: 'totalAmount', label: '支払額', num: true, w: 'w-20' },
      { key: 'mainContent', label: '備考', w: 'w-32' },
      { key: 'balance', label: '残額・残回数', num: true, w: 'w-24' },
    ],
  }
  const colSpecs = COLSPECS[kind || 'receipt']

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

  // 行データ → 出力用の値（未入力の数値は空欄）
  function cellValue(r: ReceiptRow, key: keyof ReceiptRow): string | number {
    const v = r[key]
    if (v == null) return ''
    return v as string | number
  }

  async function exportExcel() {
    const XLSX = await import('xlsx')
    const aoa: (string | number)[][] = []
    if (kind === 'credit-card' && meta) {
      aoa.push(['引落日', meta.paymentDate || '', '引落総額', meta.totalAmount || 0, 'カード名', meta.cardName || ''])
    }
    if ((kind === 'loan' || kind === 'lease') && meta) {
      aoa.push([kind === 'loan' ? '金融機関' : 'リース会社', meta.partyName || '', kind === 'loan' ? '契約' : '物件', meta.title || ''])
    }
    aoa.push(colSpecs.map((c) => c.label))
    for (const r of rows) aoa.push(colSpecs.map((c) => cellValue(r, c.key)))
    const ws = XLSX.utils.aoa_to_sheet(aoa)
    ws['!cols'] = colSpecs.map(() => ({ wch: 16 }))
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, '解析結果')
    XLSX.writeFile(wb, `${fileBase()}.xlsx`)
  }

  function exportCsv() {
    const lines = [colSpecs.map((c) => c.label).join(',')]
    for (const r of rows) {
      lines.push(colSpecs.map((c) => `"${String(cellValue(r, c.key)).replace(/"/g, '""')}"`).join(','))
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
            {(kind === 'loan' || kind === 'lease') && meta && (meta.partyName || meta.title) && (
              <div className="text-xs bg-blue-50 border border-blue-200 text-blue-800 rounded px-3 py-2 mb-2">
                {kind === 'loan' ? '🏦' : '📄'} {meta.partyName || '—'}{meta.title ? `／${meta.title}` : ''}
              </div>
            )}
            {(kind === 'passbook' || kind === 'cashbook') && meta?.corrections?.length ? (
              <div className="text-xs bg-amber-50 border border-amber-200 text-amber-800 rounded px-3 py-2 mb-2">
                ⚠️ 残高整合チェックで自動補正した行があります：{meta.corrections.join('、')}
              </div>
            ) : null}

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
                      {colSpecs.map((c) => (
                        <th key={c.key} className={`px-2 py-1.5 ${c.num ? 'text-right' : 'text-left'}`}>{c.label}</th>
                      ))}
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
                        {colSpecs.map((c) => (
                          <td key={c.key} className="px-1 py-1">
                            {c.num ? (
                              <input
                                value={r[c.key] == null ? '' : String(r[c.key])}
                                onChange={(e) => {
                                  const t = e.target.value.replace(/[^\d.-]/g, '')
                                  updateRow(i, { [c.key]: t === '' ? (c.key === 'totalAmount' ? 0 : null) : Number(t) } as Partial<ReceiptRow>)
                                }}
                                className={`${c.w} px-1 py-1 border border-gray-200 rounded text-right`}
                              />
                            ) : (
                              <input
                                value={(r[c.key] as string) || ''}
                                onChange={(e) => updateRow(i, { [c.key]: e.target.value } as Partial<ReceiptRow>)}
                                className={`${c.w} px-1 py-1 border border-gray-200 rounded`}
                              />
                            )}
                          </td>
                        ))}
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

/** 受信箱の「📎 ファイル」タブ（ファイル便）。DL・ZIP一括DL・Drive保存・処理済み管理・削除。
 *  削除は受け渡し箱（Firebase上のコピー）のみで、顧問先の元ファイルには影響しない。 */
function FilesTab({
  client,
  company,
  files,
  showDone,
  msg,
  setMsg,
  driveOpen,
  setDriveOpen,
  onChanged,
}: {
  client: SharedClient
  company: ScanCompany
  files: Record<string, ScanFile>
  showDone: boolean
  msg: string
  setMsg: (m: string) => void
  driveOpen: boolean
  setDriveOpen: (v: boolean) => void
  onChanged: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [sendOpen, setSendOpen] = useState(false)
  const [sentRefresh, setSentRefresh] = useState(0)

  const list = Object.values(files)
    .filter((f) => showDone || f.status !== 'done')
    .sort((a, b) => (a.folder || '').localeCompare(b.folder || '', 'ja') || b.submittedAt.localeCompare(a.submittedAt))

  // フォルダごとにグループ化（顧問先が付けたサブフォルダ。無しは末尾）
  const groups: { folder: string; items: ScanFile[] }[] = []
  for (const f of list) {
    const key = f.folder || ''
    const g = groups.find((x) => x.folder === key)
    if (g) g.items.push(f)
    else groups.push({ folder: key, items: [f] })
  }
  groups.sort((a, b) => (a.folder === '' ? 1 : b.folder === '' ? -1 : a.folder.localeCompare(b.folder, 'ja')))

  function fmtSize(bytes: number): string {
    if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + 'MB'
    return Math.max(1, Math.round(bytes / 1024)) + 'KB'
  }

  // 削除までの残り日数（90日保存）
  function daysLeft(f: ScanFile): number {
    const t = Date.parse(f.submittedAt || '')
    if (!t) return 999
    return Math.ceil((t + SCAN_FILE_RETENTION_DAYS * 24 * 3600 * 1000 - Date.now()) / (24 * 3600 * 1000))
  }

  function isNew(f: ScanFile): boolean {
    return !f.downloadedAt && !f.driveSavedAt && f.status !== 'done'
  }

  async function downloadOne(f: ScanFile) {
    setBusy(true)
    setMsg('')
    try {
      const blob = await getScanFileBlob(f)
      downloadBlob(blob, f.name)
      try { await markFileDownloaded(company.token, f.id) } catch { /* ignore */ }
      await onChanged()
    } catch (e) {
      setMsg('ダウンロードに失敗しました：' + (e instanceof Error ? e.message : ''))
    }
    setBusy(false)
  }

  async function downloadZip() {
    if (!list.length) return
    setBusy(true)
    setMsg('')
    try {
      const JSZip = (await import('jszip')).default
      const zip = new JSZip()
      for (let i = 0; i < list.length; i++) {
        setMsg(`まとめています... (${i + 1}/${list.length})`)
        const blob = await getScanFileBlob(list[i])
        if (list[i].folder) zip.folder(safe(list[i].folder!))?.file(list[i].name, blob)
        else zip.file(list[i].name, blob)
      }
      setMsg('ZIPを作成中...')
      const out = await zip.generateAsync({ type: 'blob' })
      downloadBlob(out, `${safe(client.name)}_ファイル便_${new Date().toISOString().slice(0, 10)}.zip`)
      setMsg('')
      // 含まれた全ファイルにDL済みマーク
      for (const f of list) {
        try { await markFileDownloaded(company.token, f.id) } catch { /* ignore */ }
      }
      await onChanged()
    } catch (e) {
      setMsg('一括ダウンロードに失敗しました：' + (e instanceof Error ? e.message : ''))
    }
    setBusy(false)
  }

  async function toggleDone(f: ScanFile) {
    try {
      await setFileStatus(company.token, f.id, f.status === 'done' ? 'new' : 'done')
      await onChanged()
    } catch (e) {
      alert('更新に失敗しました：' + (e instanceof Error ? e.message : ''))
    }
  }

  async function removeOne(f: ScanFile) {
    if (!confirm(`「${f.name}」を削除しますか？\n（受け渡し箱のコピーが消えるだけで、顧問先の元ファイルには影響しません）`)) return
    try {
      await deleteScanFile(company.token, f)
      await onChanged()
    } catch (e) {
      alert('削除に失敗しました：' + (e instanceof Error ? e.message : ''))
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
        <p className="text-xs text-gray-500">送信から90日で自動削除されます。長期保管するものはDLまたはDriveへ退避してください。</p>
        <div className="flex gap-2">
          <button
            onClick={() => setSendOpen(true)}
            className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            📤 顧問先へ送る
          </button>
          <button
            onClick={() => setDriveOpen(true)}
            disabled={busy || list.length === 0}
            className="px-3 py-1.5 text-xs border border-emerald-300 text-emerald-700 rounded hover:bg-emerald-50 disabled:opacity-50"
          >
            📁 Driveへ保存
          </button>
          <button
            onClick={downloadZip}
            disabled={busy || list.length === 0}
            className="px-3 py-1.5 text-xs bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50"
          >
            一括DL（ZIP）
          </button>
        </div>
      </div>

      {msg && <div className="text-xs bg-blue-50 border border-blue-200 text-blue-800 rounded px-3 py-2 mb-2">{msg}</div>}

      {list.length === 0 ? (
        <p className="text-sm text-gray-500 py-6 text-center">ファイルがありません。</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 text-gray-500">
              <th className="text-left px-3 py-2">ファイル名</th>
              <th className="text-right px-3 py-2">サイズ</th>
              <th className="text-left px-3 py-2">送信日時</th>
              <th className="text-left px-3 py-2">状態</th>
              <th className="text-right px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <Fragment key={g.folder || '_none'}>
                {g.folder && (
                  <tr className="bg-gray-50/70 border-t border-gray-200">
                    <td colSpan={5} className="px-3 py-1.5 text-xs font-semibold text-gray-600">📂 {g.folder}</td>
                  </tr>
                )}
                {g.items.map((f) => {
                  const left = daysLeft(f)
                  return (
                    <tr key={f.id} className="border-t border-gray-100">
                      <td className="px-3 py-2 text-gray-800">
                        {g.folder ? <span className="text-gray-300 mr-1">└</span> : null}📄 {f.name}
                        <span className="inline-flex gap-1 ml-2 align-middle">
                          {f.member && <span className="text-[10px] text-purple-700 bg-purple-50 border border-purple-200 rounded px-1.5 py-0.5">👤{f.member}</span>}
                          {isNew(f) && <span className="text-[10px] font-bold text-white bg-red-500 rounded px-1.5 py-0.5">新着</span>}
                          {f.downloadedAt && (
                            <span className="text-[10px] text-blue-700 bg-blue-50 border border-blue-200 rounded px-1.5 py-0.5" title={`DL: ${new Date(f.downloadedAt).toLocaleString('ja-JP')}`}>
                              ⬇ DL済
                            </span>
                          )}
                          {f.driveSavedAt && (
                            <span className="text-[10px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1.5 py-0.5" title={`Drive保存: ${new Date(f.driveSavedAt).toLocaleString('ja-JP')}`}>
                              📁 Drive済
                            </span>
                          )}
                          {left <= 10 && (
                            <span className="text-[10px] font-bold text-red-700 bg-red-50 border border-red-300 rounded px-1.5 py-0.5">
                              🗑 あと{Math.max(0, left)}日で削除
                            </span>
                          )}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right text-gray-600">{fmtSize(f.size)}</td>
                      <td className="px-3 py-2 text-gray-600">{new Date(f.submittedAt).toLocaleString('ja-JP')}</td>
                      <td className="px-3 py-2">
                        {f.status === 'done' ? (
                          <span className="text-xs text-green-700 bg-green-50 rounded px-2 py-0.5">処理済み</span>
                        ) : (
                          <span className="text-xs text-amber-700 bg-amber-50 rounded px-2 py-0.5">未処理</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        <span className="inline-flex gap-1.5">
                          <button onClick={() => downloadOne(f)} disabled={busy} className="px-3 py-1 text-xs border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50">
                            DL
                          </button>
                          <button onClick={() => toggleDone(f)} className="px-3 py-1 text-xs border border-gray-300 rounded hover:bg-gray-50">
                            {f.status === 'done' ? '未処理に戻す' : '処理済みにする'}
                          </button>
                          <button onClick={() => removeOne(f)} className="px-3 py-1 text-xs border border-red-300 text-red-600 rounded hover:bg-red-50">
                            削除
                          </button>
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}

      <SentFilesSection company={company} refresh={sentRefresh} />

      {sendOpen && (
        <SendFilesDialog
          client={client}
          company={company}
          onClose={() => setSendOpen(false)}
          onSent={() => setSentRefresh((v) => v + 1)}
        />
      )}

      {driveOpen && (
        <DriveSaveDialog
          title={`${client.name}／ファイル便の${list.length}件を共有ドライブに保存します（フォルダ付きはサブフォルダに振り分け）`}
          getFiles={async (onProgress) => {
            const out: { name: string; blob: Blob; folder?: string }[] = []
            for (let i = 0; i < list.length; i++) {
              onProgress(`ファイルを取得しています... (${i + 1}/${list.length}) ${list[i].name}`)
              out.push({ name: list[i].name, blob: await getScanFileBlob(list[i]), folder: list[i].folder })
            }
            return out
          }}
          onSaved={async () => {
            // 保存に成功した全ファイルへDrive保存済みマーク
            for (const f of list) {
              try { await markFileDriveSaved(company.token, f.id) } catch { /* ignore */ }
            }
            await onChanged()
          }}
          onClose={() => setDriveOpen(false)}
        />
      )}
    </div>
  )
}

/** メンバー別URLの管理（宛先制御用）。追加・URLコピー・QR・削除 */
function MembersDialog({
  client,
  company,
  onClose,
  onChanged,
}: {
  client: SharedClient
  company: ScanCompany
  onClose: () => void
  onChanged: () => void
}) {
  const [members, setMembers] = useState<ScanMember[]>(Object.values(company.members || {}))
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [qr, setQr] = useState<{ name: string; url: string; dataUrl: string } | null>(null)

  async function add() {
    const name = newName.trim()
    if (!name) return
    if (members.some((m) => m.name === name)) {
      setMsg('同じ名前のメンバーが既にいます。')
      return
    }
    setBusy(true)
    setMsg('')
    try {
      const m = await addScanMember(company, name)
      setMembers((prev) => [...prev, m])
      setNewName('')
      onChanged()
    } catch (e) {
      setMsg('追加に失敗しました：' + (e instanceof Error ? e.message : ''))
    }
    setBusy(false)
  }

  async function remove(m: ScanMember) {
    if (!confirm(`メンバー「${m.name}」を削除しますか？\n・このメンバーのURLは使えなくなります\n・このメンバー宛の未受領ファイルも削除されます`)) return
    setBusy(true)
    try {
      await removeScanMember(client.id, m)
      setMembers((prev) => prev.filter((x) => x.id !== m.id))
      onChanged()
    } catch (e) {
      setMsg('削除に失敗しました：' + (e instanceof Error ? e.message : ''))
    }
    setBusy(false)
  }

  async function copyUrl(m: ScanMember) {
    const url = buildScanUrlFromToken(m.token)
    try {
      await navigator.clipboard.writeText(url)
      setMsg(`${m.name} さんのURLをコピーしました。`)
    } catch {
      window.prompt('URLをコピーしてください', url)
    }
  }

  async function showQr(m: ScanMember) {
    const url = buildScanUrlFromToken(m.token)
    const QRCode = (await import('qrcode')).default
    const dataUrl = await QRCode.toDataURL(url, { width: 280, margin: 1 })
    setQr({ name: `${client.name}／${m.name}`, url, dataUrl })
  }

  return (
    <Overlay onClose={onClose}>
      <h2 className="font-bold text-gray-800 mb-1">{client.name} — メンバー別URL</h2>
      <p className="text-xs text-gray-500 mb-3 leading-relaxed">
        メンバーごとに専用URLを発行できます。ファイル送信時に宛先を選ぶと、<b>その人のURLでしか見られません</b>（全員宛は会社URL・全メンバーで閲覧可）。
        誰が送信・受領したかも名前で表示されます。
      </p>

      {msg && <div className="text-xs bg-blue-50 border border-blue-200 text-blue-800 rounded px-3 py-2 mb-3">{msg}</div>}

      <div className="flex gap-2 mb-4">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') add() }}
          placeholder="メンバー名（例：社長、経理担当）"
          className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-lg"
        />
        <button onClick={add} disabled={busy || !newName.trim()} className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap">
          ＋ 追加
        </button>
      </div>

      {members.length === 0 ? (
        <p className="text-sm text-gray-500 py-4 text-center">メンバーがいません（会社URLのみの運用）。</p>
      ) : (
        <ul className="divide-y divide-gray-100 border border-gray-200 rounded-lg overflow-hidden">
          {members.map((m) => (
            <li key={m.id} className="flex items-center justify-between px-4 py-2.5">
              <span className="text-sm font-medium text-gray-800">👤 {m.name}</span>
              <span className="inline-flex gap-1.5">
                <button onClick={() => copyUrl(m)} className="px-3 py-1 text-xs border border-gray-300 rounded hover:bg-gray-50">URLコピー</button>
                <button onClick={() => showQr(m)} className="px-3 py-1 text-xs border border-gray-300 rounded hover:bg-gray-50">QR表示</button>
                <button onClick={() => remove(m)} disabled={busy} className="px-3 py-1 text-xs border border-red-300 text-red-600 rounded hover:bg-red-50 disabled:opacity-50">削除</button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {qr && (
        <div className="mt-4 border-t border-gray-200 pt-3 text-center">
          <div className="text-sm font-semibold text-gray-800 mb-2">{qr.name}</div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={qr.dataUrl} alt="QR" className="mx-auto mb-2" />
          <div className="text-[11px] text-gray-500 break-all bg-gray-50 rounded p-2">{qr.url}</div>
          <button onClick={() => setQr(null)} className="mt-2 text-xs text-gray-500">QRを閉じる</button>
        </div>
      )}
    </Overlay>
  )
}

/** 事務所→顧問先のファイル送信ダイアログ（宛先選択つき） */
function SendFilesDialog({
  client,
  company,
  onClose,
  onSent,
}: {
  client: SharedClient
  company: ScanCompany
  onClose: () => void
  onSent: () => void
}) {
  const members = Object.values(company.members || {})
  const [files, setFiles] = useState<File[]>([])
  const [drag, setDrag] = useState(false)
  const [folder, setFolder] = useState('')
  const [toAll, setToAll] = useState(true)
  const [toMembers, setToMembers] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [err, setErr] = useState('')
  const [done, setDone] = useState('')

  function addFiles(list: FileList | File[] | null) {
    if (!list || !list.length) return
    const arr = Array.from(list)
    setErr('')
    const tooBig = arr.filter((f) => f.size > SCAN_FILE_MAX_BYTES)
    if (tooBig.length) {
      setErr(`${tooBig.map((f) => f.name).join('、')} は大きすぎます（1ファイル50MBまで）。`)
      return
    }
    setFiles((prev) => {
      const next = [...prev, ...arr]
      if (next.reduce((s, f) => s + f.size, 0) > SCAN_FILE_MAX_TOTAL) {
        setErr('1回の送信は合計200MBまでです。分けて送信してください。')
        return prev
      }
      return next
    })
  }

  async function send() {
    const recipients: { name: string; token: string }[] = []
    if (toAll) recipients.push({ name: '全員', token: company.token })
    for (const m of members) if (toMembers.has(m.id)) recipients.push({ name: m.name, token: m.token })
    if (!recipients.length) {
      setErr('宛先を選択してください。')
      return
    }
    if (!files.length) {
      setErr('ファイルを追加してください。')
      return
    }
    setBusy(true)
    setErr('')
    setDone('')
    try {
      let n = 0
      const total = files.length * recipients.length
      for (const r of recipients) {
        for (const f of files) {
          setProgress(`送信中... (${++n}/${total}) ${r.name}宛：${f.name}`)
          await sendInboxFile(r.token, f, f.name, folder)
        }
      }
      setDone(`✅ ${files.length}件を ${recipients.map((r) => r.name).join('・')} 宛に送信しました。`)
      setFiles([])
      onSent()
    } catch (e) {
      setErr('送信に失敗しました：' + (e instanceof Error ? e.message : ''))
    }
    setBusy(false)
    setProgress('')
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[70] p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl p-6 w-full max-w-lg max-h-[85vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <h3 className="font-bold text-gray-800 mb-1">📤 {client.name} へファイルを送る</h3>
        <p className="text-xs text-gray-500 mb-3">送信から90日で自動削除されます。顧問先の受け取り（DL）状況は送信済み一覧で確認できます。</p>

        <div className="mb-3">
          <div className="text-xs font-semibold text-gray-600 mb-1">宛先</div>
          <label className="flex items-center gap-2 text-sm mb-1">
            <input type="checkbox" checked={toAll} onChange={(e) => setToAll(e.target.checked)} />
            全員宛（会社URLと全メンバーが閲覧可）
          </label>
          {members.map((m) => (
            <label key={m.id} className="flex items-center gap-2 text-sm mb-1">
              <input
                type="checkbox"
                checked={toMembers.has(m.id)}
                onChange={(e) => {
                  setToMembers((prev) => {
                    const next = new Set(prev)
                    if (e.target.checked) next.add(m.id)
                    else next.delete(m.id)
                    return next
                  })
                }}
              />
              👤 {m.name} 宛（この人のURLでのみ閲覧可）
            </label>
          ))}
          {members.length === 0 && (
            <p className="text-[11px] text-gray-400">※ メンバー宛にしたい場合は、先に「👥 メンバー」からメンバーURLを発行してください。</p>
          )}
        </div>

        <label className="block text-xs text-gray-500 mb-1">📂 フォルダ名（任意）</label>
        <input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="例：2026年3月 月次報告" className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg mb-3" />

        <div
          onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); addFiles(e.dataTransfer?.files || null) }}
          className={`border-2 border-dashed rounded-xl p-5 text-center mb-3 ${drag ? 'border-blue-500 bg-blue-50' : 'border-gray-300 bg-gray-50'}`}
        >
          <p className="text-sm text-gray-600 mb-2">ここにファイルをドラッグ＆ドロップ</p>
          <label className="inline-block px-4 py-2 text-sm bg-blue-600 text-white rounded-lg font-semibold cursor-pointer">
            ファイルを選択
            <input type="file" multiple className="hidden" onChange={(e) => { addFiles(e.target.files); e.target.value = '' }} />
          </label>
        </div>

        {files.length > 0 && (
          <ul className="mb-3 space-y-1">
            {files.map((f, i) => (
              <li key={i} className="flex items-center justify-between text-xs bg-gray-50 rounded px-2 py-1.5">
                <span className="truncate mr-2">📄 {f.name}</span>
                <button onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))} className="text-red-500 shrink-0">×</button>
              </li>
            ))}
          </ul>
        )}

        {err && <div className="text-xs text-red-600 mb-2 break-words">{err}</div>}
        {done && <div className="text-sm font-semibold text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2 mb-2">{done}</div>}

        <button onClick={send} disabled={busy || files.length === 0} className="w-full py-3 bg-green-600 text-white rounded-lg font-semibold hover:bg-green-700 disabled:opacity-60">
          {busy ? progress || '送信中...' : '送信する'}
        </button>

        <div className="text-right mt-4">
          <button onClick={onClose} className="px-4 py-2 bg-gray-200 text-gray-700 rounded text-sm">閉じる</button>
        </div>
      </div>
    </div>
  )
}

/** 事務所→顧問先の送信済み一覧（受領確認・削除） */
function SentFilesSection({ company, refresh }: { company: ScanCompany; refresh: number }) {
  const [rows, setRows] = useState<{ recipient: string; token: string; file: ScanInboxFile }[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    const out: { recipient: string; token: string; file: ScanInboxFile }[] = []
    try {
      const shared = await loadInbox(company.token)
      for (const f of Object.values(shared)) out.push({ recipient: '全員', token: company.token, file: f })
      for (const m of Object.values(company.members || {})) {
        try {
          const inbox = await loadInbox(m.token)
          for (const f of Object.values(inbox)) out.push({ recipient: m.name, token: m.token, file: f })
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    out.sort((a, b) => b.file.sentAt.localeCompare(a.file.sentAt))
    setRows(out)
    setLoading(false)
  }, [company])

  useEffect(() => {
    load()
  }, [load, refresh])

  async function remove(row: { recipient: string; token: string; file: ScanInboxFile }) {
    if (!confirm(`「${row.file.name}」（${row.recipient}宛）を取り消しますか？顧問先のページから見えなくなります。`)) return
    try {
      await deleteInboxFile(row.token, row.file)
      await load()
    } catch (e) {
      alert('削除に失敗しました：' + (e instanceof Error ? e.message : ''))
    }
  }

  if (loading) return <p className="text-xs text-gray-400 py-3">送信済み一覧を読み込み中...</p>
  if (!rows.length) return null

  return (
    <div className="mt-5 border-t border-gray-200 pt-3">
      <h4 className="text-sm font-semibold text-gray-700 mb-2">📤 送信済み（事務所→顧問先）</h4>
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-gray-50 text-gray-500">
            <th className="text-left px-3 py-1.5">宛先</th>
            <th className="text-left px-3 py-1.5">ファイル名</th>
            <th className="text-left px-3 py-1.5">送信日</th>
            <th className="text-left px-3 py-1.5">受領状況</th>
            <th className="text-right px-3 py-1.5"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const dls = Object.keys(row.file.downloads || {})
            return (
              <tr key={row.token + row.file.id} className="border-t border-gray-100">
                <td className="px-3 py-1.5 text-gray-700">{row.recipient}</td>
                <td className="px-3 py-1.5 text-gray-800">
                  {row.file.folder ? `📂${row.file.folder}／` : ''}📄 {row.file.name}
                </td>
                <td className="px-3 py-1.5 text-gray-600">{new Date(row.file.sentAt).toLocaleDateString('ja-JP')}</td>
                <td className="px-3 py-1.5">
                  {dls.length ? (
                    <span className="text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1.5 py-0.5" title={dls.map((k) => `${k}: ${new Date((row.file.downloads || {})[k]).toLocaleString('ja-JP')}`).join('\n')}>
                      ✅ 受領済み（{dls.join('、')}）
                    </span>
                  ) : (
                    <span className="text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">未受領</span>
                  )}
                </td>
                <td className="px-3 py-1.5 text-right">
                  <button onClick={() => remove(row)} className="px-2 py-0.5 text-xs border border-red-300 text-red-600 rounded hover:bg-red-50">取消</button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
