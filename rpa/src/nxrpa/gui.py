"""画面（Tkinter）。暗証番号の入力と、顧問先を選んで実行するところまで。

Tkinter を選んだ理由は、Python の標準構成に入っていて PyInstaller で1つの exe に
まとめやすいこと。事務所のパソコンに追加インストールを増やしたくないため。

スレッド構成:
  - 画面は主スレッド
  - 実行は作業スレッド（画面が固まらないように）
  - ログは queue 経由で主スレッドへ渡して描画する
  - 確認ダイアログは、作業スレッドから `root.after` で主スレッドへ依頼し、
    Event で待つ（Tkinter は主スレッド以外から触ってはいけないため）
"""

from __future__ import annotations

import queue
import threading
import traceback
from dataclasses import replace
from pathlib import Path
from typing import Any

from .audit import RunLog, ScreenshotStore
from .clients import ClientBook, load_clients
from .config import MODE_LIVE, MODE_REHEARSAL, MODE_SIMULATE, Settings, load_settings
from .engine.profile import load_profile
from .errors import RpaError
from .output import plan_outputs
from .pipeline import Pipeline, write_report
from .secrets import SecretVault

MODE_LABELS = {
    MODE_REHEARSAL: "練習（送信の直前で停止）",
    MODE_LIVE: "本番（実際に送信します）",
    MODE_SIMULATE: "検証（画面を触りません）",
}


def launch(config_path: str) -> int:
    try:
        import tkinter as tk  # noqa: F401
    except ImportError:
        print("Tkinter が使えません。コマンドライン（nxrpa run）をお使いください。")
        return 1

    app = App(config_path)
    return app.run()


class GuiConfirmer:
    """作業スレッドからの確認要求を、主スレッドのダイアログへ橋渡しする。"""

    def __init__(self, app: "App"):
        self.app = app

    def confirm(self, message: str, *, expect: str | None = None, danger: bool = False) -> bool:
        done = threading.Event()
        box: dict[str, bool] = {}

        def ask() -> None:
            try:
                box["ok"] = self.app.ask_confirm(message, expect=expect, danger=danger)
            finally:
                done.set()

        self.app.root.after(0, ask)
        done.wait()
        return bool(box.get("ok"))


