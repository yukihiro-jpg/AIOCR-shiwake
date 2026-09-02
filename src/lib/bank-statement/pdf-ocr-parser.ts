import { createWorker } from 'tesseract.js'
import { tesseractPaths } from '@/lib/vendor-path'
import type { RawTableRow } from './types'

interface OcrPageResult {
  rows: RawTableRow[]
  pageWidth: number
  pageHeight: number
}

export async function parsePdfWithOcr(
  imageDataUrls: string[],
  onProgress?: (page: number, total: number, status: string) => void,
): Promise<OcrPageResult[]> {
  const worker = await createWorker('jpn', undefined, {
    ...tesseractPaths(),
    logger: (m: { status: string; progress: number }) => {
      if (onProgress && m.status === 'recognizing text') {
        // progress callback handled per page below
      }
    },
  })

  const results: OcrPageResult[] = []

  for (let i = 0; i < imageDataUrls.length; i++) {
    onProgress?.(i + 1, imageDataUrls.length, `ページ ${i + 1} をOCR処理中...`)

    const { data } = await worker.recognize(imageDataUrls[i])

    const rows: RawTableRow[] = []

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ocrData = data as any
    const lines = ocrData.lines || []
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx]
      const text = (line.text || '').trim()
      if (!text) continue

      const cells = splitLineIntoCells(text)

      const bbox = line.bbox
      rows.push({
        cells,
        rowIndex: lineIdx,
        boundingBox: bbox
          ? {
              x: bbox.x0,
              y: bbox.y0,
              width: bbox.x1 - bbox.x0,
              height: bbox.y1 - bbox.y0,
            }
          : undefined,
      })
    }

    // 画像のサイズを取得
    const img = await loadImage(imageDataUrls[i])

    results.push({
      rows,
      pageWidth: img.width,
      pageHeight: img.height,
    })
  }

  await worker.terminate()
  return results
}

function splitLineIntoCells(text: string): string[] {
  // 大きなスペース区切りでセルに分割
  // 日本語の通帳では全角スペースやタブも使われる
  return text
    .split(/\s{2,}|\t/)
    .map((s) => s.trim())
    .filter((s) => s)
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = dataUrl
  })
}
