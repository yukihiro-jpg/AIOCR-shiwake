import type { Metadata, Viewport } from 'next'
import './globals.css'
import ScanAutoAnalyzerMount from '@/core/ui/ScanAutoAnalyzerMount'

export const metadata: Metadata = {
  title: '総合管理アプリ',
  description: 'AI-OCRで通帳・レシート・請求書から会計大将向け仕訳CSVを生成',
  icons: {
    // タブのアイコン（favicon）を 🌈 の絵文字に。SVGデータURIなので追加ファイル不要
    icon: "data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text x=%2250%22 y=%2250%22 dy=%22.35em%22 font-size=%2272%22 text-anchor=%22middle%22>🌈</text></svg>",
  },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="ja">
      <body className="bg-gray-50 min-h-screen">
        {/* 書類スキャンの自動AI解析（全ページ常駐・公開ページでは動かない） */}
        <ScanAutoAnalyzerMount />
        {children}
      </body>
    </html>
  )
}
