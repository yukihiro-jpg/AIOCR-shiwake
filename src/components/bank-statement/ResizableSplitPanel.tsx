'use client'

import { useRef, useState, useCallback, useEffect } from 'react'

interface Props {
  left: React.ReactNode
  right: React.ReactNode
  defaultLeftPercent?: number
  minLeftPercent?: number
  maxLeftPercent?: number
}

export default function ResizableSplitPanel({
  left,
  right,
  defaultLeftPercent = 40,
  minLeftPercent = 20,
  maxLeftPercent = 70,
}: Props) {
  const [leftPercent, setLeftPercent] = useState(defaultLeftPercent)
  const containerRef = useRef<HTMLDivElement>(null)
  const isDragging = useRef(false)

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isDragging.current = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [])

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current || !containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const x = e.clientX - rect.left
      const percent = (x / rect.width) * 100
      const clamped = Math.min(Math.max(percent, minLeftPercent), maxLeftPercent)
      setLeftPercent(clamped)
    }

    const handleMouseUp = () => {
      isDragging.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [minLeftPercent, maxLeftPercent])

  return (
    <div ref={containerRef} className="flex flex-1 overflow-hidden">
      <div
        className="flex flex-col overflow-hidden rounded-2xl border border-[#e8eaed] bg-white"
        style={{ width: `${leftPercent}%` }}
      >
        {left}
      </div>

      {/* ドラッグハンドル（カード間の隙間）*/}
      <div
        onMouseDown={handleMouseDown}
        className="group w-3 shrink-0 cursor-col-resize flex items-center justify-center"
      >
        <div className="w-1 h-10 bg-gray-300 rounded group-hover:bg-blue-400 transition-colors" />
      </div>

      <div
        className="flex flex-col overflow-hidden rounded-2xl border border-[#e8eaed] bg-white"
        style={{ width: `${100 - leftPercent}%` }}
      >
        {right}
      </div>
    </div>
  )
}
