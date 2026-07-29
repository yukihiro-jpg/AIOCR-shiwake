// 申告書チェック（電気供給業）: 県税申告書（第六号様式・別表五・別表六・別表九）から金額を抽出する。
// 第六号様式は「1マスに1桁」の様式で、pdfjs のトークンは "9 3 3" のように
// 桁が空白区切りで1トークンに入ることがある。ここでは行番号を起点に
// 列のX帯を指定して桁を連結する方式で読み取る。
import type { Line, Page, ClassifiedPage } from './types'

// ---------- 共通ヘルパー ----------

function normText(line: Line): string {
  return line.toks.map((t) => t.s).join('').replace(/\s+/g, '')
}

/** 桁が空白区切りで入るマス目の数値（"- 1 3 8 1 0 8" → -138108）。
 *  マイナス記号のあとにも桁の間隔が入るため、符号の直後の空白も許容する。 */
const BOX_RE = /^[-－△▲]?[\s　]*[0-9](?:[\s　]*[0-9])*$/

function parseBox(s: string): number | null {
  const t = s.replace(/[\s　,]/g, '')
  const neg = /^[-－△▲]/.test(t)
  const d = t.replace(/^[-－△▲]/, '')
  if (!/^\d+$/.test(d)) return null
  const v = parseInt(d, 10)
  return neg ? -v : v
}

/** カンマ区切りの金額（別表六などの通常表記） */
const COMMA_RE = /^[-△▲]?\d{1,3}(?:,\d{3})*$/

/** 指定Y近傍・X帯のマス目数字を連結して1つの数値にする。
 *  ラベル行と数字行がわずかにずれる様式があるため、最も近いY帯の行から拾う。 */
function boxedNumber(p: Page, y: number, xMin: number, xMax: number, yTol = 6): number | null {
  let best: { d: number; toks: { x: number; s: string }[] } | null = null
  for (const l of p.lines) {
    const d = Math.abs(l.y - y)
    if (d > yTol) continue
    const toks = l.toks
      .filter((t) => t.x >= xMin && t.x <= xMax && (BOX_RE.test(t.s.trim()) || COMMA_RE.test(t.s.trim())))
      .map((t) => ({ x: t.x, s: t.s }))
    if (!toks.length) continue
    if (!best || d < best.d) best = { d, toks }
  }
  if (!best) return null
  best.toks.sort((a, b) => a.x - b.x)
  return parseBox(best.toks.map((t) => t.s).join(''))
}

/** 税率欄（"1.8500" のような小数）を拾う */
function rateNumber(p: Page, y: number, xMin: number, xMax: number, yTol = 6): number | null {
  let best: { d: number; v: number } | null = null
  for (const l of p.lines) {
    const d = Math.abs(l.y - y)
    if (d > yTol) continue
    for (const t of l.toks) {
      if (t.x < xMin || t.x > xMax) continue
      const s = t.s.trim()
      if (!/^\d+\.\d+$/.test(s)) continue
      const v = parseFloat(s)
      if (!best || d < best.d) best = { d, v }
    }
  }
  return best ? best.v : null
}

const OPERATOR_RE = /^[＋+－\-×又は]+$/

/** 様式には「48 ＝ (32又は33)＋35＋…」のような算式が印字されており、
 *  そこにも行番号と同じ数字が並ぶ。算式中の数字を行番号と取り違えないための判定。
 *  なお合計欄の行番号は算式行そのものに置かれるので、行番号の位置だけでは判定できない。 */
function looksLikeFormulaLine(l: Line, anchorX: number, valX: [number, number]): boolean {
  // 値を読む帯に裸の1〜2桁数字が並んでいれば、それは金額ではなく算式の参照番号
  let small = 0
  for (const t of l.toks) {
    if (t.x >= valX[0] && t.x <= valX[1] && /^\d{1,2}$/.test(t.s.trim())) small++
  }
  if (small >= 2) return true
  // 直前のトークンが演算子（「又は」等）なら、その数字は算式の一部
  let prev: { x: number; s: string } | null = null
  for (const t of l.toks) {
    if (t.x >= anchorX - 0.01) break
    prev = t
  }
  if (prev && anchorX - prev.x <= 40 && OPERATOR_RE.test(prev.s.trim())) return true
  return false
}

