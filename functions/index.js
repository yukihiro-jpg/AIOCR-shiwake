// 書類スキャン受信：顧問先がアップロードしたときに事務所へメール通知する Cloud Function。
//
// 仕組み
//   顧問先が送信 → アプリが scan-public/{token}/notify/{id} に1件だけ記録を書く
//   → この関数が起動し、scan-public/{token}/info/name（顧問先名）を読んでメール送信
//   → 送信済みの記録は削除する（溜まらないようにするため）
//
// 「送信のたびに1通」にするため、ファイル1件ごとではなく "送信1回につき1件" の記録を
// アプリ側で書いている（件名の「〇件」はその記録の count を使う）。
//
// メール送信は Gmail の SMTP（アプリパスワード）を使う。パスワード等は
// Secret Manager に保管し、リポジトリには一切置かない。

const { onValueCreated, onValueWritten } = require('firebase-functions/v2/database')
const { defineSecret } = require('firebase-functions/params')
const { initializeApp } = require('firebase-admin/app')
const { getDatabase } = require('firebase-admin/database')
const { getStorage } = require('firebase-admin/storage')
const { JWT } = require('google-auth-library')
const nodemailer = require('nodemailer')

initializeApp()

// Secret Manager に登録する値（firebase functions:secrets:set で登録）
const GMAIL_USER = defineSecret('GMAIL_USER') // 送信元Gmailアドレス
const GMAIL_PASS = defineSecret('GMAIL_PASS') // Gmailのアプリパスワード（16桁）
const NOTIFY_TO = defineSecret('NOTIFY_TO')   // 通知先メールアドレス
const DRIVE_SA_KEY = defineSecret('DRIVE_SA_KEY') // Googleドライブへ保存するサービスアカウントの鍵（JSON）

// 種別 → 件名に使う表示名
const KIND_LABEL = {
  files: '共有フォルダ',
  batch: 'スマホ撮影',
  cash: '現金引出・預入',
}

// Realtime Database のインスタンスは US（既定）なので、トリガーも us-central1 に置く。
// （データベースのリージョンと関数のリージョンが一致していないとデプロイに失敗する）
exports.notifyScanUpload = onValueCreated(
  {
    ref: '/scan-public/{token}/notify/{id}',
    region: 'us-central1',
    secrets: [GMAIL_USER, GMAIL_PASS, NOTIFY_TO, DRIVE_SA_KEY],
    // 通知が失敗しても顧問先のアップロード自体には影響しない。無限リトライは避ける
    retry: false,
    // ドライブへの自動保存（最大50MBのファイル）も同じ関数で行うので、時間とメモリを多めに取る
    timeoutSeconds: 540,
    memory: '1GiB',
  },
  async (event) => {
    const rec = event.data.val() || {}
    const token = event.params.token
    const id = event.params.id
    const db = getDatabase()

    // 送信済みの記録はすぐ消す（失敗しても二重送信されないよう、先に消してから送る）
    try { await db.ref(`scan-public/${token}/notify/${id}`).remove() } catch (e) { /* ignore */ }

    const kind = String(rec.kind || '')
    const label = KIND_LABEL[kind] || '資料'
    const count = Number(rec.count) || 0
    if (!count) return

    // 顧問先名は公開情報ノードから取得（記録側には持たせない）
    let name = ''
    try {
      const snap = await db.ref(`scan-public/${token}/info/name`).get()
      name = String(snap.val() || '')
    } catch (e) { /* ignore */ }
    if (!name) name = '顧問先'

    const subject = `${name}／${label} ${count}件追加`
    const when = new Date(rec.at || Date.now()).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
    const lines = [
      `${name} から ${label} に ${count}件 のアップロードがありました。`,
      '',
      `受信日時：${when}`,
      rec.member ? `送信者：${rec.member}` : '',
      rec.folder ? `フォルダ：${rec.folder}` : '',
      '',
      '※ 本文の内容は自動生成です。ファイルは「書類スキャン受信」の画面でご確認ください。',
    ].filter((l) => l !== '')

    const sendMail = async () => {
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: GMAIL_USER.value(), pass: GMAIL_PASS.value() },
      })
      await transporter.sendMail({
        from: `書類スキャン受信 <${GMAIL_USER.value()}>`,
        to: NOTIFY_TO.value(),
        subject,
        text: lines.join('\n'),
      })
    }
    // メールとドライブ保存は互いに影響させない（片方が失敗してももう片方は行う）
    const [mail] = await Promise.allSettled([
      sendMail(),
      kind === 'files' || kind === 'batch' ? autoSaveToDrive(token) : Promise.resolve(),
    ])
    if (mail.status === 'rejected') throw mail.reason
  },
)

