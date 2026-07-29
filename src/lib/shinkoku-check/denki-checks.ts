// 申告書チェック（電気供給業）: 区分計算書Excel・決算書・法人税別表・県税申告書の突合。
// 純粋関数・API不使用。analyze.ts から呼ばれ、既存のチェック結果に追記される。
//
// 検証は4方向:
//   ① 区分計算書の内部（様式1号→様式2号→付表の連動と、あん分の端数処理）
//   ② 決算書との整合（総額欄は決算書と一致するはず）
//   ③ 法人税申告書との整合（当期純利益・納税充当金・仮計＝別表四(34)）
//   ④ 県税申告書との整合と、収入割・所得割の税額計算そのものの検算
import type { CheckResult } from './types'
import { mk, mkNote } from './check'
import {
  type Cell,
  type DenkiWorkbook,
  type Form2Row,
  type FuhyoBlock,
  normLabel,
  roundDown0,
  roundDownDigits,
  roundHalfUpDigits,
} from './denki-excel'
import type { Beppyo52Pay, Rokugo2, RokugoB5, RokugoB6, RokugoB9 } from './denki-form'

// ---------- グループ名（レポートの見出し。' ⇔ ' で左右の書類名になる） ----------

const G_IN = '区分計算書 ⇔ 様式どおりの再計算'
const G_PL = '決算書 ⇔ 区分計算書'
const G_B4 = '法人税申告書 ⇔ 区分計算書'
const G_RK = '区分計算書 ⇔ 県税申告書'
const G_TX = '県税申告書 ⇔ 法令どおりの税額計算'

// ---------- 端数処理 ----------

/** 課税標準の1,000円未満切捨（欠損のときは0） */
const trunc1000 = (v: number) => (v > 0 ? Math.floor(v / 1000) * 1000 : 0)
/** 税額の100円未満切捨 */
const trunc100 = (v: number) => (v > 0 ? Math.floor(v / 100) * 100 : 0)

// ---------- 電気供給業の標準税率（法定。超過課税・改正で変わりうるので参考表示に留める） ----------

/** 地方税法72条の2第1項の事業区分ごとの標準税率（％）。
 *  実際の検算は申告書に印字された税率を使い、この表とのズレは「参考」として出す。 */
const STD_RATE = {
  /** 第2号事業（送配電事業・導管ガス供給業・保険業）の収入割 */
  shunyu2: 1.0,
  /** 第3号事業（小売電気事業等・発電事業等・特定卸供給事業）の収入割 */
  shunyu3: 0.75,
  /** 第3号事業の所得割（所得の段階区分はなく一律） */
  shotoku3: 1.85,
  /** 特別法人事業税：第1号事業の所得割額に対する税率（外形標準課税の対象外法人） */
  tokubetsu1: 37.0,
  /** 特別法人事業税：第2号事業の収入割額に対する税率 */
  tokubetsu2: 30.0,
  /** 特別法人事業税：第3号事業の収入割額に対する税率 */
  tokubetsu3: 40.0,
}

// ---------- 入力 ----------

export interface DenkiCheckInput {
  denki: DenkiWorkbook
  rokugo2: Rokugo2 | null
  rokugoB5: RokugoB5[]
  rokugoB6: RokugoB6 | null
  rokugoB9: RokugoB9[]
  /** 決算書（PL/BS）の科目→金額。完全一致で最初の値を返す */
  fs: (...labels: string[]) => number | null
  /** 決算書から拾えた科目名の一覧（名称のゆらぎを吸収した照合に使う） */
  fsLabels: string[]
  /** 別表四の指定行（①総額） */
  b4Row: (no: number) => number | null
  /** 別表五(二)の納付状況（事業税の損金算入額の検算に使う） */
  beppyo52: Beppyo52Pay
  /** 決算書のページがあるか */
  hasFs: boolean
  /** 法人税別表四のページがあるか */
  hasB4: boolean
}

// ---------- セル・行のヘルパー ----------

const num = (c: Cell | undefined): number | null => (c ? c.num : null)

/** 総額欄は合っていても他の列がずれていることがある。
 *  列ごとの不一致があれば、総額が一致していても「要確認」に落とす。 */
function withCols(c: CheckResult, bad: string[]): CheckResult {
  if (bad.length && c.status === 'ok') c.status = 'warn'
  return c
}
/** 空欄は 0 として扱う（様式では未記入＝0） */
const z = (c: Cell | undefined): number => (c && c.num != null ? c.num : 0)

/** 様式2号の行ラベル照合用キー（全角数字・括弧・空白の差を吸収） */
function key2(s: string): string {
  return normLabel(s)
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
    .replace(/[（）()「」]/g, '')
}

type ColKey = 'total' | 'shotokuFix' | 'shotokuApp' | 'denkiFix' | 'denkiApp' | 'kyotsu'
const COL_LABEL: Record<ColKey, string> = {
  total: '総額',
  shotokuFix: '所得課税事業（区分）',
  shotokuApp: '所得課税事業（あん分）',
  denkiFix: '電気供給業（区分）',
  denkiApp: '電気供給業（あん分）',
  kyotsu: '共通',
}

// ---------- 本体 ----------

