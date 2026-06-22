/*
  相続管理モジュールのデータブリッジ（ホスト側）。

  iframe 内の相続アプリは Firebase を直接触らず、postMessage で同期要求を送る。
  本ブリッジが、ホスト共通コア（getDb / modulePath）を使って
  rooms/{roomKey}/souzoku/… を読み書きし、結果を iframe に返す。

  - 読み込み: onValue(rooms/{roomKey}/souzoku) の rawスナップショット(エンコード済み)を
              そのまま iframe へ postMessage（iframe側で decode）。
  - 書き込み: iframe からの update(差分・エンコード済みパス) を update() でそのまま反映。
  - 旧データ移行: このホスト名の localStorage("souzoku_cloud_v1") に正本があり、
                  かつ新パスが空のときだけ seed（直前に JSON バックアップを自動DL）。

  ※ RTDB 禁止文字のエンコードは相続アプリ側と完全一致（先頭 "_" ＋ 禁止文字を "~<hex>"）。
*/
import { getDb } from '@/core/firebase';
import { modulePath } from '@/core/room';

const BAD = /[.#$/[\]~]/g;
function enc(k: string): string {
  return '_' + String(k).replace(BAD, (c) => '~' + c.charCodeAt(0).toString(16));
}
function encodeTree(o: any): any {
  if (Array.isArray(o)) return o.map(encodeTree);
  if (o && typeof o === 'object') {
    const r: Record<string, any> = {};
    for (const k in o) r[enc(k)] = encodeTree((o as any)[k]);
    return r;
  }
  return o;
}

export type SouzokuBridgeHandle = { dispose: () => void };

/**
 * iframe（相続アプリ）とホストの Firebase を橋渡しする。
 * @param iframe 相続アプリを描画している iframe 要素
 */
export async function startSouzokuBridge(iframe: HTMLIFrameElement): Promise<SouzokuBridgeHandle> {
  const db = await getDb();
  const { ref, onValue, update, get, set } = await import('firebase/database');
  const base = (await modulePath('souzoku')).replace(/\/+$/, ''); // => rooms/{roomKey}/souzoku（末尾スラッシュ除去）
  const node = ref(db, base);

  // ---- 旧データの自動 seed（同ホスト名の localStorage 正本があり、新パスが空のときのみ） ----
  try {
    const snap = await get(node);
    if (!snap.exists() && typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem('souzoku_cloud_v1');
      if (raw) {
        const cloud = JSON.parse(raw);
        if (cloud && cloud.cases && Object.keys(cloud.cases).length) {
          downloadBackup(cloud);
          await set(node, encodeTree({ cases: cloud.cases || {}, tomb: cloud.tomb || {} }));
        }
      }
    }
  } catch (e) {
    console.warn('[souzoku] seed skipped', e);
  }

  let lastValue: any = null;
  let gotFirst = false;

  const post = (value: any) => {
    try {
      iframe.contentWindow?.postMessage({ type: 'souzoku:data', value: value ?? null }, '*');
    } catch {
      /* noop */
    }
  };

  const onMsg = (ev: MessageEvent) => {
    const m: any = ev.data;
    if (!m || m.source !== 'souzoku') return;
    if (m.type === 'init') {
      // iframe が後から準備完了した場合に備えて、最新スナップショットを再送
      if (gotFirst) post(lastValue);
    } else if (m.type === 'update' && m.updates && Object.keys(m.updates).length) {
      // 差分（エンコード済み相対パス → 値）をそのまま反映
      update(node, m.updates).catch((e) => console.error('[souzoku] update failed', e));
    }
  };
  window.addEventListener('message', onMsg);

  const off = onValue(node, (snap) => {
    lastValue = snap.val();
    gotFirst = true;
    post(lastValue);
  });

  return {
    dispose() {
      window.removeEventListener('message', onMsg);
      try {
        off();
      } catch {
        /* noop */
      }
    },
  };
}

/** 移行前の安全のため、旧 localStorage 正本を JSON ファイルとして自動ダウンロード */
function downloadBackup(cloud: any): void {
  try {
    const blob = new Blob([JSON.stringify(cloud, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    a.href = url;
    a.download = `souzoku_backup_${ts}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch (e) {
    console.warn('[souzoku] backup download skipped', e);
  }
}
