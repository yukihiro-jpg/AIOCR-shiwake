'use client';

/*
  相続管理モジュール（総合アプリの1画面）。

  - 完全クライアント専用（APIルート/SSR/server actions 不使用）。dynamic(ssr:false) 前提。
  - Firebase 初期化・匿名認証・合言葉処理は持たず、ホスト共通コアを使用。
  - 相続アプリ本体（単一HTML）は iframe 隔離で描画し、同期は bridge.ts が core 経由で実施。
  - ルート(/souzoku)の結線はホスト側。本ファイルはトップ画面を default export するのみ。
*/

import React, { useEffect, useRef, useState } from 'react';
import { hasRoom, setRoomPassphrase, modulePath } from '@/core/room';
import { getDb } from '@/core/firebase';
import GlobalNav from '@/core/ui/GlobalNav';
import { startSouzokuBridge, type SouzokuBridgeHandle } from './bridge';
import { SOUZOKU_HTML } from './embedded';

export default function SouzokuApp() {
  const [roomReady, setRoomReady] = useState(false);
  const [pass, setPass] = useState('');
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // 合言葉（ワークスペース）が設定済みか
  useEffect(() => {
    setRoomReady(hasRoom());
  }, []);

  // 合言葉が設定されたら、iframe とホスト Firebase を橋渡し
  useEffect(() => {
    if (!roomReady) return;
    const el = iframeRef.current;
    if (!el) return;
    let alive = true;
    let handle: SouzokuBridgeHandle | null = null;
    (async () => {
      try {
        const h = await startSouzokuBridge(el);
        if (alive) handle = h;
        else h.dispose();
        // 議事録など、souzoku 内から共有ストア(shinchoku/minutes 等)へ直接アクセスするためのコアを注入
        const dbfns = await import('firebase/database');
        const w = el.contentWindow as unknown as { __souzokuCore?: unknown } | null;
        if (w && alive) {
          w.__souzokuCore = {
            getDb,
            hasRoom,
            modulePath,
            dbfns: {
              ref: dbfns.ref,
              get: dbfns.get,
              set: dbfns.set,
              update: dbfns.update,
              onValue: dbfns.onValue,
            },
          };
        }
      } catch (e) {
        console.error('[souzoku] bridge start failed', e);
      }
    })();
    return () => {
      alive = false;
      if (handle) handle.dispose();
    };
  }, [roomReady]);

  if (!roomReady) {
    return (
      <div style={gateWrap}>
        <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>相続管理</h2>
        <p style={{ fontSize: 13.5, color: '#555', lineHeight: 1.7, marginBottom: 16 }}>
          共有の合言葉を入力してください。事務所で共通の合言葉（顧問先管理などと同じもの）を使うと、
          同じワークスペースのデータを共有できます。
        </p>
        <input
          value={pass}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPass(e.target.value)}
          onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
            if (e.key === 'Enter') applyPass();
          }}
          placeholder="合言葉"
          style={gateInput}
        />
        <button onClick={applyPass} style={gateBtn}>
          開く
        </button>
      </div>
    );
  }

  return (
    <div style={shell}>
      <div style={{ flex: '0 0 auto' }}>
        <GlobalNav currentKey="souzoku" />
      </div>
      <iframe
        ref={iframeRef}
        title="相続管理"
        srcDoc={SOUZOKU_HTML}
        // 自前コードのため same-origin を許可（localStorage / ダウンロード / 確認ダイアログ等のため）
        sandbox="allow-scripts allow-same-origin allow-downloads allow-modals allow-forms allow-popups"
        style={frame}
      />
    </div>
  );

  function applyPass() {
    const p = pass.trim();
    if (!p) return;
    setRoomPassphrase(p); // 共通キー "suite-room-passphrase" に保存（core）
    setRoomReady(true);
  }
}

const shell: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100vh',
  width: '100%',
};
const frame: React.CSSProperties = {
  flex: '1 1 auto',
  width: '100%',
  height: '100%',
  border: 'none',
  display: 'block',
};
const gateWrap: React.CSSProperties = {
  maxWidth: 460,
  margin: '80px auto',
  padding: 24,
  fontFamily: 'system-ui, -apple-system, sans-serif',
};
const gateInput: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  fontSize: 14,
  border: '1px solid #ccc',
  borderRadius: 8,
  boxSizing: 'border-box',
};
const gateBtn: React.CSSProperties = {
  marginTop: 12,
  padding: '10px 18px',
  background: '#0071e3',
  color: '#fff',
  border: 'none',
  borderRadius: 8,
  cursor: 'pointer',
  fontWeight: 600,
};
