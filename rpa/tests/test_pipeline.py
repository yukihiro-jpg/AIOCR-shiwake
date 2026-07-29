"""顧問先1件を通しで流したときの挙動を、Windows 無しで検証する。

ここで確かめたい一番大事なこと:
  - 練習モードでは絶対に送信しない
  - 本番モードでも、確認を通らなければ送信しない
  - 暗証番号の入力は再試行しない（カードのロックを防ぐ）
  - 保存先とファイル名が「顧問先名＋資料名」になる
  - 免税事業者に消費税の申告・書類が回らない
"""

import pytest

from nxrpa.audit import RunLog, ScreenshotStore
from nxrpa.clients import load_clients
from nxrpa.config import load_settings
from nxrpa.engine.backend import FakeBackend
from nxrpa.engine.profile import load_profile
from nxrpa.engine.runner import AutoConfirmer
from nxrpa.errors import PinError
from nxrpa.pipeline import Pipeline
from nxrpa.secrets import SecretVault

SETTINGS = """
run:
  mode: rehearsal
  confirm_each_client: false
  step_pause_sec: 0
  retry: 1
  retry_wait_sec: 0
paths:
  output_root: '__ROOT__/out'
  folder_template: '{client.code}_{client.name}'
  file_template: '{client.name}_{doc.label}'
  log_dir: '__ROOT__/logs'
  screenshot_dir: '__ROOT__/logs/shots'
printing:
  enabled: true
  source: app
apps:
  nxpro:
    profile: p.yaml
documents:
  - {key: kessansho, label: 決算書, order: 1}
  - {key: houjinzei, label: 法人税申告書, order: 2}
  - {key: shouhizei, label: 消費税申告書, requires_consumption_tax: true, order: 3}
submissions:
  - {key: national, label: 国税, flow: submit_national}
  - {key: consumption, label: 消費税, flow: submit_consumption, requires_consumption_tax: true}
"""

PROFILE = """
name: テスト用
windows:
  main:
    title_re: '.*テスト.*'
  save_dialog:
    title_re: '保存'
  pin_dialog:
    title_re: '暗証番号'
flows:
  startup:
    steps:
      - {action: log, message: '起動しました'}

  select_client:
    steps:
      - {action: focus_window, window: main}
      - action: set_text
        window: main
        target: {auto_id: txtCode}
        text: '{client.code}'
      - {action: log, message: '顧問先を開きました: {client.name}'}

  sign:
    steps:
      - action: type_secret
        window: pin_dialog
        target: {auto_id: txtPin}
        secret: pin_tax_accountant

  submit_national:
    steps:
      - {action: run_flow, flow: sign}
      - action: irreversible
        description: '国税を送信'
        steps:
          - {action: click, window: main, target: {auto_id: btnSend}}
          - {action: log, message: '送信しました'}

  submit_consumption:
    steps:
      - {action: run_flow, flow: sign}
      - action: irreversible
        description: '消費税を送信'
        steps:
          - {action: click, window: main, target: {auto_id: btnSendTax}}

  export_document:
    steps:
      - action: click
        window: main
        target: {auto_id: btnPdf}
      - action: save_dialog
        window: save_dialog
        path: '{output.path}'
        filename_field: {auto_id: txtFileName}
        save_button: {auto_id: btnSave}
      - action: expect_file
        path: '{output.path}'
        timeout: 2
        min_bytes: 100
        stable_sec: 0

  print_document:
    steps:
      - {action: click, window: main, target: {auto_id: btnPrint}}
"""

CLIENTS = """顧問先コード,会社名,年度,消費税
1001,株式会社サンプル,2026,○
1002,免税商店,2026,×
"""


