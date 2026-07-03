'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { MODULES } from '@/core/registry'

const SUITE_GEMINI_KEY = 'suite-gemini-api-key'
const GOOGLE_CLIENT_ID_KEY = 'suite-google-client-id'
const OFFICE_NAME = '日下部税理士事務所'

// 共通設定モーダル：Gemini APIキーを1か所で登録（各モジュールはこのキーを自動で使う）
function CommonSettingsModal({ onClose }: { onClose: () => void }) {
  const [key, setKey] = useState(() => {
    if (typeof window === 'undefined') return ''
    return localStorage.getItem(SUITE_GEMINI_KEY) || ''
  })
  const [show, setShow] = useState(false)
  const [gClientId, setGClientId] = useState(() => {
    if (typeof window === 'undefined') return ''
    return localStorage.getItem(GOOGLE_CLIENT_ID_KEY) || ''
  })
  const save = (v: string) => {
    const t = v.trim()
    setKey(t)
    try {
      if (t) localStorage.setItem(SUITE_GEMINI_KEY, t)
      else localStorage.removeItem(SUITE_GEMINI_KEY)
    } catch { /* ignore */ }
  }
  const saveGClientId = (v: string) => {
    const t = v.trim()
    setGClientId(t)
    try {
      if (t) localStorage.setItem(GOOGLE_CLIENT_ID_KEY, t)
      else localStorage.removeItem(GOOGLE_CLIENT_ID_KEY)
    } catch { /* ignore */ }
  }
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 py-10 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl rounded-2xl border border-gray-200 bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            <span className="text-xl">⚙️</span>
            <h2 className="font-semibold text-gray-800">共通設定</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-700 text-xl leading-none px-2"
            aria-label="閉じる"
          >
            ×
          </button>
        </div>
        <div className="flex items-center gap-2 mt-4 mb-1">
          <span className="text-lg">🔑</span>
          <h3 className="font-semibold text-gray-800 text-sm">Gemini APIキー</h3>
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
            className="flex-1 min-w-[220px] px-3 py-2 text-sm border border-gray-300 rounded-lg font-mono"
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

        <div className="flex items-center gap-2 mt-5 mb-1 pt-4 border-t border-gray-100">
          <span className="text-lg">📁</span>
          <h3 className="font-semibold text-gray-800 text-sm">GoogleクライアントID（共有ドライブ保存用）</h3>
        </div>
        <p className="text-xs text-gray-500 mb-2 leading-relaxed">
          書類スキャン受信・年調データ受信の「Driveへ保存」で使います。Google Cloudで発行したOAuthクライアントIDを貼り付けてください（この端末に保存）。
        </p>
        <input
          type="text"
          value={gClientId}
          placeholder="xxxxx.apps.googleusercontent.com"
          onChange={(e) => saveGClientId(e.target.value)}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg font-mono"
        />
        <p className="text-[11px] mt-1 px-2 py-1 bg-gray-50 rounded text-gray-600 inline-block">
          現在：<b>{gClientId ? '設定済み' : '未設定'}</b>
        </p>
        <div className="mt-5 text-right">
          <button
            type="button"
            onClick={onClose}
            className="text-sm px-4 py-2 rounded-lg bg-gray-800 text-white hover:bg-gray-700"
          >
            閉じる
          </button>
        </div>
      </div>
    </div>
  )
}

// 進捗管理（komon）の端末キャッシュから「今日の要対応」件数を集計する。
// データは localStorage['komonManagerData_v3']（進捗管理を開いた端末にキャッシュ）。
type Todo = { kessanPending: number; checkPending: number; clients: number; hasData: boolean }

function readTodo(): Todo {
  const empty: Todo = { kessanPending: 0, checkPending: 0, clients: 0, hasData: false }
  if (typeof window === 'undefined') return empty
  let data: any
  try {
    const raw = localStorage.getItem('komonManagerData_v3')
    if (!raw) return empty
    data = JSON.parse(raw)
  } catch {
    return empty
  }
  const clients: any[] = Array.isArray(data?.clients) ? data.clients : []
  const active = clients.filter((c) => c && c.status !== '休止' && c.status !== '解約')

  // 決算メモ：質問ありで確認結果が未入力の行数
  let kessanPending = 0
  const km = data?.kessanMemos || {}
  Object.keys(km).forEach((key) => {
    const rows = km[key]?.rows || []
    rows.forEach((r: any) => {
      if (String(r?.q || '').trim() && !String(r?.a || '').trim()) kessanPending++
    })
  })

  // 申告書チェック待ち：申告書作成は完了（日付あり）だがチェックが未完了
  const DEFAULT_STEPS = ['資料受取', '会計入力', '申告書作成', '申告書チェック', '申告書セット', '押印・納付書', '申告', '返却用セット', '返却']
  const filingYear = new Date().getFullYear()
  const filingSteps = data?.filingSteps || {}
  const filings = data?.filings || {}
  const fiscalMonthNum = (fm: any) => { const m = String(fm || '').match(/(\d+)/); return m ? +m[1] : 0 }
  let checkPending = 0
  active.forEach((c) => {
    if (c.souzokuSpot) return
    const M = fiscalMonthNum(c.fiscal)
    if (!M) return
    const steps = filingSteps[String(M)] || DEFAULT_STEPS.map((n) => ({ name: n, due: '' }))
    const cells = (filings[filingYear + '__' + c.id] || {}).cells || {}
    const madeStep = steps.find((s: any) => s.name === '申告書作成') || steps.find((s: any) => /申告.*作成/.test(s.name))
    const chkStep = steps.find((s: any) => s.name === '申告書チェック') || steps.find((s: any) => /チェック/.test(s.name))
    if (!madeStep || !chkStep) return
    const made = cells[madeStep.name], chk = cells[chkStep.name]
    if (made && made !== '対象外' && !chk) checkPending++
  })

  return { kessanPending, checkPending, clients: active.length, hasData: true }
}

