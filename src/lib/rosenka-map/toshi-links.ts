// 都市計画の「最新の公式図」への導線。
// ① いばらきデジタルまっぷ（茨城県の統合型GIS・都市計画情報レイヤー）へ検索地点でジャンプ
// ② 市町村の都市計画図ページ（登録があれば直リンク・無ければ公式サイト検索で1クリック到達）
//
// 同梱の2019年判定はあくまで「あたり」で、最新の確認はこのリンク先の公式図で行う運用。

/** いばらきデジタルまっぷ（wagmap）。URL形式はActionsの実測プローブで確認したもの。
 *  形式が変わって開けなくなった場合はポータルURLへフォールバックする（top）。 */
export const IBARAKI_DIGITAL_MAP = {
  /** 地点ジャンプ（mpx=経度, mpy=緯度, mps=縮尺分母） */
  point: (lng: number, lat: number): string =>
    `https://www2.wagmap.jp/pref-ibaraki/Map?mid=1&mpx=${lng.toFixed(6)}&mpy=${lat.toFixed(6)}&mps=2500`,
  top: 'https://www2.wagmap.jp/pref-ibaraki/Portal',
  label: 'いばらきデジタルまっぷ',
}

/** 市町村の都市計画情報ページ（確認済みのものだけ登録。無い市は検索フォールバック） */
export const CITY_TOSHI_URLS: Record<string, string> = {
  // 例: '水戸市': 'https://www.city.mito.lg.jp/…',
}

/** 市町村の都市計画図への1クリック導線（登録が無ければ公式サイト向け検索） */
export function cityToshiUrl(cityName: string): string {
  const curated = CITY_TOSHI_URLS[cityName]
  if (curated) return curated
  return `https://www.google.com/search?q=${encodeURIComponent(`${cityName} 都市計画図 用途地域`)}`
}
