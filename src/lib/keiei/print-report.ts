// 月次レポートの印刷用レポート生成。
// 選択タブを「1セクション＝横A4・1枚」に凝縮した報告書HTMLを組み立て、新規ウィンドウで
// 開いて印刷する（画面コンポーネントの流用はせず、lib の計算関数から直接生成する）。
// 表紙には選択した資料タイトルを「１．〇〇」の番号付きで自動記載する（未選択の資料は番号が繰り上がる）。
import type { FiscalYearData } from './types'
import { CODES, getRow, plKpisSingle, plKpisYtd, sortedYears, yoy } from './calc'
import { fmtShort, fmtPctSigned } from './format'
import {
  cvp, safety, fcfAnalysis, workingCapital, profitBridge, landingScenarios,
  detailsOf, rowYtd, debtAccounts, type KeieiSettings,
} from './analysis'
import { detectIssues, debtService, type IssuesResult } from './issues'
import { budgetVsActual, monthlyBudgetSeries } from './budget'
import { computeCashFlow } from './cashflow'

export type PrintView = 'overview' | 'budget' | 'report' | 'detail' | 'cvpfcf' | 'issues' | 'cash'

/** 印刷対象タブの定義（画面のタブ表示・印刷選択と共有する単一のソース） */
export const PRINT_VIEWS: [PrintView, string][] = [
  ['overview', '概要'],
  ['budget', '予算・予実'],
  ['report', '試算表・3期比較・推移'],
  ['detail', '原価・経費明細'],
  ['cvpfcf', '損益分岐点・キャッシュフロー'],
  ['issues', '経営課題'],
  ['cash', '資金繰り・安全性'],
]

export interface PrintReportInput {
  views: PrintView[]
  company: string
  fy: FiscalYearData
  prior: FiscalYearData | null
  years: Record<string, FiscalYearData>
  monthIdx: number
  settings: KeieiSettings
}

const NAVY = '#1f3a5f'
const GOLD = '#c8a24b'
const GREEN = '#1a7f37'
const RED = '#b91c1c'
const GRAY = '#94a3b8'

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
const cut = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1) + '…' : t)
const p1 = (n: number) => `${n.toFixed(1)}%`
/** 表中の金額表記（#,### 形式・円記号なし。負は全角マイナス） */
const num = (n: number) => {
  const v = Math.round(n)
  return (v < 0 ? '−' : '') + Math.abs(v).toLocaleString('ja-JP')
}
/** 符号付きの金額表記（差異・増減用） */
const sgnYen = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(Math.round(n)).toLocaleString('ja-JP')}`
const sgnShort = (n: number) => `${n >= 0 ? '＋' : '−'}${fmtShort(Math.abs(n))}`

/** 前年比の表記（黒字↔赤字の符号反転は文言で明示） */
function yoyText(value: number, priorV?: number | null): { label: string; tone: 'good' | 'bad' | 'muted' } | null {
  if (priorV == null) return null
  const diff = value - priorV
  if (priorV === 0) {
    if (value > 0) return { label: '前年0→黒字', tone: 'good' }
    if (value < 0) return { label: '前年0→赤字', tone: 'bad' }
    return { label: '±0', tone: 'muted' }
  }
  if (priorV < 0 && value >= 0) return { label: '黒字転換', tone: 'good' }
  if (priorV >= 0 && value < 0) return { label: '赤字転落', tone: 'bad' }
  if (priorV < 0 && value < 0) {
    const rate = (diff / Math.abs(priorV)) * 100
    return { label: `赤字${rate >= 0 ? '縮小' : '拡大'}${Math.abs(rate).toFixed(1)}%`, tone: rate >= 0 ? 'good' : 'bad' }
  }
  const rate = (diff / Math.abs(priorV)) * 100
  return { label: `${rate >= 0 ? '+' : '−'}${Math.abs(rate).toFixed(1)}%`, tone: rate >= 0 ? 'good' : 'bad' }
}
function yoyChip(value: number, priorV?: number | null): string {
  const y = yoyText(value, priorV)
  if (!y) return '<span class="chip m">前年なし</span>'
  const cls = y.tone === 'good' ? 'g' : y.tone === 'bad' ? 'd' : 'm'
  return `<span class="chip ${cls}">${esc(y.label)}</span>`
}

// ===== SVG ミニチャート =====
interface ComboSeries { type: 'bar' | 'line'; values: (number | null)[]; color: string; label: string; showValues?: boolean }

// 軸目盛り用のキリのよい刻み幅（1/2/5×10^n）
function niceStep(raw: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1))))
  const d = raw / p
  return (d <= 1 ? 1 : d <= 2 ? 2 : d <= 5 ? 5 : 10) * p
}

// 目盛り区間が minIntervals 以上になる、最も粗いキリのよい刻み幅（1/2/5×10^n）を選ぶ
function pickStep(range: number, minIntervals: number): number {
  const p0 = Math.pow(10, Math.ceil(Math.log10(Math.max(range, 1))))
  let last = p0
  for (let p = p0; p >= p0 / 10000; p /= 10) {
    for (const d of [5, 2, 1]) {
      const s = p * d
      if (Math.ceil(range / s) >= minIntervals) return s
      last = s
    }
  }
  return last
}

function svgCombo(labels: string[], series: ComboSeries[], w = 660, h = 185, minIntervals?: number): string {
  const all: number[] = [0]
  for (const s of series) for (const v of s.values) if (v != null && isFinite(v)) all.push(v)
  // 目盛り（約6個）がキリのよい数字になるよう、範囲を刻み幅の倍数に広げる
  const rawMin = Math.min(...all)
  const rawMax = Math.max(...all)
  const range = rawMax - rawMin || 1
  const step = minIntervals ? pickStep(range, minIntervals) : niceStep(range / 6)
  const min = Math.floor(rawMin / step) * step
  const max = Math.ceil(rawMax / step) * step || step
  const padT = 12, padB = 16, padL = 52, padR = 4
  const ih = h - padT - padB
  const iw = w - padL - padR
  const y = (v: number) => padT + ((max - v) / (max - min)) * ih
  const n = labels.length || 1
  const slot = iw / n
  const barSeries = series.filter((s) => s.type === 'bar')
  const bw = Math.max(3, Math.min(16, (slot * 0.72) / Math.max(1, barSeries.length)))
  let out = ''
  for (let v = min; v <= max + step / 2; v += step) {
    const isZero = Math.abs(v) < step / 2
    out += `<line x1="${padL}" x2="${w - padR}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="${isZero ? GRAY : '#e2e8f0'}" ${isZero ? 'stroke-width="1"' : 'stroke-dasharray="3 3"'}/>`
    out += `<text x="${padL - 4}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="#5b6675">${esc(isZero ? '0' : fmtShort(v))}</text>`
  }
  barSeries.forEach((s, bi) => {
    s.values.forEach((v, i) => {
      if (v == null || !isFinite(v)) return
      const cx = padL + slot * i + slot / 2
      const x = cx - (bw * barSeries.length) / 2 + bi * bw
      const y1 = y(Math.max(0, v))
      const y2 = y(Math.min(0, v))
      out += `<rect x="${x.toFixed(1)}" y="${y1.toFixed(1)}" width="${(bw - 1.2).toFixed(1)}" height="${Math.max(1, y2 - y1).toFixed(1)}" rx="1" fill="${s.color}"/>`
      // 実数値ラベル（棒の上／マイナスは下）
      if (s.showValues && v !== 0) {
        const tx = x + (bw - 1.2) / 2
        const ty = v >= 0 ? y1 - 3 : y2 + 9
        out += `<text x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" text-anchor="middle" font-size="8" font-weight="700" fill="${NAVY}">${esc(fmtShort(v))}</text>`
      }
    })
  })
  for (const s of series.filter((x) => x.type === 'line')) {
    const pts: string[] = []
    s.values.forEach((v, i) => {
      if (v == null || !isFinite(v)) return
      const cx = padL + slot * i + slot / 2
      pts.push(`${cx.toFixed(1)},${y(v).toFixed(1)}`)
      out += `<circle cx="${cx.toFixed(1)}" cy="${y(v).toFixed(1)}" r="2" fill="${s.color}"/>`
    })
    if (pts.length > 1) out += `<polyline points="${pts.join(' ')}" fill="none" stroke="${s.color}" stroke-width="1.8"/>`
  }
  labels.forEach((l, i) => {
    out += `<text x="${(padL + slot * i + slot / 2).toFixed(1)}" y="${h - 4}" text-anchor="middle" font-size="9" fill="#5b6675">${esc(l)}</text>`
  })
  const legend = series.map((s) => `<span style="color:${s.color}">${s.type === 'bar' ? '■' : '─●─'} ${esc(s.label)}</span>`).join('　')
  return `<div class="legend">${legend}</div><svg viewBox="0 0 ${w} ${h}" width="100%" preserveAspectRatio="xMidYMid meet">${out}</svg>`
}

