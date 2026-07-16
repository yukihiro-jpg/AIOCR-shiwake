// 仕訳クリック→画像参照ハイライトのための領域特定。
//
// Gemini の座標だけに頼ると必ず数〜数十px ずれるため、次の3段構えで補正する：
//  Stage1: 画像をローカル解析（canvas）し、罫線とテキスト行バンドをピクセル精度で検出
//  Stage2: 抽出済み取引リストを Gemini に渡し「各取引がどの行か・列はどこか」の
//          おおよその矩形だけを返させる（読み取りはさせない・本体OCRと独立）
//  Stage3: Gemini の行ボックスを Stage1 の行バンドへスナップ（吸着）し、
//          フィールド枠は行内の実際の文字位置（暗ピクセルのラン）へ絞り込む
//
// 結果は BankTransaction.refRegion（0〜1 の比率座標）に保存し、表示側で重ねる。

import type { StatementPage, TxRegion, NormBox } from './types'
import { locateTransactionRegions, type LocatedRegions } from './gemini-client'

// ---------- Stage1: ローカル画像解析 ----------

interface PageGeometry {
  w: number // 解析キャンバスの幅（px）
  h: number
  hLines: number[] // 水平罫線の y 位置
  bands: { y0: number; y1: number }[] // テキスト行バンド（罫線間 or 投影プロファイル）
  dark: Uint8Array // 二値化ビットマップ（1=暗）。フィールドのx絞り込みに使用
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image load error'))
    img.src = dataUrl
  })
}

/** Otsu法でしきい値を推定（スキャン品質のばらつきに対応）。極端な値はクランプ */
function otsuThreshold(hist: Int32Array, total: number): number {
  let sum = 0
  for (let i = 0; i < 256; i++) sum += i * hist[i]
  let sumB = 0
  let wB = 0
  let best = 0
  let bestT = 128
  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    if (wB === 0) continue
    const wF = total - wB
    if (wF === 0) break
    sumB += t * hist[t]
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > best) { best = between; bestT = t }
  }
  return Math.min(190, Math.max(110, bestT))
}

