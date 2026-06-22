# 顧問先管理モジュール（src/modules/komon）

総合アプリ（ホスト＝AI-OCR/仕訳作成）へ「丸ごと1モジュール」として載せるための自己完結フォルダです（ステージA）。

## 構成

| ファイル | 役割 |
|---|---|
| `KomonApp.tsx` | 画面トップ（**default export**）。`'use client'`、完全クライアント専用。iframe で隔離描画し、ホスト共通コアを iframe へ橋渡しする。 |
| `embedded.ts` | 既存の単一HTMLアプリを変換した `KOMON_HTML` 文字列（iframe の `srcDoc`）。**自動生成物・直接編集禁止**。 |
| `../../tools/build-komon-module.mjs` | 生成器（リポジトリ直下 `index.html` から `embedded.ts` を作る）。再生成は `node tools/build-komon-module.mjs`。 |

## 設計方針（指示書準拠）

- **完全クライアント専用**：APIルート/SSR/server actions/next/headers は不使用。`dynamic(() => import('@/modules/komon/KomonApp'), { ssr:false })` での描画前提。
- **iframe(srcDoc) で隔離**：既存アプリは独自CSS（`body{...}` 等）と多数のグローバル関数・inline `onclick` を持つため、iframe で完全隔離し、ホストのスタイル/グローバルと衝突させない。CDN（SheetJS / html2canvas / jsPDF）も iframe 内で読み込む。
- **Firebase初期化・匿名認証・合言葉処理は自前で持たない**。`KomonApp.tsx` が `@/core` から取得し、`iframe.contentWindow.__komonCore` 経由で iframe 内アプリへ渡す：
  - `getDb`, `modulePath`, `roomKey`, `hasRoom`, `getRoomPassphrase`, `setRoomPassphrase`
  - `dbfns`（`firebase/database` の `ref/onValue/get/set/update/remove`）
- **読み書きは必ず `modulePath()` 経由**：
  - 顧問先情報 → `rooms/{roomKey}/komon/<key>`
  - 進捗管理＋議事録 → `rooms/{roomKey}/shinchoku/<key>`
- **import は `@/core/...` とモジュール内相対のみ**（`KomonApp.tsx`）。

## データ階層（最終形・ステージAから採用）

顧問先情報と進捗/議事録を**最初から別サブツリー**に分けて保存します（→ ステージBは「画面を2枚に分けるだけ・データ移行不要」）。

```
rooms/{roomKey}/komon/
    clients              顧問先一覧（配列）
    clientTombstones     削除済み顧問先ID（墓標）

rooms/{roomKey}/shinchoku/
    filings filingSteps interimDone interimCells interimSteps
    gensenSteps monthly monthlyTargets modules gensen
    gensenMonthly gensenSpecial nencho sonotaTables docTables
    docTemplate clientSummaries minutes
```

各トップレベルキーの**子キーは RTDB の禁止文字（`. # $ / [ ] ~`）対策のためエンコード**（先頭 `_` ＋ 禁止文字を `~<hex>` に置換）して保存します。読み出し時はデコードします。突合スクリプト等で生データを読む場合は同じ規則でデコードしてください。

## 同期の挙動

- 書き込み：アプリ内 `persist()` → `KomonStore.push()`（200msデバウンス）→ キーごとにフィールド単位の差分 `update()`（配列・プリミティブは `set()`）。別々のセル/項目の同時編集は消えません。
- 読み込み：キーごとに `onValue` 購読。入力中は `blur` まで再描画を遅延。
- 接続時マージ：顧問先はID単位で和集合し、削除は墓標で全端末へ伝播（消した顧問先が他端末で復活しない）。
- **初回移行のバックアップ**：新パスが空のとき、ローカル(localStorage)の既存データを seed します。その**直前にJSONバックアップを自動ダウンロード**（`komon_suite_migrated` フラグで1回のみ）。

## ホスト側の結線（参考）

```ts
// src/app/komon/page.tsx
import dynamic from 'next/dynamic';
const KomonApp = dynamic(() => import('@/modules/komon/KomonApp'), { ssr: false });
export default function Page() { return <KomonApp />; }
```
- `src/core/registry.ts` の `komon` を `status:'ready'`（`path:'/komon'`）に。
- ヘッダーの `ModuleSwitcher` はモジュール側でも表示済み（`currentKey="komon"`）。重複する場合はどちらかに統一してください。

## 既存データの移行について

旧アプリは各端末の localStorage（キー `komonManagerData_v3`）に全データを保持しています。本モジュールは起動時にそれを読み込み、新パス（`rooms/{roomKey}/...`）が空なら seed します。各端末がフル0データを持つため、**端末で一度ホスト経由で開けば移行が完了**します（旧Firebaseルーム `rooms/<合言葉そのまま>` からの直接移行は不要）。移行前のバックアップは自動取得されます。

## 注意

- 合言葉→roomKey は core の `roomKey()`（SHA-256）に一本化。合言葉は共通キー `"suite-room-passphrase"`。
- 多重 `initializeApp` を避けるため、Firebaseは必ず `getDb()` 経由（core が getApps で1回に統一済み）。
- 静的書き出しのためサーバー機能は不使用。
