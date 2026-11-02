// 年調データ受信：送信の診断（読み取り専用・GitHub Actions から手動実行）
//
// 「送信しています…から進まない」の調査用。Storage にある提出画像と提出記録を突き合わせ、
//   ・記録まで済んだ提出：1件あたりの枚数・容量・アップロードにかかった時間
//   ・画像だけ届いて記録が無い（＝途中で止まった）送信：件数・容量・時間
//   ・画像1枚の大きさの分布
// を数字だけ出す。何も書き換えない・削除しない。
// 【厳守】ログは公開されうるので、トークン・会社名・氏名・ファイル名は出さない。
//   止まった送信の会社名・氏名は、MAIL_STUCK=true のときだけメール（まとめメールと同じ宛先）で送る。

import { readFileSync } from 'node:fs'

const need = (k) => {
  const v = process.env[k]
  if (!v) throw new Error(`GitHub Secrets の ${k} が未設定です。`)
  return v
}

const pct = (arr, p) => {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))]
}
const mb = (b) => (b / 1024 / 1024).toFixed(1)
const dist = (label, arr, fmt) =>
  console.log(`${label}：${arr.length}件　最小 ${fmt(pct(arr, 0))}／中央 ${fmt(pct(arr, 0.5))}／9割 ${fmt(pct(arr, 0.9))}／最大 ${fmt(pct(arr, 1))}`)

async function main() {
  const sa = JSON.parse(need('FIREBASE_SERVICE_ACCOUNT'))
  const cfg = readFileSync(new URL('../../src/lib/bank-statement/firebase-config.ts', import.meta.url), 'utf8')
  const dbUrl = (cfg.match(/databaseURL:\s*'([^']+)'/) || [])[1]
  const bucketName = (cfg.match(/storageBucket:\s*'([^']+)'/) || [])[1]
  if (!dbUrl || !bucketName) throw new Error('Firebase の設定を読み取れませんでした。')

  const { initializeApp, cert } = await import('firebase-admin/app')
  const { getStorage } = await import('firebase-admin/storage')
  const app = initializeApp({ credential: cert(sa), storageBucket: bucketName })
  const get = async (segs, shallow = false) => {
    const tok = await app.options.credential.getAccessToken()
    const res = await fetch(`${dbUrl}/${segs.map(encodeURIComponent).join('/')}.json${shallow ? '?shallow=true' : ''}`, {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    })
    if (!res.ok) throw new Error(`データの読み取りに失敗しました（HTTP ${res.status}）`)
    return res.json()
  }

  // 提出画像（nenmatsu-public/{token}/{empId}/{docKey}_{n}.jpg）
  const [files] = await getStorage(app).bucket().getFiles({ prefix: 'nenmatsu-public/' })
  const since = Date.now() - 60 * 24 * 3600 * 1000 // 直近60日（今年の受付分）
  const groups = new Map() // token/empId -> [{path,size,at}]
  for (const f of files) {
    const parts = f.name.split('/')
    if (parts.length !== 4) continue
    const at = Date.parse(f.metadata.timeCreated || '')
    if (!at || at < since) continue
    const key = parts[1] + '/' + parts[2]
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push({ path: f.name, size: Number(f.metadata.size) || 0, at })
  }

  const fileSizes = []
  const ok = { count: [], bytes: [], secs: [], mbps: [] }
  const stuck = { groups: 0, files: 0, bytes: [], secs: [], afterRecord: 0, list: [] }
  const hours = new Map()
  for (const [key, list] of groups) {
    const [token, empId] = key.split('/')
    const rec = (await get(['nenmatsu-public', token, 'submissions', empId])) || null
    const paths = new Set(rec && rec.paths ? (Array.isArray(rec.paths) ? rec.paths : Object.values(rec.paths)) : [])
    const recAt = rec ? Date.parse(rec.submittedAt || '') : 0
    const inRec = list.filter((x) => paths.has(x.path))
    // 記録に入っていない画像のうち、記録の日時より後に上げられたもの＝記録まで行かなかった送信
    const orphan = list.filter((x) => !paths.has(x.path) && (!recAt || x.at > recAt))
    for (const x of list) fileSizes.push(x.size)
    if (inRec.length) {
      const t0 = Math.min(...inRec.map((x) => x.at))
      const t1 = Math.max(...inRec.map((x) => x.at))
      const bytes = inRec.reduce((s, x) => s + x.size, 0)
      const secs = (t1 - t0) / 1000
      ok.count.push(inRec.length)
      ok.bytes.push(bytes)
      if (inRec.length > 1 && secs > 0) {
        ok.secs.push(secs)
        ok.mbps.push((bytes * 8) / 1e6 / secs)
      }
    }
    if (orphan.length) {
      stuck.groups++
      stuck.files += orphan.length
      stuck.bytes.push(orphan.reduce((s, x) => s + x.size, 0))
      const t0 = Math.min(...orphan.map((x) => x.at))
      const t1 = Math.max(...orphan.map((x) => x.at))
      stuck.secs.push((t1 - t0) / 1000)
      if (recAt) stuck.afterRecord++
      stuck.list.push({ token, empId, files: orphan.length, at: t0, resubmit: !!recAt, prevAt: recAt })
      const h = new Date(t0 + 9 * 3600 * 1000).toISOString().slice(0, 13).replace('T', ' ') + '時'
      hours.set(h, (hours.get(h) || 0) + 1)
    }
  }

  console.log(`直近60日に画像のある提出者：${groups.size}人`)
  console.log('')
  console.log('■ 画像1枚の大きさ')
  dist('　画像', fileSizes, (b) => mb(b) + 'MB')
  console.log('')
  console.log('■ 記録まで済んだ送信（1人分）')
  dist('　枚数', ok.count, (n) => n + '枚')
  dist('　容量', ok.bytes, (b) => mb(b) + 'MB')
  dist('　1枚目〜最後の画像までの時間', ok.secs, (s) => Math.round(s) + '秒')
  dist('　実効速度', ok.mbps, (v) => v.toFixed(1) + 'Mbps')
  console.log('')
  console.log('■ 画像は届いたのに記録が無い（送信が途中で止まった）')
  console.log(`　${stuck.groups}人分・${stuck.files}枚（うち再提出の途中 ${stuck.afterRecord}人）`)
  dist('　容量', stuck.bytes, (b) => mb(b) + 'MB')
  dist('　届いた画像の時間幅', stuck.secs, (s) => Math.round(s) + '秒')
  console.log('　開始した日時（日本時間）：' + ([...hours].sort().map(([h, n]) => `${h}×${n}`).join('、') || 'なし'))

  if (process.env.MAIL_STUCK === 'true') await mailStuck(stuck.list, get)
}

