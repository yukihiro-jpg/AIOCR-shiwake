'use client'

import { useEffect, useState } from 'react'
import { getCardFormats, deleteCardFormat, type CardFormat } from '@/lib/bank-statement/card-format-store'

interface Props {
  onClose: () => void
}

/**
 * 記憶しているカード明細フォーマットの一覧。
 * カード会社ごとの列レイアウトを覚えているので、2回目以降は検出をやり直さずに読める。
 * 明細の様式が変わって読み違えるようになったときは、ここから削除すれば覚え直す。
 */
export default function CardFormatDialog({ onClose }: Props) {
  const [formats, setFormats] = useState<CardFormat[]>([])

  const reload = () => {
    const all = getCardFormats()
    setFormats(Object.values(all).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')))
  }
  useEffect(reload, [])

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-gray-200 flex items-center justify-between">
          <h2 className="font-semibold text-gray-800">記憶しているカード明細フォーマット</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        <div className="px-5 py-3 text-xs text-gray-600 bg-gray-50 border-b border-gray-200 leading-relaxed">
          カード明細PDFをAIを使わずに解析したとき、うまく読めたフォーマット（日付・金額・摘要の列の位置）を
          カード会社ごとに覚えています。2回目以降はこの位置で読むので、毎回同じ結果になります。
          明細の様式が変わって読み違えるようになったら削除してください（次回また覚え直します）。
        </div>

        <div className="flex-1 overflow-auto p-4">
          {formats.length === 0 ? (
            <p className="text-sm text-gray-500 py-8 text-center">
              まだ記憶しているフォーマットはありません。<br />
              カード明細のPDFを取り込むと、解析できたものから自動で覚えます。
            </p>
          ) : (
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="bg-gray-50 text-gray-600">
                  <th className="text-left px-2 py-1.5 border-b border-gray-200">カード明細</th>
                  <th className="text-right px-2 py-1.5 border-b border-gray-200 whitespace-nowrap">前回の件数</th>
                  <th className="text-right px-2 py-1.5 border-b border-gray-200 whitespace-nowrap">利用回数</th>
                  <th className="text-left px-2 py-1.5 border-b border-gray-200 whitespace-nowrap">最終更新</th>
                  <th className="border-b border-gray-200"></th>
                </tr>
              </thead>
              <tbody>
                {formats.map((f) => (
                  <tr key={f.signature} className="border-b border-gray-100">
                    <td className="px-2 py-1.5">
                      <div className="font-medium text-gray-800">{f.label}</div>
                      <div className="text-[10px] text-gray-400 mt-0.5">
                        日付列 {Math.round(f.layout.dateX[0])}pt ／ 金額列 {Math.round(f.layout.amountX[1])}pt
                        {f.descNeedsOcr && '　摘要は端末内OCRで読み取り'}
                      </div>
                    </td>
                    <td className="px-2 py-1.5 text-right whitespace-nowrap">{f.lastRows}件</td>
                    <td className="px-2 py-1.5 text-right whitespace-nowrap">{f.useCount}回</td>
                    <td className="px-2 py-1.5 whitespace-nowrap text-gray-500">
                      {f.updatedAt ? new Date(f.updatedAt).toLocaleDateString('ja-JP') : ''}
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <button
                        onClick={() => {
                          if (!confirm(`「${f.label}」のフォーマットを忘れますか？\n次にこの明細を取り込むとき、あらためて列の位置を検出します。`)) return
                          deleteCardFormat(f.signature)
                          reload()
                        }}
                        className="px-2 py-1 text-[11px] text-red-600 border border-red-200 rounded hover:bg-red-50"
                      >
                        忘れる
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="px-5 py-3 border-t border-gray-200 text-right">
          <button onClick={onClose} className="px-4 py-1.5 text-sm bg-gray-100 border border-gray-300 rounded hover:bg-gray-200">閉じる</button>
        </div>
      </div>
    </div>
  )
}
