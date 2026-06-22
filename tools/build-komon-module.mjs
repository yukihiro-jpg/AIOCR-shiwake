// 単一HTMLの顧問先アプリを、総合アプリ(ホスト)の自己完結モジュール src/modules/komon/ へ変換する生成器。
// 方式：アプリは iframe(srcDoc) で完全隔離し、データ層だけをホスト共通コア(__komonCore)へ差し替える。
// 実行: node tools/build-komon-module.mjs
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function rangeReplace(s, startAnchor, endAnchor, replacement) {
  const i = s.indexOf(startAnchor);
  if (i < 0) throw new Error('開始アンカーが見つかりません: ' + startAnchor.slice(0, 40));
  const j = s.indexOf(endAnchor, i);
  if (j < 0) throw new Error('終了アンカーが見つかりません: ' + endAnchor.slice(0, 40));
  return s.slice(0, i) + replacement + s.slice(j + endAnchor.length);
}
function must(s, anchor) { if (s.indexOf(anchor) < 0) throw new Error('置換対象が見つかりません: ' + anchor.slice(0, 50)); return s; }

// ---- T0: ホスト側が用意する/不要なヘッダscriptを除去（Firebase compat と Google GSI） ----
[
  '<script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js"></script>\n',
  '<script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-database-compat.js"></script>\n',
  '<script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js"></script>\n',
  '<script src="https://accounts.google.com/gsi/client" async defer></script>\n',
].forEach(tag => { html = must(html, tag); html = html.replace(tag, ''); });

