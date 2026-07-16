'use client'

// 案件台帳（設計業務）: 顧問先の契約管理Excelを取り込み、事業年度別に
// 報酬額（税抜）・申請手数料・外注費・粗利を集計して表示・PDF/Excel出力する
import { useCallback, useEffect, useState } from 'react'
import {
  type AnkenData, type AnkenItem, type AnkenYearGroup,
  parseAnkenGrid, mergeAnken, groupByFiscalYear, gaichuTotal, arari, fmtDate, autoFiscalYearOf,
} from '@/lib/keiei/anken'
import { loadAnken, saveAnken } from '@/lib/keiei/store'
import { fmtYen } from '@/lib/keiei/format'

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-[0_3px_10px_rgba(26,115,232,0.06)] p-5">
      <div className="flex items-baseline gap-2 mb-3">
        <h2 className="text-sm font-bold text-gray-800">{title}</h2>
        {note && <span className="text-xs text-gray-400">{note}</span>}
      </div>
      {children}
    </div>
  )
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const periodText = (it: AnkenItem) =>
  it.periodStart || it.periodEnd ? `${fmtDate(it.periodStart)} 〜 ${fmtDate(it.periodEnd)}` : ''

export default function SectionAnken({ clientId, company }: { clientId: string; company: string }) {
  const [data, setData] = useState<AnkenData>({ items: [], closingMonth: 5 })
  const [loaded, setLoaded] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  useEffect(() => {
    let alive = true
    setLoaded(false)
    loadAnken(clientId).then((d) => { if (alive) { setData(d); setLoaded(true) } })
    return () => { alive = false }
  }, [clientId])

  const persist = useCallback((d: AnkenData) => {
    setData(d)
    saveAnken(clientId, d)
  }, [clientId])

  const handleFile = useCallback(async (files: FileList) => {
    // FileListは呼び出し元で input.value='' されると空になる「生きた」参照のため、
    // 最初の await の前に必ず File の配列へスナップショットする
    const list = Array.from(files)
    setErr(''); setMsg('')
    try {
      const XLSX = await import('xlsx')
      let parsed: AnkenItem[] = []
      for (const file of list) {
        const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' })
        for (const name of wb.SheetNames) {
          const grid = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null }) as unknown[][]
          parsed = mergeAnken(parsed, parseAnkenGrid(grid))
        }
      }
      if (!parsed.length) { setErr('案件を読み取れませんでした。「物件名」欄のある契約管理Excelか確認してください。'); return }
      const before = data.items.length
      const merged = mergeAnken(data.items, parsed)
      persist({ ...data, items: merged })
      const added = merged.length - before
      setMsg(`${parsed.length}件を読み取りました（新規 ${added}件・更新 ${parsed.length - added}件 ／ 登録計 ${merged.length}件）`)
    } catch (e) {
      setErr('読み取りに失敗しました: ' + (e instanceof Error ? e.message : String(e)))
    }
  }, [data, persist])

  const removeItem = useCallback((key: string) => {
    if (!window.confirm('この案件を台帳から削除しますか？（再アップロードで復元できます）')) return
    persist({ ...data, items: data.items.filter((x) => x.key !== key) })
  }, [data, persist])

  // 案件を任意の事業年度へ移動（year=null で自動判定に戻す）
  const setFyOverride = useCallback((key: string, year: number | null) => {
    persist({ ...data, items: data.items.map((x) => (x.key === key ? { ...x, fyOverride: year } : x)) })
  }, [data, persist])

  const groups = groupByFiscalYear(data.items, data.closingMonth)

  // 移動先の候補年（既存案件の自動判定年＋当年前後）を新しい順に
  const candidateYears = (() => {
    const set = new Set<number>()
    for (const it of data.items) { const y = autoFiscalYearOf(it, data.closingMonth); if (y != null) set.add(y) }
    const thisYear = new Date().getFullYear()
    for (let y = thisYear - 4; y <= thisYear + 1; y++) set.add(y)
    return Array.from(set).sort((a, b) => b - a)
  })()

  // ---------- PDF（新規ウインドウ・月次レポートのコンサル調デザイン） ----------
  const openPdf = useCallback(() => {
    const now = new Date()
    const dateStr = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`
    const gHtml = groups.map((grp) => `
  <section class="grp">
    <h2>${esc(grp.label)}<span class="cnt">${grp.items.length}件</span></h2>
    <table>
      <colgroup>
        <col style="width:17%"><col style="width:20%"><col style="width:8%"><col style="width:14%">
        <col style="width:10%"><col style="width:10%"><col style="width:7%"><col style="width:6%"><col style="width:8%">
      </colgroup>
      <thead><tr>
        <th class="tl">物件名／契約者</th><th class="tl">所在地・構造及び規模</th><th class="tc">契約日</th><th class="tc">契約期間</th>
        <th class="tr">報酬額(税込)</th><th class="tr">報酬額(税抜)</th><th class="tr">申請手数料</th><th class="tr">外注費</th><th class="tr">粗利額</th>
      </tr></thead>
      <tbody>
        ${grp.items.map((it) => `<tr>
          <td class="tl"><div class="nm">${esc(it.bukken)}</div><div class="sub">${esc(it.keiyakusha)}</div></td>
          <td class="tl"><div>${esc(it.shozaichi)}</div><div class="sub">${esc(it.kozo)}</div>${it.gaichu.length ? `<div class="sub">外注: ${it.gaichu.map((x) => esc(x.name)).join('、')}</div>` : ''}</td>
          <td class="tc">${fmtDate(it.keiyakuDate)}</td>
          <td class="tc">${esc(periodText(it))}</td>
          <td class="tr">${it.hoshuGross.toLocaleString()}</td>
          <td class="tr">${it.hoshuNet.toLocaleString()}</td>
          <td class="tr">${it.tesuryo ? it.tesuryo.toLocaleString() : ''}</td>
          <td class="tr">${gaichuTotal(it) ? gaichuTotal(it).toLocaleString() : ''}</td>
          <td class="tr">${arari(it).toLocaleString()}</td>
        </tr>`).join('')}
        <tr class="total">
          <td class="tl" colspan="4">合計（${esc(grp.label)}）</td>
          <td class="tr">${grp.totalHoshuGross.toLocaleString()}</td>
          <td class="tr">${grp.totalHoshu.toLocaleString()}</td>
          <td class="tr">${grp.totalTesuryo.toLocaleString()}</td>
          <td class="tr">${grp.totalGaichu.toLocaleString()}</td>
          <td class="tr">${grp.totalArari.toLocaleString()}</td>
        </tr>
      </tbody>
    </table>
  </section>`).join('')
    const html = `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">
<title>案件台帳_${esc(company)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Noto Sans JP", "Hiragino Sans", "Yu Gothic", Meiryo, sans-serif; color: #243042; padding: 24px; font-size: 11px; }
  .eyebrow { font-size: 10px; letter-spacing: 4px; color: #c8a24b; font-weight: 700; }
  h1 { font-size: 24px; font-weight: 800; color: #1f3a5f; letter-spacing: 2px; margin: 2px 0; }
  .sub { color: #5b6675; }
  .head-sub { font-size: 12px; color: #5b6675; }
  .rule { height: 3px; margin: 10px 0 18px; background: linear-gradient(90deg,#1f3a5f 0%,#1f3a5f 72%,#c8a24b 72%,#c8a24b 100%); }
  .grp { margin-bottom: 20px; break-inside: avoid-page; }
  .grp h2 { font-size: 14px; font-weight: 800; color: #1f3a5f; border-left: 5px solid #c8a24b; border-bottom: 2px solid #1f3a5f; padding: 0 0 5px 10px; margin-bottom: 8px; }
  .grp h2 .cnt { font-size: 11px; color: #5b6675; font-weight: 500; margin-left: 10px; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  thead th { background: #1f3a5f; color: #fff; font-weight: 700; padding: 5px 6px; border: 1px solid #1f3a5f; font-size: 10px; }
  td { padding: 5px 6px; border: 1px solid #d3dae3; vertical-align: top; word-break: break-word; }
  tbody tr:nth-child(even) td { background: #f6f8fb; }
  tr.total td { background: #e7edf5; font-weight: 800; color: #1f3a5f; }
  .tl { text-align: left; } .tr { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; } .tc { text-align: center; }
  .nm { font-weight: 700; }
  td .sub { font-size: 9.5px; color: #7b8698; margin-top: 1px; }
  .note { font-size: 9.5px; color: #7b8698; margin-top: 14px; line-height: 1.7; }
  .toolbar { margin-bottom: 14px; }
  .toolbar button { padding: 8px 18px; font-size: 13px; font-weight: 700; border: none; border-radius: 8px; cursor: pointer; background: #1f3a5f; color: #fff; }
  @media print { .toolbar { display: none; } body { padding: 0; } @page { size: A4 landscape; margin: 12mm 10mm; } }
</style></head><body>
  <div class="toolbar"><button onclick="window.print()">🖨 印刷 / PDF保存</button></div>
  <div class="eyebrow">PROJECT LEDGER</div>
  <h1>案件台帳（設計業務）</h1>
  <div class="head-sub"><b>${esc(company)}</b> 御中　／　決算月 ${data.closingMonth}月　／　作成日 ${dateStr}</div>
  <div class="rule"></div>
  ${gHtml}
  <div class="note">※ 事業年度は履行期間の終了日（未記載の場合は契約日）を基準に、決算月${data.closingMonth}月で区切って判定しています。<br>
  ※ 報酬額(税込)は契約書の報酬額。報酬額(税抜)はそこから（内）消費税を控除した金額で、売上高に計上されます。申請手数料は立替金の回収であり売上高には含まれません。<br>
  ※ 外注費は契約管理表の「業務の一部委託」で受託者の氏名・名称が記載されているものの金額合計。粗利額＝報酬額（税抜）−外注費。</div>
</body></html>`
    const w = window.open('', '_blank')
    if (!w) { setErr('ポップアップがブロックされました。ブラウザの設定で許可してください。'); return }
    w.document.open(); w.document.write(html); w.document.close()
  }, [groups, company, data.closingMonth])

  // ---------- Excel出力（事業年度ごとにシート・罫線/背景色/Noto Sans JP） ----------
  const downloadExcel = useCallback(async () => {
    const ExcelJS = (await import('exceljs')).default
    const FONT = 'Noto Sans JP'
    const NAVY = 'FF1F3A5F', INK = 'FF243042', SUBTX = 'FF5B6675'
    const HEADFILL = 'FF1F3A5F', ZEBRA = 'FFF6F8FB', TOTALFILL = 'FFE7EDF5', GRID = 'FFD3DAE3'
    const border = () => { const s = { style: 'thin' as const, color: { argb: GRID } }; return { top: s, bottom: s, left: s, right: s } }
    const headers = ['物件名', '契約者', '所在地', '構造及び規模', '契約日', '契約期間', '報酬額(税込)', '報酬額(税抜)', '申請手数料', '外注費', '粗利額', '外注先']
    const widths = [30, 22, 26, 20, 12, 22, 14, 14, 12, 12, 13, 24]
    const isNum = (c: number) => c >= 7 && c <= 11 // 1-based: 税込〜粗利
    const isCenter = (c: number) => c === 5 || c === 6 // 契約日・契約期間
    const isWrap = (c: number) => c === 1 || c === 3 || c === 4 || c === 12
    const wb = new ExcelJS.Workbook()
    for (const grp of groups) {
      const ws = wb.addWorksheet(grp.label.replace(/[\\/?*[\]:]/g, '').slice(0, 31), { views: [{ state: 'frozen', ySplit: 3 }] })
      ws.columns = widths.map((w) => ({ width: w }))
      // タイトル
      const title = ws.addRow([`${company}　案件台帳（設計業務）　${grp.label}`])
      ws.mergeCells(1, 1, 1, headers.length)
      title.getCell(1).font = { name: FONT, size: 14, bold: true, color: { argb: NAVY } }
      title.height = 24
      const sub = ws.addRow([`${grp.items.length}件　／　決算月 ${data.closingMonth}月　／　報酬額(税込)＝契約書の報酬額、報酬額(税抜)＝内消費税控除後の売上高`])
      ws.mergeCells(2, 1, 2, headers.length)
      sub.getCell(1).font = { name: FONT, size: 9, color: { argb: SUBTX } }
      // ヘッダ
      const head = ws.addRow([...headers])
      head.height = 22
      head.eachCell((c) => {
        c.font = { name: FONT, size: 9.5, bold: true, color: { argb: 'FFFFFFFF' } }
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADFILL } }
        c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
        c.border = border()
      })
      // データ行（ゼブラ）
      grp.items.forEach((it, i) => {
        const r = ws.addRow([
          it.bukken, it.keiyakusha, it.shozaichi, it.kozo, fmtDate(it.keiyakuDate), periodText(it),
          it.hoshuGross, it.hoshuNet, it.tesuryo, gaichuTotal(it), arari(it), it.gaichu.map((x) => x.name).join('、'),
        ])
        for (let c = 1; c <= headers.length; c++) {
          const cell = r.getCell(c)
          cell.font = { name: FONT, size: 9.5, bold: c === 1, color: { argb: c === 1 ? NAVY : INK } }
          cell.border = border()
          cell.alignment = { vertical: 'top', horizontal: isNum(c) ? 'right' : isCenter(c) ? 'center' : 'left', wrapText: isWrap(c) }
          if (isNum(c)) cell.numFmt = '#,##0'
          if (i % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ZEBRA } }
        }
      })
      // 合計行
      const tot = ws.addRow(['合計（' + grp.label + '）', '', '', '', '', '', grp.totalHoshuGross, grp.totalHoshu, grp.totalTesuryo, grp.totalGaichu, grp.totalArari, ''])
      ws.mergeCells(tot.number, 1, tot.number, 6)
      for (let c = 1; c <= headers.length; c++) {
        const cell = tot.getCell(c)
        cell.font = { name: FONT, size: 9.5, bold: true, color: { argb: NAVY } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TOTALFILL } }
        cell.border = border()
        cell.alignment = { vertical: 'middle', horizontal: isNum(c) ? 'right' : 'left' }
        if (isNum(c)) cell.numFmt = '#,##0'
      }
    }
    const buf = await wb.xlsx.writeBuffer()
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `案件台帳_${company}.xlsx`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }, [groups, company, data.closingMonth])

  if (!loaded) return <div className="text-sm text-gray-400 py-8 text-center">読み込み中…</div>

  return (
    <div className="space-y-5">
      <Section title="案件台帳（設計業務）" note="契約管理Excelを取り込み、事業年度別に報酬・外注費・粗利を集計します">
        <div className="flex items-center gap-3 flex-wrap mb-2">
          <label className="px-4 py-2 bg-[#1a73e8] text-white rounded-full text-sm font-semibold hover:bg-[#1765cc] cursor-pointer shadow-sm">
            ＋ 契約管理Excelを取込
            <input type="file" accept=".xlsx,.xls" multiple className="hidden"
              onChange={(e) => { if (e.target.files?.length) handleFile(e.target.files); e.target.value = '' }} />
          </label>
          <label className="text-xs text-gray-500 flex items-center gap-1">
            決算月
            <select value={data.closingMonth} onChange={(e) => persist({ ...data, closingMonth: Number(e.target.value) })}
              className="px-2 py-1.5 border border-gray-300 rounded text-sm">
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => <option key={m} value={m}>{m}月</option>)}
            </select>
          </label>
          {data.items.length > 0 && (
            <div className="ml-auto flex gap-2">
              <button onClick={openPdf} className="px-3 py-1.5 text-xs bg-[#1F3A5F] text-white rounded-lg font-bold hover:brightness-110">🖨 PDF（新しいウインドウ）</button>
              <button onClick={downloadExcel} className="px-3 py-1.5 text-xs bg-[#1a7f37] text-white rounded-lg font-bold hover:brightness-110">📥 Excelダウンロード</button>
            </div>
          )}
        </div>
        <div className="text-[11px] text-gray-400 leading-relaxed">
          同じ物件名・契約者の案件は同一案件として上書き取込します（同じファイルへの追記運用に対応）。
          事業年度は履行期間の終了日（未記載は契約日）を決算月で区切って自動判定します。
          報酬額(税込)は契約書の報酬額、報酬額(税抜)はそこから内消費税を控除した売上高、申請手数料は立替（売上高ではありません）、粗利額＝報酬額（税抜）−外注費。
        </div>
        {msg && <div className="mt-2 px-3 py-2 bg-green-50 text-green-700 text-xs rounded-lg">{msg}</div>}
        {err && <div className="mt-2 px-3 py-2 bg-red-50 text-red-700 text-xs rounded-lg">{err}</div>}
      </Section>

      {groups.length === 0 && (
        <div className="text-sm text-gray-400 text-center py-10">まだ案件がありません。契約管理Excelを取り込んでください。</div>
      )}

      {groups.map((grp) => (
        <Section key={grp.label} title={grp.label} note={`${grp.items.length}件`}>
          <div className="overflow-x-auto">
            <table className="w-full text-xs" style={{ tableLayout: 'fixed' }}>
              {/* 全事業年度で列幅を揃えるため固定レイアウト＋共通の列幅指定 */}
              <colgroup>
                <col style={{ width: '16%' }} />
                <col style={{ width: '19%' }} />
                <col style={{ width: '8%' }} />
                <col style={{ width: '13%' }} />
                <col style={{ width: '10%' }} />
                <col style={{ width: '10%' }} />
                <col style={{ width: '8%' }} />
                <col style={{ width: '7%' }} />
                <col style={{ width: '6%' }} />
                <col style={{ width: '3%' }} />
              </colgroup>
              <thead>
                <tr className="text-gray-500 border-b border-gray-200 bg-gray-50">
                  <th className="text-left px-2 py-2 font-medium">物件名／契約者</th>
                  <th className="text-left px-2 py-2 font-medium">所在地・構造及び規模</th>
                  <th className="text-center px-2 py-2 font-medium">契約日</th>
                  <th className="text-center px-2 py-2 font-medium">契約期間</th>
                  <th className="text-right px-2 py-2 font-medium">報酬額(税込)</th>
                  <th className="text-right px-2 py-2 font-medium">報酬額(税抜)</th>
                  <th className="text-right px-2 py-2 font-medium">申請手数料</th>
                  <th className="text-right px-2 py-2 font-medium">外注費</th>
                  <th className="text-right px-2 py-2 font-medium">粗利額</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {grp.items.map((it) => (
                  <tr key={it.key} className="border-b border-gray-100 align-top hover:bg-sky-50/40">
                    <td className="px-2 py-2 break-words">
                      <div className="font-bold text-gray-800">{it.bukken}</div>
                      <div className="text-[11px] text-gray-500">{it.keiyakusha}</div>
                      {grp.fyEndYear == null ? (
                        <select
                          value=""
                          onChange={(e) => { if (e.target.value) setFyOverride(it.key, Number(e.target.value)) }}
                          className="mt-1 w-full px-1 py-0.5 border border-amber-300 rounded text-[11px] text-amber-800 bg-amber-50"
                          title="この案件を事業年度へ移動">
                          <option value="">▸ 事業年度へ移動…</option>
                          {candidateYears.map((y) => <option key={y} value={y}>{y}年{data.closingMonth}月期へ移動</option>)}
                        </select>
                      ) : it.fyOverride != null ? (
                        <button onClick={() => setFyOverride(it.key, null)}
                          className="mt-1 text-[11px] text-amber-700 hover:text-amber-900 underline"
                          title="手動で指定した事業年度を解除し、日付からの自動判定に戻す">
                          ↩ 手動指定を解除
                        </button>
                      ) : null}
                    </td>
                    <td className="px-2 py-2 break-words">
                      <div className="text-gray-700">{it.shozaichi}</div>
                      <div className="text-[11px] text-gray-400">{it.kozo}</div>
                      {it.gaichu.length > 0 && (
                        <div className="text-[11px] text-amber-700 mt-0.5">
                          外注: {it.gaichu.map((x) => `${x.name}${x.amount ? ` ${fmtYen(x.amount)}` : ''}`).join('、')}
                        </div>
                      )}
                      {it.biko && <div className="text-[11px] text-gray-400 mt-0.5">備考: {it.biko}</div>}
                    </td>
                    <td className="px-2 py-2 text-center">{fmtDate(it.keiyakuDate)}</td>
                    <td className="px-2 py-2 text-center">{periodText(it)}</td>
                    <td className="px-2 py-2 text-right tabular-nums whitespace-nowrap">{fmtYen(it.hoshuGross)}</td>
                    <td className="px-2 py-2 text-right tabular-nums whitespace-nowrap">{fmtYen(it.hoshuNet)}</td>
                    <td className="px-2 py-2 text-right tabular-nums whitespace-nowrap text-gray-500">{it.tesuryo ? fmtYen(it.tesuryo) : '—'}</td>
                    <td className="px-2 py-2 text-right tabular-nums whitespace-nowrap text-gray-500">{gaichuTotal(it) ? fmtYen(gaichuTotal(it)) : '—'}</td>
                    <td className="px-2 py-2 text-right tabular-nums whitespace-nowrap font-bold text-gray-800">{fmtYen(arari(it))}</td>
                    <td className="px-1 py-2 text-center">
                      <button onClick={() => removeItem(it.key)} className="text-gray-300 hover:text-red-500" title="この案件を削除">✕</button>
                    </td>
                  </tr>
                ))}
                <tr className="font-bold bg-[#f0f4fa] text-[#1F3A5F]">
                  <td className="px-2 py-2 break-words" colSpan={4}>合計（{grp.label}）</td>
                  <td className="px-2 py-2 text-right tabular-nums whitespace-nowrap">{fmtYen(grp.totalHoshuGross)}</td>
                  <td className="px-2 py-2 text-right tabular-nums whitespace-nowrap">{fmtYen(grp.totalHoshu)}</td>
                  <td className="px-2 py-2 text-right tabular-nums whitespace-nowrap">{fmtYen(grp.totalTesuryo)}</td>
                  <td className="px-2 py-2 text-right tabular-nums whitespace-nowrap">{fmtYen(grp.totalGaichu)}</td>
                  <td className="px-2 py-2 text-right tabular-nums whitespace-nowrap">{fmtYen(grp.totalArari)}</td>
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
        </Section>
      ))}
    </div>
  )
}
