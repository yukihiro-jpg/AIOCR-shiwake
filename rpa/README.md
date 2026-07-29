# 電子申告 自動処理ツール（nxrpa）

MJS ACELINK NX-PRO で作った電子申告データを、顧問先を選ぶだけで

**送信 → 受信通知の取り込み → 各申告書・決算書の PDF 出力 → 「顧問先名＋資料名」で所定の場所へ保存 → 印刷**

まで通しで行う Windows 用のツールです。

このフォルダ（`rpa/`）は、同じリポジトリにある Web アプリ（業務総合アプリ）とは
独立した別プログラムです。Web アプリのビルド・デプロイには影響しません。

---

## 0. 最初に読んでほしいこと

このツールは **実際の税務申告を送信します。送信は取り消せません。**
そのため、次の安全策を最初から入れてあります。

| しくみ | 内容 |
|---|---|
| 既定は練習モード | 何も指定しなければ「送信ボタンの直前で必ず停止」します |
| 本番は明示指定 | 実際に送るには `--mode live` を付け、さらに**顧問先名を打ち込む確認**が必要です |
| 顧問先の突き合わせ | 開いた画面に出ている会社名と、選んだ顧問先が一致するか確認してから送ります |
| 暗証番号は再試行しない | カードは規定回数間違えるとロックされます。1回失敗したら必ず止まります |
| 送信途中の失敗は自動復旧しない | 送れたか不明な状態で再実行すると二重送信になるため、人が確認します |
| 実行記録 | いつ・どの顧問先で・何を送り・どこへ保存したかを JSONL と CSV に残します |

そして、もう一つ大事なことがあります。

> **同梱の画面手順定義（`config/profiles/acelink-nx-pro.sample.yaml`）に書いてある
> ボタン名・部品 ID は、実機で確認したものではありません。**

NX-PRO はバージョン・導入オプション・事務所ごとの設定で画面が変わるため、
実機を見ずに手順を確定することはできません。そのままでは「画面部品が見つかりません」で
止まります。**それが正常な初期状態です。**

そのかわり、実機を見ながら手順を埋めるための道具（インスペクタ）と、
実機に触らずに設定を検証するモードを用意しています。埋め方は「4. 手順を埋める」を見てください。

---

## 1. 必要なもの

