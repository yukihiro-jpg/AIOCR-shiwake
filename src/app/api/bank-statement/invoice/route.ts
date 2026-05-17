import { NextRequest, NextResponse } from 'next/server'
import { GoogleGenerativeAI } from '@google/generative-ai'

const PROMPT_SALES = `この画像は売上請求書です（1つのPDFに複数の請求書が含まれる場合があります）。
各請求書について以下の情報をJSON形式で抽出してください。

【複数請求書の判定】
- 1つのPDF内に複数の請求書が含まれる場合があります
- 請求書の区切りは、請求先名称の変化、ページ区切り、請求書番号の変化などから判断してください
- 同じ請求先でも複数ページにまたがる場合は1つの請求書として扱ってください

各請求書のフィールド：
- invoiceIndex: 請求書番号（0始まり）
- counterpartName: 請求先名称（相手先の会社名・個人名）
- invoiceDate: 請求日（YYYY-MM-DD形式。和暦は西暦に変換。令和N年=2018+N年）
- mainContent: 請求内容の中で金額が最も大きい主な品目・サービス名
- taxLines: 消費税区分別の金額配列。各要素:
  - taxRate: 税率（"10%", "8%", "非課税" 等）
  - netAmount: 本体価格（税抜金額）
  - taxAmount: 消費税額
  - totalAmount: 税込金額
- pageStart: この請求書の開始ページ（0始まり）
- pageEnd: この請求書の終了ページ（0始まり）

出力は必ず以下のJSON形式のみ：
{"invoices": [{"invoiceIndex": 0, "counterpartName": "山田商事", "invoiceDate": "2025-03-31", "mainContent": "ガソリン", "taxLines": [{"taxRate": "10%", "netAmount": 100000, "taxAmount": 10000, "totalAmount": 110000}], "pageStart": 0, "pageEnd": 0}]}

注意：
- 金額のカンマは除去して数値にしてください
- 読み取れない場合は空配列 {"invoices": []} を返してください`

const PROMPT_PURCHASE = `この画像は仕入請求書（受領した請求書）です（1つのPDFに複数の請求書が含まれる場合があります）。
各請求書について以下の情報をJSON形式で抽出してください。

【複数請求書の判定】
- 1つのPDF内に複数の請求書が含まれる場合があります
- 請求書の区切りは、請求元名称の変化、ページ区切り、請求書番号の変化などから判断してください
- 同じ請求元でも複数ページにまたがる場合は1つの請求書として扱ってください

各請求書のフィールド：
- invoiceIndex: 請求書番号（0始まり）
- counterpartName: 請求元名称（発行元の会社名）
- invoiceNumber: インボイス番号（適格請求書発行事業者番号。T+13桁数字。記載がなければ空文字）
- invoiceDate: 請求日（YYYY-MM-DD形式。請求日の記載がない場合は請求締め日の末尾。和暦は西暦に変換）
- mainContent: 請求内容の中で金額が最も大きい主な品目・サービス名
- taxLines: 消費税区分別の金額配列。各要素:
  - taxRate: 税率（"10%", "8%", "非課税" 等）
  - netAmount: 本体価格（税抜金額）
  - taxAmount: 消費税額
  - totalAmount: 税込金額
- pageStart: この請求書の開始ページ（0始まり）
- pageEnd: この請求書の終了ページ（0始まり）

出力は必ず以下のJSON形式のみ：
{"invoices": [{"invoiceIndex": 0, "counterpartName": "東京物産", "invoiceNumber": "T1234567890123", "invoiceDate": "2025-03-31", "mainContent": "事務用品", "taxLines": [{"taxRate": "10%", "netAmount": 50000, "taxAmount": 5000, "totalAmount": 55000}], "pageStart": 0, "pageEnd": 0}]}

注意：
- 金額のカンマは除去して数値にしてください
- インボイス番号が見つからない場合は invoiceNumber を空文字にしてください
- 読み取れない場合は空配列 {"invoices": []} を返してください`

export async function POST(request: NextRequest) {
  try {
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) {
      return NextResponse.json({ error: 'GEMINI_API_KEY が設定されていません。' }, { status: 500 })
    }

    const { images, type, geminiModel } = await request.json()
    if (!images || !Array.isArray(images) || images.length === 0) {
      return NextResponse.json({ error: '画像データがありません' }, { status: 400 })
    }

    const genAI = new GoogleGenerativeAI(apiKey)
    const modelName = geminiModel || process.env.GEMINI_MODEL || 'gemini-2.5-flash'
    const model = genAI.getGenerativeModel({ model: modelName, generationConfig: { temperature: 0 } })

    const prompt = type === 'purchase' ? PROMPT_PURCHASE : PROMPT_SALES

    // 全ページを並列送信（通帳と同じ方式）
    const startTime = Date.now()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parts: any[] = [prompt]
    for (const img of images) {
      const match = img.match(/^data:([^;]+);base64,(.+)$/)
      if (!match) continue
      parts.push({ inlineData: { mimeType: match[1], data: match[2] } })
    }

    console.log(`Invoice OCR: ${images.length} pages, type=${type}`)
    const result = await model.generateContent(parts)
    const responseText = result.response.text()
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(`Invoice OCR done in ${elapsed}s:`, responseText.substring(0, 500))

    const jsonMatch = responseText.match(/\{[\s\S]*"invoices"[\s\S]*\}/)
    if (!jsonMatch) {
      return NextResponse.json({ invoices: [], error: 'JSONを抽出できませんでした' })
    }

    const parsed = JSON.parse(jsonMatch[0])
    return NextResponse.json({ invoices: parsed.invoices || [] })
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    console.error('Invoice OCR error:', errMsg)
    return NextResponse.json({ error: `請求書OCRエラー: ${errMsg}` }, { status: 500 })
  }
}
