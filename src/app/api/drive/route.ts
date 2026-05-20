import { NextRequest, NextResponse } from 'next/server'
import { google } from 'googleapis'
import { cookies } from 'next/headers'

function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.NEXTAUTH_URL || 'http://localhost:3000'}/api/auth/callback/google`,
  )
}

async function getAuthedDrive() {
  const cookieStore = await cookies()
  const tokensCookie = cookieStore.get('google_tokens')
  if (!tokensCookie) throw new Error('NOT_AUTHENTICATED')

  const tokens = JSON.parse(tokensCookie.value)
  const oauth2Client = getOAuth2Client()
  oauth2Client.setCredentials(tokens)

  // トークン更新時にクッキーを更新
  oauth2Client.on('tokens', async (newTokens) => {
    const merged = { ...tokens, ...newTokens }
    const cs = await cookies()
    cs.set('google_tokens', JSON.stringify(merged), {
      httpOnly: true, secure: false, sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 365, path: '/',
    })
  })

  return google.drive({ version: 'v3', auth: oauth2Client })
}

const ROOT_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID || ''
// 前身アプリは "accounting-app-data" を使っていたが、本アプリは別フォルダにデータを格納する。
// 環境変数 GOOGLE_DRIVE_DATA_FOLDER_NAME で上書きも可能。
const APP_FOLDER_NAME = process.env.GOOGLE_DRIVE_DATA_FOLDER_NAME || '事務所アプリ共有データ'

// フォルダ名に使えない/面倒な文字をサニタイズ
function sanitizeFolderName(name: string): string {
  return name.replace(/[/\\'"`]/g, '_').trim() || 'unnamed'
}

