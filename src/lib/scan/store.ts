// 書類スキャン（顧問先スマホ撮影→事務所受信）モジュールの Firebase(RTDB+Storage) データアクセス。
// 事務所側の管理情報は rooms/{roomKey}/scan/companies/{clientId} に保存（合言葉ルームでスコープ）。
// 顧問先（スマホ）側は scan-public/{token}/... のみを読み書きする（roomKey は一切渡さない）。
// パターンは src/lib/nenmatsu/store.ts を踏襲。

import { getDb } from '@/core/firebase'
import { modulePath, hasRoom } from '@/core/room'

export const SCAN_KEY = 'scan'

export interface ScanClient {
  id: string
  name: string
  code?: string
}

export interface ScanMember {
  id: string
  name: string // 例：社長、経理担当、山田
  token: string // メンバー専用URLのトークン
  createdAt: string
}

export interface ScanCompany {
  clientId: string
  code: string
  name: string
  token: string // 会社（全員用）URLのトークン
  registeredAt: string
  members?: Record<string, ScanMember> // メンバー別URL（宛先制御用）
}

export type ScanStatus = 'new' | 'done'

export interface ScanBatch {
  id: string
  docType: string
  bankName?: string
  accountNumber?: string
  userName?: string
  pageCount: number
  paths: string[]
  submittedAt: string
  status: ScanStatus
  transferredAt?: string // 仕訳作成へ転送した日時（二重取込防止の目印）
  member?: string // 送信したメンバー名（メンバー用URLからの送信時）
}

export type CashEntryType = '現金引出' | '現金預入'
export type CashDepositType = '売上金の預入' | 'その他の預入'

export interface ScanCashEntry {
  id: string
  entryType: CashEntryType
  date: string
  bankName: string
  accountNumber?: string
  amount: number
  depositType?: CashDepositType
  submittedAt: string
  status: ScanStatus
  member?: string // 送信したメンバー名
}

async function dbfns() {
  const db = await getDb()
  const m = await import('firebase/database')
  return { db, ...m }
}

async function storageFns() {
  await getDb() // app初期化＋匿名認証を保証
  const { getApps } = await import('firebase/app')
  const s = await import('firebase/storage')
  const app = getApps()[0]
  return { st: s.getStorage(app), ...s }
}

