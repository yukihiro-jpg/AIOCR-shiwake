'use client'

// 取り込んだ元帳を画面から使えるようにする（移植元 useLedger.ts の差し替え版）。
//
// 読み込み先は、この総合管理アプリの元帳保存（IndexedDB）。
// キャッシュは **必ず顧問先IDで持つ**。同じブラウザで別の顧問先を開いたときに
// 前の顧問先の元帳が見えることは絶対にあってはならない。

import { useEffect, useState } from 'react'
import { getState } from '../api'
import { buildLedger, accountKinds } from './aggregate'
import type { Ledger, AccountKind } from './aggregate'
import { loadKrLedger } from './store'
import type { KrLedgerMeta } from './store'
import type { AliasMap } from './normalize'
import { emptyAliases } from './normalize'

interface Cache {
  clientId: string
  meta: KrLedgerMeta | null
  ledger: Ledger | null
}
let cache: Cache | null = null

function cacheFor(clientId: string): Cache | null {
  if (cache && cache.clientId !== clientId) cache = null
  return cache
}

/** 読み込み済みの元帳を捨てる（取込・名寄せ変更のあとに呼ぶ） */
export function invalidateLedger(): void {
  cache = null
}

export interface LedgerState {
  loading: boolean
  meta: KrLedgerMeta | null
  ledger: Ledger | null
  kinds: Map<string, AccountKind>
  error: string | null
  reload: () => void
}

export function useLedger(clientId: string, aliases?: AliasMap): LedgerState {
  const [tick, setTick] = useState(0)
  const [state, setState] = useState<{
    loading: boolean; meta: KrLedgerMeta | null; ledger: Ledger | null; error: string | null
  }>(() => {
    const c = cacheFor(clientId)
    return c
      ? { loading: false, meta: c.meta, ledger: c.ledger, error: null }
      : { loading: true, meta: null, ledger: null, error: null }
  })

  useEffect(() => {
    let alive = true
    const c = cacheFor(clientId)
    if (c && tick === 0) {
      setState({ loading: false, meta: c.meta, ledger: c.ledger, error: null })
      return
    }
    setState((s) => ({ ...s, loading: true, error: null }))
    void (async () => {
      try {
        const al = aliases || emptyAliases()
        const { meta, entries } = await loadKrLedger(clientId, al)
        if (!alive) return
        if (!meta) {
          cache = { clientId, meta: null, ledger: null }
          setState({ loading: false, meta: null, ledger: null, error: null })
          return
        }
        const ledger = buildLedger(entries, meta.from, meta.to, al)
        cache = { clientId, meta, ledger }
        setState({ loading: false, meta, ledger, error: null })
      } catch (e) {
        if (!alive) return
        setState({
          loading: false, meta: null, ledger: null,
          error: e instanceof Error ? e.message : String(e),
        })
      }
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, tick])

  return {
    ...state,
    kinds: accountKinds(getState()),
    reload: () => { invalidateLedger(); setTick((t) => t + 1) },
  }
}

/** 名寄せの指定を変えた元帳を組み直す（保存は呼び出し側で行う） */
export function rebuildWithAliases(led: Ledger, aliases: AliasMap): Ledger {
  return buildLedger(led.entries, led.from, led.to, aliases)
}
