// 新報告書 v2 ── 借入金とフリーキャッシュフロー（P7「借入金とフリーキャッシュフロー」）。
//
// 設計の意図（なぜこうしたか）:
// - 借入残高・自己資本比率・簡易CFは、既存の「安全性」タブと**必ず同じ数字**にする。
//   ここで科目を拾い直すと（例: 役員借入を含める/含めない）画面と紙で食い違って
//   問い合わせになるので、analysis.ts の safety() をそのまま呼ぶ（再実装しない）。
//   有利子負債から除外する科目の設定（KeieiSettings.loanExclude）も safety() の判定に従い、
//   月次グラフの残高でも同じ除外を適用して、カードとグラフの当月値を一致させる。
// - 返済原資は「税引後利益＋減価償却」の簡易CF。税引後利益の税率は**年換算した経常利益**で
//   判定する（期中の累計そのままだと所得が小さく見えて低い税率が当たり、期末に近づくほど
//   返済原資が過大→過少へ動いてしまう）。safety() と同じ考え方に揃えてある。
// - 返済額はユーザー入力（月額元本＋月額リース）だけを根拠にする。BSの借入残高の増減から
//   逆算すると、新規調達があった月に「返済額がマイナス」になって紙面が破綻するため。
// - フリーCFは簡易CFではなく **cashflow.ts の厳密CF（間接法3区分）の営業＋投資** を使う。
//   P4（キャッシュ・フロー計算書）と同じ数字でないと、同じ報告書の中で2つのFCFが並ぶことになる。
// - 返済予定表は「約定返済が今のまま続いたら」の単純な引き算。当期末残高だけは
//   当月末残高から**期末までの残り月ぶん**を引く（当期はすでに何か月か返済済みなので、
//   当期末残高から年間返済額を丸ごと引くと二重に減ってしまう）。
// - 金額はすべて **円** のまま返す（表示単位の変換は theme.ts の amt()/toUnit() の仕事）。
// - データが無いとき（借入なし・返済額未入力・前期なし）でも例外は投げない。0 か null を返して
//   呼び出し側が「—」を出せるようにする。
import type { FiscalYearData } from '../types'
import { CODES, ytd, singleMonth } from '../calc'
import { safety, debtAccounts, depreciationYtd, type KeieiSettings } from '../analysis'
import { effectiveTaxRate } from '../tax'
import { computeCashFlow } from '../cashflow'
import type { LoanMonth, LoanResult } from './types'

/** 1期＝12か月固定（会計大将の月次推移CSVが12列） */
const M = 12
/** 返済予定表の行数（当期＋3期先） */
const SCHEDULE_YEARS = 4

const fin = (n: number): number => (isFinite(n) ? n : 0)

/**
 * 期数の表記（第8期）をラベルから取り出す。
 * 「令和8年3月期」「2026年3月期」を期数と読み違えないよう、**「第」が付いているときだけ**採用する。
 * 取れなければ null（呼び出し側が '当期'/'翌期'/… にフォールバックする）。
 */
function periodNoOf(label: string): number | null {
  const m = /第\s*([0-9０-９]+)\s*期/.exec(label || '')
  if (!m) return null
  const n = Number(m[1].replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)))
  return isFinite(n) && n > 0 ? n : null
}

/** 返済予定表の年度ラベル（i=0 が当期） */
function scheduleLabel(fy: FiscalYearData, i: number): string {
  const no = periodNoOf(fy.label)
  if (no != null) return i === 0 ? `第${no}期（当期）` : `第${no + i}期`
  return ['当期', '翌期', '2期後', '3期後'][i] ?? `${i}期後`
}

/** 簡易CF（税引後利益＋減価償却）の期首〜monthIdx累計。税率は年換算した経常利益で判定する */
function simpleCfYtdAt(fy: FiscalYearData, monthIdx: number): { afterTax: number; dep: number; source: number } {
  const months = monthIdx + 1
  const ord = ytd(fy, CODES.ordProfit, monthIdx)
  const rate = effectiveTaxRate(ord * (M / months))
  const afterTax = fin(ord * (1 - rate))
  const dep = fin(depreciationYtd(fy, monthIdx))
  return { afterTax, dep, source: afterTax + dep }
}

// ===== 本体 =====

/**
 * 借入金・返済原資・フリーCF（P7の指標カード／棒グラフ／内訳表／返済予定表）をまとめて作る。
 * @param prior 前期（厳密CFの期首残高に使う。無ければ当期の初月末を期首とみなす＝cashflow.ts の既定）
 */