function randomToken(): string {
  const a = new Uint8Array(16)
  crypto.getRandomValues(a)
  return Array.from(a)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** 公開領域（顧問先がアクセスする場所）のRTDBパス。token はルームとは独立の128bit乱数 */
function publicPath(token: string, ...seg: string[]): string {
  return `scan-public/${token}${seg.length ? '/' + seg.join('/') : ''}`
}

// ===== 顧問先情報（komon）で「書類スキャン受信＝利用」にした会社だけを読む =====
export async function loadScanClients(): Promise<ScanClient[]> {
  const { db, ref, get } = await dbfns()
  const path = await modulePath(SCAN_KEY, '_clients')
  const snap = await get(ref(db, path))
  const val = snap.val() || {}
  return Object.values(val)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((c: any) => ({ id: c.id, name: c.name, code: c.code }))
    .filter((c: ScanClient) => c && c.id && c.name)
    .sort((a, b) => (a.code || '').localeCompare(b.code || '', 'ja', { numeric: true }))
}

// ===== 事務所側：登録会社管理（合言葉ルーム内） =====

/** 登録会社一覧 */
export async function loadScanCompanies(): Promise<Record<string, ScanCompany>> {
  const { db, ref, get } = await dbfns()
  const path = await modulePath(SCAN_KEY, 'companies')
  const snap = await get(ref(db, path))
  return (snap.val() as Record<string, ScanCompany>) || {}
}

/** 会社をスキャン利用に登録（トークンを発行）。既存ならそれを返す。
 *  公開領域の会社名(info)は毎回書き直す（過去にルール不備等で書けていなくても自己修復される）。
 *  ※ members サブツリーを消さないよう、会社フィールドは update で書く */
export async function registerScanCompany(client: ScanClient): Promise<ScanCompany> {
  const { db, ref, get, set, update } = await dbfns()
  const path = await modulePath(SCAN_KEY, 'companies', client.id)
  const existing = (await get(ref(db, path))).val() as ScanCompany | null
  const company: ScanCompany =
    existing && existing.token
      ? { ...existing, name: client.name || existing.name, code: client.code || existing.code || '' }
      : {
          clientId: client.id,
          code: client.code || '',
          name: client.name,
          token: randomToken(),
          registeredAt: new Date().toISOString(),
        }
  await update(ref(db, path), {
    clientId: company.clientId,
    code: company.code,
    name: company.name,
    token: company.token,
    registeredAt: company.registeredAt,
  })
  await set(ref(db, publicPath(company.token, 'info')), { name: company.name })
  // メンバーの公開infoも自己修復（会社名変更の反映）
  for (const m of Object.values(company.members || {})) {
    if (m && m.token) {
      try {
        await set(ref(db, publicPath(m.token, 'info')), { name: company.name, member: m.name, ct: company.token })
      } catch { /* ignore */ }
    }
  }
  return company
}

// ===== メンバー別URL（宛先制御） =====

/** メンバーを追加し専用トークンURLを発行。公開info には会社名・メンバー名・会社トークン(ct)を書く。
 *  ct により、メンバーページは「全員宛」ファイルの閲覧と会社領域への撮影/送信ができる。
 *  他メンバーのトークンは info に含まれないため、他人宛のファイルには構造的に到達できない */
export async function addScanMember(company: ScanCompany, name: string): Promise<ScanMember> {
  const member: ScanMember = {
    id: genId(),
    name: name.trim(),
    token: randomToken(),
    createdAt: new Date().toISOString(),
  }
  const { db, ref, set } = await dbfns()
  const path = await modulePath(SCAN_KEY, 'companies', company.clientId, 'members', member.id)
  await set(ref(db, path), member)
  await set(ref(db, publicPath(member.token, 'info')), { name: company.name, member: member.name, ct: company.token })
  return member
}

/** メンバーを削除（URL失効）。未受領の宛先ファイルも削除する */
export async function removeScanMember(clientId: string, member: ScanMember): Promise<void> {
  const { db, ref, remove } = await dbfns()
  try {
    const inbox = await loadInbox(member.token)
    for (const f of Object.values(inbox)) {
      try { await deleteInboxFile(member.token, f) } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  try { await remove(ref(db, publicPath(member.token))) } catch { /* ignore */ }
  const path = await modulePath(SCAN_KEY, 'companies', clientId, 'members', member.id)
  await remove(ref(db, path))
}

/** 任意のトークン（会社/メンバー）からURLを組み立て */
export function buildScanUrlFromToken(token: string): string {
  const base = process.env.NEXT_PUBLIC_BASE_PATH || ''
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  return `${origin}${base}/scan-upload/?${new URLSearchParams({ t: token }).toString()}`
}

/** 公開トークン配下の Storage（ファイル・受信箱・バッチ）と公開サブツリーを丸ごと削除する。 */
async function purgeScanToken(token: string): Promise<void> {
  if (!token) return
  const { db, ref, remove } = await dbfns()
  try { const files = await loadFiles(token); for (const f of Object.values(files)) { try { await deleteScanFile(token, f) } catch { /* ignore */ } } } catch { /* ignore */ }
  try { const inbox = await loadInbox(token); for (const f of Object.values(inbox)) { try { await deleteInboxFile(token, f) } catch { /* ignore */ } } } catch { /* ignore */ }
  try { const batches = await loadBatches(token); for (const b of Object.values(batches)) { try { await deleteBatch(token, b) } catch { /* ignore */ } } } catch { /* ignore */ }
  try { await remove(ref(db, publicPath(token))) } catch { /* ignore */ }
}

/** 顧問先削除の purge キュー（scan/_purgeQueue/{clientId} = { tokens: string[], at }）。
 *  komon（iframe内・Storage SDKなし）は削除時にキューへ登録だけ行い、
 *  Storage を消せる事務所側のこの画面がキューを処理して実体（画像・ファイル）ごと削除する。
 *  【開発ルール】公開トークン配下にデータを持つモジュールを増やす場合は、必ず同様の
 *  キュー＋processPurgeQueue を用意する（RTDBだけ消すとStorageが永久に残る）。 */
export async function processScanPurgeQueue(): Promise<number> {
  if (!hasRoom()) return 0
  const { db, ref, get, remove } = await dbfns()
  const qPath = await modulePath(SCAN_KEY, '_purgeQueue')
  const snap = await get(ref(db, qPath))
  const entries = (snap.val() as Record<string, { tokens?: string[]; clientId?: string; at?: number }> | null) || {}
  let done = 0
  for (const [cid, e] of Object.entries(entries)) {
    try {
      for (const t of e?.tokens || []) {
        if (t) await purgeScanToken(t)
      }
      try { await remove(ref(db, await modulePath(SCAN_KEY, 'prefs', cid))) } catch { /* ignore */ }
      await remove(ref(db, `${qPath}/${cid}`))
      done++
    } catch { /* 失敗分はキューに残し、次回開いたときに再試行 */ }
  }
  return done
}

export async function unregisterScanCompany(clientId: string): Promise<void> {
  const { db, ref, remove } = await dbfns()
  // 公開領域（会社トークン＋各メンバートークン）のデータと Storage も削除する。
  // これをしないと、登録解除後も旧トークンの保持者が公開ファイル・受信箱を読めてしまう。
  try {
    const companies = await loadScanCompanies()
    const company = companies[clientId]
    if (company) {
      if (company.token) await purgeScanToken(company.token)
      for (const m of Object.values(company.members || {})) {
        if (m && m.token) await purgeScanToken(m.token)
      }
    }
  } catch { /* ignore */ }
  const path = await modulePath(SCAN_KEY, 'companies', clientId)
  await remove(ref(db, path))
}

/** 顧問先向けアップロードURL。
 *  【重要】roomKey は絶対に含めない。外部（顧問先）に渡るURLには、会社ごとのランダムトークン(t)のみを載せる。 */
export function buildScanUrl(company: ScanCompany): string {
  const base = process.env.NEXT_PUBLIC_BASE_PATH || ''
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const q = new URLSearchParams({ t: company.token })
  return `${origin}${base}/scan-upload/?${q.toString()}`
}

// ===== 顧問先側（公開ページ）：トークンのみで scan-public/{token} を読み書きする =====
// roomKey は受け取らない（外部に渡るURLへ載せないため）。

export interface ScanPublicInfo {
  name: string // 会社名
  member?: string // メンバー名（メンバー用URLの場合）
  ct?: string // 会社トークン（メンバー用URLの場合。撮影/送信先と全員宛ファイルの参照に使う）
}

/** 会社名（＋メンバー情報）を取得（顧問先ページ用）。token が無効なら null */
export async function loadScanInfoPublic(token: string): Promise<ScanPublicInfo | null> {
  if (!token) return null
  const { db, ref, get } = await dbfns()
  const info = (await get(ref(db, publicPath(token, 'info')))).val() as ScanPublicInfo | null
  if (!info || !info.name) return null
  return info
}

function genId(): string {
  return Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
}

/** 顧問先側：撮影バッチを送信（Storageへアップし、batchesに記録）。アップロード成否をそのまま返す */
export async function submitScanBatchPublic(
  token: string,
  docType: string,
  meta: { bankName?: string; accountNumber?: string; userName?: string; member?: string },
  images: Blob[],
): Promise<void> {
  if (!token) throw new Error('トークンがありません')
  if (!images || images.length === 0) throw new Error('画像がありません')
  if (images.length > 200) throw new Error('1回の送信は200枚までにしてください')
  assertUploadSizes(images.map((b, i) => ({ size: b.size, name: `${i + 1}枚目` })))
  const { st, ref: sref, uploadBytes } = await storageFns()
  const batchId = genId()
  const paths: string[] = []
  for (let i = 0; i < images.length; i++) {
    const path = `scan-public/${token}/${batchId}/p${i + 1}.jpg`
    await uploadBytes(sref(st, path), images[i], { contentType: 'image/jpeg' })
    paths.push(path)
  }
  const { db, ref, set } = await dbfns()
  const batch: ScanBatch = {
    id: batchId,
    docType,
    ...(meta.bankName ? { bankName: meta.bankName } : {}),
    ...(meta.accountNumber ? { accountNumber: meta.accountNumber } : {}),
    ...(meta.userName ? { userName: meta.userName } : {}),
    ...(meta.member ? { member: meta.member } : {}),
    pageCount: images.length,
    paths,
    submittedAt: new Date().toISOString(),
    status: 'new',
  }
  await set(ref(db, publicPath(token, 'batches', batchId)), batch)
}

/** 顧問先側：現金引出・預入の登録 */
export async function submitCashEntryPublic(
  token: string,
  entry: {
    entryType: CashEntryType
    date: string
    bankName: string
    accountNumber?: string
    amount: number
    depositType?: CashDepositType
    member?: string
  },
): Promise<void> {
  if (!token) throw new Error('トークンがありません')
  const { db, ref, set } = await dbfns()
  const id = genId()
  const rec: ScanCashEntry = {
    id,
    entryType: entry.entryType,
    date: entry.date,
    bankName: entry.bankName,
    ...(entry.accountNumber ? { accountNumber: entry.accountNumber } : {}),
    amount: entry.amount,
    ...(entry.depositType ? { depositType: entry.depositType } : {}),
    ...(entry.member ? { member: entry.member } : {}),
    submittedAt: new Date().toISOString(),
    status: 'new',
  }
  await set(ref(db, publicPath(token, 'cash', id)), rec)
}

// ===== ファイル便（PDF・Excel等のファイル受け渡し） =====
// 「同期」ではなく一方通行のコピー送付。削除は受け渡し箱（Firebase上のコピー）のみで、
// 顧問先の手元の元ファイルには一切影響しない。

export interface ScanFile {
  id: string
  name: string
  size: number
  mimeType: string
  path: string // Storage 上のパス
  folder?: string // 顧問先が付けたフォルダ名（旧仕様・任意・整理用。フォルダツリー導入前の互換用）
  folderId?: string | null // 共有フォルダ（toOfficeツリー）内の所属フォルダID。null/未設定=ルート直下
  submittedAt: string
  status: ScanStatus
  downloadedAt?: string // 事務所がDL（個別/ZIP）した日時
  driveSavedAt?: string // 事務所がGoogleドライブへ保存した日時
  member?: string // 送信したメンバー名
  comment?: string // 送信時のコメント（相手側に表示される）
}

// ===== 共有フォルダ（DocuWorks風フォルダツリー） =====
// 2つの固定ルート（toOffice=顧問先→事務所／toClient=事務所→顧問先）配下のサブフォルダのみを保持する。
// ルート自体はDBに実体を持たない仮想フォルダ。

export interface ScanFolder {
  id: string
  name: string
  root: 'toOffice' | 'toClient'
  parentId: string | null // null=ルート直下
  createdAt: string
}

export async function loadScanFolders(token: string): Promise<Record<string, ScanFolder>> {
  const { db, ref, get } = await dbfns()
  return ((await get(ref(db, publicPath(token, 'folders')))).val() as Record<string, ScanFolder>) || {}
}

export async function createScanFolder(
  token: string,
  root: 'toOffice' | 'toClient',
  parentId: string | null,
  name: string,
): Promise<ScanFolder> {
  const trimmed = safeFileName((name || '').trim()).slice(0, 40)
  if (!trimmed) throw new Error('フォルダ名を入力してください')
  const { db, ref, set } = await dbfns()
  const folder: ScanFolder = {
    id: genId(),
    name: trimmed,
    root,
    parentId: parentId || null,
    createdAt: new Date().toISOString(),
  }
  await set(ref(db, publicPath(token, 'folders', folder.id)), folder)
  return folder
}

export async function renameScanFolder(token: string, id: string, name: string): Promise<void> {
  const trimmed = safeFileName((name || '').trim()).slice(0, 40)
  if (!trimmed) throw new Error('フォルダ名を入力してください')
  const { db, ref, update } = await dbfns()
  await update(ref(db, publicPath(token, 'folders', id)), { name: trimmed })
}

/** フォルダ自身＋配下の子孫フォルダIDを収集（フォルダ削除時の対象判定に使う） */
export function collectFolderDescendantIds(folder: ScanFolder, allFolders: ScanFolder[]): Set<string> {
  const targetIds = new Set<string>([folder.id])
  let changed = true
  while (changed) {
    changed = false
    for (const f of allFolders) {
      if (f.parentId && targetIds.has(f.parentId) && !targetIds.has(f.id)) {
        targetIds.add(f.id)
        changed = true
      }
    }
  }
  return targetIds
}

/** フォルダを削除。配下の子フォルダ・ファイルも再帰的に削除してから、フォルダ本体を削除する。
 *  allFolders / filesInRoot は呼び出し側が渡す（該当rootの全フォルダ・全ファイル）。
 *  【注意】メンバー個別宛ファイル（別トークン配下）は含まれないため、呼び出し側で
 *  collectFolderDescendantIds を使って先に削除すること（ScanContent の toClient 削除参照）。 */
export async function deleteScanFolder(
  token: string,
  folder: ScanFolder,
  allFolders: ScanFolder[],
  filesInRoot: (ScanFile | ScanInboxFile)[],
): Promise<void> {
  const targetIds = collectFolderDescendantIds(folder, allFolders)
  // 対象フォルダ配下の全ファイルを削除
  for (const f of filesInRoot) {
    const fid = f.folderId
    if (fid && targetIds.has(fid)) {
      if (folder.root === 'toOffice') await deleteScanFile(token, f as ScanFile)
      else await deleteInboxFile(token, f as ScanInboxFile)
    }
  }
  // 対象フォルダ本体・子フォルダを削除
  const { db, ref, remove } = await dbfns()
  for (const id of Array.from(targetIds)) {
    try { await remove(ref(db, publicPath(token, 'folders', id))) } catch { /* ignore */ }
  }
}

export const SCAN_FILE_RETENTION_DAYS = 90 // 送信から90日で自動削除
export const SCAN_FILE_MAX_BYTES = 50 * 1024 * 1024 // 1ファイル上限 50MB
export const SCAN_FILE_MAX_TOTAL = 200 * 1024 * 1024 // 1回の送信上限 200MB

function safeFileName(name: string): string {
  return (name || 'file').replace(/[\\/:*?"<>|#\[\]]/g, '_').slice(0, 120)
}

/** アップロードサイズ上限の強制（UI側の表示チェックとは別に、書き込み関数側でも必ず検証する） */
function assertUploadSizes(files: { size: number; name?: string }[]): void {
  let total = 0
  for (const f of files) {
    if (f.size > SCAN_FILE_MAX_BYTES) {
      throw new Error(`「${f.name || 'ファイル'}」が1ファイル上限（${Math.round(SCAN_FILE_MAX_BYTES / 1024 / 1024)}MB）を超えています`)
    }
    total += f.size
  }
  if (total > SCAN_FILE_MAX_TOTAL) {
    throw new Error(`合計サイズが上限（${Math.round(SCAN_FILE_MAX_TOTAL / 1024 / 1024)}MB）を超えています`)
  }
}

/** 顧問先側：ファイルを送信（1件ずつStorageへ・RTDBに記録）。実際の成否を返す */
export async function submitFilesPublic(
  token: string,
  files: File[],
  folder?: string,
  folderId?: string | null,
  member?: string,
  comment?: string,
  onProgress?: (done: number, total: number, name: string) => void,
): Promise<void> {
  if (!token) throw new Error('トークンがありません')
  if (!files.length) throw new Error('ファイルがありません')
  // サイズ上限はUIだけでなく書き込み関数側でも強制する（UI迂回・改造クライアント対策の最低限）
  assertUploadSizes(files)
  const folderName = safeFileName((folder || '').trim()).slice(0, 40)
  const { st, ref: sref, uploadBytes } = await storageFns()
  const { db, ref, set } = await dbfns()
  for (let i = 0; i < files.length; i++) {
    const f = files[i]
    onProgress?.(i, files.length, f.name)
    const id = genId()
    const name = safeFileName(f.name)
    const path = `scan-public/${token}/files/${id}/${name}`
    await uploadBytes(sref(st, path), f, { contentType: f.type || 'application/octet-stream' })
    const rec: ScanFile = {
      id,
      name,
      size: f.size,
      mimeType: f.type || '',
      path,
      ...(folderName ? { folder: folderName } : {}),
      ...(folderId ? { folderId } : {}),
      ...(member ? { member } : {}),
      ...(comment && comment.trim() ? { comment: comment.trim().slice(0, 500) } : {}),
      submittedAt: new Date().toISOString(),
      status: 'new',
    }
    await set(ref(db, publicPath(token, 'files', id)), rec)
    onProgress?.(i + 1, files.length, f.name)
  }
}

// ===== 事務所 → 顧問先 のファイル送信（inbox） =====
// 宛先（会社=全員宛／メンバー）ごとのトークン領域にコピーを置く。
// 他メンバー宛のファイルはそのメンバーのトークンを知らない限り到達できない（構造的な宛先制御）。

export interface ScanInboxFile {
  id: string
  name: string
  size: number
  mimeType: string
  path: string
  folder?: string // 旧仕様のフォルダ名（フォルダツリー導入前の互換用）
  folderId?: string | null // 共有フォルダ（toClientツリー）内の所属フォルダID。null/未設定=ルート直下
  comment?: string // 送信時のコメント（顧問先側に表示される）
  sentAt: string
  downloadedAt?: string // 最初にDLされた日時
  downloads?: Record<string, string> // 誰がいつDLしたか（キー=メンバー名等をサニタイズしたもの）
}

function dlKey(who: string): string {
  return (who || '共通URL').replace(/[.#$/\[\]]/g, '_').slice(0, 40) || '共通URL'
}

/** 事務所側：宛先トークンの受信箱へファイルを送る */
export async function sendInboxFile(
  recipientToken: string,
  blob: Blob,
  fileName: string,
  folder?: string,
  folderId?: string | null,
  comment?: string,
): Promise<void> {
  assertUploadSizes([{ size: blob.size, name: fileName }])
  const { st, ref: sref, uploadBytes } = await storageFns()
  const { db, ref, set } = await dbfns()
  const id = genId()
  const name = safeFileName(fileName)
  const folderName = safeFileName((folder || '').trim()).slice(0, 40)
  const path = `scan-public/${recipientToken}/inbox/${id}/${name}`
  await uploadBytes(sref(st, path), blob, { contentType: blob.type || 'application/octet-stream' })
  const rec: ScanInboxFile = {
    id,
    name,
    size: blob.size,
    mimeType: blob.type || '',
    path,
    ...(folderName ? { folder: folderName } : {}),
    ...(folderId ? { folderId } : {}),
    ...(comment && comment.trim() ? { comment: comment.trim().slice(0, 500) } : {}),
    sentAt: new Date().toISOString(),
  }
  await set(ref(db, publicPath(recipientToken, 'inbox', id)), rec)
}

export async function loadInbox(token: string): Promise<Record<string, ScanInboxFile>> {
  const { db, ref, get } = await dbfns()
  return ((await get(ref(db, publicPath(token, 'inbox')))).val() as Record<string, ScanInboxFile>) || {}
}

/** 顧問先側：受け取り（DL）を記録 → 事務所側で受領確認できる */
export async function markInboxDownloaded(token: string, id: string, who: string): Promise<void> {
  const { db, ref, update } = await dbfns()
  const now = new Date().toISOString()
  await update(ref(db, publicPath(token, 'inbox', id)), {
    downloadedAt: now,
    [`downloads/${dlKey(who)}`]: now,
  })
}

export async function getInboxBlob(file: ScanInboxFile): Promise<Blob> {
  const { st, ref: sref, getBlob } = await storageFns()
  return getBlob(sref(st, file.path))
}

export async function deleteInboxFile(token: string, file: ScanInboxFile): Promise<void> {
  const { st, ref: sref, deleteObject } = await storageFns()
  try { await deleteObject(sref(st, file.path)) } catch { /* ignore */ }
  const { db, ref, remove } = await dbfns()
  await remove(ref(db, publicPath(token, 'inbox', file.id)))
}

/** 受信ファイルの所属フォルダを変更（フォルダ間移動）。folderId=null で最上位へ */
export async function moveInboxFile(token: string, id: string, folderId: string | null): Promise<void> {
  const { db, ref, update } = await dbfns()
  await update(ref(db, publicPath(token, 'inbox', id)), { folderId: folderId })
}

/** 事務所がDLした印を付ける */
export async function markFileDownloaded(token: string, id: string): Promise<void> {
  const { db, ref, update } = await dbfns()
  await update(ref(db, publicPath(token, 'files', id)), { downloadedAt: new Date().toISOString() })
}

/** 事務所がGoogleドライブへ保存した印を付ける */
export async function markFileDriveSaved(token: string, id: string): Promise<void> {
  const { db, ref, update } = await dbfns()
  await update(ref(db, publicPath(token, 'files', id)), { driveSavedAt: new Date().toISOString() })
}

export async function loadFiles(token: string): Promise<Record<string, ScanFile>> {
  const { db, ref, get } = await dbfns()
  return ((await get(ref(db, publicPath(token, 'files')))).val() as Record<string, ScanFile>) || {}
}

export async function setFileStatus(token: string, id: string, status: ScanStatus): Promise<void> {
  const { db, ref, update } = await dbfns()
  await update(ref(db, publicPath(token, 'files', id)), { status })
}

export async function deleteScanFile(token: string, file: ScanFile): Promise<void> {
  const { st, ref: sref, deleteObject } = await storageFns()
  try { await deleteObject(sref(st, file.path)) } catch { /* 既に無い等は無視 */ }
  const { db, ref, remove } = await dbfns()
  await remove(ref(db, publicPath(token, 'files', file.id)))
}

/** ファイルの所属フォルダを変更（フォルダ間移動）。folderId=null で最上位へ */
export async function moveScanFile(token: string, id: string, folderId: string | null): Promise<void> {
  const { db, ref, update } = await dbfns()
  await update(ref(db, publicPath(token, 'files', id)), { folderId: folderId })
}

export async function getScanFileBlob(file: ScanFile): Promise<Blob> {
  const { st, ref: sref, getBlob } = await storageFns()
  return getBlob(sref(st, file.path))
}

// ===== 事務所側：受信箱の閲覧・操作 =====

export async function loadBatches(token: string): Promise<Record<string, ScanBatch>> {
  const { db, ref, get } = await dbfns()
  const snap = await get(ref(db, publicPath(token, 'batches')))
  return (snap.val() as Record<string, ScanBatch>) || {}
}

/** バッチのリアルタイム購読。購読開始時に現在の全バッチが即時1回届き、以後は追加・変更のたびに届く。
 *  戻り値の関数で購読解除。 */
export async function subscribeBatches(
  token: string,
  cb: (batches: Record<string, ScanBatch>) => void,
): Promise<() => void> {
  const { db, ref } = await dbfns()
  const { onValue } = await import('firebase/database')
  return onValue(
    ref(db, publicPath(token, 'batches')),
    (snap) => cb((snap.val() as Record<string, ScanBatch>) || {}),
    () => { /* 権限エラー等は無視（画面側の読み込みエラー表示に任せる） */ },
  )
}

export async function loadCashEntries(token: string): Promise<Record<string, ScanCashEntry>> {
  const { db, ref, get } = await dbfns()
  const snap = await get(ref(db, publicPath(token, 'cash')))
  return (snap.val() as Record<string, ScanCashEntry>) || {}
}

export async function setBatchStatus(token: string, id: string, status: ScanStatus): Promise<void> {
  const { db, ref, update } = await dbfns()
  await update(ref(db, publicPath(token, 'batches', id)), { status })
}

/** 仕訳作成へ転送済みの目印を付ける */
export async function markBatchTransferred(token: string, id: string): Promise<void> {
  const { db, ref, update } = await dbfns()
  await update(ref(db, publicPath(token, 'batches', id)), { transferredAt: new Date().toISOString() })
}

// ===== 仕訳作成への転送設定（顧問先ごと・全端末共有） =====

export interface ScanCreditAccount {
  code: string
  name: string
  subCode?: string
  subName?: string
}

/** 「それ以外」で過去に選ばれた貸方科目の履歴（新しい順） */
export async function loadScanCreditHistory(clientId: string): Promise<ScanCreditAccount[]> {
  const { db, ref, get } = await dbfns()
  const path = await modulePath(SCAN_KEY, 'prefs', clientId, 'creditHistory')
  const v = (await get(ref(db, path))).val()
  return Array.isArray(v) ? (v as ScanCreditAccount[]) : []
}

/** 貸方科目の選択を履歴の先頭に記録（重複は除去・最大10件） */
export async function pushScanCreditHistory(clientId: string, acc: ScanCreditAccount): Promise<void> {
  const cur = await loadScanCreditHistory(clientId)
  const key = (a: ScanCreditAccount) => `${a.code}|${a.subCode || ''}`
  const next = [acc, ...cur.filter((a) => key(a) !== key(acc))].slice(0, 10)
  const { db, ref, set } = await dbfns()
  const path = await modulePath(SCAN_KEY, 'prefs', clientId, 'creditHistory')
  await set(ref(db, path), JSON.parse(JSON.stringify(next)))
}

export async function setCashStatus(token: string, id: string, status: ScanStatus): Promise<void> {
  const { db, ref, update } = await dbfns()
  await update(ref(db, publicPath(token, 'cash', id)), { status })
}

/** 事務所側：バッチ画像のダウンロードURL一覧（閲覧用） */
export async function getBatchImageUrls(token: string, batch: ScanBatch): Promise<string[]> {
  const { st, ref: sref, getDownloadURL } = await storageFns()
  const urls: string[] = []
  for (const p of batch.paths || []) {
    urls.push(await getDownloadURL(sref(st, p)))
  }
  return urls
}

/** 事務所側：バッチ画像を dataURL 配列で取得（Gemini解析用） */
export async function getBatchImageDataUrls(token: string, batch: ScanBatch): Promise<string[]> {
  const { st, ref: sref, getBlob } = await storageFns()
  const out: string[] = []
  for (const p of batch.paths || []) {
    const blob = await getBlob(sref(st, p))
    out.push(await blobToDataUrl(blob))
  }
  return out
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('画像の読み込みに失敗しました'))
    reader.readAsDataURL(blob)
  })
}

// ===== AI解析結果の保存（バッチごと・全端末共有） =====

export interface ScanAnalysisRow {
  date: string
  storeName: string // 店名／相手先／摘要（種別により意味が変わる。表のラベルは種別ごとに切替）
  mainContent: string
  invoiceNumber: string
  taxRate: string
  totalAmount: number
  // 通帳・現金出納帳・返済予定表用（種別により 入金/出金/残高、元金/利息/残高 として使う）
  deposit?: number | null
  withdrawal?: number | null
  balance?: number | null
  pageIndex?: number | null // 元になった画像（0始まり）
}

/** 解析の種別（書類種類に対応） */
export type ScanAnalysisKind =
  | 'receipt'
  | 'credit-card'
  | 'invoice-sales'
  | 'invoice-purchase'
  | 'passbook'
  | 'cashbook'
  | 'loan'
  | 'lease'

export interface ScanAnalysisMeta {
  paymentDate?: string // クレジットカード：引落日
  totalAmount?: number // クレジットカード：引落総額
  cardName?: string // クレジットカード：カード名
  partyName?: string // 返済予定表：金融機関名／リース：リース会社名
  title?: string // 返済予定表：契約名／リース：物件名
  corrections?: string[] // 通帳：残高整合チェックによる自動補正の記録
}

export interface ScanAnalysis {
  rows: ScanAnalysisRow[]
  analyzedAt: string
  kind?: ScanAnalysisKind
  meta?: ScanAnalysisMeta
}

/** 自動解析の多端末ロック。取得できた端末だけが解析する（5分で失効＝処理中断時も別端末が引き継げる） */
export async function acquireAnalysisLock(token: string, batchId: string): Promise<boolean> {
  const { db, ref } = await dbfns()
  const { runTransaction } = await import('firebase/database')
  const r = ref(db, publicPath(token, 'locks', batchId))
  const res = await runTransaction(r, (cur: unknown) => {
    const now = Date.now()
    if (typeof cur === 'number' && now - cur < 5 * 60_000) return // 他端末が処理中 → 取得失敗
    return now
  })
  return res.committed
}

/** 解析結果を保存（編集内容も同じ場所に上書き保存） */
export async function saveAnalysis(
  token: string,
  batchId: string,
  rows: ScanAnalysisRow[],
  kind?: ScanAnalysisKind,
  meta?: ScanAnalysisMeta,
): Promise<void> {
  const { db, ref, set } = await dbfns()
  // undefined を含むと RTDB がエラーになるため JSON 経由で除去
  const clean = JSON.parse(
    JSON.stringify({ rows, analyzedAt: new Date().toISOString(), kind: kind || 'receipt', meta: meta || null }),
  )
  await set(ref(db, publicPath(token, 'analysis', batchId)), clean)
}

export async function loadAnalysis(token: string, batchId: string): Promise<ScanAnalysis | null> {
  const { db, ref, get } = await dbfns()
  const v = (await get(ref(db, publicPath(token, 'analysis', batchId)))).val() as ScanAnalysis | null
  if (!v || !Array.isArray(v.rows)) return v && v.analyzedAt ? { rows: [], analyzedAt: v.analyzedAt } : null
  return v
}

/** 受信箱一覧用：解析済みバッチの一覧（batchId → analyzedAt） */
export async function loadAnalyses(token: string): Promise<Record<string, ScanAnalysis>> {
  const { db, ref, get } = await dbfns()
  return ((await get(ref(db, publicPath(token, 'analysis')))).val() as Record<string, ScanAnalysis>) || {}
}

/** 事務所側：バッチ画像を {name, blob} で取得（Google Drive保存・ZIP用） */
export async function getBatchImageBlobs(
  token: string,
  batch: ScanBatch,
): Promise<{ name: string; blob: Blob }[]> {
  const { st, ref: sref, getBlob } = await storageFns()
  const out: { name: string; blob: Blob }[] = []
  for (let i = 0; i < (batch.paths || []).length; i++) {
    const blob = await getBlob(sref(st, batch.paths[i]))
    out.push({ name: `p${i + 1}.jpg`, blob })
  }
  return out
}

/** 保存期間（送信から1年）を過ぎたバッチ・現金登録を自動削除する。
 *  事務所側の画面表示時に呼ばれる（顧問先側からは呼ばない） */
export const SCAN_RETENTION_DAYS = 365
export async function sweepOldScanData(token: string, maxAgeDays: number = SCAN_RETENTION_DAYS): Promise<number> {
  const cutoff = Date.now() - maxAgeDays * 24 * 3600 * 1000
  let removed = 0
  const batches = await loadBatches(token)
  for (const b of Object.values(batches)) {
    const t = Date.parse(b.submittedAt || '')
    if (t && t < cutoff) {
      try { await deleteBatch(token, b); removed++ } catch { /* 次回に再試行 */ }
    }
  }
  const cash = await loadCashEntries(token)
  const { db, ref, remove } = await dbfns()
  for (const c of Object.values(cash)) {
    const t = Date.parse(c.submittedAt || '')
    if (t && t < cutoff) {
      try { await remove(ref(db, publicPath(token, 'cash', c.id))); removed++ } catch { /* 次回に再試行 */ }
    }
  }
  // ファイル便は送信から90日で削除（受け渡しの箱の掃除。顧問先の元ファイルには影響しない）
  const fileCutoff = Date.now() - SCAN_FILE_RETENTION_DAYS * 24 * 3600 * 1000
  try {
    const files = await loadFiles(token)
    for (const f of Object.values(files)) {
      const t = Date.parse(f.submittedAt || '')
      if (t && t < fileCutoff) {
        try { await deleteScanFile(token, f); removed++ } catch { /* 次回に再試行 */ }
      }
    }
  } catch { /* ignore */ }
  // 事務所→顧問先のファイル（inbox）も送信から90日で削除
  try {
    const inbox = await loadInbox(token)
    for (const f of Object.values(inbox)) {
      const t = Date.parse(f.sentAt || '')
      if (t && t < fileCutoff) {
        try { await deleteInboxFile(token, f); removed++ } catch { /* 次回に再試行 */ }
      }
    }
  } catch { /* ignore */ }
  return removed
}

/** 事務所側：バッチを削除（Storageファイルも削除） */
export async function deleteBatch(token: string, batch: ScanBatch): Promise<void> {
  const { st, ref: sref, deleteObject } = await storageFns()
  for (const p of batch.paths || []) {
    try {
      await deleteObject(sref(st, p))
    } catch {
      /* 既に削除済み等は無視 */
    }
  }
  const { db, ref, remove } = await dbfns()
  await remove(ref(db, publicPath(token, 'batches', batch.id)))
  try { await remove(ref(db, publicPath(token, 'analysis', batch.id))) } catch { /* ignore */ }
}
