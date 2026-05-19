@echo off
chcp 932 > nul
setlocal
cd /d "%~dp0"

echo ============================================================
echo  初回セットアップ
echo ============================================================
echo.

where git > nul 2>&1
if errorlevel 1 (
  echo [エラー] Git for Windows が未インストール。
  echo   https://git-scm.com/download/win からインストール → 再起動後に再実行
  pause & exit /b 1
)
for /f "delims=" %%v in ('git --version') do echo %%v

if exist ".git" (
  echo 既に Git 管理されています。セットアップ完了済みです。
  pause & exit /b 0
)

echo Git リポジトリとして初期化...
git init -b claude/gemini-file-api-kp4Qk
git remote add origin https://github.com/yukihiro-jpg/test-project.git
git fetch origin claude/gemini-file-api-kp4Qk
if errorlevel 1 ( echo [エラー] GitHub から取得失敗 & pause & exit /b 1 )
git reset --hard origin/claude/gemini-file-api-kp4Qk
if errorlevel 1 ( echo [エラー] git reset 失敗 & pause & exit /b 1 )

echo.
echo 完了。これ以降は 起動.bat だけで自動更新されます。
pause
endlocal
