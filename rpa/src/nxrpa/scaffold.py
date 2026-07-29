"""`nxrpa init` — 設定ファイルのひな形を作る。

同梱の *.sample.yaml を、実際に読み込まれる名前へ複製する。
既にあるファイルは既定で触らない（事務所の設定を上書きしないため）。
"""

from __future__ import annotations

import shutil
from pathlib import Path

from .clients import write_sample
from .errors import ConfigError

# コピー元（パッケージからの相対）→ コピー先（作業ディレクトリからの相対）
SAMPLES = [
    ("config/settings.sample.yaml", "config/settings.yaml"),
    ("config/profiles/acelink-nx-pro.sample.yaml", "config/profiles/acelink-nx-pro.yaml"),
]


def package_root() -> Path:
    """同梱ファイルの置き場所を探す。

    開発時は rpa/ 直下、PyInstaller で固めたときは展開先を見る。
    """
    here = Path(__file__).resolve()
    # src/nxrpa/scaffold.py → rpa/
    candidate = here.parent.parent.parent
    if (candidate / "config" / "settings.sample.yaml").exists():
        return candidate

    import sys

    bundled = Path(getattr(sys, "_MEIPASS", "")) if hasattr(sys, "_MEIPASS") else None
    if bundled and (bundled / "config" / "settings.sample.yaml").exists():
        return bundled

    raise ConfigError(
        "同梱のひな形（config/settings.sample.yaml）が見つかりません。"
        " インストールが壊れている可能性があります。"
    )


def scaffold(target_dir: Path, *, force: bool = False) -> list[Path]:
    """ひな形一式を target_dir に作る。作った・更新したファイルの一覧を返す。"""
    root = package_root()
    target_dir = Path(target_dir).resolve()
    created: list[Path] = []

    for src_rel, dst_rel in SAMPLES:
        src = root / src_rel
        dst = target_dir / dst_rel
        if not src.exists():
            raise ConfigError(f"ひな形が見つかりません: {src}")
        if dst.exists() and not force:
            print(f"  既にあるので飛ばします: {dst}")
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dst)
        created.append(dst)

    clients = target_dir / "config" / "clients.csv"
    if not clients.exists() or force:
        write_sample(clients)
        created.append(clients)
    else:
        print(f"  既にあるので飛ばします: {clients}")

    for sub in ("logs", "output"):
        (target_dir / sub).mkdir(parents=True, exist_ok=True)

    # ログと出力は業務データなので、うっかり Git に入らないようにしておく
    gitignore = target_dir / ".gitignore"
    lines = ["logs/", "output/", "config/clients.csv", "config/settings.yaml"]
    if not gitignore.exists():
        gitignore.write_text(
            "# 業務データ・事務所固有の設定は共有しない\n" + "\n".join(lines) + "\n",
            encoding="utf-8",
        )
        created.append(gitignore)

    return created
