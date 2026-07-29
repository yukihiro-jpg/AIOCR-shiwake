"""実機の画面部品を採取する道具。

このツールの手順定義（profiles/*.yaml）は、実機の画面部品の名前・auto_id を
知らないと書けない。ここで採取した内容をそのまま貼れる形で出力する。

使い方:
  1. NX-PRO で、手順を書きたい画面を出す
  2. `nxrpa inspect --windows` で対象ウィンドウのタイトルを確認する
  3. `nxrpa inspect --title "電子申告" --out shinkoku.yaml` で中身を採取する
     （--delay 5 を付けると、5秒のうちに目的の画面を出せる）
  4. 出力の target: 節をコピーして profiles/*.yaml に貼る

【注意】採取結果には顧問先名・金額など、画面に出ている業務情報が含まれる。
        --out で書き出したファイルは、共有前に中身を確認すること。
"""

from __future__ import annotations

import sys
import time
from pathlib import Path
from typing import Any

from .errors import RpaError


def run_inspector(args) -> int:
    if not sys.platform.startswith("win"):
        print(
            "inspect は Windows でのみ動きます。"
            "（NX-PRO を動かしているパソコンで実行してください）",
            file=sys.stderr,
        )
        return 1

    if args.delay:
        print(f"{args.delay:.0f} 秒後に採取します。対象の画面を前面に出してください…")
        for remaining in range(int(args.delay), 0, -1):
            print(f"  {remaining}", end="\r", flush=True)
            time.sleep(1)
        print("  採取します    ")

    try:
        from pywinauto import Desktop
    except ImportError:
        print(
            "pywinauto が入っていません。`pip install -r requirements.txt` を実行してください。",
            file=sys.stderr,
        )
        return 1

    desktop = Desktop(backend="uia")

    if args.windows or not args.title:
        return _list_windows(desktop, args)
    return _dump_window(desktop, args)


def _list_windows(desktop, args) -> int:
    print("開いているウィンドウ:\n")
    rows: list[tuple[str, str, str]] = []
    for w in desktop.windows():
        try:
            title = w.window_text()
            if not title:
                continue
            info = w.element_info
            rows.append((title, getattr(info, "class_name", "") or "",
                         getattr(info, "control_type", "") or ""))
        except Exception:  # noqa: BLE001
            continue

    if not rows:
        print("  （見つかりませんでした）")
        return 1

    for title, class_name, control_type in sorted(set(rows)):
        print(f"  {title}")
        print(f"      class_name: {class_name}   control_type: {control_type}")

    print("\nプロファイルへの書き方の例:\n")
    print("windows:")
    for title, class_name, _ in sorted(set(rows))[:5]:
        key = _to_key(title)
        print(f"  {key}:")
        print(f'    title_re: "{_escape_re(title)}"')
        if class_name:
            print(f'    class_name: "{class_name}"')
    print("\n中身を調べるには: nxrpa inspect --title \"<タイトルの一部>\"")
    return 0


def _dump_window(desktop, args) -> int:
    try:
        win = desktop.window(title_re=f".*{args.title}.*")
        if not win.exists(timeout=5):
            raise RpaError(f"ウィンドウが見つかりません: {args.title}")
        wrapper = win.wrapper_object()
    except Exception as exc:  # noqa: BLE001
        print(f"ウィンドウを掴めません（{args.title}）: {exc}", file=sys.stderr)
        print("`nxrpa inspect --windows` で正しいタイトルを確認してください。", file=sys.stderr)
        return 1

    print(f"ウィンドウ: {wrapper.window_text()}\n")
    entries: list[dict[str, Any]] = []
    _walk(wrapper, entries, depth=0, max_depth=args.depth)

    needle = (args.find or "").strip()
    if needle:
        entries = [e for e in entries
                   if needle in (e["name"] or "") or needle in (e["auto_id"] or "")]

    if not entries:
        print("  （部品が見つかりませんでした。--depth を増やしてみてください）")
        return 1

    print(f"{'深さ':<4} {'種類':<14} {'auto_id':<28} 表示名")
    print("-" * 100)
    for e in entries:
        indent = "  " * e["depth"]
        print(f"{e['depth']:<4} {e['control_type']:<14} {(e['auto_id'] or '-'):<28} "
              f"{indent}{_trim(e['name'])}")

    print("\n--- 貼り付け用（操作しやすそうな部品） ---\n")
    for e in entries:
        if e["control_type"] not in ("Button", "Edit", "ComboBox", "CheckBox", "RadioButton",
                                     "List", "Tree", "Table", "DataGrid", "MenuItem", "TabItem"):
            continue
        if not (e["auto_id"] or e["name"]):
            continue
        print(f"# {e['control_type']}: {_trim(e['name'])}")
        print("  target:")
        if e["auto_id"]:
            print(f'    auto_id: "{e["auto_id"]}"')
        elif e["name"]:
            print(f'    name: "{e["name"]}"')
        print(f'    control_type: {e["control_type"]}')
        print()

    if args.out:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        _write_yaml(out, wrapper.window_text(), entries)
        print(f"書き出しました: {out}")
        print("※ 画面に出ていた顧問先名・金額が含まれることがあります。共有前に中身を確認してください。")
    return 0


def _walk(node, out: list[dict[str, Any]], *, depth: int, max_depth: int) -> None:
    if depth > max_depth:
        return
    try:
        children = node.children()
    except Exception:  # noqa: BLE001
        return
    for child in children:
        try:
            info = child.element_info
            out.append({
                "depth": depth,
                "control_type": getattr(info, "control_type", "") or "",
                "auto_id": getattr(info, "automation_id", "") or "",
                "class_name": getattr(info, "class_name", "") or "",
                "name": (child.window_text() or "").strip(),
                "enabled": bool(child.is_enabled()),
                "visible": bool(child.is_visible()),
            })
        except Exception:  # noqa: BLE001
            continue
        _walk(child, out, depth=depth + 1, max_depth=max_depth)


def _write_yaml(path: Path, window_title: str, entries: list[dict[str, Any]]) -> None:
    lines = [
        "# nxrpa inspect の採取結果。profiles/*.yaml へ貼って使う。",
        f"# ウィンドウ: {window_title}",
        "",
        "windows:",
        f"  {_to_key(window_title)}:",
        f'    title_re: "{_escape_re(window_title)}"',
        "",
        "# --- 部品 ---",
    ]
    for e in entries:
        if not (e["auto_id"] or e["name"]):
            continue
        lines.append(f"# depth={e['depth']} {e['control_type']}: {_trim(e['name'])}")
        lines.append("# target:")
        if e["auto_id"]:
            lines.append(f'#   auto_id: "{e["auto_id"]}"')
        elif e["name"]:
            lines.append(f'#   name: "{e["name"]}"')
        lines.append(f'#   control_type: {e["control_type"]}')
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _to_key(title: str) -> str:
    key = "".join(ch if ch.isalnum() else "_" for ch in (title or "window"))
    key = "_".join(part for part in key.split("_") if part)
    return (key or "window").lower()[:40]


def _escape_re(text: str) -> str:
    import re

    return re.escape(text or "")


def _trim(text: str, limit: int = 50) -> str:
    text = (text or "").replace("\n", " ").replace("\r", " ")
    return text if len(text) <= limit else text[: limit - 1] + "…"
