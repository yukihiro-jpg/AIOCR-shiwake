// 借入金の返済予定表（償還予定表）を顧問先ごとに覚えておき、
// 通帳の解析で「償還額と同じ出金」を見つけたときに、元本と利息へ分けた複合仕訳を作る。
//
// 【なぜ必要か】
// 通帳に出てくるのは償還額（元本＋利息）の1本だけで、内訳は通帳のどこにも書いていない。
// 内訳は銀行の返済予定表にしか無いので、パターン学習では原理的に当てられない
// （元利均等なら毎月1円単位で元本と利息の配分が変わる）。
// そこで予定表そのものを取り込み、日付と償還額で引き当てて内訳を写す。
//
// 【引き当ての考え方】
// ・償還額は**完全一致**を求める（金額が違えば繰上返済・金利変更なので、勝手に当てない）
// ・実際の引落日は予定日とずれることがある（休日順延）ので、日付は前後の許容日数で見る
// ・元利均等は毎月の償還額が同じなので、**日付がいちばん近い回**を採る
//
// 保存は顧問先ごと（`bs-loan-schedules-{cid}`）。STORAGE_KEY_MAP に載せてあるので
// Firebase同期・ZIPバックアップの対象になる。

import type { RawTableRow } from './types'

const keyOf = (cid: string) => `bs-loan-schedules-${cid}`

/** 返済予定表の1回分 */
export interface LoanScheduleRow {
  /** 償還予定日 YYYY-MM-DD */
  date: string
  /** 償還額（元本＋利息）＝通帳から出ていく金額 */
  total: number
  /** 元本額 */
  principal: number
  /** 利息額 */
  interest: number
  /** 融資残高（画面で見比べるためだけに持つ） */
  balance?: number
}

/** 返済予定表の列マッピング（通帳CSVの列マッピングと同じ考え方） */
export interface LoanScheduleMapping {
  dateColumn: number
  totalColumn: number
  principalColumn: number
  interestColumn: number
  balanceColumn?: number
}

/** 1本の借入 */
export interface LoanSchedule {
  id: string
  /** 表示名（例: 筑波銀行 ひたちなか支店） */
  name: string
  /** 元本部分の科目（例: 長期借入金） */
  principalCode: string
  principalName: string
  principalSubCode?: string
  principalSubName?: string
  /** 利息部分の科目（例: 支払利息） */
  interestCode: string
  interestName: string
  interestSubCode?: string
  interestSubName?: string
  rows: LoanScheduleRow[]
  /** 日付のずれの許容（日）。未設定は既定値を使う */
  dateTolerance?: number
  mapping?: LoanScheduleMapping
  fileName?: string
  note?: string
  updatedAt?: number
}

/** 実際の引落日が予定日とずれても拾う日数（休日順延・月末調整の幅） */
export const DEFAULT_DATE_TOLERANCE = 7

export function newLoanScheduleId(): string {
  return `ls-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

// ---------------------------------------------------------------------------
// 保存・読み込み
// ---------------------------------------------------------------------------

export function loadLoanSchedules(cid: string): LoanSchedule[] {
  if (!cid || typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(keyOf(cid))
    if (!raw) return []
    const list = JSON.parse(raw) as LoanSchedule[]
    return Array.isArray(list) ? list.filter((s) => s && s.id) : []
  } catch {
    return []
  }
}

export function saveLoanSchedules(cid: string, list: LoanSchedule[]): void {
  if (!cid || typeof window === 'undefined') return
  try {
    localStorage.setItem(keyOf(cid), JSON.stringify(list))
    // 他端末へも配信（受信は firebase-sync の STORAGE_KEY_MAP 経由）
    import('./firebase-sync')
      .then((m) => m.schedulePushToFirebase(cid, 'loan-schedules', list))
      .catch(() => { /* オフラインなら端末内だけで動く */ })
  } catch { /* 容量超過は無視 */ }
}

// ---------------------------------------------------------------------------
// 取り込み（列マッピング）
// ---------------------------------------------------------------------------

/** 「1,234円」「¥1,234」「△1,234」→ 数値。読めなければ null。 */
export function parseAmount(s: string): number | null {
  const t = String(s ?? '').replace(/[,，\s¥￥円]/g, '').replace(/[−–—ー]/g, '-')
  if (!t || !/\d/.test(t)) return null
  const neg = /^[-△▲]/.test(t) || /^\(.*\)$/.test(t)
  const n = Number(t.replace(/[^0-9.]/g, ''))
  if (!Number.isFinite(n)) return null
  return neg ? -n : n
}

/**
 * 日付セルを YYYY-MM-DD にする。
 * Excelは parseExcel が YYYY-MM-DD に直してくれるが、和暦表記（R6.10.28）や
 * シリアル値のまま入っている列を選ばれることもあるので、ここで受け止める。
 */
export function parseScheduleDate(s: string): string | null {
  const t = String(s ?? '').trim()
  if (!t) return null
  const pad = (n: number) => String(n).padStart(2, '0')
  // YYYY-MM-DD / YYYY/M/D
  let m = /^(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})/.exec(t)
  if (m) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`
  // 和暦（R6.10.28 / 令和6年10月28日 / H31.4.1 / S63.1.1）
  m = /^(令和|平成|昭和|R|H|S)\s*(\d{1,2})[-/年.](\d{1,2})[-/月.](\d{1,2})/i.exec(t)
  if (m) {
    const era = m[1].toUpperCase()
    const base = era === '令和' || era === 'R' ? 2018 : era === '平成' || era === 'H' ? 1988 : 1925
    return `${base + Number(m[2])}-${pad(+m[3])}-${pad(+m[4])}`
  }
  // Excelのシリアル値（1900年基準。1900年のうるう年バグぶんを含めて -25569 日）
  if (/^\d{4,6}(\.\d+)?$/.test(t)) {
    const serial = Number(t)
    if (serial > 20000 && serial < 80000) {
      const d = new Date(Math.round((serial - 25569) * 86400000))
      if (!isNaN(d.getTime())) {
        return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
      }
    }
  }
  return null
}

