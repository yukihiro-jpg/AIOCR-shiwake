'use client'
import { useState } from 'react'
import type { PayrollData, PayrollEmployee, AccountItem, SubAccountItem } from '@/lib/bank-statement/types'

interface Props {
  open: boolean
  onClose: () => void
  accountMaster: AccountItem[]
  subAccountMaster: SubAccountItem[]
  onGenerate: (data: PayrollData, bankCode: string, bankName: string, deductionAccounts: Record<string, { code: string; name: string; subCode?: string; subName?: string }>) => void
}

export default function PayrollUploadDialog({ open, onClose, accountMaster, subAccountMaster, onGenerate }: Props) {
  const [mode, setMode] = useState<'file' | 'paste'>('paste')
  const [pasteText, setPasteText] = useState('')
  const [parsed, setParsed] = useState<PayrollData | null>(null)
  const [error, setError] = useState('')
  const [bankCode, setBankCode] = useState('')
  const [bankName, setBankName] = useState('')
  const [deductAccounts, setDeductAccounts] = useState<Record<string, { code: string; name: string; subCode?: string; subName?: string }>>({})

  if (!open) return null

  const handleParse = async (text?: string) => {
    setError('')
    try {
      const { parsePayrollText } = await import('@/lib/bank-statement/payroll-parser')
      const data = parsePayrollText(text || pasteText)
      if (data.employees.length === 0) throw new Error('従業員データが見つかりません')
      setParsed(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : '解析に失敗しました')
    }
  }

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setError('')
    try {
      const { parsePayrollFile } = await import('@/lib/bank-statement/payroll-parser')
      const data = await parsePayrollFile(file)
      if (data.employees.length === 0) throw new Error('従業員データが見つかりません')
      setParsed(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : '解析に失敗しました')
    }
  }

  const toggleExecutive = (idx: number) => {
    if (!parsed) return
    const updated = { ...parsed, employees: parsed.employees.map((emp, i) => i === idx ? { ...emp, isExecutive: !emp.isExecutive } : emp) }
    setParsed(updated)
  }

  const setDeductAccount = (name: string, code: string) => {
    const acc = accountMaster.find((a) => a.code === code)
    setDeductAccounts((prev) => ({ ...prev, [name]: { code, name: acc?.shortName || acc?.name || name } }))
  }

  const handleGenerate = () => {
    if (!parsed || !bankCode) return
    onGenerate(parsed, bankCode, bankName, deductAccounts)
    onClose()
  }

  // 控除項目のユニーク名リスト
  const deductionNames = parsed ? parsed.deductHeaders.filter((h) => {
    const total = parsed.employees.reduce((s, e) => s + (e.items.find((i) => i.name === h)?.amount || 0), 0)
    return total > 0
  }) : []

  const executiveTotal = parsed ? parsed.employees.filter((e) => e.isExecutive).reduce((s, e) => s + e.totalPay, 0) : 0
  const employeeTotal = parsed ? parsed.employees.filter((e) => !e.isExecutive).reduce((s, e) => s + e.totalPay, 0) : 0

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-[900px] max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-4 border-b bg-gray-50">
          <h2 className="text-lg font-bold">賃金台帳 → 仕訳データ作成</h2>
        </div>

        {!parsed ? (
          <div className="px-6 py-4 space-y-4">
            <div className="flex gap-2">
              <button onClick={() => setMode('paste')} className={`px-3 py-1.5 text-sm rounded ${mode === 'paste' ? 'bg-blue-600 text-white' : 'bg-gray-200'}`}>テキスト貼り付け</button>
              <button onClick={() => setMode('file')} className={`px-3 py-1.5 text-sm rounded ${mode === 'file' ? 'bg-blue-600 text-white' : 'bg-gray-200'}`}>ファイル選択</button>
            </div>

            {mode === 'paste' ? (
              <>
                <div className="text-xs text-gray-600">Excelの給与明細一覧表をコピーして下のエリアに貼り付けてください</div>
                <textarea
                  value={pasteText}
                  onChange={(e) => setPasteText(e.target.value)}
                  placeholder="Excelからコピーしたデータを貼り付け（タブ区切り）"
                  className="w-full h-48 p-3 text-xs font-mono border rounded resize-none"
                />
                <button onClick={() => handleParse()} disabled={!pasteText.trim()}
                  className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-40">
                  解析
                </button>
              </>
            ) : (
              <>
                <input type="file" accept=".xlsx,.xls,.csv" onChange={handleFileUpload} className="block w-full text-sm border rounded p-2" />
              </>
            )}

            {error && <div className="text-sm text-red-600 bg-red-50 p-2 rounded">{error}</div>}
          </div>
        ) : (
          <div className="px-6 py-4 space-y-4">
            {/* メタ情報 */}
            <div className="flex gap-6 text-sm">
              <span><b>期間:</b> {parsed.period}</span>
              <span><b>支給日:</b> {parsed.paymentDate}</span>
              <span><b>会社:</b> {parsed.companyName}</span>
              <span><b>人数:</b> {parsed.employees.length}名</span>
            </div>

            {/* 従業員一覧 + 役員選択 */}
            <div>
              <div className="text-sm font-bold mb-1">従業員一覧（役員にチェック）</div>
              <div className="border rounded max-h-[200px] overflow-auto">
                <table className="w-full text-xs">
                  <thead className="bg-gray-100 sticky top-0">
                    <tr>
                      <th className="px-2 py-1 text-left w-10">役員</th>
                      <th className="px-2 py-1 text-left w-8">NO</th>
                      <th className="px-2 py-1 text-left">氏名</th>
                      <th className="px-2 py-1 text-right">支給合計</th>
                      <th className="px-2 py-1 text-right">控除合計</th>
                      <th className="px-2 py-1 text-right">差引支給額</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsed.employees.map((emp, idx) => (
                      <tr key={idx} className={`border-t ${emp.isExecutive ? 'bg-amber-50' : ''}`}>
                        <td className="px-2 py-1"><input type="checkbox" checked={emp.isExecutive} onChange={() => toggleExecutive(idx)} /></td>
                        <td className="px-2 py-1">{emp.no}</td>
                        <td className="px-2 py-1">{emp.name}</td>
                        <td className="px-2 py-1 text-right">{emp.totalPay.toLocaleString()}</td>
                        <td className="px-2 py-1 text-right">{emp.totalDeductions.toLocaleString()}</td>
                        <td className="px-2 py-1 text-right">{emp.netPay.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-1 text-xs text-gray-600">
                役員報酬: ¥{executiveTotal.toLocaleString()} / 給与手当: ¥{employeeTotal.toLocaleString()}
              </div>
            </div>

            {/* 控除項目の科目割当 */}
            <div>
              <div className="text-sm font-bold mb-1">控除項目の勘定科目設定</div>
              <div className="grid grid-cols-2 gap-2">
                {['役員報酬', '給与手当', ...deductionNames].map((name) => (
                  <div key={name} className="flex items-center gap-2 text-xs">
                    <span className="w-28 truncate" title={name}>{name}</span>
                    <input
                      type="text"
                      value={deductAccounts[name]?.code || ''}
                      onChange={(e) => setDeductAccount(name, e.target.value)}
                      placeholder="科目CD"
                      className="w-16 px-1 py-0.5 border rounded font-mono text-xs"
                    />
                    <span className="text-gray-500 truncate">{deductAccounts[name]?.name || ''}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* 引落口座 */}
            <div className="flex items-center gap-3">
              <span className="text-sm font-bold">引落口座（差引支給額の貸方）:</span>
              <input
                type="text"
                value={bankCode}
                onChange={(e) => {
                  setBankCode(e.target.value)
                  const acc = accountMaster.find((a) => a.code === e.target.value)
                  setBankName(acc?.shortName || acc?.name || '')
                }}
                placeholder="科目CD"
                className="w-16 px-2 py-1 border rounded font-mono text-sm"
              />
              <span className="text-sm text-gray-600">{bankName}</span>
            </div>

            {error && <div className="text-sm text-red-600 bg-red-50 p-2 rounded">{error}</div>}

            <div className="flex gap-2 justify-end">
              <button onClick={() => setParsed(null)} className="px-4 py-2 text-sm bg-gray-200 rounded hover:bg-gray-300">戻る</button>
              <button onClick={handleGenerate} disabled={!bankCode}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-40">
                仕訳作成
              </button>
            </div>
          </div>
        )}

        <div className="px-6 py-3 border-t flex justify-end">
          <button onClick={onClose} className="px-4 py-2 text-sm bg-gray-200 rounded hover:bg-gray-300">閉じる</button>
        </div>
      </div>
    </div>
  )
}
