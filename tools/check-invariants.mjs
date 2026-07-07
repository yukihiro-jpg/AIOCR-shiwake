/*
  スイート全体の「壊れやすい不変条件」を機械チェックするスクリプト。
  npm run build の先頭で実行され、違反があるとビルドを失敗させる。

  背景（過去に実際に起きたバグ）:
  - komonに新タブを追加したが KOMON_ONLY に入れず、顧問先情報ビューで非表示になった
  - 新しい per-client Firebaseノード（kakunin等）を追加したが、顧問先削除の purge に入れず残存した
  - 公開トークン配下の Storage を RTDB削除だけで放置し、画像実体が永久に残った
  - per-client localStorage キーを STORAGE_KEY_MAP に入れず、端末間同期・バックアップから漏れた
  - Gemini呼び出しにタイムアウトが無く、通信ハングで画面が固まった

  新しいノード/キー/タブを追加するときは、このファイルの登録表（REGISTRY等）に追記すること。
  詳細は CLAUDE.md の「開発チェックリスト」を参照。
*/
import { readFileSync, readdirSync, statSync, writeFileSync, mkdtempSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const errors = []
const fail = (msg) => errors.push(msg)

function walk(dir, exts, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === '.git' || name === 'embedded.ts') continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, exts, out)
    else if (exts.some((e) => name.endsWith(e))) out.push(p)
  }
  return out
}
const read = (p) => readFileSync(p, 'utf8')

// ============================================================
// A. per-client Firebase ノードの登録表（modulePath の第1引数）
//    新しいモジュールキーを使い始めたら、ここに追加し、削除経路を必ず決めること。
//    purge:  'komon-direct' = purgeClientExternal がRTDB直削除
//            'queue'        = purgeキュー方式（Storage実体があるため。process*PurgeQueue必須）
//            'internal'     = komon自身のデータ（deleteClientのローカル掃除で対応）
//            'global'       = per-clientデータを持たない
// ============================================================
const REGISTRY = {
  komon: 'internal',
  shinchoku: 'internal',
  keiei: 'komon-direct',
  'aiocr-shiwake': 'komon-direct',
  souzoku: 'komon-direct',
  kakunin: 'komon-direct',
  nenmatsu: 'queue',
  scan: 'queue',
}

{
  const files = [
    ...walk(join(ROOT, 'src'), ['.ts', '.tsx']),
    join(ROOT, 'app-sources/komon/index.html'),
    join(ROOT, 'app-sources/souzoku/index.html'),
  ]
  const used = new Set()
  for (const f of files) {
    const s = read(f)
    for (const m of s.matchAll(/modulePath\(\s*['"]([A-Za-z0-9_-]+)['"]/g)) used.add(m[1])
  }
  for (const key of used) {
    if (!(key in REGISTRY)) {
      fail(`[A] 未登録のモジュールキー modulePath('${key}') が使われています。tools/check-invariants.mjs の REGISTRY に追加し、顧問先削除時の掃除経路（komon purge か purgeキュー）を決めてください。`)
    }
  }

  // purgeClientExternal のカバレッジ（komon HTML 内）
  const komon = read(join(ROOT, 'app-sources/komon/index.html'))
  const pm = komon.match(/async function purgeClientExternal\([\s\S]*?\n\}/)
  if (!pm) fail('[A] komon の purgeClientExternal が見つかりません')
  else {
    const body = pm[0]
    for (const [key, mode] of Object.entries(REGISTRY)) {
      if (mode === 'internal' || mode === 'global') continue
      if (!body.includes(`'${key}'`)) {
        fail(`[A] purgeClientExternal がモジュール '${key}' を掃除していません（顧問先削除でデータが残ります）`)
      }
      if (mode === 'queue' && !new RegExp(`modulePath\\('${key}','_purgeQueue'`).test(body.replace(/\s+/g, ''))) {
        fail(`[A] '${key}' は Storage実体を持つため purge キュー方式が必須ですが、purgeClientExternal に ${key}/_purgeQueue への登録がありません`)
      }
    }
  }
  // キュー処理側の配線（Storage削除は各モジュールの事務所画面が行う）
  const scanContent = read(join(ROOT, 'src/components/scan/ScanContent.tsx'))
  if (!scanContent.includes('processScanPurgeQueue(')) fail('[A] ScanContent が processScanPurgeQueue を呼んでいません（scanのpurgeキューが処理されません）')
  const nenContent = read(join(ROOT, 'src/components/nenmatsu/NenmatsuContent.tsx'))
  if (!nenContent.includes('processNenmatsuPurgeQueue(')) fail('[A] NenmatsuContent が processNenmatsuPurgeQueue を呼んでいません（年調のpurgeキューが処理されません）')
}

// ============================================================
// B. komon のタブ整合（nav data-page ↔ page-セクション ↔ KOMON_ONLY）
// ============================================================
{
  const komon = read(join(ROOT, 'app-sources/komon/index.html'))
  const navIds = [...komon.matchAll(/data-page="([a-z-]+)"/g)].map((m) => m[1])
  const sectionIds = [...komon.matchAll(/<section id="page-([a-z-]+)"/g)].map((m) => m[1])
  for (const id of navIds) {
    if (!sectionIds.includes(id)) fail(`[B] nav の data-page="${id}" に対応する <section id="page-${id}"> がありません`)
  }
  for (const id of sectionIds) {
    if (!navIds.includes(id)) fail(`[B] <section id="page-${id}"> に対応する nav リンクがありません`)
  }
  const ko = komon.match(/KOMON_ONLY=\[([^\]]*)\]/)
  if (!ko) fail('[B] KOMON_ONLY が見つかりません')
  else {
    const ids = [...ko[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1])
    for (const id of ids) {
      if (!navIds.includes(id)) fail(`[B] KOMON_ONLY の '${id}' が nav に存在しません`)
    }
  }
}

// ============================================================
// C. 仕訳作成の per-client localStorage キー（同期・バックアップ漏れ防止）
//    STORAGE_KEY_MAP か、意図的に端末ローカルとする ALLOW_LOCAL に必ず載せること。
// ============================================================
{
  const mapSrc = read(join(ROOT, 'src/lib/bank-statement/storage-keys.ts'))
  const mapped = [...mapSrc.matchAll(/\(cid\)\s*=>\s*`([^`]*)\$\{cid\}([^`]*)`/g)].map((m) => ({ pre: m[1], post: m[2] }))
  // 意図的に端末ローカル（同期しない）キー。追加時は理由をコメントで残すこと。
  const ALLOW_LOCAL = [
    { pre: 'keiei-years-', post: '' },     // keieiはリモート優先で独自同期（store.ts）
    { pre: 'keiei-settings-', post: '' },  // 同上
    { pre: 'bs-excel-mapping-', post: '-' }, // 旧形式（科目CD付き）。読込時に新形式へ移行済み
  ]
  const files = walk(join(ROOT, 'src'), ['.ts', '.tsx'])
  for (const f of files) {
    const s = read(f)
    for (const m of s.matchAll(/`([A-Za-z0-9_-]+-)\$\{cid\}([^`]*)`/g)) {
      const pre = m[1], post = m[2]
      const ok = mapped.some((k) => k.pre === pre && k.post === post) ||
        ALLOW_LOCAL.some((k) => pre.startsWith(k.pre) || (k.pre === pre && post.startsWith(k.post)))
      if (!ok) {
        fail(`[C] per-client localStorage キー \`${pre}\${cid}${post}\` (${f.replace(ROOT + '/', '')}) が STORAGE_KEY_MAP にも ALLOW_LOCAL にもありません。同期/バックアップ対象なら STORAGE_KEY_MAP へ、端末ローカルなら check-invariants の ALLOW_LOCAL へ追加してください。`)
      }
    }
  }
}

