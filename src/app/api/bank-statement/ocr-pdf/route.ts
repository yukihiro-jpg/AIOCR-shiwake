import { NextRequest, NextResponse } from 'next/server'
import { GoogleGenerativeAI, SchemaType, type ResponseSchema } from '@google/generative-ai'

// Gemini に強制する出力スキーマ。構造化出力モードを使うことで、
// JSON フォーマット制約に費やすトークンが減り、生成時間が短くなる。
// 借/貸科目、消費税、page などの「OCRに不要な項目」は意図的に含めない。
const TRANSACTION_SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    transactions: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          page: { type: SchemaType.INTEGER, description: '0始まりのページ番号' },
          date: { type: SchemaType.STRING, description: 'YYYY-MM-DD' },
          description: { type: SchemaType.STRING, description: '摘要' },
          deposit: { type: SchemaType.NUMBER, nullable: true, description: '入金額（出金行ではnull）' },
          withdrawal: { type: SchemaType.NUMBER, nullable: true, description: '出金額（入金行ではnull）' },
          balance: { type: SchemaType.NUMBER, description: '差引残高' },
        },
        required: ['date', 'description', 'balance'],
      },
    },
  },
  required: ['transactions'],
}

const BASE_PROMPT = `この PDF は日本の銀行の取引明細書です。
通帳・お取引照合表（常陽銀行等）・取引明細書・現金出納帳などの形式があります。

【必ず守ること】
- 取引行が1つでも見える場合、1行も漏らさずに transactions 配列に含める
- ヘッダ行（取引日/勘定日/摘要/お支払金額/お預り金額/差引残高など）はスキップ
- タイトル行（お取引照合表、口座情報、頁数など）はスキップ

【横型・見開き通帳の重要な注意】
通帳の見開き2ページを1つの画像/PDFページにスキャンしている場合、
左右に2つの独立した取引表があります（例: 「普通預金 ORDINARY 1」「普通預金 ORDINARY 2」）。
- 必ず左半分の表をすべて読み取ってから、右半分の表を読み取る
- 上から下、左の表が完了してから右の表へ進む順序を守る
- 左半分の最終行と右半分の最初の行は別取引なので混同しない
- 「普通預金 ORDINARY N」のような小さなページ番号表記が左右にある場合、
  それぞれが別々の表ヘッダとして認識する
- 残高の連続性で左右の境界を判定: 左表の最終残高と右表の開始残高の前の繰越残高がほぼ一致

【列構造の認識】
- 日付列: 「日付」「取引日」「年月日」「入金・出金日」「勘定日」
  ※「取引日」と「勘定日」のように2つ日付列がある場合は取引日を優先
- 摘要列: 「摘要」「お取引内容」「取引内容」「内容」「記事」
- 出金列: 「お支払金額」「出金」「出金金額」「払出」「引出」
- 入金列: 「お預り金額」「入金」「入金金額」「預入」
- 残高列: 「差引残高」「残高」「お預り残高」

【検算ルール】
各取引行: 前行の残高 + 入金額 - 出金額 = 当行の残高
不一致なら入金と出金を入れ替える

【日付の変換ルール】
- 「7-2-27」「7.2.27」→ 令和7年 → 2025-02-27
- 「6-12-25」「6.12.25」→ 令和6年 → 2024-12-25
- 「25-9-2」「25--9--2」のような年が大きい(>9)場合は平成として解釈
  例: 平成25年=2013年, 平成26年=2014年, 平成31年=2019年（5月以降は令和元年）
- 「R7.4.1」→ 2025-04-01
- 「2025-02-27」「2025/2/27」→ そのまま

【摘要の結合】
摘要列の右側に振込先名（カタカナ）が記載されている場合は摘要に含める
例: 摘要「振込WB1」+ 右側「ｽｽﾞｷ ﾄｼｵ」→ description: "振込WB1 ｽｽﾞｷ ﾄｼｵ"

各取引行のフィールド：
- page: ページ番号（0始まり）
- date: YYYY-MM-DD形式
- description: 摘要のみ（科目名は含めない・推測しない）
- deposit: 入金額（数値、出金行はnull）
- withdrawal: 出金額（数値、入金行はnull）
- balance: 差引残高（数値）

【重要】借方/貸方の科目判定、消費税の計算は一切行わない。
読み取った生データだけを返す。`

interface Transaction {
  page: number
  date: string
  description: string
  deposit: number | null
  withdrawal: number | null
  balance: number
}

export const runtime = 'nodejs'
export const maxDuration = 300

export async function POST(request: NextRequest) {
  try {
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) {
      return NextResponse.json({ error: 'GEMINI_API_KEY が設定されていません' }, { status: 500 })
    }

    const { fileUri, mimeType, startPage, endPage, geminiModel } = await request.json()
    if (!fileUri) {
      return NextResponse.json(
        { error: 'fileUri がありません（事前に /api/bank-statement/gemini-upload でアップロードしてください）' },
        { status: 400 },
      )
    }
    const fileMime = mimeType || 'application/pdf'

    const genAI = new GoogleGenerativeAI(apiKey)
    const modelName = geminiModel || process.env.GEMINI_MODEL || 'gemini-2.5-flash'

    // ページ範囲指定がある場合: 同じファイル参照にプロンプトで範囲指定
    if (typeof startPage === 'number' && typeof endPage === 'number') {
      return await processPageRange(genAI, modelName, fileUri, fileMime, startPage, endPage)
    }

    // ページ範囲指定なし: 全ページ処理
    return await processSinglePdf(genAI, modelName, fileUri, fileMime)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'OCR処理に失敗しました'
    console.error('OCR-PDF error:', err)
    return NextResponse.json({ error: `Gemini OCR エラー: ${msg}` }, { status: 500 })
  }
}

