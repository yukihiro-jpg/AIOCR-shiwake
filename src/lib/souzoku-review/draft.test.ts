// 口コミ下書きエンジンのテスト（tsc→nodeで直接実行する。テストランナーは使わない）
import { buildDraft, defaultTasks, type ReviewAnswers, type ReviewFlags } from './draft'

let fails = 0
const ok = (c: boolean, m: string) => { if (c) console.log('  OK  ', m); else { fails++; console.log('  FAIL', m) } }

const base: ReviewAnswers = { worries: [], tasks: [], goods: [], recommend: '', note: '' }
const flagsFull: ReviewFlags = {
  filing: true, realEstate: true, unlisted: false, securities: true, multiBank: true,
  kobo: true, lifeIns: true, gift: true, heirsMulti: true, spouse: true,
}

// --- 既定選択（案件データとの連動） ---
{
  const t = defaultTasks(flagsFull)
  ok(t.includes('filing') && !t.includes('judge'), '申告が必要な案件は「相続税の申告」が既定ON')
  ok(t.includes('valuation'), '不動産があると「財産の評価」が既定ON')
  ok(t.includes('shihoshoshi'), '不動産があると「司法書士の紹介」が既定ON')
  ok(t.includes('bankguide'), '複数金融機関・有価証券があると「預貯金等の進め方」が既定ON')
  ok(t.includes('division') && t.includes('secondary'), '相続人が複数＋配偶者ありで分割相談・二次相続が既定ON')
  const t2 = defaultTasks({ filing: false })
  ok(t2.includes('judge') && !t2.includes('filing'), '申告不要の案件は「かかるかどうかの判定」が既定ON')
  ok(!t2.includes('shihoshoshi') && !t2.includes('bankguide'), '該当しない項目は既定OFF')
}

// --- 文章の基本 ---
{
  const a: ReviewAnswers = { ...base, tasks: ['filing', 'valuation', 'shihoshoshi'], goods: ['clear', 'organized', 'deadline'], recommend: 'first', worries: ['start'] }
  const t = buildDraft(a, flagsFull, 1)
  ok(t.length >= 80 && t.length <= 300, `長さが80〜300字に収まる（${t.length}字）`)
  ok(t.endsWith('。'), '文末が句点で終わる')
  ok(/司法書士/.test(t), '司法書士の紹介が文章に入る')
  ok(!/名義変更を(お願い|依頼)/.test(t), '名義変更を「依頼した」とは書かない（提携先が行うため）')
  ok(!/[0-9０-９]/.test(t), '数字（金額・人数）が入らない')
}

// --- 言い回しのバリエーション ---
{
  const a: ReviewAnswers = { ...base, tasks: ['filing'], goods: ['clear', 'quick'], recommend: 'first', worries: ['start'] }
  const set = new Set<string>()
  for (let s = 1; s <= 40; s++) set.add(buildDraft(a, {}, s))
  ok(set.size >= 15, `同じ回答でも言い回しが分かれる（40回で${set.size}通り）`)
}

// --- よかった点は2つまでしか文章化しない（宣伝文にしない） ---
{
  const a: ReviewAnswers = { ...base, tasks: ['filing'], goods: ['clear', 'quick', 'fee'] }
  let feeCount = 0
  for (let s = 1; s <= 30; s++) if (/費用|料金/.test(buildDraft(a, {}, s))) feeCount++
  ok(feeCount === 0, '3つ目に選んだ点は文章に出さない（先の2つのみ）')
}

// --- ひとことの反映 ---
{
  const a: ReviewAnswers = { ...base, tasks: ['filing'], goods: ['clear'], note: '母も納得していました' }
  const t = buildDraft(a, {}, 7)
  ok(t.includes('母も納得していました'), 'ひとことが文章に入る')
  ok(!t.includes('「母も納得していました」'), 'かぎ括弧の引用にはしない（地の文になじませる）')
}

// --- 何も選ばなくても空にならない ---
{
  const t = buildDraft(base, {}, 3)
  ok(t.length > 20, '未選択でも下書きが空にならない')
}

// --- 選択肢の全キーが文章を持っている（設定漏れ検出） ---
{
  const tasks: ReviewAnswers['tasks'] = ['filing', 'judge', 'valuation', 'division', 'secondary', 'lifetime', 'junkakutei', 'meigi', 'shihoshoshi', 'bankguide']
  const goods: ReviewAnswers['goods'] = ['clear', 'quick', 'organized', 'deadline', 'fee', 'easyToAsk', 'proposal', 'referral', 'flexible']
  const worries: ReviewAnswers['worries'] = ['start', 'deadline', 'amount', 'family', 'time', 'far', 'whom']
  const recs = ['first', 'deadline', 'realEstate', 'far', 'manyHeirs', 'lifetime'] as const
  let allOk = true
  for (const t of tasks) for (const g of goods) for (const w of worries) {
    const d = buildDraft({ ...base, tasks: [t], goods: [g], worries: [w] }, {}, 5)
    if (d.length < 20 || /undefined/.test(d)) { allOk = false; console.log('       ->', t, g, w, d) }
  }
  for (const r of recs) {
    const d = buildDraft({ ...base, tasks: ['filing'], recommend: r }, {}, 5)
    if (!d.length || /undefined/.test(d)) allOk = false
  }
  ok(allOk, 'すべての選択肢の組み合わせで文章が生成される（undefinedが出ない）')
}

console.log(fails ? `FAILURES: ${fails}` : 'ALL CHECKS PASSED')
process.exit(fails ? 1 : 0)
