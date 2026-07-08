// ============================================================
// 経営課題の自動検出（ハイブリッド方式のテンプレートロジック側）
//
// 設計方針（ユーザー合意済み）:
// - 課題の「検出」と「数値」はすべてこのファイルの確定的なロジックで行う。
//   AI（Gemini）は buildIssuesStory が組み立てた文章の言い回しを整えるだけで、
//   数値の計算・課題の判定には一切関与しない（ハルシネーション対策）。
// - 判定の閾値は中小企業の実務でよく使われる目安を採用し、各判定に
//   「何が起きているか」「なぜ問題か」「典型的な打ち手」まで含めた
//   コメントを付ける（社長がそのまま読める文章にする）。
// - 対応パターンはできるだけ広く: 売上・粗利率・販管費・営業利益・
//   損益分岐点・労働分配率・資金・回転日数・借入・自己資本・予算・
//   債務超過・償却前赤字 など。データが無い項目は黙ってスキップする。
// ============================================================

import type { FiscalYearData } from './types'
import { CODES, getRow, ytd, plKpisYtd, findPriorYear } from './calc'
import {
  cvp, safety, workingCapital, detailsOf, rowYtd,
  type KeieiSettings, type YearBudget,
} from './analysis'
import { budgetVsActual } from './budget'

// ---------- 共通型 ----------

export type IssueSeverity = 'danger' | 'warn' | 'good'
export interface Issue {
  severity: IssueSeverity
  category: string // 表示用の分類ラベル（売上・粗利率・資金…）
  title: string    // 1行の見出し（数値入り）
  body: string     // 充実した解説コメント（現象→影響→打ち手）
}

// ---------- 労働分配率 ----------

// 人件費とみなす科目名（販管費・売上原価の明細から名称一致で拾う）。
// 「福利厚生費」は交際的な支出も混ざり得るが、実務の労働分配率計算では
// 人件費に含めるのが一般的なので含める。役員報酬も含む（総人件費ベース）。
const LABOR_RE = /役員報酬|役員賞与|給料|給与|賃金|賞与|雑給|法定福利|福利厚生|退職金|退職給付|人件費|労務費|専従者給与/

export interface LaborResult {
  labor: number        // 期首〜選択月の人件費累計
  gross: number        // 同 粗利
  share: number | null // 労働分配率（%）＝人件費÷粗利
  priorShare: number | null
  prior2Share: number | null
  accounts: { name: string; amount: number }[] // 拾った科目の内訳（透明性のため画面に出す）
}

function laborYtd(fy: FiscalYearData, monthIdx: number): { total: number; accounts: { name: string; amount: number }[] } {
  const accounts: { name: string; amount: number }[] = []
  let total = 0
  for (const a of [...detailsOf(fy, CODES.sgna), ...detailsOf(fy, CODES.cogs)]) {
    if (LABOR_RE.test(a.name)) {
      const v = rowYtd(a, monthIdx)
      if (v) { accounts.push({ name: a.name.trim(), amount: v }); total += v }
    }
  }
  return { total, accounts }
}

export function laborShare(
  years: Record<string, FiscalYearData>, fy: FiscalYearData, monthIdx: number,
): LaborResult {
  const { total, accounts } = laborYtd(fy, monthIdx)
  const gross = ytd(fy, CODES.grossProfit, monthIdx)
  const prior = findPriorYear(years, fy)
  const prior2 = prior ? findPriorYear(years, prior) : null
  const shareOf = (y: FiscalYearData | null): number | null => {
    if (!y) return null
    const idx = Math.min(monthIdx, y.lastFilledIndex)
    const l = laborYtd(y, idx).total
    const g = ytd(y, CODES.grossProfit, idx)
    return g > 0 && l > 0 ? (l / g) * 100 : null
  }
  return {
    labor: total, gross,
    share: gross > 0 && total > 0 ? (total / gross) * 100 : null,
    priorShare: shareOf(prior),
    prior2Share: shareOf(prior2),
    accounts: accounts.sort((a, b) => b.amount - a.amount),
  }
}

