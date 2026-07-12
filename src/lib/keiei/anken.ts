// 案件台帳（設計業務）: 顧問先が記帳する契約管理Excel（8列×約37行のブロックが並ぶ様式）を
// 解析し、事業年度別に報酬額・申請手数料・外注費・粗利を集計する。
// Excelは年度を通じて同一ファイルへ追記される運用のため、同じ物件名＋契約者は同一案件として
// マージ（後からのアップロードで上書き）する。

export interface AnkenGaichu {
  name: string // 受託者の氏名・名称
  overview: string // 委託業務概要
  amount: number // 金額（外注費）
}

export interface AnkenItem {
  key: string // 同一案件判定キー（物件名＋契約者を正規化）
  bukken: string // 物件名
  keiyakusha: string // 契約者（氏名・名称）
  shozaichi: string // 所在地
  kozo: string // 構造及び規模
  keiyakuDate: string | null // 契約日 YYYY-MM-DD
  periodStart: string | null // 履行期間 開始
  periodEnd: string | null // 履行期間 終了
  hoshuNet: number // 報酬額（税抜）
  tesuryo: number // 申請手数料（立替。売上高ではない）
  gaichu: AnkenGaichu[] // 外注（受託者名の入力がある委託のみ）
  biko: string // 備考
}

export interface AnkenData {
  items: AnkenItem[]
  closingMonth: number // 決算月（1-12）
}

// ---------- ユーティリティ ----------

const normKey = (s: string) => s.replace(/[\s　]+/g, '').replace(/[（(]/g, '(').replace(/[）)]/g, ')')

function toNumber(v: unknown): number {
  if (v == null || v === '') return 0
  if (typeof v === 'number') return isFinite(v) ? v : 0
  const s = String(v).replace(/[,，￥¥円\s]/g, '').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
  const n = Number(s)
  return isFinite(n) ? n : 0
}

/** Excelシリアル値 or 日付文字列 → YYYY-MM-DD（解釈できなければ null） */
function toDateStr(v: unknown): string | null {
  if (v == null || v === '') return null
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    // Excelシリアル（1900年基準）。UTCで計算してタイムゾーンずれを防ぐ
    const d = new Date(Math.round((v - 25569) * 86400 * 1000))
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
  }
  const s = String(v).trim()
  let m = s.match(/^(\d{4})[/.年-](\d{1,2})[/.月-](\d{1,2})/)
  if (m) {
    const mo = Math.min(12, Math.max(1, Number(m[2])))
    const da = Math.min(31, Math.max(1, Number(m[3])))
    return `${m[1]}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`
  }
  m = s.match(/^[RＲ令和]+(\d{1,2})[/.年-](\d{1,2})[/.月-](\d{1,2})/)
  if (m) {
    const y = 2018 + Number(m[1])
    return `${y}-${String(Number(m[2])).padStart(2, '0')}-${String(Number(m[3])).padStart(2, '0')}`
  }
  return null
}

export function fmtDate(s: string | null): string {
  if (!s) return ''
  const [y, m, d] = s.split('-')
  return `${y}/${Number(m)}/${Number(d)}`
}

// ---------- Excel解析 ----------

type Grid = unknown[][]

const cell = (g: Grid, r: number, c: number): unknown => (g[r] ? g[r][c] : null)
const cellStr = (g: Grid, r: number, c: number): string => {
  const v = cell(g, r, c)
  return v == null ? '' : String(v).trim()
}

/** グリッドから案件ブロック（「物件名」ラベルをアンカーとする8列幅の枠）を全て解析する */
export function parseAnkenGrid(grid: Grid): AnkenItem[] {
  // アンカー検出
  const anchors: { r: number; c: number }[] = []
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r] || []
    for (let c = 0; c < row.length; c++) {
      if (String(row[c] ?? '').trim() === '物件名') anchors.push({ r, c })
    }
  }
  const items: AnkenItem[] = []
  for (const a of anchors) {
    // ブロック高さ: 同じ列の次のアンカーまで（無ければ40行）
    const next = anchors.find((b) => b.c === a.c && b.r > a.r)
    const rEnd = next ? next.r : Math.min(grid.length, a.r + 40)
    const it = parseBlock(grid, a.r, a.c, rEnd)
    if (it) items.push(it)
  }
  return items
}