async function analyzePageGeometry(imageDataUrl: string): Promise<PageGeometry | null> {
  const img = await loadImage(imageDataUrl)
  const natW = img.naturalWidth
  const natH = img.naturalHeight
  if (!natW || !natH) return null
  // 解析は幅1600px以下に縮小（十分な精度・高速）
  const scale = Math.min(1, 1600 / natW)
  const w = Math.max(1, Math.round(natW * scale))
  const h = Math.max(1, Math.round(natH * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(img, 0, 0, w, h)
  let data: Uint8ClampedArray
  try {
    data = ctx.getImageData(0, 0, w, h).data
  } catch {
    return null
  }
  // 輝度化 + ヒストグラム
  const lum = new Uint8Array(w * h)
  const hist = new Int32Array(256)
  for (let i = 0, p = 0; i < lum.length; i++, p += 4) {
    const v = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000
    const vi = v | 0
    lum[i] = vi
    hist[vi]++
  }
  const th = otsuThreshold(hist, w * h)
  const dark = new Uint8Array(w * h)
  for (let i = 0; i < lum.length; i++) dark[i] = lum[i] < th ? 1 : 0

  // 水平投影
  const rowDark = new Int32Array(h)
  for (let y = 0; y < h; y++) {
    let c = 0
    const off = y * w
    for (let x = 0; x < w; x++) c += dark[off + x]
    rowDark[y] = c
  }
  // 水平罫線: 幅の50%以上が暗い行
  const isLine = (y: number) => rowDark[y] > w * 0.5
  const hLines: number[] = []
  for (let y = 0; y < h; y++) {
    if (isLine(y)) {
      const y0 = y
      while (y < h && isLine(y)) y++
      hLines.push((y0 + y - 1) / 2)
    }
  }

  // テキスト行バンド
  const bands: { y0: number; y1: number }[] = []
  if (hLines.length >= 4) {
    // 罫線が十分ある表: 罫線間のうちテキストを含む区間をバンドとする
    for (let i = 0; i < hLines.length - 1; i++) {
      const a = Math.ceil(hLines[i] + 1)
      const b = Math.floor(hLines[i + 1] - 1)
      if (b - a < 5) continue
      let has = false
      for (let y = a; y <= b; y++) { if (!isLine(y) && rowDark[y] > w * 0.004) { has = true; break } }
      if (has) bands.push({ y0: a, y1: b + 1 })
    }
  }
  if (bands.length < 3) {
    // 罫線がない/少ない（通帳等）: 投影プロファイルでテキスト行を検出
    bands.length = 0
    const isText = (y: number) => !isLine(y) && rowDark[y] > Math.max(3, w * 0.004)
    let y = 0
    while (y < h) {
      if (isText(y)) {
        const y0 = y
        let last = y
        y++
        while (y < h) {
          if (isText(y)) { last = y; y++ }
          else {
            // 2px以下のすき間は同一行として結合（かすれ対策）
            let g = 0
            while (y + g < h && !isText(y + g) && g <= 2) g++
            if (g <= 2 && y + g < h && isText(y + g)) { y += g } else break
          }
        }
        if (last - y0 >= 5) bands.push({ y0, y1: last + 1 })
      } else y++
    }
  }
  return { w, h, hLines, bands, dark }
}

// ---------- Stage3: スナップ ----------

const overlap = (a0: number, a1: number, b0: number, b1: number) =>
  Math.max(0, Math.min(a1, b1) - Math.max(a0, b0))

interface Band { y0: number; y1: number }
interface RowY { index: number; y0: number; y1: number; x0: number; x1: number }

/**
 * 順序保存の全体最適割当（DP）。
 * 取引行は上から順に並ぶという制約を使い、各行→行バンドの割当を全体で最適化する。
 * さらに全行共通の系統的ずれ δ をグリッドサーチで推定してから割り当てるため、
 * ずれが1行分近くあっても隣の行に誤吸着しない（行別の最近傍判定では起きる事故）。
 * 戻り値: rows と同順の Band | null 配列と、最適化スコア。
 */
function alignRowsToBands(rows: RowY[], bands: Band[], avgRowH: number): { assigned: (Band | null)[]; score: number } {
  const n = rows.length
  const m = bands.length
  if (!n || !m) return { assigned: new Array(n).fill(null), score: -Infinity }
  const NEG = -1e15

  const solve = (delta: number): { score: number; pick: (Band | null)[] } => {
    // s1[i][j] = 行i をバンドj に割当てたときのスコア
    // s2[i][j] = 行i をバンドj〜j+1（2バンド結合・摘要折返し）に割当てたときのスコア
    const s1 = (i: number, j: number) => {
      const y0 = rows[i].y0 + delta
      const y1 = rows[i].y1 + delta
      const b = bands[j]
      const ov = overlap(y0, y1, b.y0, b.y1)
      if (ov > 0) return ov
      // 重ならない場合も近いほど良い（わずかに負のスコアで許容）
      const d = Math.abs((y0 + y1) / 2 - (b.y0 + b.y1) / 2)
      return -Math.min(3, d / Math.max(8, avgRowH)) * 2
    }
    const s2 = (i: number, j: number) => {
      if (j + 1 >= m) return NEG
      const y0 = rows[i].y0 + delta
      const y1 = rows[i].y1 + delta
      const b1 = bands[j]
      const b2 = bands[j + 1]
      // 両方のバンドに実質かかっている場合のみ結合を許可
      // （片方だけだと、欠落行で空いたバンドを隣の行が不当に取り込む）
      const ov1 = overlap(y0, y1, b1.y0, b1.y1)
      const ov2 = overlap(y0, y1, b2.y0, b2.y1)
      if (ov1 < (b1.y1 - b1.y0) * 0.4) return NEG
      if (ov2 < (b2.y1 - b2.y0) * 0.4) return NEG
      return ov1 + ov2 * 0.9
    }
    // dp[i][j] = 行i以降を バンドj以降 に割当てる最大スコア
    const dp: Float64Array[] = Array.from({ length: n + 1 }, () => new Float64Array(m + 2).fill(NEG))
    const choice: Int8Array[] = Array.from({ length: n + 1 }, () => new Int8Array(m + 2))
    for (let j = 0; j <= m + 1; j++) dp[n][j] = 0
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m; j >= 0; j--) {
        if (j >= m) { dp[i][j] = NEG; continue }
        let bestV = dp[i][j + 1] // バンドjを使わない
        let bestC = 0
        const v1 = dp[i + 1][j + 1] === NEG ? NEG : dp[i + 1][j + 1] + s1(i, j)
        if (v1 > bestV) { bestV = v1; bestC = 1 }
        const sv2 = s2(i, j)
        if (sv2 > NEG / 2 && j + 2 <= m + 1) {
          const v2 = dp[i + 1][j + 2] === NEG ? NEG : dp[i + 1][j + 2] + sv2
          if (v2 > bestV) { bestV = v2; bestC = 2 }
        }
        dp[i][j] = bestV
        choice[i][j] = bestC
      }
    }
    // 復元
    const pick: (Band | null)[] = new Array(n).fill(null)
    let i = 0
    let j = 0
    while (i < n && j < m) {
      const c = choice[i][j]
      if (c === 0) { j++; continue }
      if (c === 1) { pick[i] = bands[j]; i++; j++; continue }
      pick[i] = { y0: bands[j].y0, y1: bands[j + 1].y1 }; i++; j += 2
    }
    return { score: dp[0][0], pick }
  }

  // 系統的ずれのグリッドサーチ（±2.2行分・2pxステップ）
  const range = Math.max(20, Math.round(avgRowH * 2.2))
  let best: { score: number; pick: (Band | null)[] } | null = null
  for (let d = -range; d <= range; d += 2) {
    const r = solve(d)
    if (!best || r.score > best.score) best = r
  }
  return { assigned: best!.pick, score: best!.score }
}

