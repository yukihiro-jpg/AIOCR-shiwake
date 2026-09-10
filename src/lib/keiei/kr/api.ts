// 移植した月次レポート・ビューアのための「差し替え用データ層」。
//
// 顧問先用アプリ（komon-app）の src/apps/keiei-report/api.ts と **同じ形の窓口**
// （getState() と api.*）を用意し、中身だけをこの総合管理アプリのデータに差し替える。
// こうすると、移植した画面のコードを書き換えずにそのまま動かせる。
//
// 保存先の違い:
//   移植元 … Firestore の tenants/{tenantId}/apps/keiei-report/state/current に1ドキュメント
//   ここ  … 既存の月次レポートの保存先（顧問先ごとの years と settings）にそのまま相乗りする。
//           新しい保存ノードもキーも作らない（消し忘れ・同期漏れを増やさないため）。
//
// ビューア独自の設定（実効税率・均等割・変動費固定費の上書き・所見メモ・従業員数・
// AI質問ログ）は、既存の KeieiSettings に追加フィールドとして持たせる。

import type { State, CostClass, QaEntry } from './types'
import { emptyState } from './types'
import type { ParsedImport } from './import-json'
import { mergeYears } from './import-json'
import { toKrState, toAppYear, type KrExtraSettings } from './state'
import type { FiscalYearData as AppYear } from '../types'
import type { KeieiSettings } from '../analysis'
import { defaultSettings } from '../analysis'
import { loadYears, saveYears, loadSettings, saveSettings } from '../store'

/** ビューア用の設定を足した KeieiSettings */
export type KrSettings = KeieiSettings & KrExtraSettings & { qaLog?: QaEntry[] }

let state: State = emptyState()
let clientId = ''
let appYears: Record<string, AppYear> = {}
let appSettings: KrSettings = defaultSettings()
let monthIdx: number | undefined
let onChange: (() => void) | null = null

/** 画面の再描画を促すコールバック（KrShell が登録する） */
export function setKrChangeHandler(fn: (() => void) | null): void {
  onChange = fn
}

function rebuild(): void {
  state = toKrState(appYears, {
    monthIdx,
    client: state.client,
    settings: appSettings,
  })
  state.settings.qaLog = appSettings.qaLog || []
  onChange?.()
}

/**
 * 顧問先を切り替える／報告月を変えるときに呼ぶ。
 * 既存の月次レポートが読み込んだデータをそのまま受け取る形にして、
 * 同じデータを2回読みに行かないようにしている。
 */
export function setKrContext(o: {
  clientId: string
  years: Record<string, AppYear>
  settings: KeieiSettings
  monthIdx?: number
  client?: { code: string; name: string } | null
}): void {
  clientId = o.clientId
  appYears = o.years
  appSettings = o.settings as KrSettings
  monthIdx = o.monthIdx
  state.client = o.client ?? null
  rebuild()
}

/** 画面から参照する現在の State（読み取り専用として扱うこと） */
export function getState(): State {
  return state
}

/** 取込済みの期があるか（画面の「まだデータがありません」表示の判定用） */
export function hasKrData(): boolean {
  return state.years.length > 0
}

async function persistSettings(): Promise<void> {
  if (!clientId) return
  try {
    await saveSettings(clientId, appSettings)
  } catch (e) {
    console.warn('[kr/api] 設定の保存に失敗しました', e)
  }
}

async function persistYears(): Promise<void> {
  if (!clientId) return
  try {
    await saveYears(clientId, appYears)
  } catch (e) {
    console.warn('[kr/api] 月次データの保存に失敗しました', e)
    throw e
  }
}

export const api = {
  /** JSON取込を反映する（同じ期は置き換え・無い期は残す） */
  async importData(p: ParsedImport): Promise<void> {
    state.client = p.client
    state.generatedAt = p.generatedAt
    const merged = mergeYears(state.years, p.years)
    const now = Date.now()
    const next: Record<string, AppYear> = { ...appYears }
    for (const y of merged) next[y.id] = toAppYear(y, appYears[y.id]?.uploadedAt ?? now)
    appYears = next
    await persistYears()
    rebuild()
  },
  /** 実効税率（%） */
  setTaxRate(v: number): void {
    appSettings.taxRate = Math.min(60, Math.max(0, v))
    void persistSettings()
    rebuild()
  },
  /** 法人住民税の均等割（円/年） */
  setEqualization(v: number): void {
    appSettings.equalization = Math.max(0, Math.round(v))
    void persistSettings()
    rebuild()
  },
  /** 科目の変動費/固定費を上書きする（null で自動判定に戻す） */
  setCostClass(code: string, cls: CostClass | null): void {
    const m = { ...(appSettings.costClass || {}) }
    if (cls === null) delete m[code]
    else m[code] = cls
    appSettings.costClass = m
    void persistSettings()
    rebuild()
  },
  /** 年度の従業員数（0以下・未入力は「未設定」に戻す） */
  setEmployees(yearId: string, n: number): void {
    const m = { ...(appSettings.employees || {}) }
    if (!Number.isFinite(n) || n <= 0) delete m[yearId]
    else m[yearId] = Math.round(n)
    appSettings.employees = m
    void persistSettings()
    rebuild()
  },
  /** 所見メモ（キーは 年度id または `${年度id}:${月index}`） */
  setNote(key: string, text: string): void {
    const m = { ...(appSettings.notes || {}) }
    if (text) m[key] = text
    else delete m[key]
    appSettings.notes = m
    void persistSettings()
    rebuild()
  },
  /** AI質問の記録を1件足す（新しい順・直近200件） */
  addQaLog(entry: Omit<QaEntry, 'id' | 'at' | 'starred'>): void {
    const e: QaEntry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      at: new Date().toISOString(),
      starred: false,
      ...entry,
    }
    appSettings.qaLog = [e, ...(appSettings.qaLog || [])].slice(0, 200)
    void persistSettings()
    rebuild()
  },
  /** 質問ログの★（面談で触れる印） */
  toggleQaStar(id: string): void {
    appSettings.qaLog = (appSettings.qaLog || []).map((e) => (e.id === id ? { ...e, starred: !e.starred } : e))
    void persistSettings()
    rebuild()
  },
  /** 質問ログを全部消す */
  clearQaLog(): void {
    appSettings.qaLog = []
    void persistSettings()
    rebuild()
  },
  /** この顧問先の月次データと設定をすべて消す */
  async clearAll(): Promise<void> {
    appYears = {}
    appSettings = { ...defaultSettings() }
    await persistYears()
    await persistSettings()
    state.client = null
    state.generatedAt = ''
    rebuild()
  },
  /** 顧問先IDを画面へ渡す（元帳の取込・取引先の整理で使う） */
  clientId(): string {
    return clientId
  },
}

/** 顧問先の月次データと設定を読み直す（顧問先の切替時に使う） */
export async function reloadKr(cid: string): Promise<{ years: Record<string, AppYear>; settings: KeieiSettings }> {
  const [years, settings] = await Promise.all([loadYears(cid), loadSettings(cid)])
  return { years, settings }
}
