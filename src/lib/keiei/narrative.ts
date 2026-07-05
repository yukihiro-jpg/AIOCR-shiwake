// 月次レポートの「経営サマリー」解説文（テンプレ自動生成）。
// 相続レポートの解説文（.story）と同じ思想で、読むだけで内容が分かる文章を、実数値を埋め込んで生成する。
// 【厳守】前年が赤字→当年黒字などの符号反転は「黒字転換」等と明示し、単純な%の誤解を避ける。

import type { FiscalYearData } from './types'
import { CODES, ytd, plKpisYtd, plKpisSingle } from './calc'
import { cvp, landingScenarios, type KeieiSettings } from './analysis'

// 万・億の丸め表記
function man(n: number): string {
  const a = Math.abs(n)
  if (a >= 1e8) return `${n < 0 ? '−' : ''}${(a / 1e8).toFixed(1)}億`
  return `${n < 0 ? '−' : ''}${Math.round(a / 1e4).toLocaleString('ja-JP')}万`
}
function pct(n: number): string { return `${n.toFixed(1)}%` }
function signMan(n: number): string { return `${n >= 0 ? '＋' : '−'}${man(Math.abs(n))}` }

// 前年同月比の言い回し（符号反転を明示）
function yoyPhrase(cur: number, prior: number | null): string {
  if (prior == null) return '前年同月のデータがないため比較は割愛します'
  const diff = cur - prior
  if (prior < 0 && cur >= 0) return `前年同月の赤字（${man(prior)}）から **黒字転換** しました（前年差 ${signMan(diff)}）`
  if (prior >= 0 && cur < 0) return `前年同月の黒字（${man(prior)}）から **赤字に転落** しています（前年差 ${signMan(diff)}）`
  if (prior < 0 && cur < 0) {
    const r = (diff / Math.abs(prior)) * 100
    return `前年同月に続き赤字ですが、赤字幅は **${r >= 0 ? '縮小' : '拡大'}（${Math.abs(r).toFixed(1)}%）** しています（前年差 ${signMan(diff)}）`
  }
  const r = (diff / Math.abs(prior)) * 100
  return `前年同月比 **${r >= 0 ? '+' : '−'}${Math.abs(r).toFixed(1)}%**（前年差 ${signMan(diff)}）です`
}

/** 経営サマリーの解説文（マーカー付きプレーンテキスト）を生成 */
export function buildSummaryStory(
  fy: FiscalYearData,
  prior: FiscalYearData | null,
  monthIdx: number,
  years: Record<string, FiscalYearData>,
  settings: KeieiSettings,
): string {
  const monthLabel = `${fy.fiscalMonths[monthIdx]}月`
  const s = plKpisSingle(fy, monthIdx)
  const y = plKpisYtd(fy, monthIdx)
  const py = prior ? plKpisYtd(prior, monthIdx) : null
  const c = cvp(fy, monthIdx, settings)
  const cash = ytd(fy, CODES.cash, monthIdx)
  const land = landingScenarios(years, fy)
  const std = land.scenarios.find((x) => x.key === 'standard') || land.scenarios[0]

  const L: string[] = ['# 今月の経営サマリー（社長にお伝えしたい要点）']

  // 結果（単月＋累計）
  L.push(
    `【今月の結果】${monthLabel}単月の売上は **${man(s.sales)}**、粗利率は **${pct(s.grossMargin)}**、` +
    `本業のもうけである営業${s.opProfit >= 0 ? '利益' : '損失'}は **${man(Math.abs(s.opProfit))}**（売上比 ${pct(s.opMargin)}）でした。` +
    `期首から${monthLabel}までの累計で見ると、売上 **${man(y.sales)}**、営業${y.opProfit >= 0 ? '利益' : '損失'} **${man(Math.abs(y.opProfit))}**（売上比 ${pct(y.opMargin)}）です。` +
    `単月は季節や大口案件で振れやすいため、経営判断では累計と後述の通期着地を重視してください。`,
  )

  // 前年比＋要因
  let r2 = `【前年との比較】営業利益は${yoyPhrase(y.opProfit, py ? py.opProfit : null)}。`
  if (py) {
    const gd = y.grossMargin - py.grossMargin
    r2 += `粗利率は前年 ${pct(py.grossMargin)} → 当年 ${pct(y.grossMargin)}（${gd >= 0 ? '＋' : '−'}${Math.abs(gd).toFixed(1)}pt）で、` +
      `収益性は${gd >= 0 ? '改善' : '低下'}しています。売上の増減だけでなく、この粗利率が利益を大きく左右します。`
  } else {
    r2 += `前年の月次データを取り込むと、粗利率や利益の前年比較がこの欄に表示されます。`
  }
  L.push(r2)

  // 通期着地
  if (land.partial) {
    const remain = 11 - fy.lastFilledIndex
    L.push(
      `【通期の着地見込み】いまの季節性と今期ペースがこのまま続くと、通期は 売上 **${man(std.sales)}**・` +
      `営業利益 **${man(std.opProfit)}** で着地する見込みです（標準シナリオ）。残り約${remain}か月の実績しだいで上下します。` +
      `保守・楽観のシナリオは「損益分岐点・FCF分析」ページで確認できます。`,
    )
  } else {
    L.push(`【通期実績】当期は 売上 **${man(std.sales)}**・営業利益 **${man(std.opProfit)}** で通期が確定しています。`)
  }

  // 損益分岐点・安全余裕
  if (c.marginalRate > 0 && c.sales > 0) {
    const safetyPct = c.safety * 100
    if (y.opProfit >= 0) {
      const dropToBep = c.sales - c.bep
      L.push(
        `【損益分岐点（赤字にならない売上ライン）】黒字を保てる売上の下限は **${man(c.bep)}** です。` +
        `現在の累計売上 ${man(c.sales)} との差（＝どれだけ売上が落ちても黒字でいられるか＝安全余裕）は **${man(dropToBep)}（${pct(safetyPct)}）**。` +
        `安全余裕が大きいほど景気や一時的な売上減に強い体質です。`,
      )
    } else {
      const needSales = c.bep - c.sales
      L.push(
        `【損益分岐点（黒字化に必要な売上）】黒字転換に必要な売上ラインは **${man(c.bep)}** です。` +
        `現在は ${man(c.sales)} なので、あと **${man(needSales)}** の売上上乗せ、もしくは固定費（現在 ${man(c.fixed)}）の圧縮が黒字化の条件になります。` +
        `売上を伸ばす道と固定費を下げる道、両面での対策が有効です。`,
      )
    }
  }

  // 資金
  L.push(
    `【資金（いちばん大切）】${monthLabel}末の現預金残高は **${man(cash)}** です。` +
    `利益が出ていても、売掛金の回収や在庫、借入返済のタイミングによっては資金は不足し得ます（いわゆる黒字倒産）。` +
    `本業で生み出す資金（営業キャッシュフロー）で借入返済を賄えているかを、「損益分岐点・FCF分析」「資金繰り・安全性」ページで必ずご確認ください。`,
  )

  // 打ち手
  let r6 = '【次の一手】'
  if (y.opProfit < 0) {
    r6 += `本業が赤字水準です。まずは粗利率の改善（値付けの見直し・原価の管理・安売り／値引きの抑制）と、固定費（人件費・その他経費）の点検で、損益分岐点そのものを引き下げることを最優先にしましょう。`
  } else {
    r6 += `黒字は確保できています。次は安全余裕を厚くする段階です。粗利率の維持・向上と固定費の増加抑制を意識すると、通期着地と手元資金の余力がさらに安定します。`
  }
  L.push(r6)

  return L.join('\n\n')
}
