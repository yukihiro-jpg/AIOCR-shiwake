"""画面を触る層の抽象と、Windows を使わない模擬実装。

実機（pywinauto）実装は windows_backend.py にある。ここで抽象を切っておく理由:
  - 手順定義や保存先の組み立てを、Windows 無しで自動テストできる
  - `--mode simulate` で、実機に触らずプロファイルの通し確認ができる
    （顧問先の一括処理を始める前に、書式ミスや未定義フローを洗い出す用途）
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

from ..errors import LocatorError
from .locator import Locator, WindowSpec


@runtime_checkable
class Element(Protocol):
    """画面部品1つ。"""

    def click(self, button: str = "left", double: bool = False) -> None: ...
    def set_text(self, text: str) -> None: ...
    def type_keys(self, text: str, *, clear: bool = False) -> None: ...
    def get_text(self) -> str: ...
    def is_enabled(self) -> bool: ...
    def is_visible(self) -> bool: ...
    def set_check(self, checked: bool) -> None: ...
    def select_item(self, item: str) -> None: ...
    def select_tree_path(self, path: list[str]) -> None: ...
    def select_row(self, value: str, column: str | None = None, double_click: bool = False) -> None: ...


@runtime_checkable
class Backend(Protocol):
    """アプリ全体を触る入口。"""

    def start_app(self, key: str, exe: str, args: tuple[str, ...], timeout: float) -> None: ...
    def find_window(self, spec: WindowSpec, timeout: float): ...
    def window_exists(self, spec: WindowSpec, timeout: float) -> bool: ...
    def focus_window(self, spec: WindowSpec, timeout: float) -> None: ...
    def close_window(self, spec: WindowSpec, timeout: float) -> None: ...
    def maximize_window(self, spec: WindowSpec, timeout: float) -> None: ...
    def find(self, window: WindowSpec | None, locator: Locator, timeout: float) -> Element: ...
    def exists(self, window: WindowSpec | None, locator: Locator, timeout: float) -> bool: ...
    def send_keys(self, keys: str) -> None: ...
    def menu_select(self, window: WindowSpec, path: list[str], timeout: float) -> None: ...
    def wait_idle(self, window: WindowSpec | None, timeout: float) -> None: ...
    def screenshot(self, path: str, window: WindowSpec | None = None) -> str | None: ...


# ---------------------------------------------------------------------
# 模擬実装
# ---------------------------------------------------------------------

@dataclass
class FakeElement:
    """模擬の画面部品。操作の記録だけを行う。"""

    key: str
    text: str = ""
    enabled: bool = True
    visible: bool = True
    checked: bool = False
    log: list[tuple[str, Any]] = field(default_factory=list)
    on_set_text: Any = None   # 保存ダイアログを模すためのフック

    def click(self, button: str = "left", double: bool = False) -> None:
        self.log.append(("click", {"button": button, "double": double}))

    def set_text(self, text: str) -> None:
        self.text = text
        self.log.append(("set_text", text))
        if self.on_set_text is not None:
            self.on_set_text(text)

    def type_keys(self, text: str, *, clear: bool = False) -> None:
        self.text = text if clear else (self.text + text)
        self.log.append(("type_keys", {"clear": clear}))

    def get_text(self) -> str:
        return self.text

    def is_enabled(self) -> bool:
        return self.enabled

    def is_visible(self) -> bool:
        return self.visible

    def set_check(self, checked: bool) -> None:
        self.checked = checked
        self.log.append(("set_check", checked))

    def select_item(self, item: str) -> None:
        self.text = item
        self.log.append(("select_item", item))

    def select_tree_path(self, path: list[str]) -> None:
        self.log.append(("select_tree_path", list(path)))

    def select_row(self, value: str, column: str | None = None, double_click: bool = False) -> None:
        self.log.append(("select_row", {"value": value, "column": column, "double_click": double_click}))


@dataclass
class FakeBackend:
    """Windows 無しで動く模擬バックエンド。

    - すべての部品は「見つかる」ものとして扱う（`missing` に入れた条件は除く）
    - 呼び出しはすべて `calls` に記録され、テストから検証できる
    - `texts` に部品キーと文字列を入れておくと、assert_text / capture_text が使える
    """

    missing: set[str] = field(default_factory=set)
    texts: dict[str, str] = field(default_factory=dict)
    disabled: set[str] = field(default_factory=set)
    calls: list[tuple[str, Any]] = field(default_factory=list)
    elements: dict[str, FakeElement] = field(default_factory=dict)
    missing_windows: set[str] = field(default_factory=set)

    # 保存ダイアログにパスを打ち込んだら、実際にファイルを作ったことにする。
    # これを入れておくと、保存～出力確認～印刷までを Windows 無しで通せる。
    save_on_set_text: bool = False
    saved_bytes: int = 4096
    saved_paths: list[str] = field(default_factory=list)

    # --- ヘルパ -------------------------------------------------------
    @staticmethod
    def _key(window: WindowSpec | None, locator: Locator) -> str:
        prefix = window.key if window else "-"
        return f"{prefix}/{locator.auto_id or locator.name or locator.name_re or locator.class_name or locator.at}"

    def _element(self, key: str) -> FakeElement:
        el = self.elements.get(key)
        if el is None:
            el = FakeElement(
                key=key,
                text=self.texts.get(key, ""),
                enabled=key not in self.disabled,
                on_set_text=self._maybe_save,
            )
            self.elements[key] = el
        return el

    def _maybe_save(self, text: str) -> None:
        if not self.save_on_set_text or not text:
            return
        from pathlib import Path

        p = Path(text)
        if not p.suffix or not p.is_absolute():
            return
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"%PDF-1.4\n" + b"0" * self.saved_bytes)
        self.saved_paths.append(str(p))

    # --- Backend 実装 -------------------------------------------------
    def start_app(self, key: str, exe: str, args: tuple[str, ...], timeout: float) -> None:
        self.calls.append(("start_app", {"key": key, "exe": exe}))

    def find_window(self, spec: WindowSpec, timeout: float):
        self.calls.append(("find_window", spec.key))
        if spec.key in self.missing_windows:
            raise LocatorError(f"ウィンドウが見つかりません: {spec.describe()}", spec=spec)
        return spec

    def window_exists(self, spec: WindowSpec, timeout: float) -> bool:
        self.calls.append(("window_exists", spec.key))
        return spec.key not in self.missing_windows

    def focus_window(self, spec: WindowSpec, timeout: float) -> None:
        self.calls.append(("focus_window", spec.key))
        if spec.key in self.missing_windows:
            raise LocatorError(f"ウィンドウが見つかりません: {spec.describe()}", spec=spec)

    def close_window(self, spec: WindowSpec, timeout: float) -> None:
        self.calls.append(("close_window", spec.key))
        self.missing_windows.add(spec.key)

    def maximize_window(self, spec: WindowSpec, timeout: float) -> None:
        self.calls.append(("maximize_window", spec.key))

    def find(self, window: WindowSpec | None, locator: Locator, timeout: float) -> Element:
        key = self._key(window, locator)
        self.calls.append(("find", key))
        if key in self.missing:
            raise LocatorError(f"画面部品が見つかりません: {locator.describe()}", spec=locator)
        return self._element(key)

    def exists(self, window: WindowSpec | None, locator: Locator, timeout: float) -> bool:
        key = self._key(window, locator)
        self.calls.append(("exists", key))
        return key not in self.missing

    def send_keys(self, keys: str) -> None:
        self.calls.append(("send_keys", keys))

    def menu_select(self, window: WindowSpec, path: list[str], timeout: float) -> None:
        self.calls.append(("menu_select", {"window": window.key, "path": list(path)}))

    def wait_idle(self, window: WindowSpec | None, timeout: float) -> None:
        self.calls.append(("wait_idle", window.key if window else None))

    def screenshot(self, path: str, window: WindowSpec | None = None) -> str | None:
        self.calls.append(("screenshot", path))
        return None  # 模擬なので画像は作らない

    # --- テスト用 -----------------------------------------------------
    def calls_of(self, name: str) -> list[Any]:
        return [payload for called, payload in self.calls if called == name]
