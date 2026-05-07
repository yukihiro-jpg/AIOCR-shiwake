'use client'

import { useRef, useState } from 'react'
import type { AccountItem, SubAccountItem, UploadConfig, DocumentType } from '@/lib/bank-statement/types'

interface Props {
  accountMaster: AccountItem[]
  subAccountMaster: SubAccountItem[]
  onUpload: (config: UploadConfig) => void
  isLoading: boolean
  lastPeriodFrom?: string
  lastPeriodTo?: string
}

const DOC_TYPES: { value: DocumentType; label: string; desc: string; icon: string }[] = [
  { value: 'bank-statement', label: '通帳', desc: 'PDF / Excel', icon: '🏦' },
  { value: 'cash-book', label: '現金出納帳', desc: 'PDF / Excel', icon: '📒' },
  { value: 'credit-card', label: 'クレジットカード', desc: 'CSV / Excel', icon: '💳' },
  { value: 'sales-invoice', label: '売上請求書', desc: 'PDF / Excel', icon: '📄' },
  { value: 'purchase-invoice', label: '仕入請求書', desc: 'PDF / Excel', icon: '📑' },
  { value: 'receipt', label: 'レシート・領収書', desc: 'PDF', icon: '🧾' },
  { value: 'payroll', label: '賃金台帳', desc: '貼り付け / Excel', icon: '👥' },
]