/** 行番号トークン（例: "47"）を探し、その近傍のX帯から値を読む */
function byRowNo(
  p: Page,
  rowNo: number,
  noX: [number, number],
  valX: [number, number],
  kind: 'box' | 'rate' = 'box',
): number | null {
  const label = String(rowNo)
  for (const l of p.lines) {
    for (const t of l.toks) {
      if (t.s.trim() !== label) continue
      if (t.x < noX[0] || t.x > noX[1]) continue
      if (looksLikeFormulaLine(l, t.x, valX)) continue
      const v = kind === 'rate' ? rateNumber(p, l.y, valX[0], valX[1]) : boxedNumber(p, l.y, valX[0], valX[1])
      if (v != null) return v
    }
  }
  return null
}

// ---------- 第六号様式（その2） ----------

// 課税標準・税率・税額の各列のX帯（A4縦・幅595pt の標準様式で実測）
const X_NO: [number, number] = [128, 142] // 行番号（左表）
const X_NO_R: [number, number] = [250, 265] // 行番号（合計欄）
const X_BASE: [number, number] = [150, 241] // 課税標準
const X_RATE: [number, number] = [242, 275] // 税率
const X_TAX: [number, number] = [300, 366] // 税額
// 「この申告により納付すべき事業税額」の内訳欄（左右2列組み）
const X_NO_UCHI_L: [number, number] = [100, 113]
const X_NO_UCHI_R: [number, number] = [250, 262]
const X_UCHI_L: [number, number] = [170, 210]

/** 事業税の1区分ぶんの読み取り結果 */
export interface RokugoSegment {
  /** 課税標準の総額（(28)(38)(40)(46) 等） */
  total: number | null
  /** 1,000円未満切捨後の課税標準（(39)(41)(47) 等） */
  base: number | null
  /** 印字されている税率（%） */
  rate: number | null
  /** 税額 */
  tax: number | null
}

export interface Rokugo2 {
  page: number
  /** 事業種目の記載 */
  gyoshu: string
  /** 第1号事業（所得割課税事業）の所得 */
  shotoku1: RokugoSegment
  /** 第1号事業 所得割の各段の課税標準（(29)年400万円以下 (30)400万円超800万円以下 (31)800万円超） */
  shotoku1Base29: number | null
  shotoku1Base30: number | null
  shotoku1Base31: number | null
  /** 第1号事業 所得割の各段の税額 */
  shotoku1Tax29: number | null
  shotoku1Tax30: number | null
  shotoku1Tax31: number | null
  /** 第1号事業 所得割の税額（(32)計 と (33)軽減税率不適用） */
  shotoku1Tax32: number | null
  shotoku1Tax33: number | null
  /** 第2号事業（送配電等）の収入割 */
  shunyu2: RokugoSegment
  /** 第3号事業（小売電気・発電等）の所得割 */
  shotoku3: RokugoSegment
  /** 第3号事業の収入割 */
  shunyu3: RokugoSegment
  /** 付加価値割・資本割の税額（外形標準課税法人のみ。通常は0） */
  fukakachiTax35: number | null
  shihonTax37: number | null
  fukakachiTax43: number | null
  shihonTax45: number | null
  /** (48) 合計事業税額 */
  jigyozeiTotal: number | null
  /** 特別法人事業税 (65)(66)(67)(68) */
  tokubetsu1: RokugoSegment
  tokubetsu2: RokugoSegment
  tokubetsu3: RokugoSegment
  tokubetsuTotal: number | null
  /** (76) 法人税の所得金額（別表4の(52)） */
  hojinzeiShotoku: number | null
  /** (54)この申告により納付すべき事業税額の内訳。
   *  (55)〜(58)＝第1号又は第2号事業、(59)〜(62)＝第3号事業 */
  nofu55: number | null
  nofu56: number | null
  nofu57: number | null
  nofu58: number | null
  nofu59: number | null
  nofu60: number | null
  nofu61: number | null
  nofu62: number | null
  /** (73) この申告により納付すべき特別法人事業税額 */
  nofu73: number | null
}

function textAfter(p: Page, re: RegExp, xMin: number): string {
  for (const l of p.lines) {
    const joined = normText(l)
    if (!re.test(joined)) continue
    const rest = l.toks
      .filter((t) => t.x >= xMin)
      .map((t) => t.s)
      .join('')
      .trim()
    if (rest) return rest
  }
  return ''
}

