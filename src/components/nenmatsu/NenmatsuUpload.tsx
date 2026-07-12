'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  loadCompanyPublic,
  submitDocsPublic,
  getSubmissionPublic,
  sha256Hex,
  type NenmatsuEmployee,
  type PublicEmployee,
} from '@/lib/nenmatsu/store'
import { NENMATSU_DOC_TYPES } from '@/lib/nenmatsu/document-types'
import { compressImage } from '@/lib/nenmatsu/image-compress'
import { FY_BY_ID } from '@/lib/nenmatsu/fiscal-year'
import { emptyDeclaration, type Declaration } from '@/lib/nenmatsu/declaration'
import DeclarationForm from './DeclarationForm'

type Phase = 'loading' | 'error' | 'select' | 'verify' | 'declare' | 'docs' | 'done'
interface Params {
  t: string
  y: string
}

export default function NenmatsuUpload() {
  const [phase, setPhase] = useState<Phase>('loading')
  const [errMsg, setErrMsg] = useState('')
  const [params, setParams] = useState<Params | null>(null)
  const [companyName, setCompanyName] = useState('')
  const [deadline, setDeadline] = useState('')
  const [employees, setEmployees] = useState<PublicEmployee[]>([])
  const [empId, setEmpId] = useState('')
  const [by, setBy] = useState('')
  const [bm, setBm] = useState('')
  const [bd, setBd] = useState('')
  const [verifyErr, setVerifyErr] = useState('')
  const [me, setMe] = useState<NenmatsuEmployee | null>(null)
  const [decl, setDecl] = useState<Declaration | null>(null)
  const [noChange, setNoChange] = useState(false)
  const [photos, setPhotos] = useState<Record<string, File[]>>({})
  const [submitting, setSubmitting] = useState(false)
  const [progress, setProgress] = useState('')
  const [submitErr, setSubmitErr] = useState('')

  const fyGregorian = useMemo(() => FY_BY_ID[params?.y || '']?.gregorian || new Date().getFullYear(), [params])

  useEffect(() => {
    ;(async () => {
      try {
        const q = new URLSearchParams(window.location.search)
        const t = q.get('t') || ''
        const yParam = q.get('y') || ''
        const isLegacyLink = !!q.get('rk') // 旧形式（roomKey入りURL）
        if (!t) {
          setErrMsg('URLが正しくありません。配布されたQRコード／リンクから開いてください。')
          setPhase('error')
          return
        }
        const res = await loadCompanyPublic(t)
        if (!res) {
          setErrMsg(
            isLegacyLink
              ? 'このリンクは新しい形式に更新されました。お手数ですが、会社のご担当者様へ新しいリンクの再送をご依頼ください。'
              : 'このリンクは無効か期限切れです。事務所へお問い合わせください。',
          )
          setPhase('error')
          return
        }
        setParams({ t, y: res.yearId || yParam })
        setCompanyName(res.companyName)
        setDeadline(res.deadline || '')
        setEmployees(res.employees)
        setPhase('select')
      } catch {
        setErrMsg('読み込みに失敗しました。通信環境をご確認のうえ、再度お試しください。')
        setPhase('error')
      }
    })()
  }, [])

  const sortedEmployees = useMemo(
    () => [...employees].sort((a, b) => (a.kanaLast + a.kanaFirst).localeCompare(b.kanaLast + b.kanaFirst, 'ja')),
    [employees],
  )
  const years = useMemo(() => {
    const now = new Date().getFullYear()
    const arr: number[] = []
    for (let y = now - 14; y >= now - 100; y--) arr.push(y) // 14〜100歳をカバー（範囲外で本人確認不能にならないよう広めに）
    return arr
  }, [])

  function startExisting() {
    setPhase('verify')
  }
  function startNewHire() {
    setMe(null)
    setDecl(emptyDeclaration(true))
    setNoChange(false)
    setPhase('declare')
  }

  async function verify() {
    setVerifyErr('')
    const emp = employees.find((e) => e.id === empId)
    if (!emp) return setVerifyErr('お名前を選択してください。')
    if (!by || !bm || !bd) return setVerifyErr('生年月日を選択してください。')
    const input = `${by}-${String(Number(bm)).padStart(2, '0')}-${String(Number(bd)).padStart(2, '0')}`
    // 公開名簿には生年月日のハッシュのみを載せているため、入力値をハッシュ化して照合する。
    // 【厳守】ハッシュ未登録（=生年月日を読み取れなかった従業員）は本人確認ができないため、
    // 照合スキップで通さずブロックする（スキップ可にすると他人へのなりすまし提出が可能になる）。
    if (!emp.birthHash) {
      return setVerifyErr('この方は本人確認用の生年月日が登録されていないため、こちらから提出できません。お手数ですが会社のご担当者（または税理士事務所）へご連絡ください。')
    }
    const h = await sha256Hex(input)
    if (h !== emp.birthHash) return setVerifyErr('生年月日が一致しません。もう一度ご確認ください。')
    // 提出用に本人情報を確定（住所・生CSV等は公開名簿に無いので本人入力に委ねる）
    const { birthHash, ...rest } = emp
    void birthHash
    setMe({ ...rest, birth: input, birthRaw: input, address: '' })
    // 氏名・カナは公開名簿から、生年月日は入力値をプリセット
    const d = emptyDeclaration(false)
    d.lastName = emp.lastName
    d.firstName = emp.firstName
    d.kanaLast = emp.kanaLast
    d.kanaFirst = emp.kanaFirst
    d.birth = input
    d.address = ''
    setDecl(d)
    setNoChange(false)
    setPhase('declare')
  }

  function proceedToDocs() {
    if (!decl) return
    if (!decl.lastName || !decl.firstName) {
      alert('氏名を入力してください。')
      return
    }
    if (decl.isNewHire && !decl.hireDate) {
      alert('入社日を入力してください。')
      return
    }
    if (decl.isNewHire && decl.hasPrevJob === undefined) {
      alert('今年の前職の有無を選択してください。')
      return
    }
    setDecl({ ...decl, noChange, confirmedAt: new Date().toISOString() })
    setPhase('docs')
  }

  // 本年入社×前職ありの場合、前職の源泉徴収票が必須（どうしても入手できない場合のみ例外）
  const needPrevSlip = !!(decl?.isNewHire && decl?.hasPrevJob)
  const prevSlipCount = (photos['prev_withholding'] || []).length
  const [noSlipChecked, setNoSlipChecked] = useState(false)

  // 提出期限の表示（期限を過ぎても提出は受け付ける＝機会を閉じない方針）
  const deadlineInfo = useMemo(() => {
    if (!deadline) return null
    const d = new Date(deadline + 'T23:59:59')
    if (isNaN(d.getTime())) return null
    const w = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()]
    const label = `${d.getMonth() + 1}月${d.getDate()}日（${w}）`
    const days = Math.ceil((d.getTime() - Date.now()) / 86400000)
    return { label, days }
  }, [deadline])

  function onCapture(docKey: string, list: FileList | null) {
    if (!list || !list.length) return
    const arr = Array.from(list)
    setPhotos((prev) => ({ ...prev, [docKey]: [...(prev[docKey] || []), ...arr] }))
  }
  function removePhoto(docKey: string, idx: number) {
    setPhotos((prev) => ({ ...prev, [docKey]: (prev[docKey] || []).filter((_, i) => i !== idx) }))
  }

  async function submit() {
    if (!params || !decl) return
    // 前職ありで源泉徴収票が未撮影の場合は原則提出不可
    if (needPrevSlip && prevSlipCount === 0) {
      if (!noSlipChecked) {
        alert(
          '前職の源泉徴収票が撮影されていません。\n\n' +
            '前職分を含めて年末調整を行うため、今年のすべての前職の源泉徴収票が必要です。' +
            'お手元にない場合は、前職の会社へ発行を依頼してください（退職後1か月以内の発行が法律上の義務です）。\n\n' +
            'どうしても入手できない場合のみ、画面下のチェックを入れて提出してください。',
        )
        return
      }
      if (
        !confirm(
          '【重要】前職の源泉徴収票なしで提出します。\n\n' +
            'この場合、会社の年末調整に前職分を含めることができないため、' +
            'ご自身で確定申告（翌年2月16日〜3月15日）を行う必要があります。\n\n' +
            'このまま提出しますか？',
        )
      )
        return
    }
    const declToSend: Declaration = { ...decl, prevJobNoSlip: needPrevSlip && prevSlipCount === 0 && noSlipChecked }
    // 提出者（既存=me、新入社員=申告から生成）
    const emp: NenmatsuEmployee =
      me ||
      {
        id: 'n_' + Math.abs(hashCode(decl.lastName + decl.firstName + decl.birth)).toString(36) + '_' + (decl.birth || '').replace(/-/g, ''),
        code: '',
        lastName: decl.lastName,
        firstName: decl.firstName,
        kanaLast: decl.kanaLast,
        kanaFirst: decl.kanaFirst,
        birth: decl.birth,
        birthRaw: decl.birth,
        isNewHire: true,
      }
    const totalFiles = Object.values(photos).reduce((s, a) => s + a.length, 0)
    if (totalFiles === 0) {
      if (!confirm('撮影した書類がありません。「該当する書類なし」として提出しますか？')) return
    }
    try {
      const existing = await getSubmissionPublic(params.t, emp.id)
      if (existing) {
        if (!confirm(`${emp.lastName} ${emp.firstName} さんは既に提出済みです（${new Date(existing.submittedAt).toLocaleString('ja-JP')}）。\n上書きして提出しますか？`)) return
      }
    } catch {
      /* チェック失敗時は続行 */
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
      await submitDocsPublic(params.t, emp, docs, declToSend)
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
          <p className="text-[11px] text-gray-400 mt-2">提出された画像は、提出から1年6か月後に自動削除されます。</p>
        </div>
      </Center>
    )

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <header className="bg-blue-600 text-white px-4 py-3">
        <div className="max-w-md mx-auto">
          <div className="text-xs opacity-80">年末調整 書類アップロード</div>
          <div className="font-bold">{companyName}</div>
        </div>
      </header>

      <div className="max-w-md mx-auto p-4">
        {deadlineInfo && (
          <div className={`rounded-xl px-3 py-2.5 mb-3 text-sm border ${
            deadlineInfo.days < 0
              ? 'bg-red-50 border-red-300 text-red-800'
              : deadlineInfo.days <= 7
                ? 'bg-amber-50 border-amber-300 text-amber-800'
                : 'bg-white border-gray-200 text-gray-700'
          }`}>
            {deadlineInfo.days < 0 ? (
              <>⚠ <b>提出期限（{deadlineInfo.label}）を過ぎています。</b>至急ご提出のうえ、会社のご担当者へご連絡ください。</>
            ) : deadlineInfo.days === 0 ? (
              <>⏰ <b>提出期限は本日（{deadlineInfo.label}）です。</b>お早めにご提出ください。</>
            ) : (
              <>📅 提出期限：<b>{deadlineInfo.label}</b>（あと{deadlineInfo.days}日）</>
            )}
          </div>
        )}
        {phase === 'select' && (
          <div className="bg-white rounded-2xl border border-gray-200 p-5">
            <h1 className="font-bold text-gray-800 mb-3">あてはまるものを選んでください</h1>
            <button onClick={startExisting} className="w-full py-3 mb-3 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700">
              在籍中の従業員の方
            </button>
            <button onClick={startNewHire} className="w-full py-3 border border-blue-600 text-blue-700 rounded-lg font-semibold hover:bg-blue-50">
              本年入社の方
            </button>
          </div>
        )}

        {phase === 'verify' && (
          <div className="bg-white rounded-2xl border border-gray-200 p-5">
            <h1 className="font-bold text-gray-800 mb-1">ご本人の確認</h1>
            <p className="text-xs text-gray-500 mb-4">お名前と生年月日（必須）で確認します。</p>
            <label className="block text-sm font-medium text-gray-700 mb-1">お名前</label>
            <select value={empId} onChange={(e) => setEmpId(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded mb-4">
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
                {Array.from({ length: 31 }, (_, i) => i + 1).map((dd) => (
                  <option key={dd} value={dd}>{dd}</option>
                ))}
              </select>
            </div>
            {verifyErr && <div className="text-sm text-red-600 mb-2">{verifyErr}</div>}
            <button onClick={verify} className="w-full py-3 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 mt-2">
              次へ
            </button>
          </div>
        )}

        {phase === 'declare' && decl && (
          <div className="bg-white rounded-2xl border border-gray-200 p-5">
            <h1 className="font-bold text-gray-800 mb-1">
              {decl.isNewHire ? '扶養控除等申告書（本年入社）' : '個人情報・扶養親族の確認'}
            </h1>
            <p className="text-xs text-gray-500 mb-3">
              {decl.isNewHire
                ? '本人・配偶者・扶養親族の情報を入力してください。'
                : '前年の情報をもとに表示しています。変更があれば修正してください。'}
            </p>
            {!decl.isNewHire && (
              <label className="flex items-center gap-2 text-sm mb-3 bg-blue-50 rounded px-3 py-2">
                <input type="checkbox" checked={noChange} onChange={(e) => setNoChange(e.target.checked)} />
                <span>前年と相違ありません</span>
              </label>
            )}
            <DeclarationForm value={decl} onChange={setDecl} fyGregorian={fyGregorian} editableName={decl.isNewHire} />
            <button onClick={proceedToDocs} className="w-full py-3 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 mt-5">
              次へ（書類の撮影）
            </button>
          </div>
        )}

        {phase === 'docs' && decl && (
          <div className="bg-white rounded-2xl border border-gray-200 p-5">
            <h1 className="font-bold text-gray-800 mb-1">
              {decl.lastName} {decl.firstName} 様
            </h1>
            <p className="text-xs text-gray-500 mb-2">該当する書類を撮影してください（複数ページは続けて撮影できます）。スマホ内に保存済みの写真も選べます。</p>
            <p className="text-[11px] text-amber-700 bg-amber-50 rounded px-2 py-1.5 mb-4">
              📷 カメラが開かない・撮影できないときは、LINE等のアプリ内ではなく <b>Safari / Chrome で開き直す</b>とご利用いただけます（右上メニューの「ブラウザで開く」）。
            </p>
            {needPrevSlip && (
              <div className="text-[12px] text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3 leading-relaxed">
                ❗ 前職があるため、<b>今年のすべての前職の「源泉徴収票」の撮影が必須</b>です。
                撮影がないと原則提出できません。お手元にない場合は前職の会社へ発行をご依頼ください。
              </div>
            )}
            <ul className="space-y-3">
              {NENMATSU_DOC_TYPES.map((dt) => {
                const list = photos[dt.key] || []
                const required = needPrevSlip && dt.key === 'prev_withholding'
                return (
                  <li key={dt.key} className={`border rounded-lg p-3 ${required ? (list.length ? 'border-green-400 bg-green-50/40' : 'border-red-400 bg-red-50/40') : 'border-gray-200'}`}>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm text-gray-700">
                        {required && <span className={`mr-1 px-1.5 py-0.5 rounded text-[10px] font-bold ${list.length ? 'bg-green-600 text-white' : 'bg-red-600 text-white'}`}>{list.length ? '撮影済' : '必須'}</span>}
                        {dt.name}
                        {dt.note && <span className="text-[11px] text-gray-400 ml-1">（{dt.note}）</span>}
                      </span>
                      <label className="px-3 py-1.5 text-xs bg-blue-50 text-blue-700 rounded cursor-pointer whitespace-nowrap">
                        ＋撮影・写真を追加
                        <input
                          type="file"
                          accept="image/*"
                          multiple
                          className="hidden"
                          onChange={(e) => {
                            onCapture(dt.key, e.target.files)
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
                            <img src={URL.createObjectURL(f)} alt="" className="w-16 h-16 object-cover rounded border border-gray-200" />
                            <button onClick={() => removePhoto(dt.key, i)} className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full w-5 h-5 text-xs leading-none">
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
            {needPrevSlip && prevSlipCount === 0 && (
              <div className="mt-4 border border-amber-300 bg-amber-50 rounded-lg px-3 py-2.5">
                <label className="flex items-start gap-2 text-[12px] text-amber-900">
                  <input type="checkbox" className="mt-0.5" checked={noSlipChecked} onChange={(e) => setNoSlipChecked(e.target.checked)} />
                  <span>
                    前職の会社に問い合わせましたが、<b>どうしても源泉徴収票を入手できません</b>（入手できないまま提出します）
                  </span>
                </label>
                {noSlipChecked && (
                  <p className="text-[11px] text-red-700 mt-1.5 leading-relaxed">
                    ⚠ この場合、会社の年末調整では前職分を精算できないため、<b>ご自身で確定申告（翌年2/16〜3/15）を行う必要があります</b>。
                    源泉徴収票の発行は退職後1か月以内が法律上の義務ですので、まずは前職の会社へご依頼ください。
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {phase === 'docs' && (
        <div className="fixed bottom-0 inset-x-0 bg-white border-t border-gray-200 p-3">
          <div className="max-w-md mx-auto">
            {submitErr && <div className="text-xs text-red-600 mb-2 break-words">{submitErr}</div>}
            <button onClick={submit} disabled={submitting} className="w-full py-3 bg-green-600 text-white rounded-lg font-semibold hover:bg-green-700 disabled:opacity-60">
              {submitting ? progress || '送信中...' : '送信する'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function hashCode(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return h
}

function Center({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen flex items-center justify-center bg-gray-50 p-6 text-gray-500">{children}</div>
}
