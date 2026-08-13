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
    <details className="text-[14px] text-gray-700 bg-sky-50 border-[1.5px] border-sky-200 rounded-xl px-4 py-3 mb-4">
      <summary className="cursor-pointer font-bold text-sky-800 text-[15px] leading-relaxed">
        ❓ どれを選べばいい？（お手帳の種類・等級で確認できます）
      </summary>
      <div className="mt-2.5 space-y-2 leading-relaxed">
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
    <div className="py-2.5 border-b border-sky-100 last:border-b-0">
      <span className="block leading-relaxed">{text}</span>
      <span className="flex gap-2 mt-2">
        {(['yes', 'no'] as const).map((v) => (
          <button key={v} type="button"
            onClick={() => { setV(v); onDone(v) }}
            className={`flex-1 h-11 rounded-xl border-[1.5px] text-[16px] font-bold ${val === v ? 'bg-sky-600 text-white border-sky-600' : 'bg-white text-gray-600 border-gray-300'}`}>
            {v === 'yes' ? 'はい' : 'いいえ'}
          </button>
        ))}
      </span>
    </div>
  )

  return (
    <details className="text-[14px] text-gray-700 bg-sky-50 border-[1.5px] border-sky-200 rounded-xl px-4 py-3 mb-4">
      <summary className="cursor-pointer font-bold text-sky-800 text-[15px] leading-relaxed">
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
          <div className={`mt-3 px-3 py-2.5 rounded-xl text-[16px] font-bold ${result === '非該当' ? 'bg-gray-100 text-gray-600' : 'bg-green-100 text-green-800'}`}>
            判定結果：{result} {value === result ? '（上の欄に反映しました）' : ''}
          </div>
        )}
        <p className="mt-2.5 text-gray-500 leading-relaxed">
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
    <div className="space-y-4">
      {/* ===== 本人情報 ===== */}
      <section className="bg-white border border-gray-200 rounded-2xl px-4 py-4">
        <H title="本人情報" sub="扶養控除等申告書に書く内容です。上から順に入力してください。" />

        <L label="姓" required>
          <input className={inp} value={d.lastName} disabled={!editableName} onChange={(e) => set({ lastName: e.target.value })} />
        </L>
        <L label="名" required>
          <input className={inp} value={d.firstName} disabled={!editableName} onChange={(e) => set({ firstName: e.target.value })} />
        </L>
        <L label="フリガナ（姓）">
          <input className={inp} value={d.kanaLast} onChange={(e) => set({ kanaLast: e.target.value })} />
        </L>
        <L label="フリガナ（名）">
          <input className={inp} value={d.kanaFirst} onChange={(e) => set({ kanaFirst: e.target.value })} />
        </L>
        <L label="生年月日" required>
          <input type="date" className={dateInp} value={d.birth} onChange={(e) => set({ birth: e.target.value })} />
        </L>

        {d.isNewHire && (
          <L label="入社日" required>
            <input type="date" className={dateInp} value={d.hireDate || ''} onChange={(e) => set({ hireDate: e.target.value })} />
          </L>
        )}
        {d.isNewHire && (
          <div className="mb-4">
            <span className="block text-[15px] font-semibold text-gray-700 leading-relaxed">
              今年、入社前に他の会社で働いていましたか？
            </span>
            <span className="block text-[13px] text-gray-500 leading-relaxed mt-1 mb-2">アルバイト・パートも含みます。</span>
            <div className="flex gap-2.5">
              {[
                { v: true, label: '前職がある' },
                { v: false, label: '前職はない' },
              ].map((o) => (
                <button key={String(o.v)} type="button"
                  onClick={() => set({ hasPrevJob: o.v, ...(o.v ? {} : { prevJobNoSlip: false }) })}
                  className={`flex-1 h-14 rounded-xl border-[1.5px] text-[17px] font-bold ${d.hasPrevJob === o.v ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-600 border-gray-300'}`}>
                  {o.label}
                </button>
              ))}
            </div>
            {d.hasPrevJob === true && (
              <div className="mt-2.5 text-[14px] text-amber-800 bg-amber-50 border-[1.5px] border-amber-200 rounded-xl px-3.5 py-3 leading-relaxed">
                📄 前職分も合わせて年末調整を行うため、<b>今年に退職したすべての前職の「源泉徴収票」</b>が必要です。
                次の画面（書類の撮影）で必ず撮影してください。お手元にない場合は、前職の会社へ発行を依頼してください。
              </div>
            )}
          </div>
        )}

        <L label="郵便番号" note="入力すると住所が自動で入ります。">
          <input className={inp} inputMode="numeric" placeholder="1234567" value={d.postal} onChange={(e) => onPostal(e.target.value)} />
        </L>
        <L label="住所" required>
          <input className={inp} value={d.address} onChange={(e) => set({ address: e.target.value })} />
        </L>
        <L label="世帯主の氏名">
          <input className={inp} value={d.householder} onChange={(e) => set({ householder: e.target.value })} />
        </L>
        <L label="世帯主との続柄">
          <input className={inp} value={d.householderRelation} onChange={(e) => set({ householderRelation: e.target.value })} />
        </L>

        <L label="本人の障害者区分" note="手帳などをお持ちでなければ「非該当」のままで結構です。">
          <select className={inp} value={d.selfDisability} onChange={(e) => set({ selfDisability: e.target.value as DisabilityType })}>
            {selfDisabilityOptions.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </L>
        <DisabilityHelp forFamily={false} />

        <L label="寡婦／ひとり親" note="当てはまらなければ「非該当」のままで結構です。">
          <select className={inp} value={d.widow} onChange={(e) => set({ widow: e.target.value as Declaration['widow'] })}>
            <option>非該当</option>
            <option>寡婦</option>
            <option>ひとり親</option>
          </select>
        </L>
        <WidowWizard value={d.widow} onSelect={(w) => set({ widow: w })} />

        <div className="mb-4">
          <span className="block text-[15px] font-semibold text-gray-700 leading-relaxed mb-1.5">勤労学生</span>
          <label className={`flex items-center gap-3 border-[1.5px] rounded-xl px-4 py-3.5 text-[18px] font-semibold ${d.workingStudent ? 'border-blue-600 bg-blue-50 text-blue-700' : 'border-gray-300 bg-white text-gray-700'}`}>
            <input type="checkbox" className="w-6 h-6 accent-blue-600" checked={d.workingStudent} onChange={(e) => set({ workingStudent: e.target.checked })} />
            <span>該当する</span>
          </label>
        </div>
        <details className="text-[14px] text-gray-700 bg-sky-50 border-[1.5px] border-sky-200 rounded-xl px-4 py-3">
          <summary className="cursor-pointer font-bold text-sky-800 text-[15px] leading-relaxed">❓ 勤労学生とは（学生アルバイトの方はご確認ください）</summary>
          <div className="mt-2.5 leading-relaxed space-y-1.5">
            <p>次の<b>両方</b>に当てはまる方はチェックしてください。</p>
            <p>① 大学・大学院・高校・中学校・（認可された）専門学校などの<b>学生・生徒</b>である</p>
            <p>② 今年の収入がお給料（アルバイト代）だけで<b>150万円以下</b>である（バイト先が2か所以上ある場合は合計で判断。給与以外の所得がある場合はご相談ください）</p>
            <p className="text-gray-500">※ 社会人の方、収入が150万円を超える方は対象外です（チェック不要）。</p>
          </div>
        </details>
      </section>

      {/* ===== 配偶者 ===== */}
      <section className="bg-white border border-gray-200 rounded-2xl px-4 py-4">
        <H title="配偶者" />
        <label className={`flex items-center gap-3 border-[1.5px] rounded-xl px-4 py-3.5 text-[18px] font-semibold mb-4 ${d.spouse.exists ? 'border-blue-600 bg-blue-50 text-blue-700' : 'border-gray-300 bg-white text-gray-700'}`}>
          <input type="checkbox" className="w-6 h-6 accent-blue-600" checked={d.spouse.exists} onChange={(e) => setSpouse({ exists: e.target.checked })} />
          <span>配偶者がいる</span>
        </label>
        {d.spouse.exists && (
          <>
            <L label="氏名">
              <input className={inp} value={d.spouse.name} onChange={(e) => setSpouse({ name: e.target.value })} />
            </L>
            <L label="フリガナ">
              <input className={inp} value={d.spouse.kana} onChange={(e) => setSpouse({ kana: e.target.value })} />
            </L>
            <L label="生年月日">
              <input type="date" className={dateInp} value={d.spouse.birth} onChange={(e) => setSpouse({ birth: e.target.value })} />
            </L>
            <L label="本年の年収（円）" note={<>税金や保険料が引かれる<b>前</b>の金額です。</>}>
              <MoneyInput value={d.spouse.income} onChange={(v) => setSpouse({ income: v })} />
            </L>
            <div className="text-[15px] font-bold text-blue-700 bg-blue-50 border-[1.5px] border-blue-200 rounded-xl px-3.5 py-2.5 leading-relaxed">
              控除区分（目安）：{spouseCategory(d.spouse)}
              {numYen(d.spouse.income) > 0 && (
                <span className="block text-[13px] font-normal text-gray-500 mt-0.5">入力額 {numYen(d.spouse.income).toLocaleString('ja-JP')}円</span>
              )}
            </div>
          </>
        )}
      </section>

      {/* ===== 扶養親族 ===== */}
      <section className="bg-white border border-gray-200 rounded-2xl px-4 py-4">
        <H title="扶養親族" sub="お子さん・ご両親など、生活費が同じご家族がいる場合に追加してください。" />
        {d.dependents.length === 0 && (
          <p className="text-[14px] text-gray-500 mb-3 leading-relaxed">扶養親族がいる場合は、下の「＋ 扶養親族を追加」を押してください。</p>
        )}
        {d.dependents.map((dep, i) => (
          <div key={i} className="border-[1.5px] border-gray-200 rounded-2xl p-4 mb-3.5 bg-gray-50/40">
            <div className="flex items-center justify-between mb-3">
              <span className="text-[17px] font-bold text-gray-700">扶養 {i + 1} 人目</span>
              <button
                type="button"
                onClick={() => set({ dependents: d.dependents.filter((_, j) => j !== i) })}
                className="text-[15px] font-bold text-red-600 px-2 py-1"
              >
                削除
              </button>
            </div>
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
              <input type="date" className={dateInp} value={dep.birth} onChange={(e) => setDep(i, { birth: e.target.value })} />
            </L>
            <L label="本年の年収（円）" optional note="収入がなければ空欄で結構です。">
              <MoneyInput value={dep.income} onChange={(v) => setDep(i, { income: v })} />
            </L>
            <L label="同居／別居">
              <select className={inp} value={dep.liveTogether ? '同居' : '別居'} onChange={(e) => setDep(i, { liveTogether: e.target.value === '同居' })}>
                <option>同居</option>
                <option>別居</option>
              </select>
            </L>
            <L label="障害者区分" note="手帳などをお持ちでなければ「非該当」のままで結構です。">
              <select className={inp} value={dep.disability} onChange={(e) => setDep(i, { disability: e.target.value as DisabilityType })}>
                {DISABILITY_FAMILY.map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </L>
            <DisabilityHelp forFamily={true} />
            <div className="text-[15px] font-bold text-blue-700 bg-blue-50 border-[1.5px] border-blue-200 rounded-xl px-3.5 py-2.5 leading-relaxed">
              控除区分（目安）：{dependentCategory(dep, fyGregorian)}
            </div>
          </div>
        ))}
        <button
          type="button"
          onClick={() => set({ dependents: [...d.dependents, emptyDependent()] })}
          className="w-full h-[52px] rounded-xl border-2 border-dashed border-blue-300 bg-blue-50/40 text-blue-700 text-[16px] font-bold"
        >
          ＋ 扶養親族を追加
        </button>
      </section>
    </div>
  )
}

