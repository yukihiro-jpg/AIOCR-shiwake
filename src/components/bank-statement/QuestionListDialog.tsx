'use client'

import { useState } from 'react'
import type { AccountItem } from '@/lib/bank-statement/types'
import { generateQuestionList, downloadQuestionExcel } from '@/lib/bank-statement/question-list'
import { clearQuestionItems } from '@/lib/bank-statement/question-store'
import type { Client } from '@/lib/bank-statement/client-store'

interface Props {
  open: boolean
  onClose: () => void
  accountMaster: AccountItem[]
  client: Client | null
}

export default function QuestionListDialog({ open, onClose, accountMaster, client }: Props) {
  const [copied, setCopied] = useState(false)
  const [refresh, setRefresh] = useState(0)

  if (!open) return null

  const clientName = client?.name || '顧問先'
  // refresh をキーに含めることで、クリア後に再計算させる
  void refresh
  const rows = generateQuestionList(accountMaster, clientName)
  const today = new Date().toLocaleDateString('ja-JP')

  const handleClear = () => {
    if (!window.confirm('質問リストを顧問先へ送付済みにして、蓄積をクリアします。よろしいですか？\n（CSV出力で溜めた仮払金の確認事項がリセットされます）')) return
    clearQuestionItems()
    setRefresh((v) => v + 1)
  }

  // メール本文生成
  const mailBody = `${clientName} 様

いつもお世話になっております。

${today}現在のお取引につきまして、内容が確認できないものがございましたので、ご確認をお願いいたします。

添付のExcelファイルに該当する${rows.length}件のお取引をまとめております。
各取引の「回答」欄にお取引の内容をご記入いただき、ご返送くださいますようお願いいたします。

なお、領収書・レシート・請求書等の証憑がございましたら、併せてご提供いただけますと幸いです。

ご不明な点がございましたら、お気軽にお問い合わせください。

よろしくお願いいたします。`

  const handleCopy = () => {
    navigator.clipboard.writeText(mailBody)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleDownload = () => {
    downloadQuestionExcel(rows, clientName)
  }

  if (rows.length === 0) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
        <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
          <h2 className="text-lg font-bold text-gray-800 mb-4">仮払金質問リスト</h2>
          <p className="text-sm text-gray-600 mb-4">質問対象の仮払金がありません。<br/>（仮払金にした行のうち「要質問」のものが、CSV出力や一時保存を通じてここに溜まります）</p>
          <button onClick={onClose} className="px-4 py-2 text-sm bg-gray-100 rounded hover:bg-gray-200">閉じる</button>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-6xl max-h-[90vh] flex flex-col">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-gray-800">仮払金質問リスト</h2>
            <p className="text-sm text-gray-500">{clientName} 様 — {rows.length}件の確認事項</p>
          </div>
          <button onClick={handleDownload}
            className="px-4 py-2 text-sm bg-green-600 text-white rounded hover:bg-green-700 font-medium">
            Excelダウンロード
          </button>
        </div>

        <div className="flex flex-1 overflow-hidden">
          {/* 左: プレビュー */}
          <div className="flex-1 overflow-auto border-r border-gray-200">
            <div className="px-6 py-3 bg-gray-50 border-b border-gray-200">
              <h3 className="text-sm font-bold text-gray-700">質問リスト プレビュー</h3>
            </div>
            <div className="overflow-auto">
              <table className="w-full text-sm border-collapse">
                <thead className="sticky top-0 bg-gray-100">
                  <tr>
                    <th className="px-3 py-2 text-left border-b border-gray-300 w-8 font-medium">No</th>
                    <th className="px-3 py-2 text-left border-b border-gray-300 w-24 font-medium">日付</th>
                    <th className="px-3 py-2 text-left border-b border-gray-300 font-medium">口座</th>
                    <th className="px-3 py-2 text-center border-b border-gray-300 w-12 font-medium">入出金</th>
                    <th className="px-3 py-2 text-right border-b border-gray-300 w-20 font-medium">金額</th>
                    <th className="px-3 py-2 text-left border-b border-gray-300 font-medium">通帳摘要</th>
                    <th className="px-3 py-2 text-left border-b border-gray-300 font-medium" style={{ minWidth: 250 }}>確認事項</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.no} className="border-b border-gray-100 hover:bg-gray-50">
                      <td className="px-3 py-2 text-xs text-gray-500">{r.no}</td>
                      <td className="px-3 py-2 text-xs">{r.date}</td>
                      <td className="px-3 py-2 text-xs">{r.bankAccount}</td>
                      <td className="px-3 py-2 text-xs text-center">
                        <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${
                          r.direction === '出金' ? 'bg-red-100 text-red-700' : 'bg-blue-100 text-blue-700'
                        }`}>{r.direction}</span>
                      </td>
                      <td className="px-3 py-2 text-xs text-right tabular-nums font-medium">{r.amount.toLocaleString()}</td>
                      <td className="px-3 py-2 text-xs text-gray-700">{r.originalDescription}</td>
                      <td className="px-3 py-2 text-xs text-gray-600 whitespace-pre-wrap">{r.question}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* 右: メール本文 */}
          <div className="w-96 flex flex-col shrink-0">
            <div className="px-4 py-3 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
              <h3 className="text-sm font-bold text-gray-700">メール本文サンプル</h3>
              <button onClick={handleCopy}
                className={`px-3 py-1 text-xs rounded font-medium transition-colors ${
                  copied
                    ? 'bg-green-100 text-green-700'
                    : 'bg-blue-100 text-blue-700 hover:bg-blue-200'
                }`}>
                {copied ? 'コピーしました' : 'メール本文をコピー'}
              </button>
            </div>
            <div className="flex-1 overflow-auto p-4">
              <pre className="text-sm text-gray-700 whitespace-pre-wrap font-sans leading-relaxed">
                {mailBody}
              </pre>
            </div>
          </div>
        </div>

        <div className="px-6 py-3 border-t border-gray-200 flex items-center justify-between">
          <p className="text-xs text-gray-400">
            Excelをダウンロードしてメールに添付してください
          </p>
          <div className="flex items-center gap-2">
            <button onClick={handleClear}
              className="px-4 py-2 text-sm bg-rose-50 text-rose-600 border border-rose-200 rounded hover:bg-rose-100">
              送付済み（リストをクリア）
            </button>
            <button onClick={onClose} className="px-4 py-2 text-sm bg-gray-100 rounded hover:bg-gray-200">閉じる</button>
          </div>
        </div>
      </div>
    </div>
  )
}