- Windows 10 / 11
- Python 3.11 以降（[python.org](https://www.python.org/downloads/windows/) から。
  インストール時に **「Add python.exe to PATH」に必ずチェック**）
- ACELINK NX-PRO（電子申告システムを含む）
- 税理士の IC カードとカードリーダ（パソコンに接続済みであること）
- プリンタ（印刷する場合）

暗証番号はアプリの起動時に入力します。ファイルにも設定にも保存しません。

---

## 2. 導入

`rpa` フォルダをパソコンの任意の場所（例: `C:\nxrpa`）に置いて、

```
setup.bat
```

をダブルクリックします。専用の Python 環境を作り、必要なパッケージを入れ、
設定ファイルのひな形を作ります。

作られるもの:

```
config/
  settings.yaml                     … 保存先・印刷・対象書類などの設定
  clients.csv                       … 顧問先マスタ（Excel で編集できます）
  profiles/
    acelink-nx-pro.yaml             … 画面操作の手順（ここを実機に合わせて埋める）
logs/                               … 実行ログ・失敗時の画面・実行記録CSV
output/                             … PDF の保存先（既定。設定で変更してください）
```

---

## 3. 設定

### 3-1. 顧問先マスタ（`config/clients.csv`）

Excel で開けます。列は日本語のままで構いません。

| 列 | 内容 |
|---|---|
| 顧問先コード | NX-PRO の顧問先コード（必須） |
| 会社名 | ファイル名に入ります（必須） |
| カナ | 検索用（任意） |
| 年度 | 保存先フォルダに使えます |
| 期首 / 期末 | 任意 |
| 消費税 | `○`＝課税事業者 / `×`＝免税事業者。**免税なら消費税の申告と書類が自動で外れます** |
| 提出先自治体 | 任意 |
| 対象書類 | 空欄なら設定の既定を全部。絞りたいときだけ書類キーをカンマ区切りで |
| 保存先 | この顧問先だけ別の場所に保存したいとき |
| プリンタ | この顧問先だけ別のプリンタで印刷したいとき |
| 有効 | `×` にすると対象から外れます |

### 3-2. 保存先とファイル名（`config/settings.yaml`）

```yaml
paths:
  output_root: 'X:\顧問先'                              # 保存先のルート
  folder_template: '{client.code}_{client.name}\{client.fiscal_year}'
  file_template: '{client.name}_{doc.label}'            # ← 顧問先名＋資料名
  on_existing: rename                                   # 同名があれば連番
```

上の例だと、こうなります。

```
X:\顧問先\1001_株式会社サンプル商事\2026\株式会社サンプル商事_法人税申告書.pdf
```

使える差し込み: `{client.code}` `{client.name}` `{client.kana}` `{client.fiscal_year}`
`{client.period_from}` `{client.period_to}` `{client.local_gov}`
`{doc.key}` `{doc.label}` `{doc.category}`
`{run.date}` `{run.datetime}` `{run.year}` `{run.month}` `{run.day}`

保存先を1つの受け皿にまとめたいときは `folder_template` を空にするか、
`'{run.date}'` のように日付フォルダにしてください。

### 3-3. 出力する書類（＝資料名）

`settings.yaml` の `documents` が、そのままファイル名の「資料名」になります。
既定では 決算書 / 勘定科目内訳明細書 / 法人事業概況説明書 / 法人税申告書 /
都道府県民税事業税申告書 / 市町村民税申告書 / 消費税申告書 / 税務代理権限証書 /
受信通知（国税・消費税・地方税）を定義しています。事務所の呼び方に合わせて直してください。

- `requires_consumption_tax: true` … 課税事業者だけが対象
- `depends_on_submission: national` … その送信をしていないと存在しない書類（受信通知）。
  **練習モードでは自動的に省略されます**（送っていないので受信通知が無いのは当然のため）

### 3-4. 印刷

```yaml
printing:
  enabled: true
  source: app        # app＝NX-PROの印刷画面から / pdf＝保存したPDFを印刷
  printer: ''        # 空なら既定プリンタ
  copies: 1
```

プリンタ名は正確な文字列が必要です。`nxrpa printers` で確認できます。

`source: pdf` にして印刷できない環境では、SumatraPDF を入れて

```yaml
  pdf_print_command: '"C:\Tools\SumatraPDF.exe" -print-to "{printer}" -silent "{path}"'
```

を設定すると確実に印刷できます。

---

## 4. 手順を埋める（ここが本番前の一番の作業）

### 4-1. 画面の名前を調べる

NX-PRO を開いた状態で `check-screens.bat` を実行します。

```
開いているウィンドウ:

  ACELINK NX-PRO 電子申告
      class_name: WindowsForms10.Window.8.app...   control_type: Window
```

出てきたタイトルを `config/profiles/acelink-nx-pro.yaml` の `windows:` に書きます。

### 4-2. 画面部品を調べる

同じ `check-screens.bat` で、調べたいウィンドウ名の一部を入力します。
「何秒後に採取しますか」で 5 くらいを入れると、その間に目的の画面を出せます。

貼り付け用の形で出てくるので、そのまま `target:` に貼れます。

```yaml
# Button: 送信
  target:
    auto_id: "btnSend"
    control_type: Button
```

> 採取結果には画面に出ている顧問先名・金額が含まれることがあります。
> `inspect-result.txt` を外部に送る前に中身を確認してください。

### 4-3. 部品の指定は、壊れにくい順に

1. **`auto_id`** … 最優先。画面の文言が変わっても壊れません
2. `name`（表示名）… 読みやすいが、文言変更で壊れます
3. `class_name` + `index` … 並び順が変わると壊れます
4. `at: [x, y]`（座標）… **最後の手段**。ウィンドウサイズが変わると誤爆します

### 4-4. 画面が変わったことを必ず確かめる

「押したつもりで押せていないまま次へ進む」が、RPA で一番危ない壊れ方です。
画面遷移のあとには必ず `assert_exists` か `assert_text` を入れてください。

特に **顧問先の突き合わせ**は必ず入れてください。
別の顧問先の申告を送ってしまう事故を、ここだけが防げます。

```yaml
- name: 開いた顧問先が正しいことを確かめる
  action: assert_text
  window: main
  target: {auto_id: 'lblClientName'}
  contains: '{client.name}'
```

### 4-5. 書けるアクション

| 種類 | アクション |
|---|---|
| 制御 | `run_flow` `for_each` `set_var` `log` `sleep` `screenshot` `confirm` `irreversible` `fail` |
| ウィンドウ | `start_app` `focus_window` `wait_window` `wait_window_gone` `close_window` `maximize_window` `wait_idle` |
| 入力 | `click` `double_click` `right_click` `set_text` `type_text` `type_secret` `press_keys` `check` `uncheck` `select_combo` `select_list_item` `select_tree_item` `select_grid_row` `menu_select` |
| 確認・取得 | `wait_for` `assert_exists` `assert_not_exists` `assert_text` `capture_text` |
| ファイル・印刷 | `save_dialog` `expect_file` `print_file` |

**送信は必ず `irreversible` の中に入れてください。** ここが練習モードの停止点であり、
本番モードの確認点です。外に書くと安全策が効きません。

```yaml
- action: irreversible
  description: '国税（法人税ほか）を e-Tax へ送信'
  steps:
    - {action: click, window: denshi, target: {name: 送信, control_type: Button}}
    - {action: wait_idle, timeout: 300}
    - {action: assert_exists, window: denshi, target: {name_re: '.*受付完了.*'}, timeout: 300}
```

---

## 5. 実行

### 5-1. 画面から使う（ふだんはこちら）

`run.bat` をダブルクリックします。

1. 起動時に**暗証番号の入力**を求められます
2. 顧問先を選びます（複数選択できます）
3. 実行モードを選びます
4. 「保存先を確認」でどこに何が出るか見られます
5. 「実行」

### 5-2. コマンドから使う

```
nxrpa clients                        顧問先の一覧
nxrpa plan --client 1001             保存先と対象書類を表示（実行しない）
nxrpa check                          設定と手順定義を検証
nxrpa check --run                    画面を触らずに手順を通して検証
nxrpa run --client 1001              練習モードで実行
nxrpa run --client 1001 --mode live  本番モードで実行（実際に送信）
nxrpa run --all --mode live          有効な全顧問先を本番で処理
nxrpa printers                       使えるプリンタの一覧
nxrpa inspect --windows              開いているウィンドウの一覧
```

主なオプション: `--no-print`（印刷しない） `--no-submit`（送信せず出力だけ）
`--output-root`（保存先を一時的に変える） `--yes`（顧問先ごとの確認を省く）

### 5-3. 3つのモード

| モード | 画面 | 送信 | 用途 |
|---|---|---|---|
| `simulate`（検証） | 触らない | しない | 設定・手順の書き間違いを探す。カードも NX-PRO も不要 |
| `rehearsal`（練習・既定） | 触る | **送信ボタンの直前で停止** | 実機で手順が通るか確かめる |
| `live`（本番） | 触る | **する（取り消せません）** | 実際の申告 |

### 5-4. 進め方の順序（推奨）

```
nxrpa check              設定の誤りを潰す
nxrpa check --run        手順の通しを検証（画面を触らない）
nxrpa run -c 1001        練習。送信の直前まで実機で通す
nxrpa run -c 1001 --mode live   1件だけ本番で通す
nxrpa run --all --mode live     問題なければ全件
```

**いきなり `--all --mode live` は避けてください。**
1件を本番で通し、保存された PDF と紙を目で確認してから広げるのが安全です。

---

## 6. 実行の記録

`logs/` に残ります。

| ファイル | 内容 |
|---|---|
| `run-YYYYmmdd-HHMMSS.log` | 人が読む用。そのまま作業記録に貼れます |
| `run-YYYYmmdd-HHMMSS.jsonl` | 1行1イベント。あとから集計・検証できます |
| `result-YYYYmmdd-HHMMSS.csv` | 顧問先×書類の一覧（保存先・送信結果・印刷結果） |
| `screenshots/<実行ID>/` | 失敗時の画面 |

暗証番号はどのファイルにも残りません（万一混ざっても伏せ字にします）。
スクリーンショットには顧問先の申告情報が写るので、既定で 90 日を過ぎたら自動削除します
（`run.keep_screenshots_days`）。

---

## 7. 困ったとき

**「画面部品が見つかりません」**
→ 手順定義と実機がずれています。`check-screens.bat` で正しい `auto_id` / 名前を確認して
　 `config/profiles/acelink-nx-pro.yaml` を直してください。
　 `logs/screenshots/` に失敗時の画面が残っています。

**「表示内容に '○○' が含まれません」**
→ 画面が想定と違います。**別の顧問先を開いている可能性があるので、必ず目で確認してください。**
　 この確認はわざと厳しくしてあります。

**「暗証番号を入力できませんでした」**
→ 自動では絶対にやり直しません。画面を確認し、必要なら手で入力してからやり直してください。
　 カードは規定回数間違えるとロックされます。

**「送信操作の途中で失敗しました」**
→ 送信できたかどうかが不明な状態です。**そのまま再実行しないでください。**
　 e-Tax / eLTAX のメッセージボックスで送信済みかを確認してから判断してください。

**「保存先のパスが長すぎます」**
→ Windows の 260 文字制限です。`output_root` を浅い場所にするか、
　 `folder_template` を短くするか、その顧問先だけ「保存先」列で別の場所を指定してください。

**印刷されない**
→ `nxrpa printers` でプリンタ名を確認してください。`source: pdf` で出ない場合は
　 `pdf_print_command` に SumatraPDF を設定すると確実です。

---

## 8. 未確定事項（実機を見て決めるところ）

次の点は実機がないと確定できないため、**設定で差し替えられる形**にしてあります。
決まったら該当箇所を直してください。

1. **地方税をどこから送るか**
   NX-PRO の電子申告システムから直接送るなら、いまの `submit_local` フローを埋めるだけです。
   PCdesk へ取り込んで送る運用なら、`config/profiles/pcdesk.yaml` を作って
   `settings.yaml` の `apps` に追加し、`submissions` の `local` の `app` を `pcdesk` にしてください。
   手順定義の書き方は同じです。

2. **PDF の作り方**
   NX-PRO の PDF 出力を使う前提で書いてあります。対応していない帳票があれば、
   その書類だけ `export_method: print_to_pdf` にして、`export_flow` に
   「Microsoft Print to PDF へ印刷して保存する」手順を書いてください。

3. **受信通知の取り込みのタイミング**
   同梱の `fetch_receipts` は「更新 → 20秒待つ → もう一度更新」にしてあります。
   実際に受信通知が届くまでの時間に合わせて調整してください。

4. **顧問先の突き合わせに使う表示欄**
   `select_client` の最後にある `assert_text` の `target` は仮です。
   実機で会社名が表示される場所を特定して差し替えてください。**ここは必ず埋めてください。**

---

## 9. このツールがしないこと

- 申告内容そのものの検算はしません（金額の突合は Web アプリ側の「税務チェック」が担当）
- 電子申告データの作成はしません（NX-PRO で作成済みのデータを送るところから）
- 送信の取り消し・訂正はしません（誤送信は e-Tax / eLTAX 側で対応してください）
- 印刷の失敗では全体を止めません（紙は出し直せますが、送信のやり直しはきかないため）

---

## 10. 開発者向け

```
rpa/
  src/nxrpa/
    cli.py            コマンドライン入口
    gui.py            画面（Tkinter）
    config.py         settings.yaml の読み込みと検証
    clients.py        顧問先マスタ
    output.py         保存先の組み立て（ファイル名・衝突処理・パス長）
    templating.py     差し込みと Windows 用ファイル名整形
    secrets.py        暗証番号の保持（ログに出さない・再試行しない）
    audit.py          実行記録
    printing.py       印刷
    pipeline.py       顧問先1件の段取り
    inspector.py      画面部品の採取
    scaffold.py       ひな形の生成
    engine/
      locator.py      画面部品の指定
      profile.py      手順定義の読み込みと検証
      runner.py       ステップ実行・リトライ・安全弁
      backend.py      画面を触る層の抽象＋模擬実装
      windows_backend.py  pywinauto 実装
  tests/              Windows 無しで動くテスト
```

テスト:

```
python -m pytest tests/ -q
```

模擬バックエンド（`FakeBackend`）を使うので、Windows も NX-PRO も無しで
送信の安全弁・保存先の組み立て・暗証番号の扱いまで検証できます。

手順定義に新しいアクションを足すときは `engine/profile.py` の `ACTIONS` に
仕様を追加してください（必須項目・リトライ可否がここで検証されます）。
