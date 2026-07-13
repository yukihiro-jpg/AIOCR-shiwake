// 会計監査: 対象月の元帳取引を、過去の元帳（直近2期＋進行期の過去月）の処理実績と
// 突合し、税務的に修正すべき可能性のある取引を抽出する（すべてブラウザ内・API不使用）。
//
// 判定ルール:
//  R1 税区分の逸脱   … 同じ科目×同じ摘要の取引が過去は一貫した税区分（課税10%等）なのに、
//                        対象月だけ異なる税区分（非課税/税なし/税率違い）になっている
//  R2 源泉徴収の漏れ … 過去は同じ摘要で預り金（源泉）の仕訳を伴っていたのに、
//                        対象月は源泉の仕訳が見当たらない
//  R3 補助金・保険金等の課税誤り … 補助金・助成金・保険金・共済金・還付金等の入金
//                        （原則 不課税/非課税）が課税として入力されている
//  R4 科目の相違     … 同じ摘要の取引が過去は一貫して別の科目に計上されている

import type { LedgerData, LedgerTx } from './ledger'
import { isPlAccount, isRevenueAccount, isBalanceRow } from './ledger'

export interface AuditFinding {
  rule: 'R1' | 'R2' | 'R3' | 'R4'
  ruleName: string
  date: string
  debitName: string
  creditName: string
  taxLabel: string // 消費税区分の表示（課税10% / 課税8% / 税なし 等）
  amount: number
  memo: string
  reason: string
}

export interface AuditResult {
  findings: AuditFinding[]
  targetLabel: string // 例: 2026年4月
  targetCount: number // 対象月の取引数（重複除去後）
  historyCount: number // 比較に使った過去取引数
  historyDesc: string // 比較対象の説明
}

// ---------- 取引の正規化（ブロック形式 → 仕訳1行の形） ----------

interface JournalLine {
  date: string
  ym: string // YYYY-MM
  debitName: string
  creditName: string
  amount: number
  memo: string
  taxRate: number | null
  taxCode: string
  plCode: string // PL側の科目コード（両側BSなら ''）
  plName: string
  plIsRevenue: boolean
}

const normMemo = (s: string) => s.replace(/[\s　]+/g, ' ').replace(/[0-9０-９]{4,}/g, '#').trim()

/** 元帳（科目ブロック形式）の取引を仕訳1行の形に正規化し、A側/B側の重複を除去する。
 *  税情報はPL側のブロックに付くため、重複統合時に税情報のある方を優先する。 */
export function toJournalLines(ledger: LedgerData): JournalLine[] {
  const map = new Map<string, JournalLine>()
  const isAgg = (code: string, name: string) => /複合|諸口/.test(name) || code === '997'
  for (const acc of ledger.accounts) {
    const accIsAgg = isAgg(acc.code, acc.name)
    for (const tx of acc.txs) {
      if (isBalanceRow(tx)) continue
      const amount = Math.max(tx.debit, tx.credit)
      if (!amount) continue
      const isDebit = tx.debit > 0
      const debitName = isDebit ? acc.name : tx.counterName
      const creditName = isDebit ? tx.counterName : acc.name
      const key = `${tx.date}|${amount}|${debitName}|${creditName}|${tx.memo}`
      // 複合仕訳の「複合」「諸口」（997）は実在の科目ではないため、どちら側でもPL側として扱わない
      const counterIsAgg = isAgg(tx.counterCode, tx.counterName)
      const plSide = (!accIsAgg && isPlAccount(acc.code))
        ? { code: acc.code, name: acc.name }
        : (!counterIsAgg && isPlAccount(tx.counterCode)) ? { code: tx.counterCode, name: tx.counterName } : { code: '', name: '' }
      const line: JournalLine = {
        date: tx.date,
        ym: tx.date.slice(0, 7),
        debitName,
        creditName,
        amount,
        memo: tx.memo,
        taxRate: tx.taxRate,
        taxCode: tx.taxCode || '',
        plCode: plSide.code,
        plName: plSide.name,
        plIsRevenue: plSide.code ? isRevenueAccount(plSide.code) : false,
      }
      const prev = map.get(key)
      if (!prev) map.set(key, line)
      else {
        // 税情報・PL側情報を持つ方で補完
        if (prev.taxRate == null && line.taxRate != null) { prev.taxRate = line.taxRate; prev.taxCode = line.taxCode }
        if (!prev.plCode && line.plCode) { prev.plCode = line.plCode; prev.plName = line.plName; prev.plIsRevenue = line.plIsRevenue }
      }
    }
  }
  return Array.from(map.values())
}

