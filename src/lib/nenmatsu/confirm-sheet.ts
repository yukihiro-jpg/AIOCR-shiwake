// 紙で配る「年末調整の確認シート」（従業員1人につきA4縦1枚・印刷用）。
// スマホでの提出が難しい方向け。会社に登録されている内容（前年の提出、無ければCSVの登録内容）を
// 印字しておき、質問に答える形で「変更なし／変更あり」と変更後の内容を書いてもらう。
// 紙の運用では QR は載せない（紙で出すと決めた方に配るため）。マイナンバーは印字しない。
// 配偶者・扶養親族の前年の収入（所得）は印字しない（今年の見込みを書いてもらう）。
// 障害者控除の対象の方は、手帳の種類と等級を書く欄を設ける（区分は等級で決まるため）。
// 今年入社した方用の確認シート（白紙）も、指定の枚数だけ既存社員の分のあとに続けて作れる。

import { writePrintWindow } from './check-sheet'

export interface ConfirmSheetPerson {
  name: string
  kana: string
  rel: string // 扶養親族の続柄（配偶者では未使用）
  birth: string
  together?: string // 同居・別居（分からなければ空）
  disability?: string // 障害者区分（非該当なら印字しない）
  /** 補足（扶養親族＝親族区分「年少扶養」等。前年の収入は入れない） */
  note?: string
}

export interface ConfirmSheetEmployee {
  code: string
  name: string
  kana: string
  birth: string
  postal: string
  address: string
  householder: string // 例: 山田 太郎（本人）。不明なら空
  /** 本人の状態（前年の申告の内容）。不明なら null（チェック欄を空のまま出す） */
  self: { disability: string; widow: string; student: boolean } | null
  /** 甲乙（会社の登録）。不明なら空 */
  taxTable: '' | 'kou' | 'otsu'
  spouse: ConfirmSheetPerson | null
  dependents: ConfirmSheetPerson[]
  /** 印字の元（シートの隅に小さく出す。例: 令和7年度の提出／会社の登録内容） */
  source: string
}

export interface ConfirmSheetOptions {
  companyName: string
  yearLabel: string
  deadlineText: string
  employees: ConfirmSheetEmployee[]
  /** 今年入社した方用の確認シート（白紙・記入式）の枚数 */
  newHireCount?: number
}

const DOCS = [
  '生命保険料控除証明書', '地震保険料控除証明書', '国民年金保険料の控除証明書', '国民健康保険料の支払証明',
  '小規模企業共済・iDeCoの払込証明書', '住宅借入金等特別控除申告書・残高証明書', '前職の源泉徴収票（今年入社の方）',
]

function esc(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string),
  )
}

/** YYYY-MM-DD（YYYY/MM/DD）を和暦に。読めなければそのまま */
export function warekiOf(s: string): string {
  const m = String(s || '').trim().match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/)
  if (!m) return String(s || '')
  const y = +m[1], mo = +m[2], d = +m[3]
  const t = y * 10000 + mo * 100 + d
  const [era, base] = t >= 20190501 ? ['令和', 2018] : t >= 19890108 ? ['平成', 1988] : t >= 19261225 ? ['昭和', 1925] : t >= 19120730 ? ['大正', 1911] : ['明治', 1867]
  const ey = y - (base as number)
  return `${era}${ey === 1 ? '元' : ey}年${mo}月${d}日`
}

const box = '<span class="bx"></span>'
/** 登録内容として ✓ を印字済みのチェック欄 */
const boxOn = '<span class="bx on">✓</span>'
const ck = (on: boolean) => (on ? boxOn : box)

const isNone = (v: string | undefined) => !v || v === '非該当'

/** 本人の状態の登録内容（1行）と、該当欄のチェック */
function selfStatus(self: ConfirmSheetEmployee['self']): string {
  if (!self) {
    return `<div class="mt">該当するもの：${box}障害者　${box}寡婦　${box}ひとり親　${box}勤労学生</div>`
  }
  const dis = !isNone(self.disability)
  const none = !dis && isNone(self.widow) && !self.student
  return `<div class="mt">該当するもの：${ck(dis)}障害者${dis && self.disability !== '一般障害者' ? `（${esc(self.disability)}）` : ''}　${ck(self.widow === '寡婦')}寡婦　${ck(self.widow === 'ひとり親')}ひとり親　${ck(self.student)}勤労学生　${ck(none)}どれもあてはまらない<span class="hint">✓は昨年の登録内容です。変わった場合は訂正してください</span></div>`
}

