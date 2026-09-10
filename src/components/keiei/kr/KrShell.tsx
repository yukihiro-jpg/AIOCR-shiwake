'use client'

// 月次レポート・ビューアの入れ物。
//
// 顧問先用アプリ（komon-app）の App.tsx を移植したもの。あちらは react-router で
// 画面を切り替えているが、この総合管理アプリは静的書き出し（URLでの画面切替をしない）
// ため、**タブの状態だけで切り替える**形に置き換えた。
// サイドバー・トップバーは移植していない（画面上部の共通ナビと二重になるため）。
//
// 画面の中身（pages/ 配下）は移植元のまま。データは kr/api.ts の差し替え層が
// この総合管理アプリの保存データを返すので、顧問先が見る画面と数字が必ず一致する。

import { useCallback, useEffect, useState } from 'react'
import KrPrint from './KrPrint'
import type { FiscalYearData } from '@/lib/keiei/types'
import type { KeieiSettings } from '@/lib/keiei/analysis'
import { setKrContext, setKrChangeHandler, setKrDataChangeHandler } from '@/lib/keiei/kr/api'
import './keiei-report.css'

import Dashboard from './pages/Dashboard'
import ClientDashboard from './pages/ClientDashboard'
import TrendPL from './pages/TrendPL'
import TrendBS from './pages/TrendBS'
import CashFlow from './pages/CashFlow'
import Debt from './pages/Debt'
import TaxForecast from './pages/TaxForecast'
import BreakEven from './pages/BreakEven'
import Labor from './pages/Labor'
import Simulation from './pages/Simulation'
import QaLog from './pages/QaLog'
import Ask from './pages/Ask'
import LedgerImport from './pages/LedgerImport'
import Partners from './pages/Partners'
import DataImport from './pages/DataImport'
import Help from './pages/Help'

/** 画面の識別子。印刷の選択やタブの並びで使う */
export type KrPage =
  | 'dash' | 'pl' | 'bs'
  | 'cf' | 'debt' | 'tax'
  | 'bep' | 'labor' | 'sim'
  | 'client' | 'ask' | 'qalog'
  | 'import' | 'ledger' | 'partners' | 'help'

export const KR_GROUPS: { group: string; items: { key: KrPage; label: string }[] }[] = [
  {
    group: '月次報告',
    items: [
      { key: 'dash', label: 'ダッシュボード' },
      { key: 'pl', label: '月次推移（損益）' },
      { key: 'bs', label: '月次推移（貸借）' },
    ],
  },
  {
    group: '資金・キャッシュ',
    items: [
      { key: 'cf', label: 'CF計算書（簡便法）' },
      { key: 'debt', label: 'FCF・借入返済バランス' },
      { key: 'tax', label: '納税資金予測' },
    ],
  },
  {
    group: '分析・シミュレーション',
    items: [
      { key: 'bep', label: '損益分岐点・必要売上高' },
      { key: 'labor', label: '労働分配率' },
      { key: 'sim', label: '経営シミュレーション' },
    ],
  },
  {
    group: '顧問先向け',
    items: [
      { key: 'client', label: '顧問先の画面' },
      { key: 'ask', label: '💬 AIに質問' },
      { key: 'qalog', label: 'AI質問ログ' },
    ],
  },
  {
    group: 'データ',
    items: [
      { key: 'import', label: 'データ取込（JSON）' },
      { key: 'ledger', label: '元帳の取込' },
      { key: 'partners', label: '取引先の整理' },
      { key: 'help', label: '❓ 使い方' },
    ],
  },
]

/** 印刷でまとめられる画面（データ取込・使い方など操作用の画面は含めない） */
export const KR_PRINTABLE: { key: KrPage; label: string }[] = [
  { key: 'dash', label: 'ダッシュボード' },
  { key: 'pl', label: '月次推移（損益）' },
  { key: 'bs', label: '月次推移（貸借）' },
  { key: 'cf', label: 'CF計算書（簡便法）' },
  { key: 'debt', label: 'FCF・借入返済バランス' },
  { key: 'tax', label: '納税資金予測' },
  { key: 'bep', label: '損益分岐点・必要売上高' },
  { key: 'labor', label: '労働分配率' },
  { key: 'sim', label: '経営シミュレーション' },
]

