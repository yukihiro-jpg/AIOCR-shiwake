'use client'

import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
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
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // ボタン位置からドロップダウンの固定位置を算出（解析中の再レイアウトにも追従）
  const place = () => {
    const btn = containerRef.current?.getBoundingClientRect()
    if (!btn) return
    setPos({ top: btn.bottom + 4, right: Math.max(8, window.innerWidth - btn.right) })
  }

  useEffect(() => {
    if (!open) return
    place()
    const onMove = () => place()
    window.addEventListener('resize', onMove)
    window.addEventListener('scroll', onMove, true)
    return () => {
      window.removeEventListener('resize', onMove)
      window.removeEventListener('scroll', onMove, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node
      // ボタン本体・ポータルで描画したメニューのどちらにも含まれなければ閉じる
      if (containerRef.current?.contains(t)) return
      if (menuRef.current?.contains(t)) return
      setOpen(false)
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
        className="fbtn fbtn-soft"
      >
        {buttonLabel}
        <span className="text-[10px]">▼</span>
      </button>
      {open && pos && typeof document !== 'undefined' && createPortal(
        // document.body 直下に固定配置。表側のネイティブ<select>より確実に前面へ。
        <div
          ref={menuRef}
          style={{ position: 'fixed', top: pos.top, right: pos.right, zIndex: 1000 }}
          className="bg-white text-gray-800 rounded-lg shadow-xl border border-gray-200 min-w-[220px] max-h-[80vh] overflow-auto py-1"
        >
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
        </div>,
        document.body,
      )}
    </div>
  )
}
