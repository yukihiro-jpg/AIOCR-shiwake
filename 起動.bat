@echo off
chcp 932 > nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ============================================================
echo  会計大将インポート変換（FileAPI版）
echo ============================================================
echo.

REM Node.js 確認
where node >nul 2>&1
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

REM 最新コードを GitHub から取得
where git >nul 2>&1
if errorlevel 1 (
  echo [情報] Git が見つかりません。最新コードへの自動更新はスキップします。
) else (
  if exist ".git" (
    echo 最新コードを取得中...
    set "LOCK_BEFORE="
    if exist package-lock.json (
      for /f "delims=" %%h in ('git hash-object package-lock.json 2^>nul') do set "LOCK_BEFORE=%%h"
    )
    git fetch origin --quiet
    git reset --hard origin/claude/gemini-file-api-kp4Qk --quiet
    if errorlevel 1 (
      echo [警告] git による更新に失敗しました。現状のコードで起動します。
    ) else (
      echo 最新コードに更新しました。
      set "LOCK_AFTER="
      if exist package-lock.json (
        for /f "delims=" %%h in ('git hash-object package-lock.json 2^>nul') do set "LOCK_AFTER=%%h"
      )
      if not "!LOCK_BEFORE!"=="!LOCK_AFTER!" (
        echo パッケージ定義が変更されたので npm install を実行します...
        call npm install
        if errorlevel 1 ( echo [エラー] npm install に失敗 & pause & exit /b 1 )
      )
    )
  ) else (
    echo [情報] このフォルダは Git 管理されていません。最新コードへの自動更新はスキップします。
    echo        自動更新を有効にするには 初回セットアップ.bat を実行してください。
  )
)
echo.

REM 初回 npm install
if not exist node_modules (
  echo 初回セットアップ: npm install を実行します（3～5分かかります）...
  call npm install
  if errorlevel 1 ( echo [エラー] npm install に失敗 & pause & exit /b 1 )
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
findstr /R /C:"^GEMINI_API_KEY=your_gemini_api_key" .env.local >nul 2>&1
if not errorlevel 1 (
  echo [エラー] .env.local の GEMINI_API_KEY がまだ初期値のままです。
  notepad .env.local
  pause & exit /b 1
)

REM ブラウザを少し遅れて起動
start "" /B cmd /c "timeout /t 8 /nobreak >nul & start "" http://localhost:3000/bank-statement"

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
