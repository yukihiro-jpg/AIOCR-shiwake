// 「AIに質問」の質問と回答を Excel でダウンロードする。
//
// 出力は2シート。
//   ・質問と回答 … 日時／質問／回答／どの集計で答えたか／★
//   ・根拠の内訳 … 回答に添えた表（科目の内訳・月別の金額など）を質問ごとに展開
//
// 体裁は月次推移のExcel（excel.ts）と揃える。
//   フォントは Noto Sans JP、全セルに罫線、見出しは濃紺、
//   回答しなかった質問は薄い赤、読み取れなかった質問は薄い橙、★は薄い青で塗る。
// 長い文章が切れないよう、**折り返しを有効にしたうえで行の高さを文字数から計算する**
// （xlsx には「自動で高さを合わせる」指定が無く、既定の高さのままだと1行しか見えない）。
//
// ライブラリは押されたときだけ動的に読み込む（本体バンドルを重くしない）。

import type { QaEntry } from './types';
import type { Answer } from './qa/answers';

// ---- 配色（excel.ts と同じ） ----
const INK = '1A2330';
const MUTED = '6B7684';
const HEAD_BG = '1C2F45';
const HEAD_FG = 'FFFFFF';
const BORDER = 'B9C2CC';
const BORDER_LIGHT = 'DCDFD8';
const ZEBRA = 'F7F9FC';        // 1行おきの薄い地
const DECLINED_BG = 'FCECEA';  // 回答しなかった質問
const UNKNOWN_BG = 'FDF3E0';   // 読み取れなかった質問
const STAR_BG = 'EAF0FE';      // ★を付けた質問
const ACCENT = '1E4AB0';

const FONT = 'Noto Sans JP';
type Style = Record<string, unknown>;
interface Cell { v: string | number; t: 's' | 'n'; s: Style }

const font = (o: Record<string, unknown> = {}) => ({ name: FONT, sz: 9, color: { rgb: INK }, ...o });
const fill = (rgb: string) => ({ patternType: 'solid', fgColor: { rgb } });
const bd = (rgb = BORDER) => ({ style: 'thin', color: { rgb } });
const boxAll = { top: bd(BORDER_LIGHT), bottom: bd(BORDER_LIGHT), left: bd(BORDER), right: bd(BORDER) };

const empty: Cell = { v: '', t: 's', s: {} };
const titleCell = (v: string): Cell => ({ v, t: 's', s: { font: font({ sz: 15, bold: true }) } });
const subCell = (v: string): Cell => ({ v, t: 's', s: { font: font({ sz: 9, color: { rgb: MUTED } }) } });

const th = (v: string, align: 'left' | 'center' | 'right' = 'center'): Cell => ({
  v, t: 's',
  s: {
    font: font({ bold: true, color: { rgb: HEAD_FG } }), fill: fill(HEAD_BG),
    border: { top: bd(HEAD_BG), bottom: bd(HEAD_BG), left: bd('44586F'), right: bd('44586F') },
    alignment: { horizontal: align, vertical: 'center' },
  },
});

/** 本文セル。bg を渡すとその色で塗る（回答しなかった質問などの強調用）。 */
const td = (v: string, o: {
  bg?: string; bold?: boolean; wrap?: boolean; align?: 'left' | 'center' | 'right';
  color?: string; sz?: number;
} = {}): Cell => ({
  v, t: 's',
  s: {
    font: font({ bold: !!o.bold, ...(o.color ? { color: { rgb: o.color } } : {}), ...(o.sz ? { sz: o.sz } : {}) }),
    ...(o.bg ? { fill: fill(o.bg) } : {}),
    border: boxAll,
    alignment: {
      horizontal: o.align ?? 'left', vertical: 'top', wrapText: o.wrap !== false,
    },
  },
});

/** 数値（金額）セル。 */
const num = (v: number, bg?: string): Cell => ({
  v, t: 'n',
  s: {
    font: font({ bold: true, ...(v < 0 ? { color: { rgb: 'B0331F' } } : {}) }),
    ...(bg ? { fill: fill(bg) } : {}),
    border: boxAll,
    alignment: { horizontal: 'right', vertical: 'top' },
    numFmt: '#,##0;[Red]-#,##0',
  },
});

/**
 * 折り返した文章の行数から、その行に必要な高さ（pt）を見積もる。
 * 列幅（wch＝半角文字数）に対し、全角は2文字ぶんとして数える。
 */
function rowHeight(cells: { text: string; wch: number }[]): number {
  let lines = 1;
  for (const c of cells) {
    const width = 0;
    let used = width;
    let n = 1;
    for (const ch of c.text) {
      if (ch === '\n') { n++; used = 0; continue; }
      // 半角は1・全角は2（ざっくりで十分。切れないよう多めに見る側へ倒す）
      used += /[ -~｡-ﾟ]/.test(ch) ? 1 : 2;
      if (used >= c.wch) { n++; used = 0; }
    }
    lines = Math.max(lines, n);
  }
  return Math.min(320, Math.max(16, lines * 13 + 4));
}

