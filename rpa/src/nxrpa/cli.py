"""コマンドライン入口。

  nxrpa run       申告～PDF保存～印刷を実行する
  nxrpa check     設定と画面手順定義を検証する（画面を触らない）
  nxrpa clients   顧問先マスタを一覧表示する
  nxrpa plan      指定した顧問先の保存先・対象書類を表示する（実行しない）
  nxrpa inspect   実機の画面部品を採取する（手順定義を書くための道具）
  nxrpa printers  使えるプリンタを一覧表示する
  nxrpa init      設定ファイルのひな形を作る
  nxrpa gui       画面（顧問先選択と暗証番号入力）を出す

【重要】暗証番号はコマンドライン引数から受け取らない。
他プロセスから見えてしまうため、必ず対話入力にする。
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import __version__
from .audit import RunLog, ScreenshotStore, sweep_logs
from .clients import ClientBook, load_clients, write_sample
from .config import MODE_LIVE, MODE_REHEARSAL, MODE_SIMULATE, Settings, load_settings
from .engine.profile import load_profile
from .errors import ConfigError, RpaError
from .output import plan_outputs
from .pipeline import Pipeline, RunResult, write_report
from .printing import default_printer, list_printers, validate_printer
from .secrets import SecretVault, prompt_pin

DEFAULT_CONFIG = "config/settings.yaml"


# ---------------------------------------------------------------------
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="nxrpa",
        description="MJS ACELINK NX-PRO 電子申告の自動化（申告 → 受信通知 → PDF保存 → 印刷）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "例:\n"
            "  nxrpa check                         設定の検証だけ行う\n"
            "  nxrpa plan --client 1001            1001 の保存先を確認する\n"
            "  nxrpa run --client 1001             練習モードで実行（送信の直前で停止）\n"
            "  nxrpa run --client 1001 --mode live 本番モードで実行（実際に送信）\n"
            "  nxrpa inspect --windows             開いているウィンドウを一覧表示\n"
        ),
    )
    p.add_argument("--version", action="version", version=f"nxrpa {__version__}")
    sub = p.add_subparsers(dest="command", required=True)

    def common(sp):
        sp.add_argument("--config", default=DEFAULT_CONFIG, help="設定ファイル（既定: config/settings.yaml）")
        return sp

    # run --------------------------------------------------------------
    run = common(sub.add_parser("run", help="申告～PDF保存～印刷を実行する"))
    run.add_argument("--client", "-c", action="append", default=[],
                     help="顧問先コード。複数回指定できる")
    run.add_argument("--all", action="store_true", help="顧問先マスタの有効な全件を対象にする")
    run.add_argument("--mode", choices=[MODE_REHEARSAL, MODE_LIVE, MODE_SIMULATE],
                     help="実行モード（既定は設定ファイルの run.mode）")
    run.add_argument("--no-print", action="store_true", help="印刷しない")
    run.add_argument("--no-submit", action="store_true",
                     help="送信を行わず、PDF出力と印刷だけ行う")
    run.add_argument("--output-root", help="保存先のルートを一時的に差し替える")
    run.add_argument("--yes", "-y", action="store_true",
                     help="顧問先ごとの確認を省く（本番送信の確認は省けない）")
    run.add_argument("--quiet", action="store_true", help="画面出力を減らす")

    # check ------------------------------------------------------------
    check = common(sub.add_parser("check", help="設定と画面手順定義を検証する（画面を触らない）"))
    check.add_argument("--client", "-c", action="append", default=[],
                       help="この顧問先で通し検証する（省略時は全件の保存先だけ検証）")
    check.add_argument("--run", action="store_true",
                       help="手順を最後まで模擬実行する（simulate モード）")

    # clients ----------------------------------------------------------
    common(sub.add_parser("clients", help="顧問先マスタを一覧表示する"))

    # plan -------------------------------------------------------------
    plan = common(sub.add_parser("plan", help="保存先と対象書類を表示する（実行しない）"))
    plan.add_argument("--client", "-c", action="append", default=[])
    plan.add_argument("--all", action="store_true")

    # inspect ----------------------------------------------------------
    insp = sub.add_parser("inspect", help="実機の画面部品を採取する")
    insp.add_argument("--windows", action="store_true", help="開いているウィンドウを一覧表示")
    insp.add_argument("--title", help="このタイトル（正規表現）のウィンドウの中を調べる")
    insp.add_argument("--depth", type=int, default=6, help="調べる深さ（既定 6）")
    insp.add_argument("--delay", type=float, default=0.0,
                      help="開始まで待つ秒数。対象の画面を出す時間を作る")
    insp.add_argument("--out", help="結果を YAML で書き出す")
    insp.add_argument("--find", help="この文字を含む部品だけ表示する")

    # printers ---------------------------------------------------------
    sub.add_parser("printers", help="使えるプリンタを一覧表示する")

    # init -------------------------------------------------------------
    init = sub.add_parser("init", help="設定ファイルのひな形を作る")
    init.add_argument("--dir", default=".", help="作る場所（既定: カレント）")
    init.add_argument("--force", action="store_true", help="既にあっても上書きする")

    # gui --------------------------------------------------------------
    common(sub.add_parser("gui", help="画面を出す（顧問先選択と暗証番号入力）"))

    return p


# ---------------------------------------------------------------------
def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return _dispatch(args)
    except ConfigError as exc:
        print(f"\n[設定エラー] {exc}\n", file=sys.stderr)
        return 2
    except RpaError as exc:
        print(f"\n[エラー] {exc}\n", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\n中断しました。", file=sys.stderr)
        return 130


def _dispatch(args) -> int:
    if args.command == "init":
        return cmd_init(args)
    if args.command == "inspect":
        return cmd_inspect(args)
    if args.command == "printers":
        return cmd_printers(args)
    if args.command == "gui":
        return cmd_gui(args)

    settings = load_settings(args.config)
    if args.command == "clients":
        return cmd_clients(settings)
    if args.command == "plan":
        return cmd_plan(settings, args)
    if args.command == "check":
        return cmd_check(settings, args)
    if args.command == "run":
        return cmd_run(settings, args)
    raise ConfigError(f"不明なコマンド: {args.command}")


# ---------------------------------------------------------------------
def cmd_init(args) -> int:
    from .scaffold import scaffold

    created = scaffold(Path(args.dir), force=args.force)
    print("設定ファイルのひな形を作りました:")
    for path in created:
        print(f"  {path}")
    print(
        "\n次の手順:\n"
        "  1. config/clients.csv に顧問先を登録する\n"
        "  2. config/settings.yaml の保存先（paths.output_root）とプリンタを設定する\n"
        "  3. NX-PRO を開いた状態で `nxrpa inspect --windows` を実行し、画面名を確認する\n"
        "  4. config/profiles/*.yaml に手順を書く（ひな形のコメントを参照）\n"
        "  5. `nxrpa check --run` で検証 → `nxrpa run -c <コード>` で練習\n"
    )
    return 0


def cmd_printers(args) -> int:
    printers = list_printers()
    if not printers:
        print("プリンタ一覧を取得できませんでした（Windows 以外か、pywin32 が未導入）。")
        return 1
    current = default_printer()
    print("使えるプリンタ:")
    for name in printers:
        print(f"  {'*' if name == current else ' '} {name}")
    print("\n（* が既定のプリンタ）")
    return 0


def cmd_clients(settings: Settings) -> int:
    book = _load_book(settings)
    print(f"顧問先マスタ: {book.source}（{len(book)} 件）\n")
    print(f"  {'コード':<10} {'会社名':<28} {'年度':<8} {'消費税':<6} 対象書類")
    print("  " + "-" * 88)
    for c in book:
        docs = ",".join(c.documents) if c.documents else "(既定)"
        mark = " " if c.enabled else "×"
        print(f"{mark} {c.code:<10} {c.name:<28} {c.fiscal_year:<8} "
              f"{'課税' if c.consumption_tax else '免税':<6} {docs}")
    disabled = len(book) - len(book.enabled())
    if disabled:
        print(f"\n（× は対象外の {disabled} 件）")
    return 0


def cmd_plan(settings: Settings, args) -> int:
    book = _load_book(settings)
    targets = _select_clients(book, args.client, getattr(args, "all", False))
    for client in targets:
        print(f"\n=== {client.label} ===")
        subs = settings.submissions_for(client)
        print(f"  送信 : {', '.join(s.label for s in subs) or '(なし)'}")
        outs = plan_outputs(settings, client)
        if not outs:
            print("  書類 : (なし)")
            continue
        print(f"  保存先: {outs[0].folder}")
        for t in outs:
            flag = "  ※同名あり" if t.existed else ""
            print(f"    - {t.doc.label:<20} {t.filename}{flag}")
    print()
    return 0


def cmd_check(settings: Settings, args) -> int:
    """実機に触らずに、設定・手順定義・保存先をまとめて検証する。"""
    problems: list[str] = []
    print(f"設定       : {settings.source}")
    print(f"モード     : {settings.run.mode}")
    print(f"保存先     : {settings.resolve(settings.paths.output_root)}")
    print(f"書類       : {len(settings.documents)} 種類")
    print(f"送信       : {', '.join(s.label for s in settings.submissions) or '(なし)'}")

    # 画面手順定義
    profiles = {}
    for key in settings.apps:
        path = settings.profile_path(key)
        try:
            profiles[key] = load_profile(path)
            print(f"手順定義   : {key} → {path}（OK / フロー {len(profiles[key].flows)} 件）")
        except RpaError as exc:
            problems.append(str(exc))
            print(f"手順定義   : {key} → {path}（NG）")

    # 顧問先マスタと保存先
    book = _load_book(settings)
    print(f"顧問先     : {len(book)} 件（有効 {len(book.enabled())} 件）")
    for client in book.enabled():
        try:
            plan_outputs(settings, client)
        except RpaError as exc:
            problems.append(f"{client.label}: {exc}")

    # プリンタ
    if settings.printing.enabled:
        try:
            validate_printer(settings.printing.printer or None)
            print(f"プリンタ   : {settings.printing.printer or '（既定プリンタ）'}")
        except RpaError as exc:
            problems.append(str(exc))

    # 送信フロー・出力フローの存在確認
    profile = profiles.get(settings.default_app)
    if profile is not None:
        for spec in settings.submissions:
            if not profile.has_flow(spec.flow):
                problems.append(
                    f"送信フロー '{spec.flow}'（{spec.label}）が {profile.source} にありません"
                )
        for doc in settings.documents:
            flow = doc.export_flow or settings.flow_name("export_document")
            if not profile.has_flow(flow):
                problems.append(f"出力フロー '{flow}'（{doc.label}）が {profile.source} にありません")

    if problems:
        print(f"\n[問題 {len(problems)} 件]")
        for msg in problems:
            print(f"  - {msg}")
        return 1

    print("\n設定に問題は見つかりませんでした。")

    if args.run:
        codes = args.client or [c.code for c in book.enabled()[:1]]
        print(f"\n模擬実行（画面を触りません）: {', '.join(codes)}")
        from dataclasses import replace

        settings.run = replace(settings.run, mode=MODE_SIMULATE, confirm_each_client=False)
        result = _execute(settings, book, codes, quiet=False)
        return 0 if result.ok else 1
    return 0


def cmd_run(settings: Settings, args) -> int:
    from dataclasses import replace

    if args.mode:
        settings.run = replace(settings.run, mode=args.mode)
    if args.no_print:
        settings.printing = replace(settings.printing, enabled=False)
    if args.yes:
        settings.run = replace(settings.run, confirm_each_client=False)
    if args.output_root:
        settings.paths = replace(settings.paths, output_root=args.output_root)
    if args.no_submit:
        settings.submissions = ()

    book = _load_book(settings)
    codes = _codes(book, args.client, args.all)

    if settings.run.mode == MODE_LIVE:
        print(
            "\n" + "!" * 68 + "\n"
            "本番モードです。実際に電子申告データを送信します。送信は取り消せません。\n"
            + "!" * 68
        )

    result = _execute(settings, book, codes, quiet=args.quiet)
    return 0 if result.ok else 1


def cmd_gui(args) -> int:
    from .gui import launch

    return launch(args.config)


def cmd_inspect(args) -> int:
    from .inspector import run_inspector

    return run_inspector(args)


# ---------------------------------------------------------------------
def _load_book(settings: Settings) -> ClientBook:
    return load_clients(settings.resolve(settings.clients_file))


def _codes(book: ClientBook, requested: list[str], take_all: bool) -> list[str]:
    if take_all:
        return [c.code for c in book.enabled()]
    if not requested:
        raise ConfigError(
            "対象の顧問先を指定してください（--client <コード> または --all）。\n"
            "登録済みの顧問先は `nxrpa clients` で確認できます。"
        )
    return requested


def _select_clients(book: ClientBook, requested: list[str], take_all: bool):
    return [book.by_code(code) for code in _codes(book, requested, take_all)]


def _execute(settings: Settings, book: ClientBook, codes: list[str], *, quiet: bool) -> RunResult:
    """実行の共通部分。ログ・暗証番号・バックエンドの用意と後始末。"""
    from .engine.runner import ConsoleConfirmer

    clients = [book.by_code(code) for code in codes]
    log_dir = settings.resolve(settings.paths.log_dir)
    shot_dir = settings.resolve(settings.paths.screenshot_dir)

    with SecretVault() as vault:
        log = RunLog.create(log_dir, vault=vault, echo=not quiet)
        shots = ScreenshotStore(shot_dir, log.run_id, keep_days=settings.run.keep_screenshots_days)
        result = RunResult(mode=settings.run.mode, run_id=log.run_id)
        try:
            profile = load_profile(settings.profile_path(settings.default_app))

            if settings.run.mode != MODE_SIMULATE:
                # 秘密情報ごとに別々に尋ねる。NX-Pro の担当者パスワードと
                # カードの暗証番号は別物なので、まとめて1回にしてはいけない。
                for spec in settings.secrets:
                    print()
                    print(spec.prompt_text())
                    vault.put(spec.name, prompt_pin(spec.label))

            backend = _make_backend(settings)
            pipeline = Pipeline(settings, profile, backend, log, vault, shots, ConsoleConfirmer())
            result = pipeline.run(clients)

            report = write_report(result, log_dir / f"result-{log.run_id}.csv")
            print("\n" + "=" * 68)
            print(f"結果（{settings.run.mode}）")
            for line in result.summary_lines():
                print(line)
            print(f"\n  ログ  : {log.text_path}")
            print(f"  記録  : {report}")
            print("=" * 68 + "\n")

            log.finish(ok=result.ok, clients=len(clients),
                       saved=sum(r.saved_count for r in result.results))
        except RpaError as exc:
            log.error(str(exc))
            log.finish(ok=False)
            raise
        finally:
            shots.sweep(shot_dir)
            sweep_logs(log_dir, settings.run.keep_screenshots_days)
    return result


def _make_backend(settings: Settings):
    if settings.run.mode == MODE_SIMULATE:
        from .engine.backend import FakeBackend

        return FakeBackend()
    from .engine.windows_backend import WindowsBackend

    return WindowsBackend(default_timeout=settings.run.step_timeout_sec)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
