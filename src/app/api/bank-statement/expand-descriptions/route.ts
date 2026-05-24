import { NextRequest, NextResponse } from 'next/server'
import { GoogleGenerativeAI } from '@google/generative-ai'

/**
 * 現金出納帳などで、摘要の「名前部分」が省略された行を AI で補完する。
 *
 * 例:
 *   ["橋本真也重量税", "〃テスター代", "テスター代", "5/2 田中商店仕入"]
 *   → ["橋本真也重量税", "橋本真也テスター代", "橋本真也テスター代", "5/2 田中商店仕入"]
 *
 * ルール:
 *   - 「〃」「″」「々」「同上」で始まる、または明らかに支払先名が省略され品目だけになっている行は、
 *     直前の行の「名前（支払先）部分」だけを引き継いで補完する。
 *   - 名前部分のみ。品目（重量税・テスター代等）は引き継がない。
 */
const PROMPT = `あなたは日本の会計事務所の記帳担当者です。現金出納帳の「摘要」列を上から順に並べた配列を渡します。
一部の行は、支払先の「名前部分」を省略して品目だけ書いています（手書きの横着）。
省略の合図は次のいずれかです:
- 行頭が「〃」「″」「々」「同上」「同」
- 行頭にスペースがある（インデントで"上と同じ"を表す）
- 支払先名が無く品目だけになっている（直前の行には支払先名がある）

これらの行は、直前の行の「名前部分（支払先・人名・店名）だけ」を引き継ぎ、品目はその行のものを使って補完してください。
重要:
- 名前部分だけを引き継ぐ。直前行の品目（重量税・テスター代など）は引き継がない。
- 省略の合図が無く、独立した摘要として完結している行はそのまま変更しない。
- 日付や金額が先頭に付いている場合はそのまま残す。
- 出力は入力と同じ要素数・同じ順序の配列にする。

例:
入力: ["橋本真也重量税","〃テスター代"," 印紙代","田中商店仕入"]
出力: ["橋本真也重量税","橋本真也テスター代","橋本真也印紙代","田中商店仕入"]

出力は必ず以下の JSON 形式のみ（説明文なし）:
{"descriptions": ["...","..."]}`

export async function POST(request: NextRequest) {
  try {
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) {
      return NextResponse.json({ error: 'GEMINI_API_KEY が設定されていません。' }, { status: 500 })
    }
    const { descriptions, geminiModel } = await request.json()
    if (!Array.isArray(descriptions) || descriptions.length === 0) {
      return NextResponse.json({ descriptions: [] })
    }

    const genAI = new GoogleGenerativeAI(apiKey)
    const modelName = geminiModel || process.env.GEMINI_MODEL || 'gemini-2.5-flash'
    const model = genAI.getGenerativeModel({ model: modelName, generationConfig: { temperature: 0 } })

    const input = JSON.stringify({ descriptions })
    const result = await model.generateContent([PROMPT, input])
    const responseText = result.response.text()

    const jsonMatch = responseText.match(/\{[\s\S]*"descriptions"[\s\S]*\}/)
    if (!jsonMatch) {
      // 失敗時は元の配列をそのまま返す（補完なし）
      return NextResponse.json({ descriptions, warning: 'AI 応答を解析できませんでした' })
    }
    const parsed = JSON.parse(jsonMatch[0])
    const out: unknown = parsed.descriptions
    // 要素数が一致しない場合は安全側に倒して元データを返す
    if (!Array.isArray(out) || out.length !== descriptions.length) {
      return NextResponse.json({ descriptions, warning: 'AI 応答の件数が一致しませんでした' })
    }
    return NextResponse.json({ descriptions: out.map((d) => String(d ?? '')) })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('expand-descriptions error:', msg)
    return NextResponse.json({ error: `摘要補完エラー: ${msg}` }, { status: 500 })
  }
}