// スマホで見る画面なので、1列・大きめの文字・押しやすい高さで組む（ユーザー合意済み）。
// 文字は従来より2周り大きい（ラベル 11→15px／入力 14→18px／見出し 14→20px）。
// 入力欄の高さ52pxは、指で正確に押せる大きさ（44px以上）を確保するため。
const inp = 'w-full h-[52px] px-3.5 border-[1.5px] border-gray-300 rounded-xl text-[18px] bg-white ' +
  'focus:outline-none focus:border-blue-600 focus:ring-4 focus:ring-blue-100 disabled:bg-gray-100 disabled:text-gray-400'
// iOS Safari の date 入力は固有幅を持ちはみ出すため、appearance を無効化して幅・高さを揃える
const dateInp = inp + ' min-w-0 appearance-none'

/** 入力1つ分。ラベル・補足・必須バッジをまとめて縦に積む */
function L({ label, note, required, optional, children }: {
  label: string
  note?: React.ReactNode
  required?: boolean
  optional?: boolean
  children: React.ReactNode
}) {
  return (
    <label className="block mb-4">
      <span className="block text-[15px] font-semibold text-gray-700 leading-relaxed">
        {label}
        {required && <span className="ml-1.5 align-[2px] inline-block px-1.5 py-px rounded text-[12px] font-bold text-white bg-red-600">必須</span>}
        {optional && <span className="ml-1.5 align-[2px] inline-block px-1.5 py-px rounded text-[12px] font-bold text-gray-500 bg-gray-100">任意</span>}
      </span>
      {note && <span className="block text-[13px] text-gray-500 leading-relaxed mt-1 mb-1.5">{note}</span>}
      <span className={`block ${note ? '' : 'mt-1.5'}`}>{children}</span>
    </label>
  )
}

/** セクションの見出し（左に青い帯） */
function H({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="mb-3">
      <h3 className="relative pl-3 text-[20px] font-bold text-gray-800 leading-snug
        before:absolute before:left-0 before:top-1 before:bottom-1 before:w-[5px] before:rounded before:bg-blue-600 before:content-['']">
        {title}
      </h3>
      {sub && <p className="pl-3 mt-1 text-[14px] text-gray-500 leading-relaxed">{sub}</p>}
    </div>
  )
}
