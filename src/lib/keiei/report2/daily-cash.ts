// 新報告書 v2 P5（月次資金繰り表・日繰り）の計算。
//
// 設計の意図（なぜこうしたか）:
//  - 会計データは**月次しか無い**。日々の入出金の実績は会計ソフトの月次推移CSVには入っていないので、
//    ここで作る日別残高は「その月の実績合計（売上・原価・販管費・BSの増減）」を
//    **登録済みの支払・回収サイクル（締日・支払日）で日付へ割り当てた推計**である。
//    社長に見せたいのは「月末にいくら残るか」ではなく「**月の途中でどこが一番薄くなるか**」なので、
//    金額の1円単位の正しさより「山と谷の形」と「底の日」が合っていることを優先している。
//  - そのかわり **月初残高＋入金合計−出金合計＝月末残高 が必ず一致する**ことを不変条件にした。
//    推計で説明できなかった残りは、最終日の「その他入出金」1行にまとめて吸収する
//    （どこかの日に薄く混ぜ込むと、説明できない額の大きさが読み手に見えなくなるため）。
//  - 各内訳は**マイナスにしない**（0で止める）。たとえば売上以上に売掛が増えた月は
//    「回収がマイナス」ではなく「回収は0＋差額はその他入出金」と表す。
//    符号が反転した項目を『売掛金の回収』の行に出すと紙面の意味が壊れるため。
//  - 金額の内部単位は「円」。表示単位（千円）への変換は theme.ts の amt()/toUnit() が行う。
//  - データが欠けていても例外は投げない。前月末のBSが取れないときは月末残高から逆算し、
//    reliable=false を返して呼び出し側が注記を強められるようにする。
import type { FiscalYearData } from '../types'
import { CODES, singleMonth, ytd } from '../calc'
import { depreciationYtd, detailsOf, workingCapital, type KeieiSettings } from '../analysis'
import {
  defaultDailyCycle,
  type DailyCashResult, type DailyCashRow, type ReportV2Settings,
} from './types'

/** 1期＝12か月固定（会計大将の月次推移CSVが12列） */
const M = 12

// 人件費とみなす科目名。landing.ts / issues.ts と**同じ判定**にしている
// （片方だけ直すと着地見込みの「うち人件費」と給与支給額がずれるので、変更時は必ず揃えること）。
const LABOR_RE = /役員報酬|役員賞与|給料|給与|賃金|賞与|雑給|法定福利|福利厚生|退職金|退職給付|人件費|労務費|専従者給与/

/**
 * 社会保険料（本人負担の預り分を含む）と源泉所得税の納付額を、人件費から見積もるときの率。
 * 会社負担・本人負担あわせた社会保険料が給与のおおむね30%、うち会社負担分は法定福利費として
 * すでに人件費（＝販管費）に入っている。ここで日付へ置きたいのは「口座から出ていく総額」なので、
 * 二重計上を避けつつ預り金の納付を織り込む概算として 15% を使う。
 */
export const SOCIAL_INSURANCE_RATE = 0.15

/** その他経費（カード・諸口座振替）のうち、振替日にまとめて落ちる割合。残りは営業日へならす */
const CARD_LUMP_RATE = 0.7

const DOW = ['日', '月', '火', '水', '木', '金', '土']

/** 期の i 番目の月（1〜12）。fiscalMonths が欠けている取込データでも期末月から逆算する */
function monthNoOf(fy: FiscalYearData, i: number): number {
  const m = fy.fiscalMonths?.[i]
  if (m && m >= 1 && m <= M) return m
  return (((fy.endMonth - 1 - (M - 1 - i)) % M) + M) % M + 1
}

/** 販管費の明細から当月（単月）の人件費を拾う */
function laborSingle(fy: FiscalYearData, monthIdx: number): number {
  let s = 0
  for (const a of detailsOf(fy, CODES.sgna)) {
    if (LABOR_RE.test(a.name)) s += a.monthly[monthIdx] ?? 0
  }
  return s
}

/** 当月（単月）の減価償却費＝YTDの差分（拾う科目の範囲を analysis.ts と一致させるため差で取る） */
function depreciationSingle(fy: FiscalYearData, monthIdx: number): number {
  const cur = depreciationYtd(fy, monthIdx)
  return monthIdx > 0 ? cur - depreciationYtd(fy, monthIdx - 1) : cur
}

/** 前期の期末インデックス（期中までしか入っていない前期でも落ちないように最終入力月で止める） */
function priorEndIdx(prior: FiscalYearData): number {
  const last = prior.lastFilledIndex
  return last >= 0 && last < M ? last : M - 1
}

