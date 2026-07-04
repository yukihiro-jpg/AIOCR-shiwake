'use client'

// Google共有ドライブへの一括保存ダイアログ（スキャン受信・年調で共用）。
// 共有ドライブ→フォルダを辿って保存先を選び、新規フォルダ作成もできる。
// files の folder 指定があれば、保存先の下にサブフォルダを作って振り分ける（例：従業員ごと）。

import { useState } from 'react'
import {
  getAccessToken,
  getGoogleClientId,
  listSharedDrives,
  listFolders,
  createDriveFolder,
  uploadToDrive,
  type DriveItem,
} from '@/lib/google-drive'

export interface DriveFile {
  name: string
  blob: Blob
  folder?: string // 指定時は保存先フォルダの下にこの名前のサブフォルダを作って入れる
}

interface Props {
  title: string
  // 保存実行時に呼ばれる（画像のダウンロード等の重い処理はここで行う）
  getFiles: (onProgress: (msg: string) => void) => Promise<DriveFile[]>
  onClose: () => void
  // 全件の保存が成功したときに呼ばれる（保存済みマーク付け等）
  onSaved?: () => void
}

type Crumb = { id: string; name: string }

export default function DriveSaveDialog({ title, getFiles, onClose, onSaved }: Props) {
  const [connected, setConnected] = useState(false)
  const [drives, setDrives] = useState<DriveItem[]>([])
  const [drive, setDrive] = useState<DriveItem | null>(null)
  const [crumbs, setCrumbs] = useState<Crumb[]>([]) // ドライブ直下からの階層
  const [folders, setFolders] = useState<DriveItem[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [newName, setNewName] = useState('')
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState('')
  const [done, setDone] = useState('')

  const currentParentId = crumbs.length ? crumbs[crumbs.length - 1].id : drive?.id || ''

  async function connect() {
    setErr('')
    setLoading(true)
    try {
      const token = await getAccessToken()
      const ds = await listSharedDrives(token)
      setDrives(ds)
      setConnected(true)
      if (!ds.length) setErr('共有ドライブが見つかりません。共有ドライブに参加しているGoogleアカウントでログインしてください')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
    setLoading(false)
  }

  async function openDrive(d: DriveItem) {
    setErr('')
    setLoading(true)
    try {
      const token = await getAccessToken()
      setDrive(d)
      setCrumbs([])
      setFolders(await listFolders(token, d.id, d.id))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
    setLoading(false)
  }

  async function openFolder(f: DriveItem) {
    if (!drive) return
    setErr('')
    setLoading(true)
    try {
      const token = await getAccessToken()
      setCrumbs((prev) => [...prev, { id: f.id, name: f.name }])
      setFolders(await listFolders(token, drive.id, f.id))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
    setLoading(false)
  }

  async function goTo(index: number) {
    // index=-1 でドライブ直下、それ以外は crumbs[index] へ
    if (!drive) return
    setErr('')
    setLoading(true)
    try {
      const token = await getAccessToken()
      const next = index < 0 ? [] : crumbs.slice(0, index + 1)
      setCrumbs(next)
      const parent = next.length ? next[next.length - 1].id : drive.id
      setFolders(await listFolders(token, drive.id, parent))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
    setLoading(false)
  }

  async function makeFolder() {
    const name = newName.trim()
    if (!name || !drive) return
    setErr('')
    setLoading(true)
    try {
      const token = await getAccessToken()
      await createDriveFolder(token, currentParentId, name)
      setNewName('')
      setFolders(await listFolders(token, drive.id, currentParentId))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
    setLoading(false)
  }

  async function save() {
    if (!drive) return
    setUploading(true)
    setErr('')
    setDone('')
    try {
      const token = await getAccessToken()
      const files = await getFiles((m) => setProgress(m))
      if (!files.length) throw new Error('保存するファイルがありません')
      // folder 指定ごとにサブフォルダを1回だけ作成
      const folderIds = new Map<string, string>()
      let doneCount = 0
      for (const f of files) {
        let parent = currentParentId
        if (f.folder) {
          if (!folderIds.has(f.folder)) {
            const created = await createDriveFolder(token, currentParentId, f.folder)
            folderIds.set(f.folder, created.id)
          }
          parent = folderIds.get(f.folder)!
        }
        setProgress(`アップロード中... (${++doneCount}/${files.length}) ${f.name}`)
        await uploadToDrive(token, parent, f.name, f.blob)
      }
      const place = [drive.name, ...crumbs.map((c) => c.name)].join(' / ')
      setDone(`${files.length}件を「${place}」に保存しました。`)
      onSaved?.()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
    setUploading(false)
    setProgress('')
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl p-6 w-full max-w-2xl max-h-[85vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <h2 className="font-bold text-gray-800 mb-1">📁 Google共有ドライブへ保存</h2>
        <p className="text-xs text-gray-500 mb-4">{title}</p>

        {err && <div className="text-sm bg-red-50 border border-red-200 text-red-700 rounded px-3 py-2 mb-3 break-words">{err}</div>}
        {done && <div className="text-sm bg-green-50 border border-green-200 text-green-700 rounded px-3 py-2 mb-3">{done}</div>}

        {!connected ? (
          <div className="text-center py-6">
            {!getGoogleClientId() ? (
              <p className="text-sm text-gray-600 mb-3">
                GoogleクライアントIDが未設定です。<br />
                ホーム右上の「⚙️共通設定」で登録してから、もう一度お試しください。
              </p>
            ) : (
              <p className="text-sm text-gray-600 mb-3">Googleアカウントに接続して、共有ドライブを表示します。</p>
            )}
            <button
              onClick={connect}
              disabled={loading || !getGoogleClientId()}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:opacity-50"
            >
              {loading ? '接続中...' : 'Googleに接続する'}
            </button>
          </div>
        ) : !drive ? (
          <div>
            <div className="text-sm font-semibold text-gray-700 mb-2">共有ドライブを選択</div>
            {loading ? (
              <p className="text-sm text-gray-500 py-4 text-center">読み込み中...</p>
            ) : (
              <ul className="divide-y divide-gray-100 border border-gray-200 rounded-lg overflow-hidden">
                {drives.map((d) => (
                  <li key={d.id}>
                    <button onClick={() => openDrive(d)} className="w-full text-left px-4 py-3 text-sm hover:bg-blue-50 flex items-center gap-2">
                      <span>🗂️</span>
                      {d.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div>
            {/* パンくず */}
            <div className="text-xs text-gray-600 mb-2 flex items-center gap-1 flex-wrap">
              <button onClick={() => { setDrive(null); setCrumbs([]) }} className="text-blue-600 hover:underline">共有ドライブ</button>
              <span>›</span>
              <button onClick={() => goTo(-1)} className="text-blue-600 hover:underline">{drive.name}</button>
              {crumbs.map((c, i) => (
                <span key={c.id} className="flex items-center gap-1">
                  <span>›</span>
                  <button onClick={() => goTo(i)} className="text-blue-600 hover:underline">{c.name}</button>
                </span>
              ))}
            </div>

            {loading ? (
              <p className="text-sm text-gray-500 py-4 text-center">読み込み中...</p>
            ) : (
              <ul className="divide-y divide-gray-100 border border-gray-200 rounded-lg overflow-hidden mb-3 max-h-56 overflow-y-auto">
                {folders.length === 0 && <li className="px-4 py-3 text-xs text-gray-400">フォルダがありません（ここに保存できます）</li>}
                {folders.map((f) => (
                  <li key={f.id}>
                    <button onClick={() => openFolder(f)} className="w-full text-left px-4 py-2.5 text-sm hover:bg-blue-50 flex items-center gap-2">
                      <span>📁</span>
                      {f.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {/* 新規フォルダ */}
            <div className="flex gap-2 mb-4">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') makeFolder() }}
                placeholder="新しいフォルダ名"
                className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-lg"
              />
              <button onClick={makeFolder} disabled={loading || !newName.trim()} className="px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 whitespace-nowrap">
                ＋ フォルダ作成
              </button>
            </div>

            <button
              onClick={save}
              disabled={uploading}
              className="w-full py-3 bg-green-600 text-white rounded-lg font-semibold hover:bg-green-700 disabled:opacity-60"
            >
              {uploading ? progress || '保存中...' : `📤 この場所（${crumbs.length ? crumbs[crumbs.length - 1].name : drive.name}）に保存する`}
            </button>
          </div>
        )}

        <div className="text-right mt-4">
          <button onClick={onClose} className="px-4 py-2 bg-gray-200 text-gray-700 rounded text-sm">閉じる</button>
        </div>
      </div>
    </div>
  )
}
