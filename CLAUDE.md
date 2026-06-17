# 会計大将インポートデータ変換アプリ

AI-OCR（Gemini API）で通帳・レシート・請求書・クレジットカード明細・現金出納帳等を解析し、会計大将向け仕訳CSVを生成する Next.js アプリ。

このファイルは、新セッションが起動時に文脈を引き継ぐためのものです。**最初に必ず読んでください。**

## クイックスタート（新セッション向け）

1. このファイルを読む
2. `docs/session-history/` に過去の会話履歴（JSONL）あり。必要に応じて参照
3. ユーザーから依頼された作業に着手

## アーキテクチャ

### ディレクトリ構成
```
src/
├── app/
│   ├── bank-statement/        # メインの画面（/bank-statement ルート）
│   └── api/
│       ├── bank-statement/    # Gemini OCR API ルート（通帳・レシート・請求書・CC・現金出納帳）
│       └── drive/             # Google Drive 同期 API
├── components/bank-statement/ # 25個のUIコンポーネント
└── lib/bank-statement/        # 解析・マッピング・パターン学習・ストレージ
```

### 主要コンポーネント
- **BankStatementContent.tsx**: ルート画面。アップロード、解析、仕訳テーブル、CSV出力までを統括（約1700行）
- **StatementViewer.tsx**: 左ペイン。PDF/Excelの取り込みデータプレビュー
- **JournalEntryTable.tsx / JournalEntryRow.tsx**: 右ペイン。仕訳テーブルと行編集UI
- **ColumnMappingDialog.tsx**: 通帳・CC用の列マッピング
- **InvoiceColumnMappingDialog.tsx**: 請求書用の列マッピング
- **ReceiptColumnMappingDialog.tsx**: レシート用の列マッピング
- **PatternListDialog.tsx**: 学習パターン管理
- **AccountMasterUploader.tsx**: 科目・補助科目・科目別消費税マスタの取り込み

### データの流れ
1. ユーザーがファイルをアップロード（UploadDialog）
2. ファイル種別ごとに解析:
   - PDFテキスト: `pdf-text-parser` で pdfjs-dist による解析
   - PDF画像 / 複雑なPDF: Gemini API（`/api/bank-statement/*`）
   - Excel/CSV: `excel-parser` でパース → 列マッピングダイアログ表示 → 確定後マッピング適用
3. RawTableRow → BankTransaction → JournalEntry に変換（`transaction-extractor` / `journal-mapper`）
4. パターン学習で借方・貸方科目・消費税を自動セット
5. ユーザーが画面で手修正
6. 会計大将CSVをエクスポート（`csv-generator`）

## 重要な仕様・設計判断（ユーザーとの合意済み事項）

### 消費税率の扱い（重要）
- **マスタによる税率の自動上書きはしない**。例えば科目別消費税マスタで「課税仕入10%」となっていても、取引によっては軽減8%になることがあるため、パターン由来や個別設定された税率を尊重する
- マスタは「空欄のときだけ補完」する（`BankStatementContent.tsx` の `applyParseResultFn` 及び `onAccountTaxUpdate` 内）
- 学習済みパターンの税率を変えたい場合は、パターン一覧からパターン自体を修正する運用
- 税率コード: `4`=10%, `5`=8%軽減, `3`=8%

### 補助科目CDの保存（修正済みバグ）
- かつて、補助科目をドロップダウンで選んでも CD が保存されないバグがあった
- 原因: `onChange(id, 'debitSubCode', sc)` と `onChange(id, 'debitSubName', sn)` を連続呼び出ししていたが、`entriesRef.current` のref更新が再レンダリング後の useEffect で行われるため、2回目の呼び出しが1回目の更新を上書きしていた
- 修正: `_debitSubFull` / `_creditSubFull` という一括更新フィールドを追加し、`code|name` を1回の setState で同時更新（`JournalEntryTable.tsx` の `handleEntryChange`）

### レシート・領収書のExcel列マッピング
- xlsx/csv をレシート区分でアップロードすると専用の列マッピング画面が出る
- マッピング項目: 日付 / 相手先名称 / 主な品名 / 支払総額（必須）と 10%対象額 / 軽減8%対象額 / 対象外金額 / インボイス番号 / 備考（任意）
- **列マッピング経由は常にインボイス登録事業者扱い**（経過措置※を付けない）
- **対象外**: 税CD/税率/税区分すべて空欄で生成
- **10%対象額** → 課仕10%、税率コード `4`
- **軽減8%対象額** → 課仕8%、税率コード `5`
- シート名に「レシート」「領収」を含むものを優先

### パターン学習
- キーワード（通帳の元摘要）+ 金額範囲 + 科目コードでマッチング
- `matchType`: exact（完全一致）/ partial（部分一致）
- `replaceEntireDescription`: true なら部分一致でも変換後摘要で全体置換
- 複合仕訳パターン（諸口を使った複数行）対応
- 自動学習時は `patternId` をエントリに記録（再学習で重複防止）

### 諸口（997）を使った複合仕訳
- 通帳の1取引から複数科目への按分が必要な場合（家賃収入の内訳など）
- 親エントリ: 通帳 ↔ 諸口（全額）、子エントリ: 諸口 ↔ 各科目
- 通帳の動きが内訳数だけ増えるのを防ぎ、実際の通帳推移と一致

### 顧問先（クライアント）切り替え
- localStorage キーは `bs-{cid}-{type}` 形式（マスタ・パターン・処理状況をクライアントごとに分離）
- Google Drive 同期で複数端末・複数ユーザーでデータ共有可能

## 起動方法

### 開発（このリポジトリ）
```
npm install
npm run dev
```
→ http://localhost:3000/bank-statement

### エンドユーザー向け（Windows）
- `初回セットアップ.bat`: 初回のみ。git clone してセットアップ
- `起動.bat`: 毎回これをダブルクリック。git pullで最新化してから `npm run dev`
- `デスクトップにショートカット作成.bat`: 起動.batのショートカットを作る
- 環境変数: `.env.local` に `GEMINI_API_KEY=...`

## 環境

- Next.js 14 / TypeScript / Tailwind
- Gemini API（@google/generative-ai）
- xlsx パッケージで Excel 解析
- pdfjs-dist で PDF テキスト抽出
- googleapis で Google Drive 連携

## 次にやる予定の作業

**左側プレビュー行のハイライト機能**

通帳データを Excel で取り込んだとき、左側に Excel データが表示される。右側の仕訳テーブルの任意の行をクリックしたとき、それに対応する左側の Excel データの該当行に背景色を付ける。

実装ヒント:
- `JournalEntry.transactionId` で左側の `BankTransaction.id` と紐付け済み
- 右ペインの行クリック → 親 state に selectedTransactionId を保存
- 左ペイン（StatementViewer）に selectedTransactionId を渡し、該当行に背景色クラスを付与
- 該当行へスクロール（scrollIntoView）もあると良い

## 移行履歴

このリポジトリは `yukihiro-jpg/test-project` の `claude/gemini-file-api-kp4Qk` ブランチから分離して作られました。元のリポジトリには従業員管理・マイナンバー収集アプリ等が同居していましたが、こちらは会計OCRアプリ専用です。

過去のセッション履歴は `docs/session-history/` 配下の JSONL ファイルにあります。
