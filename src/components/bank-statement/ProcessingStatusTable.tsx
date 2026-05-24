'use client'

import { useEffect, useState, useCallback } from 'react'
import { getProcessingStatuses, saveProcessingStatuses, type ProcessingStatus } from '@/lib/bank-statement/processing-status-store'
import { getClients, updateClient, type Client } from '@/lib/bank-statement/client-store'
import type { AccountItem } from '@/lib/bank-statement/types'

interface Props {
  clientId: string | null
  refreshKey?: number
  accountMaster: AccountItem[]
}

const DOC_TYPES = ['通帳', '当座照合表', 'ゆうちょ受払', '現金出納帳', 'ｸﾚｼﾞｯﾄ', '賃金台帳', 'その他']
const RECEIVE_METHODS = ['', '紙コピー', 'PDF', 'CSV']

export default function ProcessingStatusTable({ clientId, refreshKey, accountMaster }: Props) {
  const [statuses, setStatuses] = useState<ProcessingStatus[]>([])
  const [client, setClient] = useState<Client | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showFiscalDialog, setShowFiscalDialog] = useState(false)
  const [fiscalMonth, setFiscalMonth] = useState(3)
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [showMailPreview, setShowMailPreview] = useState(false)
  const [mailCopied, setMailCopied] = useState(false)
  const [manualEditMode, setManualEditMode] = useState(false)
  // 表示する会計年度のオフセット（0=今日基準の当期, -1=前期, +1=翌期）
  const [fiscalYearOffset, setFiscalYearOffset] = useState<number | null>(null)

  useEffect(() => {
    setStatuses(getProcessingStatuses())
    if (clientId) {
      const c = getClients().find((cl) => cl.id === clientId) || null
      setClient(c)
      if (c) setFiscalMonth(c.fiscalYearEndMonth || 3)
    }
  }, [clientId, refreshKey])

  const endMonth = client?.fiscalYearEndMonth || 3
  const months: string[] = []
  for (let i = 1; i <= 12; i++) {
    const m = ((endMonth) % 12) + i
    months.push(String(m > 12 ? m - 12 : m))
  }

  const saveFiscalMonth = useCallback(() => {
    if (!clientId) return
    updateClient(clientId, { fiscalYearEndMonth: fiscalMonth })
    setClient((prev: Client | null) => prev ? { ...prev, fiscalYearEndMonth: fiscalMonth } : prev)
    setShowFiscalDialog(false)
  }, [clientId, fiscalMonth])

  const handleDetailChange = useCallback((code: string, field: string, value: string) => {
    setStatuses((prev: ProcessingStatus[]) => {
      const updated = prev.map((s: ProcessingStatus) => s.accountCode === code ? { ...s, [field]: value } : s)
      saveProcessingStatuses(updated)
      return updated
    })
  }, [])

  const handleAddAccount = useCallback((code: string) => {
    const acc = accountMaster.find((a) => a.code === code)
    if (!acc) return
    const existing = getProcessingStatuses()
    if (existing.some((s) => s.accountCode === code)) {
      alert('この科目は既に登録されています')
      return
    }
    existing.push({
      accountCode: code,
      accountName: acc.shortName || acc.name,
      lastDate: '', lastUpdated: '',
      monthlyProgress: {},
    })
    saveProcessingStatuses(existing)
    setStatuses(existing)
    setShowAddDialog(false)
  }, [accountMaster])

  const handleDeleteRow = useCallback((code: string) => {
    if (!confirm(`科目CD ${code} を進捗管理表から削除しますか？`)) return
    const updated = getProcessingStatuses().filter((s) => s.accountCode !== code)
    saveProcessingStatuses(updated)
    setStatuses(updated)
  }, [])

  const sorted = [...statuses].sort((a, b) => a.accountCode.localeCompare(b.accountCode))

  const now = new Date()
  const currentMonth = now.getMonth() + 1
  const currentYear = now.getFullYear()
  // 今日基準の期首年
  const autoFiscalStartYear = currentMonth > endMonth ? currentYear : currentYear - 1

  // monthlyProgress に登録されているデータのうち、最新の年月が属する期首年を求める
  const dataLatestStartYear = (() => {
    let latest = ''
    for (const s of statuses) {
      for (const ym of Object.keys(s.monthlyProgress || {})) {
        if (s.monthlyProgress?.[ym] && ym > latest) latest = ym
      }
    }
    if (!latest) return null
    const [y, m] = latest.split('-').map(Number)
    return m > endMonth ? y : y - 1
  })()

  // 初期表示の年度: データがあればその年度、なければ当期。ユーザーが切り替えたらそれを優先。
  const defaultOffset = dataLatestStartYear != null ? dataLatestStartYear - autoFiscalStartYear : 0
  const effectiveOffset = fiscalYearOffset != null ? fiscalYearOffset : defaultOffset
  const fiscalStartYear = autoFiscalStartYear + effectiveOffset

  function getYearMonth(monthStr: string): string {
    const m = parseInt(monthStr)
    const y = m > endMonth ? fiscalStartYear : fiscalStartYear + 1
    return `${y}-${String(m).padStart(2, '0')}`
  }

  // 未登録科目一覧（科目マスタにあるが進捗表にない）
  const registeredCodes = new Set(statuses.map((s) => s.accountCode))
  const unregistered = accountMaster.filter((a) => !registeredCodes.has(a.code))

  if (!client?.fiscalYearEndMonth && clientId) {
    return (
      <div className="mt-6 max-w-4xl mx-auto">
        <div className="bg-amber-50 border border-amber-300 rounded-lg p-4 text-center">
          <div className="text-sm font-bold text-amber-800 mb-2">決算月が設定されていません</div>
          <div className="text-xs text-amber-600 mb-3">進捗管理表を表示するには決算月を設定してください</div>
          <div className="flex items-center justify-center gap-2">
            <select value={fiscalMonth} onChange={(e) => setFiscalMonth(parseInt(e.target.value))}
              className="px-2 py-1 border rounded text-sm">
              {[1,2,3,4,5,6,7,8,9,10,11,12].map((m) => <option key={m} value={m}>{m}月決算</option>)}
            </select>
            <button onClick={saveFiscalMonth} className="px-3 py-1 bg-blue-600 text-white text-sm rounded hover:bg-blue-700">設定</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="mt-6 mx-auto" style={{ maxWidth: '95vw' }}>
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-bold text-gray-700 flex items-center gap-2">
          進捗管理表
          <span className="inline-flex items-center gap-1 ml-1">
            <button onClick={() => setFiscalYearOffset(effectiveOffset - 1)}
              title="前の期を表示"
              className="px-1.5 py-0.5 text-xs bg-gray-200 rounded hover:bg-gray-300">◀ 前期</button>
            <span className="text-xs text-gray-500 font-normal min-w-[150px] text-center">
              {fiscalStartYear + 1}年{endMonth}月期 / {months[0]}月〜{months[11]}月
            </span>
            <button onClick={() => setFiscalYearOffset(effectiveOffset + 1)}
              title="次の期を表示"
              className="px-1.5 py-0.5 text-xs bg-gray-200 rounded hover:bg-gray-300">次期 ▶</button>
            {effectiveOffset !== 0 && (
              <button onClick={() => setFiscalYearOffset(0)}
                title="今日を含む当期に戻す"
                className="px-1.5 py-0.5 text-xs bg-blue-100 text-blue-700 rounded hover:bg-blue-200">当期へ</button>
            )}
          </span>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setShowFiscalDialog(true)}
            className="px-2 py-1 text-xs bg-gray-200 rounded hover:bg-gray-300">決算月変更</button>
          <button onClick={() => setManualEditMode((v) => !v)}
            className={`px-2 py-1 text-xs rounded ${manualEditMode ? 'bg-amber-500 text-white' : 'bg-gray-200 hover:bg-gray-300'}`}>
            {manualEditMode ? '手入力モード ON' : '手入力モード'}
          </button>
          <button onClick={() => setShowAddDialog(true)}
            className="px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700">+ 科目追加</button>
        </div>
      </div>

      {showFiscalDialog && (
        <div className="mb-3 p-2 bg-gray-50 border rounded flex items-center gap-2">
          <select value={fiscalMonth} onChange={(e) => setFiscalMonth(parseInt(e.target.value))} className="px-2 py-1 border rounded text-sm">
            {[1,2,3,4,5,6,7,8,9,10,11,12].map((m) => <option key={m} value={m}>{m}月決算</option>)}
          </select>
          <button onClick={saveFiscalMonth} className="px-2 py-1 bg-blue-600 text-white text-xs rounded">保存</button>
          <button onClick={() => setShowFiscalDialog(false)} className="px-2 py-1 bg-gray-200 text-xs rounded">キャンセル</button>
        </div>
      )}

      {/* 科目追加ダイアログ */}
      {showAddDialog && (
        <div className="mb-3 p-3 bg-blue-50 border border-blue-200 rounded">
          <div className="text-xs font-bold text-blue-800 mb-2">科目マスタから追加</div>
          <div className="max-h-[200px] overflow-auto border rounded bg-white">
            {unregistered.length === 0 ? (
              <div className="px-3 py-4 text-center text-xs text-gray-400">全ての科目が登録済みです</div>
            ) : (
              <table className="w-full text-xs">
                <tbody>
                  {unregistered.map((a) => (
                    <tr key={a.code} className="border-b hover:bg-blue-50 cursor-pointer" onClick={() => handleAddAccount(a.code)}>
                      <td className="px-2 py-1 font-mono font-bold w-16">{a.code}</td>
                      <td className="px-2 py-1">{a.shortName || a.name}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <button onClick={() => setShowAddDialog(false)} className="mt-2 px-3 py-1 text-xs bg-gray-200 rounded hover:bg-gray-300">閉じる</button>
        </div>
      )}

      <div className="bg-white rounded-lg border border-gray-200 overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-gray-100 border-b border-gray-200">
            <tr>
              <th className="px-2 py-1.5 text-left font-medium w-14">科目CD</th>
              <th className="px-2 py-1.5 text-left font-medium w-20">科目名</th>
              <th className="px-2 py-1.5 text-left font-medium w-20">種別</th>
              <th className="px-2 py-1.5 text-left font-medium w-16">銀行名</th>
              <th className="px-2 py-1.5 text-left font-medium w-12">口座種類</th>
              <th className="px-2 py-1.5 text-left font-medium w-16">口座番号</th>
              <th className="px-2 py-1.5 text-left font-medium w-14">受取方法</th>
              {months.map((m) => (
                <th key={m} className="px-1 py-1.5 text-center font-medium w-12">{m}月</th>
              ))}
              <th className="px-2 py-1.5 text-center font-medium w-20">更新日時</th>
              <th className="px-1 py-1.5 w-5"></th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr><td colSpan={20} className="px-4 py-6 text-center text-gray-400">
                「+ 科目追加」ボタンで科目マスタから管理する科目を追加してください
              </td></tr>
            ) : sorted.map((s) => {
              const isEditing = editingId === s.accountCode
              return (
                <tr key={s.accountCode} className={`border-b border-gray-100 hover:bg-gray-50 ${isEditing ? 'bg-yellow-50' : ''}`}
                  onClick={() => setEditingId(isEditing ? null : s.accountCode)}>
                  <td className="px-2 py-1 font-bold">{s.accountCode}</td>
                  <td className="px-2 py-1">{s.accountName || '—'}</td>
                  <td className="px-2 py-1">
                    {isEditing ? (
                      <select value={s.docType || ''} onClick={(e) => e.stopPropagation()}
                        onChange={(e) => handleDetailChange(s.accountCode, 'docType', e.target.value)}
                        className="w-full px-1 py-0.5 border rounded text-xs">
                        <option value="">-</option>
                        {DOC_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                    ) : <span className="text-gray-500">{s.docType || '—'}</span>}
                  </td>
                  <td className="px-2 py-1">
                    {isEditing ? (
                      <input type="text" value={s.bankName || ''} onClick={(e) => e.stopPropagation()}
                        onChange={(e) => handleDetailChange(s.accountCode, 'bankName', e.target.value)}
                        className="w-full px-1 py-0.5 border rounded text-xs" />
                    ) : <span className="text-gray-500">{s.bankName || '—'}</span>}
                  </td>
                  <td className="px-2 py-1">
                    {isEditing ? (
                      <select value={s.accountType || ''} onClick={(e) => e.stopPropagation()}
                        onChange={(e) => handleDetailChange(s.accountCode, 'accountType', e.target.value)}
                        className="w-full px-1 py-0.5 border rounded text-xs">
                        <option value="">-</option>
                        <option value="普通">普通</option>
                        <option value="当座">当座</option>
                        <option value="定期">定期</option>
                        <option value="貯蓄">貯蓄</option>
                      </select>
                    ) : <span className="text-gray-500">{s.accountType || '—'}</span>}
                  </td>
                  <td className="px-2 py-1">
                    {isEditing ? (
                      <input type="text" value={s.accountNumber || ''} onClick={(e) => e.stopPropagation()}
                        onChange={(e) => handleDetailChange(s.accountCode, 'accountNumber', e.target.value)}
                        className="w-full px-1 py-0.5 border rounded text-xs font-mono" />
                    ) : <span className="text-gray-500 font-mono">{s.accountNumber || '—'}</span>}
                  </td>
                  <td className="px-2 py-1">
                    {isEditing ? (
                      <select value={s.receiveMethod || ''} onClick={(e) => e.stopPropagation()}
                        onChange={(e) => handleDetailChange(s.accountCode, 'receiveMethod', e.target.value)}
                        className="w-full px-1 py-0.5 border rounded text-xs">
                        {RECEIVE_METHODS.map((t) => <option key={t} value={t}>{t || '-'}</option>)}
                      </select>
                    ) : <span className="text-gray-500">{s.receiveMethod || '—'}</span>}
                  </td>
                  {months.map((m) => {
                    const ym = getYearMonth(m)
                    const day = s.monthlyProgress?.[ym]
                    const hasData = !!day
                    return (
                      <td key={m} className={`px-1 py-1 text-center ${hasData ? 'bg-blue-100 text-blue-800 font-bold' : 'text-gray-300'} ${manualEditMode ? 'cursor-pointer hover:bg-yellow-100' : ''}`}
                        onClick={manualEditMode ? (e) => {
                          e.stopPropagation()
                          const input = prompt(`${parseInt(m)}月の最終処理日（日のみ、例: 31）を入力\n空欄で削除`, day || '')
                          if (input === null) return
                          const updated = { ...s.monthlyProgress || {} }
                          if (input.trim()) {
                            updated[ym] = input.trim().padStart(2, '0')
                          } else {
                            delete updated[ym]
                          }
                          handleDetailChange(s.accountCode, 'monthlyProgress', JSON.stringify(updated))
                          // monthlyProgressはオブジェクトなので直接更新
                          setStatuses((prev) => prev.map((st) =>
                            st.accountCode === s.accountCode ? { ...st, monthlyProgress: updated, lastUpdated: new Date().toISOString() } : st
                          ))
                          saveProcessingStatuses(statuses.map((st) =>
                            st.accountCode === s.accountCode ? { ...st, monthlyProgress: updated, lastUpdated: new Date().toISOString() } : st
                          ))
                        } : undefined}>
                        {hasData ? `${parseInt(m)}/${day}` : manualEditMode ? '—' : ''}
                      </td>
                    )
                  })}
                  <td className="px-2 py-1 text-center text-gray-400">
                    {s.lastUpdated ? new Date(s.lastUpdated).toLocaleDateString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}
                  </td>
                  <td className="px-1 py-1">
                    {isEditing && (
                      <button onClick={(e) => { e.stopPropagation(); handleDeleteRow(s.accountCode) }}
                        className="text-red-400 hover:text-red-600 text-sm" title="削除">×</button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-1 flex items-center justify-between">
        <span className="text-xs text-gray-400">行をクリックして編集</span>
        {sorted.length > 0 && (
          <button onClick={() => { setShowMailPreview(true); setMailCopied(false) }}
            className="px-3 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700">
            📧 資料依頼メール作成
          </button>
        )}
      </div>

      {/* メールプレビュー */}
      {showMailPreview && (() => {
        // 各科目の次に必要な期間を計算（最後に登録されている「年月＋日」の翌日から）
        const items = sorted.map((s) => {
          const progress = s.monthlyProgress || {}
          const allYm = Object.keys(progress).filter((k) => progress[k]).sort()
          const lastYm = allYm.length > 0 ? allYm[allYm.length - 1] : null
          let nextPeriod = ''
          if (lastYm) {
            const [y, m] = lastYm.split('-').map(Number)
            // 登録されている日（"15" 等の文字列、または日付）から数値部分を抽出
            const rawDay = String(progress[lastYm] || '').trim()
            const dayMatch = rawDay.match(/(\d{1,2})/)
            const lastDay = dayMatch ? parseInt(dayMatch[1]) : 0
            const daysInMonth = new Date(y, m, 0).getDate()
            let nextY = y, nextM = m, nextD = lastDay + 1
            if (nextD > daysInMonth) {
              // 月末を超えるので翌月 1 日に繰り上げ
              nextD = 1
              if (nextM === 12) { nextM = 1; nextY = y + 1 } else { nextM += 1 }
            }
            if (lastDay > 0) {
              nextPeriod = `${nextY}年${nextM}月${nextD}日分〜`
            } else {
              // 日付未指定の場合は翌月開始（従来動作）
              const fallbackM = m === 12 ? 1 : m + 1
              const fallbackY = m === 12 ? y + 1 : y
              nextPeriod = `${fallbackY}年${fallbackM}月分〜`
            }
          } else {
            nextPeriod = `${months[0]}月分〜`
          }
          // 資料名を種別に応じて生成
          let name = ''
          const dt = s.docType || ''
          if (dt === 'ｸﾚｼﾞｯﾄ') {
            name = [s.bankName, 'クレジット利用明細書'].filter(Boolean).join(' ')
          } else if (dt === '通帳' || dt === '当座照合表') {
            const parts = [s.bankName, s.accountType, s.accountNumber].filter(Boolean)
            name = parts.length > 0 ? `${parts.join(' ')} ${dt === '当座照合表' ? '照合表' : '通帳'}` : `${s.accountName} ${dt}`
          } else if (dt === '賃金台帳') {
            name = '賃金台帳（給与明細一覧表）'
          } else if (dt === '現金出納帳') {
            name = '現金出納帳'
          } else {
            name = s.accountName || dt || '資料'
          }
          return { name, nextPeriod, method: s.receiveMethod || '', docType: dt }
        }).filter((i) => i.nextPeriod)

        // 受取方法でグループ化
        const groups: Record<string, typeof items> = {}
        for (const item of items) {
          const key = item.method || 'その他'
          if (!groups[key]) groups[key] = []
          groups[key].push(item)
        }
        const groupOrder = ['紙コピー', 'PDF', 'CSV', 'その他']
        const groupLabels: Record<string, string> = {
          '紙コピー': 'コピーをお願いしたい資料',
          'PDF': 'PDFでお送りいただきたい資料',
          'CSV': 'データ（CSV）でお送りいただきたい資料',
          'その他': 'ご準備いただきたい資料',
        }

        const clientName = client?.name || '顧問先'

        const htmlContent = `
<p>${clientName} 御中</p>
<p>お世話になっております。<br>下記の資料について、ご準備をお願いいたします。</p>
${groupOrder.filter((g) => groups[g]?.length).map((g) => `
<p><strong>■ ${groupLabels[g]}</strong></p>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:14px;border-color:#ccc;">
<tr style="background:#f0f0f0;"><th style="text-align:left;">資料名</th><th style="text-align:left;">必要な期間</th></tr>
${groups[g].map((i) => `<tr><td>${i.name}</td><td>${i.nextPeriod}最新分</td></tr>`).join('')}
</table>`).join('')}
<p>お手数をおかけしますが、ご対応のほどよろしくお願いいたします。</p>`

        const textContent = `${clientName} 御中\n\nお世話になっております。\n下記の資料について、ご準備をお願いいたします。\n\n${groupOrder.filter((g) => groups[g]?.length).map((g) => `■ ${groupLabels[g]}\n${groups[g].map((i) => `  ・${i.name}：${i.nextPeriod}最新分`).join('\n')}`).join('\n\n')}\n\nお手数をおかけしますが、ご対応のほどよろしくお願いいたします。`

        const copyHtml = async () => {
          try {
            const blob = new Blob([htmlContent], { type: 'text/html' })
            const textBlob = new Blob([textContent], { type: 'text/plain' })
            await navigator.clipboard.write([
              new ClipboardItem({ 'text/html': blob, 'text/plain': textBlob }),
            ])
            setMailCopied(true)
            setTimeout(() => setMailCopied(false), 3000)
          } catch {
            await navigator.clipboard.writeText(textContent)
            setMailCopied(true)
            setTimeout(() => setMailCopied(false), 3000)
          }
        }

        return (
          <div className="mt-3 border rounded-lg overflow-hidden">
            <div className="px-4 py-2 bg-green-50 border-b flex items-center justify-between">
              <span className="text-sm font-bold text-green-800">資料依頼メール プレビュー</span>
              <div className="flex gap-2">
                <button onClick={copyHtml}
                  className={`px-3 py-1 text-xs rounded ${mailCopied ? 'bg-green-700 text-white' : 'bg-green-600 text-white hover:bg-green-700'}`}>
                  {mailCopied ? '✓ コピーしました' : 'メール本文をコピー'}
                </button>
                <button onClick={() => setShowMailPreview(false)}
                  className="px-2 py-1 text-xs bg-gray-200 rounded hover:bg-gray-300">閉じる</button>
              </div>
            </div>
            <div className="px-6 py-4 bg-white text-sm" dangerouslySetInnerHTML={{ __html: htmlContent }} />
          </div>
        )
      })()}
    </div>
  )
}
