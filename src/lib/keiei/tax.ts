// 中小法人（資本金1億円以下・外形標準課税なし）の概算実効税率（所得連動）。
// 現行料率に基づく代表値。赤字（所得0以下）は0%。料率は将来編集可能にする想定の定数。
// 参考: 所得400万以下 ≒ 21.4% / 400〜800万 ≒ 23.2% / 800万超 ≒ 33.6%

export interface TaxBand { upTo: number; rate: number }

export const SME_TAX_BANDS: TaxBand[] = [
  { upTo: 4000000, rate: 0.214 },
  { upTo: 8000000, rate: 0.232 },
  { upTo: Infinity, rate: 0.336 },
]

/** 課税所得（円）から概算実効税率を返す。赤字は0。 */
export function effectiveTaxRate(income: number, bands: TaxBand[] = SME_TAX_BANDS): number {
  if (income <= 0) return 0
  for (const b of bands) if (income <= b.upTo) return b.rate
  return bands[bands.length - 1].rate
}