// ---------- 感度分析（もし〜なら営業利益はいくら変わるか） ----------

export interface SensScenario {
  label: string
  deltaAnnual: number // 営業利益への年間インパクト（年換算）
  note: string        // 前提の説明
}
export interface SensResult {
  months: number
  scenarios: SensScenario[]
  base: { salesAnnual: number; opAnnual: number; marginalRate: number }
}

/** CVP（変動費・固定費の分解）を使った感度分析。すべて年換算で表示する */
export function sensitivity(fy: FiscalYearData, monthIdx: number, settings: KeieiSettings): SensResult {
  const c = cvp(fy, monthIdx, settings)
  const months = monthIdx + 1
  const af = 12 / months
  const salesAnnual = c.sales * af
  const scenarios: SensScenario[] = [
    {
      label: '販売価格を1%値上げ（数量は同じ）',
      deltaAnnual: salesAnnual * 0.01,
      note: '値上げ分がそのまま利益になる。全打ち手の中で最も効きやすい',
    },
    {
      label: '販売数量を1%増やす（価格は同じ）',
      deltaAnnual: salesAnnual * 0.01 * c.marginalRate,
      note: '増えた売上のうち限界利益率分だけ利益になる',
    },
    {
      label: '変動費（仕入・原価）を1%削減',
      deltaAnnual: c.variable * af * 0.01,
      note: '仕入価格の交渉・ロス削減など。売上規模に応じて効果が変わる',
    },
    {
      label: '固定費を年100万円削減',
      deltaAnnual: 1_000_000,
      note: '家賃・保険・サブスクなどの見直し。削減額がそのまま利益になる',
    },
    {
      label: '売上が10%減少した場合（リスク）',
      deltaAnnual: -(salesAnnual * 0.10 * c.marginalRate),
      note: '主要取引先の離脱や景気悪化を想定した下振れリスクの目安',
    },
  ]
  return { months, scenarios, base: { salesAnnual, opAnnual: c.opProfit * af, marginalRate: c.marginalRate } }
}

// ---------- 借入返済能力 ----------

export interface DebtResult {
  loanBal: number; leaseBal: number
  simpleCfAnnual: number   // 簡易CF（税引後利益＋減価償却）年換算
  annualRepay: number      // 年間返済額（ユーザー入力の月額×12）
  hasRepayInput: boolean
  payoffYears: number | null  // 債務償還年数 ＝ 有利子負債 ÷ 簡易CF
  coverage: number | null     // 簡易CF ÷ 年間返済額（1未満は返済原資不足）
  equityRatio: number
  liquidityMonths: number
}

export function debtService(
  fy: FiscalYearData, monthIdx: number, settings: KeieiSettings, yearId: string,
): DebtResult {
  const s = safety(fy, monthIdx, settings)
  const monthlyRepay = (settings.repayLoanMonthly?.[yearId] || 0) + (settings.repayLeaseMonthly?.[yearId] || 0)
  const annualRepay = monthlyRepay * 12
  return {
    loanBal: s.loans, leaseBal: s.leases,
    simpleCfAnnual: s.simpleCfAnnual,
    annualRepay, hasRepayInput: monthlyRepay > 0,
    payoffYears: s.payoffLoansLease,
    coverage: annualRepay > 0 ? s.simpleCfAnnual / annualRepay : null,
    equityRatio: s.equityRatio,
    liquidityMonths: s.liquidityMonths,
  }
}

// ---------- 課題の自動検出（テンプレートロジック本体） ----------

