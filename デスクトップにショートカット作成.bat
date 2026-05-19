@echo off
chcp 932 > nul
setlocal
cd /d "%~dp0"

set "TARGET=%~dp0起動.bat"
set "ICON=%~dp0kaikei-taisho-fileapi.ico"
set "SHORTCUT=%USERPROFILE%\Desktop\会計大将インポート変換（FileAPI版）.lnk"

echo デスクトップにショートカットを作成します:
echo   %SHORTCUT%
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$s = (New-Object -ComObject WScript.Shell).CreateShortcut('%SHORTCUT%');" ^
  "$s.TargetPath = '%TARGET%';" ^
  "$s.WorkingDirectory = '%~dp0';" ^
  "$s.IconLocation = '%ICON%,0';" ^
  "$s.Description = '会計大将インポート変換（FileAPI版）';" ^
  "$s.Save()"

if exist "%SHORTCUT%" (
  echo.
  echo 完了しました。デスクトップにアイコンができています。
  echo ダブルクリックでアプリが起動します（毎回 GitHub から最新版を取得）。
) else (
  echo.
  echo [エラー] ショートカットの作成に失敗しました。
)
pause
endlocal