async function findOrCreateFolder(drive: ReturnType<typeof google.drive>, name: string, parentId: string): Promise<string> {
  const safeName = sanitizeFolderName(name)
  const escapedName = safeName.replace(/'/g, "\\'")
  const res = await drive.files.list({
    q: `name='${escapedName}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  })
  if (res.data.files && res.data.files.length > 0) return res.data.files[0].id!

  const folder = await drive.files.create({
    requestBody: {
      name: safeName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    fields: 'id',
    supportsAllDrives: true,
  })
  return folder.data.id!
}

/**
 * 顧問先フォルダを検索し、必要に応じて:
 * - 顧問先名で存在: それを使用
 * - 顧問先IDの旧フォルダが存在: リネームして使用
 * - どちらも無い: 顧問先名で新規作成
 */
async function getOrMigrateClientFolder(
  drive: ReturnType<typeof google.drive>,
  clientId: string,
  clientName: string,
  parentId: string,
): Promise<string> {
  const safeName = sanitizeFolderName(clientName)
  const escapedName = safeName.replace(/'/g, "\\'")

  // 1. 顧問先名のフォルダを検索
  const byName = await drive.files.list({
    q: `name='${escapedName}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  })
  if (byName.data.files && byName.data.files.length > 0) return byName.data.files[0].id!

  // 2. 顧問先IDの旧フォルダを検索 → 見つかればリネーム
  const byId = await drive.files.list({
    q: `name='${clientId}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  })
  if (byId.data.files && byId.data.files.length > 0) {
    const folderId = byId.data.files[0].id!
    console.log(`[Drive] Renaming folder: ${clientId} → ${safeName} (id=${folderId})`)
    try {
      await drive.files.update({
        fileId: folderId,
        requestBody: { name: safeName },
        supportsAllDrives: true,
      })
      console.log(`[Drive] Rename succeeded`)
    } catch (e) {
      console.error(`[Drive] Rename FAILED:`, e)
    }
    return folderId
  }
  console.log(`[Drive] No existing folder for clientId=${clientId}, will create new with name=${safeName}`)

  // 3. 新規作成（顧問先名）
  const folder = await drive.files.create({
    requestBody: {
      name: safeName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    fields: 'id',
    supportsAllDrives: true,
  })
  return folder.data.id!
}

async function readFile(drive: ReturnType<typeof google.drive>, fileName: string, folderId: string): Promise<string | null> {
  const res = await drive.files.list({
    q: `name='${fileName}' and '${folderId}' in parents and trashed=false`,
    fields: 'files(id)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  })
  if (!res.data.files || res.data.files.length === 0) return null

  const fileId = res.data.files[0].id!
  const content = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'text' },
  )
  return content.data as string
}

async function writeFile(drive: ReturnType<typeof google.drive>, fileName: string, folderId: string, content: string): Promise<void> {
  const res = await drive.files.list({
    q: `name='${fileName}' and '${folderId}' in parents and trashed=false`,
    fields: 'files(id)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  })

  const media = { mimeType: 'application/json', body: content }

  if (res.data.files && res.data.files.length > 0) {
    await drive.files.update({
      fileId: res.data.files[0].id!,
      media,
      supportsAllDrives: true,
    })
  } else {
    await drive.files.create({
      requestBody: {
        name: fileName,
        parents: [folderId],
      },
      media,
      fields: 'id',
      supportsAllDrives: true,
    })
  }
}

async function resolveClientFolder(
  drive: ReturnType<typeof google.drive>,
  clientId: string,
  clientName: string | null,
  appFolder: string,
): Promise<string> {
  console.log(`[Drive] resolveClientFolder clientId=${clientId}, clientName=${clientName}`)
  if (clientId === '_global' || !clientName) {
    console.log(`[Drive] fallback to findOrCreateFolder by id`)
    return findOrCreateFolder(drive, clientId, appFolder)
  }
  return getOrMigrateClientFolder(drive, clientId, clientName, appFolder)
}

// GET: Drive からデータ読み込み
export async function GET(request: NextRequest) {
  try {
    const drive = await getAuthedDrive()
    const clientId = request.nextUrl.searchParams.get('clientId') || '_global'
    const clientName = request.nextUrl.searchParams.get('clientName')
    const key = request.nextUrl.searchParams.get('key')
    if (!key) return NextResponse.json({ error: 'key is required' }, { status: 400 })

    const appFolder = await findOrCreateFolder(drive, APP_FOLDER_NAME, ROOT_FOLDER_ID)
    const clientFolder = await resolveClientFolder(drive, clientId, clientName, appFolder)
    const data = await readFile(drive, `${key}.json`, clientFolder)

    return NextResponse.json({ data: data ? JSON.parse(data) : null })
  } catch (err) {
    if (err instanceof Error && err.message === 'NOT_AUTHENTICATED') {
      return NextResponse.json({ error: 'NOT_AUTHENTICATED' }, { status: 401 })
    }
    console.error('Drive read error:', err)
    return NextResponse.json({ error: 'Drive read failed' }, { status: 500 })
  }
}

// POST: Drive にデータ書き込み
export async function POST(request: NextRequest) {
  try {
    const drive = await getAuthedDrive()
    const { clientId = '_global', clientName = null, key, data } = await request.json()
    if (!key) return NextResponse.json({ error: 'key is required' }, { status: 400 })

    const appFolder = await findOrCreateFolder(drive, APP_FOLDER_NAME, ROOT_FOLDER_ID)
    const clientFolder = await resolveClientFolder(drive, clientId, clientName, appFolder)
    await writeFile(drive, `${key}.json`, clientFolder, JSON.stringify(data))

    return NextResponse.json({ success: true })
  } catch (err) {
    if (err instanceof Error && err.message === 'NOT_AUTHENTICATED') {
      return NextResponse.json({ error: 'NOT_AUTHENTICATED' }, { status: 401 })
    }
    console.error('Drive write error:', err)
    return NextResponse.json({ error: 'Drive write failed' }, { status: 500 })
  }
}

// PUT: localStorageの全データをDriveに一括アップロード
export async function PUT(request: NextRequest) {
  try {
    const drive = await getAuthedDrive()
    const { items } = await request.json() as { items: { clientId: string; clientName?: string | null; key: string; data: unknown }[] }

    const appFolder = await findOrCreateFolder(drive, APP_FOLDER_NAME, ROOT_FOLDER_ID)
    const folderCache: Record<string, string> = {}

    for (const item of items) {
      const cid = item.clientId || '_global'
      const cname = item.clientName || null
      if (!folderCache[cid]) {
        folderCache[cid] = await resolveClientFolder(drive, cid, cname, appFolder)
      }
      await writeFile(drive, `${item.key}.json`, folderCache[cid], JSON.stringify(item.data))
    }

    return NextResponse.json({ success: true, count: items.length })
  } catch (err) {
    if (err instanceof Error && err.message === 'NOT_AUTHENTICATED') {
      return NextResponse.json({ error: 'NOT_AUTHENTICATED' }, { status: 401 })
    }
    console.error('Drive bulk write error:', err)
    return NextResponse.json({ error: 'Drive bulk write failed' }, { status: 500 })
  }
}
