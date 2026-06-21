'use client'

import Link from 'next/link'
import { MODULES } from '@/core/registry'

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

        <p className="max-w-5xl mx-auto mt-6 text-xs text-gray-400">
          ※「準備中」の機能は順次このホームから使えるようになります。
        </p>
      </div>
    </div>
  )
}
