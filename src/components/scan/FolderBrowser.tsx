'use client'

// DocuWorks風のフォルダツリー共有フォルダ（顧問先ページ・事務所ページ共通で使うブラウザUI）。
// ルート（toOffice/toClient）は仮想（DBに実体を持たない）。folders はルート配下のサブフォルダのみ。

import { useMemo, useState } from 'react'
import type { ScanFolder } from '@/lib/scan/store'

// ドラッグ中のファイル移動情報を保持（一覧⇔サイドバーツリーの橋渡し用モジュール変数）
export interface ScanDragItem {
  root: 'toOffice' | 'toClient'
  label: string
  move: (targetFolderId: string | null) => Promise<void>
}
let _scanDrag: ScanDragItem | null = null
export function scanDragSet(d: ScanDragItem | null) { _scanDrag = d }
export function scanDragGet(): ScanDragItem | null { return _scanDrag }
export function scanDragClear() { _scanDrag = null }

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
  onAddFiles: (parentId: string | null, files: File[], comment: string, recipientIds?: string[]) => Promise<void>
  recipients?: { id: string; name: string }[] // 指定すると「＋ファイル追加」に宛先選択を表示（税理士→顧問先用）
  onDownload: (file: BrowserFile) => Promise<void>
  onDeleteFile?: (file: BrowserFile) => Promise<void>
  onMoveFile?: (file: BrowserFile, targetFolderId: string | null) => Promise<void> // 指定するとフォルダ間移動（ボタン＋D&D）を有効化
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

