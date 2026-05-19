@echo off
chcp 932 > nul
setlocal
cd /d "%~dp0"

set "TARGET=%~dp0起動.bat"
set "ICON=%~dp0kaikei-taisho-fileapi.ico"
set "SHORTCUT=%USERPROFILE%\Desktop\会計大将インポート変換（FileAPI版）.lnk"

echo デスクトップにショートカットを作成: %SHORTCUT%

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$s = (New-Object -ComObject WScript.Shell).CreateShortcut('%SHORTCUT%');" ^
  "$s.TargetPath = '%TARGET%';" ^
  "$s.WorkingDirectory = '%~dp0';" ^
  "$s.IconLocation = '%ICON%,0';" ^
  "$s.Description = '会計大将インポート変換（FileAPI版）';" ^
  "$s.Save()"

if exist "%SHORTCUT%" (
  echo 完了しました。デスクトップにアイコンができています。
) else (
  echo [エラー] ショートカット作成に失敗
)
pause
endlocal
