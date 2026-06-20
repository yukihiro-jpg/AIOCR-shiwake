'use client'

import { useState, useEffect } from 'react'
import {
  getRoomPassphrase,
  setRoomPassphrase,
  clearRoomPassphrase,
  testFirebaseConnection,
} from '@/lib/bank-statement/firebase-sync'

interface Props {
  open: boolean
  onClose: () => void
  // 合言葉が確定（新規設定 or 変更）したら呼ばれる
  onConfirmed: () => void
  // 初回設定（まだ合言葉が無い）かどうか。true のときは閉じる導線を制限
  firstTime?: boolean
}

export default function FirebaseRoomDialog({ open, onClose, onConfirmed, firstTime }: Props) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setValue(getRoomPassphrase() || '')
      setError(null)
    }
  }, [open])

  if (!open) return null

  const handleSave = async () => {
    const pass = value.trim()
    if (pass.length < 4) {
      setError('合言葉は4文字以上で入力してください。')
      return
    }
    setBusy(true)
    setError(null)
    try {
      setRoomPassphrase(pass)
      const ok = await testFirebaseConnection()
      if (!ok) {
        setError('サーバーに接続できませんでした。通信環境を確認してください。')
        setBusy(false)
        return
      }
      onConfirmed()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : '接続に失敗しました。')
    } finally {
      setBusy(false)
    }
  }

  const handleClear = () => {
    if (!confirm('この端末の合言葉を消去します。再度開くときに入力が必要になります。よろしいですか？')) return
    clearRoomPassphrase()
    setValue('')
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
        <h2 className="text-lg font-bold text-gray-800">データ共有の合言葉</h2>
        <p className="mt-2 text-sm leading-relaxed text-gray-600">
          チームでデータを共有するための<strong>合言葉</strong>を入力してください。
          <br />
          同じ合言葉を入れた人どうしで、顧問先データがリアルタイムに同期されます。
        </p>
        <ul className="mt-2 list-disc pl-5 text-xs text-gray-500">
          <li>入力はこの端末で最初の1回だけ（次回からは自動でつながります）</li>
          <li>合言葉はこの端末内にのみ保存され、外部には記録されません</li>
          <li>合言葉は社内のメンバー以外に教えないでください</li>
        </ul>

        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleSave() }}
          placeholder="合言葉を入力"
          autoFocus
          className="mt-4 w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
        />

        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

        <div className="mt-5 flex items-center justify-between gap-2">
          <div>
            {!firstTime && (
              <button
                onClick={handleClear}
                className="text-xs text-gray-400 hover:text-red-500"
              >
                この端末の合言葉を消去
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              disabled={busy}
              className="rounded px-4 py-2 text-sm text-gray-600 hover:bg-gray-100"
            >
              {firstTime ? 'あとで（共有なしで使う）' : 'キャンセル'}
            </button>
            <button
              onClick={handleSave}
              disabled={busy}
              className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {busy ? '接続中…' : '接続する'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