export function computeLoan(
  fy: FiscalYearData,
  prior: FiscalYearData | null,
  monthIdx: number,
  settings: KeieiSettings,
): LoanResult {
  // 実績のある月までに丸める（未入力月を当月として扱うと残高0で紙面が崩れるため）
  const last = fy.lastFilledIndex >= 0 && fy.lastFilledIndex < M ? fy.lastFilledIndex : M - 1
  const idx = Math.max(0, Math.min(last, M - 1, Math.floor(monthIdx) || 0))
  const months = idx + 1
  const annualFactor = M / months

  // ===== 有利子負債（既存の安全性タブと同じ判定・同じ除外設定） =====
  const s = safety(fy, idx, settings)
  const loanBal = fin(s.loans)
  const leaseBal = fin(s.leases)
  const interestBearing = loanBal + leaseBal

  // ===== 返済額（ユーザー入力の月額。BS残高の増減からは逆算しない） =====
  const monthlyRepay = fin((settings.repayLoanMonthly?.[fy.id] ?? 0) + (settings.repayLeaseMonthly?.[fy.id] ?? 0))
  const annualRepay = monthlyRepay * M

  // ===== 返済原資（簡易CF＝税引後利益＋減価償却） =====
  const cf = simpleCfYtdAt(fy, idx)
  const afterTaxYtd = cf.afterTax
  const depYtd = cf.dep
  const sourceYtd = cf.source
  const afterTaxAnnual = afterTaxYtd * annualFactor
  const depAnnual = depYtd * annualFactor
  const sourceAnnual = sourceYtd * annualFactor

  // 返済後に残る資金（累計は経過月ぶんの返済、年換算は年間返済額と比べる）
  const restYtd = sourceYtd - monthlyRepay * months
  const restAnnual = sourceAnnual - annualRepay

  const coverage = annualRepay > 0 ? fin(sourceAnnual / annualRepay) : null
  const payoffYears = sourceAnnual > 0 ? fin(interestBearing / sourceAnnual) : null

  // ===== フリーCF（P4のキャッシュ・フロー計算書と同じ営業CF・投資CF） =====
  const flow = computeCashFlow(fy, prior, idx)
  const subtotalOf = (key: 'op' | 'inv' | 'fin'): number =>
    fin(flow.sections.find((x) => x.key === key)?.subtotal ?? 0)
  const operatingCf = subtotalOf('op')
  const investingCf = subtotalOf('inv')
  const fcf = operatingCf + investingCf

  // ===== 月次の残高と返済原資（棒＝残高／線＝簡易CFの月平均） =====
  // 残高はカードの当月値と一致させるため、safety() と同じ除外設定で科目を絞ってから合算する
  const { loans, leases } = debtAccounts(fy)
  const excluded = settings.loanExclude || {}
  const debtCodes = [...loans, ...leases].filter((a) => !excluded[a.code]).map((a) => a.code)
  const monthsRows: LoanMonth[] = []
  for (let i = 0; i <= idx; i++) {
    const balance = debtCodes.reduce((sum, code) => sum + singleMonth(fy, code, i), 0)
    // その月までの簡易CF ÷ 経過月数 ＝ 「1か月あたりいくら返済原資を生んでいるか」。
    // 単月の利益は季節変動が大きく線がぶれるので、累計の月平均でならす
    const c = simpleCfYtdAt(fy, i)
    const hasPl = ytd(fy, CODES.sales, i) !== 0 || c.afterTax !== 0 || c.dep !== 0
    monthsRows.push({
      label: `${fy.fiscalMonths[i] ?? i + 1}月`,
      balance: fin(balance),
      repaySource: hasPl ? fin(c.source / (i + 1)) : null,
      current: i === idx,
    })
  }

  // ===== 来期以降の返済予定（約定返済が今のまま続く前提） =====
  // 当期末残高は「当月末残高 − 期末までの残り月ぶんの返済」。年間返済額を丸ごと引くと、
  // 当期にすでに返済した分まで二重に引くことになる
  const schedule: { label: string; repay: number; closing: number }[] = []
  let closing = Math.max(0, interestBearing - monthlyRepay * (M - months))
  schedule.push({ label: scheduleLabel(fy, 0), repay: annualRepay, closing })
  for (let i = 1; i < SCHEDULE_YEARS; i++) {
    // 残高より返済額が大きくなる期は、実際にはその期で完済する（マイナス残高は出さない）
    closing = Math.max(0, closing - annualRepay)
    schedule.push({ label: scheduleLabel(fy, i), repay: annualRepay, closing })
  }

  return {
    loanBal, leaseBal, interestBearing,
    annualRepay, monthlyRepay,
    sourceYtd, sourceAnnual,
    afterTaxYtd, afterTaxAnnual,
    depYtd, depAnnual,
    restYtd, restAnnual,
    coverage, payoffYears,
    fcf, operatingCf, investingCf,
    equityRatio: fin(s.equityRatio),
    months: monthsRows,
    schedule,
  }
}
