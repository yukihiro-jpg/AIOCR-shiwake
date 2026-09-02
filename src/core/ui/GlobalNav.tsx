'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { MODULES, openModuleWindow } from '@/core/registry'

// 総合アプリ共通のトップナビ。Google Chrome のタブのような見た目で、
// 各アプリ（顧問先情報登録／進捗管理／仕訳作成／相続管理／年調データ受信 …）を切り替える。
// ラベルは常に太字。選択中のアプリ（currentKey）は白背景で前面に浮き上がり目立たせる。
// currentKey='home' を渡すとホーム（ランチャー）側を選択中として表示する。
//
// スマホ幅（sm未満）ではタブを横に並べず、☰ ボタン＋現在のアプリ名だけの1段にし、
// ☰ を押すと全アプリの縦メニューを出す（PCは従来どおりのタブ）。
export default function GlobalNav({ currentKey }: { currentKey?: string }) {
  const tab =
    'flex items-center gap-1.5 px-4 h-10 rounded-t-[10px] text-sm font-bold whitespace-nowrap shrink-0 transition-colors'
  const on =
    'bg-white text-blue-700 border border-b-0 border-gray-300 border-t-2 border-t-blue-600 -mb-px shadow-[0_-1px_3px_rgba(0,0,0,0.08)] z-10'
  const off = 'text-gray-700 hover:bg-white/60'
  const homeCurrent = currentKey === 'home'
  const current = MODULES.find((m) => m.key === currentKey)
  const [open, setOpen] = useState(false)

  // メニューを開いたまま画面を回転／広げたときに残らないよう、Esc と幅変更で閉じる
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const onResize = () => setOpen(false)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onResize)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('resize', onResize) }
  }, [open])

  return (
    <>
      {/* PC: タブ */}
      <nav
        className="hidden sm:flex w-full shrink-0 items-end gap-1 h-12 px-2 pt-2 bg-[#dee1e6] border-b border-gray-300 overflow-x-auto"
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

      {/* スマホ: ☰ ＋ 現在のアプリ名 */}
      <div className="sm:hidden relative w-full shrink-0 flex items-center gap-1 h-12 px-1 bg-[#dee1e6] border-b border-gray-300 z-40">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-label="アプリメニュー"
          aria-expanded={open}
          className="flex items-center justify-center w-11 h-11 rounded-md text-gray-800 hover:bg-white/70 active:bg-white"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
            {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
          </svg>
        </button>
        <div className="flex items-center gap-1.5 min-w-0 font-bold text-[15px] text-blue-700">
          <span>{homeCurrent ? '🏠' : current?.icon}</span>
          <span className="truncate">{homeCurrent ? 'ホーム' : current?.label}</span>
        </div>
        {!homeCurrent && (
          <Link href="/" aria-label="ホーム" className="ml-auto flex items-center justify-center w-11 h-11 rounded-md text-xl hover:bg-white/70">🏠</Link>
        )}

        {open && (
          <>
            {/* 背景（タップで閉じる） */}
            <div className="fixed inset-0 top-12 bg-black/30 z-40" onClick={() => setOpen(false)} />
            <div className="absolute left-0 top-12 z-50 w-full bg-white border-b border-gray-300 shadow-xl py-1 max-h-[calc(100vh-3rem)] overflow-y-auto">
              <Link href="/" onClick={() => setOpen(false)}
                aria-current={homeCurrent ? 'page' : undefined}
                className={`flex items-center gap-3 px-5 h-12 text-[15px] font-bold ${homeCurrent ? 'bg-blue-50 text-blue-700' : 'text-gray-800 active:bg-gray-100'}`}>
                <span className="text-lg">🏠</span><span>ホーム</span>
              </Link>
              {MODULES.map((m) => {
                const isCurrent = m.key === currentKey
                const ready = m.status === 'ready'
                const cls = `flex items-center gap-3 px-5 h-12 text-[15px] font-bold border-t border-gray-100 ${
                  !ready ? 'text-gray-400' : isCurrent ? 'bg-blue-50 text-blue-700' : 'text-gray-800 active:bg-gray-100'}`
                const inner = (<><span className="text-lg">{m.icon}</span><span>{m.label}</span>{!ready && <span className="ml-auto text-xs font-normal">準備中</span>}</>)
                if (!ready) return <span key={m.key} className={cls}>{inner}</span>
                if (m.newWindow && !isCurrent) {
                  return (
                    <a key={m.key} href={m.path} className={cls}
                      onClick={(e) => { e.preventDefault(); setOpen(false); openModuleWindow(m.key, m.path) }}>
                      {inner}
                    </a>
                  )
                }
                return (
                  <Link key={m.key} href={m.path} aria-current={isCurrent ? 'page' : undefined} className={cls}
                    onClick={() => setOpen(false)}>
                    {inner}
                  </Link>
                )
              })}
            </div>
          </>
        )}
      </div>
    </>
  )
}
