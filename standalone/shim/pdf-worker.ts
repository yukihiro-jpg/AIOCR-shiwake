// pdfjs のワーカー指定を絶対https URLに固定する（standalone専用）。
// 元コード(pdf-text-parser.ts)は「未設定のときだけ」protocol-relative("//cdnjs...")を設定するため、
// file:// で開くと "file://cdnjs..." と誤解釈され失敗する。
// アプリ本体の import より前にここで設定しておけば、元コードは上書きしない。
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf'

if (typeof window !== 'undefined' && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'
}