function svgWaterfall(startLabel: string, startValue: number, steps: { label: string; delta: number }[], endLabel: string, endValue: number, w = 620, h = 185): string {
  interface It { label: string; from: number; to: number; color: string; total: boolean }
  const items: It[] = [{ label: startLabel, from: 0, to: startValue, color: NAVY, total: true }]
  let run = startValue
  for (const st of steps) { items.push({ label: st.label, from: run, to: run + st.delta, color: st.delta >= 0 ? GREEN : RED, total: false }); run += st.delta }
  items.push({ label: endLabel, from: 0, to: endValue, color: NAVY, total: true })
  const vals = items.flatMap((i) => [i.from, i.to, 0])
  const min = Math.min(...vals)
  const max = Math.max(...vals)
  const padT = 16, padB = 26, padL = 6, padR = 6
  const ih = h - padT - padB
  const range = max - min || 1
  const y = (v: number) => padT + ((max - v) / range) * ih
  const n = items.length
  const slot = (w - padL - padR) / n
  const bw = Math.min(slot * 0.62, 70)
  let out = `<line x1="0" x2="${w}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" stroke="#cbd5e1" stroke-width="1"/>`
  items.forEach((it, i) => {
    const x = padL + slot * i + (slot - bw) / 2
    const y1 = y(Math.max(it.from, it.to))
    const y2 = y(Math.min(it.from, it.to))
    out += `<rect x="${x.toFixed(1)}" y="${y1.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1.5, y2 - y1).toFixed(1)}" rx="2" fill="${it.color}" fill-opacity="${it.total ? '1' : '0.88'}"/>`
    const v = it.total ? it.to : it.to - it.from
    const vLabel = it.total ? fmtShort(v) : `${v >= 0 ? '+' : '−'}${fmtShort(Math.abs(v))}`
    out += `<text x="${(x + bw / 2).toFixed(1)}" y="${(y1 - 4).toFixed(1)}" text-anchor="middle" font-size="10.5" font-weight="700" fill="${it.color}">${esc(vLabel)}</text>`
    out += `<text x="${(x + bw / 2).toFixed(1)}" y="${h - padB + 13}" text-anchor="middle" font-size="9.5" fill="#5b6675">${esc(it.label)}</text>`
    if (i < n - 1) {
      const nx = padL + slot * (i + 1) + (slot - bw) / 2
      out += `<line x1="${(x + bw).toFixed(1)}" x2="${nx.toFixed(1)}" y1="${y(it.to).toFixed(1)}" y2="${y(it.to).toFixed(1)}" stroke="${GRAY}" stroke-dasharray="3 2" stroke-width="1"/>`
    }
  })
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" preserveAspectRatio="xMidYMid meet">${out}</svg>`
}

