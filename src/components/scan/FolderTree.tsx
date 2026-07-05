'use client'

// DocuWorks風のサイドバー・フォルダツリー。
// 2つのルート（顧問先→税理士＝緑／税理士→顧問先＝青）とその下のサブフォルダ（黄）を
// 階層表示し、クリックで右パネルの表示フォルダを切り替える（表示は制御コンポーネント側が持つ）。

import { useMemo, useState } from 'react'
import type { ScanFolder } from '@/lib/scan/store'
import { FolderIcon, FOLDER_COLOR } from '@/components/scan/FolderBrowser'

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

export default function FolderTree({ roots, currentRoot, currentId, onSelect }: FolderTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())

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
    const children = root.folders.filter((f) => (f.parentId || null) === folder.id)
    const isOpen = openIds.has(folder.id)
    const selected = currentRoot === root.key && currentId === folder.id
    return (
      <li key={folder.id}>
        <div
          className={`flex items-center gap-1 rounded-md ${selected ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
          style={{ paddingLeft: 4 + depth * 16 }}
        >
          {children.length > 0 ? (
            <button
              onClick={() => toggle(folder.id)}
              className="w-5 h-7 shrink-0 text-gray-400 text-[11px] leading-none"
              aria-label={isOpen ? '折りたたむ' : '展開'}
            >
              {isOpen ? '▾' : '▸'}
            </button>
          ) : (
            <span className="w-5 shrink-0" />
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
        const top = root.folders.filter((f) => (f.parentId || null) === null)
        const rootSelected = currentRoot === root.key && currentId === null
        return (
          <li key={root.key}>
            <button
              onClick={() => onSelect(root.key, null)}
              className={`w-full flex items-center gap-1.5 px-1.5 py-2.5 rounded-md text-left text-[13px] ${rootSelected ? 'bg-blue-50 font-semibold text-blue-700' : 'text-gray-800 hover:bg-gray-50 font-medium'}`}
            >
              <FolderIcon color={FOLDER_COLOR[root.key]} size={16} />
              <span className="flex-1 min-w-0 truncate">{root.label}</span>
              {!!root.badge && root.badge > 0 && (
                <span className="text-[10px] font-bold text-white bg-red-500 rounded-full min-w-[16px] text-center px-1">{root.badge}</span>
              )}
            </button>
            {top.length > 0 && <ul className="space-y-1 mt-1">{top.map((f) => renderFolder(root, f, 1))}</ul>}
          </li>
        )
      })}
    </ul>
  )
}
