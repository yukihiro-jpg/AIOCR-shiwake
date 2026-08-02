// 相続人が答えた選択肢＋案件の特徴フラグから、口コミの「下書き」を組み立てる（純関数）。
//
// 方針（テンプレ感を出さないための工夫）:
//  - 文の構成そのものを複数パターン持ち、毎回どれかを選ぶ（不安から入る／依頼内容から入る 等）
//  - 選択肢1つにつき言い回しを4〜6通り用意し、組み合わせで重複しないようにする
//  - よかった点は最大3つ選べるが、文章にするのは2つまで（長所の羅列は宣伝文に見えるため）
//  - 語尾・接続をそろえない。事務所名は出さない。金額・人数・氏名は一切入れない
//  - seed を変えるだけで別の言い回しになる（画面の「別の言い回しにする」ボタン用）

export interface ReviewFlags {
  filing?: boolean       // 相続税の申告が必要だった
  realEstate?: boolean   // 土地・建物がある
  unlisted?: boolean     // 非上場株式がある
  securities?: boolean   // 有価証券がある
  multiBank?: boolean    // 金融機関が複数
  kobo?: boolean         // 小規模宅地等の特例を検討
  lifeIns?: boolean      // 生命保険金等がある
  gift?: boolean         // 生前贈与がある
  heirsMulti?: boolean   // 相続人が複数
  spouse?: boolean       // 配偶者がいる（二次相続の話につながる）
}

export type TaskKey =
  | 'filing' | 'judge' | 'valuation' | 'division' | 'secondary'
  | 'lifetime' | 'junkakutei' | 'meigi' | 'shihoshoshi' | 'bankguide'
export type GoodKey =
  | 'clear' | 'quick' | 'organized' | 'deadline' | 'fee'
  | 'easyToAsk' | 'proposal' | 'referral' | 'flexible'
export type WorryKey = 'start' | 'deadline' | 'amount' | 'family' | 'time' | 'far' | 'whom'
export type RecommendKey = 'first' | 'deadline' | 'realEstate' | 'far' | 'manyHeirs' | 'lifetime' | ''

export interface ReviewAnswers {
  worries: WorryKey[]   // Q4 依頼前の不安（任意）
  tasks: TaskKey[]      // Q1 依頼・相談したこと
  goods: GoodKey[]      // Q2 よかった点（最大3）
  recommend: RecommendKey // Q3 どんな方におすすめか（任意）
  note: string          // Q8 ひとこと（任意）
}

export const TASK_LABELS: [TaskKey, string][] = [
  ['filing', '相続税の申告'],
  ['judge', '相続税がかかるかどうかの判定・相談'],
  ['valuation', '土地や自社株など、財産の評価'],
  ['division', '遺産分割の進め方の相談（分けかたによる税額の違い）'],
  ['secondary', '二次相続まで見据えた試算'],
  ['lifetime', '生前の相続対策・生前贈与の相談'],
  ['junkakutei', '準確定申告'],
  ['meigi', '名義預金や生前の入出金の確認・整理'],
  ['shihoshoshi', '相続登記（不動産の名義変更）は提携の司法書士を紹介してもらった'],
  ['bankguide', '預貯金や証券の解約・名義変更は、必要書類や進め方を教えてもらった'],
]
export const GOOD_LABELS: [GoodKey, string][] = [
  ['clear', '説明が分かりやすかった'],
  ['quick', '連絡・返信が早かった'],
  ['organized', '必要な書類や段取りを整理してもらえた'],
  ['deadline', '期限内に終えられた'],
  ['fee', '費用が明確だった'],
  ['easyToAsk', '質問しやすい雰囲気だった'],
  ['proposal', '特例や分け方の提案があった'],
  ['referral', '提携の専門家を紹介してもらえた'],
  ['flexible', '訪問やオンラインなど柔軟に対応してもらえた'],
]
export const WORRY_LABELS: [WorryKey, string][] = [
  ['start', '何から始めればよいか分からなかった'],
  ['deadline', '期限に間に合うか不安だった'],
  ['amount', '税額がいくらになるか分からなかった'],
  ['family', '相続人同士の話し合いが心配だった'],
  ['time', '平日に動く時間が取れなかった'],
  ['far', '遠方で手続きが難しかった'],
  ['whom', 'どこに相談すればよいか分からなかった'],
]
export const RECOMMEND_LABELS: [Exclude<RecommendKey, ''>, string][] = [
  ['first', '初めて相続を経験する方'],
  ['deadline', '期限が迫っている方'],
  ['realEstate', '不動産を含む相続の方'],
  ['far', '遠方に住んでいる方'],
  ['manyHeirs', '相続人が複数いる方'],
  ['lifetime', '生前の対策を考えている方'],
]

