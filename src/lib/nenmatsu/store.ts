// 年末調整モジュールの Firebase(RTDB) データアクセス。
// すべて rooms/{roomKey}/nenmatsu/{yearId}/... 配下に保存（合言葉ルームでスコープ）。
// 顧問先（会社）は仕訳作成と共有の顧問先リスト（aiocr-shiwake/_global/clients_v2）を参照して紐づける。

import { getDb } from '@/core/firebase'
import { roomKey, modulePath } from '@/core/room'

export const NENMATSU_KEY = 'nenmatsu'

export interface SharedClient {
  id: string
  name: string
  code?: string
}

export interface NenmatsuEmployee {
  id: string // 社員コード由来の安定ID
  code: string
  lastName: string
  firstName: string
  kanaLast: string
  kanaFirst: string
  birth: string // 正規化済み YYYY-MM-DD（照合用）。空なら未取得
  birthRaw: string // CSVの生の値
  address?: string // 住所（取込内容確認用）
  rawCells?: string[] // CSVの行データ（列番号で内容を確認するため）
  isNewHire?: boolean
}

export interface NenmatsuCompany {
  clientId: string
  code: string
  name: string
  token: string // 従業員向けURLのトークン
  registeredAt: string
  employeeCount?: number
}

async function dbfns() {
  const db = await getDb()
  const m = await import('firebase/database')
  return { db, ...m }
}

/** 共有の顧問先リスト（仕訳作成と共通）を読み込む */
export async function loadSharedClients(): Promise<SharedClient[]> {
  const rk = await roomKey()
  const { db, ref, get } = await dbfns()
  const snap = await get(ref(db, `rooms/${rk}/aiocr-shiwake/_global/clients_v2`))
  const val = snap.val() || {}
  return Object.values(val)
    .map((c: any) => ({ id: c.id, name: c.name, code: c.code }))
    .filter((c: SharedClient) => c && c.id && c.name)
    .sort((a, b) => (a.code || '').localeCompare(b.code || '', 'ja', { numeric: true }))
}

/** 年度の登録会社一覧 */
export async function loadCompanies(yearId: string): Promise<Record<string, NenmatsuCompany>> {
  const { db, ref, get } = await dbfns()
  const path = await modulePath(NENMATSU_KEY, yearId, 'companies')
  const snap = await get(ref(db, path))
  return (snap.val() as Record<string, NenmatsuCompany>) || {}
}

/** 会社を年末調整に登録（トークンを発行） */
export async function registerCompany(
  yearId: string,
  client: SharedClient,
): Promise<NenmatsuCompany> {
  const { db, ref, get, set } = await dbfns()
  const path = await modulePath(NENMATSU_KEY, yearId, 'companies', client.id)
  const existing = (await get(ref(db, path))).val() as NenmatsuCompany | null
  if (existing && existing.token) return existing
  const company: NenmatsuCompany = {
    clientId: client.id,
    code: client.code || '',
    name: client.name,
    token: randomToken(),
    registeredAt: new Date().toISOString(),
  }
  await set(ref(db, path), company)
  return company
}

export async function unregisterCompany(yearId: string, clientId: string): Promise<void> {
  const { db, ref, remove } = await dbfns()
  const path = await modulePath(NENMATSU_KEY, yearId, 'companies', clientId)
  await remove(ref(db, path))
}

/** 従業員リストを保存（CSV取込結果） */
export async function saveEmployees(
  yearId: string,
  clientId: string,
  employees: NenmatsuEmployee[],
): Promise<void> {
  const { db, ref, set, update } = await dbfns()
  const map: Record<string, NenmatsuEmployee> = {}
  employees.forEach((e) => (map[e.id] = e))
  const empPath = await modulePath(NENMATSU_KEY, yearId, 'employees', clientId)
  await set(ref(db, empPath), map)
  const compPath = await modulePath(NENMATSU_KEY, yearId, 'companies', clientId)
  await update(ref(db, compPath), { employeeCount: employees.length })
}

export async function loadEmployees(
  yearId: string,
  clientId: string,
): Promise<NenmatsuEmployee[]> {
  const { db, ref, get } = await dbfns()
  const path = await modulePath(NENMATSU_KEY, yearId, 'employees', clientId)
  const snap = await get(ref(db, path))
  const val = (snap.val() as Record<string, NenmatsuEmployee>) || {}
  return Object.values(val)
}

/** 従業員向けアップロードURL（合言葉そのものは含めず roomKey ハッシュのみ） */
export async function buildUploadUrl(yearId: string, company: NenmatsuCompany): Promise<string> {
  const rk = await roomKey()
  const base = process.env.NEXT_PUBLIC_BASE_PATH || ''
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const q = new URLSearchParams({ rk, y: yearId, c: company.clientId, t: company.token })
  return `${origin}${base}/nenmatsu-upload/?${q.toString()}`
}

