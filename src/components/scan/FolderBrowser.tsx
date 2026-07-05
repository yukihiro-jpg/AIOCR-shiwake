'use client'

// DocuWorks風のフォルダツリー共有フォルダ（顧問先ページ・事務所ページ共通で使うブラウザUI）。
// ルート（toOffice/toClient）は仮想（DBに実体を持たない）。folders はルート配下のサブフォルダのみ。

import { useMemo, useState } from 'react'
import type { ScanFolder } from '@/lib/scan/store'

export interface BrowserFile {
  id: string
  name: string
  size: number
  folderId: string | null
  at: string // 表示用日時（ISO文字列）
  comment?: string
  member?: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw: any // 元レコード（ダウンロード等で使う）
}

export interface FolderBrowserProps {
  rootKey: 'toOffice' | 'toClient'
  rootLabel: string
  folders: ScanFolder[] // このrootのフォルダ全部
  files: BrowserFile[] // このrootのファイル全部
  canManageFolders: boolean // フォルダ作成/改名/削除の可否
  canAddFiles: boolean // アップロード/送付の可否
  addFilesLabel: string
  onCreateFolder: (parentId: string | null, name: string) => Promise<void>
  onRenameFolder: (folder: ScanFolder, name: string) => Promise<void>
  onDeleteFolder: (folder: ScanFolder) => Promise<void>
  onAddFiles: (parentId: string | null, files: File[], comment: string) => Promise<void>
  onDownload: (file: BrowserFile) => Promise<void>
  onDeleteFile?: (file: BrowserFile) => Promise<void>
  renderFileBadges?: (file: BrowserFile) => React.ReactNode
  onChanged: () => void
  maxFileBytes?: number
  maxTotalBytes?: number
  controlledId?: string | null // 指定するとサイドバー等の外部から現在フォルダを制御する
  onNavigate?: (id: string | null) => void
}

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + 'MB'
  return Math.max(1, Math.round(bytes / 1024)) + 'KB'
}

// フォルダアイコン（絵文字ではなく塗り色で区別する小さなSVG）
export function FolderIcon({ color, size = 18 }: { color: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 16" fill="none" xmlns="http://www.w3.org/2000/svg" className="shrink-0">
      <path
        d="M1 2.5C1 1.67157 1.67157 1 2.5 1H7.5L9.5 3H17.5C18.3284 3 19 3.67157 19 4.5V13.5C19 14.3284 18.3284 15 17.5 15H2.5C1.67157 15 1 14.3284 1 13.5V2.5Z"
        fill={color}
      />
    </svg>
  )
}

export const FOLDER_COLOR = {
  toOffice: '#16a34a', // 顧問先→税理士事務所（緑）
  toClient: '#2563eb', // 税理士事務所→顧問先（青）
  sub: '#f59e0b', // ユーザー作成サブフォルダ（黄/オレンジ）
} as const

