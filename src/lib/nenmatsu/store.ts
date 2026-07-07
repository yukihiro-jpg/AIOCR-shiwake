// 年末調整モジュールの Firebase(RTDB) データアクセス。
// すべて rooms/{roomKey}/nenmatsu/{yearId}/... 配下に保存（合言葉ルームでスコープ）。
// 顧問先（会社）は仕訳作成と共有の顧問先リスト（aiocr-shiwake/_global/clients_v2）を参照して紐づける。

import { getDb } from '@/core/firebase'
import { roomKey, modulePath } from '@/core/room'
import { normalizeBirth } from './jdl-csv'

export const NENMATSU_KEY = 'nenmatsu'

/** 生年月日など照合値を一方向ハッシュ化するための SHA-256（16進）。 */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const buf = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

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

/** 公開名簿（従業員ページが読む）に載せる最小限の情報。
 *  【厳守】生年月日・住所・CSV生データなどの平文PIIは載せない。
 *  本人確認は生年月日の SHA-256 ハッシュ（birthHash）との照合で行う。 */
export interface PublicEmployee {
  id: string
  code: string
  lastName: string
  firstName: string
  kanaLast: string
  kanaFirst: string
  birthHash: string // SHA-256(正規化生年月日)。空＝生年月日未取得（照合スキップ）
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

/** 既存の全登録会社の公開名簿を最新仕様（生年月日ハッシュ化・住所等のPII非公開）で再発行する。
 *  旧仕様（平文PIIを公開）で発行済みの名簿を安全な形へ移行し、生年月日ハッシュも付け直す。
 *  戻り値: 全社成功なら true（呼び出し側は false のとき移行完了フラグを立てないこと）。 */
export async function republishRosters(yearId: string): Promise<boolean> {
  const companies = await loadCompanies(yearId)
  let ok = true
  for (const comp of Object.values(companies)) {
    if (!comp || !comp.token) continue
    try {
      const employees = await loadEmployees(yearId, comp.clientId)
      await publishRoster(yearId, comp, employees)
    } catch { ok = false /* 失敗分は次回リトライ（フラグを立てない） */ }
  }
  return ok
}

/** 顧問先削除の purge キュー処理（nenmatsu/_purgeQueue/{clientId} = { years: {yearId: token|''}, at }）。
 *  komon（iframe内・Storage SDKなし）は削除時にキュー登録のみ行い、Storage を消せる
 *  事務所側のこの画面が、公開データ＋提出画像（Storage）＋従業員名簿＋旧形式提出を確実に削除する。
 *  【開発ルール】公開トークン/Storage を持つモジュールは必ずこの方式で削除する（RTDBのみの削除は禁止）。 */
export async function processNenmatsuPurgeQueue(): Promise<number> {
  const { db, ref, get, remove } = await dbfns()
  const qPath = await modulePath(NENMATSU_KEY, '_purgeQueue')
  const snap = await get(ref(db, qPath))
  const entries = (snap.val() as Record<string, { years?: Record<string, string>; at?: number }> | null) || {}
  let done = 0
  for (const [cid, e] of Object.entries(entries)) {
    try {
      const years = e?.years || {}
      for (const [yearId, token] of Object.entries(years)) {
        // 1) 公開領域: 提出画像Storage → 公開サブツリー
        if (token) {
          try {
            const pub = ((await get(ref(db, publicPath(token, 'submissions')))).val() as Record<string, SubmissionRecord>) || {}
            const { st, ref: sref, deleteObject } = await storageFns()
            for (const rec of Object.values(pub)) {
              for (const p of rec?.paths || []) { try { await deleteObject(sref(st, p)) } catch { /* ignore */ } }
            }
          } catch { /* ignore */ }
          try { await remove(ref(db, publicPath(token))) } catch { /* ignore */ }
        }
        // 2) 旧形式提出（rooms側）: Storage → ノード
        try {
          const legacyPath = await modulePath(NENMATSU_KEY, yearId, 'submissions', cid)
          const legacy = ((await get(ref(db, legacyPath))).val() as Record<string, SubmissionRecord>) || {}
          const { st, ref: sref, deleteObject } = await storageFns()
          for (const rec of Object.values(legacy)) {
            for (const p of rec?.paths || []) { try { await deleteObject(sref(st, p)) } catch { /* ignore */ } }
          }
          await remove(ref(db, legacyPath))
        } catch { /* ignore */ }
        // 3) 従業員名簿（生年月日・住所等PII）と会社ノード
        try { await remove(ref(db, await modulePath(NENMATSU_KEY, yearId, 'employees', cid))) } catch { /* ignore */ }
        try { await remove(ref(db, await modulePath(NENMATSU_KEY, yearId, 'companies', cid))) } catch { /* ignore */ }
      }
      await remove(ref(db, `${qPath}/${cid}`))
      done++
    } catch { /* 失敗分はキューに残し、次回開いたときに再試行 */ }
  }
  return done
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
  // 公開名簿の枠を作成（名簿は従業員CSV取込時・リンク発行時に更新される）
  try { await publishRoster(yearId, company, await loadEmployees(yearId, client.id)) } catch { /* ignore */ }
  return company
}

export async function unregisterCompany(yearId: string, clientId: string): Promise<void> {
  const { db, ref, get, remove } = await dbfns()
  const path = await modulePath(NENMATSU_KEY, yearId, 'companies', clientId)
  // 公開領域（名簿PII・提出データ）と提出画像の Storage も削除する。
  // これをしないと、登録解除後も旧トークンの保持者が全従業員の名簿（生年月日・住所）や
  // 提出画像を読めてしまう。
  try {
    const comp = (await get(ref(db, path))).val() as NenmatsuCompany | null
    if (comp && comp.token) {
      try {
        const subs = await loadSubmissions(yearId, clientId)
        const { st, ref: sref, deleteObject } = await storageFns()
        for (const rec of Object.values(subs)) {
          for (const p of rec.paths || []) {
            try { await deleteObject(sref(st, p)) } catch { /* ignore */ }
          }
        }
      } catch { /* ignore */ }
      try { await remove(ref(db, publicPath(comp.token))) } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  await remove(ref(db, path))
}

/** 従業員リストを保存（CSV取込結果） */
export async function saveEmployees(
  yearId: string,
  clientId: string,
  employees: NenmatsuEmployee[],
): Promise<void> {
  const { db, ref, set, update, get } = await dbfns()
  const map: Record<string, NenmatsuEmployee> = {}
  employees.forEach((e) => (map[e.id] = e))
  const empPath = await modulePath(NENMATSU_KEY, yearId, 'employees', clientId)
  await set(ref(db, empPath), map)
  const compPath = await modulePath(NENMATSU_KEY, yearId, 'companies', clientId)
  await update(ref(db, compPath), { employeeCount: employees.length })
  // 従業員向け公開データ（token配下）にも名簿を反映
  const comp = (await get(ref(db, compPath))).val() as NenmatsuCompany | null
  if (comp && comp.token) await publishRoster(yearId, comp, employees)
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

/** 従業員向けアップロードURL。
 *  【重要】roomKey(rk) は絶対に含めない。rk はルーム全データ（顧問先・相続等）への鍵になるため、
 *  外部（顧問先の従業員）に渡るURLには、会社ごとのランダムトークン(t)のみを載せる。
 *  従業員側は nenmatsu-public/{token} 配下だけを読み書きする。 */
export async function buildUploadUrl(yearId: string, company: NenmatsuCompany): Promise<string> {
  // リンク発行時に公開名簿を最新化しておく（従業員側はこの公開データを参照する）
  try { await publishRoster(yearId, company, await loadEmployees(yearId, company.clientId)) } catch { /* ignore */ }
  const base = process.env.NEXT_PUBLIC_BASE_PATH || ''
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const q = new URLSearchParams({ y: yearId, t: company.token })
  return `${origin}${base}/nenmatsu-upload/?${q.toString()}`
}

/** 公開領域（従業員がアクセスする場所）のRTDBパス。token はルームとは独立の128bit乱数 */
function publicPath(token: string, ...seg: string[]): string {
  return `nenmatsu-public/${token}${seg.length ? '/' + seg.join('/') : ''}`
}

/** 会社の名簿を公開領域へ書き出す。
 *  【厳守】公開領域は「会社トークン1本」を全従業員が共有するため、生年月日・住所・CSV生データ等の
 *  平文PIIは載せない。本人確認に使う生年月日は SHA-256 ハッシュ（birthHash）だけを公開する。
 *  事務所側は rooms/{roomKey}/nenmatsu/... に完全な情報を保持しているため、ここは最小限で足りる。 */
export async function publishRoster(
  yearId: string,
  company: NenmatsuCompany,
  employees: NenmatsuEmployee[],
): Promise<void> {
  if (!company.token) return
  const { db, ref, set } = await dbfns()
  const map: Record<string, PublicEmployee> = {}
  for (const e of employees) {
    const norm = e.birth || normalizeBirth(e.birthRaw || '')
    const pub: PublicEmployee = {
      id: e.id,
      code: e.code,
      lastName: e.lastName,
      firstName: e.firstName,
      kanaLast: e.kanaLast,
      kanaFirst: e.kanaFirst,
      birthHash: norm ? await sha256Hex(norm) : '',
    }
    if (e.isNewHire) pub.isNewHire = true
    map[e.id] = pub
  }
  await set(ref(db, publicPath(company.token, 'roster')), {
    name: company.name,
    yearId,
    employees: map,
  })
}

function randomToken(): string {
  const a = new Uint8Array(16)
  crypto.getRandomValues(a)
  return Array.from(a)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

// ===== 従業員側（公開ページ）：トークンのみで nenmatsu-public/{token} を読み書きする =====
// roomKey は受け取らない（外部に渡るURLへ載せないため）。

/** 会社名と名簿を取得（従業員ページ用）。token が無効なら null */
export async function loadCompanyPublic(
  token: string,
): Promise<{ companyName: string; yearId: string; employees: PublicEmployee[] } | null> {
  if (!token) return null
  const { db, ref, get } = await dbfns()
  const roster = (await get(ref(db, publicPath(token, 'roster')))).val() as
    | { name: string; yearId: string; employees?: Record<string, PublicEmployee> }
    | null
  if (!roster || !roster.name) return null
  return {
    companyName: roster.name,
    yearId: roster.yearId || '',
    employees: Object.values(roster.employees || {}),
  }
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

/** 従業員側：撮影済み画像（docKey -> Blob[]）をアップロードし、提出記録を書く（token 配下のみ） */
export async function submitDocsPublic(
  token: string,
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
      const path = `nenmatsu-public/${token}/${emp.id}/${docKey}_${i + 1}.jpg`
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
  await set(ref(db, publicPath(token, 'submissions', emp.id)), rec)
}

/** 従業員側：既に提出済みか確認（二重提出チェック用） */
export async function getSubmissionPublic(
  token: string,
  empId: string,
): Promise<SubmissionRecord | null> {
  const { db, ref, get } = await dbfns()
  const snap = await get(ref(db, publicPath(token, 'submissions', empId)))
  return (snap.val() as SubmissionRecord) || null
}

/** 事務所側：会社の提出記録一覧（公開領域＋旧・内部パスの両方を統合） */
export async function loadSubmissions(
  yearId: string,
  clientId: string,
): Promise<Record<string, SubmissionRecord>> {
  const { db, ref, get } = await dbfns()
  // 旧形式（rooms/{rk}/nenmatsu/.../submissions）に残っている過去分
  const legacyPath = await modulePath(NENMATSU_KEY, yearId, 'submissions', clientId)
  const legacy = ((await get(ref(db, legacyPath))).val() as Record<string, SubmissionRecord>) || {}
  // 新形式（nenmatsu-public/{token}/submissions）
  let pub: Record<string, SubmissionRecord> = {}
  try {
    const compPath = await modulePath(NENMATSU_KEY, yearId, 'companies', clientId)
    const comp = (await get(ref(db, compPath))).val() as NenmatsuCompany | null
    if (comp && comp.token) {
      pub = ((await get(ref(db, publicPath(comp.token, 'submissions')))).val() as Record<string, SubmissionRecord>) || {}
    }
  } catch { /* ignore */ }
  return { ...legacy, ...pub }
}

/** 保存期間（アップロードから1年6か月）を過ぎた提出データ・画像を自動削除する。
 *  事務所側の画面表示時に呼ばれる */
export const NENMATSU_RETENTION_DAYS = 548 // 約1年6か月
export async function sweepOldSubmissions(
  yearId: string,
  clientId: string,
  maxAgeDays: number = NENMATSU_RETENTION_DAYS,
): Promise<number> {
  const cutoff = Date.now() - maxAgeDays * 24 * 3600 * 1000
  const subs = await loadSubmissions(yearId, clientId)
  const old = Object.values(subs).filter((r) => {
    const t = Date.parse(r.submittedAt || '')
    return t && t < cutoff
  })
  if (!old.length) return 0
  const { st, ref: sref, deleteObject } = await storageFns()
  const { db, ref, get, remove } = await dbfns()
  const compPath = await modulePath(NENMATSU_KEY, yearId, 'companies', clientId)
  const comp = (await get(ref(db, compPath))).val() as NenmatsuCompany | null
  let removed = 0
  for (const rec of old) {
    try {
      for (const p of rec.paths || []) {
        try { await deleteObject(sref(st, p)) } catch { /* 既に無い等は無視 */ }
      }
      if (comp && comp.token) {
        try { await remove(ref(db, publicPath(comp.token, 'submissions', rec.empId))) } catch { /* ignore */ }
      }
      const legacyPath = await modulePath(NENMATSU_KEY, yearId, 'submissions', clientId, rec.empId)
      try { await remove(ref(db, legacyPath)) } catch { /* ignore */ }
      removed++
    } catch { /* 次回に再試行 */ }
  }
  return removed
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

/** 事務所側：ある従業員のアップロードファイルのダウンロードURL一覧（アプリ内閲覧・DL用）
 *  新形式（nenmatsu-public/{token}/{empId}）と旧形式（nenmatsu/{rk}/...）の両方を確認する */
export async function listEmployeeFiles(
  yearId: string,
  clientId: string,
  empId: string,
): Promise<{ name: string; url: string }[]> {
  const { st, ref: sref, listAll, getDownloadURL } = await storageFns()
  const dirs: string[] = []
  try {
    const { db, ref, get } = await dbfns()
    const compPath = await modulePath(NENMATSU_KEY, yearId, 'companies', clientId)
    const comp = (await get(ref(db, compPath))).val() as NenmatsuCompany | null
    if (comp && comp.token) dirs.push(`nenmatsu-public/${comp.token}/${empId}`)
  } catch { /* ignore */ }
  try {
    const rk = await roomKey()
    dirs.push(`nenmatsu/${rk}/${yearId}/${clientId}/${empId}`)
  } catch { /* ignore */ }
  const out: { name: string; url: string }[] = []
  const seen = new Set<string>()
  for (const d of dirs) {
    try {
      const res = await listAll(sref(st, d))
      for (const item of res.items) {
        if (seen.has(item.name)) continue
        seen.add(item.name)
        out.push({ name: item.name, url: await getDownloadURL(item) })
      }
    } catch { /* ignore */ }
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

