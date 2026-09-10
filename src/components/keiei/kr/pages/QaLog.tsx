'use client'

/**
 * AI質問ログ（税理士のみ）:
 * 顧問先がどんなことを気にしているかを一覧する画面。
 * 月次報告の前に開くと、先回りして準備できる。
 */
import { getState, api } from '@/lib/keiei/kr/api';
import { useRerender } from '../ui';

function fmt(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function QaLog() {
  const state = getState();
  const rerender = useRerender();
  const log = state.settings.qaLog;
  const month = new Date().toISOString().slice(0, 7);
  const thisMonth = log.filter(e => e.at.slice(0, 7) === month);
  const declined = thisMonth.filter(e => e.declined).length;
  const starred = log.filter(e => e.starred);
  // 定型のキーワードでは読み取れず、AI に読み取ってもらった件数（＝AI の利用回数）
  const viaAi = thisMonth.filter(e => e.viaAi).length;

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-title">
            AI質問ログ<span className="kr-only-adviser">税理士のみ</span>
          </h2>
          <p className="page-sub">
            顧問先がどんなことを気にしているかが分かります。面談前の準備にお使いください。
            この画面は顧問先には表示されません。
          </p>
        </div>
        {log.length > 0 && (
          <button className="secondary" onClick={() => {
            if (confirm(`質問の記録 ${log.length}件 をすべて削除します。よろしいですか？`)) {
              api.clearQaLog(); rerender();
            }
          }}>記録を削除</button>
        )}
      </div>

      <div className="card kr-logstat">
        <div><div className="muted">今月の質問数</div><div className="val">{thisMonth.length}回</div></div>
        <div><div className="muted">うちAIが読み取り</div><div className="val">{viaAi}回</div></div>
        <div><div className="muted">面談で触れる（★）</div><div className="val">{starred.length}件</div></div>
        <div><div className="muted">答えなかった質問</div><div className="val">{declined}件</div></div>
      </div>

      {log.length === 0 ? (
        <div className="card muted">まだ質問の記録がありません。</div>
      ) : (
        <div className="card table-scroll">
          <h3>質問の記録<small>新しい順・直近200件</small></h3>
          <table className="grid">
            <thead>
              <tr>
                <th style={{ width: 90 }}>日時</th>
                <th style={{ width: 260 }}>質問</th>
                <th>回答</th>
                <th style={{ width: 60 }} className="center">★</th>
              </tr>
            </thead>
            <tbody>
              {log.map(e => (
                <tr key={e.id} className={e.declined ? 'kr-declined' : undefined}>
                  <td className="muted">{fmt(e.at)}</td>
                  <td>
                    {e.question}
                    {e.declined && <span className="kr-declined-tag">税務判断のため回答せず</span>}
                    {!e.declined && e.tool === null && <span className="kr-unknown-tag">読み取れず</span>}
                    {!e.declined && e.viaAi && <span className="kr-ai-tag">AIが読み取り</span>}
                  </td>
                  <td className="note">{e.answer}</td>
                  <td className="center">
                    <button type="button" className="kr-star"
                      title={e.starred ? '面談メモから外す' : '面談で触れる印を付ける'}
                      onClick={() => { api.toggleQaStar(e.id); rerender(); }}>
                      {e.starred ? '★' : '☆'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {starred.length > 0 && (
        <div className="card">
          <h3>次回の面談メモ<small>★を付けた質問</small></h3>
          <ul className="kr-insights">
            {starred.map(e => (
              <li key={e.id}><span className="dot warn" />{e.question}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
