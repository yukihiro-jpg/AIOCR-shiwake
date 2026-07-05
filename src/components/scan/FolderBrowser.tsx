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
  onGetBlob?: (file: BrowserFile) => Promise<Blob> // 指定するとプレビュー可能に
  enableAiAsk?: boolean // ファイル選択＋AI質問を有効化（税理士側の届いた資料用）
  onAiAsk?: (files: BrowserFile[], question: string, onProgress?: (m: string) => void) => Promise<string>
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

// ファイル名の拡張子から種類マーク（色付き丸バッジ）を決める
function fileTypeBadge(name: string): { label: string; bg: string } {
  const ext = (name.split('.').pop() || '').toLowerCase()
  if (ext === 'pdf') return { label: 'PDF', bg: '#ef4444' } // 赤
  if (ext === 'xlsx' || ext === 'xls' || ext === 'xlsm') return { label: 'Excel', bg: '#16a34a' } // 緑
  if (ext === 'csv') return { label: 'CSV', bg: '#16a34a' } // 緑
  if (ext === 'doc' || ext === 'docx') return { label: 'Word', bg: '#2563eb' } // 青
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'bmp', 'tif', 'tiff'].includes(ext)) return { label: '画像', bg: '#6b7280' }
  if (ext === 'ppt' || ext === 'pptx') return { label: 'PPT', bg: '#ea580c' }
  if (ext === 'zip' || ext === 'rar' || ext === '7z') return { label: 'ZIP', bg: '#6b7280' }
  if (ext === 'txt') return { label: 'TXT', bg: '#6b7280' }
  return { label: ext ? ext.toUpperCase().slice(0, 4) : 'FILE', bg: '#6b7280' }
}

