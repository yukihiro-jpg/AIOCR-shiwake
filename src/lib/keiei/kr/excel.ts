// 月次経営レポート — 月次推移表の Excel 出力（xlsx-js-style）。
//
// 画面の表（trend.ts の TrendTable）をそのままブックにする。
//   ・フォントは Noto Sans JP（表示側と揃える）
//   ・金額は #,### 形式（マイナスは赤字）／同月比は 0.0%
//   ・小計行【】は薄い青、利益行〔〕は濃い青で強調、区分の段ごとに罫線
//   ・ダウンロード後そのまま印刷できるよう、A3横・全列1ページ幅・
//     見出し行の繰り返し・余白・印刷範囲・ウィンドウ枠固定を設定する
// ライブラリは押されたときだけ動的に読み込む（本体バンドルを重くしない）。

import type { TrendTable, TrendSeg } from './trend';
import { MODE_LABEL, buildTrend, rowKind } from './trend';
import type { FiscalYearData, State } from './types';
import { CF_ROWS, cashFlowOf, calYm, prevYearOf } from './analysis';
import { kpiMetrics, monthKpiMetrics } from './kpi';
import type { KpiMetric } from './kpi';

// ---- 配色（画面の styles.css に対応） ----
const INK = '1A2330';        // 本文
const MUTED = '6B7684';      // 補足
const HEAD_BG = '1C2F45';    // 見出し背景（濃紺）
const HEAD_FG = 'FFFFFF';
const GROUP_BG = 'EEF2F7';   // 小計行【】
const PROFIT_BG = 'DCE8F6';  // 利益行〔〕
const SEG_BG = 'F7F8F5';     // 区分列（前期実績値など）
const CUM_BG = 'F0F4F9';     // 累計列
const NEG = 'B0331F';        // マイナス
const BORDER = 'B9C2CC';     // 罫線（濃いめ・印刷で出る太さ）
const BORDER_LIGHT = 'DCDFD8';

const FONT = 'Noto Sans JP';
type Style = Record<string, unknown>;
interface Cell { v: string | number; t: 's' | 'n'; s: Style }

const font = (o: Record<string, unknown> = {}) => ({ name: FONT, sz: 9, color: { rgb: INK }, ...o });
const fill = (rgb: string) => ({ patternType: 'solid', fgColor: { rgb } });
const bd = (rgb = BORDER) => ({ style: 'thin', color: { rgb } });
const boxAll = { top: bd(BORDER_LIGHT), bottom: bd(BORDER_LIGHT), left: bd(BORDER), right: bd(BORDER) };
/** 科目の区切り（段の最初の行）を太線にする */
const boxTop = { ...boxAll, top: { style: 'medium', color: { rgb: BORDER } } };

const empty: Cell = { v: '', t: 's', s: {} };
const titleCell = (v: string): Cell => ({ v, t: 's', s: { font: font({ sz: 15, bold: true }) } });
const subCell = (v: string): Cell => ({ v, t: 's', s: { font: font({ sz: 9, color: { rgb: MUTED } }) } });

const th = (v: string, align: 'left' | 'center' | 'right' = 'center'): Cell => ({
  v, t: 's',
  s: {
    font: font({ bold: true, color: { rgb: HEAD_FG } }), fill: fill(HEAD_BG),
    border: { top: bd(HEAD_BG), bottom: bd(HEAD_BG), left: bd('44586F'), right: bd('44586F') },
    alignment: { horizontal: align, vertical: 'center', wrapText: false },
  },
});

/** 科目名セル。 */
const nameCell = (v: string, kind: 'group' | 'profit' | 'detail', indent: number, top: boolean): Cell => ({
  v, t: 's',
  s: {
    font: font({ bold: kind !== 'detail' }),
    ...(kind === 'group' ? { fill: fill(GROUP_BG) } : kind === 'profit' ? { fill: fill(PROFIT_BG) } : {}),
    border: top ? boxTop : boxAll,
    alignment: { horizontal: 'left', vertical: 'center', indent: Math.min(8, indent) },
  },
});

/** 区分列（当期実績値／前期実績値…）。 */
const segCell = (v: string, kind: 'group' | 'profit' | 'detail', top: boolean): Cell => ({
  v, t: 's',
  s: {
    font: font({ sz: 8.5, color: { rgb: MUTED }, bold: kind !== 'detail' }),
    fill: fill(kind === 'group' ? GROUP_BG : kind === 'profit' ? PROFIT_BG : SEG_BG),
    border: top ? boxTop : boxAll,
    alignment: { horizontal: 'left', vertical: 'center' },
  },
});

