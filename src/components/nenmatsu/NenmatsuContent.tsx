'use client'

import { useEffect, useState, useCallback, Fragment } from 'react'
import GlobalNav from '@/core/ui/GlobalNav'
import { hasRoom, setRoomPassphrase } from '@/core/room'
import { FISCAL_YEARS, defaultFiscalYearId } from '@/lib/nenmatsu/fiscal-year'
import { NENMATSU_DOC_TYPES, DOC_BY_KEY } from '@/lib/nenmatsu/document-types'
import {
  loadNenmatsuClients,
  loadCompanies,
  registerCompany,
  saveEmployees,
  loadEmployees,
  loadSubmissions,
  listEmployeeFiles,
  getFileBlobs,
  buildUploadUrl,
  type SharedClient,
  type NenmatsuCompany,
  type NenmatsuEmployee,
  type SubmissionRecord,
} from '@/lib/nenmatsu/store'
import { decodeShiftJis, parseJdlCsv } from '@/lib/nenmatsu/jdl-csv'

interface Row {
  client: SharedClient
  company: NenmatsuCompany
  submitted: number
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

/** 保存パス末尾(life_insurance_1.jpg)を「生命保険料控除証明書_1.jpg」に */
function niceFileName(path: string): string {
  const fn = path.split('/').pop() || path
  const m = fn.match(/^(.*)_(\d+)\.jpg$/i)
  if (m) return `${DOC_BY_KEY[m[1]]?.name || m[1]}_${m[2]}.jpg`
  return fn
}
function safe(name: string): string {
  return (name || '').replace(/[\\/:*?"<>|]/g, '_')
}

export default function NenmatsuContent() {
  const [ready, setReady] = useState(false)
  const [pass, setPass] = useState('')
  const [yearId, setYearId] = useState('R8')
  const [rows, setRows] = useState<Row[]>([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [qr, setQr] = useState<{ name: string; url: string; dataUrl: string } | null>(null)
  const [detail, setDetail] = useState<{ company: NenmatsuCompany } | null>(null)
  const [importCheck, setImportCheck] = useState<{ company: NenmatsuCompany } | null>(null)

  useEffect(() => {
    setReady(hasRoom())
    setYearId(defaultFiscalYearId(new Date().getFullYear()))
  }, [])

  const reload = useCallback(async () => {
    if (!hasRoom()) return
    setBusy(true)
    setMsg('')
    try {
      const clients = await loadNenmatsuClients()
      // 利用クライアントごとに会社（トークン）を自動用意
      await Promise.all(clients.map((c) => registerCompany(yearId, c)))
      const comps = await loadCompanies(yearId)
      const next: Row[] = []
      for (const c of clients) {
        const company = comps[c.id]
        if (!company) continue
        const subs = await loadSubmissions(yearId, c.id)
        next.push({ client: c, company, submitted: Object.keys(subs).length })
      }
      setRows(next)
    } catch (e) {
      setMsg('読み込みに失敗しました：' + (e instanceof Error ? e.message : ''))
    }
    setBusy(false)
  }, [yearId])

  useEffect(() => {
    if (ready) reload()
  }, [ready, yearId, reload])

  function saveRoom() {
    if (!pass.trim()) return
    setRoomPassphrase(pass.trim())
    setReady(true)
  }

  async function onCsv(clientId: string, file: File) {
    setBusy(true)
    setMsg('')
    try {
      const buf = await file.arrayBuffer()
      const { employees, skipped } = parseJdlCsv(decodeShiftJis(buf))
      if (!employees.length) {
        setMsg('従業員データを読み取れませんでした。JDLの年末調整CSVか確認してください。')
        setBusy(false)
        return
      }
      await saveEmployees(yearId, clientId, employees)
      await reload()
      setMsg(`従業員 ${employees.length}名を取り込みました（退職等で ${skipped}名を除外）。`)
    } catch (e) {
      setMsg('取込に失敗しました：' + (e instanceof Error ? e.message : ''))
    }
    setBusy(false)
  }

  async function showQr(company: NenmatsuCompany) {
    const url = await buildUploadUrl(yearId, company)
    const QRCode = (await import('qrcode')).default
    const dataUrl = await QRCode.toDataURL(url, { width: 280, margin: 1 })
    setQr({ name: company.name, url, dataUrl })
  }

  async function copyUrl(company: NenmatsuCompany) {
    const url = await buildUploadUrl(yearId, company)
    try {
      await navigator.clipboard.writeText(url)
      setMsg('アップロードURLをコピーしました。')
    } catch {
      window.prompt('URLをコピーしてください', url)
    }
  }

  if (!ready) {
    return (
      <div className="min-h-screen flex flex-col bg-gray-50">
        <GlobalNav currentKey="nenmatsu" />
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
            <button
              onClick={saveRoom}
              className="w-full py-2 bg-blue-600 text-white rounded font-semibold hover:bg-blue-700"
            >
              設定する
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <GlobalNav currentKey="nenmatsu" />
      <div className="flex-1 p-6 max-w-5xl w-full mx-auto">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <h1 className="text-xl font-bold text-gray-800">年末調整 — 控除証明書の回収</h1>
          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-500">年度</label>
            <select
              value={yearId}
              onChange={(e) => setYearId(e.target.value)}
              className="px-3 py-1.5 text-sm border border-gray-300 rounded"
            >
              {FISCAL_YEARS.map((y) => (
                <option key={y.id} value={y.id}>
                  {y.label}
                </option>
              ))}
            </select>
            <button
              onClick={reload}
              disabled={busy}
              className="px-3 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50"
            >
              更新
            </button>
          </div>
        </div>

        {msg && (
          <div className="mb-4 text-sm bg-blue-50 border border-blue-200 text-blue-800 rounded px-3 py-2">
            {msg}
          </div>
        )}

        <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 text-sm text-gray-500">
            「顧問先情報登録」で<strong>年末調整＝利用</strong>にした会社が表示されます。JDLのCSVで従業員を取り込み、URL/QRを配布してください。
          </div>
          {rows.length === 0 ? (
            <div className="p-6 text-center text-sm text-gray-500">
              対象会社がありません。「顧問先情報登録」で対象会社の<strong>年末調整</strong>を<strong>利用</strong>に設定してください。
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-gray-500">
                  <th className="text-left px-4 py-2 font-semibold">コード</th>
                  <th className="text-left px-4 py-2 font-semibold">会社名</th>
                  <th className="text-left px-4 py-2 font-semibold">従業員 / 提出</th>
                  <th className="text-right px-4 py-2 font-semibold">操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ client, company, submitted }) => (
                  <tr key={client.id} className="border-t border-gray-100">
                    <td className="px-4 py-3 text-gray-700">{client.code || '—'}</td>
                    <td className="px-4 py-3 font-medium text-gray-800">{client.name}</td>
                    <td className="px-4 py-3 text-gray-600">
                      従業員 {company.employeeCount ?? 0}名 ／ 提出{' '}
                      <span className="font-semibold text-blue-700">{submitted}</span>名
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 justify-end flex-wrap">
                        <label className="px-3 py-1.5 text-xs border border-gray-300 rounded hover:bg-gray-50 cursor-pointer">
                          CSV取込
                          <input
                            type="file"
                            accept=".csv,.txt"
                            className="hidden"
                            onChange={(e) => {
                              const f = e.target.files?.[0]
                              if (f) onCsv(client.id, f)
                              e.target.value = ''
                            }}
                          />
                        </label>
                        <button
                          onClick={() => copyUrl(company)}
                          className="px-3 py-1.5 text-xs border border-gray-300 rounded hover:bg-gray-50"
                        >
                          URLコピー
                        </button>
                        <button
                          onClick={() => showQr(company)}
                          className="px-3 py-1.5 text-xs border border-gray-300 rounded hover:bg-gray-50"
                        >
                          QR表示
                        </button>
                        <button
                          onClick={() => setImportCheck({ company })}
                          className="px-3 py-1.5 text-xs border border-gray-300 rounded hover:bg-gray-50"
                        >
                          取込内容確認
                        </button>
                        <button
                          onClick={() => setDetail({ company })}
                          className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700"
                        >
                          提出状況・閲覧
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <p className="text-xs text-gray-400 mt-4">
          ※ 写真アップロードには Firebase Storage（Blazeプラン）の有効化とセキュリティルール設定が必要です。マイナンバーの暗号収集・前年差分は順次追加します。
        </p>
      </div>

      {qr && (
        <Overlay onClose={() => setQr(null)}>
          <h2 className="font-bold text-gray-800 mb-1">{qr.name}</h2>
          <p className="text-xs text-gray-500 mb-3">従業員に配布するQRコード</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={qr.dataUrl} alt="QR" className="mx-auto mb-3" />
          <div className="text-[11px] text-gray-500 break-all bg-gray-50 rounded p-2">{qr.url}</div>
        </Overlay>
      )}

      {detail && (
        <CompanyDetail
          yearId={yearId}
          company={detail.company}
          onClose={() => setDetail(null)}
        />
      )}

      {importCheck && (
        <ImportCheck
          yearId={yearId}
          company={importCheck.company}
          onClose={() => setImportCheck(null)}
        />
      )}
    </div>
  )
}

function ImportCheck({
  yearId,
  company,
  onClose,
}: {
  yearId: string
  company: NenmatsuCompany
  onClose: () => void
}) {
  const [employees, setEmployees] = useState<NenmatsuEmployee[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [openId, setOpenId] = useState('')

  useEffect(() => {
    ;(async () => {
      setLoading(true)
      setErr('')
      try {
        const emp = await loadEmployees(yearId, company.clientId)
        emp.sort((a, b) => (a.kanaLast + a.kanaFirst).localeCompare(b.kanaLast + b.kanaFirst, 'ja'))
        setEmployees(emp)
      } catch (e) {
        setErr('読み込みに失敗しました：' + (e instanceof Error ? e.message : ''))
      } finally {
        setLoading(false)
      }
    })()
  }, [yearId, company.clientId])

  return (
    <Overlay onClose={onClose}>
      <h2 className="font-bold text-gray-800 mb-1">{company.name} — CSV取込内容の確認</h2>
      <p className="text-xs text-gray-500 mb-3">
        取り込んだ従業員 {employees.length}名。氏名をクリックすると、CSVの各列の内容（扶養親族情報を含む）を確認できます。
      </p>
      {err && (
        <div className="text-sm bg-red-50 border border-red-200 text-red-700 rounded px-3 py-2 mb-3">
          {err}
        </div>
      )}
      {loading ? (
        <p className="text-sm text-gray-500 py-6 text-center">読み込み中...</p>
      ) : employees.length === 0 ? (
        <p className="text-sm text-gray-500 py-6 text-center">
          従業員が未取込です。CSVを取り込んでください。
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 text-gray-500">
              <th className="text-left px-3 py-2">コード</th>
              <th className="text-left px-3 py-2">氏名 / フリガナ</th>
              <th className="text-left px-3 py-2">生年月日</th>
              <th className="text-left px-3 py-2">住所</th>
            </tr>
          </thead>
          <tbody>
            {employees.map((e) => (
              <Fragment key={e.id}>
                <tr
                  className="border-t border-gray-100 cursor-pointer hover:bg-blue-50/40"
                  onClick={() => setOpenId(openId === e.id ? '' : e.id)}
                >
                  <td className="px-3 py-2 text-gray-700">{e.code}</td>
                  <td className="px-3 py-2 text-gray-800">
                    {e.lastName} {e.firstName}
                    <div className="text-[11px] text-gray-400">
                      {e.kanaLast} {e.kanaFirst}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-gray-600">{e.birth || e.birthRaw || '—'}</td>
                  <td className="px-3 py-2 text-gray-600">{e.address || '—'}</td>
                </tr>
                {openId === e.id && (
                  <tr className="bg-gray-50">
                    <td colSpan={4} className="px-3 py-2">
                      <div className="text-[11px] text-gray-500 mb-1">
                        CSVの全列（列番号: 内容）。扶養親族や配偶者の列を確認できます。
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-0.5 max-h-64 overflow-auto">
                        {(e.rawCells || []).map((v, i) =>
                          v ? (
                            <div key={i} className="text-[11px] flex gap-1">
                              <span className="text-gray-400 shrink-0">{i}:</span>
                              <span className="text-gray-700 break-all">{v}</span>
                            </div>
                          ) : null,
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </Overlay>
  )
}

function Overlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl p-6 max-w-2xl w-full max-h-[85vh] overflow-auto"
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

function CompanyDetail({
  yearId,
  company,
  onClose,
}: {
  yearId: string
  company: NenmatsuCompany
  onClose: () => void
}) {
  const [employees, setEmployees] = useState<NenmatsuEmployee[]>([])
  const [subs, setSubs] = useState<Record<string, SubmissionRecord>>({})
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [files, setFiles] = useState<{ emp: string; items: { name: string; url: string }[] } | null>(
    null,
  )

  useEffect(() => {
    ;(async () => {
      setLoading(true)
      setErr('')
      try {
        const [emp, sub] = await Promise.all([
          loadEmployees(yearId, company.clientId),
          loadSubmissions(yearId, company.clientId),
        ])
        emp.sort((a, b) => (a.kanaLast + a.kanaFirst).localeCompare(b.kanaLast + b.kanaFirst, 'ja'))
        setEmployees(emp)
        setSubs(sub)
      } catch (e) {
        setErr('読み込みに失敗しました：' + (e instanceof Error ? e.message : ''))
      } finally {
        setLoading(false)
      }
    })()
  }, [yearId, company.clientId])

  const [zipMsg, setZipMsg] = useState('')

  async function viewFiles(emp: NenmatsuEmployee) {
    try {
      const items = await listEmployeeFiles(yearId, company.clientId, emp.id)
      setFiles({ emp: `${emp.lastName} ${emp.firstName}`, items })
    } catch (e) {
      alert('ファイルの取得に失敗しました：' + (e instanceof Error ? e.message : ''))
    }
  }

  async function downloadOne(emp: NenmatsuEmployee, rec: SubmissionRecord) {
    setZipMsg(`${emp.lastName}${emp.firstName} さんのファイルを準備中...`)
    try {
      const JSZip = (await import('jszip')).default
      const zip = new JSZip()
      const blobs = await getFileBlobs(rec.paths || [])
      blobs.forEach((b) => zip.file(niceFileName(b.name), b.blob))
      const out = await zip.generateAsync({ type: 'blob' })
      saveBlob(out, `${safe(company.name)}_${safe(emp.lastName + emp.firstName)}.zip`)
    } catch (e) {
      alert('一括ダウンロードに失敗しました：' + (e instanceof Error ? e.message : ''))
    }
    setZipMsg('')
  }

  async function downloadAll() {
    const targets = employees
      .map((e) => ({ e, rec: subs[e.id] }))
      .filter((x) => x.rec && (x.rec.paths || []).length > 0)
    if (!targets.length) {
      alert('ダウンロードできるファイルがありません。')
      return
    }
    try {
      const JSZip = (await import('jszip')).default
      const zip = new JSZip()
      let i = 0
      for (const { e, rec } of targets) {
        setZipMsg(`まとめています... (${++i}/${targets.length})`)
        const folder = zip.folder(safe(`${e.lastName}${e.firstName}`))
        const blobs = await getFileBlobs(rec.paths || [])
        blobs.forEach((b) => folder?.file(niceFileName(b.name), b.blob))
      }
      setZipMsg('ZIPを作成中...')
      const out = await zip.generateAsync({ type: 'blob' })
      saveBlob(out, `${safe(company.name)}_年末調整_${yearId}.zip`)
    } catch (e) {
      alert('一括ダウンロードに失敗しました：' + (e instanceof Error ? e.message : ''))
    }
    setZipMsg('')
  }

  return (
    <Overlay onClose={onClose}>
      <h2 className="font-bold text-gray-800 mb-1">{company.name} — 提出状況</h2>
      <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
        <p className="text-xs text-gray-500">
          提出済みの従業員はファイルをアプリ内で閲覧・人別/全員一括でダウンロードできます。
        </p>
        <button
          onClick={downloadAll}
          disabled={!!zipMsg}
          className="px-3 py-1.5 text-xs bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50 whitespace-nowrap"
        >
          全員のファイルを一括DL（ZIP）
        </button>
      </div>
      {zipMsg && (
        <div className="text-xs bg-blue-50 border border-blue-200 text-blue-800 rounded px-3 py-2 mb-2">
          {zipMsg}
        </div>
      )}
      {err && (
        <div className="text-sm bg-red-50 border border-red-200 text-red-700 rounded px-3 py-2 mb-3">
          {err}
        </div>
      )}
      {loading ? (
        <p className="text-sm text-gray-500 py-6 text-center">読み込み中...</p>
      ) : employees.length === 0 ? (
        <p className="text-sm text-gray-500 py-6 text-center">
          従業員が未取込です。CSVを取り込んでください。
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 text-gray-500">
              <th className="text-left px-3 py-2">氏名</th>
              <th className="text-left px-3 py-2">提出書類</th>
              <th className="text-right px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {employees.map((e) => {
              const rec = subs[e.id]
              return (
                <tr key={e.id} className="border-t border-gray-100">
                  <td className="px-3 py-2 text-gray-800">
                    {e.lastName} {e.firstName}
                  </td>
                  <td className="px-3 py-2 text-gray-600">
                    {rec ? (
                      Object.keys(rec.docs || {}).length ? (
                        Object.entries(rec.docs || {})
                          .map(([k, n]) => `${DOC_BY_KEY[k]?.name || k}(${n})`)
                          .join('、')
                      ) : (
                        <span className="text-gray-400">該当書類なしで提出</span>
                      )
                    ) : (
                      <span className="text-gray-300">未提出</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    {rec && (rec.paths || []).length > 0 && (
                      <span className="inline-flex gap-1.5">
                        <button
                          onClick={() => viewFiles(e)}
                          className="px-3 py-1 text-xs border border-gray-300 rounded hover:bg-gray-50"
                        >
                          ファイルを見る
                        </button>
                        <button
                          onClick={() => downloadOne(e, rec)}
                          disabled={!!zipMsg}
                          className="px-3 py-1 text-xs border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50"
                        >
                          一括DL
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      {files && (
        <div className="mt-4 border-t border-gray-200 pt-3">
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-semibold text-sm text-gray-800">{files.emp} 様 のファイル</h3>
            <button onClick={() => setFiles(null)} className="text-xs text-gray-500">
              閉じる
            </button>
          </div>
          {files.items.length === 0 ? (
            <p className="text-sm text-gray-500">ファイルがありません。</p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {files.items.map((f) => (
                <div key={f.name} className="border border-gray-200 rounded-lg overflow-hidden">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={f.url} alt={f.name} className="w-full h-32 object-cover bg-gray-50" />
                  <div className="flex items-center justify-between px-2 py-1.5 text-[11px]">
                    <span className="truncate">{f.name}</span>
                    <a
                      href={f.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      download={f.name}
                      className="text-blue-600 shrink-0 ml-1"
                    >
                      DL
                    </a>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Overlay>
  )
}