export interface ParsedSchedule {
  rows: LoanScheduleRow[]
  /** 元本＋利息が償還額と合わない回（そのまま使うと貸借が合わないので画面に出す） */
  mismatched: LoanScheduleRow[]
  /** 日付か金額を読めずに飛ばした行数（見出し・空行を含む） */
  skipped: number
}

/** 列マッピングに従って表を返済予定に直す。 */
export function parseLoanSchedule(rows: RawTableRow[], map: LoanScheduleMapping): ParsedSchedule {
  const out: LoanScheduleRow[] = []
  const mismatched: LoanScheduleRow[] = []
  let skipped = 0
  const cell = (r: RawTableRow, col: number): string =>
    (col >= 0 ? (r.cells[col] ?? '') : '')

  for (const r of rows) {
    const date = parseScheduleDate(cell(r, map.dateColumn))
    const total = parseAmount(cell(r, map.totalColumn))
    const principal = parseAmount(cell(r, map.principalColumn))
    const interest = parseAmount(cell(r, map.interestColumn))
    // 見出し行・期首行（償還額が空）はここで落ちる
    if (!date || total === null || total <= 0 || principal === null || interest === null) { skipped++; continue }
    const row: LoanScheduleRow = {
      date, total, principal, interest,
      balance: map.balanceColumn != null ? (parseAmount(cell(r, map.balanceColumn)) ?? undefined) : undefined,
    }
    out.push(row)
    if (principal + interest !== total) mismatched.push(row)
  }
  return { rows: out, mismatched, skipped }
}

// ---------------------------------------------------------------------------
// 引き当て
// ---------------------------------------------------------------------------

const dayDiff = (a: string, b: string): number => {
  const ta = Date.parse(a), tb = Date.parse(b)
  if (isNaN(ta) || isNaN(tb)) return Number.POSITIVE_INFINITY
  return Math.abs(ta - tb) / 86400000
}

export interface LoanMatch {
  schedule: LoanSchedule
  row: LoanScheduleRow
}

/**
 * 通帳の出金1件に当たる返済予定の回を探す。
 *
 * 償還額は完全一致を求める（違う金額を勝手に元本と利息に割り振らないため）。
 * 元利均等は毎回の償還額が同じなので、**日付がいちばん近い回**を採る。
 * 元本＋利息が償還額と合わない回は、貸借が合わなくなるので当てない。
 */
export function findLoanRepayment(
  schedules: LoanSchedule[], date: string, amount: number,
): LoanMatch | null {
  if (!schedules.length || !date || !amount) return null
  let best: { v: LoanMatch; d: number } | null = null
  for (const s of schedules) {
    if (!s.principalCode || !s.interestCode) continue
    const tol = s.dateTolerance ?? DEFAULT_DATE_TOLERANCE
    for (const row of s.rows) {
      if (row.total !== amount) continue
      if (row.principal + row.interest !== row.total) continue
      const d = dayDiff(row.date, date)
      if (d > tol) continue
      if (!best || d < best.d) best = { v: { schedule: s, row }, d }
    }
  }
  return best ? best.v : null
}
