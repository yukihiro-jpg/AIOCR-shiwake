'use client'

// 申告書チェック: 税務書類PDFをアップロードし、別種類の書類間で金額の整合を確認する
// すべてブラウザ内で処理（AIやサーバーへの送信なし・API不使用）
import { useCallback, useRef, useState } from 'react'
import Link from 'next/link'
import type { AnalyzeResult, CheckResult } from '@/lib/shinkoku-check/types'

const STATUS_STYLE: Record<string, { label: string; cls: string }> = {
  ok: { label: '✓ 一致', cls: 'bg-green-100 text-green-800' },
  warn: { label: '⚠ 要確認', cls: 'bg-amber-100 text-amber-800' },
  info: { label: '参考', cls: 'bg-sky-100 text-sky-800' },
  na: { label: '－ 対象なし', cls: 'bg-gray-100 text-gray-500' },
}

function fmt(v: number | null): string {
  if (v == null) return '（検出不可）'
  return v.toLocaleString('ja-JP')
}

export default function ShinkokuCheckContent() {
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [result, setResult] = useState<AnalyzeResult | null>(null)
  const [noText, setNoText] = useState<number[]>([])
  const [error, setError] = useState('')
  const [showPages, setShowPages] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const addFiles = useCallback((list: FileList | File[]) => {
    const pdfs = Array.from(list).filter((f) => /\.pdf$/i.test(f.name))
    if (pdfs.length) {
      setFiles((prev) => [...prev, ...pdfs])
      setResult(null)
      setError('')
    }
  }, [])

  const run = useCallback(async () => {
    if (!files.length || busy) return
    setBusy(true)
    setError('')
    setResult(null)
    setNoText([])
    try {
      setProgress('PDFを読み込み中…')
      const { extractPdfPages } = await import('@/lib/shinkoku-check/pdf')
      const { analyze } = await import('@/lib/shinkoku-check/analyze')
      const { pages, noTextPages } = await extractPdfPages(files, (done, total) =>
        setProgress(`PDFを読み込み中… ${done}/${total}ページ`),
      )
      setNoText(noTextPages)
      setProgress('金額を照合中…')
      setResult(analyze(pages))
    } catch (e: any) {
      setError('処理に失敗しました: ' + (e?.message || String(e)))
    } finally {
      setBusy(false)
      setProgress('')
    }
  }, [files, busy])

  const groups: { name: string; items: CheckResult[] }[] = []
  if (result) {
    for (const c of result.checks) {
      let g = groups.find((x) => x.name === c.group)
      if (!g) {
        g = { name: c.group, items: [] }
        groups.push(g)
      }
      g.items.push(c)
    }
  }
  const warnCount = result ? result.checks.filter((c) => c.status === 'warn').length : 0
  const okCount = result ? result.checks.filter((c) => c.status === 'ok').length : 0

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-4 py-3 flex items-center gap-3">
        <Link href="/" className="text-sm text-blue-600 hover:underline shrink-0">
          ← ホーム
        </Link>
        <h1 className="text-lg font-bold text-gray-800">🧾 申告書チェック</h1>
        <span className="text-xs text-gray-500 hidden sm:inline">
          税務書類PDFの書類間の金額整合をブラウザ内で自動チェック（外部送信なし）
        </span>
      </header>

      <main className="max-w-5xl mx-auto p-4 space-y-4">
        {/* アップロード */}
        <section
          className="bg-white rounded-xl border-2 border-dashed border-gray-300 p-6 text-center cursor-pointer hover:border-blue-400 transition-colors"
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault()
            addFiles(e.dataTransfer.files)
          }}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".pdf"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files)
              e.target.value = ''
            }}
          />
          <div className="text-3xl mb-2">📄</div>
          <p className="text-sm text-gray-700 font-medium">
            申告書一式のPDFをここにドロップ（クリックで選択）
          </p>
          <p className="text-xs text-gray-500 mt-1">
            法人税申告書（別表）・決算書・勘定科目内訳明細書・事業概況説明書・消費税申告書などをまとめた
            PDF、または複数のPDFに分かれていても構いません
          </p>
          {files.length > 0 && (
            <div className="mt-3 text-left inline-block">
              {files.map((f, i) => (
                <div key={i} className="text-xs text-gray-700 flex items-center gap-2">
                  <span>📎 {f.name}（{(f.size / 1024 / 1024).toFixed(1)}MB）</span>
                  <button
                    className="text-red-500 hover:text-red-700"
                    onClick={(e) => {
                      e.stopPropagation()
                      setFiles((prev) => prev.filter((_, j) => j !== i))
                      setResult(null)
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <div className="flex items-center gap-3">
          <button
            className="px-5 py-2.5 rounded-lg bg-blue-600 text-white text-sm font-bold hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
            disabled={!files.length || busy}
            onClick={run}
          >
            {busy ? progress || '処理中…' : 'チェック実行'}
          </button>
          {result && (
            <span className="text-sm text-gray-700">
              ✓ 一致 <b className="text-green-700">{okCount}</b> 件 ／ ⚠ 要確認{' '}
              <b className={warnCount ? 'text-amber-700' : 'text-gray-500'}>{warnCount}</b> 件
            </span>
          )}
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-3">
            {error}
          </div>
        )}

        {noText.length > 0 && (
          <div className="bg-amber-50 border border-amber-200 text-amber-800 text-xs rounded-lg p-3">
            ⚠ テキスト情報のないページ（スキャン画像など）が {noText.length}
            ページありました（ページ: {noText.slice(0, 10).join(', ')}
            {noText.length > 10 ? ' …' : ''}）。これらのページはチェックできません。
            税務ソフトから直接出力したPDFをご利用ください。
          </div>
        )}

        {/* 結果 */}
        {groups.map((g) => (
          <section key={g.name} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <h2 className="px-4 py-2.5 bg-gray-100 text-sm font-bold text-gray-800 border-b border-gray-200">
              {g.name}
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-gray-500 border-b border-gray-100">
                    <th className="text-left px-3 py-2 font-medium">チェック項目</th>
                    <th className="text-right px-3 py-2 font-medium">書類A</th>
                    <th className="text-right px-3 py-2 font-medium">書類B</th>
                    <th className="text-right px-3 py-2 font-medium">差額</th>
                    <th className="text-center px-3 py-2 font-medium w-24">判定</th>
                  </tr>
                </thead>
                <tbody>
                  {g.items.map((c, i) => {
                    const st = STATUS_STYLE[c.status]
                    return (
                      <tr key={i} className="border-b border-gray-50 align-top">
                        <td className="px-3 py-2">
                          <div className="font-medium text-gray-800">{c.name}</div>
                          {c.note && <div className="text-[11px] text-gray-500 mt-0.5">{c.note}</div>}
                        </td>
                        <td className="px-3 py-2 text-right whitespace-nowrap">
                          <div className="text-[11px] text-gray-500">{c.leftLabel}</div>
                          <div className={'font-mono ' + (c.leftValue == null ? 'text-gray-400' : 'text-gray-800')}>
                            {fmt(c.leftValue)}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right whitespace-nowrap">
                          <div className="text-[11px] text-gray-500">{c.rightLabel}</div>
                          <div className={'font-mono ' + (c.rightValue == null ? 'text-gray-400' : 'text-gray-800')}>
                            {fmt(c.rightValue)}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right whitespace-nowrap font-mono">
                          {c.diff == null ? (
                            <span className="text-gray-400">－</span>
                          ) : c.diff === 0 ? (
                            <span className="text-green-700">0</span>
                          ) : (
                            <span className="text-amber-700 font-bold">{fmt(c.diff)}</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-center">
                          <span className={'inline-block px-2 py-0.5 rounded-full text-[11px] font-bold ' + st.cls}>
                            {st.label}
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>
        ))}

        {/* ページ認識結果 */}
        {result && (
          <section className="bg-white rounded-xl border border-gray-200">
            <button
              className="w-full px-4 py-2.5 text-left text-sm font-bold text-gray-700 flex justify-between items-center"
              onClick={() => setShowPages((v) => !v)}
            >
              <span>📑 ページの認識結果（{result.pageSummary.length}ページ）</span>
              <span className="text-gray-400">{showPages ? '▲' : '▼'}</span>
            </button>
            {showPages && (
              <div className="px-4 pb-3 grid grid-cols-1 sm:grid-cols-2 gap-x-6 text-xs text-gray-600">
                {result.pageSummary.map((s) => (
                  <div key={s.page} className="py-0.5 border-b border-gray-50 flex justify-between">
                    <span>p{s.page}</span>
                    <span className={s.detected.includes('対象外') ? 'text-gray-400' : ''}>{s.detected}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {result && (
          <p className="text-[11px] text-gray-500 leading-relaxed">
            ※ 本チェックはPDFのテキスト情報から機械的に金額を照合するものです。様式・会計ソフトのレイアウトによっては
            金額を検出できない場合があります（「検出不可」表示）。⚠の項目も誤りとは限りません（各項目の注記参照）。
            最終判断は必ず元の書類でご確認ください。データはすべてこの端末内で処理され、外部には送信されません。
          </p>
        )}
      </main>
    </div>
  )
}
