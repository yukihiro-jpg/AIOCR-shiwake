'use client'

// 書類スキャンの自動AI解析エンジンを全ページで常駐させる（表示なし）。
// 顧問先・従業員向けの公開ページ（合言葉を持たない端末）では hasRoom() が false のため何もしない。

import { useEffect } from 'react'
import { usePathname } from 'next/navigation'
import { startScanAutoAnalyzer } from '@/lib/scan/auto-analyzer'

export default function ScanAutoAnalyzerMount() {
  const pathname = usePathname()
  useEffect(() => {
    // 公開アップロードページでは起動しない（事務所端末で開いた場合も不要なため）
    if (pathname?.includes('scan-upload') || pathname?.includes('nenmatsu-upload')) return
    startScanAutoAnalyzer()
  }, [pathname])
  return null
}
