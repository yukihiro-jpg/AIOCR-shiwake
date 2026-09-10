// 「AIに質問」で、キーワード判定に当たらなかったときだけ呼ぶ質問の読み取り。
//
// ■ このファイルがやること／やらないこと
//   やること   : 質問の文章を読んで、どの集計で答えるべきかを1つ選ぶ。
//   やらないこと: 金額の計算。**数字は1円たりともAIに渡さない**。
//
//   AIに送るのは「質問の文章だけ」（例:「今月どうだった？」）。売上・利益・残高も、
//   会社名も、仕訳の明細も送らない。返ってくるのは集計の名前という短い文字列だけで、
//   実際の金額はブラウザの中（analysis.ts）で計算する。
//   → 渡していないものは漏れない。
//
// ■ 移植元との違い
//   顧問先用アプリは Cloud Functions 経由で Vertex AI を呼んでいた（AIを呼ぶ資格を
//   ブラウザに置かないため）。この総合管理アプリは事務所内で使うもので、
//   Gemini APIキーは元々この端末の共通設定に入っている（他のモジュールと同じ扱い）ので、
//   ここではブラウザから直接呼ぶ。キーはURLに載せずヘッダで渡す（gemini-client と同じ作法）。
//
// ■ 失敗したときの約束
//   AIが呼べなくても画面は壊さない。キーワード判定の結果に戻すだけ。

import { askGeminiJson } from '@/lib/bank-statement/gemini-client'

/** 選べる集計の一覧。qa/answers.ts の PRESETS の id と必ず一致させること */
const TOOLS: { id: string; desc: string }[] = [
  { id: 'monthResult', desc: 'ある1ヶ月の売上高・粗利・営業利益・経常利益。「今月は」「先月どうだった」「5月はどのくらい儲かった」など' },
  { id: 'vsPrev', desc: '前期（前年同期）との比較。「去年と比べて」「前年比」など' },
  { id: 'cashTrend', desc: '現金預金の残高と増減。「お金は残っているか」「資金繰り」「手元資金」など' },
  { id: 'bestSalesMonth', desc: '売上が最も多かった月・少なかった月、売上の月別の山谷。「一番売れた月」など' },
  { id: 'bep', desc: '損益分岐点売上高。「トントンになる売上」「いくら売れば赤字にならないか」など' },
  { id: 'needSales', desc: '黒字化にあといくら売上が必要か。不足額。「あといくら」など' },
  { id: 'expenseUp', desc: '経費・販管費が前年と比べてどう増減したか。科目別の増加。「無駄な出費」「コスト増」など' },
  { id: 'debtYears', desc: '借入金・リースの残高と、何年で返済できるか（債務償還年数）。「融資」「返済」など' },
  { id: 'laborShare', desc: '人件費・給料の水準、労働分配率。「人件費は多すぎないか」など' },
  { id: 'accountAmount', desc: '勘定科目を名指しした金額。「交際費はいくら使った」「家賃の合計」「売掛金の残高」など' },
  { id: 'periodResult', desc: '期間を区切った業績。「上半期は」「第2四半期の」「4月から6月の」など' },
  { id: 'partnerTotal', desc: '特定の取引先との金額。「〇〇商事にいくら払った」「△△との取引は」など' },
  { id: 'partnerRanking', desc: '科目の相手先別の内訳・ランキング。「修繕費を相手先別に」「外注費は誰に払った」など' },
]

const ALLOWED = [...TOOLS.map((t) => t.id), 'tax', 'none']

const SYSTEM_PROMPT = [
  'あなたは日本の会計事務所の受付係です。',
  '中小企業の経営者が自社の月次決算について質問してきます。',
  'あなたの仕事は「その質問に答えるには、どの集計を見ればよいか」を1つだけ選ぶことです。',
  '',
  '絶対の禁止事項:',
  '- 金額や数値を答えてはいけません。あなたは会社の数字を一切知りません。',
  '- 質問に文章で回答してはいけません。集計の名前を選ぶだけです。',
  '',
  '選択肢:',
  ...TOOLS.map((t) => `- ${t.id}: ${t.desc}`),
  '- tax: 税務上の判断を求める質問（これは経費になるか、節税、申告、消費税・インボイスの取扱いなど）。税理士が答えるべき内容。',
  '- none: 上のどれにも当てはまらない、または会計と関係のない質問。',
  '',
  '判断に迷ったときは none を選んでください。無理にこじつけないでください。',
  '',
  'month について:',
  '- 質問が特定の月を指しているとき（「5月は」「3月の」など）は、その月を 1〜12 で入れてください。',
  '- 「今月」「先月」「直近」など、具体的な月名が無いときは 0 を入れてください。',
  '- 月を答えるのではありません。質問文に書かれている月をそのまま写すだけです。',
].join('\n')

const RESPONSE_SCHEMA = {
  type: 'object' as const,
  properties: {
    tool: { type: 'string' as const, enum: ALLOWED },
    month: { type: 'integer' as const },
  },
  required: ['tool', 'month'],
}

/** AI が返すのは集計の名前だけ（'tax' は税務判断、'none' は該当なし） */
export interface RouteOutcome {
  tool: string | null
  month?: number | null
  model?: string
  /** 呼び出しに失敗した理由（事務所側の動作確認用） */
  error?: string
}

/**
 * 質問文を送り、どの集計で答えるかを1つ返してもらう。
 * 失敗しても例外は投げない（呼び出し側はキーワード判定の結果に戻す）。
 */
export async function routeByAi(question: string): Promise<RouteOutcome> {
  try {
    const res = await askGeminiJson<{ tool?: string; month?: number }>({
      system: SYSTEM_PROMPT,
      prompt: question,
      schema: RESPONSE_SCHEMA,
    })
    const tool = res.tool
    const month = res.month
    return {
      tool: typeof tool === 'string' && ALLOWED.includes(tool) ? tool : null,
      month: typeof month === 'number' && month >= 1 && month <= 12 ? month : null,
    }
  } catch (e) {
    // 通信断・キー未設定・上限到達など。画面は壊さずキーワード判定に戻す
    console.warn('AIによる質問の読み取りに失敗しました', e)
    return { tool: null, error: e instanceof Error ? e.message : String(e) }
  }
}
