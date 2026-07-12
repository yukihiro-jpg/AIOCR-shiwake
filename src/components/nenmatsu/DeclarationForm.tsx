'use client'

import { useState } from 'react'
import {
  type Declaration,
  type DepInfo,
  type DisabilityType,
  type WidowType,
  emptyDependent,
  dependentCategory,
  spouseCategory,
  lookupPostal,
  numYen,
} from '@/lib/nenmatsu/declaration'

// 本人は「同居特別障害者」にはなり得ない（同居特別は配偶者・扶養親族のみの区分）
const DISABILITY_SELF: DisabilityType[] = ['非該当', '一般障害者', '特別障害者']
const DISABILITY_FAMILY: DisabilityType[] = ['非該当', '一般障害者', '特別障害者', '同居特別障害者']

/** 手帳の種類・等級から障害者区分を判断するための説明（税務に明るくない人向け） */
function DisabilityHelp({ forFamily }: { forFamily: boolean }) {
  return (
    <details className="col-span-2 text-[11px] text-gray-600 bg-sky-50 border border-sky-100 rounded-lg px-3 py-2">
      <summary className="cursor-pointer font-semibold text-sky-800">
        ❓ どれを選べばいい？（お手帳の種類・等級で確認できます）
      </summary>
      <div className="mt-2 space-y-1.5 leading-relaxed">
        <p>
          <b>非該当</b>：障害者手帳などをお持ちでない方（迷ったらこちらを選び、会社・事務所にご相談ください）。
        </p>
        <p>
          <b>特別障害者</b>：次のいずれかに当てはまる方。
          <br />・身体障害者手帳 <b>1級・2級</b>
          <br />・精神障害者保健福祉手帳 <b>1級</b>
          <br />・療育手帳 <b>A（重度）</b>
          <br />・いつも寝たきりで複雑な介護が必要な方、成年被後見人の方 など
        </p>
        <p>
          <b>一般障害者</b>：障害者手帳をお持ちで、上の「特別障害者」に当てはまらない方。
          <br />・身体障害者手帳 <b>3〜6級</b>
          <br />・精神障害者保健福祉手帳 <b>2級・3級</b>
          <br />・療育手帳 <b>B（中軽度）</b> など
        </p>
        {forFamily && (
          <p>
            <b>同居特別障害者</b>：上の「特別障害者」に当てはまる<b>ご家族</b>で、
            あなた（またはあなたの配偶者・同じ生計のご親族）と<b>ふだん同居している</b>方。
            施設に入所している場合は同居にはなりません（「特別障害者」を選択）。
          </p>
        )}
      </div>
    </details>
  )
}

