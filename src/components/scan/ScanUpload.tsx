'use client'

import { useEffect, useMemo, useState, useCallback } from 'react'
import {
  loadScanInfoPublic,
  submitScanBatchPublic,
  submitCashEntryPublic,
  submitFilesPublic,
  loadInbox,
  markInboxDownloaded,
  getInboxBlob,
  loadFiles,
  getScanFileBlob,
  loadScanFolders,
  createScanFolder,
  renameScanFolder,
  deleteScanFolder,
  moveScanFile,
  moveInboxFile,
  SCAN_FILE_MAX_BYTES,
  SCAN_FILE_MAX_TOTAL,
  type ScanInboxFile,
  type ScanFile,
  type ScanFolder,
  type CashEntryType,
  type CashDepositType,
} from '@/lib/scan/store'
import { compressImage } from '@/lib/nenmatsu/image-compress'
import FolderBrowser, { type BrowserFile, FOLDER_COLOR } from '@/components/scan/FolderBrowser'
import FolderTree from '@/components/scan/FolderTree'

const TOKEN_STORAGE_KEY = 'scan-token'

// 顧問先ページの3機能（スマホ=上部ボタン／PC=左サイドバー）
const NAV = [
  { key: 'files', icon: '📁', label: '共有フォルダ', desc: 'ファイルの受取・送付' },
  { key: 'scan', icon: '📷', label: 'スマホスキャン', desc: '書類を撮影して送る' },
  { key: 'cash', icon: '💴', label: '現金入出金登録', desc: '現金引出・預入の登録' },
] as const
type ViewKey = (typeof NAV)[number]['key']

const DOC_TYPES = [
  '通帳',
  '現金出納帳',
  'レシート・領収書',
  'クレジットカード利用明細書',
  '売上請求書',
  '仕入請求書',
  '借入金の返済予定表',
  'リース契約の支払予定表',
] as const

type Phase = 'loading' | 'invalid' | 'error' | 'ready'

interface HistoryItem {
  at: string
  label: string
}

