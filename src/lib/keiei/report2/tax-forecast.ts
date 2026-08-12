// 新報告書 v2 P3（着地見込と納税予測）の中央「納税予測」・右「消費税の予測」を作る計算。
//
// 設計の意図:
//  - **紙面の左表（着地見込み）と数字を必ず一致させる**ため、税額の出発点は自前で年換算せず
//    landing（LandingResult）の A 列＝「残り＝当期平均」で置いた通期見込みをそのまま使う。
//    左表に無い項目（減価償却費・租税公課）だけ、A列と同じ考え方（YTD×12/経過月数）で年換算する。
//  - 税額は **中小法人（資本金1億円以下・外形標準課税なし）の標準税率による概算**。
//    超過課税・自治体差・均等割の資本金/従業者区分・欠損金の繰越控除・特定同族会社の留保金課税・
//    所得拡大促進税制などの特例は一切考慮していない。社長に「だいたいこれくらい要る」を
//    示して納税資金を準備してもらうための数字であり、申告書の税額ではない。
//  - 料率は改正のたびに直すことになるので **CORPORATE_TAX_RATES / VAT_DEFAULTS にすべて集約**し、
//    行ラベル（「年800万円以下 15%」など）も定数から組み立てる。ここだけ直せば表示も追随する。
//  - 端数処理は会計事務所の実務どおり「課税標準は1,000円未満切捨・税額は100円未満切捨」
//    （四捨五入ではない）。各行を切り捨ててから合計するので、紙面の明細行の和＝合計行になる。
//  - 金額の内部単位は「円」。表示単位（千円）への変換は theme.ts の amt()/toUnit() が行う。
//  - データが欠けていても例外は投げない。拾えない項目は 0 として計算し、消費税は estimated=false
//    （実績残高で裏が取れていない）を返して呼び出し側が注記を強められるようにする。

import type { FiscalYearData } from '../types'
import { CODES, ytd } from '../calc'
import { depreciationYtd, detailsOf, rowYtd } from '../analysis'
import type {
  CorporateTaxForecast, LandingResult, ReportV2Settings, TaxLine, VatForecast,
} from './types'

// ===== 料率（改正時はここだけ直す） =====
export interface ProgressiveBand { upTo: number; rate: number }

export const CORPORATE_TAX_RATES = {
  /** 法人税の軽減税率が使える所得の上限（年800万円） */
  corpLowLimit: 8_000_000,
  /** 法人税（軽減） */
  corpLowRate: 0.15,
  /** 法人税（上限超過分） */
  corpHighRate: 0.232,
  /** 地方法人税＝法人税額 × 10.3% */
  localCorpRate: 0.103,
  /** 法人住民税・法人税割＝法人税額 × 7.0%（道府県＋市町村の標準税率の合計） */
  residentRate: 0.070,
  /** 法人住民税・均等割（資本金1,000万円以下・従業者50人以下の道府県2万＋市町村5万） */
  residentPerCapita: 70_000,
  /** 法人事業税（所得割・標準税率）の超過累進 */
  bizBands: [
    { upTo: 4_000_000, rate: 0.035 },
    { upTo: 8_000_000, rate: 0.053 },
    { upTo: Infinity, rate: 0.070 },
  ] as ProgressiveBand[],
  /** 特別法人事業税＝基準法人所得割額（標準税率の事業税）× 37% */
  specialBizRate: 0.37,
} as const

export const VAT_DEFAULTS = {
  /** 消費税率（%）。軽減税率が混在していても概算では単一税率で置く */
  rate: 10,
  /** 簡易課税のみなし仕入率（%）。第3種（製造業等）の70%ではなく第2種（小売）寄りの既定値 */
  deemedRate: 80,
} as const

/** 人件費とみなす科目名（issues.ts の LABOR_RE と同じ考え方。着地見込みに人件費行が無いときの保険） */
const LABOR_RE = /役員報酬|役員賞与|給料|給与|賃金|賞与|雑給|法定福利|福利厚生|退職金|退職給付|人件費|労務費|専従者給与/
/** 不課税の代表科目（印紙税・固定資産税・自動車税など）。課税仕入から除く */
const TAX_DUES_RE = /租税公課|公租公課/
/** 消費税の実績残高（この科目があれば推計を実績で検算できる） */
const VAT_SUSPENSE_RE = /仮受消費税|仮払消費税/

// ===== 小さなヘルパー =====
const num = (n: number | null | undefined): number => (n != null && isFinite(n) ? n : 0)
/** 課税標準の1,000円未満切捨（マイナスは0） */
const floor1000 = (n: number): number => (n > 0 ? Math.floor(n / 1000) * 1000 : 0)
/** 税額の100円未満切捨（マイナスは0） */
const floor100 = (n: number): number => (n > 0 ? Math.floor(n / 100) * 100 : 0)
/** 0.232 → '23.2%' / 0.15 → '15%'（末尾の0を落とす） */
const rateLabel = (r: number): string => `${Number((r * 100).toFixed(3))}%`
/** 8000000 → '800万円' */
const manLabel = (yen: number): string => `${Math.round(yen / 10_000).toLocaleString('en-US')}万円`

