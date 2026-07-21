# 業務総合アプリ（税理士事務所向けスイート）

税理士事務所の業務を1つのURLにまとめた総合管理アプリ。Next.js 14 の静的書き出し（`output:'export'`）を GitHub Pages で配信し、Firebase Realtime Database（RTDB）で全端末リアルタイム同期する。

このファイルは、新セッションが起動時に文脈を引き継ぐためのものです。**最初に必ず読んでください。**

## クイックスタート（新セッション向け）

1. このファイルを読む
2. `docs/session-history/` に過去の会話履歴（JSONL）あり。必要に応じて参照
3. ユーザーから依頼された作業に着手

## モジュール構成

| モジュール | ルート | 実体 | 編集対象 |
|---|---|---|---|
| ホーム（ランチャー＋共通設定） | `/` | React | `src/components/Launcher.tsx` |
| 顧問先情報登録 | `/komon` | 単一HTML（iframe埋め込み） | `app-sources/komon/index.html` |
| 進捗管理（議事録・決算メモ含む） | `/shinchoku` | komonと同一HTML（ビュー切替） | 同上 |
| 仕訳作成（AI-OCR→会計大将CSV） | `/bank-statement` | React | `src/components/bank-statement/` `src/lib/bank-statement/` |
| 相続管理 | `/souzoku` | 単一HTML（iframe埋め込み） | `app-sources/souzoku/index.html` |
| 年調データ受信（事務所側） | `/nenmatsu` | React | `src/components/nenmatsu/` `src/lib/nenmatsu/` |
| 年調アップロード（従業員向け公開ページ） | `/nenmatsu-upload` | React | `src/components/nenmatsu/NenmatsuUpload.tsx` |
| 月次レポート | `/keiei` | React | `src/components/keiei/` `src/lib/keiei/` |
| 税務チェック（①申告書PDFの書類間金額突合 ②総勘定元帳CSVの会計監査・API不使用） | `/shinkoku-check` | React | `src/components/shinkoku-check/` `src/lib/shinkoku-check/`（監査ロジックは `src/lib/keiei/audit.ts` を共用） |

## ビルド・デプロイ手順（重要）

### komon / souzoku（単一HTMLモジュール）を編集したとき
1. `app-sources/{komon|souzoku}/index.html` を編集
2. 変換ツールで埋め込みモジュールを再生成（**忘れると反映されない**）
   - komon: `node tools/build-komon-module.mjs` → `src/modules/komon/embedded.ts`
   - souzoku: `node tools/build-souzoku-embedded.mjs` → `src/modules/souzoku/embedded.ts`
3. `npm run build` で静的ビルド確認
4. **index.html と embedded.ts の両方をコミット**

⚠️ `tools/build-komon-module.mjs` は index.html 内の特定コード片をアンカーに置換する。アンカー行（例: saveSettings の末尾）を書き換えるとビルドが失敗するので、変更した場合はツール側のアンカーも合わせて更新すること。

### JSの構文チェック（単一HTMLモジュール）
最大の `<script>` ブロックを抽出して `node --check`。

### React（仕訳作成・年調・月次レポート）
`npx tsc --noEmit` → `npm run build`

### デプロイ
`claude/festive-einstein-08owfb` ブランチで開発しコミット → `git push -u origin claude/festive-einstein-08owfb` → mainへff-onlyマージしpush（ユーザー承認済みの公開手順）→ GitHub Actions が Pages へ自動デプロイ（数分）。

## 開発チェックリスト（不変条件・再発防止）

`npm run build` の先頭で `tools/check-invariants.mjs` が自動実行され、以下の違反はビルドが失敗する。
新機能を足すときは該当する登録表への追記まで含めて1つの変更とすること。

1. **新しい per-client Firebaseノード**（`modulePath('X', clientId, …)`）を追加したら：
   - `tools/check-invariants.mjs` の `REGISTRY` に追加し、削除経路を決める
   - RTDBのみ → komon `purgeClientExternal` に直削除を追加（`komon-direct`）
   - **Storage実体（画像・ファイル）を持つ** → RTDB直削除は禁止。`X/_purgeQueue` へ登録し、
     Storage SDKを持つ事務所画面の `processXxxPurgeQueue()` が Storage→RTDB の順に実削除する
     （scan / nenmatsu が実装例。komonはiframe内でStorageを消せないため）
