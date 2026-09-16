'use client'

/**
 * 取引先の整理（税理士のみ）:
 * 摘要から自動でまとめた取引先を確認・修正する画面。
 *
 * 【全部は見せない】
 * 取引先は数百〜数千になるので、一覧を全部見るのは現実的でない。
 * まとまった理由で3つに分け、**誤りが出うるものだけ**を開いた状態で出す。
 *   ★要確認 … あいまい一致（1文字違い等）でまとまった。「お茶代」と「お花代」のような
 *              別物の取り違えは、この経路からしか出ない
 *   ほぼ安全 … 前方一致だけでまとまった（「社会保険」⊂「社会保険料」）
 *   単独     … 表記が1通りだけ。確認するものが無い
 *
 * 【一度見たものは戻ってこない】
 * 「このまとまりでOK」を押すと、そのときの表記の組み合わせを指紋にして残す。
 * 次の取込で表記が増えたときだけ★へ戻るので、毎月ぜんぶ見直さなくてよい。
 *
 * 並びは件数ではなく**金額の大きい順**。1,000円の誤りより100万円の誤りを先に見せる。
 */
import { useMemo, useState } from 'react';
import { partnerSummary, partnerTotals, variantAmounts } from '@/lib/keiei/kr/ledger/aggregate';
import { nameKey, needsReview, groupSignature } from '@/lib/keiei/kr/ledger/normalize';
import type { AliasMap, PartnerGroup } from '@/lib/keiei/kr/ledger/normalize';
import { saveAliases, loadAliases } from '@/lib/keiei/kr/ledger/store';
import { api } from '@/lib/keiei/kr/api';
import { useLedger } from '@/lib/keiei/kr/ledger/useLedger';

const yen = (n: number) => Math.round(n).toLocaleString('ja-JP');

type Row = PartnerGroup & { expense: number; revenue: number };
type Bucket = 'review' | 'safe' | 'single';

