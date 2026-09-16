'use client'

/**
 * 納税予測の前提を入力する箱（納税資金予測の画面に置く）。
 *
 * ・均等割 … 自治体プリセットから引く。プリセットは事務所で1つ持ち、全顧問先で共有する。
 *            資本金等の額と従業者数で区分が変わるので、その2つを入れれば金額が決まる。
 *            プリセットが無い／該当区分が無いときは手入力に落ちる。
 * ・消費税 … 課税方式（原則／簡易／免税）。**簡易課税は計算式そのものが違う**ので、
 *            ここを間違えると消費税の予測が丸ごと外れる。
 *
 * 税率表をアプリに焼き込まないのは、毎年どこかの自治体が変えるため
 * （焼き込むと、静かに間違えた金額を出し続けることになる）。
 */
import { useEffect, useState } from 'react'
import {
  CAPITAL_BRACKETS, capitalBracketOf, capitalLabel, eqPresetLabel, findRate,
  loadEqPresets, saveEqPresets, newEqPresetId,
} from '@/lib/keiei/equalization-presets'
import type { EqPreset, CapitalKey } from '@/lib/keiei/equalization-presets'
import { DEEMED_RATES } from '@/lib/keiei/kr/analysis'
import type { CtMethod } from '@/lib/keiei/kr/analysis'

const yen = (n: number) => Math.round(n).toLocaleString('ja-JP')

export interface TaxBasis {
  eqPresetId?: string
  eqCapital?: number
  eqStaff?: number
  /** 手入力の均等割（プリセットで決まらないとき） */
  equalization: number
  ctMethod?: CtMethod
  ctBiz?: number
  ctDeemedRate?: number
}

/** 設定から実際に使う均等割を決める。プリセットで決まればそれ、決まらなければ手入力。 */
export function resolveEqualization(b: TaxBasis, presets: EqPreset[]): {
  total: number; pref: number | null; city: number | null; preset: EqPreset | null; bracket: CapitalKey;
} {
  const preset = presets.find(p => p.id === b.eqPresetId) ?? null
  const bracket = capitalBracketOf(b.eqCapital ?? 0)
  const r = findRate(preset, bracket, (b.eqStaff ?? 0) > 50)
  if (!r) return { total: b.equalization, pref: null, city: null, preset, bracket }
  return { total: r.pref + r.city, pref: r.pref, city: r.city, preset, bracket }
}

