import * as XLSX from 'xlsx'
import type { RawTableRow } from './types'
import { readSpreadsheet } from './spreadsheet-reader'

interface ExcelPageResult {
  rows: RawTableRow[]
  sheetName: string
  htmlTable: string // HTML表示用
}

export function parseExcel(file: File): Promise<ExcelPageResult[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const data = e.target?.result as ArrayBuffer
        const workbook = readSpreadsheet(data, { cellDates: true })
        const results: ExcelPageResult[] = []

        for (const sheetName of workbook.SheetNames) {
          const sheet = workbook.Sheets[sheetName]
          if (!sheet) continue

          // JSON形式で全行取得（ヘッダーなし）
          const jsonData = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
            header: 1,
            defval: '',
            rawNumbers: false,
          })

          const rows: RawTableRow[] = []
          for (let i = 0; i < jsonData.length; i++) {
            const rowData = jsonData[i] as unknown[]
            if (!rowData || rowData.every((cell) => !String(cell ?? '').trim())) continue

            rows.push({
              cells: rowData.map((cell) => formatCellValue(cell)),
              rowIndex: i,
            })
          }

          // HTML表示用テーブル生成
          const htmlTable = XLSX.utils.sheet_to_html(sheet, {
            editable: false,
          })

          results.push({
            rows,
            sheetName,
            htmlTable,
          })
        }

        resolve(results)
      } catch (err) {
        reject(err)
      }
    }
    reader.onerror = () => reject(new Error('ファイルの読み込みに失敗しました'))
    reader.readAsArrayBuffer(file)
  })
}

// セル値を適切な文字列に変換（日付シリアル値 → YYYY-MM-DD）
function formatCellValue(cell: unknown): string {
  if (cell == null) return ''
  if (cell instanceof Date) {
    // cellDates: true の場合、Date オブジェクトとして返される
    const y = cell.getFullYear()
    const m = String(cell.getMonth() + 1).padStart(2, '0')
    const d = String(cell.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }
  return String(cell).trim()
}
