'use client'

import { useEffect, useMemo, useState } from 'react'
import { loadCompanyPublic, type NenmatsuCompany, type NenmatsuEmployee } from '@/lib/nenmatsu/store'
import { normalizeBirth } from '@/lib/nenmatsu/jdl-csv'
import { NENMATSU_DOC_TYPES } from '@/lib/nenmatsu/document-types'

type Phase = 'loading' | 'error' | 'verify' | 'docs'

export default function NenmatsuUpload() {
  const [phase, setPhase] = useState<Phase>('loading')
  const [errMsg, setErrMsg] = useState('')
  const [company, setCompany] = useState<NenmatsuCompany | null>(null)
  const [employees, setEmployees] = useState<NenmatsuEmployee[]>([])
  const [empId, setEmpId] = useState('')
  const [by, setBy] = useState('')
  const [bm, setBm] = useState('')
  const [bd, setBd] = useState('')
  const [verifyErr, setVerifyErr] = useState('')
  const [me, setMe] = useState<NenmatsuEmployee | null>(null)

  useEffect(() => {
    ;(async () => {
      try {
        const q = new URLSearchParams(window.location.search)
        const rk = q.get('rk') || ''
        const y = q.get('y') || ''
        const c = q.get('c') || ''
        const t = q.get('t') || ''
        if (!rk || !y || !c || !t) {
          setErrMsg('URLが正しくありません。配布されたQRコード／リンクから開いてください。')
          setPhase('error')
          return
        }
        const res = await loadCompanyPublic(rk, y, c, t)
        if (!res) {
          setErrMsg('このリンクは無効か期限切れです。事務所へお問い合わせください。')
          setPhase('error')
          return
        }
        setCompany(res.company)
        setEmployees(res.employees)
        setPhase('verify')
      } catch {
        setErrMsg('読み込みに失敗しました。通信環境をご確認のうえ、再度お試しください。')
        setPhase('error')
      }
    })()
  }, [])

  const sortedEmployees = useMemo(
    () =>
      [...employees].sort((a, b) =>
        (a.kanaLast + a.kanaFirst).localeCompare(b.kanaLast + b.kanaFirst, 'ja'),
      ),
    [employees],
  )

  const years = useMemo(() => {
    const now = new Date().getFullYear()
    const arr: number[] = []
    for (let y = now - 15; y >= now - 90; y--) arr.push(y)
    return arr
  }, [])

  function verify() {
    setVerifyErr('')
    const emp = employees.find((e) => e.id === empId)
    if (!emp) {
      setVerifyErr('お名前を選択してください。')
      return
    }
    if (!by || !bm || !bd) {
      setVerifyErr('生年月日を選択してください。')
      return
    }
    const input = `${by}-${String(Number(bm)).padStart(2, '0')}-${String(Number(bd)).padStart(2, '0')}`
    const stored = emp.birth || normalizeBirth(emp.birthRaw)
    if (stored && stored !== input) {
      setVerifyErr('生年月日が一致しません。もう一度ご確認ください。')
      return
    }
    setMe(emp)
    setPhase('docs')
  }

  if (phase === 'loading') {
    return <Center>読み込み中...</Center>
  }
  if (phase === 'error') {
    return (
      <Center>
        <div className="text-center">
          <div className="text-3xl mb-2">⚠️</div>
          <p className="text-gray-700">{errMsg}</p>
        </div>
      </Center>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-blue-600 text-white px-4 py-3">
        <div className="max-w-md mx-auto">
          <div className="text-xs opacity-80">年末調整 書類アップロード</div>
          <div className="font-bold">{company?.name}</div>
        </div>
      </header>

      <div className="max-w-md mx-auto p-4">
        {phase === 'verify' && (
          <div className="bg-white rounded-2xl border border-gray-200 p-5">
            <h1 className="font-bold text-gray-800 mb-1">ご本人の確認</h1>
            <p className="text-xs text-gray-500 mb-4">お名前と生年月日で確認します。</p>

            <label className="block text-sm font-medium text-gray-700 mb-1">お名前</label>
            <select
              value={empId}
              onChange={(e) => setEmpId(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded mb-4"
            >
              <option value="">選択してください</option>
              {sortedEmployees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.lastName} {e.firstName}
                </option>
              ))}
            </select>

            <label className="block text-sm font-medium text-gray-700 mb-1">生年月日</label>
            <div className="flex gap-2 mb-2">
              <select value={by} onChange={(e) => setBy(e.target.value)} className="flex-1 px-2 py-2 border border-gray-300 rounded">
                <option value="">年</option>
                {years.map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
              <select value={bm} onChange={(e) => setBm(e.target.value)} className="w-20 px-2 py-2 border border-gray-300 rounded">
                <option value="">月</option>
                {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <select value={bd} onChange={(e) => setBd(e.target.value)} className="w-20 px-2 py-2 border border-gray-300 rounded">
                <option value="">日</option>
                {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </div>

            {verifyErr && <div className="text-sm text-red-600 mb-2">{verifyErr}</div>}

            <button
              onClick={verify}
              className="w-full py-3 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 mt-2"
            >
              次へ
            </button>
          </div>
        )}

        {phase === 'docs' && me && (
          <div className="bg-white rounded-2xl border border-gray-200 p-5">
            <h1 className="font-bold text-gray-800 mb-1">
              {me.lastName} {me.firstName} 様
            </h1>
            <p className="text-xs text-gray-500 mb-4">
              下記の書類を撮影して提出します（該当するものだけでOK）。
            </p>
            <ul className="space-y-2">
              {NENMATSU_DOC_TYPES.map((d) => (
                <li
                  key={d.key}
                  className="flex items-center justify-between border border-gray-200 rounded-lg px-3 py-2.5"
                >
                  <span className="text-sm text-gray-700">
                    {d.name}
                    {d.note && <span className="text-[11px] text-gray-400 ml-1">（{d.note}）</span>}
                  </span>
                  <span className="text-[11px] text-gray-400">未撮影</span>
                </li>
              ))}
            </ul>
            <div className="mt-4 text-sm bg-amber-50 border border-amber-200 text-amber-800 rounded px-3 py-2">
              撮影・送信機能は現在準備中です（次回の更新で、その場で撮影して送信できるようになります）。
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function Center({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-6 text-gray-500">
      {children}
    </div>
  )
}
