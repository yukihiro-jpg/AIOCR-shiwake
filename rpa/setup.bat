@echo off
rem ===================================================================
rem 電子申告 自動処理ツール 初期設定（初回だけ実行する）
rem
rem 事前に Python 3.11 以降を入れておくこと。
rem   https://www.python.org/downloads/windows/
rem   ※ インストール時に「Add python.exe to PATH」に必ずチェックを入れる
rem ===================================================================
setlocal
cd /d "%~dp0"

echo.
echo === Python を確認します ===
py -3 --version >nul 2>&1
if errorlevel 1 (
    python --version >nul 2>&1
    if errorlevel 1 (
        echo.
        echo Python が見つかりません。
        echo https://www.python.org/downloads/windows/ から 3.11 以降を入れてください。
        echo インストール時に「Add python.exe to PATH」にチェックを入れてください。
        echo.
        pause
        exit /b 1
    )
    set PY=python
) else (
    set PY=py -3
)
%PY% --version

echo.
echo === 専用の Python 環境を作ります（.venv） ===
if exist ".venv" (
    echo   既にあります。作り直しません。
) else (
    %PY% -m venv .venv
    if errorlevel 1 goto :failed
)

echo.
echo === 必要なパッケージを入れます ===
".venv\Scripts\python.exe" -m pip install --upgrade pip
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 goto :failed

echo.
echo === 設定ファイルのひな形を作ります ===
".venv\Scripts\python.exe" -m nxrpa init

echo.
echo ===================================================================
echo 初期設定が終わりました。
echo.
echo 次の手順:
echo   1. config\clients.csv に顧問先を登録する（Excel で開けます）
echo   2. config\settings.yaml の保存先とプリンタを設定する
echo   3. NX-PRO を開いた状態で check-screens.bat を実行し、画面名を確認する
echo   4. config\profiles\acelink-nx-pro.yaml に手順を書く
echo   5. run.bat で起動する
echo ===================================================================
echo.
pause
exit /b 0

:failed
echo.
echo 初期設定に失敗しました。上のメッセージを確認してください。
echo.
pause
exit /b 1
