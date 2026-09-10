// 質問文から「どの勘定科目のことか」を突き止める。
//
// 科目名は顧問先ごとに違う（「交際費」「接待交際費」、「賃借料」「地代家賃」など）ので、
// **決め打ちの辞書ではなく、その顧問先が実際に持っている科目一覧と突き合わせる**。
// 言い方のゆれ（家賃／賃料、電気代／光熱費）は ALIASES で吸収する。

import type { AccountRow, FiscalYearData } from '../types';

/** 見つかった科目（複数科目にまたがることもある。例: 「在庫」＝商品＋仕掛品）。 */
export interface AccountMatch {
  /** 画面に出す名前。1科目ならその科目名、まとめたときは質問の言い方 */
  label: string;
  rows: AccountRow[];
}

/**
 * 話し言葉 → 実際の科目名にあてる正規表現。
 * ここに無い言葉でも、科目名そのもので聞かれれば下の直接照合で拾える。
 */
const ALIASES: { words: string[]; re: RegExp; label?: string }[] = [
  { words: ['交際費', '接待'], re: /交際費/ },
  { words: ['広告', '宣伝'], re: /広告/ },
  { words: ['家賃', '賃料', '地代', '事務所代'], re: /賃借料|地代家賃|支払家賃/ },
  { words: ['光熱費', '電気代', '電気料', '水道代'], re: /水道光熱費|電気|光熱/ },
  // 「車」だけでは広すぎる（「社用車の買い替えはどう思う？」を経費の質問にしてしまう）
  { words: ['ガソリン', '燃料', '車両費', '車輌費'], re: /燃料|車両費|車輌費/ },
  { words: ['電話代', '通信'], re: /通信費/ },
  { words: ['交通費', '旅費', '出張'], re: /旅費|交通費/ },
  { words: ['保険'], re: /保険料/ },
  { words: ['修繕', '修理'], re: /修繕/ },
  { words: ['消耗品'], re: /消耗品/ },
  { words: ['会議費'], re: /会議費/ },
  { words: ['外注'], re: /外注/ },
  { words: ['減価償却', '償却費'], re: /減価償却/ },
  { words: ['利息', '金利'], re: /支払利息|利息割引料/ },
  { words: ['役員報酬'], re: /役員報酬/ },
  // 「人件費」は科目ではなく概念なので入れない（労働分配率の集計に任せる）
  { words: ['給料', '給与', '賃金'], re: /給料|給与|賃金|雑給/, label: '給料' },
  { words: ['賞与', 'ボーナス'], re: /賞与/ },
  { words: ['社会保険', '法定福利'], re: /法定福利/ },
  { words: ['福利厚生'], re: /福利厚生/ },
  { words: ['租税公課', '印紙'], re: /租税公課/ },
  { words: ['手数料'], re: /手数料/ },
  { words: ['リース'], re: /リース料/ },
  { words: ['会費'], re: /諸会費|会費/ },
  { words: ['雑費'], re: /雑費/ },
  { words: ['仕入'], re: /仕入/ },
  { words: ['売掛', '未回収', '未収'], re: /売掛金|受取手形|完成工事未収/, label: '売掛金など' },
  { words: ['買掛', '未払い', '未払'], re: /買掛金|支払手形|工事未払金/, label: '買掛金など' },
  { words: ['在庫', '棚卸'], re: /^商品$|^製品$|仕掛品|原材料|貯蔵品|未成工事支出金/, label: '棚卸資産' },
  { words: ['退職金', '退職給付'], re: /退職/ },
];

/**
 * 科目としては拾わないもの。
 * これらは専用の集計（現金の推移・借入の返済年数）のほうが良い答えを返すため、
 * そちらに任せる。
 */
const RESERVED = /現金|預金|普通|当座|定期|積金|短期借入金|長期借入金|社債|リース債務|役員借入金/;

/** 質問の対象にできる明細行（小計・合計は除く）。 */
function detailRows(y: FiscalYearData): AccountRow[] {
  return y.rows.filter(r => !r.isSubtotal && r.name.trim().length >= 2
    && !RESERVED.test(r.name));
}

/**
 * 質問文から科目を探す。見つからなければ null。
 * 1) 実際の科目名がそのまま質問に入っていれば、それ（長い名前を優先）
 * 2) 話し言葉（家賃・電気代など）なら ALIASES 経由で科目を引く
 */
export function findAccounts(y: FiscalYearData, q: string): AccountMatch | null {
  const t = q.replace(/\s/g, '');
  const rows = detailRows(y);

  // 1) 科目名そのもの。「支払保険料」と「保険料」が両方あるときは長いほうを採る
  const direct = rows
    .filter(r => t.includes(r.name))
    .sort((a, b) => b.name.length - a.name.length);
  if (direct.length) {
    const name = direct[0].name;
    // 同名の科目が複数（BS/PLに跨るなど）あればまとめる
    const same = rows.filter(r => r.name === name);
    return { label: name, rows: same };
  }

  // 2) 話し言葉から引く
  for (const a of ALIASES) {
    if (!a.words.some(w => t.includes(w))) continue;
    const hit = rows.filter(r => a.re.test(r.name));
    if (hit.length === 1) return { label: hit[0].name, rows: hit };
    if (hit.length > 1) return { label: a.label ?? a.words[0], rows: hit };
  }
  return null;
}

/** 顧問先が持っている費用科目の例（見つからなかったときの案内用）。 */
export function sampleExpenseNames(y: FiscalYearData, n = 6): string[] {
  return detailRows(y)
    .filter(r => r.statement === 'PL' && /費|料|報酬|手当|賞与|公課/.test(r.name))
    .map(r => r.name)
    .slice(0, n);
}
