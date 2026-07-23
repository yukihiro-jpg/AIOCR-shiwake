'use client'
// キクチ・エステート専用: ガス料金・家賃集計表Excel → 仕訳作成ダイアログ
import { useState, useEffect } from 'react'
import type { AccountItem, SubAccountItem, JournalEntry } from '@/lib/bank-statement/types'
import type { KikuchiParseResult } from '@/lib/bank-statement/kikuchi-gas-rent-parser'

interface Props {
  open: boolean
  onClose: () => void
  accountMaster: AccountItem[]
  subAccountMaster: SubAccountItem[]
  onGenerateEntries: (entries: JournalEntry[], info: string) => void
}

export default function KikuchiGasRentDialog({ open, onClose, accountMaster, subAccountMaster, onGenerateEntries }: Props) {
  const [result, setResult] = useState<KikuchiParseResult | null>(null)
  const [fileName, setFileName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [dragOver, setDragOver] = useState(false)

  useEffect(() => {
    if (open) { setResult(null); setFileName(''); setError('') }
  }, [open])

  if (!open) return null

  const processFile = async (file: File) => {
    setError(''); setResult(null); setBusy(true); setFileName(file.name)
    try {
      const lower = file.name.toLowerCase()
      if (!(lower.endsWith('.xlsx') || lower.endsWith('.xls') || lower.endsWith('.ods'))) {
        throw new Error('Excelファイル（.xlsx / .xls / .ods）を選択してください')
      }
      const { parseKikuchiGasRentFile } = await import('@/lib/bank-statement/kikuchi-gas-rent-parser')
      const r = await parseKikuchiGasRentFile(file, accountMaster, subAccountMaster)
      if (!r.entries.length) throw new Error('仕訳対象のデータが見つかりませんでした。' + (r.warnings[0] || ''))
      setResult(r)
    } catch (e) {
      setError(e instanceof Error ? e.message : '解析に失敗しました')
    } finally { setBusy(false) }
  }

  const handleGenerate = () => {
    if (!result) return
    onGenerateEntries(result.entries, `ガス・家賃集計表（${result.periods.join('・') || fileName}）から${result.entries.length}件の仕訳を作成しました`)
    onClose()
  }

  const totalAll = result ? result.summary.reduce((s, x) => s + x.total, 0) : 0

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bg-white rounded-lg shadow-xl w-[95vw] max-w-[760px] max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-3 border-b bg-gray-50">
          <h2 className="text-lg font-bold">ガス・家賃集計表 → 仕訳作成（キクチ・エステート専用）</h2>
        </div>

        <div className="px-6 py-4 space-y-4">
          {!result ? (
            <>
              <div className="text-xs text-gray-600 leading-relaxed">
                月次の「ガス料金・家賃 請求受領金額集計表」Excelを取り込み、<b>管轄が「1 法人」</b>の行だけを仕訳にします（AIは使いません）。<br />
                ガス代・保証金・灯油器具代（取引日=検針日）／家賃・礼金更新料・敷金・共益費・駐車料（取引日=請求年月の1日）。借方はすべて 162（補助1）。
              </div>
              <label
                onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
                onDragLeave={(e) => { e.preventDefault(); setDragOver(false) }}
                onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files?.[0]; if (f) processFile(f) }}
                className={`flex flex-col items-center justify-center gap-2 w-full py-10 px-4 border-2 border-dashed rounded-lg cursor-pointer transition-colors ${dragOver ? 'border-blue-500 bg-blue-50' : 'border-gray-300 bg-gray-50 hover:bg-gray-100'}`}>
                <div className="text-3xl">📥</div>
                <div className="text-sm text-gray-700 font-medium">ここに集計表Excelをドラッグ&ドロップ</div>
                <div className="text-xs text-gray-500">またはクリックして選択（.xlsx / .xls / .ods）</div>
                <input type="file" accept=".xlsx,.xls,.ods" onChange={(e) => { const f = e.target.files?.[0]; if (f) processFile(f) }} className="hidden" />
              </label>
              {busy && <div className="text-sm text-blue-700 bg-blue-50 p-2 rounded flex items-center gap-2"><span className="inline-block w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin"></span>解析しています…</div>}
              {error && <div className="text-sm text-red-600 bg-red-50 p-2 rounded">{error}</div>}
            </>
          ) : (
            <>
              <div className="flex gap-5 text-sm flex-wrap">
                <span><b>ファイル:</b> {fileName}</span>
                <span><b>対象月:</b> {result.periods.join('、') || '—'}</span>
                <span><b>仕訳件数:</b> {result.entries.length}件</span>
              </div>
              <table className="w-full text-xs border rounded">
                <thead className="bg-gray-100">
                  <tr><th className="px-2 py-1.5 text-left">区分</th><th className="px-2 py-1.5 text-right w-20">件数</th><th className="px-2 py-1.5 text-right w-32">金額合計</th></tr>
                </thead>
                <tbody>
                  {result.summary.map((s) => (
                    <tr key={s.label} className="border-t">
                      <td className="px-2 py-1">{s.label}</td>
                      <td className="px-2 py-1 text-right">{s.count}件</td>
                      <td className="px-2 py-1 text-right tabular-nums">¥{s.total.toLocaleString()}</td>
                    </tr>
                  ))}
                  <tr className="border-t bg-gray-50 font-bold">
                    <td className="px-2 py-1">合計</td>
                    <td className="px-2 py-1 text-right">{result.entries.length}件</td>
                    <td className="px-2 py-1 text-right tabular-nums">¥{totalAll.toLocaleString()}</td>
                  </tr>
                </tbody>
              </table>
              {result.warnings.length > 0 && (
                <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-2 space-y-0.5">
                  {result.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
                </div>
              )}
              <div className="text-[11px] text-gray-500">
                ※ 仕訳作成を押すと仕訳一覧に追加されます。内容は一覧で確認・修正できます。
              </div>
              <div className="flex gap-2 justify-end">
                <button onClick={() => { setResult(null); setFileName('') }} className="px-4 py-2 text-sm bg-gray-200 rounded hover:bg-gray-300">戻る</button>
                <button onClick={handleGenerate} className="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700">仕訳作成（{result.entries.length}件）</button>
              </div>
            </>
          )}
        </div>

        <div className="px-6 py-2 border-t flex justify-end">
          <button onClick={onClose} className="px-4 py-2 text-sm bg-gray-200 rounded hover:bg-gray-300">閉じる</button>
        </div>
      </div>
    </div>
  )
}
