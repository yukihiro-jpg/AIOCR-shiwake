'use client'

import dynamic from 'next/dynamic'

const ReviewContent = dynamic(() => import('@/components/souzoku-review/ReviewContent'), {
  ssr: false,
  loading: () => (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <p className="text-gray-500 text-sm">読み込み中...</p>
    </div>
  ),
})

export default function SouzokuReviewPage() {
  return <ReviewContent />
}
