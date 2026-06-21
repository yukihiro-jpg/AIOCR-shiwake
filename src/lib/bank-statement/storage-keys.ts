// 顧問先別データの localStorage キー定義（旧 drive-sync から分離・中立化）。
// Firebase 同期 / バックアップ(ZIP) の両方がここを参照する。

export const STORAGE_KEY_MAP: Record<string, (cid: string) => string> = {
  'patterns': (cid) => `bs-patterns-${cid}`,
  'account-master': (cid) => `bs-accounts-${cid}`,
  'sub-account-master': (cid) => `bs-sub-accounts-${cid}`,
  'account-tax-master': (cid) => `bs-account-tax-${cid}`,
  'temp-entries': (cid) => `bs-temp-csv-${cid}`,
  'fixed-journals': (cid) => `bs-fixed-journals-${cid}`,
  'bank-templates': (cid) => `bs-bank-templates-${cid}`,
  'processing-status': (cid) => `bank-statement-client-${cid}-processing-status`,
  'payroll-settings': (cid) => `bs-payroll-settings-${cid}`,
  'questions': (cid) => `bs-questions-${cid}`,
}
export const STORAGE_KEYS = Object.keys(STORAGE_KEY_MAP)

// 顧問先一覧（グローバル）の localStorage キー
export const CLIENTS_LIST_KEY = 'bank-statement-clients'
