"""ステップ実行エンジンの基本動作の検証。"""

import pytest
import yaml

from nxrpa.audit import RunLog, ScreenshotStore
from nxrpa.config import load_settings
from nxrpa.engine.backend import FakeBackend
from nxrpa.engine.profile import load_profile
from nxrpa.engine.runner import AutoConfirmer, RunContext, Runner
from nxrpa.errors import AssertionFailed, ConfirmationDeclined, StepFailed, SubmitBlocked
from nxrpa.secrets import SecretVault

SETTINGS = """
run:
  mode: rehearsal
  step_pause_sec: 0
  retry: 2
  retry_wait_sec: 0
paths:
  output_root: '__ROOT__/out'
  log_dir: '__ROOT__/logs'
apps: {nxpro: {profile: p.yaml}}
documents: [{key: a, label: 資料A}]
"""


def make(env, profile_body: str, *, mode="rehearsal", backend=None, confirm=True, **vars_):
    cfg = env / "config"
    (cfg / "profiles").mkdir(parents=True, exist_ok=True)
    (cfg / "settings.yaml").write_text(
        SETTINGS.replace("__ROOT__", str(env)), encoding="utf-8"
    )
    (cfg / "profiles" / "p.yaml").write_text(profile_body, encoding="utf-8")

    from dataclasses import replace

    settings = load_settings(cfg / "settings.yaml")
    settings.run = replace(settings.run, mode=mode)
    profile = load_profile(cfg / "profiles" / "p.yaml")
    backend = backend if backend is not None else FakeBackend()
    vault = SecretVault()
    log = RunLog.create(env / "logs", vault=vault, echo=False)
    ctx = RunContext(
        settings=settings, profile=profile, backend=backend, log=log, vault=vault,
        shots=ScreenshotStore(env / "logs" / "shots", log.run_id),
        confirmer=AutoConfirmer(confirm), vars=dict(settings.base_context()),
    )
    ctx.vars.update(vars_)
    return Runner(ctx), ctx, backend


def prof(steps: str, extra: str = "") -> str:
    return f"""
name: t
windows:
  main: {{title_re: '.*'}}
{extra}
flows:
  f:
    steps:
{steps}
"""


class Test条件:
    def test_whenが一致したら実行する(self, tmp_path):
        r, ctx, _ = make(tmp_path, prof(
            "      - {action: set_var, name: hit, value: 'yes', when: {var: doc.key, equals: a}}"
        ), doc={"key": "a"})
        r.run_flow("f")
        assert ctx.lookup("hit") == "yes"

    def test_whenが不一致なら飛ばす(self, tmp_path):
        r, ctx, _ = make(tmp_path, prof(
            "      - {action: set_var, name: hit, value: 'yes', when: {var: doc.key, equals: b}}"
        ), doc={"key": "a"})
        r.run_flow("f")
        assert ctx.lookup("hit") is None

    def test_unlessは反転する(self, tmp_path):
        r, ctx, _ = make(tmp_path, prof(
            "      - {action: set_var, name: hit, value: 'yes', unless: {var: doc.key, equals: a}}"
        ), doc={"key": "a"})
        r.run_flow("f")
        assert ctx.lookup("hit") is None

    def test_真偽値で判定できる(self, tmp_path):
        r, ctx, _ = make(tmp_path, prof(
            "      - {action: set_var, name: hit, value: 'yes',"
            " when: {var: client.consumption_tax, is_true: true}}"
        ), client={"consumption_tax": False})
        r.run_flow("f")
        assert ctx.lookup("hit") is None

    def test_inで候補判定できる(self, tmp_path):
        r, ctx, _ = make(tmp_path, prof(
            "      - {action: set_var, name: hit, value: 'yes',"
            " when: {var: doc.category, in: [local, national]}}"
        ), doc={"category": "local"})
        r.run_flow("f")
        assert ctx.lookup("hit") == "yes"


class Test繰り返し:
    def test_リスト変数を順に回す(self, tmp_path):
        r, ctx, backend = make(tmp_path, prof(
            """      - action: for_each
        items: items
        as: it
        steps:
          - {action: click, window: main, target: {auto_id: '{it}'}}"""
        ), items=["a", "b", "c"])
        r.run_flow("f")
        assert backend.calls_of("find") == ["main/a", "main/b", "main/c"]

    def test_周回情報が使える(self, tmp_path):
        r, ctx, _ = make(tmp_path, prof(
            """      - action: for_each
        items: items
        as: it
        steps:
          - {action: set_var, name: last, value: '{loop.index}/{loop.total}'}"""
        ), items=["a", "b"])
        r.run_flow("f")
        assert ctx.lookup("last") == "2/2"

    def test_存在しない変数を弾く(self, tmp_path):
        r, _, _ = make(tmp_path, prof(
            """      - action: for_each
        items: ない変数
        as: it
        steps:
          - {action: log, message: x}"""
        ))
        with pytest.raises(Exception, match="ない変数"):
            r.run_flow("f")


