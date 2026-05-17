import { NextRequest, NextResponse } from 'next/server'
import { GoogleGenerativeAI } from '@google/generative-ai'

const PROMPT = `この画像はクレジットカードの利用明細書です。
以下の情報をJSON形式で抽出してください。

【全体情報（1枚目にのみ記載されていることが多い）】
- paymentDate: 引落日・支払日（YYYY-MM-DD形式）
- totalAmount: 引落総額・請求金額（数値）
- cardName: カード名称（あれば）

【各取引明細（全ページから抽出）】
transactions 配列として:
- usageDate: 利用日（YYYY-MM-DD形式）
- storeName: 利用店名・加盟店名
- amount: 利用金額（数値、正の整数）
- memo: 備考・支払区分等（あれば）

【注意事項】
- 年会費、手数料、キャッシングなども取引として含めてください
- 利用日が「月/日」のみの場合は、引落日から推定して年を補完してください
  例: 引落日が2025-03-27で利用日が2/15なら → 2025-02-15
  例: 引落日が2025-01-27で利用日が12/15なら → 2024-12-15（前年）
- 金額にカンマや円記号が含まれていても数値のみ抽出してください
- 返品・取消はマイナス金額（負の数）としてください
- ページをまたぐ場合も全取引を漏れなく抽出してください

出力フォーマット:
{
  "paymentDate": "2025-03-27",
  "totalAmount": 150000,
  "cardName": "○○カード",
  "transactions": [
    {"usageDate": "2025-02-01", "storeName": "アマゾンジャパン", "amount": 3980, "memo": "1回払い"},
    {"usageDate": "2025-02-05", "storeName": "コンビニABC", "amount": 550, "memo": ""}
  ]
}

JSONのみを出力してください。説明文は不要です。`

export async function POST(request: NextRequest) {
  try {
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) {
      return NextResponse.json({ error: 'GEMINI_API_KEY が設定されていません' }, { status: 500 })
    }

    const { images, geminiModel } = await request.json()
    if (!images || !Array.isArray(images) || images.length === 0) {
      return NextResponse.json({ error: '画像データがありません' }, { status: 400 })
    }

    const genAI = new GoogleGenerativeAI(apiKey)
    const modelName = geminiModel || process.env.GEMINI_MODEL || 'gemini-2.5-flash'
    const model = genAI.getGenerativeModel({
      model: modelName,
      generationConfig: { temperature: 0 },
    })

    // 全ページを1リクエストで送信（カード明細は全体像の把握が重要）
    const parts: { inlineData: { mimeType: string; data: string } }[] = images.map((img: string) => {
      const base64 = img.replace(/^data:image\/\w+;base64,/, '')
      return { inlineData: { mimeType: 'image/jpeg', data: base64 } }
    })

    const result = await model.generateContent([PROMPT, ...parts])
    const text = result.response.text()

    // JSONを抽出
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      return NextResponse.json({ error: 'Gemini応答からJSONを抽出できませんでした' }, { status: 500 })
    }

    const data = JSON.parse(jsonMatch[0])

    // バリデーション
    if (!data.paymentDate || !data.transactions || !Array.isArray(data.transactions)) {
      return NextResponse.json({
        error: '明細データの抽出に失敗しました。引落日・取引明細が認識できませんでした。',
      }, { status: 500 })
    }

    // 金額の正規化
    data.totalAmount = Math.abs(data.totalAmount || 0)
    data.transactions = data.transactions.map((t: { usageDate: string; storeName: string; amount: number; memo?: string }) => ({
      usageDate: t.usageDate || data.paymentDate,
      storeName: (t.storeName || '').trim(),
      amount: t.amount || 0,
      memo: (t.memo || '').trim(),
    }))

    return NextResponse.json(data)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'クレジットカード明細の解析に失敗しました'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
