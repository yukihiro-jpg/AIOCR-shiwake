import { createRoot } from 'react-dom/client'
import BulkTransferDialog from '@/components/bank-statement/BulkTransferDialog'
const cid = 'c1'
const rows = [
  { payee: '常陽石油（株）', amount: 13791182, fee: 275 },
  { payee: '内山労務管理事務所　内山治則', amount: 118252, fee: 275 },
  { payee: '西野電設', amount: 212300, fee: 495 },
]
localStorage.setItem('bs-bulk-transfers-' + cid, JSON.stringify([{ id: 'bt-1', date: '2026-08-31', rows, importedAt: 1 }]))
localStorage.setItem('bs-payee-accounts-' + cid, JSON.stringify({ '常陽石油': { payee: '常陽石油（株）', code: '312', name: '買掛金' } }))
const master = [
  { code: '131', name: '当座預金', shortName: '筑波' }, { code: '312', name: '買掛金', shortName: '買掛金' },
  { code: '321', name: '預り金', shortName: '預り金' }, { code: '635', name: '支払報酬', shortName: '支払報酬' },
  { code: '997', name: '諸口', shortName: '諸口' },
]
;(window as any).__journalized = []
createRoot(document.getElementById('root')!).render(
  <BulkTransferDialog clientId={cid} accountMaster={master as any} subAccountMaster={[]}
    onJournalize={(t, _d, fee, mode) => { (window as any).__journalized.push({ id: t.id, bank: t.bankCode, fee, mode }); return true }}
    onClose={() => { (window as any).__closed = true }} />,
)
