// ブラウザから直接 Gemini を呼び出すクライアント。
// 以前は /api/bank-statement/* のサーバールートで処理していたが、
// 静的サイト（GitHub Pages）化に伴い、各ユーザーが自分の API キーを入力して
// ブラウザから直接 Gemini を叩く方式に変更した。
//
// API キーは設定画面で入力し localStorage('bs-gemini-api-key') に保存する。

import { GoogleGenerativeAI, SchemaType, type ResponseSchema } from '@google/generative-ai'

export const GEMINI_API_KEY_STORAGE = 'bs-gemini-api-key'
/** スイート共通のGeminiキー（ホーム画面の共通設定で登録）。モジュール個別キーが空のときに使う */
export const SUITE_GEMINI_API_KEY_STORAGE = 'suite-gemini-api-key'
const DEFAULT_MODEL = 'gemini-2.5-flash'

/** Gemini API キーを取得（仕訳作成の個別キー → スイート共通キー の順。未設定ならエラー） */
function getApiKey(): string {
  if (typeof window === 'undefined') throw new Error('ブラウザ以外では利用できません')
  const own = (localStorage.getItem(GEMINI_API_KEY_STORAGE) || '').trim()
  const suite = (localStorage.getItem(SUITE_GEMINI_API_KEY_STORAGE) || '').trim()
  const key = own || suite
  if (!key) {
    throw new Error('Gemini APIキーが未設定です。ホーム画面の「共通設定」または画面右上のメニュー →「Gemini APIキー設定」から入力してください。')
  }
  return key
}

function resolveModel(geminiModel?: string): string {
  return geminiModel || DEFAULT_MODEL
}

function genAI(): GoogleGenerativeAI {
  return new GoogleGenerativeAI(getApiKey())
}

// ============================================================
// Gemini File API（再開可能アップロード）
// ============================================================

export interface GeminiFileRef {
  name: string
  uri: string
  mimeType: string
  state: string
}

/**
 * Gemini File API へファイル(Blob)をアップロードし fileUri を取得する。
 * 大きなPDFをリクエスト本体に含めずに済む。
 */