export default function FolderBrowser({
  rootKey,
  rootLabel,
  folders,
  files,
  canManageFolders,
  canAddFiles,
  addFilesLabel,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onAddFiles,
  onDownload,
  onDeleteFile,
  renderFileBadges,
  onChanged,
  maxFileBytes,
  maxTotalBytes,
  controlledId,
  onNavigate,
}: FolderBrowserProps) {
  const [internalId, setInternalId] = useState<string | null>(null)
  const currentId = controlledId !== undefined ? controlledId : internalId
  const setCurrentId = (id: string | null) => {
    if (onNavigate) onNavigate(id)
    else setInternalId(id)
  }
  const [newFolderOpen, setNewFolderOpen] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameName, setRenameName] = useState('')
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const [comment, setComment] = useState('')
  const [drag, setDrag] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [done, setDone] = useState('')

  const byId = useMemo(() => {
    const m = new Map<string, ScanFolder>()
    for (const f of folders) m.set(f.id, f)
    return m
  }, [folders])

  // パンくず（ルート → ... → 現在地）
  const crumbs = useMemo(() => {
    const chain: ScanFolder[] = []
    let cur = currentId ? byId.get(currentId) : undefined
    while (cur) {
      chain.unshift(cur)
      cur = cur.parentId ? byId.get(cur.parentId) : undefined
    }
    return chain
  }, [currentId, byId])

  const subFolders = folders.filter((f) => (f.parentId || null) === currentId)
  const curFiles = files
    .filter((f) => (f.folderId || null) === currentId)
    .sort((a, b) => b.at.localeCompare(a.at))

  function resetMsgs() {
    setErr('')
    setDone('')
  }

  async function createFolder() {
    const name = newFolderName.trim()
    if (!name) return
    setBusy(true)
    resetMsgs()
    try {
      await onCreateFolder(currentId, name)
      setNewFolderName('')
      setNewFolderOpen(false)
      onChanged()
    } catch (e) {
      setErr('フォルダの作成に失敗しました：' + (e instanceof Error ? e.message : ''))
    }
    setBusy(false)
  }

  async function submitRename(folder: ScanFolder) {
    const name = renameName.trim()
    if (!name) return
    setBusy(true)
    resetMsgs()
    try {
      await onRenameFolder(folder, name)
      setRenaming(null)
      onChanged()
    } catch (e) {
      setErr('改名に失敗しました：' + (e instanceof Error ? e.message : ''))
    }
    setBusy(false)
  }

  async function removeFolder(folder: ScanFolder) {
    if (!confirm(`フォルダ「${folder.name}」を削除しますか？\n中のファイル・サブフォルダもすべて削除され、元に戻せません。`)) return
    setBusy(true)
    resetMsgs()
    try {
      await onDeleteFolder(folder)
      onChanged()
    } catch (e) {
      setErr('削除に失敗しました：' + (e instanceof Error ? e.message : ''))
    }
    setBusy(false)
  }

  function addPendingFiles(list: FileList | File[] | null) {
    if (!list || !list.length) return
    const arr = Array.from(list)
    resetMsgs()
    if (maxFileBytes) {
      const tooBig = arr.filter((f) => f.size > maxFileBytes)
      if (tooBig.length) {
        setErr(`${tooBig.map((f) => f.name).join('、')} はサイズが大きすぎます（1ファイル ${fmtSize(maxFileBytes)} まで）。`)
        return
      }
    }
    setPendingFiles((prev) => {
      const next = [...prev, ...arr]
      if (maxTotalBytes) {
        const total = next.reduce((s, f) => s + f.size, 0)
        if (total > maxTotalBytes) {
          setErr(`1回の送信は合計 ${fmtSize(maxTotalBytes)} までです。分けて送信してください。`)
          return prev
        }
      }
      return next
    })
  }

  async function submitFiles() {
    if (!pendingFiles.length) return
    setBusy(true)
    resetMsgs()
    try {
      await onAddFiles(currentId, pendingFiles, comment)
      setDone(`✅ ${pendingFiles.length}件を送信しました。`)
      setPendingFiles([])
      setComment('')
      onChanged()
    } catch (e) {
      setErr('送信に失敗しました：' + (e instanceof Error ? e.message : ''))
    }
    setBusy(false)
  }

  async function removeFile(file: BrowserFile) {
    if (!onDeleteFile) return
    if (!confirm(`「${file.name}」を削除しますか？元に戻せません。`)) return
    setBusy(true)
    try {
      await onDeleteFile(file)
      onChanged()
    } catch (e) {
      alert('削除に失敗しました：' + (e instanceof Error ? e.message : ''))
    }
    setBusy(false)
  }

  const rootColor = FOLDER_COLOR[rootKey]

  return (
    <div>
      {/* パンくず */}
      <div className="flex items-center flex-wrap gap-1 text-sm mb-3">
        <button
          onClick={() => setCurrentId(null)}
          className={`inline-flex items-center gap-1 px-2 py-1 rounded ${currentId === null ? 'bg-gray-100 font-semibold text-gray-800' : 'text-gray-500 hover:bg-gray-50'}`}
        >
          <FolderIcon color={rootColor} size={16} />
          {rootLabel}
        </button>
        {crumbs.map((c) => (
          <span key={c.id} className="inline-flex items-center gap-1">
            <span className="text-gray-300">／</span>
            <button
              onClick={() => setCurrentId(c.id)}
              className={`inline-flex items-center gap-1 px-2 py-1 rounded ${currentId === c.id ? 'bg-gray-100 font-semibold text-gray-800' : 'text-gray-500 hover:bg-gray-50'}`}
            >
              <FolderIcon color={FOLDER_COLOR.sub} size={16} />
              {c.name}
            </button>
          </span>
        ))}
      </div>

      {err && <div className="text-xs text-red-600 mb-2 break-words bg-red-50 border border-red-200 rounded px-3 py-2">{err}</div>}
      {done && <div className="text-xs text-green-700 mb-2 bg-green-50 border border-green-200 rounded px-3 py-2">{done}</div>}

      {/* フォルダ操作 */}
      {canManageFolders && (
        <div className="mb-3">
          {!newFolderOpen ? (
            <button
              onClick={() => setNewFolderOpen(true)}
              className="px-3 py-1.5 text-xs border border-gray-300 rounded hover:bg-gray-50"
            >
              ＋ 新規フォルダ
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <input
                autoFocus
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') createFolder()
                  if (e.key === 'Escape') { setNewFolderOpen(false); setNewFolderName('') }
                }}
                placeholder="フォルダ名"
                className="px-3 py-1.5 text-sm border border-gray-300 rounded"
              />
              <button onClick={createFolder} disabled={busy || !newFolderName.trim()} className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded disabled:opacity-50">
                作成
              </button>
              <button onClick={() => { setNewFolderOpen(false); setNewFolderName('') }} className="px-3 py-1.5 text-xs text-gray-500">
                取消
              </button>
            </div>
          )}
        </div>
      )}

      {/* サブフォルダ一覧 */}
      {subFolders.length > 0 && (
        <ul className="mb-3 divide-y divide-gray-100 border border-gray-200 rounded-lg overflow-hidden">
          {subFolders.map((f) => (
            <li key={f.id} className="flex items-center justify-between gap-2 px-3 py-2 hover:bg-gray-50">
              {renaming === f.id ? (
                <div className="flex items-center gap-2 flex-1">
                  <FolderIcon color={FOLDER_COLOR.sub} />
                  <input
                    autoFocus
                    value={renameName}
                    onChange={(e) => setRenameName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') submitRename(f)
                      if (e.key === 'Escape') setRenaming(null)
                    }}
                    className="flex-1 px-2 py-1 text-sm border border-gray-300 rounded"
                  />
                  <button onClick={() => submitRename(f)} disabled={busy} className="px-2 py-1 text-xs bg-blue-600 text-white rounded">
                    保存
                  </button>
                  <button onClick={() => setRenaming(null)} className="px-2 py-1 text-xs text-gray-500">
                    取消
                  </button>
                </div>
              ) : (
                <>
                  <button
                    onClick={() => setCurrentId(f.id)}
                    className="flex-1 flex items-center gap-2 text-left text-sm text-gray-800"
                  >
                    <FolderIcon color={FOLDER_COLOR.sub} />
                    {f.name}
                  </button>
                  {canManageFolders && (
                    <span className="inline-flex gap-1 shrink-0">
                      <button
                        onClick={() => { setRenaming(f.id); setRenameName(f.name) }}
                        className="px-2 py-1 text-xs border border-gray-300 rounded hover:bg-gray-50"
                      >
                        改名
                      </button>
                      <button
                        onClick={() => removeFolder(f)}
                        disabled={busy}
                        className="px-2 py-1 text-xs border border-red-300 text-red-600 rounded hover:bg-red-50"
                      >
                        削除
                      </button>
                    </span>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* ファイル一覧 */}
      {curFiles.length === 0 ? (
        <p className="text-sm text-gray-400 py-4 text-center border border-dashed border-gray-200 rounded mb-3">
          このフォルダにファイルはありません。
        </p>
      ) : (
        <ul className="mb-3 divide-y divide-gray-100 border border-gray-200 rounded-lg overflow-hidden">
          {curFiles.map((f) => (
            <li key={f.id} className="px-3 py-2 hover:bg-gray-50">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-gray-800 truncate flex items-center gap-1.5 flex-wrap">
                    📄 {f.name}
                    {renderFileBadges?.(f)}
                  </div>
                  <div className="text-[11px] text-gray-400">
                    {fmtSize(f.size)}・{new Date(f.at).toLocaleString('ja-JP')}
                    {f.member ? `・👤${f.member}` : ''}
                  </div>
                  {f.comment && (
                    <div className="text-[11px] text-gray-600 bg-yellow-50 border border-yellow-200 rounded px-2 py-1 mt-1 whitespace-pre-wrap">
                      💬 {f.comment}
                    </div>
                  )}
                </div>
                <span className="inline-flex gap-1.5 shrink-0">
                  <button onClick={() => onDownload(f)} className="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700">
                    ⬇ DL
                  </button>
                  {onDeleteFile && (
                    <button onClick={() => removeFile(f)} className="px-3 py-1 text-xs border border-red-300 text-red-600 rounded hover:bg-red-50">
                      削除
                    </button>
                  )}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* アップロード／送付エリア */}
      {canAddFiles && (
        <div className="border border-gray-200 rounded-xl p-4 bg-gray-50">
          <div className="text-xs font-semibold text-gray-600 mb-2">📤 {addFilesLabel}（このフォルダへ）</div>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="コメント（任意）"
            rows={2}
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg mb-2"
          />
          <div
            onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); addPendingFiles(e.dataTransfer?.files || null) }}
            className={`border-2 border-dashed rounded-xl p-4 text-center mb-2 transition-colors ${drag ? 'border-blue-500 bg-blue-50' : 'border-gray-300 bg-white'}`}
          >
            <p className="text-xs text-gray-500 mb-2">ここにファイルをドラッグ＆ドロップ</p>
            <label className="inline-block px-4 py-2 text-sm bg-blue-600 text-white rounded-lg font-semibold cursor-pointer">
              ファイルを選択
              <input
                type="file"
                multiple
                className="hidden"
                onChange={(e) => { addPendingFiles(e.target.files); e.target.value = '' }}
              />
            </label>
          </div>

          {pendingFiles.length > 0 && (
            <ul className="mb-2 space-y-1">
              {pendingFiles.map((f, i) => (
                <li key={i} className="flex items-center justify-between text-xs bg-white rounded px-2 py-1.5 border border-gray-200">
                  <span className="truncate mr-2">📄 {f.name}</span>
                  <span className="flex items-center gap-2 shrink-0 text-gray-400">
                    {fmtSize(f.size)}
                    <button onClick={() => setPendingFiles((prev) => prev.filter((_, j) => j !== i))} className="text-red-500">
                      ×
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}

          <button
            onClick={submitFiles}
            disabled={busy || pendingFiles.length === 0}
            className="w-full py-2.5 bg-green-600 text-white rounded-lg font-semibold hover:bg-green-700 disabled:opacity-60"
          >
            {busy ? '送信中...' : '送信する'}
          </button>
        </div>
      )}
    </div>
  )
}