function personExtra(p: ConfirmSheetPerson): string {
  return [
    p.together ? esc(p.together) : '',
    !isNone(p.disability) ? `<span class="tag">${esc(p.disability as string)}</span>` : '',
    p.note ? `<span class="note">${esc(p.note)}</span>` : '',
  ].filter(Boolean).map((x) => `　${x}`).join('')
}

/** 障害者手帳の種類（等級と一緒に書いてもらう。障害者控除の区分は手帳の等級で決まるため） */
const TECHO = ['身体障害者手帳', '精神障害者手帳', '療育手帳', 'その他']

interface DisPerson { name: string; rel: string; type: string }

/** 障害者控除の対象となる方：手帳の種類と等級の記入欄。会社に登録のある方は氏名を印字しておく */
function disabilityQ(n: number, known: DisPerson[]): string {
  const rows = [...known]
  while (rows.length < 2) rows.push({ name: '', rel: '', type: '' })
  const td = (r: DisPerson) => r.name
    ? `${esc(r.name)}${r.rel ? `（${esc(r.rel)}）` : ''}${r.type ? `<span class="tag">${esc(r.type)}</span>` : ''}`
    : ''
  return `<div class="q"><div class="h"><i>${n}</i>障害者控除の対象となる方（ご本人・配偶者・扶養親族）</div><div class="b">
  <div class="ans"><span>${box}いない</span><span>${ck(known.length > 0)}いる → 手帳の種類に✓を付け、等級をご記入ください${known.length ? '<span class="note">（✓と氏名は昨年の登録内容です）</span>' : ''}</span></div>
  <table class="dt"><thead><tr><th style="width:31%">氏名（続柄）</th><th>手帳の種類</th><th style="width:19%">等級（療育手帳はA・Bなど）</th></tr></thead><tbody>
  ${rows.map((r) => `<tr><td>${td(r)}</td><td>${TECHO.map((t) => `<span class="nw">${box}${t}</span>`).join('')}</td><td class="grade">級</td></tr>`).join('')}
  </tbody></table>
</div></div>`
}

const fld = (label: string) => `<div><div class="lbl">${label}</div><div class="line"></div></div>`
/** 生年月日の記入欄（元号に○を付けてもらう） */
const ERA_BIRTH = '<span class="era">T・S・H・R</span>　　年　　月　　日'
const fldBirth = (label: string) => `<div><div class="lbl">${label}（元号に○）</div><div class="line era-line">${ERA_BIRTH}</div></div>`
const TOGETHER = `<span class="nw">${box}同居</span><span class="nw">${box}別居</span>`

/** 配偶者を扶養に入れるか（配偶者控除・配偶者特別控除を受けるか）。
 *  入れない場合も必ず✓してもらう（空欄だと控除の有無が分からず税額がずれる）。収入見込は入れる場合だけ */
const SPOUSE_DED = `<div class="ded"><b>配偶者がいる方は、必ずどちらかに✓：</b>配偶者を扶養に入れますか？（配偶者控除・配偶者特別控除を受けるか）
  <div class="ans"><span>${box}入れる（控除を受ける）→ 配偶者の今年の収入見込　＿＿＿＿＿＿＿円</span><span>${box}入れない（控除を受けない）</span></div>
  <div class="warn">⚠ 入れない場合も、必ず「入れない」に✓をしてください。どちらにも✓が無いと税額の計算がずれます。</div>
</div>`