/** 超過累進の税額（各段の幅ごとに税率を掛ける） */
function bandTax(base: number, bands: ProgressiveBand[]): number {
  let rest = Math.max(0, base)
  let prev = 0
  let tax = 0
  for (const b of bands) {
    if (rest <= 0) break
    const width = b.upTo - prev
    const part = Math.min(rest, width)
    tax += part * b.rate
    rest -= part
    prev = b.upTo
  }
  return tax
}

// ===== 法人税等の予測 =====
/**
 * 着地見込A（残り＝当期平均）の税引前利益から、法人税・地方法人税・住民税・事業税・
 * 特別法人事業税を概算し、中間納付済を差し引いた期末の納付予定を出す。
 *
 * 欠損（課税所得がマイナス）のときは所得に対する税はすべて0だが、**均等割は赤字でも課される**ので
 * 「地方法人税・住民税」の行には均等割だけが残る。欠損金の繰越控除は考慮していないため、
 * 課税所得がプラスでも繰越欠損があれば実際の税額はこれより小さくなる（effectiveRate は
 * 課税所得が0以下なら0を返すので、呼び出し側はその旨を注記できる）。
 */
export function computeCorporateTax(landing: LandingResult, v2: ReportV2Settings): CorporateTaxForecast {
  const R = CORPORATE_TAX_RATES
  const preTax = num(landing?.preTaxA)
  // 加減算（見込）＝ 交際費の損金不算入・減価償却超過額などの申告調整。
  // いまは入力欄が無いので常に0。将来 v2 に持たせても行の並びを変えずに済むよう、行だけ先に出しておく。
  const adjustment = 0
  const taxableIncome = preTax + adjustment          // マイナス（欠損）もそのまま持つ
  const base = floor1000(taxableIncome)              // 税額計算に使う課税標準（欠損は0）

  // 法人税（年800万円以下と超過分の2段）
  const corpLow = floor100(Math.min(base, R.corpLowLimit) * R.corpLowRate)
  const corpHigh = floor100(Math.max(0, base - R.corpLowLimit) * R.corpHighRate)
  const corpTax = corpLow + corpHigh

  // 地方法人税・住民税（法人税額に連動する国税＋地方税＋均等割）を1行にまとめる
  const localCorp = floor100(corpTax * R.localCorpRate)
  const resident = floor100(corpTax * R.residentRate)
  const localAndResident = localCorp + resident + R.residentPerCapita

  // 事業税（所得割・標準税率）と、それを課税標準にした特別法人事業税を1行にまとめる
  const bizTax = floor100(bandTax(base, R.bizBands))
  const specialBiz = floor100(bizTax * R.specialBizRate)
  const bizAndSpecial = bizTax + specialBiz

  const total = corpTax + localAndResident + bizAndSpecial
  const prepaid = num(v2?.taxPrepaid)
  const due = Math.max(0, total - prepaid)

  const lines: TaxLine[] = [
    { label: '税引前当期純利益（見込）', amount: preTax },
    { label: '加減算（見込）', amount: adjustment },
    { label: '課税所得（見込）', amount: taxableIncome, kind: 'sub' },
    { label: `法人税（年${manLabel(R.corpLowLimit)}以下 ${rateLabel(R.corpLowRate)}）`, amount: corpLow, kind: 'ind' },
    { label: `法人税（超過分 ${rateLabel(R.corpHighRate)}）`, amount: corpHigh, kind: 'ind' },
    { label: '地方法人税・住民税', amount: localAndResident, kind: 'ind' },
    { label: '事業税・特別法人事業税', amount: bizAndSpecial, kind: 'ind' },
    { label: '法人税等 合計', amount: total, kind: 'key' },
    { label: '中間納付済', amount: -prepaid },
    { label: '期末の納付予定', amount: due, kind: 'total' },
  ]

  return {
    preTax, adjustment, taxableIncome, lines,
    total, prepaid, due,
    effectiveRate: taxableIncome > 0 ? (total / taxableIncome) * 100 : 0,
  }
}

// ===== 消費税の予測 =====
/** 着地見込みの表からA列（残り＝当期平均）の金額を拾う。率の行は拾わない */
function landingA(landing: LandingResult, re: RegExp): number | null {
  const rows = landing?.rows
  if (!rows) return null
  const row = rows.find((r) => !r.isRate && !/率/.test(r.label) && re.test(r.label))
  return row ? num(row.a) : null
}

