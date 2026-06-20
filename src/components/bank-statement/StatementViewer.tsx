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
  onFileDelete?: () => void
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
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const selectedRowRef = useRef<HTMLTableRowElement>(null)
  const [zoom, setZoom] = useState(100)

  // 右ペインで仕訳行を選択したら、左の該当行へスクロール
  useEffect(() => {
    if (selectedTransactionId && selectedRowRef.current) {
      selectedRowRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
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

  return (
    <div className="flex flex-col h-full">
      {/* ページ送り + ズーム */}
      <div className="flex items-center justify-between px-4 py-2 bg-gray-50 border-b border-gray-200 shrink-0">
        <div className="flex items-center gap-1">
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
          {onFileDelete && (
            <button onClick={onFileDelete} title="アップロードファイルを削除"
              className="px-2 py-1 text-xs bg-red-50 text-red-600 border border-red-200 rounded hover:bg-red-100 mr-1">
              ファイル削除
            </button>
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
          <div className="inline-block" style={{ width: `${zoom}%`, minWidth: '100%' }}>
            <img
              src={currentPage.imageDataUrl}
              alt={`通帳ページ ${currentPageIndex + 1}`}
              className="w-full select-none pointer-events-none"
              draggable={false}
            />
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
        <div className="px-4 py-2 bg-gray-50 border-t border-gray-200 shrink-0 text-sm">
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