/** バンド検出を x 範囲限定で行う（見開きスキャンの左右独立表用） */
function bandsInXRange(geom: PageGeometry, x0: number, x1: number): Band[] {
  const { w, h, dark } = geom
  const a = Math.max(0, Math.round(x0))
  const b = Math.min(w, Math.round(x1))
  const span = Math.max(1, b - a)
  const rowDark = new Int32Array(h)
  for (let y = 0; y < h; y++) {
    let c = 0
    const off = y * w
    for (let x = a; x < b; x++) c += dark[off + x]
    rowDark[y] = c
  }
  const isLine = (y: number) => rowDark[y] > span * 0.5
  const isText = (y: number) => !isLine(y) && rowDark[y] > Math.max(2, span * 0.004)
  const bands: Band[] = []
  let y = 0
  while (y < h) {
    if (isText(y)) {
      const y0 = y
      let last = y
      y++
      while (y < h) {
        if (isText(y)) { last = y; y++ }
        else {
          let g = 0
          while (y + g < h && !isText(y + g) && g <= 2) g++
          if (g <= 2 && y + g < h && isText(y + g)) { y += g } else break
        }
      }
      if (last - y0 >= 5) bands.push({ y0, y1: last + 1 })
    } else y++
  }
  return bands
}

/** 行バンド内・指定x範囲の実際の文字位置（暗ピクセルのラン）に絞り込む */
function tightenX(
  geom: PageGeometry,
  y0: number, y1: number,
  colX0: number, colX1: number,
): { x0: number; x1: number } | null {
  const w = geom.w
  const a = Math.max(0, Math.round(y0))
  const b = Math.min(geom.h, Math.round(y1))
  if (b - a < 2) return null
  // 行バンド内の縦方向カウント（罫線行の影響を避けるため dark をそのまま集計）
  const colCount = new Int32Array(w)
  for (let y = a; y < b; y++) {
    const off = y * w
    for (let x = 0; x < w; x++) colCount[x] += geom.dark[off + x]
  }
  // 縦罫線由来の列（バンド高さの90%以上が暗い1-2px幅）はランに含めない
  const bandH = b - a
  const isInk = (x: number) => colCount[x] > 0 && colCount[x] < bandH * 0.9
  // ギャップ許容で暗ランを列挙
  const gapTol = Math.max(6, Math.round(w * 0.008))
  const runs: { s: number; e: number }[] = []
  let x = 0
  while (x < w) {
    if (isInk(x)) {
      const s = x
      let last = x
      x++
      while (x < w) {
        if (isInk(x)) { last = x; x++ }
        else {
          let g = 0
          while (x + g < w && !isInk(x + g)) g++
          if (g <= gapTol && x + g < w) { x += g } else break
        }
      }
      runs.push({ s, e: last })
    } else x++
  }
  // 指定列範囲と重なるランの結合
  let rx0 = Infinity
  let rx1 = -Infinity
  for (const r of runs) {
    if (overlap(r.s, r.e + 1, colX0, colX1) > 0) {
      rx0 = Math.min(rx0, r.s)
      rx1 = Math.max(rx1, r.e + 1)
    }
  }
  if (!isFinite(rx0)) return null
  // 隣列の文字まで巻き込まないよう、列範囲の±25%幅までにクランプ
  const colW = Math.max(8, colX1 - colX0)
  const lim0 = colX0 - colW * 0.25
  const lim1 = colX1 + colW * 0.25
  return { x0: Math.max(rx0, lim0), x1: Math.min(rx1, lim1) }
}

