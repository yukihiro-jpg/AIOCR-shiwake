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
//  R5 科目の税区分逸脱 … 科目全体の実績（95%以上が同じ税区分）から外れる取引（初出の摘要にも効く）
//  R6 少額資産の確認 … 消耗品費・修繕費等への10万円以上／40万円以上の支出（資産計上の要否）
//  R7 毎月定額の欠落・重複 … 毎月ほぼ同額の支払が対象月に無い／2回以上ある
//  R9 役員報酬の定期同額 … 役員報酬の月額が当期のこれまでの月額と異なる
//  R10 現金残高マイナス … 現金勘定の日次残高が対象月中にマイナス
//  R11 免税事業者等取引の一貫性 … 同一取引でインボイス経過措置フラグの有無が過去と異なる
//  R12 消費税マスタとの課税区分不一致 … 仕訳作成の科目別消費税マスタ（共有）で課税登録の
//      科目が税なし／対象外登録の科目が課税になっている取引（履歴が無くても・最初から
//      一貫して誤っている場合も検出できる）。税率(8/10)の妥当性は品目次第（軽減税率）の
//      ため R12 では判定せず、履歴ベースの R1/R5 に任せる。

import type { LedgerData, LedgerTx } from './ledger'
import { isPlAccount, isRevenueAccount, isBalanceRow } from './ledger'
import type { AccountTaxItem } from '@/lib/bank-statement/types'
import { getDefaultTaxCode } from '@/lib/bank-statement/account-master'

