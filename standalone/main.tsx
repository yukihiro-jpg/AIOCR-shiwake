import React from 'react'
import { createRoot } from 'react-dom/client'
// /api/... をクライアント処理へ振り替える（アプリ本体の import より前に有効化）
import { installApiShim, installSettingsButton } from './shim/api-shim'
// 既存アプリのスタイルをそのまま利用（Tailwind + 独自CSS）
import '@/app/globals.css'
// 既存のルート画面コンポーネントをそのまま再利用（使用感を変えないため）
import BankStatementContent from '@/components/bank-statement/BankStatementContent'

installApiShim()

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BankStatementContent />
  </React.StrictMode>,
)

installSettingsButton()
