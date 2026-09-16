// 借入金の返済予定（手入力）。
//
// いまの月次レポートは、借入をBSの残高の増減からしか見ていない。
// これは「過ぎたこと」しか分からず、**これから何月にいくら返すのか**が出せない。
// 返済予定を持つと、
//   ・FCF・借入返済バランス … 実績の返済額ではなく「今後12ヶ月の約定返済額」で見られる
//   ・納税資金予測          … 返済と納税を同じ時間軸に並べ、資金が要る月を先に出せる
//   ・損益分岐点            … 来期の約定返済を賄う売上高を逆算できる
// が成り立つ。
//
// 【入力は手入力から始める】
// 返済予定表のPDF/Excelの読取は後から足せるが、まずは手で入れられることを優先する。
// 元金均等・元利均等・据置期間まで入れれば、毎月の元金と利息は計算で出せるので、
// 入力するのは借入1本につき数項目で済む。
//
// 保存は顧問先ごと（`keiei/{cid}/loans`）。顧問先を削除したら一緒に消える。

import { getDb } from '@/core/firebase'
import { modulePath, hasRoom } from '@/core/room'

const MODULE_KEY = 'keiei'
const lsKey = (cid: string) => `keiei-loans-${cid}`

/** 返済方法 */
export type RepayMethod =
  | 'equal-principal'  // 元金均等（毎月の元金が一定。利息は残高に応じて減る）
  | 'equal-payment'    // 元利均等（毎月の返済額が一定）
  | 'bullet'           // 期限一括（満期に元金をまとめて返す）

export interface Loan {
  id: string
  /** 金融機関・借入の名前（例: 常陽銀行 証書貸付） */
  name: string
  /** 対応するBSの科目名（残高との突合に使う。空でもよい） */
  account?: string
  /** 当初借入額（円） */
  principal: number
  /** 実行日 YYYY-MM-DD */
  startDate: string
  /** 返済回数（月数）。据置期間は含まない */
  termMonths: number
  /** 年利（%） */
  rate: number
  method: RepayMethod
  /** 据置期間（月）。この間は利息のみ */
  graceMonths?: number
  /** 毎月の返済日（1〜31。末日は31） */
  payDay?: number
  /** 元利均等で、実際の返済額が計算値と違うとき用（円）。入っていればこちらを使う */
  fixedPayment?: number
  /** 保証料・メモ */
  note?: string
}

/** 1回分の返済予定 */
export interface RepayRow {
  /** 支払年月 YYYY-MM */
  ym: string
  /** 元金 */
  principal: number
  /** 利息 */
  interest: number
  /** 返済後の残高 */
  balance: number
}

/** 元利均等の毎月返済額。利率0なら単純割り。 */
export function equalPayment(principal: number, annualRate: number, months: number): number {
  if (months <= 0) return 0
  const r = annualRate / 100 / 12
  if (r <= 0) return principal / months
  const f = Math.pow(1 + r, months)
  return (principal * r * f) / (f - 1)
}

const ymOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`

/**
 * 1本の借入の返済予定を全期間ぶん作る。
 * 端数は最終回で吸収し、**残高がぴったり0で終わる**ようにする
 * （毎月を丸めた結果、最後に数円残るのを避けるため）。
 */
export function scheduleOf(loan: Loan): RepayRow[] {
  const out: RepayRow[] = []
  const n = Math.max(0, Math.floor(loan.termMonths))
  if (!loan.principal || !n) return out
  const start = new Date(loan.startDate || `${new Date().getFullYear()}-01-01`)
  if (isNaN(start.getTime())) return out
  const grace = Math.max(0, Math.floor(loan.graceMonths ?? 0))
  const r = loan.rate / 100 / 12
  let bal = loan.principal

  // 据置期間: 元金は減らず利息だけ払う
  for (let i = 0; i < grace; i++) {
    const d = new Date(start.getFullYear(), start.getMonth() + 1 + i, 1)
    out.push({ ym: ymOf(d), principal: 0, interest: Math.round(bal * r), balance: bal })
  }

  const pay = loan.method === 'equal-payment'
    ? (loan.fixedPayment && loan.fixedPayment > 0
      ? loan.fixedPayment : equalPayment(loan.principal, loan.rate, n))
    : 0
  const flat = Math.floor(loan.principal / n)

  for (let i = 0; i < n; i++) {
    const d = new Date(start.getFullYear(), start.getMonth() + 1 + grace + i, 1)
    const interest = Math.round(bal * r)
    let principal: number
    if (loan.method === 'bullet') {
      principal = i === n - 1 ? bal : 0
    } else if (loan.method === 'equal-payment') {
      principal = Math.round(pay - interest)
    } else {
      principal = flat
    }
    // 最終回、または残高を超えた回は残りを全部返して終わる
    if (i === n - 1 || principal > bal) principal = bal
    if (principal < 0) principal = 0
    bal -= principal
    out.push({ ym: ymOf(d), principal, interest, balance: bal })
    if (bal <= 0) break
  }
  return out
}

/** 複数の借入をまとめて、年月ごとの元金・利息・残高にする。 */
export function mergeSchedules(loans: Loan[]): Map<string, { principal: number; interest: number; balance: number }> {
  const out = new Map<string, { principal: number; interest: number; balance: number }>()
  for (const l of loans) {
    for (const row of scheduleOf(l)) {
      const v = out.get(row.ym) ?? { principal: 0, interest: 0, balance: 0 }
      v.principal += row.principal
      v.interest += row.interest
      v.balance += row.balance
      out.set(row.ym, v)
    }
  }
  return out
}

/** 指定した年月から12ヶ月ぶんの予定（無い月は0）。 */
export function next12(loans: Loan[], fromYm: string): { ym: string; principal: number; interest: number }[] {
  const m = mergeSchedules(loans)
  const [y0, m0] = fromYm.split('-').map(Number)
  return Array.from({ length: 12 }, (_, i) => {
    const d = new Date(y0, (m0 - 1) + i, 1)
    const ym = ymOf(d)
    const v = m.get(ym)
    return { ym, principal: v?.principal ?? 0, interest: v?.interest ?? 0 }
  })
}

// ---------------------------------------------------------------------------
// 保存（顧問先ごと）
// ---------------------------------------------------------------------------

function readLocal(cid: string): Loan[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(lsKey(cid))
    return raw ? (JSON.parse(raw) as Loan[]) : []
  } catch {
    return []
  }
}

function writeLocal(cid: string, list: Loan[]): void {
  if (typeof window === 'undefined') return
  try { localStorage.setItem(lsKey(cid), JSON.stringify(list)) } catch { /* 容量超過は無視 */ }
}

async function dbfns() {
  const db = await getDb()
  const m = await import('firebase/database')
  return { db, ...m }
}

export async function loadLoans(cid: string): Promise<Loan[]> {
  if (!cid) return []
  if (!hasRoom()) return readLocal(cid)
  try {
    const { db, ref, get } = await dbfns()
    const snap = await get(ref(db, await modulePath(MODULE_KEY, cid, 'loans')))
    const val = snap.val()
    if (!val) return readLocal(cid)
    const list = (Array.isArray(val) ? val : Object.values(val)) as Loan[]
    const clean = list.filter((l) => l && l.id)
    writeLocal(cid, clean)
    return clean
  } catch {
    return readLocal(cid)
  }
}

export async function saveLoans(cid: string, list: Loan[]): Promise<void> {
  if (!cid) return
  writeLocal(cid, list)
  if (!hasRoom()) return
  const { db, ref, set } = await dbfns()
  await set(ref(db, await modulePath(MODULE_KEY, cid, 'loans')), list)
}

export function newLoanId(): string {
  return `loan-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

export const METHOD_LABEL: Record<RepayMethod, string> = {
  'equal-principal': '元金均等',
  'equal-payment': '元利均等',
  bullet: '期限一括',
}
