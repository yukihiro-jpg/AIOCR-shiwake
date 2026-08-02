'use client'

// 相続人向けの口コミ下書きページ（QR／リンクから開く公開ページ）。
// 目的は「投稿の手間を最小にすること」。ログイン不要、質問は4つ＋任意のひとことだけで、
// 選ぶそばから下書きが完成する。文章は本人が自由に手直しできる（そのまま投稿させない）。

import { useCallback, useEffect, useMemo, useState } from 'react'
import { loadReviewPublic, type ReviewPublic } from '@/lib/souzoku-review/store'
import {
  buildDraft, defaultTasks,
  TASK_LABELS, GOOD_LABELS, WORRY_LABELS, RECOMMEND_LABELS,
  type GoodKey, type RecommendKey, type TaskKey, type WorryKey,
} from '@/lib/souzoku-review/draft'

type Phase = 'loading' | 'error' | 'form'
const LS_KEY = 'souzoku-review-answers'

export default function ReviewContent() {
  const [phase, setPhase] = useState<Phase>('loading')
  const [errMsg, setErrMsg] = useState('')
  const [pub, setPub] = useState<ReviewPublic | null>(null)
  const [tasks, setTasks] = useState<TaskKey[]>([])
  const [goods, setGoods] = useState<GoodKey[]>([])
  const [recommend, setRecommend] = useState<RecommendKey>('')
  const [worries, setWorries] = useState<WorryKey[]>([])
  const [note, setNote] = useState('')
  const [seed, setSeed] = useState(1)
  const [text, setText] = useState('')
  const [edited, setEdited] = useState(false) // 本人が手直ししたら自動更新を止める
  const [copied, setCopied] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false) // 下書きはボトムシート方式（質問を隠さない）

  useEffect(() => {
    ;(async () => {
      try {
        const token = new URLSearchParams(window.location.search).get('t') || ''
        if (!token) {
          setErrMsg('URLが正しくありません。お渡ししたQRコードまたはリンクから開いてください。')
          setPhase('error')
          return
        }
        const p = await loadReviewPublic(token)
        if (!p) {
          setErrMsg('このリンクは無効か、有効期限が切れています。お手数ですが担当者までお知らせください。')
          setPhase('error')
          return
        }
        setPub(p)
        // 前回の続きがあれば復元。無ければ案件の内容に合わせて初期選択を入れておく
        let restored = false
        try {
          const saved = JSON.parse(localStorage.getItem(`${LS_KEY}-${token}`) || 'null')
          if (saved && Array.isArray(saved.tasks)) {
            setTasks(saved.tasks); setGoods(saved.goods || []); setRecommend(saved.recommend || '')
            setWorries(saved.worries || []); setNote(saved.note || '')
            if (typeof saved.text === 'string' && saved.text) { setText(saved.text); setEdited(!!saved.edited) }
            restored = true
          }
        } catch { /* ignore */ }
        if (!restored) setTasks(defaultTasks(p.flags))
        setSeed(Math.floor(Math.random() * 1e9) + 1)
        setPhase('form')
      } catch (e) {
        setErrMsg('読み込みに失敗しました。通信環境をご確認のうえ、もう一度お試しください。' + (e instanceof Error ? `（${e.message}）` : ''))
        setPhase('error')
      }
    })()
  }, [])

  const answers = useMemo(() => ({ worries, tasks, goods, recommend, note }), [worries, tasks, goods, recommend, note])

  // 選ぶそばから下書きが変わる（手直しを始めたら上書きしない）
  useEffect(() => {
    if (phase !== 'form' || !pub || edited) return
    setText(buildDraft(answers, pub.flags, seed))
  }, [answers, pub, seed, phase, edited])

  // 途中で閉じても続きから書けるように保存
  useEffect(() => {
    if (phase !== 'form') return
    const token = new URLSearchParams(window.location.search).get('t') || ''
    try { localStorage.setItem(`${LS_KEY}-${token}`, JSON.stringify({ ...answers, text, edited })) } catch { /* ignore */ }
  }, [answers, text, edited, phase])

  const toggle = <T,>(list: T[], v: T, setter: (x: T[]) => void, max?: number) => {
    if (list.includes(v)) setter(list.filter((x) => x !== v))
    else if (!max || list.length < max) setter([...list, v])
  }

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // クリップボードAPIが使えない端末向けのフォールバック
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      try { document.execCommand('copy') } catch { /* ignore */ }
      document.body.removeChild(ta)
    }
    setCopied(true)
  }, [text])

  if (phase === 'loading') {
    return <div className="min-h-screen flex items-center justify-center bg-gray-50"><p className="text-gray-500 text-sm">読み込み中...</p></div>
  }
  if (phase === 'error') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-6">
        <div className="max-w-md text-center">
          <p className="text-gray-700 text-sm leading-relaxed">{errMsg}</p>
        </div>
      </div>
    )
  }

  const Chip = ({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) => (
    <button
      type="button"
      onClick={onClick}
      className={`text-left px-3.5 py-2 rounded-xl border text-[14.5px] leading-snug transition ${
        on ? 'bg-blue-600 text-white border-blue-600 shadow-sm' : 'bg-white text-gray-700 border-gray-300 active:bg-gray-50'
      }`}
    >
      <span className="mr-1.5">{on ? '✓' : '＋'}</span>{children}
    </button>
  )
  const Section = ({ n, title, sub, children }: { n: string; title: string; sub?: string; children: React.ReactNode }) => (
    <section className="mb-5">
      <h2 className="text-[15px] font-bold text-gray-800 mb-1">
        <span className="inline-block bg-gray-800 text-white text-[11px] rounded px-1.5 py-0.5 mr-2 align-middle">{n}</span>
        {title}
      </h2>
      {sub && <p className="text-xs text-gray-500 mb-2">{sub}</p>}
      <div className="grid gap-1.5">{children}</div>
    </section>
  )

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-5 py-4">
        <h1 className="text-lg font-bold text-gray-900">クチコミのお願い</h1>
        {pub?.officeName && <p className="text-xs text-gray-500 mt-0.5">{pub.officeName}</p>}
        <p className="text-xs text-gray-500 mt-1 leading-relaxed">
          あてはまるものを選ぶだけで、投稿用の文章の下書きができます（30秒ほど）。
        </p>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-4 pb-28">
        <Section n="Q1" title="どのようなことでご依頼・ご相談されましたか？" sub="あてはまるものをすべて選んでください（最初からいくつか選ばれています）">
          {TASK_LABELS.map(([k, label]) => (
            <Chip key={k} on={tasks.includes(k)} onClick={() => toggle(tasks, k, setTasks)}>{label}</Chip>
          ))}
        </Section>

        <Section n="Q2" title="よかった点を3つまで選んでください" sub={`選択中 ${goods.length}／3`}>
          {GOOD_LABELS.map(([k, label]) => (
            <Chip key={k} on={goods.includes(k)} onClick={() => toggle(goods, k, setGoods, 3)}>{label}</Chip>
          ))}
        </Section>

        <Section n="Q3" title="どんな方におすすめしたいですか？" sub="1つ選んでください（選ばなくても大丈夫です）">
          {RECOMMEND_LABELS.map(([k, label]) => (
            <Chip key={k} on={recommend === k} onClick={() => setRecommend(recommend === k ? '' : k)}>{label}</Chip>
          ))}
        </Section>

        <Section n="Q4" title="依頼する前は、どんなことが不安でしたか？" sub="あてはまるものがあれば選んでください（任意）">
          {WORRY_LABELS.map(([k, label]) => (
            <Chip key={k} on={worries.includes(k)} onClick={() => toggle(worries, k, setWorries)}>{label}</Chip>
          ))}
        </Section>

        <Section n="Q5" title="ひとこと（任意）" sub="入力すると下書きに自然に入ります。空欄のままでも大丈夫です">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="例：母も納得したうえで進められました"
            className="w-full border border-gray-300 rounded-xl px-3 py-2 text-[15px]"
          />
        </Section>
      </main>

      {/* 下書きは画面下の小さなバーに置き、タップでシートを開く（質問を隠さないため） */}
      {!sheetOpen && (
        <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 shadow-[0_-2px_10px_rgba(0,0,0,.08)]" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
          <div className="max-w-2xl mx-auto px-4 py-2.5 flex items-center gap-2">
            <button type="button" onClick={() => setSheetOpen(true)} className="flex-1 min-w-0 text-left">
              <span className="block text-[11px] text-gray-500 truncate">下書き（{text.length}字）― タップで確認・編集</span>
              <span className="block text-[13px] text-gray-800 truncate">{text}</span>
            </button>
            <button
              type="button"
              onClick={() => { copy(); setSheetOpen(true) }}
              className="shrink-0 px-4 py-2.5 rounded-xl bg-blue-600 text-white font-bold text-sm active:bg-blue-700"
            >
              コピー
            </button>
          </div>
        </div>
      )}

      {sheetOpen && (
        <>
          <div className="fixed inset-0 bg-black/30" onClick={() => setSheetOpen(false)} />
          <div
            className="fixed bottom-0 left-0 right-0 bg-white rounded-t-2xl shadow-[0_-4px_20px_rgba(0,0,0,.15)] max-h-[88vh] overflow-y-auto"
            style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 8px)' }}
          >
            <div className="max-w-2xl mx-auto px-4 pt-2 pb-3">
              <div className="w-10 h-1 bg-gray-300 rounded-full mx-auto mb-2" />
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-bold text-gray-800">下書き<span className="text-[11px] font-normal text-gray-400 ml-1.5">{text.length}字</span></span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => { setEdited(false); setSeed((n) => n + 1); setCopied(false) }}
                    className="text-xs px-2.5 py-1.5 border border-gray-300 rounded-full text-gray-600 active:bg-gray-50"
                  >
                    別の言い回し
                  </button>
                  <button type="button" onClick={() => setSheetOpen(false)} className="text-gray-400 text-xl leading-none px-1" aria-label="閉じる">×</button>
                </div>
              </div>
              <textarea
                value={text}
                onChange={(e) => { setText(e.target.value); setEdited(true); setCopied(false) }}
                rows={8}
                className="w-full border border-gray-300 rounded-xl px-3 py-2.5 text-[15px] leading-relaxed"
              />
              <p className="text-[11px] text-gray-400 mt-1 mb-2">ご自身の言葉に自由に書き換えていただいて構いません。</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={copy}
                  className="flex-1 px-3 py-3 rounded-xl bg-blue-600 text-white font-bold text-[15px] whitespace-nowrap active:bg-blue-700"
                >
                  {copied ? '✓ コピー済み' : '文章をコピー'}
                </button>
                <a
                  href={pub?.reviewUrl || '#'}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`flex-1 px-3 py-3 rounded-xl font-bold text-[15px] text-center whitespace-nowrap ${
                    copied ? 'bg-green-600 text-white active:bg-green-700' : 'bg-gray-100 text-gray-500 border border-gray-300'
                  }`}
                >
                  Googleで投稿
                </a>
              </div>
              <p className="text-[11px] text-gray-400 mt-2 leading-relaxed">
                コピー →「Googleで投稿」→ 入力欄を長押しして貼り付け → 星を選んで投稿。Googleにログインした状態で開いてください。
              </p>
            </div>
          </div>
        </>
      )}

    </div>
  )
}
