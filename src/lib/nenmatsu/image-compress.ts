// ブラウザ側で画像を圧縮（JPEG）。
// 書類の判読性のため解像度は高め（長辺〜3300px≒控除証明書で300dpi以上）に保ちつつ、
// JPEGで最小化し、10MBを超える場合は品質→寸法の順に自動で落として10MB以下に収める。

const MAX_BYTES = 10 * 1024 * 1024 // 10MB

export async function compressImage(file: File, maxLong = 3300, quality = 0.85): Promise<Blob> {
  const bitmap = await loadBitmap(file)
  const ow = bitmap.width
  const oh = bitmap.height
  // 元画像より拡大はしない（拡大しても解像度は上がらないため）
  const scale = Math.min(1, maxLong / Math.max(ow, oh))
  let w = Math.max(1, Math.round(ow * scale))
  let h = Math.max(1, Math.round(oh * scale))
  let q = quality

  let blob = await toJpeg(bitmap, w, h, q)
  let guard = 0
  while (blob.size > MAX_BYTES && guard++ < 8) {
    if (q > 0.5) {
      q = Math.max(0.5, q - 0.1)
    } else {
      w = Math.max(1, Math.round(w * 0.85))
      h = Math.max(1, Math.round(h * 0.85))
    }
    blob = await toJpeg(bitmap, w, h, q)
  }

  if ('close' in bitmap && typeof (bitmap as ImageBitmap).close === 'function') {
    ;(bitmap as ImageBitmap).close()
  }
  return blob
}

async function toJpeg(
  src: ImageBitmap | HTMLImageElement,
  w: number,
  h: number,
  q: number,
): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas未対応')
  ctx.drawImage(src as CanvasImageSource, 0, 0, w, h)
  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('変換失敗'))), 'image/jpeg', q),
  )
}

async function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file)
    } catch {
      /* fallthrough */
    }
  }
  return await new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('画像の読み込みに失敗'))
    }
    img.src = url
  })
}