/** 数値セル（金額は #,###／率は 0.0%）。 */
const numCell = (
  value: number | null, cellKind: 'amount' | 'ratio' | 'none', neg: boolean,
  rowStyle: 'group' | 'profit' | 'detail', top: boolean, cum = false,
): Cell => {
  const bg = rowStyle === 'group' ? GROUP_BG : rowStyle === 'profit' ? PROFIT_BG : cum ? CUM_BG : null;
  const base: Style = {
    font: font({ bold: rowStyle !== 'detail' || cum, color: { rgb: neg ? NEG : INK } }),
    ...(bg ? { fill: fill(bg) } : {}),
    border: top ? boxTop : boxAll,
    alignment: { horizontal: 'right', vertical: 'center' },
  };
  if (value === null || cellKind === 'none') {
    return { v: '—', t: 's', s: { ...base, font: font({ color: { rgb: MUTED } }) } };
  }
  return {
    v: value, t: 'n',
    s: { ...base, numFmt: cellKind === 'ratio' ? '#,##0.0"%";[Red]-#,##0.0"%"' : '#,###;[Red]-#,###' },
  };
};

/** シート名に使えない文字を落とす（31文字以内）。 */
const sheetName = (s: string) => s.replace(/[[\]:*?/\\]/g, '').slice(0, 31);

/** 0始まりの列番号を A, B, ... Z, AA … に変換する。 */
function colName(i: number): string {
  let n = i; let out = '';
  do { out = String.fromCharCode(65 + (n % 26)) + out; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return out;
}

/**
 * 印刷設定とウィンドウ枠固定を xlsx に後から書き込む。
 * xlsx-js-style は pageSetup（用紙・向き・1ページ幅）と pane（枠固定）を
 * 書き出さないため、生成後のブックを開いてシートXMLに直接足す。
 * 要素の順序は OOXML の規定（sheetPr → sheetViews → cols → sheetData →
 * mergeCells → printOptions → pageMargins → pageSetup）に合わせる。
 */
async function patchPrintSettings(
  bytes: ArrayBuffer, freezes: { xSplit: number; ySplit: number }[],
): Promise<Blob> {
  interface ZipLike {
    file: {
      (p: string): { async: (t: 'string') => Promise<string> } | null;
      (p: string, data: string): void;
    };
    generateAsync: (o: Record<string, unknown>) => Promise<Blob>;
  }
  const JSZipMod = (await import('jszip')) as unknown as { default?: unknown };
  const JSZip = (JSZipMod.default ?? JSZipMod) as { loadAsync: (d: ArrayBuffer) => Promise<ZipLike> };
  const zip = await JSZip.loadAsync(bytes);
  for (let i = 0; i < freezes.length; i++) {
    const freeze = freezes[i];
    const path = `xl/worksheets/sheet${i + 1}.xml`;
    const entry = zip.file(path);
    if (!entry) continue;
    let xml = await entry.async('string');
    // 用紙に合わせて縮小印刷する指定（これが無いと fitToWidth が効かない）
    xml = xml.replace(
      /(<worksheet[^>]*>)/,
      '$1<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>',
    );
    // 見出しと科目列を固定して、スクロールしても位置が分かるようにする
    const cell = `${colName(freeze.xSplit)}${freeze.ySplit + 1}`;
    xml = xml.replace(
      /<sheetView([^>]*)\/>/,
      `<sheetView$1><pane xSplit="${freeze.xSplit}" ySplit="${freeze.ySplit}" topLeftCell="${cell}" activePane="bottomRight" state="frozen"/>`
      + `<selection pane="bottomRight" activeCell="${cell}" sqref="${cell}"/></sheetView>`,
    );
    // A3・横向き・全列を1ページ幅に収める（縦は必要なだけ続ける）
    xml = xml.replace(
      /(<pageMargins[^>]*\/>)/,
      '<printOptions horizontalCentered="1"/>$1'
      + '<pageSetup paperSize="8" orientation="landscape" fitToWidth="1" fitToHeight="0" horizontalDpi="600" verticalDpi="600"/>',
    );
    zip.file(path, xml);
  }
  return zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    compression: 'DEFLATE',
  });
}

