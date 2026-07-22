'use client'

import { useRef, useState, useCallback, useEffect } from 'react'
import type { StatementPage, JournalEntry } from '@/lib/bank-statement/types'
import BalanceInfo from './BalanceInfo'

interface Props {
  pages: StatementPage[]
  currentPageIndex: number
  onPageChange: (index: number) => void
  entries?: JournalEntry[]
  selectedTransactionId?: string | null
  bankAccountCode?: string
  hideBalance?: boolean
  onBalanceOverride?: (pageIndex: number, field: 'openingBalance' | 'closingBalance', value: number) => void
  onFileDelete?: () => void // 全ファイル削除
  onPageDelete?: () => void // 表示中のページのみ削除
}

const ZOOM_STEP = 10
const ZOOM_MIN = 30
const ZOOM_MAX = 300
const ZOOM_PRESETS = [50, 75, 100, 125, 150, 200]

export default function StatementViewer({
  pages,
  currentPageIndex,
  onPageChange,
  entries,
  selectedTransactionId,
  bankAccountCode,
  hideBalance,
  onBalanceOverride,
  onFileDelete,
  onPageDelete,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const selectedRowRef = useRef<HTMLTableRowElement>(null)
  const highlightRowRef = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(100)
  // 画像の回転（0/90/180/270度）。ページ切替でリセット
  const [rotation, setRotation] = useState(0)
  useEffect(() => { setRotation(0) }, [currentPageIndex])

  // 右ペインで仕訳行を選択したら、左の該当行へスクロール
  useEffect(() => {
    if (selectedTransactionId && selectedRowRef.current) {
      selectedRowRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [selectedTransactionId, currentPageIndex])

  // 画像上のハイライト行へスクロール（画像表示のとき）
  useEffect(() => {
    if (selectedTransactionId && highlightRowRef.current) {
      highlightRowRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  }, [selectedTransactionId, currentPageIndex])

  // ドラッグによるパン移動
  const [isDragging, setIsDragging] = useState(false)
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 })
  const [scrollStart, setScrollStart] = useState({ x: 0, y: 0 })

  const currentPage = pages[currentPageIndex]

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    // 画像エリアでのドラッグ開始
    if (!containerRef.current) return
    // iframe(PDF viewer)上ではドラッグ禁止（iframe内で独自スクロール）
    const target = e.target as HTMLElement
    if (target.tagName === 'IFRAME') return
    setIsDragging(true)
    setDragStart({ x: e.clientX, y: e.clientY })
    setScrollStart({
      x: containerRef.current.scrollLeft,
      y: containerRef.current.scrollTop,
    })
    e.preventDefault()
  }, [])

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isDragging || !containerRef.current) return
      const dx = e.clientX - dragStart.x
      const dy = e.clientY - dragStart.y
      containerRef.current.scrollLeft = scrollStart.x - dx
      containerRef.current.scrollTop = scrollStart.y - dy
    },
    [isDragging, dragStart, scrollStart],
  )

  const handleMouseUp = useCallback(() => {
    setIsDragging(false)
  }, [])

  const handleZoomIn = () => setZoom((z) => Math.min(z + ZOOM_STEP, ZOOM_MAX))
  const handleZoomOut = () => setZoom((z) => Math.max(z - ZOOM_STEP, ZOOM_MIN))

  if (!currentPage) return null

  // 選択中の仕訳に対応する取引の参照領域（画像上ハイライト用）
  const selectedTx = selectedTransactionId
    ? currentPage.transactions.find((t) => t.id === selectedTransactionId)
    : undefined
  const region = selectedTx?.refRegion
  const pct = (v: number) => `${(v * 100).toFixed(3)}%`
  const boxStyle = (b: { x0: number; y0: number; x1: number; y1: number }) => ({
    left: pct(b.x0), top: pct(b.y0), width: pct(b.x1 - b.x0), height: pct(b.y1 - b.y0),
  })
  const FIELD_STYLES = [
    { key: 'date' as const, label: '日付', cls: 'border-blue-500 bg-blue-400/25' },
    { key: 'description' as const, label: '摘要', cls: 'border-emerald-600 bg-emerald-400/25' },
    { key: 'amount' as const, label: '金額', cls: 'border-rose-500 bg-rose-400/25' },
    { key: 'balance' as const, label: '残高', cls: 'border-violet-500 bg-violet-400/25' },
  ]

  return (
    <div className="flex flex-col h-full">
      {/* ページ送り + ズーム */}
      <div className="flex items-center justify-between px-4 py-2 bg-white border-b border-gray-200 shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-gray-800 mr-1">解析元データ</span>
          <button
            onClick={() => onPageChange(currentPageIndex - 1)}
            disabled={currentPageIndex === 0}
            className="px-2 py-1 text-sm bg-white border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            &lt;
          </button>
          <span className="text-xs text-gray-600 mx-1">
            {currentPageIndex + 1}/{pages.length}
          </span>
          <button
            onClick={() => onPageChange(currentPageIndex + 1)}
            disabled={currentPageIndex >= pages.length - 1}
            className="px-2 py-1 text-sm bg-white border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            &gt;
          </button>
        </div>

        <div className="flex items-center gap-1">
          {onPageDelete && (
            <button onClick={onPageDelete} title={`表示中のページ（${currentPageIndex + 1}/${pages.length}）と、このページから作成された仕訳だけを削除します`}
              className="px-2 py-1 text-xs bg-amber-50 text-amber-700 border border-amber-300 rounded hover:bg-amber-100">
              このページを削除
            </button>
          )}
          {onFileDelete && (
            <button onClick={onFileDelete} title="アップロードした全ファイルと画面上の仕訳を削除します"
              className="px-2 py-1 text-xs bg-red-50 text-red-600 border border-red-200 rounded hover:bg-red-100 mr-1">
              全ファイル削除
            </button>
          )}
          {currentPage.imageDataUrl && !currentPage.pdfDataUrl && (
            <>
              <button
                onClick={() => setRotation((r) => (r + 270) % 360)}
                title="左に90°回転"
                className="w-7 h-7 flex items-center justify-center text-sm bg-white border border-gray-300 rounded hover:bg-gray-50"
              >
                ↺
              </button>
              <button
                onClick={() => setRotation((r) => (r + 90) % 360)}
                title="右に90°回転"
                className="w-7 h-7 flex items-center justify-center text-sm bg-white border border-gray-300 rounded hover:bg-gray-50 mr-1"
              >
                ↻
              </button>
            </>
          )}
          <button
            onClick={handleZoomOut}
            disabled={zoom <= ZOOM_MIN}
            className="w-7 h-7 flex items-center justify-center text-sm bg-white border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            -
          </button>
          <select
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            className="px-1 py-1 text-xs border border-gray-300 rounded bg-white text-center w-16"
          >
            {ZOOM_PRESETS.map((p) => (
              <option key={p} value={p}>{p}%</option>
            ))}
            {!ZOOM_PRESETS.includes(zoom) && (
              <option value={zoom}>{zoom}%</option>
            )}
          </select>
          <button
            onClick={handleZoomIn}
            disabled={zoom >= ZOOM_MAX}
            className="w-7 h-7 flex items-center justify-center text-sm bg-white border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            +
          </button>
        </div>
      </div>

      {/* 参照ハイライトの凡例（ハイライト表示中のみ） */}
      {region && (
        <div className="flex items-center gap-3 px-4 py-1 bg-amber-50 border-b border-amber-200 text-[11px] text-gray-600 shrink-0">
          <span className="font-semibold text-amber-700">参照箇所を表示中:</span>
          <span className="flex items-center gap-1"><i className="inline-block w-3 h-3 rounded-sm border-2 border-blue-500 bg-blue-400/25" />日付</span>
          <span className="flex items-center gap-1"><i className="inline-block w-3 h-3 rounded-sm border-2 border-emerald-600 bg-emerald-400/25" />摘要</span>
          <span className="flex items-center gap-1"><i className="inline-block w-3 h-3 rounded-sm border-2 border-rose-500 bg-rose-400/25" />金額</span>
          <span className="flex items-center gap-1"><i className="inline-block w-3 h-3 rounded-sm border-2 border-violet-500 bg-violet-400/25" />残高</span>
        </div>
      )}

      {/* 画像表示エリア（ドラッグ移動対応） */}
      <div
        ref={containerRef}
        className={`flex-1 overflow-auto p-2 ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        {currentPage.pdfDataUrl ? (
          // PDFを iframe で表示。ズーム変更時に再レンダでURLフラグメントを更新。
          // ドラッグ移動はブラウザ標準PDFビューアのスクロールに任せる
          <iframe
            key={`${currentPageIndex}-${zoom}`}
            src={`${currentPage.pdfDataUrl}#page=${currentPageIndex + 1}&zoom=${zoom}`}
            title={`通帳ページ ${currentPageIndex + 1}`}
            className="w-full border-0"
            style={{ height: 'calc(100vh - 200px)', minHeight: '600px' }}
          />
        ) : currentPage.imageDataUrl ? (
          <div className="flex justify-center items-start" style={{ width: `${zoom}%`, minWidth: '100%' }}>
            {/* 画像とハイライトを同じラッパーに入れ、回転もラッパーごと行う（%座標が常に画像と一致） */}
            <div
              className="relative inline-block"
              style={{ transform: `rotate(${rotation}deg)`, transformOrigin: 'center center' }}
            >
              <img
                src={currentPage.imageDataUrl}
                alt={`通帳ページ ${currentPageIndex + 1}`}
                className="max-w-full h-auto select-none pointer-events-none block"
                draggable={false}
              />
              {region && (
                <>
                  {region.row && (
                    <div
                      ref={highlightRowRef}
                      className="absolute border-y-2 border-amber-400 bg-amber-300/15 pointer-events-none"
                      style={boxStyle(region.row)}
                    />
                  )}
                  {FIELD_STYLES.map(({ key, label, cls }) => {
                    const b = region[key]
                    if (!b) return null
                    return (
                      <div
                        key={key}
                        title={label}
                        className={`absolute border-2 rounded-sm pointer-events-none ${cls}`}
                        style={boxStyle(b)}
                      />
                    )
                  })}
                </>
              )}
            </div>
          </div>
        ) : (
          <div className="bg-white border border-gray-200 rounded overflow-auto">
            <table className="w-full text-xs border-collapse">
              <tbody>
                {currentPage.transactions.map((tx, i) => {
                  const isSelected = tx.id === selectedTransactionId
                  return (
                  <tr
                    key={tx.id}
                    ref={isSelected ? selectedRowRef : undefined}
                    className={`h-[34px] border-b border-gray-100 ${isSelected ? 'bg-yellow-100' : `${i % 2 === 1 ? 'bg-[#f6f9ff]' : 'bg-white'} hover:bg-sky-50`}`}
                  >
                    <td className="px-2 py-1.5 whitespace-nowrap">{tx.date}</td>
                    <td className="px-2 py-1.5">{tx.description}</td>
                    <td className="px-2 py-1.5 text-right whitespace-nowrap">
                      {tx.deposit ? tx.deposit.toLocaleString() : ''}
                    </td>
                    <td className="px-2 py-1.5 text-right whitespace-nowrap">
                      {tx.withdrawal ? tx.withdrawal.toLocaleString() : ''}
                    </td>
                    <td className="px-2 py-1.5 text-right whitespace-nowrap font-medium">
                      {tx.balance.toLocaleString()}
                    </td>
                  </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 残高情報 */}
      {hideBalance ? (
        // クレジットカード等: 金額合計のみ表示
        <div className="px-4 py-2 bg-[#fafbfd] border-t border-gray-200 shrink-0 text-sm">
          <span className="text-gray-600">金額合計: </span>
          <span className="font-bold text-gray-800">
            ¥{currentPage.transactions.reduce((s, t) => s + (t.deposit || 0) + (t.withdrawal || 0), 0).toLocaleString()}
          </span>
          <span className="text-xs text-gray-400 ml-2">({currentPage.transactions.length}件)</span>
        </div>
      ) : (
        <BalanceInfo page={currentPage} entries={entries} bankAccountCode={bankAccountCode} onBalanceOverride={onBalanceOverride} />
      )}
    </div>
  )
}
