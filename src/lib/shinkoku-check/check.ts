// 申告書チェック: チェック結果1件を組み立てる共通ヘルパー。
// analyze.ts と denki-checks.ts の双方から使うため、循環参照を避けて独立させている。
import type { CheckResult, CheckStatus } from './types'

export function mk(
  group: string,
  name: string,
  leftLabel: string,
  leftValue: number | null,
  rightLabel: string,
  rightValue: number | null,
  opts: { note?: string; tol?: number; infoOnly?: boolean } = {},
): CheckResult {
  let status: CheckStatus
  let diff: number | null = null
  if (leftValue == null && rightValue == null) status = 'na'
  else if (leftValue == null || rightValue == null) {
    status = 'warn'
  } else {
    diff = leftValue - rightValue
    const tol = opts.tol ?? 0
    if (Math.abs(diff) <= tol) status = 'ok'
    else status = opts.infoOnly ? 'info' : 'warn'
  }
  return {
    group,
    name,
    leftLabel,
    leftValue,
    rightLabel,
    rightValue,
    diff,
    status,
    note: opts.note,
  }
}

/** 金額の左右比較にならない項目（判定結果・注意喚起）を1行として並べる。
 *  金額欄には「－」を出す（textOnly）ので「検出不可」と誤読されない。 */
export function mkNote(
  group: string,
  name: string,
  status: CheckStatus,
  note: string,
): CheckResult {
  return {
    group,
    name,
    leftLabel: '',
    leftValue: null,
    rightLabel: '',
    rightValue: null,
    diff: null,
    status,
    note,
    textOnly: true,
  }
}