/** 扶養親族（配偶者以外）の記入表。どこに何を書くか分かるよう列見出しを付ける */
function depWriteTable(rows: number): string {
  return `<div class="lbl mt">生年月日は T（大正）・S（昭和）・H（平成）・R（令和）のどれかに○を付けてください</div>
  <table class="dt dw"><thead><tr><th style="width:18%">氏名</th><th style="width:16%">フリガナ</th><th style="width:7%">続柄</th><th style="width:25%">生年月日</th><th style="width:17%">同居・別居</th><th>今年の収入見込</th></tr></thead><tbody>
  ${Array.from({ length: rows }, () => `<tr><td></td><td></td><td></td><td class="eracell">${ERA_BIRTH}</td><td>${TOGETHER}</td><td class="grade">円</td></tr>`).join('')}
  </tbody></table>`
}

/** 署名欄の近くに出すマイナンバーの注意 */
const MYNUMBER_NOTE = `<div class="mynum">🪪 <b class="em">新入社員の方</b>と、新しく<b class="em">扶養親族となった方</b>は、その方のマイナンバーが必要になります。<b>マイナンバーカードのコピー</b>も添付してください。</div>`

const DOCS_Q = (n: number) => `<div class="q"><div class="h"><i>${n}</i>一緒に出していただく書類（あるものに✓）</div><div class="b"><div class="g3">
  ${DOCS.map((d) => `<div>${box}${d}</div>`).join('')}<div>${box}何もない</div>
</div>
<div class="clip">📎 添付書類は<b>このシートのお名前が隠れないよう</b>、<b>シートの裏側に重ねてクリップで留めて</b>ください（のり付け・ホチキス留めはしないでください）。</div>
</div></div>`

const SIGN = `${MYNUMBER_NOTE}<div class="sign"><span>内容に相違ありません。</span><div>記入日　　　年　　月　　日</div><div>氏名（自署）</div></div>`

/** 今年入社した方用（白紙・記入式）。登録内容が無いので、全部を書いてもらう */
function newHirePage(o: ConfirmSheetOptions, i: number, total: number): string {
  return `<section class="page">
<div class="title">
  <div><div class="c">${esc(o.companyName)}　${esc(o.yearLabel)}</div><h1>年末調整の確認シート</h1></div>
  <div class="r"><div class="n">今年入社された方用</div>${o.deadlineText ? `<div class="d">提出期限　${esc(o.deadlineText)}</div>` : ''}</div>
</div>

<div class="q"><div class="h"><i>1</i>この会社で年末調整を行いますか？</div><div class="b">
  <div class="ans"><span>${box}はい（この会社がメイン）</span><span>${box}いいえ（他社で年末調整を受ける）→ ご本人欄だけ記入し、記入日と署名をして提出してください</span></div>
  <div class="g2 mt">${fld('この会社への入社日')}<div><div class="lbl">今年、この会社の前に勤めていた会社</div><div class="ans"><span>${box}ない</span><span>${box}ある → 前の会社の<b>源泉徴収票</b>を添付</span></div></div></div>
</div></div>

<div class="q"><div class="h"><i>2</i>ご本人について</div><div class="b">
  <div class="g2">${fld('氏名')}${fld('フリガナ')}${fldBirth('生年月日')}${fld('郵便番号')}</div>
  ${fld('住所（1月1日以降に引っ越した方は今の住所）')}
  <div class="g2">${fld('世帯主の氏名')}${fld('世帯主から見たあなたの続柄（本人・子・妻 など）')}</div>
  <div class="mt">該当するもの：${box}障害者　${box}寡婦　${box}ひとり親　${box}勤労学生　${box}どれもあてはまらない</div>
</div></div>

<div class="q"><div class="h"><i>3</i>配偶者の方について</div><div class="b">
  <div class="ans"><span>${box}配偶者はいない</span><span>${box}配偶者がいる → 下にご記入ください</span></div>
  <div class="g-sp">${fld('配偶者の氏名・フリガナ')}${fldBirth('配偶者の生年月日')}<div><div class="lbl">お住まい</div><div class="line" style="border:none">${TOGETHER}</div></div></div>
  ${SPOUSE_DED}
</div></div>

<div class="q"><div class="h"><i>4</i>扶養している家族について（配偶者以外を記入します）</div><div class="b">
  <div class="ans"><span>${box}いない</span><span>${box}いる → 下にご記入ください（16歳未満のお子さんも書いてください）</span></div>
  ${depWriteTable(3)}
</div></div>

${disabilityQ(5, [])}

${DOCS_Q(6)}

${SIGN}
<div class="ft"><span>個人情報を含みます。封筒に入れて提出してください。ご不明な点は会社のご担当者へ。</span><span>今年入社された方用（記入式）${total > 1 ? `　${i + 1}/${total}` : ''}</span></div>
</section>`
}