/** 税区分の表示ラベル（比較にも使う署名） */
export function taxSig(l: { taxRate: number | null; taxCode: string }): string {
  if (l.taxRate != null) return `課税${l.taxRate}%`
  if (l.taxCode) return `税CD${l.taxCode}`
  return '税なし'
}

// ---------- 監査本体 ----------

const SUBSIDY_RE = /補助金|助成金|給付金|協力金|交付金|支援金|奨励金|雇用調整|保険金|共済金|返戻|還付|見舞金|配当/
const WITHHOLDING_ACC_RE = /預り金|源泉/

export function auditMonth(
  target: LedgerData,
  ym: string, // 対象月 'YYYY-MM'
  history: LedgerData[], // 過去の元帳（対象期自身を含めてよい。対象月より前の月だけ使う）
): AuditResult {
  const targetLines = toJournalLines(target).filter((l) => l.ym === ym)
  // 比較対象: 過去元帳の全取引 ＋ 対象元帳の対象月より前の取引
  const histLines: JournalLine[] = []
  const seenLedger = new Set<LedgerData>()
  for (const led of [...history, target]) {
    if (seenLedger.has(led)) continue
    seenLedger.add(led)
    for (const l of toJournalLines(led)) {
      if (l.ym < ym) histLines.push(l)
    }
  }

  // --- ベースライン構築 ---
  // R1: PL科目×摘要 → 税署名の分布
  const taxBase = new Map<string, Map<string, number>>()
  // R4: 摘要 → PL科目の分布
  const acctBase = new Map<string, Map<string, number>>()
  // R2: 源泉預り金の仕訳を伴っていた摘要
  const withholdingMemos = new Set<string>()
  for (const l of histLines) {
    const mk = normMemo(l.memo)
    if (l.plCode && mk) {
      const k1 = `${l.plCode}|${mk}`
      let m1 = taxBase.get(k1)
      if (!m1) { m1 = new Map(); taxBase.set(k1, m1) }
      const sig = taxSig(l)
      m1.set(sig, (m1.get(sig) || 0) + 1)
      if (mk.length >= 3 && !l.plIsRevenue) {
        let m2 = acctBase.get(mk)
        if (!m2) { m2 = new Map(); acctBase.set(mk, m2) }
        m2.set(l.plName, (m2.get(l.plName) || 0) + 1)
      }
    }
    if (mk && (WITHHOLDING_ACC_RE.test(l.debitName) || WITHHOLDING_ACC_RE.test(l.creditName))) {
      withholdingMemos.add(mk)
    }
  }
  // 対象月内で源泉仕訳がある摘要（R2の除外用）
  const targetWithholdingMemos = new Set<string>()
  for (const l of targetLines) {
    const mk = normMemo(l.memo)
    if (mk && (WITHHOLDING_ACC_RE.test(l.debitName) || WITHHOLDING_ACC_RE.test(l.creditName))) targetWithholdingMemos.add(mk)
  }

  const findings: AuditFinding[] = []
  const push = (rule: AuditFinding['rule'], ruleName: string, l: JournalLine, reason: string) => {
    findings.push({
      rule, ruleName,
      date: l.date, debitName: l.debitName, creditName: l.creditName,
      taxLabel: taxSig(l), amount: l.amount, memo: l.memo, reason,
    })
  }

  const flaggedKeys = new Set<string>() // 同一取引に複数ルールが当たったら強い方（R2/R3）を優先

  // --- R3: 補助金・保険金等の課税処理（履歴不要の絶対ルール） ---
  for (const l of targetLines) {
    if (!l.plIsRevenue && !/雑収入|雑益/.test(l.plName)) continue
    if (!SUBSIDY_RE.test(l.memo)) continue
    if (l.taxRate == null) continue // 税なしなら問題なし
    push('R3', '補助金・保険金等の課税誤り', l,
      `摘要から補助金・助成金・保険金・還付金等の入金とみられます。これらは原則 不課税（対価性なし）ですが、課税${l.taxRate}%で入力されています。税区分をご確認ください。`)
    flaggedKeys.add(`${l.date}|${l.amount}|${l.memo}`)
  }

  // --- R2: 源泉徴収の漏れ ---
  for (const l of targetLines) {
    const mk = normMemo(l.memo)
    if (!mk || !l.plCode || l.plIsRevenue) continue
    if (!withholdingMemos.has(mk)) continue
    if (targetWithholdingMemos.has(mk)) continue
    const key = `${l.date}|${l.amount}|${l.memo}`
    if (flaggedKeys.has(key)) continue
    push('R2', '源泉徴収の処理漏れ疑い', l,
      `過去は同じ摘要「${l.memo}」の支払いで源泉所得税（預り金）の仕訳を伴っていましたが、対象月には源泉の仕訳が見当たりません。源泉徴収の処理漏れでないかご確認ください。`)
    flaggedKeys.add(key)
  }

  // --- R1: 税区分の逸脱 ---
  for (const l of targetLines) {
    const mk = normMemo(l.memo)
    if (!mk || !l.plCode) continue
    const key = `${l.date}|${l.amount}|${l.memo}`
    if (flaggedKeys.has(key)) continue
    const dist = taxBase.get(`${l.plCode}|${mk}`)
    if (!dist) continue
    const total = Array.from(dist.values()).reduce((s, v) => s + v, 0)
    if (total < 2) continue // 実績1件では判断しない
    let domSig = ''
    let domCount = 0
    for (const [sig, n] of Array.from(dist.entries())) { if (n > domCount) { domSig = sig; domCount = n } }
    if (domCount / total < 0.9) continue // 過去がブレている取引は対象外
    const cur = taxSig(l)
    if (cur === domSig) continue
    push('R1', '税区分の逸脱', l,
      `同じ科目（${l.plName}）×同じ摘要の取引は、過去${total}件中${domCount}件が「${domSig}」で処理されていますが、今回は「${cur}」になっています。入力誤りでないかご確認ください。`)
    flaggedKeys.add(key)
  }

  // --- R4: 科目の相違 ---
  for (const l of targetLines) {
    const mk = normMemo(l.memo)
    if (!mk || mk.length < 3 || !l.plCode || l.plIsRevenue) continue
    const key = `${l.date}|${l.amount}|${l.memo}`
    if (flaggedKeys.has(key)) continue
    const dist = acctBase.get(mk)
    if (!dist) continue
    const total = Array.from(dist.values()).reduce((s, v) => s + v, 0)
    if (total < 3) continue
    let domName = ''
    let domCount = 0
    for (const [name, n] of Array.from(dist.entries())) { if (n > domCount) { domName = name; domCount = n } }
    if (domCount / total < 0.9) continue
    if (domName === l.plName) continue
    push('R4', '科目の相違', l,
      `同じ摘要「${l.memo}」の取引は、過去${total}件中${domCount}件が「${domName}」に計上されていますが、今回は「${l.plName}」になっています。科目の付け替え誤りでないかご確認ください。`)
    flaggedKeys.add(key)
  }

  findings.sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount)
  const [y, m] = ym.split('-')
  return {
    findings,
    targetLabel: `${y}年${Number(m)}月`,
    targetCount: targetLines.length,
    historyCount: histLines.length,
    historyDesc: `${seenLedger.size}冊の元帳・${histLines.length.toLocaleString()}取引（対象月より前）`,
  }
}