function parseBlock(g: Grid, r0: number, c0: number, rEnd: number): AnkenItem | null {
  // ラベル行の探索（様式の行ずれに強くするため、位置固定でなくラベル文字列で探す）
  const findRow = (label: string, col: number): number => {
    for (let r = r0; r < rEnd; r++) {
      if (cellStr(g, r, col).replace(/[\s　]/g, '') === label) return r
    }
    return -1
  }
  const bukken = cellStr(g, r0, c0 + 1)

  const rKeiyaku = findRow('契約者', c0)
  let keiyakusha = rKeiyaku >= 0 ? cellStr(g, rKeiyaku, c0 + 1) : ''
  // 契約者の下の「氏名・名称」行に記載がある様式にも対応
  if (rKeiyaku >= 0) {
    const sub = cellStr(g, rKeiyaku + 1, c0 + 1)
    if (sub && !keiyakusha) keiyakusha = sub
    else if (sub && sub !== keiyakusha) keiyakusha = `${keiyakusha} ${sub}`
  }

  const rShozai = findRow('所在地', c0)
  const shozaichi = rShozai >= 0 ? cellStr(g, rShozai, c0 + 1) : ''
  const rKozo = findRow('構造及び規模', c0)
  const kozo = rKozo >= 0 ? cellStr(g, rKozo, c0 + 1) : ''

  const rKeiyakuDate = findRow('契約日', c0)
  const keiyakuDate = rKeiyakuDate >= 0 ? toDateStr(cell(g, rKeiyakuDate, c0 + 1)) : null
  // 履行期間: 契約日と同じ行の右側（開始）、その下1〜3行（終了）
  let periodStart: string | null = null
  let periodEnd: string | null = null
  if (rKeiyakuDate >= 0) {
    periodStart = toDateStr(cell(g, rKeiyakuDate, c0 + 4))
    for (let r = rKeiyakuDate + 1; r <= rKeiyakuDate + 3 && r < rEnd; r++) {
      const d = toDateStr(cell(g, r, c0 + 4))
      if (d) { periodEnd = d; break }
    }
  }

  const rHoshu = findRow('報酬額', c0)
  const hoshuGross = rHoshu >= 0 ? toNumber(cell(g, rHoshu, c0 + 1)) : 0
  // （内）消費税: 報酬額と同じ行の右側
  let shohizei = 0
  let tesuryo = 0
  if (rHoshu >= 0) {
    for (let r = rHoshu; r <= rHoshu + 3 && r < rEnd; r++) {
      const lbl = cellStr(g, r, c0 + 4).replace(/[\s　]/g, '')
      if (/消費税/.test(lbl)) shohizei = toNumber(cell(g, r, c0 + 5))
      if (/申請手数料/.test(lbl)) tesuryo = toNumber(cell(g, r, c0 + 5))
    }
  }
  const hoshuNet = hoshuGross - shohizei

  // 外注（業務の一部委託）: 「委託業務概要」行の受託者 氏名・名称が入力されている場合のみ計上
  const gaichu: AnkenGaichu[] = []
  for (let r = r0; r < rEnd; r++) {
    if (cellStr(g, r, c0).replace(/[\s　]/g, '') !== '委託業務概要') continue
    const name = cellStr(g, r, c0 + 5)
    if (!name) continue
    const overview = cellStr(g, r, c0 + 1)
    // 金額: 下1〜3行の「金 額」ラベル行
    let amount = 0
    for (let r2 = r + 1; r2 <= r + 3 && r2 < rEnd; r2++) {
      if (/^金額$/.test(cellStr(g, r2, c0).replace(/[\s　]/g, ''))) { amount = toNumber(cell(g, r2, c0 + 1)); break }
    }
    gaichu.push({ name, overview, amount })
  }

  // 備考（表示用に1行だけ）
  let biko = ''
  const rBiko = findRow('備考', c0)
  if (rBiko >= 0) {
    for (let r = rBiko; r < rEnd; r++) {
      const v = cellStr(g, r, c0 + 1)
      if (v) { biko = v; break }
    }
  }

  // 空ブロックはスキップ
  if (!bukken && !keiyakusha && !hoshuGross) return null

  const key = `${normKey(bukken)}|${normKey(keiyakusha)}`
  return { key, bukken, keiyakusha, shozaichi, kozo, keiyakuDate, periodStart, periodEnd, hoshuNet, tesuryo, gaichu, biko }
}