/** 寡婦／ひとり親のかんたん判定（質問に答えると自動で選択される） */
function WidowWizard({ value, onSelect }: { value: WidowType; onSelect: (w: WidowType) => void }) {
  const [q1, setQ1] = useState('') // 現在結婚している？
  const [q2, setQ2] = useState('') // 年収677万円以下？
  const [q3, setQ3] = useState('') // 生計を一にする子がいる？
  const [q4, setQ4] = useState('') // （女性で）死別 or 離婚+扶養親族？

  const decide = (a1: string, a2: string, a3: string, a4: string): WidowType | null => {
    if (a1 === 'yes') return '非該当'
    if (a1 !== 'no') return null
    if (a2 === 'no') return '非該当'
    if (a2 !== 'yes') return null
    if (a3 === 'yes') return 'ひとり親'
    if (a3 !== 'no') return null
    if (a4 === 'yes') return '寡婦'
    if (a4 === 'no') return '非該当'
    return null
  }
  const result = decide(q1, q2, q3, q4)

  const Q = ({ text, val, set: setV, onDone }: { text: React.ReactNode; val: string; set: (v: string) => void; onDone: (v: string) => void }) => (
    <div className="flex items-start justify-between gap-2 py-1.5 border-b border-sky-100 last:border-b-0">
      <span className="flex-1">{text}</span>
      <span className="flex gap-1 shrink-0">
        {(['yes', 'no'] as const).map((v) => (
          <button key={v} type="button"
            onClick={() => { setV(v); onDone(v) }}
            className={`px-3 py-1 rounded-full border text-xs font-semibold ${val === v ? 'bg-sky-600 text-white border-sky-600' : 'bg-white text-gray-600 border-gray-300'}`}>
            {v === 'yes' ? 'はい' : 'いいえ'}
          </button>
        ))}
      </span>
    </div>
  )

  return (
    <details className="col-span-2 text-[11px] text-gray-700 bg-sky-50 border border-sky-100 rounded-lg px-3 py-2">
      <summary className="cursor-pointer font-semibold text-sky-800">
        ❓ どれに当てはまるか分からない方へ — かんたん判定（質問に答えると自動で選ばれます）
      </summary>
      <div className="mt-2">
        <Q text={<>Q1. 現在、結婚していますか？（籍を入れていなくても、事実上婚姻と同じ状態の方がいる場合は「はい」）</>}
          val={q1} set={setQ1} onDone={(v) => { const r = decide(v, q2, q3, q4); if (r) onSelect(r) }} />
        {q1 === 'no' && (
          <Q text={<>Q2. あなたの今年の収入は、お給料だけでおよそ<b>677万円以下</b>ですか？（お給料以外の収入がある場合は合計所得500万円以下）</>}
            val={q2} set={setQ2} onDone={(v) => { const r = decide(q1, v, q3, q4); if (r) onSelect(r) }} />
        )}
        {q1 === 'no' && q2 === 'yes' && (
          <Q text={<>Q3. あなたと生活費が同じ（生計を一にする）<b>お子さん</b>で、年収123万円以下の方がいますか？（別居で仕送りしている場合も含みます）</>}
            val={q3} set={setQ3} onDone={(v) => { const r = decide(q1, q2, v, q4); if (r) onSelect(r) }} />
        )}
        {q1 === 'no' && q2 === 'yes' && q3 === 'no' && (
          <Q text={<>Q4. あなたは女性で、次のどちらかに当てはまりますか？<br />
            ①夫と<b>死別</b>した後、再婚していない<br />
            ②夫と<b>離婚</b>した後、再婚しておらず、扶養しているご家族（父母・祖父母など。子以外でも可）がいる</>}
            val={q4} set={setQ4} onDone={(v) => { const r = decide(q1, q2, q3, v); if (r) onSelect(r) }} />
        )}
        {result && (
          <div className={`mt-2 px-2 py-1.5 rounded font-bold ${result === '非該当' ? 'bg-gray-100 text-gray-600' : 'bg-green-100 text-green-800'}`}>
            判定結果：{result} {value === result ? '（上の欄に反映しました）' : ''}
          </div>
        )}
        <p className="mt-2 text-gray-500">
          ※「ひとり親」は未婚・離婚・死別を問わず、男女どちらでも対象です。「寡婦」は女性のみの制度です。
        </p>
      </div>
    </details>
  )
}

/** 年収入力（#,###形式）。編集中は数字のみ、フォーカスを外すとカンマ区切りで表示する */
function MoneyInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [focused, setFocused] = useState(false)
  const digits = String(value || '').replace(/[^0-9]/g, '')
  const display = focused ? digits : digits ? Number(digits).toLocaleString('ja-JP') : ''
  return (
    <input
      className={inp}
      inputMode="numeric"
      placeholder={placeholder || '例：1,000,000'}
      value={display}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onChange={(e) => onChange(e.target.value.replace(/[^0-9]/g, ''))}
    />
  )
}