async function processPageRange(
  genAI: GoogleGenerativeAI,
  modelName: string,
  fileUri: string,
  mimeType: string,
  startPage: number,
  endPage: number,
): Promise<NextResponse> {
  const pagePrompt = `${BASE_PROMPT}

【重要: ページ範囲指定】
この PDF は複数ページありますが、${startPage + 1}ページ目から${endPage}ページ目だけを処理してください。
それ以外のページは完全に無視してください。
page フィールドには0始まりのページ番号を入れてください（${startPage}～${endPage - 1}）。`

  const maxAttempts = 3
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 64000,
          responseMimeType: 'application/json',
          responseSchema: TRANSACTION_SCHEMA,
        },
      })
      console.log(`OCR-PDF: pages ${startPage}-${endPage - 1} (attempt ${attempt}) sending fileUri to ${modelName}`)
      const startTime = Date.now()
      const result = await model.generateContent([
        pagePrompt,
        { fileData: { mimeType, fileUri } },
      ])
      const responseText = result.response.text()
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      console.log(`OCR-PDF: pages ${startPage}-${endPage - 1} completed in ${elapsed}s, response length=${responseText.length}`)

      const jsonMatch = responseText.match(/\{[\s\S]*"transactions"[\s\S]*\}/)
      if (!jsonMatch) {
        console.warn(`OCR-PDF pages ${startPage}-${endPage - 1}: JSON抽出失敗 response先頭=${responseText.slice(0, 300)}`)
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 2000 * attempt))
          continue
        }
        return NextResponse.json({ pages: [], totalCount: 0 })
      }
      const parsed = JSON.parse(jsonMatch[0])
      const transactions: Transaction[] = (parsed.transactions || []).map((tx: {
        page?: number; date?: string; description?: string;
        deposit?: number | null; withdrawal?: number | null; balance?: number
      }) => ({
        page: tx.page ?? startPage,
        date: tx.date || '',
        description: tx.description || '',
        deposit: tx.deposit ?? null,
        withdrawal: tx.withdrawal ?? null,
        balance: tx.balance ?? 0,
      }))
      console.log(`OCR-PDF: pages ${startPage}-${endPage - 1} extracted ${transactions.length} transactions`)

      const pageGroups: Record<number, Transaction[]> = {}
      for (const tx of transactions) {
        if (!pageGroups[tx.page]) pageGroups[tx.page] = []
        pageGroups[tx.page].push(tx)
      }
      const pages = Object.entries(pageGroups).map(([pageIdx, txs]) => ({
        pageIndex: parseInt(pageIdx),
        transactions: txs.map((t) => ({
          date: t.date, description: t.description,
          deposit: t.deposit, withdrawal: t.withdrawal, balance: t.balance,
        })),
      }))
      return NextResponse.json({ pages, totalCount: transactions.length })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const isRetriable = /429|503|504|timeout|ECONN|fetch failed/i.test(msg)
      console.warn(`OCR-PDF pages ${startPage}-${endPage - 1} error (attempt ${attempt}/${maxAttempts}): ${msg}`)
      if (attempt < maxAttempts && isRetriable) {
        await new Promise((r) => setTimeout(r, 2000 * Math.pow(2, attempt - 1)))
        continue
      }
    }
  }
  return NextResponse.json({ pages: [], totalCount: 0 })
}

async function processSinglePdf(
  genAI: GoogleGenerativeAI,
  modelName: string,
  fileUri: string,
  mimeType: string,
): Promise<NextResponse> {
    const model = genAI.getGenerativeModel({
      model: modelName,
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 64000,
        responseMimeType: 'application/json',
        responseSchema: TRANSACTION_SCHEMA,
      },
    })

    const prompt = `${BASE_PROMPT}\nPDF 全ページから取引データを読み取って返してください。`

    console.log(`OCR-PDF: sending fileUri (full PDF) to ${modelName}`)
    const startTime = Date.now()
    const result = await model.generateContent([
      prompt,
      { fileData: { mimeType, fileUri } },
    ])
    const responseText = result.response.text()
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(`OCR-PDF completed in ${elapsed}s, response length=${responseText.length}`)

    const jsonMatch = responseText.match(/\{[\s\S]*"transactions"[\s\S]*\}/)
    if (!jsonMatch) {
      console.warn(`OCR-PDF: JSON抽出失敗 response先頭=${responseText.slice(0, 300)}`)
      return NextResponse.json({ error: 'Gemini応答からJSONを抽出できませんでした' }, { status: 500 })
    }

    const parsed = JSON.parse(jsonMatch[0])
    const transactions: Transaction[] = (parsed.transactions || []).map((tx: {
      page?: number; date?: string; description?: string;
      deposit?: number | null; withdrawal?: number | null; balance?: number
    }) => ({
      page: tx.page ?? 0,
      date: tx.date || '',
      description: tx.description || '',
      deposit: tx.deposit ?? null,
      withdrawal: tx.withdrawal ?? null,
      balance: tx.balance ?? 0,
    }))

    console.log(`OCR-PDF: extracted ${transactions.length} transactions`)

    const pageGroups: Record<number, Transaction[]> = {}
    for (const tx of transactions) {
      if (!pageGroups[tx.page]) pageGroups[tx.page] = []
      pageGroups[tx.page].push(tx)
    }
    const pages = Object.entries(pageGroups).map(([pageIdx, txs]) => ({
      pageIndex: parseInt(pageIdx),
      transactions: txs.map((t) => ({
        date: t.date, description: t.description,
        deposit: t.deposit, withdrawal: t.withdrawal, balance: t.balance,
      })),
    }))

    return NextResponse.json({ pages, totalCount: transactions.length })
}
