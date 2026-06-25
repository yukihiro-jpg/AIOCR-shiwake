'use client'

import {
  type Declaration,
  type DepInfo,
  type DisabilityType,
  emptyDependent,
  dependentCategory,
  spouseCategory,
  lookupPostal,
} from '@/lib/nenmatsu/declaration'

const DISABILITY: DisabilityType[] = ['非該当', '一般障害者', '特別障害者', '同居特別障害者']

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
          <L label="本人の障害者区分">
            <select className={inp} value={d.selfDisability} onChange={(e) => set({ selfDisability: e.target.value as DisabilityType })}>
              {DISABILITY.map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </L>
          <L label="寡婦／ひとり親">
            <select className={inp} value={d.widow} onChange={(e) => set({ widow: e.target.value as Declaration['widow'] })}>
              <option>非該当</option>
              <option>寡婦</option>
              <option>ひとり親</option>
            </select>
          </L>
          <L label="勤労学生（年収150万円以下）">
            <label className="flex items-center gap-2 text-sm h-9">
              <input type="checkbox" checked={d.workingStudent} onChange={(e) => set({ workingStudent: e.target.checked })} />
              <span>該当する</span>
            </label>
          </L>
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
            <L label="本年の年収（円）">
              <input className={inp} inputMode="numeric" value={d.spouse.income} onChange={(e) => setSpouse({ income: e.target.value })} />
            </L>
            <div className="col-span-2 text-xs text-blue-700 bg-blue-50 rounded px-2 py-1">
              控除区分（目安）：{spouseCategory(d.spouse)}
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
                <L label="本年の年収（円）">
                  <input className={inp} inputMode="numeric" value={dep.income} onChange={(e) => setDep(i, { income: e.target.value })} />
                </L>
                <L label="同居／別居">
                  <select className={inp} value={dep.liveTogether ? '同居' : '別居'} onChange={(e) => setDep(i, { liveTogether: e.target.value === '同居' })}>
                    <option>同居</option>
                    <option>別居</option>
                  </select>
                </L>
                <L label="障害者区分">
                  <select className={inp} value={dep.disability} onChange={(e) => setDep(i, { disability: e.target.value as DisabilityType })}>
                    {DISABILITY.map((x) => (
                      <option key={x}>{x}</option>
                    ))}
                  </select>
                </L>
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