export async function geminiUpload(blob: Blob, displayName: string, mimeType?: string): Promise<GeminiFileRef> {
  const apiKey = getApiKey()
  const buf = await blob.arrayBuffer()
  const numBytes = buf.byteLength
  const mime = mimeType || blob.type || 'application/octet-stream'

  // 1) 再開可能アップロードを開始
  const startRes = await fetch(
    // APIキーはURLに載せず（履歴・ログへの残留防止）、ヘッダで渡す
    `https://generativelanguage.googleapis.com/upload/v1beta/files`,
    {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(numBytes),
        'X-Goog-Upload-Header-Content-Type': mime,
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
  if (!uploadUrl) throw new Error('upload start: x-goog-upload-url ヘッダがありません')

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
  const upData = (await upRes.json()) as { file?: GeminiFileRef }
  if (!upData.file) throw new Error('upload finalize: file が応答にありません')

  let info = upData.file
  // 3) PDFは PROCESSING になるため ACTIVE まで待機
  if (info.state !== 'ACTIVE') {
    info = await waitForActive(apiKey, info.name)
  }
  return { name: info.name, uri: info.uri, mimeType: info.mimeType, state: info.state }
}

async function waitForActive(apiKey: string, name: string): Promise<GeminiFileRef> {
  const url = `https://generativelanguage.googleapis.com/v1beta/${name}`
  const maxAttempts = 60
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    const r = await fetch(url, { headers: { 'x-goog-api-key': apiKey } })
    if (!r.ok) {
      const t = await r.text().catch(() => '')
      throw new Error(`file status HTTP ${r.status}: ${t.slice(0, 200)}`)
    }
    const data = (await r.json()) as GeminiFileRef
    if (data.state === 'ACTIVE') return data
    if (data.state === 'FAILED') throw new Error(`file processing FAILED: ${name}`)
  }
  throw new Error(`file が ${maxAttempts}秒以内に ACTIVE になりませんでした: ${name}`)
}

// ============================================================
// 通帳・明細 OCR（画像 fileUri ベース） … 旧 /api/bank-statement/ocr
// ============================================================

const PROMPT_PER_PAGE = `この画像は日本の銀行の取引明細書です。
通帳・お取引照合表（常陽銀行等）・取引明細書・現金出納帳などの形式があります。
画像から必ず取引データを読み取ってJSONで返してください。

【必ず守ること】
- 取引行が1つでも見える場合、必ず transactions 配列に入れる
- ヘッダ行（取引日/勘定日/摘要/お支払金額/お預り金額/差引残高など）はスキップ
- タイトル行（お取引照合表、口座情報など）はスキップ
- 取引行を1つも見つけられない場合のみ {"transactions": []} を返す
各取引行について以下の情報をJSON形式で抽出してください。

【最優先: 列構造の認識】
まず列ヘッダーを特定してください。以下のような列名が含まれます：
- 日付列: 「日付」「取引日」「年月日」「入金・出金日」「勘定日」「銀行処理日」
  ※「取引日」と「勘定日」のように2つ日付列がある場合は取引日を優先
- 摘要列: 「摘要」「お取引内容」「取引内容」「内容」「記事」
- 出金列: 「お支払金額」「出金」「出金金額」「払出」「引出」
- 入金列: 「お預り金額」「入金」「入金金額」「預入」
- 残高列: 「差引残高」「残高」「お預り残高」
- 他の列（小切手番号・手形番号・店番等）は無視

「出金」系の列にある数字 → withdrawal（出金）
「入金」系の列にある数字 → deposit（入金）

【検算ルール】
各取引行: 前行の残高 + 入金額 - 出金額 = 当行の残高
不一致なら入金と出金を入れ替えてください。

各取引行のフィールド：
- date: 取引日（YYYY-MM-DD形式。必ず西暦に変換）
- description: 摘要（金額列の横のカタカナ・数字も含める）
- deposit: 入金額（入金系列の数値。null可）
- withdrawal: 出金額（出金系列の数値。null可）
- balance: 残高（差引残高列の数値）

【繰越残高について - 重要】
通帳の最終行が「繰越」「くりこし」「次頁へ」等の場合、その残高は通帳繰り越しのための表示であり、
実際の取引ではありません。この行はdeposit=null, withdrawal=nullとし、balanceにはその残高を記録してください。
ただし、最終残高としてCSV出力する際はこの繰越残高ではなく、直前の通常取引の残高を使ってください。

【日付の変換ルール】
- 「7-2-27」「7.2.27」→ 令和7年 → 2025-02-27（令和N年 = 2018 + N年）
- 「6-12-25」「6.12.25」→ 令和6年 → 2024-12-25
- 「R7.4.1」→ 2025-04-01
- 「2025-02-27」「2025/2/27」→ そのまま

【お取引照合表・取引明細書の場合の注意】
- 「振込WB1」「振込2」などの略号も摘要として抽出する
- 摘要列の右側に振込先名（カタカナ）が記載されている場合はそれも摘要に含める
  例: 摘要「振込WB1」+ 右側「ｽｽﾞｷ ﾄｼｵ」→ description: "振込WB1 ｽｽﾞｷ ﾄｼｵ"
- 列見出し行（取引日/勘定日/摘要/…）や残高開始行はtransactionsに含めない

【重要】画像に取引データが1行でも見える場合、絶対に全て抽出してください。
日付列・金額列・摘要列が確認できる取引行は、1行も漏らさずに transactions に含めてください。
判断に迷った場合は「取引である」として含めてください。
「空のテーブル」「ヘッダのみの画像」「取引が0件」という判断は、本当に何も書かれていない場合のみです。

出力形式:
{"transactions": [{"date": "YYYY-MM-DD", "description": "摘要", "deposit": 数値またはnull, "withdrawal": 数値またはnull, "balance": 数値}]}

他の説明文は不要。JSONのみを返してください。`

interface Transaction {
  page: number
  date: string
  description: string
  deposit: number | null
  withdrawal: number | null
  balance: number
}

function verifyAndCorrectTransactions(transactions: Transaction[]): {
  corrected: Transaction[]
  corrections: string[]
} {
  if (transactions.length === 0) return { corrected: [], corrections: [] }
  const corrected = [...transactions.map((t) => ({ ...t }))]
  const corrections: string[] = []

  for (let i = 0; i < corrected.length; i++) {
    const tx = corrected[i]
    const deposit = tx.deposit ?? 0
    const withdrawal = tx.withdrawal ?? 0
    if (deposit === 0 && withdrawal === 0) continue

    let prevBalance: number | null = null
    for (let j = i - 1; j >= 0; j--) {
      if (corrected[j].balance != null) { prevBalance = corrected[j].balance; break }
    }
    if (prevBalance === null || tx.balance == null) continue

    const expectedBalance = prevBalance + deposit - withdrawal
    if (Math.abs(expectedBalance - tx.balance) < 1) continue

    const swappedBalance = prevBalance + withdrawal - deposit
    if (Math.abs(swappedBalance - tx.balance) < 1) {
      corrections.push(`行${i + 1} (${tx.date} ${tx.description}): 入金${deposit.toLocaleString()}↔出金${withdrawal.toLocaleString()} を入替え`)
      tx.deposit = withdrawal > 0 ? withdrawal : null
      tx.withdrawal = deposit > 0 ? deposit : null
      continue
    }
    if (deposit > 0 && withdrawal === 0) {
      const asWithdrawal = prevBalance - deposit
      if (Math.abs(asWithdrawal - tx.balance) < 1) {
        corrections.push(`行${i + 1} (${tx.date}): 入金${deposit.toLocaleString()} → 出金に修正`)
        tx.withdrawal = deposit; tx.deposit = null; continue
      }
    }
    if (withdrawal > 0 && deposit === 0) {
      const asDeposit = prevBalance + withdrawal
      if (Math.abs(asDeposit - tx.balance) < 1) {
        corrections.push(`行${i + 1} (${tx.date}): 出金${withdrawal.toLocaleString()} → 入金に修正`)
        tx.deposit = withdrawal; tx.withdrawal = null; continue
      }
    }
  }
  return { corrected, corrections }
}

export interface OcrPage {
  pageIndex: number
  transactions: Transaction[]
}

/** 画像（fileUri）から通帳取引を抽出。旧 /api/bank-statement/ocr 相当 */
export async function ocrImagesByFileUri(
  files: { fileUri: string; mimeType?: string }[],
  templateHint?: string,
  geminiModel?: string,
): Promise<{ pages: OcrPage[]; corrections?: string[] }> {
  if (!files || files.length === 0) {
    throw new Error('fileUri がありません')
  }
  const fileRefs = files.map((f) => ({ fileUri: f.fileUri, mimeType: f.mimeType || 'image/png' }))
  const model = genAI().getGenerativeModel({ model: resolveModel(geminiModel), generationConfig: { temperature: 0 } })
  const promptAddition = templateHint ? `\n${templateHint}` : ''

  const processOnePage = async (ref: { fileUri: string; mimeType: string }, pageIndex: number): Promise<Transaction[]> => {
    const result = await model.generateContent([
      PROMPT_PER_PAGE + promptAddition,
      { fileData: { mimeType: ref.mimeType, fileUri: ref.fileUri } },
    ])
    const responseText = result.response.text()
    const jsonMatch = responseText.match(/\{[\s\S]*"transactions"[\s\S]*\}/)
    if (!jsonMatch) return []
    const parsed = JSON.parse(jsonMatch[0])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (parsed.transactions || []).map((tx: any) => ({
      page: pageIndex,
      date: tx.date || '',
      description: tx.description || '',
      deposit: tx.deposit,
      withdrawal: tx.withdrawal,
      balance: tx.balance ?? 0,
    }))
  }

  const results = await Promise.all(fileRefs.map((ref, i) => processOnePage(ref, i)))
  const allTransactions: Transaction[] = []
  results.forEach((txs) => allTransactions.push(...txs))

  const { corrected, corrections } = verifyAndCorrectTransactions(allTransactions)

  const pageGroups: Record<number, Transaction[]> = {}
  for (let i = 0; i < fileRefs.length; i++) pageGroups[i] = []
  for (const tx of corrected) {
    const idx = tx.page ?? 0
    if (!pageGroups[idx]) pageGroups[idx] = []
    pageGroups[idx].push(tx)
  }
  const pages = Object.keys(pageGroups).map(Number).sort((a, b) => a - b)
    .map((idx) => ({ pageIndex: idx, transactions: pageGroups[idx] }))

  return { pages, corrections: corrections.length > 0 ? corrections : undefined }
}

// ============================================================
// PDF OCR（fileUri＋構造化出力） … 旧 /api/bank-statement/ocr-pdf
// ============================================================

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

export interface OcrPdfResult {
  pages: { pageIndex: number; transactions: { date: string; description: string; deposit: number | null; withdrawal: number | null; balance: number }[] }[]
  totalCount: number
}

/** PDF（fileUri）から取引抽出。ページ範囲指定可。旧 /api/bank-statement/ocr-pdf 相当 */
export async function ocrPdf(opts: {
  fileUri: string
  mimeType?: string
  startPage?: number
  endPage?: number
  geminiModel?: string
}): Promise<OcrPdfResult> {
  const { fileUri, startPage, endPage } = opts
  if (!fileUri) throw new Error('fileUri がありません')
  const mimeType = opts.mimeType || 'application/pdf'
  const modelName = resolveModel(opts.geminiModel)

  const hasRange = typeof startPage === 'number' && typeof endPage === 'number'
  const prompt = hasRange
    ? `${BASE_PROMPT}

【重要: ページ範囲指定】
この PDF は複数ページありますが、${startPage! + 1}ページ目から${endPage}ページ目だけを処理してください。
それ以外のページは完全に無視してください。
page フィールドには0始まりのページ番号を入れてください（${startPage}～${endPage! - 1}）。`
    : `${BASE_PROMPT}\nPDF 全ページから取引データを読み取って返してください。`

  const maxAttempts = hasRange ? 3 : 1
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const model = genAI().getGenerativeModel({
        model: modelName,
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 64000,
          responseMimeType: 'application/json',
          responseSchema: TRANSACTION_SCHEMA,
        },
      })
      const result = await model.generateContent([prompt, { fileData: { mimeType, fileUri } }])
      const responseText = result.response.text()
      const jsonMatch = responseText.match(/\{[\s\S]*"transactions"[\s\S]*\}/)
      if (!jsonMatch) {
        if (attempt < maxAttempts) { await new Promise((r) => setTimeout(r, 2000 * attempt)); continue }
        return { pages: [], totalCount: 0 }
      }
      const parsed = JSON.parse(jsonMatch[0])
      const transactions: Transaction[] = (parsed.transactions || []).map((tx: {
        page?: number; date?: string; description?: string; deposit?: number | null; withdrawal?: number | null; balance?: number
      }) => ({
        page: tx.page ?? (startPage ?? 0),
        date: tx.date || '',
        description: tx.description || '',
        deposit: tx.deposit ?? null,
        withdrawal: tx.withdrawal ?? null,
        balance: tx.balance ?? 0,
      }))
      const pageGroups: Record<number, Transaction[]> = {}
      for (const tx of transactions) {
        if (!pageGroups[tx.page]) pageGroups[tx.page] = []
        pageGroups[tx.page].push(tx)
      }
      const pages = Object.entries(pageGroups).map(([pageIdx, txs]) => ({
        pageIndex: parseInt(pageIdx),
        transactions: txs.map((t) => ({ date: t.date, description: t.description, deposit: t.deposit, withdrawal: t.withdrawal, balance: t.balance })),
      }))
      return { pages, totalCount: transactions.length }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const isRetriable = /429|503|504|timeout|ECONN|fetch failed/i.test(msg)
      if (attempt < maxAttempts && isRetriable) {
        await new Promise((r) => setTimeout(r, 2000 * Math.pow(2, attempt - 1)))
        continue
      }
      if (!hasRange) throw e
    }
  }
  return { pages: [], totalCount: 0 }
}

