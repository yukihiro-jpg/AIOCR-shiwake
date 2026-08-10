// カード明細（PDF）のフォーマット記憶。
//
// カード会社ごとに列レイアウトが違うので、一度うまく解析できたフォーマットを
// 「署名 → レイアウト」で覚えておき、次回以降は検出をやり直さず同じ位置で読む。
// 署名は「英字のブランド語（アメリカン・エキスプレスの www.americanexpress.co.jp など）＋
// 用紙サイズ＋日付列と金額列の位置」から作る。氏名・カード番号・金額は一切含めない。

import type { StatementLayout } from './statement-layout-parser'
import type { RawTableRow } from './types'
import { getSelectedClientId } from './client-store'

export interface CardFormat {
  signature: string
  /** 画面に出す名前（明細書の英字表記から拾う。無ければ「カード明細」） */
  label: string
  layout: StatementLayout
  /** 摘要が文字化けするフォーマットか（＝ローカルOCRで読み直す必要がある） */
  descNeedsOcr: boolean
  /** 前回の取引件数（件数が大きく変わったときの気付き用） */
  lastRows: number
  useCount: number
  updatedAt: string
}

const keyOf = (cid: string) => `bs-card-formats-${cid}`
const GLOBAL_KEY = 'bs-card-formats'

function storageKey(): string {
  const cid = getSelectedClientId()
  return cid ? keyOf(cid) : GLOBAL_KEY
}

export function getCardFormats(): Record<string, CardFormat> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = localStorage.getItem(storageKey())
    if (raw) return (JSON.parse(raw) as Record<string, CardFormat>) || {}
  } catch { /* ignore */ }
  return {}
}

export function getCardFormat(signature: string): CardFormat | null {
  if (!signature) return null
  return getCardFormats()[signature] || null
}

export function saveCardFormat(fmt: Omit<CardFormat, 'useCount' | 'updatedAt'>): void {
  if (typeof window === 'undefined' || !fmt.signature) return
  const all = getCardFormats()
  const prev = all[fmt.signature]
  all[fmt.signature] = {
    ...fmt,
    useCount: (prev?.useCount || 0) + 1,
    updatedAt: new Date().toISOString(),
  }
  try { localStorage.setItem(storageKey(), JSON.stringify(all)) } catch { /* ignore */ }
  const cid = getSelectedClientId()
  if (cid) {
    // 他端末へも配信（受信は firebase-sync の STORAGE_KEY_MAP 経由）
    import('./firebase-sync')
      .then(({ schedulePushToFirebase }) => schedulePushToFirebase(cid, 'card-formats', all))
      .catch(() => { /* firebase 未設定なら無視 */ })
  }
}

export function deleteCardFormat(signature: string): void {
  if (typeof window === 'undefined') return
  const all = getCardFormats()
  if (!all[signature]) return
  delete all[signature]
  try { localStorage.setItem(storageKey(), JSON.stringify(all)) } catch { /* ignore */ }
  const cid = getSelectedClientId()
  if (cid) {
    import('./firebase-sync')
      .then(({ schedulePushToFirebase }) => schedulePushToFirebase(cid, 'card-formats', all))
      .catch(() => { /* ignore */ })
  }
}

/** 数字を含まない英字語だけを拾う（カード番号・電話番号・氏名を署名に入れないため） */
function brandTokens(rows: RawTableRow[]): string[] {
  const found = new Set<string>()
  for (const r of rows) {
    for (const cell of r.cells) {
      // 文字化けした日本語からもラテン文字が拾えてしまうので、
      // まるごと英数字・記号の行（本当の英語表記）だけを署名の材料にする
      if (!/^[\x20-\x7E]+$/.test(cell)) continue
      const words = cell.match(/[A-Za-z][A-Za-z.]{2,}/g)
      if (!words) continue
      for (const w of words) {
        const t = w.replace(/[^A-Za-z]/g, '').toLowerCase()
        if (t.length >= 3 && t.length <= 24) found.add(t)
      }
    }
  }
  // 長い語ほどブランド固有（americanexpress / businessplatinum）。上位6語を辞書順で
  return Array.from(found).sort((a, b) => b.length - a.length || a.localeCompare(b))
    .slice(0, 6).sort()
}

/** 明細書の見出しに使える英字の行（画面表示用のラベル） */
function brandLabel(rows: RawTableRow[]): string {
  let best = ''
  for (const r of rows.slice(0, 12)) {
    for (const cell of r.cells) {
      if (!/^[\x20-\x7E]+$/.test(cell)) continue
      if (!/[A-Za-z]{4}/.test(cell)) continue
      if (/^\d|@|^www\./i.test(cell)) continue
      if (cell.length > best.length && cell.length <= 60) best = cell
    }
  }
  return best.trim()
}

/**
 * フォーマット署名。カード会社・用紙・列位置が同じなら同じ文字列になる。
 * 個人を特定する情報（氏名・カード番号・金額）は含めない。
 */
export function computeCardSignature(
  firstPageRows: RawTableRow[],
  pageWidth: number,
  pageHeight: number,
  layout: StatementLayout,
): string {
  const brand = brandTokens(firstPageRows).join('-')
  return [
    brand || 'nobrand',
    `${Math.round(pageWidth)}x${Math.round(pageHeight)}`,
    `d${Math.round(layout.dateX[0])}`,
    `a${Math.round(layout.amountX[1])}`,
  ].join('|')
}

export function computeCardLabel(firstPageRows: RawTableRow[]): string {
  return brandLabel(firstPageRows) || 'カード明細'
}
