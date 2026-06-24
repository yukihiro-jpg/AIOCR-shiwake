import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: '年末調整 書類アップロード',
  description: '控除証明書等を撮影して提出します',
}

export default function NenmatsuUploadLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
