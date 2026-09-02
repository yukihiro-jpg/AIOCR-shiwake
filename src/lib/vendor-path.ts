// 自前配信しているライブラリ（public/vendor/、tools/copy-vendor.mjs が生成）のURL。
// 以前は cdnjs / jsdelivr から読んでいたが、第三者CDNの改ざんがそのままアプリ内の
// コード実行につながる（合言葉・APIキー・全データが流出する）ため、
// npm で版を固定した実体を GitHub Pages から配信する。
export function vendorUrl(path: string): string {
  const base = process.env.NEXT_PUBLIC_BASE_PATH || ''
  return `${base}/vendor/${path.replace(/^\/+/, '')}`
}

/** pdf.js の getDocument に渡す共通オプション（日本語CIDフォント用の CMap・標準フォント） */
export function pdfjsDocOptions() {
  return {
    cMapUrl: vendorUrl('pdfjs/cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: vendorUrl('pdfjs/standard_fonts/'),
  }
}

/** pdf.js のワーカー（本体と同じ legacy ビルド） */
export function pdfjsWorkerUrl(): string {
  return vendorUrl('pdfjs/pdf.worker.min.js')
}

/** tesseract.js の createWorker に渡す自前配信の場所（ワーカー・WASMコア） */
export function tesseractPaths() {
  return {
    workerPath: vendorUrl('tesseract/worker.min.js'),
    corePath: vendorUrl('tesseract/core'),
  }
}