export default function Partners() {
  const clientId = api.clientId();
  const aliases = loadAliases();
  const { meta, ledger, kinds, loading, error, reload } = useLedger(clientId, aliases);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [show, setShow] = useState<Record<Bucket, boolean>>({ review: true, safe: false, single: false });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const rows = useMemo(
    () => (ledger ? partnerSummary(ledger, kinds) : []),
    [ledger, kinds],
  );
  // 表記ごとの金額（全明細を1回走査して作る）
  const vAmt = useMemo(
    () => (ledger ? variantAmounts(ledger, kinds) : new Map<string, { amount: number; count: number }>()),
    [ledger, kinds],
  );

  const al = meta?.aliases;
  /** グループを3つに仕分ける。 */
  const bucketOf = (r: Row): Bucket => {
    if (r.variants.length <= 1) return 'single';
    return al && needsReview(r, al) ? 'review' : 'safe';
  };

  const buckets = useMemo(() => {
    const t = nameKey(q);
    const hit = (r: Row) => !t || nameKey(r.name).includes(t) || r.variants.some(v => nameKey(v.name).includes(t));
    const out: Record<Bucket, Row[]> = { review: [], safe: [], single: [] };
    for (const r of rows) if (hit(r)) out[bucketOf(r)].push(r);
    // 金額の大きい順（支払と売上の合計）
    for (const k of ['review', 'safe', 'single'] as Bucket[]) {
      out[k].sort((a, b) => (b.expense + b.revenue) - (a.expense + a.revenue));
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, q, al]);

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

  const base = (): AliasMap => ({
    toGroup: { ...meta.aliases.toGroup },
    label: { ...meta.aliases.label },
    reviewed: { ...(meta.aliases.reviewed || {}) },
  });

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

  /** 選んだ取引先を1つにまとめる。金額がいちばん大きいものを残す。 */
  const mergePicked = () => {
    const ids = Array.from(picked);
    if (ids.length < 2) return;
    const target = rows.find(r => ids.includes(r.id));
    if (!target) return;
    const next = base();
    for (const id of ids) {
      const g = rows.find(r => r.id === id);
      if (!g) continue;
      for (const v of g.variants) next.toGroup[nameKey(v.name)] = target.id;
      delete next.reviewed![id];
    }
    next.label[target.id] = target.name;
    void apply(next, `${ids.length}件を「${target.name}」にまとめました。`);
  };

  /** 1つの表記だけを別の取引先として切り出す。 */
  const splitVariant = (group: Row, variantName: string) => {
    const key = nameKey(variantName);
    const next = base();
    next.toGroup[key] = key;
    next.label[key] = variantName;
    // まとまりの中身が変わるので、確認済みはいったん外す
    delete next.reviewed![group.id];
    void apply(next, `「${variantName}」を別の取引先にしました。`);
  };

  /** このまとまりで良い、と記録する（次からは★に出ない）。 */
  const markReviewed = (r: Row) => {
    const next = base();
    next.reviewed![r.id] = groupSignature(r);
    void apply(next, `「${r.name}」を確認済みにしました。`);
  };

  /** まとめて確認済みにする。 */
  const markAllReviewed = () => {
    const next = base();
    for (const r of buckets.review) next.reviewed![r.id] = groupSignature(r);
    void apply(next, `${buckets.review.length}件を確認済みにしました。`);
  };

  /** 表示名を変える。 */
  const rename = (id: string, current: string) => {
    const name = prompt('取引先の表示名', current);
    if (!name || name === current) return;
    const next = base();
    next.label[id] = name;
    void apply(next, `表示名を「${name}」に変えました。`);
  };

  const toggle = (b: Bucket) => setShow(s => ({ ...s, [b]: !s[b] }));

  const section = (b: Bucket, title: string, note: string) => {
    const list = buckets[b];
    const opened = show[b];
    return (
      <div className="card" key={b}>
        <button type="button" className={`kr-bucket${b === 'review' && list.length ? ' hot' : ''}`}
          onClick={() => toggle(b)}>
          <span className="kr-bucket-arrow">{opened ? '▼' : '▶'}</span>
          <b>{title}</b>
          <span className="kr-bucket-n">{list.length}件</span>
          <span className="kr-bucket-note">{note}</span>
        </button>
        {opened && (
          list.length === 0
            ? <div className="muted" style={{ padding: '4px 2px' }}>該当はありません。</div>
            : (
              <>
                {b === 'review' && list.length > 1 && (
                  <div className="kr-ptools" style={{ marginTop: 6 }}>
                    <button className="secondary" disabled={busy} onClick={markAllReviewed}>
                      ぜんぶ確認済みにする（{list.length}件）
                    </button>
                  </div>
                )}
                <div className="kr-pcards">
                  {list.slice(0, 200).map(r => (
                    <PartnerCard key={r.id} r={r} bucket={b} busy={busy}
                      amountOf={(name: string) => vAmt.get(nameKey(name))}
                      picked={picked.has(r.id)}
                      onPick={(on) => {
                        const s = new Set(picked);
                        if (on) s.add(r.id); else s.delete(r.id);
                        setPicked(s);
                      }}
                      onSplit={(name) => splitVariant(r, name)}
                      onReviewed={() => markReviewed(r)}
                      onRename={() => rename(r.id, r.name)}
                      openDetail={open === r.id}
                      onToggleDetail={() => setOpen(open === r.id ? null : r.id)}
                      accounts={open === r.id ? partnerTotals(ledger, kinds, r.id).byAccount : []}
                    />
                  ))}
                </div>
                {list.length > 200 && (
                  <div className="muted" style={{ marginTop: 8 }}>
                    {list.length}件のうち上位200件を表示しています。検索で絞り込んでください。
                  </div>
                )}
              </>
            )
        )}
      </div>
    );
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
            <b>確認が要るのは「★要確認」だけ</b>です。別物がまとまっていたら、その書き方を
            「これは別」で外してください。直した内容は次回の取込にも引き継がれます。
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
      </div>

      {section('review', '★ 要確認', '似ている書き方どうしがまとまったもの。別物が混ざるのはここだけです')}
      {section('safe', 'ほぼ安全', '一方がもう一方の先頭に含まれるもの（「社会保険」と「社会保険料」など）')}
      {section('single', '書き方が1通りだけ', 'まとめていないので確認するものはありません')}
    </div>
  );
}

function PartnerCard({
  r, bucket, busy, amountOf, picked, onPick, onSplit, onReviewed, onRename,
  openDetail, onToggleDetail, accounts,
}: {
  r: Row;
  bucket: Bucket;
  busy: boolean;
  amountOf: (name: string) => { amount: number; count: number } | undefined;
  picked: boolean;
  onPick: (on: boolean) => void;
  onSplit: (name: string) => void;
  onReviewed: () => void;
  onRename: () => void;
  openDetail: boolean;
  onToggleDetail: () => void;
  accounts: { name: string; amount: number; count: number }[];
}) {
  const total = r.expense + r.revenue;
  return (
    <div className={`kr-pcard${bucket === 'review' ? ' hot' : ''}`}>
      <div className="kr-pcard-head">
        <input type="checkbox" checked={picked} onChange={e => onPick(e.target.checked)}
          title="ほかの取引先と1つにまとめるときに選びます" />
        <button type="button" className="kr-linkbtn kr-pcard-name" onClick={onToggleDetail}>
          {r.name}
        </button>
        <span className="kr-pcard-amt">{yen(total)}円</span>
        <span className="kr-pcard-cnt">{r.count}件</span>
        <span className="tb-grow" />
        <button type="button" className="kr-linkbtn" disabled={busy} onClick={onRename}>名前を変える</button>
        {bucket === 'review' && (
          <button type="button" disabled={busy} onClick={onReviewed}
            title="このまとまりで正しい、と記録します。次の取込で書き方が増えるまで★には出ません">
            このまとまりでOK
          </button>
        )}
      </div>

      {r.variants.length > 1 && (
        <ul className="kr-pvars">
          {r.variants.map(v => {
            const a = amountOf(v.name);
            return (
              <li key={v.name} className={v.via === 'fuzzy' ? 'sus' : undefined}>
                <span className="kr-pvar-name">{v.name}</span>
                <span className="kr-pvar-amt">{a ? `${yen(a.amount)}円` : '—'}</span>
                <span className="kr-pvar-cnt">{v.count}件</span>
                {v.via === 'fuzzy' && <span className="kr-pvar-tag">似ているのでまとめた</span>}
                {v.via === 'alias' && <span className="kr-pvar-tag alias">手動で指定</span>}
                <button type="button" className="kr-linkbtn" disabled={busy}
                  onClick={() => onSplit(v.name)}>これは別</button>
              </li>
            );
          })}
        </ul>
      )}

      {openDetail && (
        <div className="kr-pdetail">
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
      )}
    </div>
  );
}
