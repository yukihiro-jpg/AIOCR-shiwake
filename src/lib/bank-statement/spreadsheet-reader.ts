// スプレッドシート読込の共通ラッパー。
// ODS（LibreOffice/OpenOffice Calc）は、日本語セルに「ふりがな（ルビ）」が
// 埋め込まれていることがある。SheetJS はルビの読み仮名（<text:ruby-text>）まで
// セル本文に連結してしまうため、「自賠責」→「自賠責ジバイセキ」のように
// 読み仮名が混入する。ここで content.xml のルビ読み仮名だけを除去してから読む
// （ルビ本体 <text:ruby-base> は残すので、正当なカタカナ表記は保持される）。

import * as XLSX from 'xlsx'
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate'

/** ODS(ZIP)ならルビの読み仮名を除去したバッファを返す。ODSでない/失敗時は元のまま */
function stripOdsRuby(buffer: ArrayBuffer): ArrayBuffer {
  const bytes = new Uint8Array(buffer)
  // ZIPローカルファイル署名 'PK\x03\x04'（ODS/XLSXはZIP。旧xlsやCSVは対象外）
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
    return buffer
  }
  try {
    const files = unzipSync(bytes)
    const content = files['content.xml']
    // content.xml を持つのは ODF（ODS等）。XLSX には無いので素通り
    if (!content) return buffer
    let xml = strFromU8(content)
    if (!xml.includes('text:ruby-text')) return buffer
    // <text:ruby-text ...>読み仮名</text:ruby-text> を丸ごと削除（ruby-base は残す）
    xml = xml.replace(/<text:ruby-text\b[^>]*>[\s\S]*?<\/text:ruby-text>/g, '')
    files['content.xml'] = strToU8(xml)
    const out = zipSync(files)
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer
  } catch {
    return buffer
  }
}

/** XLSX.read のラッパー。ODSのふりがな混入を除去してから読む */
export function readSpreadsheet(buffer: ArrayBuffer, opts?: XLSX.ParsingOptions): XLSX.WorkBook {
  const clean = stripOdsRuby(buffer)
  return XLSX.read(clean, { type: 'array', ...opts })
}