// ============================================================
// D. Gemini 呼び出しの安全策（タイムアウト必須）
// ============================================================
{
  const gc = read(join(ROOT, 'src/lib/bank-statement/gemini-client.ts'))
  const direct = [...gc.matchAll(/genAI\(\)\.getGenerativeModel/g)].length
  if (direct !== 1) fail(`[D] bank-statement/gemini-client.ts の genAI().getGenerativeModel 直呼びは gm() 内の1箇所だけにしてください（現在 ${direct} 箇所）。タイムアウト無しの呼び出しはハングの原因になります。`)
  for (const f of walk(join(ROOT, 'src'), ['.ts', '.tsx'])) {
    if (f.endsWith('gemini-client.ts')) continue
    const s = read(f)
    if (/getGenerativeModel\(/.test(s) && !/getGenerativeModel\([^)]*\)\s*,\s*\{[^}]*timeout/.test(s) && !/\{\s*timeout\s*:/.test(s)) {
      fail(`[D] ${f.replace(ROOT + '/', '')} の getGenerativeModel にタイムアウト指定（第2引数 { timeout: … }）がありません`)
    }
  }
}

// ============================================================
// E. 単一HTMLモジュールの最大<script>が構文エラーでないこと
// ============================================================
{
  const tmp = mkdtempSync(join(tmpdir(), 'inv-'))
  for (const name of ['komon', 'souzoku']) {
    const html = read(join(ROOT, `app-sources/${name}/index.html`))
    let best = ''
    for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
      if (m[1].length > best.length) best = m[1]
    }
    const p = join(tmp, `${name}.js`)
    writeFileSync(p, best)
    try { execFileSync(process.execPath, ['--check', p], { stdio: 'pipe' }) }
    catch (e) { fail(`[E] app-sources/${name}/index.html の <script> が構文エラーです:\n${String(e.stderr || e.message).slice(0, 500)}`) }
  }
}

// ============================================================
if (errors.length) {
  console.error(`\n✗ 不変条件チェックに失敗（${errors.length}件）:\n`)
  for (const e of errors) console.error('  - ' + e + '\n')
  process.exit(1)
}
console.log('✓ check-invariants: OK（purge登録表・タブ整合・localStorage登録・Geminiタイムアウト・HTML構文）')
