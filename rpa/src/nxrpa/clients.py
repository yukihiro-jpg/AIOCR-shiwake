"""顧問先マスタ（CSV）の読み込み。

NX-PRO 側の顧問先コードと、事務所の保存先・印刷先・対象書類をひも付ける表。
Excel で編集できるよう CSV（UTF-8 BOM 付き）とする。BOM を付けないと
Excel が Shift_JIS と誤認して社名が文字化けするため、書き出しは常に utf-8-sig。
"""

from __future__ import annotations

import csv
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Sequence

from .errors import ConfigError

# CSV の列名（日本語ヘッダも受け付ける）
_ALIASES = {
    "code": {"code", "顧問先コード", "コード", "客先コード"},
    "name": {"name", "会社名", "顧問先名", "名称"},
    "kana": {"kana", "カナ", "フリガナ", "かな"},
    "fiscal_year": {"fiscal_year", "年度", "事業年度"},
    "period_from": {"period_from", "期首", "自"},
    "period_to": {"period_to", "期末", "決算日", "至"},
    "consumption_tax": {"consumption_tax", "消費税", "課税事業者"},
    "local_gov": {"local_gov", "提出先自治体", "自治体", "地方税提出先"},
    "documents": {"documents", "対象書類", "書類"},
    "output_dir": {"output_dir", "保存先", "出力先"},
    "printer": {"printer", "プリンタ", "プリンター"},
    "enabled": {"enabled", "有効", "対象"},
    "note": {"note", "備考", "メモ"},
}

_TRUE = {"1", "true", "yes", "y", "○", "◯", "有", "対象", "課税", "はい", "on"}
_FALSE = {"0", "false", "no", "n", "×", "✕", "無", "対象外", "免税", "いいえ", "off", ""}


@dataclass(frozen=True)
class Client:
    """顧問先1件。テンプレートからは `{client.code}` などで参照する。"""

    code: str
    name: str
    kana: str = ""
    fiscal_year: str = ""
    period_from: str = ""
    period_to: str = ""
    consumption_tax: bool = False
    local_gov: str = ""
    documents: tuple[str, ...] = ()
    output_dir: str = ""
    printer: str = ""
    enabled: bool = True
    note: str = ""
    row_number: int = 0

    @property
    def label(self) -> str:
        """画面表示・確認ダイアログ用の見出し。"""
        return f"{self.code} {self.name}"

    def as_context(self) -> dict[str, str]:
        return {
            "code": self.code,
            "name": self.name,
            "kana": self.kana,
            "fiscal_year": self.fiscal_year,
            "period_from": self.period_from,
            "period_to": self.period_to,
            "local_gov": self.local_gov,
        }


@dataclass
class ClientBook:
    """顧問先マスタ全体。"""

    clients: list[Client] = field(default_factory=list)
    source: Path | None = None

    def __iter__(self):
        return iter(self.clients)

    def __len__(self) -> int:
        return len(self.clients)

    def enabled(self) -> list[Client]:
        return [c for c in self.clients if c.enabled]

    def by_code(self, code: str) -> Client:
        wanted = str(code).strip()
        for c in self.clients:
            if c.code == wanted:
                return c
        raise ConfigError(
            f"顧問先コード '{code}' が顧問先マスタにありません（{self.source}）。"
            f" 登録済み: {', '.join(c.code for c in self.clients[:20])}"
            f"{' ...' if len(self.clients) > 20 else ''}"
        )

    def search(self, keyword: str) -> list[Client]:
        """コード・社名・カナの部分一致で絞り込む（GUI の検索欄用）。"""
        kw = (keyword or "").strip()
        if not kw:
            return list(self.clients)
        low = kw.lower()
        return [
            c
            for c in self.clients
            if low in c.code.lower() or low in c.name.lower() or low in c.kana.lower()
        ]


def _norm_header(headers: Sequence[str]) -> dict[str, int]:
    """CSV のヘッダ行を内部の列名へ対応づける。"""
    mapping: dict[str, int] = {}
    for idx, raw in enumerate(headers):
        key = (raw or "").strip().lstrip("﻿")
        for canonical, names in _ALIASES.items():
            if key in names or key.lower() in {n.lower() for n in names}:
                mapping.setdefault(canonical, idx)
                break
    return mapping