class App:
    def __init__(self, config_path: str):
        import tkinter as tk
        from tkinter import ttk

        self.tk = tk
        self.ttk = ttk
        self.config_path = config_path
        self.settings: Settings | None = None
        self.book: ClientBook | None = None
        self.vault = SecretVault()
        self.queue: queue.Queue[tuple[str, Any]] = queue.Queue()
        self.worker: threading.Thread | None = None
        self.cancel = threading.Event()

        self.root = tk.Tk()
        self.root.title("電子申告 自動処理")
        self.root.geometry("1080x720")
        self.root.minsize(900, 600)
        self._build()
        self.root.after(200, self._pump)
        self.root.after(400, self._startup)

    # -----------------------------------------------------------------
    def run(self) -> int:
        try:
            self.root.mainloop()
        finally:
            self.vault.burn_all()
        return 0

    # -----------------------------------------------------------------
    def _build(self) -> None:
        tk, ttk = self.tk, self.ttk

        top = ttk.Frame(self.root, padding=(12, 10))
        top.pack(fill="x")

        ttk.Label(top, text="実行モード:").pack(side="left")
        self.mode_var = tk.StringVar(value=MODE_REHEARSAL)
        self.mode_box = ttk.Combobox(
            top, textvariable=self.mode_var, state="readonly", width=28,
            values=[MODE_LABELS[m] for m in (MODE_REHEARSAL, MODE_LIVE, MODE_SIMULATE)],
        )
        self.mode_box.set(MODE_LABELS[MODE_REHEARSAL])
        self.mode_box.pack(side="left", padx=(6, 18))
        self.mode_box.bind("<<ComboboxSelected>>", lambda e: self._on_mode_change())

        self.pin_label = ttk.Label(top, text="未入力", foreground="#b00")
        self.pin_label.pack(side="left")
        ttk.Button(top, text="パスワード・暗証番号を入力", command=self._ask_pin).pack(side="left", padx=8)

        self.print_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(top, text="印刷する", variable=self.print_var).pack(side="right")

        self.mode_note = ttk.Label(
            self.root, text="", padding=(12, 0, 12, 6), foreground="#555",
        )
        self.mode_note.pack(fill="x")

        body = ttk.Panedwindow(self.root, orient="horizontal")
        body.pack(fill="both", expand=True, padx=12, pady=(0, 6))

        # --- 左: 顧問先 ---------------------------------------------
        left = ttk.Frame(body)
        body.add(left, weight=2)

        search_row = ttk.Frame(left)
        search_row.pack(fill="x", pady=(0, 6))
        ttk.Label(search_row, text="検索:").pack(side="left")
        self.search_var = tk.StringVar()
        entry = ttk.Entry(search_row, textvariable=self.search_var)
        entry.pack(side="left", fill="x", expand=True, padx=6)
        entry.bind("<KeyRelease>", lambda e: self._refresh_clients())
        ttk.Button(search_row, text="全選択", command=self._select_all).pack(side="left")
        ttk.Button(search_row, text="解除", command=self._select_none).pack(side="left", padx=4)

        columns = ("code", "name", "year", "tax")
        self.tree = ttk.Treeview(left, columns=columns, show="headings", selectmode="extended")
        for col, text, width in (
            ("code", "コード", 90), ("name", "会社名", 260),
            ("year", "年度", 80), ("tax", "消費税", 70),
        ):
            self.tree.heading(col, text=text)
            self.tree.column(col, width=width, anchor="w")
        self.tree.pack(fill="both", expand=True, side="left")
        sb = ttk.Scrollbar(left, orient="vertical", command=self.tree.yview)
        sb.pack(side="right", fill="y")
        self.tree.configure(yscrollcommand=sb.set)
        self.tree.bind("<<TreeviewSelect>>", lambda e: self._preview())

        # --- 右: ログ ------------------------------------------------
        right = ttk.Frame(body)
        body.add(right, weight=3)
        ttk.Label(right, text="実行ログ").pack(anchor="w")
        self.log_text = tk.Text(right, wrap="none", height=20, font=("MS Gothic", 10))
        self.log_text.pack(fill="both", expand=True, side="left")
        lsb = ttk.Scrollbar(right, orient="vertical", command=self.log_text.yview)
        lsb.pack(side="right", fill="y")
        self.log_text.configure(yscrollcommand=lsb.set, state="disabled")
        self.log_text.tag_configure("warn", foreground="#a60")
        self.log_text.tag_configure("error", foreground="#b00")
        self.log_text.tag_configure("head", foreground="#036")

        # --- 下: 操作 ------------------------------------------------
        bottom = ttk.Frame(self.root, padding=(12, 6, 12, 12))
        bottom.pack(fill="x")
        self.status = ttk.Label(bottom, text="")
        self.status.pack(side="left")
        self.run_btn = ttk.Button(bottom, text="実行", command=self._start)
        self.run_btn.pack(side="right")
        ttk.Button(bottom, text="保存先を確認", command=self._preview_dialog).pack(side="right", padx=6)
        self.stop_btn = ttk.Button(bottom, text="中止", command=self._request_cancel, state="disabled")
        self.stop_btn.pack(side="right", padx=6)

        self._on_mode_change()

    # -----------------------------------------------------------------
    def _startup(self) -> None:
        from tkinter import messagebox

        try:
            self.settings = load_settings(self.config_path)
            self.book = load_clients(self.settings.resolve(self.settings.clients_file))
            self.mode_box.set(MODE_LABELS.get(self.settings.run.mode, MODE_LABELS[MODE_REHEARSAL]))
            self._refresh_clients()
            self._log(f"設定を読み込みました: {self.settings.source}", "head")
            self._log(f"顧問先 {len(self.book)} 件（有効 {len(self.book.enabled())} 件）")
            self._log(f"保存先: {self.settings.resolve(self.settings.paths.output_root)}")
        except RpaError as exc:
            messagebox.showerror("設定エラー", str(exc))
            self._log(str(exc), "error")
            return

        # 起動時に暗証番号を入力する（利用者の運用どおり）
        self._ask_pin()

    def _ask_pin(self) -> None:
        """設定された秘密情報を1つずつ入力してもらう。

        NX-Pro の担当者パスワードとカードの暗証番号は別物なので、
        1回の入力を使い回してはいけない（以前はそうなっていた）。
        """
        from tkinter import simpledialog

        if self.settings is None:
            return
        for spec in self.settings.secrets:
            value = simpledialog.askstring(
                "入力",
                f"{spec.prompt_text()}\n\n"
                f"※ 入力した内容はこのアプリの実行中のみメモリ上で保持し、\n"
                f"　 ファイルにも記録にも残しません。",
                show="*", parent=self.root,
            )
            if not value:
                self._log(f"{spec.label} が未入力です。実行前に入力してください。", "warn")
                self._set_pin_state()
                return
            self.vault.put(spec.name, value)
            self._log(f"{spec.label} を受け取りました（内容は記録しません）")
        self._set_pin_state()

    def _missing_secrets(self) -> list:
        if self.settings is None:
            return []
        return [s for s in self.settings.secrets if not self.vault.has(s.name)]

    def _set_pin_state(self, ok: bool | None = None) -> None:
        missing = self._missing_secrets()
        done = ok if ok is not None else not missing
        if done:
            text = "入力済み"
        elif self.settings is None:
            text = "未入力"
        else:
            text = "未入力: " + "、".join(s.label for s in missing)
        self.pin_label.configure(
            text=text, foreground="#070" if done else "#b00",
        )

    def _on_mode_change(self) -> None:
        mode = self._mode()
        notes = {
            MODE_REHEARSAL: "練習モード: 送信ボタンの直前で停止します。PDF出力・印刷は行いません。",
            MODE_LIVE: "本番モード: 実際に送信します。送信は取り消せません。顧問先ごとに確認します。",
            MODE_SIMULATE: "検証モード: 画面を一切触らず、設定と手順の整合だけを確かめます。",
        }
        self.mode_note.configure(
            text=notes.get(mode, ""),
            foreground="#b00" if mode == MODE_LIVE else "#555",
        )

    def _mode(self) -> str:
        label = self.mode_box.get()
        for key, text in MODE_LABELS.items():
            if text == label:
                return key
        return MODE_REHEARSAL

    # -----------------------------------------------------------------
    def _refresh_clients(self) -> None:
        if self.book is None:
            return
        for item in self.tree.get_children():
            self.tree.delete(item)
        for c in self.book.search(self.search_var.get()):
            if not c.enabled:
                continue
            self.tree.insert(
                "", "end", iid=c.code,
                values=(c.code, c.name, c.fiscal_year, "課税" if c.consumption_tax else "免税"),
            )
        self._preview()

    def _select_all(self) -> None:
        self.tree.selection_set(self.tree.get_children())

    def _select_none(self) -> None:
        self.tree.selection_remove(self.tree.selection())

    def _selected(self) -> list[str]:
        return list(self.tree.selection())

    def _preview(self) -> None:
        codes = self._selected()
        self.status.configure(text=f"選択中: {len(codes)} 件")

    def _preview_dialog(self) -> None:
        from tkinter import messagebox

        if self.settings is None or self.book is None:
            return
        codes = self._selected()
        if not codes:
            messagebox.showinfo("保存先の確認", "顧問先を選んでください。")
            return
        lines = []
        try:
            for code in codes[:10]:
                client = self.book.by_code(code)
                targets = plan_outputs(self.settings, client)
                lines.append(f"■ {client.label}")
                lines.append(f"   {targets[0].folder if targets else '(書類なし)'}")
                for t in targets:
                    lines.append(f"     - {t.filename}" + ("  ※同名あり" if t.existed else ""))
                lines.append("")
            if len(codes) > 10:
                lines.append(f"…ほか {len(codes) - 10} 件")
        except RpaError as exc:
            messagebox.showerror("保存先の確認", str(exc))
            return
        messagebox.showinfo("保存先の確認", "\n".join(lines))

    # -----------------------------------------------------------------
    def ask_confirm(self, message: str, *, expect: str | None = None, danger: bool = False) -> bool:
        """主スレッドで確認ダイアログを出す。"""
        from tkinter import messagebox, simpledialog

        if expect:
            typed = simpledialog.askstring(
                "送信の確認",
                f"{message}\n\n続けるには次を正確に入力してください:\n{expect}",
                parent=self.root,
            )
            if typed is None:
                return False
            if typed.strip() != expect:
                messagebox.showwarning("送信の確認", "入力が一致しません。中止します。", parent=self.root)
                return False
            return True
        if danger:
            return bool(messagebox.askokcancel("確認", message, parent=self.root, icon="warning"))
        return bool(messagebox.askokcancel("確認", message, parent=self.root))

    # -----------------------------------------------------------------
    def _start(self) -> None:
        from tkinter import messagebox

        if self.worker is not None and self.worker.is_alive():
            return
        if self.settings is None or self.book is None:
            messagebox.showerror("実行", "設定が読み込めていません。")
            return
        codes = self._selected()
        if not codes:
            messagebox.showinfo("実行", "顧問先を選んでください。")
            return

        mode = self._mode()
        missing = self._missing_secrets()
        if mode != MODE_SIMULATE and missing:
            messagebox.showwarning(
                "実行", "先に次の入力を済ませてください:\n" + "\n".join(f"・{s.label}" for s in missing)
            )
            self._ask_pin()
            return

        if mode == MODE_LIVE:
            ok = messagebox.askokcancel(
                "本番送信の確認",
                f"本番モードで {len(codes)} 件を処理します。\n"
                f"実際に電子申告データを送信し、送信後は取り消せません。\n\n"
                f"よろしいですか？",
                icon="warning", parent=self.root,
            )
            if not ok:
                return

        settings = replace_settings(self.settings, mode=mode, printing_enabled=self.print_var.get())
        self.cancel.clear()
        self.run_btn.configure(state="disabled")
        self.stop_btn.configure(state="normal")
        self._log("", "head")
        self._log(f"=== 実行開始（{MODE_LABELS[mode]}）{len(codes)} 件 ===", "head")

        self.worker = threading.Thread(
            target=self._work, args=(settings, list(codes)), daemon=True
        )
        self.worker.start()

    def _request_cancel(self) -> None:
        self.cancel.set()
        self._log("中止を要求しました。現在のステップが終わったら止まります。", "warn")

    def _work(self, settings: Settings, codes: list[str]) -> None:
        try:
            book = self.book
            clients = [book.by_code(c) for c in codes]
            log_dir = settings.resolve(settings.paths.log_dir)
            shot_dir = settings.resolve(settings.paths.screenshot_dir)

            log = RunLog.create(log_dir, vault=self.vault, echo=False)
            log_sink = _QueueLog(log, self.queue)
            shots = ScreenshotStore(shot_dir, log.run_id,
                                    keep_days=settings.run.keep_screenshots_days)
            profile = load_profile(settings.profile_path(settings.default_app))
            backend = _make_backend(settings)

            pipeline = Pipeline(settings, profile, backend, log_sink, self.vault,
                                shots, GuiConfirmer(self))
            pipeline.runner  # noqa: B018 - 生成時の検証を先に走らせる

            result = pipeline.run(_cancellable(clients, self.cancel, log_sink))
            report = write_report(result, log_dir / f"result-{log.run_id}.csv")

            self.queue.put(("log", ("", "head")))
            self.queue.put(("log", ("=== 結果 ===", "head")))
            for line in result.summary_lines():
                self.queue.put(("log", (line, "" if result.ok else "warn")))
            self.queue.put(("log", (f"ログ: {log.text_path}", "")))
            self.queue.put(("log", (f"記録: {report}", "")))
            log.finish(ok=result.ok)
            self.queue.put(("done", result.ok))
        except RpaError as exc:
            self.queue.put(("log", (str(exc), "error")))
            self.queue.put(("done", False))
        except Exception:  # noqa: BLE001
            self.queue.put(("log", (traceback.format_exc(), "error")))
            self.queue.put(("done", False))

    # -----------------------------------------------------------------
    def _pump(self) -> None:
        try:
            while True:
                kind, payload = self.queue.get_nowait()
                if kind == "log":
                    text, tag = payload
                    self._log(text, tag)
                elif kind == "done":
                    self.run_btn.configure(state="normal")
                    self.stop_btn.configure(state="disabled")
                    self.status.configure(text="完了" if payload else "失敗あり")
        except queue.Empty:
            pass
        self.root.after(150, self._pump)

    def _log(self, text: str, tag: str = "") -> None:
        self.log_text.configure(state="normal")
        self.log_text.insert("end", (text or "") + "\n", tag or ())
        self.log_text.see("end")
        self.log_text.configure(state="disabled")


