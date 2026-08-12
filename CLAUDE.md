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
| 税務チェック（①申告書PDFの書類間金額突合＋電気供給業の区分計算書Excel検証 ②総勘定元帳CSVの会計監査・API不使用） | `/shinkoku-check` | React | `src/components/shinkoku-check/` `src/lib/shinkoku-check/`（監査ロジックは `src/lib/keiei/audit.ts` を共用） |
| 路線価マップ（住所→地図＋国税庁路線価図PDF・年分切替・都市計画区分） | `/rosenka-map` | React | `src/components/rosenka-map/` `src/lib/rosenka-map/`。索引データは `tools/rosenka/build-rosenka-index.mjs` が生成し `public/rosenka-data/` に置く（`.github/workflows/rosenka-data.yml` が毎年7/2に自動更新） |

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
- 共有フォルダの「顧問先→税理士」側は、顧問先自身がアップロードしたファイルを顧問先画面から削除できる
  （誤送信の取り消し用）。事務所が受取済み（downloadedAt/driveSavedAt あり）なら確認ダイアログでその旨を伝える。
  「税理士→顧問先」側は顧問先から削除・変更できない
- モジュール「利用→未利用」の切替では公開URL・データは削除しない（誤操作でのデータ消失防止）。
  失効させたいときは顧問先削除（purgeキューが実体まで削除）を使う。
- 年調は1社1URL（トークン）方式。同じ会社の従業員同士は提出物が相互に見える設計上のトレードオフがある
  （本人確認は生年月日ハッシュ。ハッシュ未登録者は提出ブロック）。
- 年調の再提出は**書類（docKey）単位のマージ**（`mergeSubmissionPaths`）。撮影した書類は置き換え・
  撮影しなかった書類は前回分を保持・申告内容は今回の入力で更新。丸ごと上書きにすると
  出し忘れ追加のときに前回画像が一括DLから消えるため。閲覧・ZIP・Driveはすべて `rec.paths` 基準
- 年調の保存期限清掃・孤児画像回収は `sweepAllNenmatsu`（全年度・全登録会社・利用/未利用に関係なく、
  端末ごと6時間に1回）。孤児画像は「作成から7日超＋どの記録からも未参照」のみ削除
  （アップロード直後の記録未書き込みを誤削除しないため）

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
- 共有フォルダ（ファイル便）は**向きで期間が違う**：顧問先→税理士＝**1年**（`SCAN_FILE_RETENTION_DAYS`）／
  税理士→顧問先＝**4年**（`SCAN_INBOX_RETENTION_DAYS`。申告書PDF・元帳CSVを後から取り出せるように）。
  表示と実削除は必ず `scanExpiry()` を通す（画面の「あと◯日」と実際の削除日がずれないため）。
  一覧・フォルダ・顧問先ページの3か所に削除予定日を出している
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
- 通帳画像PDFの参照箇所ハイライト（refRegion・region-locator）はユーザー要望で廃止済み（再実装しない）
- **カード明細PDFはAPI不使用の解析を最優先**（`card-statement-local.ts`）。Gemini は解析できなかったときだけ。
  - 見出し文字に頼らず**列のx位置**で読む（`statement-layout-parser.ts`）。カード会社のPDFは日本語フォントに
    ToUnicode が無く日本語が全部化けることがある（アメックス）が、数字は正確に取れる
  - **漏れの検知は明細書の小計との突合**（`reconciliation`）。日付の無い金額行を小計候補とし、
    直前の小計以降の累計と一致したらそこまで漏れなしとみなす。`ok===true` のときだけフォーマットを記憶する
  - 年は「西暦4桁で最頻のもの」、締め月は「出現した月を円環に並べていちばん大きい空きの手前」（年跨ぎ対応）
  - **文字化けはOCRの前にPDF側で直す**（`pdf-cid-glyph-fix.ts`）。ToUnicodeの無いPDFは
    `/Differences` のグリフ名が `CTIU`＋Adobe-Japan1のCID(16進4桁)になっているので、pdf.jsが読める
    `uniXXXX` へ書き換えたPDFをpdf-libで作り直して読み直す（実測2秒・OCR不要・通信不要）。
    CID→Unicode表は `adobe-japan1-ucs2.ts`（`tools/build-adobe-japan1-table.mjs` が生成・Adobe公式）。
    異体字セレクタ付き（茨󠄀）は基底文字だけ使う。この修復は `parsePdfText` に入れてあるので全モジュールに効く
  - それでも化けている場合だけ**摘要の列を切り出して端末内OCR**（`statement-ocr.ts`・tesseract.js・
    `4.0.0_best_int` を優先し取得できなければ既定へ）。**金額はOCRに頼らない**ので画像OCRより精度が高い
  - **2段構え**: 日付・金額はテキスト層だけで確定するので**先に仕訳を出して表示を終える**（実測0.7秒）。
    摘要のOCRとページ画像生成は後追いで、終わったら「ユーザーがまだ触っていない仕訳」だけ作り直す
    （`finishDescriptions()` ＋ `untouched()` 比較。ページ画像は `StatementPage.sourceId` で差し込む）。
    **OCRを待ってから表示する設計にしないこと**
  - 化け方はフォントの対応表で決まるので**同じ店名は必ず同じ文字列に化ける**。「化けた文字列→店名」の
    辞書（`descDict`）をフォーマットと一緒に保存し、既知の店はOCRせずに埋める。全行が埋まったページは
    OCRを飛ばす。ワーカーは3本（1本目を作ってから残りを作る＝学習データの多重ダウンロード防止）
  - 列検出は「見出しから取れた件数が0」か「小計と完全一致していて1.2倍以上多く取れた（10件以上）」
    ときだけ位置ベースへ乗り換える。**見出し検出は的外れでも“成功”を返すことがある**（過去にカード明細を
    通帳として上げると0件になる不具合）
  - フォーマット記憶は `card-format-store.ts`（署名＝英字ブランド語＋用紙サイズ＋日付/金額列の位置）。
    署名の材料は**まるごとASCIIの行だけ**（化けた日本語から拾うと明細ごとに揺れる）。
    保存キーは `bs-card-formats-{cid}`（`STORAGE_KEY_MAP` の `card-formats`）。一覧・削除は
    ヘッダーメニュー「カード明細フォーマット」（`CardFormatDialog.tsx`）