@pytest.fixture
def env(tmp_path):
    """設定・手順定義・顧問先マスタを一式そろえた作業場所。"""
    cfg = tmp_path / "config"
    (cfg / "profiles").mkdir(parents=True)
    (cfg / "settings.yaml").write_text(
        SETTINGS.replace("__ROOT__", str(tmp_path).replace("\\", "/")), encoding="utf-8"
    )
    (cfg / "profiles" / "p.yaml").write_text(PROFILE, encoding="utf-8")
    (cfg / "clients.csv").write_text(CLIENTS, encoding="utf-8-sig")
    return tmp_path


def build(env, *, mode="rehearsal", confirm=True, backend=None, **run_overrides):
    from dataclasses import replace

    settings = load_settings(env / "config" / "settings.yaml")
    settings.run = replace(settings.run, mode=mode, **run_overrides)
    profile = load_profile(env / "config" / "profiles" / "p.yaml")
    book = load_clients(env / "config" / "clients.csv")

    backend = backend if backend is not None else FakeBackend(save_on_set_text=True)
    vault = SecretVault()
    vault.put("pin_tax_accountant", "1234")
    log = RunLog.create(env / "logs", vault=vault, echo=False)
    shots = ScreenshotStore(env / "logs" / "shots", log.run_id)
    confirmer = AutoConfirmer(confirm)
    pipeline = Pipeline(settings, profile, backend, log, vault, shots, confirmer)
    return pipeline, book, backend, confirmer, log


# ---------------------------------------------------------------------
class Test練習モード:
    def test_送信せずに書類だけ出力する(self, env):
        pipeline, book, backend, _, _ = build(env)
        result = pipeline.run([book.by_code("1001")])

        r = result.results[0]
        # 送信は「停止」であって失敗ではない
        assert [s.blocked for s in r.submissions] == [True, True]
        assert [s.submitted for s in r.submissions] == [False, False]
        # 送信ボタンは押されていない
        assert "main/btnSend" not in backend.calls_of("find")

    def test_停止しても後続の書類出力は進む(self, env):
        pipeline, book, backend, _, _ = build(env)
        result = pipeline.run([book.by_code("1001")])
        r = result.results[0]
        assert r.saved_count == 3
        assert r.ok


class Test本番モード:
    def test_確認を通れば送信する(self, env):
        pipeline, book, backend, _, _ = build(env, mode="live")
        result = pipeline.run([book.by_code("1001")])

        r = result.results[0]
        assert [s.submitted for s in r.submissions] == [True, True]
        assert "main/btnSend" in backend.calls_of("find")

    def test_確認を断れば送信しない(self, env):
        pipeline, book, backend, _, _ = build(env, mode="live", confirm=False)
        result = pipeline.run([book.by_code("1001")])

        r = result.results[0]
        assert r.aborted
        assert not any(s.submitted for s in r.submissions)
        assert "main/btnSend" not in backend.calls_of("find")

    def test_送信の確認では顧問先名の打ち込みを求める(self, env):
        pipeline, book, _, confirmer, _ = build(env, mode="live")
        pipeline.run([book.by_code("1001")])
        # 確認文面に顧問先名が入っていること（別の顧問先を送る事故を防ぐ）
        assert any("株式会社サンプル" in m for m in confirmer.asked)


class Test免税事業者:
    def test_消費税の申告も書類も回らない(self, env):
        pipeline, book, _, _, _ = build(env)
        result = pipeline.run([book.by_code("1002")])
        r = result.results[0]
        assert [s.key for s in r.submissions] == ["national"]
        assert [d.doc_key for d in r.documents] == ["kessansho", "houjinzei"]


