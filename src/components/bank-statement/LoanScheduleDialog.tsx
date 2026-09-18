'use client'

/**
 * 借入金の返済予定表（償還予定表）の登録・編集。
 *
 * 通帳に出てくるのは償還額（元本＋利息）の1本だけで、内訳はどこにも書いていない。
 * 内訳は銀行の予定表にしかないので、ここで取り込んでおき、通帳の解析のときに
 * 「同じころの日付・同じ償還額の出金」へ当てて、元本と利息に分けた複合仕訳を作る。
 *
 * 取り込みは通帳CSVと同じ列マッピング方式にしてある（銀行ごとに様式が違うため）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { parseExcel } from '@/lib/bank-statement/excel-parser'
import {
  loadLoanSchedules, saveLoanSchedules, newLoanScheduleId,
  parseLoanSchedule, DEFAULT_DATE_TOLERANCE,
} from '@/lib/bank-statement/loan-schedule-store'
import type {
  LoanSchedule, LoanScheduleMapping, ParsedSchedule,
} from '@/lib/bank-statement/loan-schedule-store'
import type { RawTableRow, AccountItem, SubAccountItem } from '@/lib/bank-statement/types'

interface Props {
  clientId: string
  accountMaster: AccountItem[]
  subAccountMaster: SubAccountItem[]
  onClose: () => void
  /** 保存したあと、呼び出し側が持っている一覧を更新するため */
  onSaved?: (list: LoanSchedule[]) => void
}

const ROLES = [
  { key: 'dateColumn', label: '償還予定日', color: 'bg-blue-100 border-blue-400' },
  { key: 'totalColumn', label: '償還額', color: 'bg-yellow-100 border-yellow-400' },
  { key: 'principalColumn', label: '元本額', color: 'bg-emerald-100 border-emerald-400' },
  { key: 'interestColumn', label: '利息額', color: 'bg-red-100 border-red-400' },
  { key: 'balanceColumn', label: '融資残高', color: 'bg-purple-100 border-purple-400' },
] as const

const yen = (n: number) => Math.round(n).toLocaleString('ja-JP')

/** 見出しの語から列を推測する（当たらなくても手で選べるので、外れても害はない） */
function guessMapping(rows: RawTableRow[]): LoanScheduleMapping {
  const m: LoanScheduleMapping = { dateColumn: -1, totalColumn: -1, principalColumn: -1, interestColumn: -1 }
  for (const r of rows.slice(0, 12)) {
    r.cells.forEach((c, i) => {
      const t = String(c || '')
      // 見出しらしい短いセルだけを見る。予定表の上部にある説明文（「…返済期日 R31.09.28…」）を
      // 見出しと取り違えて、まったく別の列を選んでしまうため
      if (!t || t.length > 12) return
      if (m.dateColumn < 0 && /(返済|償還|支払|引落).*日/.test(t) && !/和暦/.test(t)) m.dateColumn = i
      if (m.totalColumn < 0 && /(返済|償還)額|返済金額|元利.*計|合計/.test(t)) m.totalColumn = i
      if (m.principalColumn < 0 && /元本|元金/.test(t)) m.principalColumn = i
      if (m.interestColumn < 0 && /利息|利子/.test(t)) m.interestColumn = i
      if (m.balanceColumn == null && /残高/.test(t)) m.balanceColumn = i
    })
  }
  return m
}

