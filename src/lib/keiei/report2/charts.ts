// 新報告書 v2 の図（SVG）。
//
// 設計の意図:
//  - 紙面は承認済みのデザインモック（monthly-report-cyan-v3.html）が正。viewBox・フォントサイズ・
//    線幅・配置の考え方はモックのまま移植し、**座標だけ** を ctx の実データから計算している。
//    「見た目を良くするために配置を変える」のは禁止（ユーザーが承認した紙面と変わってしまうため）。
//  - 返すのは `<svg>…</svg>` の文字列だけ。凡例・キャプションなど図の外のHTMLはページ側が作る
//    （図とキャプションの間隔をページごとに詰めたいので、図の中に抱え込ませない）。
//  - 目盛りの数字は必ず amt(値, ctx.unit) を通す。会社の規模で桁が変わる（千円／円）ので、
//    単位の切替は theme.ts の1か所に任せて図の中では判断しない。
//  - 金額の内部単位は「円」。ここでは割り算も掛け算もせず、そのまま amt() へ渡す。
//  - データが無くても例外を投げない。空の `<svg>` を返し、ページ側が「—」を出せるようにする。
//  - 文字が線や他の文字に重ならないよう、モックと同じく「高さ帯」で役割を分ける
//    （凡例＝上／吹き出し＝中／ゾーン説明＝軸の直上）。数値の大小で吹き出しが枠外へ出る場合は
//    左右を入れ替える（赤字の会社でも紙面が破綻しないように）。
import type { ReportV2Context } from './types'
import { CY, CY15, CY30, INK08, INK18, INK45, INK70, amt, esc, pct, unitWord } from './theme'

// モックにあってテーマ定数には無い中間トーン（2色刷りの中で「線の格」を分けるために使う）
const GRID = '#e6e6e6'    // 目盛線（いちばん薄い）
const GRAY = '#6f6f6f'    // 総費用の線・見込Bの線（黒より一段弱い無彩色）
const HAIR = '#c9c9c9'    // 固定費の水平補助線
const ZONE_OK = '#cceaf7' // 黒字ゾーンの塗り（CY15より濃くCY30より薄い）
const ZONE_NG = '#e8e8e8' // 赤字ゾーンの塗り
const FCBG = '#f4f4f4'    // 見込み期間の背景

// ===== 小道具 =====
/** 座標は小数1桁まで（SVGの文字列を短くし、印刷時の差分も出さない） */
const f = (n: number): string => (isFinite(n) ? n : 0).toFixed(1)
const fin = (n: number | null | undefined): number => (n != null && isFinite(n) ? n : 0)
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

interface Scale { lo: number; hi: number; step: number; n: number }

/**
 * キリのよい目盛り幅（1・1.5・2・2.5・5・10 の10^n倍）。
 * 1.5 を候補に入れているのはモックの「15,000刻み」を再現するため。
 */
function niceStep(raw: number): number {
  const v = Math.abs(raw)
  if (!(v > 0) || !isFinite(v)) return 1
  const pow = Math.pow(10, Math.floor(Math.log10(v)))
  const n = v / pow
  const m = n <= 1 ? 1 : n <= 1.5 ? 1.5 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10
  return m * pow
}
/** 次に大きいキリのよい幅（軸が収まらないときに1段上げる） */
const stepUp = (step: number): number => niceStep(step * 1.0001)

/**
 * 0を含む軸（棒グラフ・残高など）。上端は実データの1割増しまで伸ばす
 * （棒や線が天井に張り付くと「まだ上がある」感じが出ないため）。
 */
function niceRange(minV: number, maxV: number, ticks: number): Scale {
  const lo0 = Math.min(0, fin(minV))
  const hi0 = Math.max(0, fin(maxV))
  const hiP = hi0 > 0 ? hi0 * 1.1 : 0
  const loP = lo0 < 0 ? lo0 * 1.1 : 0
  const span = Math.max(hiP - loP, 1)
  const step = niceStep(span / Math.max(1, ticks))
  const lo = Math.floor(loP / step) * step
  const hi = Math.ceil(hiP / step) * step
  const n = Math.max(1, Math.round((hi - lo) / step))
  return { lo, hi: lo + n * step, step, n }
}

/**
 * 目盛り本数を固定した軸（借入金残高のように、0から描くと月々の増減が見えないものは下を切る）。
 * 下限は「実データの下に少し余白」まで下げるだけにして、棒の高さの差が読めるようにする。
 */
function fixedScale(minV: number, maxV: number, n: number): Scale {
  const mn = fin(minV)
  const mx = Math.max(fin(maxV), mn)
  const spread = Math.max(mx - mn, Math.max(Math.abs(mx), 1) * 0.05)
  const hi0 = mx + spread * 0.35
  const lo0 = Math.max(0, mn - spread * 0.8)
  let step = niceStep((hi0 - lo0) / n)
  let lo = Math.floor(lo0 / step) * step
  let guard = 0
  while (lo + step * n < hi0 && guard++ < 12) {
    step = stepUp(step)
    lo = Math.floor(lo0 / step) * step
  }
  return { lo, hi: lo + step * n, step, n }
}

/** 摘要を図の中に置ける長さへ詰める（「・」で連結された最初の1件だけ使う） */
function shortNote(s: string, max = 7): string {
  const head = String(s || '').split('・')[0]
  return head.length > max ? head.slice(0, max) + '…' : head
}

// ============================================================================
// 損益分岐点図（モック P6 の大きい図）
// ============================================================================
/**
 * ①売上高の線（黒の太い実線）と ②総費用の線（グレーの点線）の交点＝損益分岐点。
 * 縦軸・横軸とも同じ売上高スケールなので、①は必ず左下から右上への対角線になる。
 */
