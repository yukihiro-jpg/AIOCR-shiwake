'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  loadScanInfoPublic,
  submitScanBatchPublic,
  submitCashEntryPublic,
  submitFilesPublic,
  loadInbox,
  markInboxDownloaded,
  getInboxBlob,
  SCAN_FILE_MAX_BYTES,
  SCAN_FILE_MAX_TOTAL,
  type ScanInboxFile,
  type CashEntryType,
  type CashDepositType,
} from '@/lib/scan/store'
import { compressImage } from '@/lib/nenmatsu/image-compress'

const TOKEN_STORAGE_KEY = 'scan-token'

// 顧問先ページの3機能（スマホ=上部ボタン／PC=左サイドバー）
const NAV = [
  { key: 'files', icon: '📁', label: '共有フォルダ', desc: 'ファイルの受取・送付' },
  { key: 'scan', icon: '📷', label: 'スマホスキャン', desc: '書類を撮影して送る' },
  { key: 'cash', icon: '💴', label: '現金入出金登録', desc: '現金引出・預入の登録' },
] as const
type ViewKey = (typeof NAV)[number]['key']

const DOC_TYPES = [
  '通帳',
  '現金出納帳',
  'レシート・領収書',
  'クレジットカード利用明細書',
  '売上請求書',
  '仕入請求書',
  '借入金の返済予定表',
  'リース契約の支払予定表',
] as const

type Phase = 'loading' | 'invalid' | 'error' | 'ready'

interface HistoryItem {
  at: string
  label: string
}

