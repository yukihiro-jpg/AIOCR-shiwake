"""RPA 実行中に発生する例外。

例外は「止めてよいもの」と「止めてはいけないもの」を型で区別する。
特に AbortRun は、PIN ロックの危険や送信済みの取り消し不能状態など、
**リトライしてはならない**状況を表す。呼び出し側は AbortRun を捕まえて
リトライループに戻してはならない。
"""

from __future__ import annotations


class RpaError(Exception):
    """このツールが送出する例外の基底。"""


class ConfigError(RpaError):
    """設定ファイル・顧問先マスタ・画面手順定義の不備。実行前に検出したい。"""


class ProfileError(ConfigError):
    """画面手順定義（プロファイル）の記述ミス。"""


class LocatorError(RpaError):
    """画面部品が見つからない／複数見つかって特定できない。"""

    def __init__(self, message: str, *, spec: object = None, screenshot: str | None = None):
        super().__init__(message)
        self.spec = spec
        self.screenshot = screenshot


class StepFailed(RpaError):
    """1ステップの実行に失敗した。リトライ可能。"""

    def __init__(self, message: str, *, step: object = None, screenshot: str | None = None):
        super().__init__(message)
        self.step = step
        self.screenshot = screenshot


class AssertionFailed(StepFailed):
    """assert_* 系ステップの検証に失敗した。

    画面が想定と違うということなので、**リトライせず**その顧問先の処理を打ち切る。
    """


class AbortRun(RpaError):
    """リトライ禁止の中断。

    - PIN を誤って入力した（カードロックを避けるため再試行しない）
    - 取り消し不能な操作の直前で人が中止した
    - 送信後に想定外の画面になった（二重送信を避けるため自動復旧しない）
    """


class SubmitBlocked(AbortRun):
    """練習モードで、取り消し不能な操作の直前に意図的に停止した。

    これは異常ではなく設計どおりの停止。呼び出し側は「成功（練習）」として扱う。
    """


class ConfirmationDeclined(AbortRun):
    """人が確認ダイアログで中止を選んだ。"""


class PinError(AbortRun):
    """PIN の入力・検証に関する失敗。絶対にリトライしない。"""