function snapRegions(
  geom: PageGeometry,
  located: LocatedRegions,
  txs: { deposit: number | null; withdrawal: number | null }[],
): (TxRegion | undefined)[] {
  const pad = Math.max(1, geom.h * 0.002)
  const result: (TxRegion | undefined)[] = new Array(txs.length)

  const norm = (x0: number, y0: number, x1: number, y1: number): NormBox => ({
    x0: Math.max(0, Math.min(1, x0 / geom.w)),
    y0: Math.max(0, Math.min(1, y0 / geom.h)),
    x1: Math.max(0, Math.min(1, x1 / geom.w)),
    y1: Math.max(0, Math.min(1, y1 / geom.h)),
  })

  // 座標解釈2通り（正式は [ymin,xmin,ymax,xmax]。稀に [xmin,ymin,...] で返る揺れに対応）
  const convYX = (b: [number, number, number, number]) => ({
    y0: (b[0] / 1000) * geom.h, x0: (b[1] / 1000) * geom.w,
    y1: (b[2] / 1000) * geom.h, x1: (b[3] / 1000) * geom.w,
  })
  const convXY = (b: [number, number, number, number]) => ({
    x0: (b[0] / 1000) * geom.w, y0: (b[1] / 1000) * geom.h,
    x1: (b[2] / 1000) * geom.w, y1: (b[3] / 1000) * geom.h,
  })

  // 解釈ごとに「表グループ分け→DP割当」を行い、総スコアの高い解釈を採用する
  const buildAssignment = (conv: typeof convYX) => {
    const rows: RowY[] = located.rows
      .filter((r) => r.index >= 0 && r.index < txs.length)
      .map((r) => {
        const c = conv(r.box)
        return { index: r.index, y0: Math.min(c.y0, c.y1), y1: Math.max(c.y0, c.y1), x0: Math.min(c.x0, c.x1), x1: Math.max(c.x0, c.x1) }
      })
      .filter((r) => r.y1 > r.y0)
    // 表ごとにグループ化（x重なり最大の表へ）
    const groups: { table: LocatedRegions['tables'][number]; rows: RowY[] }[] =
      located.tables.map((t) => ({ table: t, rows: [] }))
    for (const r of rows) {
      let gi = 0
      if (groups.length > 1) {
        let bestOv = -1
        groups.forEach((g, i) => {
          const tx0 = (g.table.xRange[0] / 1000) * geom.w
          const tx1 = (g.table.xRange[1] / 1000) * geom.w
          const ov = overlap(r.x0, r.x1, tx0, tx1)
          if (ov > bestOv) { bestOv = ov; gi = i }
        })
      }
      groups[gi].rows.push(r)
    }
    let total = 0
    const bandOf = new Map<number, Band>() // tx index → snapped band
    for (const g of groups) {
      if (!g.rows.length) continue
      // 見開き等の複数表では、その表のx範囲に限定して行バンドを再検出
      const bands = located.tables.length > 1
        ? bandsInXRange(geom, (g.table.xRange[0] / 1000) * geom.w, (g.table.xRange[1] / 1000) * geom.w)
        : geom.bands
      if (!bands.length) continue
      const sorted = [...g.rows].sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1))
      const avgRowH = sorted.reduce((s, r) => s + (r.y1 - r.y0), 0) / sorted.length
      const { assigned, score } = alignRowsToBands(sorted, bands, avgRowH)
      total += score
      sorted.forEach((r, i) => { const b = assigned[i]; if (b) bandOf.set(r.index, b) })
    }
    return { rows, total, bandOf }
  }

  const a1 = buildAssignment(convYX)
  const a2 = buildAssignment(convXY)
  const chosen = a1.total >= a2.total ? a1 : a2
  const conv = a1.total >= a2.total ? convYX : convXY

  // 取引index→生ボックス（表の判定・行フォールバックに使用）
  const rawOf = new Map<number, { y0: number; y1: number; x0: number; x1: number }>()
  for (const r of located.rows) {
    if (r.index < 0 || r.index >= txs.length) continue
    const c = conv(r.box)
    rawOf.set(r.index, { y0: Math.min(c.y0, c.y1), y1: Math.max(c.y0, c.y1), x0: Math.min(c.x0, c.x1), x1: Math.max(c.x0, c.x1) })
  }

  // Geminiが行を返さなかった取引: 前後の割当バンドの間にバンドが1つだけあれば補間
  for (let k = 1; k < txs.length - 1; k++) {
    if (chosen.bandOf.has(k) || rawOf.has(k)) continue
    const prev = chosen.bandOf.get(k - 1)
    const next = chosen.bandOf.get(k + 1)
    if (prev && next && next.y0 > prev.y1) {
      const gapBands = geom.bands.filter((b) => b.y0 >= prev.y1 - 1 && b.y1 <= next.y0 + 1)
      if (gapBands.length === 1) chosen.bandOf.set(k, gapBands[0])
    }
  }

  for (let i = 0; i < txs.length; i++) {
    const band = chosen.bandOf.get(i)
    const raw = rawOf.get(i)
    if (!band && !raw) continue
    const y0 = Math.max(0, (band ? band.y0 : raw!.y0) - pad)
    const y1 = Math.min(geom.h, (band ? band.y1 : raw!.y1) + pad)

    // この行が属する表（x重なり最大）
    let table = located.tables[0]
    if (located.tables.length > 1 && raw) {
      let bestOv = -1
      for (const t of located.tables) {
        const tx0 = (t.xRange[0] / 1000) * geom.w
        const tx1 = (t.xRange[1] / 1000) * geom.w
        const ov = overlap(raw.x0, raw.x1, tx0, tx1)
        if (ov > bestOv) { bestOv = ov; table = t }
      }
    }
    const tableX0 = (table.xRange[0] / 1000) * geom.w
    const tableX1 = (table.xRange[1] / 1000) * geom.w

    const region: TxRegion = { row: norm(tableX0, y0, tableX1, y1) }

    const colBox = (range?: [number, number]): NormBox | undefined => {
      if (!range) return undefined
      const cx0 = (range[0] / 1000) * geom.w
      const cx1 = (range[1] / 1000) * geom.w
      if (cx1 <= cx0) return undefined
      const tight = tightenX(geom, y0, y1, cx0, cx1)
      if (tight) return norm(tight.x0 - 3, y0, tight.x1 + 3, y1)
      return norm(cx0, y0, cx1, y1) // 空セルは列範囲のまま
    }

    const tx = txs[i]
    region.date = colBox(table.columns.date)
    region.description = colBox(table.columns.description)
    const amountRange = tx.deposit != null && tx.deposit !== 0
      ? (table.columns.deposit || table.columns.amount)
      : tx.withdrawal != null && tx.withdrawal !== 0
        ? (table.columns.withdrawal || table.columns.amount)
        : undefined
    region.amount = colBox(amountRange)
    region.balance = colBox(table.columns.balance)

    result[i] = region
  }
  return result
}

