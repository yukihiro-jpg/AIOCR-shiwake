import type { AccountItem } from './types'

/**
 * レシート・領収書の「内容」「店名」から、一般的に想定される借方科目を推定する。
 *
 * 使いどころ: 書類スキャン受信のAI解析結果を仕訳作成へ転送したとき、
 * 借方科目が全部空欄だと1行ずつ手入力になるため、無難な既定値を入れて初期入力を減らす。
 *
 * 設計の約束:
 * - 推定はあくまで下書き。過去に学習したパターン（pattern-store）があればそちらが優先。
 * - **顧問先の科目マスタに実在する科目にしか割り当てない**（存在しない科目コードを作らない）。
 *   マスタに該当科目が無ければ null を返して空欄のままにする。
 * - キーワードは長いものから順に判定する（「月極駐車場」が「駐車場」より先に当たるように）。
 */

/** キーワード → 候補科目名（顧問先マスタにある最初のものを採用） */
const RULES: { words: string[]; accounts: string[] }[] = [
  // 交通・出張
  { words: ['月極駐車場', '月極'], accounts: ['地代家賃', '賃借料'] },
  { words: ['駐車場', 'パーキング', 'ＥＴＣ', 'ETC', '高速', '有料道路', 'タクシー', '運賃', '乗車', '交通', '電車', '新幹線', '航空券', 'ＪＲ', 'JR', '宿泊', 'ホテル', '旅館', '出張'], accounts: ['旅費交通費'] },
  // 車両
  { words: ['ガソリン', '軽油', 'ハイオク', 'レギュラー', '給油', '洗車', 'オイル交換', '車検', 'タイヤ', 'エネオス', 'ＥＮＥＯＳ', 'ENEOS', 'コスモ石油', '出光'], accounts: ['車両費', '車両関係費', '旅費交通費'] },
  // 飲食まわり
  { words: ['会議', '打合せ', '打ち合わせ', 'ミーティング'], accounts: ['会議費', '接待交際費'] },
  { words: ['御飲食代', '飲食代', '御食事代', '食事代', '居酒屋', '会食', '接待', '料亭', 'スナック', 'ラウンジ', 'クラブ', '御祝', '御祝儀', '香典', '手土産', '贈答', 'お中元', 'お歳暮', '御中元', '御歳暮', 'ゴルフ'], accounts: ['接待交際費', '交際費'] },
  { words: ['忘年会', '新年会', '社員旅行', '慰安', '健康診断', '予防接種', '慶弔', '福利厚生'], accounts: ['福利厚生費'] },
  // 事務・消耗品
  { words: ['消耗品', '文房具', '文具', '事務用品', 'コピー用紙', 'インク', 'トナー', '電池', 'ホームセンター', 'カインズ', 'コメリ'], accounts: ['消耗品費', '事務用品費'] },
  { words: ['書籍', '新聞', '雑誌', '図書', '定期購読', '本代'], accounts: ['新聞図書費', '図書費'] },
  // 通信・荷造
  { words: ['切手', '郵便', 'レターパック', '電話', '携帯', 'インターネット', 'プロバイダ', '通信'], accounts: ['通信費'] },
  { words: ['宅急便', '宅配', 'ゆうパック', '送料', '梱包', '段ボール', 'ダンボール'], accounts: ['荷造運賃', '荷造運賃手数料', '通信費'] },
  // 水道光熱
  { words: ['電気料', '電力', 'ガス料', 'プロパン', '水道', '灯油'], accounts: ['水道光熱費'] },
  // 修繕・管理
  { words: ['修理', '修繕', '点検', 'メンテナンス', '整備'], accounts: ['修繕費'] },
  { words: ['清掃', 'クリーニング', '廃棄物', 'ごみ', 'ゴミ'], accounts: ['雑費', '消耗品費'] },
  // 税金・手数料・会費
  { words: ['収入印紙', '印紙', '証紙', '自動車税', '軽自動車税', '登録免許税'], accounts: ['租税公課'] },
  { words: ['手数料', '振込手数料', '登記', '印鑑証明', '住民票', '証明書'], accounts: ['支払手数料', '雑費'] },
  { words: ['年会費', '会費', '組合費', '協会'], accounts: ['諸会費', '会費'] },
  { words: ['保険'], accounts: ['保険料', '損害保険料'] },
  // 広告
  { words: ['広告', '宣伝', 'チラシ', '名刺', '看板', 'ホームページ', 'ＨＰ'], accounts: ['広告宣伝費'] },
  // 家賃
  { words: ['家賃', '賃料', '地代'], accounts: ['地代家賃'] },
]

/** 長いキーワードから順に判定するため、あらかじめ展開して並べ替えた表 */
const FLAT: { word: string; accounts: string[] }[] = RULES
  .flatMap((r) => r.words.map((w) => ({ word: w, accounts: r.accounts })))
  .sort((a, b) => b.word.length - a.word.length)

/** 科目マスタから科目名で1件引く（完全一致 → 部分一致の順） */
function findAccount(master: AccountItem[], name: string): AccountItem | null {
  const exact = master.find((a) => a.name === name || a.shortName === name)
  if (exact) return exact
  const partial = master.find((a) => (a.name || '').includes(name) || (a.shortName || '').includes(name))
  return partial || null
}

/**
 * 内容・店名から借方科目を推定する。該当なし、または顧問先のマスタに候補科目が
 * 1つも無いときは null（＝空欄のまま取り込む）。
 */
export function guessDebitAccount(
  mainContent: string,
  storeName: string,
  master: AccountItem[],
): { code: string; name: string } | null {
  if (!master || master.length === 0) return null
  // 「内容」を先に見る（店名より意図が明確なため）
  for (const text of [mainContent || '', storeName || '']) {
    if (!text.trim()) continue
    for (const rule of FLAT) {
      if (!text.includes(rule.word)) continue
      for (const cand of rule.accounts) {
        const acc = findAccount(master, cand)
        if (acc) return { code: acc.code, name: acc.shortName || acc.name }
      }
    }
  }
  return null
}
