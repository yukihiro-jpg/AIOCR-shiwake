'use client'

import { useEffect, useState, useCallback } from 'react'
import GlobalNav from '@/core/ui/GlobalNav'
import { hasRoom, setRoomPassphrase } from '@/core/room'
import { FISCAL_YEARS, defaultFiscalYearId } from '@/lib/nenmatsu/fiscal-year'
import {
  loadSharedClients,
  loadCompanies,
  registerCompany,
  unregisterCompany,
  saveEmployees,
  loadEmployees,
  buildUploadUrl,
  type SharedClient,
  type NenmatsuCompany,
} from '@/lib/nenmatsu/store'
import { decodeShiftJis, parseJdlCsv } from '@/lib/nenmatsu/jdl-csv'

export default function NenmatsuContent() {
  const [ready, setReady] = useState(false)
  const [pass, setPass] = useState('')
  const [yearId, setYearId] = useState('R8')
  const [clients, setClients] = useState<SharedClient[]>([])
  const [companies, setCompanies] = useState<Record<string, NenmatsuCompany>>({})
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [qr, setQr] = useState<{ name: string; url: string; dataUrl: string } | null>(null)

  useEffect(() => {
    setReady(hasRoom())
    setYearId(defaultFiscalYearId(new Date().getFullYear()))
  }, [])

  const reload = useCallback(async () => {
    if (!hasRoom()) return
    setBusy(true)
    setMsg('')
    try {
      const [cs, comp] = await Promise.all([loadSharedClients(), loadCompanies(yearId)])
      setClients(cs)
      setCompanies(comp)
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

  async function onRegister(c: SharedClient) {
    setBusy(true)
    try {
      await registerCompany(yearId, c)
      await reload()
    } finally {
      setBusy(false)
    }
  }
  async function onUnregister(clientId: string) {
    if (!confirm('この会社を年末調整の対象から外しますか？（取込済み従業員リストは残ります）')) return
    setBusy(true)
    try {
      await unregisterCompany(yearId, clientId)
      await reload()
    } finally {
      setBusy(false)
    }
  }

  async function onCsv(clientId: string, file: File) {
    setBusy(true)
    setMsg('')
    try {
      const buf = await file.arrayBuffer()
      const text = decodeShiftJis(buf)
      const { employees, skipped } = parseJdlCsv(text)
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

  const registeredIds = new Set(Object.keys(companies))

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
            顧問先（仕訳作成・顧問先情報と共通）。年末調整の対象にする会社を登録し、JDLのCSVで従業員を取り込んでください。
          </div>
          {clients.length === 0 ? (
            <div className="p-6 text-center text-sm text-gray-500">
              顧問先がありません。「顧問先情報登録」または「仕訳作成」で顧問先を登録してください。
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-gray-500">
                  <th className="text-left px-4 py-2 font-semibold">コード</th>
                  <th className="text-left px-4 py-2 font-semibold">会社名</th>
                  <th className="text-left px-4 py-2 font-semibold">状態 / 従業員</th>
                  <th className="text-right px-4 py-2 font-semibold">操作</th>
                </tr>
              </thead>
              <tbody>
                {clients.map((c) => {
                  const comp = companies[c.id]
                  const registered = registeredIds.has(c.id)
                  return (
                    <tr key={c.id} className="border-t border-gray-100">
                      <td className="px-4 py-3 text-gray-700">{c.code || '—'}</td>
                      <td className="px-4 py-3 font-medium text-gray-800">{c.name}</td>
                      <td className="px-4 py-3 text-gray-600">
                        {registered ? (
                          <span>
                            <span className="inline-block text-[11px] bg-green-100 text-green-700 rounded-full px-2 py-0.5 mr-2">
                              登録済み
                            </span>
                            従業員 {comp?.employeeCount ?? 0}名
                          </span>
                        ) : (
                          <span className="text-gray-400">未登録</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 justify-end flex-wrap">
                          {!registered ? (
                            <button
                              onClick={() => onRegister(c)}
                              disabled={busy}
                              className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                            >
                              年末調整に登録
                            </button>
                          ) : (
                            <>
                              <label className="px-3 py-1.5 text-xs border border-gray-300 rounded hover:bg-gray-50 cursor-pointer">
                                CSV取込
                                <input
                                  type="file"
                                  accept=".csv,.txt"
                                  className="hidden"
                                  onChange={(e) => {
                                    const f = e.target.files?.[0]
                                    if (f) onCsv(c.id, f)
                                    e.target.value = ''
                                  }}
                                />
                              </label>
                              <button
                                onClick={() => copyUrl(comp)}
                                className="px-3 py-1.5 text-xs border border-gray-300 rounded hover:bg-gray-50"
                              >
                                URLコピー
                              </button>
                              <button
                                onClick={() => showQr(comp)}
                                className="px-3 py-1.5 text-xs border border-gray-300 rounded hover:bg-gray-50"
                              >
                                QR表示
                              </button>
                              <button
                                onClick={() => onUnregister(c.id)}
                                className="px-3 py-1.5 text-xs text-red-600 border border-red-200 rounded hover:bg-red-50"
                              >
                                対象外
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        <p className="text-xs text-gray-400 mt-4">
          ※ 第一版です。従業員側の撮影・提出ページ、提出状況の集計、マイナンバーの暗号収集、前年情報の差分確認は順次追加します。
        </p>
      </div>

      {qr && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
          onClick={() => setQr(null)}
        >
          <div
            className="bg-white rounded-2xl p-6 max-w-sm w-full text-center"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="font-bold text-gray-800 mb-1">{qr.name}</h2>
            <p className="text-xs text-gray-500 mb-3">従業員に配布するQRコード</p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qr.dataUrl} alt="QR" className="mx-auto mb-3" />
            <div className="text-[11px] text-gray-500 break-all bg-gray-50 rounded p-2 mb-3">
              {qr.url}
            </div>
            <button
              onClick={() => setQr(null)}
              className="px-4 py-2 bg-gray-200 text-gray-700 rounded text-sm"
            >
              閉じる
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
