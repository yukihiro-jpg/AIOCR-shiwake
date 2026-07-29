"""ステップ実行エンジン。

方針:
- 失敗はできるだけ「どのステップの、どの部品で、何を探して、何秒待って駄目だったか」まで
  出す。RPA の運用コストの大半は原因調査なので、そこに投資する。
- リトライは一律ではない。暗証番号の入力と取り消し不能な操作は**絶対に再試行しない**。
- 練習モード（rehearsal）では、取り消し不能な操作の手前で必ず止まる。
  「うっかり本番送信」を設定ミスで起こさないため、既定を練習モードにしてある。
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Protocol

from ..audit import RunLog, ScreenshotStore
from ..config import MODE_LIVE, MODE_REHEARSAL, MODE_SIMULATE, Settings
from ..errors import (
    AbortRun,
    AssertionFailed,
    ConfigError,
    ConfirmationDeclined,
    LocatorError,
    PinError,
    ProfileError,
    RpaError,
    StepFailed,
    SubmitBlocked,
)
from ..secrets import SecretVault
from ..templating import render
from .locator import Locator, WindowSpec
from .profile import Condition, Profile, Step


class Confirmer(Protocol):
    """人に確認を求める窓口。CLI と GUI で実装が変わる。"""

    def confirm(self, message: str, *, expect: str | None = None, danger: bool = False) -> bool: ...


class AutoConfirmer:
    """確認を自動で通す（simulate モード・テスト用）。"""

    def __init__(self, answer: bool = True):
        self.answer = answer
        self.asked: list[str] = []

    def confirm(self, message: str, *, expect: str | None = None, danger: bool = False) -> bool:
        self.asked.append(message)
        return self.answer


class ConsoleConfirmer:
    """コンソールで確認する。"""

    def confirm(self, message: str, *, expect: str | None = None, danger: bool = False) -> bool:
        bar = "!" * 68 if danger else "-" * 68
        print(f"\n{bar}\n{message}\n{bar}")
        if expect:
            print(f"続行するには次の文字を正確に入力してください: {expect}")
            typed = input("> ").strip()
            if typed != expect:
                print(f"入力が一致しません（入力: '{typed}'）。中止します。")
                return False
            return True
        answer = input("続行しますか？ [y/N] > ").strip().lower()
        return answer in ("y", "yes")


@dataclass
class RunContext:
    """1回の実行で持ち回す状態。"""

    settings: Settings
    profile: Profile
    backend: Any
    log: RunLog
    vault: SecretVault
    shots: ScreenshotStore
    confirmer: Confirmer
    vars: dict[str, Any] = field(default_factory=dict)
    produced_files: list[dict[str, Any]] = field(default_factory=list)
    submitted: list[dict[str, Any]] = field(default_factory=list)
    blocked: list[str] = field(default_factory=list)

    @property
    def mode(self) -> str:
        return self.settings.run.mode

    @property
    def is_simulate(self) -> bool:
        return self.mode == MODE_SIMULATE

    @property
    def is_live(self) -> bool:
        return self.mode == MODE_LIVE

    def render(self, value: Any, *, where: str = "", strict: bool = True) -> Any:
        """文字列・リスト・辞書の中のテンプレートを再帰的に展開する。"""
        if isinstance(value, str):
            return render(value, self.vars, where=where, strict=strict)
        if isinstance(value, list):
            return [self.render(v, where=where, strict=strict) for v in value]
        if isinstance(value, dict):
            return {k: self.render(v, where=where, strict=strict) for k, v in value.items()}
        return value

    def lookup(self, path: str) -> Any:
        cur: Any = self.vars
        for part in str(path).split("."):
            if isinstance(cur, dict):
                if part not in cur:
                    return None
                cur = cur[part]
            else:
                cur = getattr(cur, part, None)
            if cur is None:
                return None
        return cur

    def set_var(self, path: str, value: Any) -> None:
        parts = str(path).split(".")
        cur = self.vars
        for part in parts[:-1]:
            nxt = cur.get(part)
            if not isinstance(nxt, dict):
                nxt = {}
                cur[part] = nxt
            cur = nxt
        cur[parts[-1]] = value


class Runner:
    """フローとステップを実行する。"""

    def __init__(self, ctx: RunContext):
        self.ctx = ctx
        self._flow_depth = 0
        self._handlers: dict[str, Callable[[Step], None]] = {
            "run_flow": self._do_run_flow,
            "for_each": self._do_for_each,
            "set_var": self._do_set_var,
            "log": self._do_log,
            "sleep": self._do_sleep,
            "screenshot": self._do_screenshot,
            "confirm": self._do_confirm,
            "irreversible": self._do_irreversible,
            "fail": self._do_fail,
            "start_app": self._do_start_app,
            "focus_window": self._do_focus_window,
            "wait_window": self._do_wait_window,
            "wait_window_gone": self._do_wait_window_gone,
            "close_window": self._do_close_window,
            "maximize_window": self._do_maximize_window,
            "wait_idle": self._do_wait_idle,
            "click": self._do_click,
            "double_click": self._do_double_click,
            "right_click": self._do_right_click,
            "set_text": self._do_set_text,
            "type_text": self._do_type_text,
            "type_secret": self._do_type_secret,
            "press_keys": self._do_press_keys,
            "check": lambda s: self._do_check(s, True),
            "uncheck": lambda s: self._do_check(s, False),
            "select_combo": self._do_select_combo,
            "select_list_item": self._do_select_list_item,
            "select_tree_item": self._do_select_tree_item,
            "select_grid_row": self._do_select_grid_row,
            "menu_select": self._do_menu_select,
            "wait_for": self._do_wait_for,
            "assert_exists": self._do_assert_exists,
            "assert_not_exists": self._do_assert_not_exists,
            "assert_text": self._do_assert_text,
            "capture_text": self._do_capture_text,
            "save_dialog": self._do_save_dialog,
            "expect_file": self._do_expect_file,
            "print_file": self._do_print_file,
        }

    # -----------------------------------------------------------------
    # フロー
    # -----------------------------------------------------------------
    def run_flow(self, name: str, params: dict[str, Any] | None = None) -> None:
        if self._flow_depth > 20:
            raise ProfileError(f"フローの入れ子が深すぎます（{name}）。循環していないか確認してください。")
        flow = self.ctx.profile.flow(name)

        missing = [p for p in flow.params if self.ctx.lookup(p) is None and p not in (params or {})]
        if missing:
            raise ProfileError(
                f"フロー '{name}' に必要な変数がありません: {missing}"
                f"（flows.{name}.params で宣言されています）"
            )

        saved = None
        if params:
            saved = {k: self.ctx.lookup(k) for k in params}
            for k, v in params.items():
                self.ctx.set_var(k, v)

        self.ctx.log.event("flow_start", message=f"▶ フロー開始: {name}",
                           flow=name, description=flow.description)
        self._flow_depth += 1
        try:
            self.run_steps(flow.steps)
        finally:
            self._flow_depth -= 1
            if saved is not None:
                for k, v in saved.items():
                    self.ctx.set_var(k, v)
            self.ctx.log.event("flow_end", message=f"■ フロー終了: {name}", flow=name)

    def run_steps(self, steps) -> None:
        for step in steps:
            self.run_step(step)

    # -----------------------------------------------------------------
    # ステップ
    # -----------------------------------------------------------------
    def run_step(self, step: Step) -> None:
        if not self._should_run(step):
            self.ctx.log.event("step_skip", level="debug",
                               message=f"– 条件により省略: {step.describe()}", step=step.source)
            return

        run = self.ctx.settings.run
        max_attempts = 1 if step.never_retry else (step.retry if step.retry is not None else run.retry) + 1
        timeout = step.timeout if step.timeout is not None else run.step_timeout_sec

        started = time.monotonic()
        last_error: Exception | None = None
        attempt = 0

        for attempt in range(1, max_attempts + 1):
            try:
                self.ctx.log.event(
                    "step", level="debug",
                    message=f"  {step.describe()}",
                    action=step.action, step=step.source,
                    attempt=attempt if attempt > 1 else None,
                )
                self._current_timeout = timeout
                self._handlers[step.action](step)
                if run.screenshot_every_step and not self.ctx.is_simulate:
                    self._capture(f"{step.action}")
                # 間を置くのは人が目で追えるようにするため。画面が無い検証モードでは不要
                if run.step_pause_sec and not self.ctx.is_simulate:
                    time.sleep(run.step_pause_sec)
                return
            except AbortRun:
                raise  # 中断系はリトライも省略もしない
            except (LocatorError, StepFailed, RpaError, OSError) as exc:
                last_error = exc
                # 設定・手順定義の誤りは何度やっても同じ結果になる。
                # 待たせるだけ無駄なので、その場で諦めて原因を出す。
                deterministic = isinstance(exc, (ConfigError, ProfileError, AssertionFailed))
                if deterministic or attempt >= max_attempts:
                    break
                self.ctx.log.warn(
                    f"  再試行 {attempt}/{max_attempts - 1}: {step.describe()} — {exc}",
                    step=step.source,
                )
                time.sleep(run.retry_wait_sec * attempt)

        elapsed = time.monotonic() - started
        shot = self._capture(f"error_{step.action}") if run.screenshot_on_error else None

        if step.optional:
            self.ctx.log.warn(
                f"  省略可のため続行: {step.describe()} — {last_error}",
                step=step.source, screenshot=shot,
            )
            return

        # 「画面が想定と違う」は「押せなかった」とは意味が違う。
        # 呼び出し側が区別できるよう、検証失敗は型を保ったまま投げ直す。
        if isinstance(last_error, AssertionFailed):
            last_error.step = step
            last_error.screenshot = shot
            raise last_error

        raise StepFailed(
            f"ステップ失敗: {step.describe()}\n"
            f"  場所   : {step.source}\n"
            f"  操作   : {step.action}\n"
            f"  経過   : {elapsed:.1f}秒 / 試行 {attempt}回\n"
            f"  原因   : {last_error}"
            + (f"\n  画面   : {shot}" if shot else ""),
            step=step, screenshot=shot,
        )

    # -----------------------------------------------------------------
    # 条件
    # -----------------------------------------------------------------
    def _should_run(self, step: Step) -> bool:
        if step.when is not None and not self._eval(step.when):
            return False
        if step.unless is not None and self._eval(step.unless):
            return False
        return True

    def _eval(self, cond: Condition) -> bool:
        value = self.ctx.lookup(cond.var)
        if cond.is_true is not None:
            return bool(value) is bool(cond.is_true)
        if cond.equals is not None:
            return _same(value, cond.equals)
        if cond.not_equals is not None:
            return not _same(value, cond.not_equals)
        if cond.contains is not None:
            return cond.contains in str(value or "")
        if cond.in_ is not None:
            return any(_same(value, x) for x in cond.in_)
        return bool(value)

    # -----------------------------------------------------------------
    # 共通ヘルパ
    # -----------------------------------------------------------------
    def _window(self, key: str | None) -> WindowSpec | None:
        if not key:
            return None
        return self.ctx.profile.window(key)

    def _locator(self, step: Step) -> Locator:
        assert step.target is not None
        return step.target.render(lambda s: self.ctx.render(s, where=step.source))

    def _param(self, step: Step, key: str, default: Any = None) -> Any:
        if key not in step.params:
            return default
        return self.ctx.render(step.params[key], where=f"{step.source}.{key}")

    def _timeout(self, step: Step, key: str = "timeout") -> float:
        raw = step.params.get(key)
        if raw is not None:
            return float(raw)
        if step.timeout is not None:
            return float(step.timeout)
        return float(self.ctx.settings.run.step_timeout_sec)

    def _find(self, step: Step):
        loc = self._locator(step)
        win = self._window(step.window)
        return self.ctx.backend.find(win, loc, self._timeout(step))

    def _capture(self, label: str) -> str | None:
        try:
            path = self.ctx.shots.path_for(label)
            return self.ctx.backend.screenshot(str(path))
        except Exception:  # noqa: BLE001
            return None

    # -----------------------------------------------------------------
    # 制御系アクション
    # -----------------------------------------------------------------
    def _do_run_flow(self, step: Step) -> None:
        name = str(self._param(step, "flow"))
        params = self._param(step, "with", {}) or {}
        if not isinstance(params, dict):
            raise ProfileError(f"{step.source}: with はマッピングで書いてください")
        self.run_flow(name, params)

    def _do_for_each(self, step: Step) -> None:
        raw_items = step.params.get("items")
        if isinstance(raw_items, str):
            items = self.ctx.lookup(raw_items.strip("{} "))
            if items is None:
                raise ProfileError(
                    f"{step.source}: items '{raw_items}' に対応する変数がありません。"
                    f" 使える変数: {sorted(self.ctx.vars)}"
                )
        else:
            items = raw_items
        if not isinstance(items, (list, tuple)):
            raise ProfileError(f"{step.source}: items がリストではありません: {type(items).__name__}")

        alias = str(step.params["as"])
        saved = self.ctx.lookup(alias)
        total = len(items)
        try:
            for i, item in enumerate(items, start=1):
                self.ctx.set_var(alias, item)
                self.ctx.set_var("loop", {"index": i, "total": total, "first": i == 1, "last": i == total})
                self.ctx.log.event(
                    "loop", level="debug",
                    message=f"  ({i}/{total}) {alias}={_short(item)}", step=step.source,
                )
                self.run_steps(step.params["steps"])
        finally:
            if saved is not None:
                self.ctx.set_var(alias, saved)

    def _do_set_var(self, step: Step) -> None:
        self.ctx.set_var(str(step.params["name"]), self._param(step, "value"))

    def _do_log(self, step: Step) -> None:
        self.ctx.log.info(str(self._param(step, "message")))

    def _do_sleep(self, step: Step) -> None:
        seconds = float(self._param(step, "seconds", 0) or 0)
        if self.ctx.is_simulate:
            return
        time.sleep(max(0.0, min(seconds, 300.0)))

    def _do_screenshot(self, step: Step) -> None:
        if self.ctx.is_simulate:
            return
        label = str(self._param(step, "label", "shot") or "shot")
        path = self._capture(label)
        if path:
            self.ctx.log.info(f"  画面を保存: {path}")

    def _do_confirm(self, step: Step) -> None:
        message = str(self._param(step, "message"))
        expect = self._param(step, "expect")
        if self.ctx.is_simulate:
            self.ctx.log.info(f"  [検証モード] 確認を省略: {message}")
            return
        ok = self.ctx.confirmer.confirm(message, expect=str(expect) if expect else None)
        if not ok:
            raise ConfirmationDeclined(f"利用者が中止しました: {message}")

    def _do_fail(self, step: Step) -> None:
        raise AbortRun(str(self._param(step, "message")))

    def _do_irreversible(self, step: Step) -> None:
        """取り消し不能な操作（＝実際の送信）の関門。

        練習モード: ここで止める。手前までの操作は済んでいるので、
                   画面を見れば「あとは送信を押すだけ」の状態を確認できる。
        本番モード: 確認を取ってから中の steps を実行する。
        """
        description = str(self._param(step, "description"))
        client = self.ctx.lookup("client.name") or ""
        code = self.ctx.lookup("client.code") or ""

        if not self.ctx.is_live:
            self.ctx.log.warn(
                f"  ⏸ 取り消し不能な操作の直前で停止しました（{self.ctx.mode} モード）: {description}"
            )
            self.ctx.blocked.append(description)
            self._capture("before_submit")
            raise SubmitBlocked(
                f"練習モードのため送信しませんでした: {description}\n"
                f"実際に送信するには --mode live を付けて実行してください。"
            )

        if self.ctx.settings.run.confirm_before_submit:
            ok = self.ctx.confirmer.confirm(
                f"【本番送信】これから取り消しのできない操作を行います。\n"
                f"  顧問先 : {code} {client}\n"
                f"  操作   : {description}\n"
                f"送信後は取り消せません。内容を画面で確認してください。",
                expect=str(client) if client else None,
                danger=True,
            )
            if not ok:
                raise ConfirmationDeclined(f"利用者が送信を中止しました: {description}")

        self._capture("before_submit")
        self.ctx.log.event(
            "submit", level="warn",
            message=f"  ★ 送信を実行します: {description}",
            client_code=code, client_name=client,
        )
        nested = step.params.get("steps") or []
        try:
            self.run_steps(nested)
        except AbortRun:
            raise
        except Exception as exc:  # noqa: BLE001
            # 送信中の失敗は、送信できたのかどうかが不明な最も危険な状態。
            # 自動で復旧を試みず、必ず人が画面を確認する。
            shot = self._capture("submit_failed")
            raise AbortRun(
                f"送信操作の途中で失敗しました: {description}\n"
                f"  原因: {exc}\n"
                f"  送信できたかどうかが不明です。**自動での再実行はしません。**\n"
                f"  e-Tax / eLTAX のメッセージボックスで送信済みかを必ず目視で確認してください。"
                + (f"\n  画面: {shot}" if shot else "")
            ) from exc

        self.ctx.submitted.append({"description": description, "client_code": code, "client_name": client})
        self.ctx.log.event("submit_done", message=f"  ✓ 送信しました: {description}",
                           client_code=code, client_name=client)

    # -----------------------------------------------------------------
    # ウィンドウ系
    # -----------------------------------------------------------------
    def _do_start_app(self, step: Step) -> None:
        key = str(self._param(step, "app"))
        app = self.ctx.settings.apps.get(key)
        if app is None:
            raise ProfileError(f"{step.source}: アプリ '{key}' が settings.yaml の apps にありません")
        timeout = float(self._param(step, "timeout", app.start_timeout_sec) or app.start_timeout_sec)
        self.ctx.backend.start_app(key, app.exe, app.args, timeout)

    def _do_focus_window(self, step: Step) -> None:
        win = self._window(step.window)
        self.ctx.backend.focus_window(win, self._window_timeout(step, win))

    def _do_wait_window(self, step: Step) -> None:
        win = self._window(step.window)
        self.ctx.backend.find_window(win, self._window_timeout(step, win))

    def _do_wait_window_gone(self, step: Step) -> None:
        if self._skip_in_simulate(step):
            return
        win = self._window(step.window)
        timeout = self._window_timeout(step, win)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if not self.ctx.backend.window_exists(win, 1.0):
                return
            time.sleep(0.5)
        raise StepFailed(f"ウィンドウが閉じません: {win.describe()}（{timeout:.0f}秒待ちました）", step=step)

    def _do_close_window(self, step: Step) -> None:
        win = self._window(step.window)
        self.ctx.backend.close_window(win, self._window_timeout(step, win))

    def _do_maximize_window(self, step: Step) -> None:
        win = self._window(step.window)
        self.ctx.backend.maximize_window(win, self._window_timeout(step, win))

    def _do_wait_idle(self, step: Step) -> None:
        if self.ctx.is_simulate:
            return
        timeout = float(self._param(step, "timeout", self.ctx.settings.run.window_timeout_sec))
        self.ctx.backend.wait_idle(self._window(step.window), timeout)

    def _window_timeout(self, step: Step, win: WindowSpec | None) -> float:
        if step.params.get("timeout") is not None:
            return float(step.params["timeout"])
        if step.timeout is not None:
            return float(step.timeout)
        if win is not None and win.timeout_sec is not None:
            return float(win.timeout_sec)
        return float(self.ctx.settings.run.window_timeout_sec)

    # -----------------------------------------------------------------
    # 入力系
    # -----------------------------------------------------------------
    def _do_click(self, step: Step) -> None:
        el = self._find(step)
        el.click(button=str(self._param(step, "button", "left")),
                 double=bool(self._param(step, "double", False)))

    def _do_double_click(self, step: Step) -> None:
        self._find(step).click(double=True)

    def _do_right_click(self, step: Step) -> None:
        self._find(step).click(button="right")

    def _do_set_text(self, step: Step) -> None:
        self._find(step).set_text(str(self._param(step, "text", "")))

    def _do_type_text(self, step: Step) -> None:
        self._find(step).type_keys(str(self._param(step, "text", "")),
                                   clear=bool(self._param(step, "clear", False)))

    def _do_type_secret(self, step: Step) -> None:
        """暗証番号の入力。**絶対にリトライしない。**

        カードは規定回数の誤入力でロックされる。ここで自動再試行を許すと、
        画面の取り違えなどで一気に残り回数を使い切ってしまう。
        """
        name = str(step.params["secret"])
        # 検証モードは設定の確かめが目的。カードを挿して暗証番号を入れる必要はない。
        if self.ctx.is_simulate:
            self.ctx.log.info("  [検証モード] 暗証番号の入力を省略")
            return
        if not self.ctx.vault.has(name):
            raise PinError(
                f"暗証番号 '{name}' が未入力です。アプリ起動時の入力画面で入力してください。"
            )

        # 入力欄が見つからない＝画面が想定と違う。ここで打ち込むと、別の欄へ
        # 暗証番号を入れてしまいかねない。探索の失敗も PinError にして即座に止める。
        try:
            el = self._find(step)
        except (LocatorError, StepFailed) as exc:
            raise PinError(
                f"暗証番号の入力欄が見つかりません（{step.describe()}）。\n"
                f"  原因: {exc}\n"
                f"  画面が想定と違います。**自動では再試行しません。**\n"
                f"  誤った欄へ暗証番号を入力する事故を避けるため、ここで停止します。"
            ) from exc

        secret = self.ctx.vault.get(name)
        try:
            el.type_keys(secret.reveal(), clear=bool(self._param(step, "clear", True)))
        except Exception as exc:  # noqa: BLE001
            raise PinError(
                f"暗証番号を入力できませんでした（{step.describe()}）。\n"
                f"  原因: {exc}\n"
                f"  **カードのロックを避けるため自動では再試行しません。**\n"
                f"  画面を確認し、必要なら手で入力してからやり直してください。"
            ) from exc
        self.ctx.log.info("  暗証番号を入力しました（内容は記録しません）")

    def _do_press_keys(self, step: Step) -> None:
        # `{ENTER}` `{TAB}` などは pywinauto のキー記法で、差し込みではない。
        # 解決できない波かっこはそのまま残す（strict=False）。
        keys = self.ctx.render(
            step.params.get("keys", ""), where=f"{step.source}.keys", strict=False
        )
        self.ctx.backend.send_keys(str(keys))

    def _do_check(self, step: Step, checked: bool) -> None:
        self._find(step).set_check(checked)

    def _do_select_combo(self, step: Step) -> None:
        self._find(step).select_item(str(self._param(step, "item")))

    def _do_select_list_item(self, step: Step) -> None:
        self._find(step).select_item(str(self._param(step, "item")))

    def _do_select_tree_item(self, step: Step) -> None:
        path = self._param(step, "path")
        if isinstance(path, str):
            path = [p for p in re.split(r"[>/\\]", path) if p.strip()]
        self._find(step).select_tree_path([str(p).strip() for p in path])

    def _do_select_grid_row(self, step: Step) -> None:
        self._find(step).select_row(
            str(self._param(step, "value")),
            column=self._param(step, "column"),
            double_click=bool(self._param(step, "double_click", False)),
        )

    def _do_menu_select(self, step: Step) -> None:
        path = self._param(step, "path")
        if isinstance(path, str):
            path = [p for p in re.split(r"[>]|->", path) if p.strip()]
        win = self._window(step.window)
        self.ctx.backend.menu_select(win, [str(p).strip() for p in path], self._timeout(step))

    # -----------------------------------------------------------------
    # 検証・取得
    # -----------------------------------------------------------------
    def _do_wait_for(self, step: Step) -> None:
        if self._skip_in_simulate(step):
            return
        state = str(self._param(step, "state", "exists"))
        timeout = self._timeout(step)
        loc = self._locator(step)
        win = self._window(step.window)
        deadline = time.monotonic() + timeout

        while True:
            if state == "gone":
                if not self.ctx.backend.exists(win, loc, 1.0):
                    return
            else:
                try:
                    el = self.ctx.backend.find(win, loc, 1.0)
                    if state == "exists":
                        return
                    if state == "enabled" and el.is_enabled():
                        return
                    if state == "visible" and el.is_visible():
                        return
                except LocatorError:
                    pass
            if time.monotonic() >= deadline:
                break
            time.sleep(0.4)

        raise StepFailed(
            f"待っても状態になりません（{state}）: {loc.describe()}（{timeout:.0f}秒）", step=step
        )

    def _skip_in_simulate(self, step: Step) -> bool:
        """検証モードでは、画面の中身に対する検査は成立しないので飛ばす。

        検証モードは「画面を触らずに、設定と手順の整合を確かめる」ためのもの。
        実画面が無い以上、表示内容の一致は判定できない。ここを無理に判定させると
        「検証モードでは必ず失敗する」ことになり、検証そのものが使えなくなる。
        画面の中身の確認は練習モード（実機）で行う。
        """
        if not self.ctx.is_simulate:
            return False
        self.ctx.log.event(
            "step_skip", level="debug",
            message=f"  [検証モード] 画面の確認を省略: {step.describe()}", step=step.source,
        )
        return True

    def _do_assert_exists(self, step: Step) -> None:
        if self._skip_in_simulate(step):
            return
        loc = self._locator(step)
        if not self.ctx.backend.exists(self._window(step.window), loc, self._timeout(step)):
            raise AssertionFailed(
                f"あるはずの部品がありません: {loc.describe()}\n"
                f"  画面が想定と違います。手順定義（{step.source}）か実機の状態を確認してください。",
                step=step,
            )

    def _do_assert_not_exists(self, step: Step) -> None:
        if self._skip_in_simulate(step):
            return
        loc = self._locator(step)
        # 「無いこと」の確認は待つ必要がないので短めに見る
        timeout = min(self._timeout(step), 5.0)
        if self.ctx.backend.exists(self._window(step.window), loc, timeout):
            raise AssertionFailed(
                f"あってはならない部品があります: {loc.describe()}\n"
                f"  エラーダイアログが出ていないか、画面を確認してください。",
                step=step,
            )

    def _do_assert_text(self, step: Step) -> None:
        if self._skip_in_simulate(step):
            return
        el = self._find(step)
        actual = (el.get_text() or "").strip()
        equals = self._param(step, "equals")
        contains = self._param(step, "contains")
        matches = self._param(step, "matches")

        if equals is not None and actual != str(equals):
            raise AssertionFailed(
                f"表示内容が一致しません。期待: '{equals}' / 実際: '{actual}'", step=step
            )
        if contains is not None and str(contains) not in actual:
            raise AssertionFailed(
                f"表示内容に '{contains}' が含まれません。実際: '{actual}'", step=step
            )
        if matches is not None and not re.search(str(matches), actual):
            raise AssertionFailed(
                f"表示内容が /{matches}/ に一致しません。実際: '{actual}'", step=step
            )
        if equals is None and contains is None and matches is None:
            raise ProfileError(
                f"{step.source}: assert_text には equals / contains / matches のいずれかが必要です"
            )

    def _do_capture_text(self, step: Step) -> None:
        name = str(step.params["var"])
        if self.ctx.is_simulate:
            # 取り込んだ値を後続で差し込む手順（受付番号で受信通知を探す等）が
            # 未定義参照で落ちないよう、目印になる仮の値を入れておく。
            self.ctx.set_var(name, f"(検証モード:{name})")
            self.ctx.log.event("step_skip", level="debug",
                               message=f"  [検証モード] 取得を省略: {name}", step=step.source)
            return
        el = self._find(step)
        value = (el.get_text() or "").strip()
        self.ctx.set_var(name, value)
        self.ctx.log.info(f"  取得: {name} = {value}")

    # -----------------------------------------------------------------
    # ファイル・印刷
    # -----------------------------------------------------------------
    def _do_save_dialog(self, step: Step) -> None:
        """Windows 標準の「名前を付けて保存」に、フルパスを打ち込んで保存する。

        フォルダとファイル名を別々に操作せず、ファイル名欄にフルパスを入れる。
        こちらの方がフォルダツリーの状態に左右されず安定する。
        """
        path = Path(str(self._param(step, "path")))
        if self.ctx.is_simulate:
            self.ctx.log.info(f"  [検証モード] 保存先: {path}")
            return

        if self.ctx.settings.paths.create_folders:
            path.parent.mkdir(parents=True, exist_ok=True)

        win_key = step.params.get("window") or "save_dialog"
        win = self._window(str(win_key))
        timeout = self._timeout(step)
        self.ctx.backend.find_window(win, timeout)

        field_spec = step.params.get("filename_field") or {"control_type": "Edit", "index": 0}
        field_loc = Locator.parse(field_spec, where=f"{step.source}.filename_field")
        el = self.ctx.backend.find(win, field_loc, timeout)
        el.set_text(str(path))

        button_spec = step.params.get("save_button") or {"name": "保存(S)", "control_type": "Button"}
        button_loc = Locator.parse(button_spec, where=f"{step.source}.save_button")
        try:
            self.ctx.backend.find(win, button_loc, timeout).click()
        except LocatorError:
            # ボタン名は OS の言語・版で揺れるので Enter に落とす
            self.ctx.backend.send_keys("{ENTER}")

        # 上書き確認が出たら、設定に従って答える
        overwrite = bool(self._param(step, "overwrite", True))
        confirm_loc = Locator.parse(
            {"name_re": ".*(置き換|上書き|既に存在).*", "control_type": "Window"},
            where=f"{step.source}.overwrite",
        )
        if self.ctx.backend.exists(None, confirm_loc, 2.0):
            self.ctx.backend.send_keys("{ENTER}" if overwrite else "{ESC}")
            if not overwrite:
                raise StepFailed(f"保存先が既に存在します: {path}", step=step)

    def _do_expect_file(self, step: Step) -> None:
        path = Path(str(self._param(step, "path")))
        timeout = self._timeout(step)
        min_bytes = int(self._param(step, "min_bytes", 1024) or 0)

        if self.ctx.is_simulate:
            self.ctx.log.info(f"  [検証モード] 出力を想定: {path}")
            self.ctx.produced_files.append({"path": str(path), "simulated": True})
            return

        # 書き込み中のファイルを「出来上がった」と誤認しないよう、
        # サイズが一定時間変わらないことを確かめてから合格にする。
        stable_sec = float(self._param(step, "stable_sec", 0.8) or 0.0)

        deadline = time.monotonic() + timeout
        last_size = -1
        stable_since = 0.0
        while True:
            if path.exists():
                size = path.stat().st_size
                if size >= min_bytes:
                    if stable_sec <= 0:
                        self.ctx.produced_files.append({"path": str(path), "bytes": size})
                        self.ctx.log.info(f"  出力を確認: {path}（{size:,} バイト）")
                        return
                    if size == last_size:
                        if stable_since and time.monotonic() - stable_since >= stable_sec:
                            self.ctx.produced_files.append({"path": str(path), "bytes": size})
                            self.ctx.log.info(f"  出力を確認: {path}（{size:,} バイト）")
                            return
                        if not stable_since:
                            stable_since = time.monotonic()
                    else:
                        stable_since = 0.0
                last_size = size
            if time.monotonic() >= deadline:
                break
            time.sleep(0.4)

        if path.exists():
            raise StepFailed(
                f"出力ファイルが小さすぎます: {path}"
                f"（{path.stat().st_size:,} バイト < {min_bytes:,} バイト）。"
                f" 出力に失敗している可能性があります。",
                step=step,
            )
        raise StepFailed(
            f"出力ファイルができていません: {path}（{timeout:.0f}秒待ちました）\n"
            f"  保存ダイアログの操作か保存先の権限を確認してください。",
            step=step,
        )

    def _do_print_file(self, step: Step) -> None:
        from ..printing import print_pdf

        path = Path(str(self._param(step, "path")))
        printer = str(self._param(step, "printer", self.ctx.settings.printing.printer) or "")
        copies = int(self._param(step, "copies", self.ctx.settings.printing.copies) or 1)

        if self.ctx.is_simulate:
            self.ctx.log.info(f"  [検証モード] 印刷を想定: {path} → {printer or '既定プリンタ'} × {copies}")
            return
        if not self.ctx.settings.printing.enabled:
            self.ctx.log.info(f"  印刷は設定で無効です。省略: {path}")
            return

        print_pdf(
            path,
            printer=printer or None,
            copies=copies,
            command=self.ctx.settings.printing.pdf_print_command or None,
            log=self.ctx.log,
        )


def _same(a: Any, b: Any) -> bool:
    if isinstance(a, bool) or isinstance(b, bool):
        return bool(a) == bool(b)
    return str(a) == str(b)


def _short(value: Any, limit: int = 60) -> str:
    text = str(value)
    return text if len(text) <= limit else text[: limit - 1] + "…"
