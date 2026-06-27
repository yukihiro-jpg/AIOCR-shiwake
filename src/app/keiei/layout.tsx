import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: '総合管理アプリ',
  description: '月次推移BS/PLから経営の数字をグラフで可視化します',
}

export default function KeieiLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