/** 案件データから「文章に使ってよい特徴」だけを既定ONにする（金額・人数は使わない） */
export function defaultTasks(flags: ReviewFlags): TaskKey[] {
  const t: TaskKey[] = []
  if (flags.filing) t.push('filing')
  else t.push('judge')
  if (flags.realEstate || flags.unlisted) t.push('valuation')
  if (flags.heirsMulti) t.push('division')
  if (flags.spouse && flags.heirsMulti) t.push('secondary')
  if (flags.gift) t.push('lifetime')
  if (flags.realEstate) t.push('shihoshoshi')
  if (flags.multiBank || flags.securities) t.push('bankguide')
  return t
}

// ===== 乱数（seedを変えると別の言い回しになる） =====
function rng(seed: number): () => number {
  let a = (seed >>> 0) || 1
  return () => {
    a += 0x6d2b79f5
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
type Pick = <T>(arr: readonly T[]) => T

// ===== 言い回しのストック =====
const OPEN_WORRY: Record<WorryKey, string[]> = {
  start: [
    '何から手をつければいいのか分からない状態でした。',
    '正直、どこから始めればよいのかも分からずにいました。',
    '相続の手続きは初めてで、最初は何をすればいいのか見当もつきませんでした。',
    'まず何から動けばいいのか分からず、しばらく手が止まっていました。',
  ],
  deadline: [
    '期限まであまり日がなく、間に合うのかとハラハラしていました。',
    '申告の期限が近づいていて、正直かなり焦っていました。',
    '気づいたら期限が迫っていて、間に合うのか不安なままの相談でした。',
    '期限のことが頭にあって、落ち着かない日が続いていました。',
  ],
  amount: [
    '税金がいくらかかるのか見当もつかず、不安でした。',
    'どれくらい納めることになるのか分からないのが一番の心配でした。',
    '税額がまったく想像できず、もやもやしたまま相談しました。',
  ],
  family: [
    '相続人同士でうまく話がまとまるか、それが一番の心配でした。',
    '家族での話し合いがこじれないかという不安がありました。',
    '兄弟で話し合うことになるので、進め方に迷っていました。',
  ],
  time: [
    '平日に動ける時間がなかなか取れず、困っていました。',
    '仕事の合間に手続きを進められるのか不安でした。',
    '日中に役所や銀行へ行く時間が取れないのが悩みでした。',
  ],
  far: [
    '実家から離れて暮らしていて、手続きをどう進めるか悩んでいました。',
    '遠方に住んでいるので、そもそも進められるのか不安でした。',
    '距離があるぶん、何度も足を運べないのが心配でした。',
  ],
  whom: [
    'どこに相談すればいいのかも分からないところからのスタートでした。',
    '相談先の選び方すら分からず、ネットで探しているところからでした。',
    'そもそも誰に相談するのが正解なのか分からずにいました。',
  ],
}
// 依頼内容やよかった点のあとに置くときの言い回し（文頭に置く形とは別に用意する）
const LATE_WORRY: Record<WorryKey, string[]> = {
  start: [
    'こちらは何から手をつければいいのかも分かっていない状態でしたが、順を追って進めてもらえました。',
    '最初はまったくの手探りでしたが、迷わずに進められました。',
  ],
  deadline: [
    '期限が近づいていて気が気ではありませんでしたが、落ち着いて対応していただけました。',
    '時間に余裕がない状況でしたが、慌てずに進めてもらえました。',
  ],
  amount: [
    '税額の見当がつかず不安でしたが、早い段階で見通しを示していただけました。',
    'いくらかかるのか分からないままでしたが、その点も早めにはっきりしました。',
  ],
  family: [
    '家族での話し合いが必要でしたが、判断材料を示してもらえたので前に進めました。',
    '親族間で意見が分かれる場面もありましたが、整理して考えることができました。',
  ],
  time: [
    'こちらが平日に動けない事情も汲んでいただけました。',
    '時間が取れない中でも、負担の少ない進め方にしてもらえました。',
  ],
  far: [
    '離れて暮らしていて何度も足を運べませんでしたが、問題なく進められました。',
    '遠方からのやり取りでしたが、不便を感じることはありませんでした。',
  ],
  whom: [
    'どこに頼めばよいかも分からないところからでしたが、思い切って相談してよかったです。',
    '相談先選びから迷っていましたが、最初の面談で不安がほどけました。',
  ],
}
const TASK_PHRASE: Record<TaskKey, string[]> = {
  filing: ['相続税の申告', '相続税の申告手続き', '申告一式'],
  judge: ['相続税がかかるかどうかの確認', '申告が必要かどうかの判断', '相続税がかかるのかどうかの相談'],
  valuation: ['土地などの財産の評価', '不動産や株式の評価', '財産の評価'],
  division: ['遺産の分け方の相談', '分割の進め方', '遺産分割の相談'],
  secondary: ['次の相続まで見据えた試算', '二次相続を含めた試算', '将来の相続まで含めた検討'],
  lifetime: ['生前の対策', '生前贈与を含めた対策の相談', '元気なうちからの相続対策'],
  junkakutei: ['準確定申告', '亡くなった年の確定申告'],
  meigi: ['名義預金や生前の入出金の整理', '通帳の入出金の確認', '名義預金についての確認'],
  shihoshoshi: [], // 別文で扱う
  bankguide: [],   // 別文で扱う
}
const TASK_TAIL = [
  'をお願いしました。', 'でお世話になりました。', 'をお願いすることにしました。', 'について相談しました。',
]
const SHIHOSHOSHI = [
  '不動産の名義変更は提携の司法書士さんを紹介していただけたので、あちこち探さずに済んだのも助かりました。',
  '登記は提携の司法書士さんにつないでいただき、窓口が一つで完結したのもありがたかったです。',
  '名義変更については司法書士さんを紹介してもらえたので、自分で探す手間がありませんでした。',
  '不動産の登記は提携の先生を紹介してもらえて、そのまま任せられたのが楽でした。',
]
const BANKGUIDE = [
  '銀行の手続きも、必要な書類や進め方を教えてもらえたので迷わずに済みました。',
  '預貯金の解約に何が必要かも整理して教えていただけたので、窓口で困ることがありませんでした。',
  '金融機関でのやり取りについても、順番と必要書類を教えてもらえて助かりました。',
]
const GOOD_PHRASE: Record<GoodKey, string[]> = {
  clear: [
    '専門用語をかみ砕いて説明してもらえるので、税金に詳しくない私でも内容がきちんと分かりました。',
    '難しい話も日常の言葉で説明してくださるので、理解しないまま進むことがありませんでした。',
    '説明がとても分かりやすく、自分が今どの段階にいるのかが常に分かりました。',
    'ひとつひとつ噛み砕いて説明してくださるので、こちらの理解が追いつかないということがありませんでした。',
  ],
  quick: [
    '質問するとすぐに返してくださって、待たされている感じがまったくありませんでした。',
    '連絡がいつも早く、こちらから催促することは一度もありませんでした。',
    'メールの返信が早いので、迷ったときにすぐ確認できたのが心強かったです。',
    'レスポンスが早く、宙ぶらりんの時間がありませんでした。',
  ],
  organized: [
    'まず何を集めればよいかを順番に整理してくださって、そこからは迷わずに進められました。',
    '必要な書類と段取りを最初にまとめていただけたので、こちらは言われたものを用意するだけで済みました。',
    'やることを一覧にして示してもらえたので、抜け漏れの心配をせずに進められました。',
    '手順を先に示してくださるので、次に何をすればいいか分からなくなることがありませんでした。',
  ],
  deadline: [
    '期限内に無事に終えることができて、ほっとしています。',
    'おかげさまで期限に余裕をもって終わりました。',
    '心配していた期限もきちんと守れて、肩の荷が下りました。',
  ],
  fee: [
    '費用も最初にはっきり示していただけたので、余計な心配をせずに任せられました。',
    '料金の説明が明確で、後から想定外の請求が来るようなこともありませんでした。',
    '費用の見通しを先に教えてもらえたのが安心材料でした。',
  ],
  easyToAsk: [
    '細かいことも聞きやすい雰囲気で、素朴な疑問もそのまま質問できました。',
    'こんなことを聞いてもいいのかなという内容でも、嫌な顔ひとつせず答えてくださいました。',
    '気負わずに相談できる雰囲気で、些細なことも確認しながら進められました。',
  ],
  proposal: [
    '使える特例や分け方についても、その場しのぎではない提案をいただけました。',
    'こちらが知らなかった特例や分け方の選択肢まで示していただけたのが印象に残っています。',
    '税額だけでなく、その後のことまで考えた分け方を提案してもらえました。',
  ],
  referral: [
    '必要な場面では他の専門家も紹介していただけるので、こちらで探し回らずに済みました。',
    '手続きに応じて適切な専門家につないでもらえるのも心強い点でした。',
  ],
  flexible: [
    '訪問やオンラインなど、こちらの都合に合わせて対応していただけました。',
    'なかなか時間が取れない事情も汲んでいただき、進め方を合わせてもらえました。',
    '対面とオンラインを組み合わせてもらえたので、無理なく進められました。',
  ],
}
const CLOSING: Record<Exclude<RecommendKey, ''>, string[]> = {
  first: [
    '初めて相続を経験する方には心強いと思います。',
    '相続が初めてという方ほど、相談してみる価値があると思います。',
    '初めてで何も分からないという方にこそおすすめしたいです。',
  ],
  deadline: [
    '期限が近づいて焦っている方にこそおすすめしたいです。',
    '時間がないと感じている方は、早めに相談してみるとよいと思います。',
    '期限が迫っている方ほど、一度相談してみることをおすすめします。',
  ],
  realEstate: [
    '不動産が含まれる相続の方には特におすすめです。',
    '土地や建物がある相続で悩んでいる方には心強いと思います。',
  ],
  far: [
    '遠方に住んでいて何度も足を運べない方にもおすすめできます。',
    '離れて暮らしていて手続きが不安な方にも安心して任せられると思います。',
  ],
  manyHeirs: [
    '相続人が複数いて話し合いが必要な方にもおすすめしたいです。',
    '家族での話し合いが必要な相続の方にも向いていると思います。',
  ],
  lifetime: [
    '生前のうちに準備しておきたい方にもおすすめです。',
    'これから対策を考えたいという方にも相談してみてほしいです。',
  ],
}
// 何も選ばれなかったときの受け皿（下書きが空にならないようにする）
const FALLBACK = [
  '相続の手続きでお世話になりました。分からないことが多い中で、丁寧に対応していただけて助かりました。',
  '相続についてご相談しました。こちらの状況に合わせて進めてくださり、安心してお任せできました。',
]

function joinTasks(tasks: TaskKey[], pick: Pick): string {
  const phrases = tasks.map((t) => TASK_PHRASE[t]).filter((p) => p && p.length).map((p) => pick(p))
  if (!phrases.length) return ''
  const head = phrases.slice(0, 2)
  const body = head.length === 2 ? `${head[0]}と${head[1]}` : head[0]
  const extra = phrases.length > 2 ? pick(['、あわせて' + phrases[2] + 'も', '、' + phrases[2] + 'まで']) : ''
  return body + extra + pick(TASK_TAIL)
}

/** ひとことを地の文になじませる（かぎ括弧での引用にはしない） */
function weaveNote(note: string): string {
  const t = note.trim().replace(/\s+/g, ' ')
  if (!t) return ''
  const body = t.replace(/[。．.]+$/, '')
  if (body.length > 60) return body + '。'
  return body + '。'
}

export function buildDraft(a: ReviewAnswers, flags: ReviewFlags, seed: number): string {
  const rand = rng(seed)
  const pick: Pick = (arr) => arr[Math.floor(rand() * arr.length) % arr.length]

  const worryKey = a.worries.length ? pick(a.worries) : null
  const worry = worryKey ? pick(OPEN_WORRY[worryKey]) : ''
  const worryLate = worryKey ? pick(LATE_WORRY[worryKey]) : ''
  const taskSentence = joinTasks(a.tasks.filter((t) => t !== 'shihoshoshi' && t !== 'bankguide'), pick)
  const extras: string[] = []
  if (a.tasks.includes('shihoshoshi')) extras.push(pick(SHIHOSHOSHI))
  if (a.tasks.includes('bankguide')) extras.push(pick(BANKGUIDE))
  // よかった点は最大2つだけ文章化する（並べすぎると宣伝文に見えるため）
  const goods = a.goods.slice(0, 3)
  const goodSentences = goods.slice(0, 2).map((g) => pick(GOOD_PHRASE[g]))
  const closing = a.recommend ? pick(CLOSING[a.recommend]) : ''
  const note = weaveNote(a.note)

  // 構成のパターン（毎回どれかを選ぶ）
  const patterns: (() => string[])[] = [
    // ① 不安 → 依頼 → よかった点 → 追加 → ひとこと → 締め
    () => [worry, taskSentence, ...goodSentences, ...extras, note, closing],
    // ② 依頼 → よかった点 → 不安（振り返り） → 追加 → ひとこと → 締め
    () => [taskSentence, goodSentences[0] || '', worryLate, goodSentences[1] || '', ...extras, note, closing],
    // ③ よかった点から入る（結論先出し）
    () => [goodSentences[0] || '', taskSentence, worryLate, goodSentences[1] || '', ...extras, note, closing],
    // ④ 不安 → よかった点 → 依頼 → 追加 → ひとこと → 締め
    () => [worry, goodSentences[0] || '', taskSentence, goodSentences[1] || '', ...extras, note, closing],
  ]
  let parts = pick(patterns)().filter(Boolean)
  if (!parts.length) parts = [pick(FALLBACK)]

  let text = parts.join('')
  // 長すぎるときは後ろから削る（締めとひとことは残す）
  const MAX = 260
  while (text.length > MAX && parts.length > 3) {
    const dropIdx = parts.findIndex((p) => goodSentences.includes(p) || extras.includes(p))
    if (dropIdx < 0) break
    parts = parts.filter((_, i) => i !== dropIdx)
    text = parts.join('')
  }
  return text
}