const jst = (t) => new Date(t + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ').replace(/-/g, '/')

/** 止まった送信の一覧（会社名・氏名）をメールで送る。ログには件数しか出さない */
async function mailStuck(list, get) {
  // トークン → 会社（年度ごとの登録会社から引く）
  const rooms = Object.keys((await fetchShallow(get, ['rooms'])) || {})
  const byToken = new Map()
  for (const rk of rooms) {
    const years = Object.keys((await fetchShallow(get, ['rooms', rk, 'nenmatsu'])) || {}).filter((y) => /^R\d+$/.test(y))
    for (const y of years) {
      const comps = (await get(['rooms', rk, 'nenmatsu', y, 'companies'])) || {}
      for (const [cid, c] of Object.entries(comps)) if (c && c.token) byToken.set(c.token, { rk, y, cid, name: c.name || '', code: c.code || '' })
    }
  }
  const lines = []
  for (const x of list.sort((a, b) => a.at - b.at)) {
    const comp = byToken.get(x.token)
    let who = '（名簿にない方・新入社員として入力）'
    if (comp) {
      const e = await get(['rooms', comp.rk, 'nenmatsu', comp.y, 'employees', comp.cid, x.empId])
      if (e) who = `${e.lastName || ''} ${e.firstName || ''}`.trim() + (e.code ? `（社員コード ${e.code}）` : '')
    }
    lines.push(
      `・${comp ? (comp.code ? comp.code + ' ' : '') + comp.name : '（会社不明）'}　${who}`,
      `　　送信した日時：${jst(x.at)}ごろ・写真 ${x.files}枚` +
        (x.resubmit ? `\n　　※再提出の途中で止まりました（${jst(x.prevAt)}に提出した分は届いています）` : '\n　　※提出は記録されていません（未提出の扱い）'),
    )
  }
  const text = [
    '「送信しています…」のまま止まった送信の一覧です（写真は届いたが、提出の記録まで進まなかったもの）。',
    '11/2 に不具合を修正済みです。下記の方に、QRコードから開き直して再送信をお願いしてください。',
    '',
    ...(lines.length ? lines : ['該当なし']),
    '',
    '※ 写真は記録が無いため、7日ほどで自動的に片付きます。再送信していただければ問題ありません。',
  ].join('\n')
  const nodemailer = (await import('nodemailer')).default
  const t = nodemailer.createTransport({ service: 'gmail', auth: { user: need('GMAIL_USER'), pass: need('GMAIL_PASS') } })
  await t.sendMail({
    from: `年調データ受信 <${need('GMAIL_USER')}>`,
    to: process.env.NENMATSU_DIGEST_TO || need('NOTIFY_TO'),
    subject: `【年調】送信が止まっていた方の一覧（${list.length}人）`,
    text,
  })
  console.log(`止まった送信の一覧（${list.length}人）をメールで送りました。`)
}

async function fetchShallow(get, segs) {
  return get(segs, true)
}

main().catch((e) => {
  console.error('::error::' + (e instanceof Error ? e.message : '不明なエラー'))
  process.exit(1)
})
