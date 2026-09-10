'use client'

/**
 * 取引先の整理（税理士のみ）:
 * 摘要から自動でまとめた取引先を一覧し、まとめ方が違うところを直す。
 * ここで直した内容は自動判定より優先され、次回の取込でも引き継がれる。
 */
import { useMemo, useState } from 'react';
import { partnerSummary, partnerTotals } from '@/lib/keiei/kr/ledger/aggregate';
import { nameKey } from '@/lib/keiei/kr/ledger/normalize';
import type { AliasMap } from '@/lib/keiei/kr/ledger/normalize';
import { saveAliases, loadAliases } from '@/lib/keiei/kr/ledger/store';
import { api } from '@/lib/keiei/kr/api';
import { useLedger } from '@/lib/keiei/kr/ledger/useLedger';

const yen = (n: number) => Math.round(n).toLocaleString('ja-JP');

export default function Partners() {
  const clientId = api.clientId();
  const aliases = loadAliases();
  const { meta, ledger, kinds, loading, error, reload } = useLedger(clientId, aliases);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const rows = useMemo(
    () => (ledger ? partnerSummary(ledger, kinds) : []),
    [ledger, kinds],
  );
  const shown = useMemo(() => {
    const t = nameKey(q);
    if (!t) return rows.slice(0, 200);
    return rows.filter(r => nameKey(r.name).includes(t)
      || r.variants.some(v => nameKey(v.name).includes(t))).slice(0, 200);
  }, [rows, q]);

  if (loading) return <div className="card muted">読み込んでいます…</div>;
  if (error) return <div className="warn-box">{error}</div>;
  if (!meta || !ledger) {
    return (
      <div>
        <h2 className="page-title">取引先の整理<span className="kr-only-adviser">税理士のみ</span></h2>
        <div className="card muted">
          まだ元帳が取り込まれていません。「元帳の取込」からCSVを読み込んでください。
        </div>
      </div>
    );
  }

  const apply = async (next: AliasMap, message: string) => {
    setBusy(true);
    try {
      await saveAliases(clientId, next);
      setPicked(new Set());
      setMsg(message);
      reload();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /** 選んだ取引先を1つにまとめる。件数がいちばん多いものを残す。 */
  const mergePicked = () => {
    const ids = Array.from(picked);
    if (ids.length < 2) return;
    const target = rows.find(r => ids.includes(r.id))!;   // rows は金額順＝先頭が代表
    const next: AliasMap = {
      toGroup: { ...meta.aliases.toGroup },
      label: { ...meta.aliases.label },
    };
    for (const id of ids) {
      const g = rows.find(r => r.id === id);
      if (!g) continue;
      for (const v of g.variants) next.toGroup[nameKey(v.name)] = target.id;
    }
    next.label[target.id] = target.name;
    void apply(next, `${ids.length}件を「${target.name}」にまとめました。`);
  };

  /** 1つの表記だけを別の取引先として切り出す。 */
  const splitVariant = (variantName: string) => {
    const key = nameKey(variantName);
    const next: AliasMap = {
      toGroup: { ...meta.aliases.toGroup },
      label: { ...meta.aliases.label },
    };
    next.toGroup[key] = key;
    next.label[key] = variantName;
    void apply(next, `「${variantName}」を別の取引先にしました。`);
  };

  /** 表示名を変える。 */
  const rename = (id: string, current: string) => {
    const name = prompt('取引先の表示名', current);
    if (!name || name === current) return;
    const next: AliasMap = {
      toGroup: { ...meta.aliases.toGroup },
      label: { ...meta.aliases.label, [id]: name },
    };
    void apply(next, `表示名を「${name}」に変えました。`);
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-title">
            取引先の整理<span className="kr-only-adviser">税理士のみ</span>
          </h2>
          <p className="page-sub">
            摘要から自動でまとめた取引先です（{ledger.groups.length}先）。
            まとめ方が違うところは、ここで直せます。直した内容は次回の取込にも引き継がれます。
          </p>
        </div>
      </div>

      {msg && <div className="card" style={{ background: '#eaf7ee' }}>{msg}</div>}

      <div className="card">
        <div className="kr-ptools">
          <input value={q} placeholder="取引先を探す" onChange={e => setQ(e.target.value)} />
          <button disabled={picked.size < 2 || busy} onClick={mergePicked}>
            選んだ{picked.size > 0 ? `${picked.size}件` : ''}を1つにまとめる
          </button>
          {picked.size > 0 && (
            <button className="secondary" onClick={() => setPicked(new Set())}>選択を解除</button>
          )}
        </div>

        <table className="grid">
          <thead>
            <tr>
              <th style={{ width: 36 }}></th>
              <th>取引先</th>
              <th style={{ width: 130 }} className="num">支払・仕入</th>
              <th style={{ width: 130 }} className="num">売上・入金</th>
              <th style={{ width: 70 }} className="center">件数</th>
              <th style={{ width: 90 }}></th>
            </tr>
          </thead>
          <tbody>
            {shown.map(r => (
              <>
                <tr key={r.id}>
                  <td className="center">
                    <input type="checkbox" checked={picked.has(r.id)}
                      onChange={e => {
                        const s = new Set(picked);
                        if (e.target.checked) s.add(r.id); else s.delete(r.id);
                        setPicked(s);
                      }} />
                  </td>
                  <td>
                    <button type="button" className="kr-linkbtn"
                      onClick={() => setOpen(open === r.id ? null : r.id)}>
                      {r.name}
                    </button>
                    {r.variants.length > 1 && (
                      <span className="note" style={{ marginLeft: 8 }}>
                        {r.variants.length}通りの書き方
                      </span>
                    )}
                  </td>
                  <td className="num">{r.expense ? `${yen(r.expense)}円` : '—'}</td>
                  <td className="num">{r.revenue ? `${yen(r.revenue)}円` : '—'}</td>
                  <td className="center">{r.count}</td>
                  <td>
                    <button type="button" className="kr-linkbtn"
                      disabled={busy} onClick={() => rename(r.id, r.name)}>名前を変える</button>
                  </td>
                </tr>
                {open === r.id && (
                  <tr key={`${r.id}-d`}>
                    <td></td>
                    <td colSpan={5}>
                      <Detail
                        variants={r.variants}
                        onSplit={splitVariant}
                        busy={busy}
                        accounts={partnerTotals(ledger, kinds, r.id).byAccount}
                      />
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
        {rows.length > shown.length && (
          <div className="muted" style={{ marginTop: 8 }}>
            {rows.length}先のうち上位{shown.length}先を表示しています。検索で絞り込んでください。
          </div>
        )}
      </div>
    </div>
  );
}

function Detail({ variants, onSplit, busy, accounts }: {
  variants: { name: string; count: number }[];
  onSplit: (name: string) => void;
  busy: boolean;
  accounts: { name: string; amount: number; count: number }[];
}) {
  return (
    <div className="kr-pdetail">
      <div>
        <div className="muted">まとめている摘要の書き方</div>
        <ul>
          {variants.map(v => (
            <li key={v.name}>
              {v.name}<span className="note">（{v.count}件）</span>
              {variants.length > 1 && (
                <button type="button" className="kr-linkbtn" disabled={busy}
                  style={{ marginLeft: 8 }}
                  onClick={() => onSplit(v.name)}>別の取引先にする</button>
              )}
            </li>
          ))}
        </ul>
      </div>
      <div>
        <div className="muted">科目の内訳</div>
        <ul>
          {accounts.slice(0, 8).map(a => (
            <li key={a.name}>{a.name}<span className="note">（{yen(a.amount)}円・{a.count}件）</span></li>
          ))}
          {accounts.length === 0 && <li className="muted">—</li>}
        </ul>
      </div>
    </div>
  );
}
