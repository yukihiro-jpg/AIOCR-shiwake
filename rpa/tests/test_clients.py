"""顧問先マスタ読み込みの検証。"""

import pytest

from nxrpa.clients import load_clients, write_sample
from nxrpa.errors import ConfigError


def write(tmp_path, text: str):
    p = tmp_path / "clients.csv"
    p.write_text(text, encoding="utf-8-sig")
    return p


class TestLoadClients:
    def test_日本語ヘッダを読める(self, tmp_path):
        p = write(tmp_path, "顧問先コード,会社名,年度,消費税\n1001,株式会社サンプル,2026,○\n")
        book = load_clients(p)
        assert len(book) == 1
        c = book.by_code("1001")
        assert c.name == "株式会社サンプル"
        assert c.fiscal_year == "2026"
        assert c.consumption_tax is True

    def test_英語ヘッダも読める(self, tmp_path):
        p = write(tmp_path, "code,name,consumption_tax\n1001,Sample,yes\n")
        assert load_clients(p).by_code("1001").consumption_tax is True

    def test_消費税の表記ゆれ(self, tmp_path):
        p = write(tmp_path,
                  "顧問先コード,会社名,消費税\n1,A,○\n2,B,×\n3,C,課税\n4,D,免税\n5,E,\n")
        book = load_clients(p)
        assert [book.by_code(str(i)).consumption_tax for i in range(1, 6)] == [
            True, False, True, False, False
        ]

    def test_コード重複を弾く(self, tmp_path):
        # 保存先が混ざるので、静かに通してはいけない
        p = write(tmp_path, "顧問先コード,会社名\n1001,A\n1001,B\n")
        with pytest.raises(ConfigError, match="重複"):
            load_clients(p)

    def test_会社名が空なら弾く(self, tmp_path):
        p = write(tmp_path, "顧問先コード,会社名\n1001,\n")
        with pytest.raises(ConfigError, match="会社名が空"):
            load_clients(p)

    def test_コードが空なら弾く(self, tmp_path):
        p = write(tmp_path, "顧問先コード,会社名\n,株式会社A\n")
        with pytest.raises(ConfigError, match="顧問先コードが空"):
            load_clients(p)

    def test_必須列が無ければ弾く(self, tmp_path):
        p = write(tmp_path, "コード,備考\n1001,なにか\n")
        with pytest.raises(ConfigError, match="必須列"):
            load_clients(p)

    def test_空行を読み飛ばす(self, tmp_path):
        p = write(tmp_path, "顧問先コード,会社名\n1001,A\n\n,\n1002,B\n")
        assert len(load_clients(p)) == 2

    def test_対象書類は読点でも区切れる(self, tmp_path):
        p = write(tmp_path, "顧問先コード,会社名,対象書類\n1,A,\"kessansho、houjinzei\"\n")
        assert load_clients(p).by_code("1").documents == ("kessansho", "houjinzei")

    def test_無効な顧問先を除ける(self, tmp_path):
        p = write(tmp_path, "顧問先コード,会社名,有効\n1,A,○\n2,B,×\n")
        book = load_clients(p)
        assert len(book) == 2
        assert [c.code for c in book.enabled()] == ["1"]

    def test_見つからないコードは候補を出す(self, tmp_path):
        p = write(tmp_path, "顧問先コード,会社名\n1001,A\n")
        with pytest.raises(ConfigError, match="1001"):
            load_clients(p).by_code("9999")

    def test_ファイルが無ければ案内する(self, tmp_path):
        with pytest.raises(ConfigError, match="見つかりません"):
            load_clients(tmp_path / "ない.csv")

    def test_検索はコード社名カナに効く(self, tmp_path):
        p = write(tmp_path,
                  "顧問先コード,会社名,カナ\n1001,株式会社サンプル,サンプル\n1002,テスト工業,テスト\n")
        book = load_clients(p)
        assert [c.code for c in book.search("サンプル")] == ["1001"]
        assert [c.code for c in book.search("1002")] == ["1002"]
        assert [c.code for c in book.search("テスト")] == ["1002"]
        assert len(book.search("")) == 2


class TestWriteSample:
    def test_書いたものを読み戻せる(self, tmp_path):
        p = write_sample(tmp_path / "sample.csv")
        book = load_clients(p)
        assert len(book) == 2
        assert book.clients[0].consumption_tax is True
        assert book.clients[1].consumption_tax is False

    def test_ExcelのためにBOMを付ける(self, tmp_path):
        p = write_sample(tmp_path / "sample.csv")
        assert p.read_bytes().startswith(b"\xef\xbb\xbf")