function page(o: ConfirmSheetOptions, e: ConfirmSheetEmployee): string {
  const sp = e.spouse
  const deps = e.dependents
  const kana = e.kana ? `（${esc(e.kana)}）` : ''
  const known: DisPerson[] = [
    ...(e.self && !isNone(e.self.disability) ? [{ name: e.name, rel: '本人', type: e.self.disability }] : []),
    ...(sp && !isNone(sp.disability) ? [{ name: sp.name, rel: '配偶者', type: sp.disability as string }] : []),
    ...deps.filter((d) => !isNone(d.disability)).map((d) => ({ name: d.name, rel: d.rel, type: d.disability as string })),
  ]
  const tt = e.taxTable === 'kou' ? '甲欄（この会社で年末調整）' : e.taxTable === 'otsu' ? '乙欄（他の会社で年末調整）' : ''
  return `<section class="page">
<div class="title">
  <div><div class="c">${esc(o.companyName)}　${esc(o.yearLabel)}</div><h1>年末調整の確認シート</h1></div>
  <div class="r"><div class="n">${esc(e.name)} 様${e.code ? `（No.${esc(e.code)}）` : ''}</div>${o.deadlineText ? `<div class="d">提出期限　${esc(o.deadlineText)}</div>` : ''}</div>
</div>

<div class="q"><div class="h"><i>1</i>この会社で年末調整を行いますか？</div><div class="b">
  ${tt ? `<div class="reg"><b>会社の登録</b>${tt}</div>` : ''}
  <div class="ans"><span>${box}はい（この会社がメイン）</span><span>${box}いいえ（他社で年末調整を受ける）→ ご住所を確認のうえ、記入日と署名だけで提出してください</span></div>
</div></div>

<div class="q"><div class="h"><i>2</i>ご本人の登録内容に変更はありますか？</div><div class="b">
  <div class="reg"><b>氏名</b>${esc(e.name)}${kana}　<b>生年月日</b>${esc(warekiOf(e.birth)) || '（未登録）'}</div>
  <div class="reg"><b>住所</b>${e.postal ? `〒${esc(e.postal)}　` : ''}${esc(e.address) || '（未登録）'}${e.householder ? `　<b>世帯主</b>${esc(e.householder)}` : ''}</div>
  <div class="ans"><span>${box}変更なし</span><span>${box}変更あり → 正しい内容をご記入ください</span></div>
  <div class="line"></div>
  ${selfStatus(e.self)}
</div></div>

<div class="q"><div class="h"><i>3</i>配偶者の方について</div><div class="b">
  ${sp
    ? `<div class="reg"><b>登録内容</b>${esc(sp.name)}${sp.kana ? `（${esc(sp.kana)}）` : ''}　${esc(warekiOf(sp.birth))}${personExtra(sp)}</div>
  <div class="ans"><span>${box}変更なし</span><span>${box}変更あり（離婚・死別など）</span></div>`
    : `<div class="reg"><b>登録内容</b>配偶者の登録はありません</div>
  <div class="ans"><span>${box}配偶者はいない</span><span>${box}配偶者がいる（結婚など）→ 下にご記入ください</span></div>`}
  ${sp
    ? fld('変更があった方のみ：変更後の内容（氏名・生年月日など）')
    : `<div class="g2">${fld('配偶者の氏名・フリガナ')}${fldBirth('配偶者の生年月日')}</div>`}
  ${SPOUSE_DED}
</div></div>

<div class="q"><div class="h"><i>4</i>扶養している家族について（配偶者以外を記入します）</div><div class="b">
  ${deps.length
    ? deps.map((d) => `<div class="reg"><b>${esc(d.rel || '扶養')}</b>${esc(d.name)}${d.kana ? `（${esc(d.kana)}）` : ''}　${esc(warekiOf(d.birth))}${personExtra(d)}<span class="inc">今年の収入見込　＿＿＿＿＿＿円</span></div>`).join('')
    : '<div class="reg"><b>登録内容</b>扶養親族の登録はありません</div>'}
  <div class="ans"><span>${box}変更なし</span><span>${box}${deps.length ? '増えた・減った' : '扶養している家族がいる'} → 下にご記入ください（減った方は上の行に×を付けてください）</span></div>
  ${depWriteTable(deps.length > 2 ? 1 : 2)}
</div></div>

${disabilityQ(5, known)}

${DOCS_Q(6)}

${SIGN}
<div class="ft"><span>個人情報を含みます。封筒に入れて提出してください。ご不明な点は会社のご担当者へ。</span><span>印字の元：${esc(e.source)}</span></div>
</section>`
}