class Test再試行:
    def test_失敗したステップを既定回数だけ再試行する(self, tmp_path):
        backend = FakeBackend(missing={"main/btnX"})
        r, _, _ = make(tmp_path, prof(
            "      - {action: click, window: main, target: {auto_id: btnX}}"
        ), backend=backend)
        with pytest.raises(StepFailed):
            r.run_flow("f")
        assert backend.calls_of("find").count("main/btnX") == 3   # 初回 + 再試行2回

    def test_ステップ単位で回数を上書きできる(self, tmp_path):
        backend = FakeBackend(missing={"main/btnX"})
        r, _, _ = make(tmp_path, prof(
            "      - {action: click, window: main, target: {auto_id: btnX}, retry: 0}"
        ), backend=backend)
        with pytest.raises(StepFailed):
            r.run_flow("f")
        assert backend.calls_of("find").count("main/btnX") == 1

    def test_省略可なら失敗しても進む(self, tmp_path):
        backend = FakeBackend(missing={"main/btnX"})
        r, ctx, _ = make(tmp_path, prof(
            "      - {action: click, window: main, target: {auto_id: btnX}, optional: true}\n"
            "      - {action: set_var, name: reached, value: 'yes'}"
        ), backend=backend)
        r.run_flow("f")
        assert ctx.lookup("reached") == "yes"

    def test_検証の失敗は再試行しない(self, tmp_path):
        # 画面が想定と違うのに何度も試すのは無意味で、危険な操作につながる
        backend = FakeBackend(missing={"main/lbl"})
        r, _, _ = make(tmp_path, prof(
            "      - {action: assert_exists, window: main, target: {auto_id: lbl}}"
        ), backend=backend)
        with pytest.raises(AssertionFailed):
            r.run_flow("f")


class Test検証:
    def test_表示文字列の一致を確かめる(self, tmp_path):
        backend = FakeBackend(texts={"main/lbl": "株式会社サンプル"})
        r, _, _ = make(tmp_path, prof(
            "      - {action: assert_text, window: main, target: {auto_id: lbl}, contains: サンプル}"
        ), backend=backend)
        r.run_flow("f")   # 例外が出なければ合格

    def test_不一致は失敗にする(self, tmp_path):
        backend = FakeBackend(texts={"main/lbl": "別の会社"})
        r, _, _ = make(tmp_path, prof(
            "      - {action: assert_text, window: main, target: {auto_id: lbl}, contains: サンプル}"
        ), backend=backend)
        with pytest.raises(AssertionFailed, match="含まれません"):
            r.run_flow("f")

    def test_あってはならない部品を検出する(self, tmp_path):
        r, _, _ = make(tmp_path, prof(
            "      - {action: assert_not_exists, target: {name_re: '.*エラー.*'}}"
        ))
        with pytest.raises(AssertionFailed, match="あってはならない"):
            r.run_flow("f")

    def test_表示文字列を変数に取り込める(self, tmp_path):
        backend = FakeBackend(texts={"main/lbl": "12345-67890"})
        r, ctx, _ = make(tmp_path, prof(
            "      - {action: capture_text, window: main, target: {auto_id: lbl}, var: receipt.no}"
        ), backend=backend)
        r.run_flow("f")
        assert ctx.lookup("receipt.no") == "12345-67890"


