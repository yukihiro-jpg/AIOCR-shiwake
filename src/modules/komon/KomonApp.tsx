'use client';

// 顧問先管理モジュール（ステージA：丸ごと1モジュール）
// - 既存の単一HTMLアプリを iframe(srcDoc) で完全隔離して描画（CSS/JSがホストと衝突しない）。
// - Firebase初期化・匿名認証・合言葉処理は自前で持たず、ホスト共通コア(@/core)を使う。
// - データの読み書きは modulePath('komon' | 'shinchoku', ...) 経由（rooms/{roomKey}/...）。
// - import は @/core/... とモジュール内相対のみ。

import { useEffect, useRef, useState } from 'react';
import { getDb } from '@/core/firebase';
import {
  hasRoom,
  roomKey,
  modulePath,
  getRoomPassphrase,
  setRoomPassphrase,
} from '@/core/room';
import ModuleSwitcher from '@/core/ui/ModuleSwitcher';
import { KOMON_HTML } from './embedded';

type KomonView = 'komon' | 'shinchoku';

export default function KomonApp({ view }: { view?: KomonView } = {}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [roomReady, setRoomReady] = useState(false);
  const [pass, setPass] = useState('');
  const switcherKey = view === 'shinchoku' ? 'shinchoku' : 'komon';

  useEffect(() => {
    setRoomReady(hasRoom());
  }, []);

  useEffect(() => {
    if (!roomReady) return;
    const iframe = iframeRef.current;
    if (!iframe) return;
    let disposed = false;

    (async () => {
      // ホストのモジュラSDKの関数群を iframe 内アプリへ橋渡しする
      const dbfns = await import('firebase/database');
      const bridge = {
        getDb,
        hasRoom,
        roomKey,
        modulePath,
        getRoomPassphrase,
        setRoomPassphrase,
        dbfns: {
          ref: dbfns.ref,
          onValue: dbfns.onValue,
          get: dbfns.get,
          set: dbfns.set,
          update: dbfns.update,
          remove: dbfns.remove,
        },
      };
      const inject = () => {
        if (disposed) return;
        const w = iframe.contentWindow as unknown as { __komonCore?: unknown; __komonView?: string } | null;
        if (w) {
          // 表示モードを先にセットしてから core を渡す（待機スクリプトが core 検知で起動するため）
          w.__komonView = view;
          w.__komonCore = bridge; // iframe 内の待機スクリプトが検知して __komonBoot() を実行
        }
      };
      // 既に読み込み済みなら即注入、そうでなければ load を待つ
      if (iframe.contentWindow && iframe.contentDocument?.readyState === 'complete') inject();
      iframe.addEventListener('load', inject);
    })();

    return () => {
      disposed = true;
      try {
        const w = iframe.contentWindow as unknown as { KomonStore?: { disconnect?: () => void } } | null;
        w?.KomonStore?.disconnect?.();
      } catch {
        /* noop */
      }
    };
  }, [roomReady]);

  // 合言葉が未設定なら、共通の合言葉を設定する導線（ホーム/共通設定でも可）
  if (!roomReady) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
        <ModuleSwitcher currentKey={switcherKey} />
        <div style={{ padding: 24, maxWidth: 520 }}>
          <h2 style={{ fontWeight: 500 }}>合言葉を設定してください</h2>
          <p style={{ color: '#5f6368' }}>
            総合アプリ共通の合言葉（ワークスペース）を設定すると、顧問先管理のデータに接続します。
            すでに他のモジュールで設定済みの場合は自動で接続されます。
          </p>
          <input
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            placeholder="共通の合言葉"
            style={{ width: '100%', padding: 8, marginBottom: 8, boxSizing: 'border-box' }}
          />
          <button
            onClick={() => {
              const p = pass.trim();
              if (!p) return;
              setRoomPassphrase(p);
              setRoomReady(true);
            }}
          >
            接続する
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <ModuleSwitcher currentKey={switcherKey} />
      <iframe
        ref={iframeRef}
        title="顧問先管理"
        srcDoc={KOMON_HTML}
        style={{ border: 'none', flex: 1, width: '100%' }}
      />
    </div>
  );
}