/** 入出金1件（amount は常に0以上。dir で向きを表す） */
interface Flow { day: number; dir: 'in' | 'out'; amount: number; label: string }

export function computeDailyCash(
  fy: FiscalYearData,
  prior: FiscalYearData | null,
  monthIdx: number,
  settings: KeieiSettings,
  v2: ReportV2Settings,
): DailyCashResult {
  const idx = Math.max(0, Math.min(M - 1, Math.floor(monthIdx) || 0))

  // ===== 対象の暦年月とカレンダー =====
  // 期末が3月・fiscalMonths が [4,5,…,3] のとき、4〜12月は期末年−1、1〜3月は期末年になる
  const month = monthNoOf(fy, idx)
  const year = month <= fy.endMonth ? fy.endYear : fy.endYear - 1
  const daysInMonth = new Date(year, month, 0).getDate() // 0日＝前月末日（うるう年も自動）
  const dowOf = (d: number): string => DOW[new Date(year, month - 1, d).getDay()] || ''

  // ===== 月初・月末の現預金残高 =====
  const closing = singleMonth(fy, CODES.cash, idx)
  // 前月末＝当期の1つ前の月末。期首月なら前期の期末。
  // 0円は「実際に0」ではなく「その月のBSが入っていない」ことがほとんどなので未取得として扱う
  const openingRaw = idx > 0
    ? singleMonth(fy, CODES.cash, idx - 1)
    : (prior ? singleMonth(prior, CODES.cash, priorEndIdx(prior)) : 0)
  const openingKnown = openingRaw !== 0

  // ===== 当月の実績（単月）=====
  const sales = singleMonth(fy, CODES.sales, idx)
  const cogs = singleMonth(fy, CODES.cogs, idx)
  const sgna = singleMonth(fy, CODES.sgna, idx)
  const labor = laborSingle(fy, idx)
  const dep = depreciationSingle(fy, idx)

  // 売上債権・仕入債務は2時点（前月末・当月末）の残高差で「発生と入出金のズレ」を取る
  const wcNow = workingCapital(fy, idx)
  const wcPre = idx > 0
    ? workingCapital(fy, idx - 1)
    : (prior ? workingCapital(prior, priorEndIdx(prior)) : wcNow) // 前月が無いときは増減0とみなす

  const nonNeg = (n: number): number => (isFinite(n) && n > 0 ? Math.round(n) : 0)

  // 売掛金の回収＝当月売上 ＋（前月末の売上債権 − 当月末の売上債権）
  //   売掛が増えた分は「まだ入金されていない売上」なので売上から差し引く
  const recvIn = nonNeg(sales + (wcPre.recv - wcNow.recv))
  // 買掛金の支払＝当月の売上原価 ＋（前月末の仕入債務 − 当月末の仕入債務）
  const payOut = nonNeg(cogs + (wcPre.pay - wcNow.pay))
  // 給与・役員報酬（販管費の人件費。売上原価の労務費は上の買掛支払に含まれる）
  const salaryOut = nonNeg(labor)
  // 社会保険・源泉所得税（概算）
  const socialOut = nonNeg(labor * SOCIAL_INSURANCE_RATE)
  // 借入・リースの返済（ユーザーが期ごとに登録した月額）
  const repayOut = nonNeg((settings.repayLoanMonthly?.[fy.id] || 0) + (settings.repayLeaseMonthly?.[fy.id] || 0))
  // その他経費＝販管費 − 人件費 − 減価償却費（非資金）− 社会保険・源泉の概算
  const otherOut = nonNeg(sgna - labor - dep - socialOut)

  // ===== 支払・回収サイクル（未設定は既定値。31は末日に丸める）=====
  const cyc = defaultDailyCycle()
  const dayOf = (v: number | undefined, def: number): number => {
    const n = v == null || !isFinite(v) ? def : Math.round(v)
    return Math.min(Math.max(1, n), daysInMonth)
  }
  const recvDay = dayOf(v2.recvPayDay, cyc.recvPayDay)
  const payDay = dayOf(v2.payPayDay, cyc.payPayDay)
  const salaryDay = dayOf(v2.salaryDay, cyc.salaryDay)
  const socialDay = dayOf(v2.socialDay, cyc.socialDay)
  const cardDay = dayOf(v2.cardDay, cyc.cardDay)
  const loanDay = dayOf(v2.loanDay, cyc.loanDay)

  // ===== 日付へ割り当てる =====
  // 土日でも日付はずらさない（実務の予定表としてはこれで足りる。銀行休業日の前倒しまでは見ない）
  const flows: Flow[] = []
  const push = (day: number, dir: 'in' | 'out', amount: number, label: string) => {
    if (!(amount > 0)) return
    flows.push({ day, dir, amount, label })
  }
  push(recvDay, 'in', recvIn, '売掛金の回収')
  push(payDay, 'out', payOut, '買掛金の支払')
  push(salaryDay, 'out', salaryOut, '給与支給')
  push(socialDay, 'out', socialOut, '源泉所得税・社会保険料の納付')
  push(loanDay, 'out', repayOut, '借入金・リースの返済')

  // その他経費は「振替日にまとめて7割・残り3割は営業日にならして毎日少額」。
  // 全額を1日に落とすと谷が実際より深く見え、逆に全部ならすと引落日の谷が消えるため半々にした
  const cardLump = Math.round(otherOut * CARD_LUMP_RATE)
  push(cardDay, 'out', cardLump, 'カード利用代金・諸経費の引落')
  const spreadTotal = otherOut - cardLump
  if (spreadTotal > 0) {
    const bizDays: number[] = []
    for (let d = 1; d <= daysInMonth; d++) {
      const w = new Date(year, month - 1, d).getDay()
      if (w !== 0 && w !== 6 && d !== cardDay) bizDays.push(d)
    }
    // 平日が1日も無いことは実際には起きないが、念のため引落日以外の全日へならす
    const target = bizDays.length ? bizDays : Array.from({ length: daysInMonth }, (_, i) => i + 1).filter((d) => d !== cardDay)
    const per = target.length ? Math.round(spreadTotal / target.length) : 0
    for (const d of target) push(d, 'out', per, '経費')
  }

  // ===== 月初残高と差額（不変条件：月初＋入金−出金＝月末）=====
  const flowNet = flows.reduce((s, f) => s + (f.dir === 'in' ? f.amount : -f.amount), 0)
  // 前月末BSが取れないときは「月末残高 − 当月の増減」で月初を逆算する（形は出るが実績ではない）
  const opening = openingKnown ? openingRaw : closing - flowNet
  const diff = closing - opening - flowNet
  if (Math.round(Math.abs(diff)) >= 1) {
    // 上の内訳で説明できなかった残り（未払金・前受金・固定資産の取得・税金など）。
    // 月末日に置くのは「いつ動いたか分からないものを月中の谷に影響させない」ため
    push(daysInMonth, diff > 0 ? 'in' : 'out', Math.round(Math.abs(diff)), 'その他入出金')
  }

  // ===== 日別の表 =====
  const rows: DailyCashRow[] = []
  let bal = opening
  let incomeTotal = 0
  let outgoTotal = 0
  for (let d = 1; d <= daysInMonth; d++) {
    const today = flows.filter((f) => f.day === d)
    let income = 0
    let outgo = 0
    const notes: string[] = []
    for (const f of today) {
      if (f.dir === 'in') income += f.amount
      else outgo += f.amount
      if (!notes.includes(f.label)) notes.push(f.label)
    }
    bal += income - outgo
    incomeTotal += income
    outgoTotal += outgo
    rows.push({
      day: d, dow: dowOf(d), income, outgo, balance: bal,
      note: notes.join('・'), danger: false, bottom: false,
    })
  }
  // 端数の積み上がりで月末が1円ずれることがあるので、最終日は月末残高そのものにする
  if (rows.length) rows[rows.length - 1].balance = closing

  // ===== 必要最低残高 =====
  // 既定は「月商の1/3」＝ 月商（期首〜当月の売上累計 ÷ 経過月数）の10日分。
  // 支払の山が月に1〜2回来る中小企業で、1回分の支払を賄える最低ラインの目安として使っている
  const monthlySales = ytd(fy, CODES.sales, idx) / (idx + 1)
  const manual = v2.minCashManual
  const useManual = v2.minCashMode === 'manual' && manual != null && isFinite(manual) && manual > 0
  const minRequired = useManual ? Math.round(manual as number) : Math.round(Math.max(0, monthlySales) / 3)
  const minRequiredNote = useManual ? '手入力' : '月商の1/3'

  // ===== 最低残高・危険水域 =====
  let minBalance = rows.length ? rows[0].balance : opening
  let minDay = rows.length ? rows[0].day : 1
  for (const r of rows) {
    if (r.balance < minBalance) { minBalance = r.balance; minDay = r.day }
  }
  const dangerDays: number[] = []
  for (const r of rows) {
    r.danger = r.balance < minRequired
    r.bottom = r.day === minDay
    if (r.danger) dangerDays.push(r.day)
  }

  return {
    year, month, daysInMonth,
    opening, closing,
    incomeTotal, outgoTotal,
    minBalance, minDay,
    minRequired, minRequiredNote,
    dangerDays, rows,
    reliable: openingKnown,
  }
}