class Test取り消し不能な操作:
    BODY = prof(
        """      - action: irreversible
        description: 送信する
        steps:
          - {action: click, window: main, target: {auto_id: btnSend}}"""
    )

    def test_練習モードでは手前で止まる(self, tmp_path):
        r, _, backend = make(tmp_path, self.BODY)
        with pytest.raises(SubmitBlocked):
            r.run_flow("f")
        assert "main/btnSend" not in backend.calls_of("find")

    def test_検証モードでも止まる(self, tmp_path):
        r, _, backend = make(tmp_path, self.BODY, mode="simulate")
        with pytest.raises(SubmitBlocked):
            r.run_flow("f")
        assert "main/btnSend" not in backend.calls_of("find")

    def test_本番モードで確認を通れば実行する(self, tmp_path):
        r, _, backend = make(tmp_path, self.BODY, mode="live",
                             client={"name": "A社", "code": "1"})
        r.run_flow("f")
        assert "main/btnSend" in backend.calls_of("find")

    def test_本番モードでも断れば実行しない(self, tmp_path):
        r, _, backend = make(tmp_path, self.BODY, mode="live", confirm=False,
                             client={"name": "A社", "code": "1"})
        with pytest.raises(ConfirmationDeclined):
            r.run_flow("f")
        assert "main/btnSend" not in backend.calls_of("find")

    def test_送信途中の失敗は自動復旧しない(self, tmp_path):
        # 送れたのか分からない状態。二重送信を避けるため人が確認する
        backend = FakeBackend(missing={"main/btnSend"})
        r, _, _ = make(tmp_path, self.BODY, mode="live", backend=backend,
                       client={"name": "A社", "code": "1"})
        with pytest.raises(Exception, match="送信できたかどうかが不明"):
            r.run_flow("f")


class Testフロー呼び出し:
    def test_引数を渡して呼べる(self, tmp_path):
        body = """
name: t
windows:
  main: {title_re: '.*'}
flows:
  f:
    steps:
      - {action: run_flow, flow: g, with: {arg: 'X'}}
  g:
    params: [arg]
    steps:
      - {action: set_var, name: got, value: '{arg}'}
"""
        r, ctx, _ = make(tmp_path, body)
        r.run_flow("f")
        assert ctx.lookup("got") == "X"

    def test_呼び出し後に元の値へ戻す(self, tmp_path):
        body = """
name: t
windows:
  main: {title_re: '.*'}
flows:
  f:
    steps:
      - {action: set_var, name: arg, value: '元'}
      - {action: run_flow, flow: g, with: {arg: '一時'}}
  g:
    params: [arg]
    steps:
      - {action: log, message: '{arg}'}
"""
        r, ctx, _ = make(tmp_path, body)
        r.run_flow("f")
        assert ctx.lookup("arg") == "元"


class Test出力確認:
    def test_ファイルが無ければ失敗にする(self, tmp_path):
        r, _, _ = make(tmp_path, prof(
            f"      - {{action: expect_file, path: '{tmp_path}/ない.pdf',"
            " timeout: 1, stable_sec: 0}"
        ))
        with pytest.raises(StepFailed, match="できていません"):
            r.run_flow("f")

    def test_小さすぎるファイルは失敗にする(self, tmp_path):
        # 出力に失敗した空 PDF を「保存できた」と扱わない
        (tmp_path / "小.pdf").write_bytes(b"x")
        r, _, _ = make(tmp_path, prof(
            f"      - {{action: expect_file, path: '{tmp_path}/小.pdf',"
            " timeout: 1, min_bytes: 1024, stable_sec: 0}"
        ))
        with pytest.raises(StepFailed, match="小さすぎ"):
            r.run_flow("f")

    def test_十分な大きさなら合格(self, tmp_path):
        (tmp_path / "大.pdf").write_bytes(b"0" * 2048)
        r, ctx, _ = make(tmp_path, prof(
            f"      - {{action: expect_file, path: '{tmp_path}/大.pdf',"
            " timeout: 2, min_bytes: 1024, stable_sec: 0}"
        ))
        r.run_flow("f")
        assert ctx.produced_files[0]["bytes"] == 2048


class Test同梱ひな形:
    def test_設定と手順定義が噛み合っている(self, tmp_path):
        """ひな形どうしの参照ずれ（フロー名の書き間違い）を捕まえる。"""
        from pathlib import Path

        root = Path(__file__).resolve().parent.parent
        settings_text = (root / "config" / "settings.sample.yaml").read_text(encoding="utf-8")
        raw = yaml.safe_load(settings_text)
        profile = load_profile(root / "config" / "profiles" / "acelink-nx-pro.sample.yaml")

        for sub in raw["submissions"]:
            assert profile.has_flow(sub["flow"]), f"送信フロー {sub['flow']} が無い"
        for doc in raw["documents"]:
            flow = doc.get("export_flow") or raw["flows"]["export_document"]
            assert profile.has_flow(flow), f"出力フロー {flow} が無い（{doc['label']}）"
        for logical, name in raw["flows"].items():
            assert profile.has_flow(name), f"フロー {name}（{logical}）が無い"