function randomToken(): string {
  const a = new Uint8Array(16)
  crypto.getRandomValues(a)
  return Array.from(a)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

// ===== 従業員側（公開ページ）：roomKey を直接受け取って読み書きする =====

/** トークン検証つきで会社情報を取得（従業員ページ用） */
export async function loadCompanyPublic(
  rk: string,
  yearId: string,
  clientId: string,
  token: string,
): Promise<{ company: NenmatsuCompany; employees: NenmatsuEmployee[] } | null> {
  const { db, ref, get } = await dbfns()
  const comp = (
    await get(ref(db, `rooms/${rk}/${NENMATSU_KEY}/${yearId}/companies/${clientId}`))
  ).val() as NenmatsuCompany | null
  if (!comp || comp.token !== token) return null
  const empVal =
    (await get(ref(db, `rooms/${rk}/${NENMATSU_KEY}/${yearId}/employees/${clientId}`))).val() ||
    {}
  return { company: comp, employees: Object.values(empVal) as NenmatsuEmployee[] }
}

// ===== 顧問先情報（komon）で「年末調整＝利用」にした会社だけを読む =====
export async function loadNenmatsuClients(): Promise<SharedClient[]> {
  const { db, ref, get } = await dbfns()
  const path = await modulePath(NENMATSU_KEY, '_clients')
  const snap = await get(ref(db, path))
  const val = snap.val() || {}
  return Object.values(val)
    .map((c: any) => ({ id: c.id, name: c.name, code: c.code }))
    .filter((c: SharedClient) => c && c.id && c.name)
    .sort((a, b) => (a.code || '').localeCompare(b.code || '', 'ja', { numeric: true }))
}

// ===== 提出（撮影アップロード）と閲覧 =====

export interface SubmissionRecord {
  empId: string
  name: string
  kana?: string
  submittedAt: string
  docs: Record<string, number> // docKey -> 枚数
  paths: string[] // Storage 上のファイルパス
  declaration?: import('./declaration').Declaration // 本人・配偶者・扶養の申告内容
}

async function storageFns() {
  await getDb() // app初期化＋匿名認証を保証
  const { getApps } = await import('firebase/app')
  const s = await import('firebase/storage')
  const app = getApps()[0]
  return { st: s.getStorage(app), ...s }
}

/** 従業員側：撮影済み画像（docKey -> Blob[]）をアップロードし、提出記録を書く */
export async function submitDocsPublic(
  rk: string,
  yearId: string,
  clientId: string,
  emp: NenmatsuEmployee,
  docs: Record<string, Blob[]>,
  declaration?: import('./declaration').Declaration,
): Promise<void> {
  const { st, ref: sref, uploadBytes } = await storageFns()
  const paths: string[] = []
  const counts: Record<string, number> = {}
  for (const docKey of Object.keys(docs)) {
    const blobs = docs[docKey]
    if (!blobs || !blobs.length) continue
    counts[docKey] = blobs.length
    for (let i = 0; i < blobs.length; i++) {
      const path = `nenmatsu/${rk}/${yearId}/${clientId}/${emp.id}/${docKey}_${i + 1}.jpg`
      await uploadBytes(sref(st, path), blobs[i], { contentType: 'image/jpeg' })
      paths.push(path)
    }
  }
  const { db, ref, set } = await dbfns()
  const rec: SubmissionRecord = {
    empId: emp.id,
    name: `${emp.lastName} ${emp.firstName}`.trim(),
    kana: `${emp.kanaLast} ${emp.kanaFirst}`.trim(),
    submittedAt: new Date().toISOString(),
    docs: counts,
    paths,
  }
  if (declaration) rec.declaration = declaration
  await set(
    ref(db, `rooms/${rk}/${NENMATSU_KEY}/${yearId}/submissions/${clientId}/${emp.id}`),
    rec,
  )
}

/** 従業員側：既に提出済みか確認（二重提出チェック用） */
export async function getSubmissionPublic(
  rk: string,
  yearId: string,
  clientId: string,
  empId: string,
): Promise<SubmissionRecord | null> {
  const { db, ref, get } = await dbfns()
  const snap = await get(
    ref(db, `rooms/${rk}/${NENMATSU_KEY}/${yearId}/submissions/${clientId}/${empId}`),
  )
  return (snap.val() as SubmissionRecord) || null
}

/** 事務所側：会社の提出記録一覧 */
export async function loadSubmissions(
  yearId: string,
  clientId: string,
): Promise<Record<string, SubmissionRecord>> {
  const { db, ref, get } = await dbfns()
  const path = await modulePath(NENMATSU_KEY, yearId, 'submissions', clientId)
  const snap = await get(ref(db, path))
  return (snap.val() as Record<string, SubmissionRecord>) || {}
}

/** 事務所側：保存パスのファイル群をBlobで取得（ZIP一括DL用） */
export async function getFileBlobs(
  paths: string[],
): Promise<{ name: string; blob: Blob }[]> {
  const { st, ref: sref, getBlob } = await storageFns()
  const out: { name: string; blob: Blob }[] = []
  for (const p of paths) {
    const name = p.split('/').pop() || p
    out.push({ name, blob: await getBlob(sref(st, p)) })
  }
  return out
}

/** 事務所側：ある従業員のアップロードファイルのダウンロードURL一覧（アプリ内閲覧・DL用） */
export async function listEmployeeFiles(
  yearId: string,
  clientId: string,
  empId: string,
): Promise<{ name: string; url: string }[]> {
  const rk = await roomKey()
  const { st, ref: sref, listAll, getDownloadURL } = await storageFns()
  const dir = sref(st, `nenmatsu/${rk}/${yearId}/${clientId}/${empId}`)
  const res = await listAll(dir)
  const out: { name: string; url: string }[] = []
  for (const item of res.items) {
    out.push({ name: item.name, url: await getDownloadURL(item) })
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