export function extractRokugo2(pages: ClassifiedPage[]): Rokugo2 | null {
  const p = pages.find((x) => x.kind === 'rokugo2')
  if (!p) return null
  const seg = (totalNo: number, baseNo: number): RokugoSegment => ({
    total: byRowNo(p, totalNo, X_NO, X_BASE),
    base: byRowNo(p, baseNo, X_NO, X_BASE),
    rate: byRowNo(p, baseNo, X_NO, X_RATE, 'rate'),
    tax: byRowNo(p, baseNo, X_NO, X_TAX),
  })
  // 事業種目は「事業種目」ラベルの右側にまとめて入る
  let gyoshu = ''
  for (const l of p.lines) {
    const idx = l.toks.findIndex((t) => t.s.replace(/\s+/g, '') === '事業種目')
    if (idx < 0) continue
    gyoshu = l.toks
      .slice(idx + 1)
      .filter((t) => t.x < 470)
      .map((t) => t.s)
      .join('')
      .trim()
    if (gyoshu) break
  }
  if (!gyoshu) gyoshu = textAfter(p, /事業種目/, 400)

  return {
    page: p.num,
    gyoshu,
    shotoku1: {
      total: byRowNo(p, 28, X_NO, X_BASE),
      base: null,
      rate: null,
      tax: null,
    },
    shotoku1Base29: byRowNo(p, 29, X_NO, X_BASE),
    shotoku1Base30: byRowNo(p, 30, X_NO, X_BASE),
    shotoku1Base31: byRowNo(p, 31, X_NO, X_BASE),
    shotoku1Tax29: byRowNo(p, 29, X_NO, X_TAX),
    shotoku1Tax30: byRowNo(p, 30, X_NO, X_TAX),
    shotoku1Tax31: byRowNo(p, 31, X_NO, X_TAX),
    shotoku1Tax32: byRowNo(p, 32, X_NO, X_TAX),
    shotoku1Tax33: byRowNo(p, 33, X_NO, X_TAX),
    shunyu2: seg(38, 39),
    shotoku3: seg(40, 41),
    shunyu3: seg(46, 47),
    fukakachiTax35: byRowNo(p, 35, X_NO, X_TAX),
    shihonTax37: byRowNo(p, 37, X_NO, X_TAX),
    fukakachiTax43: byRowNo(p, 43, X_NO, X_TAX),
    shihonTax45: byRowNo(p, 45, X_NO, X_TAX),
    jigyozeiTotal: byRowNo(p, 48, X_NO_R, X_TAX),
    tokubetsu1: { total: null, base: byRowNo(p, 65, X_NO, X_BASE), rate: byRowNo(p, 65, X_NO, X_RATE, 'rate'), tax: byRowNo(p, 65, X_NO, X_TAX) },
    tokubetsu2: { total: null, base: byRowNo(p, 66, X_NO, X_BASE), rate: byRowNo(p, 66, X_NO, X_RATE, 'rate'), tax: byRowNo(p, 66, X_NO, X_TAX) },
    tokubetsu3: { total: null, base: byRowNo(p, 67, X_NO, X_BASE), rate: byRowNo(p, 67, X_NO, X_RATE, 'rate'), tax: byRowNo(p, 67, X_NO, X_TAX) },
    tokubetsuTotal: byRowNo(p, 68, X_NO_R, X_TAX),
    hojinzeiShotoku: byRowNo(p, 76, [438, 455], [460, 560]),
    // 「この申告により納付すべき事業税額」の内訳欄は左右2列組み。
    // 奇数番号が左（行番号 x≈107・金額 x≈170〜210）、偶数番号が右（x≈256・金額 x≈320〜366）
    nofu55: byRowNo(p, 55, X_NO_UCHI_L, X_UCHI_L),
    nofu56: byRowNo(p, 56, X_NO_UCHI_R, X_TAX),
    nofu57: byRowNo(p, 57, X_NO_UCHI_L, X_UCHI_L),
    nofu58: byRowNo(p, 58, X_NO_UCHI_R, X_TAX),
    nofu59: byRowNo(p, 59, X_NO_UCHI_L, X_UCHI_L),
    nofu60: byRowNo(p, 60, X_NO_UCHI_R, X_TAX),
    nofu61: byRowNo(p, 61, X_NO_UCHI_L, X_UCHI_L),
    nofu62: byRowNo(p, 62, X_NO_UCHI_R, X_TAX),
    nofu73: byRowNo(p, 73, X_NO_UCHI_L, X_UCHI_L),
  }
}

