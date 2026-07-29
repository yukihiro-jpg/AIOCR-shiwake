"""設定ファイル（config/settings.yaml）の読み込みと検証。

設定は「実機を見ないと確定できないもの」を全部ここへ逃がすための場所。
画面部品の位置や手順そのものは profiles/*.yaml 側に置き、こちらは
保存先・印刷・対象書類・安全策といった事務所の運用に属する設定を持つ。
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

import yaml

from .errors import ConfigError

# 取り消し不能な操作（＝実際の送信）を伴うモード
MODE_REHEARSAL = "rehearsal"  # 実機を操作するが、送信ボタンの直前で停止する
MODE_LIVE = "live"            # 実際に送信する
MODE_SIMULATE = "simulate"    # 画面を一切触らず、手順定義と設定の整合だけ検証する
MODES = (MODE_REHEARSAL, MODE_LIVE, MODE_SIMULATE)


@dataclass(frozen=True)
class DocumentSpec:
    """出力対象の書類1種類。"""

    key: str
    label: str                    # ファイル名に入る「資料名」
    category: str = "national"    # national(国税) / local(地方税) / accounting(決算関係)
    report_name: str = ""         # NX-PRO の帳票一覧に出る名前（空なら label と同じ）
    menu_path: tuple[str, ...] = ()  # 帳票までのメニュー経路（画面が分かれている場合）
    export_flow: str = ""         # プロファイル側の PDF 出力フロー名
    print_flow: str = ""          # プロファイル側の印刷フロー名（空なら export と同じ経路）
    export_method: str = "app"    # app(アプリのPDF出力) / print_to_pdf(仮想プリンタ)
    print_enabled: bool = True
    copies: int = 1
    required: bool = True         # 出力できなかったときに失敗扱いにするか
    requires_consumption_tax: bool = False  # 課税事業者のときだけ対象
    depends_on_submission: str = ""  # この送信が済んでいないと存在しない書類（受信通知など）
    order: int = 0

    def as_context(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "label": self.label,
            "category": self.category,
            "report_name": self.report_name or self.label,
            "menu_path": list(self.menu_path),
        }


@dataclass(frozen=True)
class SubmissionSpec:
    """申告の送信1単位（国税・地方税・消費税など）。

    実際にどのソフトのどの画面で送るかは profiles/*.yaml の flow 側に閉じ込め、
    ここでは「何を、どの順で、どの条件のとき送るか」だけを持つ。
    国税と地方税で別ソフトを使う運用にも、flow を差し替えるだけで対応できる。
    """

    key: str
    label: str
    flow: str
    app: str = ""                  # 使うアプリ（settings.apps のキー）。空なら既定アプリ
    requires_consumption_tax: bool = False
    enabled: bool = True
    order: int = 0


@dataclass(frozen=True)
class PathSettings:
    output_root: str = "output"
    folder_template: str = "{client.code}_{client.name}\\{client.fiscal_year}"
    file_template: str = "{client.name}_{doc.label}"
    log_dir: str = "logs"
    screenshot_dir: str = "logs\\screenshots"
    on_existing: str = "rename"   # rename(連番付与) / overwrite / skip / error
    create_folders: bool = True


@dataclass(frozen=True)
class PrintSettings:
    enabled: bool = True
    source: str = "app"           # app(アプリから直接印刷) / pdf(出力したPDFを印刷)
    printer: str = ""             # 空なら既定プリンタ
    copies: int = 1
    pdf_print_command: str = ""   # source=pdf のときの外部コマンド（空なら Windows の関連付け）


@dataclass(frozen=True)
class RunSettings:
    mode: str = MODE_REHEARSAL
    confirm_before_submit: bool = True
    confirm_each_client: bool = True
    stop_on_error: bool = True    # 1顧問先が失敗したら全体を止めるか
    step_timeout_sec: float = 30.0
    window_timeout_sec: float = 90.0
    retry: int = 2
    retry_wait_sec: float = 1.5
    step_pause_sec: float = 0.2   # 人が目で追えるようにする最小間隔
    screenshot_on_error: bool = True
    screenshot_every_step: bool = False
    keep_screenshots_days: int = 90


@dataclass(frozen=True)
class AppSettings:
    """外部アプリ1つ分の起動情報。"""

    key: str
    profile: str                  # profiles/ 配下のファイル名
    exe: str = ""                 # 未起動のとき起動する実行ファイル（空なら起動済み前提）
    args: tuple[str, ...] = ()
    start_timeout_sec: float = 180.0


@dataclass
class Settings:
    run: RunSettings = field(default_factory=RunSettings)
    paths: PathSettings = field(default_factory=PathSettings)
    printing: PrintSettings = field(default_factory=PrintSettings)
    documents: tuple[DocumentSpec, ...] = ()
    submissions: tuple[SubmissionSpec, ...] = ()
    apps: dict[str, AppSettings] = field(default_factory=dict)
    default_app: str = ""
    flows: dict[str, str] = field(default_factory=dict)
    clients_file: str = "config/clients.csv"
    pin_label: str = "税理士カードの暗証番号"
    secrets_required: tuple[str, ...] = ("pin_tax_accountant",)
    root: Path = field(default_factory=lambda: Path("."))
    source: Path | None = None

    # --- 便利メソッド -------------------------------------------------
    def document(self, key: str) -> DocumentSpec:
        for d in self.documents:
            if d.key == key:
                return d
        raise ConfigError(
            f"書類キー '{key}' が settings.yaml の documents にありません。"
            f" 定義済み: {', '.join(d.key for d in self.documents)}"
        )

    def documents_for(self, client) -> list[DocumentSpec]:
        """顧問先に対して実際に出力する書類を決める。

        顧問先マスタの「対象書類」列が空なら設定の既定を全部、
        指定があればその順で使う。免税事業者には消費税申告書を回さない。
        """
        if client.documents:
            selected = [self.document(k) for k in client.documents]
        else:
            selected = list(self.documents)

        result = []
        for d in selected:
            if d.requires_consumption_tax and not client.consumption_tax:
                continue
            result.append(d)
        return sorted(result, key=lambda d: (d.order, d.key))

    def submissions_for(self, client) -> list[SubmissionSpec]:
        """顧問先に対して実際に行う送信を決める。"""
        result = [
            s for s in self.submissions
            if s.enabled and not (s.requires_consumption_tax and not client.consumption_tax)
        ]
        return sorted(result, key=lambda s: (s.order, s.key))

    def flow_name(self, logical: str, default: str = "") -> str:
        """論理名（select_client など）から実際のフロー名を引く。

        プロファイル側のフロー名を settings.yaml の flows で読み替えられるようにして、
        既存の手順定義を書き換えずに差し替えられるようにする。
        """
        return self.flows.get(logical, default or logical)

    def resolve(self, value: str) -> Path:
        """設定に書かれたパスを、相対なら設定ファイルの場所を基準に絶対化する。"""
        p = Path(os.path.expandvars(str(value))).expanduser()
        return p if p.is_absolute() else (self.root / p)

    def profile_path(self, app_key: str) -> Path:
        app = self.apps.get(app_key)
        if app is None:
            raise ConfigError(
                f"アプリ '{app_key}' が settings.yaml の apps にありません。"
                f" 定義済み: {', '.join(self.apps) or '(なし)'}"
            )
        return self.resolve(Path("config/profiles") / app.profile)

    def base_context(self) -> dict[str, Any]:
        now = datetime.now()
        return {
            "run": {
                "date": now.strftime("%Y%m%d"),
                "datetime": now.strftime("%Y%m%d_%H%M%S"),
                "year": now.strftime("%Y"),
                "month": now.strftime("%m"),
                "day": now.strftime("%d"),
                "mode": self.run.mode,
            }
        }


# ---------------------------------------------------------------------
# 読み込み
# ---------------------------------------------------------------------

def _require_mapping(value: Any, where: str) -> dict[str, Any]:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ConfigError(f"{where} はマッピング（key: value）で書いてください。実際: {type(value).__name__}")
    return value


def _get(d: dict[str, Any], key: str, default: Any, where: str, cast=None) -> Any:
    if key not in d or d[key] is None:
        return default
    value = d[key]
    if cast is None:
        return value
    try:
        return cast(value)
    except (TypeError, ValueError) as exc:
        raise ConfigError(f"{where}.{key} の値が不正です: {value!r}（{exc}）") from None


def load_settings(path: str | Path, *, overrides: dict[str, Any] | None = None) -> Settings:
    """settings.yaml を読んで検証済みの Settings を返す。"""
    p = Path(path)
    if not p.exists():
        raise ConfigError(
            f"設定ファイルが見つかりません: {p}\n"
            f"config/settings.yaml を用意してください（サンプル: config/settings.sample.yaml）"
        )
    try:
        raw = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError as exc:
        raise ConfigError(f"設定ファイルの書式が不正です: {p}\n{exc}") from None
    raw = _require_mapping(raw, "settings.yaml")

    root = p.parent.parent if p.parent.name == "config" else p.parent

    run_raw = _require_mapping(raw.get("run"), "run")
    run = RunSettings(
        mode=str(_get(run_raw, "mode", MODE_REHEARSAL, "run")),
        confirm_before_submit=bool(_get(run_raw, "confirm_before_submit", True, "run")),
        confirm_each_client=bool(_get(run_raw, "confirm_each_client", True, "run")),
        stop_on_error=bool(_get(run_raw, "stop_on_error", True, "run")),
        step_timeout_sec=_get(run_raw, "step_timeout_sec", 30.0, "run", float),
        window_timeout_sec=_get(run_raw, "window_timeout_sec", 90.0, "run", float),
        retry=_get(run_raw, "retry", 2, "run", int),
        retry_wait_sec=_get(run_raw, "retry_wait_sec", 1.5, "run", float),
        step_pause_sec=_get(run_raw, "step_pause_sec", 0.2, "run", float),
        screenshot_on_error=bool(_get(run_raw, "screenshot_on_error", True, "run")),
        screenshot_every_step=bool(_get(run_raw, "screenshot_every_step", False, "run")),
        keep_screenshots_days=_get(run_raw, "keep_screenshots_days", 90, "run", int),
    )
    if run.mode not in MODES:
        raise ConfigError(f"run.mode は {MODES} のいずれかにしてください。実際: {run.mode!r}")
    if run.retry < 0:
        raise ConfigError("run.retry は 0 以上にしてください")

    paths_raw = _require_mapping(raw.get("paths"), "paths")
    paths = PathSettings(
        output_root=str(_get(paths_raw, "output_root", "output", "paths")),
        folder_template=str(_get(paths_raw, "folder_template", PathSettings.folder_template, "paths")),
        file_template=str(_get(paths_raw, "file_template", PathSettings.file_template, "paths")),
        log_dir=str(_get(paths_raw, "log_dir", "logs", "paths")),
        screenshot_dir=str(_get(paths_raw, "screenshot_dir", "logs\\screenshots", "paths")),
        on_existing=str(_get(paths_raw, "on_existing", "rename", "paths")),
        create_folders=bool(_get(paths_raw, "create_folders", True, "paths")),
    )
    if paths.on_existing not in ("rename", "overwrite", "skip", "error"):
        raise ConfigError(
            "paths.on_existing は rename / overwrite / skip / error のいずれかにしてください。"
            f" 実際: {paths.on_existing!r}"
        )

    print_raw = _require_mapping(raw.get("printing"), "printing")
    printing = PrintSettings(
        enabled=bool(_get(print_raw, "enabled", True, "printing")),
        source=str(_get(print_raw, "source", "app", "printing")),
        printer=str(_get(print_raw, "printer", "", "printing")),
        copies=_get(print_raw, "copies", 1, "printing", int),
        pdf_print_command=str(_get(print_raw, "pdf_print_command", "", "printing")),
    )
    if printing.source not in ("app", "pdf"):
        raise ConfigError(f"printing.source は app / pdf のいずれかです。実際: {printing.source!r}")
    if printing.copies < 1:
        raise ConfigError("printing.copies は 1 以上にしてください")

    docs_raw = raw.get("documents") or []
    if not isinstance(docs_raw, list):
        raise ConfigError("documents はリストで書いてください")
    documents: list[DocumentSpec] = []
    seen_keys: set[str] = set()
    seen_labels: dict[str, str] = {}
    for i, item in enumerate(docs_raw):
        item = _require_mapping(item, f"documents[{i}]")
        key = str(item.get("key") or "").strip()
        label = str(item.get("label") or "").strip()
        if not key:
            raise ConfigError(f"documents[{i}] に key がありません")
        if not label:
            raise ConfigError(f"documents[{i}]（{key}）に label（資料名）がありません")
        if key in seen_keys:
            raise ConfigError(f"documents の key '{key}' が重複しています")
        if label in seen_labels:
            raise ConfigError(
                f"documents の label '{label}' が '{seen_labels[label]}' と重複しています。"
                f" 同じ資料名だとファイル名が衝突して上書き・連番になるため、区別できる名前にしてください。"
            )
        seen_keys.add(key)
        seen_labels[label] = key
        category = str(item.get("category") or "national")
        if category not in ("national", "local", "accounting"):
            raise ConfigError(
                f"documents[{key}].category は national / local / accounting のいずれかです。実際: {category!r}"
            )
        method = str(item.get("export_method") or "app")
        if method not in ("app", "print_to_pdf"):
            raise ConfigError(
                f"documents[{key}].export_method は app / print_to_pdf のいずれかです。実際: {method!r}"
            )
        menu_path = item.get("menu_path") or []
        if isinstance(menu_path, str):
            menu_path = [menu_path]
        documents.append(
            DocumentSpec(
                key=key,
                label=label,
                category=category,
                report_name=str(item.get("report_name") or ""),
                menu_path=tuple(str(m) for m in menu_path),
                export_flow=str(item.get("export_flow") or ""),
                print_flow=str(item.get("print_flow") or ""),
                export_method=method,
                print_enabled=bool(item.get("print_enabled", True)),
                copies=int(item.get("copies", 1) or 1),
                required=bool(item.get("required", True)),
                requires_consumption_tax=bool(item.get("requires_consumption_tax", False)),
                depends_on_submission=str(item.get("depends_on_submission") or ""),
                order=int(item.get("order", i) or i),
            )
        )
    if not documents:
        raise ConfigError("documents が1件もありません。出力する書類を settings.yaml に定義してください。")

    subs_raw = raw.get("submissions") or []
    if not isinstance(subs_raw, list):
        raise ConfigError("submissions はリストで書いてください")
    submissions: list[SubmissionSpec] = []
    seen_sub: set[str] = set()
    for i, item in enumerate(subs_raw):
        item = _require_mapping(item, f"submissions[{i}]")
        key = str(item.get("key") or "").strip()
        flow = str(item.get("flow") or "").strip()
        if not key:
            raise ConfigError(f"submissions[{i}] に key がありません")
        if not flow:
            raise ConfigError(f"submissions[{i}]（{key}）に flow がありません")
        if key in seen_sub:
            raise ConfigError(f"submissions の key '{key}' が重複しています")
        seen_sub.add(key)
        submissions.append(
            SubmissionSpec(
                key=key,
                label=str(item.get("label") or key),
                flow=flow,
                app=str(item.get("app") or ""),
                requires_consumption_tax=bool(item.get("requires_consumption_tax", False)),
                enabled=bool(item.get("enabled", True)),
                order=int(item.get("order", i) or i),
            )
        )

    apps_raw = _require_mapping(raw.get("apps"), "apps")
    apps: dict[str, AppSettings] = {}
    for key, item in apps_raw.items():
        item = _require_mapping(item, f"apps.{key}")
        profile = str(item.get("profile") or "").strip()
        if not profile:
            raise ConfigError(f"apps.{key}.profile（画面手順定義のファイル名）がありません")
        args = item.get("args") or []
        if isinstance(args, str):
            args = [args]
        apps[str(key)] = AppSettings(
            key=str(key),
            profile=profile,
            exe=str(item.get("exe") or ""),
            args=tuple(str(a) for a in args),
            start_timeout_sec=float(item.get("start_timeout_sec", 180.0) or 180.0),
        )
    if not apps:
        raise ConfigError("apps が空です。操作する対象アプリを settings.yaml に定義してください。")

    default_app = str(raw.get("default_app") or "")
    if default_app and default_app not in apps:
        raise ConfigError(
            f"default_app '{default_app}' が apps にありません。定義済み: {', '.join(apps)}"
        )
    if not default_app:
        default_app = next(iter(apps))
    for sub in submissions:
        if sub.app and sub.app not in apps:
            raise ConfigError(
                f"submissions[{sub.key}].app '{sub.app}' が apps にありません。"
                f" 定義済み: {', '.join(apps)}"
            )
    sub_keys = {s.key for s in submissions}
    for doc in documents:
        if doc.depends_on_submission and doc.depends_on_submission not in sub_keys:
            raise ConfigError(
                f"documents[{doc.key}].depends_on_submission "
                f"'{doc.depends_on_submission}' が submissions にありません。"
                f" 定義済み: {', '.join(sorted(sub_keys)) or '(なし)'}"
            )

    flows_map = _require_mapping(raw.get("flows"), "flows")

    secrets_required = raw.get("secrets_required") or ["pin_tax_accountant"]
    if isinstance(secrets_required, str):
        secrets_required = [secrets_required]

    settings = Settings(
        run=run,
        paths=paths,
        printing=printing,
        documents=tuple(documents),
        submissions=tuple(submissions),
        apps=apps,
        default_app=default_app,
        flows={str(k): str(v) for k, v in flows_map.items()},
        clients_file=str(raw.get("clients_file") or "config/clients.csv"),
        pin_label=str(raw.get("pin_label") or "税理士カードの暗証番号"),
        secrets_required=tuple(str(s) for s in secrets_required),
        root=root,
        source=p,
    )

    for key, value in (overrides or {}).items():
        _apply_override(settings, key, value)
    return settings


def _apply_override(settings: Settings, key: str, value: Any) -> None:
    """コマンドライン等からの上書き（`run.mode=live` の形）。"""
    if value is None:
        return
    section, _, field_name = key.partition(".")
    target = getattr(settings, section, None)
    if target is None or not field_name:
        raise ConfigError(f"上書きできない設定です: {key}")
    if not hasattr(target, field_name):
        raise ConfigError(f"上書きできない設定です: {key}")
    # frozen dataclass なので差し替えで対応する
    from dataclasses import replace

    setattr(settings, section, replace(target, **{field_name: value}))
