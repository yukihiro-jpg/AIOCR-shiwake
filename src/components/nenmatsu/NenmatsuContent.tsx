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
  republishRosters,
  processNenmatsuPurgeQueue,
  saveEmployees,
  loadEmployees,
  loadSubmissions,
  listEmployeeFiles,
  getFileBlobs,
  sweepOldSubmissions,
  buildUploadUrl,
  loadDefaultDeadline,
  saveDefaultDeadline,
  setCompanyDeadline,
  deleteSubmission,
  type SharedClient,
  type NenmatsuCompany,
  type NenmatsuEmployee,
  type SubmissionRecord,
} from '@/lib/nenmatsu/store'
import { decodeShiftJis, parseJdlCsv, extractPostal, extractDependents } from '@/lib/nenmatsu/jdl-csv'
import { FY_BY_ID } from '@/lib/nenmatsu/fiscal-year'
import { openGuidePrint } from '@/lib/nenmatsu/guide'
import DriveSaveDialog from '@/core/ui/DriveSaveDialog'
import { spouseCategory, dependentCategory, numYen, type Declaration } from '@/lib/nenmatsu/declaration'
import { buildDeclarationExcelBlob, type DeclarationExcelEntry } from '@/lib/nenmatsu/declaration-excel'

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

/** 期限までの残り日数（期限日の終わりまで）。期限なしは null */
function daysToDeadline(deadline: string): number | null {
  if (!deadline) return null
  const d = new Date(deadline + 'T23:59:59')
  if (isNaN(d.getTime())) return null
  return Math.ceil((d.getTime() - Date.now()) / 86400000)
}

// 提出状況マトリクスの列（提出書類の短縮ラベル。順序は NENMATSU_DOC_TYPES と同じ）
const DOC_COLS: { key: string; label: string }[] = [
  { key: 'life_insurance', label: '生保' },
  { key: 'earthquake_insurance', label: '地震' },
  { key: 'national_pension', label: '国年' },
  { key: 'national_health', label: '国保' },
  { key: 'small_mutual', label: '小規' },
  { key: 'ideco', label: 'iDe' },
  { key: 'housing_loan_declaration', label: '住宅' },
  { key: 'housing_loan_balance', label: '借入' },
  { key: 'prev_withholding', label: '前職' },
]

