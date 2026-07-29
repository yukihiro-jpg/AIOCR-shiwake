"""実機（Windows）を触るバックエンド。pywinauto の UIA バックエンドを使う。

Windows 以外では import しただけで失敗するので、呼び出し側は遅延 import すること。
（テストと `--mode simulate` は FakeBackend を使うため Windows を必要としない）

設計メモ:
- トップレベルのウィンドウ探索は Desktop(backend="uia") で行う。
  「名前を付けて保存」やカードの暗証番号入力ダイアログは別プロセスが出すことがあり、
  Application.connect で掴んだプロセスの子だけを見ていると見つけられないため。
- 部品探索は必ずタイムアウト付き。NX-PRO は帳票生成で数十秒待たされる場面があるので、
  「見つからない＝即失敗」にせず、待ってから諦める。
"""

from __future__ import annotations

import subprocess
import time
from pathlib import Path
from typing import Any

from ..errors import LocatorError, RpaError
from .locator import Locator, WindowSpec


def _require_windows() -> None:
    import sys

    if not sys.platform.startswith("win"):
        raise RpaError(
            "実機モードは Windows でのみ動きます。"
            " Windows 以外では --mode simulate（画面を触らない検証）を使ってください。"
        )


class WindowsElement:
    """pywinauto のラッパを、このツールの Element 仕様に合わせて包んだもの。"""

    def __init__(self, wrapper: Any, locator: Locator):
        self._w = wrapper
        self._loc = locator

    # --- 基本操作 -----------------------------------------------------
    def click(self, button: str = "left", double: bool = False) -> None:
        # click_input（実際のマウス移動）を使う。invoke() より遅いが、
        # 業務アプリはマウス実操作でないと反応しない独自描画の部品を持つことがある。
        try:
            self._w.click_input(button=button, double=double)
        except Exception as exc:  # noqa: BLE001
            raise LocatorError(f"クリックできません（{self._loc.describe()}）: {exc}", spec=self._loc) from exc

    def set_text(self, text: str) -> None:
        try:
            self._w.set_edit_text(text)
            return
        except Exception:  # noqa: BLE001
            pass
        # ValuePattern が無い部品向けのフォールバック（全選択→上書き）
        try:
            self._w.set_focus()
            self._w.type_keys("^a{DELETE}", set_foreground=False, pause=0.01)
            self._w.type_keys(_escape_keys(text), with_spaces=True, set_foreground=False, pause=0.01)
        except Exception as exc:  # noqa: BLE001
            raise LocatorError(f"値を入力できません（{self._loc.describe()}）: {exc}", spec=self._loc) from exc

    def type_keys(self, text: str, *, clear: bool = False) -> None:
        try:
            self._w.set_focus()
            if clear:
                self._w.type_keys("^a{DELETE}", set_foreground=False, pause=0.01)
            self._w.type_keys(_escape_keys(text), with_spaces=True, set_foreground=False, pause=0.02)
        except Exception as exc:  # noqa: BLE001
            raise LocatorError(f"キー入力できません（{self._loc.describe()}）: {exc}", spec=self._loc) from exc

    def get_text(self) -> str:
        for getter in ("window_text", "get_value", "legacy_properties"):
            try:
                if getter == "window_text":
                    value = self._w.window_text()
                elif getter == "get_value":
                    value = self._w.get_value()
                else:
                    value = (self._w.legacy_properties() or {}).get("Value")
                if value:
                    return str(value)
            except Exception:  # noqa: BLE001
                continue
        # 子要素のテキストを連結して拾う（グループ枠の中の表示文字など）
        try:
            texts = [t for t in self._w.texts() if t]
            return "\n".join(str(t) for t in texts)
        except Exception:  # noqa: BLE001
            return ""

    def is_enabled(self) -> bool:
        try:
            return bool(self._w.is_enabled())
        except Exception:  # noqa: BLE001
            return False

    def is_visible(self) -> bool:
        try:
            return bool(self._w.is_visible())
        except Exception:  # noqa: BLE001
            return False

    def set_check(self, checked: bool) -> None:
        try:
            state = self._w.get_toggle_state()  # 0=off 1=on 2=indeterminate
            if (state == 1) != checked:
                self._w.toggle()
            return
        except Exception:  # noqa: BLE001
            pass
        try:
            if checked:
                self._w.check()
            else:
                self._w.uncheck()
        except Exception as exc:  # noqa: BLE001
            raise LocatorError(
                f"チェック状態を変えられません（{self._loc.describe()}）: {exc}", spec=self._loc
            ) from exc

    def select_item(self, item: str) -> None:
        try:
            self._w.select(item)
            return
        except Exception:  # noqa: BLE001
            pass
        # select() が使えない独自コンボ向け: 開いて一覧から選ぶ
        try:
            self._w.click_input()
            time.sleep(0.3)
            from pywinauto import Desktop

            候補 = Desktop(backend="uia").windows(control_type="ListItem", title=item)
            if 候補:
                候補[0].click_input()
                return
        except Exception:  # noqa: BLE001
            pass
        raise LocatorError(
            f"'{item}' を選べません（{self._loc.describe()}）。"
            f" 選択肢の表記が一致しているか確認してください。",
            spec=self._loc,
        )

    def select_tree_path(self, path: list[str]) -> None:
        try:
            self._w.get_item(list(path)).select()
        except Exception as exc:  # noqa: BLE001
            raise LocatorError(
                f"ツリー項目 {path} を選べません（{self._loc.describe()}）: {exc}", spec=self._loc
            ) from exc

    def select_row(self, value: str, column: str | None = None, double_click: bool = False) -> None:
        """表から、いずれかのセルが value と一致する行を選ぶ。

        顧問先一覧や帳票一覧の行選択に使う。完全一致を優先し、
        見つからなければ部分一致に落とす（社名の後ろに「(株)」等が付く場合に備える）。
        """
        rows = self._rows()
        if not rows:
            raise LocatorError(
                f"表の行を読み取れません（{self._loc.describe()}）。"
                f" `nxrpa inspect` で control_type を確認してください。",
                spec=self._loc,
            )

        target_col = _to_int(column)
        exact, partial = None, None
        for row in rows:
            cells = _row_texts(row)
            if target_col is not None:
                cells = cells[target_col: target_col + 1]
            elif column:
                # 列名指定は未対応の表があるため、全セット走査に落とす
                pass
            for cell in cells:
                text = (cell or "").strip()
                if text == value:
                    exact = row
                    break
                if partial is None and value and value in text:
                    partial = row
            if exact is not None:
                break

        row = exact or partial
        if row is None:
            sample = "; ".join(" | ".join(_row_texts(r)[:4]) for r in rows[:5])
            raise LocatorError(
                f"表に '{value}' の行がありません（{self._loc.describe()}）。"
                f" 先頭数行: {sample}",
                spec=self._loc,
            )
        try:
            row.click_input(double=double_click)
        except Exception:  # noqa: BLE001
            row.select()

    def _rows(self) -> list[Any]:
        for getter in ("items", "children"):
            try:
                items = getattr(self._w, getter)()
                rows = [
                    it for it in items
                    if getattr(it.element_info, "control_type", "") in ("DataItem", "ListItem", "TreeItem", "Custom")
                ]
                if rows:
                    return rows
            except Exception:  # noqa: BLE001
                continue
        try:
            return self._w.descendants(control_type="DataItem") or self._w.descendants(control_type="ListItem")
        except Exception:  # noqa: BLE001
            return []


