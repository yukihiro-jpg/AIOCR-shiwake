'use client'

import dynamic from 'next/dynamic'

const RosenkaMapContent = dynamic(
  () => import('@/components/rosenka-map/RosenkaMapContent'),
  {
    ssr: false,
    loading: () => (
      <div className="h-screen flex items-center justify-center bg-gray-50">
        <p className="text-gray-500">読み込み中...</p>
      </div>
    ),
  },
)

export default function RosenkaMapPage() {
  return <RosenkaMapContent />
}
