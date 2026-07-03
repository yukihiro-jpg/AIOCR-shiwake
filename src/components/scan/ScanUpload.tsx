'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  loadScanInfoPublic,
  submitScanBatchPublic,
  submitCashEntryPublic,
  type CashEntryType,
  type CashDepositType,
} from '@/lib/scan/store'
import { compressImage } from '@/lib/nenmatsu/image-compress'

const TOKEN_STORAGE_KEY = 'scan-token'

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

type Phase = 'loading' | 'invalid' | 'ready'

interface HistoryItem {
  at: string
  label: string
}

export default function ScanUpload() {
  const [phase, setPhase] = useState<Phase>('loading')
  const [token, setToken] = useState('')
  const [companyName, setCompanyName] = useState('')

  const [docType, setDocType] = useState<string>('レシート・領収書')
  const [bankName, setBankName] = useState('')
  const [accountNumber, setAccountNumber] = useState('')
  const [userName, setUserName] = useState('')
  const [photos, setPhotos] = useState<File[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [progress, setProgress] = useState('')
  const [submitErr, setSubmitErr] = useState('')
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
        const info = await loadScanInfoPublic(t)
        if (!info) {
          setPhase('invalid')
          return
        }
        setToken(t)
        setCompanyName(info.name)
        setPhase('ready')
      } catch {
        setPhase('invalid')
      }
    })()
  }, [])

  const isPassbook = docType === '通帳'
  const isReceipt = docType === 'レシート・領収書'

  function onCapture(list: FileList | null) {
    if (!list || !list.length) return
    setPhotos((prev) => [...prev, ...Array.from(list)])
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
    try {
      const blobs: Blob[] = []
      for (let i = 0; i < photos.length; i++) {
        setProgress(`画像を圧縮中... (${i + 1}/${photos.length})`)
        blobs.push(await compressImage(photos[i]))
      }
      setProgress('送信しています...')
      await submitScanBatchPublic(
        token,
        docType,
        {
          bankName: isPassbook ? bankName : undefined,
          accountNumber: isPassbook ? accountNumber : undefined,
          userName: isReceipt ? userName : undefined,
        },
        blobs,
      )
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
      setSubmitErr(`送信に失敗しました：${m}。通信環境をご確認ください`)
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
      await submitCashEntryPublic(token, {
        entryType: cashTab,
        date: cashDate,
        bankName: cashBank,
        accountNumber: cashAccount || undefined,
        amount: amountNum,
        depositType: cashTab === '現金預入' ? cashDepositType : undefined,
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

  if (phase === 'loading') return <Center>読み込み中...</Center>
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
        <div className="max-w-md mx-auto">
          <div className="text-xs opacity-80">書類スキャン</div>
          <div className="font-bold text-lg">{companyName}</div>
        </div>
      </header>

      <div className="max-w-md mx-auto p-4 space-y-4">
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

        <p className="text-[11px] text-gray-400 text-center">
          カメラが開かないときは LINE 等ではなく Safari / Chrome で開き直してください（アルバムからの選択はどのアプリでも使えます）。
        </p>
      </div>
    </div>
  )
}

function Center({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen flex items-center justify-center bg-gray-50 p-6 text-gray-500">{children}</div>
}
