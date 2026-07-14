// 厳密キャッシュフロー計算書（間接法・営業/投資/財務の3区分）
//
// 設計の要点（ユーザー合意済み）:
// - 全B/S科目を「B/S上の位置」で機械的に営業/投資/財務へ振り分ける。科目名の辞書は不要。
//   位置は会計大将の標準集計コード（9564 現金及び預金 / 9566 流動資産 / 9568 資産の部 /
//   9527 流動負債 / 9569 負債の部）で判定するので、どの顧問先・どんな科目名でも動く（API不使用）。
//   例: 前受金・借受金＝流動負債→営業、前渡金＝流動資産→営業、建設仮勘定＝固定資産→投資。
// - 借入金・リース債務だけは（流動/固定どちらにあっても）財務へ回す（既存の判定関数を再利用）。
// - 3区分の合計は貸借対照表の恒等式そのものなので、実際の現預金増減に一致する（差額≈0）。
//   分類不能な科目や端数だけが「差額」に残るため、200万円超なら要確認として表示側で警告する。
import type { FiscalYearData } from './types'
import { CODES, ytd, singleMonth } from './calc'
import {
  aggregateRows, mainAccountName, depreciationYtd, isLoanAccount, isLeaseAccount,
} from './analysis'

const RECV_RE = /受取手形|電子記録債権|売掛|完成工事未収/
const INV_RE = /商品|製品|仕掛|原材料|貯蔵|未成工事支出金/
function isPay(name: string): boolean { return /買掛|支払手形|電子記録債務|工事未払/.test(name) || name === '未払金' }
// 固定負債のうち営業性（引当金・繰延税金）は営業へ、それ以外（受入保証金等）は財務へ
function isFixedOperLiab(name: string): boolean { return /引当金|繰延税金|退職給付/.test(name) }

type Sec = 'cash' | 'opAsset' | 'invAsset' | 'opLiab' | 'finLiab' | 'equity'

/** BS明細科目名 → 区分（会計大将の標準集計コードで境界を判定） */
function bsSectionMap(fy: FiscalYearData): Map<string, Sec> {
  const m = new Map<string, Sec>()
  let sec: Sec = 'cash' // 【現金及び預金】より前は現預金
  for (const r of fy.rows) {
    if (r.statement !== 'BS') continue
    if (r.isSubtotal) {
      if (r.code === CODES.cash) sec = 'opAsset'       // 9564 【現金及び預金】通過 → 流動資産(その他)
      else if (r.code === CODES.currentAsset) sec = 'invAsset' // 9566 【流動資産】通過 → 固定資産
      else if (r.code === CODES.assetTotal) sec = 'opLiab'     // 9568 【資産の部】通過 → 流動負債
      else if (r.code === CODES.currentLiab) sec = 'finLiab'   // 9527 【流動負債】通過 → 固定負債
      else if (r.code === CODES.liabTotal) sec = 'equity'      // 9569 【負債の部】通過 → 純資産
      continue
    }
    const name = mainAccountName(r.name)
    if (!m.has(name)) m.set(name, sec)
  }
  return m
}

export interface CfItem { label: string; amount: number; note?: string }
export interface CfSection { key: 'op' | 'inv' | 'fin'; title: string; items: CfItem[]; subtotal: number }
export interface CashFlowResult {
  sections: CfSection[]
  netCf: number
  actualCashChange: number
  residual: number          // 実際の現預金増減 − 3区分合計（恒等式で≈0）
  openingCash: number
  closingCash: number
  netProfit: number
  depreciation: number
  hasPrior: boolean
  months: number
  monthLabel: string
  fyLabel: string
}

