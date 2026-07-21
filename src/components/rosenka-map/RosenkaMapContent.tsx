'use client'

// 路線価マップ: 住所検索 → 地図（地理院タイル）＋国税庁 路線価図PDFの並列表示。
// 年分切替（当年〜過去分）・図郭の推定範囲・公図/地理院地図リンク・都市計画区分表示。
// データ取得はすべてブラウザ内（ジオコーダはCORS許可の地理院API・PDFは国税庁への直リンク/iframe）。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import 'leaflet/dist/leaflet.css'
import type { Map as LeafletMap, Rectangle, CircleMarker } from 'leaflet'
import {
  type RosenkaIndex, type RosenkaManifest, type TownMatch,
  rosenkaPdfUrl, rosenkaViewerUrl, rosenkaCityIndexUrl, rosenkaYearTopUrl, rosenkaRatiosUrl,
  rosenkaMirrorPdfUrl, NTA_TOP_URL,
} from '@/lib/rosenka-map/types'
import { loadManifest, loadIndex, matchAddress, normalizeTown } from '@/lib/rosenka-map/index-store'
import { geocode, geocodeTownCached, type GeocodeHit } from '@/lib/rosenka-map/gsi'
import { loadToshiData, lookupToshi, type ToshiHit } from '@/lib/rosenka-map/toshi'
import { ibarakiDigitalMapUrl, cityToshiUrl } from '@/lib/rosenka-map/toshi-links'
import type { ToshiData } from '@/lib/rosenka-map/types'

const HISTORY_KEY = 'rosenka-map-history'

function loadHistory(): string[] {
  try { const r = localStorage.getItem(HISTORY_KEY); if (r) return JSON.parse(r) } catch { /* ignore */ }
  return []
}
function pushHistory(q: string): void {
  try {
    const h = [q, ...loadHistory().filter((x) => x !== q)].slice(0, 8)
    localStorage.setItem(HISTORY_KEY, JSON.stringify(h))
  } catch { /* ignore */ }
}