/** ブラウザでファイルとして保存する。 */
function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  // クリック直後に取り除くとファイル名が反映されないことがあるため、少し待ってから片付ける
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1500);
}

/**
 * 月次推移表を Excel でダウンロードする。
 * @param t   画面と同じ表データ
 * @param company 会社名（表題に入れる）
 */
/** 1シート分の組み立て結果。 */
interface SheetSpec {
  name: string;
  aoa: Cell[][];
  merges: { s: { r: number; c: number }; e: { r: number; c: number } }[];
  cols: { wch: number }[];
  /** 見出し行（0始まり）。印刷時の繰り返しと枠固定に使う */
  headRowIdx: number;
  /** 枠固定の列数 */
  freezeCols: number;
  nCols: number;
}

/** 月次推移表のシートを組み立てる。 */
function buildTrendSheet(t: TrendTable, company: string): SheetSpec {
  const stmtLabel = t.statement === 'PL' ? '損益計算書' : '貸借対照表';
  const modeLabel = MODE_LABEL[t.mode];
  const showSeg = t.mode !== 'amount';

  // ---- 列構成 ----
  const headers: string[] = ['科目'];
  if (showSeg) headers.push('区分');
  headers.push(...t.labels);
  if (t.hasCum && t.mode !== 'amount') headers.push(`累計（${t.months}ヶ月）`);
  headers.push(t.annualLabel);
  const nCols = headers.length;
  const pad = (row: Cell[]): Cell[] => {
    while (row.length < nCols) row.push(empty);
    return row;
  };

  const aoa: Cell[][] = [];
  const merges: { s: { r: number; c: number }; e: { r: number; c: number } }[] = [];

  // ---- 表題 ----
  aoa.push(pad([titleCell(`${stmtLabel}　月次推移表（${modeLabel}）`)]));
  merges.push({ s: { r: 0, c: 0 }, e: { r: 0, c: nCols - 1 } });
  aoa.push(pad([subCell(
    `${company}　${t.year.label}　実績 ${t.months}ヶ月`
    + (t.prevYear ? `　／　前期: ${t.prevYear.label}` : '')
    + (t.mode === 'three' && t.prev2Year ? `　／　前々期: ${t.prev2Year.label}` : '')
    + `　（単位: 円${t.statement === 'BS' ? '・各月の月末残高' : ''}）`,
  )]));
  merges.push({ s: { r: 1, c: 0 }, e: { r: 1, c: nCols - 1 } });
  aoa.push(pad([]));

  // ---- 見出し ----
  const headRowIdx = aoa.length;
  aoa.push(headers.map((h, i) => th(h, i === 0 || (showSeg && i === 1) ? 'left' : 'center')));

  // ---- 明細 ----
  for (const tr of t.rows) {
    const kind = rowKind(tr.row);
    const segs: TrendSeg[] = tr.segs;
    const firstRowIdx = aoa.length;
    segs.forEach((sg, si) => {
      const top = si === 0;
      const line: Cell[] = [];
      line.push(nameCell(si === 0 ? tr.row.name : '', kind, tr.row.level, top));
      if (showSeg) line.push(segCell(sg.label, kind, top));
      for (const c of sg.months) line.push(numCell(c.value, c.kind, c.neg, kind, top));
      if (t.hasCum && t.mode !== 'amount') line.push(numCell(sg.cum.value, sg.cum.kind, sg.cum.neg, kind, top, true));
      line.push(numCell(sg.annual.value, sg.annual.kind, sg.annual.neg, kind, top, true));
      aoa.push(pad(line));
    });
    // 科目名は段をまたいで結合する
    if (segs.length > 1) {
      merges.push({ s: { r: firstRowIdx, c: 0 }, e: { r: firstRowIdx + segs.length - 1, c: 0 } });
    }
  }

  // 列幅（科目は広め・月は金額が入る幅）
  const cols: { wch: number }[] = [{ wch: 26 }];
  if (showSeg) cols.push({ wch: 11 });
  for (let i = 0; i < 12; i++) cols.push({ wch: 12.5 });
  if (t.hasCum && t.mode !== 'amount') cols.push({ wch: 14 });
  cols.push({ wch: 14 });

  return {
    name: sheetName(`${t.statement === 'PL' ? '月次推移PL' : '月次推移BS'}_${modeLabel}`),
    aoa, merges, cols, headRowIdx, freezeCols: showSeg ? 2 : 1, nCols,
  };
}

