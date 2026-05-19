@echo off
chcp 932 > nul
setlocal
cd /d "%~dp0"

echo ============================================================
echo  初回セットアップ：このフォルダを Git 管理にして
echo  ダブルクリックで最新コードに自動更新できるようにします。
echo ============================================================
echo.

REM Git 確認
where git >nul 2>&1
if errorlevel 1 (
  echo [エラー] Git for Windows がインストールされていません。
  echo.
  echo   1) https://git-scm.com/download/win から「64-bit Git for Windows Setup」をダウンロード
  echo   2) インストーラを実行（すべて「Next」で進めてOK）
  echo   3) PC を再起動
  echo   4) もう一度このバッチをダブルクリック
  echo.
  pause & exit /b 1
)
for /f "delims=" %%v in ('git --version') do echo %%v

REM 既に Git 管理されているか
if exist ".git" (
  echo.
  echo このフォルダは既に Git 管理されています。設定完了済みです。
  echo これ以降は 起動.bat だけ使えば自動で最新版に更新されます。
  pause & exit /b 0
)

echo.
echo Git リポジトリとして初期化します...
git init -b claude/gemini-file-api-kp4Qk
if errorlevel 1 ( echo [エラー] git init 失敗 & pause & exit /b 1 )

git remote add origin https://github.com/yukihiro-jpg/test-project.git
if errorlevel 1 ( echo [エラー] git remote add 失敗 & pause & exit /b 1 )

echo 最新コードを取得中...
git fetch origin claude/gemini-file-api-kp4Qk
if errorlevel 1 (
  echo [エラー] GitHub から取得できませんでした。ネットワーク接続を確認してください。
  pause & exit /b 1
)

echo ローカルファイルを最新コードに合わせて整えます...
git reset --hard origin/claude/gemini-file-api-kp4Qk
if errorlevel 1 ( echo [エラー] git reset 失敗 & pause & exit /b 1 )

echo.
echo ============================================================
echo  完了しました。
echo  これ以降は 起動.bat をダブルクリックするだけで、
echo  自動的に GitHub の最新版に更新されてアプリが起動します。
echo ============================================================
echo.
echo .env.local（APIキー設定）と node_modules は残してありますので
echo 続けて 起動.bat を実行できます。
echo.
pause
endlocal
