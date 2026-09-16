'use client'

/**
 * 顧問先へ渡すJSONの書き出しダイアログ。
 *
 * 試算表（取込済みの全期）は必ず入れる。元帳は任意で、
 *   ・入れるのは当期の1期だけ（3期入れるとファイルが3倍になる）
 *   ・科目単位で除ける（給料手当・役員報酬・事業主貸など、顧問先の画面に
 *     個人名や役員個人の支払が出ると困るもの）
 * を選べるようにしてある。**元帳を入れると顧問先アプリで見えるものが増える**ので、
 * 既定は「入れない」にし、選んだときだけ同梱する。
 */
import { useEffect, useMemo, useState } from 'react'
import type { FiscalYearData } from '@/lib/keiei/types'
import type { LedgerData } from '@/lib/keiei/ledger'
import { listLedgers } from '@/lib/keiei/ledger-store'
import { sortedYears } from '@/lib/keiei/calc'
import { toExportLedger } from '@/lib/keiei/export-data'
import type { KeieiExportLedger } from '@/lib/keiei/export-data'

/** 既定で除く候補（個人名・役員個人の支払が摘要に出やすい科目） */
const SENSITIVE = /給料|給与|役員報酬|賞与|退職金|事業主貸|事業主借|専従者/

const kb = (n: number) => (n < 1024 * 1024
  ? `${Math.round(n / 1024).toLocaleString('ja-JP')}KB`
  : `${(n / 1024 / 1024).toFixed(1)}MB`)

export function ExportJsonDialog({ clientId, years, onClose, onExport }: {
  clientId: string
  years: Record<string, FiscalYearData>
  onClose: () => void
  onExport: (ledger?: KeieiExportLedger) => void
}) {
  const list = useMemo(() => sortedYears(years), [years])
  const latestId = list.length ? list[list.length - 1].id : ''
  const [ledgers, setLedgers] = useState<{ yearId: string; data: LedgerData }[] | null>(null)
  const [withLedger, setWithLedger] = useState(false)
  const [yearId, setYearId] = useState(latestId)
  const [excluded, setExcluded] = useState<Set<string>>(new Set())

  useEffect(() => {
    let alive = true
    void listLedgers(clientId).then(l => { if (alive) setLedgers(l) }).catch(() => { if (alive) setLedgers([]) })
    return () => { alive = false }
  }, [clientId])

  const picked = ledgers?.find(l => l.yearId === yearId) ?? null
  // 元帳の年度idは取込時のもの。期を選び直せるよう、取り込んである元帳の一覧から選ぶ
  const accounts = useMemo(
    () => (picked ? picked.data.accounts.map(a => ({ name: a.name, n: a.txs.length })) : []),
    [picked],
  )

  // 既定で「個人名が出やすい科目」にチェックを入れておく
  useEffect(() => {
    if (!picked) return
    setExcluded(new Set(picked.data.accounts.filter(a => SENSITIVE.test(a.name)).map(a => a.name)))
  }, [picked])

  const built = useMemo(() => {
    if (!withLedger || !picked) return undefined
    return toExportLedger({
      yearId: picked.yearId, data: picked.data, excludeAccounts: Array.from(excluded),
    })
  }, [withLedger, picked, excluded])

  const size = useMemo(() => (built ? JSON.stringify(built.rows).length : 0), [built])

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl"
        onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b flex items-center">
          <h3 className="text-lg font-semibold">顧問先へ渡すJSONの書き出し</h3>
          <button className="ml-auto text-gray-400 hover:text-gray-700" onClick={onClose}>✕</button>
        </div>

        <div className="px-5 py-4 overflow-y-auto space-y-4 text-sm">
          <div>
            <div className="font-semibold mb-1">試算表（月次推移）</div>
            <div className="text-gray-600">
              取込済みの {list.length}期（{list.map(y => y.label).join('・')}）をすべて入れます。
            </div>
          </div>

          <div className="border-t pt-4">
            <label className="flex items-start gap-2 cursor-pointer">
              <input type="checkbox" className="mt-1" checked={withLedger}
                disabled={!ledgers || ledgers.length === 0}
                onChange={e => setWithLedger(e.target.checked)} />
              <span>
                <b>元帳の明細も入れる</b>
                <span className="block text-gray-600 mt-0.5">
                  顧問先の画面で「金額から明細へ降りる」「取引先ごとの集計」「取引先の月別」が
                  使えるようになります。
                  {ledgers && ledgers.length === 0 && (
                    <b className="text-amber-700 block">
                      この顧問先はまだ元帳を取り込んでいないため選べません。
                    </b>
                  )}
                </span>
              </span>
            </label>
          </div>

          {withLedger && ledgers && ledgers.length > 0 && (
            <div className="pl-6 space-y-3">
              <div>
                <label className="block text-gray-600 mb-1">入れる期（1期だけ）</label>
                <select className="border rounded px-2 py-1" value={yearId}
                  onChange={e => setYearId(e.target.value)}>
                  {ledgers.map(l => (
                    <option key={l.yearId} value={l.yearId}>
                      {years[l.yearId]?.label || l.yearId}（{l.data.txCount.toLocaleString('ja-JP')}件・
                      {l.data.minDate}〜{l.data.maxDate}）
                    </option>
                  ))}
                </select>
                <div className="text-gray-500 text-xs mt-1">
                  3期ぶん入れるとファイルが3倍になります。顧問先が見たいのはたいてい当期です。
                </div>
              </div>

              <div>
                <div className="text-gray-600 mb-1">
                  入れない科目
                  <span className="text-xs text-gray-500 ml-2">
                    摘要に個人名や役員個人の支払が出る科目は、あらかじめ外してあります
                  </span>
                </div>
                <div className="border rounded max-h-52 overflow-y-auto p-2 grid grid-cols-2 gap-x-3 gap-y-1">
                  {accounts.map(a => (
                    <label key={a.name} className="flex items-center gap-1.5 cursor-pointer">
                      <input type="checkbox" checked={excluded.has(a.name)}
                        onChange={e => {
                          const s = new Set(excluded)
                          if (e.target.checked) s.add(a.name); else s.delete(a.name)
                          setExcluded(s)
                        }} />
                      <span className={excluded.has(a.name) ? 'text-gray-400 line-through' : ''}>
                        {a.name}<span className="text-gray-400 text-xs ml-1">{a.n}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              {built && (
                <div className="bg-blue-50 rounded p-2 text-blue-900">
                  同梱する明細 <b>{built.rows.length.toLocaleString('ja-JP')}件</b>
                  （おおよそ {kb(size)}）
                  {built.excluded && built.excluded.length > 0 && (
                    <span className="block text-xs mt-0.5">
                      除いた科目: {built.excluded.join('・')}
                    </span>
                  )}
                </div>
              )}

              <div className="bg-amber-50 text-amber-900 rounded p-2 text-xs leading-relaxed">
                元帳を入れると、これまで顧問先に見えなかった<b>摘要の中身</b>（取引先名・
                個人名など）が顧問先の画面に出ます。誰がその画面を見るかを確かめてから入れてください。
              </div>
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t flex justify-end gap-2">
          <button className="px-4 py-2 rounded-lg border" onClick={onClose}>キャンセル</button>
          <button className="px-4 py-2 rounded-lg bg-blue-600 text-white font-semibold"
            onClick={() => onExport(built)}>
            書き出す
          </button>
        </div>
      </div>
    </div>
  )
}