class _QueueLog:
    """RunLog を包んで、画面にも流す。"""

    def __init__(self, inner: RunLog, q: "queue.Queue[tuple[str, Any]]"):
        self._inner = inner
        self._q = q

    def __getattr__(self, name: str):
        return getattr(self._inner, name)

    def event(self, kind: str, *, level: str = "info", message: str = "", **fields: Any) -> None:
        self._inner.event(kind, level=level, message=message, **fields)
        if message and level != "debug":
            self._q.put(("log", (message, {"warn": "warn", "error": "error"}.get(level, ""))))

    def info(self, message: str, **fields: Any) -> None:
        self.event("log", level="info", message=message, **fields)

    def warn(self, message: str, **fields: Any) -> None:
        self.event("log", level="warn", message=message, **fields)

    def error(self, message: str, **fields: Any) -> None:
        self.event("log", level="error", message=message, **fields)


def _cancellable(clients, cancel: threading.Event, log) -> list:
    """中止要求が出ていたら、そこから先の顧問先を落とす。

    処理中の顧問先を途中で切ると中途半端な状態になるので、
    「次の顧問先へ進まない」形の中止にする。
    """

    class _List(list):
        def __iter__(self):
            for c in list.__iter__(self):
                if cancel.is_set():
                    log.warn("中止要求により、以降の顧問先は処理しません。")
                    return
                yield c

    return _List(clients)


def replace_settings(settings: Settings, *, mode: str, printing_enabled: bool) -> Settings:
    import copy

    s = copy.copy(settings)
    s.run = replace(settings.run, mode=mode)
    s.printing = replace(settings.printing, enabled=printing_enabled and settings.printing.enabled)
    return s


def _make_backend(settings: Settings):
    if settings.run.mode == MODE_SIMULATE:
        from .engine.backend import FakeBackend

        return FakeBackend()
    from .engine.windows_backend import WindowsBackend

    return WindowsBackend(default_timeout=settings.run.step_timeout_sec)
