import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: '年末調整 - 控除証明書の回収',
  description: '従業員の控除証明書をスマホ撮影で回収・管理します',
}

export default function NenmatsuLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