export default function ScanUpload() {
  const [phase, setPhase] = useState<Phase>('loading')
  const [token, setToken] = useState('')
  const [view, setView] = useState<ViewKey>('files')
  const [companyName, setCompanyName] = useState('')
  const [memberName, setMemberName] = useState('') // メンバー用URLの場合のみ
  const [companyToken, setCompanyToken] = useState('') // メンバー用URLの場合の会社トークン（撮影/送信先・全員宛の参照）
  // 事務所からのファイル（自分宛＋全員宛）
  const [inboxItems, setInboxItems] = useState<{ srcToken: string; file: ScanInboxFile; toAll: boolean }[]>([])
  const [inboxMsg, setInboxMsg] = useState('')

  const [docType, setDocType] = useState<string>('レシート・領収書')
  const [bankName, setBankName] = useState('')
  const [accountNumber, setAccountNumber] = useState('')
  const [userName, setUserName] = useState('')
  const [photos, setPhotos] = useState<File[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [progress, setProgress] = useState('')
  const [submitErr, setSubmitErr] = useState('')
  const [submitDone, setSubmitDone] = useState('')
  const [history, setHistory] = useState<HistoryItem[]>([])

  const [cashTab, setCashTab] = useState<CashEntryType>('現金引出')
  const [cashDate, setCashDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [cashBank, setCashBank] = useState('')
  const [cashAccount, setCashAccount] = useState('')
  const [cashAmount, setCashAmount] = useState('')
  const [cashDepositType, setCashDepositType] = useState<CashDepositType>('売上金の預入')
  const [cashSubmitting, setCashSubmitting] = useState(false)
  const [cashErr, setCashErr] = useState('')
  const [cashDone, setCashDone] = useState('')

  // ファイル便
  const [sendFiles, setSendFiles] = useState<File[]>([])
  const [sendFolder, setSendFolder] = useState('')
  const [sendComment, setSendComment] = useState('')
  const [fileDrag, setFileDrag] = useState(false)
  const [fileSubmitting, setFileSubmitting] = useState(false)
  const [fileProgress, setFileProgress] = useState('')
  const [fileErr, setFileErr] = useState('')
  const [fileDone, setFileDone] = useState('')

  useEffect(() => {
    ;(async () => {
      try {
        const q = new URLSearchParams(window.location.search)
        let t = q.get('t') || ''
        if (t) {
          try {
            localStorage.setItem(TOKEN_STORAGE_KEY, t)
          } catch {
            /* ignore */
          }
        } else {
          try {
            t = localStorage.getItem(TOKEN_STORAGE_KEY) || ''
          } catch {
            /* ignore */
          }
        }
        if (!t) {
          setPhase('invalid')
          return
        }
        try {
          const info = await loadScanInfoPublic(t)
          if (!info) {
            setPhase('invalid')
            return
          }
          setToken(t)
          setCompanyName(info.name)
          if (info.member) setMemberName(info.member)
          if (info.ct) setCompanyToken(info.ct)
          setPhase('ready')
          // 事務所からのファイル（自分宛＋全員宛）を読み込む
          try {
            const own = await loadInbox(t)
            const items: { srcToken: string; file: ScanInboxFile; toAll: boolean }[] = Object.values(own).map((f) => ({
              srcToken: t,
              file: f,
              toAll: !info.member, // 会社URLで見ている場合は全員宛
            }))
            if (info.ct) {
              const shared = await loadInbox(info.ct)
              for (const f of Object.values(shared)) items.push({ srcToken: info.ct, file: f, toAll: true })
            }
            items.sort((a, b) => b.file.sentAt.localeCompare(a.file.sentAt))
            setInboxItems(items)
          } catch { /* ignore */ }
        } catch {
          // 通信エラー・サーバ設定エラー等（リンク自体は正しい可能性がある）
          setPhase('error')
        }
      } catch {
        setPhase('invalid')
      }
    })()
  }, [])

  const isPassbook = docType === '通帳'
  const isReceipt = docType === 'レシート・領収書'
  // 撮影・現金・ファイル送信の送り先（メンバー用URLでも会社の受信箱に集約される）
  const uploadToken = companyToken || token
  const myDlKey = (memberName || '共通URL').replace(/[.#$/\[\]]/g, '_').slice(0, 40) || '共通URL'
  const inboxNew = inboxItems.filter((x) => !(x.file.downloads || {})[myDlKey]).length

  async function downloadInboxFile(item: { srcToken: string; file: ScanInboxFile }) {
    setInboxMsg('')
    try {
      const blob = await getInboxBlob(item.file)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = item.file.name
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 2000)
      try { await markInboxDownloaded(item.srcToken, item.file.id, memberName || '共通URL') } catch { /* ignore */ }
      setInboxItems((prev) =>
        prev.map((x) =>
          x.file.id === item.file.id
            ? { ...x, file: { ...x.file, downloads: { ...(x.file.downloads || {}), [myDlKey]: new Date().toISOString() } } }
            : x,
        ),
      )
    } catch (e) {
      setInboxMsg('ダウンロードに失敗しました：' + (e instanceof Error ? e.message : '') + '。通信環境をご確認ください')
    }
  }

  function onCapture(list: FileList | null) {
    if (!list || !list.length) return
    // FileList は入力欄と連動する「生きた」リストのため、先に配列へコピーしてから
    // setState する（入力欄クリア後に遅延実行される更新関数内で読むと空になる）
    const arr = Array.from(list)
    setPhotos((prev) => [...prev, ...arr])
  }
  function removePhoto(idx: number) {
    setPhotos((prev) => prev.filter((_, i) => i !== idx))
  }

  async function submitBatch() {
    if (!token) return
    if (photos.length === 0) {
      alert('撮影した書類がありません。')
      return
    }
    setSubmitting(true)
    setSubmitErr('')
    setSubmitDone('')
    try {
      const blobs: Blob[] = []
      for (let i = 0; i < photos.length; i++) {
        setProgress(`画像を圧縮中... (${i + 1}/${photos.length})`)
        blobs.push(await compressImage(photos[i]))
      }
      setProgress('送信しています...')
      await submitScanBatchPublic(
        uploadToken,
        docType,
        {
          bankName: isPassbook ? bankName : undefined,
          accountNumber: isPassbook ? accountNumber : undefined,
          userName: isReceipt ? userName : undefined,
          member: memberName || undefined,
        },
        blobs,
      )
      setSubmitDone(`✅ 送信が完了しました（${docType}・${photos.length}枚）。ありがとうございました。`)
      setHistory((prev) => [
        { at: new Date().toLocaleString('ja-JP'), label: `${docType}（${photos.length}枚）` },
        ...prev,
      ])
      setPhotos([])
      setBankName('')
      setAccountNumber('')
      setUserName('')
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      setSubmitErr(
        /unauthorized|permission/i.test(m)
          ? '送信できませんでした。お手数ですが、会計事務所のご担当者に「サーバ設定（Storageルール）の確認」とお伝えください。'
          : `送信に失敗しました：${m}。通信環境をご確認ください`,
      )
    }
    setSubmitting(false)
    setProgress('')
  }

  async function submitCash() {
    if (!token) return
    setCashErr('')
    setCashDone('')
    if (!cashDate || !cashBank || !cashAmount) {
      setCashErr('日付・銀行名・金額を入力してください。')
      return
    }
    const amountNum = Number(cashAmount.replace(/,/g, ''))
    if (!amountNum || amountNum <= 0) {
      setCashErr('金額を正しく入力してください。')
      return
    }
    setCashSubmitting(true)
    try {
      await submitCashEntryPublic(uploadToken, {
        entryType: cashTab,
        date: cashDate,
        bankName: cashBank,
        accountNumber: cashAccount || undefined,
        amount: amountNum,
        depositType: cashTab === '現金預入' ? cashDepositType : undefined,
        member: memberName || undefined,
      })
      setCashDone(`${cashTab}を登録しました。`)
      setCashBank('')
      setCashAccount('')
      setCashAmount('')
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      setCashErr(`登録に失敗しました：${m}。通信環境をご確認ください`)
    }
    setCashSubmitting(false)
  }

  const photoPreviews = useMemo(() => photos.map((f) => URL.createObjectURL(f)), [photos])

  // ===== ファイル便 =====
  function fmtSize(bytes: number): string {
    if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + 'MB'
    return Math.max(1, Math.round(bytes / 1024)) + 'KB'
  }

  function addSendFiles(list: FileList | File[] | null) {
    if (!list || !list.length) return
    const arr = Array.from(list)
    setFileErr('')
    setFileDone('')
    const tooBig = arr.filter((f) => f.size > SCAN_FILE_MAX_BYTES)
    if (tooBig.length) {
      setFileErr(`${tooBig.map((f) => f.name).join('、')} はサイズが大きすぎます（1ファイル ${fmtSize(SCAN_FILE_MAX_BYTES)} まで）。`)
      return
    }
    setSendFiles((prev) => {
      const next = [...prev, ...arr]
      const total = next.reduce((s, f) => s + f.size, 0)
      if (total > SCAN_FILE_MAX_TOTAL) {
        setFileErr(`1回の送信は合計 ${fmtSize(SCAN_FILE_MAX_TOTAL)} までです。分けて送信してください。`)
        return prev
      }
      return next
    })
  }

  async function submitSendFiles() {
    if (!token || sendFiles.length === 0) return
    setFileSubmitting(true)
    setFileErr('')
    setFileDone('')
    try {
      await submitFilesPublic(uploadToken, sendFiles, sendFolder, memberName || undefined, sendComment, (done, total, name) => {
        setFileProgress(`送信中... (${Math.min(done + 1, total)}/${total}) ${name}`)
      })
      setFileDone(`✅ ${sendFiles.length}件のファイルを送信しました${sendFolder.trim() ? `（フォルダ：${sendFolder.trim()}）` : ''}。ありがとうございました。`)
      setHistory((prev) => [
        { at: new Date().toLocaleString('ja-JP'), label: `ファイル（${sendFiles.length}件${sendFolder.trim() ? `・${sendFolder.trim()}` : ''}）` },
        ...prev,
      ])
      setSendFiles([])
      setSendComment('')
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      setFileErr(
        /unauthorized|permission/i.test(m)
          ? '送信できませんでした。お手数ですが、会計事務所のご担当者にお伝えください。'
          : `送信に失敗しました：${m}。通信環境をご確認ください`,
      )
    }
    setFileSubmitting(false)
    setFileProgress('')
  }

  if (phase === 'loading') return <Center>読み込み中...</Center>
  if (phase === 'error')
    return (
      <Center>
        <div className="text-center max-w-sm">
          <div className="text-3xl mb-2">📡</div>
          <p className="text-gray-700 mb-3">読み込みに失敗しました。通信環境をご確認のうえ、再度お試しください。</p>
          <button onClick={() => window.location.reload()} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold">
            再読み込み
          </button>
        </div>
      </Center>
    )
  if (phase === 'invalid')
    return (
      <Center>
        <div className="text-center max-w-sm">
          <div className="text-3xl mb-2">⚠️</div>
          <p className="text-gray-700">
            この画面は会社ごとの専用リンクから開いてください。リンクがわからない場合は事務所へご連絡ください。
          </p>
        </div>
      </Center>
    )

  return (
    <div className="min-h-screen bg-gray-50 pb-10">
      <header className="bg-blue-600 text-white px-4 py-3">
        <div className="max-w-5xl mx-auto">
          <div className="text-xs opacity-80">書類スキャン・ファイル便</div>
          <div className="font-bold text-lg">
            {companyName}
            {memberName && <span className="text-sm font-normal opacity-90">｜{memberName} 様</span>}
          </div>
        </div>
      </header>

      <div className="max-w-md md:max-w-5xl mx-auto p-4">
        {/* スマホ：上部3ボタン */}
        <div className="grid grid-cols-3 gap-2 mb-4 md:hidden">
          {NAV.map((n) => (
            <button
              key={n.key}
              onClick={() => setView(n.key)}
              className={`relative py-2.5 rounded-xl border ${view === n.key ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-600 border-gray-200'}`}
            >
              <div className="text-xl leading-none">{n.icon}</div>
              <div className="text-[11px] font-semibold mt-1">{n.label}</div>
              {n.key === 'files' && inboxNew > 0 && (
                <span className="absolute top-1 right-1 text-[10px] font-bold text-white bg-red-500 rounded-full min-w-[16px] px-1">{inboxNew}</span>
              )}
            </button>
          ))}
        </div>

        <div className="md:flex md:gap-5 md:items-start">
          {/* PC：左サイドバー */}
          <aside className="hidden md:block md:w-56 shrink-0 space-y-1.5">
            {NAV.map((n) => (
              <button
                key={n.key}
                onClick={() => setView(n.key)}
                className={`w-full text-left px-3 py-3 rounded-xl flex items-center gap-3 border ${view === n.key ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'}`}
              >
                <span className="text-2xl leading-none">{n.icon}</span>
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-semibold">{n.label}</span>
                  <span className={`block text-[11px] ${view === n.key ? 'text-blue-100' : 'text-gray-400'}`}>{n.desc}</span>
                </span>
                {n.key === 'files' && inboxNew > 0 && (
                  <span className="text-[10px] font-bold text-white bg-red-500 rounded-full min-w-[18px] text-center px-1">{inboxNew}</span>
                )}
              </button>
            ))}
          </aside>

          {/* 右：選択中の機能 */}
          <div className="flex-1 min-w-0 space-y-4">
        {view === 'files' && inboxItems.length > 0 && (
          <div className="bg-white rounded-2xl border-2 border-blue-200 p-5">
            <h1 className="font-bold text-gray-800 mb-1">📥 事務所からのファイル</h1>
            <p className="text-xs text-gray-500 mb-3">タップしてダウンロードしてください（送信から90日で自動削除されます）。</p>
            {inboxMsg && <div className="text-xs text-red-600 mb-2 break-words">{inboxMsg}</div>}
            <ul className="space-y-2">
              {inboxItems.map((item) => {
                const isNew = !(item.file.downloads || {})[myDlKey]
                return (
                  <li key={item.srcToken + item.file.id} className="flex items-center justify-between gap-2 bg-gray-50 rounded-lg px-3 py-2">
                    <div className="min-w-0">
                      <div className="text-sm text-gray-800 truncate">
                        📄 {item.file.folder ? `${item.file.folder}／` : ''}{item.file.name}
                        {isNew && <span className="ml-1 text-[10px] font-bold text-white bg-red-500 rounded px-1.5 py-0.5 align-middle">新着</span>}
                      </div>
                      <div className="text-[10px] text-gray-400">
                        {new Date(item.file.sentAt).toLocaleDateString('ja-JP')}
                        {memberName ? (item.toAll ? '・全員宛' : '・あなた宛') : ''}
                      </div>
                      {item.file.comment && (
                        <div className="text-[11px] text-gray-600 bg-yellow-50 border border-yellow-200 rounded px-2 py-1 mt-1 whitespace-pre-wrap">
                          💬 {item.file.comment}
                        </div>
                      )}
                    </div>
                    <button
                      onClick={() => downloadInboxFile(item)}
                      className="shrink-0 px-3 py-1.5 text-xs bg-blue-600 text-white rounded-lg font-semibold"
                    >
                      ⬇ 保存
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        )}
        {view === 'files' && inboxItems.length === 0 && (
          <div className="bg-white rounded-2xl border border-gray-200 p-4 text-sm text-gray-400">
            📥 事務所からのファイルはまだありません。下の「ファイルを送る」から事務所へ送れます。
          </div>
        )}

        {view === 'scan' && (
        <>
        <div className="bg-white rounded-2xl border border-gray-200 p-5">
          <h1 className="font-bold text-gray-800 mb-3">書類を撮影して送信</h1>

          <label className="block text-sm font-medium text-gray-700 mb-1">書類の種類</label>
          <select
            value={docType}
            onChange={(e) => setDocType(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded mb-3"
          >
            {DOC_TYPES.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>

          {isPassbook && (
            <div className="grid grid-cols-2 gap-2 mb-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">銀行名</label>
                <input
                  value={bankName}
                  onChange={(e) => setBankName(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded"
                  placeholder="例：〇〇銀行"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">口座番号</label>
                <input
                  value={accountNumber}
                  onChange={(e) => setAccountNumber(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded"
                  placeholder="例：1234567"
                />
              </div>
            </div>
          )}

          {isReceipt && (
            <div className="mb-3">
              <label className="block text-xs text-gray-500 mb-1">使用者名（任意）</label>
              <input
                value={userName}
                onChange={(e) => setUserName(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded"
                placeholder="例：山田"
              />
            </div>
          )}

          <div className="flex gap-2 mb-3">
            <label className="flex-1 text-center px-3 py-2.5 bg-blue-600 text-white rounded-lg font-semibold cursor-pointer">
              📷 撮影する
              <input
                type="file"
                accept="image/*"
                capture="environment"
                multiple
                className="hidden"
                onChange={(e) => {
                  onCapture(e.target.files)
                  e.target.value = ''
                }}
              />
            </label>
            <label className="flex-1 text-center px-3 py-2.5 border border-blue-600 text-blue-700 rounded-lg font-semibold cursor-pointer">
              🖼 アルバムから選択
              <input
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  onCapture(e.target.files)
                  e.target.value = ''
                }}
              />
            </label>
          </div>

          {photos.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-3">
              {photoPreviews.map((src, i) => (
                <div key={i} className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={src} alt="" className="w-16 h-16 object-cover rounded border border-gray-200" />
                  <button
                    onClick={() => removePhoto(i)}
                    className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full w-5 h-5 text-xs leading-none"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          {submitErr && <div className="text-xs text-red-600 mb-2 break-words">{submitErr}</div>}
          {submitDone && (
            <div className="text-sm font-semibold text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2.5 mb-2">
              {submitDone}
            </div>
          )}

          <button
            onClick={submitBatch}
            disabled={submitting || photos.length === 0}
            className="w-full py-3 bg-green-600 text-white rounded-lg font-semibold hover:bg-green-700 disabled:opacity-60"
          >
            {submitting ? progress || '送信中...' : 'まとめて送信する'}
          </button>
        </div>

        {history.length > 0 && (
          <div className="bg-white rounded-2xl border border-gray-200 p-4">
            <h2 className="text-sm font-semibold text-gray-700 mb-2">送信履歴</h2>
            <ul className="space-y-1">
              {history.map((h, i) => (
                <li key={i} className="text-xs text-gray-500 flex justify-between">
                  <span>{h.label}</span>
                  <span>{h.at}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        </>
        )}

        {view === 'cash' && (
        <div className="bg-white rounded-2xl border border-gray-200 p-5">
          <h1 className="font-bold text-gray-800 mb-3">現金引出・現金預入を登録する</h1>
          <div className="flex gap-2 mb-3">
            <button
              onClick={() => setCashTab('現金引出')}
              className={`flex-1 py-2 rounded-lg text-sm font-semibold ${
                cashTab === '現金引出' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600'
              }`}
            >
              現金引出
            </button>
            <button
              onClick={() => setCashTab('現金預入')}
              className={`flex-1 py-2 rounded-lg text-sm font-semibold ${
                cashTab === '現金預入' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600'
              }`}
            >
              現金預入
            </button>
          </div>

          <label className="block text-xs text-gray-500 mb-1">日付</label>
          <input
            type="date"
            value={cashDate}
            onChange={(e) => setCashDate(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded mb-3"
          />

          <div className="grid grid-cols-2 gap-2 mb-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">銀行名</label>
              <input
                value={cashBank}
                onChange={(e) => setCashBank(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded"
                placeholder="例：〇〇銀行"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">口座番号</label>
              <input
                value={cashAccount}
                onChange={(e) => setCashAccount(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded"
                placeholder="任意"
              />
            </div>
          </div>

          <label className="block text-xs text-gray-500 mb-1">金額</label>
          <input
            inputMode="numeric"
            value={cashAmount}
            onChange={(e) => setCashAmount(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded mb-3"
            placeholder="例：50000"
          />

          {cashTab === '現金預入' && (
            <div className="mb-3">
              <label className="block text-xs text-gray-500 mb-1">預入の種類</label>
              <select
                value={cashDepositType}
                onChange={(e) => setCashDepositType(e.target.value as CashDepositType)}
                className="w-full px-3 py-2 border border-gray-300 rounded"
              >
                <option value="売上金の預入">売上金の預入</option>
                <option value="その他の預入">その他の預入</option>
              </select>
            </div>
          )}

          {cashErr && <div className="text-xs text-red-600 mb-2">{cashErr}</div>}
          {cashDone && <div className="text-xs text-green-700 mb-2">{cashDone}</div>}

          <button
            onClick={submitCash}
            disabled={cashSubmitting}
            className="w-full py-3 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 disabled:opacity-60"
          >
            {cashSubmitting ? '登録中...' : '登録する'}
          </button>
        </div>
        )}

        {view === 'files' && (
        <div className="bg-white rounded-2xl border border-gray-200 p-5">
          <h1 className="font-bold text-gray-800 mb-1">📎 ファイルを送る</h1>
          <p className="text-xs text-gray-500 mb-3">
            PDF・Excel・Word などのファイルを事務所へ送れます（お手元の元ファイルはそのまま残ります）。
          </p>

          <label className="block text-xs text-gray-500 mb-1">📂 フォルダ名（任意・まとめて整理したいとき）</label>
          <input
            value={sendFolder}
            onChange={(e) => setSendFolder(e.target.value)}
            placeholder="例：2026年3月分、決算資料 など"
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg mb-3"
          />

          <label className="block text-xs text-gray-500 mb-1">💬 コメント（任意・事務所に表示されます）</label>
          <textarea
            value={sendComment}
            onChange={(e) => setSendComment(e.target.value)}
            placeholder="例：3月分の通帳コピーです。2ページ目が見づらいかもしれません。"
            rows={2}
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg mb-3"
          />

          <div
            onDragOver={(e) => { e.preventDefault(); setFileDrag(true) }}
            onDragLeave={() => setFileDrag(false)}
            onDrop={(e) => {
              e.preventDefault()
              setFileDrag(false)
              addSendFiles(e.dataTransfer?.files || null)
            }}
            className={`border-2 border-dashed rounded-xl p-6 text-center mb-3 transition-colors ${fileDrag ? 'border-blue-500 bg-blue-50' : 'border-gray-300 bg-gray-50'}`}
          >
            <p className="text-sm text-gray-600 mb-2">ここにファイルをドラッグ＆ドロップ</p>
            <label className="inline-block px-4 py-2 text-sm bg-blue-600 text-white rounded-lg font-semibold cursor-pointer">
              ファイルを選択
              <input
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  addSendFiles(e.target.files)
                  e.target.value = ''
                }}
              />
            </label>
            <p className="text-[10px] text-gray-400 mt-2">1ファイル50MB・1回の送信200MBまで</p>
          </div>

          {sendFiles.length > 0 && (
            <ul className="mb-3 space-y-1">
              {sendFiles.map((f, i) => (
                <li key={i} className="flex items-center justify-between text-xs bg-gray-50 rounded px-2 py-1.5">
                  <span className="truncate mr-2">📄 {f.name}</span>
                  <span className="flex items-center gap-2 shrink-0 text-gray-400">
                    {fmtSize(f.size)}
                    <button onClick={() => setSendFiles((prev) => prev.filter((_, j) => j !== i))} className="text-red-500">
                      ×
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}

          {fileErr && <div className="text-xs text-red-600 mb-2 break-words">{fileErr}</div>}
          {fileDone && (
            <div className="text-sm font-semibold text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2.5 mb-2">
              {fileDone}
            </div>
          )}

          <button
            onClick={submitSendFiles}
            disabled={fileSubmitting || sendFiles.length === 0}
            className="w-full py-3 bg-green-600 text-white rounded-lg font-semibold hover:bg-green-700 disabled:opacity-60"
          >
            {fileSubmitting ? fileProgress || '送信中...' : 'まとめて送信する'}
          </button>
        </div>
        )}
          </div>{/* end content */}
        </div>{/* end md:flex */}

        <p className="text-[11px] text-gray-400 text-center">
          カメラが開かないときは LINE 等ではなく Safari / Chrome で開き直してください（アルバムからの選択はどのアプリでも使えます）。<br />
          送信された画像は送信から1年後、ファイルは90日後に自動削除されます（お手元の元データには影響しません）。
        </p>
      </div>
    </div>
  )
}

function Center({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen flex items-center justify-center bg-gray-50 p-6 text-gray-500">{children}</div>
}
