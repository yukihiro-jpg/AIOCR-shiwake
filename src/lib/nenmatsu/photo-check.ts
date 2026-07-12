// 撮影画像のOCR適性チェック（ブラウザ内・API不使用）。
// JDL/MJS等の年調システムのOCR取込で失敗しやすい要因（低解像度・暗さ・白飛び・
// 低コントラスト・ピンボケ）を撮影直後に検出し、撮り直しを促す。
// 判定は保守的な「可能性の警告」とし、提出はブロックしない（誤検知で提出を止めないため）。

export interface PhotoCheckResult {
  ok: boolean
  issues: string[] // 表示用の警告文（空なら問題なし）
}

/** 解析用に縮小したグレースケール画素を取得 */
async function grayPixels(file: File, target = 400): Promise<{ g: Float32Array; w: number; h: number; ow: number; oh: number } | null> {
  try {
    const bmp = await createImageBitmap(file)
    const ow = bmp.width
    const oh = bmp.height
    const scale = Math.min(1, target / Math.max(ow, oh))
    const w = Math.max(1, Math.round(ow * scale))
    const h = Math.max(1, Math.round(oh * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    ctx.drawImage(bmp, 0, 0, w, h)
    bmp.close()
    const data = ctx.getImageData(0, 0, w, h).data
    const g = new Float32Array(w * h)
    for (let i = 0; i < w * h; i++) {
      g[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]
    }
    return { g, w, h, ow, oh }
  } catch {
    return null
  }
}

export async function checkPhotoQuality(file: File): Promise<PhotoCheckResult> {
  const px = await grayPixels(file)
  if (!px) return { ok: true, issues: [] } // 解析できない環境では警告しない
  const { g, w, h, ow, oh } = px
  const issues: string[] = []

  // 1) 解像度: 長辺が小さいとOCRで文字がつぶれる（スクショ・縮小転送画像に多い）
  if (Math.max(ow, oh) < 1200) {
    issues.push('解像度が低めです（スクリーンショットやアプリで縮小された画像の可能性）。カメラで直接撮影してください')
  }

  // 2) 明るさ・白飛び・コントラスト
  let sum = 0
  for (let i = 0; i < g.length; i++) sum += g[i]
  const mean = sum / g.length
  let varSum = 0
  let white = 0
  for (let i = 0; i < g.length; i++) {
    const d = g[i] - mean
    varSum += d * d
    if (g[i] > 250) white++
  }
  const std = Math.sqrt(varSum / g.length)
  if (mean < 70) issues.push('暗すぎる可能性があります。明るい場所で撮影してください')
  if (white / g.length > 0.5) issues.push('光の反射・白飛びの可能性があります。照明が写り込まない角度で撮影してください')
  if (std < 22) issues.push('文字と背景の差が小さい（ぼんやりしている）可能性があります')

  // 3) ピンボケ: ラプラシアンの分散（縮小画像で小さいほどボケ）
  let lapVar = 0
  let n = 0
  let lapMean = 0
  const lap = new Float32Array((w - 2) * (h - 2))
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const v = 4 * g[y * w + x] - g[y * w + x - 1] - g[y * w + x + 1] - g[(y - 1) * w + x] - g[(y + 1) * w + x]
      lap[n++] = v
      lapMean += v
    }
  }
  if (n > 0) {
    lapMean /= n
    for (let i = 0; i < n; i++) {
      const d = lap[i] - lapMean
      lapVar += d * d
    }
    lapVar /= n
    if (lapVar < 60) issues.push('ピントが合っていない（ぼやけている）可能性があります。書類にピントを合わせて撮り直してください')
  }

  return { ok: issues.length === 0, issues }
}