def _row_texts(row: Any) -> list[str]:
    try:
        texts = [str(t) for t in row.texts() if t]
        if texts:
            return texts
    except Exception:  # noqa: BLE001
        pass
    try:
        return [str(c.window_text()) for c in row.children()]
    except Exception:  # noqa: BLE001
        return []


def _to_int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _escape_keys(text: str) -> str:
    """type_keys の特殊記号をエスケープする。

    ({}) や + ^ % は type_keys の制御文字なので、そのまま打つと消える。
    社名に「(株)」や「+」が入るケースが実際にあるため必須。
    """
    out = []
    for ch in str(text):
        if ch in "{}":
            out.append("{" + ch + "}")
        elif ch in "+^%~()[]":
            out.append("{" + ch + "}")
        else:
            out.append(ch)
    return "".join(out)


class WindowsBackend:
    """pywinauto を使う実機バックエンド。"""

    def __init__(self, *, default_timeout: float = 30.0, retry_interval: float = 0.4):
        _require_windows()
        from pywinauto import Desktop  # 遅延 import

        self._desktop = Desktop(backend="uia")
        self._apps: dict[str, Any] = {}
        self._default_timeout = default_timeout
        self._retry_interval = retry_interval

    # --- アプリ -------------------------------------------------------
    def start_app(self, key: str, exe: str, args: tuple[str, ...], timeout: float) -> None:
        from pywinauto import Application

        if not exe:
            return  # 起動済み前提（settings.yaml で exe を空にした場合）
        path = Path(exe)
        if not path.exists():
            raise RpaError(
                f"アプリの実行ファイルが見つかりません: {exe}\n"
                f"settings.yaml の apps.{key}.exe を実際のインストール先に合わせてください。"
            )
        if self._is_running(path.name):
            self._apps[key] = Application(backend="uia").connect(path=str(path), timeout=timeout)
            return
        app = Application(backend="uia").start(
            " ".join([f'"{exe}"', *(f'"{a}"' for a in args)]), timeout=timeout
        )
        self._apps[key] = app

    @staticmethod
    def _is_running(exe_name: str) -> bool:
        try:
            out = subprocess.run(
                ["tasklist", "/FI", f"IMAGENAME eq {exe_name}", "/NH"],
                capture_output=True, text=True, timeout=20, check=False,
            )
            return exe_name.lower() in (out.stdout or "").lower()
        except Exception:  # noqa: BLE001
            return False

    # --- ウィンドウ ---------------------------------------------------
    def find_window(self, spec: WindowSpec, timeout: float):
        deadline = time.monotonic() + max(timeout, 0.1)
        last: Exception | None = None
        while time.monotonic() < deadline:
            try:
                win = self._desktop.window(**spec.to_kwargs())
                if win.exists(timeout=0.5):
                    return win
            except Exception as exc:  # noqa: BLE001
                last = exc
            time.sleep(self._retry_interval)
        raise LocatorError(
            f"ウィンドウが見つかりません: {spec.describe()}"
            f"（{timeout:.0f}秒待ちました）"
            + (f" / {last}" if last else "")
            + "\n `nxrpa inspect --windows` で実際のウィンドウ名を確認してください。",
            spec=spec,
        )

    def window_exists(self, spec: WindowSpec, timeout: float) -> bool:
        try:
            self.find_window(spec, timeout)
            return True
        except LocatorError:
            return False

    def focus_window(self, spec: WindowSpec, timeout: float) -> None:
        win = self.find_window(spec, timeout)
        try:
            if win.is_minimized():
                win.restore()
        except Exception:  # noqa: BLE001
            pass
        try:
            win.set_focus()
        except Exception:  # noqa: BLE001
            # set_focus は他プロセスが前面を握っていると失敗することがある。
            # クリックで前面化を試みるが、業務データ上のボタンを踏まないよう
            # タイトルバー付近を狙う。
            try:
                rect = win.rectangle()
                win.click_input(coords=(min(40, rect.width() // 2), 8))
            except Exception:  # noqa: BLE001
                pass

    def close_window(self, spec: WindowSpec, timeout: float) -> None:
        win = self.find_window(spec, timeout)
        try:
            win.close()
        except Exception as exc:  # noqa: BLE001
            raise LocatorError(f"ウィンドウを閉じられません: {spec.describe()}: {exc}", spec=spec) from exc

    def maximize_window(self, spec: WindowSpec, timeout: float) -> None:
        win = self.find_window(spec, timeout)
        try:
            win.maximize()
        except Exception:  # noqa: BLE001
            pass

    # --- 部品 ---------------------------------------------------------
    def _scope(self, window: WindowSpec | None, timeout: float):
        if window is None:
            return self._desktop
        return self.find_window(window, timeout)

    def find(self, window: WindowSpec | None, locator: Locator, timeout: float):
        scope = self._scope(window, timeout)

        if locator.is_coordinate_only():
            return _CoordinateElement(scope, locator)

        kwargs = locator.to_kwargs()
        deadline = time.monotonic() + max(timeout, 0.1)
        last: Exception | None = None
        while True:
            try:
                child = scope.child_window(**kwargs)
                if child.exists(timeout=0.5):
                    return WindowsElement(child.wrapper_object(), locator)
            except Exception as exc:  # noqa: BLE001
                last = exc
            if time.monotonic() >= deadline:
                break
            time.sleep(self._retry_interval)

        raise LocatorError(
            f"画面部品が見つかりません: {locator.describe()}"
            f"（{'ウィンドウ ' + window.describe() if window else 'デスクトップ全体'} を"
            f" {timeout:.0f}秒探しました）"
            + (f" / {last}" if last else "")
            + "\n `nxrpa inspect` で実際の auto_id / 名前 / control_type を確認してください。",
            spec=locator,
        )

    def exists(self, window: WindowSpec | None, locator: Locator, timeout: float) -> bool:
        try:
            self.find(window, locator, timeout)
            return True
        except LocatorError:
            return False

    def send_keys(self, keys: str) -> None:
        from pywinauto.keyboard import send_keys

        send_keys(keys, pause=0.03)

    def menu_select(self, window: WindowSpec, path: list[str], timeout: float) -> None:
        win = self.find_window(window, timeout)
        try:
            win.menu_select("->".join(path))
            return
        except Exception:  # noqa: BLE001
            pass
        # UIA のリボン/独自メニューは menu_select が効かないので、順にクリックする
        current = win
        for label in path:
            item = current.child_window(title=label, control_type="MenuItem")
            if not item.exists(timeout=timeout):
                item = current.child_window(title=label)
            if not item.exists(timeout=timeout):
                raise LocatorError(
                    f"メニュー '{label}' が見つかりません（経路: {' > '.join(path)}）", spec=window
                )
            item.wrapper_object().click_input()
            time.sleep(0.3)
            current = self._desktop

    def wait_idle(self, window: WindowSpec | None, timeout: float) -> None:
        """アプリの処理が落ち着くまで待つ。

        NX-PRO は帳票生成・電子申告データ作成で長く待たされるため、
        「CPU が下がる」ことを目安にする。取れないときは短い固定待ちに落とす。
        """
        for app in self._apps.values():
            try:
                app.wait_cpu_usage_lower(threshold=8, timeout=timeout, usage_interval=0.5)
                return
            except Exception:  # noqa: BLE001
                continue
        time.sleep(min(1.0, timeout))

    def screenshot(self, path: str, window: WindowSpec | None = None) -> str | None:
        out = Path(path)
        out.parent.mkdir(parents=True, exist_ok=True)
        # まずウィンドウ単位、だめなら画面全体
        if window is not None:
            try:
                win = self.find_window(window, timeout=2)
                win.capture_as_image().save(str(out))
                return str(out)
            except Exception:  # noqa: BLE001
                pass
        try:
            from PIL import ImageGrab

            ImageGrab.grab(all_screens=True).save(str(out))
            return str(out)
        except Exception:  # noqa: BLE001
            return None


class _CoordinateElement:
    """座標クリック専用の逃げ道。部品として掴めない独自描画向け。"""

    def __init__(self, window: Any, locator: Locator):
        self._win = window
        self._loc = locator

    def _point(self) -> tuple[int, int]:
        x, y = self._loc.at or (0, 0)
        try:
            rect = self._win.rectangle()
            return rect.left + x, rect.top + y
        except Exception:  # noqa: BLE001
            return x, y

    def click(self, button: str = "left", double: bool = False) -> None:
        from pywinauto import mouse

        x, y = self._point()
        if double:
            mouse.double_click(button=button, coords=(x, y))
        else:
            mouse.click(button=button, coords=(x, y))

    def set_text(self, text: str) -> None:
        self.click()
        from pywinauto.keyboard import send_keys

        send_keys("^a{DELETE}" + _escape_keys(text), with_spaces=True, pause=0.02)

    def type_keys(self, text: str, *, clear: bool = False) -> None:
        self.click()
        from pywinauto.keyboard import send_keys

        send_keys(("^a{DELETE}" if clear else "") + _escape_keys(text), with_spaces=True, pause=0.02)

    def get_text(self) -> str:
        return ""

    def is_enabled(self) -> bool:
        return True

    def is_visible(self) -> bool:
        return True

    def set_check(self, checked: bool) -> None:
        self.click()

    def select_item(self, item: str) -> None:
        raise LocatorError("座標指定では一覧から選べません。部品を特定してください。", spec=self._loc)

    def select_tree_path(self, path: list[str]) -> None:
        raise LocatorError("座標指定ではツリーを選べません。部品を特定してください。", spec=self._loc)

    def select_row(self, value: str, column: str | None = None, double_click: bool = False) -> None:
        raise LocatorError("座標指定では表の行を選べません。部品を特定してください。", spec=self._loc)
