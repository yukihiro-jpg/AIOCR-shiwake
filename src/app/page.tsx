'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

// 静的書き出しではサーバー側 redirect() が使えないため、クライアント側で遷移する。
// useRouter は basePath を自動で付与する。
export default function Home() {
  const router = useRouter()
  useEffect(() => {
    router.replace('/bank-statement')
  }, [router])
  return null
}