2. **仕訳作成の per-client localStorageキー**を追加したら：`STORAGE_KEY_MAP`（同期・バックアップ対象）
   か、意図的ローカルなら check-invariants の `ALLOW_LOCAL` に理由コメント付きで追加
3. **komonの新タブ**は `nav.tabs` ＋ `<section id="page-*">` ＋ `KOMON_ONLY`（顧問先情報ビューに出すか）を3点セットで
4. **Gemini呼び出し**は必ずタイムアウト付き（bank-statementは `gm()` 経由、その他は
   `getGenerativeModel(params, { timeout: 120000 })`）。**AIの応答が空でもユーザーの入力文を消さない**
5. **公開トークン配下のデータ**には保存期限（sweep）と削除経路（purgeキュー）を必ず両方用意する
6. Firebaseコンソールのルールは `docs/firebase-rules-recommended.md` と一致させる（変更時に見比べる）
7. 確認・依頼メモ（kakunin）の更新は `runTransaction` の配列変換のみ（丸ごと `set` 禁止・同時編集で消える）

### 設計メモ（意図した仕様）
- モジュール「利用→未利用」の切替では公開URL・データは削除しない（誤操作でのデータ消失防止）。
  失効させたいときは顧問先削除（purgeキューが実体まで削除）を使う。
- 年調は1社1URL（トークン）方式。同じ会社の従業員同士は提出物が相互に見える設計上のトレードオフがある
  （本人確認は生年月日ハッシュ。ハッシュ未登録者は提出ブロック）。

## データ同期の設計（最重要）

- **合言葉（パスフレーズ）**が唯一の共有キー。`localStorage['suite-room-passphrase']` に端末ごとに保存し、`roomKey = SHA-256(合言葉)` を RTDB パス `rooms/{roomKey}/{module}/...` に用いる（`src/core/room.ts`）。
- firebaseConfig はコードに内蔵（公開前提・by design）。データ保護は roomKey の推測不可能性に依存。
- **【厳守】roomKey・合言葉を外部に渡るURL・コード・コミットに含めない。** 年調の従業員向けURLは会社ごとのランダムトークン（`nenmatsu-public/{token}`）のみを使う。
- komon/shinchoku の同期対象キーは `tools/build-komon-module.mjs` の `KOMON_KEYS`/`SHINCHOKU_KEYS`。**komonに新しい業務データ（data.xxx）を追加したら、この配列にも必ず追加する**（過去に決算メモ kessanMemos の追加漏れで端末間非同期の不具合が発生）。
- souzoku は案件全体（cases/tomb）を同期するので、currentCase 配下に追加したフィールドは自動的に同期される。
- 仕訳作成の顧問先別データは `src/lib/bank-statement/storage-keys.ts` の `STORAGE_KEY_MAP` が同期対象。**新しい localStorage キーを追加したらここにも追加する。**
- 設定系（APIキー・表示設定・選択中顧問先など）は端末ローカルが正しい（同期しない）。
- インボイス登録番号簿（仕訳作成）はIndexedDBに端末ローカル保存（公表データの取込想定のため同期しない・各PCで取込）。

## 画像の保存期間（自動削除）と Google ドライブ連携

- 書類スキャン受信の画像・現金登録：**送信から1年**で自動削除（`SCAN_RETENTION_DAYS`）
- 年調の提出画像：**提出から1年6か月**で自動削除（`NENMATSU_RETENTION_DAYS`）
- 削除は事務所側の各画面を開いたときに実行（サーバレス）。長期保管が必要なものは削除前に
  ZIP一括DL または「📁 Driveへ保存」（Google共有ドライブへ一括アップロード）で退避する運用。
- Drive連携は GIS(OAuth) のブラウザ直叩き（`src/lib/google-drive.ts`＋`src/core/ui/DriveSaveDialog.tsx`）。
  クライアントIDは共通設定の `localStorage['suite-google-client-id']`（端末ローカル・同期しない）。