- 補助科目CDは `_debitSubFull`/`_creditSubFull` で code|name を1回のsetStateで更新（連続onChangeはrefで上書きされるバグの修正済み）
- レシートExcel/CSV列マッピング経由は常にインボイス登録事業者扱い、対象外は税CD/税率/税区分空欄
- パターン学習: キーワード＋金額範囲＋科目コード。複合仕訳（諸口997）対応
- 金額入力は「編集中は生文字列、blurで整形」方式（1文字ごとのtoLocaleString整形はカーソル飛び・桁重複の原因になるため禁止）

### 税務チェック（申告書チェック）
- 電気供給業（太陽光の売電など）を兼業している場合、チェックボックスをONにすると茨城県の
  「電気供給業とその他の事業を併せて行う法人の計算書」Excelを追加でアップロードできる
  （`denki-excel.ts` 読取 → `denki-form.ts` が県税申告書PDFを読取 → `denki-checks.ts` が突合）
- Excelは県の版差に備えて**固定セル番地ではなくラベルをアンカーに**行を特定する
- 税額の検算は**申告書に印字された税率**を使う（超過課税・税率改正でハードコードが陳腐化するため）。
  法定の標準税率とのズレは「参考」表示に留める
- 端数処理は課税標準1,000円未満切捨・税額100円未満切捨（**四捨五入ではない**）。
  特別法人事業税の課税標準は基準法人収入割額そのもので、1,000円未満切捨を重ねてはいけない
- あん分率は ROUNDDOWN 8桁、共通経費のあん分は所得課税事業分＝ROUNDDOWN(共通×率,0)・
  電気供給業分＝共通−所得課税事業分（残差法）。集計行は明細の集計なので、あん分の端数検査から除外する
- 所得割の課税標準は事業区分ごとに計算し**区分をまたいで通算しない**（欠損区分と黒字区分を相殺しない）。
  区分後の所得の合計＝法人税の所得金額 で検証している
- 数式だけで計算結果が保存されていないxlsxはSheetJSがセル自体を返さない。主要な自動計算欄が
  3か所以上読めないときは照合を中止し「Excelで開いて上書き保存」を促す
- 事業税は納付した期の損金。区分計算書の「法人税及び法人住民税−損金計上納税充当金＋事業税減算」の
  **区分欄の正味＝別表五(二)(19)の③＋⑤** で検算する（事業税を共通欄に入れる配賦誤りがここに出る）

### 路線価マップ
- 住所照合（`index-store.ts`）の正規化: 全角→半角・漢数字丁目（十九まで）・「N丁目」以降の番地切落し・
  ダッシュ異体字（U+2010〜2015含む）・ヶ/ヵ→ケ折り畳み。**大字と丁目キーが併存する町丁**
  （戸頭と戸頭９等・14組）では、前方一致の切れ目が数字列を分断する候補（戸頭912→戸頭9）を
  番地誤認とみなし大字を優先する