// ============================================================
// 共通: data URL 画像配列を inlineData parts に変換
// ============================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function imagesToParts(images: string[]): any[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parts: any[] = []
  for (const img of images) {
    const match = img.match(/^data:([^;]+);base64,(.+)$/)
    if (!match) continue
    parts.push({ inlineData: { mimeType: match[1], data: match[2] } })
  }
  return parts
}

// ============================================================
// クレジットカード明細 OCR … 旧 /api/bank-statement/credit-card
// ============================================================

const PROMPT_CREDIT_CARD = `この画像はクレジットカードの利用明細書です。
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
- 金額は原則として必ず正の数（プラス）にしてください。
  マイナス（負の数）にしてよいのは、その行に明確な返品・取消の印がある場合のみです。具体的には:
  ・金額の前に「-」「△」「▲」が付いている
  ・「返品」「取消」「取消し」「返金」「ご返済」「キャンセル」などの文字が行内にある
  ・金額がカッコ書き（例: (1,234)）になっている
  上記のような明確な印が無い通常の利用は、たとえ少額でも必ず正の数にしてください。印が無いのに推測でマイナスにしないこと。
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

export interface CreditCardResult {
  paymentDate: string
  totalAmount: number
  cardName?: string
  transactions: { usageDate: string; storeName: string; amount: number; memo: string }[]
}

export async function creditCardOcr(images: string[], geminiModel?: string): Promise<CreditCardResult> {
  if (!images || images.length === 0) throw new Error('画像データがありません')
  const model = genAI().getGenerativeModel({ model: resolveModel(geminiModel), generationConfig: { temperature: 0 } })
  const parts = images.map((img: string) => {
    const base64 = img.replace(/^data:image\/\w+;base64,/, '')
    return { inlineData: { mimeType: 'image/jpeg', data: base64 } }
  })
  const result = await model.generateContent([PROMPT_CREDIT_CARD, ...parts])
  const text = result.response.text()
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('Gemini応答からJSONを抽出できませんでした')
  const data = JSON.parse(jsonMatch[0])
  if (!data.paymentDate || !data.transactions || !Array.isArray(data.transactions)) {
    throw new Error('明細データの抽出に失敗しました。引落日・取引明細が認識できませんでした。')
  }
  data.totalAmount = Math.abs(data.totalAmount || 0)
  data.transactions = data.transactions.map((t: { usageDate: string; storeName: string; amount: number; memo?: string }) => ({
    usageDate: t.usageDate || data.paymentDate,
    storeName: (t.storeName || '').trim(),
    amount: t.amount || 0,
    memo: (t.memo || '').trim(),
  }))
  return data as CreditCardResult
}

// ============================================================
// レシート・領収書 OCR … 旧 /api/bank-statement/receipt
// ============================================================

const PROMPT_RECEIPT = `この画像はレシートまたは領収書です（1つのPDFに複数のレシート・領収書が含まれる場合があります）。
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
  - taxRate: 税率（"10%", "8%", "非課税" 等。軽減税率の対象（飲食料品・新聞等）は "8%"）
  - netAmount: 本体価格
  - taxAmount: 消費税額
  - totalAmount: 税込金額
  - 【重要】1枚のレシートに複数の税率（10%対象と軽減8%対象など）が混在する場合は、税率ごとに必ず別々の要素に分けてください。10%対象額と8%対象額を合算して1要素にまとめてはいけません。
  - レシート下部の「10%対象 ¥◯◯」「8%対象 ¥◯◯」「(軽)」マーク等から税率別の税込金額を読み取ってください。
