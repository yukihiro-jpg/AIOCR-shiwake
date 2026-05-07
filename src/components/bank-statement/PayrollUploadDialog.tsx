'use client'
import { useState, useMemo, useEffect } from 'react'
import type { PayrollData, AccountItem, SubAccountItem } from '@/lib/bank-statement/types'

// 賃金台帳の学習データ（localStorage）
interface PayrollSettings {
  executiveNames: string[]
  itemAccounts: Record<string, { code: string; name: string; subCode?: string; subName?: string }>
  bankCode: string
  bankName: string
  bankSubCode: string
  bankSubName: string
}

function getPayrollSettingsKey(): string {
  const cid = typeof window !== 'undefined' ? localStorage.getItem('bank-statement-selected-client') || '' : ''
  return `bs-payroll-settings-${cid}`
}

function loadPayrollSettings(): PayrollSettings | null {
  try {
    const raw = localStorage.getItem(getPayrollSettingsKey())
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

function savePayrollSettings(settings: PayrollSettings): void {
  try { localStorage.setItem(getPayrollSettingsKey(), JSON.stringify(settings)) } catch {}
}

interface Props {
  open: boolean
  onClose: () => void
  accountMaster: AccountItem[]
  subAccountMaster: SubAccountItem[]
  onGenerate: (data: PayrollData, bankCode: string, bankName: string, deductionAccounts: Record<string, { code: string; name: string; subCode?: string; subName?: string }>, bankSubCode?: string, bankSubName?: string) => void
}

export default function PayrollUploadDialog({ open, onClose, accountMaster, subAccountMaster, onGenerate }: Props) {
  const [mode, setMode] = useState<'file' | 'paste'>('paste')
  const [pasteText, setPasteText] = useState('')
  const [parsed, setParsed] = useState<PayrollData | null>(null)
  const [error, setError] = useState('')
  const [bankCode, setBankCode] = useState('')
  const [bankName, setBankName] = useState('')
  const [bankSubCode, setBankSubCode] = useState('')
  const [bankSubName, setBankSubName] = useState('')
  const [accounts, setAccounts] = useState<Record<string, { code: string; name: string; subCode?: string; subName?: string }>>({})

  // 学習データの読み込み
  useEffect(() => {
    const saved = loadPayrollSettings()
    if (saved) {
      setAccounts(saved.itemAccounts || {})
      setBankCode(saved.bankCode || '')
      setBankName(saved.bankName || '')
      setBankSubCode(saved.bankSubCode || '')
      setBankSubName(saved.bankSubName || '')
    }
  }, [])

  // 解析後に役員フラグを学習データから復元
  useEffect(() => {
    if (!parsed) return
    const saved = loadPayrollSettings()
    if (saved?.executiveNames?.length) {
      const names = new Set(saved.executiveNames)
      const updated = parsed.employees.map((e) => ({ ...e, isExecutive: names.has(e.name) }))
      if (updated.some((e, i) => e.isExecutive !== parsed.employees[i].isExecutive)) {
        setParsed({ ...parsed, employees: updated })
      }
    }
  }, [parsed?.employeeCount])

  // 役員報酬・給与手当は「課税分合計」で計算（支給合計額＝非課税額＋課税分合計）
  const getTaxable = (emp: { items: { name: string; amount: number }[] }) =>
    emp.items.find((i) => i.name === '課税分合計')?.amount || 0
  const executiveTotal = parsed ? parsed.employees.filter((e) => e.isExecutive).reduce((s, e) => s + getTaxable(e), 0) : 0
  const employeeTotal = parsed ? parsed.employees.filter((e) => !e.isExecutive).reduce((s, e) => s + getTaxable(e), 0) : 0

  const itemTotals = useMemo(() => {
    if (!parsed) return new Map<string, number>()
    const m = new Map<string, number>()
    const allHeaders = [...parsed.payHeaders, ...parsed.deductHeaders]
    for (const h of allHeaders) {
      let total = 0
      for (const emp of parsed.employees) {
        const item = emp.items.find((i) => i.name === h)
        if (item) total += item.amount
      }
      m.set(h, total)
    }
    return m
  }, [parsed])

  const totalNetPay = parsed ? parsed.employees.reduce((s, e) => s + e.netPay, 0) : 0
  const bankSubs = bankCode ? subAccountMaster.filter((s) => s.parentCode === bankCode) : []

  if (!open) return null

  const handleParse = async (text?: string) => {
    setError('')
    try {
      const { parsePayrollText } = await import('@/lib/bank-statement/payroll-parser')
      const data = parsePayrollText(text || pasteText)
      if (data.employees.length === 0) throw new Error('従業員データが見つかりません')
      setParsed(data)
    } catch (e) { setError(e instanceof Error ? e.message : '解析に失敗しました') }
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
    } catch (e) { setError(e instanceof Error ? e.message : '解析に失敗しました') }
  }

  const toggleExecutive = (idx: number) => {
    if (!parsed) return
    setParsed({ ...parsed, employees: parsed.employees.map((emp, i) => i === idx ? { ...emp, isExecutive: !emp.isExecutive } : emp) })
  }

  const setAccountCode = (itemName: string, code: string) => {
    const acc = accountMaster.find((a) => a.code === code)
    setAccounts((prev) => ({ ...prev, [itemName]: { ...prev[itemName], code, name: acc ? (acc.shortName || acc.name) : '' } }))
  }

  const setSubAccount = (itemName: string, subCode: string, subName: string) => {
    setAccounts((prev) => ({ ...prev, [itemName]: { ...prev[itemName], subCode, subName } }))
  }

  const renderAccountInput = (name: string) => {
    const acc = accounts[name]
    const subs = acc?.code ? subAccountMaster.filter((s) => s.parentCode === acc.code) : []
    return (
      <div className="flex items-center gap-1 mt-1">
        <input type="text" value={acc?.code || ''} onChange={(e) => setAccountCode(name, e.target.value)}
          placeholder="科目CD" className="w-16 px-1.5 py-1 text-xs border rounded font-mono" />
        <span className="text-xs text-gray-500 min-w-[40px]">{acc?.name || ''}</span>
        {subs.length > 0 && (
          <select value={acc?.subCode || ''} onChange={(e) => {
            const sub = subs.find((s) => s.subCode === e.target.value)
            setSubAccount(name, e.target.value, sub?.shortName || sub?.name || '')
          }} className="px-1 py-1 text-xs border rounded max-w-[100px]">
            <option value="">補助科目</option>
            {subs.map((s) => <option key={s.subCode} value={s.subCode}>{s.shortName || s.name}</option>)}
          </select>
        )}
      </div>
    )
  }

  const handleGenerate = () => {
    if (!parsed || !bankCode) return
    const allAccounts = { ...accounts }
    // 学習データを保存
    savePayrollSettings({
      executiveNames: parsed.employees.filter((e) => e.isExecutive).map((e) => e.name),
      itemAccounts: allAccounts,
      bankCode, bankName, bankSubCode, bankSubName,
    })
    onGenerate(parsed, bankCode, bankName, allAccounts, bankSubCode || undefined, bankSubName || undefined)
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-[95vw] max-w-[1200px] max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-3 border-b bg-gray-50">
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
                <div className="text-xs text-gray-600">Excelの給与明細一覧表をコピーして貼り付けてください</div>
                <textarea value={pasteText} onChange={(e) => setPasteText(e.target.value)}
                  placeholder="Excelからコピーしたデータを貼り付け（タブ区切り）"
                  className="w-full h-48 p-3 text-xs font-mono border rounded resize-none" />
                <button onClick={() => handleParse()} disabled={!pasteText.trim()}
                  className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-40">解析</button>
              </>
            ) : (
              <input type="file" accept=".xlsx,.xls,.csv" onChange={handleFileUpload} className="block w-full text-sm border rounded p-2" />
            )}
            {error && <div className="text-sm text-red-600 bg-red-50 p-2 rounded">{error}</div>}
          </div>
        ) : (
          <div className="px-6 py-4 space-y-5">
            {/* メタ情報 */}
            <div className="flex gap-6 text-sm">
              <span><b>期間:</b> {parsed.period}</span>
              <span><b>支給日:</b> {parsed.paymentDate}</span>
              <span><b>会社:</b> {parsed.companyName}</span>
              <span><b>人数:</b> {parsed.employees.length}名</span>
            </div>

            {/* 従業員一覧 */}
            <div>
              <div className="text-sm font-bold mb-1">従業員一覧（役員にチェック）</div>
              <div className="border rounded max-h-[180px] overflow-auto">
                <table className="w-full text-xs">
                  <thead className="bg-gray-100 sticky top-0">
                    <tr><th className="px-2 py-1 w-10">役員</th><th className="px-2 py-1 w-8">NO</th><th className="px-2 py-1 text-left">氏名</th><th className="px-2 py-1 text-right">支給合計</th><th className="px-2 py-1 text-right">控除合計</th><th className="px-2 py-1 text-right">差引支給額</th></tr>
                  </thead>
                  <tbody>
                    {parsed.employees.map((emp, idx) => (
                      <tr key={idx} className={`border-t ${emp.isExecutive ? 'bg-amber-50' : ''}`}>
                        <td className="px-2 py-0.5 text-center"><input type="checkbox" checked={emp.isExecutive} onChange={() => toggleExecutive(idx)} /></td>
                        <td className="px-2 py-0.5 text-center">{emp.no}</td>
                        <td className="px-2 py-0.5">{emp.name}</td>
                        <td className="px-2 py-0.5 text-right">{emp.totalPay.toLocaleString()}</td>
                        <td className="px-2 py-0.5 text-right">{emp.totalDeductions.toLocaleString()}</td>
                        <td className="px-2 py-0.5 text-right">{emp.netPay.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-1 text-xs text-gray-600">
                役員報酬: ¥{executiveTotal.toLocaleString()} / 給与手当: ¥{employeeTotal.toLocaleString()}
              </div>
            </div>

            {/* 賃金台帳項目の勘定科目設定 */}
            <div>
              <div className="text-sm font-bold mb-3">賃金台帳項目の勘定科目設定</div>

              {/* 支給項目 */}
              <div className="mb-4 p-3 bg-green-50 rounded-lg border border-green-200">
                <div className="text-sm font-bold text-green-800 mb-2">支給項目</div>
                <div className="flex flex-wrap gap-x-4 gap-y-3">
                  {parsed.payHeaders.map((h) => {
                    const total = itemTotals.get(h) || 0
                    if (total === 0 && !['支給合計額', '非課税額', '課税分合計'].includes(h)) return null
                    return (
                      <div key={h}>
                        <div className="text-xs font-bold">{h}</div>
                        <div className="text-xs text-gray-500">¥{total.toLocaleString()}</div>
                        {renderAccountInput(h)}
                      </div>
                    )
                  })}
                  {/* 課税分合計の内訳: 役員報酬・給与手当 */}
                  <div className="border-l-2 border-green-400 pl-3">
                    <div className="text-xs font-bold text-amber-700">役員報酬</div>
                    <div className="text-xs text-gray-500">¥{executiveTotal.toLocaleString()}</div>
                    {renderAccountInput('役員報酬')}
                  </div>
                  <div>
                    <div className="text-xs font-bold text-blue-700">給与手当</div>
                    <div className="text-xs text-gray-500">¥{employeeTotal.toLocaleString()}</div>
                    {renderAccountInput('給与手当')}
                  </div>
                </div>
              </div>

              {/* 控除項目 */}
              <div className="mb-4 p-3 bg-red-50 rounded-lg border border-red-200">
                <div className="text-sm font-bold text-red-800 mb-2">控除項目</div>
                <div className="flex flex-wrap gap-x-4 gap-y-3">
                  {parsed.deductHeaders.map((h) => {
                    const total = itemTotals.get(h) || 0
                    if (total === 0 && h !== '控除合計額') return null
                    return (
                      <div key={h}>
                        <div className="text-xs font-bold">{h}</div>
                        <div className="text-xs text-gray-500">¥{total.toLocaleString()}</div>
                        {renderAccountInput(h)}
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>

            {/* 引落口座 */}
            <div className="p-3 bg-gray-50 rounded-lg border">
              <div className="text-sm font-bold mb-2">引落口座（差引支給額の貸方）</div>
              <div className="flex items-center gap-3">
                <input type="text" value={bankCode}
                  onChange={(e) => {
                    setBankCode(e.target.value)
                    const a = accountMaster.find((x) => x.code === e.target.value)
                    setBankName(a?.shortName || a?.name || '')
                    setBankSubCode(''); setBankSubName('')
                  }}
                  placeholder="科目CD" className="w-20 px-2 py-1.5 border rounded font-mono text-sm" />
                <span className="text-sm">{bankName}</span>
                {bankSubs.length > 0 && (
                  <select value={bankSubCode} onChange={(e) => {
                    setBankSubCode(e.target.value)
                    const sub = bankSubs.find((s) => s.subCode === e.target.value)
                    setBankSubName(sub?.shortName || sub?.name || '')
                  }} className="px-2 py-1.5 text-sm border rounded">
                    <option value="">補助科目を選択</option>
                    {bankSubs.map((s) => <option key={s.subCode} value={s.subCode}>{s.shortName || s.name}</option>)}
                  </select>
                )}
                {bankSubName && <span className="text-sm text-gray-500">{bankSubName}</span>}
                <div className="ml-auto text-sm font-bold text-blue-700">
                  差引支給額合計: ¥{totalNetPay.toLocaleString()}
                </div>
              </div>
            </div>

            {error && <div className="text-sm text-red-600 bg-red-50 p-2 rounded">{error}</div>}

            <div className="flex gap-2 justify-end">
              <button onClick={() => setParsed(null)} className="px-4 py-2 text-sm bg-gray-200 rounded hover:bg-gray-300">戻る</button>
              <button onClick={handleGenerate} disabled={!bankCode}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-40">仕訳作成</button>
            </div>
          </div>
        )}

        <div className="px-6 py-2 border-t flex justify-end">
          <button onClick={onClose} className="px-4 py-2 text-sm bg-gray-200 rounded hover:bg-gray-300">閉じる</button>
        </div>
      </div>
    </div>
  )
}
