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
  return distanceAtMost(a, b, Math.max(a.length, b.length)) ?? Math.max(a.length, b.length);
}

/**
 * 「cap 以下なら本当の距離、超えていたら null」を返す。
 *
 * 名寄せで知りたいのは「十分に似ているか」だけなので、遠いと分かった時点で
 * 打ち切れる。表全体を埋める素直な実装は文字数の二乗かかるが、
 * こちらは **帯（対角線から ±cap）の中だけ**を計算するので cap に比例した幅で済む。
 * cap は 1〜3 程度にしかならないため、実質的に文字数に比例する。
 */
function distanceAtMost(a: string, b: string, cap: number): number | null {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return null;
  if (!a.length) return b.length <= cap ? b.length : null;
  if (!b.length) return a.length <= cap ? a.length : null;
  const INF = cap + 1;
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j <= cap ? j : INF;
  for (let i = 1; i <= a.length; i++) {
    const lo = Math.max(1, i - cap);
    const hi = Math.min(b.length, i + cap);
    cur[0] = i <= cap ? i : INF;
    for (let j = 1; j < lo; j++) cur[j] = INF;
    let best = cur[0];
    for (let j = lo; j <= hi; j++) {
      const v = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      cur[j] = v > INF ? INF : v;
      if (cur[j] < best) best = cur[j];
    }
    for (let j = hi + 1; j <= b.length; j++) cur[j] = INF;
    if (best > cap) return null;   // この行がすべて cap 超え＝これ以上縮まらない
    const t = prev; prev = cur; cur = t;
  }
  return prev[b.length] <= cap ? prev[b.length] : null;
}

/**
 * どの文字が含まれるかを32ビットに畳んだ指紋。
 * 編集が k 回なら、含まれる文字の集合の違いは両側あわせて 2k 個以内。
 * ぶつかり（別の文字が同じビットになる）は「似ていないのに候補に残る」方向にしか
 * 働かないので、**結果は変わらず、遠い相手を計算せずに捨てられる**。
 */
function charMask(s: string): number {
  let m = 0;
  for (let i = 0; i < s.length; i++) m |= 1 << (s.charCodeAt(i) & 31);
  return m;
}

function popcount(n: number): number {
  let x = n - ((n >> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
  x = (x + (x >> 4)) & 0x0f0f0f0f;
  return (x * 0x01010101) >> 24;
}

/** 0〜1 の一致率（1 が完全一致）。 */
export function similarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  return 1 - distance(a, b) / max;
}

/** あいまい一致の判定（similarity(a,b) >= THRESHOLD と同じ結果を、打ち切りながら求める）。 */
function fuzzyEnough(a: string, b: string): boolean {
  const max = Math.max(a.length, b.length);
  if (max === 0) return true;
  // これを超えたら必ず不一致、という上限。1つ余裕を持たせて厳密さを保つ
  const cap = Math.floor((1 - THRESHOLD) * max) + 1;
  const d = distanceAtMost(a, b, cap);
  if (d === null) return false;
  return 1 - d / max >= THRESHOLD;
}

/** どのくらい似ていれば同じ取引先とみなすか。 */
const THRESHOLD = 0.82;
/** 短い名前はたまたま似ることがあるので、あいまい一致は使わない。 */
const MIN_FUZZY = 4;
/** 前方一致でまとめるときの最短の長さ（「山新友部店」⊂「山新友部店内原支所」）。 */
const MIN_PREFIX = 3;

/** 2つのキーが同じ取引先を指しているか。 */
export function isSameName(a: string, b: string): boolean {
  return matchKind(a, b) !== null;
}

/**
 * 同じ取引先とみなした「理由」。確認画面の絞り込みに使う。
 *   exact  … キーが完全に一致（表記ゆれを吸収した結果）
 *   prefix … 一方がもう一方の先頭に含まれる（店名＋支店名・品目が付いただけ）
 *   fuzzy  … よく似ている（1文字違いなど）
 * **誤って別々の取引先がまとまるのは fuzzy だけ**（「お茶代」と「お花代」など）。
 * 確認はここに絞ればよい。
 */
export type MatchKind = 'exact' | 'prefix' | 'fuzzy';

export function matchKind(a: string, b: string): MatchKind | null {
  if (a === b) return 'exact';
  // 一方がもう一方の先頭に完全に含まれる（店名＋支店名・品目が付いただけ）
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length >= MIN_PREFIX && long.startsWith(short)) return 'prefix';
  // よく似ている（表記ゆれ・一文字違い）
  if (a.length < MIN_FUZZY || b.length < MIN_FUZZY) return null;
  if (a[0] !== b[0]) return null;   // 頭文字が違うものは別会社とみなす
  return fuzzyEnough(a, b) ? 'fuzzy' : null;
}

