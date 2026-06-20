# Firebase リアルタイム同期 セットアップ / 仕様メモ

このアプリは **Firebase Realtime Database** を主データストアとして、
顧問先データを端末間でリアルタイム同期します。Drive は引き続き
「アーカイブ（控え）」として並行保存します（Firebase ＋ Drive アーカイブ構成）。

## 構成
- プロジェクト: `komon-manager-d7ff7`（komon-manager と同一プロジェクト）
- DB: Realtime Database
- 認証: 匿名認証（Anonymous Authentication）
- データパス: `rooms/{ルームキー}/aiocr-shiwake/{clientId}/{key}`
  - 顧問先一覧（グローバル）は `rooms/{ルームキー}/aiocr-shiwake/_global/clients`
  - `aiocr-shiwake` サブツリーに分離しているため komon-manager のデータとは混ざりません

## 合言葉（ルーム）= アクセス境界
- アクセスの鍵は **合言葉**。アプリ起動時に各端末で1回だけ入力（次回からは自動接続）
- 合言葉は **コードには一切書かず**、各端末の localStorage（`bs-fb-room`）にのみ保存
- ルームキー = 合言葉の **SHA-256 ハッシュ**（推測不可・パス安全）。同じ合言葉なら同じ部屋に繋がります
- 同じ合言葉を入れたメンバーどうしでデータが共有されます

> ⚠️ 公開リポジトリのため、合言葉そのものを README やコードに書かないでください。
> 社内メンバーにだけ口頭等で共有してください。

## 必要な Firebase 設定（管理者が一度だけ）

### 1. 匿名認証を有効化
Firebase コンソール → Authentication → Sign-in method → **匿名** を有効化
（komon-manager で既に有効なら不要）

### 2. セキュリティルール
Realtime Database → ルール。最低限、ルーム単位で認証必須にします
（komon-manager で既に同等のルールがあればそのままでOK）:

```json
{
  "rules": {
    "rooms": {
      "$room": {
        ".read": "auth != null",
        ".write": "auth != null"
      }
    }
  }
}
```

ポイント:
- `.read` を `rooms` ではなく `$room` 階層に置くことで、**部屋の一覧は取得できず**、
  正確なルームキー（=合言葉のSHA-256）を知っている人だけがアクセスできます
- ルームキーは256bitで推測不可のため、合言葉が漏れない限り第三者は到達できません

> もし書き込みが `PERMISSION_DENIED` になる場合は、上記の `$room` ワイルドカードルールが
> 入っているか確認してください。

## 動作
- データ保存（パターン学習・科目マスタ・処理状況など）→ debounce 後に Firebase へ push
- 他端末の変更 → `onValue` で受信し localStorage に反映、画面を再読込
- Drive へは従来どおり保存（アーカイブ）。Google ログイン中のみ
- 合言葉未設定でも「あとで（共有なし）」で従来のローカル/Drive 運用が可能

## 旧データの移行
合言葉を設定後、各顧問先で「保存」（または全件保存）すると、
ローカル/Drive のデータが Firebase にも反映されます。
（`firebase-sync.ts` の `pushAllToFirebase` / `pushEverythingToFirebase`）
