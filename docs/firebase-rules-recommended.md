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
    }
  }
}
```

ポイント:
- ルート直下は read/write とも拒否（`rooms` / `*-public` 以外のパスを作らせない）
- すべて匿名認証必須（`auth != null`）。トークン・roomKey を知らない限り列挙は不可能
  （キーが128bit乱数のため。**トップレベルの `.read` を true にしないこと** — 列挙可能になります）

## Storage ルール

```
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /scan-public/{token}/{allPaths=**} {
      allow read, write: if request.auth != null
        && request.resource == null || request.resource.size < 50 * 1024 * 1024;
    }
    match /nenmatsu-public/{token}/{allPaths=**} {
      allow read, write: if request.auth != null
        && request.resource == null || request.resource.size < 20 * 1024 * 1024;
    }
    match /nenmatsu/{roomKey}/{allPaths=**} {
      allow read, write: if request.auth != null;
    }
    match /{allPaths=**} {
      allow read, write: if false;
    }
  }
}
```

ポイント:
- サイズ上限をルールでも強制（アプリ側の `assertUploadSizes` はUI保護であり、改造クライアントは
  ルールでしか止められない）
- 列挙（list）は Storage ルールでは既定で `list` 権限に含まれるため、`allow read` を
  `allow get` に絞るとより堅い（トークンを知らない第三者のファイル名探索を防ぐ）

## 運用メモ

- **年調の提出データ**（申告内容・画像）は会社トークン配下に置かれ、同じ会社の従業員は
  相互に読める設計（1社1URL運用のトレードオフ）。より厳密にしたい場合は従業員ごとの
  個別トークン方式（scanのメンバーURLと同方式）への移行を検討。
- 「利用→未利用」に切り替えても公開URLは失効しない（データ削除を伴うため）。
  URLを失効させたい場合は顧問先の削除（purgeキュー経由で実体まで削除）を使う。
