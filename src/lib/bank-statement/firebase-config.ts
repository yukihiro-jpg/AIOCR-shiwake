// Firebase（komon-manager と同一プロジェクト）の公開クライアント設定。
//
// これらの値は「公開」前提のものです（Firebase の Web 設定はクライアントに
// 配布される性質上、秘密ではありません）。実際のアクセス制御は
//   1) 匿名認証（auth != null）
//   2) 合言葉（ルーム）を知っていること = ルームキーを知っていること
//   3) Realtime Database セキュリティルール
// の3点で行います。合言葉そのものはコードには一切書きません（各自が入力）。
//
// データ保存先: rooms/{ルームキー}/aiocr-shiwake/{clientId}/{key}
//   - ルームキー = 合言葉を SHA-256 でハッシュした安全な文字列（推測不可・パス安全）
//   - komon-manager のデータ（rooms/{ルーム名}/...）とはサブツリーが分かれるため混ざりません

export const firebaseConfig = {
  apiKey: 'AIzaSyAYUSRK6E3gxZ66LAvWyjYBrmOnj9BZ3Xo',
  authDomain: 'komon-manager-d7ff7.firebaseapp.com',
  databaseURL: 'https://komon-manager-d7ff7-default-rtdb.firebaseio.com',
  projectId: 'komon-manager-d7ff7',
  storageBucket: 'komon-manager-d7ff7.firebasestorage.app',
  messagingSenderId: '188439097503',
  appId: '1:188439097503:web:2a704bc119f96c3b92f2aa',
}

// このアプリのデータを格納するサブツリー名（komon-manager と衝突させないため）
export const APP_SUBTREE = 'aiocr-shiwake'