// ---- T1: Realtime IIFE を KomonStore（ホスト共通コア経由）に置換 ----
const KOMON_STORE_CODE = String.raw`/* ===== ホスト共通コア経由の同期（Firebase Realtime Database / iframe隔離） ===== */
/* 顧問先情報は rooms/{roomKey}/komon/ 、進捗管理＋議事録は rooms/{roomKey}/shinchoku/ に保存。 */
const KOMON_KEYS=['clients','clientTombstones'];
const SHINCHOKU_KEYS=['filings','filingSteps','interimDone','interimCells','interimSteps','gensenSteps','monthly','monthlyTargets','modules','gensen','gensenMonthly','gensenSpecial','nencho','sonotaTables','docTables','docTemplate','clientSummaries','minutes'];
const KomonStore=(function(){
  const ALL=[...KOMON_KEYS,...SHINCHOKU_KEYS];
  const moduleOf=k=>KOMON_KEYS.indexOf(k)>=0?'komon':'shinchoku';
  const BAD=/[.#$\/\[\]~]/g;
  function enc(k){ return '_'+String(k).replace(BAD,c=>'~'+c.charCodeAt(0).toString(16)); }
  function dec(k){ return String(k).replace(/^_/,'').replace(/~([0-9a-f]{2})/g,(m,h)=>String.fromCharCode(parseInt(h,16))); }
  function isObj(o){ return o&&typeof o==='object'&&!Array.isArray(o); }
  function clone(o){ return o===undefined?undefined:JSON.parse(JSON.stringify(o)); }
  function encodeTreeVal(o){ if(Array.isArray(o))return o.map(encodeTreeVal); if(isObj(o)){ const r={}; for(const k in o)r[enc(k)]=encodeTreeVal(o[k]); return r; } return o; }
  function decodeTree(o){ if(Array.isArray(o))return o.map(decodeTree); if(isObj(o)){ const r={}; for(const k in o)r[dec(k)]=decodeTree(o[k]); return r; } return o; }
  function relatedToClient(key,id){ return key===id||key.endsWith('__'+id)||key.endsWith('-'+id); }
  let ready=false, lastSnap={}, pushTimer=null, fbPending=false, offs=[];
  function core(){ if(!window.__komonCore)throw new Error('ホスト共通コア(__komonCore)が見つかりません'); return window.__komonCore; }
  function setStatus(s,t){ const d=document.getElementById('syncDot'),x=document.getElementById('syncText'); if(d)d.className='dot '+({on:'on',err:'err',busy:'busy'}[s]||''); if(x)x.textContent=t; }
  async function pathFor(k){ return core().modulePath(moduleOf(k),k); }
  // 接続時：顧問先をID単位で合体（新規は蓄積、削除は墓標で全端末に伝播）
  function mergeRemote(d){
    const tomb=Object.assign({},data.clientTombstones||{},d.clientTombstones||{});
    const byId={}; (data.clients||[]).forEach(c=>{ if(c&&c.id)byId[c.id]=c; });
    (d.clients||[]).forEach(c=>{ if(c&&c.id)byId[c.id]=Object.assign({},byId[c.id],c); });
    data.clients=Object.values(byId).filter(c=>!tomb[c.id]); data.clientTombstones=tomb;
    ALL.forEach(k=>{ if(k==='clients'||k==='clientTombstones')return; const rv=d[k]; if(rv===undefined)return;
      if(k==='minutes'){ const m={}; (data.minutes||[]).forEach(x=>{ if(x)m[x.id||JSON.stringify(x)]=x; }); (rv||[]).forEach(x=>{ if(x)m[x.id||JSON.stringify(x)]=x; }); data.minutes=Object.values(m).filter(x=>!tomb[x.clientId]); }
      else if(Array.isArray(rv)){ data[k]=rv; }
      else if(isObj(rv)){ const merged=Object.assign({},data[k]||{},rv); Object.keys(merged).forEach(key=>{ for(const id in tomb){ if(relatedToClient(key,id)){ delete merged[key]; break; } } }); data[k]=merged; }
      else data[k]=rv; });
  }
  function diffSeg(up,p,cur,prev){ if(isObj(cur)&&isObj(prev)){ const ks=new Set([...Object.keys(cur),...Object.keys(prev)]); ks.forEach(k=>diffSeg(up,p+'/'+enc(k),cur[k],prev[k])); } else if(JSON.stringify(cur)!==JSON.stringify(prev)){ up[p]=(cur===undefined?null:encodeTreeVal(cur)); } }
  async function pushKey(k,prev){ const db=await core().getDb(); const F=core().dbfns; const base=await pathFor(k); const cur=data[k];
    if(isObj(cur)&&isObj(prev)){ const up={}; const ks=new Set([...Object.keys(cur),...Object.keys(prev)]); ks.forEach(key=>diffSeg(up,enc(key),cur[key],prev[key])); if(Object.keys(up).length)await F.update(F.ref(db,base),up); }
    else if(JSON.stringify(cur)!==JSON.stringify(prev)){ if(cur===undefined||cur===null)await F.remove(F.ref(db,base)); else await F.set(F.ref(db,base),encodeTreeVal(cur)); } }
  async function pushNow(seed){ if(!core().hasRoom())return; for(const k of ALL){ const prev=seed?{}:(lastSnap[k]===undefined?{}:lastSnap[k]); try{ await pushKey(k,prev); }catch(e){ console.error('push',k,e); setStatus('err','保存エラー'); } lastSnap[k]=clone(data[k]); } }
  function push(){ if(!ready)return; clearTimeout(pushTimer); pushTimer=setTimeout(()=>pushNow(false),200); }
  function rerender(){ const ae=document.activeElement; if(ae&&/INPUT|TEXTAREA|SELECT/.test(ae.tagName)&&ae.closest&&ae.closest('main')){ if(!fbPending){ fbPending=true; ae.addEventListener('blur',()=>{ fbPending=false; refreshAll(); },{once:true}); } return; } refreshAll(); }
  function onRemoteKey(k,val){ if(!ready)return; const v=(val==null)?undefined:decodeTree(val); if(JSON.stringify(v)===JSON.stringify(data[k]))return;
    if(v===undefined){ if(Array.isArray(data[k]))data[k]=[]; else if(isObj(data[k]))data[k]={}; else data[k]=v; } else data[k]=v;
    lastSnap[k]=clone(data[k]); saveLocal(); rerender(); }
  async function connect(){
    try{
      if(!core().hasRoom()){ setStatus('','合言葉が未設定です'); return; }
      setStatus('busy','同期中...');
      const db=await core().getDb(); const F=core().dbfns;
      const remote={}; for(const k of ALL){ const snap=await F.get(F.ref(db,await pathFor(k))); const v=snap.val(); if(v!==null&&v!==undefined)remote[k]=decodeTree(v); }
      if(Object.keys(remote).length){ mergeRemote(remote); ALL.forEach(k=>lastSnap[k]=(remote[k]===undefined?undefined:clone(remote[k]))); saveLocal(); refreshAll(); await pushNow(false); }
      else { autoBackupOnce(); ALL.forEach(k=>lastSnap[k]=undefined); await pushNow(true); }
      ready=true; setStatus('on','共同編集中');
      for(const k of ALL){ const off=F.onValue(F.ref(db,await pathFor(k)),snap=>onRemoteKey(k,snap.val())); offs.push(off); }
    }catch(e){ console.error(e); setStatus('err','同期エラー'); try{ toast('同期エラー: '+e.message,'err'); }catch(_){ } }
  }
  function disconnect(){ offs.forEach(o=>{try{o();}catch(_){}}); offs=[]; ready=false; setStatus('','ローカル保存'); }
  function manualSync(){ if(ready)pushNow(false); else connect(); }
  // 新パスが空＝初回移行。移行前に必ずローカルデータをJSONバックアップ（1回だけ）。
  function autoBackupOnce(){ try{ if(localStorage.getItem('komon_suite_migrated'))return; const hasData=(data.clients&&data.clients.length)||Object.keys(data.filings||{}).length||(data.minutes&&data.minutes.length); if(hasData){ exportBackup(); toast('移行前のバックアップ(JSON)を書き出しました','ok'); } localStorage.setItem('komon_suite_migrated','1'); }catch(_){ } }
  return { connect, disconnect, push, manualSync, setStatus, get ready(){return ready;} };
})();`;
html = rangeReplace(html, '/* ===== リアルタイム共同編集（Firebase Realtime Database） ===== */', '})();', KOMON_STORE_CODE);

