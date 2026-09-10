'use client'

// 月次レポートの印刷（B4横・カラー）。
//
// 作り方の考え方:
//   紙面用のHTMLを別に組むのではなく、**画面のコンポーネントをそのまま紙に流し込む**。
//   画面で操作した状態（選んだ期・表示モード・展開した科目）がそのまま刷れるうえ、
//   画面と紙で数字がずれる余地が無い。
//
// ページの割り方:
//   「1画面＝必ず1ページ」にはしない。ダッシュボードのように表とグラフが多い画面は
//   B4横1枚に押し込むと 0.2 倍程度まで縮んで読めなくなるため、
//   **画面ごとに改ページし、中身は必要なページ数だけ自然に流す**。
//   カード（表・グラフの箱）は途中で切れないようにする。
//
// 横幅だけは収める:
//   月次推移のピボット表は列が多く紙幅を超えることがある。横にはみ出すと列が
//   黙って欠けた紙が出るので、幅が超えた画面だけ縮小して収める（高さは流す）。

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { KrPageBody, KR_PRINTABLE, type KrPage } from './KrShell'
import './print.css'

const PAGE_W_MM = 364 // B4(JIS)横の幅
const PAD_MM = 12
const MM = 96 / 25.4 // 1mm あたりの px（CSS上の換算）

/** 1つの画面ぶん。幅が紙に収まらないときだけ縮める */
function PrintScreen({
  title, subtitle, no, total, children,
}: {
  title: string
  subtitle: string
  no: number
  total: number
  children: React.ReactNode
}) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)

  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el) return
    // 組んでから測って、はみ出した分だけ縮める（列数・行数の決め打ちをしない）
    const avail = (PAGE_W_MM - PAD_MM * 2) * MM
    const w = el.scrollWidth
    const s = Math.min(1, avail / Math.max(1, w))
    setScale(Math.max(0.5, Math.round(s * 100) / 100))
  }, [children])

  return (
    <section className="kr-print-screen">
      <div className="kr-print-head">
        <span>{subtitle}</span>
        <span className="t">{title}</span>
        <span>資料 {no} / {total}</span>
      </div>
      <div
        ref={bodyRef}
        style={scale < 1
          ? { transform: `scale(${scale})`, transformOrigin: 'top left', width: `${100 / scale}%` }
          : undefined}
      >
        {children}
      </div>
    </section>
  )
}

export default function KrPrint({
  pages,
  company,
  periodLabel,
  onClose,
}: {
  /** 印刷する画面（この順で、画面ごとに改ページ） */
  pages: KrPage[]
  company: string
  periodLabel: string
  onClose: () => void
}) {
  const [ready, setReady] = useState(false)
  const labelOf = (k: KrPage) => KR_PRINTABLE.find((p) => p.key === k)?.label || ''
  const today = new Date().toLocaleDateString('ja-JP')

  // グラフ（SVG）の描画が終わってから印刷できるようにする
  useEffect(() => {
    const t = setTimeout(() => setReady(true), 500)
    return () => clearTimeout(t)
  }, [])

  // 印刷したときに裏の画面まで刷られないよう、開いている間だけ目印を付ける
  useEffect(() => {
    document.body.classList.add('kr-printing')
    return () => document.body.classList.remove('kr-printing')
  }, [])

  // 【重要】印刷時に「裏の画面まで刷られる」「1ページしか出ない」を防ぐため、
  // このプレビューは body 直下へ出す（ポータル）。
  //  ・body 直下なら「プレビュー以外を display:none」で裏の画面を確実に消せる
  //  ・position:fixed のままだと Chrome は1ページ目にしか描かないので、印刷時は解除する
  if (typeof document === 'undefined') return null
  return createPortal(
    <div className="kr-print-overlay fixed inset-0 bg-gray-100 z-[80] overflow-auto">
      <div className="no-print sticky top-0 flex items-center gap-2 bg-white border-b border-gray-200 px-4 py-2 z-10 flex-wrap">
        <span className="text-sm font-bold text-gray-800">印刷プレビュー（B4横・カラー）</span>
        <span className="text-xs text-gray-500">表紙＋{pages.length}資料</span>
        <span className="text-xs text-amber-700">
          ※ 印刷ダイアログで用紙「B4」・余白「なし」・「背景のグラフィック」をオンにしてください
        </span>
        <div className="ml-auto flex gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm bg-gray-200 text-gray-700 rounded">閉じる</button>
          <button
            onClick={() => window.print()}
            disabled={!ready}
            className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded font-semibold hover:bg-blue-700 disabled:opacity-50"
          >
            {ready ? '🖨 印刷する' : '準備中…'}
          </button>
        </div>
      </div>

      <div className="kr-print-root preview kr-root">
        <section className="kr-print-cover">
          <div className="t1">月次経営レポート</div>
          <div className="t2">{company}　御中</div>
          <div className="t3">{periodLabel}／作成日 {today}</div>
          <ol>
            {pages.map((p) => <li key={p}>{labelOf(p)}</li>)}
          </ol>
        </section>

        {pages.map((p, i) => (
          <PrintScreen
            key={p}
            title={labelOf(p)}
            subtitle={`${company}／${periodLabel}`}
            no={i + 1}
            total={pages.length}
          >
            <KrPageBody page={p} />
          </PrintScreen>
        ))}
      </div>
    </div>,
    document.body,
  )
}