export function bepChart(ctx: ReportV2Context): string {
  const V = 'viewBox="0 0 1480 385" style="width:100%; height:72mm"'
  const u = ctx.unit
  const b = ctx.bep
  const X0 = 100, X1 = 1420, Y0 = 310, Y1 = 26

  const now = fin(b.nowAnnual)
  const fixed = Math.max(0, fin(b.fixedAnnual))
  const landingV = fin(b.landingSales)
  const bepV = fin(b.bepAnnual)
  const hasBep = bepV > 0 && isFinite(bepV)
  const peak = Math.max(now, landingV, fixed, hasBep ? bepV : 0)
  if (!(peak > 0)) return `<svg ${V}></svg>`

  const sc = niceRange(0, peak, 7)
  const SMAX = sc.hi > 0 ? sc.hi : 1
  const px = (v: number): number => X0 + (clamp(v, 0, SMAX) / SMAX) * (X1 - X0)
  const py = (v: number): number => Y0 - (clamp(v, 0, SMAX) / SMAX) * (Y0 - Y1)

  // 総費用の線：固定費から始まり、傾きが変動費率（＝1−限界利益率）。
  // marginalRate は割合（0.35＝35%）で持っている。100で割らないこと（過去に線が45度になる不具合）
  const varRate = 1 - fin(b.marginalRate)
  const costAt = (s: number): number => fixed + s * varRate
  // 上端をはみ出す（限界利益率がゼロ以下＝売っても利益が出ない）ときは枠内で切る
  let sEnd = SMAX
  if (varRate > 0 && costAt(SMAX) > SMAX) sEnd = clamp((SMAX - fixed) / varRate, 0, SMAX)

  const p: string[] = [`<svg ${V}>`]

  // --- ゾーンの塗り（線より先に敷く） ---
  if (hasBep) {
    const bx = px(bepV), by = py(bepV)
    p.push(`<polygon points="${f(bx)},${f(by)} ${f(px(sEnd))},${f(py(sEnd))} ${f(px(sEnd))},${f(py(costAt(sEnd)))}" fill="${ZONE_OK}"/>`)
    p.push(`<polygon points="${f(X0)},${f(Y0)} ${f(bx)},${f(by)} ${f(X0)},${f(py(fixed))}" fill="${ZONE_NG}"/>`)
  }

  // --- 目盛 ---
  for (let k = 0; k <= sc.n; k++) {
    const v = sc.lo + sc.step * k
    const y = py(v)
    p.push(`<line x1="${f(X0)}" y1="${f(y)}" x2="${f(X1)}" y2="${f(y)}" stroke="${GRID}" stroke-width="1"/>`)
    p.push(`<text x="90" y="${f(y + 5)}" font-size="13" fill="${INK45}" text-anchor="end">${esc(amt(v, u))}</text>`)
  }
  p.push(`<line x1="${f(X0)}" y1="${f(Y0)}" x2="${f(X1)}" y2="${f(Y0)}" stroke="#000" stroke-width="1.6"/>`)
  p.push(`<line x1="${f(X0)}" y1="${f(Y1)}" x2="${f(X0)}" y2="${f(Y0)}" stroke="#000" stroke-width="1.6"/>`)
  p.push(`<text x="${f(X1)}" y="334" font-size="13" fill="${INK70}" text-anchor="end">売上高（${esc(unitWord(u))}）→</text>`)
  p.push(`<text x="56" y="18" font-size="13" fill="${INK70}">${esc(unitWord(u))}</text>`)

  // --- ② 総費用の線 ---
  const fy0 = py(fixed)
  p.push(`<line x1="${f(X0)}" y1="${f(fy0)}" x2="${f(px(sEnd))}" y2="${f(py(costAt(sEnd)))}" stroke="${GRAY}" stroke-width="3.4" stroke-dasharray="9 5"/>`)
  p.push(`<line x1="${f(X0)}" y1="${f(fy0)}" x2="${f(X1)}" y2="${f(fy0)}" stroke="${HAIR}" stroke-width="1.4"/>`)
  p.push(`<rect x="104" y="${f(fy0 + 3)}" width="134" height="23" fill="#fff"/>`)
  p.push(`<text x="112" y="${f(fy0 + 20)}" font-size="13" fill="${INK70}">固定費 ${esc(amt(fixed, u))}</text>`)
  // --- ① 売上高の線 ---
  p.push(`<line x1="${f(X0)}" y1="${f(Y0)}" x2="${f(X1)}" y2="${f(Y1)}" stroke="#000" stroke-width="3.8"/>`)

  // --- 凡例（左上の空き。①②がどの線かを明示する） ---
  p.push(`<rect x="122" y="32" width="530" height="76" fill="#fff" stroke="#000" stroke-width="1.2"/>`)
  p.push(`<circle cx="148" cy="56" r="12" fill="#000"/>`)
  p.push(`<text x="148" y="61" font-size="14" font-weight="700" fill="#fff" text-anchor="middle">1</text>`)
  p.push(`<line x1="168" y1="56" x2="218" y2="56" stroke="#000" stroke-width="3.8"/>`)
  p.push(`<text x="230" y="62" font-size="17" font-weight="700">売上高の線（太い実線）</text>`)
  p.push(`<circle cx="148" cy="88" r="12" fill="${GRAY}"/>`)
  p.push(`<text x="148" y="93" font-size="14" font-weight="700" fill="#fff" text-anchor="middle">2</text>`)
  p.push(`<line x1="168" y1="88" x2="218" y2="88" stroke="${GRAY}" stroke-width="3.4" stroke-dasharray="9 5"/>`)
  p.push(`<text x="230" y="94" font-size="17" font-weight="700" fill="${INK70}">総費用の線（点線）＝固定費＋変動費</text>`)

  // 赤字（いまの位置が分岐点より左）のときは吹き出しの左右を入れ替える
  const lossSide = hasBep && now < bepV
  const nowX = px(now)
  const salesY = py(now)
  const costY = py(clamp(costAt(now), 0, SMAX))

  // --- 交点（損益分岐点）※吹き出しは空いている側へ ---
  if (hasBep) {
    const bx = px(bepV), by = py(bepV)
    const roomL = bx - 106, roomR = 1474 - bx
    const toRight = lossSide ? (roomR >= 420 || roomR > roomL) : (roomL < 420 && (roomR >= 420 || roomR > roomL))
    const s = toRight ? 1 : -1
    const ay = clamp(by + 78, 86, 234)   // リーダーの水平部の高さ（文字の帯）
    p.push(`<line x1="${f(bx)}" y1="${f(Y1)}" x2="${f(bx)}" y2="${f(Y0)}" stroke="${CY}" stroke-width="1.8" stroke-dasharray="6 4"/>`)
    p.push(`<circle cx="${f(bx)}" cy="${f(by)}" r="11" fill="#fff" stroke="${CY}" stroke-width="4.5"/>`)
    p.push(`<polyline points="${f(bx + s * 10)},${f(by + 8)} ${f(bx + s * 60)},${f(ay)} ${f(bx + s * 96)},${f(ay)}" fill="none" stroke="${CY}" stroke-width="1.5"/>`)
    const tx = bx + s * 104
    p.push(`<rect x="${f(toRight ? tx : tx - 306)}" y="${f(ay - 30)}" width="306" height="68" fill="#fff" opacity="0.82"/>`)
    const anc = toRight ? 'start' : 'end'
    p.push(`<text x="${f(tx)}" y="${f(ay - 16)}" font-size="15" font-weight="700" fill="${CY}" text-anchor="${anc}">①と②が交わるこの点が</text>`)
    p.push(`<text x="${f(tx)}" y="${f(ay + 8)}" font-size="20" font-weight="700" fill="${CY}" text-anchor="${anc}">損益分岐点 ${esc(amt(bepV, u))} ${esc(unitWord(u))}</text>`)
    p.push(`<text x="${f(tx)}" y="${f(ay + 28)}" font-size="13.5" fill="${CY}" text-anchor="${anc}">ちょうど達成すると利益ゼロ（トントン）</text>`)
  }

  // --- いまの位置（報告月までの実績を年換算） ---
  p.push(`<line x1="${f(nowX)}" y1="${f(Y1)}" x2="${f(nowX)}" y2="${f(Y0)}" stroke="#000" stroke-width="1.6"/>`)
  // 売上高の線と総費用の線の間＝営業利益（この幅がそのまま利益）
  p.push(`<line x1="${f(nowX)}" y1="${f(salesY)}" x2="${f(nowX)}" y2="${f(costY)}" stroke="${CY}" stroke-width="7"/>`)
  p.push(`<circle cx="${f(nowX)}" cy="${f(salesY)}" r="10" fill="${CY}" stroke="#fff" stroke-width="3"/>`)
  const bandTop = Math.min(salesY, costY)
  const bandBottom = Math.max(salesY, costY)
  const profit = now - costAt(now)
  const toR = nowX + 220 <= 1474
  const sp = toR ? 1 : -1
  const lead1 = clamp(bandTop + 52, 64, 184)
  p.push(`<polyline points="${f(nowX + sp * 6)},${f(bandTop + 7)} ${f(nowX + sp * 38)},${f(lead1)} ${f(nowX + sp * 58)},${f(lead1)}" fill="none" stroke="${CY}" stroke-width="1.4"/>`)
  const lx = nowX + sp * 62
  const lanc = toR ? 'start' : 'end'
  p.push(`<text x="${f(lx)}" y="${f(lead1 - 4)}" font-size="15" font-weight="700" fill="${CY}" text-anchor="${lanc}">この幅が営業${profit < 0 ? '損失' : '利益'}</text>`)
  p.push(`<text x="${f(lx)}" y="${f(lead1 + 16)}" font-size="15" font-weight="700" fill="${CY}" text-anchor="${lanc}">${esc(amt(Math.abs(profit), u))} ${esc(unitWord(u))}</text>`)
  // 説明のボックス（右下。赤字のときは左へ寄せて分岐点の吹き出しと重ねない）
  const boxX = clamp(lossSide ? nowX - 248 : nowX - 94, 106, 1132)
  p.push(`<rect x="${f(boxX)}" y="196" width="342" height="72" fill="#fff" stroke="${CY}" stroke-width="1.4"/>`)
  p.push(`<text x="${f(boxX + 14)}" y="218" font-size="13.5" fill="#000">★ いまの位置（${esc(ctx.monthLabel)}までの実績を年換算）</text>`)
  p.push(`<text x="${f(boxX + 14)}" y="243" font-size="20" font-weight="700" fill="${CY}">${esc(amt(now, u))} ${esc(unitWord(u))}</text>`)
  if (hasBep) {
    const gap = now - bepV
    const word = gap >= 0 ? '上（安全余裕率' : '下（不足率'
    p.push(`<text x="${f(boxX + 14)}" y="261" font-size="13" fill="${INK70}">分岐点より ${esc(amt(Math.abs(gap), u))} ${word} ${esc(pct(Math.abs(fin(b.safetyRatio))))}）</text>`)
  } else {
    p.push(`<text x="${f(boxX + 14)}" y="261" font-size="13" fill="${INK70}">限界利益がマイナスのため分岐点は計算できません</text>`)
  }
  if (bandBottom < 190) {
    p.push(`<line x1="${f(nowX)}" y1="${f(bandBottom)}" x2="${f(nowX)}" y2="196" stroke="${CY}" stroke-width="1.2" stroke-dasharray="4 3"/>`)
  }

  // --- ゾーンの説明（軸のすぐ上。吹き出しとは高さを分けている） ---
  if (hasBep) {
    const bx = px(bepV)
    const lc = (X0 + bx) / 2
    const rc = (bx + X1) / 2
    p.push(`<text x="${f(lc)}" y="284" font-size="16" font-weight="700" fill="${INK70}" text-anchor="middle">← ここより左は赤字</text>`)
    p.push(`<text x="${f(lc)}" y="302" font-size="13" fill="${INK70}" text-anchor="middle">売上より総費用のほうが大きい</text>`)
    p.push(`<text x="${f(rc)}" y="284" font-size="16" font-weight="700" text-anchor="middle">ここより右が黒字 →</text>`)
    p.push(`<text x="${f(rc)}" y="302" font-size="13" fill="${INK70}" text-anchor="middle">①と②の間の幅がそのまま利益になる</text>`)
  }

  p.push('</svg>')
  return p.join('\n')
}