// ---------- 入口: ページ群に参照領域を付与 ----------

/** locate 呼び出し用に画像を縮小（幅1200px・JPEG）してトークンと転送量を抑える */
async function downscaleForLocate(imageDataUrl: string): Promise<string> {
  try {
    const img = await loadImage(imageDataUrl)
    const scale = Math.min(1, 1200 / (img.naturalWidth || 1200))
    if (scale >= 1) return imageDataUrl
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(img.naturalWidth * scale)
    canvas.height = Math.round(img.naturalHeight * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) return imageDataUrl
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.85)
  } catch {
    return imageDataUrl
  }
}

/**
 * 各ページの取引に refRegion を付与するための txId→TxRegion マップを返す。
 * ページ単位で独立に処理し、失敗したページは黙ってスキップ（ハイライトなし）。
 */
export async function annotateRegionsForPages(
  pages: StatementPage[],
  geminiModel?: string,
): Promise<Map<string, TxRegion>> {
  const map = new Map<string, TxRegion>()
  const targets = pages.filter((p) => p.imageDataUrl && p.transactions.length > 0)
  const CONCURRENCY = 3
  let next = 0
  const worker = async () => {
    while (next < targets.length) {
      const page = targets[next++]
      try {
        const [geom, small] = await Promise.all([
          analyzePageGeometry(page.imageDataUrl!),
          downscaleForLocate(page.imageDataUrl!),
        ])
        if (!geom || geom.bands.length === 0) continue
        const located = await locateTransactionRegions(
          small,
          page.transactions.map((t) => ({
            date: t.date, description: t.description,
            deposit: t.deposit, withdrawal: t.withdrawal, balance: t.balance,
          })),
          geminiModel,
        )
        if (!located) continue
        const regions = snapRegions(geom, located, page.transactions)
        page.transactions.forEach((t, i) => {
          const rg = regions[i]
          if (rg) map.set(t.id, rg)
        })
      } catch (e) {
        console.log(`region annotate: page ${page.pageIndex} skipped:`, e)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker))
  return map
}