// ファイル種類マーク（丸バッジ）：PDF=赤・Excel/CSV=緑・Word=青 など
export function FileTypeBadge({ name }: { name: string }) {
  const { label, bg } = fileTypeBadge(name)
  return (
    <span
      className="inline-flex items-center justify-center shrink-0 text-[9px] font-bold text-white rounded-full px-1.5 py-0.5 leading-none align-middle"
      style={{ background: bg }}
      title={label}
    >
      {label}
    </span>
  )
}

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
  onGetBlob,
  enableAiAsk,
  onAiAsk,
}: FolderBrowserProps) {
  const [internalId, setInternalId] = useState<string | null>(null)
  const currentId = controlledId !== undefined ? controlledId : internalId
  const setCurrentId = (id: string | null) => {
    if (onNavigate) onNavigate(id)
    else setInternalId(id)
    setSelected(new Set())
  }
  const [newFolderOpen, setNewFolderOpen] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameName, setRenameName] = useState('')
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const [comment, setComment] = useState('')
  const [uploadOpen, setUploadOpen] = useState(false) // 送信欄は折りたたみ（ファイル一覧を主役に）
  const [drag, setDrag] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [done, setDone] = useState('')
  // プレビュー
  const [preview, setPreview] = useState<{ url: string; name: string; kind: 'image' | 'pdf' | 'text'; text?: string } | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  // AI質問（選択）
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [ai, setAi] = useState<{ files: BrowserFile[]; label: string } | null>(null)

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

  // 「このフォルダごと」＝現在フォルダ＋その配下すべてのファイル
  function filesUnderCurrent(): BrowserFile[] {
    const ids = new Set<string | null>([currentId])
    let added = true
    while (added) {
      added = false
      for (const f of folders) {
        const p = f.parentId || null
        if (ids.has(p) && !ids.has(f.id)) { ids.add(f.id); added = true }
      }
    }
    return files.filter((f) => ids.has(f.folderId || null))
  }

  function resetMsgs() {
    setErr('')
    setDone('')
  }

  async function openPreview(file: BrowserFile) {
    if (!onGetBlob) return
    setPreviewLoading(true)
    setErr('')
    try {
      const blob = await onGetBlob(file)
      const ext = (file.name.split('.').pop() || '').toLowerCase()
      if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic', 'tif', 'tiff'].includes(ext)) {
        setPreview({ url: URL.createObjectURL(blob), name: file.name, kind: 'image' })
      } else if (ext === 'pdf') {
        setPreview({ url: URL.createObjectURL(blob), name: file.name, kind: 'pdf' })
      } else if (['csv', 'txt', 'tsv', 'json'].includes(ext)) {
        const text = await blob.text()
        setPreview({ url: '', name: file.name, kind: 'text', text })
      } else {
        setErr(`「${file.name}」はプレビュー非対応の形式です。ダウンロードしてご確認ください（Excel・Word 等）。`)
      }
    } catch (e) {
      setErr('プレビューの取得に失敗しました：' + (e instanceof Error ? e.message : ''))
    }
    setPreviewLoading(false)
  }

  function closePreview() {
    if (preview?.url) URL.revokeObjectURL(preview.url)
    setPreview(null)
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
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
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-sm font-bold text-gray-700">📁 サブフォルダ</span>
          <span className="text-xs font-semibold text-white bg-amber-500 rounded-full px-2 py-0.5">{subFolders.length}</span>
        </div>
      )}
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

      {/* AI質問ツールバー（税理士側の届いた資料） */}
      {enableAiAsk && onAiAsk && (
        <div className="flex items-center gap-2 mb-3 flex-wrap bg-indigo-50 border border-indigo-200 rounded-lg px-3 py-2">
          <span className="text-xs text-indigo-800 font-semibold">🤖 AIに質問：</span>
          <button
            onClick={() => {
              const fs = filesUnderCurrent()
              if (!fs.length) { setErr('このフォルダ（配下含む）にファイルがありません。'); return }
              setAi({ files: fs, label: `${currentId ? (byId.get(currentId)?.name || 'このフォルダ') : rootLabel}（配下含む ${fs.length}件）` })
            }}
            className="px-3 py-1 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700"
          >
            このフォルダごと
          </button>
          <button
            disabled={!selected.size}
            onClick={() => {
              const fs = files.filter((x) => selected.has(x.id))
              if (!fs.length) return
              setAi({ files: fs, label: `選択した ${fs.length}件` })
            }}
            className="px-3 py-1 text-xs border border-indigo-300 text-indigo-700 rounded hover:bg-indigo-100 disabled:opacity-50"
          >
            選択した{selected.size ? `${selected.size}件` : 'ファイル'}
          </button>
          {selected.size > 0 && (
            <button onClick={() => setSelected(new Set())} className="text-[11px] text-gray-500 hover:text-gray-700">選択解除</button>
          )}
        </div>
      )}

      {/* ファイル一覧 */}
      <div className="flex items-center gap-2 mb-1.5 mt-1">
        <span className="text-sm font-bold text-gray-700">📄 このフォルダのファイル</span>
        <span className="text-xs font-semibold text-white bg-gray-400 rounded-full px-2 py-0.5">{curFiles.length}件</span>
      </div>
      {curFiles.length === 0 ? (
        <p className="text-sm text-gray-400 py-8 text-center border-2 border-dashed border-gray-200 rounded-lg mb-3 bg-gray-50">
          このフォルダにファイルはありません。{subFolders.length > 0 ? 'サブフォルダの中もご確認ください。' : ''}
        </p>
      ) : (
        <ul className="mb-3 divide-y divide-gray-100 border border-gray-200 rounded-lg overflow-hidden shadow-sm">
          {curFiles.map((f) => (
            <li key={f.id} className="px-3 py-2.5 hover:bg-blue-50/40">
              <div className="flex items-center justify-between gap-2">
                {enableAiAsk && (
                  <input
                    type="checkbox"
                    checked={selected.has(f.id)}
                    onChange={() => toggleSelect(f.id)}
                    className="shrink-0 w-4 h-4"
                    title="AI質問の対象に選択"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-gray-800 truncate flex items-center gap-1.5 flex-wrap">
                    <FileTypeBadge name={f.name} />
                    {f.name}
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
                  {onGetBlob && (
                    <button onClick={() => openPreview(f)} disabled={previewLoading} className="px-3 py-1 text-xs border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50">
                      👁 プレビュー
                    </button>
                  )}
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

      {/* アップロード／送付エリア（折りたたみ：ファイル一覧を主役にする） */}
      {canAddFiles && !uploadOpen && (
        <button
          onClick={() => setUploadOpen(true)}
          className="w-full py-2.5 border-2 border-dashed border-gray-300 rounded-xl text-sm font-semibold text-gray-500 hover:bg-gray-50 hover:border-blue-400 hover:text-blue-600"
        >
          ＋ {addFilesLabel}（このフォルダへ）
        </button>
      )}
      {canAddFiles && uploadOpen && (
        <div className="border border-gray-200 rounded-xl p-4 bg-gray-50">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs font-semibold text-gray-600">📤 {addFilesLabel}（このフォルダへ）</div>
            <button onClick={() => { setUploadOpen(false); setPendingFiles([]); setComment('') }} className="text-xs text-gray-400 hover:text-gray-700">閉じる</button>
          </div>
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
                  <span className="truncate mr-2 inline-flex items-center gap-1.5"><FileTypeBadge name={f.name} />{f.name}</span>
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

      {preview && <PreviewModal preview={preview} onClose={closePreview} onDownload={() => { /* DLは一覧から */ }} />}
      {ai && onAiAsk && <AiAskModal target={ai} onAsk={onAiAsk} onClose={() => setAi(null)} />}
    </div>
  )
}

// ファイルプレビュー（画像・PDF・テキスト）
function PreviewModal({ preview, onClose }: { preview: { url: string; name: string; kind: 'image' | 'pdf' | 'text'; text?: string }; onClose: () => void; onDownload?: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/60 z-[80] flex flex-col p-3 sm:p-6" onClick={onClose}>
      <div className="bg-white rounded-xl w-full h-full flex flex-col overflow-hidden max-w-5xl mx-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-200">
          <div className="text-sm font-semibold text-gray-800 truncate">👁 {preview.name}</div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-2xl leading-none px-1">×</button>
        </div>
        <div className="flex-1 min-h-0 overflow-auto bg-gray-100">
          {preview.kind === 'image' && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={preview.url} alt={preview.name} className="max-w-full mx-auto block" />
          )}
          {preview.kind === 'pdf' && (
            <iframe src={preview.url} title={preview.name} className="w-full h-full" />
          )}
          {preview.kind === 'text' && (
            <pre className="text-xs text-gray-800 whitespace-pre-wrap break-words p-4 bg-white h-full">{preview.text}</pre>
          )}
        </div>
      </div>
    </div>
  )
}

// AI質問（フォルダごと／選択ファイル）
function AiAskModal({
  target,
  onAsk,
  onClose,
}: {
  target: { files: BrowserFile[]; label: string }
  onAsk: (files: BrowserFile[], question: string, onProgress?: (m: string) => void) => Promise<string>
  onClose: () => void
}) {
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [err, setErr] = useState('')

  async function ask() {
    if (!question.trim()) { setErr('質問内容を入力してください。'); return }
    setBusy(true); setErr(''); setAnswer(''); setProgress('')
    try {
      const a = await onAsk(target.files, question, (m) => setProgress(m))
      setAnswer(a || '（回答が空でした）')
    } catch (e) {
      setErr('AI質問に失敗しました：' + (e instanceof Error ? e.message : ''))
    }
    setBusy(false); setProgress('')
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-[80] flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200">
          <div>
            <div className="font-bold text-gray-800">🤖 AIに質問</div>
            <div className="text-[11px] text-gray-500">対象：{target.label}</div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-2xl leading-none px-1">×</button>
        </div>
        <div className="p-5 overflow-auto">
          <label className="block text-sm font-medium text-gray-700 mb-1">確認したい内容を入力してください</label>
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            rows={3}
            placeholder="例：この請求書の合計金額と支払期限を教えて／通帳のうち10万円以上の入金を一覧にして／この資料に登録番号（インボイス）はありますか？"
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg mb-2"
          />
          <div className="text-[11px] text-gray-400 mb-3">
            対象ファイル {target.files.length}件（PDF・画像・Excel・CSV・テキストをAIが読み取ります。Word等は非対応）。
          </div>
          {err && <div className="text-xs text-red-600 mb-2 break-words">{err}</div>}
          <button
            onClick={ask}
            disabled={busy || !question.trim()}
            className="w-full py-2.5 bg-indigo-600 text-white rounded-lg font-semibold hover:bg-indigo-700 disabled:opacity-60"
          >
            {busy ? (progress || 'AIが回答中…') : '質問する'}
          </button>

          {answer && (
            <div className="mt-4">
              <div className="flex items-center justify-between mb-1">
                <div className="text-sm font-semibold text-gray-700">回答</div>
                <button
                  onClick={() => { navigator.clipboard?.writeText(answer).catch(() => {}) }}
                  className="text-[11px] text-gray-500 hover:text-gray-700 border border-gray-300 rounded px-2 py-0.5"
                >
                  コピー
                </button>
              </div>
              <div className="text-sm text-gray-800 whitespace-pre-wrap bg-indigo-50 border border-indigo-200 rounded-lg p-3 leading-relaxed">
                {answer}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
