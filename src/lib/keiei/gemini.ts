// 月次レポートの解説文（テンプレ生成）を Gemini で仕上げる。
// 相続レポートの「AI仕上げ」と同思想。キーはスイート共通（または未設定ならエラー）。
// 【厳守】数値・事実は変えず、日本語の読みやすさ・つながりだけを整える。

import { GoogleGenerativeAI } from '@google/generative-ai'

const SUITE_GEMINI_API_KEY_STORAGE = 'suite-gemini-api-key'
const DEFAULT_MODEL = 'gemini-2.5-flash'

function getApiKey(): string {
  if (typeof window === 'undefined') throw new Error('ブラウザ以外では利用できません')
  const suite = (localStorage.getItem(SUITE_GEMINI_API_KEY_STORAGE) || '').trim()
  if (!suite) {
    throw new Error('Gemini APIキーが未設定です。ホーム画面の「共通設定」からGeminiキーを登録してください。')
  }
  return suite
}

/**
 * テンプレ生成した経営サマリー文を、数値を変えずに読みやすく仕上げる。
 * マーカー（# 見出し、【…】小見出し、**強調**）の書式はそのまま維持させる。
 */
export async function polishSummaryStory(raw: string): Promise<string> {
  const genAI = new GoogleGenerativeAI(getApiKey())
  // 通信ハングで「仕上げ中…」が永遠に終わらないのを防ぐ（120秒で自動中断）
  const model = genAI.getGenerativeModel({ model: DEFAULT_MODEL }, { timeout: 120000 })
  const prompt = [
    'あなたは中小企業の社長に月次決算を分かりやすく説明する、財務・資金に精通した税理士です。',
    '以下は自動生成した「今月の経営サマリー」の草案です。社長が読むだけで経営状況が腹落ちするよう、',
    '日本語の言い回しと文のつながりだけを自然に整えてください。',
    '',
    '【厳守事項】',
    '・金額・比率・月・シナリオなどの数値と事実は一切変えない（新しい数値を作らない・省かない）。',
    '・書式マーカーはそのまま維持する：先頭の「# 見出し」、各段落の「【小見出し】」、強調の「**…**」。',
    '・段落構成（【】の数と順序）は変えない。各段落の主旨も変えない。',
    '・「税理士にご相談ください」等の丸投げ表現は使わない（読者自身が税理士事務所の顧問先という前提）。',
    '・専門用語には必要に応じてやさしい補足を添えるが、冗長にしない。',
    '・出力は仕上げ後の本文のみ（前置き・後書き・コードブロックは付けない）。',
    '',
    '--- 草案ここから ---',
    raw,
    '--- 草案ここまで ---',
  ].join('\n')
  const res = await model.generateContent(prompt)
  const text = res.response.text().trim()
  return text || raw
}

/**
 * 経営課題レポートの総括文（テンプレ生成）をAIで仕上げる。
 * ハイブリッド方式：課題の検出・数値はすべて issues.ts の確定ロジックが行い、
 * ここでは文章の言い回し・つながりだけを整える（数値は一切変えさせない）。
 */
export async function polishIssuesStory(raw: string): Promise<string> {
  const genAI = new GoogleGenerativeAI(getApiKey())
  // 通信ハングで「仕上げ中…」が終わらないのを防ぐ（120秒で自動中断）
  const model = genAI.getGenerativeModel({ model: DEFAULT_MODEL }, { timeout: 120000 })
  const prompt = [
    'あなたは中小企業の社長に経営課題を分かりやすく伝える、財務・資金に精通した税理士です。',
    '以下は自動検出した「経営課題の総括」の草案です。社長が読んで優先順位と打ち手が腹落ちするよう、',
    '日本語の言い回しと文のつながりだけを自然に整えてください。',
    '',
    '【厳守事項】',
    '・金額・比率・件数・年数などの数値と事実は一切変えない（新しい数値を作らない・省かない）。',
    '・課題の追加・削除・順序の入れ替えはしない（検出ロジックの判断を尊重する）。',
    '・書式マーカーはそのまま維持する：先頭の「# 見出し」、各段落の「【小見出し】」、強調の「**…**」、番号付き箇条書き。',
    '・「税理士にご相談ください」等の丸投げ表現は使わない（読者自身が税理士事務所の顧問先という前提）。',
    '・脅すような表現は避けつつ、深刻な課題の重みは薄めない。',
    '・出力は仕上げ後の本文のみ（前置き・後書き・コードブロックは付けない）。',
    '',
    '--- 草案ここから ---',
    raw,
    '--- 草案ここまで ---',
  ].join('\n')
  const res = await model.generateContent(prompt)
  const text = res.response.text().trim()
  return text || raw
}
