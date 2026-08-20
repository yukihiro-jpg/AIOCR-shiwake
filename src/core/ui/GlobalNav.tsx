'use client'

import Link from 'next/link'
import { MODULES, openModuleWindow } from '@/core/registry'

// 総合アプリ共通のトップナビ。Google Chrome のタブのような見た目で、
// 各アプリ（顧問先情報登録／進捗管理／仕訳作成／相続管理／年調データ受信 …）を切り替える。
// ラベルは常に太字。選択中のアプリ（currentKey）は白背景で前面に浮き上がり目立たせる。
// currentKey='home' を渡すとホーム（ランチャー）側を選択中として表示する。
export default function GlobalNav({ currentKey }: { currentKey?: string }) {
  const tab =
    'flex items-center gap-1.5 px-4 h-10 rounded-t-[10px] text-sm font-bold whitespace-nowrap shrink-0 transition-colors'
  const on =
    'bg-white text-blue-700 border border-b-0 border-gray-300 border-t-2 border-t-blue-600 -mb-px shadow-[0_-1px_3px_rgba(0,0,0,0.08)] z-10'
  const off = 'text-gray-700 hover:bg-white/60'
  const homeCurrent = currentKey === 'home'
  return (
    <nav
      className="w-full shrink-0 flex items-end gap-1 h-12 px-2 pt-2 bg-[#dee1e6] border-b border-gray-300 overflow-x-auto"
      style={{ WebkitOverflowScrolling: 'touch' }}
    >
      <Link
        href="/"
        title="ホーム（ランチャー）"
        aria-current={homeCurrent ? 'page' : undefined}
        className={
          homeCurrent
            ? `${tab} ${on}`
            : 'flex items-center justify-center w-9 h-9 mb-1 rounded-md text-lg text-gray-600 hover:bg-white/70 shrink-0'
        }
      >
        <span>🏠</span>
        {homeCurrent && <span>ホーム</span>}
      </Link>
      {MODULES.map((m) => {
        const isCurrent = m.key === currentKey
        const ready = m.status === 'ready'
        const inner = (
          <>
            <span>{m.icon}</span>
            <span>{m.label}</span>
          </>
        )
        if (!ready) {
          return (
            <span key={m.key} title="準備中" className={`${tab} text-gray-400`}>
              {inner}
            </span>
          )
        }
        // 別ウィンドウ起動のモジュール（路線価マップ等）は、そのウィンドウ自身で開いている
        // ときだけ通常のリンクにする（自分のウィンドウを開き直すと表示が消えるため）
        if (m.newWindow && !isCurrent) {
          return (
            <a
              key={m.key}
              href={m.path}
              onClick={(e) => {
                e.preventDefault()
                openModuleWindow(m.key, m.path)
              }}
              className={`${tab} ${off}`}
            >
              {inner}
            </a>
          )
        }
        return (
          <Link
            key={m.key}
            href={m.path}
            aria-current={isCurrent ? 'page' : undefined}
            className={`${tab} ${isCurrent ? on : off}`}
          >
            {inner}
          </Link>
        )
      })}
    </nav>
  )
}