function Tiles({ todo }: { todo: Todo }) {
  const tiles = [
    { n: todo.kessanPending, label: '決算メモ 未確認', accent: '#f59e0b', href: '/shinchoku' },
    { n: todo.checkPending, label: '申告書チェック待ち', accent: '#f59e0b', href: '/shinchoku' },
    { n: todo.clients, label: '登録顧問先', accent: '#0ea5e9', href: '/komon' },
  ]
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
      {tiles.map((t) => (
        <Link
          key={t.label}
          href={t.href}
          className="rounded-2xl border border-gray-200 bg-white px-4 py-4 hover:shadow-md transition-shadow"
          style={{ borderLeft: `4px solid ${t.accent}` }}
        >
          <div className="text-2xl font-extrabold text-gray-800">{todo.hasData ? t.n : '—'}</div>
          <div className="text-[11.5px] text-gray-500 mt-0.5">{t.label}</div>
        </Link>
      ))}
      {!todo.hasData && (
        <div className="rounded-2xl border border-dashed border-gray-300 bg-gray-50 px-4 py-4 flex items-center text-[11px] text-gray-400 leading-relaxed">
          進捗管理を一度開くと、この端末で件数が表示されます
        </div>
      )}
    </div>
  )
}

const NAV_ICONS: Record<string, string> = { home: '🏠' }

// 総合アプリのランチャー（ホーム）。左サイドバー＋要対応ダッシュボード＋機能カード。
export default function Launcher() {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [todo, setTodo] = useState<Todo>({ kessanPending: 0, checkPending: 0, clients: 0, hasData: false })
  const [today, setToday] = useState('')

  useEffect(() => {
    setTodo(readTodo())
    const d = new Date()
    const w = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()]
    setToday(`${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${w}）`)
  }, [])

  return (
    <div className="min-h-screen bank-statement-app fusion flex">
      {/* 左サイドバー */}
      <aside className="w-60 shrink-0 flex flex-col text-slate-300" style={{ background: '#0f2740', minHeight: '100vh' }}>
        <div className="px-5 py-5 border-b border-slate-700/60">
          <div className="text-slate-50 font-bold text-[15px] leading-tight">業務総合アプリ</div>
          <div className="text-slate-400 text-[11px] mt-1">{OFFICE_NAME}</div>
        </div>
        <nav className="flex-1 px-2.5 py-3 space-y-0.5">
          <div className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13.5px] font-medium text-white" style={{ background: '#0ea5e9' }}>
            <span className="w-5 text-center text-base">{NAV_ICONS.home}</span>ホーム
          </div>
          {MODULES.map((m) => {
            const ready = m.status === 'ready'
            const cls = 'flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13.5px] hover:bg-slate-700/60'
            const inner = (
              <>
                <span className="w-5 text-center text-base">{m.icon}</span>
                <span className={ready ? '' : 'opacity-50'}>{m.label}</span>
              </>
            )
            return ready ? (
              <Link key={m.key} href={m.path} className={cls}>{inner}</Link>
            ) : (
              <div key={m.key} className={cls + ' opacity-60 cursor-default'} title="準備中">{inner}</div>
            )
          })}
        </nav>
        <div className="border-t border-slate-700/60 px-2.5 py-3">
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-[12.5px] text-slate-300 hover:bg-slate-700/60"
          >
            <span className="w-5 text-center text-base">⚙️</span>共通設定
          </button>
        </div>
      </aside>

      {/* メイン */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="bg-white border-b border-gray-200 h-14 px-6 flex items-center">
          <div className="text-sm text-gray-500"><b className="text-gray-800">ホーム</b></div>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="ml-auto flex items-center gap-1.5 text-sm px-3 py-2 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 text-gray-700"
            title="共通設定（Gemini APIキー）"
          >
            <span className="text-base">⚙️</span>
            <span className="hidden sm:inline">共通設定</span>
          </button>
        </header>

        <div className="px-6 py-7 overflow-auto">
          <div className="max-w-5xl">
            <h2 className="text-xl font-bold text-gray-800">おかえりなさい</h2>
            <p className="text-[13px] text-gray-500 mb-5">{today}{today && '・'}今日の要対応をまとめました</p>

            <Tiles todo={todo} />

            <div className="text-[13px] font-semibold text-gray-600 mb-3">機能を選ぶ</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
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
                  <Link key={m.key} href={m.path} className="block h-full">{inner}</Link>
                ) : (
                  <div key={m.key} className="h-full" title="準備中">{inner}</div>
                )
              })}
            </div>
          </div>
        </div>
      </div>

      {settingsOpen && <CommonSettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}
