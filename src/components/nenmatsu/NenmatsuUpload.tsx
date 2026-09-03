'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  loadCompanyPublic,
  submitDocsPublic,
  getSubmissionPublic,
  loadPrevDeclarationPublic,
  loadPrefillPublic,
  sha256Hex,
  type NenmatsuEmployee,
  type PublicEmployee,
} from '@/lib/nenmatsu/store'
import { NENMATSU_DOC_TYPES } from '@/lib/nenmatsu/document-types'
import { compressImage } from '@/lib/nenmatsu/image-compress'
import { checkPhotoQuality } from '@/lib/nenmatsu/photo-check'
import { FY_BY_ID } from '@/lib/nenmatsu/fiscal-year'
import { emptyDeclaration, emptySpouse, emptyDependent, type Declaration } from '@/lib/nenmatsu/declaration'
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
  // 前年に提出した申告内容（在籍中の方のみ）。初期表示に使い、見比べ用にも残しておく
  const [prev, setPrev] = useState<{ yearLabel: string; submittedAt: string; declaration: Declaration } | null>(null)
  const [showPrev, setShowPrev] = useState(false)
  // 初期表示が「事務所に登録されている内容（CSV由来）」だったか（前年の提出が無い初年度）
  const [fromCsv, setFromCsv] = useState(false)
  const [noChange, setNoChange] = useState(false)
  const [photos, setPhotos] = useState<Record<string, File[]>>({})
  // 写真ごとのOCR適性警告（キー: docKey|name|size|lastModified）
  const [photoWarns, setPhotoWarns] = useState<Record<string, string[]>>({})
  const warnKey = (docKey: string, f: File) => `${docKey}|${f.name}|${f.size}|${f.lastModified}`
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
    // 初期表示は「①このアプリでの前年の提出 ②事務所に登録されている内容（JDLのCSV由来）」の順で使う。
    // ①が無い初年度でも、②に前年の扶養控除等申告書の内容（住所・扶養親族）が入っているので、
    // 従業員は空欄から入力せず、確認・修正だけで済む。
    const [p, csv] = params
      ? await Promise.all([loadPrevDeclarationPublic(params.t, emp.id), loadPrefillPublic(params.t, emp.id)])
      : [null, null]
    setPrev(p)
    setShowPrev(false)
    let src: Declaration | null = p ? { ...emptyDeclaration(false), ...p.declaration } : null
    if (!src && csv) {
      src = {
        ...emptyDeclaration(false),
        postal: csv.postal || '',
        address: csv.address || '',
        spouse: csv.spouse
          ? { exists: true, name: csv.spouse.name || '', kana: csv.spouse.kana || '', birth: csv.spouse.birth || '', income: csv.spouse.income || '' }
          : emptySpouse(),
        dependents: (csv.dependents || []).map((x) => ({ ...emptyDependent(), name: x.name || '', kana: x.kana || '', relation: x.relation || '', birth: x.birth || '', income: x.income || '' })),
      }
    }
    setFromCsv(!p && !!csv)
    const base = src || emptyDeclaration(false)
    const d: Declaration = {
      ...base,
      isNewHire: false,
      noChange: false,
      confirmedAt: undefined,
      lastName: emp.lastName,
      firstName: emp.firstName,
      kanaLast: emp.kanaLast,
      kanaFirst: emp.kanaFirst,
      birth: input,
      spouse: { ...emptySpouse(), ...(base.spouse || {}) },
      dependents: (base.dependents || []).map((x) => ({ ...emptyDependent(), ...x })),
    }
    setDecl(d)
    setNoChange(false)
    setPhase('declare')
  }

  /** 1つ前の画面へ戻る。入力内容・撮影済みの写真はそのまま残す。 */
  function goBack() {
    if (phase === 'verify') { setVerifyErr(''); setPhase('select'); return }
    if (phase === 'declare') { setPhase(decl?.isNewHire ? 'select' : 'verify'); return }
    if (phase === 'docs') { setPhase('declare'); return }
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
    // OCR適性チェック（バックグラウンドで実行し、問題があれば写真に警告バッジを付ける）
    for (const f of arr) {
      checkPhotoQuality(f)
        .then((r) => {
          if (!r.ok) setPhotoWarns((prev) => ({ ...prev, [warnKey(docKey, f)]: r.issues }))
        })
        .catch(() => { /* チェック不能時は警告しない */ })
    }
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
        if (!confirm(
          `${emp.lastName} ${emp.firstName} さんは既に提出済みです（${new Date(existing.submittedAt).toLocaleString('ja-JP')}）。\n\n` +
            '再提出すると：\n' +
            '・今回撮影した書類は追加されます\n' +
            '・同じ書類を撮り直した場合は、新しい写真に置き換わります\n' +
            '・撮影しなかった書類は、前回提出した写真がそのまま残ります\n' +
            '・扶養親族等の申告内容は、今回の入力内容に更新されます\n\n' +
            'このまま提出しますか？',
        )) return
      }
    } catch {
      /* チェック失敗時は続行（提出処理側でも前回分を確認する） */
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

  // 前年と今の入力の違いを一覧にする（見比べ用。金額・住所などは文字列で比べる）
  const prevDiff = useMemo(() => {
    if (!prev || !decl) return []
    const a = prev.declaration, b = decl
    const yen = (v: string) => (v ? `${Number(String(v).replace(/[^0-9]/g, '') || 0).toLocaleString('ja-JP')}円` : '未入力')
    const rows: { label: string; before: string; after: string }[] = []
    const add = (label: string, before: string, after: string) => {
      if ((before || '') !== (after || '')) rows.push({ label, before: before || '（なし）', after: after || '（なし）' })
    }
    add('郵便番号', a.postal, b.postal)
    add('住所', a.address, b.address)
    add('世帯主', a.householder, b.householder)
    add('続柄', a.householderRelation, b.householderRelation)
    add('本人の障害者区分', a.selfDisability, b.selfDisability)
    add('寡婦／ひとり親', a.widow, b.widow)
    add('勤労学生', a.workingStudent ? '該当' : '非該当', b.workingStudent ? '該当' : '非該当')
    add('配偶者', a.spouse?.exists ? '有' : '無', b.spouse?.exists ? '有' : '無')
    if (a.spouse?.exists || b.spouse?.exists) {
      add('配偶者の氏名', a.spouse?.name || '', b.spouse?.name || '')
      add('配偶者の生年月日', a.spouse?.birth || '', b.spouse?.birth || '')
      add('配偶者の年収', yen(a.spouse?.income || ''), yen(b.spouse?.income || ''))
    }
    const an = a.dependents?.length || 0, bn = b.dependents?.length || 0
    add('扶養親族の人数', `${an}人`, `${bn}人`)
    for (let i = 0; i < Math.max(an, bn); i++) {
      const x = a.dependents?.[i], y = b.dependents?.[i]
      add(`扶養${i + 1}人目`, x ? `${x.name}（${x.relation}・${yen(x.income)}）` : '', y ? `${y.name}（${y.relation}・${yen(y.income)}）` : '')
    }
    return rows
  }, [prev, decl])

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

  // 進み具合（全4ステップ）。どこまで来たかが分かると、途中でやめる人が減る
  const stepNo = phase === 'select' ? 1 : phase === 'verify' ? 2 : phase === 'declare' ? 3 : 4
  const stepName = phase === 'select' ? 'あてはまるものを選ぶ'
    : phase === 'verify' ? 'ご本人の確認'
      : phase === 'declare' ? 'ご本人の情報' : '書類の撮影'

  return (
    <div className="min-h-screen bg-gray-50 pb-28">
      <header className="bg-blue-600 text-white px-4 py-3">
        <div className="max-w-md mx-auto">
          <div className="text-[12px] opacity-85">年末調整 書類アップロード</div>
          <div className="font-bold text-[17px]">{companyName}</div>
        </div>
      </header>

      <div className="max-w-md mx-auto px-4 pt-3">
        <div className="flex gap-1.5">
          {[1, 2, 3, 4].map((n) => (
            <span key={n} className={`flex-1 h-1.5 rounded ${n <= stepNo ? 'bg-blue-600' : 'bg-blue-100'}`} />
          ))}
        </div>
        <div className="flex items-center justify-between mt-1.5">
          <div className="text-[13px] font-semibold text-gray-600">ステップ {stepNo} / 4　{stepName}</div>
          {(phase === 'verify' || phase === 'declare' || phase === 'docs') && (
            <button onClick={goBack}
              className="text-[15px] font-bold text-blue-700 border-[1.5px] border-blue-600 rounded-lg px-3 py-1 bg-white hover:bg-blue-50">
              ← 前に戻る
            </button>
          )}
        </div>
      </div>

      <div className="max-w-md mx-auto p-4">
        {deadlineInfo && (
          <div className={`rounded-xl px-4 py-3 mb-3 text-[15px] leading-relaxed border-[1.5px] ${
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
            <h1 className="font-bold text-gray-800 text-[20px] mb-4">あてはまるものを選んでください</h1>
            <button onClick={startExisting} className="w-full h-[58px] mb-3 bg-blue-600 text-white rounded-xl text-[18px] font-bold hover:bg-blue-700">
              在籍中の従業員の方
            </button>
            <button onClick={startNewHire} className="w-full h-[58px] border-[1.5px] border-blue-600 text-blue-700 rounded-xl text-[18px] font-bold hover:bg-blue-50">
              本年入社の方
            </button>
            <p className="text-[14px] text-gray-500 leading-relaxed mt-4">
              本年入社の方は<b className="text-red-600">お名前が一覧に表示されません</b>。「本年入社の方」を選んで、ご自身の情報を入力してください。
            </p>
          </div>
        )}

        {phase === 'verify' && (
          <div className="bg-white rounded-2xl border border-gray-200 p-5">
            <h1 className="font-bold text-gray-800 text-[20px] mb-1">ご本人の確認</h1>
            <p className="text-[14px] text-gray-500 leading-relaxed mb-4">お名前と生年月日で確認します。</p>
            <label className="block text-[15px] font-semibold text-gray-700 mb-1.5">お名前</label>
            <select value={empId} onChange={(e) => setEmpId(e.target.value)} className="w-full h-[52px] px-3.5 border-[1.5px] border-gray-300 rounded-xl text-[18px] bg-white mb-4">
              <option value="">選択してください</option>
              {sortedEmployees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.lastName} {e.firstName}
                </option>
              ))}
            </select>
            <label className="block text-[15px] font-semibold text-gray-700 mb-1.5">生年月日</label>
            <div className="flex gap-2 mb-2">
              <select value={by} onChange={(e) => setBy(e.target.value)} className="flex-1 h-[52px] px-2 border-[1.5px] border-gray-300 rounded-xl text-[18px] bg-white">
                <option value="">年</option>
                {years.map((y) => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
              <select value={bm} onChange={(e) => setBm(e.target.value)} className="w-[86px] h-[52px] px-2 border-[1.5px] border-gray-300 rounded-xl text-[18px] bg-white">
                <option value="">月</option>
                {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
              <select value={bd} onChange={(e) => setBd(e.target.value)} className="w-[86px] h-[52px] px-2 border-[1.5px] border-gray-300 rounded-xl text-[18px] bg-white">
                <option value="">日</option>
                {Array.from({ length: 31 }, (_, i) => i + 1).map((dd) => (
                  <option key={dd} value={dd}>{dd}</option>
                ))}
              </select>
            </div>
            {verifyErr && <div className="text-[15px] text-red-600 leading-relaxed mb-2">{verifyErr}</div>}
            <button onClick={verify} className="w-full h-[58px] bg-blue-600 text-white rounded-xl text-[19px] font-bold hover:bg-blue-700 mt-3">
              次へ
            </button>
          </div>
        )}

        {phase === 'declare' && decl && (
          <div>
            <div className="bg-white rounded-2xl border border-gray-200 px-4 py-4 mb-4">
              <h1 className="font-bold text-gray-800 text-[20px] mb-1">
                {decl.isNewHire ? '扶養控除等申告書（本年入社）' : '個人情報・扶養親族の確認'}
              </h1>
              <p className="text-[14px] text-gray-500 leading-relaxed">
                {decl.isNewHire
                  ? '本人・配偶者・扶養親族の情報を入力してください。紙の申告書のご提出は不要です。'
                  : prev
                    ? `${prev.yearLabel}にご提出いただいた内容を表示しています。変更があれば直してください。`
                    : fromCsv
                      ? '会社に登録されている内容（前年の扶養控除等申告書）を表示しています。変更があれば直してください。'
                      : '登録されている内容がないため、空欄から入力してください。'}
              </p>

              {/* 前年との見比べ。変更点は自動で拾って一覧にする */}
              {!decl.isNewHire && prev && (
                <div className="mt-3 border-[1.5px] border-blue-200 bg-blue-50 rounded-xl px-3.5 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[14px] font-bold text-blue-900">
                      {prevDiff.length === 0
                        ? `✓ ${prev.yearLabel}から変更はありません`
                        : `${prev.yearLabel}から ${prevDiff.length}か所 変わっています`}
                    </div>
                    <button onClick={() => setShowPrev((v) => !v)}
                      className="shrink-0 text-[14px] font-bold text-blue-700 border-[1.5px] border-blue-500 rounded-lg px-2.5 py-1 bg-white">
                      {showPrev ? '閉じる' : '前年の内容を見る'}
                    </button>
                  </div>
                  {prevDiff.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {prevDiff.map((r) => (
                        <li key={r.label} className="text-[14px] leading-relaxed text-gray-800">
                          <span className="font-semibold">{r.label}</span>：
                          <span className="text-gray-500 line-through">{r.before}</span>
                          <span className="mx-1">→</span>
                          <span className="font-bold text-blue-800">{r.after}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {showPrev && (
                    <div className="mt-3 bg-white border border-blue-200 rounded-lg px-3 py-2.5 text-[14px] leading-relaxed text-gray-800">
                      <div className="font-bold text-gray-700 mb-1">{prev.yearLabel}のご提出内容</div>
                      <div>住所：{prev.declaration.postal ? `〒${prev.declaration.postal} ` : ''}{prev.declaration.address || '（なし）'}</div>
                      <div>世帯主：{prev.declaration.householder || '（なし）'}{prev.declaration.householderRelation ? `（${prev.declaration.householderRelation}）` : ''}</div>
                      <div>本人の障害者区分：{prev.declaration.selfDisability}／寡婦・ひとり親：{prev.declaration.widow}／勤労学生：{prev.declaration.workingStudent ? '該当' : '非該当'}</div>
                      <div className="mt-1 font-semibold">配偶者</div>
                      <div>{prev.declaration.spouse?.exists
                        ? `${prev.declaration.spouse.name || '（氏名なし）'}　${prev.declaration.spouse.birth || ''}　年収 ${Number(String(prev.declaration.spouse.income || '').replace(/[^0-9]/g, '') || 0).toLocaleString('ja-JP')}円`
                        : 'なし'}</div>
                      <div className="mt-1 font-semibold">扶養親族（{prev.declaration.dependents?.length || 0}人）</div>
                      {(prev.declaration.dependents || []).length === 0 ? <div>なし</div> : (
                        <ul className="list-disc pl-5">
                          {(prev.declaration.dependents || []).map((x, i) => (
                            <li key={i}>{x.name || '（氏名なし）'}（{x.relation || '続柄なし'}・{x.birth || '生年月日なし'}・年収 {Number(String(x.income || '').replace(/[^0-9]/g, '') || 0).toLocaleString('ja-JP')}円・{x.liveTogether ? '同居' : '別居'}）</li>
                          ))}
                        </ul>
                      )}
                      {prev.submittedAt && (
                        <div className="text-[12px] text-gray-500 mt-2">
                          提出日：{new Date(prev.submittedAt).toLocaleDateString('ja-JP')}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
              {!decl.isNewHire && (
                <label className={`flex items-center gap-3 border-[1.5px] rounded-xl px-4 py-3.5 text-[18px] font-semibold mt-3 ${noChange ? 'border-blue-600 bg-blue-50 text-blue-700' : 'border-gray-300 bg-white text-gray-700'}`}>
                  <input type="checkbox" className="w-6 h-6 accent-blue-600" checked={noChange} onChange={(e) => setNoChange(e.target.checked)} />
                  <span>前年と相違ありません</span>
                </label>
              )}
            </div>
            <DeclarationForm value={decl} onChange={setDecl} fyGregorian={fyGregorian} editableName={decl.isNewHire} />
          </div>
        )}

        {phase === 'docs' && decl && (
          <div className="bg-white rounded-2xl border border-gray-200 p-5">
            <h1 className="font-bold text-gray-800 mb-1">
              {decl.lastName} {decl.firstName} 様
            </h1>
            <p className="text-xs text-gray-500 mb-2">該当する書類を撮影してください（複数ページは続けて撮影できます）。スマホ内に保存済みの写真も選べます。</p>
            <div className="text-[12px] text-sky-900 bg-sky-50 border border-sky-200 rounded-lg px-3 py-2.5 mb-2 leading-relaxed">
              <div className="font-bold mb-1">📷 きれいに読み取れる撮影のコツ</div>
              ・書類の<b>真上から</b>、書類<b>全体が画面に大きく</b>入るように撮影<br />
              ・<b>明るい場所</b>で。影や照明の映り込み・フラッシュの反射に注意<br />
              ・無地の机の上に置き、<b>折り目・丸まりを伸ばして</b>から撮影<br />
              ・撮影後、<b>小さな文字が読めるか</b>写真を拡大して確認してください
            </div>
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
                      <>
                        <div className="flex flex-wrap gap-2">
                          {list.map((f, i) => {
                            const warns = photoWarns[warnKey(dt.key, f)]
                            return (
                              <div key={i} className="relative">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={URL.createObjectURL(f)} alt="" className={`w-16 h-16 object-cover rounded border-2 ${warns ? 'border-amber-400' : 'border-gray-200'}`} />
                                <button onClick={() => removePhoto(dt.key, i)} className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full w-5 h-5 text-xs leading-none">
                                  ×
                                </button>
                                {warns && (
                                  <span className="absolute bottom-0 left-0 right-0 bg-amber-500/95 text-white text-[9px] text-center rounded-b font-bold">⚠ 要確認</span>
                                )}
                              </div>
                            )
                          })}
                        </div>
                        {list.some((f) => photoWarns[warnKey(dt.key, f)]) && (
                          <div className="mt-2 text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1.5 leading-relaxed">
                            <b>⚠ 自動読取に失敗する可能性のある写真があります：</b>
                            {Array.from(new Set(list.flatMap((f) => photoWarns[warnKey(dt.key, f)] || []))).map((w, i) => (
                              <span key={i}><br />・{w}</span>
                            ))}
                            <br />そのまま提出もできますが、<b>×で削除して撮り直す</b>ことをおすすめします。
                          </div>
                        )}
                      </>
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

      {phase === 'declare' && decl && (
        <div className="fixed bottom-0 inset-x-0 bg-white/95 backdrop-blur border-t border-gray-200 px-3 pt-3 pb-4">
          <div className="max-w-md mx-auto">
            <button onClick={proceedToDocs} className="w-full h-[58px] bg-blue-600 text-white rounded-xl text-[19px] font-bold hover:bg-blue-700">
              次へ（書類の撮影）
            </button>
          </div>
        </div>
      )}

      {phase === 'docs' && (
        <div className="fixed bottom-0 inset-x-0 bg-white/95 backdrop-blur border-t border-gray-200 px-3 pt-3 pb-4">
          <div className="max-w-md mx-auto">
            {submitErr && <div className="text-[14px] text-red-600 mb-2 break-words leading-relaxed">{submitErr}</div>}
            <button onClick={submit} disabled={submitting} className="w-full h-[58px] bg-green-600 text-white rounded-xl text-[19px] font-bold hover:bg-green-700 disabled:opacity-60">
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
