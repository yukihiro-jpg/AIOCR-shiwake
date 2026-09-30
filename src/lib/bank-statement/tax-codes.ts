// 消費税コードマスタ（内税入力用のみ）

export interface TaxCodeItem {
  code: string
  name: string
  category: 'sales' | 'purchase'
}

// 売上関係（内税入力）
export const SALES_TAX_CODES: TaxCodeItem[] = [
  { code: '10', name: '課税売上', category: 'sales' },
  { code: '12', name: '課税売上控除', category: 'sales' },
  { code: '13', name: '課税貸倒償却', category: 'sales' },
  { code: '15', name: '課税貸倒回収', category: 'sales' },
  { code: '30', name: '非課税売上', category: 'sales' },
  { code: '34', name: '有価証券売上等（非課税）', category: 'sales' },
  { code: '40', name: '不課税売上（精算取引）', category: 'sales' },
  { code: '41', name: '不課税売上（免税期間）', category: 'sales' },
  { code: '60', name: '輸出売上', category: 'sales' },
  { code: '64', name: '非課税資産 輸出売上', category: 'sales' },
  { code: '80', name: '課税仕入対応特定収入', category: 'sales' },
  { code: '81', name: '共通仕入対応特定収入', category: 'sales' },
  { code: '84', name: '非課税仕入対応特定収入', category: 'sales' },
  { code: '89', name: '使途不特定の特定収入', category: 'sales' },
  { code: '99', name: '不明', category: 'sales' },
]

// 仕入関係（内税入力）
export const PURCHASE_TAX_CODES: TaxCodeItem[] = [
  { code: '10', name: '課税仕入', category: 'purchase' },
  { code: '11', name: '課税非課税共通売上対応課税仕入', category: 'purchase' },
  { code: '12', name: '課税仕入控除', category: 'purchase' },
  { code: '14', name: '非課税売上対応課税仕入', category: 'purchase' },
  { code: '15', name: '課税非課税共通売上対応課税仕入控除', category: 'purchase' },
  { code: '16', name: '非課税売上対応課税仕入控除', category: 'purchase' },
  { code: '30', name: '非課税仕入', category: 'purchase' },
  { code: '40', name: '不課税仕入（精算取引）', category: 'purchase' },
  { code: '41', name: '不課税仕入（免税期間）', category: 'purchase' },
  { code: '70', name: '輸入仕入', category: 'purchase' },
  { code: '71', name: '輸入共通仕入', category: 'purchase' },
  { code: '74', name: '非課税売上対応輸入仕入', category: 'purchase' },
  { code: '80', name: '課税売上対応特定課税仕入', category: 'purchase' },
  { code: '81', name: '共通売上対応特定課税仕入', category: 'purchase' },
  { code: '82', name: '課税売上対応特定課税仕入控除', category: 'purchase' },
  { code: '84', name: '非課税売上対応特定課税仕入', category: 'purchase' },
  { code: '85', name: '共通売上対応特定課税仕入控除', category: 'purchase' },
  { code: '86', name: '非課税売上対応特定課税仕入控除', category: 'purchase' },
  { code: '99', name: '不明', category: 'purchase' },
]

export const ALL_TAX_CODES = [...SALES_TAX_CODES, ...PURCHASE_TAX_CODES]

// BS/PL判定ヘルパー（全角半角混在に対応）
export function isPL(bsPl?: string): boolean {
  if (!bsPl) return false
  const normalized = bsPl.replace(/[Ａ-Ｚａ-ｚ]/g, (s) => String.fromCharCode(s.charCodeAt(0) - 0xFEE0)).toUpperCase()
  return normalized === 'PL' || normalized.includes('PL') || bsPl === 'ＰＬ'
}

export function isBS(bsPl?: string): boolean {
  if (!bsPl) return false
  const normalized = bsPl.replace(/[Ａ-Ｚａ-ｚ]/g, (s) => String.fromCharCode(s.charCodeAt(0) - 0xFEE0)).toUpperCase()
  return normalized === 'BS' || normalized.includes('BS') || bsPl === 'ＢＳ'
}