- `RosenkaMapContent` の照合は **`indexRef`（最新索引のref）** を使う。stateの`index`をclosureで
  参照すると、geocode等のawait中に年切替・索引到着が起きたとき古い索引で照合される（修正済みの競合バグ）。
  年切替の索引読込effectはcancelledフラグ必須・失敗(null)時は旧年の候補/図番号をクリアする
- 隣接ナビ: 索引に adj エントリの無い図でも逆リンクから復元して行き止まりにしない
- 索引スクレイパ（`build-rosenka-index.mjs`）: 国税庁の町丁名索引は**1行10リンクで折返し、
  継続行は町丁名セルがrowspanで省略**される → `parseTownPages` が直前の町丁名を引き継ぐ（過去に
  11件目以降の図番号が全消失するバグ）。隣接データは「町丁sheets∪adj参照先」の**閉包**まで取得
  （`completeAdjacency`・既存分は再利用し不足分のみ）。`tools/rosenka/**` をmainへpushすると
  `.github/workflows/rosenka-data.yml` が自動でデータ再生成→コミット→Pages再デプロイする
- r08で神栖市の町丁が16→10に減ったのは国税庁側の倍率地域化（正当な変更・スクレイパのバグではない）

### 相続管理
- 生前贈与加算は calcTax で反映済み（暦年3年/延長7年100万控除・精算課税110万控除）
- 報告書には解説キャプション（.caption）とストーリー解説文（.story、テンプレ＋AI仕上げ）
- 「税理士にご相談ください」系の文言は入れない（ユーザー自身が税理士）
- AI通帳分析（passbook）: 通帳明細をAIで分析し要確認取引・推定財産を財産一覧・異動一覧表へ反映
- 区分所有建物（マンション）: 建物ビューの「🏢 区分所有建物…」モーダルで登記事項（一棟・専有部分・
  敷地権・共有者）を一括入力 → 建物1行＋敷地利用権の土地行（`kubunId`でひも付け・符号単位で増減同期）を
  自動作成。敷地行は持分（被相続人持分）と敷地権割合（shikiNum/shikiDen）を別々に保持・表示し評価で両方を乗算（約分しない・敷地権割合列は区分所有登録のある案件のみ表示。旧データは持分に織込済みでshikiなし＝二重掛けしない）。マンション通達の区分所有補正率
  （`kubunHoseiCalc`・端数処理は通達どおり、×0.6の結果は丸めない）を両行の `kubunHosei` に持ち
  computeAssetValue で乗算。協議書は通常の表から除外し登記事項ブロックで別掲。建物行の削除で敷地行も連動削除
- 先代名義の不動産（数次相続）の遺産分割協議書: 先代は今回の申告の対象外なので基本情報・財産一覧には
  登録せず `currentCase.sendai[]`（先代ごとに氏名/本籍/住所/死亡日＋土地・建物の登記事項＋取得者）に持つ。
  資料出力の「先代名義 遺産分割協議書…」モーダルで入力。協議の参加者は今回の相続人（＝先代の相続人の
  権利義務承継者）。体裁は本体の協議書と共通（`agreementStyles()`）で前段の文面だけ数次相続用
- クチコミのお願い（souzoku-review）: 事務所はQR/リンクを発行するだけで、文章は相続人側のページが作る。
  公開ノード `souzoku-review/{token}` には**事務所名・Googleクチコミ投稿リンク・案件の特徴フラグ（真偽値）だけ**を置く
  （氏名・金額・人数は絶対に置かない）。発行から6か月で失効し、`sweepReviewLinks`（起動時）と
  案件削除（deleteCase）で実削除する。下書きは `src/lib/souzoku-review/draft.ts` のテンプレート方式
  （AI・APIキー不要で即時生成。seedを変えると別の言い回し）。名義変更・預貯金の解約は提携先/案内の扱いで書く
- 財産診断書Excel（downloadShindanExcelBody）: 3-1〜のカテゴリ別明細シートはアプリの財産一覧と同一ヘッダ
  （操作列のみ除外）で全項目を出力。自動計算欄はExcel数式（`{formula,result}`）で出力し、
  アプリの計算関数（computeAssetValue/secUnit/divInfo/landUseFactor/computeKobo等）と式を一致させる。
  全シートのフォントは書き出し直前に Noto Sans JP へ一括統一。PDF版は要約のまま（変更しない合意）