// ============================================================
// Googleドライブへの自動保存
//   顧問先ごとに登録した保存先フォルダ（scan-public/{token}/driveAuto。例：顧問先／月次／受領資料）の中へ、
//   共有フォルダ（顧問先→税理士）のファイルを顧問先のフォルダ構成のまま、スマホ撮影の画像を「スマホ撮影」へ保存する。
//   ・アップロードのたびに（notifyScanUpload から）呼ばれ、未保存分をまとめて保存する
//   ・画面で保存先を登録したとき／「今すぐ保存」を押したときは driveAuto/req の書き込みで呼ばれる
//   ・保存したものには driveSavedAt を付ける（画面の「Drive済」と同じ印。手動保存済みも二重に保存しない）
//   ・保存先は共有ドライブのフォルダであること（サービスアカウントはマイドライブに容量を持たない）
// ============================================================

exports.driveAutoRequest = onValueWritten(
  {
    ref: '/scan-public/{token}/driveAuto/req',
    region: 'us-central1',
    secrets: [DRIVE_SA_KEY],
    retry: false,
    timeoutSeconds: 540,
    memory: '1GiB',
  },
  async (event) => {
    if (!event.data.after.exists()) return // 設定の解除
    await autoSaveToDrive(event.params.token, { check: true })
  },
)

const DRIVE = 'https://www.googleapis.com/drive/v3'
const LOCK_MS = 15 * 60 * 1000 // 処理中の印の有効時間（関数が途中で落ちても15分後には再試行できる）

async function driveAuth() {
  const k = JSON.parse(DRIVE_SA_KEY.value())
  const jwt = new JWT({ email: k.client_email, key: k.private_key, scopes: ['https://www.googleapis.com/auth/drive'] })
  const { token } = await jwt.getAccessToken()
  return { token, email: k.client_email }
}

/** ドライブAPIのエラーを、事務所の画面にそのまま出せる日本語にする */
function driveError(status, body) {
  let reason = ''
  let msg = ''
  try {
    const e = JSON.parse(body).error || {}
    reason = ((e.errors || [])[0] || {}).reason || ''
    msg = e.message || ''
  } catch { /* ignore */ }
  if (reason === 'accessNotConfigured' || /has not been used|is disabled/.test(msg)) {
    return new Error('Google Drive API が有効になっていません。Google Cloud のコンソールで Drive API を有効にしてください。')
  }
  if (status === 404 || reason === 'notFound') {
    return new Error('保存先フォルダが見つかりません。URLが正しいか、下のアドレスを共有ドライブ（またはフォルダ）のメンバーに追加したかをご確認ください。')
  }
  if (reason === 'storageQuotaExceeded' || /storage quota/i.test(msg)) {
    return new Error('マイドライブのフォルダには保存できません。共有ドライブの中のフォルダを指定してください。')
  }
  if (status === 403) {
    return new Error('保存先フォルダに書き込む権限がありません。下のアドレスを「コンテンツ管理者」以上でメンバーに追加してください。')
  }
  return new Error(`ドライブへの保存に失敗しました（${status}${msg ? '：' + msg.slice(0, 120) : ''}）`)
}

