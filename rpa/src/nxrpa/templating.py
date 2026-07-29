"""設定ファイルに書くテンプレート文字列の展開と、Windows 用のファイル名整形。

テンプレートは `{client.name}_{doc.label}` のようなドット区切りの参照だけを扱う。
str.format をそのまま使うと `{0.__class__}` のような参照から内部を辿れてしまうため、
ここでは自前の最小実装にとどめる（設定ファイルは事務所内で書き換えるものなので
悪用の心配は薄いが、書き間違いを早く・分かりやすく落とすためにも自前の方が良い）。
"""

from __future__ import annotations

import re
import unicodedata
from typing import Any, Mapping

from .errors import ConfigError

_PLACEHOLDER = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\}")

# Windows のファイル名に使えない文字と、その全角での置き換え先。
# 単に削除すると「4/1期」→「41期」のように意味が変わるので、見た目が近い全角へ寄せる。
_FORBIDDEN = {
    "\\": "￥",
    "/": "／",
    ":": "：",
    "*": "＊",
    "?": "？",
    '"': "”",
    "<": "＜",
    ">": "＞",
    "|": "｜",
}

# Windows の予約名（拡張子を付けても使えない）
_RESERVED = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}


def render(template: str, context: Mapping[str, Any], *, where: str = "",
           strict: bool = True) -> str:
    """`{a.b}` を context から解決して埋め込む。

    strict=True（既定）: 未定義の参照は例外にする。
      空文字で通すと、ファイル名が壊れたまま大量に保存されてしまい、
      後から追跡できなくなるため。

    strict=False: 解決できない差し込みは書かれたまま残す。
      キー送信の `{ENTER}` `{TAB}` `{F5}` は pywinauto の記法で、たまたま
      差し込みと同じ波かっこを使う。ここを厳密にすると Enter が打てない。
      「解決できない＝差し込みではない」と判断してよい場所だけで使うこと。
    """
    if not isinstance(template, str):
        raise ConfigError(f"テンプレートが文字列ではありません{_at(where)}: {template!r}")

    def replace(m: re.Match[str]) -> str:
        path = m.group(1)
        if not strict and not _resolvable(path, context):
            return m.group(0)
        value = _resolve(path, context, where)
        return "" if value is None else str(value)

    return _PLACEHOLDER.sub(replace, template)


def _resolvable(path: str, context: Mapping[str, Any]) -> bool:
    """その参照が context から解決できるか（例外を出さずに判定する）。"""
    cur: Any = context
    for part in path.split("."):
        if isinstance(cur, Mapping):
            if part not in cur:
                return False
            cur = cur[part]
        else:
            if not hasattr(cur, part):
                return False
            cur = getattr(cur, part)
    return True


def _resolve(path: str, context: Mapping[str, Any], where: str) -> Any:
    cur: Any = context
    walked: list[str] = []
    for part in path.split("."):
        walked.append(part)
        if isinstance(cur, Mapping):
            if part not in cur:
                raise ConfigError(
                    f"テンプレートの参照 '{{{path}}}' を解決できません{_at(where)}: "
                    f"'{'.'.join(walked)}' がありません。"
                    f" 使える項目: {_available(context)}"
                )
            cur = cur[part]
        else:
            if not hasattr(cur, part):
                raise ConfigError(
                    f"テンプレートの参照 '{{{path}}}' を解決できません{_at(where)}: "
                    f"'{'.'.join(walked)}' がありません。"
                )
            cur = getattr(cur, part)
    return cur


def _available(context: Mapping[str, Any]) -> str:
    keys = []
    for k, v in context.items():
        if isinstance(v, Mapping):
            keys.extend(f"{k}.{sub}" for sub in list(v)[:12])
        else:
            keys.append(k)
    return ", ".join(sorted(keys))


def _at(where: str) -> str:
    return f"（{where}）" if where else ""


def safe_filename(name: str, *, max_len: int = 120, replacement: str = "_") -> str:
    """Windows のファイル名として安全な形に整える。

    - 使えない記号は見た目の近い全角へ寄せる
    - 制御文字は除去
    - 末尾の空白・ドットは Windows が黙って落とすので事前に取る
    - 予約名（CON など）はそのままだと保存できないのでサフィックスを付ける
    - 長すぎる場合は切り詰める（パス全体の 260 文字制限は別途 shorten_path で見る）
    """
    if name is None:
        raise ValueError("ファイル名が None です")

    # 全角/半角の揺れで別ファイル扱いにならないよう、互換文字を正規化する
    out = unicodedata.normalize("NFC", str(name))
    out = "".join(_FORBIDDEN.get(ch, ch) for ch in out)
    out = "".join(ch for ch in out if unicodedata.category(ch) != "Cc")
    out = out.strip()
    # 連続した区切りをまとめる（"__" や "  " が混ざると検索しづらい）
    out = re.sub(r"\s+", " ", out)
    out = re.sub(r"_{2,}", "_", out)
    out = out.rstrip(" .")

    if not out:
        out = replacement

    stem = out.split(".")[0].upper()
    if stem in _RESERVED:
        out = f"{out}{replacement}"

    if len(out) > max_len:
        out = out[:max_len].rstrip(" .")
    return out


def safe_relpath(parts: str, *, max_len: int = 120) -> str:
    r"""`a\b\c` のような相対パスを、区切りを保ったまま各要素だけ整形する。"""
    normalized = str(parts).replace("/", "\\")
    segments = [seg for seg in normalized.split("\\") if seg not in ("", ".")]
    if any(seg == ".." for seg in segments):
        raise ConfigError(f"保存先テンプレートに '..' は使えません: {parts!r}")
    return "\\".join(safe_filename(seg, max_len=max_len) for seg in segments)