export function KrPageBody({ page, jumpCode, onNavigate }: {
  page: KrPage
  jumpCode?: string | null
  onNavigate?: (page: KrPage) => void
}) {
  switch (page) {
    case 'dash': return <Dashboard />
    case 'pl': return <TrendPL jumpCode={jumpCode} />
    case 'bs': return <TrendBS jumpCode={jumpCode} />
    case 'cf': return <CashFlow />
    case 'debt': return <Debt />
    case 'tax': return <TaxForecast />
    case 'bep': return <BreakEven />
    case 'labor': return <Labor />
    case 'sim': return <Simulation />
    // 顧問先が見ているのと同じ画面
    case 'client': return <ClientDashboard canAsk onAsk={() => onNavigate?.('ask')} />
    case 'ask': return <Ask onNavigate={(to) => onNavigate?.(to === '/pl' ? 'pl' : to === '/bs' ? 'bs' : 'dash')} />
    case 'ledger': return <LedgerImport />
    case 'partners': return <Partners />
    case 'qalog': return <QaLog />
    case 'import': return <DataImport />
    case 'help': return <Help />
    default: return null
  }
}

export default function KrShell({
  clientId,
  years,
  settings,
  monthIdx,
  clientName,
  clientCode,
  yearId,
  onYearChange,
  onMonthChange,
  onDeleteYear,
  onExportJson,
  onBackToClients,
  onDataChanged,
}: {
  clientId: string
  years: Record<string, FiscalYearData>
  settings: KeieiSettings
  monthIdx: number
  clientName: string
  clientCode?: string
  /** 表示中の期。サイドバーの「対象期」で切り替える */
  yearId?: string
  onYearChange?: (id: string) => void
  onMonthChange?: (idx: number) => void
  onDeleteYear?: (id: string) => void
  onExportJson?: () => void
  onBackToClients?: () => void
  /** ビューア側でデータを取り込んだ・消したときに親へ知らせる（一覧の再読込用） */
  onDataChanged?: () => void
}) {
  const [page, setPage] = useState<KrPage>('dash')
  const [, setTick] = useState(0)
  // 印刷: 選んだ画面をB4横で刷る。既定は表示中の画面だけ
  const [printOpen, setPrintOpen] = useState(false)
  const [printPick, setPrintPick] = useState<Set<KrPage>>(new Set())
  const [printPages, setPrintPages] = useState<KrPage[] | null>(null)

  // 表紙・ページ下部に出す「どの期のどの月までか」
  const latest = Object.values(years).sort((a, b) => (a.endYear * 12 + a.endMonth) - (b.endYear * 12 + b.endMonth)).pop()
  const periodLabel = latest
    ? `${latest.label}／${latest.fiscalMonths[Math.max(0, Math.min(monthIdx, latest.lastFilledIndex))]}月まで`
    : ''

  // ビューア側の操作（設定変更・取込）で再描画する。
  // 【順番が大事】データを渡す前にこの登録を済ませること。逆にすると初回表示のとき
  // 「データがありません」の案内が出たまま再描画されない（実際に起きた）。
  const rerender = useCallback(() => {
    setTick((t) => t + 1)
  }, [])
  useEffect(() => {
    setKrChangeHandler(rerender)
    return () => setKrChangeHandler(null)
  }, [rerender])

  // 取込・全削除のときだけ親へ知らせる（親は月次データを読み直す）
  useEffect(() => {
    setKrDataChangeHandler(onDataChanged ?? null)
    return () => setKrDataChangeHandler(null)
  }, [onDataChanged])

  // 差し替え層へ、いま表示している顧問先・期・報告月を渡す。
  // 報告月は state.ts で「最新期の最終月」を下げる形で反映される。
  useEffect(() => {
    setKrContext({
      clientId,
      years,
      settings,
      monthIdx,
      client: { code: clientCode || '', name: clientName },
    })
    setTick((t) => t + 1) // 渡した直後に必ず描き直す
  }, [clientId, years, settings, monthIdx, clientName, clientCode])

  // 会社名の頭文字をマークにする（法人格は除いた最初の1文字）
  const mark = clientName
    .replace(/^(株式会社|有限会社|合同会社|合資会社|合名会社|一般社団法人|医療法人|税理士法人)\s*/, '')
    .trim().charAt(0) || '経'
  const sorted = Object.values(years).sort((a, b) => (a.endYear * 12 + a.endMonth) - (b.endYear * 12 + b.endMonth))
  const fy = yearId ? years[yearId] : undefined

  return (
    <div className="kr-root">
      <aside className="kr-sidebar no-print">
        <h1 title={clientName}>
          <span className="kr-mark" aria-hidden="true">{mark}</span>
          <span>{clientName || '月次経営レポート'}</span>
        </h1>
        <div className="kr-client"><span className="kr-tag">経営</span>月次経営レポート</div>

        {KR_GROUPS.map((g) => (
          <div key={g.group}>
            <div className="kr-group">{g.group}</div>
            {g.items.map((it) => (
              <button
                key={it.key}
                onClick={() => setPage(it.key)}
                className={`kr-nav${page === it.key ? ' active' : ''}`}
              >
                {it.label}
              </button>
            ))}
          </div>
        ))}

        {/* 対象期・対象月・取込済み・書き出し（総合管理アプリの上部にあった帯をここへ収めた） */}
        {sorted.length > 0 && (
          <>
            <div className="kr-group">表示する期・月</div>
            <div className="kr-side-box">
              <div className="kr-side-label">対象期</div>
              <select value={yearId || ''} onChange={(e) => onYearChange?.(e.target.value)}>
                {sorted.slice().reverse().map((y) => <option key={y.id} value={y.id}>{y.label}</option>)}
              </select>
              {fy && (
                <>
                  <div className="kr-side-label">対象月（報告月）</div>
                  <select value={monthIdx} onChange={(e) => onMonthChange?.(Number(e.target.value))}>
                    {fy.fiscalMonths.slice(0, fy.lastFilledIndex + 1).map((m, i) => (
                      <option key={i} value={i}>{m}月</option>
                    ))}
                  </select>
                </>
              )}
            </div>

            <div className="kr-group">取込済みの期</div>
            <div className="kr-side-box">
              {sorted.slice().reverse().map((y, i) => {
                const rel = i // 0=当期
                const relLabel = rel === 0 ? '当期' : rel === 1 ? '前期' : rel === 2 ? '前々期' : `${rel}期前`
                return (
                  <div key={y.id} className={`kr-side-year${y.id === yearId ? ' current' : ''}`}>
                    <span className="rel">{relLabel}</span>
                    <span>{y.label}（{y.lastFilledIndex + 1}ヶ月）</span>
                    {onDeleteYear && (
                      <button className="del" title="この期を削除" onClick={() => onDeleteYear(y.id)}>✕</button>
                    )}
                  </div>
                )
              })}
              {onExportJson && (
                <button className="kr-side-btn" onClick={onExportJson}
                  title="取り込んだ全期の月次推移BS/PLを1つのJSONファイルで保存します（顧問先へ渡す用）">
                  📤 取込データを書き出し（JSON・{sorted.length}期）
                </button>
              )}
            </div>
          </>
        )}

        <div className="kr-group">操作</div>
        <div className="kr-side-box">
          <button
            className="kr-side-btn"
            onClick={() => { setPrintPick(new Set(KR_PRINTABLE.some((p) => p.key === page) ? [page] : [])); setPrintOpen(true) }}
            title="B4横カラーで印刷します（画面を選べます）"
          >
            🖨 印刷（B4横）
          </button>
          {onBackToClients && (
            <button className="kr-side-btn plain" onClick={onBackToClients}>← 顧問先一覧へ</button>
          )}
        </div>
      </aside>

      <div className="kr-body">
        <div className="kr-main">
          <KrPageBody page={page} onNavigate={setPage} />
        </div>
      </div>

      {printOpen && (
        <div className="fixed inset-0 bg-black/50 z-[75] flex items-center justify-center p-4"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setPrintOpen(false) }}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-bold text-gray-800 mb-1">🖨 印刷する画面を選ぶ</h3>
            <p className="text-xs text-gray-500 mb-3">B4横・カラーで、1画面につき1ページ印刷します（表紙が付きます）。</p>
            <div className="flex gap-2 mb-2">
              <button className="px-2 py-1 text-xs border border-gray-300 rounded"
                onClick={() => setPrintPick(new Set(KR_PRINTABLE.map((p) => p.key)))}>すべて選ぶ</button>
              <button className="px-2 py-1 text-xs border border-gray-300 rounded"
                onClick={() => setPrintPick(new Set())}>選択を外す</button>
            </div>
            <div className="border border-gray-200 rounded max-h-[50vh] overflow-auto p-2">
              {KR_PRINTABLE.map((p) => (
                <label key={p.key} className="flex items-center gap-2 py-1 text-sm cursor-pointer">
                  <input type="checkbox" className="w-4 h-4"
                    checked={printPick.has(p.key)}
                    onChange={(e) => setPrintPick((prev) => {
                      const n = new Set(prev)
                      if (e.target.checked) n.add(p.key); else n.delete(p.key)
                      return n
                    })} />
                  {p.label}
                </label>
              ))}
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setPrintOpen(false)} className="px-4 py-2 text-sm bg-gray-200 text-gray-700 rounded">閉じる</button>
              <button
                disabled={printPick.size === 0}
                onClick={() => {
                  // 画面の並び順で刷る（選んだ順ではなく、いつも同じ並びの資料にする）
                  setPrintPages(KR_PRINTABLE.filter((p) => printPick.has(p.key)).map((p) => p.key))
                  setPrintOpen(false)
                }}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded font-semibold hover:bg-blue-700 disabled:opacity-40"
              >
                {printPick.size}ページを印刷
              </button>
            </div>
          </div>
        </div>
      )}

      {printPages && (
        <KrPrint
          pages={printPages}
          company={clientName}
          periodLabel={periodLabel}
          onClose={() => setPrintPages(null)}
        />
      )}
    </div>
  )
}
