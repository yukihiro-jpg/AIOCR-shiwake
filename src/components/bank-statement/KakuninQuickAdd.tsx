'use client'
import { useState, useRef, useEffect } from 'react'
import { addKakuninItem, type KakuninKind } from '@/lib/bank-statement/kakunin'

// 会計入力中に、選択中の顧問先へ「確認・依頼メモ」を1件追加するクイック入力。
// 保存先は顧問先情報（確認・依頼タブ）と共有。
export default function KakuninQuickAdd({ clientId, clientName }: { clientId: string; clientName: string }) {
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<KakuninKind>('確認')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])
  const submit = async () => {
    if (!text.trim()) return
    setBusy(true); setMsg('')
    try {
      await addKakuninItem(clientId, kind, text)
      setText(''); setMsg('追加しました')
      setTimeout(() => { setMsg(''); setOpen(false) }, 1100)
    } catch (e) {
      setMsg(e instanceof Error ? e.message : '追加に失敗しました')
    } finally { setBusy(false) }
  }
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)} title="この顧問先への確認・依頼をメモ（顧問先情報の「確認・依頼」に集約）"
        className="fusion-link text-xs whitespace-nowrap">📝 確認メモ</button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-80 bg-white border border-gray-200 rounded-xl shadow-xl z-40 p-3">
          <div className="text-xs font-bold text-gray-700 mb-1">{clientName}｜確認・依頼メモ</div>
          <div className="text-[11px] text-gray-400 mb-2">顧問先情報の「確認・依頼」に集約され、まとめてメール文にできます。</div>
          <div className="flex gap-1.5 mb-2">
            {(['確認', '質問', '資料'] as KakuninKind[]).map((k) => (
              <button key={k} onClick={() => setKind(k)}
                className={`px-2 py-1 rounded text-xs ${kind === k ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600'}`}>{k === '資料' ? '資料請求' : k}</button>
            ))}
          </div>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3}
            placeholder="例）5月の売上に計上漏れがないか確認／通帳コピーを請求"
            className="w-full px-2 py-1.5 border border-gray-300 rounded text-xs mb-2" />
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-green-600">{msg}</span>
            <button onClick={submit} disabled={busy || !text.trim()}
              className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded font-medium hover:bg-blue-700 disabled:opacity-40">追加</button>
          </div>
        </div>
      )}
    </div>
  )
}
