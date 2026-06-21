'use client'

import { useState, useEffect, useRef } from 'react'
import { exportAllAsZip, importAllFromZip, daysSinceLastBackup } from '@/lib/bank-statement/backup'

// 全データのローカルバックアップ（ZIP出力）と復元。前回バックアップ日を表示し催促する。
export default function BackupButton() {
  const [days, setDays] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => { setDays(daysSinceLastBackup()) }, [])

  // 未実施 or 7日以上経過なら催促表示
  const stale = days === null || days >= 7

  const handleExport = async () => {
    setBusy(true)
    try {
      const name = await exportAllAsZip()
      setDays(0)
      alert(`バックアップZIPを保存しました：\n${name}\n\nこのファイルを Google ドライブ等に保管してください。`)
    } catch (e) {
      alert('バックアップに失敗しました: ' + (e instanceof Error ? e.message : 'unknown'))
    }
    setBusy(false)
  }

  const handleRestoreFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    if (!confirm('バックアップZIPから復元します。\nこの端末のデータに取り込みます（顧問先一覧はマージ、各顧問先データは上書き）。\n続けますか？')) {
      e.target.value = ''
      return
    }
    setBusy(true)
    try {
      const r = await importAllFromZip(f)
      alert(`復元しました。\n顧問先 ${r.clientsTotal}件 / データ ${r.keysRestored}項目を取り込みました。\n画面を再読み込みします。`)
      window.location.reload()
    } catch (err) {
      alert('復元に失敗しました: ' + (err instanceof Error ? err.message : 'unknown'))
      setBusy(false)
    }
    e.target.value = ''
  }

  const label = days === null ? 'バックアップ未実施'
    : days === 0 ? '本日バックアップ済'
    : `前回バックアップ ${days}日前`

  return (
    <div className="flex items-center gap-2">
      <span
        title="全データをZIPで出力できます。控えとして Google ドライブ等へ保管してください。"
        className={`text-xs font-medium px-2.5 py-1 rounded-full whitespace-nowrap ${stale ? 'bg-amber-50 text-amber-700' : 'bg-gray-100 text-gray-500'}`}>
        💾 {label}{stale ? '・保存推奨' : ''}
      </span>
      <button onClick={handleExport} disabled={busy} className="fbtn fbtn-soft">
        {busy ? '処理中…' : 'バックアップ'}
      </button>
      <button onClick={() => fileRef.current?.click()} disabled={busy} className="fbtn fbtn-soft">
        復元
      </button>
      <input ref={fileRef} type="file" accept=".zip" className="hidden" onChange={handleRestoreFile} />
    </div>
  )
}