/** SheetSpec からブックを作り、印刷設定を入れてダウンロードする。 */
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
    ws['!rows'] = sp.aoa.map((_, i) => (i === 0 ? { hpt: 24 } : i === sp.headRowIdx ? { hpt: 20 } : { hpt: 15 }));
    ws['!margins'] = { left: 0.3, right: 0.3, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 };
    XLSX.utils.book_append_sheet(wb, ws, sp.name);
    const lastCol = colName(sp.nCols - 1);
    names.push(
      { Name: '_xlnm.Print_Titles', Sheet: idx, Ref: `'${sp.name}'!$${sp.headRowIdx + 1}:$${sp.headRowIdx + 1}` },
      { Name: '_xlnm.Print_Area', Sheet: idx, Ref: `'${sp.name}'!$A$1:$${lastCol}$${sp.aoa.length}` },
    );
  });
  (wb as { Workbook?: Record<string, unknown> }).Workbook = { Views: [{ RTL: false }], Names: names };
  const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  const blob = await patchPrintSettings(bytes, sheets.map(sp => ({
    xSplit: sp.freezeCols, ySplit: sp.headRowIdx + 1,
  })));
  saveBlob(blob, fileName);
}

/** 表示中の月次推移表をExcelでダウンロードする。 */
export async function exportTrendXlsx(t: TrendTable, company: string): Promise<void> {
  const sp = buildTrendSheet(t, company);

  const label = MODE_LABEL[t.mode];
  await writeBook([sp], `月次推移_${t.statement === 'PL' ? '損益' : '貸借'}_${label}_${t.year.label}.xlsx`);
}

// ---------------------------------------------------------------------------
// 月次報告一式（主要指標・月次推移PL・月次推移BS・CF明細の4シート）
// ---------------------------------------------------------------------------

/** 主要指標シート。ダッシュボードの表と同じ数字（kpi.ts を共有）。 */
function buildKpiSheet(state: State, y: FiscalYearData, company: string): SheetSpec {
  const metrics = kpiMetrics(state, y);
  const prevY = prevYearOf(state, y);
  const headers = ['主要指標', `${y.label}（${y.lastFilledIndex + 1}ヶ月）`,
    prevY ? `前年同期（${prevY.label}）` : '前年同期', '増減', '補足'];
  const nCols = headers.length;
  const aoa: Cell[][] = [];
  const merges: { s: { r: number; c: number }; e: { r: number; c: number } }[] = [];
  const pad = (row: Cell[]): Cell[] => { while (row.length < nCols) row.push(empty); return row; };

  aoa.push(pad([titleCell('主要指標')]));
  merges.push({ s: { r: 0, c: 0 }, e: { r: 0, c: nCols - 1 } });
  aoa.push(pad([subCell(`${company}　${y.label}　実績 ${y.lastFilledIndex + 1}ヶ月　（金額の単位: 円）`)]));
  merges.push({ s: { r: 1, c: 0 }, e: { r: 1, c: nCols - 1 } });
  aoa.push(pad([]));
  const headRowIdx = aoa.length;
  aoa.push(headers.map((h, i) => th(h, i === 0 || i === nCols - 1 ? 'left' : 'center')));

  const rep = calYm(y, y.lastFilledIndex);
  // 累計の指標 → 空行 → 報告月の単月の指標（画面のダッシュボードと同じ並び）
  const blocks: { head: string[] | null; metrics: KpiMetric[] }[] = [
    { head: null, metrics },
    {
      head: [`報告月の単月実績（${rep.year}年${rep.month}月）`, `${rep.month}月 単月`, '前年同月', '増減', '補足'],
      metrics: monthKpiMetrics(state, y),
    },
  ];
  for (const block of blocks) {
  if (block.head) {
    aoa.push(pad([]));
    aoa.push(block.head.map((h, i) => th(h, i === 0 || i === nCols - 1 ? 'left' : 'center')));
  }
  for (const m of block.metrics) {
    const val = (v: number | null): Cell => {
      if (v === null) return numCell(null, 'none', false, 'detail', false);
      if (m.unit === 'pct') {
        return {
          v: v * 100, t: 'n',
          s: {
            font: font({ bold: true }), border: boxAll,
            alignment: { horizontal: 'right', vertical: 'center' }, numFmt: '#,##0.0"%"',
          },
        };
      }
      return numCell(v, 'amount', v < 0, 'detail', false);
    };
    aoa.push(pad([
      nameCell(m.label, 'group', 0, false),
      val(m.value),
      val(m.prev),
      {
        v: m.deltaText ?? '—', t: 's',
        s: {
          font: font({ bold: true, color: { rgb: m.tone === 'good' ? '12855F' : m.tone === 'bad' ? NEG : MUTED } }),
          border: boxAll, alignment: { horizontal: 'right', vertical: 'center' },
        },
      },
      { v: m.note, t: 's', s: { font: font({ color: { rgb: MUTED } }), border: boxAll, alignment: { vertical: 'center' } } },
    ]));
  }
  }
  return {
    name: '主要指標', aoa, merges, headRowIdx, freezeCols: 1, nCols,
    cols: [{ wch: 30 }, { wch: 20 }, { wch: 20 }, { wch: 15 }, { wch: 52 }],
  };
}

