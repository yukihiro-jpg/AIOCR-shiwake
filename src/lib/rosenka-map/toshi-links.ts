// 都市計画の「最新の公式図」への導線。
// ① いばらきデジタルまっぷ（茨城県の統合型GIS）の各市町村「都市計画」マップへ検索地点でジャンプ
// ② 市町村の都市計画図ページ（登録があれば直リンク・無ければ公式サイト検索で1クリック到達）
//
// 同梱の2019年判定はあくまで「あたり」で、最新の確認はこのリンク先の公式図で行う運用。

/** いばらきデジタルまっぷの「都市計画」マップID（市町村別）。
 *  一覧とURL形式（Map?mid=N&mpx=経度&mpy=緯度&mps=縮尺 → 200 OK）は
 *  2026-07 に実サイトで確認済み。掲載が無い市町村はこの表に無い。 */
export const IBARAKI_TOSHI_MAP_IDS: Record<string, number> = {
  '水戸市': 77, // R3.3時点の注記あり
  '結城市': 65,
  '常総市': 66,
  '鹿嶋市': 67,
  '神栖市': 68, // R4.7時点の注記あり
  '鉾田市': 81,
  '行方市': 83,
  '境町': 97,
  '桜川市': 111,
  '潮来市': 113,
}

/** 検索地点の市町村の都市計画マップURL（掲載が無い市町村は null） */
export function ibarakiDigitalMapUrl(cityName: string, lng: number, lat: number): string | null {
  const mid = IBARAKI_TOSHI_MAP_IDS[cityName]
  if (!mid) return null
  return `https://www2.wagmap.jp/ibaraki/Map?mid=${mid}&mpx=${lng.toFixed(6)}&mpy=${lat.toFixed(6)}&mps=2500`
}

export const IBARAKI_DIGITAL_MAP_TOP = 'https://www2.wagmap.jp/ibaraki/Portal'

/** 市町村の都市計画情報ページ（確認済みのものだけ登録。無い市は検索フォールバック） */
export const CITY_TOSHI_URLS: Record<string, string> = {
  // 例: '土浦市': 'https://www.city.tsuchiura.lg.jp/…',
}

/** 市町村の都市計画図への1クリック導線（登録が無ければ公式サイト向け検索） */
export function cityToshiUrl(cityName: string): string {
  const curated = CITY_TOSHI_URLS[cityName]
  if (curated) return curated
  return `https://www.google.com/search?q=${encodeURIComponent(`${cityName} 都市計画図 用途地域`)}`
}
