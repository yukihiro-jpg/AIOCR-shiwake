'use client'

/**
 * 総合振込の内訳（銀行の総合振込明細）の取り込みと、振込先ごとの科目（取引先辞書）の設定。
 *
 * 通帳には総合振込の合計額が1行で引き落とされるだけなので、内訳の明細を取り込んでおき、
 * 通帳の解析で「同じころの日付・同じ合計額の出金」を見つけたら振込先ごとの複合仕訳にする。
 * 振込先の科目は振込先の名前で覚える（顔ぶれが月ごとに変わるため、通帳の摘要では覚えない）。
 *
 * 取り込みは通帳CSVと同じ列マッピング方式。明細1枚（Excelの1シート）が総合振込1回分。
 */
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { parseExcel } from '@/lib/bank-statement/excel-parser'
import {
  loadBulkTransfers, saveBulkTransfers, loadPayeeDict, savePayeeDict,
  newBulkTransferId, parseBulkSheet, normalizePayee, bulkTotal, bulkFeeTotal,
  resolvePayeeLines, lastBankOf, FEE_PAYEE, BULK_DATE_TOLERANCE,
} from '@/lib/bank-statement/bulk-transfer-store'
import type {
  BulkTransfer, BulkTransferRow, BulkTransferMapping, PayeeDict, PayeeAccount, PayeeLine,
} from '@/lib/bank-statement/bulk-transfer-store'
import { storageFullMessage } from '@/lib/bank-statement/storage-usage'
import type { RawTableRow, AccountItem, SubAccountItem } from '@/lib/bank-statement/types'

interface Props {
  clientId: string
  accountMaster: AccountItem[]
  subAccountMaster: SubAccountItem[]
  /** 明細だけで仕訳にする（mode='append' 仕訳一覧に追加／'csv' そのままCSV出力）。できたら true */
  onJournalize?: (t: BulkTransfer, payees: PayeeDict, includeFee: boolean, mode: 'append' | 'csv') => boolean
  onClose: () => void
}

const ROLES = [
  { key: 'dateColumn', label: '指定日', color: 'bg-blue-100 border-blue-400' },
  { key: 'payeeColumn', label: '受取人名', color: 'bg-green-100 border-green-400' },
  { key: 'amountColumn', label: '振込金額', color: 'bg-yellow-100 border-yellow-400' },
  { key: 'feeColumn', label: '手数料', color: 'bg-red-100 border-red-400' },
] as const

const yen = (n: number) => Math.round(n).toLocaleString('ja-JP')

/** 見出しの語から列を推測する（外れていれば手で選び直せる） */
function guessMapping(rows: RawTableRow[]): BulkTransferMapping {
  const m: BulkTransferMapping = { dateColumn: -1, payeeColumn: -1, amountColumn: -1 }
  let payAmount = -1
  for (const r of rows.slice(0, 10)) {
    r.cells.forEach((c, i) => {
      const t = String(c || '').trim()
      if (!t || t.length > 12) return
      if (m.dateColumn < 0 && /指定日|振込日|支払日|日付/.test(t)) m.dateColumn = i
      if (m.payeeColumn < 0 && /受取人|振込先|支払先|取引先|相手先/.test(t)) m.payeeColumn = i
      // 実際に口座から出ていくのは「振込金額」。無ければ「支払金額」「金額」
      if (m.amountColumn < 0 && /振込金額/.test(t)) m.amountColumn = i
      if (payAmount < 0 && /支払金額|^金額$/.test(t)) payAmount = i
      if (m.feeColumn == null && /手数料/.test(t)) m.feeColumn = i
    })
  }
  if (m.amountColumn < 0) m.amountColumn = payAmount
  return m
}

interface SheetDraft { name: string; rows: RawTableRow[]; include: boolean; date: string }

