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
import DataImport from './pages/DataImport'
import Help from './pages/Help'

/** 画面の識別子。印刷の選択やタブの並びで使う */
export type KrPage =
  | 'dash' | 'pl' | 'bs'
  | 'cf' | 'debt' | 'tax'
  | 'bep' | 'labor' | 'sim'
  | 'client' | 'qalog'
  | 'import' | 'help'

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
      { key: 'qalog', label: 'AI質問ログ' },
    ],
  },
  {
    group: 'データ',
    items: [
      { key: 'import', label: 'データ取込（JSON）' },
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

export function KrPageBody({ page, jumpCode }: { page: KrPage; jumpCode?: string | null }) {
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
    // 顧問先が見ているのと同じ画面。AI質問ボタンはAI画面の移植後に結線する
    case 'client': return <ClientDashboard canAsk={false} onAsk={() => { /* AI質問の移植後に結線 */ }} />
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
  onDataChanged,
}: {
  clientId: string
  years: Record<string, FiscalYearData>
  settings: KeieiSettings
  monthIdx: number
  clientName: string
  clientCode?: string
  /** ビューア側でデータを取り込んだ・消したときに親へ知らせる（一覧の再読込用） */
  onDataChanged?: () => void
}) {
  const [page, setPage] = useState<KrPage>('dash')
  const [, setTick] = useState(0)

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

  return (
    <div className="kr-root">
      <div className="kr-tabs no-print">
        {KR_GROUPS.map((g) => (
          <div key={g.group} className="kr-tabgroup">
            <span className="kr-tabgroup-label">{g.group}</span>
            {g.items.map((it) => (
              <button
                key={it.key}
                onClick={() => setPage(it.key)}
                className={`kr-tab${page === it.key ? ' active' : ''}`}
              >
                {it.label}
              </button>
            ))}
          </div>
        ))}
      </div>
      <div className="kr-main">
        <KrPageBody page={page} />
      </div>
    </div>
  )
}
