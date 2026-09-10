'use client'

/**
 * AIに質問（顧問先モードの中心画面）:
 * 顧問先が自分の会計データについて質問し、その場で答えを得る画面。
 *
 * 金額は必ず qa/answers.ts（＝analysis.ts の計算）で確定させ、
 * 文章もそこで組み立てる。画面は表示と記録だけを行う。
 * 税務判断の質問には答えず、担当者へ誘導する。
 *
 * 質問の読み取りは2段構え。
 *   1) キーワード判定（qa/answers.ts の matchPreset）… 費用ゼロ・即答
 *   2) 1で分からなければ AI に読み取ってもらう（qa/askAi.ts）
 * AI が読み取るのは「どの集計を見るか」だけで、金額はどちらの場合も
 * このブラウザの中で計算する。AI に数字は送らない。
 */
import { useState } from 'react';
import { getState, api } from '@/lib/keiei/kr/api';
import { yen } from '@/lib/keiei/kr/analysis';
import { NeedData, useRerender } from '../ui';
import {
  PRESETS, PRESET_CHIPS, matchPreset, isTaxQuestion, latestYear, readContext,
} from '@/lib/keiei/kr/qa/answers';
import type { Answer, Evidence, AskContext } from '@/lib/keiei/kr/qa/answers';
import { routeByAi } from '@/lib/keiei/kr/ask-ai';
import { useLedger } from '@/lib/keiei/kr/ledger/useLedger';

/** 画面に出す1往復 */
interface Turn {
  id: number;
  question: string;
  answer: Answer | null;
  declined: boolean;
  /** AI に読み取ってもらっている最中 */
  pending?: boolean;
  /** AI が質問を読み取った（キーワード判定ではない） */
  viaAi?: boolean;
  /**
   * 税理士（管理者）にだけ見せる動作確認用のメモ。
   * どのモデルが判定したか、失敗したなら何が起きたか。
   * 顧問先には表示しないし、質問ログにも残さない。
   */
  adminNote?: string;
}

/** 1日あたりの質問回数の上限（費用の暴走を防ぐ） */
const DAILY_LIMIT = 30;

