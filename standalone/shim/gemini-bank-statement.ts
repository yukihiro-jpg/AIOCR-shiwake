// /api/bank-statement/gemini-upload と /api/bank-statement/ocr-pdf のクライアント版。
// src/app/api/bank-statement/{gemini-upload,ocr-pdf}/route.ts のロジックを忠実に移植し、
// File API(fileUri) の代わりに inlineData(base64) を使う。プロンプト・スキーマは原本と同一。
import { GoogleGenerativeAI, SchemaType, type ResponseSchema } from '@google/generative-ai'
import {
  ensureApiKey,
  getModel,
  storeLocalFile,
  getLocalFile,
  blobToBase64,
  jsonResponse,
} from './gemini-common'

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

// POST /api/bank-statement/gemini-upload （FormData: file, mimeType, displayName）
export async function handleGeminiUpload(init: RequestInit | undefined): Promise<Response> {
  try {
    const form = init?.body as FormData
    if (!form || typeof form.get !== 'function') {
      return jsonResponse({ error: 'file が指定されていません' }, 400)
    }
    const fileEntry = form.get('file')
    if (!fileEntry || typeof fileEntry === 'string') {
      return jsonResponse({ error: 'file が指定されていません' }, 400)
    }
    const blob = fileEntry as Blob & { name?: string }
    const displayName =
      (form.get('displayName')?.toString() || (typeof blob.name === 'string' ? blob.name : 'upload'))
    const mimeType = (form.get('mimeType')?.toString() || blob.type) || 'application/octet-stream'

    const base64 = await blobToBase64(blob)
    const uri = storeLocalFile(base64, mimeType, displayName)
    return jsonResponse({ name: uri, uri, mimeType, state: 'ACTIVE' })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return jsonResponse({ error: `アップロード失敗: ${msg}` }, 500)
  }
}

function buildModel(genAI: GoogleGenerativeAI, modelName: string) {
  return genAI.getGenerativeModel({
    model: modelName,
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 64000,
      responseMimeType: 'application/json',
      responseSchema: TRANSACTION_SCHEMA,
    },
  })
}

function parseTransactions(responseText: string, defaultPage: number): Transaction[] {
  const jsonMatch = responseText.match(/\{[\s\S]*"transactions"[\s\S]*\}/)
  if (!jsonMatch) return []
  const parsed = JSON.parse(jsonMatch[0])
  return (parsed.transactions || []).map((tx: {
    page?: number; date?: string; description?: string
    deposit?: number | null; withdrawal?: number | null; balance?: number
  }) => ({
    page: tx.page ?? defaultPage,
    date: tx.date || '',
    description: tx.description || '',
    deposit: tx.deposit ?? null,
    withdrawal: tx.withdrawal ?? null,
    balance: tx.balance ?? 0,
  }))
}

function groupToPages(transactions: Transaction[]) {
  const pageGroups: Record<number, Transaction[]> = {}
  for (const tx of transactions) {
    if (!pageGroups[tx.page]) pageGroups[tx.page] = []
    pageGroups[tx.page].push(tx)
  }
  return Object.entries(pageGroups).map(([pageIdx, txs]) => ({
    pageIndex: parseInt(pageIdx),
    transactions: txs.map((t) => ({
      date: t.date, description: t.description,
      deposit: t.deposit, withdrawal: t.withdrawal, balance: t.balance,
    })),
  }))
}

// POST /api/bank-statement/ocr-pdf （JSON: fileUri, mimeType, startPage?, endPage?, geminiModel）
export async function handleOcrPdf(init: RequestInit | undefined): Promise<Response> {
  try {
    const apiKey = ensureApiKey()
    const body = JSON.parse((init?.body as string) || '{}')
    const { fileUri, mimeType, startPage, endPage, geminiModel } = body
    if (!fileUri) {
      return jsonResponse({ error: 'fileUri がありません' }, 400)
    }
    const stored = getLocalFile(fileUri)
    if (!stored) {
      return jsonResponse({ error: 'アップロード済みファイルが見つかりません（再アップロードしてください）' }, 400)
    }
    const fileMime = mimeType || stored.mimeType || 'application/pdf'
    const genAI = new GoogleGenerativeAI(apiKey)
    const modelName = geminiModel || getModel()
    const inlinePart = { inlineData: { mimeType: fileMime, data: stored.base64 } }

    if (typeof startPage === 'number' && typeof endPage === 'number') {
      const pagePrompt = `${BASE_PROMPT}

【重要: ページ範囲指定】
この PDF は複数ページありますが、${startPage + 1}ページ目から${endPage}ページ目だけを処理してください。
それ以外のページは完全に無視してください。
page フィールドには0始まりのページ番号を入れてください（${startPage}～${endPage - 1}）。`
      const maxAttempts = 3
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const model = buildModel(genAI, modelName)
          const result = await model.generateContent([pagePrompt, inlinePart])
          const transactions = parseTransactions(result.response.text(), startPage)
          if (transactions.length > 0 || attempt === maxAttempts) {
            return jsonResponse({ pages: groupToPages(transactions), totalCount: transactions.length })
          }
          await new Promise((r) => setTimeout(r, 2000 * attempt))
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          const isRetriable = /429|503|504|timeout|ECONN|fetch failed/i.test(msg)
          if (attempt < maxAttempts && isRetriable) {
            await new Promise((r) => setTimeout(r, 2000 * Math.pow(2, attempt - 1)))
            continue
          }
          if (attempt === maxAttempts) throw e
        }
      }
      return jsonResponse({ pages: [], totalCount: 0 })
    }

    // ページ範囲指定なし: 全ページ
    const prompt = `${BASE_PROMPT}\nPDF 全ページから取引データを読み取って返してください。`
    const model = buildModel(genAI, modelName)
    const result = await model.generateContent([prompt, inlinePart])
    const transactions = parseTransactions(result.response.text(), 0)
    return jsonResponse({ pages: groupToPages(transactions), totalCount: transactions.length })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'OCR処理に失敗しました'
    return jsonResponse({ error: `Gemini OCR エラー: ${msg}` }, 500)
  }
}
