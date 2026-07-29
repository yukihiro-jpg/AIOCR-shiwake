"""画面手順定義の検証。

実機を触る前に書式ミスを落とし切ることが、このツールの安全性の土台。
「途中まで動いて途中で止まる」を減らすためのテスト。
"""

import pytest

from nxrpa.engine.locator import Locator
from nxrpa.engine.profile import load_profile
from nxrpa.errors import ProfileError


def write_profile(tmp_path, body: str):
    p = tmp_path / "profile.yaml"
    p.write_text(body, encoding="utf-8")
    return p


BASE = """
name: テスト
windows:
  main:
    title_re: '.*テスト.*'
flows:
  main_flow:
    steps:
"""


class TestLocator:
    def test_文字列は表示名とみなす(self):
        loc = Locator.parse("送信", where="t")
        assert loc.name == "送信"

    def test_pywinautoの引数に変換する(self):
        loc = Locator.parse({"auto_id": "btn1", "control_type": "Button", "index": 2}, where="t")
        assert loc.to_kwargs() == {"auto_id": "btn1", "control_type": "Button", "found_index": 2}

    def test_不明な項目を弾く(self):
        with pytest.raises(ProfileError, match="不明な項目"):
            Locator.parse({"auto_idd": "x"}, where="t")

    def test_control_typeの誤記を弾く(self):
        with pytest.raises(ProfileError, match="control_type"):
            Locator.parse({"control_type": "Buton"}, where="t")

    def test_条件が空なら弾く(self):
        with pytest.raises(ProfileError, match="条件が空"):
            Locator.parse({"visible_only": True}, where="t")

    def test_座標だけの指定を見分ける(self):
        assert Locator.parse({"at": [10, 20]}, where="t").is_coordinate_only()
        assert not Locator.parse({"at": [10, 20], "name": "x"}, where="t").is_coordinate_only()

    def test_座標は2要素で書く(self):
        with pytest.raises(ProfileError, match=r"\[x, y\]"):
            Locator.parse({"at": [1, 2, 3]}, where="t")

    def test_テンプレートを展開できる(self):
        loc = Locator.parse({"name": "{client.name}"}, where="t")
        assert loc.render(lambda s: s.replace("{client.name}", "A社")).name == "A社"


class TestLoadProfile:
    def test_基本形を読める(self, tmp_path):
        p = write_profile(tmp_path, BASE + """
      - action: click
        window: main
        target: {name: 送信, control_type: Button}
""")
        profile = load_profile(p)
        assert profile.flow("main_flow").steps[0].action == "click"

    def test_不明なアクションを弾いて候補を出す(self, tmp_path):
        p = write_profile(tmp_path, BASE + """
      - action: clik
        target: 送信
""")
        with pytest.raises(ProfileError) as exc:
            load_profile(p)
        assert "clik" in str(exc.value)
        assert "click" in str(exc.value)   # もしかして候補

    def test_必須項目の不足を弾く(self, tmp_path):
        p = write_profile(tmp_path, BASE + """
      - action: set_text
        target: 欄
""")
        with pytest.raises(ProfileError, match="必須項目"):
            load_profile(p)

    def test_targetが必要なアクションを弾く(self, tmp_path):
        p = write_profile(tmp_path, BASE + """
      - action: click
""")
        with pytest.raises(ProfileError, match="target が必要"):
            load_profile(p)

    def test_windowが必要なアクションを弾く(self, tmp_path):
        p = write_profile(tmp_path, BASE + """
      - action: focus_window
""")
        with pytest.raises(ProfileError, match="window が必要"):
            load_profile(p)

    def test_未定義ウィンドウの参照を弾く(self, tmp_path):
        p = write_profile(tmp_path, BASE + """
      - action: focus_window
        window: ない画面
""")
        with pytest.raises(ProfileError, match="未定義"):
            load_profile(p)

    def test_未定義フローの呼び出しを弾く(self, tmp_path):
        p = write_profile(tmp_path, BASE + """
      - action: run_flow
        flow: ないフロー
""")
        with pytest.raises(ProfileError, match="未定義"):
            load_profile(p)

    def test_フローの循環を弾く(self, tmp_path):
        # 循環したまま実行すると固まるので、読み込み時に落とす
        p = write_profile(tmp_path, """
name: テスト
windows: {}
flows:
  a:
    steps:
      - {action: run_flow, flow: b}
  b:
    steps:
      - {action: run_flow, flow: a}
""")
        with pytest.raises(ProfileError, match="循環"):
            load_profile(p)

    def test_暗証番号入力のリトライ指定を弾く(self, tmp_path):
        # カードのロックにつながるので、設定ファイル上も書けないようにする
        p = write_profile(tmp_path, BASE + """
      - action: type_secret
        window: main
        target: {control_type: Edit}
        secret: pin_tax_accountant
        retry: 3
""")
        with pytest.raises(ProfileError, match="リトライできません"):
            load_profile(p)

    def test_送信ステップのリトライ指定も弾く(self, tmp_path):
        p = write_profile(tmp_path, BASE + """
      - action: irreversible
        description: 送信
        retry: 1
""")
        with pytest.raises(ProfileError, match="リトライできません"):
            load_profile(p)

    def test_入れ子ステップも検証する(self, tmp_path):
        p = write_profile(tmp_path, BASE + """
      - action: irreversible
        description: 送信
        steps:
          - action: click
""")
        with pytest.raises(ProfileError, match="target が必要"):
            load_profile(p)

    def test_不明な項目を弾く(self, tmp_path):
        p = write_profile(tmp_path, BASE + """
      - action: click
        target: 送信
        timeoutt: 10
""")
        with pytest.raises(ProfileError, match="不明な項目"):
            load_profile(p)

    def test_whenの不明項目を弾く(self, tmp_path):
        p = write_profile(tmp_path, BASE + """
      - action: log
        message: x
        when: {var: doc.key, equal: a}
""")
        with pytest.raises(ProfileError, match="不明な項目"):
            load_profile(p)

    def test_書式エラーを案内する(self, tmp_path):
        p = write_profile(tmp_path, "flows: [これは: 不正: な: yaml")
        with pytest.raises(ProfileError, match="書式が不正"):
            load_profile(p)

    def test_ファイルが無ければ案内する(self, tmp_path):
        with pytest.raises(ProfileError, match="見つかりません"):
            load_profile(tmp_path / "ない.yaml")

    def test_同梱のひな形が読める(self):
        # ひな形が壊れていたら、利用者は最初の一歩で詰まる
        from pathlib import Path

        sample = Path(__file__).resolve().parent.parent / "config" / "profiles" / "acelink-nx-pro.sample.yaml"
        profile = load_profile(sample)
        for name in ("startup", "select_client", "submit_national", "export_document"):
            assert profile.has_flow(name), f"{name} が無い"
