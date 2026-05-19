@echo off
chcp 932 > /dev/null
setlocal enabledelayedexpansion
cd /d "%~dp0"

REM 引数 --launched が付いていれば「git pull 後の再起動」モード（更新スキップして本体処理へ）
if "%~1"=="--launched" goto :MAIN

echo ============================================================
echo  会計大将インポート変換（FileAPI版）
echo ============================================================
echo.

REM Node.js 確認
where node >/dev/null 2>&1
if errorlevel 1 (
  echo [エラー] Node.js が見つかりません。
  echo   https://nodejs.org/ja から LTS版 をインストールしてください。
  pause & exit /b 1
)
for /f "delims=" %%v in ('node -v') do echo Node.js: %%v

REM package.json 確認
if not exist package.json (
  echo [エラー] このフォルダに package.json がありません。
  pause & exit /b 1
)

REM Git で最新コード取得
where git >/dev/null 2>&1
if errorlevel 1 (
  echo [情報] Git が見つかりません。最新コードへの自動更新はスキップします。
  goto :MAIN
)
if not exist ".git" (
  echo [情報] このフォルダは Git 管理されていません。最新コードへの自動更新はスキップします。
  echo        自動更新を有効にするには 初回セットアップ.bat を実行してください。
  goto :MAIN
)

echo 最新コードを取得中...
set "OLD_HEAD="
for /f "delims=" %%h in ('git rev-parse HEAD 2^>nul') do set "OLD_HEAD=%%h"
git fetch origin --quiet
git reset --hard origin/claude/gemini-file-api-kp4Qk --quiet
if errorlevel 1 (
  echo [警告] git による更新に失敗しました。現状のコードで起動します。
  goto :MAIN
)
set "NEW_HEAD="
for /f "delims=" %%h in ('git rev-parse HEAD 2^>nul') do set "NEW_HEAD=%%h"

if "!OLD_HEAD!"=="!NEW_HEAD!" (
  echo 既に最新版です。
  goto :MAIN
)

echo 最新コードに更新しました。
REM bat 自身が書き換わった可能性があるので、再起動して新しい内容で続行する
echo （安全のためバッチを再起動します）
echo.
call "%~f0" --launched
exit /b

:MAIN
REM npm install（node_modules が無い or package-lock.json が更新された場合）
set "NEED_INSTALL="
if not exist node_modules set "NEED_INSTALL=1"
if exist .git (
  REM HEAD と HEAD~1 で package-lock.json が変わったか確認
  git diff --quiet HEAD~1 HEAD -- package-lock.json 2>/dev/null
  if errorlevel 1 set "NEED_INSTALL=1"
)
if defined NEED_INSTALL (
  echo 依存パッケージをインストールします（初回 or 更新あり、3～5分かかります）...
  call npm install
  if errorlevel 1 (
    echo [エラー] npm install に失敗しました。
    pause & exit /b 1
  )
)

REM .env.local 作成・APIキー設定
if not exist .env.local (
  echo GEMINI_API_KEY=your_gemini_api_key> .env.local
  echo.
  echo [初回] .env.local を作成しました。
  echo   メモ帳が開いたら、GEMINI_API_KEY= の右側を実際のキーで書き換えて保存してください。
  notepad .env.local
  pause
)
findstr /R /C:"^GEMINI_API_KEY=your_gemini_api_key$" .env.local >/dev/null 2>&1
if not errorlevel 1 (
  echo [エラー] .env.local の GEMINI_API_KEY がまだ初期値のままです。
  notepad .env.local
  pause & exit /b 1
)

REM ブラウザを少し遅れて起動（通帳CSV変換画面を直接開く）
start "" /B cmd /c "timeout /t 8 /nobreak >/dev/null & start "" http://localhost:3000/bank-statement"

echo.
echo サーバを起動します。ブラウザが自動で開きます。
echo （このウィンドウは閉じないでください。閉じるとアプリも停止します）
echo Ctrl + C で終了できます。
echo.
call npm run dev

echo.
echo サーバが終了しました。
pause
endlocal