export default function UploadDialog({ accountMaster, subAccountMaster, onUpload, isLoading, lastPeriodFrom, lastPeriodTo }: Props) {
  const [isOpen, setIsOpen] = useState(false)
  const [docType, setDocType] = useState<DocumentType>('bank-statement')
  const [accountCode, setAccountCode] = useState('')
  const [accountName, setAccountName] = useState('')
  const [accountSubCode, setAccountSubCode] = useState('')
  const [accountSubName, setAccountSubName] = useState('')
  const [debitCode, setDebitCode] = useState('')
  const [debitName, setDebitName] = useState('')
  const [debitSubCode, setDebitSubCode] = useState('')
  const [debitSubName, setDebitSubName] = useState('')
  const [creditCode, setCreditCode] = useState('')
  const [creditName, setCreditName] = useState('')
  const [creditSubCode, setCreditSubCode] = useState('')
  const [creditSubName, setCreditSubName] = useState('')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [isDragOver, setIsDragOver] = useState(false)
  const [periodFrom, setPeriodFrom] = useState('')
  const [periodTo, setPeriodTo] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleAccountSelect = (code: string, setter: (c: string) => void, nameSetter: (n: string) => void) => {
    setter(code)
    const item = accountMaster.find((a) => a.code === code)
    if (item) nameSetter(item.shortName || item.name)
  }

  const allFiles = selectedFiles.length > 0 ? selectedFiles : selectedFile ? [selectedFile] : []

  const handleSubmit = () => {
    if (isPayroll) {
      // 賃金台帳: ファイル不要、ダイアログを開くためにダミーconfig送信
      onUpload({
        documentType: 'payroll',
        accountCode: creditCode || '', accountName: creditName || '',
        creditCode: creditCode || '', creditName: creditName || '',
        creditSubCode: creditSubCode || undefined, creditSubName: creditSubName || undefined,
        file: new File([], 'payroll'),
      })
      setIsOpen(false)
      return
    }
    if (allFiles.length === 0) return
    const period = { periodFrom: periodFrom || undefined, periodTo: periodTo || undefined }
    // 複数ファイルを順番にアップロード（呼び出し元で追記処理）
    for (const file of allFiles) {
      if (docType === 'bank-statement' || docType === 'cash-book') {
        if (!accountCode || !accountName) return
        onUpload({ documentType: docType, accountCode, accountName, accountSubCode: accountSubCode || undefined, accountSubName: accountSubName || undefined, file, ...period })
      } else if (docType === 'receipt') {
        if (!creditCode || !creditName) return
        onUpload({
          documentType: docType,
          accountCode: creditCode, accountName: creditName,
          creditCode, creditName, creditSubCode: creditSubCode || undefined, creditSubName: creditSubName || undefined,
          file, ...period,
        })
      } else if (docType === 'credit-card') {
        if (!creditCode || !creditName) return
        onUpload({
          documentType: docType,
          accountCode: '', accountName: '',
          creditCode, creditName, creditSubCode: creditSubCode || undefined, creditSubName: creditSubName || undefined,
          file, ...period,
        })
      } else {
        if (!debitCode || !creditCode) return
        onUpload({
          documentType: docType,
          accountCode: '', accountName: '',
          debitCode, debitName, debitSubCode: debitSubCode || undefined, debitSubName: debitSubName || undefined,
          creditCode, creditName, creditSubCode: creditSubCode || undefined, creditSubName: creditSubName || undefined,
          file, ...period,
        })
      }
    }
    setIsOpen(false)
    setSelectedFile(null)
    setSelectedFiles([])
  }

  const isBankLike = docType === 'bank-statement' || docType === 'cash-book'
  const isInvoice = docType === 'sales-invoice' || docType === 'purchase-invoice'
  const isReceipt = docType === 'receipt'
  const isCreditCard = docType === 'credit-card'
  const isPayroll = docType === 'payroll'
  const canSubmit = !isLoading && (
    isPayroll ? true  // 賃金台帳はファイル不要（貼り付けダイアログが開く）
      : allFiles.length > 0 && (
        isBankLike ? !!(accountCode && accountName)
          : isCreditCard ? !!(creditCode && creditName)
            : isReceipt ? !!(creditCode && creditName)
              : !!(debitCode && creditCode)
      )
  )

  const acceptFiles = isCreditCard ? '.pdf,.csv,.xlsx,.xls' : isReceipt ? '.pdf,.xlsx,.xls' : isInvoice ? '.pdf,.xlsx,.xls,.csv' : '.pdf,.xlsx,.xls,.csv'

  const renderAccountSelector = (
    label: string, code: string, onCodeChange: (c: string) => void, name: string, onNameChange: (n: string) => void,
    filterKeywords?: string[],
    subCode?: string, onSubCodeChange?: (c: string) => void, subName?: string, onSubNameChange?: (n: string) => void,
  ) => {
    const subs = code ? subAccountMaster.filter((s) => s.parentCode === code) : []
    return (
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
        {accountMaster.length > 0 ? (
          <div className="space-y-1">
            <select value={code}
              onChange={(e) => {
                handleAccountSelect(e.target.value, onCodeChange, onNameChange)
                if (onSubCodeChange) { onSubCodeChange(''); onSubNameChange?.('') }
              }}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="">-- 科目を選択 --</option>
              {filterKeywords && (
                <optgroup label="候補">
                  {accountMaster.filter((a) => filterKeywords.some((k) => a.name.includes(k) || a.shortName.includes(k)))
                    .map((item) => (
                      <option key={item.code} value={item.code}>{item.code} - {item.shortName || item.name}</option>
                    ))}
                </optgroup>
              )}
              <optgroup label="全科目">
                {accountMaster.map((item) => (
                  <option key={`all-${item.code}`} value={item.code}>{item.code} - {item.shortName || item.name}</option>
                ))}
              </optgroup>
            </select>
            {subs.length > 0 && onSubCodeChange && (
              <select value={subCode || ''}
                onChange={(e) => {
                  const sub = subs.find((s) => s.subCode === e.target.value)
                  onSubCodeChange(e.target.value)
                  onSubNameChange?.(sub?.shortName || sub?.name || '')
                }}
                className="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-xs text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-400 bg-gray-50">
                <option value="">-- 補助科目（任意）--</option>
                {subs.map((s) => (
                  <option key={s.subCode} value={s.subCode}>{s.subCode} - {s.shortName || s.name}</option>
                ))}
              </select>
            )}
          </div>
        ) : (
          <div className="flex gap-2">
            <input type="text" value={code} onChange={(e) => onCodeChange(e.target.value)}
              placeholder="コード" className="w-20 px-2 py-2 border border-gray-300 rounded-lg text-sm" />
            <input type="text" value={name} onChange={(e) => onNameChange(e.target.value)}
              placeholder="科目名" className="flex-1 px-2 py-2 border border-gray-300 rounded-lg text-sm" />
          </div>
        )}
      </div>
    )
  }

  return (
    <>
      <button onClick={() => setIsOpen(true)}
        className="px-3 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white rounded">
        アップロード
      </button>

      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md">
            <div className="p-5 border-b border-gray-200">
              <h2 className="text-lg font-bold text-gray-800">ファイルのアップロード</h2>
            </div>

            <div className="p-5 space-y-4">
              {/* 書類種別 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">書類の種類</label>
                <div className="grid grid-cols-4 gap-1.5">
                  {DOC_TYPES.map((dt) => (
                    <button key={dt.value}
                      onClick={() => setDocType(dt.value)}
                      className={`py-2 px-1 text-center rounded-lg transition-colors ${
                        docType === dt.value
                          ? 'bg-blue-600 text-white ring-2 ring-blue-300'
                          : 'bg-gray-50 text-gray-700 hover:bg-gray-100 border border-gray-200'
                      }`}>
                      <div className="text-lg leading-none">{dt.icon}</div>
                      <div className="text-xs font-bold mt-0.5">{dt.label}</div>
                      <div className={`text-[10px] mt-0.5 ${docType === dt.value ? 'text-blue-200' : 'text-gray-400'}`}>{dt.desc}</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* 賃金台帳は貼り付けダイアログを直接開く */}
              {isPayroll && (
                <div className="p-4 bg-blue-50 rounded-lg border border-blue-200 text-center">
                  <div className="text-sm text-blue-800 mb-2">Excelの給与明細一覧表をコピーして貼り付け、またはファイルをアップロードできます</div>
                  <div className="text-xs text-blue-600">「解析開始」を押すと賃金台帳ダイアログが開きます</div>
                </div>
              )}

              {/* ファイル選択（クリック or ドラッグ&ドロップ）- 賃金台帳以外 */}
              {!isPayroll && <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  ファイル ({isCreditCard ? 'PDF' : isInvoice ? 'PDF/Excel/CSV' : 'PDF/Excel/CSV'})
                </label>
                <div
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setIsDragOver(true) }}
                  onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); setIsDragOver(true) }}
                  onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); setIsDragOver(false) }}
                  onDrop={(e) => {
                    e.preventDefault(); e.stopPropagation()
                    setIsDragOver(false)
                    const files = Array.from(e.dataTransfer.files)
                    if (files.length === 0) return
                    const accepted = acceptFiles.split(',').map((s) => s.trim().toLowerCase())
                    const validFiles = files.filter((f) => accepted.some((ext) => f.name.toLowerCase().endsWith(ext)))
                    const rejected = files.length - validFiles.length
                    if (rejected > 0) alert(`${rejected}件のファイルは非対応の形式のためスキップしました。\n対応: ${acceptFiles}`)
                    if (validFiles.length === 0) return
                    if (validFiles.length === 1) { setSelectedFile(validFiles[0]); setSelectedFiles([]) }
                    else { setSelectedFiles(validFiles); setSelectedFile(null) }
                  }}
                  className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors ${
                    isDragOver
                      ? 'border-blue-500 bg-blue-100'
                      : 'border-gray-300 hover:border-blue-400 hover:bg-blue-50'
                  }`}>
                  {allFiles.length > 1 ? (
                    <div>
                      <p className="text-sm font-medium text-gray-800">{allFiles.length}件のファイルを選択中</p>
                      <div className="text-xs text-gray-500 mt-1 max-h-20 overflow-auto">
                        {allFiles.map((f, i) => <div key={i}>{f.name} ({(f.size / 1024).toFixed(1)} KB)</div>)}
                      </div>
                      <p className="text-xs text-gray-400 mt-2">クリックまたはドラッグして変更</p>
                    </div>
                  ) : selectedFile ? (
                    <div>
                      <p className="text-sm font-medium text-gray-800">{selectedFile.name}</p>
                      <p className="text-xs text-gray-500 mt-1">{(selectedFile.size / 1024).toFixed(1)} KB</p>
                      <p className="text-xs text-gray-400 mt-2">クリックまたはドラッグして変更</p>
                    </div>
                  ) : (
                    <div>
                      <p className="text-sm text-gray-600 font-medium">
                        {isDragOver ? 'ここにドロップ' : 'クリックしてファイルを選択'}
                      </p>
                      <p className="text-xs text-gray-400 mt-1">またはファイルをここにドラッグ&ドロップ</p>
                    </div>
                  )}
                </div>
                <input ref={fileInputRef} type="file" accept={acceptFiles} multiple
                  onChange={(e) => {
                    const files = e.target.files ? Array.from(e.target.files) : []
                    if (files.length === 1) { setSelectedFile(files[0]); setSelectedFiles([]) }
                    else if (files.length > 1) { setSelectedFiles(files); setSelectedFile(null) }
                  }}
                  className="hidden" />
              </div>}

              {/* 処理対象期間 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">処理対象期間</label>
                <div className="flex items-center gap-2">
                  <input type="date" value={periodFrom} onChange={(e) => setPeriodFrom(e.target.value)}
                    className="flex-1 px-2 py-2 border border-gray-300 rounded-lg text-sm" />
                  <span className="text-sm text-gray-500">〜</span>
                  <input type="date" value={periodTo} onChange={(e) => setPeriodTo(e.target.value)}
                    className="flex-1 px-2 py-2 border border-gray-300 rounded-lg text-sm" />
                </div>
                {lastPeriodFrom && lastPeriodTo && (
                  <button onClick={() => { setPeriodFrom(lastPeriodFrom); setPeriodTo(lastPeriodTo) }}
                    className="mt-1 text-xs text-blue-600 hover:underline">
                    前回の期間をセット（{lastPeriodFrom} 〜 {lastPeriodTo}）
                  </button>
                )}
              </div>

              {/* 科目選択 */}
              {isBankLike ? (
                renderAccountSelector(
                  docType === 'cash-book' ? '現金の勘定科目' : '通帳の勘定科目',
                  accountCode, setAccountCode, accountName, setAccountName,
                  docType === 'cash-book' ? ['現金'] : ['預金', '当座', '普通', '定期'],
                  accountSubCode, setAccountSubCode, accountSubName, setAccountSubName,
                )
              ) : isCreditCard ? (
                <>
                  {renderAccountSelector(
                    'クレジットカードの勘定科目（貸方に設定されます）',
                    creditCode, setCreditCode, creditName, setCreditName,
                    ['未払', 'クレジ', 'カード'],
                    creditSubCode, setCreditSubCode, creditSubName, setCreditSubName,
                  )}
                  <p className="text-xs text-gray-500 mt-1">
                    各取引の貸方に {creditName || '—'}({creditCode || '—'}) {creditSubName ? `[${creditSubName}]` : ''} が設定されます。
                  </p>
                </>
              ) : isReceipt ? (
                <>
                  {renderAccountSelector(
                    '支払原資の勘定科目（貸方に設定されます）',
                    creditCode, setCreditCode, creditName, setCreditName,
                    ['現金', '預金', '普通'],
                    creditSubCode, setCreditSubCode, creditSubName, setCreditSubName,
                  )}
                </>
              ) : isPayroll ? (
                <>
                  {renderAccountSelector(
                    '支払手段の科目（未払費用・普通預金等）',
                    creditCode, setCreditCode, creditName, setCreditName,
                    ['未払', '預金', '当座', '普通'],
                    creditSubCode, setCreditSubCode, creditSubName, setCreditSubName,
                  )}
                  <p className="text-xs text-gray-500 mt-1">
                    差引支給額の貸方科目として使用します。借方科目（給与手当・役員報酬等）は解析後に設定します。
                  </p>
                </>
              ) : (
                <>
                  {renderAccountSelector(
                    docType === 'sales-invoice' ? '借方科目（売掛金等）' : '借方科目（仕入・経費等）',
                    debitCode, setDebitCode, debitName, setDebitName,
                    docType === 'sales-invoice' ? ['売掛', '未収'] : ['仕入', '経費', '消耗', '通信', '水道'],
                    debitSubCode, setDebitSubCode, debitSubName, setDebitSubName,
                  )}
                  {renderAccountSelector(
                    docType === 'sales-invoice' ? '貸方科目（売上等）' : '貸方科目（買掛金等）',
                    creditCode, setCreditCode, creditName, setCreditName,
                    docType === 'sales-invoice' ? ['売上', '収入'] : ['買掛', '未払'],
                    creditSubCode, setCreditSubCode, creditSubName, setCreditSubName,
                  )}
                </>
              )}
            </div>

            <div className="p-4 border-t border-gray-200 flex gap-2">
              <button onClick={() => { setIsOpen(false); setSelectedFile(null) }}
                className="flex-1 py-2 bg-gray-100 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-200">
                キャンセル
              </button>
              <button onClick={handleSubmit} disabled={!canSubmit}
                className={`flex-1 py-2 text-sm font-medium rounded-lg ${
                  canSubmit ? 'bg-blue-600 text-white hover:bg-blue-700' : 'bg-gray-200 text-gray-400 cursor-not-allowed'
                }`}>
                {isLoading ? '解析中...' : allFiles.length > 1 ? `${allFiles.length}件アップロード` : 'アップロード'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
