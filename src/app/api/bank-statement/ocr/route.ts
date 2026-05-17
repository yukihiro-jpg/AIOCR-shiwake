import { NextRequest, NextResponse } from 'next/server'
import { GoogleGenerativeAI } from '@google/generative-ai'

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
      if (corrected[j].balance != null) {
        prevBalance = corrected[j].balance
        break
      }
    }

    if (prevBalance === null || tx.balance == null) continue

    const expectedBalance = prevBalance + deposit - withdrawal
    const actualBalance = tx.balance

    if (Math.abs(expectedBalance - actualBalance) < 1) continue

    const swappedBalance = prevBalance + withdrawal - deposit
    if (Math.abs(swappedBalance - actualBalance) < 1) {
      corrections.push(
        `行${i + 1} (${tx.date} ${tx.description}): 入金${deposit.toLocaleString()}↔出金${withdrawal.toLocaleString()} を入替え`,
      )
      tx.deposit = withdrawal > 0 ? withdrawal : null
      tx.withdrawal = deposit > 0 ? deposit : null
      continue
    }

    if (deposit > 0 && withdrawal === 0) {
      const asWithdrawal = prevBalance - deposit
      if (Math.abs(asWithdrawal - actualBalance) < 1) {
        corrections.push(`行${i + 1} (${tx.date}): 入金${deposit.toLocaleString()} → 出金に修正`)
        tx.withdrawal = deposit
        tx.deposit = null
        continue
      }
    }

    if (withdrawal > 0 && deposit === 0) {
      const asDeposit = prevBalance + withdrawal
      if (Math.abs(asDeposit - actualBalance) < 1) {
        corrections.push(`行${i + 1} (${tx.date}): 出金${withdrawal.toLocaleString()} → 入金に修正`)
        tx.deposit = withdrawal
        tx.withdrawal = null
        continue
      }
    }
  }

  return { corrected, corrections }
}

async function processOnePage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  model: any,
  imageDataUrl: string,
  pageIndex: number,
  promptAddition: string = '',
): Promise<{ pageIndex: number; transactions: Transaction[]; error?: string }> {
  const base64Match = imageDataUrl.match(/^data:([^;]+);base64,(.+)$/)
  if (!base64Match) {
    return { pageIndex, transactions: [], error: '画像形式が不正です' }
  }

  const fullPrompt = PROMPT_PER_PAGE + promptAddition
  const result = await model.generateContent([
    fullPrompt,
    { inlineData: { mimeType: base64Match[1], data: base64Match[2] } },
  ])

  const responseText = result.response.text()
  console.log(`Page ${pageIndex} response:`, responseText.substring(0, 300))

  const jsonMatch = responseText.match(/\{[\s\S]*"transactions"[\s\S]*\}/)
  if (!jsonMatch) {
    return { pageIndex, transactions: [], error: 'JSONを抽出できませんでした' }
  }

  const parsed = JSON.parse(jsonMatch[0])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const transactions: Transaction[] = (parsed.transactions || []).map((tx: any) => ({
    page: pageIndex,
    date: tx.date || '',
    description: tx.description || '',
    deposit: tx.deposit,
    withdrawal: tx.withdrawal,
    balance: tx.balance ?? 0,
  }))

  return { pageIndex, transactions }
}

export async function POST(request: NextRequest) {
  try {
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) {
      return NextResponse.json(
        { error: 'GEMINI_API_KEY が設定されていません。' },
        { status: 500 },
      )
    }

    const { images, templateHint, geminiModel } = await request.json()
    console.log(`OCR request: ${images?.length || 0} pages${templateHint ? ' (with template)' : ''}`)

    if (!images || !Array.isArray(images) || images.length === 0) {
      return NextResponse.json({ error: '画像データがありません' }, { status: 400 })
    }

    const genAI = new GoogleGenerativeAI(apiKey)
    const modelName = geminiModel || process.env.GEMINI_MODEL || 'gemini-2.5-flash'
    console.log(`Using model: ${modelName}, sending ${images.length} pages in parallel`)
    const model = genAI.getGenerativeModel({ model: modelName, generationConfig: { temperature: 0 } })

    // テンプレート情報があればプロンプトに追加
    const promptAddition = templateHint ? `\n${templateHint}` : ''

    // 全ページを並列でAPIに送信
    const startTime = Date.now()
    const promises = images.map((img: string, i: number) => processOnePage(model, img, i, promptAddition))
    const results = await Promise.all(promises)
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(`All ${images.length} pages completed in ${elapsed}s (parallel)`)

    // 全ページの取引を結合してページ順にソート
    const allTransactions: Transaction[] = []
    for (const r of results.sort((a, b) => a.pageIndex - b.pageIndex)) {
      allTransactions.push(...r.transactions)
    }

    console.log(`Total transactions: ${allTransactions.length}`)

    // 残高整合性チェック＆自動補正
    const { corrected, corrections } = verifyAndCorrectTransactions(allTransactions)

    if (corrections.length > 0) {
      console.log('=== 入出金自動補正 ===')
      corrections.forEach((c) => console.log(`  ${c}`))
    }

    // ページごとにグループ化
    const pageGroups: Record<number, Transaction[]> = {}
    for (let i = 0; i < images.length; i++) pageGroups[i] = []

    for (const tx of corrected) {
      const idx = tx.page ?? 0
      if (!pageGroups[idx]) pageGroups[idx] = []
      pageGroups[idx].push(tx)
    }

    const pages = Object.keys(pageGroups)
      .map(Number)
      .sort((a, b) => a - b)
      .map((idx) => ({ pageIndex: idx, transactions: pageGroups[idx] }))

    return NextResponse.json({
      pages,
      corrections: corrections.length > 0 ? corrections : undefined,
    })
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    console.error('Gemini OCR API error:', errMsg)
    return NextResponse.json({ error: `Gemini OCR エラー: ${errMsg}` }, { status: 500 })
  }
}