export default function ScanUpload() {
  const [phase, setPhase] = useState<Phase>('loading')
  const [token, setToken] = useState('')
  const [view, setView] = useState<ViewKey>('files')
  const [companyName, setCompanyName] = useState('')
  const [memberName, setMemberName] = useState('') // メンバー用URLの場合のみ
  const [companyToken, setCompanyToken] = useState('') // メンバー用URLの場合の会社トークン（撮影/送信先・全員宛の参照）
  // 事務所からのファイル（自分宛＋全員宛）
  const [inboxItems, setInboxItems] = useState<{ srcToken: string; file: ScanInboxFile; toAll: boolean }[]>([])
  const [inboxMsg, setInboxMsg] = useState('')

  const [docType, setDocType] = useState<string>('レシート・領収書')
  const [bankName, setBankName] = useState('')
  const [accountNumber, setAccountNumber] = useState('')
  const [userName, setUserName] = useState('')
  const [photos, setPhotos] = useState<File[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [progress, setProgress] = useState('')
  const [submitErr, setSubmitErr] = useState('')
  const [submitDone, setSubmitDone] = useState('')
  const [history, setHistory] = useState<HistoryItem[]>([])

  const [cashTab, setCashTab] = useState<CashEntryType>('現金引出')
  const [cashDate, setCashDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [cashBank, setCashBank] = useState('')
  const [cashAccount, setCashAccount] = useState('')
  const [cashAmount, setCashAmount] = useState('')
  const [cashDepositType, setCashDepositType] = useState<CashDepositType>('売上金の預入')
  const [cashSubmitting, setCashSubmitting] = useState(false)
  const [cashErr, setCashErr] = useState('')
  const [cashDone, setCashDone] = useState('')

  // タブ名を「共有フォルダ」にする（URLから開いた顧問先向けページ）
  useEffect(() => { document.title = '共有フォルダ' }, [])

  // 共有フォルダ（DocuWorks風フォルダツリー）
  const [browseRoot, setBrowseRoot] = useState<'select' | 'toOffice' | 'toClient'>('select')
  const [folderId, setFolderId] = useState<string | null>(null) // 現在表示中フォルダ（null=ルート直下）
  const [folders, setFolders] = useState<ScanFolder[]>([])
  const [ownFiles, setOwnFiles] = useState<Record<string, ScanFile>>({})
  const [folderErr, setFolderErr] = useState('')

  useEffect(() => {
    ;(async () => {
      try {
        const q = new URLSearchParams(window.location.search)
        let t = q.get('t') || ''
        if (t) {
          try {
            localStorage.setItem(TOKEN_STORAGE_KEY, t)
          } catch {
            /* ignore */
          }
        } else {
          try {
            t = localStorage.getItem(TOKEN_STORAGE_KEY) || ''
          } catch {
            /* ignore */
          }
        }
        if (!t) {
          setPhase('invalid')
          return
        }
        try {
          const info = await loadScanInfoPublic(t)
          if (!info) {
            setPhase('invalid')
            return
          }
          setToken(t)
          setCompanyName(info.name)
          if (info.member) setMemberName(info.member)
          if (info.ct) setCompanyToken(info.ct)
          setPhase('ready')
          // 事務所からのファイル（自分宛＋全員宛）を読み込む
          try {
            const own = await loadInbox(t)
            const items: { srcToken: string; file: ScanInboxFile; toAll: boolean }[] = Object.values(own).map((f) => ({
              srcToken: t,
              file: f,
              toAll: !info.member, // 会社URLで見ている場合は全員宛
            }))
            if (info.ct) {
              const shared = await loadInbox(info.ct)
              for (const f of Object.values(shared)) items.push({ srcToken: info.ct, file: f, toAll: true })
            }
            items.sort((a, b) => b.file.sentAt.localeCompare(a.file.sentAt))
            setInboxItems(items)
          } catch { /* ignore */ }
        } catch {
          // 通信エラー・サーバ設定エラー等（リンク自体は正しい可能性がある）
          setPhase('error')
        }
      } catch {
        setPhase('invalid')
      }
    })()
  }, [])

  const isPassbook = docType === '通帳'
  const isReceipt = docType === 'レシート・領収書'
  // 撮影・現金・ファイル送信の送り先（メンバー用URLでも会社の受信箱に集約される）
  const uploadToken = companyToken || token
  const myDlKey = (memberName || '共通URL').replace(/[.#$/\[\]]/g, '_').slice(0, 40) || '共通URL'
  const inboxNew = inboxItems.filter((x) => !(x.file.downloads || {})[myDlKey]).length

  // ===== 共有フォルダ（フォルダツリー） =====
  const reloadFolderData = useCallback(async () => {
    if (!uploadToken) return
    try {
      const [f, files] = await Promise.all([loadScanFolders(uploadToken), loadFiles(uploadToken)])
      setFolders(Object.values(f))
      setOwnFiles(files)
    } catch { /* ignore */ }
  }, [uploadToken])

  function selectFolder(root: 'toOffice' | 'toClient', id: string | null) {
    setView('files')
    setBrowseRoot(root)
    setFolderId(id)
  }

  async function reloadInboxItems() {
    if (!token) return
    try {
      const own = await loadInbox(token)
      const items: { srcToken: string; file: ScanInboxFile; toAll: boolean }[] = Object.values(own).map((f) => ({
        srcToken: token,
        file: f,
        toAll: !memberName,
      }))
      if (companyToken) {
        const shared = await loadInbox(companyToken)
        for (const f of Object.values(shared)) items.push({ srcToken: companyToken, file: f, toAll: true })
      }
      items.sort((a, b) => b.file.sentAt.localeCompare(a.file.sentAt))
      setInboxItems(items)
    } catch { /* ignore */ }
  }

  useEffect(() => {
    if (phase === 'ready') reloadFolderData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, uploadToken])

  // 共有フォルダのルート名は実際の顧問先名を使う（1行に収めるため「税理士」表記）
  const cn = companyName || '顧問先'
  const labelToOffice = `${cn} → 税理士`
  const labelToClient = `税理士 → ${cn}`

  // toOffice（顧問先→事務所）：自分がこの会社へ送ったファイル一覧をフォルダ表示用に変換
  const toOfficeFolders = folders.filter((f) => f.root === 'toOffice')
  const toOfficeFiles: BrowserFile[] = Object.values(ownFiles).map((f) => ({
    id: f.id,
    name: f.name,
    size: f.size,
    folderId: f.folderId || null,
    at: f.submittedAt,
    comment: f.comment,
    member: f.member,
    raw: f,
  }))

  // toClient（事務所→顧問先）：会社宛＋自分（メンバー）宛。フォルダは会社トークンの共有ツリー、
  // ファイルは folderId でそのフォルダに振り分け表示（全員宛・個別宛とも同じツリーに載る）
  const toClientFolders = folders.filter((f) => f.root === 'toClient')
  const toClientFiles: BrowserFile[] = inboxItems.map((item) => ({
    id: `${item.srcToken}_${item.file.id}`,
    name: item.file.name,
    size: item.file.size,
    folderId: item.file.folderId || null,
    at: item.file.sentAt,
    comment: item.file.comment,
    raw: item,
  }))

  async function downloadInboxFile(item: { srcToken: string; file: ScanInboxFile }) {
    setInboxMsg('')
    try {
      const blob = await getInboxBlob(item.file)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = item.file.name
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 2000)
      try { await markInboxDownloaded(item.srcToken, item.file.id, memberName || '共通URL') } catch { /* ignore */ }
      setInboxItems((prev) =>
        prev.map((x) =>
          x.file.id === item.file.id
            ? { ...x, file: { ...x.file, downloads: { ...(x.file.downloads || {}), [myDlKey]: new Date().toISOString() } } }
            : x,
        ),
      )
    } catch (e) {
      setInboxMsg('ダウンロードに失敗しました：' + (e instanceof Error ? e.message : '') + '。通信環境をご確認ください')
    }
  }

  function onCapture(list: FileList | null) {
    if (!list || !list.length) return
    // FileList は入力欄と連動する「生きた」リストのため、先に配列へコピーしてから
    // setState する（入力欄クリア後に遅延実行される更新関数内で読むと空になる）
    const arr = Array.from(list)
    setPhotos((prev) => [...prev, ...arr])
  }
  function removePhoto(idx: number) {
    setPhotos((prev) => prev.filter((_, i) => i !== idx))
  }

  async function submitBatch() {
    if (!token) return
    if (photos.length === 0) {
      alert('撮影した書類がありません。')
      return
    }
    setSubmitting(true)
    setSubmitErr('')
    setSubmitDone('')
    try {
      const blobs: Blob[] = []
      for (let i = 0; i < photos.length; i++) {
        setProgress(`画像を圧縮中... (${i + 1}/${photos.length})`)
        blobs.push(await compressImage(photos[i]))
      }
      setProgress('送信しています...')
      await submitScanBatchPublic(
        uploadToken,
        docType,
        {
          bankName: isPassbook ? bankName : undefined,
          accountNumber: isPassbook ? accountNumber : undefined,
          userName: isReceipt ? userName : undefined,
          member: memberName || undefined,
        },
        blobs,
      )
      setSubmitDone(`✅ 送信が完了しました（${docType}・${photos.length}枚）。ありがとうございました。`)
      setHistory((prev) => [
        { at: new Date().toLocaleString('ja-JP'), label: `${docType}（${photos.length}枚）` },
        ...prev,
      ])
      setPhotos([])
      setBankName('')
      setAccountNumber('')
      setUserName('')
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      setSubmitErr(
        /unauthorized|permission/i.test(m)
          ? '送信できませんでした。お手数ですが、会計事務所のご担当者に「サーバ設定（Storageルール）の確認」とお伝えください。'
          : `送信に失敗しました：${m}。通信環境をご確認ください`,
      )
    }
    setSubmitting(false)
    setProgress('')
  }

  async function submitCash() {
    if (!token) return
    setCashErr('')
    setCashDone('')
    if (!cashDate || !cashBank || !cashAmount) {
      setCashErr('日付・銀行名・金額を入力してください。')
      return
    }
    const amountNum = Number(cashAmount.replace(/,/g, ''))
    if (!amountNum || amountNum <= 0) {
      setCashErr('金額を正しく入力してください。')
      return
    }
    setCashSubmitting(true)
    try {
      await submitCashEntryPublic(uploadToken, {
        entryType: cashTab,
        date: cashDate,
        bankName: cashBank,
        accountNumber: cashAccount || undefined,
        amount: amountNum,
        depositType: cashTab === '現金預入' ? cashDepositType : undefined,
        member: memberName || undefined,
      })
      setCashDone(`${cashTab}を登録しました。`)
      setCashBank('')
      setCashAccount('')
      setCashAmount('')
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      setCashErr(`登録に失敗しました：${m}。通信環境をご確認ください`)
    }
    setCashSubmitting(false)
  }

  const photoPreviews = useMemo(() => photos.map((f) => URL.createObjectURL(f)), [photos])

  if (phase === 'loading') return <Center>読み込み中...</Center>
  if (phase === 'error')
    return (
      <Center>
        <div className="text-center max-w-sm">
          <div className="text-3xl mb-2">📡</div>
          <p className="text-gray-700 mb-3">読み込みに失敗しました。通信環境をご確認のうえ、再度お試しください。</p>
          <button onClick={() => window.location.reload()} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold">
            再読み込み
          </button>
        </div>
      </Center>
    )
  if (phase === 'invalid')
    return (
      <Center>
        <div className="text-center max-w-sm">
          <div className="text-3xl mb-2">⚠️</div>
          <p className="text-gray-700">
            この画面は会社ごとの専用リンクから開いてください。リンクがわからない場合は事務所へご連絡ください。
          </p>
        </div>
      </Center>
    )

  return (
    <div className="min-h-screen bg-gray-50 pb-10">
      <header className="text-white px-4 py-3" style={{ background: '#0f2740' }}>
        <div className="max-w-md md:max-w-none md:px-4 mx-auto">
          <div className="text-[11px] text-slate-300">書類スキャン・ファイル便</div>
          <div className="font-bold text-lg">
            {companyName}
            {memberName && <span className="text-sm font-normal text-slate-200">｜{memberName} 様</span>}
          </div>
        </div>
      </header>

      <div className="max-w-md md:max-w-none mx-auto p-4 md:px-6">
        {/* スマホ：上部3ボタン */}
        <div className="grid grid-cols-3 gap-2 mb-4 md:hidden">
          {NAV.map((n) => (
            <button
              key={n.key}
              onClick={() => setView(n.key)}
              className={`relative py-2.5 rounded-xl border ${view === n.key ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-600 border-gray-200'}`}
            >
              <div className="text-xl leading-none">{n.icon}</div>
              <div className="text-[11px] font-semibold mt-1">{n.label}</div>
              {n.key === 'files' && inboxNew > 0 && (
                <span className="absolute top-1 right-1 text-[10px] font-bold text-white bg-red-500 rounded-full min-w-[16px] px-1">{inboxNew}</span>
              )}
            </button>
          ))}
        </div>

        <div className="md:flex md:gap-5 md:items-start">
          {/* PC：左サイドバー */}
          <aside className="hidden md:block md:w-64 shrink-0 space-y-1.5">
            {NAV.map((n) => (
              <button
                key={n.key}
                onClick={() => setView(n.key)}
                className={`w-full text-left px-3 py-3 rounded-xl flex items-center gap-3 border ${view === n.key ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'}`}
              >
                <span className="text-2xl leading-none">{n.icon}</span>
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-semibold">{n.label}</span>
                  <span className={`block text-[11px] ${view === n.key ? 'text-blue-100' : 'text-gray-400'}`}>{n.desc}</span>
                </span>
                {n.key === 'files' && inboxNew > 0 && (
                  <span className="text-[10px] font-bold text-white bg-red-500 rounded-full min-w-[18px] text-center px-1">{inboxNew}</span>
                )}
              </button>
            ))}

            {/* サイドバー内フォルダツリー（共有フォルダ選択時） */}
            {view === 'files' && (
              <div className="mt-3 pt-3 border-t border-gray-200">
                <div className="text-[11px] font-semibold text-gray-400 px-1.5 mb-1.5">フォルダ</div>
                <FolderTree
                  roots={[
                    { key: 'toOffice', label: labelToOffice, folders: toOfficeFolders },
                    { key: 'toClient', label: labelToClient, folders: toClientFolders, badge: inboxNew },
                  ]}
                  currentRoot={browseRoot}
                  currentId={folderId}
                  onSelect={selectFolder}
                />
              </div>
            )}
          </aside>

          {/* 右：選択中の機能 */}
          <div className="flex-1 min-w-0 space-y-4">
        {view === 'files' && (
          <div className="bg-white rounded-2xl border border-gray-200 p-5">
            {inboxMsg && <div className="text-xs text-red-600 mb-2 break-words">{inboxMsg}</div>}
            {folderErr && <div className="text-xs text-red-600 mb-2 break-words">{folderErr}</div>}

            {browseRoot === 'select' && (
              <>
                {/* モバイル：ルート選択カード（PCは左サイドバーのツリーで選ぶ） */}
                <div className="md:hidden">
                  <h1 className="font-bold text-gray-800 mb-3">📁 共有フォルダ</h1>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <button
                      onClick={() => selectFolder('toOffice', null)}
                      className="flex items-center gap-3 p-4 rounded-xl border-2 text-left hover:bg-gray-50"
                      style={{ borderColor: FOLDER_COLOR.toOffice }}
                    >
                      <span className="text-3xl leading-none">📁</span>
                      <span>
                        <span className="block text-sm font-bold text-gray-800">{labelToOffice}</span>
                        <span className="block text-xs text-gray-500 mt-0.5">フォルダを作って事務所へファイルを送れます</span>
                      </span>
                    </button>
                    <button
                      onClick={() => selectFolder('toClient', null)}
                      className="relative flex items-center gap-3 p-4 rounded-xl border-2 text-left hover:bg-gray-50"
                      style={{ borderColor: FOLDER_COLOR.toClient }}
                    >
                      <span className="text-3xl leading-none">📁</span>
                      <span>
                        <span className="block text-sm font-bold text-gray-800">{labelToClient}</span>
                        <span className="block text-xs text-gray-500 mt-0.5">事務所から届いたファイルを確認・ダウンロードできます</span>
                      </span>
                      {inboxNew > 0 && (
                        <span className="absolute top-2 right-2 text-[10px] font-bold text-white bg-red-500 rounded-full min-w-[18px] text-center px-1">{inboxNew}</span>
                      )}
                    </button>
                  </div>
                  <p className="text-[11px] text-gray-400 mt-3">送信されたファイルは90日で自動削除されます。</p>
                </div>
                {/* PC：ツリー未選択時のヒント */}
                <div className="hidden md:block text-center text-gray-400 py-20 text-sm">
                  ← 左のフォルダを選択してください
                </div>
              </>
            )}

            {browseRoot !== 'select' && (
              <>
                <button
                  onClick={() => setBrowseRoot('select')}
                  className="md:hidden mb-3 text-xs text-gray-500 hover:text-gray-700"
                >
                  ← 共有フォルダ一覧へ戻る
                </button>
                {browseRoot === 'toOffice' ? (
                  <FolderBrowser
                    rootKey="toOffice"
                    rootLabel={labelToOffice}
                    folders={toOfficeFolders}
                    files={toOfficeFiles}
                    controlledId={folderId}
                    onNavigate={setFolderId}
                    canManageFolders
                    canAddFiles
                    addFilesLabel="事務所へファイルを送る"
                    maxFileBytes={SCAN_FILE_MAX_BYTES}
                    maxTotalBytes={SCAN_FILE_MAX_TOTAL}
                    onCreateFolder={async (parentId, name) => {
                      await createScanFolder(uploadToken, 'toOffice', parentId, name)
                    }}
                    onRenameFolder={async (folder, name) => {
                      await renameScanFolder(uploadToken, folder.id, name)
                    }}
                    onDeleteFolder={async (folder) => {
                      await deleteScanFolder(uploadToken, folder, toOfficeFolders, Object.values(ownFiles))
                    }}
                    onAddFiles={async (parentId, addFiles, comment) => {
                      await submitFilesPublic(uploadToken, addFiles, undefined, parentId, memberName || undefined, comment)
                    }}
                    onMoveFile={async (f, targetFolderId) => {
                      await moveScanFile(uploadToken, (f.raw as ScanFile).id, targetFolderId)
                    }}
                    onGetBlob={async (f) => getScanFileBlob(f.raw as ScanFile)}
                    onDownload={async (f) => {
                      const raw = f.raw as ScanFile
                      const blob = await getScanFileBlob(raw)
                      const url = URL.createObjectURL(blob)
                      const a = document.createElement('a')
                      a.href = url
                      a.download = raw.name
                      document.body.appendChild(a)
                      a.click()
                      a.remove()
                      setTimeout(() => URL.revokeObjectURL(url), 2000)
                    }}
                    onChanged={reloadFolderData}
                  />
                ) : (
                  <FolderBrowser
                    rootKey="toClient"
                    rootLabel={labelToClient}
                    folders={toClientFolders}
                    files={toClientFiles}
                    controlledId={folderId}
                    onNavigate={setFolderId}
                    canManageFolders={false}
                    canAddFiles={false}
                    addFilesLabel=""
                    onCreateFolder={async () => { /* 顧問先はフォルダ操作不可 */ }}
                    onRenameFolder={async () => { /* 顧問先はフォルダ操作不可 */ }}
                    onDeleteFolder={async () => { /* 顧問先はフォルダ操作不可 */ }}
                    onAddFiles={async () => { /* 顧問先はアップロード不可 */ }}
                    onGetBlob={async (f) => getInboxBlob((f.raw as { file: ScanInboxFile }).file)}
                    onMoveFile={async (f, targetFolderId) => {
                      const item = f.raw as { srcToken: string; file: ScanInboxFile }
                      await moveInboxFile(item.srcToken, item.file.id, targetFolderId)
                    }}
                    onDownload={async (f) => {
                      const item = f.raw as { srcToken: string; file: ScanInboxFile; toAll: boolean }
                      await downloadInboxFile(item)
                    }}
                    renderFileBadges={(f) => {
                      const item = f.raw as { srcToken: string; file: ScanInboxFile; toAll: boolean }
                      const isNew = !(item.file.downloads || {})[myDlKey]
                      return (
                        <>
                          {isNew && <span className="text-[10px] font-bold text-white bg-red-500 rounded px-1.5 py-0.5 align-middle">新着</span>}
                          {memberName && (
                            <span className="text-[10px] text-purple-700 bg-purple-50 border border-purple-200 rounded px-1.5 py-0.5">
                              {item.toAll ? '全員宛' : 'あなた宛'}
                            </span>
                          )}
                        </>
                      )
                    }}
                    onChanged={reloadInboxItems}
                  />
                )}
              </>
            )}
          </div>
        )}

        {view === 'scan' && (
        <>
        <div className="bg-white rounded-2xl border border-gray-200 p-5">
          <h1 className="font-bold text-gray-800 mb-3">書類を撮影して送信</h1>

          <label className="block text-sm font-medium text-gray-700 mb-1">書類の種類</label>
          <select
            value={docType}
            onChange={(e) => setDocType(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded mb-3"
          >
            {DOC_TYPES.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>

          {isPassbook && (
            <div className="grid grid-cols-2 gap-2 mb-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">銀行名</label>
                <input
                  value={bankName}
                  onChange={(e) => setBankName(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded"
                  placeholder="例：〇〇銀行"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">口座番号</label>
                <input
                  value={accountNumber}
                  onChange={(e) => setAccountNumber(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded"
                  placeholder="例：1234567"
                />
              </div>
            </div>
          )}

          {isReceipt && (
            <div className="mb-3">
              <label className="block text-xs text-gray-500 mb-1">使用者名（任意）</label>
              <input
                value={userName}
                onChange={(e) => setUserName(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded"
                placeholder="例：山田"
              />
            </div>
          )}

          <div className="flex gap-2 mb-3">
            <label className="flex-1 text-center px-3 py-2.5 bg-blue-600 text-white rounded-lg font-semibold cursor-pointer">
              📷 撮影する
              <input
                type="file"
                accept="image/*"
                capture="environment"
                multiple
                className="hidden"
                onChange={(e) => {
                  onCapture(e.target.files)
                  e.target.value = ''
                }}
              />
            </label>
            <label className="flex-1 text-center px-3 py-2.5 border border-blue-600 text-blue-700 rounded-lg font-semibold cursor-pointer">
              🖼 アルバムから選択
              <input
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  onCapture(e.target.files)
                  e.target.value = ''
                }}
              />
            </label>
          </div>

          {photos.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-3">
              {photoPreviews.map((src, i) => (
                <div key={i} className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={src} alt="" className="w-16 h-16 object-cover rounded border border-gray-200" />
                  <button
                    onClick={() => removePhoto(i)}
                    className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full w-5 h-5 text-xs leading-none"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          {submitErr && <div className="text-xs text-red-600 mb-2 break-words">{submitErr}</div>}
          {submitDone && (
            <div className="text-sm font-semibold text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2.5 mb-2">
              {submitDone}
            </div>
          )}

          <button
            onClick={submitBatch}
            disabled={submitting || photos.length === 0}
            className="w-full py-3 bg-green-600 text-white rounded-lg font-semibold hover:bg-green-700 disabled:opacity-60"
          >
            {submitting ? progress || '送信中...' : 'まとめて送信する'}
          </button>
        </div>

        {history.length > 0 && (
          <div className="bg-white rounded-2xl border border-gray-200 p-4">
            <h2 className="text-sm font-semibold text-gray-700 mb-2">送信履歴</h2>
            <ul className="space-y-1">
              {history.map((h, i) => (
                <li key={i} className="text-xs text-gray-500 flex justify-between">
                  <span>{h.label}</span>
                  <span>{h.at}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        </>
        )}

        {view === 'cash' && (
        <div className="bg-white rounded-2xl border border-gray-200 p-5">
          <h1 className="font-bold text-gray-800 mb-3">現金引出・現金預入を登録する</h1>
          <div className="flex gap-2 mb-3">
            <button
              onClick={() => setCashTab('現金引出')}
              className={`flex-1 py-2 rounded-lg text-sm font-semibold ${
                cashTab === '現金引出' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600'
              }`}
            >
              現金引出
            </button>
            <button
              onClick={() => setCashTab('現金預入')}
              className={`flex-1 py-2 rounded-lg text-sm font-semibold ${
                cashTab === '現金預入' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600'
              }`}
            >
              現金預入
            </button>
          </div>

          <label className="block text-xs text-gray-500 mb-1">日付</label>
          <input
            type="date"
            value={cashDate}
            onChange={(e) => setCashDate(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded mb-3"
          />

          <div className="grid grid-cols-2 gap-2 mb-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">銀行名</label>
              <input
                value={cashBank}
                onChange={(e) => setCashBank(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded"
                placeholder="例：〇〇銀行"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">口座番号</label>
              <input
                value={cashAccount}
                onChange={(e) => setCashAccount(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded"
                placeholder="任意"
              />
            </div>
          </div>

          <label className="block text-xs text-gray-500 mb-1">金額</label>
          <input
            inputMode="numeric"
            value={cashAmount}
            onChange={(e) => setCashAmount(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded mb-3"
            placeholder="例：50000"
          />

          {cashTab === '現金預入' && (
            <div className="mb-3">
              <label className="block text-xs text-gray-500 mb-1">預入の種類</label>
              <select
                value={cashDepositType}
                onChange={(e) => setCashDepositType(e.target.value as CashDepositType)}
                className="w-full px-3 py-2 border border-gray-300 rounded"
              >
                <option value="売上金の預入">売上金の預入</option>
                <option value="その他の預入">その他の預入</option>
              </select>
            </div>
          )}

          {cashErr && <div className="text-xs text-red-600 mb-2">{cashErr}</div>}
          {cashDone && <div className="text-xs text-green-700 mb-2">{cashDone}</div>}

          <button
            onClick={submitCash}
            disabled={cashSubmitting}
            className="w-full py-3 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 disabled:opacity-60"
          >
            {cashSubmitting ? '登録中...' : '登録する'}
          </button>
        </div>
        )}

          </div>{/* end content */}
        </div>{/* end md:flex */}

        <p className="text-[11px] text-gray-400 text-center">
          カメラが開かないときは LINE 等ではなく Safari / Chrome で開き直してください（アルバムからの選択はどのアプリでも使えます）。<br />
          送信された画像は送信から1年後、ファイルは90日後に自動削除されます（お手元の元データには影響しません）。
        </p>
      </div>
    </div>
  )
}

function Center({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen flex items-center justify-center bg-gray-50 p-6 text-gray-500">{children}</div>
}