/**
 * あいまい一致が成り立ちうる長さの範囲。
 * 編集距離は長さの差以上なので、similarity = 1 − 距離/長い方 ≥ THRESHOLD には
 * 「長さの差 ≤ (1−THRESHOLD) × 長い方」が必要。ここから外れる相手は
 * 計算するまでもなく不一致なので、**距離の計算自体を省ける**。
 */
function fuzzyLenRange(len: number): [number, number] {
  return [Math.ceil(THRESHOLD * len), Math.floor(len / THRESHOLD)];
}

/** 名寄せの結果ひとかたまり。 */
export interface PartnerGroup {
  /** まとめたグループの識別子（代表名のキー） */
  id: string;
  /** 画面に出す名前（いちばん多く出てきた表記） */
  name: string;
  /** このグループに入った表記の一覧（多い順） */
  variants: {
    name: string;
    count: number;
    /**
     * この表記がグループに入った理由。代表そのものは 'self'、
     * 税理士が手で指定したものは 'alias'。確認画面の絞り込みに使う。
     */
    via?: MatchKind | 'self' | 'alias';
  }[];
  /** 出現件数の合計 */
  count: number;
}

/** 名寄せの手動指定（税理士が直したもの）。自動判定より必ず優先する。 */
export interface AliasMap {
  /** 表記のキー → まとめ先のグループid */
  toGroup: Record<string, string>;
  /** グループid → 表示名の上書き */
  label: Record<string, string>;
  /**
   * 確認済みの記録。グループid → そのとき入っていた表記の指紋。
   * 表記が増えると指紋が変わるので、**次からは「新しく出てきた表記のあるグループ」だけ**が
   * 要確認に戻る（毎月ぜんぶ見直さなくてよくするための仕組み）。
   */
  reviewed?: Record<string, string>;
}

export function emptyAliases(): AliasMap {
  return { toGroup: {}, label: {} };
}

/**
 * 取引先の表記をまとめる。
 * 件数の多い表記を代表にするので、結果は入力順に左右されない。
 *
 * 【速さについて】
 * 素直に「既存グループ全部と突き合わせる」と件数の二乗になり、
 * ユニークな摘要が1万を超える顧問先では取込のたびに数十秒固まる（実測 12,000表記で42秒）。
 * そこで、一致しうる相手を先に絞り込む索引を持つ。
 *   ・完全一致 … キーで直接引く
 *   ・前方一致 … 「キーの先頭3文字以上」で引く（どちらが長くても先頭3文字は必ず同じ）
 *   ・あいまい一致 … 頭文字が同じで、かつ長さが一致しうる範囲のものだけ距離を計算する
 * **どの候補を採るかは従来どおり「いちばん先に作られたグループ」**なので、結果は変わらない。
 */
