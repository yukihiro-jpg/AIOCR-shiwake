// 従業員が申告した内容と「変更前」を突き合わせて、修正・新規・削除を洗い出す。
//
// 「変更前」は従業員が画面で最初に見た内容と同じものを使う：
//   ① このアプリでの前年の提出があればそれ
//   ② 無ければ会社に登録されている内容（取り込んだCSV＝前年の扶養控除等申告書）
// どちらも無い（本年入社など）ときは、全項目を「新規」として扱う。

import type { Declaration, DepInfo, SpouseInfo } from './declaration'

/** 変更の種類。★＝修正 ＋＝新規 −＝削除（白黒印刷でも区別できるよう記号を付ける） */
export type ChangeKind = 'modified' | 'added' | 'removed'
export const CHANGE_MARK: Record<ChangeKind, string> = { modified: '★', added: '＋', removed: '−' }
export const CHANGE_LABEL: Record<ChangeKind, string> = { modified: '修正', added: '新規', removed: '削除' }

/** 変更前の内容（従業員ページの初期表示に使ったもの） */
export interface Baseline {
  /** 何を基準にしたか（Excelに書く） */
  source: 'prev' | 'csv' | 'none'
  sourceLabel: string // 例: 「令和8年度の提出」「会社の登録内容」
  lastName: string
  firstName: string
  kanaLast: string
  kanaFirst: string
  birth: string
  postal: string
  address: string
  householder: string
  householderRelation: string
  selfDisability: string
  widow: string
  workingStudent: boolean
  spouse: { exists: boolean; name: string; kana: string; birth: string; income: string }
  dependents: { name: string; kana: string; relation: string; birth: string; income: string; liveTogether?: boolean; disability?: string }[]
}

/** 1件の変更 */
export interface Change {
  kind: ChangeKind
  /** 対象の行（本人／配偶者／扶養N）。Excelの行と対応づける */
  target: 'self' | 'spouse' | `dep${number}`
  /** 本人行のどの列か（1始まり・列に色を付けるため）。行まるごとの追加・削除では未設定 */
  field?: string
  label: string // 例: 「住所」「扶養親族2（子・海野 花）」
  before: string
  after: string
}

const s = (v: unknown) => String(v ?? '').trim()
/** 比較用に空白・全角半角のゆれを吸収する（見た目が同じなら「変更なし」にする） */
const norm = (v: unknown) => s(v).normalize('NFKC').replace(/[\s　-]/g, '')
const yen = (v: unknown) => {
  const n = s(v).replace(/[^0-9]/g, '')
  return n ? `${Number(n).toLocaleString('ja-JP')}円` : ''
}

/** 空の変更前（本年入社など、比較対象が無いとき） */
export function emptyBaseline(): Baseline {
  return {
    source: 'none', sourceLabel: '',
    lastName: '', firstName: '', kanaLast: '', kanaFirst: '', birth: '',
    postal: '', address: '', householder: '', householderRelation: '',
    selfDisability: '非該当', widow: '非該当', workingStudent: false,
    spouse: { exists: false, name: '', kana: '', birth: '', income: '' },
    dependents: [],
  }
}

/** 前年の提出（Declaration）を変更前に変換 */
export function baselineFromDeclaration(d: Declaration, label: string): Baseline {
  return {
    source: 'prev', sourceLabel: label,
    lastName: s(d.lastName), firstName: s(d.firstName),
    kanaLast: s(d.kanaLast), kanaFirst: s(d.kanaFirst), birth: s(d.birth),
    postal: s(d.postal), address: s(d.address),
    householder: s(d.householder), householderRelation: s(d.householderRelation),
    selfDisability: s(d.selfDisability) || '非該当',
    widow: s(d.widow) || '非該当',
    workingStudent: !!d.workingStudent,
    spouse: {
      exists: !!d.spouse?.exists, name: s(d.spouse?.name), kana: s(d.spouse?.kana),
      birth: s(d.spouse?.birth), income: s(d.spouse?.income),
    },
    dependents: (d.dependents || []).map((x) => ({
      name: s(x.name), kana: s(x.kana), relation: s(x.relation), birth: s(x.birth),
      income: s(x.income), liveTogether: x.liveTogether, disability: s(x.disability),
    })),
  }
}