// ---- T2: persist / saveLocal / manualSyncAll をコア用に置換 ----
html = rangeReplace(html,
  'function manualSyncAll(){ if(data.settings.fbConfig&&data.settings.fbRoom)Realtime.manualSync(); else DriveSync.manualSync(); }',
  'setTimeout(()=>DriveSync.saveToDrive(),1500); } }',
  `function manualSyncAll(){ KomonStore.manualSync(); }
function saveLocal(){ try{ localStorage.setItem(LS_KEY,JSON.stringify(data)); }catch(e){console.warn(e);} }
function persist(){ saveLocal(); KomonStore.push(); }`);

// ---- T3: DriveSync IIFE をスタブに置換（残存ボタン対策） ----
html = rangeReplace(html, '/* ===== Google Drive 同期 ===== */', '})();',
  `/* ===== 同期スタブ（ホスト共通コアを使用） ===== */
const DriveSync={ connect(){ try{toast('この統合版はホスト共通の合言葉で同期します','');}catch(_){ } }, saveToDrive(){}, loadFromDrive(){}, manualSync(){ KomonStore.manualSync(); }, setStatus(s,t){ KomonStore.setStatus(s,t); } };`);

// ---- T4: saveSettings / restoreSettingsUI から Firebase/Drive を除去 ----
html = rangeReplace(html,
  "function saveSettings(){ data.settings.folderUrl=val('setFolderUrl');",
  "saveLocal(); toast('設定を保存しました','ok'); }",
  `function saveSettings(){ const p=val('setAiProvider')||'gemini'; data.settings.aiProvider=p;
  if(p==='gemini'){ data.settings.geminiApiKey=val('setAiKey'); data.settings.geminiModel=val('setAiModel')||'gemini-2.5-flash'; }
  else { data.settings.claudeApiKey=val('setAiKey'); data.settings.claudeModel=val('setAiModel')||'claude-opus-4-8'; }
  saveLocal(); toast('設定を保存しました','ok'); }`);
