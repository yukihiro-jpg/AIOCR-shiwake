// 年調データ受信：提出状況のまとめメール（1日1回・GitHub Actions から実行）
//
// 仕組み
//   .github/workflows/nenmatsu-digest.yml が毎朝7時ごろ（11/15〜12/15のみ）これを動かす
//   → Firebase の管理者キー（アップロード通知メールと同じ FIREBASE_SERVICE_ACCOUNT）で
//     登録会社・名簿・提出記録を読み、会社ごとの「N人中M人提出（昨日から +K人）」を数える
//   → 前日から新しい提出があったときだけ、Gmail（GMAIL_USER / GMAIL_PASS）で1通送る
//
// 合言葉は使わない（管理者キーで rooms/ 配下の年調データを直接読む）。
// 【厳守】Actions のログは公開されうるので、会社名・氏名などはログに出さない（件数だけ）。
//   提出記録は提出日時（submittedAt）だけを読み、申告内容・画像には触れない。

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const DAY = 24 * 3600 * 1000
const JST = 9 * 3600 * 1000
const REIWA_BASE = 2018 // 令和N年＝西暦(2018+N)。年度IDは 'R8' 形式（src/lib/nenmatsu/fiscal-year.ts と同じ）

/** 日本時間の年月日 */
export function jstParts(now) {
  const d = new Date(now + JST)
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() }
}

/** 送る期間（11/15〜12/15・日本時間）か */
export function inSeason(now) {
  const { m, d } = jstParts(now)
  return (m === 11 && d >= 15) || (m === 12 && d <= 15)
}

/** 会社コードを数字として比較（コード未入力は最後） */
function byCode(a, b) {
  return (!a.code) - (!b.code) || String(a.code || '').localeCompare(String(b.code || ''), undefined, { numeric: true }) || String(a.name || '').localeCompare(String(b.name || ''), 'ja')
}

/**
 * 集計（純関数）。companies: [{code,name,roster:[empId],submissions:{empId:submittedAt}}]
 * 名簿にいない人の提出は「名簿外」として別に数える（N人中M人がNを超えないように）。
 */
export function summarize(companies, now) {
  const since = now - DAY
  const rows = companies.map((c) => {
    const roster = new Set(c.roster)
    const ids = Object.keys(c.submissions || {})
    const inRoster = roster.size ? ids.filter((id) => roster.has(id)) : ids
    const isFresh = (id) => {
      const t = Date.parse(c.submissions[id] || '')
      return t && t > since
    }
    return {
      code: c.code || '',
      name: c.name || '（会社名なし）',
      total: roster.size,
      done: inRoster.length,
      outside: ids.length - inRoster.length,
      fresh: inRoster.filter(isFresh).length,
      freshOutside: ids.filter((id) => !inRoster.includes(id) && isFresh(id)).length,
    }
  }).sort(byCode)
  const sum = (k) => rows.reduce((s, r) => s + r[k], 0)
  return {
    rows,
    total: sum('total'),
    done: sum('done'),
    fresh: sum('fresh'),
    freshAny: sum('fresh') + sum('freshOutside'), // 名簿にいない人の新着でも送る
    complete: rows.filter((r) => r.total > 0 && r.done >= r.total).length,
  }
}

/** メールの件名・本文 */
export function buildMail(s, now) {
  const { m, d } = jstParts(now)
  const subject = `【年調 提出状況】${m}/${d} 新着${s.fresh}人（全体 ${s.done}/${s.total}人）`
  const lines = [
    `${m}/${d} 7:00 時点の年末調整の提出状況です。`,
    '',
    `全体：${s.total}人中 ${s.done}人提出（昨日から +${s.fresh}人）／全員提出済み ${s.complete}社・登録 ${s.rows.length}社`,
    '',
  ]
  for (const r of s.rows) {
    const head = `${r.fresh || r.freshOutside ? '★' : '・'}${r.code ? r.code + ' ' : ''}${r.name}`
    let tail
    if (!r.total) tail = `名簿未取込（提出 ${r.done}件）`
    else tail = `${r.total}人中 ${r.done}人提出${r.fresh ? `（昨日から +${r.fresh}人）` : ''}${r.done >= r.total ? ' ✅全員提出' : ''}`
    if (r.outside) tail += `（名簿にいない人の提出 ${r.outside}件）`
    lines.push(`${head}　${tail}`)
  }
  lines.push(
    '',
    '★＝昨日7時以降に新しい提出があった会社',
    '※ 新しい提出があった日だけ届きます（11/15〜12/15）。提出内容は「年調データ受信」の画面でご確認ください。',
  )
  return { subject, text: lines.join('\n') }
}

