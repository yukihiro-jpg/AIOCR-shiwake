'use client'

import dynamic from 'next/dynamic'

// ルート(/) は総合アプリのランチャー（ホーム）。クライアント専用で描画する。
const Launcher = dynamic(() => import('@/components/Launcher'), {
  ssr: false,
  loading: () => (
    <div className="h-screen flex items-center justify-center bg-gray-50">
      <p className="text-gray-500">読み込み中...</p>
    </div>
  ),
})

export default function Home() {
  return <Launcher />
}
