// 申告書チェック: ページ分類・金額抽出・突合ロジック（純粋関数・API不使用）
// 税務ソフトが出力するテキスト層付きPDFを前提に、座標付きトークンから様式ごとに金額を抽出する。
import type {
  Tok,
  Line,
  Page,
  ClassifiedPage,
  CheckResult,
  AnalyzeResult,
  CheckStatus,
} from './types'

// ---------- 基本ヘルパー ----------

const AMOUNT_RE = /^[-△▲]?\d{1,3}(,\d{3})+$|^[-△▲]?\d+$/

function isAmountTok(t: Tok): boolean {
  const s = t.s.trim()
  return AMOUNT_RE.test(s)
}

function parseAmount(s: string): number {
  s = s.trim()
  const neg = /^[△▲-]/.test(s)
  const v = parseInt(s.replace(/[△▲,\-]/g, ''), 10)
  if (isNaN(v)) return 0
  return neg ? -v : v
}

// カンマ付き数値のみ（行番号・日付との誤認を防ぐ厳格版）
function isStrictAmountTok(t: Tok): boolean {
  return /^[-△▲]?\d{1,3}(,\d{3})+$/.test(t.s.trim())
}

function normText(line: Line): string {
  return line.toks.map((t) => t.s).join('').replace(/\s+/g, '')
}

function pageText(p: Page): string {
  return p.lines.map(normText).join('\n')
}

// 指定Y帯・X範囲の金額トークンを収集
function amountsInBand(
  p: Page,
  yMin: number,
  yMax: number,
  xMin = 0,
  xMax = 9999,
  strict = false,
): Tok[] {
  const out: Tok[] = []
  for (const l of p.lines) {
    if (l.y < yMin || l.y > yMax) continue
    for (const t of l.toks) {
      if (t.x < xMin || t.x > xMax) continue
      if (strict ? isStrictAmountTok(t) : isAmountTok(t)) out.push(t)
    }
  }
  out.sort((a, b) => a.y - b.y || a.x - b.x)
  return out
}

function findLine(p: Page, re: RegExp): Line | null {
  for (const l of p.lines) if (re.test(normText(l))) return l
  return null
}

// ---------- ページ分類 ----------

const UCHIWAKE_TYPES: [string, RegExp][] = [
  ['預貯金', /預貯金等の内訳書/],
  ['受取手形', /受取手形の内訳書/],
  ['有価証券', /有価証券の内訳書/],
  ['売掛金', /売掛金（未収入金）の内訳書/],
  ['仮払金・貸付金', /仮払金（前渡金）の内訳書/],
  ['棚卸資産', /棚卸資産（商品又は製品/],
  ['固定資産(土地建物)', /固定資産（土地、土地の上に存する権利及び建物に限る/],
  ['支払手形', /支払手形の内訳書/],
  ['買掛金', /買掛金（未払金・未払費用）の内訳書/],
  ['仮受金', /仮受金（前受金・預り金）の内訳書/],
  ['借入金', /借入金及び支払利子の内訳書/],
  ['役員給与', /役員給与等の内訳書/],
  ['地代家賃', /地代家賃等の内訳書/],
  ['雑益雑損失', /雑益、雑損失等の内訳書/],
]

export function classifyPages(pages: Page[]): ClassifiedPage[] {
  const out: ClassifiedPage[] = []
  for (const p of pages) {
    const txt = pageText(p).replace(/\s+/g, '')
    // 様式名の判定はページ上部のみ（注記文中に他様式の名称が引用されることがあるため）
    const headTxt = p.lines
      .filter((l) => l.y < 130)
      .map(normText)
      .join('\n')
    let kind: ClassifiedPage['kind'] = 'other'
    let subType: string | undefined
    const uw = UCHIWAKE_TYPES.find(([, re]) => re.test(headTxt))
    if (uw) {
      kind = 'uchiwake'
      subType = uw[0]
    } else if (/所得の金額の計算に関する明細書/.test(txt)) kind = 'beppyo4'
    else if (/利益積立金額及び資本金等の額/.test(txt)) kind = 'beppyo51'
    else if (/租税公課の納付状況等に関する/.test(txt)) kind = 'beppyo52'
    else if (/所得税額の控除に関する明細書/.test(txt)) kind = 'beppyo61'
    else if (/交際費等の損金算入に関する/.test(txt)) kind = 'beppyo15'
    else if (/償却額の計算に関する明細書/.test(txt)) kind = 'beppyo16'
    else if (/この申告書による消費税の税額の計算/.test(txt)) kind = 'shohizei-1'
    else if (/法人事業概況説明書/.test(txt) || /売上\(収入\)金額|売上（収入）金額/.test(txt)) kind = 'gaikyo'
    else if (/税率別消費税額計算表/.test(txt)) kind = 'shohizei-fuhyo'
    else if (/株主資本等変動計算書|個別注記表|注記/.test(txt.slice(0, 400)) && !/損益計算書|貸借対照表/.test(txt.slice(0, 200))) kind = 'other'
    else if (/損益計算書|製造原価報告書|販売費及び一般管理費/.test(txt.slice(0, 300))) kind = 'pl'
    else if (/貸借対照表/.test(txt.slice(0, 200))) kind = 'bs'
    else {
      // 表題なしで「科目/金額」ヘッダを持つページは直前の決算書の続き
      const prev = out[out.length - 1]
      const hasHead = p.lines.some((l) => l.y < 130 && /科目金額/.test(normText(l)))
      if (hasHead && prev && (prev.kind === 'pl' || prev.kind === 'bs' || prev.kind === 'fs-cont')) {
        kind = 'fs-cont'
      }
    }
    out.push({ ...p, kind, subType })
  }
  return out
}

// ---------- 決算書（PL/BS）の科目→金額プール ----------

export interface FsPool {
  // label(正規化) → 金額の配列（同名科目が販管費と製造原価などに複数回出るケース）
  entries: Map<string, number[]>
}