/** RTDB/localStorage から読み込んだ案件データの正規化。
 *  Firebase は null・空文字・空配列を保存時に削除するため、欠けたプロパティを
 *  既定値で補わないと gaichu.reduce 等が TypeError で画面全体を落とす。 */
export function normalizeAnkenItems(raw: unknown): AnkenItem[] {
  const arr = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? Object.values(raw) : []
  const items: AnkenItem[] = []
  for (const v of arr) {
    if (!v || typeof v !== 'object') continue
    const it = v as Partial<AnkenItem>
    const gaichuRaw = Array.isArray(it.gaichu) ? it.gaichu : it.gaichu && typeof it.gaichu === 'object' ? Object.values(it.gaichu) : []
    items.push({
      key: String(it.key || ''),
      bukken: String(it.bukken || ''),
      keiyakusha: String(it.keiyakusha || ''),
      shozaichi: String(it.shozaichi || ''),
      kozo: String(it.kozo || ''),
      keiyakuDate: it.keiyakuDate || null,
      periodStart: it.periodStart || null,
      periodEnd: it.periodEnd || null,
      hoshuNet: Number(it.hoshuNet) || 0,
      tesuryo: Number(it.tesuryo) || 0,
      gaichu: gaichuRaw.filter(Boolean).map((g) => ({
        name: String((g as AnkenGaichu).name || ''),
        overview: String((g as AnkenGaichu).overview || ''),
        amount: Number((g as AnkenGaichu).amount) || 0,
      })),
      biko: String(it.biko || ''),
    })
  }
  return items.filter((it) => it.key)
}

/** 既存データへ新規解析分をマージ（同一キー＝同一案件は新しい内容で上書き） */
export function mergeAnken(existing: AnkenItem[], parsed: AnkenItem[]): AnkenItem[] {
  const map = new Map<string, AnkenItem>()
  for (const it of existing) map.set(it.key, it)
  for (const it of parsed) map.set(it.key, it)
  return Array.from(map.values())
}

// ---------- 事業年度への割り当て ----------

export interface AnkenYearGroup {
  label: string // 例: 2026年5月期
  fyEndYear: number | null // null = 期判定不能
  items: AnkenItem[]
  totalHoshu: number
  totalTesuryo: number
  totalGaichu: number
  totalArari: number
}

export const gaichuTotal = (it: AnkenItem): number => (it.gaichu || []).reduce((s, x) => s + (x?.amount || 0), 0)
export const arari = (it: AnkenItem): number => it.hoshuNet - gaichuTotal(it)

/** 履行期間の終了日（無ければ契約日→開始日）が属する事業年度（決算月で区切る）を判定 */
export function fiscalYearOf(it: AnkenItem, closingMonth: number): number | null {
  const base = it.periodEnd || it.keiyakuDate || it.periodStart
  if (!base) return null
  const y = Number(base.slice(0, 4))
  const m = Number(base.slice(5, 7))
  return m <= closingMonth ? y : y + 1
}

export function groupByFiscalYear(items: AnkenItem[], closingMonth: number): AnkenYearGroup[] {
  const map = new Map<string, AnkenYearGroup>()
  for (const it of items) {
    const fy = fiscalYearOf(it, closingMonth)
    const label = fy == null ? '期判定不能（日付なし）' : `${fy}年${closingMonth}月期`
    let grp = map.get(label)
    if (!grp) {
      grp = { label, fyEndYear: fy, items: [], totalHoshu: 0, totalTesuryo: 0, totalGaichu: 0, totalArari: 0 }
      map.set(label, grp)
    }
    grp.items.push(it)
    grp.totalHoshu += it.hoshuNet
    grp.totalTesuryo += it.tesuryo
    grp.totalGaichu += gaichuTotal(it)
    grp.totalArari += arari(it)
  }
  const groups = Array.from(map.values())
  // 新しい期を先に。期不明は最後
  groups.sort((a, b) => (b.fyEndYear ?? -1) - (a.fyEndYear ?? -1))
  for (const grp of groups) {
    grp.items.sort((a, b) => (a.keiyakuDate || a.periodStart || '9999').localeCompare(b.keiyakuDate || b.periodStart || '9999'))
  }
  return groups
}