/** 期限バッジ（残り日数・超過の色分け） */
function DeadlineBadge({ deadline }: { deadline: string }) {
  const days = daysToDeadline(deadline)
  if (days == null) return null
  const [y, m, dd] = deadline.split('-')
  void y
  const label = `${Number(m)}/${Number(dd)}`
  if (days < 0) return <span className="px-1.5 py-0.5 rounded bg-red-100 text-red-700 text-[10px] font-bold whitespace-nowrap">期限超過（{label}）</span>
  if (days <= 7) return <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 text-[10px] font-bold whitespace-nowrap">あと{days}日（{label}）</span>
  return <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 text-[10px] whitespace-nowrap">期限 {label}（あと{days}日）</span>
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
  const [guide, setGuide] = useState<{ company: NenmatsuCompany } | null>(null)
  const [defaultDeadline, setDefaultDeadline] = useState('')
  const [defaultDeadlineInput, setDefaultDeadlineInput] = useState('')

  useEffect(() => {
    setReady(hasRoom())
    setYearId(defaultFiscalYearId(new Date().getFullYear()))
  }, [])

  const reload = useCallback(async () => {
    if (!hasRoom()) return
    setBusy(true)
    setMsg('')
    try {
      // 顧問先削除の purge キューを処理（削除済み顧問先の公開名簿・提出画像を確実に消す）
      try { await processNenmatsuPurgeQueue() } catch { /* 次回に再試行 */ }
      const clients = await loadNenmatsuClients()
      // 利用クライアントごとに会社（トークン）を自動用意
      await Promise.all(clients.map((c) => registerCompany(yearId, c)))
      // 旧仕様（生年月日・住所を平文公開）で発行済みの公開名簿を、安全な仕様（ハッシュ化・PII非公開）へ移行。
      // 【重要】選択中の年度だけでなく全年度を対象にする（過去年度の平文名簿を残さない）。
      // 失敗した年度はフラグを立てず、次回開いたときに再試行する。
      try {
        if (typeof window !== 'undefined') {
          for (const fy of Object.keys(FY_BY_ID)) {
            const migKey = `nenmatsu-roster-migrated-v2-${fy}`
            if (!localStorage.getItem(migKey)) {
              const ok = await republishRosters(fy)
              if (ok) localStorage.setItem(migKey, '1')
            }
          }
        }
      } catch { /* ignore */ }
      try {
        const dd = await loadDefaultDeadline(yearId)
        setDefaultDeadline(dd)
        setDefaultDeadlineInput(dd)
      } catch { /* ignore */ }
      const comps = await loadCompanies(yearId)
      const next: Row[] = []
      for (const c of clients) {
        const company = comps[c.id]
        if (!company) continue
        // 保存期間（アップロードから1年6か月）を過ぎた提出データを自動削除
        try { await sweepOldSubmissions(yearId, c.id) } catch { /* 次回に再試行 */ }
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
      <div className="flex-1 p-6 max-w-[1500px] w-full mx-auto">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <h1 className="text-xl font-bold text-gray-800">年調データ受信 — 控除証明書・申告データの回収</h1>
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

        {/* 提出期限（年度の既定。会社別は一覧の各行で上書き） */}
        <div className="bg-white rounded-2xl border border-gray-200 px-4 py-3 mb-4 flex items-center gap-3 flex-wrap">
          <span className="text-sm font-semibold text-gray-700">📅 提出期限（全社の既定）</span>
          <input
            type="date"
            value={defaultDeadlineInput}
            onChange={(e) => setDefaultDeadlineInput(e.target.value)}
            className="px-3 py-1.5 text-sm border border-gray-300 rounded"
          />
          <button
            onClick={async () => {
              setBusy(true)
              try {
                await saveDefaultDeadline(yearId, defaultDeadlineInput)
                setDefaultDeadline(defaultDeadlineInput)
                setMsg(defaultDeadlineInput ? '既定の提出期限を保存し、従業員向けページに反映しました。' : '既定の提出期限を解除しました。')
              } catch (e) {
                setMsg('保存に失敗しました：' + (e instanceof Error ? e.message : ''))
              }
              setBusy(false)
            }}
            disabled={busy || defaultDeadlineInput === defaultDeadline}
            className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-40"
          >
            保存して全社に適用
          </button>
          <span className="text-[11px] text-gray-400">
            従業員向けページに期限と残り日数が表示されます（期限後も提出は受け付け、警告を表示）。会社ごとに変えたい場合は下の一覧の期限欄で上書きできます。
          </span>
        </div>

        <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 text-sm text-gray-500">
            「顧問先情報登録」の「アプリ利用」で<strong>年調データ受信＝利用</strong>にした会社が表示されます。JDLのCSVで従業員を取り込み、URL/QRを配布してください。
          </div>
          {rows.length === 0 ? (
            <div className="p-6 text-center text-sm text-gray-500">
              対象会社がありません。「顧問先情報登録」の「アプリ利用」で対象会社の<strong>年調データ受信</strong>を<strong>利用</strong>に設定してください。
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-gray-500">
                  <th className="text-left px-4 py-2 font-semibold">コード</th>
                  <th className="text-left px-4 py-2 font-semibold">会社名</th>
                  <th className="text-left px-4 py-2 font-semibold">従業員 / 提出</th>
                  <th className="text-left px-4 py-2 font-semibold">提出期限</th>
                  <th className="text-right px-4 py-2 font-semibold">操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ client, company, submitted }) => {
                  const eff = company.deadline || defaultDeadline
                  const remain = Math.max(0, (company.employeeCount ?? 0) - submitted)
                  const dd = daysToDeadline(eff)
                  return (
                  <tr key={client.id} className="border-t border-gray-100">
                    <td className="px-4 py-3 text-gray-700 whitespace-nowrap">{client.code || '—'}</td>
                    <td className="px-4 py-3 font-medium text-gray-800 whitespace-nowrap">{client.name}</td>
                    <td className="px-4 py-3 text-gray-600 whitespace-nowrap">
                      従業員 {company.employeeCount ?? 0}名 ／ 提出{' '}
                      <span className="font-semibold text-blue-700">{submitted}</span>名
                      {remain > 0 && (company.employeeCount ?? 0) > 0 && (
                        <span className={`ml-1.5 px-1.5 py-0.5 rounded text-[10px] font-bold ${dd != null && dd < 0 ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-500'}`}>
                          未提出 {remain}名
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <input
                          type="date"
                          value={company.deadline || ''}
                          placeholder={defaultDeadline}
                          title={company.deadline ? 'この会社だけの期限（空にすると既定に戻ります）' : defaultDeadline ? `既定（${defaultDeadline}）を使用中。変更するとこの会社だけ上書きします` : '期限を設定'}
                          onChange={async (e) => {
                            const v = e.target.value
                            try {
                              await setCompanyDeadline(yearId, client.id, v)
                              setRows((prev) => prev.map((r) => r.client.id === client.id ? { ...r, company: { ...r.company, deadline: v || undefined } } : r))
                            } catch { setMsg('期限の保存に失敗しました。') }
                          }}
                          className={`px-2 py-1 text-xs border rounded ${company.deadline ? 'border-blue-400 text-blue-800' : 'border-gray-200 text-gray-500'}`}
                        />
                        <DeadlineBadge deadline={eff} />
                      </div>
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
                          onClick={() => setGuide({ company })}
                          className="px-3 py-1.5 text-xs border border-emerald-300 text-emerald-700 rounded hover:bg-emerald-50"
                        >
                          案内PDF
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
                )})}
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
          defaultDeadline={defaultDeadline}
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

      {guide && (
        <GuideModal
          yearId={yearId}
          company={guide.company}
          defaultDeadline={defaultDeadline}
          onClose={() => setGuide(null)}
        />
      )}
    </div>
  )
}

/** 従業員向け「年末調整のご案内」PDF（印刷）を作成するモーダル。
 *  QR・URLを用意し、提出期限を設定して A4 の案内を印刷（PDF保存）できる。 */
function GuideModal({
  yearId,
  company,
  defaultDeadline,
  onClose,
}: {
  yearId: string
  company: NenmatsuCompany
  defaultDeadline: string
  onClose: () => void
}) {
  const fy = FY_BY_ID[yearId]
  const gregorian = fy?.gregorian || new Date().getFullYear()
  // 会社別期限 ＞ 年度既定 ＞ 年度テンプレの順で初期値にする（案内PDFとアプリ表示の期限を一致させる）
  const initialDeadline = company.deadline || defaultDeadline || `${gregorian}-${fy?.deadlineMMDD || '11-30'}`
  const [deadline, setDeadline] = useState(initialDeadline)
  const [url, setUrl] = useState('')
  const [qr, setQr] = useState('')
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  useEffect(() => {
    ;(async () => {
      setLoading(true)
      setErr('')
      try {
        const u = await buildUploadUrl(yearId, company)
        const QRCode = (await import('qrcode')).default
        const dataUrl = await QRCode.toDataURL(u, { width: 340, margin: 1 })
        setUrl(u)
        setQr(dataUrl)
      } catch (e) {
        setErr('QRの生成に失敗しました：' + (e instanceof Error ? e.message : ''))
      } finally {
        setLoading(false)
      }
    })()
  }, [yearId, company])

  function fmtDeadline(iso: string): string {
    const d = new Date(iso + 'T00:00:00')
    if (isNaN(d.getTime())) return iso
    const w = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()]
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${w}）`
  }

  function make() {
    if (!qr || !url) return
    const ok = openGuidePrint({
      companyName: company.name,
      yearLabel: fy?.label || `${gregorian}年`,
      url,
      qrDataUrl: qr,
      deadlineText: fmtDeadline(deadline),
    })
    if (!ok) {
      alert('ポップアップがブロックされました。ブラウザのポップアップを許可してから、もう一度「案内PDFを作成」を押してください。')
      return
    }
    // 案内に印字した期限をこの会社の提出期限として保存（従業員向けページの表示と一致させる）
    if (deadline && deadline !== (company.deadline || defaultDeadline)) {
      setCompanyDeadline(yearId, company.clientId, deadline).catch(() => { /* 表示は次回更新時に反映 */ })
    }
  }

  return (
    <Overlay onClose={onClose}>
      <h2 className="font-bold text-gray-800 mb-1">{company.name} — 年末調整のご案内（従業員配布用）</h2>
      <p className="text-xs text-gray-500 mb-4">
        QRコード・使い方・提出期限を1枚にまとめたA4の案内を作成します。ボタンを押すと印刷画面が開くので、
        送信先を「<b>PDFに保存</b>」にすればPDFとしてダウンロードできます（印刷して配布も可）。
      </p>

      {err && (
        <div className="text-sm bg-red-50 border border-red-200 text-red-700 rounded px-3 py-2 mb-3">{err}</div>
      )}

      <div className="flex gap-4 items-start mb-4 flex-wrap">
        <div className="border border-gray-200 rounded-lg p-3 bg-gray-50 text-center">
          {loading ? (
            <div className="w-[160px] h-[160px] flex items-center justify-center text-xs text-gray-400">生成中...</div>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={qr} alt="QR" className="w-[160px] h-[160px]" />
          )}
          <div className="text-[10px] text-gray-500 break-all mt-2 max-w-[160px]">{url}</div>
        </div>
        <div className="flex-1 min-w-[220px]">
          <label className="block text-sm font-medium text-gray-700 mb-1">提出期限</label>
          <input
            type="date"
            value={deadline}
            onChange={(e) => setDeadline(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded text-sm mb-2"
          />
          <p className="text-xs text-gray-500 mb-3">
            案内には「{fmtDeadline(deadline)}」と、<b className="text-red-600">期限を過ぎると会社で年末調整ができない</b>旨を明記します。
          </p>
          <button
            onClick={make}
            disabled={loading || !qr}
            className="px-4 py-2 text-sm bg-emerald-600 text-white rounded font-semibold hover:bg-emerald-700 disabled:opacity-50"
          >
            📄 案内PDFを作成（印刷 / PDF保存）
          </button>
        </div>
      </div>

      <p className="text-[11px] text-gray-400">
        ※ 文字は Noto Sans JP で表示されます。従業員は iPhone / Android / PC の Chrome・Safari で利用できます。
      </p>
    </Overlay>
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
              <th className="text-left px-3 py-2">氏名</th>
              <th className="text-left px-3 py-2">生年月日</th>
              <th className="text-left px-3 py-2">郵便番号</th>
              <th className="text-left px-3 py-2">住所</th>
              <th className="text-left px-3 py-2">扶養親族</th>
            </tr>
          </thead>
          <tbody>
            {employees.map((e) => {
              const postal = extractPostal(e.rawCells)
              const deps = extractDependents(e.rawCells)
              return (
                <Fragment key={e.id}>
                  <tr
                    className="border-t border-gray-100 cursor-pointer hover:bg-blue-50/40"
                    onClick={() => setOpenId(openId === e.id ? '' : e.id)}
                  >
                    <td className="px-3 py-2 text-gray-800">
                      {e.lastName} {e.firstName}
                      <div className="text-[11px] text-gray-400">
                        {e.kanaLast} {e.kanaFirst}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-gray-600">
                      {e.birth || e.birthRaw || '—'}
                      {!e.birth && (
                        <span className="ml-1 px-1.5 py-0.5 rounded bg-red-100 text-red-600 text-[10px] font-bold whitespace-nowrap"
                          title="生年月日を読み取れないため、この従業員は公開ページで本人確認できず提出がブロックされます。CSVの生年月日をご確認ください。">⚠ 本人確認不可</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-gray-600">{postal || '—'}</td>
                    <td className="px-3 py-2 text-gray-600">{e.address || '—'}</td>
                    <td className="px-3 py-2 text-gray-600">
                      {deps.length ? `あり（${deps.length}名）` : 'なし'}
                    </td>
                  </tr>
                  {openId === e.id && (
                    <tr className="bg-gray-50">
                      <td colSpan={5} className="px-3 py-2">
                        {deps.length === 0 ? (
                          <div className="text-[12px] text-gray-500">扶養親族なし</div>
                        ) : (
                          <table className="w-full text-[12px] mb-2">
                            <thead>
                              <tr className="text-gray-400">
                                <th className="text-left py-1">続柄</th>
                                <th className="text-left py-1">氏名</th>
                                <th className="text-left py-1">生年月日</th>
                              </tr>
                            </thead>
                            <tbody>
                              {deps.map((dep, i) => (
                                <tr key={i} className="border-t border-gray-200">
                                  <td className="py-1 text-gray-700">{dep.relation || '—'}</td>
                                  <td className="py-1 text-gray-800">{dep.name || '—'}</td>
                                  <td className="py-1 text-gray-700">{dep.birth || dep.birthRaw || '—'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                        <details>
                          <summary className="text-[11px] text-gray-400 cursor-pointer">
                            CSVの全列（列番号: 内容）を表示
                          </summary>
                          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-0.5 max-h-64 overflow-auto mt-1">
                            {(e.rawCells || []).map((v, i) =>
                              v ? (
                                <div key={i} className="text-[11px] flex gap-1">
                                  <span className="text-gray-400 shrink-0">{i}:</span>
                                  <span className="text-gray-700 break-all">{v}</span>
                                </div>
                              ) : null,
                            )}
                          </div>
                        </details>
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      )}
      <p className="text-[11px] text-gray-400 mt-3">
        ※ 扶養親族の郵便番号・住所はJDLのCSVに含まれないため、続柄・氏名・生年月日のみ表示します。
      </p>
    </Overlay>
  )
}

function Overlay({ children, onClose, wide }: { children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) (onClose)() }}
    >
      <div
        className={`bg-white rounded-2xl p-6 ${wide ? 'max-w-6xl' : 'max-w-2xl'} w-full max-h-[85vh] overflow-auto`}
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
  defaultDeadline,
  onClose,
}: {
  yearId: string
  company: NenmatsuCompany
  defaultDeadline: string
  onClose: () => void
}) {
  const [employees, setEmployees] = useState<NenmatsuEmployee[]>([])
  const [subs, setSubs] = useState<Record<string, SubmissionRecord>>({})
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [files, setFiles] = useState<{ emp: string; items: { name: string; url: string }[] } | null>(
    null,
  )
  const [declView, setDeclView] = useState<{ name: string; decl: Declaration } | null>(null)
  const fyGregorian = FY_BY_ID[yearId]?.gregorian || new Date().getFullYear()

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
  const [driveOpen, setDriveOpen] = useState(false)

  // 本年入社（新規）提出者：CSV名簿に存在しない empId（n_…）の提出を一覧・DLに含める。
  // これをしないと新入社員の提出が事務所側から一切見えないまま保存期限で消えてしまう。
  const knownIds = new Set(employees.map((e) => e.id))
  const newHires: NenmatsuEmployee[] = Object.entries(subs)
    .filter(([id]) => !knownIds.has(id))
    .map(([id, rec]) => ({
      id, code: '',
      lastName: rec.name || '(氏名不明)', firstName: '',
      kanaLast: rec.kana || '', kanaFirst: '',
      birth: '', birthRaw: '', isNewHire: true,
    }))
  const displayEmployees: NenmatsuEmployee[] = [...employees, ...newHires]

  /** 未提出者の一覧を催促連絡用テキストとしてコピー（パターンC: リマインド支援） */
  async function copyPendingList() {
    const pending = employees.filter((e) => !subs[e.id])
    if (!pending.length) {
      alert('未提出者はいません（全員提出済みです）。')
      return
    }
    const eff = company.deadline || defaultDeadline
    const lines = [
      `【${company.name}】年末調整 書類の未提出者（${pending.length}名）`,
      ...(eff ? [`提出期限: ${eff.replace(/-/g, '/')}`] : []),
      '',
      ...pending.map((e) => `・${e.lastName} ${e.firstName}`),
      '',
      'お手数ですが、上記の方へ提出のお声がけをお願いいたします。',
    ]
    const text = lines.join('\n')
    try {
      await navigator.clipboard.writeText(text)
      alert('未提出者一覧をコピーしました。メール等に貼り付けて会社のご担当者へお送りください。')
    } catch {
      window.prompt('コピーしてください', text)
    }
  }

  async function viewFiles(emp: NenmatsuEmployee) {
    try {
      const items = await listEmployeeFiles(yearId, company.clientId, emp.id)
      setFiles({ emp: `${emp.lastName} ${emp.firstName}`, items })
    } catch (e) {
      alert('ファイルの取得に失敗しました：' + (e instanceof Error ? e.message : ''))
    }
  }

  /** テスト提出・誤提出の取消（画像・申告内容を削除して未提出に戻す） */
  async function removeSubmission(emp: NenmatsuEmployee) {
    const name = `${emp.lastName} ${emp.firstName}`.trim()
    if (!window.confirm(
      `${name} さんの提出を取り消しますか？\n\n` +
      '提出された画像と申告内容を削除し、「未提出」の状態に戻します。\n' +
      '本人は同じURLからもう一度提出できます。この操作は元に戻せません。',
    )) return
    setZipMsg(`${name} さんの提出を取り消しています...`)
    try {
      await deleteSubmission(yearId, company.clientId, emp.id)
      setSubs((prev) => {
        const next = { ...prev }
        delete next[emp.id]
        return next
      })
      setFiles(null)
      setDeclView(null)
    } catch (e) {
      alert('取消に失敗しました：' + (e instanceof Error ? e.message : ''))
    }
    setZipMsg('')
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

  /** 全員一括DL。flat=false: 従業員ごとのフォルダに分ける／flat=true: 会社名フォルダ1つに「社員名_書類名」で格納 */
  async function downloadAll(flat: boolean) {
    const targets = displayEmployees
      .map((e) => ({ e, rec: subs[e.id] }))
      .filter((x) => x.rec && (x.rec.paths || []).length > 0)
    if (!targets.length) {
      alert('ダウンロードできるファイルがありません。')
      return
    }
    try {
      const JSZip = (await import('jszip')).default
      const zip = new JSZip()
      const flatFolder = flat ? zip.folder(safe(company.name)) : null
      let i = 0
      for (const { e, rec } of targets) {
        setZipMsg(`まとめています... (${++i}/${targets.length})`)
        const empName = safe(`${e.lastName}${e.firstName}`)
        const blobs = await getFileBlobs(rec.paths || [])
        if (flat) {
          blobs.forEach((b) => flatFolder?.file(`${empName}_${niceFileName(b.name)}`, b.blob))
        } else {
          const folder = zip.folder(empName)
          blobs.forEach((b) => folder?.file(niceFileName(b.name), b.blob))
        }
      }
      setZipMsg('ZIPを作成中...')
      const out = await zip.generateAsync({ type: 'blob' })
      saveBlob(out, `${safe(company.name)}_年末調整_${yearId}${flat ? '_全員' : ''}.zip`)
    } catch (e) {
      alert('一括ダウンロードに失敗しました：' + (e instanceof Error ? e.message : ''))
    }
    setZipMsg('')
  }

  /** 申告内容のExcel出力。emp指定時はその1名、未指定は提出済み全員 */
  async function downloadDeclarations(one?: NenmatsuEmployee) {
    const targets = (one ? [one] : displayEmployees)
      .map((e) => ({ e, rec: subs[e.id] }))
      .filter((x) => x.rec?.declaration)
    if (!targets.length) {
      alert('申告内容の登録がありません。')
      return
    }
    setZipMsg('申告内容のExcelを作成中...')
    try {
      const fy = FY_BY_ID[yearId]
      const entries: DeclarationExcelEntry[] = targets.map(({ e, rec }) => ({
        employeeName: `${e.lastName} ${e.firstName}`.trim(),
        decl: rec!.declaration!,
        submittedAt: rec!.submittedAt,
        isNewHire: e.isNewHire,
      }))
      const blob = await buildDeclarationExcelBlob(entries, {
        companyName: company.name,
        fyLabel: fy?.label || yearId,
        fyGregorian: fy?.gregorian || new Date().getFullYear(),
      })
      const suffix = one ? safe(`${one.lastName}${one.firstName}`) : '全員'
      saveBlob(blob, `${safe(company.name)}_申告内容_${yearId}_${suffix}.xlsx`)
    } catch (e) {
      alert('Excelの作成に失敗しました：' + (e instanceof Error ? e.message : ''))
    }
    setZipMsg('')
  }

  return (
    <Overlay onClose={onClose} wide>
      <h2 className="font-bold text-gray-800 mb-1">{company.name} — 提出状況</h2>
      <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
        <p className="text-xs text-gray-500">
          提出済みの従業員はファイルをアプリ内で閲覧・人別/全員一括でダウンロードできます。
        </p>
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={copyPendingList}
            disabled={!!zipMsg || loading}
            title="未提出者の氏名一覧を、会社への催促連絡用テキストとしてコピーします"
            className="px-3 py-1.5 text-xs border border-amber-300 text-amber-700 rounded hover:bg-amber-50 disabled:opacity-50 whitespace-nowrap"
          >
            📋 未提出者をコピー
          </button>
          <button
            onClick={() => setDriveOpen(true)}
            disabled={!!zipMsg}
            className="px-3 py-1.5 text-xs border border-emerald-300 text-emerald-700 rounded hover:bg-emerald-50 disabled:opacity-50 whitespace-nowrap"
          >
            📁 Driveへ一括保存
          </button>
          <button
            onClick={() => downloadAll(false)}
            disabled={!!zipMsg}
            title="従業員ごとのフォルダに分けてZIPにまとめます"
            className="px-3 py-1.5 text-xs bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50 whitespace-nowrap"
          >
            一括DL（個人別フォルダ）
          </button>
          <button
            onClick={() => downloadAll(true)}
            disabled={!!zipMsg}
            title="会社名のフォルダ1つに、全員のファイルを「社員名_書類名」で格納します"
            className="px-3 py-1.5 text-xs bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50 whitespace-nowrap"
          >
            一括DL（全員フォルダ）
          </button>
          <button
            onClick={() => downloadDeclarations()}
            disabled={!!zipMsg}
            title="全員の申告内容（本人・配偶者・扶養親族）を1つのExcelにまとめます"
            className="px-3 py-1.5 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50 whitespace-nowrap"
          >
            一括DL（申告内容）
          </button>
        </div>
      </div>

      {driveOpen && (
        <DriveSaveDialog
          title={`${company.name}／年末調整（${yearId}）の提出ファイルを、従業員ごとのフォルダに分けて保存します`}
          getFiles={async (onProgress) => {
            const targets = displayEmployees
              .map((e) => ({ e, rec: subs[e.id] }))
              .filter((x) => x.rec && (x.rec.paths || []).length > 0)
            if (!targets.length) throw new Error('保存できるファイルがありません（提出済みの従業員がいません）')
            const out: { name: string; blob: Blob; folder?: string }[] = []
            let i = 0
            for (const { e, rec } of targets) {
              onProgress(`ファイルを取得しています... (${++i}/${targets.length}) ${e.lastName}${e.firstName}`)
              const blobs = await getFileBlobs(rec.paths || [])
              for (const b of blobs) {
                out.push({ name: niceFileName(b.name), blob: b.blob, folder: safe(`${e.lastName}${e.firstName}`) })
              }
            }
            return out
          }}
          onClose={() => setDriveOpen(false)}
        />
      )}
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
      ) : displayEmployees.length === 0 ? (
        <p className="text-sm text-gray-500 py-6 text-center">
          従業員が未取込です。CSVを取り込んでください。
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10">
            <tr className="bg-gray-100 text-gray-500">
              <th className="text-left px-3 py-2 bg-gray-100">氏名</th>
              {DOC_COLS.map((c) => (
                <th key={c.key} className="text-center px-1 py-2 w-11 bg-gray-100" title={DOC_BY_KEY[c.key]?.name || c.key}>{c.label}</th>
              ))}
              <th className="text-right px-3 py-2 bg-gray-100"></th>
            </tr>
          </thead>
          <tbody>
            {displayEmployees.map((e) => {
              const rec = subs[e.id]
              return (
                <tr key={e.id} className="border-t border-gray-100">
                  <td className="px-3 py-2 text-gray-800 whitespace-nowrap">
                    {e.lastName} {e.firstName}
                    {e.isNewHire && (
                      <span className="ml-1.5 px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 text-[10px] font-bold align-middle">本年入社</span>
                    )}
                  </td>
                  {rec ? (
                    DOC_COLS.map((c) => {
                      const n = (rec.docs || {})[c.key] || 0
                      return (
                        <td key={c.key} className="px-1 py-2 text-center" title={`${DOC_BY_KEY[c.key]?.name || c.key}${n ? `（${n}枚）` : ''}`}>
                          {n ? <span className="text-green-600 font-bold">○</span> : <span className="text-gray-300">－</span>}
                        </td>
                      )
                    })
                  ) : (
                    <td colSpan={DOC_COLS.length} className="px-3 py-2 text-center text-gray-300">未提出</td>
                  )}
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <span className="inline-flex gap-1.5">
                      {rec?.declaration && (
                        <>
                          <button
                            onClick={() =>
                              setDeclView({ name: `${e.lastName} ${e.firstName}`, decl: rec.declaration! })
                            }
                            className="px-3 py-1 text-xs border border-gray-300 rounded hover:bg-gray-50"
                          >
                            申告内容
                          </button>
                          <button
                            onClick={() => downloadDeclarations(e)}
                            disabled={!!zipMsg}
                            title="この従業員の申告内容をExcelでダウンロード"
                            className="px-3 py-1 text-xs border border-indigo-300 text-indigo-700 rounded hover:bg-indigo-50 disabled:opacity-50"
                          >
                            申告DL
                          </button>
                        </>
                      )}
                      {rec && (rec.paths || []).length > 0 && (
                        <>
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
                        </>
                      )}
                      {rec && (
                        <button
                          onClick={() => removeSubmission(e)}
                          disabled={!!zipMsg}
                          title="テスト提出・誤提出の取消。画像と申告内容を削除して未提出に戻します"
                          className="px-3 py-1 text-xs border border-red-300 text-red-600 rounded hover:bg-red-50 disabled:opacity-50"
                        >
                          提出取消
                        </button>
                      )}
                    </span>
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

      {declView && (
        <div className="mt-4 border-t border-gray-200 pt-3">
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-semibold text-sm text-gray-800">{declView.name} 様 の申告内容</h3>
            <button onClick={() => setDeclView(null)} className="text-xs text-gray-500">
              閉じる
            </button>
          </div>
          <DeclarationView decl={declView.decl} fyGregorian={fyGregorian} />
        </div>
      )}
    </Overlay>
  )
}

function DeclarationView({ decl, fyGregorian }: { decl: Declaration; fyGregorian: number }) {
  const Row = ({ k, v }: { k: string; v: string }) => (
    <div className="flex gap-2 text-[12px] py-0.5">
      <span className="text-gray-400 w-28 shrink-0">{k}</span>
      <span className="text-gray-800 break-all">{v || '—'}</span>
    </div>
  )
  return (
    <div className="text-sm space-y-3">
      {!decl.isNewHire && decl.noChange && (
        <div className="text-xs bg-green-50 border border-green-200 text-green-700 rounded px-2 py-1">
          本人が「前年と相違ありません」を選択
        </div>
      )}
      {decl.isNewHire && (
        <div className="text-xs bg-amber-50 border border-amber-200 text-amber-700 rounded px-2 py-1">
          本年入社（新規申告）{decl.hireDate ? `・入社日 ${decl.hireDate}` : ''}
          {decl.hasPrevJob === true ? '・前職あり' : decl.hasPrevJob === false ? '・前職なし' : ''}
        </div>
      )}
      {decl.isNewHire && decl.prevJobNoSlip && (
        <div className="text-xs bg-red-50 border border-red-200 text-red-700 rounded px-2 py-1">
          ⚠ 前職の源泉徴収票を入手できないまま提出（本人が確定申告する旨を案内済み）。年末調整に前職分を含めないでください。
        </div>
      )}
      <div>
        <div className="font-semibold text-gray-700 mb-1">本人</div>
        <Row k="氏名" v={`${decl.lastName} ${decl.firstName}`} />
        <Row k="フリガナ" v={`${decl.kanaLast} ${decl.kanaFirst}`} />
        <Row k="生年月日" v={decl.birth} />
        <Row k="住所" v={`〒${decl.postal} ${decl.address}`} />
        <Row k="世帯主" v={`${decl.householder}（${decl.householderRelation}）`} />
        <Row k="障害者区分" v={decl.selfDisability} />
        <Row k="寡婦/ひとり親" v={decl.widow} />
        <Row k="勤労学生" v={decl.workingStudent ? '該当' : '非該当'} />
      </div>
      <div>
        <div className="font-semibold text-gray-700 mb-1">配偶者</div>
        {decl.spouse.exists ? (
          <>
            <Row k="氏名" v={decl.spouse.name} />
            <Row k="生年月日" v={decl.spouse.birth} />
            <Row k="年収" v={decl.spouse.income ? `${numYen(decl.spouse.income).toLocaleString('ja-JP')}円` : ''} />
            <Row k="控除区分" v={spouseCategory(decl.spouse)} />
          </>
        ) : (
          <div className="text-[12px] text-gray-400">なし</div>
        )}
      </div>
      <div>
        <div className="font-semibold text-gray-700 mb-1">扶養親族（{decl.dependents.length}名）</div>
        {decl.dependents.length === 0 ? (
          <div className="text-[12px] text-gray-400">なし</div>
        ) : (
          decl.dependents.map((dep, i) => (
            <div key={i} className="border border-gray-100 rounded p-2 mb-1.5">
              <Row k="氏名・続柄" v={`${dep.name}（${dep.relation}）`} />
              <Row k="生年月日" v={dep.birth} />
              <Row k="年収" v={dep.income ? `${numYen(dep.income).toLocaleString('ja-JP')}円` : ''} />
              <Row k="同居" v={dep.liveTogether ? '同居' : '別居'} />
              <Row k="障害者区分" v={dep.disability} />
              <Row k="控除区分" v={dependentCategory(dep, fyGregorian)} />
            </div>
          ))
        )}
      </div>
    </div>
  )
}
