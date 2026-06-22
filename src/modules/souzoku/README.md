# 相続管理モジュール（souzoku）— 総合アプリ統合キット

顧問先管理(komon)と同方式（**iframe 隔離**）で、相続管理アプリをホスト(AI-OCR)へ
1モジュールとして取り込むための一式です。**クライアント専用**で動作します
（API ルート/SSR/server actions 不使用、`'use client'`、`dynamic(ssr:false)` 前提）。

## 構成

```
src/modules/souzoku/
  SouzokuApp.tsx   … 画面トップ（default export, 'use client'）。合言葉ゲート＋ModuleSwitcher＋iframe＋ブリッジ起動
  bridge.ts        … ホストcore(getDb/modulePath)経由で rooms/{roomKey}/souzoku を読み書きする橋渡し
  embedded.ts      … 相続アプリ本体(単一HTML)を埋め込んだ文字列（自動生成・編集不可）
  README.md        … 本書
tools/
  build-souzoku-embedded.mjs … embedded.ts の生成スクリプト
```

`import` は `@/core/...` とモジュール内相対のみ。ホストの他モジュールには依存しません。

## ホスト側の結線（komon と同じ）

1. `src/app/souzoku/page.tsx`:
   ```tsx
   'use client';
   import dynamic from 'next/dynamic';
   const SouzokuApp = dynamic(() => import('@/modules/souzoku/SouzokuApp'), { ssr: false });
   export default function Page() { return <SouzokuApp />; }
   ```
2. `src/core/registry.ts` の souzoku を `status:'ready'`（`path:'/souzoku'`）へ。
3. `firebase/database` がホストに導入済みであること（bridge.ts が動的 import します）。

## 使用している共通コア API（前提どおり）

- `getDb()` … 匿名サインイン済み Realtime Database
- `modulePath('souzoku', ...segs)` … `rooms/{roomKey}/souzoku/...`
- `hasRoom()` / `setRoomPassphrase(p)` … 合言葉（共通キー `"suite-room-passphrase"`）
- `ModuleSwitcher`（ヘッダーに `<ModuleSwitcher currentKey="souzoku" />`）

## データ階層

- 保存先：**`rooms/{roomKey}/souzoku/`**（`roomKey = SHA-256(合言葉)`）。
- 直下に 2 キー：
  - `cases`  … `{ [caseId]: 案件オブジェクト }`
  - `tomb`   … `{ [caseId]: true }`（削除墓標。削除を全端末へ伝播し復活を防ぐ）
- RTDB 禁止文字（`. # $ / [ ] ~`）対策で、**全キーを `_`＋`~<hex>` でエンコード**して保存します
  （相続アプリ側 / bridge 側で完全一致。突合時も同じ規則でデコード）。
- 書き込みは**フィールド単位の差分 `update()`**（別々の項目の同時編集は両立、同一項目のみ後勝ち）。

## 旧データからの移行（自動 seed）

bridge.ts が起動時に、**このホスト名の `localStorage["souzoku_cloud_v1"]`** を読み、
`rooms/{roomKey}/souzoku` が**空のときだけ** seed します（直前に JSON バックアップを自動 DL）。

- 旧アプリ（`https://yukihiro-jpg.github.io/souzoku-kanri/`）と本ホスト
  （`https://yukihiro-jpg.github.io/AIOCR-shiwake/`）は**同一ホスト名 `yukihiro-jpg.github.io`** なので、
  **localStorage は共有**されます。→ 事務所等の端末で一度 `/souzoku` を開けば自動 seed で移行完了
  （komon と同条件）。
- 旧 `souzoku/{...}`（rooms の外）のデータは移行対象外です。必要なら、
  旧アプリの「JSON 出力」→ ホストの取り込み、もしくは旧トップ階層からの一括コピーで対応してください
  （ご要望あれば変換スクリプトを提供します）。

## embedded.ts の再生成

相続アプリ本体（index.html）を更新したら、再生成してください：

```
node tools/build-souzoku-embedded.mjs path/to/souzoku-kanri/index.html
```

- スクリプトは `<head>` 直後に `<script>window.__SOUZOKU_EMBED__=true;</script>` を注入します。
  このフラグにより、相続アプリ側の同期モジュールが **ホスト core 経由（postMessage ブリッジ）** で動作します
  （フラグなしの単体配信時は従来どおり firebaseConfig＋ルーム名で直接 Firebase へ接続）。

## 補足・注意

- iframe は自前コードのため `sandbox="allow-scripts allow-same-origin allow-downloads allow-modals allow-forms allow-popups"`
  としています（`localStorage`・JSON ダウンロード・確認ダイアログ・内部印刷 iframe のため）。
- Firebase ルールは変更不要（`rooms/$room` の 1 ブロックで保護）。旧トップ階層 `souzoku` のルールは
  移行完了後に削除予定。
- Google 連携はありません（匿名認証のみ）。
