/**
 * Drive 上の現在の顧問先フォルダ内ファイル一覧を返す（ポーリング用）。
 * { name, modifiedTime } のリストを返すだけの軽量エンドポイント。
 */

import { NextRequest, NextResponse } from 'next/server'
import { google } from 'googleapis'
import { cookies } from 'next/headers'

const ROOT_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID || ''
const APP_FOLDER_NAME = process.env.GOOGLE_DRIVE_DATA_FOLDER_NAME || '事務所アプリ共有データ'

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
  return google.drive({ version: 'v3', auth: oauth2Client })
}

function sanitizeFolderName(name: string): string {
  return name.replace(/[/\\'"`]/g, '_').trim() || 'unnamed'
}

async function findFolderId(drive: ReturnType<typeof google.drive>, name: string, parentId: string): Promise<string | null> {
  const escaped = sanitizeFolderName(name).replace(/'/g, "\\'")
  const res = await drive.files.list({
    q: `name='${escaped}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  })
  return res.data.files?.[0]?.id ?? null
}

export async function GET(request: NextRequest) {
  try {
    const drive = await getAuthedDrive()
    const clientId = request.nextUrl.searchParams.get('clientId') || '_global'
    const clientName = request.nextUrl.searchParams.get('clientName')

    const appFolder = await findFolderId(drive, APP_FOLDER_NAME, ROOT_FOLDER_ID)
    if (!appFolder) return NextResponse.json({ files: [] })

    // 顧問先フォルダ（名前ベース、無ければ ID ベースで fallback）
    let clientFolder: string | null = null
    if (clientName && clientId !== '_global') {
      clientFolder = await findFolderId(drive, clientName, appFolder)
    }
    if (!clientFolder) {
      clientFolder = await findFolderId(drive, clientId, appFolder)
    }
    if (!clientFolder) return NextResponse.json({ files: [] })

    const res = await drive.files.list({
      q: `'${clientFolder}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
      fields: 'files(name, modifiedTime)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    })
    const files = (res.data.files || []).map((f) => ({
      name: f.name || '',
      modifiedTime: f.modifiedTime || '',
    }))
    return NextResponse.json({ files })
  } catch (err) {
    if (err instanceof Error && err.message === 'NOT_AUTHENTICATED') {
      return NextResponse.json({ error: 'NOT_AUTHENTICATED' }, { status: 401 })
    }
    console.error('Drive changes error:', err)
    return NextResponse.json({ error: 'failed' }, { status: 500 })
  }
}