// ---------- レポート（新規ウインドウ・印刷/PDF保存対応） ----------

const esc = (s: string) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const RULE_COLORS: Record<string, string> = { R1: '#b45309', R2: '#b91c1c', R3: '#b91c1c', R4: '#1d4ed8' }

export function buildAuditReportHtml(result: AuditResult, companyName: string): string {
  const now = new Date()
  const dateStr = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`
  const counts = new Map<string, number>()
  for (const f of result.findings) counts.set(f.ruleName, (counts.get(f.ruleName) || 0) + 1)
  const rows = result.findings.map((f) => `<tr>
    <td class="tc"><span class="tag" style="background:${RULE_COLORS[f.rule]}">${esc(f.ruleName)}</span></td>
    <td class="tc">${esc(f.date.replace(/-/g, '/'))}</td>
    <td class="tl">${esc(f.debitName)}</td>
    <td class="tl">${esc(f.creditName)}</td>
    <td class="tc">${esc(f.taxLabel)}</td>
    <td class="tr">${f.amount.toLocaleString()}</td>
    <td class="tl">${esc(f.memo)}</td>
    <td class="tl reason">${esc(f.reason)}</td>
  </tr>`).join('\n')
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">
<title>会計監査_${esc(companyName)}_${esc(result.targetLabel)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Noto Sans JP", "Hiragino Sans", "Yu Gothic", Meiryo, sans-serif; color: #243042; padding: 24px; font-size: 11px; }
  .eyebrow { font-size: 10px; letter-spacing: 4px; color: #c8a24b; font-weight: 700; }
  h1 { font-size: 24px; font-weight: 800; color: #1f3a5f; letter-spacing: 2px; margin: 2px 0; }
  .head-sub { font-size: 12px; color: #5b6675; }
  .rule { height: 3px; margin: 10px 0 14px; background: linear-gradient(90deg,#1f3a5f 0%,#1f3a5f 72%,#c8a24b 72%,#c8a24b 100%); }
  .summary { margin-bottom: 14px; padding: 10px 14px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; font-size: 12px; line-height: 1.8; }
  table { width: 100%; border-collapse: collapse; }
  thead th { background: #1f3a5f; color: #fff; font-weight: 700; padding: 6px; border: 1px solid #1f3a5f; font-size: 10px; position: sticky; top: 0; }
  td { padding: 5px 6px; border: 1px solid #d3dae3; vertical-align: top; }
  tbody tr:nth-child(even) td { background: #f6f8fb; }
  .tl { text-align: left; } .tr { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; } .tc { text-align: center; white-space: nowrap; }
  .tag { display: inline-block; color: #fff; border-radius: 999px; padding: 2px 8px; font-size: 9px; font-weight: 700; white-space: nowrap; }
  .reason { min-width: 260px; color: #374151; }
  .note { font-size: 9.5px; color: #7b8698; margin-top: 14px; line-height: 1.7; }
  .toolbar { margin-bottom: 14px; }
  .toolbar button { padding: 8px 18px; font-size: 13px; font-weight: 700; border: none; border-radius: 8px; cursor: pointer; background: #1f3a5f; color: #fff; }
  .ok { padding: 30px; text-align: center; color: #15803d; font-size: 15px; font-weight: 700; }
  @media print { .toolbar { display: none; } body { padding: 0; } @page { size: A4 landscape; margin: 12mm 10mm; } }
</style></head><body>
  <div class="toolbar"><button onclick="window.print()">🖨 印刷 / PDF保存</button></div>
  <div class="eyebrow">ACCOUNTING AUDIT</div>
  <h1>会計監査 — 異常・修正候補リスト</h1>
  <div class="head-sub"><b>${esc(companyName)}</b>　／　対象月 ${esc(result.targetLabel)}　／　作成日 ${esc(dateStr)}</div>
  <div class="rule"></div>
  <div class="summary">
    対象月の取引 <b>${result.targetCount.toLocaleString()}件</b> を、過去実績（${esc(result.historyDesc)}）と突合しました。
    検出 <b style="color:#b91c1c">${result.findings.length}件</b>
    ${Array.from(counts.entries()).map(([n, c]) => `／ ${esc(n)} <b>${c}件</b>`).join(' ')}
  </div>
  ${result.findings.length === 0 ? '<div class="ok">✓ 修正候補は検出されませんでした</div>' : `
  <table>
    <thead><tr>
      <th>区分</th><th>取引日</th><th>借方科目</th><th>貸方科目</th><th>消費税区分</th><th>金額</th><th>摘要</th><th>理由</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`}
  <div class="note">
    ※ 本リストは元帳データの機械的な突合による「確認のおすすめ」であり、誤りと断定するものではありません（取引内容の変化により正しく区分が変わる場合があります）。<br>
    ※ 判定基準 — 税区分の逸脱: 同一科目×同一摘要で過去2件以上・9割以上が同じ税区分のとき、それと異なる処理を検出。
    源泉徴収: 過去に預り金（源泉）仕訳を伴った摘要で、対象月に源泉仕訳がないものを検出。
    補助金・保険金等: 摘要のキーワード（補助金・助成金・給付金・保険金・共済金・返戻・還付・配当等）を含む入金が課税処理されているものを検出。
    科目の相違: 同一摘要で過去3件以上・9割以上が同じ科目のとき、異なる科目への計上を検出。<br>
    ※ データはすべてこの端末内で処理され、外部・AIには送信されません。
  </div>
</body></html>`
}
