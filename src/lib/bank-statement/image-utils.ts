// 画像データURLの回転ユーティリティ。
// スキャン時に横向き・上下逆になっている書類画像を正位置に直して表示するために使う。

/** dataURL の画像を時計回りに deg 度（90/180/270）回転した dataURL を返す。0なら元のまま */
export function rotateImageDataUrl(dataUrl: string, clockwiseDeg: number): Promise<string> {
  const deg = ((Math.round(clockwiseDeg / 90) * 90) % 360 + 360) % 360
  if (!deg) return Promise.resolve(dataUrl)
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        const swap = deg === 90 || deg === 270
        canvas.width = swap ? img.height : img.width
        canvas.height = swap ? img.width : img.height
        const ctx = canvas.getContext('2d')
        if (!ctx) { resolve(dataUrl); return }
        ctx.translate(canvas.width / 2, canvas.height / 2)
        ctx.rotate((deg * Math.PI) / 180)
        ctx.drawImage(img, -img.width / 2, -img.height / 2)
        resolve(canvas.toDataURL('image/jpeg', 0.92))
      } catch {
        resolve(dataUrl) // 回転に失敗しても元画像で継続
      }
    }
    img.onerror = () => resolve(dataUrl)
    img.src = dataUrl
  })
}
