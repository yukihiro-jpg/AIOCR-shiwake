"""顧問先1件を「選択 → 送信 → 受信通知 → PDF出力 → 保存 → 印刷」まで通す本体。

論理的な段取りだけをここに書き、実際の画面操作はすべて profiles/*.yaml の
フローに委ねる。実機の画面が変わってもこのファイルは触らずに済むようにするため。

呼び出すフロー（settings.yaml の flows で名前を読み替えできる）:
  startup          … 1回だけ。アプリ起動・ログイン・暗証番号入力
  select_client    … 顧問先を開く（変数 client.* を使う）
  submit_*         … settings.yaml の submissions で指定した送信フロー
  fetch_receipts   … 受信通知を取り込む（任意）
  export_document  … 1書類を PDF 出力（変数 doc.* と output.path を使う）
  print_document   … 1書類を印刷（printing.source=app のとき）
  finish_client    … 顧問先を閉じる・後片付け（任意）
  shutdown         … 1回だけ。任意
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .audit import RunLog, ScreenshotStore
from .clients import Client
from .config import MODE_LIVE, Settings
from .engine.profile import Profile
from .engine.runner import Confirmer, RunContext, Runner
from .errors import AbortRun, ConfirmationDeclined, RpaError, SubmitBlocked
from .output import OutputTarget, apply_conflict_policy, build_context, ensure_folder, plan_outputs
from .printing import print_pdf
from .secrets import SecretVault

# 論理フロー名 → 既定のフロー名
FLOW_STARTUP = "startup"
FLOW_SELECT_CLIENT = "select_client"
FLOW_FETCH_RECEIPTS = "fetch_receipts"
FLOW_EXPORT_DOCUMENT = "export_document"
FLOW_PRINT_DOCUMENT = "print_document"
FLOW_FINISH_CLIENT = "finish_client"
FLOW_SHUTDOWN = "shutdown"


@dataclass
class DocumentResult:
    doc_key: str
    doc_label: str
    path: str = ""
    saved: bool = False
    printed: bool = False
    skipped: bool = False
    error: str = ""


@dataclass
class SubmissionResult:
    key: str
    label: str
    submitted: bool = False
    blocked: bool = False        # 練習モードで手前まで到達した
    error: str = ""


@dataclass
class ClientResult:
    client: Client
    submissions: list[SubmissionResult] = field(default_factory=list)
    documents: list[DocumentResult] = field(default_factory=list)
    error: str = ""
    aborted: bool = False
    seconds: float = 0.0

    @property
    def ok(self) -> bool:
        if self.error:
            return False
        if any(s.error for s in self.submissions):
            return False
        return not any(d.error for d in self.documents)

    @property
    def saved_count(self) -> int:
        return sum(1 for d in self.documents if d.saved)

    @property
    def printed_count(self) -> int:
        return sum(1 for d in self.documents if d.printed)


@dataclass
class RunResult:
    results: list[ClientResult] = field(default_factory=list)
    mode: str = ""
    run_id: str = ""
    stopped_early: bool = False

    @property
    def ok(self) -> bool:
        return all(r.ok for r in self.results) and not self.stopped_early

    def summary_lines(self) -> list[str]:
        lines = []
        for r in self.results:
            mark = "OK " if r.ok else "NG "
            subs = ", ".join(
                f"{s.label}:{'送信済' if s.submitted else ('停止' if s.blocked else '未')}"
                for s in r.submissions
            ) or "送信なし"
            lines.append(
                f"  {mark}{r.client.label}  保存 {r.saved_count}/{len(r.documents)}"
                f" 印刷 {r.printed_count}  {subs}"
                + (f"  ← {r.error}" if r.error else "")
            )
        return lines


class Pipeline:
    """顧問先の並びを順に処理する。"""

    def __init__(
        self,
        settings: Settings,
        profile: Profile,
        backend: Any,
        log: RunLog,
        vault: SecretVault,
        shots: ScreenshotStore,
        confirmer: Confirmer,
    ):
        self.settings = settings
        self.profile = profile
        self.log = log
        self.confirmer = confirmer
        self.ctx = RunContext(
            settings=settings,
            profile=profile,
            backend=backend,
            log=log,
            vault=vault,
            shots=shots,
            confirmer=confirmer,
            vars=dict(settings.base_context()),
        )
        self.ctx.vars.setdefault("vars", {})
        self.ctx.vars["vars"].update(profile.vars)
        self.runner = Runner(self.ctx)

    # -----------------------------------------------------------------
    def run(self, clients: list[Client]) -> RunResult:
        result = RunResult(mode=self.settings.run.mode, run_id=self.log.run_id)

        self.log.event(
            "plan",
            message=(
                f"対象 {len(clients)} 件 / モード: {_mode_label(self.settings.run.mode)}"
            ),
            clients=[c.label for c in clients],
        )

        self._run_optional_flow(FLOW_STARTUP, required=True)

        for i, client in enumerate(clients, start=1):
            self.log.event(
                "client_start",
                message=f"\n=== ({i}/{len(clients)}) {client.label} ===",
                client_code=client.code, client_name=client.name,
            )
            r = self._run_client(client)
            result.results.append(r)

            if r.aborted:
                result.stopped_early = True
                self.log.error(f"中断しました: {client.label} — {r.error}")
                break
            if not r.ok and self.settings.run.stop_on_error:
                result.stopped_early = True
                self.log.error(
                    f"失敗したため以降を中止しました: {client.label} — {r.error}\n"
                    f"  残りを続けたい場合は settings.yaml の run.stop_on_error を false にしてください。"
                )
                break

        self._run_optional_flow(FLOW_SHUTDOWN)
        return result

    # -----------------------------------------------------------------
    def _run_client(self, client: Client) -> ClientResult:
        started = time.monotonic()
        result = ClientResult(client=client)
        self._bind_client(client)

        try:
            # 保存先を先に全部決めて、書き込めることを確かめてから作業に入る。
            # PDF を作らせた後で「保存先が無い」と分かるのが一番もったいない。
            targets = plan_outputs(self.settings, client)
            for t in targets:
                ensure_folder(t, create=self.settings.paths.create_folders)
            self.log.info(f"  保存先: {targets[0].folder}" if targets else "  出力対象の書類がありません")
            for t in targets:
                self.log.event("plan_file", level="debug",
                               message=f"    - {t.doc.label} → {t.filename}")

            if self.settings.run.confirm_each_client and not self.ctx.is_simulate:
                self._confirm_client(client, targets)

            self.runner.run_flow(self.settings.flow_name(FLOW_SELECT_CLIENT))

            # 失敗して途中で抜けても、そこまでの記録が残るように
            # 結果オブジェクトへ直接書き込ませる。
            # 「どこまで送ったか／どこまで保存できたか」は事後確認に必須。
            self._submit_all(client, result.submissions)

            self._run_optional_flow(FLOW_FETCH_RECEIPTS)

            self._export_all(client, targets, result.documents, result.submissions)

        except ConfirmationDeclined as exc:
            result.error = str(exc)
            result.aborted = True
        except AbortRun as exc:
            result.error = str(exc)
            result.aborted = True
            self.log.error(f"  {exc}")
        except RpaError as exc:
            result.error = str(exc)
            self.log.error(f"  {exc}")
        except OSError as exc:
            result.error = f"ファイル操作に失敗しました: {exc}"
            self.log.error(f"  {result.error}")
        finally:
            try:
                self._run_optional_flow(FLOW_FINISH_CLIENT)
            except RpaError as exc:
                self.log.warn(f"  後片付けに失敗しました（続行します）: {exc}")
            result.seconds = time.monotonic() - started

        self.log.event(
            "client_end",
            level="info" if result.ok else "error",
            message=(
                f"  {'完了' if result.ok else '失敗'}: {client.label}"
                f"（{result.seconds:.0f}秒 / 保存 {result.saved_count} 件"
                f" / 印刷 {result.printed_count} 件）"
            ),
            client_code=client.code,
        )
        return result

    # -----------------------------------------------------------------
    def _bind_client(self, client: Client) -> None:
        self.ctx.vars.update(build_context(self.settings, client))
        self.ctx.vars["client"]["label"] = client.label
        self.ctx.produced_files.clear()
        self.ctx.blocked.clear()

    def _confirm_client(self, client: Client, targets: list[OutputTarget]) -> None:
        subs = self.settings.submissions_for(client)
        lines = [
            "これから次の顧問先を処理します。",
            f"  顧問先 : {client.code} {client.name}",
            f"  年度   : {client.fiscal_year or '(未設定)'}",
            f"  消費税 : {'課税事業者' if client.consumption_tax else '免税事業者（消費税申告なし）'}",
            f"  送信   : {', '.join(s.label for s in subs) or '(なし)'}",
            f"  保存先 : {targets[0].folder if targets else '(なし)'}",
            f"  書類   : {len(targets)} 件",
        ]
        for t in targets[:12]:
            lines.append(f"           - {t.filename}" + ("  ※同名あり" if t.existed else ""))
        if len(targets) > 12:
            lines.append(f"           …ほか {len(targets) - 12} 件")
        lines.append(
            f"  モード : {_mode_label(self.settings.run.mode)}"
        )
        if not self.ctx.is_live:
            lines.append("  ※ 練習モードのため、送信ボタンの直前で停止します。")

        if not self.confirmer.confirm("\n".join(lines), danger=self.ctx.is_live):
            raise ConfirmationDeclined(f"利用者が中止しました: {client.label}")

    # -----------------------------------------------------------------
    def _submit_all(self, client: Client, results: list[SubmissionResult]) -> list[SubmissionResult]:
        for spec in self.settings.submissions_for(client):
            r = SubmissionResult(key=spec.key, label=spec.label)
            self.ctx.set_var("submission", {"key": spec.key, "label": spec.label})
            self.log.info(f"  ▶ 送信: {spec.label}")
            try:
                if not self.profile.has_flow(spec.flow):
                    raise RpaError(
                        f"送信フロー '{spec.flow}' が {self.profile.source} にありません。"
                        f" settings.yaml の submissions[{spec.key}].flow を確認してください。"
                    )
                self.runner.run_flow(spec.flow)
                r.submitted = self.settings.run.mode == MODE_LIVE
            except SubmitBlocked as exc:
                # 練習モードの意図した停止。失敗ではない。
                r.blocked = True
                self.log.info(f"    {exc}")
            except AbortRun:
                raise
            except RpaError as exc:
                r.error = str(exc)
                self.log.error(f"    送信に失敗しました（{spec.label}）: {exc}")
                raise
            finally:
                results.append(r)
        return results

    # -----------------------------------------------------------------
    def _export_all(
        self,
        client: Client,
        targets: list[OutputTarget],
        results: list[DocumentResult],
        submissions: list[SubmissionResult],
    ) -> list[DocumentResult]:
        export_flow = self.settings.flow_name(FLOW_EXPORT_DOCUMENT)
        print_flow = self.settings.flow_name(FLOW_PRINT_DOCUMENT)
        submitted = {s.key for s in submissions if s.submitted}

        for target in targets:
            doc = target.doc
            r = DocumentResult(doc_key=doc.key, doc_label=doc.label)

            # 受信通知は送信して初めて存在する。練習モードや、その送信を
            # 行わなかった顧問先では出力できないので、失敗ではなく省略にする。
            if doc.depends_on_submission and doc.depends_on_submission not in submitted:
                r.skipped = True
                reason = (
                    "練習モードで送信していないため"
                    if not self.ctx.is_live
                    else f"'{doc.depends_on_submission}' を送信していないため"
                )
                self.log.info(f"  – {doc.label}: {reason}省略します")
                results.append(r)
                continue

            resolved = apply_conflict_policy(target, self.settings.paths.on_existing)
            if resolved is None:
                r.skipped = True
                r.path = str(target.path)
                self.log.info(f"  – 既にあるため省略: {target.filename}")
                results.append(r)
                continue
            target = resolved
            r.path = str(target.path)

            self.ctx.set_var("doc", {**doc.as_context(), "export_method": doc.export_method})
            self.ctx.set_var("output", target.as_context())

            flow = doc.export_flow or export_flow
            self.log.info(f"  ▶ 出力: {doc.label} → {target.filename}")
            try:
                if not self.profile.has_flow(flow):
                    raise RpaError(
                        f"出力フロー '{flow}' が {self.profile.source} にありません。"
                        f" settings.yaml の documents[{doc.key}].export_flow か"
                        f" flows.export_document を確認してください。"
                    )
                self.runner.run_flow(flow)
                r.saved = self.ctx.is_simulate or target.path.exists()
                if not r.saved:
                    raise RpaError(
                        f"出力したはずのファイルがありません: {target.path}\n"
                        f"  フロー '{flow}' の最後に expect_file を入れて、"
                        f"  実際に保存されたことを確かめてください。"
                    )
            except AbortRun:
                raise
            except RpaError as exc:
                r.error = str(exc)
                self.log.error(f"    出力に失敗しました（{doc.label}）: {exc}")
                if doc.required:
                    results.append(r)
                    raise
                self.log.warn(f"    必須ではないため続行します: {doc.label}")
                results.append(r)
                continue

            # --- 印刷 -------------------------------------------------
            if self._should_print(doc):
                try:
                    self._print_document(doc, target, print_flow)
                    r.printed = True
                except AbortRun:
                    raise
                except RpaError as exc:
                    # 保存は済んでいるので、印刷の失敗で全体を止めない。
                    # 紙は後から出し直せるが、送信のやり直しはきかないため。
                    r.error = f"印刷に失敗しました: {exc}"
                    self.log.warn(f"    印刷に失敗しました（{doc.label}）: {exc}")

            results.append(r)
        return results

    def _should_print(self, doc) -> bool:
        return self.settings.printing.enabled and doc.print_enabled

    def _print_document(self, doc, target: OutputTarget, print_flow: str) -> None:
        copies = doc.copies or self.settings.printing.copies
        printer = target.client.printer or self.settings.printing.printer

        if self.settings.printing.source == "pdf":
            if self.ctx.is_simulate:
                self.log.info(f"  [検証モード] 印刷を想定: {target.filename} × {copies}")
                return
            self.log.info(f"  ▶ 印刷: {target.filename} × {copies}")
            print_pdf(
                target.path,
                printer=printer or None,
                copies=copies,
                command=self.settings.printing.pdf_print_command or None,
                log=self.log,
            )
            return

        flow = doc.print_flow or print_flow
        if not self.profile.has_flow(flow):
            raise RpaError(
                f"印刷フロー '{flow}' が {self.profile.source} にありません。"
                f" アプリから印刷しない運用なら settings.yaml の printing.source を"
                f" 'pdf' にするか、printing.enabled を false にしてください。"
            )
        self.ctx.set_var("print", {"printer": printer, "copies": copies})
        self.log.info(f"  ▶ 印刷: {doc.label} × {copies}")
        self.runner.run_flow(flow)

    # -----------------------------------------------------------------
    def _run_optional_flow(self, logical: str, *, required: bool = False) -> None:
        name = self.settings.flow_name(logical)
        if not self.profile.has_flow(name):
            if required:
                raise RpaError(
                    f"フロー '{name}' が {self.profile.source} にありません。"
                    f" 最低限 {name} は定義してください。"
                )
            return
        self.runner.run_flow(name)


def _mode_label(mode: str) -> str:
    return {
        "rehearsal": "練習（送信の直前で停止）",
        "live": "本番（実際に送信します）",
        "simulate": "検証（画面を触りません）",
    }.get(mode, mode)


def write_report(result: RunResult, path: str | Path) -> Path:
    """実行結果を1枚の表にして残す（事務所の作業記録用）。"""
    import csv

    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("w", encoding="utf-8-sig", newline="") as fh:
        w = csv.writer(fh)
        w.writerow([
            "顧問先コード", "会社名", "結果", "モード", "送信", "書類", "保存先", "保存", "印刷", "備考",
        ])
        for r in result.results:
            subs = "; ".join(
                f"{s.label}={'送信済' if s.submitted else ('停止' if s.blocked else '未送信')}"
                for s in r.submissions
            )
            for d in r.documents:
                w.writerow([
                    r.client.code, r.client.name,
                    "OK" if not d.error and not d.skipped else ("省略" if d.skipped else "NG"),
                    result.mode, subs, d.doc_label, d.path,
                    "○" if d.saved else "", "○" if d.printed else "",
                    d.error or r.error,
                ])
            if not r.documents:
                w.writerow([
                    r.client.code, r.client.name, "OK" if r.ok else "NG",
                    result.mode, subs, "", "", "", "", r.error,
                ])
    return p
