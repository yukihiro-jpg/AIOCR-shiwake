'use client'

import dynamic from 'next/dynamic'

const NenmatsuUpload = dynamic(() => import('@/components/nenmatsu/NenmatsuUpload'), {
  ssr: false,
  loading: () => (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <p className="text-gray-500">読み込み中...</p>
    </div>
  ),
})

export default function NenmatsuUploadPage() {
  return <NenmatsuUpload />
}
