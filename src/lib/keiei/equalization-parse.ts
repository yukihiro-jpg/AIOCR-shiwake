// 均等割の税率表（自治体のホームページやスクショ）を読み取って、プリセットの行に直す。
//
// 【貼り付けテキストを優先する】
// 自治体のページはHTMLの表なので、選択してコピーするとタブ区切りの文字列になる。
// これを解析する経路なら **AIを使わず・通信もせず・数字を1桁も間違えない**。
// スクショの読取（AI）は、PDFしか無い・コピーできない自治体のための保険として置く。
//
// 表の形はどの自治体もほぼ同じ:
//   資本金等の額 | 従業者数が50人超 | 従業者数が50人以下
// ただし2つの数量列の**左右が逆の自治体もある**ので、見出しから判定する。
// 見出しが無い（スクショの一部だけ等）ときは、呼び出し側で並び順を選んでもらう。

import type { CapitalKey, EqRate } from './equalization-presets'

export interface ParsedEqRow {
  capital: CapitalKey
  /** 従業者数50人超の金額 */
  over50: number | null
  /** 従業者数50人以下の金額 */
  under50: number | null
  /** 元の行（画面で見比べられるように残す） */
  source: string
}

export interface ParsedEqTable {
  rows: ParsedEqRow[]
  /** 見出しから列の並びを判定できたか。false なら呼び出し側で選んでもらう */
  headerFound: boolean
  /** 見出しがあった場合、1つ目の数量列が「50人超」だったか */
  firstIsOver50: boolean
  /** 読み取れなかった行（画面に出して気づけるようにする） */
  skipped: string[]
}

/** 全角→半角・空白の正規化。 */
function norm(s: string): string {
  return s.normalize('NFKC').replace(/[\s　]+/g, ' ').trim()
}

/**
 * 「資本金等の額」の欄から区分を判定する。
 * **狭い区分から先に判定する**（「1億円を超え10億円以下」を「1億円以下」と誤らないため）。
 */
export function capitalKeyOfLabel(label: string): CapitalKey | null {
  const t = norm(label).replace(/,/g, '')
  if (/50億.*超/.test(t) && !/以下/.test(t)) return 'e'
  if (/10億.*(超|超え).*50億.*以下/.test(t)) return 'd'
  if (/1億.*(超|超え).*10億.*以下/.test(t)) return 'c'
  if (/(1千万|1000万).*(超|超え).*1億.*以下/.test(t)) return 'b'
  if (/(1千万|1000万)円?以下/.test(t)) return 'a'
  // 「10億円以下」のように上限だけ書いてある表記
  if (/^50億円?超/.test(t)) return 'e'
  return null
}

/** 「3,600,000円」「144,000」→ 数値。金額らしくないものは null。 */
function moneyOf(s: string): number | null {
  const t = norm(s).replace(/[,，]/g, '')
  const m = /(\d+)\s*円?/.exec(t)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) && n > 0 ? n : null
}

/** 1行をセルに割る。タブ区切り→複数スペース→「円」の直後 の順で試す。 */
function cellsOf(line: string): string[] {
  if (line.includes('\t')) return line.split('\t').map(norm)
  const byWide = line.split(/\s{2,}|　+/).map(norm).filter(Boolean)
  if (byWide.length >= 3) return byWide
  // 「… 3,600,000円 492,000円」のように1スペース区切り
  return norm(line).split(' ').filter(Boolean)
}

/**
 * 貼り付けたテキストから税率表を読む。
 * 行の中から「資本金等の額らしい欄」と「金額らしい欄2つ」を拾う方式なので、
 * 列が増えていても（注記の列があっても）読める。
 */
export function parseEqTable(text: string): ParsedEqTable {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trimEnd()).filter(l => l.trim())
  let headerFound = false
  let firstIsOver50 = true
  const rows: ParsedEqRow[] = []
  const skipped: string[] = []

  for (const line of lines) {
    const t = norm(line)
    // 見出し行: 「50人超」と「50人以下」の出てくる順で列の並びを決める
    if (/50\s*人/.test(t) && /従業(者|員)/.test(t)) {
      const iOver = t.search(/50\s*人\s*(を)?超/)
      const iUnder = t.search(/50\s*人\s*以下/)
      if (iOver >= 0 && iUnder >= 0) {
        headerFound = true
        firstIsOver50 = iOver < iUnder
      }
      continue
    }
    const cells = cellsOf(line)
    if (cells.length < 2) { continue }
    // 資本金等の額らしい欄を探す（どの列にあってもよい）
    let capital: CapitalKey | null = null
    let capIdx = -1
    for (let i = 0; i < cells.length; i++) {
      const k = capitalKeyOfLabel(cells[i])
      if (k) { capital = k; capIdx = i; break }
    }
    if (!capital) {
      // 「上記以外の法人等」など、資本金等の額で区分しない行は黙って飛ばさず記録する
      if (/円/.test(t) && /\d/.test(t)) skipped.push(line.trim())
      continue
    }
    const money = cells.slice(capIdx + 1).map(moneyOf).filter((v): v is number => v !== null)
    if (money.length === 0) { skipped.push(line.trim()); continue }
    const [a, b] = [money[0], money.length > 1 ? money[1] : null]
    rows.push({
      capital,
      over50: firstIsOver50 ? a : (b ?? a),
      under50: firstIsOver50 ? (b ?? a) : a,
      source: line.trim(),
    })
  }
  return { rows, headerFound, firstIsOver50, skipped }
}

/** 列の並びを後から入れ替える（見出しが無くて判定できなかったとき用）。 */
export function swapColumns(t: ParsedEqTable): ParsedEqTable {
  return {
    ...t,
    firstIsOver50: !t.firstIsOver50,
    rows: t.rows.map(r => ({ ...r, over50: r.under50, under50: r.over50 })),
  }
}

/** 取り込み先。都道府県分と市町村分は別のページに載っているので、1回につき片方だけ入れる。 */
export type EqImportTarget = 'pref' | 'city'

/**
 * 読み取った表を既存の区分表へ重ねる。
 * **もう片方（都道府県分／市町村分）の金額は残す**ので、県のページ→市のページの順に
 * 2回貼れば1つの自治体が仕上がる。
 */
export function mergeParsedRates(
  base: EqRate[], rows: ParsedEqRow[], target: EqImportTarget,
): EqRate[] {
  const out = base.map(r => ({ ...r }))
  const put = (capital: CapitalKey, staffOver50: boolean, amount: number) => {
    const hit = out.find(r => r.capital === capital && r.staffOver50 === staffOver50)
    if (hit) { hit[target] = amount; return }
    out.push({ capital, staffOver50, pref: 0, city: 0, [target]: amount } as EqRate)
  }
  for (const r of rows) {
    if (r.over50 !== null) put(r.capital, true, r.over50)
    if (r.under50 !== null) put(r.capital, false, r.under50)
  }
  // 並びは 区分（a→e）×（50人以下→50人超）で安定させる
  const ord = 'abcde'
  out.sort((x, y) =>
    ord.indexOf(x.capital) - ord.indexOf(y.capital)
    || Number(x.staffOver50) - Number(y.staffOver50))
  return out
}
