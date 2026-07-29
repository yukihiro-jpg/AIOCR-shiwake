"""設定の読み込みと、保存先の組み立ての検証。"""

import pytest

from nxrpa.clients import Client
from nxrpa.config import load_settings
from nxrpa.errors import ConfigError, RpaError
from nxrpa.output import apply_conflict_policy, plan_outputs, resolve_target

MINIMAL = """
run:
  mode: rehearsal
paths:
  output_root: '__ROOT__'
  folder_template: '{client.code}_{client.name}'
  file_template: '{client.name}_{doc.label}'
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


def make_settings(tmp_path, body: str | None = None):
    cfg_dir = tmp_path / "config"
    cfg_dir.mkdir(exist_ok=True)
    text = (body if body is not None else MINIMAL).replace("__ROOT__", str(tmp_path / "out"))
    (cfg_dir / "settings.yaml").write_text(text, encoding="utf-8")
    return load_settings(cfg_dir / "settings.yaml")


CLIENT = Client(code="1001", name="株式会社サンプル", fiscal_year="2026", consumption_tax=True)
MENZEI = Client(code="1002", name="免税商店", fiscal_year="2026", consumption_tax=False)


class TestLoadSettings:
    def test_基本形を読める(self, tmp_path):
        s = make_settings(tmp_path)
        assert s.run.mode == "rehearsal"
        assert len(s.documents) == 3
        assert s.default_app == "nxpro"

    def test_既定は練習モード(self, tmp_path):
        # 設定を書き忘れても本番送信にならないこと
        s = make_settings(tmp_path, MINIMAL.replace("  mode: rehearsal\n", ""))
        assert s.run.mode == "rehearsal"

    def test_不正なモードを弾く(self, tmp_path):
        with pytest.raises(ConfigError, match="run.mode"):
            make_settings(tmp_path, MINIMAL.replace("rehearsal", "honban"))

    def test_資料名の重複を弾く(self, tmp_path):
        # ファイル名が衝突して、片方が連番か上書きになってしまう
        body = MINIMAL.replace("label: 法人税申告書", "label: 決算書")
        with pytest.raises(ConfigError, match="重複"):
            make_settings(tmp_path, body)

    def test_書類キーの重複を弾く(self, tmp_path):
        body = MINIMAL.replace("key: houjinzei", "key: kessansho")
        with pytest.raises(ConfigError, match="重複"):
            make_settings(tmp_path, body)

    def test_資料名が無ければ弾く(self, tmp_path):
        body = MINIMAL.replace("{key: kessansho, label: 決算書, order: 1}", "{key: kessansho, order: 1}")
        with pytest.raises(ConfigError, match="label"):
            make_settings(tmp_path, body)

    def test_書類が空なら弾く(self, tmp_path):
        body = """