export function buildFsPool(pages: ClassifiedPage[]): FsPool {
  const entries = new Map<string, number[]>()
  const seen = new Set<string>() // label|value の重複除去（要約と明細の二重計上防止）
  for (const p of pages) {
    if (p.kind !== 'pl' && p.kind !== 'bs' && p.kind !== 'fs-cont') continue
    for (const l of p.lines) {
      // トークンを左→右に走査し、「ラベル文字列＋金額」の組を拾う（BSの左右2カラムにも対応）
      let label = ''
      let prevX: number | null = null
      for (const t of l.toks) {
        const isAmt = isAmountTok(t)
        // ラベル文字が大きな横間隔を空けて始まる＝別カラムの始まり。
        // 左カラムの余ったラベル（例:「固定資産」見出し）を右カラムへ引き継がない。
        // 金額トークンは列内で右寄せされるため間隔が大きくても直前ラベルと対応させる。
        if (!isAmt && prevX != null && t.x - prevX > 130) label = ''
        prevX = t.x
        if (isAmt) {
          const lab = label.replace(/\s+/g, '')
          if (lab && !/^[（(]/.test(lab)) {
            const v = parseAmount(t.s)
            const key = lab + '|' + v
            if (!seen.has(key)) {
              seen.add(key)
              const arr = entries.get(lab) || []
              arr.push(v)
              entries.set(lab, arr)
            }
          }
          label = ''
        } else {
          label += t.s
        }
      }
    }
  }
  return { entries }
}

// 完全一致で最初の値
export function fsGet(pool: FsPool, ...labels: string[]): number | null {
  for (const lab of labels) {
    const arr = pool.entries.get(lab)
    if (arr && arr.length) return arr[0]
  }
  return null
}

// 該当ラベル群の全出現値を合算（1つも無ければnull）
export function fsSum(pool: FsPool, labels: string[]): number | null {
  let sum = 0
  let found = false
  for (const lab of labels) {
    const arr = pool.entries.get(lab)
    if (arr) {
      found = true
      for (const v of arr) sum += v
    }
  }
  return found ? sum : null
}

// ---------- 法人税別表の抽出 ----------

// 別表四(1) 当期利益又は当期欠損の額（①総額）
function extractBeppyo4Profit(p: Page): number | null {
  const l = findLine(p, /当期利益又は当期欠損の額/)
  if (!l) return null
  const amts = amountsInBand(p, l.y - 2, l.y + 10, 150, 9999, true)
  return amts.length ? parseAmount(amts[0].s) : null
}

// 別表五(一)：行ラベルの近傍（下方向）にある金額のうち最後（＝④差引翌期首現在）
function extractBeppyo51(p: Page, re: RegExp): number | null {
  const l = findLine(p, re)
  if (!l) return null
  const amts = amountsInBand(p, l.y - 2, l.y + 14, 100, 9999, true)
  return amts.length ? parseAmount(amts[amts.length - 1].s) : null
}

// 別表五(二)の抽出
interface Beppyo52 {
  sonkinKeiriPay: number | null // ⑤損金経理による納付の合計（計行＋その他の各行）
  nozeiJutokinKeiri: number | null // (31)損金経理をした納税充当金
  kimatsuJutokin: number | null // (41)期末納税充当金
}

function extractBeppyo52(p: Page): Beppyo52 {
  // 列位置: ①〜⑥ヘッダトークンから列境界を求める
  const colX: number[] = []
  for (const l of p.lines) {
    if (l.y > 130) break
    const marks = l.toks.filter((t) => /^[①②③④⑤⑥]$/.test(t.s.trim()))
    if (marks.length >= 5) {
      for (const m of marks) colX[['①', '②', '③', '④', '⑤', '⑥'].indexOf(m.s.trim())] = m.x
      break
    }
  }
  let sonkinKeiriPay: number | null = null
  if (colX[4] != null) {
    const lo = colX[3] != null ? (colX[3] + colX[4]) / 2 : colX[4] - 34
    const hi = colX[5] != null ? (colX[4] + colX[5]) / 2 : colX[4] + 34
    // 対象行: 計行(5,10,15,19)とその他の各行(20〜29)。行番号トークンはx≈140〜165
    let sum = 0
    let found = false
    for (const l of p.lines) {
      if (l.y > 590) break // 納税充当金の計算より下は対象外
      const rowNum = l.toks.find(
        (t) => t.x >= 138 && t.x <= 168 && /^(5|10|15|19|2[0-9])$/.test(t.s.trim()),
      )
      if (!rowNum) continue
      const amts = amountsInBand(p, l.y - 8, l.y + 8, lo, hi)
      if (amts.length) {
        sum += parseAmount(amts[0].s)
        found = true
      } else {
        found = true // 行は存在（⑤が空欄=0）
      }
    }
    sonkinKeiriPay = found ? sum : null
  }
  // (31) 損金経理をした納税充当金
  let nozeiJutokinKeiri: number | null = null
  {
    const l = findLine(p, /損金経理をした納税充当金/)
    if (l) {
      const amts = amountsInBand(p, l.y - 2, l.y + 10, 200, 320, true)
      nozeiJutokinKeiri = amts.length ? parseAmount(amts[0].s) : 0
    }
  }
  // (41) 期末納税充当金
  let kimatsuJutokin: number | null = null
  {
    const l = findLine(p, /期末納税充当金/)
    if (l) {
      const amts = amountsInBand(p, l.y - 2, l.y + 12, 460, 9999, true)
      kimatsuJutokin = amts.length ? parseAmount(amts[0].s) : 0
    }
  }
  return { sonkinKeiriPay, nozeiJutokinKeiri, kimatsuJutokin }
}

// 別表六(一)の行1（利子）・行2（配当）の収入金額①
function extractBeppyo61Row(p: Page, rowNum: number): number | null {
  for (const l of p.lines) {
    if (l.y < 100 || l.y > 330) continue
    const rn = l.toks.find(
      (t) => t.x >= 178 && t.x <= 198 && t.s.trim() === String(rowNum),
    )
    if (!rn) continue
    const amts = amountsInBand(p, l.y - 6, l.y + 6, 200, 350)
    return amts.length ? parseAmount(amts[0].s) : 0
  }
  return null
}

// 別表十六: 合計列がある各ページから「期末現在の帳簿記載金額」「当期償却額」を合算
interface Beppyo16 {
  bookValue: number | null
  currentDep: number | null
  pagesUsed: number
}

function extractBeppyo16(pages: ClassifiedPage[]): Beppyo16 {
  let bookValue = 0
  let currentDep = 0
  let pagesUsed = 0
  let found = false
  for (const p of pages) {
    if (p.kind !== 'beppyo16') continue
    // 上部ヘッダ(y<110)から「合計」列の位置を探す
    let colX: number | null = null
    for (const l of p.lines) {
      if (l.y > 110) break
      for (let i = 0; i < l.toks.length; i++) {
        const t = l.toks[i]
        if (t.s.trim() === '合計') {
          colX = t.x
          break
        }
        if (
          t.s.trim() === '合' &&
          l.toks[i + 1] &&
          l.toks[i + 1].s.trim() === '計' &&
          l.toks[i + 1].x - t.x < 60
        ) {
          colX = t.x
          break
        }
      }
      if (colX != null) break
    }
    if (colX == null) continue // 合計列が無いページ（資産別の中間ページ）は合計ページ側で集計される
    const lo = colX - 25
    const hi = colX + 90
    const bkLine = findLine(p, /期末現在の帳簿記載金額/)
    const depLine = p.lines.find((l) => /^当期償却額\d/.test(normText(l)))
    let ok = false
    if (bkLine) {
      // ラベル行に最も近い金額を採用（近傍の取得価額行などを拾わないため）
      const amts = amountsInBand(p, bkLine.y - 14, bkLine.y + 14, lo, hi, true)
      if (amts.length) {
        amts.sort((a, b) => Math.abs(a.y - bkLine.y) - Math.abs(b.y - bkLine.y))
        bookValue += parseAmount(amts[0].s)
        ok = true
      }
    }
    if (depLine) {
      const amts = amountsInBand(p, depLine.y - 6, depLine.y + 6, lo, hi, true)
      if (amts.length) {
        currentDep += parseAmount(amts[0].s)
        ok = true
      }
    }
    if (ok) {
      pagesUsed++
      found = true
    }
  }
  return {
    bookValue: found ? bookValue : null,
    currentDep: found ? currentDep : null,
    pagesUsed,
  }
}

// ---------- 勘定科目内訳明細書の抽出 ----------

// 「期末現在高」等のヘッダ列位置を探し、最終ページのその列の一番下の金額＝合計とみなす
function uchiwakeTotal(
  pages: ClassifiedPage[],
  subType: string,
  headerRe: RegExp = /期末現在高/,
  colWidth = 74,
): number | null {
  const grp = pages.filter((p) => p.kind === 'uchiwake' && p.subType === subType)
  if (!grp.length) return null
  const last = grp[grp.length - 1]
  // ヘッダ位置（表上部 y<250 のヘッダ行から探す。続きページにヘッダが無い様式は
  // 同じ内訳書の他ページからX位置を借用する）
  let hx: number | null = null
  for (let gi = grp.length - 1; gi >= 0 && hx == null; gi--) {
    for (const l of grp[gi].lines) {
      if (l.y >= 250) continue
      const nt = normText(l)
      const m = nt.match(headerRe)
      if (m) {
        const ch = m[0][0]
        const tok = l.toks.find((t) => t.s.replace(/\s+/g, '').startsWith(ch))
        hx = tok ? tok.x : l.toks[0].x
        break
      }
    }
  }
  if (hx == null) return null
  const amts = amountsInBand(last, 100, 745, hx - 22, hx + colWidth, true)
  if (!amts.length) return null
  return parseAmount(amts[amts.length - 1].s)
}

// ===== 科目ごと明細ベースの内訳書チェック =====
// 内訳書の「科目」欄には決算書と同じ勘定科目名が記載され、科目ごとに「計」行がある
// （1件だけの科目は計行が無いこともある）。科目ごとの計を決算書の同名科目と突合する。

export interface KamokuTotal {
  kamoku: string
  amount: number
}

// 「科目」列を持つ内訳書から 科目→計 のリストを抽出する。
// 行の対応付けは金額（期末現在高列）を基準に、近傍の科目列トークンを連結して行う。
function kamokuUchiwakeTotals(
  pages: ClassifiedPage[],
  subType: string,
  amountHeaderRe: RegExp = /期末現在高/,
): KamokuTotal[] {
  const grp = pages.filter((p) => p.kind === 'uchiwake' && p.subType === subType)
  if (!grp.length) return []
  interface Rec {
    kamoku: string
    amount: number
  }
  const recs: Rec[] = []
  for (const p of grp) {
    // 科目列と金額列のX位置（各ページのヘッダから）
    let kx: number | null = null
    let ax: number | null = null
    let bodyTop = 0
    for (const l of p.lines) {
      if (l.y > 300) break
      const nt = normText(l)
      if (kx == null && /^科/.test((l.toks[0]?.s || '').trim()) && /科目/.test(nt)) {
        kx = l.toks[0].x
        bodyTop = l.y + 8
      }
      if (ax == null && amountHeaderRe.test(nt)) {
        const m = nt.match(amountHeaderRe)
        const ch = m ? m[0][0] : ''
        const tok = l.toks.find((t) => t.s.replace(/\s+/g, '').startsWith(ch))
        if (tok) ax = tok.x
      }
      if (kx != null && ax != null) break
    }
    if (kx == null || ax == null) continue
    // 本文の下限: （注）行 または 2つ目の様式（貸付金及び受取利息の内訳書 等）の手前
    let bodyEnd = 750
    for (const l of p.lines) {
      const nt = normText(l)
      if (l.y > bodyTop && (/^（注）/.test(nt) || /受取利息の内訳書/.test(nt))) {
        bodyEnd = Math.min(bodyEnd, l.y - 2)
      }
    }
    // 金額行ごとに、近傍の科目列トークンを連結
    for (const l of p.lines) {
      if (l.y < bodyTop || l.y > bodyEnd) continue
      for (const t of l.toks) {
        if (t.x < ax - 25 || t.x > ax + 72) continue
        if (!isStrictAmountTok(t)) continue
        let kamoku = ''
        for (const l2 of p.lines) {
          if (l2.y < t.y - 9 || l2.y > t.y + 8) continue
          for (const t2 of l2.toks) {
            if (t2.x >= kx - 18 && t2.x <= kx + 38) kamoku += t2.s.replace(/\s+/g, '')
          }
        }
        recs.push({ kamoku, amount: parseAmount(t.s) })
      }
    }
  }
  if (!recs.length) return []
  // グループ集計: 科目名が変わるたびにグループを閉じる。計行があれば計を、無ければ明細合計を採用
  const totals = new Map<string, number>()
  let curName = ''
  let itemSum = 0
  let kei: number | null = null
  const close = () => {
    if (curName) {
      totals.set(curName, (totals.get(curName) || 0) + (kei != null ? kei : itemSum))
    }
    itemSum = 0
    kei = null
  }
  for (const r of recs) {
    const k = r.kamoku
    if (k === '合計') {
      close()
      curName = ''
      continue
    }
    if (k === '計') {
      kei = r.amount
      continue
    }
    if (k && k !== curName) {
      close()
      curName = k
    }
    itemSum += r.amount
  }
  close()
  return Array.from(totals.entries()).map(([kamoku, amount]) => ({ kamoku, amount }))
}

// 内訳書の科目名を決算書の科目と照合する。完全一致→部分一致（一意）→金額一致で絞り込み
function matchFsKamoku(
  pool: FsPool,
  kamoku: string,
  amount: number,
): { label: string; value: number; note?: string } | null {
  const direct = pool.entries.get(kamoku)
  if (direct && direct.length) return { label: kamoku, value: direct[0] }
  if (kamoku.length < 2) return null
  const cands: { label: string; value: number }[] = []
  pool.entries.forEach((vals, label) => {
    if (label.length < 2) return
    if (label.includes(kamoku) || kamoku.includes(label)) cands.push({ label, value: vals[0] })
  })
  if (!cands.length) {
    // 語順違い（例: 内訳書「積立保険」⇔ BS「保険積立金」）: 科目名の全文字を含むBS科目が一意なら採用
    const chars = Array.from(new Set(kamoku.split('')))
    const sub: { label: string; value: number }[] = []
    pool.entries.forEach((vals, label) => {
      if (label.length < 2 || label.length > kamoku.length + 2) return
      if (chars.every((c) => label.includes(c))) sub.push({ label, value: vals[0] })
    })
    if (sub.length === 1) return { label: sub[0].label, value: sub[0].value, note: `決算書の科目「${sub[0].label}」と照合しました。` }
    return null
  }
  if (cands.length === 1)
    return { label: cands[0].label, value: cands[0].value, note: `決算書の科目「${cands[0].label}」と照合しました。` }
  const eq = cands.filter((c) => c.value === amount)
  if (eq.length === 1)
    return { label: eq[0].label, value: eq[0].value, note: `決算書の科目「${eq[0].label}」と照合しました。` }
  cands.sort((a, b) => Math.abs(a.value - amount) - Math.abs(b.value - amount))
  return {
    label: cands[0].label,
    value: cands[0].value,
    note: `科目名の候補が複数（${cands.map((c) => c.label).join('・')}）あるため「${cands[0].label}」と照合しました。`,
  }
}

// 借入金内訳書: 摘要・担保欄に長期/短期等の科目名が書かれている場合の科目別集計。
// 科目別合計の総和が合計行と一致する場合のみ採用する（書き方は事務所により異なるため）。
function loanKamokuTotals(pages: ClassifiedPage[]): KamokuTotal[] {
  const grp = pages.filter((p) => p.kind === 'uchiwake' && p.subType === '借入金')
  if (!grp.length) return []
  const totals = new Map<string, number>()
  let grand: number | null = null
  let curName = ''
  let itemSum = 0
  let kei: number | null = null
  let sawLabel = false
  const close = () => {
    if (curName) totals.set(curName, (totals.get(curName) || 0) + (kei != null ? kei : itemSum))
    itemSum = 0
    kei = null
  }
  for (const p of grp) {
    for (const l of p.lines) {
      if (l.y < 130 || l.y > 690) continue
      const amt = l.toks.find((t) => t.x >= 296 && t.x <= 390 && isStrictAmountTok(t))
      // 行ラベル: 近傍の名称列（計 判定用）と右端列（科目名）
      let nameCol = ''
      let rightCol = ''
      const yy = amt ? amt.y : l.y
      for (const l2 of p.lines) {
        if (l2.y < yy - 9 || l2.y > yy + 8) continue
        for (const t2 of l2.toks) {
          if (t2.x >= 50 && t2.x <= 250 && !isAmountTok(t2)) nameCol += t2.s.replace(/\s+/g, '')
          if (t2.x >= 455) rightCol += t2.s.replace(/\s+/g, '')
        }
      }
      if (!amt) continue
      const v = parseAmount(amt.s)
      if (/^合計/.test(nameCol) || nameCol === '合計') {
        grand = v
        close()
        curName = ''
        continue
      }
      if (nameCol === '計') {
        kei = v
        continue
      }
      const m = rightCol.match(/(長期借入金|短期借入金|役員借入金|一年内返済予定長期借入金|1年内返済予定長期借入金|借入金)/)
      if (m) {
        sawLabel = true
        if (m[1] !== curName) {
          close()
          curName = m[1]
        }
      }
      itemSum += v
    }
  }
  close()
  if (!sawLabel) return []
  const list = Array.from(totals.entries()).map(([kamoku, amount]) => ({ kamoku, amount }))
  const sum = list.reduce((s, x) => s + x.amount, 0)
  if (grand != null && sum !== grand) return [] // 書式が想定と異なる場合は科目別を採用しない
  return list
}

// 役員給与等の内訳書から代表者（役職に「代表」または関係「本人」）の氏名と役員給与計を取得
function daihyoFromYakuin(pages: ClassifiedPage[]): { name: string; amount: number } | null {
  const grp = pages.filter((p) => p.kind === 'uchiwake' && p.subType === '役員給与')
  for (const p of grp) {
    for (const l of p.lines) {
      if (l.y < 130 || l.y > 520) continue
      const yakushoku = l.toks
        .filter((t) => t.x >= 50 && t.x <= 105)
        .map((t) => t.s.replace(/\s+/g, ''))
        .join('')
      const relation = l.toks
        .filter((t) => t.x >= 180 && t.x <= 232)
        .map((t) => t.s.replace(/\s+/g, ''))
        .join('')
      if (!/代表/.test(yakushoku) && relation !== '本人') continue
      const name = l.toks
        .filter((t) => t.x > 105 && t.x < 180)
        .map((t) => t.s.replace(/\s+/g, ''))
        .join('')
      if (!name) continue
      // 役員給与計列（x≈255〜305）の金額を行の下方向から探す
      const amts = amountsInBand(p, l.y - 2, l.y + 18, 252, 306, true)
      if (amts.length) return { name, amount: parseAmount(amts[0].s) }
    }
  }
  return null
}

// 借入金内訳書のうち、借入先名称が代表者名と一致する行の期末現在高合計
function loanFromDaihyo(pages: ClassifiedPage[], daihyoName: string): number | null {
  const grp = pages.filter((p) => p.kind === 'uchiwake' && p.subType === '借入金')
  if (!grp.length) return null
  let sum = 0
  let found = false
  const target = daihyoName.replace(/[\s　]/g, '')
  for (const p of grp) {
    for (const l of p.lines) {
      if (l.y < 130 || l.y > 690) continue
      const amt = l.toks.find((t) => t.x >= 296 && t.x <= 390 && isStrictAmountTok(t))
      if (!amt) continue
      let nameCol = ''
      for (const l2 of p.lines) {
        if (l2.y < amt.y - 9 || l2.y > amt.y + 8) continue
        for (const t2 of l2.toks) {
          if (t2.x >= 50 && t2.x <= 250 && !isAmountTok(t2)) nameCol += t2.s.replace(/\s+/g, '')
        }
      }
      if (nameCol === '計' || /^合計/.test(nameCol)) continue
      if (nameCol.includes(target)) {
        sum += parseAmount(amt.s)
        found = true
      }
    }
  }
  return found ? sum : null
}

// 地代家賃内訳書のうち、貸主名称が代表者名と一致する行の支払賃借料合計
function rentToDaihyo(pages: ClassifiedPage[], daihyoName: string): number | null {
  const grp = pages.filter((p) => p.kind === 'uchiwake' && p.subType === '地代家賃')
  if (!grp.length) return null
  let sum = 0
  let found = false
  const target = daihyoName.replace(/[\s　]/g, '')
  for (const p of grp) {
    for (const l of p.lines) {
      if (l.y < 135 || l.y > 700) continue
      for (const t of l.toks) {
        if (t.x < 435 || t.x > 482 || !isStrictAmountTok(t)) continue
        // 合計行を除外
        let isTotal = false
        let lender = ''
        for (const l2 of p.lines) {
          if (l2.y < t.y - 20 || l2.y > t.y + 3) continue
          const nt = normText(l2)
          if (/^合計/.test(nt)) isTotal = true
          for (const t2 of l2.toks) {
            if (t2.x >= 265 && t2.x <= 405 && !isAmountTok(t2)) lender += t2.s.replace(/\s+/g, '')
          }
        }
        if (isTotal) continue
        if (lender.includes(target)) {
          sum += parseAmount(t.s)
          found = true
        }
      }
    }
  }
  return found ? sum : null
}

// 貸付金及び受取利息の内訳書（仮払金内訳書の下段）のうち、貸付先名称が代表者名の行の期末現在高合計
function lendToDaihyo(pages: ClassifiedPage[], daihyoName: string): number | null {
  const grp = pages.filter((p) => p.kind === 'uchiwake' && p.subType === '仮払金・貸付金')
  if (!grp.length) return null
  let sum = 0
  let found = false
  const target = daihyoName.replace(/[\s　]/g, '')
  for (const p of grp) {
    // 下段様式の開始行と期末現在高列
    let top: number | null = null
    let ax: number | null = null
    for (const l of p.lines) {
      const nt = normText(l)
      if (top == null && /受取利息の内訳書/.test(nt)) top = l.y
      if (top != null && ax == null && /期末現在高/.test(nt) && l.y > top) {
        const tok = l.toks.find((t) => t.s.replace(/\s+/g, '').startsWith('期'))
        if (tok) ax = tok.x
      }
    }
    if (top == null || ax == null) continue
    for (const l of p.lines) {
      if (l.y < top + 20 || l.y > 700) continue
      for (const t of l.toks) {
        if (t.x < ax - 25 || t.x > ax + 45 || !isStrictAmountTok(t)) continue
        let nameCol = ''
        for (const l2 of p.lines) {
          if (l2.y < t.y - 9 || l2.y > t.y + 8) continue
          for (const t2 of l2.toks) {
            if (t2.x >= 45 && t2.x <= 210 && !isAmountTok(t2)) nameCol += t2.s.replace(/\s+/g, '')
          }
        }
        if (nameCol === '計' || /合計/.test(nameCol)) continue
        if (nameCol.includes(target)) {
          sum += parseAmount(t.s)
          found = true
        }
      }
    }
  }
  return found ? sum : null
}

// 法人事業概況説明書「11 代表者に対する報酬等の金額」（千円・1マス1桁）
function extractGaikyo11(pages: ClassifiedPage[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const p of pages) {
    if (p.kind !== 'gaikyo') continue
    const anchor = findLine(p, /代表者に対する報酬等の金額/)
    if (!anchor) continue
    const FIELDS = ['報酬', '貸付金', '仮払金', '賃借料', '支払利息', '借入金', '仮受金']
    for (const l of p.lines) {
      if (l.y < anchor.y - 12 || l.y > anchor.y + 22) continue
      // 行内のラベル位置を拾い、次のラベルまでの範囲で桁連結
      const labels: { name: string; x: number }[] = []
      for (const t of l.toks) {
        const s = t.s.replace(/\s+/g, '')
        if (FIELDS.includes(s)) labels.push({ name: s, x: t.x })
      }
      labels.sort((a, b) => a.x - b.x)
      for (let i = 0; i < labels.length; i++) {
        const lo = labels[i].x + 26
        const hi = i + 1 < labels.length ? labels[i + 1].x - 4 : 575
        const v = joinDigits(l, lo, hi)
        if (v != null && !out.has(labels[i].name)) out.set(labels[i].name, v)
      }
    }
    if (out.size) break
  }
  return out
}

// ===== 別表十五（交際費） =====
// 「支出交際費等の額(1)」＝8の計。損金不算入額ではなく支出額そのものをPLと突合する
function extractBeppyo15Shishutsu(pages: ClassifiedPage[]): number | null {
  for (const p of pages) {
    if (p.kind !== 'beppyo15') continue
    const l = findLine(p, /支出交際費等の額/)
    if (!l) continue
    const amts = amountsInBand(p, l.y - 2, l.y + 14, 195, 315, true)
    if (amts.length) return parseAmount(amts[0].s)
  }
  return null
}

// ===== 受取手形の内訳書 =====
// 摘要に「裏書」注記のある行はBSの受取手形に含まれないため除外して合計する
function uketoriTegata(pages: ClassifiedPage[]): { total: number; ura: number } | null {
  const grp = pages.filter((p) => p.kind === 'uchiwake' && p.subType === '受取手形')
  if (!grp.length) return null
  let total = 0
  let ura = 0
  for (const p of grp) {
    for (const l of p.lines) {
      if (l.y < 120 || l.y > 745) continue
      for (const t of l.toks) {
        if (t.x < 368 || t.x > 425 || !isStrictAmountTok(t)) continue
        let name = ''
        let hasUra = false
        for (const l2 of p.lines) {
          if (l2.y < t.y - 10 || l2.y > t.y + 10) continue
          for (const t2 of l2.toks) {
            const s = t2.s.replace(/\s+/g, '')
            if (t2.x >= 55 && t2.x <= 185) name += s
            if (t2.x > 430 && /裏/.test(s)) hasUra = true
          }
        }
        if (/^合?計/.test(name)) continue // 計・合計行は明細の合算で代替（裏書計と混在するため）
        const v = parseAmount(t.s)
        if (hasUra) ura += v
        else total += v
      }
    }
  }
  return { total, ura }
}

// ===== 有価証券の内訳書（合計行） =====
function yukashokenTotal(pages: ClassifiedPage[]): number | null {
  const grp = pages.filter((p) => p.kind === 'uchiwake' && p.subType === '有価証券')
  if (!grp.length) return null
  const last = grp[grp.length - 1]
  const amts = amountsInBand(last, 120, 705, 170, 245, true)
  if (!amts.length) return null
  return parseAmount(amts[amts.length - 1].s)
}

// ===== 貸付金及び受取利息の内訳書（仮払金内訳書の下段様式）の期末現在高合計 =====
function kashitsukeTotal(pages: ClassifiedPage[]): number | null {
  const grp = pages.filter((p) => p.kind === 'uchiwake' && p.subType === '仮払金・貸付金')
  if (!grp.length) return null
  let sum = 0
  let found = false
  for (const p of grp) {
    let top: number | null = null
    let ax: number | null = null
    for (const l of p.lines) {
      const nt = normText(l)
      if (top == null && /受取利息の内訳書/.test(nt)) top = l.y
      if (top != null && ax == null && /期末現在高/.test(nt) && l.y > top) {
        const tok = l.toks.find((t) => t.s.replace(/\s+/g, '').startsWith('期'))
        if (tok) ax = tok.x
      }
    }
    if (top == null || ax == null) continue
    const amts = amountsInBand(p, top + 20, 705, ax - 25, ax + 55, true)
    if (amts.length) {
      sum += parseAmount(amts[amts.length - 1].s) // 各ページ様式の最下段＝合計
      found = true
    }
  }
  return found ? sum : null
}

// 組み合わせ照合: 合計額と一致するBS科目の組み合わせ（部分集合和）を探す
function matchCombination(
  total: number,
  cands: { label: string; value: number }[],
): { labels: string[]; value: number } | null {
  const n = cands.length
  if (!n || n > 12) return null
  let best: { labels: string[]; value: number } | null = null
  for (let mask = 1; mask < (1 << n); mask++) {
    let s = 0
    const labels: string[] = []
    for (let i = 0; i < n; i++) if (mask & (1 << i)) { s += cands[i].value; labels.push(cands[i].label) }
    if (s === total && (!best || labels.length > best.labels.length)) best = { labels, value: s }
  }
  return best
}

// ===== 固定資産（土地・建物）内訳書: 種類ごとの計（土地・借地権・建物…） =====
// 種類・構造欄のラベルは行の上部、金額（期末現在高）はその下、計・合計のラベルは金額の下に来る様式
function koteishisanKamoku(pages: ClassifiedPage[]): KamokuTotal[] {
  const grp = pages.filter((p) => p.kind === 'uchiwake' && p.subType === '固定資産(土地建物)')
  if (!grp.length) return []
  interface Rec { kamoku: string; amount: number }
  const recs: Rec[] = []
  for (const p of grp) {
    let ax: number | null = null
    for (const l of p.lines) {
      if (l.y > 200) break
      if (/期末現在高/.test(normText(l))) {
        const tok = l.toks.find((t) => t.s.replace(/\s+/g, '').startsWith('期'))
        if (tok) { ax = tok.x; break }
      }
    }
    if (ax == null) continue
    for (const l of p.lines) {
      if (l.y < 150 || l.y > 720) continue
      for (const t of l.toks) {
        if (t.x < ax - 25 || t.x > ax + 60 || !isStrictAmountTok(t)) continue
        // 種類ラベルは金額の少し上、計・合計ラベルは金額の少し下に来る様式
        let kamoku = ''
        for (const l2 of p.lines) {
          if (l2.y < t.y - 24 || l2.y > t.y + 2) continue
          for (const t2 of l2.toks) {
            if (t2.x >= 45 && t2.x <= 100) kamoku += t2.s.replace(/\s+/g, '')
          }
        }
        if (!kamoku) {
          for (const l2 of p.lines) {
            if (l2.y < t.y + 2 || l2.y > t.y + 16) continue
            for (const t2 of l2.toks) {
              const s2 = t2.s.replace(/\s+/g, '')
              if (t2.x >= 45 && t2.x <= 100 && /^合?計$/.test(s2)) kamoku += s2
            }
          }
        }
        recs.push({ kamoku, amount: parseAmount(t.s) })
      }
    }
  }
  if (!recs.length) return []
  const totals = new Map<string, number>()
  let curName = ''
  let itemSum = 0
  let kei: number | null = null
  const close = () => {
    if (curName) totals.set(curName, (totals.get(curName) || 0) + (kei != null ? kei : itemSum))
    itemSum = 0
    kei = null
  }
  for (const r of recs) {
    const k = r.kamoku
    if (/合計/.test(k)) { close(); curName = ''; continue }
    if (k === '計') { kei = r.amount; continue }
    if (k && k !== curName) { close(); curName = k }
    itemSum += r.amount
  }
  close()
  return Array.from(totals.entries()).map(([kamoku, amount]) => ({ kamoku, amount })).filter((x) => x.amount !== 0)
}

// ===== 仮受金内訳書: 源泉所得税預り金（本表の摘要注記行 vs 下段「源泉所得税預り金の内訳」） =====
function gensenAzukari(pages: ClassifiedPage[]): { main: number | null; section: number | null } {
  const grp = pages.filter((p) => p.kind === 'uchiwake' && p.subType === '仮受金')
  let main: number | null = null
  let section: number | null = null
  for (const p of grp) {
    // 本表: 摘要に「源泉所得税」とある行の期末現在高
    let secTop: number | null = null
    for (const l of p.lines) if (/源泉所得税預り金の内訳/.test(normText(l))) { secTop = l.y; break }
    const mainEnd = secTop != null ? secTop - 5 : 600
    for (const l of p.lines) {
      if (l.y < 130 || l.y > mainEnd) continue
      for (const t of l.toks) {
        if (t.x < 440 || t.x > 500 || !isStrictAmountTok(t)) continue
        let tekiyo = ''
        let name = ''
        for (const l2 of p.lines) {
          if (l2.y < t.y - 10 || l2.y > t.y + 8) continue
          for (const t2 of l2.toks) {
            if (t2.x >= 495) tekiyo += t2.s.replace(/\s+/g, '')
            if (t2.x >= 45 && t2.x <= 130) name += t2.s.replace(/\s+/g, '')
          }
        }
        if (/計/.test(name)) continue
        if (/源泉所得税/.test(tekiyo)) main = (main || 0) + parseAmount(t.s)
      }
    }
    // 下段: 源泉所得税預り金の内訳（左右2列の期末現在高）
    if (secTop != null) {
      // 終端は下の（注）行まで（行数が多い場合に固定幅だと最終行を取りこぼすため）
      let secEnd = secTop + 260
      for (const l of p.lines) {
        if (l.y > secTop + 10 && /「所得の種類」欄には/.test(normText(l))) { secEnd = l.y - 5; break }
      }
      let s = 0
      let found = false
      for (const l of p.lines) {
        if (l.y < secTop + 10 || l.y > secEnd) continue
        for (const t of l.toks) {
          if (!isStrictAmountTok(t)) continue
          if ((t.x >= 250 && t.x <= 312) || (t.x >= 505 && t.x <= 575)) { s += parseAmount(t.s); found = true }
        }
      }
      if (found) section = (section || 0) + s
    }
  }
  return { main, section }
}

// ===== 役員給与等の内訳書: 計行の役員給与計・使用人職務分、人件費の内訳 =====
function yakuinDetail(pages: ClassifiedPage[]): { kei: number | null; shokumu: number | null } {
  const grp = pages.filter((p) => p.kind === 'uchiwake' && p.subType === '役員給与')
  for (const p of grp) {
    for (const l of p.lines) {
      if (l.y > 525) continue
      const hasKei = l.toks.some((t) => t.s.trim() === '計' && t.x < 200)
      if (!hasKei) continue
      const amts = l.toks.filter(isStrictAmountTok)
      if (!amts.length) continue
      const kei = amts.find((t) => t.x >= 250 && t.x < 300)
      const shokumu = amts.find((t) => t.x >= 300 && t.x < 348)
      return { kei: kei ? parseAmount(kei.s) : parseAmount(amts[0].s), shokumu: shokumu ? parseAmount(shokumu.s) : null }
    }
  }
  return { kei: null, shokumu: null }
}

export interface JinkenhiUchiwake { yakuin: number | null; kyuyo: number | null; chingin: number | null; kei: number | null }
function jinkenhiUchiwake(pages: ClassifiedPage[]): JinkenhiUchiwake {
  const out: JinkenhiUchiwake = { yakuin: null, kyuyo: null, chingin: null, kei: null }
  const grp = pages.filter((p) => p.kind === 'uchiwake' && p.subType === '役員給与')
  for (const p of grp) {
    const anchor = findLine(p, /人件費の内訳/)
    if (!anchor) continue
    for (const l of p.lines) {
      if (l.y < anchor.y + 5 || l.y > anchor.y + 130) continue
      const label = l.toks.filter((t) => t.x >= 55 && t.x <= 290 && !isAmountTok(t)).map((t) => t.s.replace(/\s+/g, '')).join('')
      const amt = l.toks.find((t) => t.x >= 300 && t.x <= 432 && isStrictAmountTok(t))
      if (!amt) continue
      const v = parseAmount(amt.s)
      if (/役員給与/.test(label) && out.yakuin == null) out.yakuin = v
      else if (/給与手当/.test(label) && out.kyuyo == null) out.kyuyo = v
      else if (/賃金手当/.test(label) && out.chingin == null) out.chingin = v
      else if (/^計$/.test(label) && out.kei == null) out.kei = v
    }
  }
  return out
}

// ===== 雑益・雑損失内訳書: 雑益の合計（1つ目）と雑損失等の合計（2つ目）、源泉所得税還付行 =====
function zatsuTotals(pages: ClassifiedPage[]): { eki: number | null; son: number | null } {
  const grp = pages.filter((p) => p.kind === 'uchiwake' && p.subType === '雑益雑損失')
  const totals: number[] = []
  for (const p of grp) {
    for (const l of p.lines) {
      if (!/^合計/.test(normText(l))) continue
      const amts = amountsInBand(p, l.y - 10, l.y + 12, 490, 9999, true)
      if (amts.length) totals.push(parseAmount(amts[amts.length - 1].s))
    }
  }
  return { eki: totals.length ? totals[0] : null, son: totals.length >= 2 ? totals[1] : null }
}

// 雑益内訳書のうち「源泉所得税還付」「控除所得税還付」等の行の金額合計（別表四の還付金額行と突合）
function zatsuGensenRefund(pages: ClassifiedPage[]): number | null {
  const grp = pages.filter((p) => p.kind === 'uchiwake' && p.subType === '雑益雑損失')
  let sum = 0
  let found = false
  for (const p of grp) {
    for (const l of p.lines) {
      const content = l.toks.filter((t) => t.x >= 138 && t.x <= 275).map((t) => t.s.replace(/\s+/g, '')).join('')
      if (!/源泉所得税還付|控除所得税還付|所得税等還付|還付所得税/.test(content)) continue
      const amts = amountsInBand(p, l.y - 4, l.y + 14, 500, 9999, true)
      if (amts.length) { sum += parseAmount(amts[0].s); found = true }
    }
  }
  return found ? sum : null
}

// ===== 別表四: 「所得税額等及び欠損金の繰戻しによる還付金額等」①総額 =====
function extractBeppyo4Refund(pages: ClassifiedPage[]): number | null {
  for (const p of pages) {
    if (p.kind !== 'beppyo4') continue
    const l = findLine(p, /所得税額等及び欠損金の繰戻しによる還/)
    if (!l) continue
    const amts = amountsInBand(p, l.y - 4, l.y + 12, 230, 340, true)
    return amts.length ? parseAmount(amts[0].s) : 0
  }
  return null
}

// ===== 概況説明書: 月別の売上高等の状況の「計」行（千円） =====
export interface GaikyoMonthly { sales: number | null; shiire: number | null; gaichu: number | null; jinken: number | null }
function gaikyoMonthly(pages: ClassifiedPage[]): GaikyoMonthly {
  const out: GaikyoMonthly = { sales: null, shiire: null, gaichu: null, jinken: null }
  for (const p of pages) {
    if (p.kind !== 'gaikyo') continue
    const head = p.lines.find((l) => /売上(\(|（)収入(\)|）)金額/.test(normText(l)))
    if (!head) continue
    for (const l of p.lines) {
      if (l.y < head.y + 10 || l.y > head.y + 300) continue
      const kei = l.toks.find((t) => t.s.trim() === '計' && t.x >= 45 && t.x <= 85)
      if (!kei) continue
      const amts = l.toks.filter(isStrictAmountTok)
      if (amts.length < 2) continue
      const pick = (lo: number, hi: number) => { const t = amts.find((a) => a.x >= lo && a.x <= hi); return t ? parseAmount(t.s) : null }
      out.sales = pick(85, 190)
      out.shiire = pick(195, 300)
      out.gaichu = pick(305, 375)
      out.jinken = pick(376, 428)
      return out
    }
  }
  return out
}

// ===== 消費税申告書 第一表: 「消費税及び地方消費税の合計（納付又は還付）税額」(26) =====
function extractShohizeiGokei(pages: ClassifiedPage[]): number | null {
  for (const p of pages) {
    if (p.kind !== 'shohizei-1') continue
    const l = findLine(p, /合計\(納付又は還付\)税額|合計（納付又は還付）税額/)
    if (!l) continue
    // ラベル行と同じ行の1マス1桁の数字を連結（マイナスは還付）
    const v = joinDigits(l, 222, 345)
    if (v != null) return v
    // 数字が近傍行にある場合
    for (const l2 of p.lines) {
      if (l2.y < l.y - 10 || l2.y > l.y + 10 || l2 === l) continue
      const v2 = joinDigits(l2, 222, 345)
      if (v2 != null) return v2
    }
  }
  return null
}

// 消費税申告書 第一表: 中間納付税額(10)＋中間納付譲渡割額(21)
function extractShohizeiChukan(pages: ClassifiedPage[]): number | null {
  for (const p of pages) {
    if (p.kind !== 'shohizei-1') continue
    let sum = 0
    let found = false
    for (const re of [/^.{0,4}中間納付税額/, /中間納付譲渡割額/]) {
      const l = p.lines.find((x) => re.test(normText(x)))
      if (!l) continue
      const v = joinDigits(l, 235, 345)
      if (v != null) { sum += v; found = true }
    }
    if (found) return sum
  }
  return null
}

// 借入金内訳書の「期中の支払利子額」列合計（最終行）
function uchiwakeInterest(pages: ClassifiedPage[]): number | null {
  const grp = pages.filter((p) => p.kind === 'uchiwake' && p.subType === '借入金')
  if (!grp.length) return null
  const last = grp[grp.length - 1]
  let hx: number | null = null
  for (const l of last.lines) {
    if (/期中の支払利子額/.test(normText(l))) {
      const tok = l.toks.find((t) => t.s.replace(/\s/g, '').startsWith('期中'))
      hx = tok ? tok.x : null
      break
    }
  }
  if (hx == null) return null
  const amts = amountsInBand(last, 100, 690, hx - 22, hx + 74, true)
  if (!amts.length) return null
  return parseAmount(amts[amts.length - 1].s)
}

// 役員給与内訳書: 最初の計行の最初の金額＝役員給与計
function uchiwakeYakuin(pages: ClassifiedPage[]): number | null {
  const grp = pages.filter((p) => p.kind === 'uchiwake' && p.subType === '役員給与')
  for (const p of grp) {
    for (const l of p.lines) {
      const hasKei = l.toks.some((t) => t.s.trim() === '計' && t.x < 200)
      if (!hasKei) continue
      const amts = l.toks.filter(isStrictAmountTok)
      if (amts.length) return parseAmount(amts[0].s)
    }
  }
  return null
}

// 地代家賃内訳書: 最終ページの賃借料列（x>400）の一番下の金額
function uchiwakeChidai(pages: ClassifiedPage[]): number | null {
  const grp = pages.filter((p) => p.kind === 'uchiwake' && p.subType === '地代家賃')
  if (!grp.length) return null
  const last = grp[grp.length - 1]
  const amts = amountsInBand(last, 100, 700, 400, 520, true)
  if (!amts.length) return null
  return parseAmount(amts[amts.length - 1].s)
}


// ---------- 法人事業概況説明書（千円単位・1マス1桁）----------

// 同一行内で、指定X範囲の1桁トークン（および-）を連結して数値化
function joinDigits(l: Line, xMin: number, xMax: number): number | null {
  const toks = l.toks
    .filter((t) => t.x >= xMin && t.x <= xMax && /^(-|[0-9])$/.test(t.s.trim()))
    .sort((a, b) => a.x - b.x)
  if (!toks.length) return null
  // 桁同士の間隔が異常に空く場合は別の数値とみなし先頭グループのみ
  let s = toks[0].s.trim()
  for (let i = 1; i < toks.length; i++) {
    if (toks[i].x - toks[i - 1].x > 24) break
    s += toks[i].s.trim()
  }
  if (!/\d/.test(s)) return null
  return parseInt(s, 10)
}

interface GaikyoField {
  label: string
  re: RegExp
  side: 'left' | 'right'
}

const GAIKYO_FIELDS: GaikyoField[] = [
  { label: '売上（収入）総利益', re: /売上（収入）総利益/, side: 'left' },
  { label: '役員報酬', re: /^.{0,6}役員報酬$/, side: 'left' },
  { label: '労務費', re: /労務費/, side: 'left' },
  { label: '従業員給料', re: /従業員給料/, side: 'left' },
  { label: '営業損益', re: /営業損益/, side: 'left' },
  { label: '特別利益', re: /^.{0,6}特別利益$/, side: 'left' },
  { label: '税引前当期損益', re: /税引前当期損益/, side: 'right' },
  { label: '土地', re: /土地$/, side: 'right' },
  { label: 'その他借入金', re: /その他借入金/, side: 'right' },
  { label: '個人借入金', re: /個人借入金/, side: 'right' },
]

/** ラベル行の指定x範囲で1マス1桁数字を結合。様式によってはラベルと数字マスの
 *  y座標が僅かにずれて別行にグループ化されるため、同一行に無ければ近傍行（±9px）も探す */
function joinDigitsNear(p: Page, l: Line, xMin: number, xMax: number): number | null {
  const v = joinDigits(l, xMin, xMax)
  if (v != null) return v
  let best: { d: number; v: number } | null = null
  for (const l2 of p.lines) {
    if (l2 === l) continue
    const d = Math.abs(l2.y - l.y)
    if (d > 9) continue
    const v2 = joinDigits(l2, xMin, xMax)
    if (v2 == null) continue
    if (!best || d < best.d) best = { d, v: v2 }
  }
  return best ? best.v : null
}

function extractGaikyo(pages: ClassifiedPage[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const p of pages) {
    if (p.kind !== 'gaikyo') continue
    for (const l of p.lines) {
      const leftLabel = l.toks
        .filter((t) => t.x < 210 && !/^[0-9\-]+$/.test(t.s.trim()))
        .map((t) => t.s)
        .join('')
        .replace(/\s+/g, '')
      const rightLabel = l.toks
        .filter((t) => t.x >= 300 && t.x < 470 && !/^[0-9\-]+$/.test(t.s.trim()))
        .map((t) => t.s)
        .join('')
        .replace(/\s+/g, '')
      for (const f of GAIKYO_FIELDS) {
        if (out.has(f.label)) continue
        if (f.side === 'left' && f.re.test(leftLabel)) {
          const v = joinDigitsNear(p, l, 210, 310)
          if (v != null) out.set(f.label, v)
        }
        if (f.side === 'right' && f.re.test(rightLabel)) {
          const v = joinDigitsNear(p, l, 465, 565)
          if (v != null) out.set(f.label, v)
        }
      }
    }
  }
  return out
}

// ---------- 消費税 付表1-3 ----------

function extractShohizeiKazeiHyojun(pages: ClassifiedPage[]): number | null {
  for (const p of pages) {
    if (p.kind !== 'shohizei-fuhyo') continue
    const l = findLine(p, /^.{0,6}課税標準額[0-9①]?$/)
    if (!l) continue
    // 様式によりラベル行と金額行が14px程度ずれる（付表4-3等）ため下方向に広めに探す。
    // ただし次行の「課税資産の譲渡等の対価の額」（+40px以上下）を拾わない範囲にとどめる
    const amts = amountsInBand(p, l.y - 2, l.y + 18, 100, 9999, true)
    if (amts.length) return parseAmount(amts[amts.length - 1].s)
  }
  // 付表から取れない場合は第一表の課税標準額①（1マス1桁）から取得
  for (const p of pages) {
    if (p.kind !== 'shohizei-1') continue
    const l = findLine(p, /^.{0,4}課税標準額/)
    if (!l) continue
    const v = joinDigitsNear(p, l, 190, 350)
    if (v != null) return v
  }
  return null
}

// ---------- 事業年度の整合 ----------

function extractFsPeriod(pages: ClassifiedPage[]): string | null {
  for (const p of pages) {
    if (p.kind !== 'pl') continue
    for (const l of p.lines) {
      const m = normText(l).match(
        /自令和(\d+)年(\d+)月(\d+)日至令和(\d+)年(\d+)月(\d+)日/,
      )
      if (m) return `R${m[1]}.${m[2]}.${m[3]}〜R${m[4]}.${m[5]}.${m[6]}`
    }
  }
  return null
}

function extractBeppyoPeriod(pages: ClassifiedPage[]): string | null {
  for (const p of pages) {
    if (p.kind !== 'beppyo4') continue
    const dates: string[] = []
    for (const l of p.lines) {
      if (l.y > 80) break
      const m = normText(l).match(/(\d+)・(\d+)・(\d+)/)
      if (m) dates.push(`R${m[1]}.${m[2]}.${m[3]}`)
    }
    if (dates.length >= 2) return `${dates[0]}〜${dates[1]}`
  }
  return null
}

// ---------- チェックの組み立て ----------

function mk(
  group: string,
  name: string,
  leftLabel: string,
  leftValue: number | null,
  rightLabel: string,
  rightValue: number | null,
  opts: { note?: string; tol?: number; infoOnly?: boolean } = {},
): CheckResult {
  let status: CheckStatus
  let diff: number | null = null
  if (leftValue == null && rightValue == null) status = 'na'
  else if (leftValue == null || rightValue == null) {
    status = 'warn'
  } else {
    diff = leftValue - rightValue
    const tol = opts.tol ?? 0
    if (Math.abs(diff) <= tol) status = 'ok'
    else status = opts.infoOnly ? 'info' : 'warn'
  }
  return {
    group,
    name,
    leftLabel,
    leftValue,
    rightLabel,
    rightValue,
    diff,
    status,
    note: opts.note,
  }
}

const trunc1000 = (v: number) => (v >= 0 ? Math.floor(v / 1000) : -Math.floor(-v / 1000))

export function analyze(rawPages: Page[]): AnalyzeResult {
  const pages = classifyPages(rawPages)
  const pool = buildFsPool(pages)
  const checks: CheckResult[] = []

  const kindLabel: Record<string, string> = {
    pl: '損益計算書等',
    bs: '貸借対照表',
    'fs-cont': '決算書（続き）',
    beppyo4: '法人税 別表四',
    beppyo51: '法人税 別表五(一)',
    beppyo52: '法人税 別表五(二)',
    beppyo61: '法人税 別表六(一)',
    beppyo15: '法人税 別表十五',
    beppyo16: '法人税 別表十六',
    'shohizei-1': '消費税申告書 第一表',
    gaikyo: '法人事業概況説明書',
    'shohizei-fuhyo': '消費税 付表（税率別計算表）',
    uchiwake: '内訳書',
    other: '（チェック対象外）',
  }
  const pageSummary = pages.map((p) => ({
    page: p.num,
    fileName: p.fileName,
    detected: p.kind === 'uchiwake' ? `内訳書（${p.subType}）` : kindLabel[p.kind] || p.kind,
  }))

  const b4 = pages.find((p) => p.kind === 'beppyo4')
  const b51 = pages.find((p) => p.kind === 'beppyo51')
  const b52page = pages.find((p) => p.kind === 'beppyo52')
  const b61 = pages.find((p) => p.kind === 'beppyo61')

  // ===== ① 決算書 ⇔ 法人税申告書 =====
  const G1 = '決算書 ⇔ 法人税申告書'

  checks.push(
    mk(
      G1,
      '当期純利益',
      'PL 当期純利益（損失）',
      fsGet(pool, '当期純利益', '当期純損失'),
      '別表四(1) 当期利益又は当期欠損の額',
      b4 ? extractBeppyo4Profit(b4) : null,
    ),
  )

  checks.push(
    mk(
      G1,
      '繰越利益剰余金',
      'BS 繰越利益剰余金',
      fsGet(pool, '繰越利益剰余金'),
      '別表五(一) 繰越損益金（差引翌期首④）',
      b51 ? extractBeppyo51(b51, /繰越損益金/) : null,
    ),
  )

  checks.push(
    mk(
      G1,
      '資本金',
      'BS 資本金',
      fsGet(pool, '資本金'),
      '別表五(一) 資本金又は出資金（④）',
      b51 ? extractBeppyo51(b51, /資本金又は出資金/) : null,
    ),
  )

  const b52 = b52page ? extractBeppyo52(b52page) : null

  checks.push(
    mk(
      G1,
      '未払法人税等',
      'BS 未払法人税等',
      fsGet(pool, '未払法人税等', '未払法人税'),
      '別表五(二) 期末納税充当金(41)',
      b52 ? b52.kimatsuJutokin : null,
    ),
  )

  // PL租税公課＋法人税等 ⇔ 別表五(二) ⑤損金経理による納付の合計＋(31)損金経理をした納税充当金
  {
    const sozei = fsSum(pool, ['租税公課', '租税課金', '公租公課'])
    const hojin = fsGet(pool, '法人税、住民税及び事業税', '法人税等', '法人税等合計', '法人税住民税及び事業税')
    const left = sozei == null && hojin == null ? null : (sozei || 0) + (hojin || 0)
    const right =
      b52 && (b52.sonkinKeiriPay != null || b52.nozeiJutokinKeiri != null)
        ? (b52.sonkinKeiriPay || 0) + (b52.nozeiJutokinKeiri || 0)
        : null
    checks.push(
      mk(G1, '損金経理した税金', 'PL 租税公課＋法人税等', left, '別表五(二) 損金経理による納付⑤合計＋損金経理をした納税充当金(31)', right, {
        note: '税金を他科目（賃借料等）で処理している場合や、事業所税・不動産取得税等が別表五(二)に記載されない場合は差異が出ます。',
      }),
    )
  }

  checks.push(
    mk(
      G1,
      '受取利息と所得税控除',
      'PL 受取利息',
      fsGet(pool, '受取利息', '受取利息配当金'),
      '別表六(一) 1行目 収入金額①',
      b61 ? extractBeppyo61Row(b61, 1) : null,
      { note: '源泉徴収のない利息（相手先貸付利息等）がある場合は差異が出ます。' },
    ),
  )

  checks.push(
    mk(
      G1,
      '受取配当金と所得税控除',
      'PL 受取配当金',
      fsGet(pool, '受取配当金'),
      '別表六(一) 2行目 収入金額①',
      b61 ? extractBeppyo61Row(b61, 2) : null,
    ),
  )

  // 別表十六 ⇔ BS帳簿価額・PL減価償却費
  {
    const b16 = extractBeppyo16(pages)
    const DEPRECIABLES = [
      '建物',
      '建物附属設備',
      '附属設備',
      '建物付属設備',
      '構築物',
      '機械及び装置',
      '機械装置',
      '車両運搬具',
      '車両及び運搬具',
      '車輌運搬具',
      '船舶',
      '工具、器具及び備品',
      '工具器具及び備品',
      '工具器具備品',
      '器具及び備品',
      '器具備品',
      '一括償却資産',
      'リース資産',
      'ソフトウエア',
      'ソフトウェア',
      '繰延資産',
      '創立費',
      '開業費',
      '開発費',
      '社債発行費',
      '株式交付費',
      '営業権',
      'のれん',
      '特許権',
      '商標権',
      '意匠権',
      '実用新案権',
    ]
    checks.push(
      mk(
        G1,
        '減価償却資産の帳簿価額',
        'BS 減価償却資産の帳簿価額合計',
        fsSum(pool, DEPRECIABLES),
        '別表十六 期末現在の帳簿記載金額 合計',
        b16.bookValue,
        {
          note: '一括償却資産（別表十六(八)）・少額減価償却資産・無形固定資産を「その他」表示している場合・直接控除以外の償却累計額表示の場合は差異が出ることがあります。',
        },
      ),
    )
    checks.push(
      mk(
        G1,
        '減価償却費',
        'PL 減価償却費（製造原価分含む）',
        fsSum(pool, ['減価償却費']),
        '別表十六 当期償却額 合計',
        b16.currentDep,
        { note: '一括償却資産の損金算入額・長期前払費用償却は別表十六(一)(二)に含まれません。' },
      ),
    )
  }

  // 交際費: 別表十五「支出交際費等の額」⇔ PL交際費
  {
    const b15 = extractBeppyo15Shishutsu(pages)
    const plKosai = fsSum(pool, ['交際費', '接待交際費', '交際接待費', '交際費等'])
    if (b15 != null || plKosai != null) {
      checks.push(
        mk(G1, '交際費', 'PL 交際費（製造原価分含む）', plKosai, '別表十五 支出交際費等の額', b15, {
          note: '福利厚生費・会議費等に計上した接待飲食費を別表十五で交際費等に含めている場合は差異が出ます。',
        }),
      )
    }
  }

  // ===== ② 勘定科目内訳明細書 ⇔ 決算書 =====
  const G2 = '勘定科目内訳明細書 ⇔ 決算書'

  {
    const v = uchiwakeTotal(pages, '預貯金')
    const bs = fsGet(pool, '現金及び預金', '現金預金', '現金・預金')
    const r = mk(G2, '預貯金', '内訳書 預貯金合計', v, 'BS 現金及び預金', bs)
    if (r.status === 'warn' && v != null && bs != null && bs > v) {
      r.status = 'ok'
      r.note = `差額 ${(bs - v).toLocaleString('ja-JP')} 円は現金残高相当と推定（内訳書は預貯金のみ記載）。`
    } else if (r.status === 'warn' && v != null && bs != null) {
      r.note = '内訳書の合計がBSの現金及び預金を上回っています。'
    }
    checks.push(r)
  }

  // 科目ごとの明細ベースチェック（内訳書の科目欄＋計行 → 決算書の同名科目と突合）。
  // 科目欄を持たない・抽出できない内訳書は従来どおり合計ベースにフォールバックする。
  const kamokuChecks = (subType: string, dispName: string, fallback: () => void) => {
    const totals = kamokuUchiwakeTotals(pages, subType)
    if (!totals.length) {
      fallback()
      return
    }
    for (const kt of totals) {
      const m = matchFsKamoku(pool, kt.kamoku, kt.amount)
      checks.push(
        mk(
          G2,
          `${dispName}「${kt.kamoku}」`,
          `内訳書 ${kt.kamoku} 計`,
          kt.amount,
          m ? `決算書 ${m.label}` : `決算書 ${kt.kamoku}`,
          m ? m.value : null,
          { note: m?.note },
        ),
      )
    }
  }

  // 受取手形（摘要に「裏書」注記のある行は割引・裏書譲渡分として除外）
  {
    const ut = uketoriTegata(pages)
    const bsTe = fsSum(pool, ['受取手形', '電子記録債権'])
    if (ut || bsTe != null) {
      checks.push(
        mk(G2, '受取手形', '内訳書 受取手形合計（裏書分を除く）', ut ? ut.total : null, 'BS 受取手形＋電子記録債権', bsTe, {
          note: ut && ut.ura > 0 ? `摘要に「裏書」とある ${ut.ura.toLocaleString('ja-JP')} 円は裏書譲渡分としてBS残高との照合から除外しています。` : undefined,
        }),
      )
    }
  }

  kamokuChecks('売掛金', '売掛金内訳書', () => {
    checks.push(
      mk(
        G2,
        '売掛金・未収入金',
        '内訳書 売掛金（未収入金）合計',
        uchiwakeTotal(pages, '売掛金'),
        'BS 売掛金＋未収入金',
        fsSum(pool, ['売掛金', '未収入金', '未収金']),
      ),
    )
  })

  kamokuChecks('仮払金・貸付金', '仮払金内訳書', () => {
    const v = uchiwakeTotal(pages, '仮払金・貸付金')
    const bs = fsSum(pool, ['仮払金', '前渡金', '短期貸付金', '長期貸付金', '貸付金'])
    checks.push(
      mk(G2, '仮払金・貸付金', '内訳書 仮払金（前渡金）等合計', v, 'BS 仮払金・前渡金・貸付金', bs, {
        note: 'この内訳書に仮払金・貸付金以外の科目（出資金・保険積立金・敷金等）を記載している場合は差異が出ます。',
      }),
    )
  })

  // 有価証券内訳書 ⇔ BS（有価証券・投資有価証券・出資金・会員権の一致する組み合わせで照合）
  {
    const v = yukashokenTotal(pages)
    if (v != null) {
      const cands = ['有価証券', '投資有価証券', '出資金', '会員権', 'ゴルフ会員権']
        .map((l) => ({ label: l, value: fsGet(pool, l) }))
        .filter((x): x is { label: string; value: number } => x.value != null)
      const combo = matchCombination(v, cands)
      if (combo) {
        checks.push(mk(G2, '有価証券', '内訳書 有価証券合計', v, `BS ${combo.labels.join('＋')}`, combo.value, {
          note: combo.labels.length > 1 ? `BS科目の組み合わせ（${combo.labels.join('・')}）と一致しました。` : undefined,
        }))
      } else {
        const all = cands.reduce((t, c) => t + c.value, 0)
        checks.push(mk(G2, '有価証券', '内訳書 有価証券合計', v, cands.length ? `BS ${cands.map((c) => c.label).join('＋')}` : 'BS 有価証券・投資有価証券', cands.length ? all : null))
      }
    }
  }

  // 貸付金及び受取利息の内訳書 ⇔ BS短期貸付金・長期貸付金
  // （内訳書には短期・長期の区別がないため、一致するBS科目の組み合わせを探して照合する）
  {
    const v = kashitsukeTotal(pages)
    const cands = ['短期貸付金', '長期貸付金', '貸付金', '役員貸付金', '従業員貸付金', '関係会社貸付金']
      .map((l) => ({ label: l, value: fsGet(pool, l) }))
      .filter((x): x is { label: string; value: number } => x.value != null)
    if (v != null || cands.length) {
      const combo = v != null ? matchCombination(v, cands) : null
      if (combo) {
        checks.push(mk(G2, '貸付金', '内訳書 貸付金合計', v, `BS ${combo.labels.join('＋')}`, combo.value, {
          note: `内訳書には短期・長期の区別がないため、一致するBS科目（${combo.labels.join('・')}）と照合しました。`,
        }))
      } else {
        const all = cands.reduce((t, c) => t + c.value, 0)
        checks.push(mk(G2, '貸付金', '内訳書 貸付金合計', v, cands.length ? `BS ${cands.map((c) => c.label).join('＋')}` : 'BS 短期貸付金・長期貸付金', cands.length ? all : null, {
          note: '内訳書には短期・長期の区別がないため、貸付金系のBS科目の合算と比較しています。',
        }))
      }
    }
  }

  kamokuChecks('棚卸資産', '棚卸資産内訳書', () => {
    checks.push(
      mk(
        G2,
        '棚卸資産',
        '内訳書 棚卸資産合計',
        uchiwakeTotal(pages, '棚卸資産'),
        'BS 商品・製品・仕掛品・原材料・貯蔵品',
        fsSum(pool, ['商品', '製品', '半製品', '仕掛品', '原材料', '貯蔵品', '未成工事支出金', '商品及び製品']),
      ),
    )
  })

  {
    // 建物の簿価は内訳書に記載しない運用のため、種類（土地・借地権等）ごとにBSと照合する
    const kts = koteishisanKamoku(pages)
    if (kts.length) {
      for (const kt of kts) {
        const m = matchFsKamoku(pool, kt.kamoku, kt.amount)
        checks.push(
          mk(G2, `固定資産内訳書「${kt.kamoku}」`, `内訳書 ${kt.kamoku} 計`, kt.amount, m ? `決算書 ${m.label}` : `決算書 ${kt.kamoku}`, m ? m.value : null, { note: m?.note }),
        )
      }
    } else {
      const v = uchiwakeTotal(pages, '固定資産(土地建物)')
      const land = fsGet(pool, '土地')
      const shakuchi = fsGet(pool, '借地権')
      const bs = land == null && shakuchi == null ? null : (land || 0) + (shakuchi || 0)
      checks.push(
        mk(G2, '固定資産（土地・建物）', '内訳書 固定資産合計', v, 'BS 土地＋借地権', bs, {
          note: '建物の簿価は内訳書に記載しない運用のため、土地・借地権のみで照合しています。',
        }),
      )
    }
  }

  checks.push(
    mk(
      G2,
      '支払手形',
      '内訳書 支払手形合計',
      uchiwakeTotal(pages, '支払手形', /金額摘|金額$/),
      'BS 支払手形',
      fsGet(pool, '支払手形'),
    ),
  )

  kamokuChecks('買掛金', '買掛金内訳書', () => {
    checks.push(
      mk(
        G2,
        '買掛金・未払金・未払費用',
        '内訳書 買掛金（未払金・未払費用）合計',
        uchiwakeTotal(pages, '買掛金'),
        'BS 買掛金＋未払金＋未払費用',
        fsSum(pool, ['買掛金', '未払金', '未払費用']),
        { note: 'リース債務・未払消費税等を内訳書に含めている場合は差異が出ます。' },
      ),
    )
  })

  kamokuChecks('仮受金', '仮受金内訳書', () => {
    checks.push(
      mk(
        G2,
        '仮受金・前受金・預り金',
        '内訳書 仮受金（前受金・預り金）合計',
        uchiwakeTotal(pages, '仮受金'),
        'BS 前受金＋預り金＋仮受金',
        fsSum(pool, ['前受金', '預り金', '仮受金', '前受収益']),
      ),
    )
  })

  // 仮受金内訳書内の突合: 本表の摘要「源泉所得税預り金」⇔ 下段「源泉所得税預り金の内訳」
  {
    const g = gensenAzukari(pages)
    if (g.main != null || g.section != null) {
      checks.push(
        mk(G2, '源泉所得税預り金（仮受金内訳書）', '本表 摘要「源泉所得税預り金」の期末現在高', g.main, '下段「源泉所得税預り金の内訳」の合計', g.section),
      )
    }
  }

  {
    // 借入金: 摘要欄等に長期/短期の別が書かれていれば科目別、無ければ合計で照合
    const loans = loanKamokuTotals(pages)
    if (loans.length) {
      for (const kt of loans) {
        const m = matchFsKamoku(pool, kt.kamoku, kt.amount)
        checks.push(
          mk(G2, `借入金内訳書「${kt.kamoku}」`, `内訳書 ${kt.kamoku} 計`, kt.amount, m ? `決算書 ${m.label}` : `決算書 ${kt.kamoku}`, m ? m.value : null, { note: m?.note }),
        )
      }
    } else {
      checks.push(
        mk(
          G2,
          '借入金',
          '内訳書 借入金合計',
          uchiwakeTotal(pages, '借入金'),
          'BS 短期借入金＋長期借入金',
          fsSum(pool, ['短期借入金', '長期借入金', '借入金', '役員借入金', '1年内返済予定長期借入金', '一年内返済予定長期借入金']),
        ),
      )
    }
  }

  {
    const v = uchiwakeInterest(pages)
    const pl = fsGet(pool, '支払利息', '支払利息割引料')
    const r = mk(G2, '支払利子', '内訳書 期中の支払利子額合計', v, 'PL 支払利息', pl)
    if (v == null && pl != null) r.note = '内訳書に支払利子額の記載が見当たりません。'
    checks.push(r)
  }

  {
    const kei = uchiwakeYakuin(pages)
    const plYakuin = fsSum(pool, ['役員報酬', '役員給与'])
    const r = mk(G2, '役員給与', '内訳書 役員給与計', kei, 'PL 役員報酬（製造原価分含む）', plYakuin)
    if (r.status === 'warn' && kei != null && plYakuin != null) {
      const d = yakuinDetail(pages)
      if (d.shokumu != null && d.shokumu > 0) {
        if (kei - d.shokumu === plYakuin) {
          r.status = 'ok'
          r.diff = 0
          r.note = `使用人兼務役員の使用人職務分 ${d.shokumu.toLocaleString('ja-JP')} 円は給与手当等に計上されており、これを除いた役員分はPL役員報酬と一致しています。`
        } else {
          r.note = `使用人職務分 ${d.shokumu.toLocaleString('ja-JP')} 円を除いても一致しません（職務分控除後の差 ${(kei - d.shokumu - plYakuin).toLocaleString('ja-JP')} 円）。`
        }
      } else {
        r.note = '使用人兼務役員の使用人職務分給与の計上科目により差異が出ることがあります。'
      }
    }
    checks.push(r)
  }

  // 役員給与等の内訳書「人件費の内訳」⇔ PL
  {
    const j = jinkenhiUchiwake(pages)
    if (j.yakuin != null || j.kyuyo != null || j.kei != null) {
      const plYak = fsSum(pool, ['役員報酬', '役員給与'])
      const plKyu = fsSum(pool, ['給料手当', '給与手当', '給料', '給与', '雑給', '賞与', '給料及び手当'])
      // 賃金: 製造原価報告書の「労務費」は賃金・法定福利費・福利厚生費等の小計のため、
      // 明細の賃金系科目があればそちらを使う（労務費と合算すると二重計上になる）。
      // 明細が無く「労務費」1本で計上している決算書のみ労務費を使う。
      const chinDetail = fsSum(pool, ['賃金', '賃金手当', '賃金給料'])
      const romuhi = fsGet(pool, '労務費')
      const plChin = chinDetail != null ? chinDetail : romuhi
      const chinLabel = chinDetail != null ? 'PL 賃金（製造原価分含む）' : 'PL 労務費'
      const chinNote = chinDetail != null && romuhi != null
        ? '製造原価報告書の「労務費」は賃金・法定福利費等の小計のため、明細の「賃金」と照合しています。'
        : undefined
      if (j.yakuin != null) {
        checks.push(mk(G2, '人件費の内訳「役員給与」', '内訳書 人件費の内訳 役員給与', j.yakuin, 'PL 役員報酬', plYak, {
          note: '使用人兼務役員の使用人職務分は「給与手当」側に含まれる様式です。',
        }))
      }
      if (j.kyuyo != null) checks.push(mk(G2, '人件費の内訳「給与手当」', '内訳書 人件費の内訳 給与手当', j.kyuyo, 'PL 給料手当等', plKyu))
      if (j.chingin != null) checks.push(mk(G2, '人件費の内訳「賃金手当」', '内訳書 人件費の内訳 賃金手当', j.chingin, chinLabel, plChin, { note: chinNote }))
      if (j.kei != null && (plYak != null || plKyu != null || plChin != null)) {
        checks.push(mk(G2, '人件費の内訳「計」', '内訳書 人件費の内訳 計', j.kei, 'PL 役員報酬＋給料手当等＋賃金', (plYak || 0) + (plKyu || 0) + (plChin || 0), { note: chinNote }))
      }
    }
  }

  // 地代家賃: 内訳書の記載対象は地代・家賃。機械等の「賃借料」（製造経費に多い）を
  // 内訳書に含めるかは会社により異なるため、地代家賃のみ／地代家賃＋賃借料 の
  // 一致する組み合わせで照合する（常に合算すると賃借料分が誤検知になる）。
  {
    const v = uchiwakeChidai(pages)
    const chidai = fsSum(pool, ['地代家賃', '地代・家賃'])
    const chinshaku = fsSum(pool, ['賃借料'])
    const both = chidai == null && chinshaku == null ? null : (chidai || 0) + (chinshaku || 0)
    let right = chidai != null ? chidai : both
    let rightLabel = chidai != null ? 'PL 地代家賃（製造原価分含む）' : 'PL 賃借料'
    let note = '月極駐車場等を別科目で処理している場合は差異が出ます。'
    if (v != null && chidai != null && v !== chidai && both != null && v === both) {
      right = both
      rightLabel = 'PL 地代家賃＋賃借料'
      note = '内訳書に賃借料を含めて記載しているため、地代家賃＋賃借料の合計と照合しました。'
    } else if (v != null && chidai != null && v === chidai && chinshaku != null && chinshaku !== 0) {
      note = `PLの賃借料 ${chinshaku.toLocaleString('ja-JP')} 円（機械等の賃借料）は地代家賃内訳書の記載対象外として照合から除外しています。`
    }
    checks.push(mk(G2, '地代家賃', '内訳書 地代家賃合計', v, rightLabel, right, { note }))
  }

  {
    const zt = zatsuTotals(pages)
    const eigyogai = fsGet(pool, '営業外収益合計')
    const tokubetsu = fsGet(pool, '特別利益合計')
    const risoku = fsGet(pool, '受取利息') || 0
    const haito = fsGet(pool, '受取配当金') || 0
    const pl =
      eigyogai == null && tokubetsu == null
        ? null
        : (eigyogai || 0) + (tokubetsu || 0) - risoku - haito
    const r = mk(G2, '雑益等', '内訳書 雑益合計', zt.eki, 'PL 営業外収益＋特別利益（受取利息・配当金を除く）', pl)
    if (r.status === 'warn' && zt.eki != null && pl != null && zt.eki < pl) {
      r.status = 'ok'
      r.note = `差額 ${(pl - zt.eki).toLocaleString('ja-JP')} 円。内訳書は原則10万円以上のみ記載のため、内訳書合計がPL側以下であれば正常です。`
    }
    checks.push(r)
    // 雑損失等 ⇔ PL営業外費用＋特別損失（支払利息を除く）
    const egf = fsGet(pool, '営業外費用合計')
    const tkl = fsGet(pool, '特別損失合計')
    const shiharai = fsGet(pool, '支払利息', '支払利息割引料') || 0
    const plSon = egf == null && tkl == null ? null : (egf || 0) + (tkl || 0) - shiharai
    if (zt.son != null || (plSon != null && plSon !== 0)) {
      const r2 = mk(G2, '雑損失等', '内訳書 雑損失等合計', zt.son, 'PL 営業外費用＋特別損失（支払利息を除く）', plSon)
      if (r2.status === 'warn' && zt.son != null && plSon != null && zt.son < plSon) {
        r2.status = 'ok'
        r2.note = `差額 ${(plSon - zt.son).toLocaleString('ja-JP')} 円。内訳書は原則10万円以上のみ記載のため、内訳書合計がPL側以下であれば正常です。`
      }
      checks.push(r2)
    }
  }

  // ===== 法人税申告書 ⇔ 勘定科目内訳明細書 =====
  {
    const refundUchi = zatsuGensenRefund(pages)
    const refundB4 = extractBeppyo4Refund(pages)
    if (refundUchi != null || (refundB4 != null && refundB4 !== 0)) {
      checks.push(
        mk('法人税申告書 ⇔ 勘定科目内訳明細書', '源泉所得税等の還付金', '雑益内訳書 源泉所得税還付・控除所得税還付の行', refundUchi, '別表四 所得税額等及び欠損金の繰戻しによる還付金額等（①総額）', refundB4, {
          note: '前期に未収還付法人税等として計上済みの場合や、欠損金の繰戻し還付を含む場合は差異が出ます。',
        }),
      )
    }
  }

  // ===== ③ 法人事業概況説明書 ⇔ 決算書（千円単位・±1千円許容） =====
  const G3 = '法人事業概況説明書 ⇔ 決算書'
  {
    const gk = extractGaikyo(pages)
    const gkCheck = (
      name: string,
      gkLabel: string,
      fsLabel: string,
      fsVal: number | null,
    ) => {
      const g = gk.has(gkLabel) ? gk.get(gkLabel)! : null
      if (g == null && fsVal == null) return
      checks.push(
        mk(G3, name, `概況 ${gkLabel}（千円）`, g, `決算書（千円換算）`, fsVal == null ? null : trunc1000(fsVal), {
          tol: 1,
          note: '概況説明書は千円単位のため±1千円まで許容しています。',
        }),
      )
    }
    gkCheck('売上総利益', '売上（収入）総利益', '売上総利益', fsGet(pool, '売上総利益'))
    gkCheck('役員報酬', '役員報酬', '役員報酬', fsSum(pool, ['役員報酬', '役員給与']))
    // 概況「労務費」欄（売上原価のうち・福利厚生費等を除く）⇔ 製造原価の労務費。
    // 概況に記載がある場合のみ照合する（欄の記載要否は様式・業種により異なるため）
    {
      const g = gk.has('労務費') ? gk.get('労務費')! : null
      const romu = fsGet(pool, '労務費')
      const chinDetail = fsSum(pool, ['賃金', '賃金手当', '賃金給料'])
      if (g != null && (romu != null || chinDetail != null)) {
        const near = (v: number | null) => v != null && Math.abs(g - trunc1000(v)) <= 1
        let right = romu != null ? romu : chinDetail
        let note = '概況の労務費欄は売上原価（製造原価）のうちの金額・福利厚生費等を除いて記載します。±1千円まで許容しています。'
        if (!near(right)) {
          // 概況の労務費欄は「福利厚生費等を除く」ため、労務費計から福利厚生費（製造原価分）を除いた額とも照合する
          let hit: { v: number; n: string } | null = null
          if (romu != null) {
            for (const f of pool.entries.get('福利厚生費') || []) {
              if (near(romu - f)) { hit = { v: romu - f, n: `決算書の労務費 ${romu.toLocaleString('ja-JP')} 円から福利厚生費 ${f.toLocaleString('ja-JP')} 円（製造原価分）を除いた額と一致しました（概況の労務費欄は福利厚生費等を除いて記載）。` }; break }
            }
          }
          if (!hit && romu != null && chinDetail != null && near(chinDetail)) hit = { v: chinDetail, n: '製造原価の賃金と一致しました。' }
          if (hit) { right = hit.v; note = hit.n }
        }
        checks.push(mk(G3, '労務費（売上原価のうち）', '概況 労務費（千円）', g, '決算書 製造原価の労務費（千円換算）', right == null ? null : trunc1000(right), { tol: 1, note }))
      }
    }
    // 概況「従業員給料」欄は販管費のうちの金額。製造原価の賃金・労務費を常に合算すると
    // 製造業で誤検知になるため、販管費の給料のみを基本とし、一致しない場合に賃金との合算も試す
    {
      const g = gk.has('従業員給料') ? gk.get('従業員給料')! : null
      const base = fsSum(pool, ['給料手当', '給与手当', '給料', '給与', '賞与', '雑給', '給料及び手当', '従業員給料'])
      const chinDetail = fsSum(pool, ['賃金', '賃金手当', '賃金給料'])
      const romu = fsGet(pool, '労務費')
      let right = base
      let label = '販管費の給料手当等'
      let note = '概況の従業員給料欄は販管費のうちの金額のため、製造原価の賃金・労務費は含めていません（±1千円許容）。'
      if (g != null) {
        const near = (v: number | null) => v != null && Math.abs(g - trunc1000(v)) <= 1
        if (!near(base) && base != null && chinDetail != null && near(base + chinDetail)) {
          right = base + chinDetail
          label = '給料手当等＋賃金'
          note = '概況の従業員給料欄に賃金を含めて記載しているため、給料手当等＋賃金の合計と照合しました（±1千円許容）。'
        } else if (base == null && chinDetail != null && romu == null) {
          // 製造原価報告書（労務費小計）が無く、給料を「賃金」科目で計上している会社
          right = chinDetail
          label = '賃金'
          note = '販管費に給料科目が無いため、賃金と照合しました（±1千円許容）。'
        }
      }
      if (g != null || right != null) {
        checks.push(mk(G3, '従業員給料', '概況 従業員給料（千円）', g, `決算書 ${label}（千円換算）`, right == null ? null : trunc1000(right), { tol: 1, note }))
      }
    }
    gkCheck('営業損益', '営業損益', '営業利益', fsGet(pool, '営業利益', '営業損失'))
    gkCheck('特別利益', '特別利益', '特別利益合計', fsGet(pool, '特別利益合計'))
    gkCheck('税引前当期損益', '税引前当期損益', '税引前当期純利益', fsGet(pool, '税引前当期純利益', '税引前当期純損失'))
    gkCheck('土地', '土地', '土地', fsGet(pool, '土地'))
    // 借入金は「その他借入金＋個人借入金」の合計で決算書と照合（どちらか片方のみ記載の様式もある）
    {
      const sonota = gk.has('その他借入金') ? gk.get('その他借入金')! : null
      const kojin = gk.has('個人借入金') ? gk.get('個人借入金')! : null
      if (sonota != null || kojin != null) gk.set('その他借入金＋個人借入金', (sonota || 0) + (kojin || 0))
      gkCheck('借入金', 'その他借入金＋個人借入金', '短期借入金＋長期借入金', fsSum(pool, ['短期借入金', '長期借入金', '借入金']))
    }
  }

  // 概況説明書「11 代表者に対する報酬等の金額」⇔ 各内訳書の代表者分（千円・±1千円許容）
  {
    const g11 = extractGaikyo11(pages)
    const daihyo = daihyoFromYakuin(pages)
    const hasGaikyo = pages.some((p) => p.kind === 'gaikyo')
    if (hasGaikyo && (g11.size > 0 || daihyo)) {
      const dName = daihyo ? daihyo.name : ''
      const g11v = (k: string) => (g11.has(k) ? g11.get(k)! : null)
      const NOTE11 = '概況11欄は同族会社の場合のみ記載されます。'
      checks.push(
        mk(
          '法人事業概況説明書 ⇔ 決算書',
          '代表者報酬（概況11）',
          '概況11 報酬（千円）',
          g11v('報酬'),
          daihyo ? `役員給与内訳書 ${dName} 役員給与計（千円換算）` : '役員給与内訳書 代表者',
          daihyo ? trunc1000(daihyo.amount) : null,
          { tol: 1, note: NOTE11 },
        ),
      )
      const daihyoLoan = dName ? loanFromDaihyo(pages, dName) : null
      const daihyoRent = dName ? rentToDaihyo(pages, dName) : null
      const daihyoLend = dName ? lendToDaihyo(pages, dName) : null
      checks.push(
        mk('法人事業概況説明書 ⇔ 決算書', '代表者からの借入金（概況11）', '概況11 借入金（千円）', g11v('借入金'),
          `借入金内訳書 ${dName || '代表者'} 分（千円換算）`, daihyoLoan == null ? null : trunc1000(daihyoLoan),
          { tol: 1, note: NOTE11 }),
      )
      checks.push(
        mk('法人事業概況説明書 ⇔ 決算書', '代表者への地代家賃（概況11）', '概況11 賃借料（千円）', g11v('賃借料'),
          `地代家賃内訳書 貸主${dName || '代表者'} 分（千円換算）`, daihyoRent == null ? null : trunc1000(daihyoRent),
          { tol: 1, note: NOTE11 }),
      )
      checks.push(
        mk('法人事業概況説明書 ⇔ 決算書', '代表者への貸付金（概況11）', '概況11 貸付金（千円）', g11v('貸付金'),
          `貸付金内訳書 ${dName || '代表者'} 分（千円換算）`, daihyoLend == null ? null : trunc1000(daihyoLend),
          { tol: 1, note: NOTE11 }),
      )
    }
  }

  // 概況説明書「月別の売上高等の状況」の計 ⇔ PL・役員給与内訳書（千円・月次丸めのため±12千円許容）
  {
    const gm = gaikyoMonthly(pages)
    const G3M = '法人事業概況説明書 ⇔ 決算書'
    const NOTE_M = '月ごとの千円丸めの積み上げのため±12千円まで許容しています。'
    if (gm.sales != null || gm.jinken != null || gm.shiire != null) {
      const uriage = fsGet(pool, '総売上高', '売上高合計', '純売上高', '売上高計', '完成工事高', '売上高')
      if (gm.sales != null || uriage != null) {
        checks.push(mk(G3M, '月別表 売上金額計', '概況 月別売上金額の計（千円）', gm.sales, 'PL 売上高（千円換算）', uriage == null ? null : trunc1000(uriage), { tol: 12, note: NOTE_M }))
      }
      const shiire = fsGet(pool, '当期商品仕入高', '当期仕入高', '仕入高', '当期製品仕入高', '商品仕入高', '当期材料仕入高', '材料仕入高', '原材料仕入高', '当期原材料仕入高')
      const gaichu = fsSum(pool, ['外注費', '外注加工費', '外注工賃', '外注作業費'])
      const near = (a: number | null, b: number | null, tol: number) => a != null && b != null && Math.abs(a - trunc1000(b)) <= tol
      const shiireOk = near(gm.shiire, shiire, 12)
      const gaichuOk = near(gm.gaichu, gaichu, 12)
      // PL側で仕入高に外注費を含めて計上している場合は、仕入＋外注の合算で照合する
      const gmSum = gm.shiire != null || gm.gaichu != null ? (gm.shiire || 0) + (gm.gaichu || 0) : null
      const plSum = shiire != null || gaichu != null ? (shiire || 0) + (gaichu || 0) : null
      if (!shiireOk && !(gm.gaichu == null && gaichu == null) && near(gmSum, plSum, 24)) {
        checks.push(mk(G3M, '月別表 仕入＋外注費計', '概況 月別仕入金額＋外注費の計（千円）', gmSum, 'PL 仕入高＋外注費（千円換算）', plSum == null ? null : trunc1000(plSum), {
          tol: 24,
          note: 'PLでは仕入高に外注費を含めて計上しているため、仕入と外注費の合算で照合しました。' + NOTE_M,
        }))
      } else {
        if (gm.shiire != null || shiire != null) {
          checks.push(mk(G3M, '月別表 仕入金額計', '概況 月別仕入金額の計（千円）', gm.shiire, 'PL 仕入高（千円換算）', shiire == null ? null : trunc1000(shiire), { tol: 12, note: NOTE_M }))
        }
        if (gm.gaichu != null || gaichu != null) {
          checks.push(mk(G3M, '月別表 外注費計', '概況 月別外注費の計（千円）', gm.gaichu, 'PL 外注費（千円換算）', gaichu == null ? null : trunc1000(gaichu), { tol: 12, note: NOTE_M }))
        }
      }
      const jk = jinkenhiUchiwake(pages)
      if (gm.jinken != null || jk.kei != null) {
        checks.push(mk(G3M, '月別表 人件費計', '概況 月別人件費の計（千円）', gm.jinken, '役員給与内訳書 人件費の内訳 計（千円換算）', jk.kei == null ? null : trunc1000(jk.kei), { tol: 12, note: NOTE_M }))
      }
    }
  }

  // ===== ④ 消費税申告書 ⇔ 決算書（参考） =====
  const G4 = '消費税申告書 ⇔ 決算書（参考）'
  {
    const kazei = extractShohizeiKazeiHyojun(pages)
    const uriage = fsGet(pool, '総売上高', '売上高合計', '純売上高', '売上高計', '完成工事高', '売上高')
    if (kazei != null || uriage != null) {
      const r = mk(G4, '課税標準額と売上高', '消費税 課税標準額（合計）', kazei, 'PL 売上高', uriage, {
        infoOnly: true,
        note: '税込/税抜経理・非課税売上・雑収入や固定資産売却等により通常は一致しません。大きな乖離がないかの参考情報です。',
      })
      if (r.status === 'info' && kazei != null && uriage != null && uriage !== 0) {
        const rate = Math.abs(kazei - uriage) / Math.abs(uriage)
        r.note = `乖離率 ${(rate * 100).toFixed(1)}%。` + (r.note || '')
      }
      checks.push(r)
    }
    // 消費税及び地方消費税の合計税額(26) ⇔ BS未払消費税等
    const gokei = extractShohizeiGokei(pages)
    const bsMibarai = fsGet(pool, '未払消費税等', '未払消費税')
    if (gokei != null || bsMibarai != null) {
      const r2 = mk(G4, '消費税の年税額と未払消費税等', '消費税申告書 合計（納付又は還付）税額(26)', gokei, 'BS 未払消費税等', bsMibarai, {
        note: '税抜経理で中間納付を仮払処理し年税額を未払計上している場合は一致します。税込経理や中間納付の未払計上方法によっては一致しません。',
      })
      if (r2.status === 'warn' && gokei != null && bsMibarai != null) {
        const chukan = extractShohizeiChukan(pages)
        if (chukan != null && chukan > 0 && bsMibarai - gokei === chukan) {
          r2.note = `差額 ${chukan.toLocaleString('ja-JP')} 円は中間納付税額と一致します。中間納付分を含む年税額全体を未払消費税等に計上している（中間納付を仮払金等で両建てしている）可能性が高く、その場合は整合しています。`
        }
      }
      checks.push(r2)
    }
  }

  // ===== ⑤ 書類間の整合 =====
  const G5 = '書類間の整合'
  {
    const fsP = extractFsPeriod(pages)
    const bpP = extractBeppyoPeriod(pages)
    if (fsP || bpP) {
      checks.push({
        group: G5,
        name: '事業年度の一致',
        leftLabel: `決算書 会計期間：${fsP || '（検出不可）'}`,
        leftValue: null,
        rightLabel: `別表四 事業年度：${bpP || '（検出不可）'}`,
        rightValue: null,
        diff: null,
        status:
          fsP && bpP
            ? fsP.replace(/[^0-9.〜]/g, '') === bpP.replace(/[^0-9.〜]/g, '')
              ? 'ok'
              : 'warn'
            : 'na',
        note: fsP && bpP ? undefined : '会計期間または事業年度を検出できませんでした。',
      })
    }
  }

  return { checks, pageSummary }
}
