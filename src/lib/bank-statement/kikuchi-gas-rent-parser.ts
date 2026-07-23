// キクチ・エステート専用: ガス料金・家賃集計表Excel → 仕訳変換（AI不使用・コード解析のみ）
//
// 対象ファイル: 1シートに「ガス料金」ブロックと「家賃」ブロックが横並びで入っている集計表。
// 各ブロックは2段ヘッダー（1段目=項目グループ名「整理№/管轄/請求年月/…/ガス代/…」、
// 2段目=「請求額/検針日/受領日…」）を持つ。
// 月によって列位置がずれる可能性があるため、列番号は固定せず、
// ヘッダー行の「整理№」を起点にラベル文言から列位置を動的に特定する。
//
// 仕訳ルール（顧問先キクチ・エステートとの取り決め）:
//   共通: 借方 162（補助1）。「管轄」が「1 法人」の行のみ対象。
//   【ガス】取引日=検針日
//     ガス代（請求額）    → 貸方413 消費税10（課税売上・税率10%） 摘要=請求年月 ｱﾊﾟｰﾄ名 部屋№ 入居者名 ガス代
//     保証金（請求額）    → 貸方325 消費税なし(BS)               摘要=… 保証金
//     灯油器具代（請求額）→ 貸方412 消費税10（課税売上・税率10%） 摘要=… 灯油器具代
//   【家賃】取引日=請求年月の1日
//     家賃         → 貸方410 消費税30（非課税売上） 摘要=請求年月 ｱﾊﾟｰﾄ名 部屋№ 入居者名 家賃
//     礼金・更新料 → 貸方416 消費税30（非課税売上） 摘要=… 礼金更新料
//     敷金         → 貸方324 消費税なし(BS)         摘要=… 預り敷金
//     共益費       → 貸方410 消費税30（非課税売上） 摘要=… 共益費
//     駐車料       → 貸方410 消費税30（非課税売上） 摘要=… 駐車料

import type { JournalEntry, AccountItem, SubAccountItem } from './types'
import { createBlankEntry } from './journal-mapper'

export interface KikuchiParseResult {
  entries: JournalEntry[]
  summary: { label: string; count: number; total: number }[]
  warnings: string[]
  periods: string[]
}

const norm = (v: unknown): string => String(v ?? '').replace(/[\s　]/g, '')
const cleanText = (v: unknown): string => String(v ?? '').replace(/[\s　]+/g, ' ').trim()

const fmtYmd = (y: number, m: number, d: number): string =>
  `${y}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`

/** セル値（Date/Excelシリアル値/文字列）→ YYYYMMDD。解釈できなければ '' */
function cellToYmd(v: unknown): string {
  if (v == null || v === '') return ''
  if (v instanceof Date && !isNaN(v.getTime())) return fmtYmd(v.getFullYear(), v.getMonth() + 1, v.getDate())
  if (typeof v === 'number' && isFinite(v) && v > 20000 && v < 60000) {
    // Excelシリアル値（1899-12-30起点）。タイムゾーンの影響を受けないようUTCで日付化する
    const d = new Date(Math.round((v - 25569) * 86400000))
    return fmtYmd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())
  }
  const m = String(v).trim().match(/(\d{4})[/\-年.](\d{1,2})(?:[/\-月.](\d{1,2}))?/)
  if (m) return fmtYmd(+m[1], +m[2], m[3] ? +m[3] : 1)
  return ''
}

