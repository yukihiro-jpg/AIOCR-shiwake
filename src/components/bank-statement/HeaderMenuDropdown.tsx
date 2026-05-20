'use client'

import { useState, useEffect, useRef } from 'react'
import type { ReactNode } from 'react'

interface MenuItem {
  label?: string
  icon?: string
  onClick?: () => void
  /** カスタム要素（セレクト等）を直接描画したい場合に使用。onClick より優先 */
  render?: ReactNode
  /** 区切り線として描画 */
  divider?: boolean
  disabled?: boolean
  title?: string
}

interface Props {
  items: MenuItem[]
  buttonLabel?: string
}

export default function HeaderMenuDropdown({ items, buttonLabel = 'メニュー' }: Props) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onEsc)
    }
  }, [open])

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="px-3 py-1.5 text-xs font-medium bg-white/10 hover:bg-white/20 text-white rounded border border-white/20 flex items-center gap-1"
      >
        {buttonLabel}
        <span className="text-[10px]">▼</span>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-40 bg-white text-gray-800 rounded-lg shadow-xl border border-gray-200 min-w-[220px] py-1">
          {items.map((it, i) => {
            if (it.divider) return <div key={i} className="my-1 border-t border-gray-100" />
            if (it.render) {
              return (
                <div key={i} className="px-3 py-1.5" title={it.title}>
                  {it.render}
                </div>
              )
            }
            return (
              <button
                key={i}
                disabled={it.disabled}
                title={it.title}
                onClick={() => { it.onClick?.(); setOpen(false) }}
                className="w-full px-3 py-2 text-left text-sm hover:bg-blue-50 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {it.icon && <span className="text-base w-5 text-center">{it.icon}</span>}
                <span>{it.label}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