// ============================================================================
// 当期の月次推移と着地見込（モック P3 下段）
// ============================================================================
/**
 * 棒＝売上高（左軸）／線＝当期純利益（右軸）。報告月の翌月からは
 * A（当期の月平均）とB（前期の同じ月）の2通りを並べて出す。
 */
export function monthlyTrendChart(ctx: ReportV2Context): string {
  const V = 'viewBox="0 0 1480 205" style="width:100%; height:31mm"'
  const u = ctx.unit
  const L = ctx.landing
  const labels = ctx.monthLabels
  const M = labels.length
  if (!M) return `<svg ${V}></svg>`
  const X0 = 96, X1 = 1424, Y0 = 178, Y1 = 16
  const idx = clamp(ctx.monthIdx, 0, M - 1)
  const band = (X1 - X0) / M
  const cx = (i: number): number => X0 + (i + 0.5) * band
  const BW = 62, BW2 = 29.9, GAP2 = 4.4   // 実績の棒／見込みの2本並べ（モックの幅をそのまま使う）

  const salesAct = (i: number): number | null => (i <= idx ? L.monthlySales[i] ?? null : null)
  const netAct = (i: number): number | null => (i <= idx ? L.monthlyNet[i] ?? null : null)

  // 軸のスケール（左＝売上4段階／右＝利益3段階。モックの目盛り数に合わせる）
  const sVals: number[] = []
  const nVals: number[] = []
  for (let i = 0; i < M; i++) {
    for (const v of [salesAct(i), i > idx ? L.forecastSalesA[i] : null, i > idx ? L.forecastSalesB[i] : null]) {
      if (v != null && isFinite(v)) sVals.push(v)
    }
    for (const v of [netAct(i), L.forecastNetA[i], L.forecastNetB[i]]) {
      if (v != null && isFinite(v)) nVals.push(v)
    }
  }
  if (!sVals.length && !nVals.length) return `<svg ${V}></svg>`
  const SL = niceRange(Math.min(0, ...sVals), Math.max(0, ...sVals), 4)
  const NL = niceRange(Math.min(0, ...nVals), Math.max(0, ...nVals), 3)
  const yl = (v: number): number => Y0 - ((clamp(v, SL.lo, SL.hi) - SL.lo) / (SL.hi - SL.lo)) * (Y0 - Y1)
  const yr = (v: number): number => Y0 - ((clamp(v, NL.lo, NL.hi) - NL.lo) / (NL.hi - NL.lo)) * (Y0 - Y1)
  const yZero = yl(0)

  const p: string[] = [`<svg ${V}>`]

  // 見込み期間の背景（ここから先は実績ではないと一目で分かるように）
  const fcFrom = idx + 1
  if (fcFrom < M) {
    const bx = X0 + fcFrom * band
    p.push(`<rect x="${f(bx)}" y="${f(Y1)}" width="${f(X1 - bx)}" height="${f(Y0 - Y1)}" fill="${FCBG}"/>`)
    p.push(`<text x="${f((bx + X1) / 2)}" y="30" font-size="13" fill="${INK45}" text-anchor="middle">ここから先は見込み</text>`)
  }
  // 目盛（左）
  for (let k = 0; k <= SL.n; k++) {
    const v = SL.lo + SL.step * k
    const y = yl(v)
    p.push(`<line x1="${f(X0)}" y1="${f(y)}" x2="${f(X1)}" y2="${f(y)}" stroke="${GRID}" stroke-width="1"/>`)
    p.push(`<text x="88" y="${f(y + 4)}" font-size="11" fill="${INK45}" text-anchor="end">${esc(amt(v, u))}</text>`)
  }
  // 目盛（右＝当期純利益）
  for (let k = 0; k <= NL.n; k++) {
    const v = NL.lo + NL.step * k
    p.push(`<text x="1432" y="${f(yr(v) + 4)}" font-size="11" fill="${INK45}">${esc(amt(v, u))}</text>`)
  }
  // 棒（売上高）
  const bar = (x: number, w: number, v: number, style: string): string => {
    const y = yl(v)
    const top = Math.min(y, yZero)
    const h = Math.max(0.6, Math.abs(y - yZero))
    return `<rect x="${f(x)}" y="${f(top)}" width="${f(w)}" height="${f(h)}" ${style}/>`
  }
  for (let i = 0; i < M; i++) {
    const a = salesAct(i)
    if (a != null) { p.push(bar(cx(i) - BW / 2, BW, a, `fill="${CY}"`)); continue }
    if (i <= idx) continue
    const fa = L.forecastSalesA[i]
    const fb = L.forecastSalesB[i]
    if (fa != null && isFinite(fa)) p.push(bar(cx(i) - BW2 - GAP2 / 2, BW2, fa, `fill="${CY30}" stroke="${CY}" stroke-width="1"`))
    if (fb != null && isFinite(fb)) p.push(bar(cx(i) + GAP2 / 2, BW2, fb, `fill="#fff" stroke="${GRAY}" stroke-width="1" stroke-dasharray="3 2"`))
  }
  p.push(`<line x1="${f(X0)}" y1="${f(yZero)}" x2="${f(X1)}" y2="${f(yZero)}" stroke="#000" stroke-width="1.5"/>`)

  // 線（当期純利益）
  const poly = (pts: string[], style: string): string =>
    pts.length >= 2 ? `<polyline points="${pts.join(' ')}" fill="none" ${style}/>` : ''
  const actPts: string[] = []
  for (let i = 0; i <= idx; i++) {
    const v = netAct(i)
    if (v != null) actPts.push(`${f(cx(i))},${f(yr(v))}`)
  }
  p.push(poly(actPts, `stroke="#000" stroke-width="2.6"`))
  const fcPts = (arr: (number | null)[]): string[] => {
    const out: string[] = []
    for (let i = idx; i < M; i++) {
      const v = arr[i]
      if (v != null && isFinite(v)) out.push(`${f(cx(i))},${f(yr(v))}`)
    }
    return out
  }
  p.push(poly(fcPts(L.forecastNetA), `stroke="${CY}" stroke-width="2.6" stroke-dasharray="8 4"`))
  p.push(poly(fcPts(L.forecastNetB), `stroke="${GRAY}" stroke-width="2.2" stroke-dasharray="3 3"`))
  for (let i = 0; i <= idx; i++) {
    const v = netAct(i)
    if (v != null) p.push(`<circle cx="${f(cx(i))}" cy="${f(yr(v))}" r="3.4" fill="#000"/>`)
  }
  // 月ラベル
  for (let i = 0; i < M; i++) {
    p.push(`<text x="${f(cx(i))}" y="196" font-size="12.5" fill="#000" text-anchor="middle">${esc(labels[i])}</text>`)
  }
  // 通期の着地（右端の上にA・B）
  if (fcFrom < M) {
    p.push(`<text x="${f(cx(M - 1))}" y="${f(Y1 + 2.4)}" font-size="12.5" font-weight="700" fill="${CY}" text-anchor="middle">A</text>`)
    p.push(`<text x="${f(cx(M - 1))}" y="${f(Y1 + 15.7)}" font-size="12.5" font-weight="700" fill="${GRAY}" text-anchor="middle">B</text>`)
  }
  p.push('</svg>')
  return p.join('\n')
}

