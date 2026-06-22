'use client'

import Link from 'next/link'
import { MODULES } from '@/core/registry'

// 総合アプリ共通のトップナビ。どのアプリ・どの機能を開いても常に上部に表示し、
// 4つのアプリ（顧問先情報登録／進捗管理／仕訳作成／相続管理）を直接切り替える。
// （旧「⊞ アプリ切替」ドロップダウンの置き換え。currentKey が現在のアプリ。）
export default function GlobalNav({ currentKey }: { currentKey?: string }) {
  return (
    <nav
      className="w-full shrink-0 flex items-stretch gap-0.5 h-12 px-2 bg-white border-b border-gray-200 overflow-x-auto"
      style={{ WebkitOverflowScrolling: 'touch' }}
    >
      <Link
        href="/"
        title="ホーム（ランチャー）"
        className="flex items-center px-3 text-lg text-gray-500 hover:text-gray-800 shrink-0"
      >
        🏠
      </Link>
      {MODULES.map((m) => {
        const isCurrent = m.key === currentKey
        const ready = m.status === 'ready'
        if (!ready) {
          return (
            <span
              key={m.key}
              title="準備中"
              className="flex items-center gap-1.5 px-3.5 text-sm text-gray-300 whitespace-nowrap shrink-0"
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
            className={`flex items-center gap-1.5 px-3.5 text-sm whitespace-nowrap shrink-0 border-b-2 transition-colors ${
              isCurrent
                ? 'border-blue-600 text-blue-700 font-semibold bg-blue-50/40'
                : 'border-transparent text-gray-600 hover:text-gray-900 hover:bg-gray-50'
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