/** CF計算書の明細シート（画面と同じ CF_ROWS を使う）。 */
function buildCfSheet(state: State, y: FiscalYearData, company: string): SheetSpec {
  const cf = cashFlowOf(state, y);
  const monthAt = new Map(cf.months.map(m => [m.mi, m]));
  const labels = Array.from({ length: 12 }, (_, i) => `${calYm(y, i).month}月`);
  const headers = ['項目', ...labels, '合計'];
  const nCols = headers.length;
  const aoa: Cell[][] = [];
  const merges: { s: { r: number; c: number }; e: { r: number; c: number } }[] = [];
  const pad = (row: Cell[]): Cell[] => { while (row.length < nCols) row.push(empty); return row; };

  aoa.push(pad([titleCell('キャッシュ・フロー計算書（簡便法・間接法）')]));
  merges.push({ s: { r: 0, c: 0 }, e: { r: 0, c: nCols - 1 } });
  aoa.push(pad([subCell(
    `${company}　${y.label}　実績 ${y.lastFilledIndex + 1}ヶ月　（単位: 円）`
    + '　※ 営業CF＋投資CF＋財務CF＝現預金の増減 が一致します',
  )]));
  merges.push({ s: { r: 1, c: 0 }, e: { r: 1, c: nCols - 1 } });
  aoa.push(pad([]));
  const headRowIdx = aoa.length;
  aoa.push(headers.map((h, i) => th(h, i === 0 ? 'left' : 'center')));

  for (const row of CF_ROWS.filter(r => !r.optional || r.pick(cf.sums) !== 0)) {
    // 区分計は強調、内訳は1文字下げる（画面と同じ並び）
    const kind: 'group' | 'detail' = row.section || row.last ? 'group' : 'detail';
    const line: Cell[] = [nameCell(row.label, kind, row.indent ? 1 : 0, false)];
    for (let i = 0; i < 12; i++) {
      const m = monthAt.get(i);
      if (!m) line.push(numCell(null, 'none', false, kind, false));
      else { const v = row.pick(m); line.push(numCell(v, 'amount', v < 0, kind, false)); }
    }
    const total = row.pick(cf.sums);
    line.push(numCell(total, 'amount', total < 0, kind, false, true));
    aoa.push(pad(line));
  }
  return {
    name: 'CF計算書', aoa, merges, headRowIdx, freezeCols: 1, nCols,
    cols: [{ wch: 34 }, ...Array.from({ length: 12 }, () => ({ wch: 13 })), { wch: 15 }],
  };
}

/**
 * 月次報告一式をExcelでダウンロードする。
 * 主要指標 / 月次推移（損益）/ 月次推移（貸借）/ CF計算書 の4シート。
 */
export async function exportReportBookXlsx(state: State, y: FiscalYearData, company: string): Promise<void> {
  const sheets: SheetSpec[] = [
    buildKpiSheet(state, y, company),
    buildTrendSheet(buildTrend(state, y, 'PL', 'amount'), company),
    buildTrendSheet(buildTrend(state, y, 'BS', 'amount'), company),
    buildCfSheet(state, y, company),
  ];
  await writeBook(sheets, `月次報告_${company || '顧問先'}_${y.label}.xlsx`);
}
