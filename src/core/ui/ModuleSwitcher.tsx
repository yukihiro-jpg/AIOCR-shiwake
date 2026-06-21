'use client'

import { useState, useRef, useEffect } from 'react'
import Link from 'next/link'
import { MODULES } from '@/core/registry'

// 総合アプリの「ホーム/アプリ切替」。各モジュールのヘッダー左に置いて使う。
// currentKey に自分のモジュールkeyを渡すと「（現在）」表示になる。
export default function ModuleSwitcher({ currentKey }: { currentKey?: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
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
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((v) => !v)} className="fbtn fbtn-soft" title="ホーム / アプリ切替">
        ⊞ アプリ切替 <span className="text-[10px]">▼</span>
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 z-50 bg-white text-gray-800 rounded-lg shadow-xl border border-gray-200 min-w-[230px] py-1">
          <Link href="/" onClick={() => setOpen(false)}
            className="w-full px-3 py-2 text-sm hover:bg-blue-50 flex items-center gap-2">
            <span className="w-5 text-center">🏠</span><span>ホーム（ランチャー）</span>
          </Link>
          <div className="my-1 border-t border-gray-100" />
          {MODULES.map((m) => {
            const ready = m.status === 'ready'
            const isCurrent = m.key === currentKey
            if (ready) {
              return (
                <Link key={m.key} href={m.path} onClick={() => setOpen(false)}
                  className={`w-full px-3 py-2 text-sm flex items-center gap-2 ${isCurrent ? 'bg-blue-50/60' : 'hover:bg-blue-50'}`}>
                  <span className="w-5 text-center">{m.icon}</span>
                  <span className="flex-1">{m.label}</span>
                  {isCurrent && <span className="text-[10px] text-blue-600 font-semibold">現在</span>}
                </Link>
              )
            }
            return (
              <div key={m.key} className="w-full px-3 py-2 text-sm flex items-center gap-2 text-gray-400" title="準備中">
                <span className="w-5 text-center">{m.icon}</span>
                <span className="flex-1">{m.label}</span>
                <span className="text-[10px] bg-gray-100 rounded-full px-2 py-0.5">準備中</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
