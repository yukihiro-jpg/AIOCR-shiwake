// 書類スキャン（顧問先スマホ撮影→事務所受信）モジュールの Firebase(RTDB+Storage) データアクセス。
// 事務所側の管理情報は rooms/{roomKey}/scan/companies/{clientId} に保存（合言葉ルームでスコープ）。
// 顧問先（スマホ）側は scan-public/{token}/... のみを読み書きする（roomKey は一切渡さない）。
// パターンは src/lib/nenmatsu/store.ts を踏襲。

import { getDb } from '@/core/firebase'
import { modulePath } from '@/core/room'

export const SCAN_KEY = 'scan'

export interface ScanClient {
  id: string
  name: string
  code?: string
}

export interface ScanCompany {
  clientId: string
  code: string
  name: string
  token: string
  registeredAt: string
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
 *  公開領域の会社名(info)は毎回書き直す（過去にルール不備等で書けていなくても自己修復される） */
export async function registerScanCompany(client: ScanClient): Promise<ScanCompany> {
  const { db, ref, get, set } = await dbfns()
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
  await set(ref(db, path), company)
  await set(ref(db, publicPath(company.token, 'info')), { name: company.name })
  return company
}

export async function unregisterScanCompany(clientId: string): Promise<void> {
  const { db, ref, remove } = await dbfns()
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

/** 会社名を取得（顧問先ページ用）。token が無効なら null */
export async function loadScanInfoPublic(token: string): Promise<{ name: string } | null> {
  if (!token) return null
  const { db, ref, get } = await dbfns()
  const info = (await get(ref(db, publicPath(token, 'info')))).val() as { name: string } | null
  if (!info || !info.name) return null
  return { name: info.name }
}

function genId(): string {
  return Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
}

/** 顧問先側：撮影バッチを送信（Storageへアップし、batchesに記録）。アップロード成否をそのまま返す */
export async function submitScanBatchPublic(
  token: string,
  docType: string,
  meta: { bankName?: string; accountNumber?: string; userName?: string },
  images: Blob[],
): Promise<void> {
  if (!token) throw new Error('トークンがありません')
  if (!images || images.length === 0) throw new Error('画像がありません')
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
    submittedAt: new Date().toISOString(),
    status: 'new',
  }
  await set(ref(db, publicPath(token, 'cash', id)), rec)
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