export function TaxBasisBox({ basis, onChange }: {
  basis: TaxBasis
  onChange: (next: Partial<TaxBasis>) => void
}) {
  const [presets, setPresets] = useState<EqPreset[]>([])
  const [manage, setManage] = useState(false)

  const reload = () => { void loadEqPresets().then(setPresets).catch(() => setPresets([])) }
  useEffect(reload, [])

  const eq = resolveEqualization(basis, presets)
  const method: CtMethod = basis.ctMethod ?? 'general'

  return (
    <div className="card">
      <h3>納税予測の前提<span className="kr-only-adviser">税理士のみ</span>
        <small>ここを間違えると予測が丸ごと外れます</small></h3>

      <div className="kr-basis">
        {/* ---- 均等割 ---- */}
        <div className="kr-basis-col">
          <div className="kr-basis-h">住民税の均等割</div>
          <label className="kr-basis-row">
            <span>自治体</span>
            <select value={basis.eqPresetId ?? ''}
              onChange={e => onChange({ eqPresetId: e.target.value || undefined })}>
              <option value="">（手入力する）</option>
              {presets.map(p => <option key={p.id} value={p.id}>{eqPresetLabel(p)}</option>)}
            </select>
          </label>
          <label className="kr-basis-row">
            <span>資本金等の額</span>
            <input type="number" value={basis.eqCapital ?? ''} placeholder="例) 10000000"
              onChange={e => onChange({ eqCapital: Number(e.target.value) || 0 })} />
          </label>
          <div className="kr-basis-note">{capitalLabel(eq.bracket)}</div>
          <label className="kr-basis-row">
            <span>従業者数</span>
            <input type="number" value={basis.eqStaff ?? ''} placeholder="例) 12"
              onChange={e => onChange({ eqStaff: Number(e.target.value) || 0 })} />
          </label>
          <div className="kr-basis-note">{(basis.eqStaff ?? 0) > 50 ? '50人超' : '50人以下'}</div>

          {eq.pref !== null ? (
            <div className="kr-basis-result">
              <div>都道府県分 <b>{yen(eq.pref)}円</b></div>
              <div>市町村分 <b>{yen(eq.city ?? 0)}円</b></div>
              <div className="kr-basis-total">合計 <b>{yen(eq.total)}円</b></div>
            </div>
          ) : (
            <>
              <label className="kr-basis-row">
                <span>均等割（年額）</span>
                <input type="number" value={basis.equalization}
                  onChange={e => onChange({ equalization: Number(e.target.value) || 0 })} />
              </label>
              <div className="kr-basis-note">
                {basis.eqPresetId
                  ? 'この自治体にこの区分の金額が登録されていないため、手入力を使います。'
                  : '自治体を選ぶと、都道府県分と市町村分から自動で決まります。'}
              </div>
            </>
          )}
          <button type="button" className="secondary small" onClick={() => setManage(true)}>
            自治体の登録・編集
          </button>
        </div>

        {/* ---- 消費税 ---- */}
        <div className="kr-basis-col">
          <div className="kr-basis-h">消費税の課税方式</div>
          <label className="kr-basis-row">
            <span>方式</span>
            <select value={method}
              onChange={e => {
                const m = e.target.value as CtMethod
                // 簡易へ切り替えたときは事業区分も一緒に確定させる（未設定のままだと
                // 画面には第3種と出ているのに、計算側は率が無い状態になる）
                onChange(m === 'simplified' && basis.ctBiz == null
                  ? { ctMethod: m, ctBiz: 3 } : { ctMethod: m })
              }}>
              <option value="general">原則課税（仮受−仮払）</option>
              <option value="simplified">簡易課税（売上×みなし仕入率）</option>
              <option value="exempt">免税事業者</option>
            </select>
          </label>
          {method === 'simplified' && (
            <>
              <label className="kr-basis-row">
                <span>事業区分</span>
                <select value={basis.ctBiz ?? 3}
                  onChange={e => onChange({ ctBiz: Number(e.target.value), ctDeemedRate: undefined })}>
                  {Object.entries(DEEMED_RATES).map(([k, v]) => (
                    <option key={k} value={k}>{v.label} {Math.round(v.rate * 100)}%</option>
                  ))}
                </select>
              </label>
              <div className="kr-basis-note">
                複数の事業区分がある場合は、加重平均したみなし仕入率を下に入れてください。
              </div>
              <label className="kr-basis-row">
                <span>みなし仕入率</span>
                <input type="number" value={basis.ctDeemedRate ?? ''} placeholder="（空欄なら区分の率）"
                  onChange={e => onChange({
                    ctDeemedRate: e.target.value === '' ? undefined : Number(e.target.value),
                  })} />
              </label>
            </>
          )}
          <div className="kr-basis-note">
            {method === 'general'
              ? '仮受消費税と仮払消費税の増加額から見込みます。'
              : method === 'simplified'
                ? '仮払消費税は使いません。課税売上に係る消費税に（1−みなし仕入率）を掛けます。'
                : '納税は発生しない前提で計算します。'}
          </div>
        </div>
      </div>

      {manage && (
        <EqPresetDialog presets={presets} onClose={() => setManage(false)}
          onSaved={(list) => { setPresets(list); void saveEqPresets(list) }} />
      )}
    </div>
  )
}

