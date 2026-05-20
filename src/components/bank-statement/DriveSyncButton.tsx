'use client'

import { useState, useEffect, useCallback } from 'react'
import { uploadClientToDrive, downloadClientFromDrive, getDriveConnected, subscribeSyncStatus, type SyncStatus } from '@/lib/bank-statement/drive-sync'

interface Props {
  clientId: string | null
  clientName: string | null
}

type SyncState = 'idle' | 'uploading' | 'downloading' | 'error'

export default function DriveSyncButton({ clientId, clientName }: Props) {
  const [connected, setConnected] = useState(false)
  const [syncState, setSyncState] = useState<SyncState>('idle')
  const [message, setMessage] = useState('')
  const [autoStatus, setAutoStatus] = useState<SyncStatus | null>(null)

  useEffect(() => {
    getDriveConnected().then(setConnected)
  }, [])

  useEffect(() => {
    const unsubscribe = subscribeSyncStatus((s) => setAutoStatus(s))
    return unsubscribe
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    if (params.get('drive') === 'connected') {
      setConnected(true)
      setMessage('Google Drive に接続しました')
      window.history.replaceState({}, '', window.location.pathname)
      setTimeout(() => setMessage(''), 3000)
    }
  }, [])

  const handleUpload = useCallback(async () => {
    if (!clientId) { setMessage('顧問先を選択してください'); return }
    const clientListRaw = localStorage.getItem('bank-statement-clients')
    const parsedClients = clientListRaw ? JSON.parse(clientListRaw) : []
    if (Array.isArray(parsedClients) && parsedClients.length === 0) {
      if (!window.confirm('顧問先が0件です。Driveの顧問先一覧が上書きされ、他のPCでも空になります。\n本当に保存しますか？')) return
    }
    setSyncState('uploading')
    setMessage('Drive にアップロード中...')
    try {
      const count = await uploadClientToDrive(clientId, clientName)
      setMessage(`${count}件のデータを Drive にアップロードしました`)
    } catch (err) {
      setMessage(`エラー: ${err instanceof Error ? err.message : 'アップロード失敗'}`)
      setSyncState('error')
    }
    setSyncState('idle')
    setTimeout(() => { setMessage('') }, 4000)
  }, [clientId, clientName])

  const handleDownload = useCallback(async () => {
    if (!clientId) { setMessage('顧問先を選択してください'); return }
    setSyncState('downloading')
    setMessage('Drive からダウンロード中...')
    try {
      const count = await downloadClientFromDrive(clientId, clientName)
      setMessage(`${count}件のデータをダウンロードしました。ページを再読込(F5)してください。`)
    } catch (err) {
      setMessage(`エラー: ${err instanceof Error ? err.message : 'ダウンロード失敗'}`)
      setSyncState('error')
    }
    setSyncState('idle')
  }, [clientId, clientName])

  const handleDisconnect = async () => {
    await fetch('/api/drive/status', { method: 'DELETE' })
    setConnected(false)
    setMessage('Google Drive との接続を解除しました')
    setTimeout(() => setMessage(''), 3000)
  }

  if (!connected) {
    return (
      <div className="flex items-center gap-2">
        <a href="/api/auth/google"
          className="px-3 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white rounded flex items-center gap-1">
          Drive連携
        </a>
        {message && <span className="text-xs text-green-400">{message}</span>}
      </div>
    )
  }

  // 自動同期ステータスの表示テキスト
  const autoBadge = (() => {
    if (!autoStatus) return null
    if (autoStatus.pushing || autoStatus.pendingPushes > 0) return { text: '同期中', cls: 'text-amber-300' }
    if (autoStatus.error) return { text: '同期エラー', cls: 'text-red-400', title: autoStatus.error }
    if (autoStatus.lastSyncAt) {
      const sec = Math.floor((Date.now() - autoStatus.lastSyncAt.getTime()) / 1000)
      if (sec < 60) return { text: '同期済', cls: 'text-emerald-300', title: `最終同期: ${sec}秒前` }
      const min = Math.floor(sec / 60)
      return { text: `${min}分前`, cls: 'text-emerald-300', title: `最終同期: ${min}分前` }
    }
    return null
  })()

  return (
    <div className="flex items-center gap-1">
      <span className="text-xs text-green-400 font-medium">Drive</span>
      {autoBadge && (
        <span className={`text-[10px] ${autoBadge.cls} px-1 rounded`} title={autoBadge.title}>
          {autoBadge.text}
        </span>
      )}
      <button onClick={handleUpload} disabled={syncState !== 'idle'}
        title="現在の顧問先データをDriveにアップロード"
        className="px-2 py-1 text-xs bg-green-600 hover:bg-green-700 text-white rounded disabled:opacity-50">
        {syncState === 'uploading' ? '...' : '↑保存'}
      </button>
      <button onClick={handleDownload} disabled={syncState !== 'idle'}
        title="Driveから現在の顧問先データをダウンロード"
        className="px-2 py-1 text-xs bg-sky-600 hover:bg-sky-700 text-white rounded disabled:opacity-50">
        {syncState === 'downloading' ? '...' : '↓読込'}
      </button>
      <button onClick={handleDisconnect}
        className="px-1 py-1 text-xs text-gray-400 hover:text-red-400" title="Drive連携解除">×</button>
      {message && <span className="text-xs text-amber-300 ml-1">{message}</span>}
    </div>
  )
}
