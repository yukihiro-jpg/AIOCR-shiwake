// 申告書チェック: pdfjs-distでPDFを座標付き行データへ変換（ブラウザ内・API不使用）
import type { Tok, Line, Page } from './types'

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

interface RawTextItem {
  str: string
  transform: number[]
}

// 複数PDFを読み、通しページ番号で座標付き行データに変換する。
// テキスト層が無い（スキャン画像の）ページは lines が空になる。
export async function extractPdfPages(
  files: File[],
  onProgress?: (done: number, total: number) => void,
): Promise<{ pages: Page[]; noTextPages: number[] }> {
  const pdfjsLib = await getPdfjsLib()
  const pages: Page[] = []
  const noTextPages: number[] = []
  let pageNo = 0
  let totalPages = 0
  const docs: { doc: any; name: string }[] = []
  for (const f of files) {
    const buf = await f.arrayBuffer()
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf), ...PDF_DOC_OPTIONS })
      .promise
    docs.push({ doc, name: f.name })
    totalPages += doc.numPages
  }
  for (const { doc, name } of docs) {
    for (let i = 1; i <= doc.numPages; i++) {
      pageNo++
      const page = await doc.getPage(i)
      const viewport = page.getViewport({ scale: 1 })
      const tc = await page.getTextContent()
      const toks: Tok[] = (tc.items as RawTextItem[])
        .filter((it) => it.str && it.str.trim())
        .map((it) => ({
          s: it.str,
          x: Math.round(it.transform[4] * 10) / 10,
          y: Math.round((viewport.height - it.transform[5]) * 10) / 10,
        }))
      toks.sort((a, b) => a.y - b.y || a.x - b.x)
      const lines: Line[] = []
      for (const t of toks) {
        const last = lines[lines.length - 1]
        if (last && Math.abs(last.y - t.y) <= 2.5) last.toks.push(t)
        else lines.push({ y: t.y, toks: [t] })
      }
      lines.forEach((l) => l.toks.sort((a, b) => a.x - b.x))
      if (!toks.length) noTextPages.push(pageNo)
      pages.push({ num: pageNo, fileName: name, lines })
      onProgress?.(pageNo, totalPages)
    }
  }
  return { pages, noTextPages }
}
