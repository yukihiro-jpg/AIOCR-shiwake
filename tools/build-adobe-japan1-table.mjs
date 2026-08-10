// Adobe-Japan1 の CID → Unicode 対応表を生成する。
//
// 一部のPDF（アメリカン・エキスプレスのご利用代金明細書など）は、日本語フォントに
// 文字コード対応表（ToUnicode）を持たず、代わりに /Differences のグリフ名を
// 「CTIU + CIDの16進4桁」で書いている。CIDが分かれば正しい文字に戻せるので、
// Adobe公式の Adobe-Japan1-UCS2 から対応表を作って同梱する。
//
// 使い方（生成し直すとき。ふだんは生成済みファイルをそのまま使う）:
//   node tools/build-adobe-japan1-table.mjs
//   → src/lib/bank-statement/adobe-japan1-ucs2.ts を書き出す
//
// 出典: https://github.com/adobe-type-tools/mapping-resources-pdf (BSD-3-Clause)

import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const SRC = 'https://raw.githubusercontent.com/adobe-type-tools/mapping-resources-pdf/master/pdf2unicode/Adobe-Japan1-UCS2'
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', 'bank-statement', 'adobe-japan1-ucs2.ts')

const res = await fetch(SRC)
if (!res.ok) throw new Error(`Adobe-Japan1-UCS2 を取得できません: ${res.status}`)
const txt = await res.text()

/** CID → UTF-16BE の16進文字列 */
const map = new Map()
for (const blk of txt.match(/beginbfchar[\s\S]*?endbfchar/g) || []) {
  for (const m of blk.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) map.set(parseInt(m[1], 16), m[2])
}
for (const blk of txt.match(/beginbfrange[\s\S]*?endbfrange/g) || []) {
  for (const m of blk.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
    const lo = parseInt(m[1], 16), hi = parseInt(m[2], 16), base = parseInt(m[3], 16)
    for (let i = lo; i <= hi; i++) map.set(i, (base + (i - lo)).toString(16).padStart(4, '0'))
  }
}

const maxCid = Math.max(...map.keys())
// 1文字で表せるCIDは1本の文字列（index = CID）に、複数コードユニットのものだけ別表に
const chars = new Array(maxCid + 1).fill('\u0000')
const multi = {}
for (const [cid, hex] of map) {
  if (hex.length === 4) chars[cid] = String.fromCharCode(parseInt(hex, 16))
  else {
    let s = ''
    for (let i = 0; i < hex.length; i += 4) s += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16))
    multi[cid] = s
  }
}

// 漢字はそのまま（UTF-8で置く）。壊れるおそれのある文字だけエスケープする
const esc = (s) => s.replace(/[\\'\u0000-\u001f\u007f\u2028\u2029\ud800-\udfff]/g, (c) =>
  c === '\\' ? '\\\\' : c === "'" ? "\\'" : '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))

const body = `// 自動生成ファイル（tools/build-adobe-japan1-table.mjs）。手で編集しないこと。
//
// Adobe-Japan1 の CID → Unicode 対応表。ToUnicode を持たないPDFのグリフ名
// （CTIU + CIDの16進）から正しい文字へ戻すために使う。
// 出典: adobe-type-tools/mapping-resources-pdf (Adobe-Japan1-UCS2, BSD-3-Clause)

/** index = CID。未定義のCIDは \\u0000 */
const TABLE = '${esc(chars.join(''))}'

/** 2コードユニット以上になるCID（合成文字など） */
const MULTI: Record<number, string> = ${JSON.stringify(multi)}

/** Adobe-Japan1 の CID を Unicode 文字へ。対応が無ければ null */
export function cidToUnicode(cid: number): string | null {
  const m = MULTI[cid]
  if (m) return m
  if (cid < 0 || cid >= TABLE.length) return null
  const c = TABLE[cid]
  return c === '\\u0000' ? null : c
}
`
writeFileSync(OUT, body)
console.log(`書き出し: ${OUT}`)
console.log(`  CID数 ${map.size} / 最大CID ${maxCid} / 複数文字 ${Object.keys(multi).length} / ${(body.length / 1024).toFixed(0)}KB`)