// 自然順（数字は 1,2,…,10 の順、英字は A,B,C、和暦 R7<R8<R9 等）で名前を比較
export function naturalName(a: string, b: string): number {
  return (a || '').localeCompare(b || '', 'ja', { numeric: true, sensitivity: 'base' })
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
  recipients,
  onDownload,
  onDeleteFile,
  onMoveFile,
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
  const [toAll, setToAll] = useState(true) // 宛先：全員宛
  const [toMembers, setToMembers] = useState<Set<string>>(new Set()) // 宛先：特定メンバー
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
  // ファイル移動
  const [movePicker, setMovePicker] = useState<BrowserFile | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null | 'root'>(null) // 一覧内サブフォルダへのドロップ強調

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

  const subFolders = folders
    .filter((f) => (f.parentId || null) === currentId)
    .sort((a, b) => naturalName(a.name, b.name))
  const curFiles = files
    // 最上位では、所属フォルダが削除済み等で存在しない「孤立ファイル」もここに拾う。
    // （そうしないと folderId が宙に浮いたファイルがどのビューにも出ず、事務所からも顧問先からも見えなくなる）
    .filter((f) => {
      const fid = f.folderId || null
      if (currentId === null) return fid === null || !byId.has(fid)
      return fid === currentId
    })
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

  // 選択したファイルをまとめてダウンロード（複数はZIP）
  async function bulkDownload() {
    if (!onGetBlob || !selected.size) return
    const targets = files.filter((f) => selected.has(f.id))
    if (!targets.length) return
    setBusy(true)
    resetMsgs()
    try {
      if (targets.length === 1) {
        await onDownload(targets[0])
      } else {
        const JSZip = (await import('jszip')).default
        const zip = new JSZip()
        const used: Record<string, number> = {}
        for (const f of targets) {
          const blob = await onGetBlob(f)
          // 同名ファイルの重複回避
          let nm = f.name
          if (used[nm] != null) { used[nm]++; const dot = nm.lastIndexOf('.'); nm = dot > 0 ? `${nm.slice(0, dot)}(${used[nm]})${nm.slice(dot)}` : `${nm}(${used[nm]})` }
          else used[nm] = 0
          zip.file(nm, blob)
        }
        const out = await zip.generateAsync({ type: 'blob' })
        const url = URL.createObjectURL(out)
        const a = document.createElement('a')
        a.href = url
        a.download = `まとめてDL_${new Date().toISOString().slice(0, 10)}.zip`
        document.body.appendChild(a)
        a.click()
        a.remove()
        setTimeout(() => URL.revokeObjectURL(url), 2000)
      }
      setSelected(new Set())
    } catch (e) {
      setErr('まとめてダウンロードに失敗しました：' + (e instanceof Error ? e.message : ''))
    }
    setBusy(false)
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
    let recips: string[] | undefined
    if (recipients && recipients.length) {
      recips = [...(toAll ? ['all'] : []), ...Array.from(toMembers)]
      if (!recips.length) { setErr('宛先を選択してください（全員宛または特定メンバー）。'); return }
    }
    setBusy(true)
    resetMsgs()
    try {
      await onAddFiles(currentId, pendingFiles, comment, recips)
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

  async function doMove(file: BrowserFile, targetFolderId: string | null) {
    if (!onMoveFile) return
    if ((file.folderId || null) === targetFolderId) return
    try {
      await onMoveFile(file, targetFolderId)
      onChanged()
    } catch (e) {
      alert('移動に失敗しました：' + (e instanceof Error ? e.message : ''))
    }
  }

  // 移動先選択用：フォルダを階層順に平坦化（深さ付き）
  function flattenFolders(): { folder: ScanFolder; depth: number }[] {
    const out: { folder: ScanFolder; depth: number }[] = []
    const walk = (parentId: string | null, depth: number) => {
      folders
        .filter((f) => (f.parentId || null) === parentId)
        .sort((a, b) => naturalName(a.name, b.name))
        .forEach((f) => { out.push({ folder: f, depth }); walk(f.id, depth + 1) })
    }
    walk(null, 0)
    return out
  }

  const rootColor = FOLDER_COLOR[rootKey]

  return (
    <div>
      {/* パンくず */}
      <div className="flex items-center flex-wrap gap-1 text-sm mb-3">
        <button
          onClick={() => setCurrentId(null)}
          onDragOver={onMoveFile ? (e) => { if (scanDragGet()?.root === rootKey) { e.preventDefault(); setDropTarget('root') } } : undefined}
          onDragLeave={onMoveFile ? () => setDropTarget((t) => (t === 'root' ? null : t)) : undefined}
          onDrop={onMoveFile ? (e) => { e.preventDefault(); const d = scanDragGet(); setDropTarget(null); if (d && d.root === rootKey) d.move(null).finally(() => scanDragClear()) } : undefined}
          className={`inline-flex items-center gap-1 px-2 py-1 rounded ${dropTarget === 'root' ? 'bg-blue-100 ring-2 ring-blue-400' : currentId === null ? 'bg-gray-100 font-semibold text-gray-800' : 'text-gray-500 hover:bg-gray-50'}`}
        >
          <FolderIcon color={rootColor} size={16} />
          {rootLabel}
        </button>
        {crumbs.map((c) => (
          <span key={c.id} className="inline-flex items-center gap-1">
            <span className="text-gray-300">／</span>
            <button
              onClick={() => setCurrentId(c.id)}
              onDragOver={onMoveFile ? (e) => { if (scanDragGet()?.root === rootKey) { e.preventDefault(); setDropTarget(c.id) } } : undefined}
              onDragLeave={onMoveFile ? () => setDropTarget((t) => (t === c.id ? null : t)) : undefined}
              onDrop={onMoveFile ? (e) => { e.preventDefault(); const d = scanDragGet(); setDropTarget(null); if (d && d.root === rootKey) d.move(c.id).finally(() => scanDragClear()) } : undefined}
              className={`inline-flex items-center gap-1 px-2 py-1 rounded ${dropTarget === c.id ? 'bg-blue-100 ring-2 ring-blue-400' : currentId === c.id ? 'bg-gray-100 font-semibold text-gray-800' : 'text-gray-500 hover:bg-gray-50'}`}
            >
              <FolderIcon color={FOLDER_COLOR.sub} size={16} />
              {c.name}
            </button>
          </span>
        ))}
      </div>

      {err && <div className="text-xs text-red-600 mb-2 break-words bg-red-50 border border-red-200 rounded px-3 py-2">{err}</div>}
      {done && <div className="text-xs text-green-700 mb-2 bg-green-50 border border-green-200 rounded px-3 py-2">{done}</div>}

      {/* ツールバー（Mykomon風） */}
      {(canAddFiles || canManageFolders || (enableAiAsk && onAiAsk)) && (
        <div className="flex items-center gap-2 mb-3 flex-wrap border-b border-gray-200 pb-3">
          {canAddFiles && (
            <button
              onClick={() => setUploadOpen(true)}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700"
            >
              ＋ ファイル追加
            </button>
          )}
          {canManageFolders && (
            <button
              onClick={() => { setNewFolderOpen(true); setNewFolderName('') }}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm border border-gray-300 rounded-lg font-semibold text-gray-700 hover:bg-gray-50"
            >
              ＋ フォルダ追加
            </button>
          )}
          {enableAiAsk && onAiAsk && (
            <>
              <span className="mx-1 h-6 w-px bg-gray-200" />
              <button
                onClick={() => {
                  const fs = filesUnderCurrent()
                  if (!fs.length) { setErr('このフォルダ（配下含む）にファイルがありません。'); return }
                  setAi({ files: fs, label: `${currentId ? (byId.get(currentId)?.name || 'このフォルダ') : rootLabel}（配下含む ${fs.length}件）` })
                }}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg font-semibold hover:bg-indigo-700"
              >
                🤖 フォルダごとAI質問
              </button>
              <button
                disabled={!selected.size}
                onClick={() => {
                  const fs = files.filter((x) => selected.has(x.id))
                  if (!fs.length) return
                  setAi({ files: fs, label: `選択した ${fs.length}件` })
                }}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm border border-indigo-300 text-indigo-700 rounded-lg font-semibold hover:bg-indigo-50 disabled:opacity-50"
              >
                🤖 選択{selected.size ? `（${selected.size}件）` : ''}をAI質問
              </button>
            </>
          )}
        </div>
      )}

      {/* 新規フォルダ入力 */}
      {canManageFolders && newFolderOpen && (
        <div className="flex items-center gap-2 mb-3">
          <FolderIcon color={FOLDER_COLOR.sub} />
          <input
            autoFocus
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') createFolder()
              if (e.key === 'Escape') { setNewFolderOpen(false); setNewFolderName('') }
            }}
            placeholder="フォルダ名を入力"
            className="flex-1 max-w-xs px-3 py-1.5 text-sm border border-gray-300 rounded"
          />
          <button onClick={createFolder} disabled={busy || !newFolderName.trim()} className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded disabled:opacity-50">作成</button>
          <button onClick={() => { setNewFolderOpen(false); setNewFolderName('') }} className="px-3 py-1.5 text-xs text-gray-500">取消</button>
        </div>
      )}

      {/* 選択バー（複数選択→まとめてDL） */}
      {selected.size > 0 && (
        <div className="flex items-center gap-2 mb-2 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 text-sm">
          <span className="text-blue-800 font-semibold">{selected.size}件を選択中</span>
          {onGetBlob && (
            <button onClick={bulkDownload} disabled={busy} className="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50">
              {busy ? 'まとめてDL中…' : '⬇ まとめてDL'}
            </button>
          )}
          <button onClick={() => setSelected(new Set())} className="text-xs text-gray-500 hover:text-gray-700">選択解除</button>
        </div>
      )}

      {/* フォルダ＋ファイル 統合一覧（Mykomon風・ヘッダ固定・8行分スクロール） */}
      <div className="border border-gray-200 rounded-lg overflow-hidden">
        {/* 見出し行（固定） */}
        <div className="flex items-center text-[11px] font-semibold text-gray-500 bg-gray-50 border-b border-gray-200 px-3 py-2">
          <span className="w-8 shrink-0 flex items-center">
            <input
              type="checkbox"
              aria-label="表示中のファイルをすべて選択"
              checked={curFiles.length > 0 && curFiles.every((f) => selected.has(f.id))}
              onChange={(e) => {
                const on = e.target.checked
                setSelected((prev) => { const n = new Set(prev); curFiles.forEach((f) => (on ? n.add(f.id) : n.delete(f.id))); return n })
              }}
              className="w-4 h-4"
            />
          </span>
          <span className="flex-1 min-w-0">名称</span>
          <span className="hidden sm:block w-44 shrink-0">更新日時</span>
          <span className="hidden sm:block w-16 shrink-0 text-right">サイズ</span>
          <span className="hidden sm:block w-80 shrink-0 text-right pr-1">操作</span>
        </div>

        {/* 本文（8ファイル分の高さを確保・超過分はスクロール） */}
        <div className="overflow-y-auto" style={{ height: 360 }}>
          {subFolders.length === 0 && curFiles.length === 0 ? (
            <div className="h-full flex items-center justify-center">
              <p className="text-sm text-gray-400 text-center px-4">
                このフォルダは空です。{canAddFiles ? '「＋ ファイル追加」から資料を追加できます。' : ''}
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-gray-100">
              {/* フォルダ行 */}
              {subFolders.map((f) => (
                <li
                  key={f.id}
                  onDragOver={onMoveFile ? (e) => { if (scanDragGet()?.root === rootKey) { e.preventDefault(); setDropTarget(f.id) } } : undefined}
                  onDragLeave={onMoveFile ? () => setDropTarget((t) => (t === f.id ? null : t)) : undefined}
                  onDrop={onMoveFile ? (e) => { e.preventDefault(); const d = scanDragGet(); setDropTarget(null); if (d && d.root === rootKey) d.move(f.id).finally(() => scanDragClear()) } : undefined}
                  className={`flex items-center px-3 py-2.5 ${dropTarget === f.id ? 'bg-blue-100 ring-2 ring-inset ring-blue-400' : 'hover:bg-amber-50/40'}`}
                >
                  <span className="w-8 shrink-0" />
                  {renaming === f.id ? (
                    <div className="flex items-center gap-2 flex-1">
                      <FolderIcon color={FOLDER_COLOR.sub} />
                      <input
                        autoFocus
                        value={renameName}
                        onChange={(e) => setRenameName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') submitRename(f); if (e.key === 'Escape') setRenaming(null) }}
                        className="flex-1 px-2 py-1 text-sm border border-gray-300 rounded"
                      />
                      <button onClick={() => submitRename(f)} disabled={busy} className="px-2 py-1 text-xs bg-blue-600 text-white rounded">保存</button>
                      <button onClick={() => setRenaming(null)} className="px-2 py-1 text-xs text-gray-500">取消</button>
                    </div>
                  ) : (
                    <>
                      <button onClick={() => setCurrentId(f.id)} className="flex-1 min-w-0 flex items-center gap-2 text-left">
                        <FolderIcon color={FOLDER_COLOR.sub} size={20} />
                        <span className="text-sm font-medium text-gray-800 truncate">{f.name}</span>
                      </button>
                      <span className="hidden sm:block w-44 shrink-0 text-[11px] text-gray-400">{f.createdAt ? new Date(f.createdAt).toLocaleString('ja-JP') : ''}</span>
                      <span className="hidden sm:block w-16 shrink-0 text-right text-[11px] text-gray-400">—</span>
                      <span className="shrink-0 sm:w-80 flex justify-end gap-1">
                        {canManageFolders && (
                          <>
                            <button onClick={() => { setRenaming(f.id); setRenameName(f.name) }} className="px-2 py-1 text-xs border border-gray-300 rounded hover:bg-gray-50">改名</button>
                            <button onClick={() => removeFolder(f)} disabled={busy} className="px-2 py-1 text-xs border border-red-300 text-red-600 rounded hover:bg-red-50">削除</button>
                          </>
                        )}
                      </span>
                    </>
                  )}
                </li>
              ))}
              {/* ファイル行 */}
              {curFiles.map((f) => {
                // 操作ボタン群（スマホでは名前の下に、PCでは右側の列に表示するため2箇所で使う）
                const actionButtons = (
                  <>
                    {onGetBlob && (
                      <button onClick={() => openPreview(f)} disabled={previewLoading} className="px-2.5 py-1 text-xs border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50">プレビュー</button>
                    )}
                    {onMoveFile && (
                      <button onClick={() => setMovePicker(f)} className="px-2.5 py-1 text-xs border border-gray-300 rounded hover:bg-gray-50" title="別のフォルダへ移動（ドラッグ＆ドロップでも移動できます）">ファイル移動</button>
                    )}
                    <button onClick={() => onDownload(f)} className="px-2.5 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700">⬇ DL</button>
                    {onDeleteFile && (
                      <button onClick={() => removeFile(f)} className="px-2.5 py-1 text-xs border border-red-300 text-red-600 rounded hover:bg-red-50">削除</button>
                    )}
                  </>
                )
                return (
                <li
                  key={f.id}
                  draggable={!!onMoveFile}
                  onDragStart={onMoveFile ? (e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', f.name); scanDragSet({ root: rootKey, label: f.name, move: (tid) => doMove(f, tid) }) } : undefined}
                  onDragEnd={onMoveFile ? () => scanDragClear() : undefined}
                  className={`flex items-start gap-2 px-3 py-2.5 hover:bg-blue-50/40 ${onMoveFile ? 'cursor-move' : ''}`}
                >
                  <span className="w-6 sm:w-8 shrink-0 pt-0.5">
                    <input
                      type="checkbox"
                      checked={selected.has(f.id)}
                      onChange={() => toggleSelect(f.id)}
                      className="w-4 h-4"
                      title="選択"
                    />
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-gray-800 flex items-center gap-1.5 flex-wrap">
                      <FileTypeBadge name={f.name} />
                      <span className="break-all sm:truncate">{f.name}</span>
                      {renderFileBadges?.(f)}
                    </div>
                    <div className="sm:hidden text-[11px] text-gray-400 mt-0.5">
                      {new Date(f.at).toLocaleString('ja-JP')}・{fmtSize(f.size)}{f.member ? `・👤${f.member}` : ''}
                    </div>
                    {f.member && <div className="hidden sm:block text-[11px] text-gray-400">👤{f.member}</div>}
                    {f.comment && (
                      <div className="text-[11px] text-gray-600 bg-yellow-50 border border-yellow-200 rounded px-2 py-1 mt-1 whitespace-pre-wrap">💬 {f.comment}</div>
                    )}
                    {/* スマホ: 操作ボタンは名前の下に折り返して表示（PC列は非表示） */}
                    <div className="flex sm:hidden flex-wrap gap-1.5 mt-2">{actionButtons}</div>
                  </div>
                  <span className="hidden sm:block w-44 shrink-0 text-[11px] text-gray-500 pt-0.5">{new Date(f.at).toLocaleString('ja-JP')}</span>
                  <span className="hidden sm:block w-16 shrink-0 text-right text-[11px] text-gray-500 pt-0.5">{fmtSize(f.size)}</span>
                  <span className="hidden sm:flex w-80 shrink-0 justify-end gap-1.5">
                    {actionButtons}
                  </span>
                </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>

      {/* ファイル追加モーダル（D&D＋ファイル選択） */}
      {canAddFiles && uploadOpen && (
        <div className="fixed inset-0 bg-black/50 z-[80] flex items-center justify-center p-4" onClick={() => { setUploadOpen(false); setPendingFiles([]); setComment('') }}>
          <div className="bg-white rounded-2xl w-full max-w-lg max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200">
              <div className="font-bold text-gray-800">＋ ファイル追加{addFilesLabel ? `（${addFilesLabel}）` : ''}</div>
              <button onClick={() => { setUploadOpen(false); setPendingFiles([]); setComment('') }} className="text-gray-400 hover:text-gray-700 text-2xl leading-none px-1">×</button>
            </div>
            <div className="p-5">
              <div className="text-[11px] text-gray-500 mb-2">
                追加先：{currentId ? (byId.get(currentId)?.name || 'このフォルダ') : rootLabel}
                {maxFileBytes ? `／1ファイル ${fmtSize(maxFileBytes)}まで` : ''}
              </div>

              {recipients && recipients.length > 0 && (
                <div className="mb-3 border border-gray-200 rounded-lg p-3 bg-gray-50">
                  <div className="text-xs font-semibold text-gray-600 mb-1.5">宛先（誰が見られるか）</div>
                  <label className="flex items-center gap-2 text-sm mb-1">
                    <input type="checkbox" checked={toAll} onChange={(e) => setToAll(e.target.checked)} />
                    全員宛（会社URL・全メンバーで閲覧可）
                  </label>
                  {recipients.map((r) => (
                    <label key={r.id} className="flex items-center gap-2 text-sm mb-1">
                      <input
                        type="checkbox"
                        checked={toMembers.has(r.id)}
                        onChange={(e) => setToMembers((prev) => { const n = new Set(prev); if (e.target.checked) n.add(r.id); else n.delete(r.id); return n })}
                      />
                      👤 {r.name} 宛（この人のURLでのみ閲覧可）
                    </label>
                  ))}
                </div>
              )}

              <label className="block text-xs text-gray-500 mb-1">コメント（任意）</label>
              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="例：3月分の資料です。"
                rows={2}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg mb-3"
              />
              <div
                onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
                onDragLeave={() => setDrag(false)}
                onDrop={(e) => { e.preventDefault(); setDrag(false); addPendingFiles(e.dataTransfer?.files || null) }}
                className={`border-2 border-dashed rounded-xl p-6 text-center mb-3 transition-colors ${drag ? 'border-blue-500 bg-blue-50' : 'border-gray-300 bg-gray-50'}`}
              >
                <p className="text-sm text-gray-500 mb-2">ここにファイルをドラッグ＆ドロップ</p>
                <label className="inline-block px-4 py-2 text-sm bg-blue-600 text-white rounded-lg font-semibold cursor-pointer">
                  ファイルを選択
                  <input type="file" multiple className="hidden" onChange={(e) => { addPendingFiles(e.target.files); e.target.value = '' }} />
                </label>
              </div>

              {pendingFiles.length > 0 && (
                <ul className="mb-3 space-y-1">
                  {pendingFiles.map((f, i) => (
                    <li key={i} className="flex items-center justify-between text-xs bg-white rounded px-2 py-1.5 border border-gray-200">
                      <span className="truncate mr-2 inline-flex items-center gap-1.5"><FileTypeBadge name={f.name} />{f.name}</span>
                      <span className="flex items-center gap-2 shrink-0 text-gray-400">
                        {fmtSize(f.size)}
                        <button onClick={() => setPendingFiles((prev) => prev.filter((_, j) => j !== i))} className="text-red-500">×</button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              {err && <div className="text-xs text-red-600 mb-2 break-words">{err}</div>}
              {done && <div className="text-xs text-green-700 mb-2">{done}</div>}

              <button
                onClick={submitFiles}
                disabled={busy || pendingFiles.length === 0}
                className="w-full py-2.5 bg-green-600 text-white rounded-lg font-semibold hover:bg-green-700 disabled:opacity-60"
              >
                {busy ? '送信中...' : '保存（送信する）'}
              </button>
            </div>
          </div>
        </div>
      )}

      {preview && <PreviewModal preview={preview} onClose={closePreview} onDownload={() => { /* DLは一覧から */ }} />}
      {ai && onAiAsk && <AiAskModal target={ai} onAsk={onAiAsk} onClose={() => setAi(null)} />}

      {/* 移動先選択モーダル */}
      {movePicker && onMoveFile && (
        <div className="fixed inset-0 bg-black/50 z-[80] flex items-center justify-center p-4" onClick={() => setMovePicker(null)}>
          <div className="bg-white rounded-2xl w-full max-w-md max-h-[80vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200">
              <div className="font-bold text-gray-800 truncate">↪ 移動先を選択</div>
              <button onClick={() => setMovePicker(null)} className="text-gray-400 hover:text-gray-700 text-2xl leading-none px-1">×</button>
            </div>
            <div className="px-5 pt-2 pb-1 text-[11px] text-gray-500 truncate">「{movePicker.name}」を移動します</div>
            <div className="overflow-auto p-2">
              <button
                onClick={() => { const f = movePicker; setMovePicker(null); doMove(f, null) }}
                disabled={(movePicker.folderId || null) === null}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left rounded hover:bg-blue-50 disabled:opacity-40 disabled:hover:bg-transparent"
              >
                <FolderIcon color={rootColor} size={18} />
                <span className="truncate">{rootLabel}（最上位）</span>
                {(movePicker.folderId || null) === null && <span className="text-[10px] text-gray-400 ml-auto">現在ここ</span>}
              </button>
              {flattenFolders().map(({ folder, depth }) => {
                const here = (movePicker.folderId || null) === folder.id
                return (
                  <button
                    key={folder.id}
                    onClick={() => { const f = movePicker; setMovePicker(null); doMove(f, folder.id) }}
                    disabled={here}
                    style={{ paddingLeft: 12 + depth * 18 }}
                    className="w-full flex items-center gap-2 pr-3 py-2 text-sm text-left rounded hover:bg-blue-50 disabled:opacity-40 disabled:hover:bg-transparent"
                  >
                    <FolderIcon color={FOLDER_COLOR.sub} size={16} />
                    <span className="truncate">{folder.name}</span>
                    {here && <span className="text-[10px] text-gray-400 ml-auto shrink-0">現在ここ</span>}
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      )}
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