// ============================================================================
// 日次の現預金残高（モック P5）
// ============================================================================
/**
 * 折れ線＝日々の残高。必要最低残高より下は「危険水域」として帯を敷く。
 * 破線とラベルは塗り（polygon）より後に描く（先に描くと塗りに隠れて見えなくなる）。
 */
export function dailyCashChart(ctx: ReportV2Context): string {
  const V = 'viewBox="0 0 1180 215" style="width:100%; height:42mm"'
  const u = ctx.unit
  const d = ctx.daily
  const rows = d.rows || []
  if (!rows.length) return `<svg ${V}></svg>`
  const X0 = 62, X1 = 1164, Y0 = 185, Y1 = 22
  const days = Math.max(1, d.daysInMonth || rows.length)
  const px = (day: number): number => X0 + ((clamp(day, 1, days) - 1) / Math.max(1, days - 1)) * (X1 - X0)

  const bals = rows.map((r) => fin(r.balance))
  const sc = niceRange(Math.min(0, ...bals, fin(d.minRequired)), Math.max(0, ...bals, fin(d.minRequired)), 7)
  const py = (v: number): number => Y0 - ((clamp(v, sc.lo, sc.hi) - sc.lo) / (sc.hi - sc.lo)) * (Y0 - Y1)

  const p: string[] = [`<svg ${V}>`]
  // 目盛
  for (let k = 0; k <= sc.n; k++) {
    const v = sc.lo + sc.step * k
    const y = py(v)
    p.push(`<line x1="${f(X0)}" y1="${f(y)}" x2="${f(X1)}" y2="${f(y)}" stroke="${INK18}" stroke-width="1"/>`)
    p.push(`<text x="56" y="${f(y + 4)}" font-size="13" fill="${INK70}" text-anchor="end">${esc(amt(v, u))}</text>`)
  }
  // 残高の折れ線と、その下の塗り
  const pts = rows.map((r) => `${f(px(r.day))},${f(py(fin(r.balance)))}`)
  p.push(`<polygon points="${f(X0)},${f(Y0)} ${pts.join(' ')} ${f(X1)},${f(Y0)}" fill="${CY15}"/>`)
  // 危険水域（必要最低残高より下の帯）
  const yReq = py(fin(d.minRequired))
  if (yReq < Y0 - 0.5) {
    p.push(`<rect x="${f(X0)}" y="${f(yReq)}" width="${f(X1 - X0)}" height="${f(Y0 - yReq)}" fill="#000" opacity="0.09"/>`)
  }
  p.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="${CY}" stroke-width="3"/>`)

  // 大きな入出金があった日（上位8日に黒丸・そのうち上位4日に摘要）
  const big = rows
    .map((r, i) => ({ r, i, size: fin(r.income) + fin(r.outgo) }))
    .filter((x) => x.size > 0)
    .sort((a, b) => b.size - a.size)
  const dots = big.slice(0, 8)
  for (const x of dots) {
    p.push(`<circle cx="${f(px(x.r.day))}" cy="${f(py(fin(x.r.balance)))}" r="3.5" fill="#000"/>`)
  }
  const placed: number[] = []
  const labelRows = dots.filter((x) => x.r.note && x.r.day !== d.minDay).slice(0, 4)
  const noteTexts: string[] = []
  for (const x of labelRows) {
    const cx = px(x.r.day)
    if (placed.some((q) => Math.abs(q - cx) < 90)) continue
    placed.push(cx)
    const cy = py(fin(x.r.balance))
    const ty = cy - 12 < Y1 + 8 ? cy + 18 : cy - 12
    noteTexts.push(`<text x="${f(cx)}" y="${f(ty)}" font-size="13" fill="#000" text-anchor="middle">${esc(shortNote(x.r.note))}</text>`)
  }

  // 必要最低残高（塗りより後）
  p.push(`<line x1="${f(X0)}" y1="${f(yReq)}" x2="${f(X1)}" y2="${f(yReq)}" stroke="#000" stroke-width="1.6" stroke-dasharray="7 4"/>`)
  const reqNote = d.minRequiredNote === '月商の1/3' ? '既定＝月商の1/3' : d.minRequiredNote
  const reqY = yReq - 6 < Y1 + 10 ? yReq + 16 : yReq - 6
  p.push(`<text x="${f(X0 + 6)}" y="${f(reqY)}" font-size="13" fill="#000" font-weight="700">必要最低残高 ${esc(amt(fin(d.minRequired), u))}（${esc(reqNote)}）</text>`)

  // 月内の最低残高の日
  const bx = px(d.minDay)
  const by = py(fin(d.minBalance))
  const ly2 = Math.max(by - 66.8, Y1 + 34)
  const toLeft = bx > 300
  p.push(`<circle cx="${f(bx)}" cy="${f(by)}" r="6" fill="${CY}"/>`)
  p.push(`<line x1="${f(bx)}" y1="${f(by - 6.8)}" x2="${f(bx)}" y2="${f(ly2)}" stroke="${CY}" stroke-width="1"/>`)
  const tx = toLeft ? bx - 6 : bx + 6
  const anc = toLeft ? 'end' : 'start'
  p.push(`<text x="${f(tx)}" y="${f(ly2 - 21)}" font-size="15" font-weight="700" fill="${CY}" text-anchor="${anc}">${d.month}/${d.minDay} が今月の底</text>`)
  p.push(`<text x="${f(tx)}" y="${f(ly2 - 5)}" font-size="15" font-weight="700" fill="${CY}" text-anchor="${anc}">${esc(amt(fin(d.minBalance), u))} ${esc(unitWord(u))}</text>`)
  p.push(...noteTexts)

  // 横軸
  p.push(`<line x1="${f(X0)}" y1="${f(Y0)}" x2="${f(X1)}" y2="${f(Y0)}" stroke="#000" stroke-width="1.4"/>`)
  const ticks = [1, 5, 10, 15, 20, 25].filter((t) => t <= days - 3)
  ticks.push(days)
  for (const t of ticks) {
    p.push(`<text x="${f(px(t))}" y="203" font-size="13" fill="#000" text-anchor="middle">${t}日</text>`)
  }
  p.push('</svg>')
  return p.join('\n')
}

// ============================================================================
// 借入金残高と毎月の返済（モック P7 左）
// ============================================================================
/**
 * 棒＝各月末の有利子負債残高（当月＝シアン／前月＝黒／それ以前＝グレー）。
 * 折れ線＝毎月の返済原資。残高と返済原資は桁が2つほど違うので、
 * 折れ線は下側の帯に別スケールで置く（同じ軸に載せると線が潰れて読めない）。
 * viewBox の左を −16 にしているのは、目盛ラベルが枠から切れないようにするため。
 */
export function loanChart(ctx: ReportV2Context): string {
  const V = 'viewBox="-16 0 716 210" style="width:100%; height:53mm; margin-top:1mm"'
  const u = ctx.unit
  const months = ctx.loan.months || []
  const m = months.length
  if (!m) return `<svg ${V}></svg>`
  const X0 = 40, X1 = 690, YB = 175       // YB＝棒の足元（目盛の下端より少し下）
  const YT = 20, YL = 160                 // 目盛の上端・下端
  const slot = (X1 - X0) / m
  const bw = Math.min(52, slot * 0.59)
  const cx = (i: number): number => X0 + (i + 0.5) * slot

  const bals = months.map((x) => fin(x.balance))
  const sc = fixedScale(Math.min(...bals), Math.max(...bals), 4)
  const py = (v: number): number => YL - ((clamp(v, sc.lo, sc.hi) - sc.lo) / Math.max(1, sc.hi - sc.lo)) * (YL - YT)

  const p: string[] = [`<svg ${V}>`]
  p.push(`<g stroke="${INK18}" stroke-width="1">`)
  for (let k = 0; k <= sc.n; k++) {
    const y = YL - ((YL - YT) / sc.n) * k
    p.push(`<line x1="${f(X0)}" y1="${f(y)}" x2="${f(X1)}" y2="${f(y)}"/>`)
  }
  p.push('</g>')
  p.push(`<line x1="${f(X0)}" y1="${f(YB)}" x2="${f(X1)}" y2="${f(YB)}" stroke="#000" stroke-width="1.4"/>`)
  p.push(`<g font-size="11" fill="${INK70}" text-anchor="end">`)
  for (let k = 0; k <= sc.n; k++) {
    const y = YL - ((YL - YT) / sc.n) * k
    p.push(`<text x="${f(X0 - 4)}" y="${f(y + 3)}">${esc(amt(sc.lo + sc.step * k, u))}</text>`)
  }
  p.push('</g>')

  // 棒（残高）
  const prevIdx = m - 2
  for (let i = 0; i < m; i++) {
    const y = py(fin(months[i].balance))
    const col = months[i].current ? CY : i === prevIdx ? '#000' : INK45
    p.push(`<rect x="${f(cx(i) - bw / 2)}" y="${f(y)}" width="${f(bw)}" height="${f(Math.max(0.6, YB - y))}" fill="${col}"/>`)
  }
  // 金額ラベル（棒の上）
  const vf = m > 9 ? 9 : 10.5
  for (let i = 0; i < m; i++) {
    const y = py(fin(months[i].balance))
    const ty = y - 4 < 12 ? y + 12 : y - 4
    const cur = months[i].current
    p.push(`<text x="${f(cx(i))}" y="${f(ty)}" font-size="${vf}" fill="${cur ? CY : '#000'}"${cur ? ' font-weight="700"' : ''} text-anchor="middle">${esc(amt(fin(months[i].balance), u))}</text>`)
  }
  // 月ラベル
  for (let i = 0; i < m; i++) {
    const cur = months[i].current
    p.push(`<text x="${f(cx(i))}" y="188" font-size="11" fill="${cur ? CY : '#000'}"${cur ? ' font-weight="700"' : ''} text-anchor="middle">${esc(months[i].label)}</text>`)
  }

  // 返済原資（別スケール。下の帯 y=120〜170 に収める）
  const srcs = months.map((x) => x.repaySource).filter((v): v is number => v != null && isFinite(v))
  if (srcs.length) {
    const hi = Math.max(Math.max(...srcs) * 1.15, 1)
    const lo = Math.min(Math.min(...srcs) * 1.15, 0)
    const ry = (v: number): number => 170 - ((clamp(v, lo, hi) - lo) / Math.max(1, hi - lo)) * 50
    const pts: { x: number; y: number; i: number }[] = []
    months.forEach((x, i) => {
      if (x.repaySource != null && isFinite(x.repaySource)) pts.push({ x: cx(i), y: ry(x.repaySource), i })
    })
    if (pts.length >= 2) {
      p.push(`<polyline points="${pts.map((q) => `${f(q.x)},${f(q.y)}`).join(' ')}" fill="none" stroke="#000" stroke-width="2" stroke-dasharray="6 3"/>`)
    }
    p.push('<g fill="#000">')
    pts.forEach((q, k) => {
      const last = k === pts.length - 1
      if (q.i % 2 === 0 || last) p.push(`<circle cx="${f(q.x)}" cy="${f(q.y)}" r="${last ? '3.5' : '3'}"/>`)
    })
    p.push('</g>')
    const last = pts[pts.length - 1]
    p.push(`<text x="${f(Math.min(last.x + 15, X1 - 46))}" y="${f(last.y - 6)}" font-size="11" fill="#000">返済原資</text>`)
  }
  p.push('</svg>')
  return p.join('\n')
}

// ============================================================================
// 労働分配率の推移（モック P8 右）
// ============================================================================
/**
 * 折れ線＝月次の労働分配率（累計ベース）。一般的な目安 45〜55% の帯を敷いて、
 * 「いま帯のどこにいるか」を一目で分かるようにする。
 * 軸は実データの範囲に合わせるが、目安帯が必ず入るよう 45・55 を含めて決める。
 */
export function laborChart(ctx: ReportV2Context): string {
  const V = 'viewBox="0 0 700 200" style="width:100%; height:50mm; margin-top:1mm"'
  const monthly = (ctx.labor.monthly || []).filter((x) => x.share != null && isFinite(x.share as number))
  const m = monthly.length
  if (!m) return `<svg ${V}></svg>`
  const X0 = 46, X1 = 690, YT = 30, YL = 135, YB = 165
  const shares = monthly.map((x) => fin(x.share))
  // 目安帯（45〜55%）を必ず含め、上下に1割の余白を取ってからキリのよい4段階にする
  const lo0 = Math.min(...shares, 45)
  const hi0 = Math.max(...shares, 55)
  const pad = Math.max((hi0 - lo0) * 0.1, 0.5)
  let step = niceStep((hi0 - lo0 + pad * 2) / 3)
  let lo = Math.floor((lo0 - pad) / step) * step
  let guard = 0
  while (lo + step * 3 < hi0 + pad && guard++ < 12) {
    step = stepUp(step)
    lo = Math.floor((lo0 - pad) / step) * step
  }
  const hi = lo + step * 3
  const py = (v: number): number => YT + ((hi - clamp(v, lo, hi)) / Math.max(0.001, hi - lo)) * (YL - YT)
  const cx = (i: number): number => X0 + (i + 0.5) * ((X1 - X0) / m)

  const p: string[] = [`<svg ${V}>`]
  p.push(`<g stroke="${INK18}" stroke-width="1">`)
  for (let k = 0; k <= 3; k++) {
    const y = YT + ((YL - YT) / 3) * k
    p.push(`<line x1="${f(X0)}" y1="${f(y)}" x2="${f(X1)}" y2="${f(y)}"/>`)
  }
  p.push('</g>')
  p.push(`<line x1="${f(X0)}" y1="${f(YB)}" x2="${f(X1)}" y2="${f(YB)}" stroke="#000" stroke-width="1.4"/>`)
  p.push(`<g font-size="11" fill="${INK70}" text-anchor="end">`)
  for (let k = 0; k <= 3; k++) {
    const v = hi - step * k
    p.push(`<text x="${f(X0 - 4)}" y="${f(YT + ((YL - YT) / 3) * k + 3)}">${esc(pct(v, 0))}</text>`)
  }
  p.push('</g>')
  // 目安帯 45〜55%
  const gy1 = py(55), gy2 = py(45)
  p.push(`<rect x="${f(X0)}" y="${f(gy1)}" width="${f(X1 - X0)}" height="${f(Math.max(0, gy2 - gy1))}" fill="${INK08}"/>`)
  p.push(`<text x="${f(X0 + 10)}" y="${f(gy1 + 14)}" font-size="11" fill="${INK45}">一般的な目安 45〜55%</text>`)
  // 折れ線
  const pts = monthly.map((x, i) => `${f(cx(i))},${f(py(fin(x.share)))}`)
  if (pts.length >= 2) p.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="#000" stroke-width="2.4"/>`)
  p.push('<g fill="#000">')
  for (let i = 0; i < m - 1; i++) p.push(`<circle cx="${f(cx(i))}" cy="${f(py(fin(monthly[i].share)))}" r="3"/>`)
  p.push('</g>')
  // 最終月（当月）だけシアンの大きい丸と数値
  const lx = cx(m - 1), ly = py(fin(monthly[m - 1].share))
  p.push(`<circle cx="${f(lx)}" cy="${f(ly)}" r="5" fill="${CY}"/>`)
  p.push(`<text x="${f(Math.min(lx, X1 - 24))}" y="${f(Math.max(ly - 11, YT - 16))}" font-size="12.5" font-weight="700" fill="${CY}" text-anchor="middle">${esc(pct(fin(monthly[m - 1].share)))}</text>`)
  // 月ラベル
  p.push(`<g font-size="11" text-anchor="middle">`)
  for (let i = 0; i < m; i++) {
    const last = i === m - 1
    p.push(`<text x="${f(cx(i))}" y="180" fill="${last ? CY : '#000'}"${last ? ' font-weight="700"' : ''}>${esc(monthly[i].label)}</text>`)
  }
  p.push('</g>')
  p.push('</svg>')
  return p.join('\n')
}

