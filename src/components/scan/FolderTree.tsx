'use client'

// DocuWorks風のサイドバー・フォルダツリー。
// 2つのルート（顧問先→税理士＝緑／税理士→顧問先＝青）とその下のサブフォルダ（黄）を
// 階層表示し、クリックで右パネルの表示フォルダを切り替える（表示は制御コンポーネント側が持つ）。

import { useMemo, useState } from 'react'
import type { ScanFolder } from '@/lib/scan/store'
import { FolderIcon, FOLDER_COLOR, naturalName, scanDragGet, scanDragClear } from '@/components/scan/FolderBrowser'

export type RootKey = 'toOffice' | 'toClient'

export interface TreeRoot {
  key: RootKey
  label: string
  folders: ScanFolder[] // このルート配下の全サブフォルダ
  badge?: number // 例：新着件数
}

export interface FolderTreeProps {
  roots: TreeRoot[]
  currentRoot: RootKey | 'select'
  currentId: string | null
  onSelect: (root: RootKey, id: string | null) => void
}

// ルート名「A → B」の矢印を大きく見やすく描画（1行固定・顧問先名側のみ省略）
function RootLabel({ label, color }: { label: string; color: string }) {
  const idx = label.indexOf('→')
  if (idx < 0) return <span className="flex-1 min-w-0 truncate leading-snug">{label}</span>
  const left = label.slice(0, idx).trim()
  const right = label.slice(idx + 1).trim()
  return (
    <span className="flex-1 min-w-0 flex items-center gap-1 leading-snug">
      <span className={left === '税理士' ? 'shrink-0' : 'truncate min-w-0'}>{left}</span>
      <span className="shrink-0 text-lg font-black leading-none px-0.5" style={{ color }}>➜</span>
      <span className={right === '税理士' ? 'shrink-0' : 'truncate min-w-0'}>{right}</span>
    </span>
  )
}

export default function FolderTree({ roots, currentRoot, currentId, onSelect }: FolderTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [dragOver, setDragOver] = useState<string | null>(null) // ドロップ強調（folderId or `root:${key}`）

  function dropProps(rootKey: RootKey, targetFolderId: string | null, hlKey: string) {
    return {
      onDragOver: (e: React.DragEvent) => { if (scanDragGet()?.root === rootKey) { e.preventDefault(); setDragOver(hlKey) } },
      onDragLeave: () => setDragOver((o) => (o === hlKey ? null : o)),
      onDrop: (e: React.DragEvent) => {
        e.preventDefault()
        const d = scanDragGet()
        setDragOver(null)
        if (d && d.root === rootKey) d.move(targetFolderId).finally(() => scanDragClear())
      },
    }
  }

  // 現在フォルダの祖先は常に開いておく
  const openIds = useMemo(() => {
    const s = new Set(expanded)
    if (currentId) {
      const byId = new Map<string, ScanFolder>()
      for (const r of roots) for (const f of r.folders) byId.set(f.id, f)
      let cur: ScanFolder | undefined = byId.get(currentId)
      while (cur) {
        s.add(cur.id)
        cur = cur.parentId ? byId.get(cur.parentId) : undefined
      }
    }
    return s
  }, [expanded, currentId, roots])

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function renderFolder(root: TreeRoot, folder: ScanFolder, depth: number): React.ReactNode {
    const children = root.folders
      .filter((f) => (f.parentId || null) === folder.id)
      .sort((a, b) => naturalName(a.name, b.name))
    const isOpen = openIds.has(folder.id)
    const selected = currentRoot === root.key && currentId === folder.id
    return (
      <li key={folder.id}>
        <div
          {...dropProps(root.key, folder.id, folder.id)}
          className={`flex items-center gap-1 rounded-md ${dragOver === folder.id ? 'bg-blue-100 ring-2 ring-blue-400' : selected ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
          style={{ paddingLeft: 4 + depth * 16 }}
        >
          {children.length > 0 ? (
            <button
              onClick={() => toggle(folder.id)}
              className="w-7 h-7 shrink-0 flex items-center justify-center rounded-md text-gray-500 hover:bg-gray-200 hover:text-gray-700"
              aria-label={isOpen ? '折りたたむ' : '展開'}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={`transition-transform duration-150 ${isOpen ? 'rotate-90' : ''}`}
              >
                <path d="M9 6l6 6-6 6" />
              </svg>
            </button>
          ) : (
            <span className="w-7 shrink-0" />
          )}
          <button
            onClick={() => onSelect(root.key, folder.id)}
            className={`flex-1 min-w-0 flex items-center gap-1.5 py-2 pr-2 text-left text-[13px] ${selected ? 'font-semibold text-blue-700' : 'text-gray-700'}`}
          >
            <FolderIcon color={FOLDER_COLOR.sub} size={15} />
            <span className="truncate">{folder.name}</span>
          </button>
        </div>
        {isOpen && children.length > 0 && (
          <ul className="space-y-1 mt-1">{children.map((c) => renderFolder(root, c, depth + 1))}</ul>
        )}
      </li>
    )
  }

  return (
    <ul className="space-y-2">
      {roots.map((root) => {
        const top = root.folders
          .filter((f) => (f.parentId || null) === null)
          .sort((a, b) => naturalName(a.name, b.name))
        const rootSelected = currentRoot === root.key && currentId === null
        return (
          <li key={root.key}>
            <button
              onClick={() => onSelect(root.key, null)}
              {...dropProps(root.key, null, `root:${root.key}`)}
              className={`w-full flex items-center gap-2 pl-2 pr-1.5 py-2.5 rounded-md text-left text-sm border-l-4 ${dragOver === `root:${root.key}` ? 'bg-blue-100 ring-2 ring-blue-400' : rootSelected ? 'bg-blue-50 font-bold text-blue-800' : 'text-gray-800 hover:bg-gray-50 font-semibold'}`}
              style={{ borderLeftColor: FOLDER_COLOR[root.key] }}
            >
              <FolderIcon color={FOLDER_COLOR[root.key]} size={18} />
              <RootLabel label={root.label} color={FOLDER_COLOR[root.key]} />
              {!!root.badge && root.badge > 0 && (
                <span className="text-[10px] font-bold text-white bg-red-500 rounded-full min-w-[16px] text-center px-1 self-start">{root.badge}</span>
              )}
            </button>
            {top.length > 0 && <ul className="space-y-1 mt-1">{top.map((f) => renderFolder(root, f, 1))}</ul>}
          </li>
        )
      })}
    </ul>
  )
}
