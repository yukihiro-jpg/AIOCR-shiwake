// 文字コード対応表（ToUnicode）を持たないPDFの日本語を、正しい文字に戻す。
//
// アメリカン・エキスプレスの「ご利用代金明細書」などは、日本語フォントに ToUnicode が無く、
// 代わりに /Encoding /Differences のグリフ名が「CTIU + Adobe-Japan1のCIDを16進4桁」で
// 書かれている（例: /CTIU0E8A ＝ CID 3722 ＝「本」）。pdf.js はこの名前を知らないので
// 文字コードをそのまま返してしまい、日本語がすべて化ける。
//
// CIDが分かれば正しい文字は一意に決まるので、グリフ名を pdf.js が理解できる
// 「uniXXXXX」形式へ書き換えたPDFを作って読み直す。OCRも通信も要らない。
// 文字数を合わせる必要はない（PDFを作り直すため）。

/** グリフ名がCID表記になっているものの見分け方 */
const CID_GLYPH_PATTERNS: { re: RegExp; radix: number }[] = [
  { re: /^CTIU([0-9A-Fa-f]{4})$/, radix: 16 },
]

/**
 * 異体字セレクタ（茨󠄀 のように字形を指定する見えない文字）を落として基底の文字だけにする。
 * 仕訳の摘要には字形の違いまでは要らないので、読める文字を優先する。
 */
function stripVariationSelectors(s: string | null): string | null {
  if (!s) return s
  return s.replace(/[\uFE00-\uFE0F]|\uDB40[\uDD00-\uDDEF]/g, '')
}

function cidOfGlyphName(name: string): number | null {
  for (const p of CID_GLYPH_PATTERNS) {
    const m = p.re.exec(name)
    if (m) return parseInt(m[1], p.radix)
  }
  return null
}

/**
 * PDFのバイト列を受け取り、CID表記のグリフ名を Unicode 表記へ直したバイト列を返す。
 * 直すところが無い（＝普通のPDF）なら null。
 */
export async function repairCidGlyphNames(bytes: Uint8Array): Promise<Uint8Array | null> {
  try {
    const [{ PDFDocument, PDFName, PDFArray, PDFDict }, { cidToUnicode }] = await Promise.all([
      import('pdf-lib'),
      import('./adobe-japan1-ucs2'),
    ])
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })
    let fixed = 0
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFDict)) continue
      const enc = doc.context.lookup(obj.get(PDFName.of('Encoding')))
      if (!(enc instanceof PDFDict)) continue
      const diffs = doc.context.lookup(enc.get(PDFName.of('Differences')))
      if (!(diffs instanceof PDFArray)) continue
      for (let i = 0; i < diffs.size(); i++) {
        const el = diffs.get(i)
        if (!(el instanceof PDFName)) continue
        const cid = cidOfGlyphName(el.asString().slice(1)) // 先頭の "/" を外す
        if (cid == null) continue
        const ch = stripVariationSelectors(cidToUnicode(cid))
        // pdf.js が読めるのは1文字ぶんの uniXXXX 形式まで
        if (!ch || ch.length !== 1) continue
        // pdf.js が確実に読むのは uni + 16進4桁（BMP内）の形。1文字ならこれで足りる
        diffs.set(i, PDFName.of('uni' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')))
        fixed++
      }
    }
    if (!fixed) return null
    console.log(`PDFの文字化けを修復: ${fixed}文字ぶんのグリフ名をUnicodeへ変換`)
    return await doc.save({ useObjectStreams: false })
  } catch (e) {
    // 修復できなくても元のPDFはそのまま使える
    console.warn('PDFの文字化け修復に失敗しました（元のまま読みます）', e)
    return null
  }
}

/**
 * 抽出した文字列が化けているか。日本語の書類に本来出てこない
 * ラテン拡張文字（Ê É Ï ã ø …）がまとまって混ざっていたら化けている。
 */
export function textLooksMojibake(samples: string[]): boolean {
  let bad = 0, total = 0
  for (const s of samples) {
    for (const ch of s) {
      const c = ch.codePointAt(0)!
      if (c > 0x20) total++
      if ((c >= 0xc0 && c <= 0xff) || (c >= 0x100 && c <= 0x24f)) bad++
    }
  }
  if (total < 40) return false
  return bad >= 10 && bad / total > 0.05
}