/** 会社の登録内容（CSV由来）を変更前に変換 */
export function baselineFromCsv(
  pre: { postal?: string; address?: string; spouse?: { name: string; kana: string; birth: string; income: string }; dependents?: { name: string; kana: string; relation: string; birth: string; income: string }[] },
  label = '会社の登録内容',
  /** 名簿（CSV）の本人。氏名・フリガナ・生年月日の直しも変更点として拾うために使う */
  self?: { lastName?: string; firstName?: string; kanaLast?: string; kanaFirst?: string; birth?: string },
): Baseline {
  return {
    ...emptyBaseline(),
    source: 'csv', sourceLabel: label,
    lastName: s(self?.lastName), firstName: s(self?.firstName),
    kanaLast: s(self?.kanaLast), kanaFirst: s(self?.kanaFirst), birth: s(self?.birth),
    postal: s(pre.postal), address: s(pre.address),
    spouse: pre.spouse
      ? { exists: true, name: s(pre.spouse.name), kana: s(pre.spouse.kana), birth: s(pre.spouse.birth), income: s(pre.spouse.income) }
      : { exists: false, name: '', kana: '', birth: '', income: '' },
    dependents: (pre.dependents || []).map((x) => ({
      name: s(x.name), kana: s(x.kana), relation: s(x.relation), birth: s(x.birth), income: s(x.income),
    })),
  }
}

/** 扶養親族の同一人物判定。氏名・フリガナ・生年月日のどれかで結び付ける。
 *  氏名だけで突き合わせると、漢字の誤りを直しただけで「削除＋新規」に見えてしまうため、
 *  フリガナ＋生年月日、または生年月日＋続柄が一致すれば同じ人として扱う（＝氏名の修正になる）。 */
function sameDependent(
  a: { name: string; kana?: string; birth: string; relation?: string },
  b: { name: string; kana?: string; birth: string; relation?: string },
): boolean {
  const an = norm(a.name), bn = norm(b.name)
  const ab = norm(a.birth), bb = norm(b.birth)
  const ak = norm(a.kana), bk = norm(b.kana)
  if (an && bn && an === bn) return !ab || !bb || ab === bb   // 氏名一致（生年月日が食い違わない）
  if (ak && bk && ak === bk && ab && bb && ab === bb) return true // フリガナ＋生年月日
  if (ab && bb && ab === bb && norm(a.relation) && norm(a.relation) === norm(b.relation)) return true // 生年月日＋続柄
  return false
}

function depLabel(i: number, d: { name: string; relation: string }): string {
  const who = [d.relation, d.name].filter(Boolean).join('・')
  return who ? `扶養親族${i + 1}（${who}）` : `扶養親族${i + 1}`
}

function spouseText(sp: { name: string; kana: string; birth: string; income: string }): string {
  return [sp.name, sp.birth, yen(sp.income)].filter(Boolean).join('・')
}
function depText(d: { name: string; relation: string; birth: string; income: string }): string {
  return [d.name, d.relation, d.birth, yen(d.income)].filter(Boolean).join('・')
}

/**
 * 変更前と申告内容を突き合わせる。
 * 本年入社（比較対象なし）は、入力のある項目を「新規」として並べる。
 */