class Test保存先:
    def test_顧問先名と資料名でPDFが保存される(self, env):
        pipeline, book, backend, _, _ = build(env)
        pipeline.run([book.by_code("1001")])

        folder = env / "out" / "1001_株式会社サンプル"
        names = sorted(p.name for p in folder.glob("*.pdf"))
        assert names == [
            "株式会社サンプル_決算書.pdf",
            "株式会社サンプル_法人税申告書.pdf",
            "株式会社サンプル_消費税申告書.pdf",
        ]

    def test_同名があれば連番になる(self, env):
        folder = env / "out" / "1001_株式会社サンプル"
        folder.mkdir(parents=True)
        (folder / "株式会社サンプル_決算書.pdf").write_bytes(b"old")

        pipeline, book, _, _, _ = build(env)
        pipeline.run([book.by_code("1001")])
        assert (folder / "株式会社サンプル_決算書 (2).pdf").exists()
        assert (folder / "株式会社サンプル_決算書.pdf").read_bytes() == b"old"

    def test_出力できていなければ失敗にする(self, env):
        # 保存ダイアログを操作したのにファイルが出来ない＝出力に失敗している
        pipeline, book, _, _, _ = build(env, backend=FakeBackend(save_on_set_text=False))
        result = pipeline.run([book.by_code("1001")])
        assert not result.results[0].ok
        assert "できていません" in result.results[0].documents[0].error


class Test印刷:
    def test_保存した書類を印刷する(self, env):
        pipeline, book, backend, _, _ = build(env)
        result = pipeline.run([book.by_code("1001")])
        assert result.results[0].printed_count == 3
        assert backend.calls_of("find").count("main/btnPrint") == 3

    def test_印刷しない設定なら押さない(self, env):
        from dataclasses import replace

        pipeline, book, backend, _, _ = build(env)
        pipeline.settings.printing = replace(pipeline.settings.printing, enabled=False)
        result = pipeline.run([book.by_code("1001")])
        assert result.results[0].printed_count == 0
        assert "main/btnPrint" not in backend.calls_of("find")

    def test_印刷に失敗しても保存は残す(self, env):
        # 紙は出し直せるが、送信のやり直しはきかない。印刷失敗で全体を止めない
        backend = FakeBackend(save_on_set_text=True, missing={"main/btnPrint"})
        pipeline, book, _, _, _ = build(env, backend=backend)
        result = pipeline.run([book.by_code("1001")])
        r = result.results[0]
        assert r.saved_count == 3
        assert r.printed_count == 0


class Test暗証番号:
    def test_未入力なら送信に進まない(self, env):
        pipeline, book, backend, _, _ = build(env, mode="live")
        pipeline.ctx.vault.burn_all()
        result = pipeline.run([book.by_code("1001")])
        assert result.results[0].aborted
        assert "main/btnSend" not in backend.calls_of("find")

    def test_入力に失敗しても再試行しない(self, env):
        # 3回間違えるとカードがロックされる。1回で必ず止める
        backend = FakeBackend(save_on_set_text=True, missing={"pin_dialog/txtPin"})
        pipeline, book, _, _, _ = build(env, mode="live", retry=3)
        pipeline.ctx.backend = backend
        pipeline.runner.ctx.backend = backend

        result = pipeline.run([book.by_code("1001")])
        assert result.results[0].aborted
        # 暗証番号欄を探した回数が1回だけ＝再試行していない
        assert backend.calls_of("find").count("pin_dialog/txtPin") == 1

    def test_入力の失敗は専用の例外にする(self, env):
        from nxrpa.engine.runner import RunContext, Runner

        backend = FakeBackend(missing={"pin_dialog/txtPin"})
        pipeline, book, _, _, _ = build(env, mode="live")
        pipeline.ctx.backend = backend
        pipeline._bind_client(book.by_code("1001"))
        with pytest.raises(PinError):
            pipeline.runner.run_flow("sign")

    def test_ログに暗証番号が残らない(self, env):
        pipeline, book, _, _, log = build(env, mode="live")
        pipeline.run([book.by_code("1001")])
        log.finish(ok=True)
        assert "1234" not in log.text_path.read_text(encoding="utf-8")
        assert "1234" not in log.jsonl_path.read_text(encoding="utf-8")