/** 「2026-06」等の請求年月 → その月の1日の YYYYMMDD */
function ymTo1st(v: unknown): string {
  if (v == null || v === '') return ''
  if (v instanceof Date && !isNaN(v.getTime())) return fmtYmd(v.getFullYear(), v.getMonth() + 1, 1)
  if (typeof v === 'number' && isFinite(v) && v > 20000 && v < 60000) {
    const d = new Date(Math.round((v - 25569) * 86400000))
    return fmtYmd(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
  }
  const m = String(v).trim().match(/(\d{4})[/\-年.](\d{1,2})/)
  if (m) return fmtYmd(+m[1], +m[2], 1)
  return ''
}

function cellToNum(v: unknown): number {
  if (v == null || v === '') return 0
  if (typeof v === 'number') return isFinite(v) ? Math.round(v) : 0
  const n = parseFloat(String(v).replace(/[,，円\s]/g, ''))
  return isFinite(n) ? Math.round(n) : 0
}

interface ItemDef {
  suffix: string            // 摘要の末尾（ガス代/保証金/…）
  labelPred: (l: string) => boolean  // 1段目ヘッダーのラベル判定
  creditCode: string
  tax: 'taxable10' | 'nontax' | 'none'
}

const GAS_ITEMS: ItemDef[] = [
  { suffix: 'ガス代', labelPred: (l) => l === 'ガス代', creditCode: '413', tax: 'taxable10' },
  { suffix: '保証金', labelPred: (l) => l === '保証金', creditCode: '325', tax: 'none' },
  { suffix: '灯油器具代', labelPred: (l) => l.includes('灯油'), creditCode: '412', tax: 'taxable10' },
]
const RENT_ITEMS: ItemDef[] = [
  { suffix: '家賃', labelPred: (l) => l === '家賃', creditCode: '410', tax: 'nontax' },
  { suffix: '礼金更新料', labelPred: (l) => l.includes('礼金'), creditCode: '416', tax: 'nontax' },
  { suffix: '預り敷金', labelPred: (l) => l === '敷金', creditCode: '324', tax: 'none' },
  { suffix: '共益費', labelPred: (l) => l === '共益費', creditCode: '410', tax: 'nontax' },
  { suffix: '駐車料', labelPred: (l) => l === '駐車料', creditCode: '410', tax: 'nontax' },
]

/** ArrayBuffer から解析（テスト用に File を介さない入口も公開） */
export function parseKikuchiGasRentBuffer(
  buffer: ArrayBuffer,
  accountMaster: AccountItem[],
  subAccountMaster: SubAccountItem[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  X: any,
  wbIn?: unknown,
): KikuchiParseResult {
  const wb = wbIn || X.read(buffer, { type: 'array', cellDates: false })
  const warnings: string[] = []
  const periodSet = new Set<string>()

  const accName = (code: string): string => {
    const a = accountMaster.find((x) => x.code === code)
    return a ? (a.shortName || a.name || '') : ''
  }
  const debitSub = subAccountMaster.find((s) => s.parentCode === '162' && norm(s.subCode) === '1')

  // ヘッダー行（「整理№」と「管轄」を含む行）を持つシートを探す
  let rows: unknown[][] = []
  let hdr = -1
  for (const sn of wb.SheetNames as string[]) {
    const r = X.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true, defval: null }) as unknown[][]
    for (let i = 0; i < Math.min(r.length, 40); i++) {
      const row = r[i] || []
      const hasSeiri = row.some((c) => norm(c) === '整理№')
      const hasKanri = row.some((c) => norm(c) === '管轄')
      if (hasSeiri && hasKanri) { rows = r; hdr = i; break }
    }
    if (hdr >= 0) break
  }
  if (hdr < 0) throw new Error('ヘッダー行（整理№・管轄）が見つかりません。ガス料金・家賃集計表のExcelか確認してください。')

  const H = (rows[hdr] || []) as unknown[]
  const S = (rows[hdr + 1] || []) as unknown[]
  // 「整理№」の列＝各ブロックの起点（ガス・家賃の2ブロックを想定）
  const blockStarts: number[] = []
  H.forEach((c, i) => { if (norm(c) === '整理№') blockStarts.push(i) })
  if (!blockStarts.length) throw new Error('「整理№」列が見つかりません。')

  const width = Math.max(H.length, S.length)
  const entries: JournalEntry[] = []
  const counts = new Map<string, { count: number; total: number }>()
  const bump = (label: string, amt: number) => {
    const c = counts.get(label) || { count: 0, total: 0 }
    c.count++; c.total += amt; counts.set(label, c)
  }

  blockStarts.forEach((start, bi) => {
    const end = bi + 1 < blockStarts.length ? blockStarts[bi + 1] : width
    const findCol = (pred: (l: string) => boolean): number => {
      for (let c = start; c < end; c++) { const l = norm(H[c]); if (l && pred(l)) return c }
      return -1
    }
    // グループラベル列 g の直下〜数列以内で2段目ヘッダーを探す（請求額/検針日）
    const subCol = (g: number, pred: (l: string) => boolean): number => {
      for (let c = g; c < Math.min(g + 4, end); c++) { const l = norm(S[c]); if (l && pred(l)) return c }
      return -1
    }

    const labels = new Set<string>()
    for (let c = start; c < end; c++) { const l = norm(H[c]); if (l) labels.add(l) }
    const isGas = labels.has('ガス代')
    const isRent = labels.has('家賃')
    if (!isGas && !isRent) return // 判別できないブロックはスキップ

    const blockName = isGas ? 'ガス料金' : '家賃'
    const cKanri = findCol((l) => l === '管轄')
    const cYm = findCol((l) => l === '請求年月')
    const cApart = findCol((l) => /ｱﾊﾟ|アパ/.test(l))
    const cRoom = findCol((l) => l.startsWith('部屋'))
    const cTenant = findCol((l) => l.startsWith('入居者'))
    if (cKanri < 0 || cYm < 0) { warnings.push(`${blockName}ブロック: 管轄/請求年月の列が見つからないためスキップしました`); return }
    if (cApart < 0 || cRoom < 0 || cTenant < 0) warnings.push(`${blockName}ブロック: ｱﾊﾟｰﾄ名/部屋№/入居者名の一部の列が見つかりません（摘要が短くなります）`)

    // ガスの取引日=検針日（「ガス代」グループの2段目）
    let cKenshin = -1
    if (isGas) {
      const gGas = findCol((l) => l === 'ガス代')
      if (gGas >= 0) cKenshin = subCol(gGas, (l) => l === '検針日')
      if (cKenshin < 0) warnings.push('ガス料金ブロック: 検針日の列が見つかりません（請求年月の1日で計上します）')
    }

    // 各項目の請求額列を特定
    const defs = (isGas ? GAS_ITEMS : RENT_ITEMS)
      .map((d) => {
        const g = findCol(d.labelPred)
        const cAmt = g >= 0 ? subCol(g, (l) => l.startsWith('請求額')) : -1
        if (g >= 0 && cAmt < 0) warnings.push(`${blockName}ブロック: 「${d.suffix}」の請求額列が特定できずスキップしました`)
        return { ...d, cAmt }
      })
      .filter((d) => d.cAmt >= 0)
    if (!defs.length) { warnings.push(`${blockName}ブロック: 解析対象の項目列が1つも見つかりませんでした`); return }

    for (let r = hdr + 2; r < rows.length; r++) {
      const row = (rows[r] || []) as unknown[]
      // 「1 法人」の行のみ対象（「1法人・回収額 小計」等の集計行は一致しないため自然に除外）
      if (norm(row[cKanri]) !== '1法人') continue
      const ymRaw = row[cYm]
      const ym1st = ymTo1st(ymRaw)
      const ymText = cleanText(ymRaw) || (ym1st ? `${ym1st.slice(0, 4)}-${ym1st.slice(4, 6)}` : '')
      if (ymText) periodSet.add(ymText)
      const descBase = [
        ymText,
        cApart >= 0 ? cleanText(row[cApart]) : '',
        cRoom >= 0 ? cleanText(row[cRoom]) : '',
        cTenant >= 0 ? cleanText(row[cTenant]) : '',
      ].filter(Boolean).join(' ')

      // 取引日: ガス=検針日（無ければ請求年月の1日）、家賃=請求年月の1日
      let date = ''
      if (isGas) {
        date = cKenshin >= 0 ? cellToYmd(row[cKenshin]) : ''
        if (!date) date = ym1st
      } else {
        date = ym1st
      }
      if (!date) { warnings.push(`${blockName} ${r + 1}行目: 取引日を特定できずスキップしました（${descBase || '摘要不明'}）`); continue }

      for (const d of defs) {
        const amt = cellToNum(row[d.cAmt])
        if (!amt) continue
        const e = createBlankEntry()
        e.date = date
        e.debitCode = '162'
        e.debitName = accName('162')
        e.debitSubCode = '1'
        e.debitSubName = debitSub ? (debitSub.shortName || debitSub.name || '') : ''
        e.debitAmount = amt
        e.creditCode = d.creditCode
        e.creditName = accName(d.creditCode)
        e.creditAmount = amt
        if (d.tax === 'taxable10') {
          e.debitTaxCode = '10'      // 消費税コード（課税売上）
          e.debitTaxRate = '4'       // 税率コード 4=10%
          e.creditTaxType = '課税売上' // 売上区分は貸方（売上側）に付ける
        } else if (d.tax === 'nontax') {
          e.debitTaxCode = '30'      // 消費税コード（非課税売上）
          e.creditTaxType = '非課税売上'
        }
        e.description = (descBase ? descBase + ' ' : '') + d.suffix
        e.originalDescription = '' // パターン学習の対象にしない（ルール固定の直接仕訳のため）
        entries.push(e)
        bump(`${blockName}：${d.suffix}`, amt)
      }
    }
  })

  if (!entries.length) warnings.push('「1 法人」の行に金額のあるデータが見つかりませんでした。')

  // 日付順に安定ソート
  entries.sort((a, b) => a.date.localeCompare(b.date))

  const order = [...GAS_ITEMS.map((d) => `ガス料金：${d.suffix}`), ...RENT_ITEMS.map((d) => `家賃：${d.suffix}`)]
  const summary = order.filter((k) => counts.has(k)).map((k) => ({ label: k, count: counts.get(k)!.count, total: counts.get(k)!.total }))

  return { entries, summary, warnings, periods: Array.from(periodSet).sort() }
}

/** ファイル（.xlsx/.xls/.ods）から解析 */
export async function parseKikuchiGasRentFile(
  file: File,
  accountMaster: AccountItem[],
  subAccountMaster: SubAccountItem[],
): Promise<KikuchiParseResult> {
  const XLSX = await import('xlsx')
  const { readSpreadsheet } = await import('./spreadsheet-reader')
  const buf = await file.arrayBuffer()
  const wb = readSpreadsheet(buf)
  return parseKikuchiGasRentBuffer(buf, accountMaster, subAccountMaster, XLSX, wb)
}