- pageIndex: このレシートが含まれるページ（0始まり）

出力は必ず以下のJSON形式のみ：
{"receipts": [{"receiptIndex": 0, "storeName": "スーパー", "receiptDate": "2025-03-15", "mainContent": "食料品・日用品", "invoiceNumber": "T1234567890123", "taxLines": [{"taxRate": "10%", "netAmount": 1000, "taxAmount": 100, "totalAmount": 1100}, {"taxRate": "8%", "netAmount": 2000, "taxAmount": 160, "totalAmount": 2160}], "pageIndex": 0}]}

注意：
- 金額のカンマは除去して数値にしてください
- 読み取れない場合は空配列 {"receipts": []} を返してください`

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function receiptOcr(images: string[], geminiModel?: string): Promise<{ receipts: any[] }> {
  if (!images || images.length === 0) throw new Error('画像データがありません')
  const model = genAI().getGenerativeModel({ model: resolveModel(geminiModel), generationConfig: { temperature: 0 } })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parts: any[] = [PROMPT_RECEIPT, ...imagesToParts(images)]
  const result = await model.generateContent(parts)
  const responseText = result.response.text()
  const jsonMatch = responseText.match(/\{[\s\S]*"receipts"[\s\S]*\}/)
  if (!jsonMatch) return { receipts: [] }
  const parsed = JSON.parse(jsonMatch[0])
  return { receipts: parsed.receipts || [] }
}

// ============================================================
// 請求書 OCR … 旧 /api/bank-statement/invoice
// ============================================================

const PROMPT_INVOICE_SALES = `この画像は売上請求書です（1つのPDFに複数の請求書が含まれる場合があります）。
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
- totalAmount: 請求書全体の合計請求金額（「ご請求金額」「請求金額」「振込金額」「お支払金額」「合計」など、書類に記載された最終金額。税率内訳が読み取れない場合でも必ずこのフィールドに金額を入れてください）
- pageStart: この請求書の開始ページ（0始まり）
- pageEnd: この請求書の終了ページ（0始まり）

