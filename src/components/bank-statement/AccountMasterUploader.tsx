'use client'

import { useRef, useState } from 'react'
import type { AccountItem, SubAccountItem, AccountTaxItem } from '@/lib/bank-statement/types'
import {
  parseAccountMasterFile,
  parseSubAccountMasterFile,
  parseAccountTaxMasterFile,
  saveAccountMaster,
  saveSubAccountMaster,
  saveAccountTaxMaster,
} from '@/lib/bank-statement/account-master'

// Shift-JIS / UTF-8 自動判定で読み込む
async function readFileWithEncoding(file: File): Promise<string> {
  // まずShift-JISで読む（JDLファイルは通常Shift-JIS）
  try {
    const buffer = await file.arrayBuffer()
    const sjisText = new TextDecoder('shift-jis').decode(buffer)
    // 文字化け判定: 置換文字(U+FFFD)が多ければUTF-8で再読み込み
    const replacementCount = (sjisText.match(/\ufffd/g) || []).length
    if (replacementCount < 3) return sjisText
  } catch { /* fallback */ }
  // UTF-8で読む
  return file.text()
}

interface Props {
  accountMaster: AccountItem[]
  subAccountMaster: SubAccountItem[]
  accountTaxMaster: AccountTaxItem[]
  onAccountUpdate: (items: AccountItem[]) => void
  onSubAccountUpdate: (items: SubAccountItem[]) => void
  onAccountTaxUpdate: (items: AccountTaxItem[]) => void
  /** メニュー（白背景）内に埋め込むとき true。トリガーボタンを濃い文字色にする */
  embedded?: boolean
}

