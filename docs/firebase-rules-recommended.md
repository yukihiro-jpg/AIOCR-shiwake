# Firebase セキュリティルール（推奨設定）

このアプリのデータ保護は「roomKey（合言葉のSHA-256）の推測不可能性」と「公開トークンの128bit乱数」に
依存していますが、**RTDB / Storage のルールが最後の防波堤**です。リポジトリにはルールを置けない
（Firebaseコンソールで設定する）ため、推奨ルールをここに記録します。
コンソールの設定がこの内容と一致しているか、変更時に必ず見比べてください。

## Realtime Database ルール

```json
{
  "rules": {
    ".read": false,
    ".write": false,
    "rooms": {
      "$room": {
        ".read": "auth != null",
        ".write": "auth != null"
      }
    },
    "scan-public": {
      "$token": {
        ".read": "auth != null",
        ".write": "auth != null",
        "files": { "$id": { "size": { ".validate": "newData.isNumber() && newData.val() <= 52428800" } } },
        "inbox": { "$id": { "size": { ".validate": "newData.isNumber() && newData.val() <= 52428800" } } }
      }
    },
    "nenmatsu-public": {
      "$token": {
        ".read": "auth != null",
        ".write": "auth != null"
      }
    },
    "souzoku-review": {
      "$token": {
        ".read": "auth != null",
        ".write": "auth != null"
      }
    }
  }
}
```

ポイント:
- ルート直下は read/write とも拒否（`rooms` / `*-public` / `souzoku-review` 以外のパスを作らせない）
- `souzoku-review/{token}` は相続人向けクチコミ依頼ページ用。**事務所名・クチコミ投稿リンク・案件の特徴フラグ
  （真偽値）だけ**を置き、氏名・金額・人数などは保存しない（トークンを知る人は誰でも読めるため）
- すべて匿名認証必須（`auth != null`）。トークン・roomKey を知らない限り列挙は不可能
  （キーが128bit乱数のため。**トップレベルの `.read` を true にしないこと** — 列挙可能になります）

## Storage ルール

```
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    // 共有フォルダ・スマホ撮影（会社／メンバーごとの128bit乱数トークン配下）
    match /scan-public/{token}/{allPaths=**} {
      allow get, list: if request.auth != null;
      allow write: if request.auth != null
        && (request.resource == null || request.resource.size < 50 * 1024 * 1024);
    }
    // 年調の提出画像（会社トークン配下）
    match /nenmatsu-public/{token}/{allPaths=**} {
      allow get, list: if request.auth != null;
      allow write: if request.auth != null
        && (request.resource == null || request.resource.size < 20 * 1024 * 1024);
    }
    // 旧形式の年調画像（合言葉の部屋の配下・読み取りのみ残す）
    match /nenmatsu/{roomKey}/{allPaths=**} {
      allow get, list: if request.auth != null;
      allow write: if false;
    }
    // それ以外（バケット直下・scan-public 直下の一覧を含む）はすべて拒否
    match /{allPaths=**} {
      allow read, write: if false;
    }
  }
}
```

ポイント:
- **`match /{allPaths=**} { allow read, write: if request.auth != null; }` だけのルールにしないこと。**
  匿名認証は誰でも通るので、これは「全世界に公開・全員が削除可」と同じ。バケット直下の一覧
  （list）が通るため、トークンを知らなくても全ファイルを列挙・取得・削除・上書きできてしまう
  （2026-09 の監査でこの状態だったのを修正した）
- 一覧（`list`）はトークン配下でだけ許す。バケット直下や `scan-public/` 直下の一覧は末尾の
  `if false` で拒否されるので、トークンを知らない第三者はファイル名を探索できない
- **括弧を忘れないこと。** `A && B || C` は `(A && B) || C` と解釈されるため、括弧が無いと
  「サイズが上限未満なら認証なしでも書き込める」ルールになる
- サイズ上限をルールでも強制（アプリ側の `assertUploadSizes` はUI保護であり、改造クライアントは
  ルールでしか止められない）
- 変更後は「ルール プレイグラウンド」で次の2つを試して確認する:
  1. 種類 `list`・場所 `/scan-public`・認証済み ON → **拒否** になること
  2. 種類 `get`・場所 `/scan-public/abc/x.jpg`・認証済み OFF → **拒否** になること

## 運用メモ

- **年調の提出データ**（申告内容・画像）は会社トークン配下に置かれ、同じ会社の従業員は
  相互に読める設計（1社1URL運用のトレードオフ）。より厳密にしたい場合は従業員ごとの
  個別トークン方式（scanのメンバーURLと同方式）への移行を検討。
- 「利用→未利用」に切り替えても公開URLは失効しない（データ削除を伴うため）。
  URLを失効させたい場合は顧問先の削除（purgeキュー経由で実体まで削除）を使う。