出力は必ず以下のJSON形式のみ：
{"invoices": [{"invoiceIndex": 0, "counterpartName": "山田商事", "invoiceDate": "2025-03-31", "mainContent": "ガソリン", "taxLines": [{"taxRate": "10%", "netAmount": 100000, "taxAmount": 10000, "totalAmount": 110000}], "totalAmount": 110000, "pageStart": 0, "pageEnd": 0}]}

注意：
- 金額のカンマは除去して数値にしてください
- 税率内訳（taxLines）が読み取れない場合でも、請求金額・振込金額は totalAmount に必ず入れてください（taxLines は空配列でも構いません）
- 読み取れない場合は空配列 {"invoices": []} を返してください`

const PROMPT_INVOICE_PURCHASE = `この画像は仕入請求書（受領した請求書）です（1つのPDFに複数の請求書が含まれる場合があります）。
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
- totalAmount: 請求書全体の合計請求金額（「ご請求金額」「請求金額」「振込金額」「お支払金額」「合計」など、書類に記載された最終金額。税率内訳が読み取れない場合でも必ずこのフィールドに金額を入れてください）
- pageStart: この請求書の開始ページ（0始まり）
- pageEnd: この請求書の終了ページ（0始まり）

出力は必ず以下のJSON形式のみ：
{"invoices": [{"invoiceIndex": 0, "counterpartName": "東京物産", "invoiceNumber": "T1234567890123", "invoiceDate": "2025-03-31", "mainContent": "事務用品", "taxLines": [{"taxRate": "10%", "netAmount": 50000, "taxAmount": 5000, "totalAmount": 55000}], "totalAmount": 55000, "pageStart": 0, "pageEnd": 0}]}

