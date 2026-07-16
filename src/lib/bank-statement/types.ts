// 通帳の1取引
export interface BankTransaction {
  id: string
  pageIndex: number
  rowIndex: number
  date: string // YYYY-MM-DD
  description: string
  deposit: number | null
  withdrawal: number | null
  balance: number
  boundingBox?: { x: number; y: number; width: number; height: number }
  // 追加列（複合仕訳用: 家賃収入、預り敷金等の内訳列）
  extras?: { name: string; amount: number; direction: 'credit' | 'debit'; memo?: string }[]
  // 備考列（パターン適用後も摘要に連結）
  memoText?: string
}

// ページ情報
export interface StatementPage {
  pageIndex: number
  transactions: BankTransaction[]
  openingBalance: number
  closingBalance: number
  isBalanceValid: boolean
  balanceDifference: number
  imageDataUrl?: string
  pdfDataUrl?: string   // 元PDFのdata URL（iframe表示用、キャンバス描画失敗時のフォールバック）
  id?: string           // レシート・請求書等「1書類=1画像」ページの一意ID。仕訳行(sourcePageId)と紐付け、行削除時の画像削除に使う
}

// 仕訳行
export interface JournalEntry {
  id: string
  transactionId: string | null
  date: string // YYYYMMDD
  debitCode: string
  debitName: string
  debitSubCode: string
  debitSubName: string
  debitTaxType: string
  debitIndustry: string
  debitTaxInclude: string
  debitAmount: number
  debitTaxAmount: number
  debitTaxCode: string
  debitTaxRate: string
  debitBusinessType: string
  creditCode: string
  creditName: string
  creditSubCode: string
  creditSubName: string
  creditTaxType: string
  creditIndustry: string
  creditTaxInclude: string
  creditAmount: number
  creditTaxAmount: number
  creditTaxCode: string
  creditTaxRate: string
  creditBusinessType: string
  description: string
  originalDescription: string  // 通帳から読み取った元の摘要（パターン学習用）
  patternId?: string | null    // パターン学習から生成された場合のパターンID
  needsQuestion?: boolean       // 仮払金の質問リスト対象か（false=本物の仮払金で質問しない。未設定=質問する）
  isCompound: boolean
  parentId: string | null
  taxLocked?: boolean           // レシート等で読み取った消費税率を固定（科目別消費税マスタ・科目名デフォルトで上書きしない）
  sourcePageId?: string         // この仕訳の解析元ページ(StatementPage.id)。行クリックで左ペインに表示、行削除で画像も削除
}

// 科目マスタ
export interface AccountItem {
  code: string
  name: string         // 正式科目名
  shortName: string    // 簡略科目名
  association?: string  // 連想（カタカナ検索用）
  normalBalance?: string // 正残区分（借方/貸方）
  bsPl?: string         // BS/PL区分
}

// 科目別消費税登録マスタ
export interface AccountTaxItem {
  accountCode: string        // 科目コード
  accountName: string        // 科目名称
  categoryCode: string       // 科目区分（0対象外, 1売上, 2仕入）
  categoryName: string       // 科目名称（売上, 仕入, 対象外）
  purchaseTaxCode: string    // 仕入消費税コード
  purchaseTaxName: string    // 仕入消費税名称
  purchaseTaxRate?: string   // 仕入消費税率区分（'4'=10%, '5'=8%軽減, '3'=8% 等）
  salesTaxCode: string       // 売上消費税コード
  salesTaxName: string       // 売上消費税名称
  salesTaxRate?: string      // 売上消費税率区分
}

// 補助科目マスタ
export interface SubAccountItem {
  parentCode: string    // 科目コード
  parentName: string    // 科目簡略名称
  subCode: string       // 科目別補助コード
  name: string          // 正式科目名
  shortName: string     // 簡略科目名
  association?: string  // 連想
}

// 学習パターン（1行分の仕訳）
export interface PatternLine {
  debitCode: string
  debitName: string
  debitSubCode?: string
  debitSubName?: string
  creditCode: string
  creditName: string
  creditSubCode?: string
  creditSubName?: string
  taxCode: string
  taxCategory: string
  taxRate?: string           // 税率コード（'4'=10%, '5'=8%軽減, '3'=8%）
  businessType: string
  description: string        // 変換後の摘要
  amount: number             // 金額（複合仕訳の各行の金額を保持）
}

// 学習パターン
export interface PatternEntry {
  id: string
  keyword: string              // 通帳の元の摘要（マッチング用）
  matchType?: 'exact' | 'partial'  // 完全一致 or 部分一致（デフォルト: partial）
  matchText?: string               // 一致判定用テキスト（未設定時はkeywordを使用）
  replaceEntireDescription?: boolean  // true なら部分一致でも変換後摘要で摘要全体を置換
  amountMin: number | null
  amountMax: number | null
  accountCode?: string
  lines: PatternLine[]
  useCount: number
  // 旧互換フィールド
  convertedDescription?: string
  debitCode?: string
  debitName?: string
  creditCode?: string
  creditName?: string
  taxCode?: string
  taxCategory?: string
  businessType?: string
}

