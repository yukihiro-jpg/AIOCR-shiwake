'use client'
import { useState, useEffect } from 'react'
import { importInvoiceCsv, getInvoiceCount, clearInvoiceRegistry } from '@/lib/bank-statement/invoice-registry'

interface Props {
  open: boolean
  onClose: () => void
}

export default function InvoiceRegistryDialog({ open, onClose }: Props) {
  const [count, setCount] = useState(0)
  const [importing, setImporting] = useState(false)
  const [progress, setProgress] = useState('')

  useEffect(() => {
    if (open) getInvoiceCount().then(setCount)
  }, [open])

  if (!open) return null

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setImporting(true)
    setProgress('読込中...')
    try {
      const imported = await importInvoiceCsv(file, (done, total) => {
        setProgress(`${done.toLocaleString()} / ${total.toLocaleString()} 件`)
      })
      setProgress(`完了: ${imported.toLocaleString()} 件を登録`)
      const newCount = await getInvoiceCount()
      setCount(newCount)
    } catch (err) {
      setProgress(`エラー: ${err instanceof Error ? err.message : '不明'}`)
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center" onMouseDown={(e) => { if (e.target === e.currentTarget) (onClose)() }}>
      <div className="bg-white rounded-lg shadow-xl w-[500px] max-h-[80vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-4 border-b">
          <h2 className="text-lg font-bold">インボイス事業者登録簿</h2>
        </div>
        <div className="px-6 py-4 space-y-4">
          <div className="text-sm text-gray-700">
            国税庁の適格請求書発行事業者CSVをアップロードして、
            レシートのインボイス番号から事業者名を自動取得できるようにします。
          </div>
          <div className="flex items-center gap-3 p-3 bg-gray-50 rounded">
            <span className="text-sm font-bold">現在の登録数:</span>
            <span className="text-lg font-bold text-blue-600">{count.toLocaleString()} 件</span>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">CSVファイルを選択</label>
            <input
              type="file"
              accept=".csv"
              onChange={handleFileChange}
              disabled={importing}
              className="block w-full text-sm border rounded p-2"
            />
          </div>
          {progress && (
            <div className={`text-sm p-2 rounded ${importing ? 'bg-blue-50 text-blue-700' : 'bg-green-50 text-green-700'}`}>
              {progress}
            </div>
          )}
          <button
            onClick={async () => {
              if (!confirm('登録簿を全件削除しますか？')) return
              await clearInvoiceRegistry()
              setCount(0)
              setProgress('全件削除しました')
            }}
            disabled={importing || count === 0}
            className="text-xs text-red-600 hover:underline disabled:opacity-40">
            登録簿を全件クリア
          </button>
        </div>
        <div className="px-6 py-3 border-t flex justify-end">
          <button onClick={onClose} className="px-4 py-2 text-sm bg-gray-200 rounded hover:bg-gray-300">閉じる</button>
        </div>
      </div>
    </div>
  )
}