export function buildDenkiChecks(input: DenkiCheckInput): CheckResult[] {
  const out: CheckResult[] = []
  const { denki, rokugo2, rokugoB5, rokugoB6, rokugoB9, fs, b4Row, hasFs, hasB4 } = input
  const f1 = denki.form1
  const f2 = denki.form2

  for (const w of denki.warnings) out.push(mkNote(G_IN, '読み取りの注意', 'info', w))

  // 数式の計算結果がファイルに保存されていないと、様式に記載された金額が読み取れない。
  // この状態で照合しても意味のない差が大量に出るため、ここで打ち切って対処法を伝える。
  if (denki.missingValues > 0) {
    out.push(
      mkNote(
        G_IN,
        '区分計算書のExcelに計算結果が保存されていません',
        'warn',
        `自動計算されるはずの欄 ${denki.missingValues} か所に計算結果が入っていません。` +
          'このままでは記載金額を読み取れないため、区分計算書の照合を中止しました。' +
          'Excel（またはLibreOffice等）でこのファイルを開き、そのまま上書き保存してから、もう一度アップロードしてください。' +
          'なお、申告書PDFだけのチェックはこれまでどおり行っています。',
      ),
    )
    return out
  }
  if (denki.handTyped > 0) {
    out.push(
      mkNote(
        G_IN,
        '自動計算される欄が手入力になっています',
        'info',
        `小計・あん分率・合計など、本来は数式で自動計算される欄 ${denki.handTyped} か所が手入力の数値になっています。` +
          '意図した入力であれば問題ありませんが、他の欄を直したときに追随しないため、県の様式の数式を残したまま入力することをおすすめします。',
      ),
    )
  }

  const rowOf = (label: string): Form2Row | null => {
    const k = key2(label)
    for (const r of f2.rows) if (key2(r.label) === k) return r
    return null
  }
  /** parent の次行から end の直前までの明細行 */
  const blockRows = (parent: string, end: string): Form2Row[] => {
    const kp = key2(parent)
    const ke = key2(end)
    const i = f2.rows.findIndex((r) => key2(r.label) === kp)
    if (i < 0) return []
    let j = f2.rows.findIndex((r, idx) => idx > i && key2(r.label) === ke)
    if (j < 0) j = f2.rows.length
    return f2.rows.slice(i + 1, j)
  }

  // ===== ① 様式1号：小計とあん分率 =====

  const it = (n: number) => f1.items.get(n)
  const i1 = z(it(1)), i2 = z(it(2)), i3 = num(it(3))
  const i4 = z(it(4)), i5 = z(it(5)), i6 = z(it(6)), i7 = z(it(7)), i8 = z(it(8)), i9 = num(it(9))

  out.push(
    mk(G_IN, '様式1号 (3) 収入金分の小計', '記載値', i3, '(1)＋(2)', i1 + i2, {
      note: '電気事業営業収入と、その売上に係る法人税別表四の加算・減算の合計',
    }),
  )
  out.push(
    mk(G_IN, '様式1号 (9) 所得金分の小計', '記載値', i9, '(4)＋(5)＋(6)＋(7)＋(8)', i4 + i5 + i6 + i7 + i8),
  )

  if (i3 != null && i9 != null) {
    const minor = Math.min(i3, i9)
    const major = Math.max(i3, i9)
    out.push(mk(G_IN, '様式1号 従たる事業の売上金額', '記載値', num(f1.judgeMinor), '(3)と(9)の小さい方', minor))
    out.push(mk(G_IN, '様式1号 主たる事業の売上金額', '記載値', num(f1.judgeMajor), '(3)と(9)の大きい方', major))

    // 判定比率は小数第3位。レポートで桁が落ちないよう1000倍の整数で比較する
    const ratio = major ? roundHalfUpDigits(minor / major, 3) : 0
    const shown = num(f1.judgeRatio)
    out.push(
      mk(
        G_IN,
        'あん分計算の要否判定（比率×1,000）',
        '記載値',
        shown == null ? null : Math.round(shown * 1000),
        '従たる÷主たる（小数第3位）',
        Math.round(ratio * 1000),
        {
          note:
            `記載値 ${shown == null ? '－' : shown} ／ 再計算 ${ratio}。` +
            (ratio > 0.1
              ? '0.1を超えるため、収入金額課税分と所得金額課税分をあん分して申告する必要がある。'
              : '0.1以下のため、主たる事業の課税方式によって申告しても差し支えない。'),
        },
      ),
    )

    const denom = i3 + i9
    const anbun = denom ? roundDownDigits(i9 / denom, 8) : 0
    out.push(mk(G_IN, '様式1号 あん分率の分子 (9)', '記載値', num(f1.anbunNumer), '(9)', i9))
    out.push(mk(G_IN, '様式1号 あん分率の分母 (3)＋(9)', '記載値', num(f1.anbunDenom), '(3)＋(9)', denom))
    const shownAnbun = num(f1.anbunRatio)
    out.push(
      mk(
        G_IN,
        '様式1号 (10) あん分率（×1億）',
        '記載値',
        shownAnbun == null ? null : Math.round(shownAnbun * 1e8),
        '(9)÷((3)＋(9))（小数第9位以下切捨）',
        Math.round(anbun * 1e8),
        { note: `記載値 ${shownAnbun == null ? '－' : shownAnbun} ／ 再計算 ${anbun}。第9位以下は切り捨てる。` },
      ),
    )
  }

  // ===== ② 様式2号：あん分率の転記と、共通経費のあん分 =====

  const ratioCell = f2.anbunRatio
  const ratio = ratioCell.num
  out.push(
    mk(
      G_IN,
      '様式2号 ①あん分率（様式1号(10)からの転記・×1億）',
      '様式2号 ①',
      ratio == null ? null : Math.round(ratio * 1e8),
      '様式1号 (10)',
      num(f1.anbunRatio) == null ? null : Math.round((f1.anbunRatio.num as number) * 1e8),
    ),
  )

  // 集計行・段階損益の行は、共通経費に①を掛けるのではなく明細行の集計や差引で求まる。
  // （明細行ごとに1円未満を切り捨てるため、集計行では ③×① と1円ずれることがある）
  const AGGREGATE = new Set(
    [
      '営業収益',
      '営業費用',
      '電気事業営業費用',
      '営業利益',
      '営業外利益',
      '営業外費用',
      '税引前当期純利益',
      '当期純利益',
      '税務加算',
      '税務減算',
      '仮計',
      '合計',
    ].map(key2),
  )

  if (ratio != null) {
    const badApp: string[] = []
    const badRest: string[] = []
    const badCross: string[] = []
    for (const r of f2.rows) {
      if (key2(r.label) === '合計') continue
      const kyotsu = z(r.kyotsu)
      // ②共通経費をあん分（③×①）は1円未満切捨。明細行のみが対象
      const expApp = roundDown0(kyotsu * ratio)
      if (!AGGREGATE.has(key2(r.label)) && (r.shotokuApp.present || kyotsu !== 0)) {
        if (z(r.shotokuApp) !== expApp) {
          badApp.push(`${r.label || `${r.row}行目`}：${z(r.shotokuApp).toLocaleString()}（計算値 ${expApp.toLocaleString()}）`)
        }
      }
      // 電気供給業分の共通経費は ③－②
      const expRest = kyotsu - z(r.shotokuApp)
      if (r.denkiApp.present || kyotsu !== 0) {
        if (z(r.denkiApp) !== expRest) {
          badRest.push(`${r.label || `${r.row}行目`}：${z(r.denkiApp).toLocaleString()}（計算値 ${expRest.toLocaleString()}）`)
        }
      }
      // 総額＝区分＋あん分＋区分＋あん分
      const expTotal = z(r.shotokuFix) + z(r.shotokuApp) + z(r.denkiFix) + z(r.denkiApp)
      if (r.total.present && z(r.total) !== expTotal) {
        badCross.push(`${r.label || `${r.row}行目`}：${z(r.total).toLocaleString()}（計算値 ${expTotal.toLocaleString()}）`)
      }
    }
    const listNote = (bad: string[], okMsg: string) =>
      bad.length ? bad.slice(0, 6).join(' ／ ') + (bad.length > 6 ? ` ほか${bad.length - 6}件` : '') : okMsg

    out.push(
      mk(G_IN, '様式2号 共通経費のあん分（②＝③×①・1円未満切捨）', '不一致の行数', badApp.length, '基準', 0, {
        note: listNote(badApp, 'すべての行であん分額が一致した。'),
      }),
    )
    out.push(
      mk(G_IN, '様式2号 電気供給業分の共通経費（③－②）', '不一致の行数', badRest.length, '基準', 0, {
        note: listNote(badRest, 'すべての行で一致した。'),
      }),
    )
    out.push(
      mk(G_IN, '様式2号 総額＝区分＋あん分の横計', '不一致の行数', badCross.length, '基準', 0, {
        note: listNote(badCross, 'すべての行で横計が一致した。'),
      }),
    )
  }

  // ===== ③ 様式2号：縦計と段階損益 =====

  const cols: ColKey[] = ['total', 'shotokuFix', 'shotokuApp', 'denkiFix', 'denkiApp', 'kyotsu']
  const colSum = (rows: Form2Row[], c: ColKey) => rows.reduce((s, r) => s + z(r[c]), 0)

  /** 縦計行（親＝明細の合計）を全列で検証し、1つのチェックにまとめる。
   *  children を渡した場合はその行だけを足す（入れ子の小計を二重に足さないため） */
  const pushBlockCheck = (parent: string, end: string, label: string, children?: string[]) => {
    const p = rowOf(parent)
    if (!p) return
    const rows = children
      ? (children.map(rowOf).filter(Boolean) as Form2Row[])
      : blockRows(parent, end)
    if (!rows.length) return
    const bad: string[] = []
    for (const c of cols) {
      const exp = colSum(rows, c)
      if (z(p[c]) !== exp) bad.push(`${COL_LABEL[c]}：${z(p[c]).toLocaleString()}（計算値 ${exp.toLocaleString()}）`)
    }
    out.push(
      withCols(
        mk(G_IN, `様式2号 ${label}`, '記載値（総額）', num(p.total), '明細の合計（総額）', colSum(rows, 'total'), {
          note: bad.length
            ? '列ごとの不一致 → ' + bad.join(' ／ ')
            : `${rows.length}行の明細と全列で一致した。`,
        }),
        bad,
      ),
    )
  }
  pushBlockCheck('営業収益', '営業費用', '営業収益の縦計', [
    '電気事業営業収益',
    '附帯事業営業収益',
    'その他の事業営業収益',
  ])
  pushBlockCheck('営業費用', '営業利益', '営業費用の縦計', [
    '電気事業営業費用',
    '附帯事業営業費用',
    'その他の事業営業費用',
  ])
  pushBlockCheck('電気事業営業費用', '附帯事業営業費用', '電気事業営業費用の縦計')
  pushBlockCheck('営業外利益', '営業外費用', '営業外利益の縦計')
  pushBlockCheck('営業外費用', '特別利益', '営業外費用の縦計')
  pushBlockCheck('税務加算', '税務減算', '税務加算の縦計')
  pushBlockCheck('税務減算', '事業税加算', '税務減算の縦計')

  /** 段階損益（引き算・足し算で導かれる行）を全列で検証 */
  const pushDerived = (
    target: string,
    label: string,
    plus: string[],
    minus: string[],
  ) => {
    const t = rowOf(target)
    if (!t) return
    const rs = [...plus, ...minus].map(rowOf)
    if (rs.some((r) => !r)) return
    const bad: string[] = []
    let expTotal = 0
    for (const c of cols) {
      let exp = 0
      for (const l of plus) exp += z(rowOf(l)![c])
      for (const l of minus) exp -= z(rowOf(l)![c])
      if (c === 'total') expTotal = exp
      if (z(t[c]) !== exp) bad.push(`${COL_LABEL[c]}：${z(t[c]).toLocaleString()}（計算値 ${exp.toLocaleString()}）`)
    }
    out.push(
      withCols(
        mk(G_IN, `様式2号 ${label}`, '記載値（総額）', num(t.total), '計算値（総額）', expTotal, {
          note: bad.length ? '列ごとの不一致 → ' + bad.join(' ／ ') : '全列で一致した。',
        }),
        bad,
      ),
    )
  }
  pushDerived('営業利益', '営業利益＝営業収益－営業費用', ['営業収益'], ['営業費用'])
  pushDerived(
    '税引前当期純利益',
    '税引前当期純利益＝営業利益＋営業外利益＋特別利益－営業外費用－特別損失',
    ['営業利益', '営業外利益', '特別利益'],
    ['営業外費用', '特別損失'],
  )
  pushDerived(
    '当期純利益',
    '当期純利益＝税引前当期純利益－法人税及び法人住民税',
    ['税引前当期純利益'],
    ['法人税及び法人住民税'],
  )
  pushDerived(
    '仮計',
    '仮計＝当期純利益＋税務加算＋事業税加算－税務減算－事業税減算',
    ['当期純利益', '税務加算', '事業税加算'],
    ['税務減算', '事業税減算'],
  )

  // 合計（課税標準となる所得金額）
  const karikei = rowOf('仮計')
  if (karikei) {
    out.push(
      mk(
        G_IN,
        '様式2号 合計 所得課税事業分（ｲ＋ﾛ）',
        '記載値',
        num(f2.totalShotoku),
        '仮計の「区分」＋「あん分」',
        z(karikei.shotokuFix) + z(karikei.shotokuApp),
      ),
    )
    out.push(
      mk(
        G_IN,
        '様式2号 合計 電気供給業分（ﾊ＋ﾆ）',
        '記載値',
        num(f2.totalDenki),
        '仮計の「区分」＋「あん分」',
        z(karikei.denkiFix) + z(karikei.denkiApp),
      ),
    )
    out.push(
      mk(
        G_IN,
        '様式2号 合計 総額',
        '記載値',
        num(f2.totalAll),
        '所得課税事業分＋電気供給業分',
        z(f2.totalShotoku) + z(f2.totalDenki),
      ),
    )
  }

  // ===== ④ 付表の内部整合と、様式2号への転記 =====

  const fuhyoChecks = (blocks: FuhyoBlock[], sheet: string, linkLabel: (name: string) => string | null) => {
    for (const b of blocks) {
      const bad: string[] = []
      const FU_LABEL = { total: '総額', shotoku: '所得課税事業分', denki: '電気供給業分', kyotsu: '共通分' } as const
      for (const col of ['total', 'shotoku', 'denki', 'kyotsu'] as const) {
        const exp = b.details.reduce((s, d) => s + z(d[col]), 0)
        if (z(b.sum[col]) !== exp) {
          bad.push(`${FU_LABEL[col]}：${z(b.sum[col]).toLocaleString()}（計算値 ${exp.toLocaleString()}）`)
        }
      }
      const crossBad = b.details.filter(
        (d) => d.total.present && z(d.total) !== z(d.shotoku) + z(d.denki) + z(d.kyotsu),
      )
      out.push(
        withCols(
          mk(
            G_IN,
            `${sheet}（${b.name}）合計`,
            '記載値（総額）',
            num(b.sum.total),
            '明細の合計',
            b.details.reduce((s, d) => s + z(d.total), 0),
            {
              note:
                (bad.length ? '列ごとの不一致 → ' + bad.join(' ／ ') + '。' : `明細${b.details.length}行と全列で一致した。`) +
                (crossBad.length
                  ? ` 総額＝所得課税＋電気＋共通 が合わない行：${crossBad.map((d) => d.label || `${d.row}行目`).join('、')}`
                  : ''),
            },
          ),
          [...bad, ...crossBad.map((d) => d.label || `${d.row}行目`)],
        ),
      )
      // 様式2号の「付表◯計」行への転記
      const link = linkLabel(b.name)
      const r = link ? rowOf(link) : null
      if (r) {
        out.push(
          mk(G_IN, `${sheet}（${b.name}）→ 様式2号「${link}」所得課税事業分`, '様式2号', num(r.shotokuFix), sheet, num(b.sum.shotoku)),
        )
        out.push(
          mk(G_IN, `${sheet}（${b.name}）→ 様式2号「${link}」電気供給業分`, '様式2号', num(r.denkiFix), sheet, num(b.sum.denki)),
        )
        out.push(
          mk(G_IN, `${sheet}（${b.name}）→ 様式2号「${link}」共通分`, '様式2号', num(r.kyotsu), sheet, num(b.sum.kyotsu)),
        )
      }
    }
  }
  fuhyoChecks(denki.fuhyo1, '付表1', () => '付表1（販管費）計')
  fuhyoChecks(denki.fuhyo2, '付表2', (n) => (/収益|利益/.test(n) ? '付表2（営業外利益）計' : '付表2（営業外費用）計'))
  fuhyoChecks(denki.fuhyo3, '付表3', (n) => (/加算/.test(n) ? '付表3（税務加算）計' : '付表3（税務減算）計'))

  // ===== ⑤ 決算書との整合（総額欄は決算書と一致するはず） =====

  if (hasFs) {
    const uriage = fs('総売上高', '売上高', '売上高合計', '純売上高', '営業収益合計', '売上高計')
    const eigyoRieki = fs('営業利益', '営業損失')
    const hankanhi = fs('販売費及び一般管理費合計', '販売費及び一般管理費計', '販売費及び一般管理費')
    const eigyogaiEki = fs('営業外収益合計', '営業外収益計')
    const eigyogaiHi = fs('営業外費用合計', '営業外費用計')
    const zeibiki = fs('税引前当期純利益', '税引前当期純損失', '税引前当期利益')
    const hojinzei = fs('法人税等合計', '法人税、住民税及び事業税', '法人税住民税及び事業税', '法人税等')
    const tojun = fs('当期純利益', '当期純損失')

    if (i3 != null && i9 != null) {
      out.push(
        mk(G_PL, '売上高 ⇔ 様式1号 (3)＋(9)', 'PL 売上高', uriage, '様式1号 (3)＋(9)', i3 + i9, {
          note: '電気事業営業収入とその他の事業営業収益の合計が、決算書の売上高と一致するか',
        }),
      )
    }
    const r営業収益 = rowOf('営業収益')
    if (r営業収益) out.push(mk(G_PL, '売上高 ⇔ 様式2号 営業収益', 'PL 売上高', uriage, '様式2号 営業収益（総額）', num(r営業収益.total)))
    const r営業費用 = rowOf('営業費用')
    if (r営業費用 && uriage != null && eigyoRieki != null) {
      out.push(
        mk(G_PL, '営業費用', 'PL 売上高－営業利益', uriage - eigyoRieki, '様式2号 営業費用（総額）', num(r営業費用.total), {
          note: '売上原価と販売費及び一般管理費の合計にあたる',
        }),
      )
    }
    const r販管 = rowOf('付表1（販管費）計')
    if (r販管) out.push(mk(G_PL, '販売費及び一般管理費', 'PL 販管費合計', hankanhi, '様式2号 付表1（販管費）計（総額）', num(r販管.total)))
    const r営業利益 = rowOf('営業利益')
    if (r営業利益) out.push(mk(G_PL, '営業利益', 'PL 営業利益', eigyoRieki, '様式2号 営業利益（総額）', num(r営業利益.total)))
    const r営業外利益 = rowOf('営業外利益')
    if (r営業外利益 && eigyogaiEki != null) {
      out.push(mk(G_PL, '営業外収益', 'PL 営業外収益合計', eigyogaiEki, '様式2号 営業外利益（総額）', num(r営業外利益.total)))
    }
    const r営業外費用 = rowOf('営業外費用')
    if (r営業外費用 && eigyogaiHi != null) {
      out.push(mk(G_PL, '営業外費用', 'PL 営業外費用合計', eigyogaiHi, '様式2号 営業外費用（総額）', num(r営業外費用.total)))
    }
    const r税引前 = rowOf('税引前当期純利益')
    if (r税引前) out.push(mk(G_PL, '税引前当期純利益', 'PL 税引前当期純利益', zeibiki, '様式2号（総額）', num(r税引前.total)))
    const r法人税 = rowOf('法人税及び法人住民税')
    if (r法人税) {
      out.push(
        mk(G_PL, '法人税・住民税等', 'PL 法人税等合計', hojinzei, '様式2号 法人税及び法人住民税（総額）', num(r法人税.total), {
          note: '決算書の「法人税、住民税及び事業税」には事業税も含まれるため、事業税を別に計上している場合は差が出る',
          infoOnly: true,
        }),
      )
    }
    const r当期純利益 = rowOf('当期純利益')
    if (r当期純利益) out.push(mk(G_PL, '当期純利益', 'PL 当期純利益', tojun, '様式2号 当期純利益（総額）', num(r当期純利益.total)))

    // 付表1の科目と決算書の販管費科目の照合（名称のゆらぎがあるため参考扱い）
    // 「旅費交通費／旅費及び交通費」「支払保険料／保険料」のような表記差は同一とみなす
    const fuzzy = (s: string) =>
      normLabel(s)
        .replace(/及び/g, '')
        .replace(/^支払/, '')
        .replace(/等$/, '')
    const fuzzyMap = new Map<string, string>()
    for (const lab of input.fsLabels) {
      const k = fuzzy(lab)
      if (!fuzzyMap.has(k)) fuzzyMap.set(k, lab)
    }
    for (const b of denki.fuhyo1) {
      const diffs: string[] = []
      let matched = 0
      // 様式にあらかじめ印字されているだけで金額の入っていない行は照合対象にしない
      const used = b.details.filter(
        (d) => d.label && (z(d.total) !== 0 || d.shotoku.present || d.denki.present || d.kyotsu.present),
      )
      for (const d of used) {
        const hit = fs(d.label) != null ? d.label : fuzzyMap.get(fuzzy(d.label))
        const plv = hit ? fs(hit) : null
        if (plv == null) {
          diffs.push(`${d.label}：決算書に同名の科目なし`)
          continue
        }
        if (plv !== z(d.total)) {
          diffs.push(
            `${d.label}：付表 ${z(d.total).toLocaleString()} ／ 決算書${hit === d.label ? '' : `「${hit}」`} ${plv.toLocaleString()}`,
          )
        } else matched++
      }
      out.push(
        mk(G_PL, '付表1の科目と決算書の科目の照合（参考）', '同名・同額で確認できた科目数', matched, '付表1の科目数', used.length, {
          infoOnly: true,
          note:
            diffs.length === 0
              ? 'すべての科目が同名・同額で見つかった。'
              : '「給料手当＋賞与」のように決算書の複数科目をまとめて記載した場合も差として出るため、誤りとは限らない。' +
                ' → ' +
                diffs.slice(0, 8).join(' ／ ') +
                (diffs.length > 8 ? ` ほか${diffs.length - 8}件` : ''),
        }),
      )
    }
  } else {
    out.push(mkNote(G_PL, '決算書との突合', 'na', '決算書（損益計算書）のPDFが読み取れなかったため、この照合は省略した。'))
  }

  // ===== ⑥ 法人税申告書との整合 =====

  if (hasB4) {
    const r当期純利益 = rowOf('当期純利益')
    if (r当期純利益) {
      out.push(mk(G_B4, '当期利益', '別表四(1) 当期利益又は当期欠損の額', b4Row(1), '様式2号 当期純利益（総額）', num(r当期純利益.total)))
    }
    const r充当金 = rowOf('損金計上納税充当金')
    if (r充当金) {
      out.push(
        mk(G_B4, '損金経理をした納税充当金', '別表四(4)', b4Row(4), '様式2号 損金計上納税充当金（総額）', num(r充当金.total)),
      )
    }
    const r事業税減算 = rowOf('事業税減算')
    if (r事業税減算) {
      out.push(
        mk(G_B4, '納税充当金から支出した事業税等', '別表四(13)', b4Row(13), '様式2号 事業税減算（総額）', num(r事業税減算.total)),
      )
    }
    const r所得税 = rowOf('控除所得税額')
    if (r所得税) {
      out.push(
        mk(G_B4, '法人税額から控除される所得税額', '別表四(29)', b4Row(29), '様式2号 控除所得税額（総額）', num(r所得税.total)),
      )
    }
    // 事業税は納付した事業年度の損金になる。区分計算書の3行（法人税及び法人住民税・
    // 損金計上納税充当金・事業税減算）から導かれる正味の損金算入額が、
    // 別表五(二)の実際の納付額と一致するかを見る。区分の付け間違いはここに必ず現れる。
    const b52 = input.beppyo52
    const r34n = rowOf('法人税及び法人住民税')
    const r37n = rowOf('損金計上納税充当金')
    const r47n = rowOf('事業税減算')
    if (r34n && r37n && r47n && (b52.jigyozeiJutokin != null || b52.jigyozeiSonkin != null)) {
      const netOf = (c: ColKey) => z(r34n[c]) - z(r37n[c]) + z(r47n[c])
      // 事業税は事業区分ごとに直課するので、正味の損金算入額は「区分されている」欄から出る。
      // 共通欄に入るのは法人税・住民税で、これは全額が納税充当金なので正味は0（中間納付を
      // 損金経理していればその額）になる。事業税を共通に入れてしまう誤りはここで出る。
      const netFix = netOf('shotokuFix') + netOf('denkiFix')
      const netApp = netOf('shotokuApp') + netOf('denkiApp')
      const actual = (b52.jigyozeiJutokin ?? 0) + (b52.jigyozeiSonkin ?? 0)
      const expectedApp = b52.hojinzeiSonkin ?? 0
      const bad = netApp !== expectedApp ? [`共通のあん分列の正味 ${netApp.toLocaleString()}`] : []
      out.push(
        withCols(
          mk(
            G_B4,
            '事業税・特別法人事業税の正味の損金算入額',
            '様式2号 区分欄（法人税及び法人住民税－損金計上納税充当金＋事業税減算）',
            netFix,
            '別表五(二) (19)の③充当金取崩＋⑤損金経理',
            actual,
            {
              note:
                `所得課税事業 ${netOf('shotokuFix').toLocaleString()} ／ 電気供給業 ${netOf('denkiFix').toLocaleString()} ／ ` +
                `共通をあん分した分 ${netApp.toLocaleString()}（法人税・住民税の損金経理納付 ${expectedApp.toLocaleString()} と一致するはず）。` +
                '事業税は納付した期の損金になるため、区分に直課した分の正味は実際の納付額と一致する。' +
                '決算書で事業税を租税公課に計上している場合や、源泉所得税等を法人税等に含めている場合は一致しない。',
            },
          ),
          bad,
        ),
      )
    }

    const gokei34 = b4Row(34)
    out.push(
      mk(G_B4, '所得金額（合計）', '別表四(34) 合計', gokei34, '様式2号 仮計（総額）', num(karikei?.total ?? undefined), {
        note: '区分計算書の総額欄は、事業区分に分ける前の法人税の所得金額と一致するはず',
      }),
    )
    out.push(mk(G_B4, '所得金額（合計）⇔ 様式2号 合計', '別表四(34) 合計', gokei34, '様式2号 合計（総額）', num(f2.totalAll)))
  } else {
    out.push(mkNote(G_B4, '法人税別表四との突合', 'na', '法人税 別表四のPDFが読み取れなかったため、この照合は省略した。'))
  }

  // ===== ⑦ 県税申告書との整合 =====

  if (rokugo2 || rokugoB5.length || rokugoB6) {
    // 別表五（2枚）は表題が同一で号数を文字から判別できないため、金額で対応づける
    const b5vals = rokugoB5.map((b) => b.gokei35 ?? b.shotoku1)
    const eShotoku = num(f2.totalShotoku)
    const eDenki = num(f2.totalDenki)
    let iShotoku = b5vals.findIndex((v) => v != null && eShotoku != null && v === eShotoku)
    let iDenki = b5vals.findIndex((v) => v != null && eDenki != null && v === eDenki && b5vals.indexOf(v) !== iShotoku)
    // 一方だけ一致した場合、2枚しかないなら残りの1枚がもう一方の区分。
    // 金額がずれていても「どちらと比べるべきか」を示せるようにする
    if (b5vals.length === 2) {
      if (iShotoku >= 0 && iDenki < 0) iDenki = 1 - iShotoku
      else if (iDenki >= 0 && iShotoku < 0) iShotoku = 1 - iDenki
    }
    const b5Shotoku = iShotoku >= 0 ? b5vals[iShotoku] : null
    const b5Denki = iDenki >= 0 ? b5vals[iDenki] : null

    if (rokugoB5.length) {
      out.push(
        mk(
          G_RK,
          '別表五（所得課税事業分）合計(35)',
          '様式2号 合計 所得課税事業分',
          eShotoku,
          '第六号様式別表五 (35)',
          b5Shotoku ?? (rokugoB5.length === 1 ? b5vals[0] ?? null : null),
          {
            note:
              rokugoB5.length >= 2
                ? '別表五は事業区分ごとに2枚あるが、様式上どちらの号かは丸印（図形）で示されるため、金額で対応づけている。'
                : '別表五が1枚しか見つからなかった。事業区分ごとに2枚必要かご確認ください。',
          },
        ),
      )
      out.push(
        mk(G_RK, '別表五（電気供給業分）合計(35)', '様式2号 合計 電気供給業分', eDenki, '第六号様式別表五 (35)', b5Denki ?? null),
      )
      // 2枚の(1)の合計＝法人税の所得金額
      const sum1 = rokugoB5.reduce<number | null>((s, b) => (s == null || b.shotoku1 == null ? null : s + b.shotoku1), 0)
      out.push(
        mk(G_RK, '別表五(1)の合計 ⇔ 様式2号 合計（総額）', '別表五(1)の合計', sum1, '様式2号 合計（総額）', num(f2.totalAll), {
          note: '事業区分ごとに分けた所得の合計は、分ける前の法人税の所得金額と一致する',
        }),
      )
    }

    if (rokugo2) {
      out.push(
        mk(G_RK, '第六号様式(28) 第1号事業の所得金額総額', '様式2号 合計 所得課税事業分', eShotoku, '第六号様式 (28)', rokugo2.shotoku1.total),
      )
      out.push(
        mk(G_RK, '第六号様式(40) 第3号事業の所得金額総額', '様式2号 合計 電気供給業分', eDenki, '第六号様式 (40)', rokugo2.shotoku3.total),
      )
      out.push(
        mk(G_RK, '第六号様式(46) 収入金額総額 ⇔ 様式1号(1)', '様式1号 (1) 電気事業営業収入', num(it(1)), '第六号様式 (46)', rokugo2.shunyu3.total, {
          note: '収入割の課税標準は電気供給業の収入金額。区分計算書の電気事業営業収入と一致するはず',
        }),
      )
      if (hasB4) {
        out.push(
          mk(G_RK, '第六号様式(76) 法人税の所得金額', '別表四(52)', b4Row(52), '第六号様式 (76)', rokugo2.hojinzeiShotoku),
        )
      }
      // 「法人税及び法人住民税」のうち事業区分に直課される部分は、その区分の
      // 事業税＋特別法人事業税の年税額。法人税・地方法人税・住民税は会社全体の税なので共通に入る。
      const r34 = rowOf('法人税及び法人住民税')
      if (r34) {
        const sum = (...v: (number | null)[]) => v.reduce<number>((s, x) => s + (x ?? 0), 0)
        const hasAny = (...v: (number | null)[]) => v.some((x) => x != null)
        const NOTE_34 =
          '会社全体にかかる法人税・地方法人税・道府県民税・市町村民税は共通欄へ、' +
          '事業区分ごとに計算される事業税と特別法人事業税は各区分の欄へ入る。' +
          '決算書で事業税を租税公課に計上している場合や、事業税の確定分を未払計上していない場合は一致しない。'
        // 電気供給業（第2号・第3号事業）
        const denkiTax = sum(
          rokugo2.shunyu2.tax,
          rokugo2.shotoku3.tax,
          rokugo2.fukakachiTax43,
          rokugo2.shihonTax45,
          rokugo2.shunyu3.tax,
          rokugo2.tokubetsu2.tax,
          rokugo2.tokubetsu3.tax,
        )
        if (
          hasAny(rokugo2.shotoku3.tax, rokugo2.shunyu3.tax, rokugo2.tokubetsu3.tax, rokugo2.shunyu2.tax)
        ) {
          const c = mk(
            G_RK,
            '様式2号「法人税及び法人住民税」電気供給業に区分された額',
            '様式2号（電気供給業・区分）',
            z(r34.denkiFix),
            '(39)＋(41)＋(43)＋(45)＋(47)＋(66)＋(67)',
            denkiTax,
            {
              note:
                `電気供給業の事業税と特別法人事業税の年税額（中間納付分＋確定分）。${NOTE_34}`,
              // 事業税を法人税等に含めていない決算だと0になる。誤りとは限らないので参考に落とす
              infoOnly: z(r34.denkiFix) === 0 && denkiTax !== 0,
            },
          )
          out.push(c)
        }
        // 所得課税事業（第1号事業）
        const shotokuTax = sum(
          (rokugo2.shotoku1Tax33 ?? 0) > 0 ? rokugo2.shotoku1Tax33 : rokugo2.shotoku1Tax32,
          rokugo2.fukakachiTax35,
          rokugo2.shihonTax37,
          rokugo2.tokubetsu1.tax,
        )
        if (hasAny(rokugo2.shotoku1Tax32, rokugo2.shotoku1Tax33, rokugo2.tokubetsu1.tax)) {
          out.push(
            mk(
              G_RK,
              '様式2号「法人税及び法人住民税」所得課税事業に区分された額',
              '様式2号（所得課税事業・区分）',
              z(r34.shotokuFix),
              '(32)又は(33)＋(35)＋(37)＋(65)',
              shotokuTax,
              {
                note: `所得課税事業の事業税と特別法人事業税の年税額。${NOTE_34}`,
                infoOnly: z(r34.shotokuFix) === 0 && shotokuTax !== 0,
              },
            ),
          )
        }
        // 共通に残るのは会社全体の税。区分に直課した分を差し引いた残り
        out.push(
          mk(
            G_RK,
            '様式2号「法人税及び法人住民税」の区分と総額',
            '総額',
            num(r34.total),
            '共通＋所得課税事業（区分）＋電気供給業（区分）',
            z(r34.kyotsu) + z(r34.shotokuFix) + z(r34.denkiFix),
            { note: '共通欄には法人税・地方法人税・道府県民税・市町村民税が入る' },
          ),
        )
      }

      // 納税充当金に含めた事業税等（この申告により納付すべき額）との突合。
      // 第2号事業がある場合、内訳(55)〜(58)に第1号と第2号が混在するため対象外にする
      const r37 = rowOf('損金計上納税充当金')
      const has2go = (rokugo2.shunyu2.total ?? 0) !== 0
      if (r37 && !has2go && (rokugo2.nofu59 != null || rokugo2.nofu62 != null || rokugo2.nofu73 != null)) {
        const nofuDenki =
          (rokugo2.nofu59 ?? 0) + (rokugo2.nofu60 ?? 0) + (rokugo2.nofu61 ?? 0) + (rokugo2.nofu62 ?? 0) + (rokugo2.nofu73 ?? 0)
        out.push(
          mk(
            G_RK,
            '様式2号「損金計上納税充当金」電気供給業に区分された額',
            '様式2号（電気供給業・区分）',
            z(r37.denkiFix),
            '(59)＋(60)＋(61)＋(62)＋(73)',
            nofuDenki,
            {
              note:
                'この申告により納付すべき事業税額のうち第3号事業分と、納付すべき特別法人事業税額。' +
                '納税充当金に事業税の確定分を含めていない場合は一致しない。',
              infoOnly: z(r37.denkiFix) === 0 && nofuDenki !== 0,
            },
          ),
        )
      }

      if (rokugo2.gyoshu && !/電気|発電|太陽光/.test(rokugo2.gyoshu)) {
        out.push(
          mkNote(
            G_RK,
            '事業種目の記載',
            'info',
            `第六号様式の事業種目が「${rokugo2.gyoshu}」となっている。電気供給業を営んでいる旨（例：電気供給事業）の記載があるかご確認ください。`,
          ),
        )
      }
    }

    if (rokugoB6) {
      out.push(
        mk(G_RK, '別表六 (3) 差引計', '(1)－(2)', (rokugoB6.total1 ?? 0) - (rokugoB6.deduct2 ?? 0), '第六号様式別表六 (3)', rokugoB6.diff3, {
          note: '収入金額の総額から、控除される金額を差し引いた額',
        }),
      )
      out.push(
        mk(G_RK, '別表六 (13) 計 ⇔ 様式1号(1)', '様式1号 (1) 電気事業営業収入', num(it(1)), '第六号様式別表六 (13)', rokugoB6.final13),
      )
      if (rokugo2) {
        out.push(mk(G_RK, '別表六 (13) ⇔ 第六号様式(46)', '第六号様式別表六 (13)', rokugoB6.final13, '第六号様式 (46)', rokugo2.shunyu3.total))
      }
      out.push(
        mkNote(
          G_RK,
          '収入割の課税標準は消費税抜き',
          'info',
          '料金とあわせて受け取る消費税及び地方消費税に相当する額は収入金額に含めない（税抜き）。' +
            'ただし免税事業者など、消費税として納付しない金額は収入金額に含める。売電収入をどちらで計上しているかご確認ください。',
        ),
      )
      const denkiItem = rokugoB6.items.find((x) => /電気|発電|売電/.test(x.label))
      if (denkiItem) {
        out.push(
          mk(G_RK, '別表六 電気供給事業の収入金額', '様式1号 (1) 電気事業営業収入', num(it(1)), `別表六「${denkiItem.label}」`, denkiItem.amount),
        )
      }
      const nonDenki = rokugoB6.items.filter((x) => !/電気|発電|売電/.test(x.label))
      if (nonDenki.length) {
        const deducted = nonDenki.filter((x) => rokugoB6.deductItems.some((d) => d.label === x.label && d.amount === x.amount))
        out.push(
          mkNote(
            G_RK,
            '別表六 収入金額の総額に含めた電気供給業以外の収入',
            deducted.length === nonDenki.length ? 'info' : 'warn',
            `「${nonDenki.map((x) => `${x.label} ${x.amount.toLocaleString()}円`).join('、')}」を収入金額の総額に計上している。` +
              (deducted.length === nonDenki.length
                ? '同額が控除される金額に計上されているため、収入割の課税標準には影響しない。'
                : '控除される金額に同額の計上が見当たらない。電気供給業に係る収入以外は収入割の課税標準に含めない。'),
          ),
        )
      }
    }

    if (rokugoB9.length) {
      for (const b9 of rokugoB9) {
        const cands = [rokugo2?.shotoku1.total ?? null, rokugo2?.shotoku3.total ?? null].filter((v) => v != null)
        const hit = cands.find((v) => v === b9.beforeDeduct)
        out.push(
          mk(
            G_RK,
            `別表九（p${b9.page}）控除前所得金額`,
            '別表九 (1)',
            b9.beforeDeduct,
            '第六号様式 (28)または(40)',
            hit ?? (cands.length === 1 ? (cands[0] as number) : null),
            { note: '欠損金の繰越控除は事業区分ごとに行うため、控除前所得金額はその区分の所得金額と一致する' },
          ),
        )
      }
    }
  } else {
    out.push(
      mkNote(G_RK, '県税申告書との突合', 'na', '第六号様式（事業税・道府県民税の申告書）のPDFが読み取れなかったため、この照合は省略した。'),
    )
  }

  // ===== ⑧ 事業税額そのものの検算 =====

  if (rokugo2) {
    const r = rokugo2
    const segCheck = (
      name: string,
      seg: { total: number | null; base: number | null; rate: number | null; tax: number | null },
      stdRate: number | null,
    ) => {
      if (seg.total == null && seg.base == null && seg.tax == null) return
      if (seg.total != null) {
        out.push(mk(G_TX, `${name} 課税標準（1,000円未満切捨）`, '申告書の記載値', seg.base, '総額を1,000円未満切捨', trunc1000(seg.total)))
      }
      if (seg.base != null && seg.rate != null) {
        out.push(
          mk(G_TX, `${name} 税額（100円未満切捨）`, '申告書の記載値', seg.tax, `課税標準×${seg.rate}％`, trunc100((seg.base * seg.rate) / 100), {
            note: `申告書に印字された税率 ${seg.rate}％ で検算している`,
          }),
        )
      }
      if (stdRate != null && seg.rate != null && Math.abs(seg.rate - stdRate) > 1e-9) {
        out.push(
          mkNote(
            G_TX,
            `${name} の税率`,
            'info',
            `申告書の税率は ${seg.rate}％。標準税率は ${stdRate}％。超過課税や税率改正による違いであれば問題ないが、県の税率表と見比べてご確認ください。`,
          ),
        )
      }
    }
    // 第3号事業の所得割は所得の全額に一律の税率。第1号事業のような段階区分はない
    segCheck('第3号事業 所得割', r.shotoku3, STD_RATE.shotoku3)
    segCheck('第3号事業 収入割', r.shunyu3, STD_RATE.shunyu3)
    if (r.shunyu2.total != null) segCheck('第2号事業 収入割', r.shunyu2, STD_RATE.shunyu2)

    // 事業区分ごとに所得を分けたら、その合計は法人税の所得金額に戻る。
    // 欠損の区分と黒字の区分を通算してしまう誤りは、ここで差として出る。
    if (r.shotoku1.total != null || r.shotoku3.total != null) {
      out.push(
        mk(
          G_TX,
          '事業区分別の所得の合計 ⇔ 法人税の所得金額',
          '(28)＋(40)',
          (r.shotoku1.total ?? 0) + (r.shotoku3.total ?? 0),
          '(76) 法人税の所得金額',
          r.hojinzeiShotoku,
          {
            note:
              '所得割の課税標準は事業区分ごとに計算し、区分をまたいで通算することはできない' +
              '（一方が欠損でも他方の所得から差し引かない）。区分後の合計は法人税の所得金額と一致する。',
          },
        ),
      )
    }

    // 第1号事業の所得割
    if (r.shotoku1.total != null) {
      const tax1 = (r.shotoku1Tax33 ?? 0) > 0 ? r.shotoku1Tax33 : r.shotoku1Tax32
      if (r.shotoku1.total <= 0) {
        out.push(
          mk(G_TX, '第1号事業 所得割税額（欠損のため0）', '申告書の記載値', tax1, '欠損なので0', 0, {
            note: `第1号事業の所得金額総額は ${r.shotoku1.total.toLocaleString()}円（欠損）`,
          }),
        )
      } else {
        const brackets = [r.shotoku1Base29, r.shotoku1Base30, r.shotoku1Base31]
        if (brackets.some((v) => v != null)) {
          out.push(
            mk(
              G_TX,
              '第1号事業 所得割 課税標準の区分合計',
              '(29)＋(30)＋(31)',
              brackets.reduce<number>((s, v) => s + (v ?? 0), 0),
              '(28)を1,000円未満切捨',
              trunc1000(r.shotoku1.total),
              { note: '年400万円以下・400万円超800万円以下・800万円超の各段の合計は、課税標準の全額と一致する' },
            ),
          )
        }
      }
      const parts29 = [r.shotoku1Tax29, r.shotoku1Tax30, r.shotoku1Tax31]
      if (parts29.some((v) => v != null) || r.shotoku1Tax32 != null) {
        out.push(
          mk(
            G_TX,
            '(32) 第1号事業 所得割税額の計',
            '申告書の記載値',
            r.shotoku1Tax32,
            '(29)＋(30)＋(31)',
            parts29.reduce<number>((s, v) => s + (v ?? 0), 0),
          ),
        )
      }
    }

    // 合計事業税額
    const parts = [
      (r.shotoku1Tax33 ?? 0) > 0 ? r.shotoku1Tax33 : r.shotoku1Tax32,
      r.fukakachiTax35,
      r.shihonTax37,
      r.shunyu2.tax,
      r.shotoku3.tax,
      r.fukakachiTax43,
      r.shihonTax45,
      r.shunyu3.tax,
    ]
    if (parts.some((v) => v != null)) {
      const sum = parts.reduce<number>((s, v) => s + (v ?? 0), 0)
      out.push(
        mk(G_TX, '(48) 合計事業税額', '申告書の記載値', r.jigyozeiTotal, '各割の税額の合計', sum, {
          note: '(32)又は(33)＋(35)＋(37)＋(39)＋(41)＋(43)＋(45)＋(47)',
        }),
      )
    }

    // 特別法人事業税（第3号事業は収入割額が課税標準）
    if (r.tokubetsu1.rate != null && Math.abs(r.tokubetsu1.rate - STD_RATE.tokubetsu1) > 1e-9) {
      out.push(
        mkNote(
          G_TX,
          '特別法人事業税の税率（第1号事業の所得割）',
          'info',
          `申告書の税率は ${r.tokubetsu1.rate}％。外形標準課税の対象外法人の標準税率は ${STD_RATE.tokubetsu1}％。`,
        ),
      )
    }
    if (r.tokubetsu3.base != null || r.tokubetsu3.tax != null) {
      out.push(
        mk(G_TX, '(67) 特別法人事業税の課税標準（第3号事業）', '申告書の記載値', r.tokubetsu3.base, '第3号事業の収入割税額(47)', r.shunyu3.tax, {
          note:
            '課税標準は基準法人収入割額（＝標準税率で計算した収入割額）そのもの。' +
            'すでに100円未満を切り捨てた税額なので、ここで改めて1,000円未満を切り捨てない。',
        }),
      )
      if (r.tokubetsu3.base != null && r.tokubetsu3.rate != null) {
        out.push(
          mk(
            G_TX,
            '(67) 特別法人事業税額（第3号事業）',
            '申告書の記載値',
            r.tokubetsu3.tax,
            `課税標準×${r.tokubetsu3.rate}％`,
            trunc100((r.tokubetsu3.base * r.tokubetsu3.rate) / 100),
          ),
        )
      }
      if (r.tokubetsu3.rate != null && Math.abs(r.tokubetsu3.rate - STD_RATE.tokubetsu3) > 1e-9) {
        out.push(
          mkNote(
            G_TX,
            '特別法人事業税の税率（第3号事業）',
            'info',
            `申告書の税率は ${r.tokubetsu3.rate}％。第3号事業の収入割額に対する標準税率は ${STD_RATE.tokubetsu3}％。`,
          ),
        )
      }
    }
    const tParts = [r.tokubetsu1.tax, r.tokubetsu2.tax, r.tokubetsu3.tax]
    if (tParts.some((v) => v != null)) {
      out.push(
        mk(
          G_TX,
          '(68) 合計特別法人事業税額',
          '申告書の記載値',
          r.tokubetsuTotal,
          '(65)＋(66)＋(67)',
          tParts.reduce<number>((s, v) => s + (v ?? 0), 0),
        ),
      )
    }
  }

  return out
}