注意：
- 金額のカンマは除去して数値にしてください
- インボイス番号が見つからない場合は invoiceNumber を空文字にしてください
- 税率内訳（taxLines）が読み取れない場合でも、請求金額・振込金額は totalAmount に必ず入れてください（taxLines は空配列でも構いません）
- 読み取れない場合は空配列 {"invoices": []} を返してください`

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function invoiceOcr(images: string[], type: string, geminiModel?: string): Promise<{ invoices: any[] }> {
  if (!images || images.length === 0) throw new Error('画像データがありません')
  const model = genAI().getGenerativeModel({ model: resolveModel(geminiModel), generationConfig: { temperature: 0 } })
  const prompt = type === 'purchase' ? PROMPT_INVOICE_PURCHASE : PROMPT_INVOICE_SALES
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parts: any[] = [prompt, ...imagesToParts(images)]
  const result = await model.generateContent(parts)
  const responseText = result.response.text()
  const jsonMatch = responseText.match(/\{[\s\S]*"invoices"[\s\S]*\}/)
  if (!jsonMatch) return { invoices: [] }
  const parsed = JSON.parse(jsonMatch[0])
  return { invoices: parsed.invoices || [] }
}

// ============================================================
// 摘要補完 … 旧 /api/bank-statement/expand-descriptions
// ============================================================

const PROMPT_EXPAND = `あなたは日本の会計事務所の記帳担当者です。現金出納帳の「摘要」列を上から順に並べた配列を渡します。
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

export async function expandDescriptions(descriptions: string[], geminiModel?: string): Promise<{ descriptions: string[]; warning?: string }> {
  if (!Array.isArray(descriptions) || descriptions.length === 0) return { descriptions: [] }
  const model = genAI().getGenerativeModel({ model: resolveModel(geminiModel), generationConfig: { temperature: 0 } })
  const result = await model.generateContent([PROMPT_EXPAND, JSON.stringify({ descriptions })])
  const responseText = result.response.text()
  const jsonMatch = responseText.match(/\{[\s\S]*"descriptions"[\s\S]*\}/)
  if (!jsonMatch) return { descriptions, warning: 'AI 応答を解析できませんでした' }
  const parsed = JSON.parse(jsonMatch[0])
  const out: unknown = parsed.descriptions
  if (!Array.isArray(out) || out.length !== descriptions.length) {
    return { descriptions, warning: 'AI 応答の件数が一致しませんでした' }
  }
  return { descriptions: out.map((d) => String(d ?? '')) }
}
