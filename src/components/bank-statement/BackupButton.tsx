'use client'

import { useState, useEffect, useRef } from 'react'
import { exportAllAsZip, importAllFromZip, daysSinceLastBackup } from '@/lib/bank-statement/backup'

interface Props {
  // true: メニュー内に「バックアップ／復元」ボタンを表示。false: ヘッダーに前回日チップのみ表示。
  inMenu?: boolean
}

// 全データのローカルバックアップ（ZIP出力）と復元。
// ヘッダー: 前回バックアップ日のチップ（催促）。メニュー: 実際の操作ボタン。
export default function BackupButton({ inMenu }: Props) {
  const [days, setDays] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const refresh = () => setDays(daysSinceLastBackup())
    refresh()
    window.addEventListener('bs-backup-updated', refresh)
    window.addEventListener('focus', refresh)
    return () => {
      window.removeEventListener('bs-backup-updated', refresh)
      window.removeEventListener('focus', refresh)
    }
  }, [])

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

  // メニュー内: 操作ボタン
  if (inMenu) {
    return (
      <div className="-mx-2">
        <div className="px-3 pb-1.5 text-[11px] text-gray-500">
          💾 {label}{stale ? '（保存推奨）' : ''}
        </div>
        <button onClick={handleExport} disabled={busy}
          className="w-full px-3 py-2 text-left text-sm hover:bg-blue-50 flex items-center gap-2 disabled:opacity-50">
          <span className="w-5 text-center">⬇️</span>
          <span>{busy ? '処理中…' : '全データをバックアップ（ZIP出力）'}</span>
        </button>
        <button onClick={() => fileRef.current?.click()} disabled={busy}
          className="w-full px-3 py-2 text-left text-sm hover:bg-blue-50 flex items-center gap-2 disabled:opacity-50">
          <span className="w-5 text-center">♻️</span>
          <span>バックアップから復元（ZIP取込）</span>
        </button>
        <input ref={fileRef} type="file" accept=".zip" className="hidden" onChange={handleRestoreFile} />
      </div>
    )
  }

  // ヘッダー: 前回バックアップ日チップ（催促）
  return (
    <span
      title="バックアップ／復元は「メニュー」から行えます。控えはGoogleドライブ等へ保管してください。"
      className={`text-xs font-medium px-2.5 py-1 rounded-full whitespace-nowrap ${stale ? 'bg-amber-50 text-amber-700' : 'bg-gray-100 text-gray-500'}`}>
      💾 {label}{stale ? '・保存推奨' : ''}
    </span>
  )
}
