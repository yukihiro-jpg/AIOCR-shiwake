"""PIN（暗証番号）の取り扱い。

【厳守】
- PIN はディスクに書かない。設定ファイル・環境変数・コマンドライン引数から読まない。
  （コマンドライン引数は他プロセスから ps/tasklist で覗ける）
- PIN をログ・例外メッセージ・スクリーンショットのファイル名に出さない。
- **PIN の入力ステップは絶対にリトライしない。** 税理士カード／マイナンバーカードは
  暗証番号を規定回数（多くは3回）間違えるとロックされ、窓口での再設定が必要になる。
  「失敗したらもう一度打つ」という一般的なリトライ方針をここに適用してはいけない。

Python の str は不変で、確実なゼロ化はできない。ここでは bytearray に保持して
明示的に上書きし、参照を落とすところまでを「できる範囲の後始末」として行う。
完全な消去を保証するものではない点は正直に認めたうえで、
少なくとも「プロセスが生きている間ずっと平文の str が漂う」状態は避ける。
"""

from __future__ import annotations

import getpass
from typing import Iterator

MASK = "********"


class Secret:
    """画面に出さない値。str に混ぜてもマスクされる。

    >>> s = Secret("1234")
    >>> print(s)
    ********
    >>> f"pin={s}"
    'pin=********'
    >>> s.reveal()
    '1234'
    """

    __slots__ = ("_buf", "_label", "_burned")

    def __init__(self, value: str, label: str = "secret"):
        self._buf = bytearray(value.encode("utf-8"))
        self._label = label
        self._burned = False

    # --- 表示は常にマスク ---------------------------------------------
    def __str__(self) -> str:  # noqa: D105
        return MASK

    def __repr__(self) -> str:  # noqa: D105
        return f"<Secret {self._label} {MASK}>"

    def __format__(self, spec: str) -> str:  # noqa: D105
        return MASK

    def __len__(self) -> int:
        return len(self._buf)

    def __bool__(self) -> bool:
        return bool(self._buf) and not self._burned

    def reveal(self) -> str:
        """実際の値を取り出す。UI へ打ち込む直前だけで使うこと。"""
        if self._burned:
            raise ValueError("この Secret は既に破棄されています")
        return self._buf.decode("utf-8")

    def burn(self) -> None:
        """バッファを上書きして破棄する（できる範囲の後始末）。"""
        for i in range(len(self._buf)):
            self._buf[i] = 0
        self._buf.clear()
        self._burned = True

    # with 文で確実に後始末する
    def __enter__(self) -> "Secret":
        return self

    def __exit__(self, *exc) -> None:
        self.burn()


class SecretVault:
    """実行中だけ PIN を保持する入れ物。

    プロファイルの `type_secret` ステップは `secret: pin_tax_accountant` のように
    名前で参照する。値そのものはプロファイルにもログにも現れない。
    """

    def __init__(self) -> None:
        self._items: dict[str, Secret] = {}

    def put(self, name: str, value: str) -> None:
        old = self._items.get(name)
        if old is not None:
            old.burn()
        self._items[name] = Secret(value, label=name)

    def get(self, name: str) -> Secret:
        try:
            return self._items[name]
        except KeyError:
            raise KeyError(
                f"暗証番号 '{name}' が未登録です。アプリ起動時の入力画面で入力してください。"
            ) from None

    def has(self, name: str) -> bool:
        return name in self._items and bool(self._items[name])

    def names(self) -> Iterator[str]:
        return iter(self._items)

    def burn_all(self) -> None:
        for s in self._items.values():
            s.burn()
        self._items.clear()

    def __enter__(self) -> "SecretVault":
        return self

    def __exit__(self, *exc) -> None:
        self.burn_all()


def prompt_pin(label: str = "税理士カードの暗証番号") -> str:
    """コンソールから PIN を伏せて入力する（GUI を使わない場合の入口）。"""
    value = getpass.getpass(f"{label}: ")
    if not value:
        raise ValueError("暗証番号が入力されていません")
    return value


def redact(text: str, vault: SecretVault | None) -> str:
    """ログ出力の直前に、保持中の秘密値が混ざっていたら伏せる。

    そもそも秘密値をログに渡さないのが第一だが、想定外の経路（アプリ側の
    例外メッセージが入力値をそのまま含む等）に備えた最後の網。
    """
    if not vault or not text:
        return text
    out = text
    for name in list(vault.names()):
        secret = vault._items.get(name)  # noqa: SLF001 - 同一モジュール内の意図的な参照
        if secret is None or not secret:
            continue
        try:
            raw = secret.reveal()
        except ValueError:
            continue
        if raw and raw in out:
            out = out.replace(raw, MASK)
    return out
