"""テンプレート展開とファイル名整形の検証。

ここが壊れると、保存先が静かに間違うか、Windows が黙ってファイル名を
削って「保存したはずのものが見つからない」事故になる。
"""

import pytest

from nxrpa.errors import ConfigError
from nxrpa.templating import render, safe_filename, safe_relpath


class TestRender:
    def test_ドット参照を展開する(self):
        ctx = {"client": {"name": "株式会社サンプル"}, "doc": {"label": "法人税申告書"}}
        assert render("{client.name}_{doc.label}", ctx) == "株式会社サンプル_法人税申告書"

    def test_未定義の参照は例外にする(self):
        # 空文字で通すと、ファイル名が壊れたまま大量保存されて追跡できなくなる
        with pytest.raises(ConfigError, match="解決できません"):
            render("{client.missing}", {"client": {"name": "A"}})

    def test_未定義の途中経路も例外にする(self):
        with pytest.raises(ConfigError, match="解決できません"):
            render("{nothing.here}", {"client": {}})

    def test_エラーに使える項目名を出す(self):
        with pytest.raises(ConfigError) as exc:
            render("{client.missing}", {"client": {"name": "A", "code": "1"}})
        assert "client.name" in str(exc.value)

    def test_差し込みが無い文字列はそのまま(self):
        assert render("固定文字", {}) == "固定文字"

    def test_属性アクセスもできる(self):
        class Obj:
            name = "テスト"

        assert render("{o.name}", {"o": Obj()}) == "テスト"


class TestSafeFilename:
    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("株式会社A/B", "株式会社A／B"),
            ("期:1", "期：1"),
            ('社名"引用"', "社名”引用”"),
            ("a<b>c", "a＜b＞c"),
            ("x|y", "x｜y"),
            ("back\\slash", "back￥slash"),
            ("q?mark", "q？mark"),
            ("star*", "star＊"),
        ],
    )
    def test_使えない記号を全角へ寄せる(self, raw, expected):
        # 単に削ると「4/1期」→「41期」のように意味が変わるため、見た目の近い全角にする
        assert safe_filename(raw) == expected

    def test_末尾の空白とドットを落とす(self):
        # Windows が黙って落とすので、こちらで先に落として名前を一致させる
        assert safe_filename("会社名. ") == "会社名"
        assert safe_filename("会社名   ") == "会社名"

    def test_予約名を避ける(self):
        assert safe_filename("CON") == "CON_"
        assert safe_filename("con.pdf").startswith("con.pdf")  # 小文字でも予約
        assert safe_filename("PRN") == "PRN_"
        assert safe_filename("COM1") == "COM1_"

    def test_制御文字を除去する(self):
        assert safe_filename("会社\x00名\x07") == "会社名"

    def test_空になったら代替を使う(self):
        assert safe_filename("   ") == "_"
        assert safe_filename("...") == "_"

    def test_長すぎる名前を切る(self):
        assert len(safe_filename("あ" * 300, max_len=50)) == 50

    def test_連続アンダースコアをまとめる(self):
        assert safe_filename("a___b") == "a_b"

    def test_全角半角の揺れを正規化する(self):
        # 合成済み文字と結合文字で別ファイル扱いにならないようにする
        assert safe_filename("ガ") == safe_filename("ガ")


class TestSafeRelpath:
    def test_区切りを保ったまま各要素を整形する(self):
        assert safe_relpath("1001_株式会社A/2026") == "1001_株式会社A\\2026"

    def test_親ディレクトリ参照を拒む(self):
        with pytest.raises(ConfigError, match=r"\.\."):
            safe_relpath("..\\..\\Windows")

    def test_空要素を落とす(self):
        assert safe_relpath("a\\\\b\\") == "a\\b"

    def test_各要素の記号も整形する(self):
        assert safe_relpath("a:b\\c") == "a：b\\c"


class Test厳密でない展開:
    """キー送信の `{ENTER}` は pywinauto の記法で、差し込みではない。"""

    def test_解決できない差し込みを残す(self):
        assert render("{ENTER}", {}, strict=False) == "{ENTER}"
        assert render("^a{DELETE}", {}, strict=False) == "^a{DELETE}"

    def test_解決できるものは展開する(self):
        ctx = {"client": {"code": "1001"}}
        assert render("{client.code}{ENTER}", ctx, strict=False) == "1001{ENTER}"

    def test_既定は厳密のまま(self):
        # ファイル名やパスでは、書き間違いを見逃さない方が大事
        with pytest.raises(ConfigError):
            render("{ENTER}", {})
