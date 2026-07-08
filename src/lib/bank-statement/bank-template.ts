import { getSelectedClientId } from './client-store'

export interface BankTemplate {
  bankName: string         // 銀行名（口座名）
  columnOrder: string      // 列順序の説明
  dateFormat: string       // 日付形式
  lastUpdated: string
}

function getKey(): string {
  const cid = getSelectedClientId()
  return cid ? `bs-bank-templates-${cid}` : 'bs-bank-templates'
}

export function getBankTemplates(): Record<string, BankTemplate> {
  if (typeof window === 'undefined') return {}
  try {
    const stored = localStorage.getItem(getKey())
    if (stored) return JSON.parse(stored)
  } catch { /* ignore */ }
  return {}
}

export function saveBankTemplate(accountCode: string, template: BankTemplate): void {
  if (typeof window === 'undefined') return
  const templates = getBankTemplates()
  templates[accountCode] = { ...template, lastUpdated: new Date().toISOString() }
  localStorage.setItem(getKey(), JSON.stringify(templates))
  const cid = getSelectedClientId()
  if (cid) {
    import('./firebase-sync')
      .then(({ schedulePushToFirebase }) => schedulePushToFirebase(cid, 'bank-templates', templates))
      .catch(() => { /* firebase 未設定なら無視 */ })
  }
}

export function getBankTemplate(accountCode: string): BankTemplate | null {
  const templates = getBankTemplates()
  return templates[accountCode] || null
}

/**
 * 解析結果から通帳テンプレートを自動生成
 */
export function learnBankTemplate(
  accountCode: string,
  accountName: string,
  transactions: { date: string; description: string; deposit: number | null; withdrawal: number | null; balance: number }[],
): void {
  if (transactions.length < 2) return

  // 日付形式を推定
  const dates = transactions.map((t) => t.date).filter(Boolean)
  let dateFormat = 'YYYY-MM-DD'
  if (dates.length > 0) {
    const sample = dates[0]
    if (sample.match(/^\d{4}-\d{2}-\d{2}$/)) dateFormat = 'YYYY-MM-DD'
    else if (sample.match(/^\d{8}$/)) dateFormat = 'YYYYMMDD'
  }

  // 列順序を推定（入金と出金の配置パターン）
  let columnOrder = '日付, 摘要, 出金, 入金, 残高'
  const hasDeposit = transactions.some((t) => t.deposit && t.deposit > 0)
  const hasWithdrawal = transactions.some((t) => t.withdrawal && t.withdrawal > 0)
  if (hasDeposit && hasWithdrawal) {
    columnOrder = '日付, 摘要, お支払金額(出金), お預り金額(入金), 差引残高'
  }

  saveBankTemplate(accountCode, {
    bankName: accountName,
    columnOrder,
    dateFormat,
    lastUpdated: new Date().toISOString(),
  })
}

/**
 * テンプレート情報をGeminiプロンプトに追加するテキストを生成
 */
export function getTemplatePromptAddition(accountCode: string): string {
  const template = getBankTemplate(accountCode)
  if (!template) return ''

  return `
【この通帳のレイアウト情報（過去の解析実績から判明）】
- 銀行/口座名: ${template.bankName}
- 列の順序: ${template.columnOrder}
- 日付形式: ${template.dateFormat}
この情報に基づいて正確に読み取ってください。`
}