// ============================================================================
// 当事業年度の月次損益推移（P2 上段）
// ============================================================================
/**
 * 棒＝売上高（左軸）、線＝売上総利益（グレー破線）と営業利益（黒実線）。いずれも左軸で、
 * 「売上のうちどれだけが粗利で、そこからどれだけ営業利益に残ったか」の**幅**を読ませる図。
 * 利益を右軸にすると幅が比較できなくなるので、あえて同じ軸に載せている。
 * 営業赤字の月は棒の下に印を出して、表を見なくても分かるようにする。
 */
export function monthlyPlChart(ctx: ReportV2Context): string {
  const V = 'viewBox="0 0 1480 200" style="width:100%; height:21mm"'
  const u = ctx.unit
  const m = ctx.monthlyPl
  const labels = ctx.monthLabels
  const M = labels.length
  if (!M) return `<svg ${V}></svg>`
  const X0 = 100, X1 = 1424, Y0 = 172, Y1 = 14
  const idx = clamp(m.reportIdx, 0, M - 1)
  const band = (X1 - X0) / M
  const cx = (i: number): number => X0 + (i + 0.5) * band
  const BW = Math.min(58, band * 0.56)

  const vals: number[] = []
  for (let i = 0; i <= idx; i++) {
    for (const v of [m.salesSeries[i], m.grossSeries[i], m.opSeries[i]]) {
      if (v != null && isFinite(v)) vals.push(v)
    }
  }
  if (!vals.length) return `<svg ${V}></svg>`
  const S = niceRange(Math.min(0, ...vals), Math.max(0, ...vals), 4)
  const y = (v: number): number => Y0 - ((clamp(v, S.lo, S.hi) - S.lo) / (S.hi - S.lo)) * (Y0 - Y1)
  const yZero = y(0)

  const p: string[] = [`<svg ${V}>`]

  // 未入力の月は薄く敷いて「まだ来ていない月」だと分かるようにする
  if (idx + 1 < M) {
    const bx = X0 + (idx + 1) * band
    p.push(`<rect x="${f(bx)}" y="${f(Y1)}" width="${f(X1 - bx)}" height="${f(Y0 - Y1)}" fill="${FCBG}"/>`)
    p.push(`<text x="${f((bx + X1) / 2)}" y="28" font-size="12.5" fill="${INK45}" text-anchor="middle">未入力</text>`)
  }
  for (let k = 0; k <= S.n; k++) {
    const v = S.lo + S.step * k
    p.push(`<line x1="${f(X0)}" y1="${f(y(v))}" x2="${f(X1)}" y2="${f(y(v))}" stroke="${GRID}" stroke-width="1"/>`)
    p.push(`<text x="92" y="${f(y(v) + 4)}" font-size="11" fill="${INK45}" text-anchor="end">${esc(amt(v, u))}</text>`)
  }
  // 棒＝売上高
  for (let i = 0; i <= idx; i++) {
    const v = m.salesSeries[i]
    if (v == null) continue
    const top = Math.min(y(v), yZero)
    const h = Math.abs(y(v) - yZero)
    p.push(`<rect x="${f(cx(i) - BW / 2)}" y="${f(top)}" width="${f(BW)}" height="${f(Math.max(0.6, h))}" fill="${CY}"/>`)
  }
  // 0の線と軸
  p.push(`<line x1="${f(X0)}" y1="${f(yZero)}" x2="${f(X1)}" y2="${f(yZero)}" stroke="#000" stroke-width="1.4"/>`)

  // 線＝売上総利益（グレー破線）／営業利益（黒実線）
  const poly = (s: (number | null)[], stroke: string, w: number, dash?: string) => {
    const pts: string[] = []
    for (let i = 0; i <= idx; i++) { const v = s[i]; if (v != null) pts.push(`${f(cx(i))},${f(y(v))}`) }
    if (pts.length < 2) return
    p.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="${stroke}" stroke-width="${w}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`)
  }
  poly(m.grossSeries, GRAY, 2.2, '7 4')
  poly(m.opSeries, '#000', 2.6)
  for (let i = 0; i <= idx; i++) {
    const v = m.opSeries[i]
    if (v != null) p.push(`<circle cx="${f(cx(i))}" cy="${f(y(v))}" r="3.2" fill="#000"/>`)
  }
  // 営業赤字の月は月名の上に印を出す
  for (const i of m.lossMonths) {
    p.push(`<text x="${f(cx(i))}" y="${f(Y0 + 14)}" font-size="11" font-weight="700" fill="${GRAY}" text-anchor="middle">▲赤字</text>`)
  }
  // 月名（報告月だけシアンで太く）
  for (let i = 0; i < M; i++) {
    const on = i === idx
    const dy = m.lossMonths.includes(i) ? 27 : 16
    p.push(`<text x="${f(cx(i))}" y="${f(Y0 + dy)}" font-size="12.5" fill="${on ? CY : '#000'}"${on ? ' font-weight="700"' : ''} text-anchor="middle">${esc(labels[i])}</text>`)
  }
  p.push('</svg>')
  return p.join('')
}