function colName(i: number): string {
  let s = '';
  let n = i;
  for (;;) { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; if (n < 0) break; }
  return s;
}

function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1500);
}

interface SheetSpec {
  name: string;
  aoa: Cell[][];
  merges: { s: { r: number; c: number }; e: { r: number; c: number } }[];
  headRowIdx: number;
  cols: { wch: number }[];
  rows: { hpt: number }[];
}

async function writeBook(sheets: SheetSpec[], fileName: string): Promise<void> {
  const mod = (await import('xlsx-js-style')) as unknown as Record<string, unknown>;
  const XLSX = ((mod as { default?: unknown }).default ?? mod) as {
    utils: {
      book_new: () => Record<string, unknown>;
      aoa_to_sheet: (aoa: unknown[][]) => Record<string, unknown>;
      book_append_sheet: (wb: unknown, ws: unknown, name: string) => void;
    };
    write: (wb: unknown, o: Record<string, unknown>) => ArrayBuffer;
  };
  const wb = XLSX.utils.book_new();
  const names: Record<string, unknown>[] = [];
  sheets.forEach((sp, idx) => {
    const ws = XLSX.utils.aoa_to_sheet(sp.aoa);
    ws['!merges'] = sp.merges;
    ws['!cols'] = sp.cols;
    ws['!rows'] = sp.rows;
    ws['!margins'] = { left: 0.3, right: 0.3, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 };
    XLSX.utils.book_append_sheet(wb, ws, sp.name);
    const lastCol = colName(sp.cols.length - 1);
    names.push(
      { Name: '_xlnm.Print_Titles', Sheet: idx, Ref: `'${sp.name}'!$${sp.headRowIdx + 1}:$${sp.headRowIdx + 1}` },
      { Name: '_xlnm.Print_Area', Sheet: idx, Ref: `'${sp.name}'!$A$1:$${lastCol}$${sp.aoa.length}` },
    );
  });
  (wb as { Workbook?: Record<string, unknown> }).Workbook = { Views: [{ RTL: false }], Names: names };
  const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  saveBlob(new Blob([bytes], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }), fileName);
}

/** 画面に出したのと同じ「どの集計で答えたか」の日本語名。 */
const TOOL_LABEL: Record<string, string> = {
  monthResult: '単月の業績', vsPrev: '前期との比較', cashTrend: '現金の推移',
  bestSalesMonth: '売上の山谷', bep: '損益分岐点', needSales: '必要売上高',
  expenseUp: '経費の増減', debtYears: '借入と返済', laborShare: '人件費・労働分配率',
  accountAmount: '科目の金額', periodResult: '期間の業績',
  partnerTotal: '取引先との合計', partnerRanking: '科目の相手先別', partnerMonthly: '取引先の月別',
};

/** Excelに出す1件分（画面の会話・保存された記録のどちらからも作れる形）。 */
export interface QaRow {
  at: string;
  question: string;
  answer: string;
  tool: string | null;
  declined: boolean;
  starred?: boolean;
  viaAi?: boolean;
  /** 回答に添えた表（あれば根拠シートに出す） */
  evidence?: Answer['evidence'];
}

/** 保存してある質問ログ → 出力用の行。 */
export function rowsFromLog(log: QaEntry[]): QaRow[] {
  return log.map(e => ({
    at: e.at, question: e.question, answer: e.answer, tool: e.tool,
    declined: e.declined, starred: e.starred, viaAi: e.viaAi,
  }));
}