/** 販管費・売上原価の明細から名称一致でYTD合算（着地見込みに該当行が無いときの保険） */
function matchedYtd(fy: FiscalYearData, monthIdx: number, re: RegExp): number {
  let s = 0
  for (const a of [...detailsOf(fy, CODES.sgna), ...detailsOf(fy, CODES.cogs)]) {
    if (re.test(a.name)) s += rowYtd(a, monthIdx)
  }
  return s
}

/** 仮受・仮払消費税の科目がBSにあるか（あれば推計を実績残高で検算できる） */
function hasVatSuspense(fy: FiscalYearData | null): boolean {
  if (!fy?.rows) return false
  return fy.rows.some((r) => r.statement === 'BS' && !r.isSubtotal && VAT_SUSPENSE_RE.test(r.name))
}

/**
 * 課税方式に応じて年間の消費税納付見込みを出す。
 *
 * 原則課税の課税仕入高は「売上原価＋販管費−人件費−減価償却費−租税公課」の概算。
 * 人件費（不課税）・減価償却費（仕入ではない）・租税公課（不課税）という代表的な非課税・不課税だけを
 * 除いており、支払保険料・支払利息・非課税売上に対応する仕入などは除いていない。
 * また会計データは税抜経理・課税売上割合ほぼ100%を前提にしている。
 * ここまで割り切っているのは「納税資金をいくら残すか」を示すのが目的で、申告額の算定ではないため。
 */
export function computeVat(
  fy: FiscalYearData,
  prior: FiscalYearData | null,
  monthIdx: number,
  landing: LandingResult,
  v2: ReportV2Settings,
): VatForecast {
  const method = v2?.vatMethod ?? 'general'
  const rate = num(v2?.vatRate ?? VAT_DEFAULTS.rate) / 100
  // 当期に残高が無くても前期のBSに科目があれば「実績で検算できる」とみなす
  const estimated = hasVatSuspense(fy) || hasVatSuspense(prior)

  if (method === 'exempt') {
    return {
      method: 'exempt',
      lines: [{ label: '免税事業者のため納付はありません', amount: 0 }],
      annual: 0, prepaid: 0, due: 0,
      estimated: false,
    }
  }

  // 着地見込Aと同じ年換算（YTD×12/経過月数）。左表に無い科目だけこれで通期に伸ばす
  const months = Math.min(12, Math.max(1, monthIdx + 1))
  const af = 12 / months

  const taxableSales = Math.max(0, num(landing?.salesA))
  const outputVat = Math.round(taxableSales * rate)

  const prepaid = num(v2?.vatPrepaid)
  let taxablePurchase = 0
  let inputVat = 0
  let annual = 0
  const lines: TaxLine[] = [
    { label: '課税売上高（税抜・見込）', amount: taxableSales },
    { label: '仮受消費税', amount: outputVat, kind: 'ind' },
  ]

  if (method === 'simple') {
    // 簡易課税: 売上の消費税だけで決まる（仕入の実額は使わない）
    const deemedPct = num(v2?.vatDeemedRate ?? VAT_DEFAULTS.deemedRate)
    const deduction = Math.round(outputVat * (deemedPct / 100))
    annual = floor100(Math.max(0, outputVat - deduction))
    lines.push({ label: `控除対象仕入税額（みなし仕入率 ${Number(deemedPct.toFixed(1))}%）`, amount: -deduction, kind: 'ind' })
  } else {
    // 原則課税: 通期見込みの「売上原価＋販管費−人件費−減価償却費−租税公課」を課税仕入高とみなす
    const grossA = landingA(landing, /売上総利益|粗利/) ?? ytd(fy, CODES.grossProfit, monthIdx) * af
    const cogsA = landingA(landing, /売上原価/) ?? Math.max(0, taxableSales - grossA)
    const sgnaA = landingA(landing, /販管費|販売費/) ?? ytd(fy, CODES.sgna, monthIdx) * af
    const laborA = landingA(landing, /人件費/) ?? matchedYtd(fy, monthIdx, LABOR_RE) * af
    const depA = depreciationYtd(fy, monthIdx) * af
    const duesA = matchedYtd(fy, monthIdx, TAX_DUES_RE) * af
    taxablePurchase = Math.max(0, Math.round(cogsA + sgnaA - laborA - depA - duesA))
    inputVat = Math.round(taxablePurchase * rate)
    annual = floor100(Math.max(0, outputVat - inputVat))
    lines.push(
      { label: '課税仕入高（税抜・見込）', amount: taxablePurchase },
      { label: '仮払消費税', amount: inputVat, kind: 'ind' },
    )
  }

  const due = Math.max(0, annual - prepaid)
  lines.push(
    { label: '年間納付見込', amount: annual, kind: 'key' },
    { label: '中間納付済・予定', amount: -prepaid },
    { label: '確定申告時の納付', amount: due, kind: 'total' },
  )

  return { method, lines, annual, prepaid, due, estimated }
}
