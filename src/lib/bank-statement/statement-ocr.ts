// 摘要（加盟店名）だけを端末内OCRで読み直す。API・通信費ゼロ。
//
// カード会社のPDFには日本語フォントに文字コード対応表（ToUnicode）が無く、
// テキスト層の日本語がすべて化けるものがある。日付と金額はテキスト層から
// 1円の誤りもなく取れるので、化けている「摘要の列」だけを画像にしてOCRする。
// 金額をOCRに頼らないぶん、画像まるごとのOCRより原理的に精度が高い。

import type { LayoutRow, StatementLayout } from './statement-layout-parser'
import { looksMojibake } from './statement-layout-parser'

async function getPdfjsLib() {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf')
  if (typeof window !== 'undefined' && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js`
  }
  return pdfjsLib
}

const PDF_DOC_OPTIONS = {
  cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/cmaps/',
  cMapPacked: true,
  standardFontDataUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/standard_fonts/',
}

// 300dpi 相当。これ以下だと日本語の細部（ー と 一 など）が潰れる
const SCALE = 300 / 72

interface OcrLine { yTop: number; yBottom: number; text: string }

// 日本語の学習データ。int版(_best_int)は約2MBで、標準版(約16MB)より
// 加盟店名の読み取りが良かったので優先する。取得できない場合は既定へ戻す。
const TESS_BEST_INT = 'https://tessdata.projectnaptha.com/4.0.0_best_int'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function createJpnWorker(createWorker: any): Promise<any> {
  try {
    return await createWorker('jpn', 1, { langPath: TESS_BEST_INT })
  } catch {
    return await createWorker('jpn')
  }
}

/**
 * 摘要列をOCRして rows[].descRaw を上書きする（化けている行だけ）。
 * 返り値は実際に書き換えた行数。
 */
export async function fillDescriptionsByOcr(
  file: File,
  rows: LayoutRow[],
  layout: StatementLayout,
  onProgress?: (done: number, total: number, phase?: 'prepare' | 'start') => void,
  /**
   * 「化けた文字列 → 読み取れた店名」の辞書。入出力兼用で、新しく読めたものを書き足す。
   * 化け方はフォントの対応表で決まるので、同じ店名は毎回まったく同じ文字列に化ける。
   * つまり一度読めた店名は二度とOCRしなくてよい（次回以降の明細でも使える）。
   */
  dict?: Record<string, string>,
): Promise<number> {
  if (typeof window === 'undefined') return 0

  // 行ごとに「化けた元の文字列」を控えておく（これが辞書のキーになる）
  const keys = rows.map((r) => (looksMojibake(r.descRaw) ? r.descRaw : ''))
  const needsOcr = rows.map((r, i) => keys[i] !== '' || !r.descRaw)
  let filled = 0

  // まず辞書で埋められるだけ埋める
  const applyDict = () => {
    if (!dict) return
    for (let i = 0; i < rows.length; i++) {
      if (!needsOcr[i] || !keys[i]) continue
      const hit = dict[keys[i]]
      if (hit) { rows[i].descRaw = hit; needsOcr[i] = false; filled++ }
    }
  }
  applyDict()

  const pagesLeft = () => Array.from(
    new Set(rows.map((_, i) => i).filter((i) => needsOcr[i]).map((i) => rows[i].pageIndex)),
  ).sort((a, b) => a - b)

  const targetPages = pagesLeft()
  if (!targetPages.length) return filled

  const { createWorker } = await import('tesseract.js')
  const pdfjsLib = await getPdfjsLib()
  const buf = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf), ...PDF_DOC_OPTIONS }).promise

  // 摘要列の切り出し範囲（pt）。左は摘要列の開始、右は金額列の手前
  const cropLeft = Math.max(0, layout.descX[0] - 4)
  const cropRight = Math.max(cropLeft + 40, layout.amountX[0] - 4)

  // ページ数ぶんの待ち時間になるので、複数ワーカーで並行してOCRする。
  // 1つ目を先に作ってから残りを作る（同時に作ると学習データを人数分ダウンロードしてしまう。
  // 1つ目が終わればブラウザにキャッシュされるので、2つ目以降は待たずに立ち上がる）
  onProgress?.(0, targetPages.length, 'prepare')
  const poolSize = Math.max(1, Math.min(3, targetPages.length))
  const first = await createJpnWorker(createWorker)
  const workers = [first, ...(poolSize > 1
    ? await Promise.all(Array.from({ length: poolSize - 1 }, () => createJpnWorker(createWorker)))
    : [])]
  onProgress?.(0, targetPages.length, 'start')

  // 画像化はメインスレッドなので直列。OCR（ワーカー側）だけを並行させる
  let nextPage = 0
  let done = 0
  let renderChain: Promise<void> = Promise.resolve()

  const renderCrop = async (pageIndex: number): Promise<HTMLCanvasElement | null> => {
    const page = await pdf.getPage(pageIndex + 1)
    const viewport = page.getViewport({ scale: SCALE })
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({ canvasContext: ctx, viewport }).promise
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    try { (page as any).cleanup?.() } catch { /* ignore */ }

    // 摘要列だけを切り出す
    const sx = Math.round(cropLeft * SCALE)
    const sw = Math.min(canvas.width - sx, Math.round((cropRight - cropLeft) * SCALE))
    if (sw <= 0) return null
    const crop = document.createElement('canvas')
    crop.width = sw
    crop.height = canvas.height
    const cctx = crop.getContext('2d')!
    cctx.fillStyle = '#fff'
    cctx.fillRect(0, 0, sw, canvas.height)
    cctx.drawImage(canvas, sx, 0, sw, canvas.height, 0, 0, sw, canvas.height)
    canvas.width = 0; canvas.height = 0 // 大きなページ画像はすぐ手放す
    return crop
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await Promise.all(workers.map(async (worker: any) => {
      for (;;) {
        const i = nextPage++
        if (i >= targetPages.length) return
        const pageIndex = targetPages[i]
        // 直前のページで辞書が育って、このページはもう読む必要が無くなったかもしれない
        if (!rows.some((r, ri) => r.pageIndex === pageIndex && needsOcr[ri])) {
          done++
          onProgress?.(done, targetPages.length)
          continue
        }
        // 画像化は1つずつ順番に（同時に走らせるとメモリを食うだけで速くならない）
        const step: Promise<HTMLCanvasElement | null> = renderChain.then(() => renderCrop(pageIndex))
        renderChain = step.then(() => { /* 次の画像化へ */ }, () => { /* 失敗しても続行 */ })
        const crop = await step
        if (!crop) { done++; onProgress?.(done, targetPages.length); continue }

        const { data } = await worker.recognize(crop, {}, { blocks: true, text: true })
        const lines = collectLines(data)
        for (let ri = 0; ri < rows.length; ri++) {
          if (rows[ri].pageIndex !== pageIndex || !needsOcr[ri]) continue
          const text = pickLineFor(lines, rows[ri])
          if (!text) continue
          rows[ri].descRaw = text
          needsOcr[ri] = false
          filled++
          // 同じ化け方をする行は他のページにもあるので、辞書に入れて一斉に埋める
          if (dict && keys[ri]) dict[keys[ri]] = text
        }
        applyDict()
        crop.width = 0; crop.height = 0
        done++
        onProgress?.(done, targetPages.length)
      }
    }))
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await Promise.all(workers.map((w: any) => w.terminate().catch(() => { /* ignore */ })))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    try { (pdf as any).destroy?.() } catch { /* ignore */ }
  }
  return filled
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function collectLines(data: any): OcrLine[] {
  const out: OcrLine[] = []
  // tesseract.js v5+ は data.lines を返さない。blocks→paragraphs→lines を辿る
  for (const b of data?.blocks || []) {
    for (const p of b?.paragraphs || []) {
      for (const l of p?.lines || []) {
        const text = String(l?.text || '').replace(/\s+/g, ' ').trim()
        if (!text || !l?.bbox) continue
        out.push({ yTop: l.bbox.y0 / SCALE, yBottom: l.bbox.y1 / SCALE, text })
      }
    }
  }
  return out
}

/** 取引行の縦位置に重なるOCR行を摘要にする */
function pickLineFor(lines: OcrLine[], row: LayoutRow): string {
  const top = row.yTop
  const bottom = row.yTop + (row.height || 12)
  const center = (top + bottom) / 2
  let best: OcrLine | null = null
  let bestD = Infinity
  for (const l of lines) {
    const lc = (l.yTop + l.yBottom) / 2
    const d = Math.abs(lc - center)
    // 行の高さの2倍まで許容（OCRの行box は行間を含んで上下にずれる）
    if (d > Math.max(10, (bottom - top) * 2)) continue
    if (d < bestD) { bestD = d; best = l }
  }
  if (!best) return ''
  // 行頭に残った日付・行末に残った金額を落として加盟店名だけにする
  const t = best.text
    .replace(/^\s*\d{1,2}\s*月\s*\d{1,2}\s*日\s*/, '')
    .replace(/[\d,]{3,}\s*(?:[(（][^)）]{0,3}[)）])?\s*$/, '')
    .trim()
  return squeezeJapaneseSpaces(t)
}

/**
 * OCRは日本語の文字と文字の間にスペースを入れてくる（「ホー ムセン ター 山 新」）。
 * 英単語の区切りは残したいので、両隣が英数字のスペースだけ残して他は詰める。
 */
export function squeezeJapaneseSpaces(s: string): string {
  // 後続文字は先読みで見る（消費すると「A B C」の2つ目のスペースを判定できなくなる）
  return s.replace(/(\S)[ 　]+(?=(\S))/g, (_m, a: string, b: string) =>
    /[A-Za-z0-9]/.test(a) && /[A-Za-z0-9]/.test(b) ? `${a} ` : a,
  ).trim()
}
