// 摘要から取引先を取り出し、表記のゆれをまとめる（名寄せ）。
//
// 元帳CSVには取引先の専用列が無く、取引先は摘要に混ざって入っている。
//   「鯉渕郵便局(切手)」「モノタロウ 境工事部材」「SOU社会保険労務士法人　」
// そのまま集計すると同じ会社が別々に数えられてしまうため、
//   1) 摘要から取引先らしい部分を取り出し（partnerFromNote）
//   2) 比較用のキーに直し（nameKey。半角/全角・空白・記号・法人格を無視）
//   3) キーが同じ・前方一致・よく似ているものをまとめる（clusterPartners）
// という順で処理する。
//
// 自動でまとめきれないもの・まとめすぎたものは、税理士が画面から
// 直せるようにする（手動の指定が常に自動判定より優先される）。

/** 法人格（比較のときは無視する）。「株式会社マルミ」＝「マルミ」 */
const CORP = /(株式会社|有限会社|合同会社|合資会社|合名会社|一般社団法人|一般財団法人|公益社団法人|公益財団法人|医療法人社団|医療法人|税理士法人|司法書士法人|社会保険労務士法人|行政書士法人|弁護士法人|農業協同組合|生活協同組合|\(株\)|\(有\)|㈱|㈲|K\.K\.)/g;