// ---------- 第六号様式別表五（所得金額に関する計算書） ----------

// 1号事業用と3号事業用で表題のテキストが同一（該当号は丸印＝図形で示される）ため、
// テキストからは区別できない。金額そのもので突き合わせる前提で両方returnする。
export interface RokugoB5 {
  page: number
  /** (1) 所得金額（法人税の明細書（別表4）の(34)） */
  shotoku1: number | null
  /** (35) 合計 */
  gokei35: number | null
}

export function extractRokugoB5(pages: ClassifiedPage[]): RokugoB5[] {
  const out: RokugoB5[] = []
  for (const p of pages) {
    if (p.kind !== 'rokugo-b5') continue
    let shotoku1: number | null = null
    let gokei35: number | null = null
    for (const l of p.lines) {
      const txt = normText(l)
      if (shotoku1 == null && /所得金額\(法人税の明細書\(別表4\)の\(34\)\)/.test(txt)) {
        shotoku1 = boxedNumber(p, l.y, 210, 320, 8)
      }
      if (gokei35 == null && /^合計/.test(txt)) {
        const t35 = l.toks.find((t) => t.s.trim() === '35' && t.x >= 190 && t.x <= 210)
        if (t35) gokei35 = boxedNumber(p, l.y, 210, 320, 8)
      }
    }
    out.push({ page: p.num, shotoku1, gokei35 })
  }
  return out
}

// ---------- 第六号様式別表六（収入金額に関する計算書） ----------

export interface RokugoB6 {
  page: number
  /** 収入金額の総額の明細（摘要・金額） */
  items: { label: string; amount: number }[]
  /** 控除される金額の明細 */
  deductItems: { label: string; amount: number }[]
  /** (1) 収入金額の総額 計 */
  total1: number | null
  /** (2) 控除される金額 計 */
  deduct2: number | null
  /** (3) 差引計 */
  diff3: number | null
  /** (13) 計（収入割の課税標準になる金額） */
  final13: number | null
}

export function extractRokugoB6(pages: ClassifiedPage[]): RokugoB6 | null {
  const p = pages.find((x) => x.kind === 'rokugo-b6')
  if (!p) return null
  const X_AMT: [number, number] = [430, 560]
  // 丸数字(1)(2)(3)(13) は x≈410 に裸の数字として出る
  const rowY = (no: number): number | null => {
    for (const l of p.lines) {
      for (const t of l.toks) {
        if (t.s.trim() !== String(no)) continue
        if (t.x < 400 || t.x > 425) continue
        return l.y
      }
    }
    return null
  }
  const amountAt = (y: number | null): number | null =>
    y == null ? null : boxedNumber(p, y, X_AMT[0], X_AMT[1], 8)

  const y1 = rowY(1)
  const y2 = rowY(2)
  const y3 = rowY(3)
  const y13 = rowY(13)

  const items: { label: string; amount: number }[] = []
  const deductItems: { label: string; amount: number }[] = []
  for (const l of p.lines) {
    // 摘要は x≈127（縦書きの見出し x<125 を除く）、金額は右端
    const labelToks = l.toks.filter((t) => t.x >= 120 && t.x <= 400 && !/^\d+$/.test(t.s.trim()))
    const amtToks = l.toks.filter((t) => t.x >= X_AMT[0] && t.x <= X_AMT[1] && COMMA_RE.test(t.s.trim()))
    if (!labelToks.length || !amtToks.length) continue
    const label = labelToks.map((t) => t.s).join('').replace(/\s+/g, '')
    if (!label || /^計$/.test(label) || /差引計/.test(label)) continue
    const amount = parseBox(amtToks.map((t) => t.s).join(''))
    if (amount == null) continue
    if (y1 != null && l.y <= y1 + 3) items.push({ label, amount })
    else if (y2 != null && l.y <= y2 + 3) deductItems.push({ label, amount })
  }

  return {
    page: p.num,
    items,
    deductItems,
    total1: amountAt(y1),
    deduct2: amountAt(y2),
    diff3: amountAt(y3),
    final13: amountAt(y13),
  }
}

// ---------- 法人税 別表四（区分計算書との突合に使う行） ----------

