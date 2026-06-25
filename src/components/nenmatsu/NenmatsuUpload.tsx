'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  loadCompanyPublic,
  submitDocsPublic,
  getSubmissionPublic,
  type NenmatsuCompany,
  type NenmatsuEmployee,
} from '@/lib/nenmatsu/store'
import { normalizeBirth } from '@/lib/nenmatsu/jdl-csv'
import { NENMATSU_DOC_TYPES } from '@/lib/nenmatsu/document-types'
import { compressImage } from '@/lib/nenmatsu/image-compress'

type Phase = 'loading' | 'error' | 'verify' | 'docs' | 'done'
interface Params {
  rk: string
  y: string
  c: string
}

export default function NenmatsuUpload() {
  const [phase, setPhase] = useState<Phase>('loading')
  const [errMsg, setErrMsg] = useState('')
  const [params, setParams] = useState<Params | null>(null)
  const [company, setCompany] = useState<NenmatsuCompany | null>(null)
  const [employees, setEmployees] = useState<NenmatsuEmployee[]>([])
  const [empId, setEmpId] = useState('')
  const [by, setBy] = useState('')
  const [bm, setBm] = useState('')
  const [bd, setBd] = useState('')
  const [verifyErr, setVerifyErr] = useState('')
  const [me, setMe] = useState<NenmatsuEmployee | null>(null)
  const [photos, setPhotos] = useState<Record<string, File[]>>({})
  const [submitting, setSubmitting] = useState(false)
  const [progress, setProgress] = useState('')
  const [submitErr, setSubmitErr] = useState('')

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
        setParams({ rk, y, c })
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
    // CSVに生年月日がある人は必ず照合
    if (stored && stored !== input) {
      setVerifyErr('生年月日が一致しません。もう一度ご確認ください。')
      return
    }
    setMe(emp)
    setPhase('docs')
  }

  function onCapture(docKey: string, list: FileList | null) {
    if (!list || !list.length) return
    // FileList は input の値クリアで空になるため、ここで即座に配列へコピーする
    const arr = Array.from(list)
    setPhotos((prev) => ({ ...prev, [docKey]: [...(prev[docKey] || []), ...arr] }))
  }
  function removePhoto(docKey: string, idx: number) {
    setPhotos((prev) => ({ ...prev, [docKey]: (prev[docKey] || []).filter((_, i) => i !== idx) }))
  }

  async function submit() {
    if (!params || !me) return
    const totalFiles = Object.values(photos).reduce((s, a) => s + a.length, 0)
    if (totalFiles === 0) {
      if (!confirm('撮影した書類がありません。「該当する書類なし」として提出しますか？')) return
    }
    // 二重提出チェック
    try {
      const existing = await getSubmissionPublic(params.rk, params.y, params.c, me.id)
      if (existing) {
        if (
          !confirm(
            `${me.lastName} ${me.firstName} さんは既に提出済みです（${new Date(
              existing.submittedAt,
            ).toLocaleString('ja-JP')}）。\n上書きして提出しますか？`,
          )
        )
          return
      }
    } catch {
      /* チェック失敗時はそのまま続行 */
    }

    setSubmitting(true)
    setSubmitErr('')
    setProgress('画像を準備しています...')
    try {
      const docs: Record<string, Blob[]> = {}
      let done = 0
      for (const key of Object.keys(photos)) {
        const files = photos[key]
        if (!files || !files.length) continue
        const blobs: Blob[] = []
        for (const f of files) {
          setProgress(`画像を圧縮中... (${++done}/${totalFiles})`)
          blobs.push(await compressImage(f))
        }
        docs[key] = blobs
      }
      setProgress('送信しています...')
      await submitDocsPublic(params.rk, params.y, params.c, me, docs)
      setPhase('done')
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      setSubmitErr('送信に失敗しました：' + m)
      alert('送信に失敗しました：' + m + '\nもう一度お試しください。')
    }
    setSubmitting(false)
    setProgress('')
  }

  if (phase === 'loading') return <Center>読み込み中...</Center>
  if (phase === 'error')
    return (
      <Center>
        <div className="text-center">
          <div className="text-3xl mb-2">⚠️</div>
          <p className="text-gray-700">{errMsg}</p>
        </div>
      </Center>
    )
  if (phase === 'done')
    return (
      <Center>
        <div className="text-center">
          <div className="text-4xl mb-3">✅</div>
          <p className="text-lg font-bold text-gray-800 mb-1">提出が完了しました</p>
          <p className="text-sm text-gray-500">ありがとうございました。この画面は閉じて構いません。</p>
        </div>
      </Center>
    )

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
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
            <p className="text-xs text-gray-500 mb-4">お名前と生年月日（必須）で確認します。</p>

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
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
              <select value={bm} onChange={(e) => setBm(e.target.value)} className="w-20 px-2 py-2 border border-gray-300 rounded">
                <option value="">月</option>
                {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
              <select value={bd} onChange={(e) => setBd(e.target.value)} className="w-20 px-2 py-2 border border-gray-300 rounded">
                <option value="">日</option>
                {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>{d}</option>
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
              該当する書類を撮影してください（複数ページは続けて撮影できます）。
            </p>
            <ul className="space-y-3">
              {NENMATSU_DOC_TYPES.map((d) => {
                const list = photos[d.key] || []
                return (
                  <li key={d.key} className="border border-gray-200 rounded-lg p-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm text-gray-700">
                        {d.name}
                        {d.note && (
                          <span className="text-[11px] text-gray-400 ml-1">（{d.note}）</span>
                        )}
                      </span>
                      <label className="px-3 py-1.5 text-xs bg-blue-50 text-blue-700 rounded cursor-pointer whitespace-nowrap">
                        ＋撮影
                        <input
                          type="file"
                          accept="image/*"
                          capture="environment"
                          multiple
                          className="hidden"
                          onChange={(e) => {
                            onCapture(d.key, e.target.files)
                            e.target.value = ''
                          }}
                        />
                      </label>
                    </div>
                    {list.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {list.map((f, i) => (
                          <div key={i} className="relative">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={URL.createObjectURL(f)}
                              alt=""
                              className="w-16 h-16 object-cover rounded border border-gray-200"
                            />
                            <button
                              onClick={() => removePhoto(d.key, i)}
                              className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full w-5 h-5 text-xs leading-none"
                            >
                              ×
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
        )}
      </div>

      {phase === 'docs' && (
        <div className="fixed bottom-0 inset-x-0 bg-white border-t border-gray-200 p-3">
          <div className="max-w-md mx-auto">
            {submitErr && (
              <div className="text-xs text-red-600 mb-2 break-words">{submitErr}</div>
            )}
            <button
              onClick={submit}
              disabled={submitting}
              className="w-full py-3 bg-green-600 text-white rounded-lg font-semibold hover:bg-green-700 disabled:opacity-60"
            >
              {submitting ? progress || '送信中...' : '送信する'}
            </button>
          </div>
        </div>
      )}
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