function svgBullet(value: number, max: number, zones: { to: number; color: string }[], w = 200, h = 14): string {
  let out = ''
  let from = 0
  for (const z of zones) {
    const x = (from / max) * w
    const ww = ((Math.min(z.to, max) - from) / max) * w
    out += `<rect x="${x.toFixed(1)}" y="3" width="${Math.max(0, ww).toFixed(1)}" height="${h - 6}" rx="2" fill="${z.color}"/>`
    from = z.to
  }
  const vx = (Math.max(0, Math.min(value, max)) / max) * w
  out += `<rect x="${Math.max(0, vx - 1.5).toFixed(1)}" y="0" width="3" height="${h}" rx="1" fill="#1f2937"/>`
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${out}</svg>`
}

// ===== 本体 =====
export function buildPrintReportHtml(input: PrintReportInput): string {
  const { views, company, fy, prior, years, monthIdx, settings } = input
  const monthLabel = `${fy.fiscalMonths[monthIdx]}月`
  const priorIdx = prior ? Math.min(monthIdx, prior.lastFilledIndex) : 0
  const single = plKpisSingle(fy, monthIdx)
  const pSingle = prior ? plKpisSingle(prior, priorIdx) : null
  const curY = plKpisYtd(fy, monthIdx)
  const preY = prior ? plKpisYtd(prior, priorIdx) : null
  const c = cvp(fy, monthIdx, settings)
  const s = safety(fy, monthIdx, settings)
  const land = landingScenarios(years, fy)
  const std = land.scenarios.find((x) => x.key === 'standard') || land.scenarios[0]
  const budget = settings.budgets?.[fy.id]
  const hasBudget = !!(budget && budget.sales > 0)
  const issuesResult: IssuesResult | null = (() => {
    try { return detectIssues({ years, fy, monthIdx, settings, yearId: fy.id, budget }) } catch { return null }
  })()
  const fcf = fcfAnalysis(fy, prior, monthIdx)
  const cashflow = computeCashFlow(fy, prior, monthIdx)
  const wc = workingCapital(fy, monthIdx)
  const debt = debtService(fy, monthIdx, settings, fy.id)
  const bepRatio = c.sales > 0 && c.bep > 0 ? (c.bep / c.sales) * 100 : null
  const labelOf = (v: PrintView) => PRINT_VIEWS.find(([k]) => k === v)?.[1] || ''
  const now = new Date()
  const dateStr = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`
  const monthLabels = fy.fiscalMonths.map((m) => `${m}月`)

  const pageHead = (no: number, title: string) => `
  <div class="p-head">
    <span class="p-no">${no}</span>
    <span class="p-title">${esc(title)}</span>
    <span class="p-meta">${esc(company)}　／　${esc(fy.label)}　${monthLabel}度</span>
  </div>`
  const pageFoot = `<div class="p-foot">${esc(company)}｜月次経営レポート｜${esc(fy.label)} ${monthLabel}度</div>`
  const page = (no: number, title: string, body: string) =>
    `<section class="page">${pageHead(no, title)}${body}${pageFoot}</section>`

  // ---------- 表紙 ----------
  const cover = `
<section class="page cover">
  <div class="cv-inner">
    <div class="eyebrow">MONTHLY MANAGEMENT REPORT</div>
    <h1 class="cv-title">月次経営レポート</h1>
    <div class="cv-rule"></div>
    <div class="cv-company">${esc(company)} 御中</div>
    <div class="cv-sub">${esc(fy.label)}　${monthLabel}度　／　作成日 ${dateStr}</div>
    <div class="cv-toc">
      <div class="cv-toc-title">CONTENTS ─ 収録資料</div>
      ${views.map((v, i) => `<div class="cv-toc-item"><span class="toc-no">${i + 1}．</span>${esc(labelOf(v))}</div>`).join('')}
    </div>
  </div>
</section>`

  // ---------- 1) 概要 ----------
  function pageOverview(no: number): string {
    const bridge = profitBridge(fy, prior, monthIdx)
    const opBudgetFull = hasBudget ? budget!.sales * (budget!.grossMargin / 100) - budget!.sgna : null
    const priorFullOp = prior ? (getRow(prior, CODES.opProfit)?.annual ?? null) : null
    const landCompare = opBudgetFull != null
      ? { label: '予算比', diff: std.opProfit - opBudgetFull }
      : priorFullOp != null ? { label: '前期比', diff: std.opProfit - priorFullOp } : null
    const yyOp = yoyText(single.opProfit, pSingle?.opProfit)
    const lead = `${monthLabel}単月の売上高は <b>${esc(fmtShort(single.sales))}</b>、営業利益は <b>${esc(fmtShort(single.opProfit))}</b>` +
      (yyOp ? `（前年同月比 ${esc(yyOp.label)}）` : '') +
      `。通期は${land.partial ? '標準シナリオで' : '確定で'}売上高 <b>${esc(fmtShort(std.sales))}</b>、営業利益 <b>${esc(fmtShort(std.opProfit))}</b> の${land.partial ? '着地見込み' : '実績'}、手元資金は月商 <b>${s.monthlySales > 0 ? s.liquidityMonths.toFixed(1) : '—'}か月分</b>です。`

    const kpiRow = (label: string, cur: number, pre: number | null | undefined, curCum: number, preCum: number | null | undefined) => {
      const diff = preCum != null ? curCum - preCum : null
      return `<tr>
        <td>${esc(label)}</td>
        <td class="tr${cur < 0 ? ' neg' : ''}">${esc(num(cur))}</td>
        <td class="tr">${pre != null ? esc(num(pre)) : '—'}</td>
        <td class="tc">${yoyChip(cur, pre)}</td>
        <td class="tr${curCum < 0 ? ' neg' : ''}">${esc(num(curCum))}</td>
        <td class="tr ${diff == null ? '' : diff >= 0 ? 'pos' : 'neg'}">${diff == null ? '—' : esc(sgnYen(diff))}</td>
      </tr>`
    }
    const kpiTable = `<table>
      <thead><tr><th>指標</th><th>${monthLabel}単月</th><th>前年同月</th><th>前年比</th><th>期首〜${monthLabel}累計</th><th>累計の前年差</th></tr></thead>
      <tbody>
        ${kpiRow('売上高', single.sales, pSingle?.sales, curY.sales, preY?.sales)}
        ${kpiRow('売上総利益（粗利）', single.grossProfit, pSingle?.grossProfit, curY.grossProfit, preY?.grossProfit)}
        ${kpiRow('営業利益', single.opProfit, pSingle?.opProfit, curY.opProfit, preY?.opProfit)}
        ${kpiRow('経常利益', single.ordProfit, pSingle?.ordProfit, curY.ordProfit, preY?.ordProfit)}
        ${kpiRow('当期純利益', single.netProfit, pSingle?.netProfit, curY.netProfit, preY?.netProfit)}
      </tbody>
    </table>
    <div class="note mt1">粗利率 ${esc(p1(curY.grossMargin))}（前年同期 ${preY ? esc(p1(preY.grossMargin)) : '—'}）／ 営業利益率 ${esc(p1(curY.opMargin))}（同 ${preY ? esc(p1(preY.opMargin)) : '—'}）※累計ベース</div>`

    const bridgeHtml = bridge
      ? svgWaterfall('前年の営業利益', bridge.preOp, bridge.steps, '当期の営業利益', bridge.curOp)
      : svgCombo(monthLabels, [
          { type: 'bar', values: Array.from({ length: 12 }, (_, i) => (i > monthIdx ? null : (getRow(fy, CODES.sales)?.monthly[i] ?? 0))), color: NAVY, label: '売上高' },
          { type: 'line', values: Array.from({ length: 12 }, (_, i) => (i > monthIdx ? null : (getRow(fy, CODES.opProfit)?.monthly[i] ?? 0))), color: GOLD, label: '営業利益' },
        ])

    // 健全度ゲージ: 判定＋その会社の数値への一言コメント＋指標の意味の簡潔な説明
    const gauge = (title: string, valueLabel: string, svg: string, judge: string, tone: 'good' | 'warn' | 'bad', comment: string, meaning: string) => `
      <div class="gauge">
        <div class="g-head"><span class="g-title">${esc(title)}</span><span class="g-val">${esc(valueLabel)}</span></div>
        ${svg}
        <div class="g-judge ${tone === 'good' ? 'pos' : tone === 'bad' ? 'neg' : 'warn'}">${esc(judge)}</div>
        <div class="g-comment">${esc(comment)}</div>
        <div class="g-note">${esc(meaning)}</div>
      </div>`
    const gauges: string[] = []
    if (bepRatio != null) {
      const r = bepRatio
      const comment = r >= 100
        ? `売上が損益分岐点を${(r - 100).toFixed(0)}%下回っており、現在の売上では固定費を賄えず赤字の状態です。`
        : r >= 90
          ? `売上があと${(100 - r).toFixed(0)}%落ちると赤字になる、余裕の少ない状態です。`
          : r >= 75
            ? `売上があと${(100 - r).toFixed(0)}%落ちるまでは黒字を保てますが、もう一段の余裕がほしい水準です。`
            : `売上があと${(100 - r).toFixed(0)}%落ちても黒字を維持できる、体力のある収益構造です。`
      gauges.push(gauge('損益分岐点比率', `${r.toFixed(0)}%`,
        svgBullet(Math.min(r, 120), 120, [{ to: 75, color: '#bfe6c8' }, { to: 90, color: '#fbe8b6' }, { to: 120, color: '#f6c6c2' }]),
        r < 75 ? '安全（〜75%）' : r < 90 ? '注意（75〜90%）' : '危険水準（90%〜）',
        r < 75 ? 'good' : r < 90 ? 'warn' : 'bad',
        comment,
        '※ 赤字になる売上ライン（損益分岐点）÷実際の売上高。低いほど売上減少に強い体質です（目安：75%以下が安全・90%超は危険）。'))
    }
    if (issuesResult && issuesResult.labor.share != null) {
      const sh = issuesResult.labor.share
      const comment = sh >= 70
        ? `稼いだ粗利の${sh.toFixed(0)}%が人件費に消えており、他の経費や利益がほとんど残らない水準です。`
        : sh >= 60
          ? `粗利の6割超が人件費に充てられており、昇給・増員の余力が乏しくなっています。`
          : sh >= 50
            ? `人件費と粗利のバランスはおおむね標準的な水準です。`
            : `粗利に対して人件費に余裕があり、昇給・採用など人への投資余力があります。`
      gauges.push(gauge('労働分配率', `${sh.toFixed(0)}%`,
        svgBullet(Math.min(sh, 100), 100, [{ to: 50, color: '#bfe6c8' }, { to: 60, color: '#e8f0d8' }, { to: 70, color: '#fbe8b6' }, { to: 100, color: '#f6c6c2' }]),
        sh < 50 ? '健全（〜50%）' : sh < 60 ? '許容（50〜60%）' : sh < 70 ? '警戒（60〜70%）' : '危険水準（70%〜）',
        sh < 60 ? 'good' : sh < 70 ? 'warn' : 'bad',
        comment,
        '※ 人件費÷売上総利益（粗利）。稼いだ粗利のうち人件費が占める割合で、低いほど利益が残ります（目安：50%前後が健全・70%超は危険）。'))
    }
    if (s.monthlySales > 0) {
      const lm = s.liquidityMonths
      const comment = lm < 1
        ? `手元資金が月商1か月分を切っており、入金遅れや突発的な支出で資金繰りに窮するリスクがあります。`
        : lm < 2
          ? `当面の支払いには足りますが、納税や賞与が重なる月には薄くなる水準です。`
          : lm < 3
            ? `標準的な水準です。月商3か月分あるとより安心です。`
            : `不測の事態にも耐えられる、厚めの手元資金を確保できています。`
      gauges.push(gauge('手元資金の月商倍率', `${lm.toFixed(1)}か月`,
        svgBullet(Math.min(lm, 6), 6, [{ to: 1, color: '#f6c6c2' }, { to: 2, color: '#fbe8b6' }, { to: 3, color: '#e8f0d8' }, { to: 6, color: '#bfe6c8' }]),
        lm < 1 ? '危険（1か月未満）' : lm < 2 ? '注意（1〜2か月）' : lm < 3 ? '許容（2〜3か月）' : '安心（3か月〜）',
        lm < 1 ? 'bad' : lm < 2 ? 'warn' : 'good',
        comment,
        '※ 現預金残高÷月平均売上高。手元資金が月商の何か月分あるかを示します（目安：2〜3か月分が安心・1か月未満は危険）。'))
    }

    let signals = ''
    if (issuesResult && issuesResult.issues.length) {
      const cnt = (sev: string) => issuesResult.issues.filter((i) => i.severity === sev).length
      const chips = issuesResult.issues.slice(0, 9).map((i) =>
        `<span class="chip ${i.severity === 'danger' ? 'd' : i.severity === 'warn' ? 'w' : 'g'}">${i.severity === 'danger' ? '🔴' : i.severity === 'warn' ? '🟡' : '🟢'} ${esc(i.category)}</span>`).join('')
      const more = issuesResult.issues.length > 9 ? `<span class="note">ほか${issuesResult.issues.length - 9}件</span>` : ''
      const issuesNo = views.indexOf('issues')
      const refText = issuesNo >= 0 ? `詳細は「${issuesNo + 1}．${labelOf('issues')}」のページを参照` : '詳細は画面の「経営課題」タブを参照'
      signals = `<div class="blk mt"><div class="blk-t">今月の信号（要対応 ${cnt('danger')}件／注意 ${cnt('warn')}件／良好 ${cnt('good')}件 — ${refText}）</div>${chips}${more}</div>`
    }

    const m0 = fy.fiscalMonths[0]
    const bridgeTitle = `前年と比べて利益がどう変化したか【前期（${m0}月〜${monthLabel}累計）→当期（${m0}月〜${monthLabel}累計）】`
    return page(no, '概要', `
      <div class="lead">${lead}</div>
      <div class="cards c4">
        <div class="card"><div class="c-label">今月の売上高（${monthLabel}単月）</div>
          <div class="c-main">${esc(fmtShort(single.sales))}</div>
          <div class="c-sub">${yoyChip(single.sales, pSingle?.sales)}　${esc(num(single.sales))}</div></div>
        <div class="card"><div class="c-label">今月の営業利益（${monthLabel}単月）</div>
          <div class="c-main${single.opProfit < 0 ? ' neg' : ''}">${esc(fmtShort(single.opProfit))}</div>
          <div class="c-sub">${yoyChip(single.opProfit, pSingle?.opProfit)}　${esc(num(single.opProfit))}</div></div>
        <div class="card"><div class="c-label">${land.partial ? '通期の着地見込み（営業利益・標準）' : '通期の営業利益（確定）'}</div>
          <div class="c-main${std.opProfit < 0 ? ' neg' : ''}">${esc(fmtShort(std.opProfit))}</div>
          <div class="c-sub">${landCompare ? `<span class="${landCompare.diff >= 0 ? 'pos' : 'neg'}"><b>${esc(landCompare.label)} ${esc(sgnShort(landCompare.diff))}</b></span>` : `売上見込み ${esc(fmtShort(std.sales))}`}</div></div>
        <div class="card"><div class="c-label">手元資金（現預金）</div>
          <div class="c-main${s.monthlySales > 0 && s.liquidityMonths < 1 ? ' neg' : ''}">${s.monthlySales > 0 ? `月商 ${s.liquidityMonths.toFixed(1)}か月分` : esc(fmtShort(s.cash))}</div>
          <div class="c-sub">残高 ${esc(fmtShort(s.cash))}（目安：2〜3か月分）</div></div>
      </div>
      <div class="row2 mt">
        <div class="blk"><div class="blk-t">主要損益（単月と累計）</div>${kpiTable}</div>
        <div class="blk"><div class="blk-t">${bridge ? bridgeTitle : `月次推移（売上高・営業利益）`}</div>${bridgeHtml}</div>
      </div>
      <div class="blk mt"><div class="blk-t">経営の健全度</div><div class="gauges">${gauges.join('')}</div></div>
      ${signals}
    `)
  }

  // ---------- 2) 予算・予実 ----------
  function pageBudget(no: number): string {
    const landTable = `<table>
      <thead><tr><th>シナリオ</th><th>売上高</th><th>営業利益</th><th>経常利益</th></tr></thead>
      <tbody>${land.scenarios.map((sc) => `<tr${sc.key === 'standard' ? ' class="em"' : ''}>
        <td>${esc(sc.label)}</td><td class="tr">${esc(num(sc.sales))}</td>
        <td class="tr${sc.opProfit < 0 ? ' neg' : ''}">${esc(num(sc.opProfit))}</td>
        <td class="tr${sc.ordProfit < 0 ? ' neg' : ''}">${esc(num(sc.ordProfit))}</td></tr>`).join('')}</tbody>
    </table>`

    if (!hasBudget) {
      return page(no, '予算・予実', `
        <div class="lead">この期の予算は未設定です。画面の「予算・予実」タブで通期予算（売上高・粗利率・販管費）を設定すると、予実対比を印刷できます。</div>
        <div class="row2">
          <div class="blk"><div class="blk-t">通期の着地見込み（実績ベースの3シナリオ）</div>${landTable}
            <div class="note mt1">残り期間は「前年同月（保守）／前期・前々期の同月平均×今期ペース（標準）／前年同月+5%（楽観）」で補完しています。</div></div>
          <div class="blk"><div class="blk-t">当期の実績（期首〜${monthLabel}累計）</div>
            <table><tbody>
              <tr><td>売上高</td><td class="tr">${esc(num(curY.sales))}</td></tr>
              <tr><td>売上総利益（粗利率 ${esc(p1(curY.grossMargin))}）</td><td class="tr">${esc(num(curY.grossProfit))}</td></tr>
              <tr><td>販管費</td><td class="tr">${esc(num(curY.sgna))}</td></tr>
              <tr class="em"><td>営業利益</td><td class="tr${curY.opProfit < 0 ? ' neg' : ''}">${esc(num(curY.opProfit))}</td></tr>
            </tbody></table></div>
        </div>
      `)
    }

    const va = budgetVsActual(years, fy, monthIdx, budget!)
    const mbs = monthlyBudgetSeries(years, fy, monthIdx, budget!)
    const sl = va.lines[0], op = va.lines[2]
    const lead = `期首〜${monthLabel}累計で、売上は予算比 <b>${sl.achieveYtd != null ? sl.achieveYtd.toFixed(0) + '%' : '—'}</b>（差異 ${esc(sgnShort(sl.actualYtd - sl.budgetYtd))}）、営業利益は <b>${op.achieveYtd != null ? op.achieveYtd.toFixed(0) + '%' : '—'}</b>（差異 ${esc(sgnShort(op.actualYtd - op.budgetYtd))}）の進捗です。`
    const vaTable = `<table>
      <thead><tr><th>指標</th><th>予算（累計）</th><th>実績（累計）</th><th>達成率</th><th>差異</th><th>通期予算</th><th>着地見込み</th></tr></thead>
      <tbody>${va.lines.map((l) => {
        const d = l.actualYtd - l.budgetYtd
        return `<tr>
          <td>${esc(l.label)}</td>
          <td class="tr">${esc(num(l.budgetYtd))}</td>
          <td class="tr${l.actualYtd < 0 ? ' neg' : ''}">${esc(num(l.actualYtd))}</td>
          <td class="tc"><b>${l.achieveYtd != null ? l.achieveYtd.toFixed(0) + '%' : '—'}</b></td>
          <td class="tr ${d >= 0 ? 'pos' : 'neg'}">${esc(sgnYen(d))}</td>
          <td class="tr">${esc(num(l.budgetFull))}</td>
          <td class="tr">${l.landingFull != null ? esc(num(l.landingFull)) : '—'}</td></tr>`
      }).join('')}</tbody>
    </table>
    <div class="note mt1">予算の月割りは、売上・粗利＝前年の季節性、販管費＝月数按分。着地見込みは標準シナリオ（季節性×今期ペース）です。</div>`
    const chart = svgCombo(monthLabels, [
      { type: 'bar', values: mbs.salesBudget, color: '#8ba3c2', label: '売上予算' },
      { type: 'bar', values: mbs.salesActual, color: NAVY, label: '売上実績' },
      { type: 'line', values: mbs.opActual, color: GOLD, label: '営業利益実績' },
    ])
    const comment = budget!.comment
      ? esc(budget!.comment).replace(/\n/g, '<br>')
      : esc(`売上の達成率は${sl.achieveYtd != null ? sl.achieveYtd.toFixed(0) + '%' : '—'}、営業利益の達成率は${op.achieveYtd != null ? op.achieveYtd.toFixed(0) + '%' : '—'}です。` +
          (op.landingFull != null ? `このままのペースなら通期営業利益は約${fmtShort(op.landingFull)}（予算${fmtShort(op.budgetFull)}に対し${sgnShort(op.landingFull - op.budgetFull)}）の着地が見込まれます。` : ''))
    return page(no, '予算・予実', `
      <div class="lead">${lead}</div>
      <div class="row2">
        <div class="blk"><div class="blk-t">予実対比（期首〜${monthLabel}累計）</div>${vaTable}
          <div class="blk-t mt">通期の着地見込み（3シナリオ）</div>${landTable}</div>
        <div class="blk"><div class="blk-t">月次売上の予実と営業利益</div>${chart}
          <div class="blk-t mt">所見</div><div class="txt">${comment}</div></div>
      </div>
    `)
  }

  // ---------- 3) 試算表・3期比較・推移 ----------
  function pageReport(no: number): string {
    const sorted = sortedYears(years)
    const ci = sorted.findIndex((y) => y.id === fy.id)
    const comp = sorted.slice(Math.max(0, ci - 2), ci + 1)
    const kAt = (y: FiscalYearData) => plKpisYtd(y, Math.min(monthIdx, y.lastFilledIndex))
    const ks = comp.map(kAt)
    const cur = ks[ks.length - 1]
    const pre = ks.length >= 2 ? ks[ks.length - 2] : null
    const lead = `期首〜${monthLabel}累計の売上高は <b>${esc(fmtShort(cur.sales))}</b>（前年同期比 ${esc(fmtPctSigned(pre ? yoy(cur.sales, pre.sales) : null))}）、営業利益は <b>${esc(fmtShort(cur.opProfit))}</b>（同 ${esc(fmtPctSigned(pre ? yoy(cur.opProfit, pre.opProfit) : null))}）です。`
    type Getter = (k: ReturnType<typeof plKpisYtd>) => number
    // isCost=true の行（売上原価・販管費）は増加＝良いとは限らないため前年比を色付けしない
    const row = (label: string, get: Getter, isCost?: boolean) => {
      const vals = ks.map((k) => {
        const v = get(k)
        return `<td class="tr${v < 0 ? ' neg' : ''}">${esc(num(v))}</td>`
      }).join('')
      const g = pre ? yoy(get(cur), get(pre)) : null
      const cls = isCost || g == null ? '' : g < 0 ? 'neg' : 'pos'
      return `<tr><td>${esc(label)}</td>${vals}<td class="tc ${cls}">${esc(fmtPctSigned(g))}</td></tr>`
    }
    // 利益率は金額と同じセルに入れると桁の位置がずれて読みにくいため、独立した率行にする
    const rateRow = (label: string, get: Getter) => {
      const vals = ks.map((k) => `<td class="tr">${esc(p1(get(k)))}</td>`).join('')
      const d = pre ? get(cur) - get(pre) : null
      return `<tr class="rate"><td>　${esc(label)}</td>${vals}<td class="tc">${d == null ? '—' : esc(`${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(1)}pt`)}</td></tr>`
    }
    const plTable = `<table>
      <thead><tr><th>PL（期首〜同月数累計）</th>${comp.map((y) => `<th>${esc(y.label)}</th>`).join('')}<th>前年比</th></tr></thead>
      <tbody>
        ${row('売上高', (k) => k.sales)}
        ${row('売上原価', (k) => k.cogs, true)}
        ${row('売上総利益', (k) => k.grossProfit)}
        ${rateRow('売上総利益率', (k) => k.grossMargin)}
        ${row('販管費', (k) => k.sgna, true)}
        ${row('営業利益', (k) => k.opProfit)}
        ${rateRow('営業利益率', (k) => k.opMargin)}
        ${row('経常利益', (k) => k.ordProfit)}
        ${rateRow('経常利益率', (k) => k.ordMargin)}
        ${row('当期純利益', (k) => k.netProfit)}
      </tbody>
    </table>`
    const bsAt = (y: FiscalYearData, code: string) => getRow(y, code)?.monthly[Math.min(monthIdx, y.lastFilledIndex)] ?? 0
    const bsRow = (label: string, code: string) =>
      `<tr><td>${esc(label)}</td>${comp.map((y) => { const v = bsAt(y, code); return `<td class="tr${v < 0 ? ' neg' : ''}">${esc(num(v))}</td>` }).join('')}</tr>`
    const bsTable = `<table>
      <thead><tr><th>BS（各期の同月末残高）</th>${comp.map((y) => `<th>${esc(y.label)}</th>`).join('')}</tr></thead>
      <tbody>
        ${bsRow('現金及び預金', CODES.cash)}
        ${bsRow('資産合計', CODES.assetTotal)}
        ${bsRow('負債合計', CODES.liabTotal)}
        ${bsRow('純資産', CODES.netAsset)}
        <tr class="em"><td>自己資本比率</td>${comp.map((y) => {
          const a = bsAt(y, CODES.assetTotal); const n = bsAt(y, CODES.netAsset)
          return `<td class="tr">${a ? p1((n / a) * 100) : '—'}</td>`
        }).join('')}</tr>
      </tbody>
    </table>`
    const chart = svgCombo(monthLabels, [
      ...(prior ? [{ type: 'bar' as const, values: Array.from({ length: 12 }, (_, i) => getRow(prior, CODES.sales)?.monthly[i] ?? 0), color: '#8ba3c2', label: '売上高（前期）' }] : []),
      { type: 'bar', values: Array.from({ length: 12 }, (_, i) => (i > monthIdx ? null : (getRow(fy, CODES.sales)?.monthly[i] ?? 0))), color: NAVY, label: '売上高（当期）' },
      { type: 'line', values: Array.from({ length: 12 }, (_, i) => (i > monthIdx ? null : (getRow(fy, CODES.opProfit)?.monthly[i] ?? 0))), color: GOLD, label: '営業利益（当期）' },
    ], 660, 152)
    return page(no, '試算表・3期比較・推移', `
      <div class="lead">${lead}</div>
      <div class="row2">
        <div class="blk"><div class="blk-t">損益計算書の3期比較（各期とも期首〜${monthLabel}と同じ月数の累計）</div>${plTable}</div>
        <div class="blk"><div class="blk-t">貸借対照表の3期比較（同月末残高）</div>${bsTable}</div>
      </div>
      <div class="blk mt"><div class="blk-t">月次推移（売上高と営業利益）</div>${chart}</div>
    `)
  }

  // ---------- 4) 明細・経費 ----------
  function pageDetail(no: number): string {
    const curList = detailsOf(fy, CODES.sgna).map((a) => ({ name: a.name.trim(), cur: rowYtd(a, monthIdx) }))
    const preMap = new Map<string, number>()
    if (prior) for (const a of detailsOf(prior, CODES.sgna)) preMap.set(a.name.trim(), rowYtd(a, priorIdx))
    const names: string[] = []
    const seen = new Set<string>()
    for (const x of curList) { if (!seen.has(x.name)) { seen.add(x.name); names.push(x.name) } }
    for (const n of Array.from(preMap.keys())) { if (!seen.has(n)) { seen.add(n); names.push(n) } }
    const rows = names.map((name) => {
      const cur = curList.find((x) => x.name === name)?.cur ?? 0
      const pre = prior ? (preMap.get(name) ?? 0) : null
      return { name, cur, pre, diff: pre != null ? cur - pre : null }
    }).filter((r) => r.cur !== 0 || (r.pre ?? 0) !== 0)

    const sgnaRate = curY.sales > 0 ? (curY.sgna / curY.sales) * 100 : null
    const preSgnaRate = preY && preY.sales > 0 ? (preY.sgna / preY.sales) * 100 : null

    const detailTable = (list: typeof rows, emptyMsg: string) => list.length === 0
      ? `<div class="note">${esc(emptyMsg)}</div>`
      : `<table>
        <thead><tr><th>科目</th><th>当期累計</th><th>前年同期</th><th>増減額</th><th>増減率</th></tr></thead>
        <tbody>${list.map((r) => `<tr>
          <td>${esc(r.name)}</td>
          <td class="tr">${esc(num(r.cur))}</td>
          <td class="tr">${r.pre != null ? esc(num(r.pre)) : '—'}</td>
          <td class="tr ${r.diff != null && r.diff >= 0 ? 'neg' : 'pos'}">${r.diff != null ? esc(sgnYen(r.diff)) : '—'}</td>
          <td class="tc">${r.pre ? esc(fmtPctSigned(((r.cur - r.pre) / Math.abs(r.pre)) * 100)) : '新規'}</td></tr>`).join('')}</tbody>
      </table>`

    let body: string
    let lead: string
    if (prior) {
      const inc = rows.filter((r) => (r.diff ?? 0) > 0).sort((a, b) => (b.diff ?? 0) - (a.diff ?? 0)).slice(0, 12)
      const dec = rows.filter((r) => (r.diff ?? 0) < 0).sort((a, b) => (a.diff ?? 0) - (b.diff ?? 0)).slice(0, 12)
      lead = `販管費の累計は <b>${esc(fmtShort(curY.sgna))}</b>（前年同期比 ${esc(sgnShort(curY.sgna - (preY?.sgna ?? 0)))}）。` +
        (inc.length ? `増加が大きいのは<b>${esc(inc.slice(0, 3).map((x) => x.name).join('・'))}</b>です。` : '大きく増えた科目はありません。')
      body = `
      <div class="cards">
        <div class="card"><div class="c-label">販管費（期首〜${monthLabel}累計）</div>
          <div class="c-main sm2">${esc(fmtShort(curY.sgna))}</div>
          <div class="c-sub">前年同期 ${esc(fmtShort(preY?.sgna ?? 0))}　<span class="${curY.sgna - (preY?.sgna ?? 0) >= 0 ? 'neg' : 'pos'}">${esc(sgnShort(curY.sgna - (preY?.sgna ?? 0)))}</span></div></div>
        <div class="card"><div class="c-label">売上原価（累計）</div>
          <div class="c-main sm2">${esc(fmtShort(curY.cogs))}</div>
          <div class="c-sub">前年同期 ${esc(fmtShort(preY?.cogs ?? 0))}　<span class="${curY.cogs - (preY?.cogs ?? 0) >= 0 ? 'neg' : 'pos'}">${esc(sgnShort(curY.cogs - (preY?.cogs ?? 0)))}</span></div></div>
        <div class="card"><div class="c-label">販管費率（対売上）</div>
          <div class="c-main sm2">${sgnaRate != null ? esc(p1(sgnaRate)) : '—'}</div>
          <div class="c-sub">前年同期 ${preSgnaRate != null ? esc(p1(preSgnaRate)) : '—'}</div></div>
      </div>
      <div class="row2 mt">
        <div class="blk"><div class="blk-t">前年より増えた経費（増加額の大きい順）</div>${detailTable(inc, '前年より増えた経費はありません。')}</div>
        <div class="blk"><div class="blk-t">前年より減った経費（減少額の大きい順）</div>${detailTable(dec, '前年より減った経費はありません。')}</div>
      </div>
      <div class="note mt1">※ 販管費の明細科目を前年の同じ月数の累計と比較しています。増減の背景（先行投資・単発費用など）は所見欄・面談でご確認ください。</div>`
    } else {
      const top = rows.sort((a, b) => b.cur - a.cur).slice(0, 20)
      lead = `販管費の累計は <b>${esc(fmtShort(curY.sgna))}</b>（対売上 ${sgnaRate != null ? esc(p1(sgnaRate)) : '—'}）。前年データを取り込むと増減比較を表示します。`
      body = `
      <div class="blk"><div class="blk-t">販管費の内訳（累計の大きい順・上位20科目）</div>
        <table>
          <thead><tr><th>科目</th><th>期首〜${monthLabel}累計</th><th>販管費に占める割合</th></tr></thead>
          <tbody>${top.map((r) => `<tr><td>${esc(r.name)}</td><td class="tr">${esc(num(r.cur))}</td><td class="tc">${curY.sgna ? esc(p1((r.cur / curY.sgna) * 100)) : '—'}</td></tr>`).join('')}</tbody>
        </table></div>`
    }
    return page(no, '原価・経費明細', `<div class="lead">${lead}</div>${body}`)
  }

  // ---------- 5) 損益分岐点・FCF分析 ----------
  function pageCvpFcf(no: number): string {
    const bepNote = bepRatio == null ? '' : bepRatio < 100
      ? `（売上があと${(100 - bepRatio).toFixed(0)}%落ちても黒字）`
      : '（売上が損益分岐点に届いていません）'
    const lead = `損益分岐点比率は <b>${bepRatio != null ? bepRatio.toFixed(0) + '%' : '—'}</b>${bepNote}。期首〜${monthLabel}の営業活動CFは <b>${esc(fmtShort(cashflow.sections[0].subtotal))}</b>、現金の純増減は <b>${esc(fmtShort(cashflow.netCf))}</b> です（差額 ${esc(sgnYen(cashflow.residual))} 円）。`
    const cvpTable = `<table>
      <tbody>
        <tr><td>売上高（期首〜${monthLabel}累計）</td><td class="tr">${esc(num(c.sales))}</td></tr>
        <tr><td>変動費（売上原価ほか）</td><td class="tr">${esc(num(c.variable))}</td></tr>
        <tr class="em"><td>限界利益（率 ${esc(p1(c.marginalRate * 100))}）</td><td class="tr">${esc(num(c.marginal))}</td></tr>
        <tr><td>固定費（販管費ほか）</td><td class="tr">${esc(num(c.fixed))}</td></tr>
        <tr class="em"><td>営業利益</td><td class="tr${c.opProfit < 0 ? ' neg' : ''}">${esc(num(c.opProfit))}</td></tr>
        <tr class="hl"><td>損益分岐点売上高（＝固定費 ÷ 限界利益率）</td><td class="tr">${esc(num(c.bep))}</td></tr>
        <tr><td>損益分岐点比率</td><td class="tr"><b>${bepRatio != null ? esc(p1(bepRatio)) : '—'}</b></td></tr>
        <tr><td>安全余裕率（売上の下落余地）</td><td class="tr">${esc(p1(c.safety * 100))}</td></tr>
      </tbody>
    </table>
    <div class="note mt1">変動費・固定費の区分は「損益分岐点・FCF分析」タブの設定（既定：売上原価＝変動費、販管費＝固定費）に従います。</div>`
    // invert=true（仕入債務）は増加が資金にプラスに働くため色を反転する
    const wcRow = (label: string, close: number, chg: number, invert?: boolean) => {
      const badUp = invert ? chg < 0 : chg >= 0
      return `<tr><td>${esc(label)}</td><td class="tr">${esc(num(close - chg))}</td><td class="tr">${esc(num(close))}</td><td class="tr ${badUp ? 'neg' : 'pos'}">${esc(sgnYen(chg))}</td></tr>`
    }
    const wcTable = `<table>
      <thead><tr><th>運転資本</th><th>期首</th><th>${monthLabel}末</th><th>増減</th></tr></thead>
      <tbody>
        ${wcRow('売上債権（受手・売掛）', wc.recv, fcf.recvChg)}
        ${wcRow('棚卸資産（在庫）', wc.inv, fcf.invChg)}
        ${wcRow('仕入債務（買掛・支手）', wc.pay, fcf.payChg, true)}
        <tr class="em"><td>運転資本（債権＋在庫−債務）</td><td class="tr">${esc(num(fcf.wcOpen))}</td><td class="tr">${esc(num(fcf.wcClose))}</td><td class="tr ${fcf.wcIncrease >= 0 ? 'neg' : 'pos'}">${esc(sgnYen(fcf.wcIncrease))}</td></tr>
      </tbody>
    </table>
    <div class="txt mt1"><b>→ 結論：</b>${esc(
      fcf.wcIncrease > 0
        ? `運転資本が期首から ${fmtShort(fcf.wcIncrease)} 増えたため、その分だけ現金預金が減る要因になりました。売掛金・在庫という「立て替え」にお金が回っており、利益が出ていてもこの分は手元の現金になっていません（売掛金の早期回収・在庫圧縮が改善余地です）。`
        : fcf.wcIncrease < 0
          ? `運転資本が期首から ${fmtShort(-fcf.wcIncrease)} 減ったため、その分だけ現金預金が増える要因になりました。売掛金の回収・在庫の圧縮が進み、立て替えに回っていたお金が手元に戻っています。`
          : '運転資本は期首から変わらず、現金預金への影響はありません。',
    )}</div>`
    // 厳密キャッシュフロー計算書（営業/投資/財務・差額≈0）— 全B/S科目を位置で自動集計
    const cf = cashflow
    const bigResidual = Math.abs(cf.residual) > 2_000_000
    const shortLabel = (l: string) => l.replace(/（[^）]*）/g, '').trim()
    // 印刷は1枚に収めるため、投資CFの固定資産明細は純額1行にまとめる（減価償却の調整行は残す）
    const cfPrintSections = cf.sections.map((sec) => {
      if (sec.key !== 'inv') return sec
      const dep = sec.items.find((it) => it.label.includes('減価償却費の調整'))
      const rest = sec.items.filter((it) => it !== dep).reduce((s, it) => s + it.amount, 0)
      return { ...sec, items: [{ label: '固定資産の取得・売却（純額）', amount: rest }, ...(dep ? [dep] : [])] }
    })
    const cfRows = cfPrintSections.map((sec) => `
      <tr class="em"><td>${esc(sec.title)}</td><td class="tr${sec.subtotal < 0 ? ' neg' : ''}">${esc(num(sec.subtotal))}</td></tr>
      ${sec.items.map((it) => `<tr><td class="cf-ind">${esc(shortLabel(it.label))}</td><td class="tr${it.amount < 0 ? ' neg' : ''}">${it.amount >= 0 ? '＋' : '−'}${esc(num(Math.abs(it.amount)))}</td></tr>`).join('')}`).join('')
    const cfTable = `<table>
      <thead><tr><th>キャッシュフロー計算書（間接法）</th><th>金額</th></tr></thead>
      <tbody>
        ${cfRows}
        <tr class="hl"><td>現金の増減（営業＋投資＋財務）</td><td class="tr${cf.netCf < 0 ? ' neg' : ''}">${esc(num(cf.netCf))}</td></tr>
        <tr><td>（参考）実際の現預金の増減（期首 ${esc(fmtShort(cf.openingCash))} → ${monthLabel}末 ${esc(fmtShort(cf.closingCash))}）</td><td class="tr${cf.actualCashChange < 0 ? ' neg' : ''}">${esc(num(cf.actualCashChange))}</td></tr>
        <tr><td>差額（実際 − 計算上）${bigResidual ? ' <b style="color:#b4690e">⚠要確認</b>' : ''}</td><td class="tr">${esc(num(cf.residual))}</td></tr>
      </tbody>
    </table>
    <div class="note mt1">※ 全B/S科目をB/S上の位置（流動/固定・資産/負債/純資産）で営業・投資・財務に自動集計しています（借入金・リースのみ名称で財務へ）。3区分の合計は実際の現預金増減に一致し、差額は分類端数のみ（通常ゼロ〜数万円。200万円超は⚠要確認）。投資CFの「減価償却費の調整」は、営業CFで足し戻した減価償却（非資金）を控除して実際の設備投資・売却額に直す項目です。</div>`
    return page(no, '損益分岐点・キャッシュフロー', `
      <div class="lead">${lead}</div>
      <div class="row2">
        <div class="blk"><div class="blk-t">損益分岐点（CVP）分析</div>${cvpTable}
          <div class="blk-t mt">運転資本の内訳</div>${wcTable}</div>
        <div class="blk"><div class="blk-t">キャッシュフロー計算書（期首〜${monthLabel}・差額≈0）</div>${cfTable}</div>
      </div>
    `)
  }

  // ---------- 6) 経営課題 ----------
  function pageIssues(no: number): string {
    if (!issuesResult) {
      return page(no, '経営課題', `<div class="lead">課題の自動検出を実行できませんでした（データ不足）。</div>`)
    }
    const dangers = issuesResult.issues.filter((i) => i.severity === 'danger')
    const warns = issuesResult.issues.filter((i) => i.severity === 'warn')
    const goods = issuesResult.issues.filter((i) => i.severity === 'good')
    const lead = dangers.length || warns.length
      ? `<b>要対応 ${dangers.length}件</b>・注意 ${warns.length}件・良好 ${goods.length}件。` +
        (dangers.length ? `最優先は「<b>${esc(cut(dangers[0].title, 42))}</b>」です。` : '')
      : `<b>急いで手を打つべき課題は検出されませんでした</b>（良好 ${goods.length}件）。`
    const mainList = [...dangers, ...warns].slice(0, 8)
    const overflow = dangers.length + warns.length - mainList.length
    const issueHtml = mainList.map((i) => `
      <div class="iss">
        <span class="chip ${i.severity === 'danger' ? 'd' : 'w'}">${i.severity === 'danger' ? '🔴 ' : '🟡 '}${esc(i.category)}</span>
        <b>${esc(i.title)}</b>
        <div class="iss-b">${esc(cut(i.body, 155))}</div>
      </div>`).join('') +
      (overflow > 0 ? `<div class="note">ほか ${overflow} 件（画面の「経営課題」タブに全件）</div>` : '') +
      (goods.length ? `<div class="iss-goods">${goods.slice(0, 4).map((i) => `<div><span class="chip g">🟢 ${esc(i.category)}</span> ${esc(i.title)}</div>`).join('')}</div>` : '')
    const sensTable = `<table>
      <thead><tr><th>打ち手（もし実行したら）</th><th>営業利益への効果（年換算）</th></tr></thead>
      <tbody>${issuesResult.sens.scenarios.map((sc) => `<tr>
        <td>${esc(sc.label)}<div class="sm">${esc(sc.note)}</div></td>
        <td class="tr ${sc.deltaAnnual >= 0 ? 'pos' : 'neg'}"><b>${esc(sgnShort(sc.deltaAnnual))}</b></td></tr>`).join('')}</tbody>
    </table>`
    const lb = issuesResult.labor
    const laborHtml = lb.share != null ? `<table>
      <tbody>
        <tr class="em"><td>労働分配率（人件費÷粗利）</td><td class="tr"><b>${esc(p1(lb.share))}</b></td></tr>
        <tr><td>人件費（期首〜${monthLabel}累計）</td><td class="tr">${esc(num(lb.labor))}</td></tr>
        <tr><td>売上総利益（同）</td><td class="tr">${esc(num(lb.gross))}</td></tr>
        <tr><td>前年同期の分配率</td><td class="tr">${lb.priorShare != null ? esc(p1(lb.priorShare)) : '—'}</td></tr>
      </tbody>
    </table><div class="note mt1">目安：50%前後が健全、60%超で警戒、70%超は危険水準。</div>` : '<div class="note">人件費データがありません。</div>'
    return page(no, '経営課題', `
      <div class="lead">${lead}</div>
      <div class="row2 r64">
        <div class="blk"><div class="blk-t">検出された課題（重要度順）</div>${issueHtml}</div>
        <div class="blk"><div class="blk-t">打ち手の効果（感度分析）</div>${sensTable}
          <div class="blk-t mt">労働分配率</div>${laborHtml}</div>
      </div>
      <div class="note mt1">※ 検出はすべて試算表数値の機械判定です（売上・粗利率・販管費・損益分岐点・労働分配率・資金・回転日数・借入・自己資本・予算）。</div>
    `)
  }

  // ---------- 7) 資金繰り・安全性 ----------
  function pageCash(no: number): string {
    const lead = `手元資金は <b>${esc(fmtShort(s.cash))}</b>（月商 ${s.monthlySales > 0 ? s.liquidityMonths.toFixed(1) : '—'}か月分）。年間の返済原資（簡易CF）は <b>${esc(fmtShort(s.simpleCfAnnual))}</b>、債務償還年数は <b>${s.payoffLoansLease != null ? s.payoffLoansLease.toFixed(1) + '年' : '—'}</b>、自己資本比率は <b>${esc(p1(s.equityRatio))}</b> です。`
    const cards = `
    <div class="cards c6">
      <div class="card"><div class="c-label">手元資金（現預金）</div><div class="c-main sm2">${esc(fmtShort(s.cash))}</div><div class="c-sub">月商 ${s.monthlySales > 0 ? s.liquidityMonths.toFixed(1) : '—'}か月分</div></div>
      <div class="card"><div class="c-label">簡易CF（年換算）</div><div class="c-main sm2${s.simpleCfAnnual < 0 ? ' neg' : ''}">${esc(fmtShort(s.simpleCfAnnual))}</div><div class="c-sub">税引後利益＋減価償却</div></div>
      <div class="card"><div class="c-label">有利子負債</div><div class="c-main sm2">${esc(fmtShort(s.loans + s.leases))}</div><div class="c-sub">借入 ${esc(fmtShort(s.loans))}／リース ${esc(fmtShort(s.leases))}</div></div>
      <div class="card"><div class="c-label">債務償還年数</div><div class="c-main sm2${s.payoffLoansLease != null && s.payoffLoansLease > 10 ? ' neg' : ''}">${s.payoffLoansLease != null ? s.payoffLoansLease.toFixed(1) + '年' : '—'}</div><div class="c-sub">目安：10年以内（5年以内が優良）</div></div>
      <div class="card"><div class="c-label">自己資本比率</div><div class="c-main sm2${s.equityRatio < 10 ? ' neg' : ''}">${esc(p1(s.equityRatio))}</div><div class="c-sub">目安：30%以上で安定</div></div>
      ${debt.hasRepayInput
        ? `<div class="card"><div class="c-label">年間返済額（入力値）</div><div class="c-main sm2">${esc(fmtShort(debt.annualRepay))}</div><div class="c-sub">返済カバー率 ${debt.coverage != null ? debt.coverage.toFixed(2) + '倍' : '—'}（1倍未満は原資不足）</div></div>`
        : `<div class="card"><div class="c-label">運転資本（${monthLabel}末）</div><div class="c-main sm2">${esc(fmtShort(wc.wc))}</div><div class="c-sub">債権＋在庫−仕入債務</div></div>`}
    </div>`
    const { loans } = debtAccounts(fy)
    const ex = settings.loanExclude || {}
    const loanSeries = Array.from({ length: 12 }, (_, i) => (i > monthIdx ? null : loans.filter((a) => !ex[a.code]).reduce((sum, a) => sum + (a.monthly[i] ?? 0), 0)))
    const cashSeries = Array.from({ length: 12 }, (_, i) => (i > monthIdx ? null : (getRow(fy, CODES.cash)?.monthly[i] ?? 0)))
    const hasLoan = loanSeries.some((v) => (v ?? 0) > 0)
    // 縦軸は6段階以上の細かい目盛り、棒には実数値ラベルを表示
    const chart = svgCombo(monthLabels, [
      { type: 'bar', values: cashSeries, color: NAVY, label: '現預金残高', showValues: true },
      ...(hasLoan ? [{ type: 'line' as const, values: loanSeries, color: GOLD, label: '借入金残高' }] : []),
    ], 660, 185, 6)
    const landTable = `<table>
      <thead><tr><th>シナリオ</th><th>売上高</th><th>営業利益</th><th>経常利益</th></tr></thead>
      <tbody>${land.scenarios.map((sc) => `<tr${sc.key === 'standard' ? ' class="em"' : ''}>
        <td>${esc(sc.label)}</td><td class="tr">${esc(num(sc.sales))}</td>
        <td class="tr${sc.opProfit < 0 ? ' neg' : ''}">${esc(num(sc.opProfit))}</td>
        <td class="tr${sc.ordProfit < 0 ? ' neg' : ''}">${esc(num(sc.ordProfit))}</td></tr>`).join('')}</tbody>
    </table>`
    const guide = `
      <div class="txt">
        <b>手元資金</b>：月商2〜3か月分が目安。1か月を切ると突発支出で資金繰りに窮するリスクがあります。<br>
        <b>債務償還年数</b>：有利子負債÷簡易CF。10年超は金融機関から「借りすぎ」と見られ、追加融資が受けにくくなります。<br>
        <b>自己資本比率</b>（＝純資産 ÷ 資産合計）：30%以上で安定、10%未満は要警戒。赤字が続くと目減りするため、内部留保の積み増しが基本です。<br>
        <b>簡易CF</b>：税引後利益＋減価償却の概算値（経常利益を年換算し実効税率 ${esc(p1(s.taxRate * 100))} で計算）。
      </div>`
    return page(no, '資金繰り・安全性', `
      <div class="lead">${lead}</div>
      ${cards}
      <div class="blk mt"><div class="blk-t">現預金残高の月次推移${hasLoan ? 'と借入金残高' : ''}</div>${chart}</div>
      <div class="row2 mt">
        <div class="blk"><div class="blk-t">通期の着地見込み（3シナリオ）</div>${landTable}</div>
        <div class="blk"><div class="blk-t">判定の目安</div>${guide}</div>
      </div>
    `)
  }

  const renderers: Record<PrintView, (no: number) => string> = {
    overview: pageOverview,
    budget: pageBudget,
    report: pageReport,
    detail: pageDetail,
    cvpfcf: pageCvpFcf,
    issues: pageIssues,
    cash: pageCash,
  }
  const pages = views.map((v, i) => renderers[v](i + 1)).join('\n')

  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">
<title>月次レポート_${esc(company)}_${esc(fy.label)}_${monthLabel}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Noto Sans JP", "Hiragino Sans", "Yu Gothic", Meiryo, sans-serif; color: #243042; background: #e7ebf1; font-size: 11px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .toolbar { text-align: center; padding: 10px; }
  .toolbar button { padding: 9px 22px; font-size: 14px; font-weight: 700; border: none; border-radius: 8px; cursor: pointer; background: ${NAVY}; color: #fff; }
  .toolbar span { font-size: 11px; color: #5b6675; margin-left: 10px; }
  .page { width: 297mm; height: 209mm; background: #fff; margin: 0 auto 10px; padding: 9mm 11mm 10mm; position: relative; overflow: hidden; box-shadow: 0 2px 10px rgba(0,0,0,.18); }

  /* ページ共通 */
  .p-head { display: flex; align-items: baseline; gap: 3mm; border-bottom: 2px solid ${NAVY}; padding-bottom: 1.6mm; margin-bottom: 2.6mm; }
  .p-no { background: ${NAVY}; color: #fff; font-weight: 800; font-size: 12px; padding: 1px 9px; border-radius: 3px; }
  .p-title { font-size: 16px; font-weight: 800; color: ${NAVY}; letter-spacing: 1.5px; }
  .p-meta { margin-left: auto; font-size: 9.5px; color: #5b6675; }
  .p-foot { position: absolute; bottom: 3.5mm; left: 0; right: 0; text-align: center; font-size: 8.5px; color: #9aa3ad; }
  .lead { font-size: 12.5px; line-height: 1.65; margin-bottom: 2.6mm; padding: 1.6mm 3mm; background: #f6f8fb; border-left: 3px solid ${GOLD}; border-radius: 0 4px 4px 0; }
  .lead b { color: ${NAVY}; font-size: 13.5px; }

  .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 4mm; align-items: start; }
  .row2.r64 { grid-template-columns: 1.5fr 1fr; }
  .mt { margin-top: 3mm; } .mt1 { margin-top: 1.5mm; }
  .blk { border: 1px solid #e2e8f0; border-radius: 6px; padding: 2.4mm 3mm; background: #fff; }
  .blk-t { font-size: 11.5px; font-weight: 800; color: ${NAVY}; margin-bottom: 1.6mm; border-left: 3px solid ${GOLD}; padding-left: 2mm; }
  .note { font-size: 9.5px; color: #7b8698; line-height: 1.6; }
  .txt { font-size: 10.5px; line-height: 1.8; color: #374151; }
  .sm { font-size: 9px; color: #7b8698; font-weight: 400; }

  /* カード */
  .cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 3.5mm; }
  .cards.c4 { grid-template-columns: repeat(4, 1fr); gap: 3mm; }
  .cards.c4 .c-main { font-size: 20px; }
  .cards.c6 { grid-template-columns: repeat(6, 1fr); gap: 2.5mm; }
  .card { border: 1px solid #d7dde6; border-radius: 6px; padding: 2.6mm 3mm; background: #fbfcfe; }
  .c-label { font-size: 9.5px; color: #5b6675; font-weight: 700; margin-bottom: 1mm; }
  .c-main { font-size: 23px; font-weight: 800; color: #111827; line-height: 1.05; font-variant-numeric: tabular-nums; }
  .c-main.sm2 { font-size: 18px; }
  .c-main.neg { color: ${RED}; }
  .c-sub { font-size: 9px; color: #5b6675; margin-top: 1.2mm; }

  /* 表 */
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #d3dae3; padding: 1.2mm 2mm; font-size: 10.5px; line-height: 1.45; text-align: left; }
  thead th { background: ${NAVY}; color: #fff; font-weight: 700; font-size: 10px; text-align: center; white-space: nowrap; }
  tbody tr:nth-child(even) td { background: #f6f8fb; }
  tr.em td { background: #e7edf5 !important; font-weight: 700; }
  tr.rate td { background: #fbfcfe !important; color: #5b6675; font-size: 9.5px; }
  tr.hl td { background: #f6ecd4 !important; font-weight: 700; border-top: 1.5px solid #c8a24b !important; border-bottom: 1.5px solid #c8a24b !important; }
  td.guide { font-size: 9px; color: #5b6675; }
  td.cf-ind { padding-left: 6mm; color: #5b6675; }
  .tr { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .tc { text-align: center; white-space: nowrap; }
  .neg { color: ${RED}; } .pos { color: ${GREEN}; } .warn { color: #b4690e; }

  /* チップ・課題 */
  .chip { display: inline-block; border: 1px solid; border-radius: 999px; padding: 0.3mm 2.2mm; font-size: 9.5px; font-weight: 700; margin: 0 1mm 1mm 0; white-space: nowrap; }
  .chip.d { background: #fef2f2; color: ${RED}; border-color: #fecaca; }
  .chip.w { background: #fffbeb; color: #b4690e; border-color: #fde68a; }
  .chip.g { background: #f0fdf4; color: ${GREEN}; border-color: #bbf7d0; }
  .chip.m { background: #f3f4f6; color: #6b7280; border-color: #e5e7eb; }
  .iss { padding: 1.4mm 0; border-bottom: 1px dashed #e2e8f0; font-size: 11px; }
  .iss b { color: #1f2937; }
  .iss-b { font-size: 9.6px; color: #5b6675; line-height: 1.55; margin-top: 0.6mm; }
  .iss-goods { margin-top: 1.6mm; font-size: 10.5px; line-height: 1.9; }

  /* ゲージ */
  .gauges { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4mm; }
  .gauge { }
  .g-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 1mm; }
  .g-title { font-size: 10.5px; font-weight: 700; color: #374151; }
  .g-val { font-size: 15px; font-weight: 800; color: ${NAVY}; }
  .g-judge { font-size: 9.5px; font-weight: 700; margin-top: 0.8mm; }
  .g-comment { font-size: 9.5px; color: #374151; line-height: 1.55; margin-top: 1mm; }
  .g-note { font-size: 8.5px; color: #7b8698; line-height: 1.5; margin-top: 0.6mm; }

  .legend { font-size: 9.5px; font-weight: 700; text-align: right; margin-bottom: 0.6mm; }

  /* 表紙 */
  .cover { display: flex; align-items: center; justify-content: center; }
  .cv-inner { width: 72%; }
  .eyebrow { font-size: 11px; letter-spacing: 5px; color: ${GOLD}; font-weight: 700; }
  .cv-title { font-size: 36px; font-weight: 800; color: ${NAVY}; letter-spacing: 4px; margin: 2mm 0 0; }
  .cv-rule { height: 3px; margin: 5mm 0 8mm; background: linear-gradient(90deg, ${NAVY} 0%, ${NAVY} 72%, ${GOLD} 72%, ${GOLD} 100%); }
  .cv-company { font-size: 21px; font-weight: 700; color: #1f2937; }
  .cv-sub { font-size: 11px; color: #5b6675; margin-top: 2mm; }
  .cv-toc { margin-top: 11mm; border: 1px solid #d7dde6; border-radius: 8px; padding: 5mm 8mm 4mm; background: #fbfcfe; }
  .cv-toc-title { font-size: 10px; letter-spacing: 3px; color: ${GOLD}; font-weight: 800; margin-bottom: 2.5mm; }
  .cv-toc-item { font-size: 14px; font-weight: 700; color: ${NAVY}; padding: 1.8mm 0; border-bottom: 1px dashed #e2e8f0; }
  .cv-toc-item:last-child { border-bottom: none; }
  .toc-no { color: ${GOLD}; font-weight: 800; margin-right: 2mm; }

  @media print {
    body { background: #fff; }
    .toolbar { display: none; }
    .page { margin: 0; box-shadow: none; page-break-after: always; }
    .page:last-of-type { page-break-after: auto; }
    @page { size: A4 landscape; margin: 0; }
  }
</style></head><body>
  <div class="toolbar"><button onclick="window.print()">🖨 印刷 / PDF保存</button><span>横向き（A4ランドスケープ）でそのまま印刷されます。1資料＝1枚です。</span></div>
  ${cover}
  ${pages}
  <script>window.addEventListener('load', function () { setTimeout(function () { window.print() }, 400) })</script>
</body></html>`
}
