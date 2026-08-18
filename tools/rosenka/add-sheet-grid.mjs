// 既存の路線価索引JSONに sheetGrid（図面の格子座標）を後付けするツール。
// build-rosenka-index.mjs は年次実行時に sheetGrid を含めて生成するようになったが、
// 生成済みのJSONを作り直さずに済むよう、adj から同じ計算だけをやり直して書き足す。
//
// 使い方: node tools/rosenka/add-sheet-grid.mjs

import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeSheetGrid } from './build-rosenka-index.mjs'

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'rosenka-data', 'index')

for (const f of readdirSync(DIR).filter((x) => /^r\d{2}-[a-z]+\.json$/.test(x))) {
  const path = join(DIR, f)
  const idx = JSON.parse(readFileSync(path, 'utf8'))
  const grid = computeSheetGrid(idx.adj || {})
  const n = Object.keys(grid).length
  idx.sheetGrid = grid
  writeFileSync(path, JSON.stringify(idx))
  console.log(`${f}: sheetGrid ${n}図面を書き込み`)
}
