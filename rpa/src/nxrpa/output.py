"""保存先の組み立て。

ファイル名は「顧問先名＋資料名」。設定の file_template / folder_template を
テンプレートとして展開し、Windows で保存できる形に整えたうえで、
同名ファイルの扱い（連番・上書き・スキップ・エラー）を決める。

保存先が長くなりすぎるとき（顧問先名が長い＋深い共有フォルダ）は、
Windows の 260 文字制限に当たって「保存したつもりが保存されていない」事故になる。
ここで事前に検知して、はっきりしたメッセージで止める。
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .clients import Client
from .config import DocumentSpec, Settings
from .errors import ConfigError, RpaError
from .templating import render, safe_filename, safe_relpath

MAX_PATH = 259  # Windows の既定（\\?\ プレフィックス無し）


@dataclass(frozen=True)
class OutputTarget:
    """1書類の出力先。"""

    path: Path
    folder: Path
    filename: str
    doc: DocumentSpec
    client: Client
    existed: bool = False

    def as_context(self) -> dict[str, str]:
        return {
            "path": str(self.path),
            "folder": str(self.folder),
            "filename": self.filename,
            "stem": self.path.stem,
        }


def build_context(settings: Settings, client: Client, doc: DocumentSpec | None = None,
                  extra: dict[str, Any] | None = None) -> dict[str, Any]:
    """テンプレート展開用の変数一式。"""
    ctx: dict[str, Any] = settings.base_context()
    ctx["client"] = client.as_context()
    ctx["client"]["consumption_tax"] = client.consumption_tax
    if doc is not None:
        ctx["doc"] = doc.as_context()
    for k, v in (extra or {}).items():
        ctx[k] = v
    return ctx


def resolve_target(
    settings: Settings,
    client: Client,
    doc: DocumentSpec,
    *,
    extension: str = ".pdf",
    extra: dict[str, Any] | None = None,
) -> OutputTarget:
    """1書類分の保存先パスを決める（衝突処理はまだ行わない）。"""
    ctx = build_context(settings, client, doc, extra)

    root = Path(client.output_dir) if client.output_dir else settings.resolve(settings.paths.output_root)
    if not root.is_absolute():
        root = settings.resolve(root)

    folder_rel = render(settings.paths.folder_template, ctx, where="paths.folder_template")
    folder = root / safe_relpath(folder_rel) if folder_rel.strip() else root

    stem = render(settings.paths.file_template, ctx, where="paths.file_template")
    stem = safe_filename(stem)
    if not stem:
        raise ConfigError(
            f"ファイル名が空になりました（顧問先: {client.label} / 書類: {doc.label}）。"
            f" paths.file_template を確認してください。"
        )
    filename = f"{stem}{extension}"
    path = folder / filename

    _check_length(path, client, doc)
    return OutputTarget(path=path, folder=folder, filename=filename, doc=doc,
                        client=client, existed=path.exists())


def _check_length(path: Path, client: Client, doc: DocumentSpec) -> None:
    text = str(path)
    if len(text) > MAX_PATH:
        raise ConfigError(
            f"保存先のパスが長すぎます（{len(text)} 文字 > {MAX_PATH} 文字）。\n"
            f"  {text}\n"
            f"  顧問先: {client.label} / 書類: {doc.label}\n"
            f"  対処: paths.output_root をより浅い場所にする、"
            f"paths.folder_template を短くする、"
            f"または顧問先マスタの『保存先』列でこの顧問先だけ別の場所を指定してください。"
        )


def apply_conflict_policy(target: OutputTarget, policy: str) -> OutputTarget | None:
    """同名ファイルがあるときの扱いを決める。

    None を返したら「この書類は飛ばす」の意味（policy=skip）。
    """
    if not target.path.exists():
        return target

    if policy == "overwrite":
        return target
    if policy == "skip":
        return None
    if policy == "error":
        raise RpaError(
            f"保存先に同名のファイルが既にあります: {target.path}\n"
            f"  paths.on_existing が 'error' のため中止します。"
            f" 上書きしてよければ 'overwrite'、連番を付けるなら 'rename' にしてください。"
        )
    if policy != "rename":
        raise ConfigError(f"paths.on_existing の値が不正です: {policy!r}")

    # rename: 「会社名_法人税申告書 (2).pdf」の形で空きを探す
    stem, suffix = target.path.stem, target.path.suffix
    for n in range(2, 1000):
        candidate = target.folder / f"{stem} ({n}){suffix}"
        if not candidate.exists():
            from dataclasses import replace

            return replace(target, path=candidate, filename=candidate.name, existed=True)
    raise RpaError(f"同名ファイルが多すぎて保存先を決められません: {target.path}")


def ensure_folder(target: OutputTarget, *, create: bool = True) -> None:
    """保存先フォルダを用意し、書き込めることを確かめる。

    共有ドライブが切れている・権限が無い、といった事情は
    「PDF を作らせてから保存に失敗する」より前に分かった方がよい。
    """
    if create:
        try:
            target.folder.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise RpaError(
                f"保存先フォルダを作れません: {target.folder}\n"
                f"  原因: {exc}\n"
                f"  共有ドライブが接続されているか、書き込み権限があるか確認してください。"
            ) from exc
    elif not target.folder.exists():
        raise RpaError(f"保存先フォルダがありません: {target.folder}")

    probe = target.folder / f".nxrpa-write-test-{id(target) & 0xFFFF:04x}"
    try:
        probe.write_bytes(b"")
        probe.unlink()
    except OSError as exc:
        raise RpaError(
            f"保存先フォルダに書き込めません: {target.folder}\n"
            f"  原因: {exc}\n"
            f"  権限またはネットワークドライブの接続状態を確認してください。"
        ) from exc


def plan_outputs(settings: Settings, client: Client) -> list[OutputTarget]:
    """顧問先1件について、これから作る全書類の保存先を先に決める。

    実行前に一覧を見せて確認できるようにするための下ごしらえ。
    「どこに何が出るか」を送信前に見せられると、設定ミスに気付きやすい。
    """
    targets: list[OutputTarget] = []
    for doc in settings.documents_for(client):
        targets.append(resolve_target(settings, client, doc))
    _check_duplicates(targets, client)
    return targets


def _check_duplicates(targets: list[OutputTarget], client: Client) -> None:
    seen: dict[str, str] = {}
    for t in targets:
        key = str(t.path).lower()
        if key in seen:
            raise ConfigError(
                f"同じ保存先に2つの書類が割り当てられています（顧問先: {client.label}）:\n"
                f"  {t.path}\n"
                f"  '{seen[key]}' と '{t.doc.label}' が同じファイル名になります。\n"
                f"  settings.yaml の documents の label を区別できる名前にしてください。"
            )
        seen[key] = t.doc.label
