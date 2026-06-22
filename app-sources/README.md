# app-sources（埋め込みモジュールのソース）

総合アプリに iframe 隔離方式で組み込んでいる外部アプリの**編集可能なソース**。
ここを編集して再生成すれば、ホスト（このリポジトリ）だけで仕様変更できる。

```
app-sources/
  komon/index.html     ← 顧問先管理(komon-manager)のソース
  souzoku/index.html   ← 相続管理(souzoku-kanri)のソース
```

## 編集 → 反映の手順
1. `app-sources/komon/index.html`（または `souzoku/index.html`）を編集する
2. 埋め込みを再生成する
   - 顧問先: `node tools/build-komon-module.mjs`
       → `src/modules/komon/embedded.ts` を再生成
   - 相続:   `node tools/build-souzoku-embedded.mjs`
       → `src/modules/souzoku/embedded.ts` を再生成
3. `npm run build` で確認 → コミット＆プッシュ（GitHub Pages へデプロイ）

## 注意
- `src/modules/*/embedded.ts` は**自動生成物**。直接編集せず、必ず上記ソースを編集して再生成する。
- ビルドツールは「データ層 → ホスト共通コア(@/core)橋渡し」への変換アンカーを使う。
  そのアンカー周辺（データ保存/読込まわりの差し替え対象）を壊すと再生成が失敗するので注意。
- データ保存先・合言葉・roomKey は core 側の仕組みを使う（ソース側で独自に持たない）。
