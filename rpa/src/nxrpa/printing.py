"""印刷。

方式は2つあり、settings.yaml の printing.source で切り替える。

  app : NX-PRO の印刷画面からそのままプリンタへ出す。
        帳票の体裁（袋とじ・複数部・用紙）がアプリ側の設定どおりになるので、
        提出用・保管用の紙が必要なときはこちらが確実。
  pdf : 先に PDF を作り、その PDF を印刷する。
        「保存した現物がそのまま紙になる」ので、保存物と紙の一致を確認しやすい。

pdf 方式は Windows の関連付け（printto 動詞）に依存する。Adobe Acrobat Reader や
SumatraPDF が入っていれば動くが、環境によっては効かない。効かない環境向けに
printing.pdf_print_command で外部コマンドを指定できるようにしてある。
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from .errors import RpaError


def is_windows() -> bool:
    return sys.platform.startswith("win")


def list_printers() -> list[str]:
    """使えるプリンタ名の一覧。設定の書き間違いを見つけるために使う。"""
    if not is_windows():
        return []
    try:
        import win32print

        flags = win32print.PRINTER_ENUM_LOCAL | win32print.PRINTER_ENUM_CONNECTIONS
        return [p[2] for p in win32print.EnumPrinters(flags)]
    except Exception:  # noqa: BLE001
        try:
            out = subprocess.run(
                ["wmic", "printer", "get", "name"],
                capture_output=True, text=True, timeout=30, check=False,
            )
            lines = [ln.strip() for ln in (out.stdout or "").splitlines()[1:]]
            return [ln for ln in lines if ln]
        except Exception:  # noqa: BLE001
            return []


def default_printer() -> str:
    if not is_windows():
        return ""
    try:
        import win32print

        return win32print.GetDefaultPrinter()
    except Exception:  # noqa: BLE001
        return ""


def validate_printer(name: str | None) -> None:
    """設定されたプリンタが実在するか確かめる。

    実行の途中で「プリンタが無い」と分かるより、始める前に分かる方が良い。
    """
    if not name or not is_windows():
        return
    printers = list_printers()
    if not printers:
        return  # 一覧が取れない環境では素通しにする（誤検知で止めない）
    if name not in printers:
        raise RpaError(
            f"プリンタ '{name}' が見つかりません。\n"
            f"  使えるプリンタ: {', '.join(printers)}\n"
            f"  settings.yaml の printing.printer を修正してください。"
        )


def print_pdf(
    path: str | Path,
    *,
    printer: str | None = None,
    copies: int = 1,
    command: str | None = None,
    log: Any = None,
) -> None:
    """PDF を印刷する。"""
    p = Path(path)
    if not p.exists():
        raise RpaError(f"印刷するファイルがありません: {p}")
    copies = max(1, int(copies))
    target = printer or default_printer()

    def note(msg: str) -> None:
        if log is not None:
            log.info(msg)

    if command:
        _print_with_command(p, target, copies, command, note)
        return

    if not is_windows():
        raise RpaError(
            "印刷は Windows でのみ動きます。"
            " それ以外の環境では settings.yaml の printing.enabled を false にしてください。"
        )

    _print_with_shell(p, target, copies, note)


def _print_with_command(p: Path, printer: str, copies: int, command: str, note) -> None:
    """外部コマンドで印刷する（SumatraPDF など）。

    command には {path} {printer} {copies} を埋め込める。
    例: '"C:\\Tools\\SumatraPDF.exe" -print-to "{printer}" -silent "{path}"'
    """
    for i in range(copies):
        rendered = command.replace("{path}", str(p)).replace("{printer}", printer).replace(
            "{copies}", "1"
        )
        note(f"  印刷（{i + 1}/{copies}）: {p.name} → {printer or '既定プリンタ'}")
        result = subprocess.run(rendered, shell=True, capture_output=True, text=True, timeout=180, check=False)
        if result.returncode != 0:
            raise RpaError(
                f"印刷コマンドが失敗しました（終了コード {result.returncode}）: {rendered}\n"
                f"{(result.stderr or result.stdout or '').strip()[:500]}"
            )
        time.sleep(1.0)


def _print_with_shell(p: Path, printer: str, copies: int, note) -> None:
    """Windows の関連付けで印刷する。"""
    try:
        import win32api
    except ImportError as exc:  # noqa: BLE001
        raise RpaError(
            "印刷には pywin32 が必要です。`pip install pywin32` を実行してください。"
        ) from exc

    for i in range(copies):
        note(f"  印刷（{i + 1}/{copies}）: {p.name} → {printer or '既定プリンタ'}")
        try:
            if printer:
                # printto: プリンタを指定して印刷（Acrobat Reader / SumatraPDF が対応）
                win32api.ShellExecute(0, "printto", str(p), f'"{printer}"', str(p.parent), 0)
            else:
                win32api.ShellExecute(0, "print", str(p), None, str(p.parent), 0)
        except Exception as exc:  # noqa: BLE001
            hint = ""
            if printer:
                hint = (
                    "\n  プリンタ指定の印刷に対応していない PDF ビューアかもしれません。"
                    "\n  settings.yaml の printing.pdf_print_command に"
                    ' \'"C:\\Tools\\SumatraPDF.exe" -print-to "{printer}" -silent "{path}"\''
                    " のようなコマンドを設定すると確実です。"
                )
            raise RpaError(f"印刷を開始できません: {p}\n  原因: {exc}{hint}") from exc
        # 連続投入するとビューアの起動が追いつかずジョブが落ちることがある
        time.sleep(2.0)


def find_sumatra() -> str:
    """SumatraPDF があれば、そのまま使えるコマンド文字列を返す（設定の手助け）。"""
    candidates = [
        shutil.which("SumatraPDF"),
        r"C:\Program Files\SumatraPDF\SumatraPDF.exe",
        r"C:\Program Files (x86)\SumatraPDF\SumatraPDF.exe",
    ]
    for c in candidates:
        if c and Path(c).exists():
            return f'"{c}" -print-to "{{printer}}" -silent "{{path}}"'
    return ""
