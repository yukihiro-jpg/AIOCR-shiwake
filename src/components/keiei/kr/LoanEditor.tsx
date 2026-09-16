'use client'

/**
 * 借入金の返済予定（手入力）。
 *
 * 借入1本につき「当初額・実行日・回数・利率・返済方法」を入れれば、
 * 毎月の元金と利息は計算で出る。返済予定表を1行ずつ写す必要はない。
 * 元利均等で実際の返済額が計算値と1円単位で違う場合だけ、毎月返済額を直接入れられる。
 *
 * ここで入れた予定は
 *   ・FCF・借入返済バランス … 実績ではなく「今後12ヶ月の約定返済額」で見る
 *   ・納税資金予測          … 返済と納税を同じ月に並べ、資金が要る月を先に出す
 * で使う。
 */
import { useEffect, useMemo, useState } from 'react'
import {
  scheduleOf, equalPayment, mergeSchedules, METHOD_LABEL, newLoanId,
} from '@/lib/keiei/loans'
import type { Loan, RepayMethod } from '@/lib/keiei/loans'

const yen = (n: number) => Math.round(n).toLocaleString('ja-JP')

export function LoanEditor({ loans, onChange, onClose }: {
  loans: Loan[]
  onChange: (list: Loan[]) => void
  onClose: () => void
}) {
  const [list, setList] = useState<Loan[]>(() => JSON.parse(JSON.stringify(loans)) as Loan[])
  const [sel, setSel] = useState<string>(loans[0]?.id ?? '')
  const cur = list.find(l => l.id === sel) ?? null

  // 選択中の借入が消えたら先頭へ戻す
  useEffect(() => {
    if (!list.some(l => l.id === sel)) setSel(list[0]?.id ?? '')
  }, [list, sel])

  const up = (id: string, patch: Partial<Loan>) =>
    setList(l => l.map(x => (x.id === id ? { ...x, ...patch } : x)))

  const add = () => {
    const today = new Date()
    const l: Loan = {
      id: newLoanId(), name: '', principal: 0,
      startDate: `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`,
      termMonths: 60, rate: 1.5, method: 'equal-principal',
    }
    setList(x => [...x, l]); setSel(l.id)
  }

  const sched = useMemo(() => (cur ? scheduleOf(cur) : []), [cur])
  const calcPay = cur && cur.method === 'equal-payment'
    ? equalPayment(cur.principal, cur.rate, cur.termMonths) : 0

  return (
    <div className="kr-drill-bg" onClick={onClose}>
      <div className="kr-drill" style={{ maxWidth: 1000 }} onClick={e => e.stopPropagation()}>
        <div className="kr-drill-head">
          <b>借入金の返済予定</b>
          <button type="button" className="secondary small" onClick={onClose}>閉じる</button>
        </div>

        <div className="muted" style={{ marginBottom: 10 }}>
          借入1本につき、当初額・実行日・回数・利率・返済方法を入れてください。
          毎月の元金と利息は計算で出るので、返済予定表を1行ずつ写す必要はありません。
        </div>

        <div className="kr-eq-wrap">
          <div className="kr-eq-list">
            {list.map(l => (
              <button key={l.id} type="button"
                className={`kr-eq-item${l.id === sel ? ' on' : ''}`} onClick={() => setSel(l.id)}>
                <span>{l.name || '（名称未設定）'}</span>
                <span className="note">{yen(l.principal)}円</span>
              </button>
            ))}
            <button type="button" className="secondary small" onClick={add}>＋ 借入を追加</button>
          </div>

          <div className="kr-eq-edit">
            {!cur ? (
              <div className="muted">左から借入を選ぶか、追加してください。</div>
            ) : (
              <>
                <div className="kr-loan-form">
                  <label className="kr-basis-row">
                    <span>名称</span>
                    <input value={cur.name} placeholder="例) 常陽銀行 証書貸付"
                      onChange={e => up(cur.id, { name: e.target.value })} />
                  </label>
                  <label className="kr-basis-row">
                    <span>BSの科目名</span>
                    <input value={cur.account ?? ''} placeholder="例) 長期借入金（空欄可）"
                      onChange={e => up(cur.id, { account: e.target.value })} />
                  </label>
                  <label className="kr-basis-row">
                    <span>当初借入額</span>
                    <input type="number" value={cur.principal || ''}
                      onChange={e => up(cur.id, { principal: Number(e.target.value) || 0 })} />
                  </label>
                  <label className="kr-basis-row">
                    <span>実行日</span>
                    <input type="date" value={cur.startDate}
                      onChange={e => up(cur.id, { startDate: e.target.value })} />
                  </label>
                  <label className="kr-basis-row">
                    <span>返済方法</span>
                    <select value={cur.method}
                      onChange={e => up(cur.id, { method: e.target.value as RepayMethod })}>
                      {Object.entries(METHOD_LABEL).map(([k, v]) => (
                        <option key={k} value={k}>{v}</option>
                      ))}
                    </select>
                  </label>
                  <label className="kr-basis-row">
                    <span>返済回数（月）</span>
                    <input type="number" value={cur.termMonths || ''}
                      onChange={e => up(cur.id, { termMonths: Number(e.target.value) || 0 })} />
                  </label>
                  <label className="kr-basis-row">
                    <span>年利（%）</span>
                    <input type="number" step="0.01" value={cur.rate || ''}
                      onChange={e => up(cur.id, { rate: Number(e.target.value) || 0 })} />
                  </label>
                  <label className="kr-basis-row">
                    <span>据置（月）</span>
                    <input type="number" value={cur.graceMonths ?? ''} placeholder="0"
                      onChange={e => up(cur.id, { graceMonths: Number(e.target.value) || 0 })} />
                  </label>
                  {cur.method === 'equal-payment' && (
                    <label className="kr-basis-row">
                      <span>毎月返済額</span>
                      <input type="number" value={cur.fixedPayment ?? ''}
                        placeholder={`計算値 ${yen(calcPay)}`}
                        onChange={e => up(cur.id, {
                          fixedPayment: e.target.value === '' ? undefined : Number(e.target.value),
                        })} />
                    </label>
                  )}
                  <label className="kr-basis-row">
                    <span>メモ</span>
                    <input value={cur.note ?? ''} placeholder="保証料・借換の経緯など"
                      onChange={e => up(cur.id, { note: e.target.value })} />
                  </label>
                </div>

                {sched.length > 0 && (
                  <div className="kr-loan-sum">
                    <span>回数 <b>{sched.length}回</b></span>
                    <span>初回 <b>{sched[0].ym}</b></span>
                    <span>最終 <b>{sched[sched.length - 1].ym}</b></span>
                    <span>利息の総額 <b>{yen(sched.reduce((s, r) => s + r.interest, 0))}円</b></span>
                  </div>
                )}

                <div className="kr-drill-body" style={{ maxHeight: 260, marginTop: 8 }}>
                  <table className="kr-grid">
                    <thead>
                      <tr>
                        <th>支払月</th>
                        <th className="num">元金</th>
                        <th className="num">利息</th>
                        <th className="num">合計</th>
                        <th className="num">残高</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sched.slice(0, 120).map((r, i) => (
                        <tr key={i}>
                          <td>{r.ym}</td>
                          <td className="num">{yen(r.principal)}</td>
                          <td className="num">{yen(r.interest)}</td>
                          <td className="num">{yen(r.principal + r.interest)}</td>
                          <td className="num">{yen(r.balance)}</td>
                        </tr>
                      ))}
                      {sched.length === 0 && (
                        <tr><td colSpan={5} className="muted">
                          当初額・回数・実行日を入れると予定が出ます。
                        </td></tr>
                      )}
                    </tbody>
                  </table>
                </div>

                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <button type="button" className="secondary small" onClick={() => {
                    if (!confirm(`「${cur.name || '（名称未設定）'}」を削除しますか？`)) return
                    setList(l => l.filter(x => x.id !== cur.id))
                  }}>この借入を削除</button>
                </div>
              </>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
          <div className="muted">
            {list.length > 0 && (() => {
              const m = mergeSchedules(list)
              const keys = Array.from(m.keys()).sort()
              return keys.length
                ? `登録 ${list.length}本 ／ 予定の期間 ${keys[0]} 〜 ${keys[keys.length - 1]}`
                : ''
            })()}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="secondary" onClick={onClose}>キャンセル</button>
            <button type="button" onClick={() => { onChange(list); onClose() }}>保存する</button>
          </div>
        </div>
      </div>
    </div>
  )
}
