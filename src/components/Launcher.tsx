'use client'

import Link from 'next/link'
import { useState } from 'react'
import { MODULES } from '@/core/registry'

const SUITE_GEMINI_KEY = 'suite-gemini-api-key'

// 共通設定：Gemini APIキーを1か所で登録（各モジュールはこのキーを自動で使う）
function CommonSettings() {
  const [key, setKey] = useState(() => {
    if (typeof window === 'undefined') return ''
    return localStorage.getItem(SUITE_GEMINI_KEY) || ''
  })
  const [show, setShow] = useState(false)
  const save = (v: string) => {
    const t = v.trim()
    setKey(t)
    try {
      if (t) localStorage.setItem(SUITE_GEMINI_KEY, t)
      else localStorage.removeItem(SUITE_GEMINI_KEY)
    } catch { /* ignore */ }
  }
  return (
    <div className="max-w-5xl mx-auto mt-8 rounded-2xl border border-gray-200 bg-white p-5">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xl">🔑</span>
        <h2 className="font-semibold text-gray-800">共通設定：Gemini APIキー</h2>
      </div>
      <p className="text-xs text-gray-500 mb-3 leading-relaxed">
        ここに登録した1つのキーを、<b>仕訳作成（OCR）・進捗管理／顧問先情報（議事録AI等）・相続管理（議事録AI・AI通帳分析・解説文）</b>が共通で使います。
        各機能の設定画面に個別のキーが入力されている場合はそちらが優先されます（例：仕訳作成だけ有料キーにしたい場合は、仕訳作成の設定に有料キーを入れてください）。
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type={show ? 'text' : 'password'}
          value={key}
          placeholder="AIza... を貼り付け（この端末に保存）"
          onChange={(e) => save(e.target.value)}
          className="flex-1 min-w-[260px] px-3 py-2 text-sm border border-gray-300 rounded-lg font-mono"
        />
        <button
          type="button"
          onClick={() => setShow((s) => !s)}
          className="text-xs px-3 py-2 border border-gray-300 rounded-lg bg-white hover:bg-gray-50"
        >
          {show ? '🙈 隠す' : '🔎 表示'}
        </button>
        <button
          type="button"
          onClick={() => {
            if (!key) return
            navigator.clipboard?.writeText(key).then(() => alert('APIキーをコピーしました')).catch(() => setShow(true))
          }}
          className="text-xs px-3 py-2 border border-gray-300 rounded-lg bg-white hover:bg-gray-50"
        >
          📋 コピー
        </button>
      </div>
      <p className="text-[11px] mt-2 px-2 py-1 bg-gray-50 rounded text-gray-600 inline-block">
        現在この端末に保存されている共通キー：<b>{key ? `設定済み（末尾 ${key.slice(-4)}・${key.length}文字）` : '未設定'}</b>
      </p>
      <p className="text-[11px] text-gray-400 mt-1">
        ※ キーはこの端末（ブラウザ）内にのみ保存され、同期はされません。各PCで一度だけ入力してください。
        取得は <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer" className="text-blue-500 underline">Google AI Studio</a>。
      </p>
    </div>
  )
}

// 総合アプリのランチャー（ホーム）。使う機能をカードで選ぶ。
export default function Launcher() {
  return (
    <div className="min-h-screen bank-statement-app fusion">
      <header className="fusion-bar px-6 py-3 flex items-center gap-3">
        <div className="fusion-logo">KS</div>
        <div>
          <h1 className="text-base font-semibold text-gray-800 leading-tight">業務総合アプリ</h1>
          <p className="text-xs text-gray-500">使う機能を選んでください</p>
        </div>
      </header>

      <div className="px-6 py-10">
        <div className="max-w-5xl mx-auto grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
          {MODULES.map((m) => {
            const ready = m.status === 'ready'
            const inner = (
              <div
                className={`h-full rounded-2xl border bg-white p-5 flex flex-col gap-3 transition-all ${
                  ready
                    ? 'border-gray-200 shadow-sm hover:shadow-md hover:border-blue-300 cursor-pointer'
                    : 'border-gray-200 opacity-60'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-3xl">{m.icon}</span>
                  {ready ? (
                    <span className="text-[11px] font-semibold text-blue-700 bg-blue-50 rounded-full px-2.5 py-1">利用可</span>
                  ) : (
                    <span className="text-[11px] font-semibold text-gray-500 bg-gray-100 rounded-full px-2.5 py-1">準備中</span>
                  )}
                </div>
                <div className="font-semibold text-gray-800">{m.label}</div>
                <p className="text-xs text-gray-500 leading-relaxed mt-auto">{m.desc}</p>
              </div>
            )
            return ready ? (
              <Link key={m.key} href={m.path} className="block h-full">
                {inner}
              </Link>
            ) : (
              <div key={m.key} className="h-full" title="準備中">
                {inner}
              </div>
            )
          })}
        </div>

        <CommonSettings />

        <p className="max-w-5xl mx-auto mt-6 text-xs text-gray-400">
          ※「準備中」の機能は順次このホームから使えるようになります。
        </p>
      </div>
    </div>
  )
}