export default function RosenkaMapContent() {
  const [manifest, setManifest] = useState<RosenkaManifest | null | undefined>(undefined)
  const [yearId, setYearId] = useState('')
  const [index, setIndex] = useState<RosenkaIndex | null>(null)
  const [query, setQuery] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [point, setPoint] = useState<{ lat: number; lng: number; title: string } | null>(null)
  const [hits, setHits] = useState<GeocodeHit[]>([])
  const [matches, setMatches] = useState<TownMatch[]>([])
  const [selTown, setSelTown] = useState('')
  const [selSheet, setSelSheet] = useState('')
  const [extentNote, setExtentNote] = useState('')
  const [toshi, setToshi] = useState<ToshiData | null | undefined>(undefined)
  const [toshiHit, setToshiHit] = useState<ToshiHit | null>(null)
  // PDF表示: ミラー（raw・CORS可）から取得して blob URL で表示。'loading' | 'error' | blob URL
  const [pdfView, setPdfView] = useState<'none' | 'loading' | 'error' | string>('none')
  const pdfBlobRef = useRef<string | null>(null)

  const mapRef = useRef<LeafletMap | null>(null)
  const markerRef = useRef<CircleMarker | null>(null)
  const rectRef = useRef<Rectangle | null>(null)
  const mapDivRef = useRef<HTMLDivElement>(null)
  const extentSeq = useRef(0)

  // ---- 初期化: マニフェスト・都市計画データ・地図 ----
  useEffect(() => {
    setHistory(loadHistory())
    loadManifest().then((m) => {
      setManifest(m)
      if (m?.years?.length) setYearId(m.years[0].id)
    })
    loadToshiData('ibaraki').then((d) => setToshi(d))
  }, [])

  useEffect(() => {
    let disposed = false
    ;(async () => {
      if (!mapDivRef.current || mapRef.current) return
      const L = (await import('leaflet')).default
      if (disposed || !mapDivRef.current || mapRef.current) return
      const map = L.map(mapDivRef.current, { zoomControl: true }).setView([36.366, 140.446], 13) // 水戸市
      L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', {
        maxZoom: 18,
        attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noreferrer">地理院タイル</a>',
      }).addTo(map)
      mapRef.current = map
    })()
    return () => {
      disposed = true
      if (mapRef.current) { mapRef.current.remove(); mapRef.current = null }
    }
  }, [])

  // ---- 年分の索引読込 ----
  const prefSlug = manifest?.prefs?.[0]?.slug || 'ibaraki'
  useEffect(() => {
    if (!yearId) return
    loadIndex(yearId, prefSlug).then((idx) => {
      setIndex(idx)
    })
  }, [yearId, prefSlug])

  // 年切替時: 同じ住所を新しい年の索引で照合し直す（図番号は年により変わるため流用しない）
  useEffect(() => {
    if (!index || !point) return
    const m = matchAddress(index, point.title)
    setMatches(m.matches)
    const prevNorm = normalizeTown(selTown)
    const keep = m.matches.find((x) => normalizeTown(x.town) === prevNorm) || m.matches[0] || null
    setSelTown(keep?.town || '')
    setSelSheet(keep?.sheets[0] || '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index])

  // ---- 検索 ----
  const runSearch = useCallback(async (q?: string) => {
    const text = (q ?? query).trim()
    if (!text || busy) return
    setBusy(true)
    setErr('')
    setHits([])
    try {
      const results = await geocode(text)
      if (!results.length) {
        setErr('住所が見つかりませんでした。表記を変えてお試しください（例: 茨城県水戸市姫子2丁目）')
        return
      }
      pushHistory(text)
      setHistory(loadHistory())
      if (results.length > 1 && !results[0].title.includes(text.replace(/[ 　]/g, ''))) setHits(results.slice(0, 6))
      selectHit(results[0])
    } catch (e) {
      setErr('検索に失敗しました（地理院ジオコーダに接続できません）: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, busy, index, toshi])

  const selectHit = useCallback((hit: GeocodeHit) => {
    setPoint({ lat: hit.lat, lng: hit.lng, title: hit.title })
    // 地図
    const map = mapRef.current
    if (map) {
      import('leaflet').then(({ default: L }) => {
        if (!mapRef.current) return
        if (markerRef.current) markerRef.current.remove()
        markerRef.current = L.circleMarker([hit.lat, hit.lng], {
          radius: 9, color: '#1d4ed8', weight: 3, fillColor: '#3b82f6', fillOpacity: 0.5,
        }).addTo(mapRef.current)
        mapRef.current.setView([hit.lat, hit.lng], 16)
      })
    }
    // 町丁の照合
    if (index) {
      const m = matchAddress(index, hit.title)
      setMatches(m.matches)
      setSelTown(m.matches[0]?.town || '')
      setSelSheet(m.matches[0]?.sheets[0] || '')
    }
    // 都市計画区分
    if (toshi) setToshiHit(lookupToshi(toshi, hit.lng, hit.lat))
    else setToshiHit(null)
  }, [index, toshi])

  // ---- 図郭の推定範囲（同じ図番号の町丁の位置から概算・キャッシュ付き） ----
  useEffect(() => {
    const seq = ++extentSeq.current
    if (rectRef.current) { rectRef.current.remove(); rectRef.current = null }
    setExtentNote('')
    if (!index || !selSheet || !selTown) return
    const city = matches.find((m) => m.town === selTown)?.city
    if (!city) return
    const towns = Object.keys(city.towns).filter((t) => (city.towns[t] || []).includes(selSheet)).slice(0, 12)
    if (towns.length < 2) return // 1町丁だけでは範囲を推定しない（誤解を招くため）
    ;(async () => {
      setExtentNote(`図郭の範囲を推定中…（${towns.length}町丁を照合）`)
      const pts: [number, number][] = []
      for (const t of towns) {
        if (extentSeq.current !== seq) return
        const p = await geocodeTownCached(index.prefName, city.name, t)
        if (p) pts.push(p)
      }
      if (extentSeq.current !== seq) return
      if (pts.length < 2) { setExtentNote(''); return }
      let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity
      for (const [lng, lat] of pts) {
        minLng = Math.min(minLng, lng); maxLng = Math.max(maxLng, lng)
        minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat)
      }
      const padLng = Math.max((maxLng - minLng) * 0.25, 0.003)
      const padLat = Math.max((maxLat - minLat) * 0.25, 0.002)
      const { default: L } = await import('leaflet')
      if (extentSeq.current !== seq || !mapRef.current) return
      rectRef.current = L.rectangle(
        [[minLat - padLat, minLng - padLng], [maxLat + padLat, maxLng + padLng]],
        { color: '#b45309', weight: 2, dashArray: '6 4', fillOpacity: 0.04 },
      ).addTo(mapRef.current)
      setExtentNote(`橙の枠 = 図${selSheet}の推定範囲（町丁名索引に基づく概算・正確な図郭ではありません）`)
    })()
  }, [index, selSheet, selTown, matches])

  // ---- PDFの取得（ミラー→blob。国税庁PDFはXFOで直接iframe不可のため） ----
  useEffect(() => {
    if (pdfBlobRef.current) { URL.revokeObjectURL(pdfBlobRef.current); pdfBlobRef.current = null }
    if (!index || !selSheet) { setPdfView('none'); return }
    let cancelled = false
    setPdfView('loading')
    ;(async () => {
      try {
        const res = await fetch(rosenkaMirrorPdfUrl(index, selSheet))
        if (!res.ok) throw new Error(String(res.status))
        const buf = await res.arrayBuffer()
        const head = new Uint8Array(buf.slice(0, 5))
        if (String.fromCharCode(head[0], head[1], head[2], head[3], head[4]) !== '%PDF-') throw new Error('not pdf')
        if (cancelled) return
        const url = URL.createObjectURL(new Blob([buf], { type: 'application/pdf' }))
        pdfBlobRef.current = url
        setPdfView(url)
      } catch {
        if (!cancelled) setPdfView('error')
      }
    })()
    return () => { cancelled = true }
  }, [index, selSheet])

  // ---- 表示用 ----
  const curMatch = matches.find((m) => m.town === selTown) || null
  const pdfUrl = index && selSheet ? rosenkaPdfUrl(index, selSheet) : ''
  const yearIdx = manifest?.years.findIndex((y) => y.id === yearId) ?? -1
  const changeYear = useCallback((d: number) => {
    if (!manifest) return
    const i = yearIdx + d
    if (i >= 0 && i < manifest.years.length) setYearId(manifest.years[i].id)
  }, [manifest, yearIdx])

  const mappleUrl = point ? `https://labs.mapple.com/mapplexml.html#17.00/${point.lat.toFixed(6)}/${point.lng.toFixed(6)}` : ''
  const gsiMapUrl = point ? `https://maps.gsi.go.jp/#17/${point.lat.toFixed(6)}/${point.lng.toFixed(6)}` : ''

  // 隣接図面（東西南北）ナビ
  const adjacent = (index?.adj && selSheet && index.adj[selSheet]) || null
  const goAdjacent = useCallback((dir: 'n' | 's' | 'e' | 'w') => {
    const target = adjacent?.[dir]
    if (target) setSelSheet(target)
  }, [adjacent])

  const fmtPct = (v?: number) => (v != null && v > 0 ? `${v}` : '—')

  return (
    <div className="h-screen flex flex-col bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-4 py-2.5 flex items-center gap-3 shrink-0 flex-wrap">
        <Link href="/" className="text-sm text-blue-600 hover:underline shrink-0">← ホーム</Link>
        <h1 className="text-lg font-bold text-gray-800 shrink-0">🗺 路線価マップ</h1>
        <div className="flex items-center gap-2 flex-1 min-w-[280px]">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') runSearch() }}
            placeholder="住所を入力（例: 茨城県水戸市姫子2丁目）"
            className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm"
            list="rosenka-history"
          />
          <datalist id="rosenka-history">
            {history.map((h) => <option key={h} value={h} />)}
          </datalist>
          <button onClick={() => runSearch()} disabled={busy || !query.trim()}
            className="px-4 py-2 bg-[#1F3A5F] text-white rounded-lg text-sm font-bold hover:brightness-110 disabled:opacity-40 shrink-0">
            {busy ? '検索中…' : '路線価図を表示'}
          </button>
        </div>
      </header>

      {/* 照合結果バー */}
      {(point || err || manifest === null) && (
        <div className="bg-amber-50/60 border-b border-amber-100 px-4 py-1.5 text-xs flex items-center gap-3 flex-wrap shrink-0">
          {err && <span className="text-red-600">{err}</span>}
          {manifest === null && (
            <span className="text-amber-700">
              ⚠ 路線価索引データが未生成です（初回の自動生成が完了すると住所→図面の自動対応が有効になります）。
              それまでは <a className="underline" href={NTA_TOP_URL} target="_blank" rel="noreferrer">国税庁 財産評価基準書</a> のリンクをご利用ください。
            </span>
          )}
          {point && (
            <>
              <span className="text-gray-600">📍 {point.title}</span>
              {index && curMatch && (
                <span className={`px-2 py-0.5 rounded-full font-bold ${curMatch.exact ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800'}`}>
                  {curMatch.exact ? '町丁名索引と一致 ✓' : '近い町丁を推定（下の候補から選択可）'}
                </span>
              )}
              {index && !curMatch && matches.length === 0 && (
                <span className="text-amber-700">
                  この住所は町丁名索引と自動照合できませんでした。
                  路線価図が無い市町村（<b>倍率地域</b>）の可能性があります —
                  <a className="underline mx-1" href={rosenkaRatiosUrl(index)} target="_blank" rel="noreferrer">評価倍率表を開く ↗</a>／
                  <a className="underline ml-1" href={rosenkaYearTopUrl(index.year)} target="_blank" rel="noreferrer">町丁名索引 ↗</a>
                </span>
              )}
              {matches.length > 0 && (
                <span className="flex items-center gap-1 flex-wrap">
                  {matches.slice(0, 8).map((m) => (
                    <button key={m.town}
                      onClick={() => { setSelTown(m.town); setSelSheet(m.sheets[0] || '') }}
                      className={`px-2 py-0.5 rounded border text-[11px] ${m.town === selTown ? 'bg-[#1F3A5F] text-white border-[#1F3A5F]' : 'bg-white border-gray-300 hover:border-blue-400'}`}>
                      {m.town}
                    </button>
                  ))}
                </span>
              )}
              {curMatch && curMatch.sheets.length > 0 && (
                <span className="flex items-center gap-1 flex-wrap">
                  <span className="text-gray-500">図:</span>
                  {curMatch.sheets.map((s) => (
                    <button key={s} onClick={() => setSelSheet(s)}
                      className={`px-2 py-0.5 rounded border font-mono text-[11px] ${s === selSheet ? 'bg-blue-600 text-white border-blue-600' : 'bg-white border-gray-300 hover:border-blue-400'}`}>
                      {s}
                    </button>
                  ))}
                </span>
              )}
            </>
          )}
          {hits.length > 0 && (
            <span className="flex items-center gap-1 flex-wrap">
              <span className="text-gray-500">他の候補:</span>
              {hits.map((h, i) => (
                <button key={i} onClick={() => selectHit(h)}
                  className="px-2 py-0.5 rounded border bg-white border-gray-300 text-[11px] hover:border-blue-400">{h.title}</button>
              ))}
            </span>
          )}
        </div>
      )}

      {/* 都市計画区分バー */}
      {point && (
        <div className="bg-white border-b border-gray-200 px-4 py-1.5 text-xs flex items-center gap-3 flex-wrap shrink-0">
          <span className="font-bold text-gray-700">都市計画</span>
          {toshi === undefined && <span className="text-gray-400">読込中…</span>}
          {toshi === null && (
            <span className="text-gray-400">
              データ準備中（生成が完了すると区域区分・用途地域・建蔽率・容積率をここに表示します）
            </span>
          )}
          {toshi && toshiHit && (
            <>
              {/* 区域区分はデータに区分レイヤーがあるときのみ表示（無いのに「該当なし」と出すと誤解を招く） */}
              {toshi.features.some((f) => f.layer === 'kubun') && (
                <span className={`px-2 py-0.5 rounded font-bold ${toshiHit.kubun ? 'bg-emerald-100 text-emerald-800' : 'bg-gray-100 text-gray-500'}`}>
                  {toshiHit.kubun ? toshiHit.kubun.name : '区域区分の該当なし'}
                </span>
              )}
              <span className={`px-2 py-0.5 rounded font-bold ${toshiHit.youto ? 'bg-indigo-100 text-indigo-800' : 'bg-gray-100 text-gray-500'}`}>
                {toshiHit.youto ? toshiHit.youto.name : '用途地域の指定なし'}
              </span>
              {toshiHit.youto && (
                <span className="text-gray-600">建蔽率 {fmtPct(toshiHit.youto.kenpei)}％ ／ 容積率 {fmtPct(toshiHit.youto.yoseki)}％</span>
              )}
              <span className="text-gray-400">
                ※{toshi.year}の参考判定です。<b>最新の確認は右のボタンの公式図で</b>
              </span>
            </>
          )}
          {/* 最新の公式図への導線（判定データの有無に関わらず表示） */}
          <span className="ml-auto flex items-center gap-1.5">
            {curMatch && ibarakiDigitalMapUrl(curMatch.city.name, point.lng, point.lat) && (
              <a href={ibarakiDigitalMapUrl(curMatch.city.name, point.lng, point.lat)!} target="_blank" rel="noreferrer"
                title={`いばらきデジタルまっぷの「都市計画（${curMatch.city.name}）」をこの地点で開く`}
                className="px-2 py-1 bg-emerald-700 text-white rounded font-bold hover:brightness-110">
                🗾 デジタルまっぷで確認 ↗
              </a>
            )}
            {curMatch && (
              <a href={cityToshiUrl(curMatch.city.name)} target="_blank" rel="noreferrer"
                title={`${curMatch.city.name}の都市計画図（公式サイト）を開く`}
                className="px-2 py-1 border border-emerald-700 text-emerald-800 rounded font-bold hover:bg-emerald-50">
                {curMatch.city.name}の都市計画図 ↗
              </a>
            )}
          </span>
        </div>
      )}

      {/* 本体: 左=地図 / 右=PDF */}
      <div className="flex-1 flex min-h-0">
        <div className="w-1/2 relative border-r border-gray-300">
          <div ref={mapDivRef} className="absolute inset-0" />
          {extentNote && (
            <div className="absolute left-2 bottom-2 z-[1000] bg-white/90 rounded px-2 py-1 text-[11px] text-amber-800 shadow">
              {extentNote}
            </div>
          )}
        </div>
        <div className="w-1/2 flex flex-col min-h-0">
          <div className="bg-white border-b border-gray-200 px-3 py-1.5 flex items-center gap-2 flex-wrap shrink-0">
            {manifest && manifest.years.length > 0 && (
              <span className="flex items-center gap-1">
                <button onClick={() => changeYear(1)} disabled={yearIdx >= manifest.years.length - 1}
                  title="前の年分" className="px-1.5 py-0.5 text-xs bg-gray-100 rounded disabled:opacity-30 hover:bg-gray-200">◀</button>
                <b className="text-sm min-w-[86px] text-center">{manifest.years[yearIdx]?.label || ''}</b>
                <button onClick={() => changeYear(-1)} disabled={yearIdx <= 0}
                  title="次の年分" className="px-1.5 py-0.5 text-xs bg-gray-100 rounded disabled:opacity-30 hover:bg-gray-200">▶</button>
              </span>
            )}
            {pdfUrl && (
              <a href={pdfUrl} target="_blank" rel="noreferrer"
                className="px-2 py-1 text-xs border border-gray-300 rounded hover:border-blue-400">PDFを別タブで ↗</a>
            )}
            {index && selSheet && (
              <a href={rosenkaViewerUrl(index, selSheet)} target="_blank" rel="noreferrer"
                className="px-2 py-1 text-xs border border-gray-300 rounded hover:border-blue-400">国税庁ページ ↗</a>
            )}
            {index && curMatch && (
              <a href={rosenkaCityIndexUrl(index, curMatch.city.code)} target="_blank" rel="noreferrer"
                className="px-2 py-1 text-xs border border-gray-300 rounded hover:border-blue-400">町丁名索引 ↗</a>
            )}
            {mappleUrl && (
              <a href={mappleUrl} target="_blank" rel="noreferrer"
                className="px-2 py-1 text-xs bg-[#1F3A5F] text-white rounded hover:brightness-110">📄 公図 ↗</a>
            )}
            {gsiMapUrl && (
              <a href={gsiMapUrl} target="_blank" rel="noreferrer"
                className="px-2 py-1 text-xs border border-gray-300 rounded hover:border-blue-400">地理院地図 ↗</a>
            )}
            {/* 隣接図面ナビ（東西南北）: 索引の接続図データから移動 */}
            {selSheet && (
              <span className="ml-auto flex items-center gap-1">
                <span className="text-[11px] text-gray-500 font-mono mr-0.5">図{selSheet}</span>
                <button onClick={() => goAdjacent('w')} disabled={!adjacent?.w}
                  title={adjacent?.w ? `西の図面（${adjacent.w}）へ` : '西の接続図なし'}
                  className="px-2 py-1 text-xs border border-gray-300 rounded hover:border-blue-400 hover:bg-blue-50 disabled:opacity-30 disabled:hover:bg-transparent font-bold">←西</button>
                <span className="flex flex-col gap-0.5">
                  <button onClick={() => goAdjacent('n')} disabled={!adjacent?.n}
                    title={adjacent?.n ? `北の図面（${adjacent.n}）へ` : '北の接続図なし'}
                    className="px-2 py-0 text-[11px] border border-gray-300 rounded hover:border-blue-400 hover:bg-blue-50 disabled:opacity-30 disabled:hover:bg-transparent font-bold leading-4">↑北</button>
                  <button onClick={() => goAdjacent('s')} disabled={!adjacent?.s}
                    title={adjacent?.s ? `南の図面（${adjacent.s}）へ` : '南の接続図なし'}
                    className="px-2 py-0 text-[11px] border border-gray-300 rounded hover:border-blue-400 hover:bg-blue-50 disabled:opacity-30 disabled:hover:bg-transparent font-bold leading-4">↓南</button>
                </span>
                <button onClick={() => goAdjacent('e')} disabled={!adjacent?.e}
                  title={adjacent?.e ? `東の図面（${adjacent.e}）へ` : '東の接続図なし'}
                  className="px-2 py-1 text-xs border border-gray-300 rounded hover:border-blue-400 hover:bg-blue-50 disabled:opacity-30 disabled:hover:bg-transparent font-bold">東→</button>
              </span>
            )}
          </div>
          <div className="flex-1 bg-gray-700 min-h-0">
            {typeof pdfView === 'string' && pdfView.startsWith('blob:') ? (
              <iframe key={pdfView} src={pdfView} title="路線価図PDF" className="w-full h-full border-0" />
            ) : pdfView === 'loading' ? (
              <div className="h-full flex items-center justify-center text-gray-300 text-sm">路線価図PDFを読み込み中…</div>
            ) : pdfView === 'error' && pdfUrl ? (
              <div className="h-full flex flex-col items-center justify-center gap-3 text-gray-300 text-sm px-8 text-center leading-relaxed">
                <div>画面内表示用のPDFミラーを取得できませんでした（ミラー生成前の可能性があります）。</div>
                <a href={pdfUrl} target="_blank" rel="noreferrer"
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-bold hover:bg-blue-700">
                  国税庁のPDFを別タブで開く ↗
                </a>
              </div>
            ) : (
              <div className="h-full flex items-center justify-center text-gray-300 text-sm px-8 text-center leading-relaxed">
                {manifest === undefined ? '読み込み中…'
                  : manifest === null ? '路線価索引データの生成待ちです。生成後、住所を検索するとここに路線価図PDFが表示されます。'
                  : '住所を検索すると、該当する路線価図PDFがここに表示されます。'}
              </div>
            )}
          </div>
        </div>
      </div>

      <footer className="bg-white border-t border-gray-200 px-4 py-1 text-[10px] text-gray-400 shrink-0 leading-relaxed">
        出典: <a className="underline" href={NTA_TOP_URL} target="_blank" rel="noreferrer">国税庁 路線価図・評価倍率表（財産評価基準書）</a>／
        <a className="underline" href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noreferrer">地理院タイル</a>・地理院ジオコーダ／
        公図表示: MAPPLE法務局地図ビューア。
        ※地図上の範囲表示は町丁名索引に基づく推定です。<b>最終確認は必ずPDF本体の記載によってください。</b>
        倍率地域は路線価図がありません（評価倍率表を参照）。都市計画区分は参考情報です。
      </footer>
    </div>
  )
}
