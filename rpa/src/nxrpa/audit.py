"""実行記録（監査ログ）。

税務申告という性質上、「いつ・誰の・どの顧問先で・何を送信し・どこへ保存したか」が
後から追えることは機能そのもの。ログは2系統で残す:

  - run-YYYYmmdd-HHMMSS.jsonl : 機械可読。1行1イベント。後から集計・検証できる
  - run-YYYYmmdd-HHMMSS.log   : 人が読む用。そのまま事務所の作業記録に貼れる

秘密値（暗証番号）は SecretVault 経由で必ずマスクしてから書く。
"""

from __future__ import annotations

import json
import os
import platform
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from .secrets import SecretVault, redact

LEVELS = {"debug": 10, "info": 20, "warn": 30, "error": 40}


@dataclass
class RunLog:
    """1回の実行分のログ。"""

    log_dir: Path
    run_id: str
    vault: SecretVault | None = None
    echo: bool = True
    min_level: str = "info"
    _jsonl: Any = field(default=None, repr=False)
    _text: Any = field(default=None, repr=False)
    counts: dict[str, int] = field(default_factory=lambda: {"info": 0, "warn": 0, "error": 0})

    @classmethod
    def create(
        cls,
        log_dir: str | Path,
        *,
        vault: SecretVault | None = None,
        echo: bool = True,
        min_level: str = "info",
        run_id: str | None = None,
    ) -> "RunLog":
        d = Path(log_dir)
        d.mkdir(parents=True, exist_ok=True)
        rid = run_id or datetime.now().strftime("%Y%m%d-%H%M%S")
        log = cls(log_dir=d, run_id=rid, vault=vault, echo=echo, min_level=min_level)
        log._jsonl = (d / f"run-{rid}.jsonl").open("a", encoding="utf-8")
        log._text = (d / f"run-{rid}.log").open("a", encoding="utf-8")
        log.event(
            "run_start",
            message=f"実行開始 run_id={rid}",
            host=platform.node(),
            user=os.environ.get("USERNAME") or os.environ.get("USER") or "",
            python=sys.version.split()[0],
            platform=platform.platform(),
        )
        return log

    # --- 出力 ---------------------------------------------------------
    def event(self, kind: str, *, level: str = "info", message: str = "", **fields: Any) -> None:
        payload: dict[str, Any] = {
            "ts": datetime.now().isoformat(timespec="milliseconds"),
            "run_id": self.run_id,
            "kind": kind,
            "level": level,
        }
        if message:
            payload["message"] = self._clean(message)
        for k, v in fields.items():
            payload[k] = self._clean(v) if isinstance(v, str) else _jsonable(v, self)
        self.counts[level] = self.counts.get(level, 0) + 1

        if self._jsonl is not None:
            self._jsonl.write(json.dumps(payload, ensure_ascii=False) + "\n")
            self._jsonl.flush()

        line = self._format(payload)
        if self._text is not None:
            self._text.write(line + "\n")
            self._text.flush()
        if self.echo and LEVELS.get(level, 20) >= LEVELS.get(self.min_level, 20):
            stream = sys.stderr if level in ("warn", "error") else sys.stdout
            print(line, file=stream, flush=True)

    def info(self, message: str, **fields: Any) -> None:
        self.event("log", level="info", message=message, **fields)

    def warn(self, message: str, **fields: Any) -> None:
        self.event("log", level="warn", message=message, **fields)

    def error(self, message: str, **fields: Any) -> None:
        self.event("log", level="error", message=message, **fields)

    def _format(self, payload: dict[str, Any]) -> str:
        ts = payload["ts"][11:23]
        mark = {"info": "  ", "warn": "! ", "error": "x ", "debug": ". "}.get(payload["level"], "  ")
        msg = payload.get("message") or payload["kind"]
        extra = {
            k: v for k, v in payload.items()
            if k not in ("ts", "run_id", "kind", "level", "message") and v not in ("", None)
        }
        tail = ""
        if extra:
            tail = "  " + " ".join(f"{k}={v}" for k, v in extra.items())
        return f"{ts} {mark}{msg}{tail}"

    def _clean(self, text: str) -> str:
        return redact(str(text), self.vault)

    # --- 後始末 -------------------------------------------------------
    def finish(self, *, ok: bool, **summary: Any) -> None:
        self.event(
            "run_end",
            level="info" if ok else "error",
            message="実行終了（正常）" if ok else "実行終了（失敗あり）",
            **summary,
        )
        for fh in (self._jsonl, self._text):
            try:
                if fh is not None:
                    fh.close()
            except Exception:  # noqa: BLE001
                pass
        self._jsonl = self._text = None

    @property
    def jsonl_path(self) -> Path:
        return self.log_dir / f"run-{self.run_id}.jsonl"

    @property
    def text_path(self) -> Path:
        return self.log_dir / f"run-{self.run_id}.log"


def _jsonable(value: Any, log: RunLog) -> Any:
    if isinstance(value, (str, int, float, bool)) or value is None:
        return log._clean(value) if isinstance(value, str) else value  # noqa: SLF001
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, dict):
        return {str(k): _jsonable(v, log) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_jsonable(v, log) for v in value]
    return log._clean(repr(value))  # noqa: SLF001


class ScreenshotStore:
    """失敗時の画面を保存する。名前に秘密値は入れない。"""

    def __init__(self, directory: str | Path, run_id: str, *, keep_days: int = 90):
        self.dir = Path(directory) / run_id
        self.run_id = run_id
        self.keep_days = keep_days
        self._seq = 0

    def path_for(self, label: str) -> Path:
        self._seq += 1
        safe = "".join(ch if (ch.isalnum() or ch in "-_一二三四五六七八九十") else "_" for ch in str(label))[:60]
        self.dir.mkdir(parents=True, exist_ok=True)
        return self.dir / f"{self._seq:03d}_{safe or 'shot'}.png"

    def sweep(self, root: str | Path) -> int:
        """古いスクリーンショットを消す。画面には顧問先の申告情報が写るため放置しない。"""
        base = Path(root)
        if not base.exists() or self.keep_days <= 0:
            return 0
        cutoff = time.time() - self.keep_days * 86400
        removed = 0
        for child in base.iterdir():
            try:
                if child.is_dir() and child.stat().st_mtime < cutoff:
                    for f in child.glob("*"):
                        f.unlink(missing_ok=True)
                    child.rmdir()
                    removed += 1
                elif child.is_file() and child.stat().st_mtime < cutoff:
                    child.unlink(missing_ok=True)
                    removed += 1
            except OSError:
                continue
        return removed


def sweep_logs(log_dir: str | Path, keep_days: int) -> int:
    """古い実行ログを消す。"""
    d = Path(log_dir)
    if not d.exists() or keep_days <= 0:
        return 0
    cutoff = datetime.now() - timedelta(days=keep_days)
    removed = 0
    for f in d.glob("run-*"):
        if not f.is_file():
            continue
        try:
            if datetime.fromtimestamp(f.stat().st_mtime) < cutoff:
                f.unlink()
                removed += 1
        except OSError:
            continue
    return removed