export default function DeclarationForm({
  value,
  onChange,
  fyGregorian,
  editableName,
}: {
  value: Declaration
  onChange: (d: Declaration) => void
  fyGregorian: number
  editableName: boolean
}) {
  const d = value
  const set = (patch: Partial<Declaration>) => onChange({ ...d, ...patch })
  const setSpouse = (patch: Partial<Declaration['spouse']>) =>
    onChange({ ...d, spouse: { ...d.spouse, ...patch } })
  const setDep = (i: number, patch: Partial<DepInfo>) =>
    onChange({ ...d, dependents: d.dependents.map((x, j) => (j === i ? { ...x, ...patch } : x)) })

  async function onPostal(v: string) {
    set({ postal: v })
    const addr = await lookupPostal(v)
    if (addr) onChange({ ...d, postal: v, address: addr })
  }

  // 旧データで本人に同居特別障害者が入っている場合は選択肢に残す（値の消失防止）
  const selfDisabilityOptions = DISABILITY_SELF.includes(d.selfDisability)
    ? DISABILITY_SELF
    : [...DISABILITY_SELF, d.selfDisability]

  return (
    <div className="space-y-5">
      {/* 本人情報 */}
      <section>
        <h3 className="font-semibold text-gray-800 text-sm mb-2">本人情報</h3>
        <div className="grid grid-cols-2 gap-2">
          <L label="姓">
            <input className={inp} value={d.lastName} disabled={!editableName} onChange={(e) => set({ lastName: e.target.value })} />
          </L>
          <L label="名">
            <input className={inp} value={d.firstName} disabled={!editableName} onChange={(e) => set({ firstName: e.target.value })} />
          </L>
          <L label="フリガナ（姓）">
            <input className={inp} value={d.kanaLast} onChange={(e) => set({ kanaLast: e.target.value })} />
          </L>
          <L label="フリガナ（名）">
            <input className={inp} value={d.kanaFirst} onChange={(e) => set({ kanaFirst: e.target.value })} />
          </L>
          <L label="生年月日">
            <input type="date" className={inp} value={d.birth} onChange={(e) => set({ birth: e.target.value })} />
          </L>
          {d.isNewHire && (
            <L label="入社日（本年入社の方は必ず入力）">
              <input type="date" className={inp} value={d.hireDate || ''} onChange={(e) => set({ hireDate: e.target.value })} />
            </L>
          )}
          {d.isNewHire && (
            <div className="col-span-2">
              <span className="block text-[11px] text-gray-500 mb-1">
                今年、入社前に他の会社で働いていましたか？（アルバイト・パートを含みます）
              </span>
              <div className="flex gap-2">
                {[
                  { v: true, label: '前職がある' },
                  { v: false, label: '前職はない' },
                ].map((o) => (
                  <button key={String(o.v)} type="button"
                    onClick={() => set({ hasPrevJob: o.v, ...(o.v ? {} : { prevJobNoSlip: false }) })}
                    className={`flex-1 py-2 rounded-lg border text-sm font-semibold ${d.hasPrevJob === o.v ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-600 border-gray-300'}`}>
                    {o.label}
                  </button>
                ))}
              </div>
              {d.hasPrevJob === true && (
                <div className="mt-2 text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 leading-relaxed">
                  📄 前職分も合わせて年末調整を行うため、<b>今年に退職したすべての前職の「源泉徴収票」</b>が必要です。
                  次の画面（書類の撮影）で必ず撮影してください。お手元にない場合は、前職の会社へ発行を依頼してください。
                </div>
              )}
            </div>
          )}
          <L label="郵便番号（自動で住所入力）">
            <input className={inp} inputMode="numeric" placeholder="1234567" value={d.postal} onChange={(e) => onPostal(e.target.value)} />
          </L>
          <div className="col-span-2">
            <L label="住所">
              <input className={inp} value={d.address} onChange={(e) => set({ address: e.target.value })} />
            </L>
          </div>
          <L label="世帯主の氏名">
            <input className={inp} value={d.householder} onChange={(e) => set({ householder: e.target.value })} />
          </L>
          <L label="世帯主との続柄">
            <input className={inp} value={d.householderRelation} onChange={(e) => set({ householderRelation: e.target.value })} />
          </L>
          <L label="本人の障害者区分（手帳などをお持ちでなければ「非該当」）">
            <select className={inp} value={d.selfDisability} onChange={(e) => set({ selfDisability: e.target.value as DisabilityType })}>
              {selfDisabilityOptions.map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </L>
          <div />
          <DisabilityHelp forFamily={false} />
          <L label="寡婦／ひとり親（当てはまらなければ「非該当」）">
            <select className={inp} value={d.widow} onChange={(e) => set({ widow: e.target.value as Declaration['widow'] })}>
              <option>非該当</option>
              <option>寡婦</option>
              <option>ひとり親</option>
            </select>
          </L>
          <div />
          <WidowWizard value={d.widow} onSelect={(w) => set({ widow: w })} />
          <L label="勤労学生">
            <label className="flex items-center gap-2 text-sm h-9">
              <input type="checkbox" checked={d.workingStudent} onChange={(e) => set({ workingStudent: e.target.checked })} />
              <span>該当する</span>
            </label>
          </L>
          <div />
          <details className="col-span-2 text-[11px] text-gray-600 bg-sky-50 border border-sky-100 rounded-lg px-3 py-2">
            <summary className="cursor-pointer font-semibold text-sky-800">❓ 勤労学生とは（学生アルバイトの方はご確認ください）</summary>
            <div className="mt-2 leading-relaxed space-y-1">
              <p>次の<b>両方</b>に当てはまる方はチェックしてください。</p>
              <p>① 大学・大学院・高校・中学校・（認可された）専門学校などの<b>学生・生徒</b>である</p>
              <p>② 今年の収入がお給料（アルバイト代）だけで<b>150万円以下</b>である（バイト先が2か所以上ある場合は合計で判断。給与以外の所得がある場合はご相談ください）</p>
              <p className="text-gray-500">※ 社会人の方、収入が150万円を超える方は対象外です（チェック不要）。</p>
            </div>
          </details>
        </div>
      </section>

      {/* 配偶者 */}
      <section>
        <h3 className="font-semibold text-gray-800 text-sm mb-2">配偶者</h3>
        <label className="flex items-center gap-2 text-sm mb-2">
          <input type="checkbox" checked={d.spouse.exists} onChange={(e) => setSpouse({ exists: e.target.checked })} />
          <span>配偶者がいる</span>
        </label>
        {d.spouse.exists && (
          <div className="grid grid-cols-2 gap-2">
            <L label="氏名">
              <input className={inp} value={d.spouse.name} onChange={(e) => setSpouse({ name: e.target.value })} />
            </L>
            <L label="フリガナ">
              <input className={inp} value={d.spouse.kana} onChange={(e) => setSpouse({ kana: e.target.value })} />
            </L>
            <L label="生年月日">
              <input type="date" className={inp} value={d.spouse.birth} onChange={(e) => setSpouse({ birth: e.target.value })} />
            </L>
            <L label="本年の年収（円）※税金や保険料が引かれる前の金額">
              <MoneyInput value={d.spouse.income} onChange={(v) => setSpouse({ income: v })} />
            </L>
            <div className="col-span-2 text-xs text-blue-700 bg-blue-50 rounded px-2 py-1">
              控除区分（目安）：{spouseCategory(d.spouse)}
              {numYen(d.spouse.income) > 0 && <span className="text-gray-500 ml-2">（入力額 {numYen(d.spouse.income).toLocaleString('ja-JP')}円）</span>}
            </div>
          </div>
        )}
      </section>

      {/* 扶養親族 */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-semibold text-gray-800 text-sm">扶養親族</h3>
          <button
            type="button"
            onClick={() => set({ dependents: [...d.dependents, emptyDependent()] })}
            className="px-3 py-1 text-xs bg-blue-50 text-blue-700 rounded"
          >
            ＋ 追加
          </button>
        </div>
        {d.dependents.length === 0 && <p className="text-xs text-gray-400">扶養親族がいる場合は「＋追加」してください。</p>}
        <div className="space-y-3">
          {d.dependents.map((dep, i) => (
            <div key={i} className="border border-gray-200 rounded-lg p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-gray-600">扶養 {i + 1}</span>
                <button
                  type="button"
                  onClick={() => set({ dependents: d.dependents.filter((_, j) => j !== i) })}
                  className="text-xs text-red-600"
                >
                  削除
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <L label="氏名">
                  <input className={inp} value={dep.name} onChange={(e) => setDep(i, { name: e.target.value })} />
                </L>
                <L label="フリガナ">
                  <input className={inp} value={dep.kana} onChange={(e) => setDep(i, { kana: e.target.value })} />
                </L>
                <L label="続柄">
                  <input className={inp} placeholder="例：長男・母" value={dep.relation} onChange={(e) => setDep(i, { relation: e.target.value })} />
                </L>
                <L label="生年月日">
                  <input type="date" className={inp} value={dep.birth} onChange={(e) => setDep(i, { birth: e.target.value })} />
                </L>
                <L label="本年の年収（円）※収入がなければ空欄でOK">
                  <MoneyInput value={dep.income} onChange={(v) => setDep(i, { income: v })} />
                </L>
                <L label="同居／別居">
                  <select className={inp} value={dep.liveTogether ? '同居' : '別居'} onChange={(e) => setDep(i, { liveTogether: e.target.value === '同居' })}>
                    <option>同居</option>
                    <option>別居</option>
                  </select>
                </L>
                <L label="障害者区分（手帳などがなければ「非該当」）">
                  <select className={inp} value={dep.disability} onChange={(e) => setDep(i, { disability: e.target.value as DisabilityType })}>
                    {DISABILITY_FAMILY.map((x) => (
                      <option key={x}>{x}</option>
                    ))}
                  </select>
                </L>
              </div>
              <div className="mt-2 grid grid-cols-1 gap-2">
                <DisabilityHelp forFamily={true} />
              </div>
              <div className="text-xs text-blue-700 bg-blue-50 rounded px-2 py-1 mt-2">
                控除区分（目安）：{dependentCategory(dep, fyGregorian)}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

const inp = 'w-full px-2 py-2 border border-gray-300 rounded text-sm disabled:bg-gray-100'

function L({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[11px] text-gray-500 mb-0.5">{label}</span>
      {children}
    </label>
  )
}