export default function Ask({ canAsk = true, onNavigate }: {
  canAsk?: boolean
  /** 画面移動（移植元は react-router。ここはタブ切替なので親から受け取る） */
  onNavigate?: (to: string) => void
}) {
  const state = getState();
  const rerender = useRerender();
  const navigate = (to: string) => onNavigate?.(to);
  // 移植先は事務所内で使う画面なので、税理士向けの補足は常に出す
  const isAdmin = true;
  // 元帳（取り込まれていれば取引先の質問にも答えられる）
  const { ledger, kinds } = useLedger(api.clientId());
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [seq, setSeq] = useState(1);
  const [busy, setBusy] = useState(false);

  const y = latestYear(state);
  if (!y) {
    return (
      <div>
        <h2 className="page-title">AIに質問</h2>
        <NeedData />
      </div>
    );
  }

  // 今日すでに質問した回数（記録から数える）
  const today = new Date().toISOString().slice(0, 10);
  const usedToday = state.settings.qaLog.filter(e => e.at.slice(0, 10) === today).length;
  const remaining = Math.max(0, DAILY_LIMIT - usedToday);

  /** 既に画面に出ている1往復を、答えが決まった状態に差し替える。 */
  const settle = (id: number, patch: Partial<Turn>) => {
    setTurns(t => t.map(x => (x.id === id ? { ...x, ...patch, pending: false } : x)));
  };

  /** 税務判断として回答を断る。 */
  const decline = (id: number, q: string, exists: boolean) => {
    const turn: Turn = { id, question: q, answer: null, declined: true };
    if (exists) settle(id, turn);
    else setTurns(t => [...t, turn]);
    api.addQaLog({ question: q, answer: '（税務判断のため回答せず）', tool: null, declined: true });
    rerender();
  };

  /** 集計を実行して答えを出す。 */
  const answerWith = (id: number, q: string, preset: typeof PRESETS[number],
    viaAi: boolean, exists: boolean, ctx?: AskContext, model?: string) => {
    const a = preset.run(state, y, ctx);
    const where = preset.id
      + (ctx?.partner ? `（${ctx.partner.name}）` : '')
      + (ctx?.account ? `（${ctx.account.label}）` : '')
      + (ctx?.period ? `（${ctx.period.label}）` : '')
      + (ctx?.month ? `（${ctx.month}月）` : '');
    const turn: Turn = {
      id, question: q, answer: a, declined: false, viaAi,
      adminNote: isAdmin && viaAi ? `判定モデル: ${model || '不明'} → ${where}` : undefined,
    };
    if (exists) settle(id, turn);
    else setTurns(t => [...t, turn]);
    api.addQaLog({ question: q, answer: a.text, tool: a.tool, declined: false, viaAi });
    rerender();
  };

  /** どの集計にも当たらなかったとき。 */
  const giveUp = (id: number, q: string, exists: boolean, error?: string) => {
    const a: Answer = {
      tool: 'unknown',
      text: 'ご質問の内容をうまく読み取れませんでした。'
        + '下のボタンからお選びいただくか、「売上」「経費」「現金」などの言葉を入れて聞き直してください。',
    };
    const turn: Turn = {
      id, question: q, answer: a, declined: false,
      // 顧問先には理由を出さない。税理士が開いたときだけ原因を見せる。
      adminNote: isAdmin && error ? `AIの呼び出しに失敗しました: ${error}` : undefined,
    };
    if (exists) settle(id, turn);
    else setTurns(t => [...t, turn]);
    api.addQaLog({ question: q, answer: a.text, tool: null, declined: false });
    rerender();
  };

  const ask = async (question: string) => {
    const q = question.trim();
    if (!q || remaining <= 0 || busy) return;
    setInput('');
    const id = seq;
    setSeq(id + 1);

    // 税務判断は答えない（AI に送る前に、ここで止める）
    if (isTaxQuestion(q)) { decline(id, q, false); return; }

    // 月・期間・科目・何期前かは、質問文から直接読み取る（AI の解釈に頼らない）
    const ctx = readContext(q, y, ledger, kinds);

    // まずキーワードで判定する（費用ゼロ・待ち時間ゼロ）
    const preset = matchPreset(q, y, ledger);
    if (preset) {
      answerWith(id, q, preset, false, false, ctx);
      return;
    }

    // 読み取れなかったものだけ AI に頼る。送るのは質問の文章だけ。
    setTurns(t => [...t, { id, question: q, answer: null, declined: false, pending: true }]);
    setBusy(true);
    try {
      const res = await routeByAi(q);
      if (res.tool === 'tax') { decline(id, q, true); return; }
      const byAi = res.tool ? PRESETS.find(p => p.id === res.tool) : undefined;
      // 月は質問文から読み取ったものを優先し、無ければAIが読み取ったものを使う
      // （「先月は？」のように数字で書かれていない場合はAI側が拾う）
      if (byAi) {
        answerWith(id, q, byAi, true, true,
          { ...ctx, month: ctx.month ?? res.month ?? null }, res.model);
      } else giveUp(id, q, true, res.error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-title">AIに質問</h2>
          <p className="page-sub">
            御社の会計データにもとづいてお答えします。下のボタンを押すか、自由に入力してください。
            金額は会計データから計算しています。
          </p>
        </div>
      </div>

      <div className="kr-chips">
        {PRESET_CHIPS.map(p => (
          <button key={p.id} type="button" className="kr-chip"
            disabled={!canAsk || remaining <= 0 || busy}
            onClick={() => void ask(p.label)}>{p.label}</button>
        ))}
      </div>

      <div className="kr-askbar">
        <input value={input} placeholder="例）今期の売上が一番高かった月は？"
          maxLength={200} disabled={!canAsk || remaining <= 0 || busy}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void ask(input); }} />
        <button type="button" disabled={!canAsk || !input.trim() || remaining <= 0 || busy}
          onClick={() => void ask(input)}>{busy ? '確認中…' : '質問する'}</button>
      </div>
      <div className="kr-quota">
        {remaining > 0
          ? `今日はあと ${remaining} 回ご質問いただけます（1日${DAILY_LIMIT}回まで）`
          : `今日の質問回数の上限（${DAILY_LIMIT}回）に達しました。明日またご利用ください。`}
      </div>

      {turns.length === 0 && (
        <div className="card">
          <h3>使い方<small>はじめての方へ</small></h3>
          <div className="muted">
            上のボタンを押すと、その場で御社の数字をお答えします。文章で聞いていただいてもかまいません。<br />
            ボタンに無い聞き方をされた場合は、AIがご質問の意図を読み取ってお答えします。<br />
            回答には必ず「根拠」を付けています。数字がどこから来ているかを確認できます。<br />
            なお、<b>税務の判断（経費になるか等）にはお答えできません</b>。担当者にご相談ください。
          </div>
        </div>
      )}

      {turns.map(t => (
        <div className="kr-qa" key={t.id}>
          <div className="kr-q"><span>{t.question}</span></div>
          <div className="kr-a">
            <div className="kr-ahead">
              <span className="kr-adot">AI</span>回答
              {t.viaAi && <span className="kr-aivia">AIがご質問を読み取りました</span>}
            </div>
            {t.pending ? (
              <p className="kr-atext muted">ご質問の内容を確認しています…</p>
            ) : t.declined ? (
              <>
                <div className="warn-box">
                  <b>この質問にはお答えできません。</b><br />
                  税務上の取り扱い（経費になるか、いつ計上するか等）は、契約内容や実態を確認したうえでの
                  判断が必要です。担当の税理士にご確認ください。
                </div>
                <div className="kr-abtns">
                  <button type="button" className="secondary"
                    onClick={() => navigate('/pl')}>月次推移で金額を確認する</button>
                </div>
                <div className="kr-disc">※ 税務判断・節税に関するご質問には回答しない設定になっています。</div>
              </>
            ) : t.answer && (
              <>
                <p className="kr-atext">{t.answer.text}</p>
                {t.answer.evidence && <EvidenceView ev={t.answer.evidence} />}
                {t.answer.link && (
                  <div className="kr-abtns">
                    <button type="button" className="secondary"
                      onClick={() => navigate(t.answer!.link!.to)}>→ {t.answer.link.label}</button>
                  </div>
                )}
                <div className="kr-disc">
                  ※ 金額は御社の会計データから計算しています。税務上の判断は担当者にご確認ください。
                </div>
              </>
            )}
            {t.adminNote && (
              <div className="kr-adminnote">
                <span className="kr-only-adviser">税理士のみ</span>{t.adminNote}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/** 回答の根拠（棒グラフ or 表）。 */
function EvidenceView({ ev }: { ev: Evidence }) {
  if (ev.kind === 'table') {
    return (
      <div className="kr-evi">
        <div className="kr-evihead">🧮 {ev.title}</div>
        <table className="grid kr-evitable">
          <tbody>
            {ev.rows.map(r => (
              <tr key={r.label}>
                <td>{r.label}</td>
                <td className="num val">{r.value}</td>
                <td className="note">{r.note ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  // 棒グラフ（実績のある月だけ描く。最大値の月を色分けする）
  const vals = ev.values.map(v => (v === null ? null : v));
  const max = Math.max(1, ...vals.map(v => (v === null ? 0 : Math.abs(v))));
  return (
    <div className="kr-evi">
      <div className="kr-evihead">📊 {ev.title}</div>
      <div className="kr-evibars">
        {vals.map((v, i) => (
          <div className="kr-evibar" key={i}>
            <div className="kr-evibar-v">{v === null ? '' : `${Math.round(v / 10000).toLocaleString('ja-JP')}`}</div>
            <div className="kr-evibar-track">
              <div className={`kr-evibar-fill${i === ev.highlight ? ' hot' : ''}${v !== null && v < 0 ? ' minus' : ''}`}
                style={{ height: v === null ? 0 : `${(Math.abs(v) / max) * 100}%` }}
                title={v === null ? '未確定' : `${yen(v)}円`} />
            </div>
            <div className={`kr-evibar-l${i === ev.highlight ? ' hot' : ''}`}>{ev.labels[i]}</div>
          </div>
        ))}
      </div>
      <div className="muted" style={{ marginTop: 4 }}>単位: 万円（棒にカーソルを合わせると円単位で出ます）</div>
    </div>
  );
}