export default function AccountMasterUploader({
  accountMaster,
  subAccountMaster,
  accountTaxMaster,
  onAccountUpdate,
  onSubAccountUpdate,
  onAccountTaxUpdate,
  embedded = false,
}: Props) {
  const accountInputRef = useRef<HTMLInputElement>(null)
  const subAccountInputRef = useRef<HTMLInputElement>(null)
  const accountTaxInputRef = useRef<HTMLInputElement>(null)
  const restoreInputRef = useRef<HTMLInputElement>(null)
  const [showPanel, setShowPanel] = useState(false)

  const handleAccountFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const text = await readFileWithEncoding(file)
    const items = parseAccountMasterFile(text)
    if (items.length === 0) {
      alert('科目データを読み取れませんでした。\nタブ区切りまたはCSV形式のファイルを選択してください。')
      return
    }
    saveAccountMaster(items)
    onAccountUpdate(items)
    alert(`勘定科目 ${items.length}件を登録しました`)
    e.target.value = ''
  }

  const handleSubAccountFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const text = await readFileWithEncoding(file)
    const items = parseSubAccountMasterFile(text)
    if (items.length === 0) {
      alert('補助科目データを読み取れませんでした。\nタブ区切りまたはCSV形式のファイルを選択してください。')
      return
    }
    saveSubAccountMaster(items)
    onSubAccountUpdate(items)
    alert(`補助科目 ${items.length}件を登録しました`)
    e.target.value = ''
  }

  const totalSub = subAccountMaster.length

  return (
    <div className="relative">
      <button
        onClick={() => setShowPanel(!showPanel)}
        className={embedded
          ? "w-full text-left px-3 py-2 text-sm font-medium text-gray-800 hover:bg-blue-50 rounded flex items-center gap-2"
          : "px-3 py-1.5 text-xs font-medium bg-white/10 hover:bg-white/20 text-white rounded border border-white/20"}
      >
        科目マスタ
        {accountMaster.length > 0 && (
          <span className={embedded ? "ml-1 text-gray-500" : "ml-1 text-white/70"}>({accountMaster.length})</span>
        )}
      </button>

      <input ref={accountInputRef} type="file" accept=".csv,.tsv,.txt" onChange={handleAccountFile} className="hidden" />
      <input ref={subAccountInputRef} type="file" accept=".csv,.tsv,.txt" onChange={handleSubAccountFile} className="hidden" />
      <input ref={accountTaxInputRef} type="file" accept=".csv,.tsv,.txt,.xlsx,.xls" onChange={async (e) => {
        const file = e.target.files?.[0]; if (!file) return
        const text = await readFileWithEncoding(file)
        const items = parseAccountTaxMasterFile(text)
        if (items.length === 0) { alert('科目別消費税データを読み取れませんでした'); return }
        saveAccountTaxMaster(items); onAccountTaxUpdate(items)
        alert(`科目別消費税 ${items.length}件を登録しました`)
        e.target.value = ''
      }} className="hidden" />
      <input ref={restoreInputRef} type="file" accept=".json" onChange={async (e) => {
        const file = e.target.files?.[0]; if (!file) return
        try {
          const text = await file.text()
          const data = JSON.parse(text)
          if (data.accounts) { saveAccountMaster(data.accounts); onAccountUpdate(data.accounts) }
          if (data.subAccounts) { saveSubAccountMaster(data.subAccounts); onSubAccountUpdate(data.subAccounts) }
          alert(`復元しました: 科目${(data.accounts || []).length}件, 補助${(data.subAccounts || []).length}件`)
        } catch { alert('JSONファイルの読み込みに失敗しました') }
        e.target.value = ''
      }} className="hidden" />

      {showPanel && (
        <div className="absolute right-0 top-full mt-2 w-80 bg-white border border-gray-200 rounded-lg shadow-xl z-50">
          <div className="p-4 space-y-3">
            <h3 className="text-sm font-bold text-gray-800">マスタ登録</h3>

            {/* 勘定科目 */}
            <div className="p-3 bg-gray-50 rounded-lg">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-gray-700">勘定科目</span>
                <span className="text-xs text-gray-500">{accountMaster.length}件</span>
              </div>
              <button
                onClick={() => accountInputRef.current?.click()}
                className="w-full py-2 text-xs bg-white border border-gray-300 rounded hover:bg-gray-50 text-gray-700"
              >
                科目チェックリストを読込
              </button>
            </div>

            {/* 補助科目 */}
            <div className="p-3 bg-gray-50 rounded-lg">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-gray-700">補助科目</span>
                <span className="text-xs text-gray-500">{totalSub}件</span>
              </div>
              <button
                onClick={() => subAccountInputRef.current?.click()}
                className="w-full py-2 text-xs bg-white border border-gray-300 rounded hover:bg-gray-50 text-gray-700"
              >
                補助科目チェックリストを読込
              </button>
            </div>

            {/* 科目別消費税 */}
            <div className="p-3 bg-gray-50 rounded-lg">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-gray-700">科目別消費税</span>
                <span className="text-xs text-gray-500">{accountTaxMaster.length}件</span>
              </div>
              <button
                onClick={() => accountTaxInputRef.current?.click()}
                className="w-full py-2 text-xs bg-white border border-gray-300 rounded hover:bg-gray-50 text-gray-700"
              >
                科目別消費税登録チェックリストを読込
              </button>
            </div>

            <p className="text-xs text-gray-400">
              TSV（タブ区切り）/ CSV / Shift-JIS対応
            </p>

            {/* 保存・復元 */}
            {(accountMaster.length > 0 || totalSub > 0) && (
              <div className="space-y-1">
                <button onClick={() => {
                  const data = JSON.stringify({ accounts: accountMaster, subAccounts: subAccountMaster }, null, 2)
                  const blob = new Blob([data], { type: 'application/json' })
                  const a = document.createElement('a'); a.href = URL.createObjectURL(blob)
                  a.download = `科目マスタ_${new Date().toISOString().slice(0,10)}.json`
                  a.click()
                }}
                  className="w-full py-2 text-xs text-blue-600 border border-blue-200 rounded hover:bg-blue-50">
                  マスタを保存（JSON）
                </button>
                <button onClick={() => {
                  if (confirm('登録済みの科目マスタ・補助科目マスタをすべて削除しますか？')) {
                    saveAccountMaster([]); saveSubAccountMaster([]); saveAccountTaxMaster([])
                    onAccountUpdate([]); onSubAccountUpdate([]); onAccountTaxUpdate([])
                  }
                }}
                  className="w-full py-2 text-xs text-red-600 border border-red-200 rounded hover:bg-red-50">
                  マスタをリセット
                </button>
              </div>
            )}

            {/* マスタ復元 */}
            <button onClick={() => restoreInputRef.current?.click()}
              className="w-full py-2 text-xs text-gray-600 border border-gray-200 rounded hover:bg-gray-50">
              保存済みマスタを復元（JSON）
            </button>
          </div>

          {/* 登録済み科目プレビュー */}
          {accountMaster.length > 0 && (
            <div className="border-t border-gray-100 max-h-48 overflow-auto">
              {accountMaster.slice(0, 30).map((item, i) => (
                <div key={i} className="px-4 py-1 text-xs flex gap-2 hover:bg-gray-50">
                  <span className="text-gray-400 w-10 shrink-0">{item.code}</span>
                  <span className="text-gray-700 truncate">{item.shortName || item.name}</span>
                </div>
              ))}
              {accountMaster.length > 30 && (
                <div className="px-4 py-1 text-xs text-gray-400 text-center">
                  他 {accountMaster.length - 30}件
                </div>
              )}
            </div>
          )}

          <div className="p-2 border-t border-gray-100">
            <button
              onClick={() => setShowPanel(false)}
              className="w-full text-xs text-gray-500 hover:text-gray-700 py-1"
            >
              閉じる
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
