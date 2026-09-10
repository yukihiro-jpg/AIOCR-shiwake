'use client'

/**
 * 元帳の取込。
 *
 * 会計ソフトが書き出した総勘定元帳CSVを読み込み、取引先ごとの集計に使えるようにする。
 * ファイルは外部に送らず、ブラウザの中だけで解析する。
 *
 * 【この総合管理アプリでの作り】
 * 移植元は元帳を専用の保存先（Firestore）に持っていたが、こちらは元から
 * 元帳の解析（lib/keiei/ledger.ts）と保存（lib/keiei/ledger-store.ts = IndexedDB）があり、
 * 税務チェックの会計監査も同じデータを見ている。取込の入口を2つ作ると同じCSVを
 * 2回取り込むことになるため、**解析も保存も既存の1本に統一**した。
 * ここで取り込んだ元帳は、税務チェックの会計監査でもそのまま使える。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { decodeCsv } from '@/lib/keiei/parse'
import { parseLedgerCsv, findMatchingFy, fyPeriod, type LedgerData } from '@/lib/keiei/ledger'
import { saveLedger, listLedgers, deleteLedger } from '@/lib/keiei/ledger-store'
import { getState, api } from '@/lib/keiei/kr/api'
import { invalidateLedger } from '@/lib/keiei/kr/ledger/useLedger'
import { sortedYears } from '@/lib/keiei/kr/analysis'
import { NeedData } from '../ui'

const yen = (n: number) => Math.round(n).toLocaleString('ja-JP')

export default function LedgerImport({ onImported }: { onImported?: () => void }) {
  const state = getState()
  const years = sortedYears(state)
  const clientId = api.clientId()
  const fileRef = useRef<HTMLInputElement>(null)
  const [list, setList] = useState<{ yearId: string; data: LedgerData }[]>([])
  const [busy, setBusy] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const reload = useCallback(() => {
    if (!clientId) return
    listLedgers(clientId).then(setList).catch((e) => setError(String(e)))
  }, [clientId])
  useEffect(() => { reload() }, [reload])

  const pick = async (file: File) => {
    setError(null); setMsg(null); setBusy('読み込んでいます…')
    try {
      const data = parseLedgerCsv(decodeCsv(await file.arrayBuffer()), file.name)
      // どの期の元帳かは、取込済みの月次データの期間と突き合わせて自動で決める
      const fy = findMatchingFy(data, Object.fromEntries(years.map((y) => [y.id, y])) as never)
      if (!fy) {
        setError(
          `この元帳（${data.minDate}〜${data.maxDate}）に対応する期が見つかりません。` +
          '先に月次推移データを取り込むか、元帳の期間をご確認ください。',
        )
        return
      }
      await saveLedger(clientId, fy.id, data)
      invalidateLedger()
      setMsg(`${fy.label}の元帳として取り込みました（${data.accounts.length}科目・${data.txCount}明細）。`)
      reload()
      onImported?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy('')
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const remove = async (yearId: string, label: string) => {
    if (!confirm(`${label}の元帳を削除します。よろしいですか？\n（税務チェックの会計監査でも使えなくなります）`)) return
    await deleteLedger(clientId, yearId)
    invalidateLedger()
    reload()
    onImported?.()
  }

  if (!years.length) {
    return (
      <div>
        <h2 className="page-title">元帳の取込</h2>
        <NeedData />
      </div>
    )
  }

  return (
    <div>
      <h2 className="page-title">元帳の取込</h2>
      <p className="page-lead">
        総勘定元帳のCSVを取り込むと、「〇〇への支払合計」「修繕費の相手先別」といった
        取引先ごとの集計ができるようになります（AIに質問でも使われます）。
        ファイルはこのパソコンの中だけで解析し、外部へ送りません。
        <br />
        ここで取り込んだ元帳は<b>税務チェックの会計監査でもそのまま使えます</b>（取込は1回だけで済みます）。
      </p>

      <div className="card">
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          disabled={!!busy}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void pick(f) }}
        />
        {busy && <span className="muted" style={{ marginLeft: 10 }}>{busy}</span>}
        {error && <div className="warn-box" style={{ marginTop: 10 }}>{error}</div>}
        {msg && <div className="ok-box" style={{ marginTop: 10 }}>{msg}</div>}
      </div>

      <div className="card">
        <h3 className="card-title">取込済みの元帳</h3>
        {list.length === 0 ? (
          <p className="muted">まだ取り込まれていません。</p>
        ) : (
          <table className="kr-grid">
            <thead>
              <tr>
                <th>期</th><th>期間</th><th className="num">科目数</th><th className="num">明細数</th>
                <th>ファイル</th><th>取込日時</th><th></th>
              </tr>
            </thead>
            <tbody>
              {list.map((l) => {
                const y = years.find((x) => x.id === l.yearId)
                const label = y?.label || l.yearId
                return (
                  <tr key={l.yearId}>
                    <td>{label}</td>
                    <td>{l.data.minDate}〜{l.data.maxDate}</td>
                    <td className="num">{yen(l.data.accounts.length)}</td>
                    <td className="num">{yen(l.data.txCount)}</td>
                    <td>{l.data.fileName}</td>
                    <td>{new Date(l.data.importedAt).toLocaleString('ja-JP')}</td>
                    <td>
                      <button className="secondary small" onClick={() => void remove(l.yearId, label)}>削除</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
        {years.length > 0 && (
          <p className="muted" style={{ marginTop: 8, fontSize: 12 }}>
            対象にできる期: {years.map((y) => `${y.label}（${fyPeriod(y as never).start}〜${fyPeriod(y as never).end}）`).join('／')}
          </p>
        )}
      </div>
    </div>
  )
}
