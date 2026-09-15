'use client'

// 月次推移の数字から、その中身（元帳の明細）へ降りるパネル。
//
// 月次推移は試算表（合計残高）から作っているので、金額の「理由」は分からない。
// 元帳を取り込んであれば、科目と月を指定して明細を出せる。
//
// 【重要】月次推移の金額と元帳の合計は、必ずしも一致しない。
//   ・元帳を全期間ぶん取り込んでいない
//   ・試算表と元帳の出力時点がずれている（決算整理の前後）
// ので、**両方を並べて出し、違うときは理由の候補を書く**。
// 黙って元帳の数字だけ見せると、試算表と違うことに気づけない。

import { useMemo, useState } from 'react'
import { entriesOfAccount } from '@/lib/keiei/kr/ledger/aggregate'
import type { Ledger, AccountKind } from '@/lib/keiei/kr/ledger/aggregate'
import { yen } from '@/lib/keiei/kr/analysis'

export interface DrillTarget {
  /** 月次推移の科目名（元帳の科目名と突き合わせる） */
  name: string
  /** 対象期間の表示名（「令和8年9月期 5月」など） */
  label: string
  from: string
  to: string
  /** 月次推移側の金額（突合用）。null なら比較しない */
  expected: number | null
}

export function LedgerDrill({ led, kinds, target, onClose }: {
  led: Ledger
  kinds: Map<string, AccountKind>
  target: DrillTarget
  onClose: () => void
}) {
  const [tab, setTab] = useState<'partner' | 'detail'>('partner')
  const r = useMemo(
    () => entriesOfAccount(led, kinds, target.name, { from: target.from, to: target.to }),
    [led, kinds, target],
  )
  // 元帳に同じ名前の科目が無い（科目名が試算表と違う）場合の案内材料
  const known = useMemo(() => new Set(led.entries.map(e => e.an)), [led])
  const missing = !known.has(target.name)
  const diff = target.expected == null ? null : r.total - target.expected

  return (
    <div className="kr-drill-bg" onClick={onClose}>
      <div className="kr-drill" onClick={e => e.stopPropagation()}>
        <div className="kr-drill-head">
          <div>
            <b>{target.name}</b>
            <span className="muted" style={{ marginLeft: 8 }}>{target.label}</span>
          </div>
          <button type="button" className="secondary small" onClick={onClose}>閉じる</button>
        </div>

        {missing ? (
          <div className="warn-box">
            取り込んである元帳に「{target.name}」の明細が見当たりません。
            試算表と元帳で科目名の書き方が違う、またはこの期間の元帳が未取込の可能性があります。
          </div>
        ) : r.rows.length === 0 ? (
          <div className="warn-box">この期間には明細がありませんでした。</div>
        ) : (
          <>
            <div className="kr-drill-sum">
              <div>
                <span className="muted">元帳の合計</span>
                <b>{yen(r.total)}円</b>
                <span className="muted">（{r.rows.length}件）</span>
              </div>
              {target.expected != null && (
                <div>
                  <span className="muted">月次推移の金額</span>
                  <b>{yen(target.expected)}円</b>
                </div>
              )}
              {diff != null && diff !== 0 && (
                <div className="kr-drill-diff">差 {yen(diff)}円</div>
              )}
            </div>
            {diff != null && diff !== 0 && (
              <div className="warn-box" style={{ marginTop: 0 }}>
                元帳の合計が月次推移の金額と一致しません。決算整理の前後で試算表と元帳の
                出力時点がずれている、またはこの期間の元帳が一部しか取り込まれていない可能性があります。
              </div>
            )}

            <div className="kr-drill-tabs">
              <button type="button" className={tab === 'partner' ? '' : 'secondary'}
                onClick={() => setTab('partner')}>相手先別（{r.byPartner.length}先）</button>
              <button type="button" className={tab === 'detail' ? '' : 'secondary'}
                onClick={() => setTab('detail')}>明細（{r.rows.length}件）</button>
            </div>

            <div className="kr-drill-body">
              {tab === 'partner' ? (
                <table className="kr-grid">
                  <thead>
                    <tr>
                      <th>相手先</th>
                      <th className="num">金額</th>
                      <th className="num">件数</th>
                      <th className="num">構成比</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.byPartner.map(b => (
                      <tr key={b.name}>
                        <td>{b.name}</td>
                        <td className="num">{yen(b.amount)}</td>
                        <td className="num">{b.count}</td>
                        <td className="num">
                          {r.total !== 0 ? `${((b.amount / r.total) * 100).toFixed(1)}%` : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <table className="kr-grid">
                  <thead>
                    <tr>
                      <th>日付</th>
                      <th>摘要</th>
                      <th>相手科目</th>
                      <th className="num">借方</th>
                      <th className="num">貸方</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.rows.map((e, i) => (
                      <tr key={`${e.d}-${i}`}>
                        <td style={{ whiteSpace: 'nowrap' }}>{e.d}</td>
                        <td>{e.no}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>{e.ca}</td>
                        <td className="num">{e.dr ? yen(e.dr) : ''}</td>
                        <td className="num">{e.cr ? yen(e.cr) : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