export function clusterPartners(
  names: { name: string; count: number }[],
  aliases: AliasMap = emptyAliases(),
): PartnerGroup[] {
  // 多い順（同数なら名前順）に並べて、代表が安定するようにする
  const sorted = [...names].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ja'));
  const groups: PartnerGroup[] = [];
  const byId = new Map<string, PartnerGroup>();

  // --- 照合用の索引（自動判定の対象になるグループだけを入れる） ---
  const ordOf = new Map<PartnerGroup, number>();
  const byKey = new Map<string, PartnerGroup>();
  const byPre = new Map<string, PartnerGroup[]>();
  const byChar = new Map<string, Map<number, PartnerGroup[]>>();
  const maskOf = new Map<PartnerGroup, number>();
  const indexGroup = (g: PartnerGroup) => {
    ordOf.set(g, ordOf.size);
    if (aliases.toGroup[g.id]) return;   // 手動で他へ寄せた先は自動判定の相手にしない
    byKey.set(g.id, g);
    if (g.id.length >= MIN_PREFIX) {
      const p = g.id.slice(0, MIN_PREFIX);
      const a = byPre.get(p); if (a) a.push(g); else byPre.set(p, [g]);
    }
    if (g.id.length >= MIN_FUZZY) {
      maskOf.set(g, charMask(g.id));
      let per = byChar.get(g.id[0]);
      if (!per) { per = new Map(); byChar.set(g.id[0], per); }
      const a = per.get(g.id.length); if (a) a.push(g); else per.set(g.id.length, [g]);
    }
  };

  /** その表記を受け入れられる既存グループのうち、いちばん先に作られたもの。 */
  const findHit = (key: string): { g: PartnerGroup; via: MatchKind } | null => {
    // 閉包の中で書き換えるので、入れ物に包んで型の絞り込みを効かせる
    const best: { v: { g: PartnerGroup; via: MatchKind; ord: number } | null } = { v: null };
    const take = (g: PartnerGroup | undefined, via: MatchKind) => {
      if (!g) return;
      const ord = ordOf.get(g) ?? Infinity;
      if (!best.v || ord < best.v.ord) best.v = { g, via, ord };
    };
    take(byKey.get(key), 'exact');
    // 既存のidが key の先頭にある（key が長い側）
    for (let L = MIN_PREFIX; L < key.length; L++) take(byKey.get(key.slice(0, L)), 'prefix');
    // key が既存のidの先頭にある（key が短い側）
    if (key.length >= MIN_PREFIX) {
      for (const g of byPre.get(key.slice(0, MIN_PREFIX)) ?? []) {
        if (g.id.length > key.length && g.id.startsWith(key)) take(g, 'prefix');
      }
    }
    // あいまい一致（距離の計算は、長さが一致しうる範囲のものだけ）
    if (key.length >= MIN_FUZZY) {
      const per = byChar.get(key[0]);
      if (per) {
        const [lo, hi] = fuzzyLenRange(key.length);
        const km = charMask(key);
        for (let L = Math.max(MIN_FUZZY, lo); L <= hi; L++) {
          const cap = Math.floor((1 - THRESHOLD) * Math.max(L, key.length));
          for (const g of per.get(L) ?? []) {
            // すでに、より先に作られた候補があるなら距離を計算するまでもない
            if (best.v && (ordOf.get(g) ?? Infinity) >= best.v.ord) continue;
            // 含まれる文字が離れすぎているものは、距離を計算するまでもなく不一致
            if (popcount(km ^ (maskOf.get(g) ?? 0)) > cap * 2) continue;
            if (fuzzyEnough(g.id, key)) take(g, 'fuzzy');
          }
        }
      }
    }
    return best.v ? { g: best.v.g, via: best.v.via } : null;
  };

  const put = (g: PartnerGroup, name: string, count: number, via: PartnerGroup['variants'][number]['via']) => {
    const v = g.variants.find(x => x.name === name);
    if (v) v.count += count;
    else g.variants.push({ name, count, via });
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
        byId.set(forced, g); groups.push(g); indexGroup(g);
      }
      put(g, name, count, 'alias');
      continue;
    }

    // 2) 既にあるグループのどれかと同じか
    const hit = findHit(key);
    if (hit) { put(hit.g, name, count, hit.via); continue; }

    // 3) 新しいグループ
    const g: PartnerGroup = { id: key, name: aliases.label[key] ?? name, variants: [], count: 0 };
    byId.set(key, g); groups.push(g); indexGroup(g);
    put(g, name, count, 'self');
  }

  for (const g of groups) {
    g.variants.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ja'));
    if (!aliases.label[g.id] && g.variants.length) g.name = representative(g.variants);
  }
  return groups.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ja'));
}

/**
 * そのグループが「いま何をまとめているか」の指紋。
 * 確認済みを記録するときに使い、**表記が増えたら指紋が変わる**ので
 * 次の取込で自動的に要確認へ戻る。
 */
export function groupSignature(g: PartnerGroup): string {
  const keys = g.variants.map(v => nameKey(v.name)).sort().join('');
  let h = 2166136261;
  for (let i = 0; i < keys.length; i++) {
    h ^= keys.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${g.variants.length}:${(h >>> 0).toString(36)}`;
}

/** 確認が要るか（あいまい一致を含み、まだ今の中身で確認していないもの）。 */
export function needsReview(g: PartnerGroup, aliases: AliasMap): boolean {
  if (g.variants.length <= 1) return false;
  if (!g.variants.some(v => v.via === 'fuzzy')) return false;
  return aliases.reviewed?.[g.id] !== groupSignature(g);
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
