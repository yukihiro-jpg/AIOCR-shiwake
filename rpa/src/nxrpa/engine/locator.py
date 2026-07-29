"""画面部品（ボタン・入力欄・一覧など）の指定方法。

実機の画面構造が分からないうちは、ここを YAML で差し替えられることが
このツールの生命線になる。インスペクタ（`nxrpa inspect`）が吐く候補を
そのまま貼れる形にしてある。

指定の優先順位（安定する順）:
  1. auto_id     … 開発者が付けた識別子。画面のレイアウト変更に強い。最優先。
  2. name        … 表示名。日本語ラベルなので読みやすいが、文言変更で壊れる。
  3. class_name + index … 最後の手段。並び順が変わると壊れる。

座標クリック（`at`）はレイアウトのわずかな差で誤爆するため、
どうしても部品として掴めないときの逃げ道としてのみ許可する。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ..errors import ProfileError

# pywinauto の control_type に渡せる代表的な値（誤記を早期に落とすため）
KNOWN_CONTROL_TYPES = {
    "Button", "CheckBox", "ComboBox", "Custom", "DataGrid", "DataItem", "Document",
    "Edit", "Group", "Header", "HeaderItem", "Hyperlink", "Image", "List", "ListItem",
    "Menu", "MenuBar", "MenuItem", "Pane", "ProgressBar", "RadioButton", "ScrollBar",
    "Separator", "Slider", "Spinner", "SplitButton", "StatusBar", "Tab", "TabItem",
    "Table", "Text", "Thumb", "TitleBar", "ToolBar", "ToolTip", "Tree", "TreeItem",
    "Window",
}


@dataclass(frozen=True)
class Locator:
    """1つの画面部品の探し方。"""

    auto_id: str | None = None
    name: str | None = None
    name_re: str | None = None
    control_type: str | None = None
    class_name: str | None = None
    class_name_re: str | None = None
    index: int | None = None          # 同じ条件で複数見つかったときの何番目か（0 始まり）
    depth: int | None = None          # 探索の深さ制限。深い画面での探索を速くする
    visible_only: bool = True
    enabled_only: bool = False
    at: tuple[int, int] | None = None  # 逃げ道: ウィンドウ左上からの相対座標
    description: str = ""              # 人間向けの説明（ログに出る）

    # --- 生成 ---------------------------------------------------------
    @classmethod
    def parse(cls, raw: Any, *, where: str) -> "Locator":
        """YAML の target 節を Locator にする。

        文字列だけを書いた場合は表示名の指定として扱う（`target: "送信"`）。
        """
        if raw is None:
            raise ProfileError(f"{where}: target がありません")
        if isinstance(raw, str):
            return cls(name=raw, description=raw)
        if not isinstance(raw, dict):
            raise ProfileError(f"{where}: target は文字列かマッピングで書いてください。実際: {type(raw).__name__}")

        unknown = set(raw) - {
            "auto_id", "name", "title", "name_re", "title_re", "control_type", "class_name",
            "class_name_re", "index", "found_index", "depth", "visible_only", "enabled_only",
            "at", "description",
        }
        if unknown:
            raise ProfileError(
                f"{where}: target に不明な項目があります: {sorted(unknown)}。"
                f" 使えるのは auto_id / name / name_re / control_type / class_name /"
                f" class_name_re / index / depth / visible_only / enabled_only / at / description"
            )

        control_type = raw.get("control_type")
        if control_type is not None:
            control_type = str(control_type)
            if control_type not in KNOWN_CONTROL_TYPES:
                raise ProfileError(
                    f"{where}: control_type '{control_type}' は認識できません。"
                    f" 例: Button, Edit, ComboBox, List, ListItem, Tree, TreeItem, Table, Text, Pane"
                )

        at = raw.get("at")
        if at is not None:
            if not (isinstance(at, (list, tuple)) and len(at) == 2):
                raise ProfileError(f"{where}: at は [x, y] の2要素で書いてください。実際: {at!r}")
            at = (int(at[0]), int(at[1]))

        index = raw.get("index", raw.get("found_index"))
        loc = cls(
            auto_id=_opt_str(raw.get("auto_id")),
            name=_opt_str(raw.get("name", raw.get("title"))),
            name_re=_opt_str(raw.get("name_re", raw.get("title_re"))),
            control_type=control_type,
            class_name=_opt_str(raw.get("class_name")),
            class_name_re=_opt_str(raw.get("class_name_re")),
            index=int(index) if index is not None else None,
            depth=int(raw["depth"]) if raw.get("depth") is not None else None,
            visible_only=bool(raw.get("visible_only", True)),
            enabled_only=bool(raw.get("enabled_only", False)),
            at=at,
            description=str(raw.get("description") or ""),
        )
        if not loc.is_specified():
            raise ProfileError(
                f"{where}: target の条件が空です。auto_id / name / name_re /"
                f" control_type / class_name / at のいずれかを指定してください。"
            )
        return loc

    # --- 問い合わせ ---------------------------------------------------
    def is_specified(self) -> bool:
        return any(
            v is not None
            for v in (self.auto_id, self.name, self.name_re, self.control_type,
                      self.class_name, self.class_name_re, self.at)
        )

    def is_coordinate_only(self) -> bool:
        """座標指定だけで部品条件が無い（＝最後の手段）か。"""
        return self.at is not None and not any(
            v is not None
            for v in (self.auto_id, self.name, self.name_re, self.control_type,
                      self.class_name, self.class_name_re)
        )

    def to_kwargs(self) -> dict[str, Any]:
        """pywinauto の child_window() に渡す引数へ変換する。"""
        kw: dict[str, Any] = {}
        if self.auto_id is not None:
            kw["auto_id"] = self.auto_id
        if self.name is not None:
            kw["title"] = self.name
        if self.name_re is not None:
            kw["title_re"] = self.name_re
        if self.control_type is not None:
            kw["control_type"] = self.control_type
        if self.class_name is not None:
            kw["class_name"] = self.class_name
        if self.class_name_re is not None:
            kw["class_name_re"] = self.class_name_re
        if self.index is not None:
            kw["found_index"] = self.index
        if self.depth is not None:
            kw["depth"] = self.depth
        if self.visible_only is False:
            kw["visible_only"] = False
        if self.enabled_only:
            kw["enabled_only"] = True
        return kw

    def render(self, resolver) -> "Locator":
        """name / auto_id などに含まれるテンプレートを展開した複製を返す。"""
        from dataclasses import replace

        return replace(
            self,
            auto_id=resolver(self.auto_id) if self.auto_id else self.auto_id,
            name=resolver(self.name) if self.name else self.name,
            name_re=resolver(self.name_re) if self.name_re else self.name_re,
            description=resolver(self.description) if self.description else self.description,
        )

    def describe(self) -> str:
        """ログ・エラーメッセージ用の短い説明。"""
        if self.description:
            return self.description
        bits = []
        if self.auto_id:
            bits.append(f"auto_id={self.auto_id}")
        if self.name:
            bits.append(f"名前='{self.name}'")
        if self.name_re:
            bits.append(f"名前~/{self.name_re}/")
        if self.control_type:
            bits.append(self.control_type)
        if self.class_name:
            bits.append(f"class={self.class_name}")
        if self.index is not None:
            bits.append(f"[{self.index}]")
        if self.at:
            bits.append(f"座標{self.at}")
        return " ".join(bits) or "(条件なし)"

    def __str__(self) -> str:  # noqa: D105
        return self.describe()


def _opt_str(value: Any) -> str | None:
    return None if value is None else str(value)


@dataclass(frozen=True)
class WindowSpec:
    """ウィンドウ（画面）の探し方。"""

    key: str
    title: str | None = None
    title_re: str | None = None
    class_name: str | None = None
    control_type: str = "Window"
    timeout_sec: float | None = None
    description: str = ""

    @classmethod
    def parse(cls, key: str, raw: Any) -> "WindowSpec":
        where = f"windows.{key}"
        if isinstance(raw, str):
            return cls(key=key, title_re=raw, description=raw)
        if not isinstance(raw, dict):
            raise ProfileError(f"{where}: ウィンドウ定義は文字列かマッピングで書いてください")
        unknown = set(raw) - {
            "title", "name", "title_re", "name_re", "class_name", "control_type",
            "timeout_sec", "timeout", "description",
        }
        if unknown:
            raise ProfileError(f"{where}: 不明な項目があります: {sorted(unknown)}")
        spec = cls(
            key=key,
            title=_opt_str(raw.get("title", raw.get("name"))),
            title_re=_opt_str(raw.get("title_re", raw.get("name_re"))),
            class_name=_opt_str(raw.get("class_name")),
            control_type=str(raw.get("control_type") or "Window"),
            timeout_sec=float(raw["timeout_sec"]) if raw.get("timeout_sec") is not None
            else (float(raw["timeout"]) if raw.get("timeout") is not None else None),
            description=str(raw.get("description") or ""),
        )
        if not (spec.title or spec.title_re or spec.class_name):
            raise ProfileError(
                f"{where}: title / title_re / class_name のいずれかを指定してください"
            )
        return spec

    def to_kwargs(self) -> dict[str, Any]:
        kw: dict[str, Any] = {}
        if self.title is not None:
            kw["title"] = self.title
        if self.title_re is not None:
            kw["title_re"] = self.title_re
        if self.class_name is not None:
            kw["class_name"] = self.class_name
        return kw

    def describe(self) -> str:
        return self.description or self.title or self.title_re or self.class_name or self.key