export function diffDeclaration(base: Baseline, d: Declaration): Change[] {
  const out: Change[] = []
  const isNew = base.source === 'none'
  const push = (kind: ChangeKind, target: Change['target'], label: string, before: string, after: string, field?: string) => {
    out.push({ kind, target, label, before, after, field })
  }
  // 未入力のままでも既定で入る値。これを「新規に入力された」と数えると、
  // 本年入社の方の一覧が「非該当」ばかりになって肝心の変更が埋もれる
  const DEFAULTS: Record<string, string> = { selfDisability: '非該当', widow: '非該当', workingStudent: '非該当' }
  /** 本人行の項目。値が変わっていれば修正、変更前が空なら新規（空欄に入力されたということ） */
  const cmp = (field: string, label: string, before: string, after: string) => {
    if (!s(after) || norm(before) === norm(after)) {
      if (!isNew && norm(before) !== norm(after)) push('modified', 'self', label, s(before), s(after), field)
      return
    }
    if (DEFAULTS[field] && norm(after) === norm(DEFAULTS[field]) && !s(before)) return
    if (!s(before)) push('added', 'self', label, '', s(after), field)
    else push('modified', 'self', label, s(before), s(after), field)
  }
  cmp('lastName', '姓', base.lastName, s(d.lastName))
  cmp('firstName', '名', base.firstName, s(d.firstName))
  cmp('kanaLast', 'フリガナ（姓）', base.kanaLast, s(d.kanaLast))
  cmp('kanaFirst', 'フリガナ（名）', base.kanaFirst, s(d.kanaFirst))
  cmp('birth', '生年月日', base.birth, s(d.birth))
  cmp('postal', '郵便番号', base.postal, s(d.postal))
  cmp('address', '住所', base.address, s(d.address))
  cmp('householder', '世帯主', base.householder, s(d.householder))
  cmp('householderRelation', '世帯主との続柄', base.householderRelation, s(d.householderRelation))
  cmp('selfDisability', '本人の障害者区分', base.selfDisability, s(d.selfDisability) || '非該当')
  cmp('widow', '寡婦・ひとり親', base.widow, s(d.widow) || '非該当')
  cmp('workingStudent', '勤労学生', base.workingStudent ? '該当' : '非該当', d.workingStudent ? '該当' : '非該当')

  // 配偶者
  const bs = base.spouse, ds: SpouseInfo = d.spouse || { exists: false, name: '', kana: '', birth: '', income: '' }
  if (!bs.exists && ds.exists) push('added', 'spouse', '配偶者', '', spouseText({ name: s(ds.name), kana: s(ds.kana), birth: s(ds.birth), income: s(ds.income) }))
  else if (bs.exists && !ds.exists) push('removed', 'spouse', '配偶者', spouseText(bs), '')
  else if (bs.exists && ds.exists) {
    if (norm(bs.name) !== norm(ds.name)) push('modified', 'spouse', '配偶者の氏名', bs.name, s(ds.name), 'name')
    if (norm(bs.kana) !== norm(ds.kana)) push('modified', 'spouse', '配偶者のフリガナ', bs.kana, s(ds.kana), 'kana')
    if (norm(bs.birth) !== norm(ds.birth)) push('modified', 'spouse', '配偶者の生年月日', bs.birth, s(ds.birth), 'birth')
    if (norm(bs.income) !== norm(ds.income)) push('modified', 'spouse', '配偶者の年収', yen(bs.income), yen(ds.income), 'income')
  }

  // 扶養親族（氏名＋生年月日で結び付け、残りを新規／削除にする）
  const deps: DepInfo[] = d.dependents || []
  const usedBase = new Set<number>()
  deps.forEach((dep, i) => {
    const bi = base.dependents.findIndex((b, k) => !usedBase.has(k)
      && sameDependent(b, { name: s(dep.name), kana: s(dep.kana), birth: s(dep.birth), relation: s(dep.relation) }))
    if (bi < 0) {
      if (s(dep.name) || s(dep.relation)) {
        push('added', `dep${i}`, depLabel(i, { name: s(dep.name), relation: s(dep.relation) }), '',
          depText({ name: s(dep.name), relation: s(dep.relation), birth: s(dep.birth), income: s(dep.income) }))
      }
      return
    }
    usedBase.add(bi)
    const b = base.dependents[bi]
    const lab = depLabel(i, { name: s(dep.name), relation: s(dep.relation) })
    if (norm(b.name) !== norm(dep.name)) push('modified', `dep${i}`, `${lab} の氏名`, b.name, s(dep.name), 'name')
    if (norm(b.kana) !== norm(dep.kana)) push('modified', `dep${i}`, `${lab} のフリガナ`, b.kana || '', s(dep.kana), 'kana')
    if (norm(b.relation) !== norm(dep.relation)) push('modified', `dep${i}`, `${lab} の続柄`, b.relation, s(dep.relation), 'relation')
    if (norm(b.birth) !== norm(dep.birth)) push('modified', `dep${i}`, `${lab} の生年月日`, b.birth, s(dep.birth), 'birth')
    if (norm(b.income) !== norm(dep.income)) push('modified', `dep${i}`, `${lab} の年収`, yen(b.income), yen(dep.income), 'income')
    if (b.liveTogether !== undefined && !!b.liveTogether !== !!dep.liveTogether) {
      push('modified', `dep${i}`, `${lab} の同居・別居`, b.liveTogether ? '同居' : '別居', dep.liveTogether ? '同居' : '別居', 'liveTogether')
    }
    if (b.disability && norm(b.disability) !== norm(dep.disability)) {
      push('modified', `dep${i}`, `${lab} の障害者区分`, b.disability, s(dep.disability), 'disability')
    }
  })
  base.dependents.forEach((b, k) => {
    if (usedBase.has(k)) return
    if (!s(b.name)) return
    push('removed', `dep${base.dependents.length + k}`, `扶養親族（${[b.relation, b.name].filter(Boolean).join('・')}）`,
      depText({ name: b.name, relation: b.relation, birth: b.birth, income: b.income }), '')
  })
  return out
}

/** Excelのセル色分け用。行（target）ごとに、その行で起きた変更をまとめる */
export function changesByTarget(changes: Change[]): Map<string, Change[]> {
  const m = new Map<string, Change[]>()
  for (const c of changes) {
    const list = m.get(c.target) || []
    list.push(c)
    m.set(c.target, list)
  }
  return m
}