/** 比較のときに落とす記号・空白。「キクチ・エステート」＝「キクチエステート」 */
const NOISE = /[\s　・･,，.。、／/\\|｜\-‐‑–—ー－_＿"'`^~＝=+＋*＊:：;；!！?？#＃$＄%％&＆@＠()（）[\]［］{}｛｝<>＜＞【】〔〕「」『』]/g;

/**
 * 文字幅・大小をそろえる。
 * NFKC で 全角英数→半角・半角カナ→全角カナ が一度に片づく。
 */
function unify(s: string): string {
  return s.normalize('NFKC').toLowerCase();
}

/**
 * 摘要から取引先らしい部分を取り出す。
 * - 括弧の中は品目の説明なので落とす（「山新友部店(カットクロス)」→「山新友部店」）
 * - 全角スペースの連続は区切りとして使われることが多いので、そこで切る
 * - 何も残らなければ摘要そのものを返す（後で税理士が直せる）
 */
export function partnerFromNote(note: string): string {
  let t = String(note ?? '').replace(/　/g, ' ');
  // 括弧より前
  const br = t.search(/[([{【〔「]/);
  if (br > 0) t = t.slice(0, br);
  // 2つ以上の空白で区切られていれば、その前まで
  const sp = t.search(/\s{2,}/);
  if (sp > 0) t = t.slice(0, sp);
  t = t.replace(/\s+/g, ' ').trim();
  if (!t) return String(note ?? '').replace(/[\s　]+/g, ' ').trim();
  return t;
}

/**
 * 名寄せ用のキー。これが同じなら同一の取引先とみなす。
 * 半角/全角、空白、中黒、法人格の有無をすべて吸収する。
 *   「キクチ・エステート」「キクチエステート」→ きくちえすてーと相当の同一キー
 *   「株式会社マルミ」「株式会社　マルミ」「(株)マルミ」→ 同一キー
 */
export function nameKey(name: string): string {
  return unify(name).replace(CORP, '').replace(NOISE, '');
}

/** レーベンシュタイン距離（編集回数）。 */
function distance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

/** 0〜1 の一致率（1 が完全一致）。 */
export function similarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  return 1 - distance(a, b) / max;
}

/** どのくらい似ていれば同じ取引先とみなすか。 */
const THRESHOLD = 0.82;
/** 短い名前はたまたま似ることがあるので、あいまい一致は使わない。 */
const MIN_FUZZY = 4;
/** 前方一致でまとめるときの最短の長さ（「山新友部店」⊂「山新友部店内原支所」）。 */
const MIN_PREFIX = 3;

/** 2つのキーが同じ取引先を指しているか。 */
export function isSameName(a: string, b: string): boolean {
  if (a === b) return true;
  // 一方がもう一方の先頭に完全に含まれる（店名＋支店名・品目が付いただけ）
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length >= MIN_PREFIX && long.startsWith(short)) return true;
  // よく似ている（表記ゆれ・一文字違い）
  if (a.length < MIN_FUZZY || b.length < MIN_FUZZY) return false;
  if (a[0] !== b[0]) return false;   // 頭文字が違うものは別会社とみなす
  return similarity(a, b) >= THRESHOLD;
}

/** 名寄せの結果ひとかたまり。 */
export interface PartnerGroup {
  /** まとめたグループの識別子（代表名のキー） */
  id: string;
  /** 画面に出す名前（いちばん多く出てきた表記） */
  name: string;
  /** このグループに入った表記の一覧（多い順） */
  variants: { name: string; count: number }[];
  /** 出現件数の合計 */
  count: number;
}

/** 名寄せの手動指定（税理士が直したもの）。自動判定より必ず優先する。 */
export interface AliasMap {
  /** 表記のキー → まとめ先のグループid */
  toGroup: Record<string, string>;
  /** グループid → 表示名の上書き */
  label: Record<string, string>;
}

export function emptyAliases(): AliasMap {
  return { toGroup: {}, label: {} };
}

/**
 * 取引先の表記をまとめる。
 * 件数の多い表記を代表にするので、結果は入力順に左右されない。
 */
export function clusterPartners(
  names: { name: string; count: number }[],
  aliases: AliasMap = emptyAliases(),
): PartnerGroup[] {
  // 多い順（同数なら名前順）に並べて、代表が安定するようにする
  const sorted = [...names].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ja'));
  const groups: PartnerGroup[] = [];
  const byId = new Map<string, PartnerGroup>();

  const put = (g: PartnerGroup, name: string, count: number) => {
    const v = g.variants.find(x => x.name === name);
    if (v) v.count += count;
    else g.variants.push({ name, count });
    g.count += count;
  };

  for (const { name, count } of sorted) {
    const key = nameKey(name);
    if (!key) continue;

    // 1) 税理士が指定したまとめ先が最優先
    const forced = aliases.toGroup[key];
    if (forced) {
      let g = byId.get(forced);
      if (!g) {
        g = { id: forced, name: aliases.label[forced] ?? name, variants: [], count: 0 };
        byId.set(forced, g); groups.push(g);
      }
      put(g, name, count);
      continue;
    }

    // 2) 既にあるグループのどれかと同じか
    const hit = groups.find(g => !aliases.toGroup[g.id] && isSameName(g.id, key));
    if (hit) { put(hit, name, count); continue; }

    // 3) 新しいグループ
    const g: PartnerGroup = { id: key, name: aliases.label[key] ?? name, variants: [], count: 0 };
    byId.set(key, g); groups.push(g);
    put(g, name, count);
  }

  for (const g of groups) {
    g.variants.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ja'));
    if (!aliases.label[g.id] && g.variants.length) g.name = representative(g.variants);
  }
  return groups.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ja'));
}

/**
 * グループの代表名を選ぶ。
 *
 * 単純に「いちばん多い表記」にすると、摘要に用途が付いたもの
 * （「水戸信用金庫 借入金返済 元金10,000千円」）が代表になってしまう。
 * そこで **他の表記の頭に来ている数がいちばん多いもの** を選ぶ。
 * 会社名は必ず先頭に来るので、これで素の会社名が代表になる。
 */
function representative(variants: { name: string; count: number }[]): string {
  const keys = variants.map(v => nameKey(v.name));
  let best = 0;
  let bestScore = -1;
  for (let i = 0; i < variants.length; i++) {
    const k = keys[i];
    if (!k) continue;
    const prefixOf = keys.filter(o => o.startsWith(k)).length;
    // ①他の表記の頭に来ている数 ②出現回数 ③短いほう の順で選ぶ
    const score = prefixOf * 1e9 + variants[i].count * 1e3 + (1000 - Math.min(999, k.length));
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return variants[best].name;
}