class Test複数件:
    def test_1件失敗したら以降を止める(self, env):
        backend = FakeBackend(save_on_set_text=True, missing={"main/btnPdf"})
        pipeline, book, _, _, _ = build(env, backend=backend)
        result = pipeline.run([book.by_code("1001"), book.by_code("1002")])
        assert len(result.results) == 1
        assert result.stopped_early

    def test_止めない設定なら続ける(self, env):
        backend = FakeBackend(save_on_set_text=True, missing={"main/btnPdf"})
        pipeline, book, _, _, _ = build(env, backend=backend, stop_on_error=False)
        result = pipeline.run([book.by_code("1001"), book.by_code("1002")])
        assert len(result.results) == 2

    def test_中止は残りを流さない(self, env):
        pipeline, book, _, _, _ = build(env, mode="live", confirm=False)
        result = pipeline.run([book.by_code("1001"), book.by_code("1002")])
        assert len(result.results) == 1
        assert result.stopped_early


class Test記録:
    def test_実行結果をCSVに残す(self, env):
        from nxrpa.pipeline import write_report

        pipeline, book, _, _, _ = build(env)
        result = pipeline.run([book.by_code("1001")])
        path = write_report(result, env / "result.csv")
        text = path.read_text(encoding="utf-8-sig")
        assert "株式会社サンプル" in text
        assert "法人税申告書" in text
        assert text.startswith("﻿") or "顧問先コード" in text


class Test送信への依存:
    """受信通知は送信して初めて存在する。送っていなければ出力を試みない。"""

    PROFILE_WITH_RECEIPT = PROFILE + """
  export_receipt:
    steps:
      - action: click
        window: main
        target: {auto_id: btnReceiptPdf}
      - action: save_dialog
        window: save_dialog
        path: '{output.path}'
        filename_field: {auto_id: txtFileName}
        save_button: {auto_id: btnSave}
      - action: expect_file
        path: '{output.path}'
        timeout: 2
        min_bytes: 100
        stable_sec: 0
"""
    # 受信通知の書類を documents の末尾に足す（submissions の前に挿し込む）
    SETTINGS_WITH_RECEIPT = SETTINGS.replace(
        "submissions:",
        """  - key: juushin
    label: 受信通知（国税）
    export_flow: export_receipt
    depends_on_submission: national
    order: 9
submissions:""",
    )

    def setup_env(self, env):
        cfg = env / "config"
        cfg.mkdir(exist_ok=True)
        (cfg / "settings.yaml").write_text(
            self.SETTINGS_WITH_RECEIPT.replace("__ROOT__", str(env)), encoding="utf-8"
        )
        (cfg / "profiles" / "p.yaml").write_text(self.PROFILE_WITH_RECEIPT, encoding="utf-8")

    def test_練習モードでは受信通知を省略する(self, env):
        self.setup_env(env)
        pipeline, book, backend, _, _ = build(env)
        result = pipeline.run([book.by_code("1001")])
        r = result.results[0]
        juushin = [d for d in r.documents if d.doc_key == "juushin"][0]
        assert juushin.skipped
        assert not juushin.error
        assert r.ok            # 省略は失敗ではない
        assert "main/btnReceiptPdf" not in backend.calls_of("find")

    def test_本番で送信していれば出力する(self, env):
        self.setup_env(env)
        pipeline, book, backend, _, _ = build(env, mode="live")
        result = pipeline.run([book.by_code("1001")])
        juushin = [d for d in result.results[0].documents if d.doc_key == "juushin"][0]
        assert juushin.saved
        assert not juushin.skipped

    def test_未定義の送信を参照したら設定エラー(self, env):
        self.setup_env(env)
        cfg = env / "config" / "settings.yaml"
        cfg.write_text(
            cfg.read_text(encoding="utf-8").replace(
                "depends_on_submission: national", "depends_on_submission: ないキー"),
            encoding="utf-8",
        )
        from nxrpa.config import load_settings
        from nxrpa.errors import ConfigError

        with pytest.raises(ConfigError, match="ないキー"):
            load_settings(cfg)
