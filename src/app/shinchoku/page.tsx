'use client'

import dynamic from 'next/dynamic'

// 進捗管理（議事録含む）。komon モジュールを shinchoku ビューで表示。
const KomonApp = dynamic(() => import('@/modules/komon/KomonApp'), {
  ssr: false,
  loading: () => (
    <div className="h-screen flex items-center justify-center bg-gray-50">
      <p className="text-gray-500">読み込み中...</p>
    </div>
  ),
})

export default function ShinchokuPage() {
  return <KomonApp view="shinchoku" />
}
