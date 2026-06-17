@echo off
chcp 932 > nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

if "%~1"=="--launched" goto :MAIN

echo ============================================================
echo  会計大将インポート変換（FileAPI版）
echo ============================================================
echo.

REM Node.js 確認
where node > nul 2>&1
if errorlevel 1 (
  echo [エラー] Node.js が見つかりません。 https://nodejs.org/ja から LTS版 をインストールしてください。
  pause & exit /b 1
)
for /f "delims=" %%v in ('node -v') do echo Node.js: %%v

REM package.json 確認
if not exist package.json (
  echo [エラー] このフォルダに package.json がありません。
  pause & exit /b 1
)

REM Git で最新コード取得 → 自己再起動（bat 自己書き換え対策のため reset/call/exit は1行）
where git > nul 2>&1
if errorlevel 1 (
  echo [情報] Git が見つかりません。自動更新はスキップします。
  goto :MAIN
)
if not exist ".git" (
  echo [情報] Git 管理されていません。自動更新はスキップします。
  goto :MAIN
)
echo 最新コードを取得して再起動します...
git fetch origin --quiet && git reset --hard origin/main --quiet && call "%~f0" --launched & exit /b


:MAIN
REM npm install 必要判定（package-lock.json のハッシュ比較）
set "NEED_INSTALL="
if not exist node_modules set "NEED_INSTALL=1"
if exist package-lock.json (
  set "CURR_HASH="
  for /f "delims=" %%h in ('git hash-object package-lock.json 2^> nul') do set "CURR_HASH=%%h"
  set "STORED_HASH="
  if exist node_modules\.lock-stamp set /p STORED_HASH=<node_modules\.lock-stamp
  if not "!CURR_HASH!"=="!STORED_HASH!" set "NEED_INSTALL=1"
)
if defined NEED_INSTALL (
  echo 依存パッケージをインストール中（数秒～数分）...
  call npm install
  if errorlevel 1 (
    echo [エラー] npm install に失敗しました。
    pause & exit /b 1
  )
  if defined CURR_HASH echo !CURR_HASH!>node_modules\.lock-stamp
)

REM .env.local の作成・APIキー設定
if not exist .env.local (
  echo GEMINI_API_KEY=your_gemini_api_key>.env.local
  echo [初回] .env.local を作成しました。メモ帳が開きます。
  echo   GEMINI_API_KEY= の右側を実際のキーで書き換えて保存してください。
  notepad .env.local
  pause
)
findstr /R /C:"^GEMINI_API_KEY=your_gemini_api_key$" .env.local > nul 2>&1
if not errorlevel 1 (
  echo [エラー] .env.local の GEMINI_API_KEY がまだ初期値のままです。
  notepad .env.local
  pause & exit /b 1
)

REM ブラウザを少し遅れて起動（通帳CSV変換画面へ直行）
start "" /B cmd /c "timeout /t 8 /nobreak > nul & start "" http://localhost:3000/bank-statement"

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