/** 全B/S科目から間接法の3区分キャッシュフロー計算書を組み立てる（差額≈0） */
export function computeCashFlow(fy: FiscalYearData, prior: FiscalYearData | null, monthIdx: number): CashFlowResult {
  const sectionMap = bsSectionMap(fy)
  const cur = aggregateRows(fy)
  const pre = prior ? aggregateRows(prior) : null
  const OPEN_IDX = 11 // 前期の期末（12ヶ月目＝期末月末）＝当期の期首

  // 科目名 → 残高（期首・当月末）。補助科目は主科目に合算済み（aggregateRows）
  const closeMap = new Map<string, number>()
  for (const r of cur) if (r.statement === 'BS' && !r.isSubtotal) closeMap.set(r.name, (closeMap.get(r.name) || 0) + (r.monthly[monthIdx] ?? 0))
  const openMap = new Map<string, number>()
  if (pre) for (const r of pre) { if (r.statement === 'BS' && !r.isSubtotal) openMap.set(r.name, (openMap.get(r.name) || 0) + (r.monthly[OPEN_IDX] ?? 0)) }
  else for (const r of cur) { if (r.statement === 'BS' && !r.isSubtotal) openMap.set(r.name, r.monthly[0] ?? 0) } // 前期なし＝初月末を期首とみなす

  const names = new Set<string>()
  closeMap.forEach((_v, k) => names.add(k))
  openMap.forEach((_v, k) => names.add(k))

  // 集計バケツ
  let recvChg = 0, invChg = 0, otherOpAsset = 0 // 資産の増減（Δ）
  let payChg = 0, otherOpLiab = 0               // 営業性負債の増減（Δ）
  let loanChg = 0, leaseChg = 0, otherFinLiab = 0 // 財務（Δ）
  const invDetail: { name: string; delta: number }[] = []  // 固定資産の科目別Δ

  for (const name of Array.from(names)) {
    const d = (closeMap.get(name) || 0) - (openMap.get(name) || 0)
    if (d === 0) continue
    const sec = sectionMap.get(name)
    if (sec === 'cash' || sec === 'equity' || sec == null) continue // 現預金＝対象／純資産は集計で処理
    if (sec === 'opAsset') {
      if (RECV_RE.test(name)) recvChg += d
      else if (INV_RE.test(name)) invChg += d
      else otherOpAsset += d
    } else if (sec === 'invAsset') {
      invDetail.push({ name, delta: d })
    } else if (sec === 'opLiab') {
      if (isLoanAccount(name)) loanChg += d
      else if (isLeaseAccount(name)) leaseChg += d
      else if (isPay(name)) payChg += d
      else otherOpLiab += d
    } else if (sec === 'finLiab') {
      if (isLoanAccount(name)) loanChg += d
      else if (isLeaseAccount(name)) leaseChg += d
      else if (isFixedOperLiab(name)) otherOpLiab += d // 引当金等は営業へ
      else otherFinLiab += d                            // 受入保証金等は財務へ
    }
  }

  const netProfit = ytd(fy, CODES.netProfit, monthIdx)
  const dep = depreciationYtd(fy, monthIdx)
  const closeNA = singleMonth(fy, CODES.netAsset, monthIdx)
  const openNA = pre ? singleMonth(prior!, CODES.netAsset, OPEN_IDX) : singleMonth(fy, CODES.netAsset, 0)
  const capitalDividend = (closeNA - openNA) - netProfit // 配当・増減資（純資産増減−当期純利益）
  const closeCash = singleMonth(fy, CODES.cash, monthIdx)
  const openCash = pre ? singleMonth(prior!, CODES.cash, OPEN_IDX) : singleMonth(fy, CODES.cash, 0)
  const actualCashChange = closeCash - openCash

  // ===== 営業活動によるCF =====
  const otherOper = -otherOpAsset + otherOpLiab // その他営業資産・負債（資産増＝現金減、負債増＝現金増）
  const opItems: CfItem[] = [
    { label: '当期純利益', amount: netProfit },
    { label: '減価償却費（非資金費用の戻し）', amount: dep },
    { label: '売上債権の増減（増加＝資金減）', amount: -recvChg },
    { label: '棚卸資産の増減（増加＝資金減）', amount: -invChg },
    { label: '仕入債務の増減（増加＝資金増）', amount: payChg },
    { label: 'その他営業資産・負債の増減（未収金・仮払/仮受消費税・未払費用・前受金・預り金 等）', amount: otherOper },
  ]
  const opSub = opItems.reduce((s, x) => s + x.amount, 0)

  // ===== 投資活動によるCF（固定資産の簿価純増減 − 減価償却費＝実際の設備投資・売却） =====
  invDetail.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
  const TOP = 6
  const invItems: CfItem[] = []
  let invRest = 0
  invDetail.forEach((x, i) => {
    if (i < TOP) invItems.push({ label: `${x.name}の増減（取得＝資金減／売却・償却＝資金増）`, amount: -x.delta })
    else invRest += -x.delta
  })
  if (invRest !== 0) invItems.push({ label: 'その他固定資産の増減', amount: invRest })
  // 固定資産の簿価減少には減価償却（非資金）が含まれるため、同額を控除して営業CFへ振り替える
  invItems.push({ label: '減価償却費の調整（非資金・営業CFへ計上）', amount: -dep })
  const invSub = invItems.reduce((s, x) => s + x.amount, 0)

  // ===== 財務活動によるCF =====
  const finItems: CfItem[] = [
    { label: '借入金の増減（＋調達／−返済）', amount: loanChg },
    { label: 'リース債務の増減（＋調達／−返済）', amount: leaseChg },
    { label: '配当・増減資（純資産の増減−当期純利益）', amount: capitalDividend },
  ]
  if (otherFinLiab !== 0) finItems.push({ label: 'その他財務（受入保証金 等）の増減', amount: otherFinLiab })
  const finSub = finItems.reduce((s, x) => s + x.amount, 0)

  const sections: CfSection[] = [
    { key: 'op', title: '営業活動によるキャッシュフロー', items: opItems, subtotal: opSub },
    { key: 'inv', title: '投資活動によるキャッシュフロー', items: invItems, subtotal: invSub },
    { key: 'fin', title: '財務活動によるキャッシュフロー', items: finItems, subtotal: finSub },
  ]
  const netCf = opSub + invSub + finSub

  return {
    sections,
    netCf,
    actualCashChange,
    residual: actualCashChange - netCf,
    openingCash: openCash,
    closingCash: closeCash,
    netProfit,
    depreciation: dep,
    hasPrior: !!prior,
    months: monthIdx + 1,
    monthLabel: `${fy.fiscalMonths[monthIdx]}月`,
    fyLabel: fy.label,
  }
}
