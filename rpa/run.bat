@echo off
rem ===================================================================
rem 電子申告 自動処理ツール 起動用
rem
rem 初回だけ setup.bat を実行してから、このファイルをダブルクリックする。
rem ===================================================================
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo.
    echo 初期設定がまだです。先に setup.bat を実行してください。
    echo.
    pause
    exit /b 1
)

if not exist "config\settings.yaml" (
    echo.
    echo config\settings.yaml がありません。ひな形を作ります。
    echo.
    ".venv\Scripts\python.exe" -m nxrpa init
    echo.
    echo config\settings.yaml と config\clients.csv を編集してから、もう一度実行してください。
    echo.
    pause
    exit /b 1
)

rem 画面（顧問先選択と暗証番号入力）を出す
".venv\Scripts\python.exe" -m nxrpa gui

if errorlevel 1 (
    echo.
    echo エラーで終了しました。logs フォルダの実行ログを確認してください。
    echo.
    pause
)
endlocal