export function buildConfirmSheetHtml(o: ConfirmSheetOptions): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<title>年末調整 確認シート ${esc(o.companyName)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{background:#e8eaed;font-family:"Noto Sans JP","Hiragino Sans","Yu Gothic",Meiryo,sans-serif;color:#1f2937}
@page{size:A4;margin:0}
.page{width:210mm;min-height:297mm;margin:10mm auto;background:#fff;position:relative;box-shadow:0 2px 12px rgba(0,0,0,.12);padding:7mm 11mm 13mm;break-after:page;page-break-after:always}
.page:last-of-type{break-after:auto;page-break-after:auto}
@media print{body{background:#fff}.page{margin:0;box-shadow:none}.noprint{display:none}}
.title{background:#0f766e;color:#fff;border-radius:3mm;padding:2.2mm 4.5mm;display:flex;justify-content:space-between;align-items:center;gap:4mm}
.title .c{font-size:9.5px;opacity:.85}.title h1{font-size:18px;margin:.2mm 0 0}.title .r{text-align:right}.title .n{font-size:14px;font-weight:700}
.title .d{font-size:10px;margin-top:.8mm;background:rgba(255,255,255,.18);display:inline-block;padding:.4mm 2.5mm;border-radius:2mm}
.q{margin-top:1.4mm;border:1px solid #d6e4e1;border-radius:3mm;overflow:hidden;break-inside:avoid}
.q .h{display:flex;align-items:center;gap:2.5mm;background:#ecf6f4;padding:.7mm 3mm;font-size:11px;font-weight:700;color:#134e4a}
.q .h i{font-style:normal;background:#0f766e;color:#fff;border-radius:50%;width:5.2mm;height:5.2mm;display:flex;align-items:center;justify-content:center;font-size:10px;flex:none}
.q .b{padding:1mm 3.5mm;font-size:10px;line-height:1.5}
.ans{display:flex;flex-wrap:wrap;gap:1mm 6mm;font-size:10.5px;font-weight:500;margin-top:.8mm}
.reg{background:#f8fafc;border-radius:2mm;padding:.8mm 2.5mm;margin:.5mm 0;font-size:10px}
.reg b{color:#0f766e;font-weight:700;margin-right:1.5mm}
.reg .inc{float:right;color:#374151}
.line{border-bottom:1px solid #9ca3af;height:5.4mm;margin-top:.1mm}
.line.yen{text-align:right;line-height:6mm}
.lbl{font-size:8.5px;color:#6b7280}
.mt{margin-top:1.2mm}
.g2{display:grid;grid-template-columns:1fr 1fr;gap:.4mm 5mm}
.g3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:.2mm 3mm;font-size:9.5px}
.clip{margin-top:1.2mm;background:#fff7ed;border:1px solid #fdba74;border-radius:2mm;padding:1mm 2.5mm;font-size:9.5px;color:#7c2d12;line-height:1.5}
.bx{display:inline-block;width:3.6mm;height:3.6mm;border:1.2px solid #374151;vertical-align:-.6mm;margin-right:1.2mm;border-radius:.6mm}
.bx.on{font-size:9px;line-height:3.2mm;text-align:center;font-weight:700;color:#0f766e}
.hint{display:block;font-size:8.5px;color:#6b7280}
.reg .tag{display:inline-block;border:1px solid #f59e0b;color:#92400e;border-radius:1.5mm;padding:0 1.5mm;font-size:9px;line-height:1.5}
.reg .note,.ans .note{font-size:9px;color:#4b5563;font-weight:400}
.dt{width:100%;border-collapse:collapse;margin-top:1mm;font-size:9.5px}
.dt th{background:#f1f5f9;color:#475569;font-weight:500;font-size:8.5px;text-align:left;padding:.4mm 1.5mm;border:1px solid #cbd5e1}
.dt td{border:1px solid #cbd5e1;height:5.8mm;padding:0 1.5mm;vertical-align:middle}
.dt td.grade{text-align:right;white-space:nowrap}
.dt td.grade .lbl{display:block;text-align:right;line-height:1.2}
.dt .nw{white-space:nowrap;margin-right:2.2mm;display:inline-block}
.nw{white-space:nowrap;margin-right:3mm;display:inline-block}
.era{font-size:8.5px;color:#6b7280;letter-spacing:.3px}
.era-line{font-size:10px;line-height:6mm;color:#374151;padding-left:1mm}
.dt.dw td{height:6.2mm}
.dt.dw .nw{margin-right:2mm}
.g-sp{display:grid;grid-template-columns:1.1fr 1.1fr .8fr;gap:.4mm 5mm}
.dt td.eracell{white-space:nowrap;font-size:9.5px;color:#374151}
.ded{margin-top:1.2mm;border:1.2px solid #f59e0b;background:#fffbeb;border-radius:2mm;padding:1mm 2.5mm;font-size:10px}
.ded .warn{font-size:9px;color:#b45309;font-weight:700;margin-top:.4mm}
.mynum{margin-top:1.8mm;border:1.2px solid #dc2626;background:#fef2f2;border-radius:2mm;padding:.9mm 3mm;font-size:10px;line-height:1.5;color:#1f2937;break-inside:avoid}
.mynum .em{color:#b91c1c;font-size:11px;background:#fee2e2;padding:0 1mm;border-radius:1mm;text-decoration:underline}
.dt .tag{display:inline-block;border:1px solid #f59e0b;color:#92400e;border-radius:1.5mm;padding:0 1.5mm;font-size:8.5px;line-height:1.5;margin-left:1.5mm}
.sign{display:flex;gap:6mm;margin-top:2.6mm;font-size:10px;align-items:flex-end;break-inside:avoid}
.sign div{flex:1;border-bottom:1px solid #374151;padding-bottom:1mm}
.ft{position:absolute;left:11mm;right:11mm;bottom:5mm;display:flex;justify-content:space-between;gap:4mm;font-size:8.5px;color:#6b7280;border-top:1px solid #e5e7eb;padding-top:2mm}
.noprint{position:fixed;top:10px;right:10px;z-index:2}
.noprint button{font-family:inherit;font-size:13px;padding:8px 16px;background:#0f766e;color:#fff;border:none;border-radius:8px;cursor:pointer}
</style></head><body>
<div class="noprint"><button onclick="window.print()">🖨 印刷 / PDFに保存</button></div>
${o.employees.map((e) => page(o, e)).join('\n')}
${Array.from({ length: Math.max(0, Math.floor(o.newHireCount || 0)) }, (_, i) => newHirePage(o, i, Math.floor(o.newHireCount || 0))).join('\n')}
<script>
(function(){
  function go(){ try{ window.focus(); window.print(); }catch(e){} }
  var ready = (document.fonts && document.fonts.ready) ? document.fonts.ready : Promise.resolve();
  Promise.race([ready, new Promise(function(r){ setTimeout(r, 3000) })]).then(function(){ setTimeout(go, 350) });
})();
</script>
</body></html>`
}

/** 先に開いたウインドウ（openPrintWindowNow）へ書き込む */
export function openConfirmSheetPrint(o: ConfirmSheetOptions, w: Window | null): boolean {
  if (!w) return false
  writePrintWindow(w, buildConfirmSheetHtml(o))
  return true
}