const fmtS = (n: number): string => {
  const sign = n < 0 ? '−' : ''
  const a = Math.abs(n)
  if (a >= 100000000) { const oku = a / 100000000; return `${sign}${oku >= 10 ? Math.round(oku).toLocaleString() : oku.toFixed(1)}億円` }
  if (a >= 10000) return `${sign}${Math.round(a / 10000).toLocaleString()}万円`
  return `${sign}${Math.round(a).toLocaleString()}円`
}
const pt = (n: number): string => `${n >= 0 ? '+' : ''}${n.toFixed(1)}pt`
const pc = (n: number): string => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`

export interface IssuesInput {
  years: Record<string, FiscalYearData>
  fy: FiscalYearData
  monthIdx: number
  settings: KeieiSettings
  yearId: string
  budget?: YearBudget
}

export interface IssuesResult {
  issues: Issue[]
  labor: LaborResult
  debt: DebtResult
  sens: SensResult
  monthLabel: string
}

export function detectIssues(input: IssuesInput): IssuesResult {
  const { years, fy, monthIdx, settings, yearId, budget } = input
  const issues: Issue[] = []
  const push = (severity: IssueSeverity, category: string, title: string, body: string) =>
    issues.push({ severity, category, title, body })

  const monthLabel = `${fy.fiscalMonths[monthIdx]}月`
  const prior = findPriorYear(years, fy)
  const prior2 = prior ? findPriorYear(years, prior) : null
  const cur = plKpisYtd(fy, monthIdx)
  // 前期・前々期は「同じ経過月数」で比較する（期中でも公平な前年同期比になる）
  const kpiAt = (y: FiscalYearData | null): ReturnType<typeof plKpisYtd> | null =>
    y ? plKpisYtd(y, Math.min(monthIdx, y.lastFilledIndex)) : null
  const pre = kpiAt(prior)
  const pre2 = kpiAt(prior2)
  const months = monthIdx + 1
  const af = 12 / months

  // ===== 1. 売上高（前年同期比・2期連続減） =====
  if (pre && pre.sales > 0) {
    const g = ((cur.sales - pre.sales) / pre.sales) * 100
    const twoDown = !!(pre2 && pre2.sales > 0 && pre.sales < pre2.sales && cur.sales < pre.sales)
    if (twoDown) {
      push('danger', '売上', `売上が2期連続で減少しています（前年同期比 ${pc(g)}）`,
        `前々期→前期→当期と売上の減少が続いています。一時的な反動ではなく、主要顧客の減少・単価下落・競合流出など構造的な要因が疑われます。売上を「客数×単価×頻度」に分解し、どこが減っているかを特定するのが第一歩です。既存客への再アプローチと値付けの見直しを、固定費の削減より先に検討してください。`)
    } else if (g <= -10) {
      push('danger', '売上', `売上が前年同期比 ${pc(g)} と大きく減少しています`,
        `期首〜${monthLabel}の売上は前年同期の ${fmtS(pre.sales)} から ${fmtS(cur.sales)} へ減少しました。10%を超える減収は、固定費がそのままだと利益に直撃します。大口取引の減少か、全体的な減少かで打ち手が変わるため、まず得意先別・商品別の内訳確認を。あわせて後述の損益分岐点比率を確認し、赤字転落までの余裕を把握してください。`)
    } else if (g <= -3) {
      push('warn', '売上', `売上が前年同期比 ${pc(g)} の減少です`,
        `緩やかな減収ですが、物価上昇局面での減収は実質的にはより大きな目減りです。値上げ（単価改定）ができているか、取引量が減っていないかを切り分けて確認しましょう。`)
    } else if (g >= 5) {
      push('good', '売上', `売上は前年同期比 ${pc(g)} と好調です`,
        `増収を利益につなげられているか（粗利率・人件費とのバランス）を下記の項目で確認してください。増収時こそ、値引きの安売りで伸ばしていないかのチェックが重要です。`)
    }
  }

  // ===== 2. 粗利率 =====
  if (pre && cur.sales > 0 && pre.sales > 0) {
    const d = cur.grossMargin - pre.grossMargin
    const impact = cur.sales * (Math.abs(d) / 100) // 粗利率変化の金額インパクト（YTD）
    if (d <= -1) {
      push('danger', '粗利率', `粗利率が前年の ${pre.grossMargin.toFixed(1)}% から ${cur.grossMargin.toFixed(1)}%（${pt(d)}）に低下`,
        `この低下は期首〜${monthLabel}で約 ${fmtS(impact)} の利益押し下げに相当します。原因は主に「仕入・原価の上昇を価格に転嫁できていない」「安い案件の比率が増えた」「値引きの常態化」の3つです。原価が上がった分は勇気を持って価格改定するのが定石で、感度分析のとおり値上げ1%の利益インパクトは大きいです。`)
    } else if (d <= -0.3) {
      push('warn', '粗利率', `粗利率が前年同期比 ${pt(d)} と徐々に低下しています`,
        `小さな低下でも売上規模に掛かるため無視できません（YTDで約 ${fmtS(impact)} 相当）。仕入価格の推移と販売価格の改定時期を確認しておきましょう。`)
    } else if (d >= 1) {
      push('good', '粗利率', `粗利率が前年同期比 ${pt(d)} 改善しています（${cur.grossMargin.toFixed(1)}%）`,
        `価格転嫁・商品構成の改善が利益に効いています。この水準を維持できれば、期首〜${monthLabel}で約 ${fmtS(impact)} の増益要因です。`)
    }
  }

  // ===== 3. 販管費（費用先行・販管費率） =====
  if (pre && pre.sales > 0 && pre.sgna > 0) {
    const salesG = ((cur.sales - pre.sales) / pre.sales) * 100
    const sgnaG = ((cur.sgna - pre.sgna) / pre.sgna) * 100
    if (sgnaG > salesG + 3 && cur.sgna > pre.sgna) {
      push('warn', '販管費', `販管費の増加（${pc(sgnaG)}）が売上の伸び（${pc(salesG)}）を上回っています`,
        `販管費は前年同期の ${fmtS(pre.sgna)} から ${fmtS(cur.sgna)} に増えました。売上より速いペースの経費増は利益率を確実に削ります。「明細・経費」タブで増加している科目（人件費・広告・地代・保険あたりが典型）を特定し、先行投資なら回収時期を、そうでなければ削減余地を検討してください。`)
    }
  }

  // ===== 4. 営業利益 =====
  {
    if (cur.opProfit < 0) {
      push('danger', '営業利益', `本業が営業赤字です（期首〜${monthLabel}累計 ${fmtS(cur.opProfit)}）`,
        `本業で稼げていない状態で、放置すれば現預金が毎月減り続けます。まず損益分岐点（下記）と固定費の内訳を確認し、「粗利率の改善」「固定費の削減」「売上の底上げ」のどれが最短かを感度分析で見極めてください。資金面では手元資金の月商倍率も併せて確認を。`)
    } else if (pre && pre.opProfit > 0 && cur.opProfit < pre.opProfit * 0.5) {
      push('warn', '営業利益', `営業利益が前年同期の半分以下に減少（${fmtS(pre.opProfit)} → ${fmtS(cur.opProfit)}）`,
        `黒字は維持していますが減益幅が大きい状態です。売上・粗利率・販管費のどこで削られたか、上記の各項目とあわせて要因を分解してください。`)
    } else if (cur.sales > 0 && cur.opMargin >= 10) {
      push('good', '営業利益', `営業利益率 ${cur.opMargin.toFixed(1)}% は優良水準です`,
        `中小企業の平均的な営業利益率（2〜4%程度）を大きく上回っています。稼いだ利益の使い道（借入圧縮・投資・内部留保・役員報酬）を計画的に決める段階です。`)
    } else if (cur.sales > 0 && cur.opProfit > 0 && cur.opMargin < 1) {
      push('warn', '営業利益', `営業利益率が ${cur.opMargin.toFixed(1)}% と薄利です`,
        `黒字ですが、わずかな売上減や原価上昇で赤字に転落する水準です。損益分岐点比率と粗利率の項目を確認し、利益体質の改善余地を探ってください。`)
    }
  }

  // ===== 5. 損益分岐点 =====
  {
    const c = cvp(fy, monthIdx, settings)
    if (c.sales > 0 && c.bep > 0) {
      const ratio = (c.bep / c.sales) * 100
      if (ratio >= 100) {
        push('danger', '損益分岐点', `売上が損益分岐点に届いていません（分岐点比率 ${ratio.toFixed(0)}%）`,
          `現状の売上 ${fmtS(c.sales)}（累計）に対し、損益分岐点は ${fmtS(c.bep)} です。あと ${fmtS(c.bep - c.sales)} の売上増、または固定費 ${fmtS((c.sales - c.bep) * -1 * c.marginalRate)} 相当の削減が必要です。詳細は「損益分岐点・FCF分析」タブのシミュレーションで確認できます。`)
      } else if (ratio >= 90) {
        push('warn', '損益分岐点', `損益分岐点比率が ${ratio.toFixed(0)}% と余裕がありません`,
          `売上があと ${(100 - ratio).toFixed(0)}% 落ちると赤字という状態です。一般に80%台なら普通、70%台以下が優良とされます。固定費体質の見直しか粗利率の改善で、下振れへの耐性を高めておきましょう。`)
      } else if (ratio > 0 && ratio < 75) {
        push('good', '損益分岐点', `損益分岐点比率 ${ratio.toFixed(0)}% と収益体質は良好です`,
          `売上が${(100 - ratio).toFixed(0)}%落ちても赤字にならない体力があります。攻めの投資判断がしやすい状態です。`)
      }
    }
  }

  // ===== 6. 労働分配率 =====
  const labor = laborShare(years, fy, monthIdx)
  if (labor.share != null) {
    const d = labor.priorShare != null ? labor.share - labor.priorShare : null
    if (labor.share >= 70) {
      push('danger', '労働分配率', `労働分配率が ${labor.share.toFixed(0)}% と高すぎます（人件費 ${fmtS(labor.labor)} ÷ 粗利 ${fmtS(labor.gross)}）`,
        `稼いだ粗利の7割以上が人件費に消えており、家賃などの他の固定費や利益がほとんど残りません。一般に50%前後が健全、60%超で警戒とされます。人を減らすより先に、「粗利を増やす」（値上げ・単価改善・一人当たり売上の向上）方向での改善が現実的です。昇給・賞与・採用の判断は、この比率を見ながら行ってください。`)
    } else if (labor.share >= 60) {
      push('warn', '労働分配率', `労働分配率が ${labor.share.toFixed(0)}% とやや高めです`,
        `人件費 ${fmtS(labor.labor)} に対し粗利 ${fmtS(labor.gross)}。60%を超えると利益が残りにくくなります。賃上げ圧力が続く環境では、粗利（＝値付けと商品構成）の改善をセットで進めないと分配率は悪化し続けます。`)
    } else if (d != null && d >= 3) {
      push('warn', '労働分配率', `労働分配率が前年から ${pt(d)} 上昇しています（${labor.share.toFixed(0)}%）`,
        `水準としてはまだ許容範囲ですが、悪化ペースが速い点に注意。昇給・増員に粗利の伸びが追いついていない状態です。`)
    } else if (labor.share < 50 && labor.gross > 0) {
      push('good', '労働分配率', `労働分配率 ${labor.share.toFixed(0)}% は健全な水準です`,
        `粗利に対して人件費のバランスが取れており、昇給・採用の余力があります。人材確保が課題の環境では、計画的な処遇改善の原資として活かせます。`)
    }
  }

  // ===== 7. 手元資金（現預金月商倍率） =====
  {
    const s = safety(fy, monthIdx, settings)
    if (s.monthlySales > 0) {
      if (s.liquidityMonths < 1) {
        push('danger', '資金', `手元資金が月商の ${s.liquidityMonths.toFixed(1)}か月分しかありません（${fmtS(s.cash)}）`,
          `入金の遅れや突発支出で即座に資金繰りに窮する水準です。最低でも月商1.5か月、できれば2〜3か月分の確保が目安。利益改善を待たず、金融機関への相談（当座貸越枠・長期資金への借換え）を先に動かすべき状況です。`)
      } else if (s.liquidityMonths < 2) {
        push('warn', '資金', `手元資金は月商の ${s.liquidityMonths.toFixed(1)}か月分です（${fmtS(s.cash)}）`,
          `当面の支払いには足りますが、賞与月・納税月が重なると薄くなります。月商2か月分を下回らないよう、資金繰り表で3か月先までの山谷を確認しておきましょう。`)
      } else if (s.liquidityMonths >= 3) {
        push('good', '資金', `手元資金は月商の ${s.liquidityMonths.toFixed(1)}か月分と厚めです（${fmtS(s.cash)}）`,
          `不測の事態への耐性は十分です。過剰な現預金は収益を生まないため、借入金利との比較で繰上返済や投資への振り向けも選択肢になります。`)
      }
    }
  }

  // ===== 8. 売掛金・在庫の回転日数（前年同月末比較） =====
  if (prior && prior.lastFilledIndex >= Math.min(monthIdx, prior.lastFilledIndex)) {
    const pIdx = Math.min(monthIdx, prior.lastFilledIndex)
    const wcCur = workingCapital(fy, monthIdx)
    const wcPre = workingCapital(prior, pIdx)
    const daysCur = months * 30.4
    const daysPre = (pIdx + 1) * 30.4
    const recvDaysCur = cur.sales > 0 ? wcCur.recv / (cur.sales / daysCur) : null
    const recvDaysPre = pre && pre.sales > 0 ? wcPre.recv / (pre.sales / daysPre) : null
    if (recvDaysCur != null && recvDaysPre != null && recvDaysCur - recvDaysPre >= 15) {
      push('warn', '売掛金', `売掛金の回転日数が前年より ${(recvDaysCur - recvDaysPre).toFixed(0)}日 長くなっています（約${recvDaysCur.toFixed(0)}日）`,
        `売掛金残高は ${fmtS(wcCur.recv)}。回収が遅い取引の増加や、請求漏れ・入金遅延の滞留が疑われます。得意先別の売掛金年齢表で90日超の債権がないか確認を。回収が1か月遅れると、その分だけ運転資金の借入が必要になります。`)
    }
    const invDaysCur = cur.cogs > 0 ? wcCur.inv / (cur.cogs / daysCur) : null
    const invDaysPre = pre && pre.cogs > 0 ? wcPre.inv / (pre.cogs / daysPre) : null
    if (invDaysCur != null && invDaysPre != null && invDaysCur - invDaysPre >= 15) {
      push('warn', '在庫', `在庫の回転日数が前年より ${(invDaysCur - invDaysPre).toFixed(0)}日 長くなっています（約${invDaysCur.toFixed(0)}日）`,
        `在庫残高は ${fmtS(wcCur.inv)}。売れ筋の変化に仕入が追随できていないか、不良在庫の滞留が疑われます。在庫は置いておくだけで資金を寝かせ、保管費・廃棄ロスも生みます。動きの遅い在庫の処分（値引き販売でも現金化を優先）を検討してください。`)
    }
  }

  // ===== 9. 借入・返済能力 =====
  const debt = debtService(fy, monthIdx, settings, yearId)
  if (debt.loanBal + debt.leaseBal > 0) {
    if (debt.simpleCfAnnual <= 0) {
      push('danger', '借入', `借入 ${fmtS(debt.loanBal + debt.leaseBal)} に対し、返済原資（簡易CF）がマイナスです`,
        `利益＋減価償却で返済原資を生み出せておらず、返済のたびに手元資金が減る構造です。損益の改善が本筋ですが、当面は返済条件の見直し（リスケ・借換えによる月額返済の軽減）を金融機関に早めに相談することで時間を確保できます。相談は資金が枯渇する前に動くほど選択肢が多くなります。`)
    } else if (debt.payoffYears != null && debt.payoffYears > 10) {
      push('danger', '借入', `債務償還年数が ${debt.payoffYears.toFixed(1)}年 と過大です（目安10年以内）`,
        `有利子負債 ${fmtS(debt.loanBal + debt.leaseBal)} ÷ 簡易CF ${fmtS(debt.simpleCfAnnual)}/年。金融機関の融資審査でも10年超は「借りすぎ」と見られ、追加融資が受けにくくなります。新規の設備投資・借入は慎重に。利益体質の改善で分母（CF）を増やすことが最優先です。`)
    } else if (debt.payoffYears != null && debt.payoffYears > 7) {
      push('warn', '借入', `債務償還年数が ${debt.payoffYears.toFixed(1)}年 とやや長めです`,
        `10年以内には収まっていますが、5年以内が優良の目安です。今後大きな借入を予定している場合は、現在の利益水準で返せる範囲かを先に確認してください。`)
    } else if (debt.payoffYears != null && debt.payoffYears <= 5) {
      push('good', '借入', `債務償還年数 ${debt.payoffYears.toFixed(1)}年 と返済能力は良好です`,
        `簡易CFに対して借入が過大でなく、金融機関からの評価も得やすい水準です。必要な投資の資金調達余力があります。`)
    }
    if (debt.hasRepayInput && debt.coverage != null && debt.coverage < 1) {
      push('warn', '借入', `年間返済額 ${fmtS(debt.annualRepay)} に対し返済原資（簡易CF ${fmtS(debt.simpleCfAnnual)}）が不足しています`,
        `毎年の返済が稼ぐ力を上回っており、差額は手元資金の取り崩しか新規借入で埋めている状態です。長期資金への借換えで月額返済を軽くする、収益改善で原資を増やす、のいずれかが必要です。`)
    }
  }

  // ===== 10. 自己資本比率・債務超過 =====
  {
    const s = safety(fy, monthIdx, settings)
    const asset = getRow(fy, CODES.assetTotal)?.monthly[monthIdx] ?? 0
    const netAsset = getRow(fy, CODES.netAsset)?.monthly[monthIdx] ?? 0
    if (asset > 0) {
      if (netAsset < 0) {
        push('danger', '財務体質', `債務超過の状態です（純資産 ${fmtS(netAsset)}）`,
          `資産をすべて処分しても負債を返しきれない状態で、新規融資は原則として非常に困難になります。利益の積み上げによる解消計画（何年で解消するか）を数字で作り、金融機関と共有することが信頼維持の鍵です。役員借入金がある場合は資本性借入としての扱い（DES等）も検討余地があります。`)
      } else if (s.equityRatio < 10) {
        push('danger', '財務体質', `自己資本比率が ${s.equityRatio.toFixed(1)}% と脆弱です`,
          `わずかな赤字で債務超過に転落しかねない水準です（目安：30%以上で安定、10%未満は要警戒）。当面は利益を配当や過大な役員報酬で外に出さず、内部留保の積み増しを優先してください。`)
      } else if (s.equityRatio >= 50) {
        push('good', '財務体質', `自己資本比率 ${s.equityRatio.toFixed(1)}% と財務基盤は盤石です`,
          `外部環境の悪化に耐える体力が十分にあります。守りは固いので、成長投資へ資金を振り向ける余地があります。`)
      }
    }
  }

  // ===== 11. 償却前赤字（本業でCFが出ていない） =====
  {
    const s = safety(fy, monthIdx, settings)
    if (s.simpleCfYtd < 0) {
      push('danger', '資金創出力', `減価償却を足し戻しても資金がマイナスです（簡易CF累計 ${fmtS(s.simpleCfYtd)}）`,
        `「償却前赤字」と呼ばれる状態で、事業を続けるほど現金が減ります。単なる赤字（償却後）より一段深刻で、コスト構造の抜本的な見直し（不採算事業・拠点の整理、価格改定）が必要な段階です。`)
    }
  }

  // ===== 12. 予算との乖離（予算がある場合のみ） =====
  if (budget && budget.sales > 0) {
    const va = budgetVsActual(years, fy, monthIdx, budget)
    const sl = va.lines[0], op = va.lines[2]
    if (sl.achieveYtd != null && sl.achieveYtd < 90) {
      push('warn', '予算', `売上が予算比 ${sl.achieveYtd.toFixed(0)}% と未達です（差異 ${fmtS(sl.actualYtd - sl.budgetYtd)}）`,
        `期初の計画から1割以上下振れています。残り期間で挽回可能な差か、それとも予算自体を修正して固定費計画を見直すべきかの判断時期です。「予算・予実」タブの着地見込みを参考にしてください。`)
    } else if (op.achieveYtd != null && op.achieveYtd >= 100 && sl.achieveYtd != null && sl.achieveYtd >= 100) {
      push('good', '予算', `売上・営業利益とも予算を達成しています（売上 ${sl.achieveYtd.toFixed(0)}%・利益 ${op.achieveYtd.toFixed(0)}%）`,
        `計画どおり進捗しています。上振れ分の使い道（前倒し投資・借入圧縮・決算賞与等）を早めに検討すると、期末の打ち手の選択肢が広がります。`)
    }
  }

  // 重要度順（danger → warn → good）に並べる。同じ重要度内は検出順（＝損益→資金→財務の流れ）
  const order: Record<IssueSeverity, number> = { danger: 0, warn: 1, good: 2 }
  issues.sort((a, b) => order[a.severity] - order[b.severity])

  return { issues, labor, debt, sens: sensitivity(fy, monthIdx, settings), monthLabel }
}

// ---------- 総括ストーリー（テンプレ文。AI仕上げの入力になる） ----------

/** 検出結果から社長向けの総括文章を組み立てる（経営サマリーと同じマーカー書式） */
export function buildIssuesStory(r: IssuesResult, companyName: string): string {
  const dangers = r.issues.filter((i) => i.severity === 'danger')
  const warns = r.issues.filter((i) => i.severity === 'warn')
  const goods = r.issues.filter((i) => i.severity === 'good')
  const blocks: string[] = []
  blocks.push(`# 経営課題の総括（期首〜${r.monthLabel}）`)

  if (!dangers.length && !warns.length) {
    blocks.push(`【総評】\n自動チェック（売上・粗利率・経費・損益分岐点・労働分配率・資金・回転日数・借入・自己資本・予算）の範囲では、**急いで手を打つべき課題は検出されませんでした**。現状の良い点を維持しつつ、下記の感度分析を参考に次の一手（値上げ・投資・処遇改善など）を検討できる状態です。`)
  } else {
    blocks.push(`【総評】\n自動チェックの結果、**最優先で対応すべき課題が ${dangers.length}件**、注意して見ておくべき変化が ${warns.length}件 見つかりました。すべてを一度に直す必要はありません。以下の順番で、効果の大きいものから着手することをおすすめします。`)
  }
  if (dangers.length) {
    blocks.push(`【最優先の課題】\n` + dangers.map((i, n) => `${n + 1}. **${i.title}**\n${i.body}`).join('\n\n'))
  }
  if (warns.length) {
    blocks.push(`【注意すべき変化】\n` + warns.map((i, n) => `${n + 1}. **${i.title}**\n${i.body}`).join('\n\n'))
  }
  if (goods.length) {
    blocks.push(`【良い点（維持したい強み）】\n` + goods.map((i, n) => `${n + 1}. **${i.title}**\n${i.body}`).join('\n\n'))
  }
  // 打ち手の優先順位（感度分析の上位を提示）
  const top = [...r.sens.scenarios].filter((s) => s.deltaAnnual > 0).sort((a, b) => b.deltaAnnual - a.deltaAnnual).slice(0, 3)
  if (top.length) {
    blocks.push(`【打ち手の効果（年間の営業利益インパクト）】\n` +
      top.map((s, n) => `${n + 1}. ${s.label}：**約${fmtS(s.deltaAnnual)}**（${s.note}）`).join('\n') +
      `\n※ 期首〜${r.monthLabel}の実績を年換算した概算です。`)
  }
  return blocks.join('\n\n')
}