// パース結果のraw行データ（列マッピング用）
export interface RawTableRow {
  cells: string[]
  cellPositions?: number[] // 各セルの開始X座標（PDF空セルのずれ対策）
  rowIndex: number
  boundingBox?: { x: number; y: number; width: number; height: number }
}

// 列マッピング設定
export interface ColumnMapping {
  dateColumn: number
  // 年・月・日が別セルの場合の列指定（設定時は dateColumn より優先。年は西暦/和暦どちらも可）
  yearColumn?: number
  monthColumn?: number
  dayColumn?: number
  descriptionColumn: number
  descriptionColumns?: number[]   // 摘要が複数列の場合（結合して摘要にする）
  depositColumn: number
  withdrawalColumn: number
  balanceColumn: number
  transactionTypeColumn?: number
  signedAmountColumn?: number
  directionColumn?: number
  extraColumns?: { col: number; name: string; direction: 'credit' | 'debit' }[]
  memoColumn?: number
  columnXPositions?: number[]
}

// パース結果
export interface ParseResult {
  pages: StatementPage[]
  rawPages?: RawTableRow[][] // 列マッピング用
  pageImageUrls?: string[] // OCR失敗時でもPDF画像を保持
  pdfFile?: File // ページ遷移時のオンデマンド画像生成用
  sourceType: 'pdf-text' | 'pdf-ocr' | 'excel'
  needsColumnMapping: boolean
  ocrFailed?: boolean // OCRでテキスト抽出できなかった場合
  ocrErrorMessage?: string // OCRエラーの詳細メッセージ
  corrections?: string[] // 入出金自動補正のログ
}

// 書類種別
export type DocumentType = 'bank-statement' | 'sales-invoice' | 'purchase-invoice' | 'cash-book' | 'receipt' | 'credit-card' | 'payroll' | 'yucho'

// アップロード設定
export interface UploadConfig {
  documentType: DocumentType
  accountCode: string
  accountName: string
  accountSubCode?: string
  accountSubName?: string
  // 請求書用: 借方・貸方の科目コード
  debitCode?: string
  debitName?: string
  debitSubCode?: string
  debitSubName?: string
  creditCode?: string
  creditName?: string
  creditSubCode?: string
  creditSubName?: string
  file: File
  extraImages?: File[] // レシート等で複数の画像ファイルをまとめて1ジョブとして並列解析する場合の追加画像
  periodFrom?: string  // 処理対象期間（開始）YYYY-MM-DD
  periodTo?: string    // 処理対象期間（終了）YYYY-MM-DD
}

// 請求書の解析結果
export interface InvoiceData {
  invoiceIndex: number      // PDF内の請求書番号（0始まり）
  counterpartName: string   // 相手先名称（売上）/ 請求元名称（仕入）
  invoiceNumber?: string    // インボイス番号（仕入のみ）
  invoiceDate: string       // 請求日 YYYY-MM-DD
  mainContent: string       // 主な請求内容
  taxLines: {
    taxRate: string         // "10%" | "8%" | "非課税" 等
    netAmount: number       // 本体価格
    taxAmount: number       // 消費税額
    totalAmount: number     // 税込金額
  }[]
  totalAmount?: number      // 請求金額/振込金額（taxLines が空の場合のフォールバック）
  pageStart: number         // 開始ページ
  pageEnd: number           // 終了ページ
}

// クレジットカード明細
export interface CreditCardData {
  paymentDate: string          // 引落日 YYYY-MM-DD
  totalAmount: number          // 引落総額
  cardName?: string            // カード名称
  transactions: CreditCardTransaction[]
}

export interface CreditCardTransaction {
  usageDate: string            // 利用日 YYYY-MM-DD
  storeName: string            // 利用店名
  amount: number               // 利用金額
  memo?: string                // 備考
}

// 賃金台帳
export interface PayrollEmployee {
  no: number
  name: string
  isExecutive: boolean
  items: { name: string; amount: number }[]
  totalPay: number
  totalDeductions: number
  netPay: number
}

export interface PayrollData {
  period: string
  paymentDate: string
  companyName: string
  employeeCount: number
  employees: PayrollEmployee[]
  payHeaders: string[]
  deductHeaders: string[]
  isBonus?: boolean // 賞与データ（摘要を「賞与」にする）
}

// 賃金台帳（年間・従業員別シート・月列形式）— 人別×月別に複合仕訳を作る
export interface PayrollLedgerMonth {
  month: number          // 1〜12
  gross: number          // 総支給額
  socialInsurance: number // 社会保険料合計（従業員負担分）
  incomeTax: number      // 源泉所得税
  residentTax: number    // 住民税
  netPay: number         // 差引支給額
}
export interface PayrollLedgerEmployee {
  name: string
  isExecutive: boolean
  months: PayrollLedgerMonth[]
}
export interface PayrollLedger {
  kind: 'ledger'
  year: number
  companyName: string
  employees: PayrollLedgerEmployee[]
}