function fmtAt(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const COLS = [{ wch: 17 }, { wch: 42 }, { wch: 78 }, { wch: 18 }, { wch: 6 }];

function buildQaSheet(rows: QaRow[], company: string, title: string): SheetSpec {
  const aoa: Cell[][] = [];
  const merges: { s: { r: number; c: number }; e: { r: number; c: number } }[] = [];
  const rowsH: { hpt: number }[] = [];
  const n = COLS.length;
  const pad = (r: Cell[]): Cell[] => { while (r.length < n) r.push(empty); return r; };

  aoa.push(pad([titleCell(title)]));
  merges.push({ s: { r: 0, c: 0 }, e: { r: 0, c: n - 1 } });
  rowsH.push({ hpt: 24 });

  const declined = rows.filter(r => r.declined).length;
  const viaAi = rows.filter(r => r.viaAi).length;
  aoa.push(pad([subCell(
    `${company ? `${company}　` : ''}${rows.length}件`
    + `（AIが読み取り ${viaAi}件／回答しなかった質問 ${declined}件）`
    + `　出力 ${fmtAt(new Date().toISOString())}`,
  )]));
  merges.push({ s: { r: 1, c: 0 }, e: { r: 1, c: n - 1 } });
  rowsH.push({ hpt: 16 });

  aoa.push(pad([]));
  rowsH.push({ hpt: 8 });

  const headRowIdx = aoa.length;
  aoa.push(['日時', '質問', '回答', 'どの集計で答えたか', '★']
    .map((h, i) => th(h, i === 1 || i === 2 ? 'left' : 'center')));
  rowsH.push({ hpt: 20 });

  rows.forEach((r, i) => {
    // 回答しなかった質問・読み取れなかった質問・★の順で、行の地色を決める
    const bg = r.declined ? DECLINED_BG
      : (!r.declined && r.tool === null) ? UNKNOWN_BG
        : r.starred ? STAR_BG
          : (i % 2 === 1 ? ZEBRA : undefined);
    const tool = r.declined ? '（税務判断のため回答せず）'
      : r.tool === null ? '（読み取れず）'
        : (TOOL_LABEL[r.tool] ?? r.tool) + (r.viaAi ? '／AIが読み取り' : '');
    aoa.push(pad([
      td(fmtAt(r.at), { bg, align: 'center', wrap: false, color: MUTED }),
      td(r.question, { bg, bold: true }),
      td(r.answer, { bg }),
      td(tool, { bg, align: 'center', color: r.declined || r.tool === null ? MUTED : ACCENT }),
      td(r.starred ? '★' : '', { bg, align: 'center', wrap: false, color: ACCENT, sz: 12 }),
    ]));
    rowsH.push({
      hpt: rowHeight([
        { text: r.question, wch: COLS[1].wch },
        { text: r.answer, wch: COLS[2].wch },
      ]),
    });
  });

  return { name: '質問と回答', aoa, merges, headRowIdx, cols: COLS, rows: rowsH };
}

const EV_COLS = [{ wch: 5 }, { wch: 42 }, { wch: 34 }, { wch: 26 }, { wch: 18 }, { wch: 22 }];

/** 回答に添えた表を質問ごとに展開したシート（無ければ作らない）。 */
function buildEvidenceSheet(rows: QaRow[], company: string): SheetSpec | null {
  const withEv = rows
    .map((r, i) => ({ r, no: i + 1 }))
    .filter(x => x.r.evidence && x.r.evidence.kind === 'table');
  if (!withEv.length) return null;

  const aoa: Cell[][] = [];
  const merges: { s: { r: number; c: number }; e: { r: number; c: number } }[] = [];
  const rowsH: { hpt: number }[] = [];
  const n = EV_COLS.length;
  const pad = (r: Cell[]): Cell[] => { while (r.length < n) r.push(empty); return r; };

  aoa.push(pad([titleCell('回答の根拠')]));
  merges.push({ s: { r: 0, c: 0 }, e: { r: 0, c: n - 1 } });
  rowsH.push({ hpt: 24 });
  aoa.push(pad([subCell(
    `${company ? `${company}　` : ''}回答に添えた内訳です。No は「質問と回答」シートの並び順に対応します。`,
  )]));
  merges.push({ s: { r: 1, c: 0 }, e: { r: 1, c: n - 1 } });
  rowsH.push({ hpt: 16 });
  aoa.push(pad([]));
  rowsH.push({ hpt: 8 });

  const headRowIdx = aoa.length;
  aoa.push(['No', '質問', '内訳の見出し', '項目', '金額', '補足']
    .map((h, i) => th(h, i >= 4 ? 'right' : i === 0 ? 'center' : 'left')));
  rowsH.push({ hpt: 20 });

  for (const { r, no } of withEv) {
    const ev = r.evidence as { kind: 'table'; title: string; rows: { label: string; value: string; note?: string }[] };
    ev.rows.forEach((er, j) => {
      const bg = no % 2 === 0 ? ZEBRA : undefined;
      // 金額は「1,234円」の形で入っているので、数値に戻して桁区切りで出す
      const m = /^-?[\d,]+/.exec(er.value.replace(/△/, '-'));
      const v = m ? Number(m[0].replace(/,/g, '')) : NaN;
      const isTotal = er.label === '合計';
      aoa.push(pad([
        td(j === 0 ? String(no) : '', { bg, align: 'center', wrap: false, color: MUTED }),
        td(j === 0 ? r.question : '', { bg }),
        td(j === 0 ? ev.title : '', { bg, color: MUTED }),
        td(er.label, { bg, bold: isTotal }),
        isNaN(v) ? td(er.value, { bg, align: 'right', wrap: false, bold: isTotal })
          : num(v, isTotal ? STAR_BG : bg),
        td(er.note ?? '', { bg, color: MUTED, wrap: false }),
      ]));
      rowsH.push({
        hpt: rowHeight([{ text: j === 0 ? r.question : '', wch: EV_COLS[1].wch }]),
      });
    });
  }
  return { name: '回答の根拠', aoa, merges, headRowIdx, cols: EV_COLS, rows: rowsH };
}

/** 質問と回答をExcelでダウンロードする。 */
export async function exportQaXlsx(
  rows: QaRow[], company: string, opts: { title?: string; fileName?: string } = {},
): Promise<void> {
  const title = opts.title ?? 'AIに質問 — 質問と回答';
  const sheets: SheetSpec[] = [buildQaSheet(rows, company, title)];
  const ev = buildEvidenceSheet(rows, company);
  if (ev) sheets.push(ev);
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  await writeBook(sheets, opts.fileName ?? `AI質問_${company || '顧問先'}_${stamp}.xlsx`);
}