### 月次レポート
- **顧問先へお渡しする報告書は `src/lib/keiei/report2/` の新報告書に一本化した**（旧 `print-report.ts` のA3×7種類は廃止）。
  A4横で直接組版・**黒＋シアンの2色**・Noto Sans JP。色に意味を持たせるのは「シアン＝いま見てほしいところ」だけで、
  マイナスは色ではなく **△＋太字**、階層は網の濃さで表す（白黒コピーでも情報が落ちない）
- ページ構成（`REPORT_V2_PAGES`）: 表紙／①当事業年度の月次損益推移／②単月PL・BS／③着地見込と納税予測／
  ④CF計算書（間接法）／⑤月次資金繰り表（日繰り）／⑥損益分岐点売上高とシミュレーション／⑦借入金とFCF／
  ⑧労働分配率・生産性／⑨3期推移PL（全科目）。**フッターの番号は `ctx.pageNo()` が表紙を1として振る**ので、
  ページを足すときは `REPORT_V2_PAGES` に1行足すだけで表紙の目次・本文・相互参照がすべて追随する
- 月次損益推移は当期の12か月を横に並べた資料（単月PLと3期推移PLの間をつなぐ）。1ページに入らないときは
  販管費の明細を上位14科目＋「その他販管費」に丸める（科目を落とさず総額を保つ）。
  **グラフは載せない**（ユーザー要望。数字の表だけで見る資料）
- **画面と紙面は同じHTML**。`buildMonthlyReportV2Html()` が返すHTMLを、画面は iframe に流し込み、印刷は新規ウィンドウに書き出す。
  「計算＝`context.ts` で1回」「ページ＝`pages/*.ts` は ctx を並べるだけ」に分けているので、画面で動かした状態がそのまま印刷される
- 損益分岐点図は**図が上・表が下**。①売上高の線（太い実線）②総費用の線（点線）を凡例で明示し、
  交点の吹き出しは**左下**、いまの位置（報告月までの実績を年換算）の吹き出しは**右下**、ゾーン説明は軸の直上、と
  **高さの帯で置き場所を分けて文字が重ならないようにしている**（重なると読めなくなるため位置を勝手に変えない）
- **必要最低残高（危険水域）の既定は月商の1/3**（顧問先ごとに手入力へ変更可）。日繰りは月次データしか無いので、
  「月の実績合計」を登録済みの支払・回収サイクル（締日・支払日）で日付へ割り当てた**推計**。
  月初残高＋入金−出金が必ず月末残高に一致するよう、差額は月末で吸収する
- 着地見込みは **A＝当期平均／B＝前期実績の2本立て**（旧3シナリオは廃止）。9段階（売上→売上総利益→販管費→営業利益→
  経常利益→税引前）で表示し、当期純利益の見込みは税引前×(1−実効税率)
- 納税予測の料率は `tax-forecast.ts` の冒頭に定数でまとめる（法人税15%/23.2%・地方法人税10.3%・住民税7.0%＋均等割・
  事業税3.5/5.3/7.0%・特別法人事業税37%）。**超過課税や自治体差があるため概算**である旨を紙面にも書く
- 経営課題のコメントは**報告書に入れない**（画面の「経営課題」タブだけで確認する）
- 3期推移PLは科目×当期・前期・前々期の3段。**当期の段だけシアン網＋太字**。
  金額は円／千円を選択でき、**円単位のA4横は前半6か月／後半6か月の2枚に分割**（A3横を選べば1枚）

### 顧問先情報・進捗管理
- 相続税申告スポット顧問先: `souzokuSpot` フラグ。死亡日⇄相続管理と双方向連動、申告期限=死亡日+10か月
- 決算メモ（kessanMemos）: 年度__顧問先ID キー。未回答分はダッシュボード要確認リストに表示
- 税額モーダルは「納付税額確認書から自動入力」でJDL等の確認書（PDF/Excel）を端末内解析して各欄へ反映
  （`nofuParsePages` 純関数・PDFはpdf.jsをCDN遅延読込・明細ページから県/市の名称と収入割も取得）
- 中間申告計算: 収入割（電気供給業等）は税額モーダルの「うち収入割」に入力。収入割のある法人は
  **法人税の中間申告がなくても事業税・特別法人事業税の予定申告が必要**（金額基準なし・住民税は法人税連動のまま）。
  予定額は各割ごとに 前期×6÷前期月数→100円未満切捨（収入割と所得割は別々に切り捨てる）
- 決算確認書（案内PDF）: 印刷は @page margin:0＋body padding 方式（ブラウザのヘッダー/フッター印字を防ぐ）。
  税額モーダルのメモ欄（tax.memo）は署名欄の直上に「特記事項」として印字

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