function isDebitNormal(normalBalance?: string): boolean {
  return normalBalance === '借方'
}

function isCreditNormal(normalBalance?: string): boolean {
  return normalBalance === '貸方'
}

/**
 * 仕訳の借方・貸方科目から売上/仕入を判定して適切な消費税コードを返す
 */
export function getTaxCodesForEntry(
  debitCode: string,
  creditCode: string,
  accountMaster: { code: string; bsPl?: string; normalBalance?: string }[],
): TaxCodeItem[] {
  const debitAcc = accountMaster.find((a) => a.code === debitCode)
  const creditAcc = accountMaster.find((a) => a.code === creditCode)

  // PL科目の正残区分で判定
  if (creditAcc && isPL(creditAcc.bsPl) && isCreditNormal(creditAcc.normalBalance)) {
    return SALES_TAX_CODES
  }
  if (debitAcc && isPL(debitAcc.bsPl) && isDebitNormal(debitAcc.normalBalance)) {
    return PURCHASE_TAX_CODES
  }

  // コード番号で簡易判定
  const debitNum = parseInt(debitCode)
  const creditNum = parseInt(creditCode)
  if (creditNum >= 400 && creditNum < 600) return SALES_TAX_CODES
  if (debitNum >= 500 && debitNum < 900) return PURCHASE_TAX_CODES

  return [...SALES_TAX_CODES, ...PURCHASE_TAX_CODES]
}

/**
 * 消費税コードを検索
 */
export function findTaxCode(code: string, category?: 'sales' | 'purchase'): TaxCodeItem | undefined {
  const list = category === 'sales' ? SALES_TAX_CODES
    : category === 'purchase' ? PURCHASE_TAX_CODES
    : ALL_TAX_CODES
  return list.find((t) => t.code === code)
}

/**
 * 科目名から消費税コードのデフォルト値を判定
 * パターン学習未済・科目別消費税マスタ未登録の場合に使用
 */
export function getDefaultTaxCodeByName(
  accountName: string,
  category: 'sales' | 'purchase' | null,
): { taxCode: string; taxName: string } | null {
  if (!accountName || !category) return null
  const name = accountName

  if (category === 'purchase') {
    // 経費仕入関係
    // 対象外(40)
    if (name.includes('減価償却') || name.includes('租税公課') ||
        name.includes('諸会費') || name.includes('給料') ||
        name.includes('役員報酬') || name.includes('賞与') ||
        name.includes('雑給') || name.includes('退職')) {
      return { taxCode: '40', taxName: '不課税仕入（精算取引）' }
    }
    // 非課税仕入(30)
    if (name.includes('保険料') || name.includes('支払保険') ||
        name.includes('法定福利')) {
      return { taxCode: '30', taxName: '非課税仕入' }
    }
    // それ以外は課税仕入(10)
    return { taxCode: '10', taxName: '課税仕入' }
  }

  if (category === 'sales') {
    // 売上関係
    // 非課税売上(30)
    if (name.includes('受取利息')) {
      return { taxCode: '30', taxName: '非課税売上' }
    }
    // 対象外(40)
    if (name.includes('受取配当') || name.includes('配当金')) {
      return { taxCode: '40', taxName: '不課税売上（精算取引）' }
    }
    // それ以外は課税売上(10)
    return { taxCode: '10', taxName: '課税売上' }
  }

  return null
}

/**
 * 税率の指定が必ず要る消費税コードか（課税・課税控除 10〜16、輸入仕入 70〜74）。
 * 非課税・不課税・輸出・特定収入など、税率を持たないコードには税率を補わない。
 */
export function taxCodeNeedsRate(code: string): boolean {
  return /^(1[0-6]|7[0-4])$/.test(String(code || ''))
}
