import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const maxDuration = 120

interface UploadedFileInfo {
  name: string
  uri: string
  mimeType: string
  state: string
}

export async function POST(request: NextRequest) {
  try {
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) {
      return NextResponse.json({ error: 'GEMINI_API_KEY が設定されていません' }, { status: 500 })
    }

    const formData = await request.formData()
    const fileEntry = formData.get('file')
    if (fileEntry === null || typeof fileEntry === 'string') {
      return NextResponse.json({ error: 'file が指定されていません' }, { status: 400 })
    }
    const blob = fileEntry as Blob & { name?: string }
    const displayNameRaw = formData.get('displayName')
    const displayName =
      (typeof displayNameRaw === 'string' && displayNameRaw) ||
      (typeof blob.name === 'string' ? blob.name : 'upload')
    const mimeType =
      (formData.get('mimeType')?.toString() || blob.type) || 'application/octet-stream'

    const info = await uploadToGeminiFileApi(apiKey, blob, displayName, mimeType)
    return NextResponse.json(info)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('gemini-upload error:', msg)
    return NextResponse.json({ error: `Gemini File API アップロード失敗: ${msg}` }, { status: 500 })
  }
}

async function uploadToGeminiFileApi(
  apiKey: string,
  blob: Blob,
  displayName: string,
  mimeType: string,
): Promise<UploadedFileInfo> {
  const buf = Buffer.from(await blob.arrayBuffer())
  const numBytes = buf.length
  console.log(`[gemini-upload] start: ${displayName} (${(numBytes / 1024).toFixed(0)} KB, ${mimeType})`)

  // 1) 再開可能アップロードを開始
  const startRes = await fetch(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`,
    {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(numBytes),
        'X-Goog-Upload-Header-Content-Type': mimeType,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file: { display_name: displayName } }),
    },
  )
  if (!startRes.ok) {
    const t = await startRes.text().catch(() => '')
    throw new Error(`upload start HTTP ${startRes.status}: ${t.slice(0, 300)}`)
  }
  const uploadUrl = startRes.headers.get('x-goog-upload-url')
  if (!uploadUrl) {
    throw new Error('upload start: x-goog-upload-url ヘッダがありません')
  }

  // 2) バイトをアップロード＆finalize
  const upRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Length': String(numBytes),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    body: buf,
  })
  if (!upRes.ok) {
    const t = await upRes.text().catch(() => '')
    throw new Error(`upload finalize HTTP ${upRes.status}: ${t.slice(0, 300)}`)
  }
  const upData = (await upRes.json()) as {
    file?: { name: string; uri: string; mimeType: string; state: string }
  }
  if (!upData.file) {
    throw new Error('upload finalize: file が応答にありません')
  }
  let info = upData.file
  console.log(`[gemini-upload] uploaded: name=${info.name} state=${info.state}`)

  // 3) PDFは PROCESSING 状態になるため ACTIVE まで待機
  if (info.state !== 'ACTIVE') {
    info = await waitForActive(apiKey, info.name)
  }
  return { name: info.name, uri: info.uri, mimeType: info.mimeType, state: info.state }
}

async function waitForActive(
  apiKey: string,
  name: string,
): Promise<{ name: string; uri: string; mimeType: string; state: string }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/${name}?key=${apiKey}`
  const maxAttempts = 60
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    const r = await fetch(url)
    if (!r.ok) {
      const t = await r.text().catch(() => '')
      throw new Error(`file status HTTP ${r.status}: ${t.slice(0, 200)}`)
    }
    const data = (await r.json()) as { name: string; uri: string; mimeType: string; state: string }
    if (data.state === 'ACTIVE') {
      console.log(`[gemini-upload] ACTIVE: ${name} (waited ${i + 1}s)`)
      return data
    }
    if (data.state === 'FAILED') {
      throw new Error(`file processing FAILED: ${name}`)
    }
  }
  throw new Error(`file が ${maxAttempts}秒以内に ACTIVE になりませんでした: ${name}`)
}
