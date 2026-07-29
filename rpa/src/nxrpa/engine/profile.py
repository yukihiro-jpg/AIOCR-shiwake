"""画面手順定義（config/profiles/*.yaml）の読み込みと検証。

実機を触る前に、書式ミス・未定義フロー・未定義ウィンドウ・不明なアクションを
すべてここで落とす。RPA は「途中まで動いて途中で止まる」のが一番たちが悪いので、
実行前に分かる間違いは実行前に落とし切る方針。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from ..errors import ProfileError
from .locator import Locator, WindowSpec


@dataclass(frozen=True)
class ActionSpec:
    """アクション1種類の仕様（検証用）。"""

    name: str
    needs_target: bool = False
    needs_window: bool = False
    required: tuple[str, ...] = ()
    optional: tuple[str, ...] = ()
    irreversible: bool = False
    never_retry: bool = False
    summary: str = ""


# 使えるアクションの一覧。ここに無いものはプロファイルに書けない。
ACTIONS: dict[str, ActionSpec] = {
    a.name: a
    for a in [
        # --- 制御 -----------------------------------------------------
        ActionSpec("run_flow", required=("flow",), optional=("with",),
                   summary="別のフローを呼び出す"),
        ActionSpec("for_each", required=("items", "as", "steps"),
                   summary="リストを順に処理する"),
        ActionSpec("set_var", required=("name", "value"), summary="変数を設定する"),
        ActionSpec("log", required=("message",), summary="ログに1行書く"),
        ActionSpec("sleep", required=("seconds",), summary="待つ"),
        ActionSpec("screenshot", optional=("label",), summary="画面を保存する"),
        ActionSpec("confirm", required=("message",), optional=("expect",), never_retry=True,
                   summary="人に確認を求めて止まる"),
        ActionSpec("irreversible", required=("description",), optional=("steps",),
                   irreversible=True, never_retry=True,
                   summary="取り消し不能な操作。練習モードではここで停止する"),
        ActionSpec("fail", required=("message",), never_retry=True,
                   summary="意図的に失敗させる（未設定の手順に置いておく番人）"),

        # --- ウィンドウ -----------------------------------------------
        ActionSpec("start_app", required=("app",), optional=("timeout",),
                   summary="アプリを起動する（起動済みなら接続のみ）"),
        ActionSpec("focus_window", needs_window=True, optional=("timeout",),
                   summary="ウィンドウを前面にする"),
        ActionSpec("wait_window", needs_window=True, optional=("timeout",),
                   summary="ウィンドウが出るまで待つ"),
        ActionSpec("wait_window_gone", needs_window=True, optional=("timeout",),
                   summary="ウィンドウが閉じるまで待つ"),
        ActionSpec("close_window", needs_window=True, summary="ウィンドウを閉じる"),
        ActionSpec("maximize_window", needs_window=True, summary="ウィンドウを最大化する"),
        ActionSpec("wait_idle", optional=("timeout", "seconds"),
                   summary="アプリの処理待ち（砂時計が消えるまで）"),

        # --- 入力 -----------------------------------------------------
        ActionSpec("click", needs_target=True, optional=("button", "double", "timeout"),
                   summary="クリックする"),
        ActionSpec("double_click", needs_target=True, optional=("timeout",),
                   summary="ダブルクリックする"),
        ActionSpec("right_click", needs_target=True, optional=("timeout",),
                   summary="右クリックする"),
        ActionSpec("set_text", needs_target=True, required=("text",), optional=("timeout",),
                   summary="入力欄に値を入れる（既存値を置き換え）"),
        ActionSpec("type_text", needs_target=True, required=("text",),
                   optional=("timeout", "clear"),
                   summary="入力欄にキー入力する"),
        ActionSpec("type_secret", needs_target=True, required=("secret",),
                   optional=("timeout", "clear"), never_retry=True,
                   summary="暗証番号を入力する（絶対にリトライしない）"),
        ActionSpec("press_keys", required=("keys",), optional=("timeout",),
                   summary="キーを送る（^s のような pywinauto 形式）"),
        ActionSpec("check", needs_target=True, optional=("timeout",), summary="チェックを入れる"),
        ActionSpec("uncheck", needs_target=True, optional=("timeout",), summary="チェックを外す"),
        ActionSpec("select_combo", needs_target=True, required=("item",), optional=("timeout",),
                   summary="コンボボックスから選ぶ"),
        ActionSpec("select_list_item", needs_target=True, required=("item",), optional=("timeout",),
                   summary="一覧から選ぶ"),
        ActionSpec("select_tree_item", needs_target=True, required=("path",), optional=("timeout",),
                   summary="ツリーの項目を選ぶ"),
        ActionSpec("select_grid_row", needs_target=True, required=("value",),
                   optional=("column", "timeout", "double_click"),
                   summary="表から値が一致する行を探して選ぶ"),
        ActionSpec("menu_select", needs_window=True, required=("path",),
                   summary="メニューをたどる（[ファイル, 印刷] の形）"),

        # --- 検証・取得 -----------------------------------------------
        ActionSpec("wait_for", needs_target=True, optional=("state", "timeout"),
                   summary="部品が出る/消える/押せるまで待つ"),
        ActionSpec("assert_exists", needs_target=True, optional=("timeout",), never_retry=True,
                   summary="部品があることを確かめる"),
        ActionSpec("assert_not_exists", needs_target=True, optional=("timeout",), never_retry=True,
                   summary="部品が無いことを確かめる"),
        ActionSpec("assert_text", needs_target=True, optional=("equals", "contains", "matches", "timeout"),
                   never_retry=True, summary="表示文字列を確かめる"),
        ActionSpec("capture_text", needs_target=True, required=("var",), optional=("timeout",),
                   summary="表示文字列を変数に取り込む（受付番号など）"),

        # --- ファイル・印刷 -------------------------------------------
        ActionSpec("save_dialog", required=("path",),
                   optional=("window", "filename_field", "save_button", "overwrite", "timeout"),
                   summary="「名前を付けて保存」に保存先を打ち込む"),
        ActionSpec("expect_file", required=("path",),
                   optional=("timeout", "min_bytes", "stable_sec"),
                   summary="ファイルが出来上がるまで待って確かめる"),
        ActionSpec("print_file", required=("path",), optional=("printer", "copies"),
                   summary="出来上がった PDF を印刷する"),
    ]
}


@dataclass(frozen=True)
class Condition:
    """ステップの実行条件。式は評価せず、単純な比較だけを扱う。"""

    var: str
    equals: Any = None
    not_equals: Any = None
    contains: str | None = None
    is_true: bool | None = None
    in_: tuple[Any, ...] | None = None

    @classmethod
    def parse(cls, raw: Any, *, where: str) -> "Condition":
        if not isinstance(raw, dict):
            raise ProfileError(f"{where}: when は マッピングで書いてください（例: {{var: doc.category, equals: local}}）")
        var = raw.get("var")
        if not var:
            raise ProfileError(f"{where}: when に var がありません")
        unknown = set(raw) - {"var", "equals", "not_equals", "contains", "is_true", "in"}
        if unknown:
            raise ProfileError(f"{where}: when に不明な項目があります: {sorted(unknown)}")
        in_raw = raw.get("in")
        return cls(
            var=str(var),
            equals=raw.get("equals"),
            not_equals=raw.get("not_equals"),
            contains=_opt_str(raw.get("contains")),
            is_true=raw.get("is_true"),
            in_=tuple(in_raw) if isinstance(in_raw, list) else None,
        )


@dataclass(frozen=True)
class Step:
    """1ステップ。"""

    action: str
    name: str = ""
    window: str | None = None
    target: Locator | None = None
    params: dict[str, Any] = field(default_factory=dict)
    timeout: float | None = None
    retry: int | None = None
    optional: bool = False        # 失敗しても次へ進む
    when: Condition | None = None
    unless: Condition | None = None
    source: str = ""              # 「flow=foo step#3」のような場所表示

    @property
    def spec(self) -> ActionSpec:
        return ACTIONS[self.action]

    @property
    def is_irreversible(self) -> bool:
        return self.spec.irreversible

    @property
    def never_retry(self) -> bool:
        return self.spec.never_retry

    def describe(self) -> str:
        if self.name:
            return self.name
        if self.target is not None:
            return f"{self.action} {self.target.describe()}"
        return self.action


@dataclass(frozen=True)
class Flow:
    """名前の付いた手順のまとまり。"""

    name: str
    steps: tuple[Step, ...]
    description: str = ""
    params: tuple[str, ...] = ()


@dataclass
class Profile:
    """1アプリ分の画面手順定義。"""

    name: str
    windows: dict[str, WindowSpec] = field(default_factory=dict)
    flows: dict[str, Flow] = field(default_factory=dict)
    vars: dict[str, Any] = field(default_factory=dict)
    source: Path | None = None
    version: int = 1

    def flow(self, name: str) -> Flow:
        try:
            return self.flows[name]
        except KeyError:
            raise ProfileError(
                f"フロー '{name}' が {self.source} にありません。"
                f" 定義済み: {', '.join(sorted(self.flows)) or '(なし)'}"
            ) from None

    def window(self, key: str) -> WindowSpec:
        try:
            return self.windows[key]
        except KeyError:
            raise ProfileError(
                f"ウィンドウ '{key}' が {self.source} の windows にありません。"
                f" 定義済み: {', '.join(sorted(self.windows)) or '(なし)'}"
            ) from None

    def has_flow(self, name: str) -> bool:
        return name in self.flows


# ---------------------------------------------------------------------

def _opt_str(v: Any) -> str | None:
    return None if v is None else str(v)


def load_profile(path: str | Path) -> Profile:
    p = Path(path)
    if not p.exists():
        raise ProfileError(
            f"画面手順定義が見つかりません: {p}\n"
            f"config/profiles/ に置いてください。ひな形は config/profiles/*.sample.yaml"
        )
    try:
        raw = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError as exc:
        raise ProfileError(f"画面手順定義の書式が不正です: {p}\n{exc}") from None
    if not isinstance(raw, dict):
        raise ProfileError(f"画面手順定義はマッピングで書いてください: {p}")

    windows: dict[str, WindowSpec] = {}
    for key, item in (raw.get("windows") or {}).items():
        windows[str(key)] = WindowSpec.parse(str(key), item)

    flows_raw = raw.get("flows") or {}
    if not isinstance(flows_raw, dict):
        raise ProfileError(f"{p}: flows はマッピングで書いてください")

    flows: dict[str, Flow] = {}
    for name, item in flows_raw.items():
        name = str(name)
        if isinstance(item, list):
            item = {"steps": item}
        if not isinstance(item, dict):
            raise ProfileError(f"{p}: flows.{name} はリストかマッピングで書いてください")
        steps_raw = item.get("steps")
        if steps_raw is None:
            raise ProfileError(f"{p}: flows.{name} に steps がありません")
        if not isinstance(steps_raw, list):
            raise ProfileError(f"{p}: flows.{name}.steps はリストで書いてください")
        params = item.get("params") or []
        if isinstance(params, str):
            params = [params]
        flows[name] = Flow(
            name=name,
            steps=tuple(_parse_steps(steps_raw, where=f"{p}: flows.{name}")),
            description=str(item.get("description") or ""),
            params=tuple(str(x) for x in params),
        )

    profile = Profile(
        name=str(raw.get("name") or p.stem),
        windows=windows,
        flows=flows,
        vars=dict(raw.get("vars") or {}),
        source=p,
        version=int(raw.get("version", 1) or 1),
    )
    _validate_references(profile)
    return profile


def _parse_steps(items: list[Any], *, where: str) -> list[Step]:
    steps: list[Step] = []
    for i, raw in enumerate(items):
        loc = f"{where} step#{i + 1}"
        if not isinstance(raw, dict):
            raise ProfileError(f"{loc}: ステップはマッピングで書いてください。実際: {type(raw).__name__}")

        action = raw.get("action")
        if not action:
            raise ProfileError(f"{loc}: action がありません")
        action = str(action)
        spec = ACTIONS.get(action)
        if spec is None:
            near = _suggest(action, ACTIONS)
            raise ProfileError(
                f"{loc}: 不明なアクション '{action}'。"
                + (f" もしかして: {near}" if near else "")
                + f"\n 使えるアクション: {', '.join(sorted(ACTIONS))}"
            )

        known = {"action", "name", "window", "target", "timeout", "retry", "optional", "when", "unless"}
        known |= set(spec.required) | set(spec.optional)
        unknown = set(raw) - known
        if unknown:
            raise ProfileError(
                f"{loc}（{action}）: 不明な項目があります: {sorted(unknown)}。"
                f" このアクションで使えるのは: {sorted(known)}"
            )

        missing = [k for k in spec.required if k not in raw]
        if missing:
            raise ProfileError(f"{loc}（{action}）: 必須項目がありません: {missing}（{spec.summary}）")

        target = None
        if "target" in raw and raw["target"] is not None:
            target = Locator.parse(raw["target"], where=loc)
        if spec.needs_target and target is None:
            raise ProfileError(f"{loc}（{action}）: target が必要です（{spec.summary}）")
        if spec.needs_window and not raw.get("window"):
            raise ProfileError(f"{loc}（{action}）: window が必要です（{spec.summary}）")

        params = {k: v for k, v in raw.items() if k in set(spec.required) | set(spec.optional)}

        # 入れ子ステップ（for_each / irreversible）を再帰的に解析
        if "steps" in params and params["steps"] is not None:
            if not isinstance(params["steps"], list):
                raise ProfileError(f"{loc}（{action}）: steps はリストで書いてください")
            params["steps"] = _parse_steps(params["steps"], where=f"{loc}>")

        retry = raw.get("retry")
        if retry is not None and spec.never_retry and int(retry) > 0:
            raise ProfileError(
                f"{loc}（{action}）: このアクションはリトライできません（retry は 0 のみ）。"
                f" 暗証番号の入力や取り消し不能な操作を再試行すると、"
                f" カードのロックや二重送信につながるためです。"
            )

        steps.append(
            Step(
                action=action,
                name=str(raw.get("name") or ""),
                window=_opt_str(raw.get("window")),
                target=target,
                params=params,
                timeout=float(raw["timeout"]) if raw.get("timeout") is not None else None,
                retry=int(retry) if retry is not None else None,
                optional=bool(raw.get("optional", False)),
                when=Condition.parse(raw["when"], where=loc) if raw.get("when") else None,
                unless=Condition.parse(raw["unless"], where=loc) if raw.get("unless") else None,
                source=loc,
            )
        )
    return steps


def _validate_references(profile: Profile) -> None:
    """フロー内の window / run_flow の参照先が実在するか確かめる。"""
    errors: list[str] = []

    def walk(steps: tuple[Step, ...] | list[Step]) -> None:
        for step in steps:
            if step.window and step.window not in profile.windows:
                errors.append(
                    f"{step.source}: window '{step.window}' が windows に未定義です"
                    f"（定義済み: {', '.join(sorted(profile.windows)) or 'なし'}）"
                )
            win_param = step.params.get("window")
            if isinstance(win_param, str) and win_param and win_param not in profile.windows:
                errors.append(f"{step.source}: window '{win_param}' が windows に未定義です")
            if step.action == "run_flow":
                target_flow = str(step.params.get("flow"))
                # 変数で切り替えるフロー名（{...} を含む）は実行時にしか決まらない
                if "{" not in target_flow and target_flow not in profile.flows:
                    errors.append(
                        f"{step.source}: フロー '{target_flow}' が未定義です"
                        f"（定義済み: {', '.join(sorted(profile.flows))}）"
                    )
            nested = step.params.get("steps")
            if isinstance(nested, list):
                walk(nested)

    for flow in profile.flows.values():
        walk(flow.steps)

    _check_cycles(profile, errors)

    if errors:
        raise ProfileError(
            f"画面手順定義に誤りがあります（{profile.source}）:\n  - " + "\n  - ".join(errors)
        )


def _check_cycles(profile: Profile, errors: list[str]) -> None:
    """run_flow の循環参照を検出する（無限ループで固まるのを防ぐ）。"""
    graph: dict[str, set[str]] = {}

    def collect(name: str, steps) -> None:
        for step in steps:
            if step.action == "run_flow":
                t = str(step.params.get("flow"))
                if "{" not in t:
                    graph.setdefault(name, set()).add(t)
            nested = step.params.get("steps")
            if isinstance(nested, list):
                collect(name, nested)

    for flow in profile.flows.values():
        collect(flow.name, flow.steps)

    visiting: set[str] = set()
    done: set[str] = set()

    def visit(node: str, path: list[str]) -> None:
        if node in visiting:
            errors.append(f"フローが循環しています: {' -> '.join(path + [node])}")
            return
        if node in done:
            return
        visiting.add(node)
        for nxt in sorted(graph.get(node, ())):
            if nxt in profile.flows:
                visit(nxt, path + [node])
        visiting.discard(node)
        done.add(node)

    for name in sorted(graph):
        visit(name, [])


def _suggest(word: str, candidates) -> str:
    import difflib

    hits = difflib.get_close_matches(word, list(candidates), n=3, cutoff=0.6)
    return ", ".join(hits)