// ---------------- ここから実行部分（GitHub Actions） ----------------

async function main() {
  const now = Date.now()
  const force = process.env.FORCE === 'true'
  if (!inSeason(now) && !force) {
    console.log('送信期間（11/15〜12/15）外のため送りません。')
    return
  }
  const need = (k) => {
    const v = process.env[k]
    if (!v) throw new Error(`GitHub Secrets の ${k} が未設定です。`)
    return v
  }
  const sa = JSON.parse(need('FIREBASE_SERVICE_ACCOUNT'))
  const to = process.env.NENMATSU_DIGEST_TO || need('NOTIFY_TO')
  const cfg = readFileSync(new URL('../../src/lib/bank-statement/firebase-config.ts', import.meta.url), 'utf8')
  const dbUrl = (cfg.match(/databaseURL:\s*'([^']+)'/) || [])[1]
  if (!dbUrl) throw new Error('databaseURL を読み取れませんでした。')

  const { initializeApp, cert } = await import('firebase-admin/app')
  const app = initializeApp({ credential: cert(sa) })
  let tok = { access_token: '', expires_in: 0 }
  let tokAt = 0
  const get = async (segs, shallow = false) => {
    if (!tok.access_token || Date.now() - tokAt > 30 * 60 * 1000) {
      tok = await app.options.credential.getAccessToken()
      tokAt = Date.now()
    }
    const path = segs.map(encodeURIComponent).join('/')
    const res = await fetch(`${dbUrl}/${path}.json${shallow ? '?shallow=true' : ''}`, {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    })
    // 応答本文はログに出さない（データが含まれうるため）
    if (!res.ok) throw new Error(`データの読み取りに失敗しました（HTTP ${res.status}）`)
    return res.json()
  }

  const { y } = jstParts(now)
  const yearId = 'R' + (y - REIWA_BASE)
  const rooms = Object.keys((await get(['rooms'], true)) || {})
  const companies = []
  for (const rk of rooms) {
    const comps = (await get(['rooms', rk, 'nenmatsu', yearId, 'companies'])) || {}
    await Promise.all(Object.entries(comps).map(async ([cid, c]) => {
      if (!c || typeof c !== 'object') return
      const roster = Object.keys((await get(['rooms', rk, 'nenmatsu', yearId, 'employees', cid], true)) || {})
      // 提出記録：新形式（会社トークン配下）＋旧形式（合言葉の部屋の配下）
      const ids = new Map() // empId -> パス
      if (c.token) for (const id of Object.keys((await get(['nenmatsu-public', c.token, 'submissions'], true)) || {})) ids.set(id, ['nenmatsu-public', c.token, 'submissions', id])
      for (const id of Object.keys((await get(['rooms', rk, 'nenmatsu', yearId, 'submissions', cid], true)) || {})) if (!ids.has(id)) ids.set(id, ['rooms', rk, 'nenmatsu', yearId, 'submissions', cid, id])
      const submissions = {}
      await Promise.all([...ids].map(async ([id, p]) => { submissions[id] = String((await get([...p, 'submittedAt'])) || '') }))
      companies.push({ code: c.code || '', name: c.name || '', roster, submissions })
    }))
  }

  const s = summarize(companies, now)
  console.log(`年度 ${yearId}：登録 ${s.rows.length}社・提出 ${s.done}/${s.total}人・新着 ${s.freshAny}人`)
  if (!s.freshAny && !force) {
    console.log('新しい提出が無いため送りません。')
    return
  }
  const mail = buildMail(s, now)
  const nodemailer = (await import('nodemailer')).default
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: need('GMAIL_USER'), pass: need('GMAIL_PASS') },
  })
  await transporter.sendMail({ from: `年調データ受信 <${need('GMAIL_USER')}>`, to, subject: mail.subject, text: mail.text })
  console.log('まとめメールを送信しました。')
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => {
    console.error('::error::' + (e instanceof Error ? e.message : '不明なエラー'))
    process.exit(1)
  })
}
