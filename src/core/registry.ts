// 総合アプリのモジュール定義（ランチャー・切替メニューの元）。
// 新しいアプリ(機能)を足すときは、この配列に1行追加するだけ。
//   ・key   … データのサブツリー名（rooms/{roomKey}/{key}/…）に使う
//   ・path  … ルーティング先
//   ・status… 'ready'=利用可 / 'soon'=準備中（ランチャーでグレー表示）

export type ModuleStatus = 'ready' | 'soon'

export interface ModuleDef {
  key: string
  label: string
  desc: string
  path: string
  icon: string
  status: ModuleStatus
}

export const MODULES: ModuleDef[] = [
  {
    key: 'komon',
    label: '顧問先情報登録',
    desc: '顧問先の基本情報を登録・管理',
    path: '/komon',
    icon: '👥',
    status: 'ready',
  },
  {
    key: 'shinchoku',
    label: '進捗管理（議事録含む）',
    desc: '進捗状況と議事録を管理',
    path: '/shinchoku',
    icon: '📊',
    status: 'ready',
  },
  {
    key: 'aiocr-shiwake',
    label: '仕訳作成',
    desc: 'AI-OCRで通帳・領収書等から仕訳CSVを作成',
    // 当面は既存ルートをそのまま使う（後のステップで /aiocr へ移設予定）
    path: '/bank-statement',
    icon: '📒',
    status: 'ready',
  },
  {
    key: 'souzoku',
    label: '相続管理',
    desc: '相続案件を管理',
    path: '/souzoku',
    icon: '🏛️',
    status: 'ready',
  },
]