export interface AuditFinding {
  rule: string
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
  exempt: string // 免税事業者等取引フラグ（空=通常）
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
        exempt: tx.exempt || '',
        plCode: plSide.code,
        plName: plSide.name,
        plIsRevenue: plSide.code ? isRevenueAccount(plSide.code) : false,
      }
      const prev = map.get(key)
      if (!prev) map.set(key, line)
      else {
        // 税情報・PL側情報を持つ方で補完
        if (prev.taxRate == null && line.taxRate != null) { prev.taxRate = line.taxRate; prev.taxCode = line.taxCode }
        if (!prev.exempt && line.exempt) prev.exempt = line.exempt
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
  taxMaster?: AccountTaxItem[], // 仕訳作成の科目別消費税マスタ（あればR12が有効になる）
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
        // 「コード|科目名」をキーにして、理由文で「コード／科目名」を出せるようにする
        const cn = `${l.plCode}|${l.plName}`
        m2.set(cn, (m2.get(cn) || 0) + 1)
      }
    }
    if (mk && (WITHHOLDING_ACC_RE.test(l.debitName) || WITHHOLDING_ACC_RE.test(l.creditName))) {
      withholdingMemos.add(mk)
    }
  }
  // R2の理由用: 過去の (摘要×伝票日) ごとに、本体（PL科目）金額と源泉所得税（預り金）額を対にする。
  // 科目コード（預り金側含む）を得るため、生の元帳ブロックから集計する（複合仕訳の本体行と源泉行は
  // 同じ日付・摘要で分かれて計上されるため日付でまとめる）。
  interface WhPair { pl: number; wh: number; plName: string; plCode: string; plTaxRate: number | null; whName: string; whCode: string }
  const whPairGrp = new Map<string, WhPair>()
  const isAggCode = (code: string, name: string) => /複合|諸口/.test(name) || code === '997'
  const seenForWh = new Set<LedgerData>()
  for (const led of [...history, target]) {
    if (seenForWh.has(led)) continue
    seenForWh.add(led)
    for (const acc of led.accounts) {
      if (isAggCode(acc.code, acc.name)) continue
      const accIsWh = WITHHOLDING_ACC_RE.test(acc.name)
      const accIsPl = isPlAccount(acc.code) && !isRevenueAccount(acc.code)
      if (!accIsWh && !accIsPl) continue
      for (const tx of acc.txs) {
        if (isBalanceRow(tx)) continue
        if (tx.date.slice(0, 7) >= ym) continue // 対象月以降は使わない
        const mk = normMemo(tx.memo)
        if (!mk) continue
        const gk = `${mk}|${tx.date}`
        let e = whPairGrp.get(gk)
        if (!e) { e = { pl: 0, wh: 0, plName: '', plCode: '', plTaxRate: null, whName: '', whCode: '' }; whPairGrp.set(gk, e) }
        if (accIsWh && tx.credit > 0) { e.wh += tx.credit; e.whName = acc.name; e.whCode = acc.code }
        else if (accIsPl && tx.debit > 0) { e.pl += tx.debit; e.plName = acc.name; e.plCode = acc.code; if (tx.taxRate != null) e.plTaxRate = tx.taxRate }
      }
    }
  }
  const whPairsByMemo = new Map<string, WhPair[]>()
  for (const [gk, e] of Array.from(whPairGrp.entries())) {
    if (e.wh <= 0 || e.pl <= 0) continue
    const mk = gk.slice(0, gk.lastIndexOf('|'))
    const arr = whPairsByMemo.get(mk) || []
    arr.push(e)
    whPairsByMemo.set(mk, arr)
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
  // 理由文の科目表記は「コード／科目名」で統一する
  const acctLabel = (code: string, name: string) => (code ? `${code}／${name}` : name)
  const fmtCn = (cn: string) => { const i = cn.indexOf('|'); return i < 0 ? cn : acctLabel(cn.slice(0, i), cn.slice(i + 1)) }

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
    // 過去の同種取引のうち、本体金額が今回の金額に最も近いものを例示（本体は税込表記・源泉額・実効率）
    let detail = ''
    const pairs = whPairsByMemo.get(mk)
    if (pairs && pairs.length) {
      const best = pairs.reduce((a, b) => (Math.abs(b.pl - l.amount) < Math.abs(a.pl - l.amount) ? b : a))
      const rate = best.pl ? (best.wh / best.pl) * 100 : 0
      const gross = best.plTaxRate ? Math.round(best.pl * (1 + best.plTaxRate / 100)) : best.pl
      const grossLabel = best.plTaxRate ? `${gross.toLocaleString()}円（税込）` : `${gross.toLocaleString()}円`
      const whLabel = best.whCode ? acctLabel(best.whCode, best.whName) : (best.whName || '源泉所得税預り金')
      detail = `過去の同じ支払いでは（${acctLabel(best.plCode, best.plName)}）${grossLabel}に対し（${whLabel}） ${best.wh.toLocaleString()}円（本体の約${rate.toFixed(2)}%）を預り金に計上していました。`
    }
    push('R2', '源泉徴収の処理漏れ疑い', l,
      `過去は同じ摘要「${l.memo}」の支払いで源泉所得税（預り金）の仕訳を伴っていましたが、対象月には源泉の仕訳が見当たりません。${detail}源泉徴収の処理漏れでないかご確認ください。`)
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
      `同じ科目（${acctLabel(l.plCode, l.plName)}）×同じ摘要の取引は、過去${total}件中${domCount}件が「${domSig}」で処理されていますが、今回は「${cur}」になっています。入力誤りでないかご確認ください。`)
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
    let domCn = '' // 「コード|科目名」
    let domCount = 0
    for (const [cn, n] of Array.from(dist.entries())) { if (n > domCount) { domCn = cn; domCount = n } }
    if (domCount / total < 0.9) continue
    if (domCn === `${l.plCode}|${l.plName}`) continue
    push('R4', '科目の相違', l,
      `同じ摘要「${l.memo}」の取引は、過去${total}件中${domCount}件が「${fmtCn(domCn)}」に計上されていますが、今回は「${acctLabel(l.plCode, l.plName)}」になっています。科目の付け替え誤りでないかご確認ください。`)
    flaggedKeys.add(key)
  }

  // --- R5: 科目レベルの税区分逸脱（初出の摘要にも効く。R1で判定済みの取引は除外） ---
  {
    const acctTax = new Map<string, Map<string, number>>() // plCode → 税署名分布
    const acctName = new Map<string, string>()
    for (const l of histLines) {
      if (!l.plCode) continue
      let m1 = acctTax.get(l.plCode)
      if (!m1) { m1 = new Map(); acctTax.set(l.plCode, m1) }
      const sig = taxSig(l)
      m1.set(sig, (m1.get(sig) || 0) + 1)
      acctName.set(l.plCode, l.plName)
    }
    for (const l of targetLines) {
      if (!l.plCode) continue
      const key = `${l.date}|${l.amount}|${l.memo}`
      if (flaggedKeys.has(key)) continue
      const dist = acctTax.get(l.plCode)
      if (!dist) continue
      const total = Array.from(dist.values()).reduce((s, v) => s + v, 0)
      if (total < 10) continue // 科目の実績が少ないうちは判定しない
      let domSig = ''
      let domCount = 0
      for (const [sig, n] of Array.from(dist.entries())) { if (n > domCount) { domSig = sig; domCount = n } }
      if (domCount / total < 0.95) continue
      const cur = taxSig(l)
      if (cur === domSig) continue
      push('R5', '科目の税区分逸脱', l,
        `科目「${acctLabel(l.plCode, l.plName)}」の過去実績は${total}件中${domCount}件（${Math.round((domCount / total) * 100)}%）が「${domSig}」ですが、この取引は「${cur}」になっています。初めての取引先・内容の場合も含め、税区分をご確認ください。`)
      flaggedKeys.add(key)
    }
  }

  // --- R12: 消費税マスタとの課税区分不一致（履歴不要・最初から誤っている場合も検出） ---
  // 課税⇄非課税・不課税・対象外のクラス違いのみ判定する。税率(8/10)の違いは品目次第
  // （軽減税率対象か）でマスタからは断定できないため、履歴ベースの R1/R5 に任せる。
  if (taxMaster && taxMaster.length) {
    const NONTAX_CODES = new Set(['30', '40', '41']) // 非課税・不課税（会計大将の税区分CD）
    for (const l of targetLines) {
      if (!l.plCode) continue
      const key = `${l.date}|${l.amount}|${l.memo}`
      if (flaggedKeys.has(key)) continue
      const item = taxMaster.find((t) => t.accountCode === l.plCode)
      if (!item) continue // マスタ未登録の科目は判定しない
      // 期待される税区分: 科目の性質（収益/費用）をヒントに売上側/仕入側を選ぶ
      const expected = getDefaultTaxCode(taxMaster, l.plCode, l.plIsRevenue ? 'sales' : 'purchase')
      const expNoTax = item.categoryCode === '0' || (!!expected && NONTAX_CODES.has(expected.taxCode))
      // 取引側のクラス: 税率あり=課税 / 税CDなし or 非課税・不課税CD=税なし / それ以外=判定不能
      const lineTaxable = l.taxRate != null
      const lineNoTax = l.taxRate == null && (!l.taxCode || NONTAX_CODES.has(l.taxCode))
      if (expNoTax) {
        if (lineTaxable) {
          const expLabel = item.categoryCode === '0' ? '対象外' : `${expected?.taxName || '非課税・不課税'}`
          push('R12', 'マスタとの課税区分不一致', l,
            `仕訳作成の消費税マスタでは科目「${acctLabel(l.plCode, l.plName)}」は「${expLabel}」の登録ですが、この取引は課税${l.taxRate}%で入力されています。課税区分の誤りでないかご確認ください。`)
          flaggedKeys.add(key)
        }
      } else if (expected && !NONTAX_CODES.has(expected.taxCode)) {
        if (lineNoTax) {
          push('R12', 'マスタとの課税区分不一致', l,
            `仕訳作成の消費税マスタでは科目「${acctLabel(l.plCode, l.plName)}」は「${expected.taxName || '課税'}」（課税）の登録ですが、この取引は「${taxSig(l)}」になっています。課税処理の漏れでないかご確認ください。`)
          flaggedKeys.add(key)
        }
      }
    }
  }

  // --- R6: 少額資産・資産計上の確認（10万円以上／40万円以上の2段階） ---
  {
    const EXPENSE_RE = /消耗品|事務用品|工具|器具|備品|修繕|雑費/
    for (const l of targetLines) {
      if (!l.plCode || l.plIsRevenue) continue
      if (!EXPENSE_RE.test(l.plName)) continue
      if (l.amount >= 400000) {
        push('R6', '資産計上の確認（40万円以上）', l,
          `${l.plName}に40万円以上の支出があります。少額減価償却資産の特例（30万円未満）の対象外のため、固定資産計上（修繕費の場合は資本的支出への該当）の要否を必ずご確認ください。`)
      } else if (l.amount >= 100000) {
        push('R6', '資産計上の確認（10万円以上）', l,
          `${l.plName}に10万円以上の支出があります。固定資産・一括償却資産（20万円未満）・少額減価償却資産の特例（30万円未満・年300万円まで）のいずれで処理すべきかご確認ください。`)
      }
    }
  }

  // --- R7: 毎月定額の支払の欠落・重複 ---
  {
    // 直前6か月のうち4か月以上・ほぼ同額（ブレ25%以内）で出ている支払を「毎月定額」とみなす
    const prevYms: string[] = []
    {
      let [py, pm] = ym.split('-').map(Number)
      for (let k = 0; k < 6; k++) { pm--; if (pm === 0) { pm = 12; py-- } prevYms.push(`${py}-${String(pm).padStart(2, '0')}`) }
    }
    const prevSet = new Set(prevYms)
    const byKey = new Map<string, { byYm: Map<string, { n: number; sum: number }>; rep: JournalLine }>()
    for (const l of histLines) {
      const mk = normMemo(l.memo)
      if (!mk || mk.length < 2 || !l.plCode || l.plIsRevenue) continue
      if (!prevSet.has(l.ym)) continue
      const k = `${l.plCode}|${mk}`
      let e = byKey.get(k)
      if (!e) { e = { byYm: new Map(), rep: l }; byKey.set(k, e) }
      e.rep = l
      const cur = e.byYm.get(l.ym) || { n: 0, sum: 0 }
      cur.n++; cur.sum += l.amount
      e.byYm.set(l.ym, cur)
    }
    const targetByKey = new Map<string, JournalLine[]>()
    for (const l of targetLines) {
      const mk = normMemo(l.memo)
      if (!mk || !l.plCode) continue
      const k = `${l.plCode}|${mk}`
      const arr = targetByKey.get(k) || []
      arr.push(l)
      targetByKey.set(k, arr)
    }
    for (const [k, e] of Array.from(byKey.entries())) {
      const months = Array.from(e.byYm.values())
      if (months.length < 4) continue
      if (!months.every((v) => v.n === 1)) continue // 月1回の定期支払のみ対象
      const amts = months.map((v) => v.sum)
      const mean = amts.reduce((s, v) => s + v, 0) / amts.length
      if (mean < 5000) continue
      const sd = Math.sqrt(amts.reduce((s, v) => s + (v - mean) ** 2, 0) / amts.length)
      if (sd / mean > 0.25) continue
      const cur = targetByKey.get(k) || []
      if (cur.length === 0) {
        findings.push({
          rule: 'R7', ruleName: '毎月定額の計上漏れ疑い', date: ym,
          debitName: e.rep.plIsRevenue ? e.rep.debitName : e.rep.plName,
          creditName: e.rep.plIsRevenue ? e.rep.plName : e.rep.creditName,
          taxLabel: '—', amount: Math.round(mean), memo: e.rep.memo,
          reason: `直前6か月のうち${months.length}か月、毎月ほぼ同額（平均 ${Math.round(mean).toLocaleString()}円）で計上されている支払が、対象月には見当たりません。計上漏れ・請求書の未着でないかご確認ください。`,
        })
      } else if (cur.length >= 2) {
        for (const l of cur) {
          const key = `${l.date}|${l.amount}|${l.memo}`
          if (flaggedKeys.has(key)) continue
          push('R7', '毎月定額の二重計上疑い', l,
            `毎月1回・ほぼ同額で計上されている支払ですが、対象月には${cur.length}回計上されています。二重計上でないかご確認ください。`)
          flaggedKeys.add(key)
        }
      }
    }
  }

  // R8（年次定期支払の期ズレ検出）はユーザー指示により無効化（誤検知が多く検索対象から除外）

  // --- R9: 役員報酬の定期同額チェック（対象期内の月額比較） ---
  {
    const execAccs = target.accounts.filter((a) => isPlAccount(a.code) && /役員報酬|役員給与/.test(a.name))
    for (const acc of execAccs) {
      const byYm = new Map<string, number>()
      for (const tx of acc.txs) {
        if (isBalanceRow(tx)) continue
        const k = tx.date.slice(0, 7)
        byYm.set(k, (byYm.get(k) || 0) + (tx.debit - tx.credit))
      }
      const prior = Array.from(byYm.entries()).filter(([k, v]) => k < ym && v > 0).map(([, v]) => v)
      if (prior.length < 2) continue
      // 最頻値（定期同額の基準額）
      const freq = new Map<number, number>()
      for (const v of prior) freq.set(v, (freq.get(v) || 0) + 1)
      let mode = 0, modeN = 0
      for (const [v, n] of Array.from(freq.entries())) { if (n > modeN) { mode = v; modeN = n } }
      if (modeN < 2) continue
      const cur = byYm.get(ym) || 0
      if (cur === mode) continue
      findings.push({
        rule: 'R9', ruleName: '役員報酬の定期同額', date: ym,
        debitName: acc.name, creditName: '—', taxLabel: '—',
        amount: cur, memo: '（月次合計の比較）',
        reason: cur === 0
          ? `当期のこれまでの${acc.name}は月額 ${mode.toLocaleString()}円ですが、対象月は計上がありません。計上漏れでないかご確認ください。`
          : `当期のこれまでの${acc.name}は月額 ${mode.toLocaleString()}円ですが、対象月は ${cur.toLocaleString()}円です。定期同額給与から外れると増減部分が損金不算入となる可能性があります（改定事由・時期をご確認ください）。`,
      })
    }
  }

  // --- R10: 現金残高のマイナス検出（対象月中の日次残高） ---
  {
    const cashAccs = target.accounts.filter((a) => Number(a.code) < 200 && /現金/.test(a.name))
    for (const acc of cashAccs) {
      const byDate = new Map<string, number>()
      for (const tx of acc.txs) {
        if (isBalanceRow(tx)) continue
        byDate.set(tx.date, (byDate.get(tx.date) || 0) + (tx.debit - tx.credit))
      }
      const dates = Array.from(byDate.keys()).sort()
      let bal = acc.opening
      let worst: { date: string; bal: number } | null = null
      for (const d of dates) {
        bal += byDate.get(d) || 0
        if (d.slice(0, 7) === ym && bal < 0 && (!worst || bal < worst.bal)) worst = { date: d, bal }
      }
      if (worst) {
        findings.push({
          rule: 'R10', ruleName: '現金残高マイナス', date: worst.date,
          debitName: acc.name, creditName: '—', taxLabel: '—',
          amount: Math.abs(worst.bal), memo: '（日次残高の検算）',
          reason: `${acc.name}の帳簿残高が ${worst.date.replace(/-/g, '/')} 時点で ${worst.bal.toLocaleString()}円とマイナスです。入金の計上漏れ・日付の前後・二重出金の可能性が高く、現金出納の信頼性に関わるため優先的にご確認ください。`,
        })
      }
    }
  }

  // --- R11: 免税事業者等取引（インボイス経過措置）の一貫性 ---
  {
    const base = new Map<string, { flagged: number; total: number }>()
    for (const l of histLines) {
      const mk = normMemo(l.memo)
      if (!mk || !l.plCode || l.plIsRevenue) continue
      const k = `${l.plCode}|${mk}`
      const e = base.get(k) || { flagged: 0, total: 0 }
      e.total++
      if (l.exempt) e.flagged++
      base.set(k, e)
    }
    for (const l of targetLines) {
      const mk = normMemo(l.memo)
      if (!mk || !l.plCode || l.plIsRevenue) continue
      const key = `${l.date}|${l.amount}|${l.memo}`
      if (flaggedKeys.has(key)) continue
      const e = base.get(`${l.plCode}|${mk}`)
      if (!e || e.total < 2) continue
      if (e.flagged / e.total >= 0.9 && !l.exempt) {
        push('R11', '免税事業者等取引の一貫性', l,
          `過去は同じ取引を「免税事業者等取引」（インボイス経過措置）として処理していましたが（${e.total}件中${e.flagged}件）、今回はフラグがありません。相手先が適格請求書発行事業者になった場合を除き、経過措置（控除制限）の適用漏れでないかご確認ください。`)
        flaggedKeys.add(key)
      } else if (e.flagged === 0 && l.exempt) {
        push('R11', '免税事業者等取引の一貫性', l,
          `過去は同じ取引を通常の課税仕入として処理していましたが（${e.total}件）、今回は「免税事業者等取引」フラグが付いています。フラグの付け誤りでないかご確認ください。`)
        flaggedKeys.add(key)
      }
    }
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

const monthLabel = (ym: string) => { const [y, m] = ym.split('-'); return `${y}年${Number(m)}月` }

/** 範囲監査: ymFrom〜ymTo の各月を、それぞれ「その月より前の全実績」と突合して結果をまとめる。
 *  各ルールの基準（過去実績）は月ごとに正しく積み上がる（範囲内の前の月も基準に含む）。 */
export function auditRange(
  target: LedgerData,
  ymFrom: string,
  ymTo: string,
  history: LedgerData[],
  taxMaster?: AccountTaxItem[],
): AuditResult {
  let from = ymFrom, to = ymTo
  if (from > to) { const t = from; from = to; to = t }
  const months: string[] = []
  let [y, m] = from.split('-').map(Number)
  for (let guard = 0; guard < 60; guard++) {
    const ym = `${y}-${String(m).padStart(2, '0')}`
    months.push(ym)
    if (ym === to) break
    m++; if (m > 12) { m = 1; y++ }
  }
  const all: AuditFinding[] = []
  let targetCount = 0
  let histCount = 0
  for (const ym of months) {
    const r = auditMonth(target, ym, history, taxMaster)
    all.push(...r.findings)
    targetCount += r.targetCount
    histCount = Math.max(histCount, r.historyCount) // 最終月の基準規模を代表値に
  }
  all.sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount)
  const label = from === to ? monthLabel(from) : `${monthLabel(from)}〜${monthLabel(to)}`
  return {
    findings: all,
    targetLabel: label,
    targetCount,
    historyCount: histCount,
    historyDesc: months.length === 1
      ? `対象月より前の全実績`
      : `各月ごとに「その月より前の全実績」と突合（${months.length}か月分）`,
  }
}

