'use client'

/**
 * 均等割の税率表を「貼り付け」で取り込む。
 *
 * 【テキストの貼り付けを主役にする】
 * 自治体のページの表は、選択してコピーするとタブ区切りの文字列になる。
 * これを読む経路なら **AIを使わず・通信もせず・数字を1桁も間違えない**。
 * スクリーンショットは、PDFしか無い／コピーできない自治体のための保険。
 * 画像を使う場合も、AIにさせるのは「表をそのまま書き写す」ことだけで、
 * どの区分か・どちらの列かの判断は端末側（parseEqTable）で行う。
 *
 * 読み取った結果は必ず表にして見せてから取り込む（金額を目で確かめられるように）。
 */
import { useState } from 'react'
import {
  parseEqTable, swapColumns, mergeParsedRates,
} from '@/lib/keiei/equalization-parse'
import type { ParsedEqTable, EqImportTarget } from '@/lib/keiei/equalization-parse'
import { capitalLabel } from '@/lib/keiei/equalization-presets'
import type { EqRate } from '@/lib/keiei/equalization-presets'
import { eqTableOcr } from '@/lib/bank-statement/gemini-client'

const yen = (n: number | null) => (n === null ? '—' : Math.round(n).toLocaleString('ja-JP'))

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error('画像を読み込めませんでした'))
    r.readAsDataURL(file)
  })
}

export function EqTableImport({ rates, onApply, onClose }: {
  rates: EqRate[]
  onApply: (next: EqRate[]) => void
  onClose: () => void
}) {
  const [text, setText] = useState('')
  const [target, setTarget] = useState<EqImportTarget>('city')
  const [parsed, setParsed] = useState<ParsedEqTable | null>(null)
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')

  const run = (t: string) => {
    setErr('')
    const p = parseEqTable(t)
    setParsed(p)
    if (p.rows.length === 0) setErr('表として読み取れませんでした。表の部分だけを選んでコピーし直すか、スクリーンショットを貼り付けてみてください。')
  }

  const ocr = async (images: string[]) => {
    setErr(''); setBusy('画像を読み取っています…')
    try {
      const t = await eqTableOcr(images)
      setText(t)
      run(t)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy('')
    }
  }

  const onPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items ?? [])
    const imgs = items.filter(it => it.kind === 'file' && it.type.startsWith('image/'))
    if (imgs.length === 0) return  // テキストの貼り付けはそのまま textarea に任せる
    e.preventDefault()
    const files = imgs.map(it => it.getAsFile()).filter((f): f is File => !!f)
    if (!files.length) return
    await ocr(await Promise.all(files.map(readAsDataUrl)))
  }

  const apply = () => {
    if (!parsed || parsed.rows.length === 0) return
    onApply(mergeParsedRates(rates, parsed.rows, target))
    onClose()
  }

  return (
    <div className="kr-drill-bg" onClick={onClose}>
      <div className="kr-drill" style={{ maxWidth: 760 }} onClick={e => e.stopPropagation()}>
        <div className="kr-drill-head">
          <b>税率表を貼り付けて取り込む</b>
          <button type="button" className="secondary small" onClick={onClose}>閉じる</button>
        </div>

        <div className="muted" style={{ marginBottom: 8 }}>
          自治体のページの表を選んでコピーし、下の枠に貼り付けてください（この経路はAIを使わないので確実です）。
          コピーできないページは、表のスクリーンショットをこの枠に貼り付けるか、画像を選んでください。
        </div>

        <label className="kr-basis-row" style={{ marginBottom: 8 }}>
          <span>取り込み先</span>
          <select value={target} onChange={e => setTarget(e.target.value as EqImportTarget)}>
            <option value="city">市町村分</option>
            <option value="pref">都道府県分</option>
          </select>
        </label>
        <div className="kr-basis-note" style={{ marginBottom: 8 }}>
          もう片方の金額は残るので、県のページと市のページを続けて貼れば1つの自治体が仕上がります。
          都道府県分で「均等割」と「森林湖沼環境税」のように列が分かれている表は、
          取り込んだあと一覧で合計額に直してください（読み取った数字はそのまま入ります）。
        </div>

        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          onPaste={onPaste}
          rows={7}
          placeholder={'ここに表を貼り付け（スクリーンショットの貼り付けも可）\n例）\n資本金等の額\t従業者数50人超\t従業者数50人以下\n1千万円以下\t144,000\t60,000'}
          style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }}
        />

        <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button type="button" className="secondary small" onClick={() => run(text)} disabled={!text.trim() || !!busy}>
            この内容を読み取る
          </button>
          <label className="secondary small" style={{ cursor: 'pointer', display: 'inline-block' }}>
            画像を選ぶ…
            <input type="file" accept="image/*" multiple style={{ display: 'none' }}
              onChange={async e => {
                const files = Array.from(e.target.files ?? [])
                e.target.value = ''
                if (files.length) await ocr(await Promise.all(files.map(readAsDataUrl)))
              }} />
          </label>
          {busy && <span className="muted">{busy}</span>}
          {err && <span style={{ color: '#c0392b' }}>{err}</span>}
        </div>

        {parsed && parsed.rows.length > 0 && (
          <>
            <div className="kr-basis-note" style={{ marginTop: 10 }}>
              {parsed.headerFound
                ? '見出しから列の並びを判定しました。'
                : '見出しが見つからなかったため、左が「50人超」として読みました。'}
              {' '}違っていれば入れ替えてください。
            </div>
            <table className="kr-grid" style={{ marginTop: 6 }}>
              <thead>
                <tr>
                  <th>資本金等の額</th>
                  <th className="num" style={{ width: 140 }}>50人超</th>
                  <th className="num" style={{ width: 140 }}>50人以下</th>
                </tr>
              </thead>
              <tbody>
                {parsed.rows.map((r, i) => (
                  <tr key={i}>
                    <td>{capitalLabel(r.capital)}</td>
                    <td className="num">{yen(r.over50)}</td>
                    <td className="num">{yen(r.under50)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {parsed.skipped.length > 0 && (
              <div className="kr-basis-note" style={{ marginTop: 6 }}>
                取り込まなかった行（資本金等の額の区分として読めなかったもの）:
                <ul style={{ margin: '4px 0 0 16px' }}>
                  {parsed.skipped.slice(0, 6).map((s, i) => <li key={i}>{s}</li>)}
                </ul>
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              <button type="button" className="secondary small"
                onClick={() => setParsed(swapColumns(parsed))}>
                ⇄ 50人超と50人以下を入れ替える
              </button>
            </div>
          </>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button type="button" className="secondary" onClick={onClose}>キャンセル</button>
          <button type="button" onClick={apply} disabled={!parsed || parsed.rows.length === 0}>
            {target === 'city' ? '市町村分' : '都道府県分'}として取り込む
          </button>
        </div>
      </div>
    </div>
  )
}
