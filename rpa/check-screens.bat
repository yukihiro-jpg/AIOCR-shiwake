@echo off
rem ===================================================================
rem 画面部品の採取（手順定義を書くための道具）
rem
rem NX-PRO で調べたい画面を出してから実行する。
rem 結果は画面に出るほか、inspect-result.txt にも残る。
rem
rem ※ 採取結果には画面に出ている顧問先名・金額が含まれることがある。
rem    外部へ送る前に中身を確認すること。
rem ===================================================================
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo 先に setup.bat を実行してください。
    pause
    exit /b 1
)

echo.
echo === 開いているウィンドウの一覧 ===
echo.
".venv\Scripts\python.exe" -m nxrpa inspect --windows

echo.
set /p TITLE="中を調べたいウィンドウ名の一部を入力（そのまま Enter で終了）: "
if "%TITLE%"=="" goto :end

echo.
set /p DELAY="何秒後に採取しますか（対象画面を出す時間・そのまま Enter で 0）: "
if "%DELAY%"=="" set DELAY=0

".venv\Scripts\python.exe" -m nxrpa inspect --title "%TITLE%" --delay %DELAY% > inspect-result.txt 2>&1
type inspect-result.txt

echo.
echo 結果を inspect-result.txt に保存しました。
echo target: の行を config\profiles\acelink-nx-pro.yaml へ貼ってください。

:end
echo.
pause
endlocal