export default function LoanScheduleDialog({
  clientId, accountMaster, subAccountMaster, onClose, onSaved,
}: Props) {
  const [list, setList] = useState<LoanSchedule[]>([])
  const [sel, setSel] = useState('')
  // 取り込み中の表（ファイルを読んだ直後だけ入る）
  const [sheets, setSheets] = useState<{ name: string; rows: RawTableRow[] }[]>([])
  const [sheetIdx, setSheetIdx] = useState(0)
  const [map, setMap] = useState<LoanScheduleMapping | null>(null)
  const [activeRole, setActiveRole] = useState<string>('dateColumn')
  const [fileName, setFileName] = useState('')
  const [err, setErr] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const l = loadLoanSchedules(clientId)
    setList(l)
    setSel(l[0]?.id ?? '')
  }, [clientId])

  const cur = list.find((s) => s.id === sel) ?? null
  const update = (id: string, patch: Partial<LoanSchedule>) =>
    setList((l) => l.map((s) => (s.id === id ? { ...s, ...patch, updatedAt: Date.now() } : s)))

  const rawRows = sheets[sheetIdx]?.rows ?? []
  const maxCols = Math.max(0, ...rawRows.map((r) => r.cells.length))
  const preview: ParsedSchedule | null = useMemo(
    () => (map && rawRows.length ? parseLoanSchedule(rawRows, map) : null),
    [map, rawRows],
  )

  const readFile = async (f: File) => {
    setErr('')
    try {
      const pages = await parseExcel(f)
      const sh = pages.map((p) => ({ name: p.sheetName, rows: p.rows })).filter((p) => p.rows.length)
      if (!sh.length) { setErr('表を読み取れませんでした。'); return }
      setSheets(sh)
      setSheetIdx(0)
      setFileName(f.name)
      setMap(guessMapping(sh[0].rows))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  const clickColumn = (i: number) => {
    if (!map) return
    setMap((prev) => {
      if (!prev) return prev
      const next: Record<string, number> = { ...(prev as unknown as Record<string, number>) }
      // 同じ列を別の役割から外してから割り当てる（1列=1役割）
      for (const k of Object.keys(next)) if (next[k] === i && k !== activeRole) next[k] = -1
      next[activeRole] = next[activeRole] === i ? -1 : i
      return next as unknown as LoanScheduleMapping
    })
  }
  const roleOf = (i: number): string | null => {
    if (!map) return null
    for (const [k, v] of Object.entries(map)) if (v === i) return k
    return null
  }

  /** 読み取った回を、新しい借入として登録する（既存を選んでいれば差し替える） */
  const applyImport = (replaceId?: string) => {
    if (!preview || !preview.rows.length) return
    if (replaceId) {
      update(replaceId, { rows: preview.rows, mapping: map!, fileName })
      setSel(replaceId)
    } else {
      const s: LoanSchedule = {
        id: newLoanScheduleId(),
        name: fileName.replace(/\.[^.]+$/, ''),
        principalCode: '', principalName: '', interestCode: '', interestName: '',
        rows: preview.rows, mapping: map!, fileName, updatedAt: Date.now(),
      }
      setList((l) => [...l, s])
      setSel(s.id)
    }
    setSheets([]); setMap(null); setFileName('')
  }

  const save = () => {
    saveLoanSchedules(clientId, list)
    onSaved?.(list)
    onClose()
  }

  const subsOf = (parentCode: string) =>
    subAccountMaster.filter((s) => s.parentCode === parentCode)

  /** 科目の入力欄（"コード:名前" のリストから選ぶ。通帳の内訳列と同じ書き方） */
  const AccountPicker = ({ label, code, name, subCode, onPick, onPickSub }: {
    label: string
    code: string; name: string; subCode?: string
    onPick: (code: string, name: string) => void
    onPickSub: (subCode: string, subName: string) => void
  }) => {
    const subs = subsOf(code)
    return (
      <div className="flex items-center gap-2 mb-1.5">
        <span className="w-20 shrink-0 text-xs text-gray-500">{label}</span>
        <select
          value={code}
          onChange={(e) => {
            const a = accountMaster.find((x) => x.code === e.target.value)
            onPick(a?.code || '', a ? (a.shortName || a.name) : '')
            onPickSub('', '')
          }}
          className="flex-1 min-w-0 px-1.5 py-1 text-xs border border-gray-300 rounded"
        >
          <option value="">（科目を選ぶ）</option>
          {accountMaster.map((a) => (
            <option key={a.code} value={a.code}>{a.code}:{a.shortName || a.name}</option>
          ))}
        </select>
        <select
          value={subCode || ''}
          onChange={(e) => {
            const s = subs.find((x) => x.subCode === e.target.value)
            onPickSub(s?.subCode || '', s ? (s.shortName || s.name) : '')
          }}
          disabled={!subs.length}
          className="w-44 shrink-0 px-1.5 py-1 text-xs border border-gray-300 rounded disabled:bg-gray-50 disabled:text-gray-400"
        >
          <option value="">{subs.length ? '（補助なし）' : '補助科目なし'}</option>
          {subs.map((s) => (
            <option key={s.subCode} value={s.subCode}>{s.subCode}:{s.shortName || s.name}</option>
          ))}
        </select>
        {!!name && <span className="text-[10px] text-gray-400 shrink-0">{name}</span>}
      </div>
    )
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-full max-w-5xl max-h-[92vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-gray-200 flex items-center justify-between">
          <h2 className="font-semibold text-gray-800">借入金の返済予定表</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        <div className="px-5 py-2.5 text-xs text-gray-600 bg-gray-50 border-b border-gray-200 leading-relaxed">
          銀行の返済予定表を取り込んでおくと、通帳の解析で<b>同じころの日付・同じ償還額の出金</b>を見つけたときに、
          <b>元本（借入金）と利息（支払利息）に分けた複合仕訳</b>を自動で作ります。
          償還額は<b>完全一致</b>のときだけ当てます（金額が違う回は繰上返済・金利変更とみなし、当てません）。
          作った仕訳には一覧の「学習」欄に <span className="text-sky-600 font-bold">予</span> の印が付きます。
        </div>

        {/* ---------------- 取り込み中（ファイルを読んだ直後） ---------------- */}
        {sheets.length > 0 && map ? (
          <div className="flex-1 overflow-auto p-4">
            <div className="flex items-center gap-2 flex-wrap mb-2">
              <span className="text-xs text-gray-500">{fileName}</span>
              {sheets.length > 1 && (
                <select value={sheetIdx}
                  onChange={(e) => { const i = Number(e.target.value); setSheetIdx(i); setMap(guessMapping(sheets[i].rows)) }}
                  className="px-1.5 py-1 text-xs border border-gray-300 rounded">
                  {sheets.map((s, i) => <option key={i} value={i}>{s.name}</option>)}
                </select>
              )}
              <button onClick={() => { setSheets([]); setMap(null) }}
                className="ml-auto px-2 py-1 text-xs bg-gray-100 rounded hover:bg-gray-200">取り込みをやめる</button>
            </div>

            <div className="flex gap-2 flex-wrap mb-1">
              {ROLES.map((r) => {
                const v = (map as unknown as Record<string, number>)[r.key] ?? -1
                return (
                  <button key={r.key} onClick={() => setActiveRole(r.key)}
                    className={`px-3 py-1.5 text-sm rounded border ${
                      activeRole === r.key ? `${r.color} border-2 font-bold` : 'bg-gray-50 border-gray-200 text-gray-600'
                    } ${v >= 0 ? 'ring-2 ring-offset-1' : ''}`}>
                    {v >= 0 ? `${r.label} (列${v + 1})` : r.label}
                  </button>
                )
              })}
            </div>
            <p className="text-xs text-gray-400 mb-2">
              上のボタンで役割を選び、下の表の列見出しをクリックしてください。
              見出しの語から当たりを付けてありますが、違っていれば選び直せます。
            </p>

            <div className="overflow-auto max-h-[38vh] border border-gray-200 rounded">
              <table className="w-full text-xs border-collapse">
                <thead className="sticky top-0 bg-white">
                  <tr>
                    {Array.from({ length: maxCols }, (_, i) => (
                      <th key={i} onClick={() => clickColumn(i)}
                        className={`border border-gray-300 px-2 py-2 cursor-pointer hover:bg-blue-50 min-w-[80px] ${
                          ROLES.find((r) => r.key === roleOf(i))?.color || ''}`}>
                        <span className="block text-gray-400">列{i + 1}</span>
                        {roleOf(i) && (
                          <span className="block font-bold text-gray-700 mt-0.5">
                            {ROLES.find((r) => r.key === roleOf(i))?.label}
                          </span>
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rawRows.slice(0, 20).map((r, i) => (
                    <tr key={i} className={i % 2 ? 'bg-gray-50' : ''}>
                      {Array.from({ length: maxCols }, (_, c) => (
                        <td key={c} className={`border border-gray-200 px-2 py-1 truncate max-w-[160px] ${
                          ROLES.find((x) => x.key === roleOf(c))?.color || ''}`}>{r.cells[c] || ''}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {preview && (
              <div className="mt-3 text-xs">
                <div className="text-gray-700">
                  読み取れた回: <b>{preview.rows.length}件</b>
                  {preview.rows.length > 0 && <>（{preview.rows[0].date} 〜 {preview.rows[preview.rows.length - 1].date}）</>}
                  <span className="text-gray-400 ml-2">／ 見出し・空行など {preview.skipped}行は対象外</span>
                </div>
                {preview.mismatched.length > 0 && (
                  <div className="mt-1 px-2 py-1.5 bg-amber-50 border border-amber-200 rounded text-amber-800">
                    元本＋利息が償還額と合わない回が {preview.mismatched.length}件あります
                    （例: {preview.mismatched[0].date} 償還額 {yen(preview.mismatched[0].total)} ／
                    元本 {yen(preview.mismatched[0].principal)} ＋ 利息 {yen(preview.mismatched[0].interest)}）。
                    列の選び方が違うかもしれません。<b>この回には仕訳を当てません</b>（貸借が合わなくなるため）。
                  </div>
                )}
              </div>
            )}

            <div className="mt-3 flex gap-2 justify-end">
              {cur && (
                <button onClick={() => applyImport(cur.id)} disabled={!preview?.rows.length}
                  className="px-4 py-2 text-sm bg-amber-500 text-white rounded hover:bg-amber-600 disabled:opacity-40">
                  「{cur.name || '選択中'}」の予定を差し替える
                </button>
              )}
              <button onClick={() => applyImport()} disabled={!preview?.rows.length}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-40">
                新しい借入として登録する
              </button>
            </div>
          </div>
        ) : (
          /* ---------------- 一覧・編集 ---------------- */
          <div className="flex-1 overflow-hidden flex">
            <div className="w-56 shrink-0 border-r border-gray-200 overflow-auto p-2">
              {list.map((s) => (
                <button key={s.id} onClick={() => setSel(s.id)}
                  className={`w-full text-left px-2 py-1.5 mb-1 rounded text-xs ${
                    s.id === sel ? 'bg-blue-50 border border-blue-300' : 'hover:bg-gray-50 border border-transparent'}`}>
                  <div className="font-medium text-gray-800 truncate">{s.name || '（名称未設定）'}</div>
                  <div className="text-[10px] text-gray-400">
                    {s.rows.length}回
                    {!s.principalCode || !s.interestCode ? <span className="text-red-500 ml-1">科目が未設定</span> : null}
                  </div>
                </button>
              ))}
              <button onClick={() => fileRef.current?.click()}
                className="w-full px-2 py-1.5 text-xs bg-blue-50 text-blue-700 rounded hover:bg-blue-100">
                ＋ 予定表を取り込む
              </button>
              <input ref={fileRef} type="file" accept=".xlsx,.xls,.xlsm,.ods,.csv" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void readFile(f) }} />
              {err && <p className="text-[10px] text-red-500 mt-1">{err}</p>}
            </div>

            <div className="flex-1 overflow-auto p-4">
              {!cur ? (
                <p className="text-sm text-gray-500 py-8 text-center">
                  左の「＋ 予定表を取り込む」から、銀行の返済予定表（Excel・CSV）を読み込んでください。
                </p>
              ) : (
                <>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="w-20 shrink-0 text-xs text-gray-500">名称</span>
                    <input value={cur.name} placeholder="例) 筑波銀行 ひたちなか支店"
                      onChange={(e) => update(cur.id, { name: e.target.value })}
                      className="flex-1 px-2 py-1 text-xs border border-gray-300 rounded" />
                  </div>

                  <AccountPicker label="元本の科目" code={cur.principalCode} name={cur.principalName} subCode={cur.principalSubCode}
                    onPick={(c, n) => update(cur.id, { principalCode: c, principalName: n })}
                    onPickSub={(c, n) => update(cur.id, { principalSubCode: c, principalSubName: n })} />
                  <AccountPicker label="利息の科目" code={cur.interestCode} name={cur.interestName} subCode={cur.interestSubCode}
                    onPick={(c, n) => update(cur.id, { interestCode: c, interestName: n })}
                    onPickSub={(c, n) => update(cur.id, { interestSubCode: c, interestSubName: n })} />

                  <div className="flex items-center gap-2 mb-2">
                    <span className="w-20 shrink-0 text-xs text-gray-500">日付のずれ</span>
                    <input type="number" value={cur.dateTolerance ?? DEFAULT_DATE_TOLERANCE}
                      onChange={(e) => update(cur.id, { dateTolerance: Math.max(0, Number(e.target.value) || 0) })}
                      className="w-20 px-2 py-1 text-xs border border-gray-300 rounded" />
                    <span className="text-[11px] text-gray-400">
                      日まで許容（実際の引落日が休日順延で予定日とずれるため）
                    </span>
                  </div>

                  {(!cur.principalCode || !cur.interestCode) && (
                    <div className="px-2 py-1.5 mb-2 text-xs bg-red-50 border border-red-200 rounded text-red-700">
                      元本と利息の科目を両方えらぶまで、この予定表は通帳の仕訳に使いません。
                    </div>
                  )}

                  <div className="text-xs text-gray-500 mb-1">
                    取り込んだ回: {cur.rows.length}件
                    {cur.fileName && <span className="ml-2 text-gray-400">（{cur.fileName}）</span>}
                  </div>
                  <div className="overflow-auto max-h-[38vh] border border-gray-200 rounded">
                    <table className="w-full text-xs border-collapse">
                      <thead className="sticky top-0 bg-gray-50">
                        <tr className="text-gray-600">
                          <th className="text-left px-2 py-1 border-b border-gray-200">償還予定日</th>
                          <th className="text-right px-2 py-1 border-b border-gray-200">償還額</th>
                          <th className="text-right px-2 py-1 border-b border-gray-200">元本額</th>
                          <th className="text-right px-2 py-1 border-b border-gray-200">利息額</th>
                          <th className="text-right px-2 py-1 border-b border-gray-200">融資残高</th>
                        </tr>
                      </thead>
                      <tbody>
                        {cur.rows.map((r, i) => (
                          <tr key={i} className={r.principal + r.interest !== r.total ? 'bg-amber-50' : ''}>
                            <td className="px-2 py-1 border-b border-gray-100">{r.date}</td>
                            <td className="px-2 py-1 border-b border-gray-100 text-right tabular-nums">{yen(r.total)}</td>
                            <td className="px-2 py-1 border-b border-gray-100 text-right tabular-nums">{yen(r.principal)}</td>
                            <td className="px-2 py-1 border-b border-gray-100 text-right tabular-nums">{yen(r.interest)}</td>
                            <td className="px-2 py-1 border-b border-gray-100 text-right tabular-nums text-gray-500">
                              {r.balance != null ? yen(r.balance) : ''}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="mt-2 flex gap-2">
                    <button onClick={() => fileRef.current?.click()}
                      className="px-3 py-1.5 text-xs bg-gray-100 rounded hover:bg-gray-200">
                      予定表を読み直す（借換・条件変更のとき）
                    </button>
                    <button onClick={() => {
                      if (!confirm(`「${cur.name || '（名称未設定）'}」を削除しますか？`)) return
                      setList((l) => l.filter((s) => s.id !== cur.id)); setSel('')
                    }} className="px-3 py-1.5 text-xs text-red-600 bg-red-50 rounded hover:bg-red-100">
                      この借入を削除
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        <div className="px-5 py-3 border-t border-gray-200 flex justify-end gap-2">
          <button onClick={onClose} className="px-5 py-2 text-sm bg-gray-100 rounded hover:bg-gray-200">キャンセル</button>
          <button onClick={save} className="px-5 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700">保存する</button>
        </div>
      </div>
    </div>
  )
}