export default function BulkTransferDialog({ clientId, accountMaster, subAccountMaster, onJournalize, onClose }: Props) {
  const [tab, setTab] = useState<'list' | 'dict'>('list')
  const [list, setList] = useState<BulkTransfer[]>([])
  const [dict, setDict] = useState<PayeeDict>({})
  const [sel, setSel] = useState('')
  const [sheets, setSheets] = useState<SheetDraft[]>([])
  const [map, setMap] = useState<BulkTransferMapping | null>(null)
  const [activeRole, setActiveRole] = useState<string>('dateColumn')
  const [previewIdx, setPreviewIdx] = useState(0)
  const [fileName, setFileName] = useState('')
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')
  // 複合仕訳の編集を開いている振込先（行番号）
  const [openRow, setOpenRow] = useState<number | null>(null)
  // 明細だけで仕訳にするとき、手数料の行も作るか（手数料込みで引き落とされる銀行の場合）
  const [includeFee, setIncludeFee] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const l = loadBulkTransfers(clientId).sort((a, b) => b.date.localeCompare(a.date))
    setList(l)
    setDict(loadPayeeDict(clientId))
    setSel(l[0]?.id ?? '')
  }, [clientId])

  const cur = list.find((t) => t.id === sel) ?? null
  const parsed = useMemo(
    () => (map ? sheets.map((s) => parseBulkSheet(s.rows, map)) : []),
    [sheets, map],
  )

  const readFile = async (f: File) => {
    setErr('')
    try {
      const pages = await parseExcel(f)
      const sh = pages.filter((p) => p.rows.length).map((p) => ({ name: p.sheetName, rows: p.rows, include: true, date: '' }))
      if (!sh.length) { setErr('表を読み取れませんでした。'); return }
      const m = guessMapping(sh[0].rows)
      // シートごとの指定日を、読み取れた日付で初期化する（読めなければ手で入れてもらう）
      setSheets(sh.map((s) => ({ ...s, date: parseBulkSheet(s.rows, m).date })))
      setMap(m)
      setPreviewIdx(0)
      setFileName(f.name)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  const clickColumn = (i: number) => {
    setMap((prev) => {
      if (!prev) return prev
      const next: Record<string, number> = { ...(prev as unknown as Record<string, number>) }
      for (const k of Object.keys(next)) if (next[k] === i && k !== activeRole) next[k] = -1
      next[activeRole] = next[activeRole] === i ? -1 : i
      return next as unknown as BulkTransferMapping
    })
    // 列を変えたら指定日も読み直す（手で直した日付は、列を変えるまで残す）
  }
  useEffect(() => {
    if (!map) return
    setSheets((ss) => ss.map((s) => ({ ...s, date: parseBulkSheet(s.rows, map).date || s.date })))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map?.dateColumn, map?.payeeColumn, map?.amountColumn])

  const roleOf = (i: number): string | null => {
    if (!map) return null
    for (const [k, v] of Object.entries(map)) if (v === i) return k
    return null
  }

  const applyImport = () => {
    if (!map) return
    const added: BulkTransfer[] = []
    sheets.forEach((s, i) => {
      const p = parsed[i]
      if (!s.include || !p || !p.rows.length || !s.date) return
      added.push({
        id: newBulkTransferId(), date: s.date, rows: p.rows,
        fileName, sheetName: s.name, importedAt: Date.now(),
        // 引落口座は前回使った口座を初期値にする（同じ口座から振り込むことが多いため）
        ...(lastBankOf(list) || {}),
      })
    })
    if (!added.length) { setErr('登録できる明細がありません（指定日と振込金額の列を確認してください）。'); return }
    setList((l) => [...added, ...l].sort((a, b) => b.date.localeCompare(a.date)))
    setSel(added[0].id)
    setSheets([]); setMap(null); setFileName('')
  }

  const setPayee = (payee: string, patch: Partial<PayeeAccount> | null) => {
    const key = normalizePayee(payee)
    setDict((d) => {
      const next = { ...d }
      if (patch === null) { delete next[key]; return next }
      next[key] = { ...(next[key] || { payee, code: '', name: '' }), ...patch, payee, updatedAt: Date.now() }
      if (!next[key].code && !next[key].lines?.length) delete next[key]
      return next
    })
  }

  const updateCur = (patch: Partial<BulkTransfer>) =>
    setList((l) => l.map((t) => (t.id === sel ? { ...t, ...patch } : t)))

  /** その振込先の複合仕訳（この回の分 → 辞書の分）。無ければ null＝1行の仕訳 */
  const linesOf = (row: BulkTransferRow): PayeeLine[] | null =>
    row.lines?.length ? row.lines : dict[normalizePayee(row.payee)]?.lines?.length ? dict[normalizePayee(row.payee)].lines! : null

  /**
   * 振込先の複合仕訳を書き換える。この回の明細（金額つき）と、取引先辞書（次回の雛形）の両方へ入れる。
   * null で1行の仕訳に戻す。
   */
  const setRowLines = (rowIdx: number, lines: PayeeLine[] | null) => {
    const t = list.find((x) => x.id === sel); if (!t) return
    const row = t.rows[rowIdx]; if (!row) return
    updateCur({ rows: t.rows.map((r, i) => {
      if (i !== rowIdx) return r
      const { lines: _drop, ...rest } = r
      return lines ? { ...rest, lines } : rest
    }) })
    const key = normalizePayee(row.payee)
    setDict((d) => {
      const next = { ...d }
      const base = next[key] || { payee: row.payee, code: '', name: '' }
      if (lines) {
        const main = lines.find((l) => l.side === 'debit') || lines[0]
        next[key] = { ...base, payee: row.payee, code: main?.code || '', name: main?.name || '', lines, updatedAt: Date.now() }
      } else {
        const { lines: _drop, ...rest } = base
        next[key] = { ...rest, updatedAt: Date.now() }
        if (!next[key].code) delete next[key]
      }
      return next
    })
  }

  /** 明細の問題点（科目の空欄・貸借が合わない複合仕訳） */
  const problemsOf = (t: BulkTransfer): { blanks: number; unbalanced: string[] } => {
    let blanks = 0
    const unbalanced: string[] = []
    for (const r of t.rows) {
      const res = resolvePayeeLines(r, dict)
      if (!res.ok) unbalanced.push(r.payee)
      blanks += res.lines.filter((l) => !l.code).length
    }
    return { blanks, unbalanced }
  }

  /** 保存（書けなければ理由を出して false） */
  const persist = (nextList: BulkTransfer[]): boolean => {
    const bad = nextList.flatMap((t) => problemsOf(t).unbalanced.map((p) => `${t.date} ${p}`))
    if (bad.length) {
      alert('複合仕訳の貸借が合っていない振込先があります（借方計−貸方計が振込金額になっていません）：\n'
        + bad.slice(0, 8).map((x) => '・' + x).join('\n') + '\n\n金額を直すか、どれか1行の金額を空欄（差額）にしてください。')
      return false
    }
    const ok1 = saveBulkTransfers(clientId, nextList)
    const ok2 = savePayeeDict(clientId, dict)
    if (!ok1 || !ok2) {
      alert(storageFullMessage(!ok1 ? '総合振込の内訳' : '取引先辞書'))
      return false
    }
    return true
  }

  /** 通帳を使わずに、この明細だけで仕訳にする */
  const journalize = (mode: 'append' | 'csv') => {
    if (!cur || !onJournalize) return
    if (!cur.bankCode) { alert('引落口座（貸方に立てる預金の科目）を選んでください。'); return }
    const { unbalanced } = problemsOf(cur)
    if (unbalanced.length) { persist(list); return }  // 理由の表示は persist に任せる
    if (cur.journalizedAt && !confirm(
      `この明細は ${new Date(cur.journalizedAt).toLocaleString('ja-JP')} に仕訳済みです。もう一度作りますか？\n（会計大将へ二重に取り込まないようご注意ください）`,
    )) return
    if (!onJournalize(cur, dict, includeFee && bulkFeeTotal(cur) > 0, mode)) return
    // 仕訳済みを記録する（通帳の解析で同じ引落を二重に仕訳しないため）
    const nextList = list.map((t) => (t.id === cur.id ? { ...t, journalizedAt: Date.now() } : t))
    setList(nextList)
    if (!persist(nextList)) {
      alert('仕訳は作りましたが、「仕訳済み」の記録を保存できませんでした。通帳を解析すると、この総合振込がもう一度仕訳になるのでご注意ください。')
    }
    onClose()
  }

  const save = () => {
    if (!persist(list)) return
    onClose()
  }

  /** 科目と補助科目のプルダウン（値を受け取って返すだけの汎用版） */
  const acctPick = ({ code, subCode, onPick, width = 'w-32' }: {
    code: string; subCode?: string; width?: string
    onPick: (v: { code: string; name: string; subCode?: string; subName?: string }) => void
  }) => {
    const subs = code ? subAccountMaster.filter((s) => s.parentCode === code) : []
    const nameOf = (c: string) => { const a = accountMaster.find((x) => x.code === c); return a ? (a.shortName || a.name) : '' }
    return (
      <div className="flex gap-1 flex-1 min-w-0">
        <select value={code}
          onChange={(e) => onPick({ code: e.target.value, name: nameOf(e.target.value) })}
          className={`flex-1 min-w-0 px-1 py-0.5 text-xs border rounded ${code ? 'border-gray-300' : 'border-amber-400 bg-amber-50'}`}>
          <option value="">（科目を選ぶ）</option>
          {accountMaster.map((a) => <option key={a.code} value={a.code}>{a.code}:{a.shortName || a.name}</option>)}
        </select>
        <select value={subCode || ''} disabled={!subs.length}
          onChange={(e) => {
            const sb = subs.find((x) => x.subCode === e.target.value)
            onPick({ code, name: nameOf(code), subCode: sb?.subCode, subName: sb ? (sb.shortName || sb.name) : undefined })
          }}
          className={`${width} shrink-0 px-1 py-0.5 text-xs border border-gray-300 rounded disabled:bg-gray-50 disabled:text-gray-400`}>
          <option value="">{subs.length ? '（補助なし）' : '補助なし'}</option>
          {subs.map((sb) => <option key={sb.subCode} value={sb.subCode}>{sb.subCode}:{sb.shortName || sb.name}</option>)}
        </select>
      </div>
    )
  }

  /** 複合仕訳の編集（振込先1件ぶん） */
  const linesEditor = (row: BulkTransferRow, rowIdx: number) => {
    const lines = linesOf(row) || []
    const res = resolvePayeeLines({ ...row, lines }, dict)
    const upd = (i: number, patch: Partial<PayeeLine>) =>
      setRowLines(rowIdx, lines.map((l, j) => (j === i ? { ...l, ...patch } : l)))
    const dSum = res.lines.filter((l) => l.side === 'debit').reduce((a, l) => a + l.amount, 0)
    const cSum = res.lines.filter((l) => l.side === 'credit').reduce((a, l) => a + l.amount, 0)
    return (
      <div className="bg-teal-50/60 border border-teal-200 rounded px-2 py-2 space-y-1">
        {lines.map((l, i) => {
          const isRem = l.amount == null
          return (
            <div key={i} className="flex items-center gap-1">
              <select value={l.side} onChange={(e) => upd(i, { side: e.target.value as PayeeLine['side'] })}
                className="w-14 shrink-0 px-1 py-0.5 text-xs border border-gray-300 rounded">
                <option value="debit">借方</option>
                <option value="credit">貸方</option>
              </select>
              {acctPick({ code: l.code, subCode: l.subCode, width: 'w-28',
                onPick: (v) => upd(i, { code: v.code, name: v.name, subCode: v.subCode, subName: v.subName }) })}
              <input
                value={isRem ? '' : String(l.amount ?? '')}
                placeholder={isRem ? `差額 ${yen(res.lines[i]?.amount ?? 0)}` : '0'}
                onChange={(e) => {
                  const d = e.target.value.replace(/[^0-9]/g, '')
                  upd(i, { amount: d === '' ? undefined : Number(d) })
                }}
                className={`w-28 shrink-0 px-1 py-0.5 text-xs text-right tabular-nums border rounded ${isRem ? 'border-teal-400 bg-white' : 'border-gray-300'}`}
                title="空欄にすると差額（借方計−貸方計＝振込金額になるよう自動計算）。差額の行は1行だけにしてください" />
              <button onClick={() => setRowLines(rowIdx, lines.filter((_, j) => j !== i))}
                disabled={lines.length <= 1} className="px-1 text-xs text-red-500 disabled:text-gray-300">✕</button>
            </div>
          )
        })}
        <div className="flex items-center gap-2 pt-1">
          <button onClick={() => setRowLines(rowIdx, [...lines, { side: 'debit', code: '', name: '', amount: 0 }])}
            className="px-2 py-0.5 text-xs bg-white border border-teal-300 text-teal-700 rounded hover:bg-teal-50">＋ 行を追加</button>
          <button onClick={() => { setRowLines(rowIdx, null); setOpenRow(null) }}
            className="px-2 py-0.5 text-xs bg-white border border-gray-300 text-gray-600 rounded hover:bg-gray-50">1行の仕訳に戻す</button>
          <span className={`ml-auto text-xs tabular-nums ${res.ok ? 'text-teal-700' : 'text-red-600 font-bold'}`}>
            借方 {yen(dSum)} − 貸方 {yen(cSum)} ＝ {yen(dSum - cSum)}
            {res.ok ? '（振込金額と一致 ✓）' : `（振込金額 ${yen(row.amount)} と合いません）`}
          </span>
        </div>
        <div className="text-[10px] text-gray-500">
          金額を<b>空欄にした行が差額</b>になり、振込金額に合うよう自動で決まります（1行だけ）。
          科目の組み合わせと差額以外の金額は、この振込先の雛形として次回も使います。
        </div>
      </div>
    )
  }

  /** 科目と補助科目のプルダウン（振込先の辞書を直接書き換える） */
  const accountSel = (payee: string) => {
    const acc = dict[normalizePayee(payee)]
    const subs = acc?.code ? subAccountMaster.filter((s) => s.parentCode === acc.code) : []
    return (
      <div className="flex gap-1">
        <select value={acc?.code || ''}
          onChange={(e) => {
            const a = accountMaster.find((x) => x.code === e.target.value)
            setPayee(payee, a ? { code: a.code, name: a.shortName || a.name, subCode: undefined, subName: undefined } : { code: '' })
          }}
          className={`flex-1 min-w-0 px-1 py-0.5 text-xs border rounded ${acc?.code ? 'border-gray-300' : 'border-amber-400 bg-amber-50'}`}>
          <option value="">（科目を選ぶ）</option>
          {accountMaster.map((a) => <option key={a.code} value={a.code}>{a.code}:{a.shortName || a.name}</option>)}
        </select>
        <select value={acc?.subCode || ''} disabled={!subs.length}
          onChange={(e) => {
            const s = subs.find((x) => x.subCode === e.target.value)
            setPayee(payee, { subCode: s?.subCode, subName: s ? (s.shortName || s.name) : undefined })
          }}
          className="w-32 shrink-0 px-1 py-0.5 text-xs border border-gray-300 rounded disabled:bg-gray-50 disabled:text-gray-400">
          <option value="">{subs.length ? '（補助なし）' : '補助なし'}</option>
          {subs.map((s) => <option key={s.subCode} value={s.subCode}>{s.subCode}:{s.shortName || s.name}</option>)}
        </select>
      </div>
    )
  }

  const rawRows = sheets[previewIdx]?.rows ?? []
  const maxCols = Math.max(0, ...rawRows.map((r) => r.cells.length))
  const dictRows = Object.entries(dict)
    .filter(([, v]) => !q || v.payee.includes(q) || v.name.includes(q) || v.code.includes(q))
    .sort((a, b) => a[1].payee.localeCompare(b[1].payee, 'ja'))

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-full max-w-5xl max-h-[92vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-gray-200 flex items-center justify-between">
          <h2 className="font-semibold text-gray-800">総合振込の内訳</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        <div className="px-5 py-2.5 text-xs text-gray-600 bg-gray-50 border-b border-gray-200 leading-relaxed">
          銀行の総合振込の明細（Excel）を取り込んでおくと、通帳の解析で<b>指定日の前後{BULK_DATE_TOLERANCE}日以内に、合計額と同じ出金</b>
          （「フリコミカワリキン」など）を見つけたとき、<b>振込先ごとの複合仕訳</b>に自動で分けます。
          手数料込みで引き落とされている場合は、手数料の行も作ります。<br />
          科目は<b>振込先の名前で覚えます</b>（顔ぶれが月ごとに変わっても、一度決めた振込先は次から自動で入ります）。
          初めての振込先は科目が空欄で出るので、ここか仕訳の画面で決めてください。仕訳の画面では、その行の ★ で覚えます。<br />
          1件を複数の科目に分けるときは「<b>複合</b>」（例：支払報酬／預り金）。
          通帳を使わずに<b>この明細だけで仕訳にする</b>こともできます（明細を選んで、下の「仕訳一覧に追加」または「そのままCSVで出力」）。
        </div>

        {sheets.length > 0 && map ? (
          /* ---------------- 取り込み中 ---------------- */
          <div className="flex-1 overflow-auto p-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs text-gray-500">{fileName}</span>
              <button onClick={() => { setSheets([]); setMap(null) }}
                className="ml-auto px-2 py-1 text-xs bg-gray-100 rounded hover:bg-gray-200">取り込みをやめる</button>
            </div>
            <div className="flex gap-2 flex-wrap mb-1">
              {ROLES.map((r) => {
                const v = (map as unknown as Record<string, number>)[r.key] ?? -1
                return (
                  <button key={r.key} onClick={() => setActiveRole(r.key)}
                    className={`px-3 py-1.5 text-sm rounded border ${activeRole === r.key ? `${r.color} border-2 font-bold` : 'bg-gray-50 border-gray-200 text-gray-600'} ${v >= 0 ? 'ring-2 ring-offset-1' : ''}`}>
                    {v >= 0 ? `${r.label} (列${v + 1})` : r.label}{r.key === 'feeColumn' ? '（任意）' : ''}
                  </button>
                )
              })}
            </div>
            <p className="text-xs text-gray-400 mb-2">
              上のボタンで役割を選び、下の表の列見出しをクリックしてください。見出しの語から当たりを付けてあります。
              合計・小計の行は自動で除きます。
            </p>
            {sheets.length > 1 && (
              <div className="flex gap-1 flex-wrap mb-1">
                {sheets.map((s, i) => (
                  <button key={i} onClick={() => setPreviewIdx(i)}
                    className={`px-2 py-0.5 text-[11px] rounded border ${i === previewIdx ? 'bg-blue-50 border-blue-300' : 'border-gray-200'}`}>{s.name}</button>
                ))}
              </div>
            )}
            <div className="overflow-auto max-h-[32vh] border border-gray-200 rounded">
              <table className="w-full text-xs border-collapse">
                <thead className="sticky top-0 bg-white">
                  <tr>
                    {Array.from({ length: maxCols }, (_, i) => (
                      <th key={i} onClick={() => clickColumn(i)}
                        className={`border border-gray-300 px-2 py-2 cursor-pointer hover:bg-blue-50 min-w-[80px] ${ROLES.find((r) => r.key === roleOf(i))?.color || ''}`}>
                        <span className="block text-gray-400">列{i + 1}</span>
                        {roleOf(i) && <span className="block font-bold text-gray-700 mt-0.5">{ROLES.find((r) => r.key === roleOf(i))?.label}</span>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rawRows.slice(0, 30).map((r, i) => (
                    <tr key={i} className={i % 2 ? 'bg-gray-50' : ''}>
                      {Array.from({ length: maxCols }, (_, c) => (
                        <td key={c} className={`border border-gray-200 px-2 py-1 truncate max-w-[180px] ${ROLES.find((x) => x.key === roleOf(c))?.color || ''}`}>{r.cells[c] || ''}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <table className="w-full text-xs border-collapse mt-3">
              <thead>
                <tr className="bg-gray-50 text-gray-600">
                  <th className="px-2 py-1 text-left border-b">登録</th>
                  <th className="px-2 py-1 text-left border-b">シート</th>
                  <th className="px-2 py-1 text-left border-b">指定日</th>
                  <th className="px-2 py-1 text-right border-b">件数</th>
                  <th className="px-2 py-1 text-right border-b">振込金額の合計</th>
                  <th className="px-2 py-1 text-right border-b">手数料の合計</th>
                </tr>
              </thead>
              <tbody>
                {sheets.map((s, i) => {
                  const p = parsed[i]
                  return (
                    <tr key={i} className="border-b border-gray-100">
                      <td className="px-2 py-1">
                        <input type="checkbox" checked={s.include && !!p?.rows.length}
                          disabled={!p?.rows.length}
                          onChange={(e) => setSheets((ss) => ss.map((x, j) => (j === i ? { ...x, include: e.target.checked } : x)))} />
                      </td>
                      <td className="px-2 py-1">{s.name}</td>
                      <td className="px-2 py-1">
                        <input type="date" value={s.date}
                          onChange={(e) => setSheets((ss) => ss.map((x, j) => (j === i ? { ...x, date: e.target.value } : x)))}
                          className={`px-1 py-0.5 border rounded ${s.date ? 'border-gray-300' : 'border-red-400 bg-red-50'}`} />
                      </td>
                      <td className="px-2 py-1 text-right">{p?.rows.length ?? 0}件</td>
                      <td className="px-2 py-1 text-right tabular-nums font-bold">{yen(p?.total ?? 0)}</td>
                      <td className="px-2 py-1 text-right tabular-nums text-gray-500">{p?.feeTotal ? yen(p.feeTotal) : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {err && <p className="text-xs text-red-600 mt-2">{err}</p>}
            <div className="mt-3 flex justify-end">
              <button onClick={applyImport}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700">
                チェックした明細を登録する
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="px-5 pt-2 flex gap-1 border-b border-gray-200">
              {([['list', '総合振込の明細'], ['dict', `取引先辞書（${Object.keys(dict).length}件）`]] as const).map(([k, label]) => (
                <button key={k} onClick={() => setTab(k)}
                  className={`px-3 py-1.5 text-xs rounded-t border border-b-0 ${tab === k ? 'bg-white font-bold text-gray-800 border-gray-300' : 'bg-gray-50 text-gray-500 border-transparent'}`}>{label}</button>
              ))}
            </div>

            {tab === 'list' ? (
              <div className="flex-1 overflow-hidden flex">
                <div className="w-56 shrink-0 border-r border-gray-200 overflow-auto p-2">
                  {list.map((t) => {
                    const unknown = t.rows.filter((r) => resolvePayeeLines(r, dict).lines.some((l) => !l.code)).length
                    return (
                      <button key={t.id} onClick={() => setSel(t.id)}
                        className={`w-full text-left px-2 py-1.5 mb-1 rounded text-xs ${t.id === sel ? 'bg-blue-50 border border-blue-300' : 'hover:bg-gray-50 border border-transparent'}`}>
                        <div className="font-medium text-gray-800">{t.date}　{t.rows.length}件</div>
                        <div className="text-[10px] text-gray-500 tabular-nums">
                          {yen(bulkTotal(t))}円
                          {unknown > 0 && <span className="text-amber-600 ml-1">科目未設定 {unknown}</span>}
                          {t.journalizedAt && <span className="text-green-700 ml-1">仕訳済</span>}
                        </div>
                      </button>
                    )
                  })}
                  <button onClick={() => fileRef.current?.click()}
                    className="w-full px-2 py-1.5 text-xs bg-blue-50 text-blue-700 rounded hover:bg-blue-100">＋ 内訳を取り込む</button>
                  <input ref={fileRef} type="file" accept=".xlsx,.xls,.xlsm,.ods,.csv" className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void readFile(f) }} />
                  {err && <p className="text-[10px] text-red-500 mt-1">{err}</p>}
                </div>

                <div className="flex-1 overflow-auto p-4">
                  {!cur ? (
                    <p className="text-sm text-gray-500 py-8 text-center">
                      左の「＋ 内訳を取り込む」から、銀行の総合振込の明細（Excel・CSV）を読み込んでください。<br />
                      複数のシートがあるときは、1シート＝1回の総合振込として取り込みます。
                    </p>
                  ) : (
                    <>
                      <div className="flex items-center gap-3 mb-2 text-xs">
                        <label className="flex items-center gap-1">指定日
                          <input type="date" value={cur.date}
                            onChange={(e) => setList((l) => l.map((t) => (t.id === cur.id ? { ...t, date: e.target.value } : t)))}
                            className="px-1 py-0.5 border border-gray-300 rounded" />
                        </label>
                        <span>振込金額の合計 <b className="tabular-nums">{yen(bulkTotal(cur))}円</b></span>
                        {bulkFeeTotal(cur) > 0 && <span className="text-gray-500">手数料込み <b className="tabular-nums">{yen(bulkTotal(cur) + bulkFeeTotal(cur))}円</b></span>}
                        {cur.sheetName && <span className="text-gray-400">（{cur.fileName} / {cur.sheetName}）</span>}
                      </div>
                      <div className="overflow-auto max-h-[46vh] border border-gray-200 rounded">
                        <table className="w-full text-xs border-collapse">
                          <thead className="sticky top-0 bg-gray-50">
                            <tr className="text-gray-600">
                              <th className="text-left px-2 py-1 border-b">受取人名</th>
                              <th className="text-right px-2 py-1 border-b">振込金額</th>
                              <th className="text-right px-2 py-1 border-b">手数料</th>
                              <th className="text-left px-2 py-1 border-b" style={{ minWidth: 300 }}>科目・補助科目（振込先ごとに覚えます）</th>
                            </tr>
                          </thead>
                          <tbody>
                            {cur.rows.map((r, i) => {
                              const ls = linesOf(r)
                              const res = resolvePayeeLines(r, dict)
                              const unset = res.lines.some((l) => !l.code)
                              return (
                                <Fragment key={i}>
                                  <tr className={!res.ok ? 'bg-red-50' : unset ? 'bg-amber-50/60' : ''}>
                                    <td className="px-2 py-1 border-b border-gray-100">{r.payee}</td>
                                    <td className="px-2 py-1 border-b border-gray-100 text-right tabular-nums">{yen(r.amount)}</td>
                                    <td className="px-2 py-1 border-b border-gray-100 text-right tabular-nums text-gray-500">{r.fee ? yen(r.fee) : ''}</td>
                                    <td className="px-2 py-1 border-b border-gray-100">
                                      <div className="flex items-center gap-1">
                                        {ls ? (
                                          <button onClick={() => setOpenRow(openRow === i ? null : i)}
                                            className={`flex-1 min-w-0 text-left px-1.5 py-0.5 rounded border truncate ${res.ok ? 'border-teal-300 bg-teal-50 text-teal-800' : 'border-red-400 bg-red-50 text-red-700'}`}
                                            title="クリックで複合仕訳を開く／閉じる">
                                            複合 {ls.length}行：{res.lines.map((l) => `${l.side === 'debit' ? '借' : '貸'}${l.name || '（未設定）'} ${yen(l.amount)}`).join('／')}
                                          </button>
                                        ) : (
                                          accountSel(r.payee)
                                        )}
                                        {!ls && (
                                          <button onClick={() => {
                                            // 今の科目を1行目（差額）にして、2行目を足した状態から始める
                                            const acc = dict[normalizePayee(r.payee)]
                                            setRowLines(i, [
                                              { side: 'debit', code: acc?.code || '', name: acc?.name || '', subCode: acc?.subCode, subName: acc?.subName,
                                                taxCode: acc?.taxCode, taxType: acc?.taxType, taxRate: acc?.taxRate, businessType: acc?.businessType },
                                              { side: 'credit', code: '', name: '', amount: 0 },
                                            ])
                                            setOpenRow(i)
                                          }} className="shrink-0 px-1.5 py-0.5 text-[11px] border border-teal-300 text-teal-700 rounded hover:bg-teal-50"
                                            title="この振込先を複数の科目に分ける（例：支払報酬／預り金）">複合</button>
                                        )}
                                      </div>
                                    </td>
                                  </tr>
                                  {ls && openRow === i && (
                                    <tr><td colSpan={4} className="px-2 py-1.5 border-b border-gray-100">{linesEditor(r, i)}</td></tr>
                                  )}
                                </Fragment>
                              )
                            })}
                            {bulkFeeTotal(cur) > 0 && (
                              <tr className="bg-gray-50">
                                <td className="px-2 py-1 text-gray-600" colSpan={2}>{FEE_PAYEE}（手数料込みで引き落とされたときに使う行）</td>
                                <td className="px-2 py-1 text-right tabular-nums text-gray-500">{yen(bulkFeeTotal(cur))}</td>
                                <td className="px-2 py-1">{accountSel(FEE_PAYEE)}</td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                      {/* 通帳を使わずに、この明細だけで仕訳にする */}
                      {onJournalize && (
                        <div className="mt-3 border border-blue-200 bg-blue-50/50 rounded px-3 py-2.5">
                          <div className="text-xs font-bold text-gray-700 mb-1.5">
                            この明細だけで仕訳にする
                            <span className="font-normal text-gray-500 ml-2">通帳を取り込まずに、総合振込の仕訳だけを作ります</span>
                          </div>
                          <div className="flex items-center gap-2 text-xs mb-2">
                            <span className="w-20 shrink-0 text-gray-600">引落口座</span>
                            {acctPick({ code: cur.bankCode || '', subCode: cur.bankSubCode,
                              onPick: (v) => updateCur({ bankCode: v.code || undefined, bankName: v.name || undefined, bankSubCode: v.subCode, bankSubName: v.subName }) })}
                          </div>
                          {bulkFeeTotal(cur) > 0 && (
                            <label className="flex items-center gap-1.5 text-xs text-gray-700 mb-2">
                              <input type="checkbox" checked={includeFee} onChange={(e) => setIncludeFee(e.target.checked)} />
                              振込手数料（{yen(bulkFeeTotal(cur))}円）も同じ引落に含める
                              <span className="text-gray-400">（手数料が通帳で別の行に出る銀行なら外したまま）</span>
                            </label>
                          )}
                          <div className="flex items-center gap-2">
                            <button onClick={() => journalize('append')}
                              className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700">仕訳一覧に追加</button>
                            <button onClick={() => journalize('csv')}
                              className="px-3 py-1.5 text-xs bg-white border border-blue-300 text-blue-700 rounded hover:bg-blue-50">そのままCSVで出力</button>
                            {cur.journalizedAt ? (
                              <span className="text-xs text-green-700">
                                ✓ {new Date(cur.journalizedAt).toLocaleString('ja-JP')} に仕訳済み（通帳の解析では、この引落を仕訳にしません）
                                <button onClick={() => updateCur({ journalizedAt: undefined })}
                                  className="ml-2 underline text-gray-500">未処理に戻す</button>
                              </span>
                            ) : (
                              <span className="text-[11px] text-gray-500">
                                仕訳にすると「仕訳済み」になり、あとで通帳を取り込んでも同じ引落は二重に仕訳しません。
                              </span>
                            )}
                          </div>
                        </div>
                      )}
                      <div className="mt-2 flex gap-2">
                        <button onClick={() => {
                          if (!confirm(`${cur.date} の総合振込（${cur.rows.length}件）の明細を削除しますか？\n（取引先辞書の科目は残ります）`)) return
                          setList((l) => l.filter((t) => t.id !== cur.id)); setSel('')
                        }} className="px-3 py-1.5 text-xs text-red-600 bg-red-50 rounded hover:bg-red-100">この明細を削除</button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex-1 overflow-auto p-4">
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="振込先・科目で絞り込み"
                  className="w-64 px-2 py-1 text-xs border border-gray-300 rounded mb-2" />
                {dictRows.length === 0 ? (
                  <p className="text-sm text-gray-500 py-8 text-center">まだ覚えている振込先はありません。</p>
                ) : (
                  <table className="w-full text-xs border-collapse">
                    <thead>
                      <tr className="bg-gray-50 text-gray-600">
                        <th className="text-left px-2 py-1 border-b">振込先</th>
                        <th className="text-left px-2 py-1 border-b" style={{ minWidth: 300 }}>科目・補助科目</th>
                        <th className="text-left px-2 py-1 border-b">摘要</th>
                        <th className="border-b"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {dictRows.map(([k, v]) => (
                        <tr key={k} className="border-b border-gray-100">
                          <td className="px-2 py-1">{v.payee}</td>
                          <td className="px-2 py-1">
                            {v.lines?.length
                              ? <span className="text-teal-800">複合 {v.lines.length}行：{v.lines.map((l) => `${l.side === 'debit' ? '借' : '貸'}${l.name || '（未設定）'}${l.amount == null ? '（差額）' : ' ' + yen(l.amount)}`).join('／')}</span>
                              : accountSel(v.payee)}
                          </td>
                          <td className="px-2 py-1">
                            <input value={v.description || ''} placeholder={v.payee}
                              onChange={(e) => setPayee(v.payee, { description: e.target.value || undefined })}
                              className="w-full px-1 py-0.5 border border-gray-300 rounded" />
                          </td>
                          <td className="px-2 py-1 text-right">
                            <button onClick={() => setPayee(v.payee, null)} className="text-red-500 hover:text-red-700">削除</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </>
        )}

        <div className="px-5 py-3 border-t border-gray-200 flex justify-end gap-2">
          <button onClick={onClose} className="px-5 py-2 text-sm bg-gray-100 rounded hover:bg-gray-200">キャンセル</button>
          <button onClick={save} className="px-5 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700">保存する</button>
        </div>
      </div>
    </div>
  )
}
