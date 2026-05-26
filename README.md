# 会計大将インポートデータ変換アプリ

通帳・現金出納帳・クレジットカード明細・請求書・レシート・賃金台帳などを
AI（Gemini）OCR や Excel/CSV 取り込みで解析し、会計ソフト「会計大将」向けの
インポート CSV に変換する Web アプリケーションです。税理士事務所での記帳代行
業務の効率化を目的としています。

## 主な機能

- **多様な証憑の取り込み**
  - 通帳・現金出納帳（PDF / Excel / CSV、列マッピング対応）
  - クレジットカード明細（PDF の Gemini OCR / Excel・CSV の列マッピング）
  - 売上請求書・仕入請求書（PDF / Excel / CSV）
  - レシート・領収書、ゆうちょ受払通知、賃金台帳
- **パターン学習**：摘要・金額から借方/貸方科目・補助科目・消費税率(10%/8%軽減)・
  インボイス登録区分・変換後摘要を自動適用。顧問先（科目コード）単位でスコープ管理
- **進捗管理表**：顧問先ごとに月別の処理状況を記録（会計年度の切替対応、資料依頼メール作成）
- **Google Drive 同期**：顧問先・学習パターン・科目/税率マスタ・進捗表を事務所内で共有
- **会計大将向け CSV 出力**（Shift_JIS）

## 動作環境

- Node.js（LTS 推奨）
- ブラウザ（Chrome 等）

## セットアップ

### 1. 依存パッケージのインストール

```
npm install
```

### 2. 環境変数の設定

プロジェクト直下に `.env.local` を作成し、以下を設定します（`.env.example` 参照）。

```
# Gemini API（OCR 解析に使用）
GEMINI_API_KEY=your_gemini_api_key

# Google OAuth（Drive 同期に使用）
GOOGLE_CLIENT_ID=xxxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxxx
GOOGLE_DRIVE_FOLDER_ID=Driveの保存先親フォルダID
NEXTAUTH_URL=http://localhost:3000

# 任意: Drive データ保存フォルダ名（既定: 事務所アプリ共有データ）
# GOOGLE_DRIVE_DATA_FOLDER_NAME=事務所アプリ共有データ
```

> `.env.local` は機密情報のため Git には含まれません。バックアップは安全な場所に保管してください。

### 3. 起動

```
npm run dev
```

ブラウザで http://localhost:3000/bank-statement を開きます。

## Google Drive 同期のセットアップ

事務所内の複数 PC で顧問先・学習パターン等を共有する手順は
[`docs/google-drive-sync-setup.md`](docs/google-drive-sync-setup.md) を参照してください。

## ディレクトリ概要

- `src/app/bank-statement/` … 画面のエントリ
- `src/components/bank-statement/` … UI コンポーネント
- `src/lib/bank-statement/` … 解析・変換・パターン・同期などのロジック
- `src/app/api/bank-statement/` … Gemini OCR 等の API ルート
- `src/app/api/drive/` … Google Drive 同期 API
- `docs/` … セットアップ手順書

## バックアップ・復旧

PC 入れ替え時の復旧手順は、Drive 同期手順書および
`.env.local` のバックアップを参照してください。データ本体（顧問先・パターン・
進捗表）は Drive に同期されているため、`.env.local` とコードがあれば復旧できます。
