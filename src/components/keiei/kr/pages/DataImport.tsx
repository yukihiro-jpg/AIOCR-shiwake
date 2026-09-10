'use client'

import { useRef, useState } from 'react';
import { getState, api } from '@/lib/keiei/kr/api';
import { parseImport, previewOf, approxStateBytes } from '@/lib/keiei/kr/import-json';
import type { ParsedImport } from '@/lib/keiei/kr/import-json';
import { useRerender } from '../ui';
import { sortedYears } from '@/lib/keiei/kr/analysis';

/**
 * データ取込:
 * 会計ソフトから書き出した月次推移JSON（keiei-monthly/1）を取り込む。
 * 取り込む前に内容（会社名・年度・月数）を確認してから反映する。
 * 同じ年度は新しい取込で置き換え、含まれない過去の年度は残す。
 */
export default function DataImport() {
  const rerender = useRerender();
  const state = getState();
  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<ParsedImport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [over, setOver] = useState(false);

  const handleFile = async (f: File | undefined) => {
    setError(null); setDone(null); setPending(null);
    if (!f) return;
    try {
      const text = await f.text();
      setPending(parseImport(text));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ファイルを読み込めませんでした。');
    }
  };

  const applyImport = () => {
    if (!pending) return;
    api.importData(pending);
    const bytes = approxStateBytes(getState());
    setPending(null);
    setDone(`取り込みました（${pending.years.length}年度分）。`
      + (bytes > 800_000 ? ' ※データ量が大きくなっています。古い年度の削除をご検討ください。' : ''));
    rerender();
  };

  const years = sortedYears(state);

  return (
    <div>
      <h2 className="page-title">データ取込</h2>
      <p className="page-sub">
        会計ソフトから書き出した月次推移のJSONファイル（形式: keiei-monthly/1）を取り込みます。
        月次の締めのたびに最新ファイルを取り込み直してください。同じ年度は新しい内容に置き換わり、
        ファイルに含まれない過去の年度はそのまま残ります。
      </p>

      <div className="card">
        <h3>ファイルを選択</h3>
        <div className={`kr-drop${over ? ' over' : ''}`}
          onClick={() => fileRef.current?.click()}
          onDragOver={e => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={e => {
            e.preventDefault(); setOver(false);
            void handleFile(e.dataTransfer.files?.[0]);
          }}>
          ここにJSONファイルをドラッグ＆ドロップ、またはクリックして選択
        </div>
        <input ref={fileRef} type="file" accept=".json,application/json" style={{ display: 'none' }}
          onChange={e => { void handleFile(e.target.files?.[0]); e.target.value = ''; }} />
        {error && <div className="warn-box">{error}</div>}
        {done && <div className="ok-box">{done}</div>}
      </div>

      {pending && (
        <div className="card">
          <h3>取込内容の確認</h3>
          <table className="grid" style={{ maxWidth: 640 }}>
            <tbody>
              <tr><td style={{ width: 140 }}>会社</td><td><b>{pending.client.name || '（名称なし）'}</b>（コード: {pending.client.code || '—'}）</td></tr>
              <tr><td>書き出し日時</td><td>{pending.generatedAt ? new Date(pending.generatedAt).toLocaleString('ja-JP') : '—'}</td></tr>
              {previewOf(pending).years.map(y => (
                <tr key={y.id}>
                  <td>{y.label}</td>
                  <td>{y.months}ヶ月分の実績・{y.rows}科目</td>
                </tr>
              ))}
            </tbody>
          </table>
          {state.client && pending.client.code && state.client.code !== pending.client.code && (
            <div className="warn-box">
              取込済みのデータ（{state.client.name}）と<b>別の会社</b>のファイルです。取り込むと会社情報が置き換わります。
            </div>
          )}
          <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
            <button onClick={applyImport}>この内容で取り込む</button>
            <button className="secondary" onClick={() => setPending(null)}>やめる</button>
          </div>
        </div>
      )}

      <div className="card">
        <h3>取込済みのデータ</h3>
        {!years.length ? (
          <div className="muted">まだデータがありません。</div>
        ) : (
          <>
            <div style={{ fontSize: 13.5, marginBottom: 8 }}>
              <b>{state.client?.name}</b>
              {state.uploadedAt && <span className="muted">　最終取込: {new Date(state.uploadedAt).toLocaleString('ja-JP')}</span>}
            </div>
            <table className="grid" style={{ maxWidth: 640 }}>
              <thead><tr><th>事業年度</th><th>実績月数</th><th className="num">科目数</th></tr></thead>
              <tbody>
                {years.map(y => (
                  <tr key={y.id}>
                    <td>{y.label}</td>
                    <td>{y.lastFilledIndex + 1}ヶ月{y.lastFilledIndex < 11 ? '（進行期）' : ''}</td>
                    <td className="num">{y.rows.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ marginTop: 12 }}>
              <button className="secondary small" style={{ color: '#b0331f' }}
                onClick={() => {
                  if (confirm('取り込んだ月次データと設定・メモをすべて削除します。よろしいですか？')) {
                    api.clearAll();
                    rerender();
                  }
                }}>すべてのデータを削除</button>
            </div>
          </>
        )}
      </div>

      <div className="card">
        <h3>設定</h3>
        <div className="row">
          <div style={{ minWidth: 220 }}>
            <label>実効税率（%）— 必要売上高の逆算などに使用</label>
            <input type="number" min={0} max={60} value={state.settings.taxRate} style={{ width: 120 }}
              onChange={e => { api.setTaxRate(Number(e.target.value)); rerender(); }} />
          </div>
          <div style={{ minWidth: 220 }}>
            <label>住民税の均等割（円/年）— 納税予測に使用</label>
            <input type="number" min={0} step={1000} value={state.settings.equalization} style={{ width: 140 }}
              onChange={e => { api.setEqualization(Number(e.target.value)); rerender(); }} />
          </div>
        </div>
      </div>
    </div>
  );
}
