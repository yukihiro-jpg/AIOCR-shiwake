// 新報告書 v2 の入口。
// buildMonthlyReportV2Html() が「表紙＋本文」の完成HTML（1枚もの）を返す。
// 印刷は新規ウィンドウにこのHTMLを書き込むだけ、画面プレビューは同じHTMLを
// iframe の srcdoc に入れるだけ ＝ 画面と紙が必ず一致する。
import type { ReportV2Input, ReportV2Context } from './types'
import { REPORT_V2_PAGES } from './types'
import { buildReportV2Context } from './context'
import { wrapHtml } from './theme'
import { pageCover } from './pages/cover'
import { pageTrial } from './pages/trial'
import { pageLanding } from './pages/landing'
import { pageCf } from './pages/cf'
import { pageDaily } from './pages/daily'
import { pageBep } from './pages/bep'
import { pageLoan } from './pages/loan'
import { pageLabor } from './pages/labor'
import { pagesTrend3 } from './pages/trend3'

export * from './types'
export { buildReportV2Context } from './context'

/** ページキー → セクションHTML（複数ページになるものは配列） */
function renderPage(ctx: ReportV2Context, key: string): string[] {
  switch (key) {
    case 'cover': return [pageCover(ctx)]
    case 'trial': return [pageTrial(ctx)]
    case 'landing': return [pageLanding(ctx)]
    case 'cf': return [pageCf(ctx)]
    case 'daily': return [pageDaily(ctx)]
    case 'bep': return [pageBep(ctx)]
    case 'loan': return [pageLoan(ctx)]
    case 'labor': return [pageLabor(ctx)]
    case 'trend3': return pagesTrend3(ctx)
    default: return []
  }
}

/** 本文だけ（<section class="page">…</section> の連結）。画面プレビューでも使う */
export function buildReportV2Body(input: ReportV2Input): string {
  const ctx = buildReportV2Context(input)
  const out: string[] = []
  for (const key of ctx.pages) {
    try {
      out.push(...renderPage(ctx, key))
    } catch (e) {
      // 1ページの失敗で報告書全体が出ないほうが困るので、その資料だけ差し替えて続行する
      const title = REPORT_V2_PAGES.find(([k]) => k === key)?.[1] || key
      const msg = e instanceof Error ? e.message : String(e)
      out.push(`<section class="page"><div class="lead"><b>${title}</b> の作成でエラーが発生しました。データの取込内容をご確認ください。<br><span style="font-size:8pt">${msg.replace(/[<>&]/g, '')}</span></div></section>`)
    }
  }
  return out.join('\n')
}

/** 完成HTML（印刷・新規ウィンドウ用） */
export function buildMonthlyReportV2Html(input: ReportV2Input): string {
  const body = buildReportV2Body(input)
  const title = `月次経営レポート｜${input.company}｜${input.fy.label}`
  return wrapHtml(title, body, input.preview === true)
}
