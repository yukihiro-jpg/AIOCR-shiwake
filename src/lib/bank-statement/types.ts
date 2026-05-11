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
  isCompound: boolean
  parentId: string | null
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
  salesTaxCode: string       // 売上消費税コード
  salesTaxName: string       // 売上消費税名称
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
  businessType: string
  description: string        // 変換後の摘要
  amount: number             // 金額（複合仕訳の各行の金額を保持）
}

// 学習パターン
export interface PatternEntry {
  id: string                   // 一意ID
  keyword: string              // 通帳の元の摘要（マッチング用）
  amountMin: number | null     // 金額下限（null=制限なし）
  amountMax: number | null     // 金額上限（null=制限なし）
  accountCode?: string         // 処理科目コード（口座別パターン分離用）
  lines: PatternLine[]         // 仕訳行（1行 or 複合仕訳で複数行）
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
  descriptionColumn: number
  depositColumn: number
  withdrawalColumn: number
  balanceColumn: number
  transactionTypeColumn?: number // 取引区分列（摘要と別列で存在する場合）
  signedAmountColumn?: number    // 入出金を1列で表す場合(正=入金,負=出金)
  directionColumn?: number       // 受払区分列（受入/払出で入出金を判別）
  extraColumns?: { col: number; name: string; direction: 'credit' | 'debit' }[]
  memoColumn?: number            // 備考列（摘要に連結）
  columnXPositions?: number[]    // 各列ヘッダの中心X座標（PDF空セル対策）
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
}