// ドライブが一時的に混んでいるときの応答（503/500/502/504/429、403の rateLimitExceeded 等）は、
// 少し待ってやり直せば通る（Googleの推奨どおり指数的に待つ）。1回で諦めると一括保存が途中で止まる。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function retryable(status, body) {
  if ([429, 500, 502, 503, 504].includes(status)) return true
  if (status === 403 && /rateLimitExceeded|userRateLimitExceeded|backendError/.test(body || '')) return true
  return false
}
async function withRetry(doFetch) {
  let last = null
  for (let i = 0; i < 6; i++) {
    if (i) await sleep(Math.min(32000, 1000 * 2 ** i) + Math.floor(Math.random() * 1000))
    let r
    try { r = await doFetch() } catch (e) { last = { status: 0, body: String(e && e.message) }; continue } // 通信の瞬断
    if (r.ok) return r
    const body = await r.text()
    if (!retryable(r.status, body)) throw driveError(r.status, body)
    last = { status: r.status, body }
  }
  throw driveError(last.status, last.body)
}

async function dapi(tok, path, opt = {}) {
  const r = await withRetry(() => fetch(path.startsWith('http') ? path : `${DRIVE}/${path}`, {
    ...opt,
    headers: { Authorization: `Bearer ${tok}`, ...(opt.headers || {}) },
  }))
  const text = await r.text()
  return text ? JSON.parse(text) : {}
}

/** 親フォルダの中の同名フォルダを探し、無ければ作る */
async function ensureFolder(tok, parentId, name, cache) {
  const key = parentId + '/' + name
  if (cache.has(key)) return cache.get(key)
  const q = encodeURIComponent(`'${parentId}' in parents and name='${qstr(name)}' and mimeType='application/vnd.google-apps.folder' and trashed=false`)
  const found = await dapi(tok, `files?q=${q}&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=files(id)&pageSize=1`)
  let id = (found.files || [])[0]?.id
  if (!id) {
    const made = await dapi(tok, 'files?supportsAllDrives=true&fields=id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }),
    })
    id = made.id
  }
  cache.set(key, id)
  return id
}

/** 再開可能アップロード（大きなファイルでも確実に送る） */
async function uploadFile(tok, parentId, name, buf, mime) {
  const type = mime || 'application/octet-stream'
  // 送信の途中で混雑エラーになったら、送信の受付からやり直す（受付だけ済んだ分はドライブに残らない）
  await withRetry(async () => {
    const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tok}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': type,
        'X-Upload-Content-Length': String(buf.length),
      },
      body: JSON.stringify({ name, parents: [parentId] }),
    })
    if (!r.ok) return r
    return fetch(r.headers.get('location'), { method: 'PUT', headers: { 'Content-Type': type }, body: buf })
  })
}

/** 二重保存を防ぐ印（同時に2つの関数が動いても片方だけが保存する） */
async function takeLock(ref) {
  const now = Date.now()
  const res = await ref.transaction((cur) => {
    if (cur && now - Date.parse(cur) < LOCK_MS) return undefined // 他で処理中
    return new Date(now).toISOString()
  })
  return res.committed
}

const jstStamp = (iso) => {
  const d = new Date(Date.parse(iso || '') + 9 * 3600 * 1000)
  return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 16).replace('T', '_').replace(':', '')
}
const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|\r\n]/g, '_').trim().slice(0, 80)
const qstr = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")

/** 同じフォルダに同じ名前・同じ大きさのファイルが既にあるか（一括保存で二重に入れないため） */
async function existsSame(tok, parentId, name, size) {
  const q = encodeURIComponent(`'${parentId}' in parents and name='${qstr(name)}' and trashed=false`)
  const r = await dapi(tok, `files?q=${q}&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=files(id,size)&pageSize=10`)
  return (r.files || []).some((x) => Number(x.size) === Number(size))
}