def _to_bool(value: str, *, default: bool) -> bool:
    v = (value or "").strip().lower()
    if v in _TRUE:
        return True
    if v in _FALSE:
        return default if v == "" else False
    return default


def load_clients(path: str | Path) -> ClientBook:
    """顧問先マスタ CSV を読む。"""
    p = Path(path)
    if not p.exists():
        raise ConfigError(
            f"顧問先マスタが見つかりません: {p}\n"
            f"config/clients.csv を用意してください（サンプル: config/clients.sample.csv）"
        )

    with p.open("r", encoding="utf-8-sig", newline="") as fh:
        reader = csv.reader(fh)
        try:
            headers = next(reader)
        except StopIteration:
            raise ConfigError(f"顧問先マスタが空です: {p}") from None

        cols = _norm_header(headers)
        for required in ("code", "name"):
            if required not in cols:
                raise ConfigError(
                    f"顧問先マスタに必須列がありません: {required}（{p}）\n"
                    f"1行目に「顧問先コード, 会社名」を含むヘッダを置いてください。"
                    f" 読み取れた列: {headers}"
                )

        def cell(row: list[str], key: str) -> str:
            idx = cols.get(key)
            if idx is None or idx >= len(row):
                return ""
            return (row[idx] or "").strip()

        clients: list[Client] = []
        seen: dict[str, int] = {}
        for line_no, row in enumerate(reader, start=2):
            if not row or all(not (c or "").strip() for c in row):
                continue
            code = cell(row, "code")
            name = cell(row, "name")
            if not code and not name:
                continue
            if not code:
                raise ConfigError(f"{p}:{line_no} 顧問先コードが空です（会社名: {name}）")
            if not name:
                raise ConfigError(f"{p}:{line_no} 会社名が空です（コード: {code}）")
            if code in seen:
                raise ConfigError(
                    f"{p}:{line_no} 顧問先コード '{code}' が {seen[code]} 行目と重複しています。"
                    f" 保存先が混ざるため、重複は解消してください。"
                )
            seen[code] = line_no

            docs = tuple(
                d.strip() for d in cell(row, "documents").replace("、", ",").split(",") if d.strip()
            )
            clients.append(
                Client(
                    code=code,
                    name=name,
                    kana=cell(row, "kana"),
                    fiscal_year=cell(row, "fiscal_year"),
                    period_from=cell(row, "period_from"),
                    period_to=cell(row, "period_to"),
                    consumption_tax=_to_bool(cell(row, "consumption_tax"), default=False),
                    local_gov=cell(row, "local_gov"),
                    documents=docs,
                    output_dir=cell(row, "output_dir"),
                    printer=cell(row, "printer"),
                    enabled=_to_bool(cell(row, "enabled"), default=True),
                    note=cell(row, "note"),
                    row_number=line_no,
                )
            )

    if not clients:
        raise ConfigError(f"顧問先マスタに1件も登録がありません: {p}")
    return ClientBook(clients=clients, source=p)


def write_sample(path: str | Path, rows: Iterable[Client] = ()) -> Path:
    """サンプルの顧問先マスタを書き出す（初回セットアップ用）。"""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    header = [
        "顧問先コード", "会社名", "カナ", "年度", "期首", "期末",
        "消費税", "提出先自治体", "対象書類", "保存先", "プリンタ", "有効", "備考",
    ]
    body = [
        [c.code, c.name, c.kana, c.fiscal_year, c.period_from, c.period_to,
         "○" if c.consumption_tax else "×", c.local_gov, ",".join(c.documents),
         c.output_dir, c.printer, "○" if c.enabled else "×", c.note]
        for c in rows
    ] or [
        ["1001", "株式会社サンプル商事", "サンプルショウジ", "2026", "2025-04-01", "2026-03-31",
         "○", "茨城県水戸市", "", "", "", "○", "対象書類が空欄なら設定ファイルの既定を使う"],
        ["1002", "サンプル工業株式会社", "サンプルコウギョウ", "2026", "2025-07-01", "2026-06-30",
         "×", "茨城県つくば市",
         "kessansho,uchiwakesho,gaikyo,houjinzei,chihouzei_ken,chihouzei_shi,zeimudairi,"
         "juushin_kokuzei,juushin_chihouzei",
         "", "", "○", "対象書類を絞る例。免税事業者なので消費税は自動で外れる"],
    ]
    with p.open("w", encoding="utf-8-sig", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(header)
        w.writerows(body)
    return p