html = rangeReplace(html,
  "function restoreSettingsUI(){ setVal('setFolderUrl'",
  "setVal('setFbRoom',data.settings.fbRoom||''); }",
  "function restoreSettingsUI(){ setVal('setAiProvider',data.settings.aiProvider||'gemini'); onProviderChange(); }");

// ---- T5: 起動を DOMContentLoaded から window.__komonBoot に変更、自動FB/Drive接続を撤去 ----
html = must(html, "window.addEventListener('DOMContentLoaded',()=>{");
html = html.replace("window.addEventListener('DOMContentLoaded',()=>{", "window.__komonBoot=function(){");
html = rangeReplace(html,
  "  if(data.settings.fbConfig&&data.settings.fbRoom){ setTimeout(()=>{ try{ Realtime.connect(); }catch(e){} },800); }",
  "DriveSync.connect(); }catch(e){} },1200); }",
  "  KomonStore.connect();");
// __komonBoot の閉じ括弧（スクリプト末尾の }); ）を }; に
html = html.replace(/\}\);(\s*)<\/script>/, '};$1</script>');

// ---- T6: 設定画面のFirebase/Driveカードを情報カードに置換（AI・バックアップは残す） ----
html = rangeReplace(html,
  '    <div class="card pad" style="max-width:820px;margin-bottom:18px">\n      <h3 style="margin-top:0;font-weight:500">リアルタイム共同編集（Firebase）</h3>',
  '<button onclick="DriveSync.loadFromDrive(true)">📥 取り込む</button></div>',
  `    <div class="card pad" style="max-width:820px;margin-bottom:18px">
      <h3 style="margin-top:0;font-weight:500">データ同期</h3>
      <div class="hint">このアプリは総合アプリ（ホスト）の共通の合言葉で Firebase Realtime Database に接続し、複数端末・複数人でリアルタイムに共同編集します。合言葉の設定・変更はホーム画面（共通設定）で行います。</div>
      <div class="row-flex" style="margin-top:10px"><button onclick="manualSyncAll()">⟳ 今すぐ同期</button></div>
    </div>
    <div class="card pad" style="max-width:820px">`);
// Driveの設定手順 details を削除
html = rangeReplace(html, '<details class="help"><summary>Googleドライブ連携の設定手順</summary>', '</details>', '');

// ---- T7: iframe 起動待ち（__komonCore がセットされたら __komonBoot を実行） ----
const WAITER = `<script>(function w(){ if(window.__komonCore && typeof window.__komonBoot==='function'){ try{ window.__komonBoot(); }catch(e){ console.error(e); } } else { setTimeout(w,30); } })();</script>`;
html = must(html, '</body>');
html = html.replace('</body>', WAITER + '\n</body>');

// 念のため、変換漏れ（旧Realtime/旧DriveSync IIFE）が無いか検査
if (/const Realtime=\(function/.test(html)) throw new Error('Realtime IIFE が残っています');
if (/google\.accounts\.oauth2/.test(html)) throw new Error('GIS 参照が残っています');

// ---- 出力 ----
const outDir = path.join(ROOT, 'src', 'modules', 'komon');
fs.mkdirSync(outDir, { recursive: true });
const banner = '// このファイルは tools/build-komon-module.mjs により index.html から自動生成されます。直接編集しないでください。\n';
fs.writeFileSync(path.join(outDir, 'embedded.ts'),
  banner + '/* eslint-disable */\nexport const KOMON_HTML: string = ' + JSON.stringify(html) + ';\n', 'utf8');

console.log('生成完了: src/modules/komon/embedded.ts （' + html.length + ' bytes）');
