import { NextRequest, NextResponse } from 'next/server'
import { GoogleGenerativeAI } from '@google/generative-ai'

const PROMPT = `この画像はレシートまたは領収書です（1つのPDFに複数のレシート・領収書が含まれる場合があります）。
各レシート・領収書について以下の情報をJSON形式で抽出してください。

【複数レシートの判定】
- スキャンされた画像に複数のレシートが含まれる場合があります
- レシートの区切りは店名の変化、日付の変化、領収書番号の変化などから判断してください

各レシート・領収書のフィールド：
- receiptIndex: レシート番号（0始まり）
- storeName: 店名・発行者名
- receiptDate: 日付（YYYY-MM-DD形式。和暦は西暦に変換。令和N年=2018+N年）
- mainContent: 主な購入内容（金額が最も大きい品目）
- invoiceNumber: インボイス番号（適格請求書発行事業者番号 T+13桁。なければ空文字）
- taxLines: 税率別金額配列。各要素:
  - taxRate: 税率（"10%", "8%", "非課税" 等）
  - netAmount: 本体価格
  - taxAmount: 消費税額
  - totalAmount: 税込金額
- pageIndex: このレシートが含まれるページ（0始まり）

出力は必ず以下のJSON形式のみ：
{"receipts": [{"receiptIndex": 0, "storeName": "コンビニ", "receiptDate": "2025-03-15", "mainContent": "文房具", "invoiceNumber": "T1234567890123", "taxLines": [{"taxRate": "10%", "netAmount": 1000, "taxAmount": 100, "totalAmount": 1100}], "pageIndex": 0}]}

注意：
- 金額のカンマは除去して数値にしてください
- 読み取れない場合は空配列 {"receipts": []} を返してください`

export async function POST(request: NextRequest) {
  try {
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) {
      return NextResponse.json({ error: 'GEMINI_API_KEY が設定されていません。' }, { status: 500 })
    }

    const { images, geminiModel } = await request.json()
    if (!images || !Array.isArray(images) || images.length === 0) {
      return NextResponse.json({ error: '画像データがありません' }, { status: 400 })
    }

    const genAI = new GoogleGenerativeAI(apiKey)
    const modelName = geminiModel || process.env.GEMINI_MODEL || 'gemini-2.5-flash'
    const model = genAI.getGenerativeModel({ model: modelName, generationConfig: { temperature: 0 } })

    const startTime = Date.now()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parts: any[] = [PROMPT]
    for (const img of images) {
      const match = img.match(/^data:([^;]+);base64,(.+)$/)
      if (!match) continue
      parts.push({ inlineData: { mimeType: match[1], data: match[2] } })
    }

    console.log(`Receipt OCR: ${images.length} pages`)
    const result = await model.generateContent(parts)
    const responseText = result.response.text()
    console.log(`Receipt OCR done in ${((Date.now() - startTime) / 1000).toFixed(1)}s`)

    const jsonMatch = responseText.match(/\{[\s\S]*"receipts"[\s\S]*\}/)
    if (!jsonMatch) {
      return NextResponse.json({ receipts: [], error: 'JSONを抽出できませんでした' })
    }

    const parsed = JSON.parse(jsonMatch[0])
    return NextResponse.json({ receipts: parsed.receipts || [] })
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    console.error('Receipt OCR error:', errMsg)
    return NextResponse.json({ error: `レシートOCRエラー: ${errMsg}` }, { status: 500 })
  }
}
