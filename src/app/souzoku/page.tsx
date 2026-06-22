'use client'

import dynamic from 'next/dynamic'

// 相続管理モジュール（クライアント専用・静的書き出し対応）
const SouzokuApp = dynamic(() => import('@/modules/souzoku/SouzokuApp'), {
  ssr: false,
  loading: () => (
    <div className="h-screen flex items-center justify-center bg-gray-50">
      <p className="text-gray-500">読み込み中...</p>
    </div>
  ),
})

export default function SouzokuPage() {
  return <SouzokuApp />
}