## APIキーの扱い

- **Gemini共通キー**：ホーム画面の共通設定で登録（`localStorage['suite-gemini-api-key']`）。仕訳作成・komon/shinchoku・souzoku のAIはこれを共通で使う。
- 各モジュール個別のキー（仕訳作成 `bs-gemini-api-key`、komon設定の geminiApiKey/claudeApiKey）が入っていれば**個別キーが優先**（無料/有料キーの使い分け用）。
- Gemini呼び出しはキーを**URLに載せず `x-goog-api-key` ヘッダで渡す**（履歴・ログへの残留防止）。

## 重要な仕様・設計判断（ユーザーとの合意済み事項）

### セキュリティ（厳守）
- 合言葉はコード・コミットに書かない
- モデル識別子（claude-*）をコミット・PR・コード・コメントに書かない（チャット返信のみ可）
- コミットメッセージ末尾: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` と `Claude-Session: https://claude.ai/code/session_01CAbLkFW9izq57S4R83LcVQ`
- push先は `claude/festive-einstein-08owfb`（main公開マージはユーザー承認済み）

### 仕訳作成
- **消費税率のマスタ自動上書きはしない**（空欄のときだけ補完）。税率コード: `4`=10%, `5`=8%軽減, `3`=8%
- 通帳画像PDFの仕訳クリック→左画像の参照箇所ハイライト（refRegion）: Geminiの座標をそのまま使わない。
  ローカルで行バンド検出（canvas投影プロファイル）→ Gemini locate（OCR本体と分離・位置特定のみ）→
  系統ずれグリッドサーチ＋順序保存DPで行バンドへスナップ（`region-locator.ts`）。失敗時はハイライト無しに退化
- 補助科目CDは `_debitSubFull`/`_creditSubFull` で code|name を1回のsetStateで更新（連続onChangeはrefで上書きされるバグの修正済み）
- レシートExcel/CSV列マッピング経由は常にインボイス登録事業者扱い、対象外は税CD/税率/税区分空欄
- パターン学習: キーワード＋金額範囲＋科目コード。複合仕訳（諸口997）対応
- 金額入力は「編集中は生文字列、blurで整形」方式（1文字ごとのtoLocaleString整形はカーソル飛び・桁重複の原因になるため禁止）

### 相続管理
- 生前贈与加算は calcTax で反映済み（暦年3年/延長7年100万控除・精算課税110万控除）
- 報告書には解説キャプション（.caption）とストーリー解説文（.story、テンプレ＋AI仕上げ）
- 「税理士にご相談ください」系の文言は入れない（ユーザー自身が税理士）
- AI通帳分析（passbook）: 通帳明細をAIで分析し要確認取引・推定財産を財産一覧・異動一覧表へ反映

### 顧問先情報・進捗管理
- 相続税申告スポット顧問先: `souzokuSpot` フラグ。死亡日⇄相続管理と双方向連動、申告期限=死亡日+10か月
- 決算メモ（kessanMemos）: 年度__顧問先ID キー。未回答分はダッシュボード要確認リストに表示

## 環境

- Next.js 14 / TypeScript / Tailwind（静的書き出し）
- Gemini API / Anthropic API（ブラウザ直叩き・キーは端末localStorage）
- xlsx（Excel解析）、pdfjs-dist（PDFテキスト抽出）、ExcelJS（診断書Excel出力）
- Firebase RTDB＋匿名認証＋Storage（年調画像）

### 開発起動
```
npm install
npm run dev
```
→ http://localhost:3000/

### エンドユーザー
GitHub Pages のURL（`https://yukihiro-jpg.github.io/AIOCR-shiwake/`）をブラウザで開くだけ。旧batファイル・standalone版は廃止済み。

## 移行履歴

- 元は `yukihiro-jpg/test-project` の会計OCRアプリを分離したもの
- bat起動（ローカルnpm run dev）→ GitHub Pages 配信へ移行済み（bat・standaloneは削除）
- souzoku の Google Drive 保存・移行機能は廃止（Firebase同期に一本化）
- 過去のセッション履歴は `docs/session-history/` のJSONL