// ---------- レポート（新規ウインドウ・印刷/PDF保存対応） ----------

const esc = (s: string) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const RULE_COLORS: Record<string, string> = {
  R1: '#b45309', R2: '#b91c1c', R3: '#b91c1c', R4: '#1d4ed8',
  R5: '#b45309', R6: '#7c3aed', R7: '#0e7490', R9: '#b91c1c', R10: '#b91c1c', R11: '#4d7c0f',
  R12: '#9d174d',
}

export function buildAuditReportHtml(result: AuditResult, companyName: string): string {
  const now = new Date()
  const dateStr = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`
  const counts = new Map<string, number>()
  for (const f of result.findings) counts.set(f.ruleName, (counts.get(f.ruleName) || 0) + 1)
  const rows = result.findings.map((f) => `<tr>
    <td class="tc"><span class="tag" style="background:${RULE_COLORS[f.rule] || '#6b7280'}">${esc(f.ruleName)}</span></td>
    <td class="tc">${esc(f.date.replace(/-/g, '/'))}</td>
    <td class="tl">${esc(f.debitName)}</td>
    <td class="tl">${esc(f.creditName)}</td>
    <td class="tc">${esc(f.taxLabel)}</td>
    <td class="tr">${f.amount.toLocaleString()}</td>
    <td class="tl">${esc(f.memo)}</td>
    <td class="tl reason">${esc(f.reason).replace(/。(?!$)/g, '。<br>')}</td>
  </tr>`).join('\n')
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">
<title>会計監査_${esc(companyName)}_${esc(result.targetLabel)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Noto Sans JP", "Hiragino Sans", "Yu Gothic", Meiryo, sans-serif; color: #243042; padding: 24px; font-size: 14px; }
  .eyebrow { font-size: 11px; letter-spacing: 4px; color: #c8a24b; font-weight: 700; }
  h1 { font-size: 26px; font-weight: 800; color: #1f3a5f; letter-spacing: 2px; margin: 2px 0; }
  .head-sub { font-size: 14px; color: #5b6675; }
  .rule { height: 3px; margin: 10px 0 16px; background: linear-gradient(90deg,#1f3a5f 0%,#1f3a5f 72%,#c8a24b 72%,#c8a24b 100%); }
  .summary { margin-bottom: 16px; padding: 12px 16px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; font-size: 14px; line-height: 1.9; }
  table { width: 100%; border-collapse: collapse; }
  thead th { background: #1f3a5f; color: #fff; font-weight: 700; padding: 9px 8px; border: 1px solid #1f3a5f; font-size: 13px; position: sticky; top: 0; }
  td { padding: 9px 8px; border: 1px solid #d3dae3; vertical-align: top; font-size: 13.5px; line-height: 1.6; }
  tbody tr:nth-child(even) td { background: #f6f8fb; }
  .tl { text-align: left; } .tr { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; } .tc { text-align: center; white-space: nowrap; }
  .tag { display: inline-block; color: #fff; border-radius: 999px; padding: 3px 10px; font-size: 12px; font-weight: 700; white-space: nowrap; }
  .reason { min-width: 320px; color: #374151; line-height: 1.7; }
  .note { font-size: 11.5px; color: #7b8698; margin-top: 16px; line-height: 1.8; }
  .toolbar { margin-bottom: 14px; }
  .toolbar button { padding: 9px 20px; font-size: 14px; font-weight: 700; border: none; border-radius: 8px; cursor: pointer; background: #1f3a5f; color: #fff; }
  .ok { padding: 32px; text-align: center; color: #15803d; font-size: 17px; font-weight: 700; }
  @media print { .toolbar { display: none; } body { padding: 0; } @page { size: A4 landscape; margin: 12mm 10mm; } }
</style></head><body>
  <div class="toolbar"><button onclick="window.print()">🖨 印刷 / PDF保存</button></div>
  <div class="eyebrow">ACCOUNTING AUDIT</div>
  <h1>会計監査 — 異常・修正候補リスト</h1>
  <div class="head-sub"><b>${esc(companyName)}</b>　／　対象 ${esc(result.targetLabel)}　／　作成日 ${esc(dateStr)}</div>
  <div class="rule"></div>
  <div class="summary">
    対象（${esc(result.targetLabel)}）の取引 <b>${result.targetCount.toLocaleString()}件</b> を、過去実績（${esc(result.historyDesc)}）と突合しました。
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
    科目の相違: 同一摘要で過去3件以上・9割以上が同じ科目のとき、異なる科目への計上を検出。
    科目の税区分逸脱: 科目全体の実績10件以上・95%以上が同じ税区分のとき、それと異なる処理を検出（初出の取引にも適用）。
    資産計上の確認: 消耗品費・修繕費等への1取引10万円以上（および40万円以上）の支出を検出。
    毎月定額: 直前6か月のうち4か月以上・月1回・ほぼ同額（ブレ25%以内）の支払の欠落／月2回以上の計上を検出。
    役員報酬: 当期の最頻月額と異なる月額（またはゼロ）を検出。
    現金残高: 現金勘定の日次残高が対象月中にマイナスとなる日を検出。
    免税事業者等取引: 同一取引でインボイス経過措置フラグの有無が過去（9割以上一貫）と異なるものを検出。<br>
    ※ データはすべてこの端末内で処理され、外部・AIには送信されません。
  </div>
</body></html>`
}