const FULL_BUDGET_MS = 420 * 1000 // 一括保存は1回の実行で7分まで。残りは自分をもう一度呼んで続ける

async function autoSaveToDrive(token, opts = {}) {
  const startedAt = Date.now()
  const db = getDatabase()
  const base = `scan-public/${token}`
  const cfg = (await db.ref(`${base}/driveAuto`).get()).val()
  if (!cfg || !cfg.folderId) return
  const statusRef = db.ref(`${base}/driveAuto/status`)
  let email = ''
  try {
    const auth = await driveAuth()
    email = auth.email
    const tok = auth.token
    // 保存先の確認（登録直後・再実行のときは、保存するものが無くても結果を返す）
    const folder = await dapi(tok, `files/${cfg.folderId}?supportsAllDrives=true&fields=id,name,mimeType,driveId`)
    if (folder.mimeType !== 'application/vnd.google-apps.folder') throw new Error('指定されたURLはフォルダではありません。フォルダのURLを貼り付けてください。')
    if (!folder.driveId) throw new Error('マイドライブのフォルダには保存できません。共有ドライブの中のフォルダを指定してください。')
    if (opts.check) await statusRef.update({ checkedAt: new Date().toISOString(), ok: true, folderName: folder.name || '', saEmail: email, error: null })

    const since = cfg.since || ''
    const fresh = (x) => x && !x.driveSavedAt && (!since || String(x.submittedAt || '') >= since)
    const bucket = getStorage().bucket()
    const cache = new Map()
    let count = 0

    // ① 共有フォルダ（顧問先→税理士）：登録フォルダの中に、顧問先のフォルダ構成をそのまま作って入れる
    //    （例：受領資料／ガス問屋／10月／○○.pdf。顧問先が新しく作ったフォルダもドライブ側に作る）
    const files = (await db.ref(`${base}/files`).get()).val() || {}
    const folders = (await db.ref(`${base}/folders`).get()).val() || {}
    const chainOf = (fid) => {
      const names = []
      let cur = fid ? folders[fid] : null
      for (let i = 0; cur && i < 20; i++) { names.unshift(safeName(cur.name)); cur = cur.parentId ? folders[cur.parentId] : null }
      return names
    }
    const parentOf = async (f) => {
      const names = f.folderId ? chainOf(f.folderId) : f.folder ? [safeName(f.folder)] : []
      let parent = cfg.folderId
      for (const n of names) if (n) parent = await ensureFolder(tok, parent, n, cache)
      return parent
    }
    for (const f of Object.values(files)) {
      if (!fresh(f) || !f.path) continue
      const lock = db.ref(`${base}/files/${f.id}/driveAutoAt`)
      if (!(await takeLock(lock))) continue
      try {
        const parent = await parentOf(f)
        const [buf] = await bucket.file(f.path).download()
        await uploadFile(tok, parent, safeName(f.name) || 'file', buf, f.mimeType)
        await db.ref(`${base}/files/${f.id}`).update({ driveSavedAt: new Date().toISOString(), driveAutoAt: null })
        count++
      } catch (e) {
        await lock.remove().catch(() => {})
        throw e
      }
    }

    // ② スマホ撮影：登録フォルダ／スマホ撮影 に 書類の種類_日時_番号.jpg で入れる
    const batches = (await db.ref(`${base}/batches`).get()).val() || {}
    for (const b of Object.values(batches)) {
      if (!fresh(b) || !Array.isArray(b.paths) || !b.paths.length) continue
      const lock = db.ref(`${base}/batches/${b.id}/driveAutoAt`)
      if (!(await takeLock(lock))) continue
      try {
        const parent = await ensureFolder(tok, cfg.folderId, 'スマホ撮影', cache)
        const head = [safeName(b.docType) || '書類', b.bankName ? safeName(b.bankName) : '', jstStamp(b.submittedAt)].filter(Boolean).join('_')
        for (let i = 0; i < b.paths.length; i++) {
          const [buf] = await bucket.file(b.paths[i]).download()
          await uploadFile(tok, parent, `${head}_${i + 1}.jpg`, buf, 'image/jpeg')
        }
        await db.ref(`${base}/batches/${b.id}`).update({ driveSavedAt: new Date().toISOString(), driveAutoAt: null })
        count++
      } catch (e) {
        await lock.remove().catch(() => {})
        throw e
      }
    }

    // ③ 一括保存（画面の「共有フォルダの全ファイルを保存」・1回だけ）：Drive済かどうかに関係なく、
    //    共有フォルダ（顧問先→税理士）の全ファイルを同じフォルダ構成で入れる。
    //    同じ場所に同じ名前・同じ大きさのファイルが既にあれば入れない（何度押しても二重にならない）。
    //    件数が多いときは7分ごとに区切り、自分をもう一度呼んで続きから行う。
    const full = cfg.full
    if (full && full.requestedAt && !full.finishedAt) {
      const done = full.done || {}
      const all = Object.values(files).filter((f) => f && f.path)
      const fullRef = db.ref(`${base}/driveAuto/full`)
      // 進み具合は1件ごとに書く（画面の「○ / ○件」がその場で進む。updatedAt は止まったかどうかの判定に使う）
      let doneCount = Object.keys(done).length
      let savedTotal = full.saved || 0
      let skippedTotal = full.skipped || 0
      await fullRef.update({ total: all.length, doneCount, updatedAt: Date.now() })
      let moved = 0
      let skipped = 0
      let rest = false // 時間切れで残りがある（自分をもう一度呼ぶ）
      let busy = 0 // 別の保存が処理中だったもの（次のアップロード／再実行のときに続ける。すぐには呼び直さない）
      for (const f of all) {
        if (done[f.id]) continue
        if (Date.now() - startedAt > FULL_BUDGET_MS) { rest = true; break }
        const lock = db.ref(`${base}/files/${f.id}/driveAutoAt`)
        if (!(await takeLock(lock))) { busy++; continue }
        try {
          const parent = await parentOf(f)
          const name = safeName(f.name) || 'file'
          if (await existsSame(tok, parent, name, f.size)) {
            skipped++
          } else {
            const [buf] = await bucket.file(f.path).download()
            await uploadFile(tok, parent, name, buf, f.mimeType)
            moved++
          }
          await db.ref(`${base}/files/${f.id}`).update({ driveSavedAt: f.driveSavedAt || new Date().toISOString(), driveAutoAt: null })
          await db.ref(`${base}/driveAuto/full/done/${f.id}`).set(true)
          doneCount++
          await fullRef.update({ doneCount, saved: savedTotal + moved, skipped: skippedTotal + skipped, updatedAt: Date.now() })
          await sleep(300) // 続けざまに送ってドライブを混ませない
        } catch (e) {
          await lock.remove().catch(() => {})
          throw e
        }
      }
      await fullRef.update({
        total: all.length,
        doneCount,
        saved: savedTotal + moved,
        skipped: skippedTotal + skipped,
        updatedAt: Date.now(),
        ...(rest || busy ? {} : { finishedAt: new Date().toISOString() }),
      })
      count += moved
      if (rest) await db.ref(`${base}/driveAuto/req`).set(Date.now()) // 続きを別の実行で行う
    }

    if (count || opts.check) {
      await statusRef.update({
        ok: true, saEmail: email, error: null, folderName: folder.name || '',
        ...(count ? { lastSavedAt: new Date().toISOString(), lastCount: count } : {}),
      })
    }
  } catch (e) {
    console.error('driveAuto failed', e && e.message)
    await statusRef.update({
      checkedAt: new Date().toISOString(), ok: false, saEmail: email || null,
      error: (e && e.message) || 'ドライブへの保存に失敗しました',
    }).catch(() => {})
  }
}
