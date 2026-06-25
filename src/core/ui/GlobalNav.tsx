'use client'

import Link from 'next/link'
import { MODULES } from '@/core/registry'

// 総合アプリ共通のトップナビ。Google Chrome のタブのような見た目で、
// 各アプリ（顧問先情報登録／進捗管理／仕訳作成／相続管理／年末調整）を直接切り替える。
// currentKey が現在のアプリ（＝白く前面に出るタブ）。
export default function GlobalNav({ currentKey }: { currentKey?: string }) {
  return (
    <nav
      className="w-full shrink-0 flex items-end gap-1 h-11 px-2 pt-1.5 bg-gray-100 border-b border-gray-300 overflow-x-auto"
      style={{ WebkitOverflowScrolling: 'touch' }}
    >
      <Link
        href="/"
        title="ホーム（ランチャー）"
        className="flex items-center justify-center w-9 h-9 mb-0.5 rounded-md text-lg text-gray-500 hover:bg-gray-200 hover:text-gray-800 shrink-0"
      >
        🏠
      </Link>
      {MODULES.map((m) => {
        const isCurrent = m.key === currentKey
        const ready = m.status === 'ready'
        const base =
          'group relative flex items-center gap-1.5 px-4 h-9 rounded-t-lg text-sm whitespace-nowrap shrink-0 border border-b-0 transition-colors'
        if (!ready) {
          return (
            <span
              key={m.key}
              title="準備中"
              className={`${base} border-transparent text-gray-300`}
            >
              <span>{m.icon}</span>
              <span>{m.label}</span>
            </span>
          )
        }
        return (
          <Link
            key={m.key}
            href={m.path}
            aria-current={isCurrent ? 'page' : undefined}
            className={`${base} ${
              isCurrent
                ? 'bg-white border-gray-300 text-blue-700 font-semibold -mb-px z-10 shadow-[0_-1px_2px_rgba(0,0,0,0.04)]'
                : 'bg-gray-200/70 border-transparent text-gray-600 hover:bg-gray-200'
            }`}
          >
            <span>{m.icon}</span>
            <span>{m.label}</span>
          </Link>
        )
      })}
    </nav>
  )
}
