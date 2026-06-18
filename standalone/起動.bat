@echo off
rem === 会計OCRアプリ（単一HTML版）起動用 ===
rem この 起動.bat と index.html を同じフォルダに置いてダブルクリックしてください。
rem Google系API（Gemini）はセキュリティ仕様上 file://（ダブルクリックで直接開く）では
rem 動作しません。http://localhost 経由で開く必要があるため、簡易サーバーを起動します。
cd /d "%~dp0"
echo ブラウザで http://localhost:8765/ を開きます...
start "" http://localhost:8765/
echo.
echo サーバーを起動します。使い終わったらこのウィンドウを閉じてください。
echo （Python が必要です。未インストールの場合は https://www.python.org/ から
echo  「Add Python to PATH」にチェックを入れてインストールしてください）
echo.
python -m http.server 8765
if errorlevel 9009 py -m http.server 8765
if errorlevel 9009 (
  echo.
  echo Python が見つかりませんでした。上記URLからインストール後、もう一度実行してください。
  pause
)