/** 別表四の指定行の「①総額」を読む。行番号は中央（x≈212）、①総額は x≈240〜340 に入る */
export function extractBeppyo4Row(pages: ClassifiedPage[], rowNo: number): number | null {
  const p = pages.find((x) => x.kind === 'beppyo4')
  if (!p) return null
  const label = String(rowNo)
  for (const l of p.lines) {
    for (const t of l.toks) {
      if (t.s.trim() !== label) continue
      if (t.x < 205 || t.x > 220) continue
      const v = boxedNumber(p, l.y, 240, 340, 8)
      if (v != null) return v
    }
  }
  return null
}

// ---------- 法人税 別表五(二)（事業税の損金算入額の検算に使う） ----------

export interface Beppyo52Pay {
  /** 事業税及び特別法人事業税 計(19) ③充当金取崩しによる納付 */
  jigyozeiJutokin: number | null
  /** 事業税及び特別法人事業税 計(19) ⑤損金経理による納付 */
  jigyozeiSonkin: number | null
  /** 法人税・道府県民税・市町村民税の計(5)(10)(15) ⑤損金経理による納付の合計。
   *  中間納付を損金経理していると法人税等の費用に混ざるため、検算で除く必要がある */
  hojinzeiSonkin: number | null
}

/** 別表五(二)は①〜⑥の列見出しが上部にあるので、そのX座標から列の帯を決める */
function beppyo52Columns(p: Page): number[] | null {
  for (const l of p.lines) {
    if (l.y > 130) break
    const marks = l.toks.filter((t) => /^[①②③④⑤⑥]$/.test(t.s.trim()))
    if (marks.length < 5) continue
    const x: number[] = []
    for (const m of marks) x[['①', '②', '③', '④', '⑤', '⑥'].indexOf(m.s.trim())] = m.x
    return x
  }
  return null
}

export function extractBeppyo52Pay(pages: ClassifiedPage[]): Beppyo52Pay {
  const empty: Beppyo52Pay = { jigyozeiJutokin: null, jigyozeiSonkin: null, hojinzeiSonkin: null }
  const p = pages.find((x) => x.kind === 'beppyo52')
  if (!p) return empty
  const col = beppyo52Columns(p)
  if (!col || col[2] == null || col[4] == null) return empty
  const width = (col[1] ?? col[0] + 66) - (col[0] ?? 126)
  const band = (i: number): [number, number] => [col[i], (col[i + 1] ?? col[i] + width) - 1]
  // 行番号は①列の左（例: ①が x≈192 のとき行番号は x≈150）
  const noBand: [number, number] = [col[0] - 55, col[0] - 18]

  /** 計行（5=法人税 10=道府県民税 15=市町村民税 19=事業税）の指定列を読む */
  const cell = (rowNo: number, colIdx: number): number | null => {
    for (const l of p.lines) {
      const t = l.toks.find((x) => x.s.trim() === String(rowNo) && x.x >= noBand[0] && x.x <= noBand[1])
      if (!t) continue
      const [lo, hi] = band(colIdx)
      const v = boxedNumber(p, l.y, lo, hi, 6)
      if (v != null) return v
      return 0 // 行はあるが空欄＝0
    }
    return null
  }
  const sum = (vals: (number | null)[]) =>
    vals.every((v) => v == null) ? null : vals.reduce<number>((s, v) => s + (v ?? 0), 0)

  return {
    jigyozeiJutokin: cell(19, 2),
    jigyozeiSonkin: cell(19, 4),
    hojinzeiSonkin: sum([cell(5, 4), cell(10, 4), cell(15, 4)]),
  }
}

// ---------- 第六号様式別表九（欠損金額等の控除明細書） ----------

export interface RokugoB9 {
  page: number
  /** (1) 控除前所得金額 */
  beforeDeduct: number | null
}

export function extractRokugoB9(pages: ClassifiedPage[]): RokugoB9[] {
  const out: RokugoB9[] = []
  for (const p of pages) {
    if (p.kind !== 'rokugo-b9') continue
    let beforeDeduct: number | null = null
    for (const l of p.lines) {
      if (!/控除前所得金額/.test(normText(l))) continue
      beforeDeduct = boxedNumber(p, l.y, 170, 300, 12)
      if (beforeDeduct != null) break
    }
    out.push({ page: p.num, beforeDeduct })
  }
  return out
}