paths: {output_root: '__ROOT__'}
apps: {nxpro: {profile: p.yaml}}
documents: []
"""
        with pytest.raises(ConfigError, match="documents"):
            make_settings(tmp_path, body)

    def test_未定義アプリを参照する送信を弾く(self, tmp_path):
        body = MINIMAL.replace(
            "{key: national, label: 国税, flow: submit_national}",
            "{key: national, label: 国税, flow: submit_national, app: pcdesk}",
        )
        with pytest.raises(ConfigError, match="pcdesk"):
            make_settings(tmp_path, body)

    def test_同名ポリシーの誤りを弾く(self, tmp_path):
        with pytest.raises(ConfigError, match="on_existing"):
            make_settings(tmp_path, MINIMAL.replace(
                "paths:\n", "paths:\n  on_existing: なんとなく\n"))


class TestDocumentsFor:
    def test_免税事業者には消費税を回さない(self, tmp_path):
        s = make_settings(tmp_path)
        assert [d.key for d in s.documents_for(MENZEI)] == ["kessansho", "houjinzei"]
        assert [d.key for d in s.documents_for(CLIENT)] == ["kessansho", "houjinzei", "shouhizei"]

    def test_免税事業者には消費税の送信をしない(self, tmp_path):
        s = make_settings(tmp_path)
        assert [x.key for x in s.submissions_for(MENZEI)] == ["national"]
        assert [x.key for x in s.submissions_for(CLIENT)] == ["national", "consumption"]

    def test_顧問先ごとの指定が優先される(self, tmp_path):
        s = make_settings(tmp_path)
        c = Client(code="1", name="A", documents=("houjinzei",))
        assert [d.key for d in s.documents_for(c)] == ["houjinzei"]

    def test_未定義の書類キーを指定したら弾く(self, tmp_path):
        s = make_settings(tmp_path)
        c = Client(code="1", name="A", documents=("ないキー",))
        with pytest.raises(ConfigError, match="ないキー"):
            s.documents_for(c)


class TestResolveTarget:
    def test_顧問先名と資料名でファイル名を作る(self, tmp_path):
        s = make_settings(tmp_path)
        t = resolve_target(s, CLIENT, s.document("houjinzei"))
        assert t.filename == "株式会社サンプル_法人税申告書.pdf"
        assert t.folder.name == "1001_株式会社サンプル"

    def test_顧問先マスタの保存先が優先される(self, tmp_path):
        s = make_settings(tmp_path)
        c = Client(code="1", name="A", output_dir=str(tmp_path / "別の場所"))
        t = resolve_target(s, c, s.document("kessansho"))
        assert str(tmp_path / "別の場所") in str(t.path)

    def test_記号を含む社名でも保存できる形にする(self, tmp_path):
        s = make_settings(tmp_path)
        c = Client(code="1", name="A/B株式会社")
        t = resolve_target(s, c, s.document("kessansho"))
        assert "/" not in t.filename
        assert t.filename == "A／B株式会社_決算書.pdf"

    def test_パスが長すぎたら実行前に止める(self, tmp_path):
        # 実行してから Windows に黙って切られるより、先に分かった方がよい
        s = make_settings(tmp_path)
        c = Client(code="1", name="あ" * 118)
        with pytest.raises(ConfigError, match="長すぎ"):
            resolve_target(s, c, s.document("kessansho"))

    def test_テンプレートの参照ミスを案内する(self, tmp_path):
        s = make_settings(tmp_path, MINIMAL.replace("{client.name}_{doc.label}", "{client.nome}"))
        with pytest.raises(ConfigError, match="解決できません"):
            resolve_target(s, CLIENT, s.document("kessansho"))


class TestPlanOutputs:
    def test_対象書類ぶんの保存先を作る(self, tmp_path):
        s = make_settings(tmp_path)
        outs = plan_outputs(s, CLIENT)
        assert [o.doc.key for o in outs] == ["kessansho", "houjinzei", "shouhizei"]

    def test_保存先の衝突を実行前に見つける(self, tmp_path):
        # ファイル名テンプレートに資料名を入れ忘れた、という事故を捕まえる
        s = make_settings(tmp_path, MINIMAL.replace("_{doc.label}", ""))
        with pytest.raises(ConfigError, match="同じ保存先"):
            plan_outputs(s, CLIENT)


class TestConflictPolicy:
    def _target(self, tmp_path):
        s = make_settings(tmp_path)
        t = resolve_target(s, CLIENT, s.document("kessansho"))
        t.folder.mkdir(parents=True, exist_ok=True)
        t.path.write_bytes(b"already")
        from dataclasses import replace

        return replace(t, existed=True)

    def test_renameは連番を付ける(self, tmp_path):
        t = apply_conflict_policy(self._target(tmp_path), "rename")
        assert t.filename == "株式会社サンプル_決算書 (2).pdf"

    def test_skipはNoneを返す(self, tmp_path):
        assert apply_conflict_policy(self._target(tmp_path), "skip") is None

    def test_overwriteはそのまま(self, tmp_path):
        t = self._target(tmp_path)
        assert apply_conflict_policy(t, "overwrite").path == t.path

    def test_errorは止める(self, tmp_path):
        with pytest.raises(RpaError, match="既にあります"):
            apply_conflict_policy(self._target(tmp_path), "error")

    def test_存在しなければそのまま(self, tmp_path):
        s = make_settings(tmp_path)
        t = resolve_target(s, CLIENT, s.document("kessansho"))
        assert apply_conflict_policy(t, "rename") is t
