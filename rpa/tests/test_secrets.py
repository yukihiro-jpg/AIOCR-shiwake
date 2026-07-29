"""暗証番号の取り扱いの検証。

「うっかりログに出る」が起きないことを機械で確かめる。
"""

import json

from nxrpa.secrets import MASK, Secret, SecretVault, redact


class TestSecret:
    def test_文字列化してもマスクされる(self):
        s = Secret("1234")
        assert str(s) == MASK
        assert f"{s}" == MASK
        assert f"pin={s}" == f"pin={MASK}"
        assert repr(s).find("1234") == -1

    def test_書式指定でもマスクされる(self):
        s = Secret("1234")
        assert f"{s:>20}" == MASK

    def test_revealで実値を取れる(self):
        assert Secret("1234").reveal() == "1234"

    def test_破棄すると使えなくなる(self):
        s = Secret("1234")
        s.burn()
        assert not s
        try:
            s.reveal()
        except ValueError as exc:
            assert "破棄" in str(exc)
        else:  # pragma: no cover
            raise AssertionError("破棄後に reveal できてしまった")

    def test_with文で破棄される(self):
        with Secret("1234") as s:
            assert s.reveal() == "1234"
        assert not s

    def test_JSONに混ぜても実値が出ない(self):
        # ログは JSON 行で書くので、str 化経路が塞がっていることを確かめる
        assert "1234" not in json.dumps({"pin": str(Secret("1234"))})


class TestSecretVault:
    def test_名前で出し入れできる(self):
        v = SecretVault()
        v.put("pin_tax_accountant", "9876")
        assert v.has("pin_tax_accountant")
        assert v.get("pin_tax_accountant").reveal() == "9876"

    def test_未登録は分かりやすい例外(self):
        v = SecretVault()
        try:
            v.get("pin_tax_accountant")
        except KeyError as exc:
            assert "未登録" in str(exc)
        else:  # pragma: no cover
            raise AssertionError("未登録なのに取れてしまった")

    def test_上書きすると前の値は破棄される(self):
        v = SecretVault()
        v.put("pin", "1111")
        old = v.get("pin")
        v.put("pin", "2222")
        assert not old
        assert v.get("pin").reveal() == "2222"

    def test_with文で全部破棄される(self):
        with SecretVault() as v:
            v.put("pin", "1234")
        assert not v.has("pin")


class TestRedact:
    def test_混入した実値を伏せる(self):
        v = SecretVault()
        v.put("pin", "246810")
        # アプリ側の例外が入力値をそのまま含んでしまった、という想定
        text = "認証に失敗しました（入力値: 246810）"
        assert "246810" not in redact(text, v)
        assert MASK in redact(text, v)

    def test_金庫が無くてもそのまま返す(self):
        assert redact("そのまま", None) == "そのまま"

    def test_破棄済みの値は無視する(self):
        v = SecretVault()
        v.put("pin", "1234")
        v.burn_all()
        assert redact("1234", v) == "1234"  # 既に保持していないので置換対象外