/** 自治体プリセットの登録・編集。 */
function EqPresetDialog({ presets, onClose, onSaved }: {
  presets: EqPreset[]
  onClose: () => void
  onSaved: (list: EqPreset[]) => void
}) {
  const [list, setList] = useState<EqPreset[]>(() => JSON.parse(JSON.stringify(presets)) as EqPreset[])
  const [sel, setSel] = useState<string>(presets[0]?.id ?? '')
  const cur = list.find(p => p.id === sel) ?? null

  const update = (id: string, patch: Partial<EqPreset>) =>
    setList(l => l.map(p => (p.id === id ? { ...p, ...patch, updatedAt: Date.now() } : p)))

  const add = () => {
    const p: EqPreset = { id: newEqPresetId(), pref: '', city: '', rates: [], updatedAt: Date.now() }
    setList(l => [...l, p]); setSel(p.id)
  }

  const addRate = (id: string) => {
    const p = list.find(x => x.id === id); if (!p) return
    update(id, { rates: [...p.rates, { capital: 'a', staffOver50: false, pref: 0, city: 0 }] })
  }

  return (
    <div className="kr-drill-bg" onClick={onClose}>
      <div className="kr-drill" style={{ maxWidth: 880 }} onClick={e => e.stopPropagation()}>
        <div className="kr-drill-head">
          <b>自治体ごとの均等割</b>
          <button type="button" className="secondary small" onClick={onClose}>閉じる</button>
        </div>

        <div className="muted" style={{ marginBottom: 10 }}>
          事務所で1つ持ち、全顧問先で共有します。税率が変わったらここだけ直せば、
          その自治体の顧問先すべてに反映されます。金額は年額（円）で入れてください。
        </div>

        <div className="kr-eq-wrap">
          <div className="kr-eq-list">
            {list.map(p => (
              <button key={p.id} type="button"
                className={`kr-eq-item${p.id === sel ? ' on' : ''}`}
                onClick={() => setSel(p.id)}>
                {eqPresetLabel(p) || '（名称未設定）'}
                <span className="note">{p.rates.length}区分</span>
              </button>
            ))}
            <button type="button" className="secondary small" onClick={add}>＋ 自治体を追加</button>
          </div>

          <div className="kr-eq-edit">
            {!cur ? (
              <div className="muted">左から自治体を選ぶか、追加してください。</div>
            ) : (
              <>
                <div className="kr-basis-row">
                  <span>都道府県</span>
                  <input value={cur.pref} placeholder="例) 茨城県"
                    onChange={e => update(cur.id, { pref: e.target.value })} />
                </div>
                <div className="kr-basis-row">
                  <span>市町村</span>
                  <input value={cur.city} placeholder="例) 水戸市"
                    onChange={e => update(cur.id, { city: e.target.value })} />
                </div>
                <div className="kr-basis-row">
                  <span>メモ</span>
                  <input value={cur.note ?? ''} placeholder="確認した条例・確認日など"
                    onChange={e => update(cur.id, { note: e.target.value })} />
                </div>

                <table className="kr-grid" style={{ marginTop: 10 }}>
                  <thead>
                    <tr>
                      <th>資本金等の額</th>
                      <th style={{ width: 110 }}>従業者数</th>
                      <th className="num" style={{ width: 130 }}>都道府県分</th>
                      <th className="num" style={{ width: 130 }}>市町村分</th>
                      <th className="num" style={{ width: 120 }}>合計</th>
                      <th style={{ width: 60 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {cur.rates.map((r, i) => (
                      <tr key={i}>
                        <td>
                          <select value={r.capital} onChange={e => update(cur.id, {
                            rates: cur.rates.map((x, j) => (j === i ? { ...x, capital: e.target.value as CapitalKey } : x)),
                          })}>
                            {CAPITAL_BRACKETS.map(b => <option key={b.key} value={b.key}>{b.label}</option>)}
                          </select>
                        </td>
                        <td>
                          <select value={r.staffOver50 ? '1' : '0'} onChange={e => update(cur.id, {
                            rates: cur.rates.map((x, j) => (j === i ? { ...x, staffOver50: e.target.value === '1' } : x)),
                          })}>
                            <option value="0">50人以下</option>
                            <option value="1">50人超</option>
                          </select>
                        </td>
                        <td className="num">
                          <input type="number" value={r.pref} style={{ width: '100%', textAlign: 'right' }}
                            onChange={e => update(cur.id, {
                              rates: cur.rates.map((x, j) => (j === i ? { ...x, pref: Number(e.target.value) || 0 } : x)),
                            })} />
                        </td>
                        <td className="num">
                          <input type="number" value={r.city} style={{ width: '100%', textAlign: 'right' }}
                            onChange={e => update(cur.id, {
                              rates: cur.rates.map((x, j) => (j === i ? { ...x, city: Number(e.target.value) || 0 } : x)),
                            })} />
                        </td>
                        <td className="num"><b>{yen(r.pref + r.city)}</b></td>
                        <td>
                          <button type="button" className="kr-linkbtn" onClick={() => update(cur.id, {
                            rates: cur.rates.filter((_, j) => j !== i),
                          })}>削除</button>
                        </td>
                      </tr>
                    ))}
                    {cur.rates.length === 0 && (
                      <tr><td colSpan={6} className="muted">区分がまだありません。下のボタンで追加してください。</td></tr>
                    )}
                  </tbody>
                </table>
                <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                  <button type="button" className="secondary small" onClick={() => addRate(cur.id)}>
                    ＋ 区分を追加
                  </button>
                  <button type="button" className="secondary small"
                    onClick={() => {
                      if (!confirm(`「${eqPresetLabel(cur)}」を削除しますか？`)) return
                      setList(l => l.filter(p => p.id !== cur.id)); setSel('')
                    }}>この自治体を削除</button>
                </div>
              </>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button type="button" className="secondary" onClick={onClose}>キャンセル</button>
          <button type="button" onClick={() => { onSaved(list); onClose() }}>保存する</button>
        </div>
      </div>
    </div>
  )
}
