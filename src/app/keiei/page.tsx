'use client'

import dynamic from 'next/dynamic'

const KeieiContent = dynamic(() => import('@/components/keiei/KeieiContent'), {
  ssr: false,
  loading: () => (
    <div className="h-screen flex items-center justify-center bg-gray-50">
      <p className="text-gray-500">読み込み中...</p>
    </div>
  ),
})

export default function KeieiPage() {
  return <KeieiContent />
}
