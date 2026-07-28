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

const { onValueCreated } = require('firebase-functions/v2/database')
const { defineSecret } = require('firebase-functions/params')
const { initializeApp } = require('firebase-admin/app')
const { getDatabase } = require('firebase-admin/database')
const nodemailer = require('nodemailer')

initializeApp()

// Secret Manager に登録する値（firebase functions:secrets:set で登録）
const GMAIL_USER = defineSecret('GMAIL_USER') // 送信元Gmailアドレス
const GMAIL_PASS = defineSecret('GMAIL_PASS') // Gmailのアプリパスワード（16桁）
const NOTIFY_TO = defineSecret('NOTIFY_TO')   // 通知先メールアドレス

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
    secrets: [GMAIL_USER, GMAIL_PASS, NOTIFY_TO],
    // 通知が失敗しても顧問先のアップロード自体には影響しない。無限リトライは避ける
    retry: false,
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
  },
)
