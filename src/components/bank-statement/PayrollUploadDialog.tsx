'use client'
import { useState, useMemo, useEffect } from 'react'
import type { PayrollData, PayrollLedger, AccountItem, SubAccountItem, JournalEntry, AccountTaxItem } from '@/lib/bank-statement/types'
import type { LedgerDateRule } from '@/lib/bank-statement/payroll-ledger-mapper'
import { payrollBalanceCheck, payrollPersonKey, type PayrollGenerateOptions } from '@/lib/bank-statement/payroll-mapper'

// 賃金台帳の学習データ（localStorage）
interface PayrollSettings {
  executiveNames: string[]
  itemAccounts: Record<string, { code: string; name: string; subCode?: string; subName?: string }>
  // 賞与の借方（役員報酬・給与手当キー）は給与と科目が異なるため別バケットで学習する
  itemAccountsBonus?: Record<string, { code: string; name: string; subCode?: string; subName?: string }>
  bankCode: string
  bankName: string
  bankSubCode: string
  bankSubName: string
  salaryIndividual?: boolean
  perPersonItems?: string[]
  perPersonSubs?: Record<string, Record<string, { subCode: string; subName: string }>>
}

// 給与/賞与で学習を分ける借方キー
const DEBIT_KEYS = ['役員報酬', '給与手当'] as const

function getPayrollSettingsKey(): string {
  const cid = typeof window !== 'undefined' ? localStorage.getItem('bank-statement-selected-client') || '' : ''
  return `bs-payroll-settings-${cid}`
}

function loadPayrollSettings(): PayrollSettings | null {
  try {
    const raw = localStorage.getItem(getPayrollSettingsKey())
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

function savePayrollSettings(settings: PayrollSettings): void {
  try { localStorage.setItem(getPayrollSettingsKey(), JSON.stringify(settings)) } catch {}
  const cid = typeof window !== 'undefined' ? localStorage.getItem('bank-statement-selected-client') || '' : ''
  if (cid) {
    import('@/lib/bank-statement/firebase-sync')
      .then(({ schedulePushToFirebase }) => schedulePushToFirebase(cid, 'payroll-settings', settings))
      .catch(() => { /* firebase 未設定なら無視 */ })
  }
}

interface Props {
  open: boolean
  onClose: () => void
  accountMaster: AccountItem[]
  subAccountMaster: SubAccountItem[]
  accountTaxMaster?: AccountTaxItem[]
  onGenerate: (data: PayrollData, bankCode: string, bankName: string, deductionAccounts: Record<string, { code: string; name: string; subCode?: string; subName?: string }>, bankSubCode?: string, bankSubName?: string, options?: PayrollGenerateOptions) => void
  onGenerateEntries?: (entries: JournalEntry[], info: string) => void
}

export default function PayrollUploadDialog({ open, onClose, accountMaster, subAccountMaster, accountTaxMaster, onGenerate, onGenerateEntries }: Props) {
  const [mode, setMode] = useState<'file' | 'paste'>('file')
  const [pasteText, setPasteText] = useState('')
  const [parsed, setParsed] = useState<PayrollData | null>(null)
  // ===== 複数月一括モード（複数ファイル or 選択月が混在する1ファイル） =====
  const [batch, setBatch] = useState<PayrollData[] | null>(null)
  const [journalDates, setJournalDates] = useState<string[]>([]) // 月ごとの仕訳日（編集可）
  const [ruleMonth, setRuleMonth] = useState<'same' | 'prev'>('same') // 一括設定: 選択月の当月/前月
  const [ruleDay, setRuleDay] = useState<'end' | number>('end') // 一括設定: 末日 or ◯日
  const [error, setError] = useState('')
  const [bankCode, setBankCode] = useState('')
  const [bankName, setBankName] = useState('')
  const [bankSubCode, setBankSubCode] = useState('')
  const [bankSubName, setBankSubName] = useState('')
  const [accounts, setAccounts] = useState<Record<string, { code: string; name: string; subCode?: string; subName?: string }>>({})
  // ===== 年間賃金台帳（従業員別シート・月列）モード =====
  const [ledger, setLedger] = useState<PayrollLedger | null>(null)
  const [fromMonth, setFromMonth] = useState(1)
  const [toMonth, setToMonth] = useState(12)
  const [dateMode, setDateMode] = useState<'monthEnd' | 'monthStart' | 'day'>('monthEnd')
  const [dateDay, setDateDay] = useState(25)
  const [dateNextMonth, setDateNextMonth] = useState(false)
  const [incSub, setIncSub] = useState<{ code: string; name: string }>({ code: '', name: '' })
  const [resSub, setResSub] = useState<{ code: string; name: string }>({ code: '', name: '' })
  const [dragOver, setDragOver] = useState(false)
  const [busy, setBusy] = useState('')
  // 給与手当を個人別明細にするか（既定＝合計）
  const [salaryIndividual, setSalaryIndividual] = useState(false)
  // 補助科目ごと（個人別）に計上する控除項目
  const [perPersonItems, setPerPersonItems] = useState<Set<string>>(new Set())
  // 控除項目 → 従業員名 → 補助科目
  const [perPersonSubs, setPerPersonSubs] = useState<Record<string, Record<string, { subCode: string; subName: string }>>>({})

  // ダイアログを開く度にテキストと解析結果をリセット
  useEffect(() => {
    if (open) {
      setPasteText('')
      setParsed(null)
      setLedger(null)
      setBatch(null)
      setJournalDates([])
      setError('')
    }
  }, [open])

  // 学習データの読み込み
  useEffect(() => {
    const saved = loadPayrollSettings()
    if (saved) {
      setAccounts(saved.itemAccounts || {})
      setBankCode(saved.bankCode || '')
      setBankName(saved.bankName || '')
      setBankSubCode(saved.bankSubCode || '')
      setBankSubName(saved.bankSubName || '')
      setSalaryIndividual(!!saved.salaryIndividual)
      setPerPersonItems(new Set(saved.perPersonItems || []))
      setPerPersonSubs(saved.perPersonSubs || {})
    }
  }, [])

  // 解析後に役員フラグを学習データから復元
  useEffect(() => {
    if (!parsed) return
    const saved = loadPayrollSettings()
    if (saved?.executiveNames?.length) {
      const names = new Set(saved.executiveNames)
      const updated = parsed.employees.map((e) => ({ ...e, isExecutive: names.has(e.name) }))
      if (updated.some((e, i) => e.isExecutive !== parsed.employees[i].isExecutive)) {
        setParsed({ ...parsed, employees: updated })
      }
    }
  }, [parsed?.employeeCount])

  // 役員報酬・給与手当は「課税分合計」で計算（支給合計額＝非課税額＋課税分合計）
  const getTaxable = (emp: { items: { name: string; amount: number }[] }) =>
    emp.items.find((i) => i.name === '課税分合計')?.amount || 0
  const executiveTotal = parsed ? parsed.employees.filter((e) => e.isExecutive).reduce((s, e) => s + getTaxable(e), 0) : 0
  const employeeTotal = parsed ? parsed.employees.filter((e) => !e.isExecutive).reduce((s, e) => s + getTaxable(e), 0) : 0

  const itemTotals = useMemo(() => {
    if (!parsed) return new Map<string, number>()
    const m = new Map<string, number>()
    const allHeaders = [...parsed.payHeaders, ...parsed.deductHeaders]
    for (const h of allHeaders) {
      let total = 0
      for (const emp of parsed.employees) {
        const item = emp.items.find((i) => i.name === h)
        if (item) total += item.amount
      }
      m.set(h, total)
    }
    return m
  }, [parsed])

  const totalNetPay = parsed ? parsed.employees.reduce((s, e) => s + e.netPay, 0) : 0
  const bankSubs = bankCode ? subAccountMaster.filter((s) => s.parentCode === bankCode) : []

  if (!open) return null

  // 賞与モード（単月＝isBonus、複数月＝全月が賞与）。借方の学習バケットを切り替える
  const isBonusMode = batch ? batch.every((m) => !!m.isBonus) : !!parsed?.isBonus

  /** 取込データの種類（給与/賞与）に応じて、役員報酬・給与手当の借方科目を学習バケットから適用 */
  const applyDebitDefaults = (bonus: boolean) => {
    const saved = loadPayrollSettings()
    const bucket = bonus ? (saved?.itemAccountsBonus || {}) : (saved?.itemAccounts || {})
    setAccounts((prev) => {
      const next = { ...prev }
      for (const k of DEBIT_KEYS) next[k] = bucket[k] || { code: '', name: '' }
      return next
    })
  }

  const handleParse = async (text?: string) => {
    setError('')
    try {
      const { parsePayrollText } = await import('@/lib/bank-statement/payroll-parser')
      const data = parsePayrollText(text || pasteText)
      if (data.employees.length === 0) throw new Error('従業員データが見つかりません')
      setParsed(data)
      applyDebitDefaults(!!data.isBonus)
    } catch (e) { setError(e instanceof Error ? e.message : '解析に失敗しました') }
  }

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : []
    if (files.length) processFiles(files)
  }

  /** 月ごとの PayrollData 配列 → 表示用に合算した PayrollData（科目設定・役員チェックを全月共通で行うため） */
  const mergeBatch = (list: PayrollData[]): PayrollData => {
    const payHeaders: string[] = []
    const deductHeaders: string[] = []
    for (const m of list) {
      for (const h of m.payHeaders) if (!payHeaders.includes(h)) payHeaders.push(h)
      for (const h of m.deductHeaders) if (!deductHeaders.includes(h)) deductHeaders.push(h)
    }
    const empMap = new Map<string, { no: number; name: string; isExecutive: boolean; items: Map<string, number>; totalPay: number; totalDeductions: number; netPay: number }>()
    for (const m of list) {
      for (const e of m.employees) {
        let agg = empMap.get(e.name)
        if (!agg) { agg = { no: e.no, name: e.name, isExecutive: false, items: new Map(), totalPay: 0, totalDeductions: 0, netPay: 0 }; empMap.set(e.name, agg) }
        for (const it of e.items) agg.items.set(it.name, (agg.items.get(it.name) || 0) + it.amount)
        agg.totalPay += e.totalPay; agg.totalDeductions += e.totalDeductions; agg.netPay += e.netPay
      }
    }
    const allHeaders = [...payHeaders, ...deductHeaders]
    const employees = Array.from(empMap.values()).map((a, i) => ({
      no: a.no || i + 1, name: a.name, isExecutive: false,
      items: allHeaders.map((h) => ({ name: h, amount: a.items.get(h) || 0 })),
      totalPay: a.totalPay, totalDeductions: a.totalDeductions, netPay: a.netPay,
    }))
    const first = list[0]
    const last = list[list.length - 1]
    return {
      period: `${first.period || ''}〜${last.period || ''}`,
      paymentDate: '', companyName: first.companyName,
      employeeCount: employees.length, employees, payHeaders, deductHeaders,
    }
  }

  const processFiles = async (files: File[]) => {
    if (files.length === 1) { await processFile(files[0]); return }
    setError('')
    try {
      const mod = await import('@/lib/bank-statement/payroll-parser')
      const list = await mod.parsePayrollFilesMulti(files)
      if (!list.length) throw new Error('従業員データが見つかりません')
      // 給与と賞与は借方科目が異なるため混在一括は不可（別々に取り込んでもらう）
      const bonusCount = list.filter((m) => m.isBonus).length
      if (bonusCount > 0 && bonusCount < list.length) {
        throw new Error('給与と賞与のファイルが混在しています。借方科目が異なるため、給与と賞与は分けて取り込んでください。')
      }
      if (list.length === 1) { setParsed(list[0]); applyDebitDefaults(!!list[0].isBonus); return }
      setBatch(list)
      setJournalDates(list.map((m) => m.paymentDate || ''))
      setParsed(mergeBatch(list))
      applyDebitDefaults(bonusCount === list.length)
    } catch (e) { setError(e instanceof Error ? e.message : '解析に失敗しました') }
  }

  /** 一括設定ルールで各月の仕訳日を計算（基準＝選択月。当月/前月×末日/◯日） */
  const applyDateRule = (mode2: 'payDate' | 'custom') => {
    if (!batch) return
    setJournalDates(batch.map((m) => {
      if (mode2 === 'payDate') return m.paymentDate || ''
      // 選択月（period 'YYYY-MM'）を基準。無ければ支給日の前月を選択月とみなす
      let y = 0, mo = 0
      const pm = (m.period || '').match(/^(\d{4})-(\d{2})/)
      if (pm) { y = Number(pm[1]); mo = Number(pm[2]) }
      else if (m.paymentDate) { const d = m.paymentDate.match(/^(\d{4})-(\d{2})/); if (d) { y = Number(d[1]); mo = Number(d[2]) - 1; if (mo === 0) { mo = 12; y-- } } }
      if (!y || !mo) return m.paymentDate || ''
      if (ruleMonth === 'prev') { mo--; if (mo === 0) { mo = 12; y-- } }
      const lastDay = new Date(y, mo, 0).getDate()
      const day = ruleDay === 'end' ? lastDay : Math.min(Math.max(1, ruleDay), lastDay)
      return `${y}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    }))
  }

  const processFile = async (file: File) => {
    setError('')
    const lower = file.name.toLowerCase()
    // PDF：給与明細一覧表（列＝従業員/行＝項目）を Gemini でOCR → PayrollData
    if (lower.endsWith('.pdf') || file.type === 'application/pdf') {
      try {
        setBusy('PDFを画像化しています…')
        const { renderAllPdfPages } = await import('@/lib/bank-statement/pdf-text-parser')
        const images = await renderAllPdfPages(file, 2)
        setBusy(`給与明細一覧表を解析しています…（${images.length}ページ）`)
        const model = (typeof window !== 'undefined' && localStorage.getItem('bs-gemini-model')) || undefined
        const { payrollSummaryOcr } = await import('@/lib/bank-statement/gemini-client')
        const raw = await payrollSummaryOcr(images, model || undefined)
        const { payrollOcrToData } = await import('@/lib/bank-statement/payroll-parser')
        const data = payrollOcrToData(raw)
        if (data.employees.length === 0) throw new Error('従業員データを読み取れませんでした。PDFの向き・解像度をご確認ください。')
        setParsed(data)
        applyDebitDefaults(!!data.isBonus)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'PDFの解析に失敗しました')
      } finally { setBusy('') }
      return
    }
    if (!(lower.endsWith('.xlsx') || lower.endsWith('.xls') || lower.endsWith('.ods') || lower.endsWith('.csv'))) {
      setError('PDF・Excel（.xlsx / .xls / .ods）・.csv のいずれかを選択してください'); return
    }
    try {
      const mod = await import('@/lib/bank-statement/payroll-parser')
      // まず「年間・従業員別シート・月列」形式かを判定
      if (await mod.detectPayrollLedgerFile(file)) {
        const led = await mod.parsePayrollLedgerFile(file)
        if (!led.employees.length) throw new Error('従業員シートが見つかりません')
        // 学習済みの役員フラグを復元＋科目デフォルトを名称から補完
        const saved = loadPayrollSettings()
        const execNames = new Set(saved?.executiveNames || [])
        led.employees = led.employees.map((emp) => ({ ...emp, isExecutive: execNames.has(emp.name) }))
        // 解析範囲の初期値＝データのある月の最小〜最大
        const allMonths = led.employees.flatMap((emp) => emp.months.map((m) => m.month))
        if (allMonths.length) { setFromMonth(Math.min(...allMonths)); setToMonth(Math.max(...allMonths)) }
        // 科目デフォルト（学習データ→なければ科目名から自動補完）
        const findByName = (kw: string) => accountMaster.find((a) => (a.name || '').includes(kw) || (a.shortName || '').includes(kw))
        const def = (key: string, kw: string) => {
          const s = saved?.itemAccounts?.[key]
          if (s?.code) return s
          const a = findByName(kw); return a ? { code: a.code, name: a.shortName || a.name } : { code: '', name: '' }
        }
        setAccounts((prev) => ({ ...prev,
          '給与手当': def('給与手当', '給与手当'), '役員報酬': def('役員報酬', '役員報酬'),
          '未払金': def('未払金', '未払金'), '法定福利費': def('法定福利費', '法定福利費'),
          '預り金': def('預り金', '預り金') }))
        if (saved?.itemAccounts?.['預り金_源泉所得税']) setIncSub({ code: saved.itemAccounts['預り金_源泉所得税'].subCode || '', name: saved.itemAccounts['預り金_源泉所得税'].subName || '' })
        if (saved?.itemAccounts?.['預り金_住民税']) setResSub({ code: saved.itemAccounts['預り金_住民税'].subCode || '', name: saved.itemAccounts['預り金_住民税'].subName || '' })
        setLedger(led)
        return
      }
      // 1ファイルでも複数月が入っている形式（氏名・年・月の行形式／選択月列）に対応するため
      // 複数月対応の解析を通す。単月なら従来どおり単月画面、複数月なら一括画面になる。
      const list = await mod.parsePayrollFilesMulti([file])
      if (!list.length || list.every((m) => m.employees.length === 0)) throw new Error('従業員データが見つかりません')
      const bonusCount = list.filter((m) => m.isBonus).length
      if (bonusCount > 0 && bonusCount < list.length) {
        throw new Error('給与と賞与のデータが混在しています。借方科目が異なるため、給与と賞与は分けて取り込んでください。')
      }
      if (list.length === 1) {
        setParsed(list[0])
        applyDebitDefaults(!!list[0].isBonus)
        return
      }
      setBatch(list)
      setJournalDates(list.map((m) => m.paymentDate || ''))
      setParsed(mergeBatch(list))
      applyDebitDefaults(bonusCount === list.length)
    } catch (e) { setError(e instanceof Error ? e.message : '解析に失敗しました') }
  }

  /** 学習データの保存内容を作る。賞与モードでは借方2キーを itemAccountsBonus へ入れ、
   *  給与用の itemAccounts の借方は前回学習を維持する（給与と賞与の科目を混同しない） */
  const buildSettingsToSave = (allAccounts: PayrollSettings['itemAccounts'], execNames: string[]): PayrollSettings => {
    const saved = loadPayrollSettings()
    let itemAccounts = allAccounts
    let itemAccountsBonus = saved?.itemAccountsBonus
    if (isBonusMode) {
      itemAccounts = { ...allAccounts }
      for (const k of DEBIT_KEYS) {
        const prev = saved?.itemAccounts?.[k]
        if (prev) itemAccounts[k] = prev
        else delete itemAccounts[k]
      }
      itemAccountsBonus = { ...(saved?.itemAccountsBonus || {}) }
      for (const k of DEBIT_KEYS) { if (allAccounts[k]) itemAccountsBonus[k] = allAccounts[k] }
    }
    return {
      executiveNames: execNames,
      itemAccounts,
      itemAccountsBonus,
      bankCode, bankName, bankSubCode, bankSubName,
      salaryIndividual,
      perPersonItems: Array.from(perPersonItems),
      perPersonSubs,
    }
  }

  const toggleLedgerExec = (idx: number) => {
    if (!ledger) return
    setLedger({ ...ledger, employees: ledger.employees.map((emp, i) => i === idx ? { ...emp, isExecutive: !emp.isExecutive } : emp) })
  }

  const handleGenerateLedger = async () => {
    if (!ledger || !onGenerateEntries) return
    const a = (k: string) => accounts[k] || { code: '', name: '' }
    if (!a('給与手当').code && ledger.employees.some((e) => !e.isExecutive)) { setError('給与手当の科目コードを設定してください'); return }
    const { payrollLedgerToEntries } = await import('@/lib/bank-statement/payroll-ledger-mapper')
    const rule: LedgerDateRule = dateMode === 'day' ? { type: 'day', day: dateDay, nextMonth: dateNextMonth } : { type: dateMode }
    const entries = payrollLedgerToEntries(ledger, fromMonth, toMonth, {
      salary: a('給与手当'), executive: a('役員報酬'), unpaid: a('未払金'), welfare: a('法定福利費'),
      withholding: a('預り金'), incomeSub: incSub.code ? incSub : undefined, residentSub: resSub.code ? resSub : undefined,
    }, rule, accountTaxMaster)
    if (!entries.length) { setError('対象月に支給データがありません'); return }
    // 学習データ保存（賞与用バケットは温存）
    savePayrollSettings({
      executiveNames: ledger.employees.filter((e) => e.isExecutive).map((e) => e.name),
      itemAccounts: { ...accounts,
        '預り金_源泉所得税': { ...a('預り金'), subCode: incSub.code, subName: incSub.name },
        '預り金_住民税': { ...a('預り金'), subCode: resSub.code, subName: resSub.name } },
      itemAccountsBonus: loadPayrollSettings()?.itemAccountsBonus,
      bankCode, bankName, bankSubCode, bankSubName,
    })
    onGenerateEntries(entries, `賃金台帳から${entries.length}件の仕訳を生成しました（${fromMonth}月〜${toMonth}月・${ledger.employees.length}名）`)
    onClose()
  }

  const toggleExecutive = (idx: number) => {
    if (!parsed) return
    setParsed({ ...parsed, employees: parsed.employees.map((emp, i) => i === idx ? { ...emp, isExecutive: !emp.isExecutive } : emp) })
  }

  const setAccountCode = (itemName: string, code: string) => {
    const acc = accountMaster.find((a) => a.code === code)
    setAccounts((prev) => ({ ...prev, [itemName]: { ...prev[itemName], code, name: acc ? (acc.shortName || acc.name) : '' } }))
  }

  const setSubAccount = (itemName: string, subCode: string, subName: string) => {
    setAccounts((prev) => ({ ...prev, [itemName]: { ...prev[itemName], subCode, subName } }))
  }

  const togglePerPerson = (item: string) => {
    setPerPersonItems((prev) => { const n = new Set(prev); if (n.has(item)) n.delete(item); else n.add(item); return n })
  }
  const setPersonSub = (item: string, empName: string, subCode: string, subName: string) => {
    setPerPersonSubs((prev) => ({ ...prev, [item]: { ...(prev[item] || {}), [empName]: { subCode, subName } } }))
  }

  const renderAccountInput = (name: string) => {
    const acc = accounts[name]
    const subs = acc?.code ? subAccountMaster.filter((s) => s.parentCode === acc.code) : []
    return (
      <div className="flex items-center gap-1 mt-1">
        <input type="text" value={acc?.code || ''} onChange={(e) => setAccountCode(name, e.target.value)}
          placeholder="科目CD" className="w-16 px-1.5 py-1 text-xs border rounded font-mono" />
        <span className="text-xs text-gray-500 min-w-[40px]">{acc?.name || ''}</span>
        {subs.length > 0 && (
          <select value={acc?.subCode || ''} onChange={(e) => {
            const sub = subs.find((s) => s.subCode === e.target.value)
            setSubAccount(name, e.target.value, sub?.shortName || sub?.name || '')
          }} className="px-1 py-1 text-xs border rounded max-w-[100px]">
            <option value="">補助科目</option>
            {subs.map((s) => <option key={s.subCode} value={s.subCode}>{s.shortName || s.name}</option>)}
          </select>
        )}
      </div>
    )
  }

  /** 複数月一括の仕訳作成: 全月に共通の科目設定・役員フラグを適用し、月ごとに複合仕訳を生成 */
  const handleGenerateBatch = async () => {
    if (!parsed || !batch || !bankCode || !onGenerateEntries) return
    setError('')
    for (let i = 0; i < batch.length; i++) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(journalDates[i] || '')) {
        setError(`${batch[i].period || `${i + 1}件目`} の仕訳日を設定してください。`)
        return
      }
    }
    const allAccounts = { ...accounts }
    const ppSubs: Record<string, Record<string, { subCode: string; subName: string }>> = {}
    for (const h of Array.from(perPersonItems)) {
      if (accounts[h]?.code) ppSubs[h] = perPersonSubs[h] || {}
    }
    // 役員チェックは合算表示側で行うため、氏名で各月へ反映する
    const execNames = new Set(parsed.employees.filter((e) => e.isExecutive).map((e) => e.name))
    const months = batch.map((m, i) => ({
      ...m,
      paymentDate: journalDates[i],
      employees: m.employees.map((e) => ({ ...e, isExecutive: execNames.has(e.name) })),
    }))
    // 【必須】貸借バランス検証は月ごとに行う（月によって控除項目の構成が違うことがあるため）
    for (const m of months) {
      const bal = payrollBalanceCheck(m, allAccounts, { salaryIndividual, perPersonSubs: ppSubs })
      if (bal.diff !== 0) {
        const hint = bal.unmapped.length
          ? `科目未設定: ${bal.unmapped.map((u) => `${u.name}（¥${u.amount.toLocaleString()}）`).join('、')}`
          : '設定済み項目の組み合わせをご確認ください。'
        setError(`${m.period || m.paymentDate} の貸借が一致しません（差額 ¥${Math.abs(bal.diff).toLocaleString()}）。${hint}`)
        return
      }
    }
    const { payrollToEntries } = await import('@/lib/bank-statement/payroll-mapper')
    let all: JournalEntry[] = []
    for (const m of months) {
      all = all.concat(payrollToEntries(m, bankCode, bankName, allAccounts, bankSubCode || undefined, bankSubName || undefined, accountTaxMaster, { salaryIndividual, perPersonSubs: ppSubs }))
    }
    savePayrollSettings(buildSettingsToSave(allAccounts, Array.from(execNames)))
    onGenerateEntries(all, `賃金台帳 ${batch.length}ヶ月分（${batch[0].period}〜${batch[batch.length - 1].period}）から${all.length}件の仕訳を生成しました`)
    onClose()
  }

  const handleGenerate = () => {
    if (batch) { handleGenerateBatch(); return }
    if (!parsed || !bankCode) return
    setError('')
    // 【必須】支給日：空だと日付なし伝票になり、CSV出力で黙って除外される
    if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed.paymentDate || '')) {
      setError('支給日を設定してください（上部の「支給日」欄）。仕訳の伝票日付になります。')
      return
    }
    const allAccounts = { ...accounts }
    // 「補助科目ごと（個人別）」に指定された控除項目だけを options.perPersonSubs に渡す
    const ppSubs: Record<string, Record<string, { subCode: string; subName: string }>> = {}
    for (const h of Array.from(perPersonItems)) {
      if (accounts[h]?.code) ppSubs[h] = perPersonSubs[h] || {}
    }
    // 【必須】貸借バランス検証：未設定項目があると差額が「差引支給額（引落口座）」行へ
    // 自動調整で押し込まれ、通帳と一致しない金額でCSV出力されてしまうため、ここでブロックする。
    const bal = payrollBalanceCheck(parsed, allAccounts, { salaryIndividual, perPersonSubs: ppSubs })
    if (bal.diff !== 0) {
      const hint = bal.unmapped.length
        ? `科目未設定: ${bal.unmapped.map((u) => `${u.name}（¥${u.amount.toLocaleString()}）`).join('、')}`
        : '設定済み項目の組み合わせが重複／不足していないかご確認ください（例: 課税分合計系と基本給などの二重設定）。'
      setError(`貸借が一致しません（差額 ¥${Math.abs(bal.diff).toLocaleString()}）。このまま作成すると引落口座の金額が通帳と合わなくなります。${hint}`)
      return
    }
    // 学習データを保存（賞与は借方を別バケットで学習）
    savePayrollSettings(buildSettingsToSave(allAccounts, parsed.employees.filter((e) => e.isExecutive).map((e) => e.name)))
    onGenerate(parsed, bankCode, bankName, allAccounts, bankSubCode || undefined, bankSubName || undefined, {
      salaryIndividual,
      perPersonSubs: ppSubs,
    })
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center" onMouseDown={(e) => { if (e.target === e.currentTarget) (onClose)() }}>
      <div className="bg-white rounded-lg shadow-xl w-[95vw] max-w-[1200px] max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-3 border-b bg-gray-50">
          <h2 className="text-lg font-bold">賃金台帳 → 仕訳データ作成</h2>
        </div>

        {ledger ? (
          <LedgerView
            ledger={ledger} fromMonth={fromMonth} toMonth={toMonth} setFromMonth={setFromMonth} setToMonth={setToMonth}
            dateMode={dateMode} setDateMode={setDateMode} dateDay={dateDay} setDateDay={setDateDay} dateNextMonth={dateNextMonth} setDateNextMonth={setDateNextMonth}
            toggleExec={toggleLedgerExec} renderAccountInput={renderAccountInput} accounts={accounts}
            subAccountMaster={subAccountMaster} incSub={incSub} setIncSub={setIncSub} resSub={resSub} setResSub={setResSub}
            error={error} onCancel={() => setLedger(null)} onGenerate={handleGenerateLedger}
          />
        ) : !parsed ? (
          <div className="px-6 py-4 space-y-4">
            <div className="flex gap-2">
              <button onClick={() => setMode('paste')} className={`px-3 py-1.5 text-sm rounded ${mode === 'paste' ? 'bg-blue-600 text-white' : 'bg-gray-200'}`}>テキスト貼り付け</button>
              <button onClick={() => setMode('file')} className={`px-3 py-1.5 text-sm rounded ${mode === 'file' ? 'bg-blue-600 text-white' : 'bg-gray-200'}`}>ファイル選択</button>
            </div>
            <div className="text-[11px] text-gray-500">※ 給与明細一覧表の<b>PDF</b>も取り込めます（列＝従業員／行＝項目の表をAIで読み取り）。従業員別シート・月列形式の「年間賃金台帳」Excelは人別×月別の複合仕訳を作成します。「氏名・年・月」の列を持つ行形式のExcel（1ファイルに複数月）は月ごとの仕訳を一括作成できます（仕訳日は取込後に指定）。</div>
            {busy && <div className="text-sm text-blue-700 bg-blue-50 p-2 rounded flex items-center gap-2"><span className="inline-block w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin"></span>{busy}</div>}
            {mode === 'paste' ? (
              <>
                <div className="text-xs text-gray-600">Excelの給与明細一覧表をコピーして貼り付けてください</div>
                <textarea value={pasteText} onChange={(e) => setPasteText(e.target.value)}
                  placeholder="Excelからコピーしたデータを貼り付け（タブ区切り）"
                  className="w-full h-48 p-3 text-xs font-mono border rounded resize-none" />
                <button onClick={() => handleParse()} disabled={!pasteText.trim()}
                  className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-40">解析</button>
              </>
            ) : (
              <label
                onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
                onDragLeave={(e) => { e.preventDefault(); setDragOver(false) }}
                onDrop={(e) => { e.preventDefault(); setDragOver(false); const fs = e.dataTransfer.files ? Array.from(e.dataTransfer.files) : []; if (fs.length) processFiles(fs) }}
                className={`flex flex-col items-center justify-center gap-2 w-full py-10 px-4 border-2 border-dashed rounded-lg cursor-pointer transition-colors ${dragOver ? 'border-blue-500 bg-blue-50' : 'border-gray-300 bg-gray-50 hover:bg-gray-100'}`}>
                <div className="text-3xl">📥</div>
                <div className="text-sm text-gray-700 font-medium">ここに賃金台帳ファイルをドラッグ&ドロップ</div>
                <div className="text-xs text-gray-500">またはクリックして選択（.pdf / .xlsx / .xls / .csv）。<b>複数月のCSVをまとめて選択</b>すると月別の仕訳を一括作成できます</div>
                <input type="file" accept=".pdf,.xlsx,.xls,.ods,.csv" multiple onChange={handleFileUpload} className="hidden" />
              </label>
            )}
            {error && <div className="text-sm text-red-600 bg-red-50 p-2 rounded">{error}</div>}
          </div>
        ) : (
          <div className="px-6 py-4 space-y-5">
            {/* メタ情報 */}
            {!batch ? (
              <div className="flex gap-6 text-sm items-center flex-wrap">
                <label className="flex items-center gap-1"><b>期間:</b>
                  <input type="text" value={parsed.period || ''} onChange={(e) => setParsed({ ...parsed, period: e.target.value })}
                    className="px-2 py-1 border rounded text-sm w-32" placeholder="例: 2025-09" title="仕訳の摘要に入ります" />
                </label>
                <label className="flex items-center gap-1"><b>支給日:</b>
                  <input type="date" value={parsed.paymentDate || ''} onChange={(e) => setParsed({ ...parsed, paymentDate: e.target.value })}
                    className="px-2 py-1 border rounded text-sm" />
                </label>
                <span><b>会社:</b> {parsed.companyName || '—'}</span>
                <span><b>人数:</b> {parsed.employees.length}名</span>
              </div>
            ) : (
              <div className="p-3 bg-blue-50 rounded-lg border border-blue-200">
                <div className="text-sm font-bold text-blue-900 mb-2">複数月一括（{batch.length}ヶ月分）— 月ごとの仕訳日を確認・修正してください</div>
                <div className="flex items-center gap-2 text-xs flex-wrap mb-2">
                  <span className="font-bold">仕訳日の一括設定:</span>
                  <button onClick={() => applyDateRule('payDate')} className="px-2.5 py-1 border border-blue-300 bg-white rounded hover:bg-blue-100">支給日どおり</button>
                  <span className="flex items-center gap-1 bg-white border border-blue-300 rounded px-2 py-1">
                    選択月の
                    <select value={ruleMonth} onChange={(e) => setRuleMonth(e.target.value as 'same' | 'prev')} className="px-1 py-0.5 border rounded">
                      <option value="same">当月</option>
                      <option value="prev">前月</option>
                    </select>
                    <select value={ruleDay === 'end' ? 'end' : 'day'} onChange={(e) => setRuleDay(e.target.value === 'end' ? 'end' : 25)} className="px-1 py-0.5 border rounded">
                      <option value="end">末日</option>
                      <option value="day">指定日</option>
                    </select>
                    {ruleDay !== 'end' && (
                      <input type="number" min={1} max={31} value={ruleDay} onChange={(e) => setRuleDay(Math.min(31, Math.max(1, Number(e.target.value) || 1)))} className="w-12 px-1 py-0.5 border rounded" />
                    )}
                    {ruleDay !== 'end' && <span>日</span>}
                    <button onClick={() => applyDateRule('custom')} className="px-2 py-0.5 bg-blue-600 text-white rounded hover:bg-blue-700 ml-1">一括適用</button>
                  </span>
                </div>
                <table className="w-full text-xs bg-white rounded border">
                  <thead className="bg-gray-100">
                    <tr>
                      <th className="px-2 py-1 text-left">選択月</th>
                      <th className="px-2 py-1 text-left">支給日（CSV）</th>
                      <th className="px-2 py-1 text-left">仕訳日（編集可）</th>
                      <th className="px-2 py-1 text-right">人数</th>
                      <th className="px-2 py-1 text-right">課税支給計</th>
                      <th className="px-2 py-1 text-right">差引支給計</th>
                    </tr>
                  </thead>
                  <tbody>
                    {batch.map((m, i) => {
                      const taxable = m.employees.reduce((s, e) => s + (e.items.find((it) => it.name === '課税分合計')?.amount || 0), 0)
                      const net = m.employees.reduce((s, e) => s + e.netPay, 0)
                      return (
                        <tr key={i} className="border-t">
                          <td className="px-2 py-1">{m.period || '—'}{m.isBonus ? '（賞与）' : ''}</td>
                          <td className="px-2 py-1 text-gray-500">{m.paymentDate || '—'}</td>
                          <td className="px-2 py-1">
                            <input type="date" value={journalDates[i] || ''}
                              onChange={(e) => setJournalDates((prev) => prev.map((d, j) => (j === i ? e.target.value : d)))}
                              className={`px-1.5 py-0.5 border rounded ${journalDates[i] && journalDates[i] !== m.paymentDate ? 'border-blue-400 text-blue-800 font-bold' : ''}`} />
                          </td>
                          <td className="px-2 py-1 text-right">{m.employees.length}名</td>
                          <td className="px-2 py-1 text-right tabular-nums">{taxable.toLocaleString()}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{net.toLocaleString()}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                <div className="text-[11px] text-gray-500 mt-1">
                  ※ 科目設定・役員チェックは全月共通です（下の金額は{batch.length}ヶ月分の合計を表示）。仕訳は月ごとに1組ずつ作成されます。
                </div>
              </div>
            )}

            {/* 従業員一覧 */}
            <div>
              <div className="text-sm font-bold mb-1">従業員一覧（役員にチェック）</div>
              <div className="border rounded max-h-[180px] overflow-auto">
                <table className="w-full text-xs">
                  <thead className="bg-gray-100 sticky top-0">
                    <tr><th className="px-2 py-1 w-10">役員</th><th className="px-2 py-1 w-8">NO</th><th className="px-2 py-1 text-left">氏名</th><th className="px-2 py-1 text-right">支給合計</th><th className="px-2 py-1 text-right">控除合計</th><th className="px-2 py-1 text-right">差引支給額</th></tr>
                  </thead>
                  <tbody>
                    {parsed.employees.map((emp, idx) => (
                      <tr key={idx} className={`border-t ${emp.isExecutive ? 'bg-amber-50' : ''}`}>
                        <td className="px-2 py-0.5 text-center"><input type="checkbox" checked={emp.isExecutive} onChange={() => toggleExecutive(idx)} /></td>
                        <td className="px-2 py-0.5 text-center">{emp.no}</td>
                        <td className="px-2 py-0.5">{emp.name}</td>
                        <td className="px-2 py-0.5 text-right">{emp.totalPay.toLocaleString()}</td>
                        <td className="px-2 py-0.5 text-right">{emp.totalDeductions.toLocaleString()}</td>
                        <td className="px-2 py-0.5 text-right">{emp.netPay.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-1 text-xs text-gray-600">
                役員報酬: ¥{executiveTotal.toLocaleString()} / 給与手当: ¥{employeeTotal.toLocaleString()}
              </div>
            </div>

            {/* 賃金台帳項目の勘定科目設定 */}
            <div>
              <div className="text-sm font-bold mb-3">賃金台帳項目の勘定科目設定</div>

              {/* 支給項目 */}
              <div className="mb-4 p-3 bg-green-50 rounded-lg border border-green-200">
                <div className="text-sm font-bold text-green-800 mb-2">支給項目</div>
                <div className="flex flex-wrap gap-x-4 gap-y-3">
                  {parsed.payHeaders.map((h) => {
                    const total = itemTotals.get(h) || 0
                    if (total === 0 && !['支給合計額', '非課税額', '課税分合計'].includes(h)) return null
                    return (
                      <div key={h}>
                        <div className="text-xs font-bold">{h}</div>
                        <div className="text-xs text-gray-500">¥{total.toLocaleString()}</div>
                        {renderAccountInput(h)}
                      </div>
                    )
                  })}
                  {/* 課税分合計の内訳: 役員報酬・給与手当（賞与は別の科目・別学習） */}
                  <div className="border-l-2 border-green-400 pl-3">
                    <div className="text-xs font-bold text-amber-700">{isBonusMode ? '役員賞与（借方）' : '役員報酬'}</div>
                    <div className="text-xs text-gray-500">¥{executiveTotal.toLocaleString()}</div>
                    {renderAccountInput('役員報酬')}
                  </div>
                  <div>
                    <div className="text-xs font-bold text-blue-700">{isBonusMode ? '従業員賞与（借方）' : '給与手当'}</div>
                    <div className="text-xs text-gray-500">¥{employeeTotal.toLocaleString()}</div>
                    {isBonusMode && <div className="text-[10px] text-amber-600">※ 賞与の借方科目は給与とは別に記憶されます</div>}
                    {renderAccountInput('給与手当')}
                    <label className="flex items-center gap-1 mt-1 text-[11px] text-gray-600 cursor-pointer" title="ONで従業員ごとの明細行（摘要に氏名）。OFFで合計1行">
                      <input type="checkbox" checked={salaryIndividual} onChange={(e) => setSalaryIndividual(e.target.checked)} />個人別に明細
                    </label>
                  </div>
                </div>
              </div>

              {/* 控除項目 */}
              <div className="mb-4 p-3 bg-red-50 rounded-lg border border-red-200">
                <div className="text-sm font-bold text-red-800 mb-2">控除項目</div>
                <div className="flex flex-wrap gap-x-4 gap-y-3">
                  {parsed.deductHeaders.map((h) => {
                    const total = itemTotals.get(h) || 0
                    if (total === 0 && h !== '控除合計額') return null
                    const acc = accounts[h]
                    const hasSubs = acc?.code ? subAccountMaster.some((s) => s.parentCode === acc.code) : false
                    return (
                      <div key={h}>
                        <div className="text-xs font-bold">{h}</div>
                        <div className="text-xs text-gray-500">¥{total.toLocaleString()}</div>
                        {renderAccountInput(h)}
                        {hasSubs && (
                          <label className="flex items-center gap-1 mt-1 text-[11px] text-gray-600 cursor-pointer" title="ONで、金額のある従業員ごとに補助科目を割り当てて個別計上（天引き貯蓄など会社独自の項目向け）">
                            <input type="checkbox" checked={perPersonItems.has(h)} onChange={() => togglePerPerson(h)} />補助を個人別
                          </label>
                        )}
                      </div>
                    )
                  })}
                </div>

                {/* 補助科目ごと（個人別）の割り当てパネル */}
                {Array.from(perPersonItems).filter((h) => accounts[h]?.code && parsed.deductHeaders.includes(h)).map((h) => {
                  const subs = subAccountMaster.filter((s) => s.parentCode === accounts[h].code)
                  const emps = parsed.employees.filter((e) => (e.items.find((i) => i.name === h)?.amount || 0) > 0)
                  return (
                    <div key={h} className="mt-3 p-3 bg-white rounded-lg border border-red-300">
                      <div className="text-sm font-bold text-red-800 mb-2">「{h}」を補助科目ごとに個別計上（{emps.length}名）</div>
                      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-x-4 gap-y-1.5">
                        {emps.map((e) => {
                          const amt = e.items.find((i) => i.name === h)?.amount || 0
                          // 同姓同名がいる場合は NO 付きキーで区別（mapper と共通の payrollPersonKey）
                          const pk = payrollPersonKey(e, parsed.employees)
                          const cur = perPersonSubs[h]?.[pk] || perPersonSubs[h]?.[e.name]
                          return (
                            <div key={pk} className="flex items-center gap-2 text-xs">
                              <span className="min-w-[72px] truncate">{pk}</span>
                              <span className="text-gray-500 tabular-nums w-16 text-right">¥{amt.toLocaleString()}</span>
                              <select value={cur?.subCode || ''} onChange={(ev) => { const s = subs.find((x) => x.subCode === ev.target.value); setPersonSub(h, pk, ev.target.value, s?.shortName || s?.name || '') }}
                                className="px-1 py-1 border rounded flex-1 min-w-0">
                                <option value="">補助科目を選択</option>
                                {subs.map((s) => <option key={s.subCode} value={s.subCode}>{s.shortName || s.name}</option>)}
                              </select>
                            </div>
                          )
                        })}
                      </div>
                      <div className="text-[11px] text-gray-400 mt-1">※ 補助科目未選択の人は、上の「{h}」で選んだ補助科目（既定）で計上されます。</div>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* 引落口座 */}
            <div className="p-3 bg-gray-50 rounded-lg border">
              <div className="text-sm font-bold mb-2">引落口座（差引支給額の貸方）</div>
              <div className="flex items-center gap-3">
                <input type="text" value={bankCode}
                  onChange={(e) => {
                    setBankCode(e.target.value)
                    const a = accountMaster.find((x) => x.code === e.target.value)
                    setBankName(a?.shortName || a?.name || '')
                    setBankSubCode(''); setBankSubName('')
                  }}
                  placeholder="科目CD" className="w-20 px-2 py-1.5 border rounded font-mono text-sm" />
                <span className="text-sm">{bankName}</span>
                {bankSubs.length > 0 && (
                  <select value={bankSubCode} onChange={(e) => {
                    setBankSubCode(e.target.value)
                    const sub = bankSubs.find((s) => s.subCode === e.target.value)
                    setBankSubName(sub?.shortName || sub?.name || '')
                  }} className="px-2 py-1.5 text-sm border rounded">
                    <option value="">補助科目を選択</option>
                    {bankSubs.map((s) => <option key={s.subCode} value={s.subCode}>{s.shortName || s.name}</option>)}
                  </select>
                )}
                {bankSubName && <span className="text-sm text-gray-500">{bankSubName}</span>}
                <div className="ml-auto text-sm font-bold text-blue-700">
                  差引支給額合計: ¥{totalNetPay.toLocaleString()}
                </div>
              </div>
            </div>

            {error && <div className="text-sm text-red-600 bg-red-50 p-2 rounded">{error}</div>}

            <div className="flex gap-2 justify-end">
              <button onClick={() => { setParsed(null); setBatch(null); setJournalDates([]) }} className="px-4 py-2 text-sm bg-gray-200 rounded hover:bg-gray-300">戻る</button>
              <button onClick={handleGenerate} disabled={!bankCode || (!batch && !parsed.paymentDate)}
                title={!bankCode ? '引落口座を設定してください' : (!batch && !parsed.paymentDate) ? '支給日を設定してください' : ''}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-40">
                {batch ? `仕訳作成（${batch.length}ヶ月分）` : '仕訳作成'}
              </button>
            </div>
          </div>
        )}

        <div className="px-6 py-2 border-t flex justify-end">
          <button onClick={onClose} className="px-4 py-2 text-sm bg-gray-200 rounded hover:bg-gray-300">閉じる</button>
        </div>
      </div>
    </div>
  )
}

// ===== 年間賃金台帳（従業員別シート・月列）モードのUI =====
function LedgerView(props: {
  ledger: PayrollLedger
  fromMonth: number; toMonth: number; setFromMonth: (n: number) => void; setToMonth: (n: number) => void
  dateMode: 'monthEnd' | 'monthStart' | 'day'; setDateMode: (m: 'monthEnd' | 'monthStart' | 'day') => void
  dateDay: number; setDateDay: (n: number) => void; dateNextMonth: boolean; setDateNextMonth: (b: boolean) => void
  toggleExec: (idx: number) => void
  renderAccountInput: (name: string) => React.ReactNode
  accounts: Record<string, { code: string; name: string; subCode?: string; subName?: string }>
  subAccountMaster: SubAccountItem[]
  incSub: { code: string; name: string }; setIncSub: (s: { code: string; name: string }) => void
  resSub: { code: string; name: string }; setResSub: (s: { code: string; name: string }) => void
  error: string; onCancel: () => void; onGenerate: () => void
}) {
  const { ledger, fromMonth, toMonth, setFromMonth, setToMonth, dateMode, setDateMode, dateDay, setDateDay, dateNextMonth, setDateNextMonth, toggleExec, renderAccountInput, accounts, subAccountMaster, incSub, setIncSub, resSub, setResSub, error, onCancel, onGenerate } = props
  const inRange = (m: number) => m >= Math.min(fromMonth, toMonth) && m <= Math.max(fromMonth, toMonth)
  const monthSum = (emp: { months: { month: number; gross: number }[] }) => emp.months.filter((m) => inRange(m.month)).reduce((s, m) => s + m.gross, 0)
  const months = Array.from({ length: 12 }, (_, i) => i + 1)
  const whCode = accounts['預り金']?.code || ''
  const whSubs = whCode ? subAccountMaster.filter((s) => s.parentCode === whCode) : []
  const subSelect = (cur: { code: string; name: string }, set: (s: { code: string; name: string }) => void) => (
    <select value={cur.code} onChange={(e) => { const s = whSubs.find((x) => x.subCode === e.target.value); set({ code: e.target.value, name: s?.shortName || s?.name || '' }) }}
      className="px-1 py-1 text-xs border rounded max-w-[120px]">
      <option value="">補助科目</option>
      {whSubs.map((s) => <option key={s.subCode} value={s.subCode}>{s.shortName || s.name}</option>)}
    </select>
  )
  const targetCount = ledger.employees.reduce((s, e) => s + e.months.filter((m) => inRange(m.month) && m.gross > 0).length, 0)
  return (
    <div className="px-6 py-4 space-y-5">
      <div className="flex gap-6 text-sm flex-wrap">
        <span><b>形式:</b> 年間賃金台帳（人別シート）</span>
        <span><b>年:</b> {ledger.year || '—'}年</span>
        <span><b>会社:</b> {ledger.companyName || '—'}</span>
        <span><b>人数:</b> {ledger.employees.length}名</span>
      </div>

      {/* 解析範囲・計上日 */}
      <div className="flex flex-wrap items-end gap-4 p-3 bg-blue-50 rounded-lg border border-blue-200">
        <div>
          <div className="text-xs font-bold mb-1">解析する月の範囲</div>
          <div className="flex items-center gap-1 text-sm">
            <select value={fromMonth} onChange={(e) => setFromMonth(Number(e.target.value))} className="px-2 py-1 border rounded">{months.map((m) => <option key={m} value={m}>{m}月</option>)}</select>
            <span>〜</span>
            <select value={toMonth} onChange={(e) => setToMonth(Number(e.target.value))} className="px-2 py-1 border rounded">{months.map((m) => <option key={m} value={m}>{m}月</option>)}</select>
          </div>
        </div>
        <div>
          <div className="text-xs font-bold mb-1">計上日（各月の仕訳日付）</div>
          <div className="flex items-center gap-2 text-sm flex-wrap">
            <label className="flex items-center gap-1"><input type="radio" checked={dateMode === 'monthEnd'} onChange={() => setDateMode('monthEnd')} />当月末日</label>
            <label className="flex items-center gap-1"><input type="radio" checked={dateMode === 'monthStart'} onChange={() => setDateMode('monthStart')} />当月1日</label>
            <label className="flex items-center gap-1"><input type="radio" checked={dateMode === 'day'} onChange={() => setDateMode('day')} />
              <select disabled={dateMode !== 'day'} value={dateNextMonth ? '1' : '0'} onChange={(e) => setDateNextMonth(e.target.value === '1')} className="px-1 py-1 border rounded text-xs"><option value="0">当月</option><option value="1">翌月</option></select>
              <input type="number" min={1} max={31} disabled={dateMode !== 'day'} value={dateDay} onChange={(e) => setDateDay(Number(e.target.value))} className="w-14 px-1 py-1 border rounded text-xs" />日
            </label>
          </div>
        </div>
        <div className="ml-auto text-sm text-blue-800 font-bold self-center">対象: {targetCount}人月分の複合仕訳</div>
      </div>

      {/* 従業員一覧（役員にチェック→役員報酬） */}
      <div>
        <div className="text-sm font-bold mb-1">従業員一覧（役員にチェックすると借方が「役員報酬」になります。既定は「給与手当」）</div>
        <div className="border rounded max-h-[180px] overflow-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-100 sticky top-0"><tr><th className="px-2 py-1 w-12">役員</th><th className="px-2 py-1 text-left">氏名</th><th className="px-2 py-1 text-right">対象月数</th><th className="px-2 py-1 text-right">範囲内 総支給額計</th></tr></thead>
            <tbody>
              {ledger.employees.map((emp, idx) => (
                <tr key={idx} className={`border-t ${emp.isExecutive ? 'bg-amber-50' : ''}`}>
                  <td className="px-2 py-0.5 text-center"><input type="checkbox" checked={emp.isExecutive} onChange={() => toggleExec(idx)} /></td>
                  <td className="px-2 py-0.5">{emp.name} {emp.isExecutive ? <span className="text-amber-700 font-bold">役員報酬</span> : <span className="text-gray-400">給与手当</span>}</td>
                  <td className="px-2 py-0.5 text-right">{emp.months.filter((m) => inRange(m.month) && m.gross > 0).length}ヶ月</td>
                  <td className="px-2 py-0.5 text-right">¥{monthSum(emp).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* 勘定科目設定 */}
      <div>
        <div className="text-sm font-bold mb-3">勘定科目設定（借方＝給与手当/役員報酬、貸方＝未払金・法定福利費・預り金）</div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-3">
          <div><div className="text-xs font-bold">給与手当（借方・総支給額）</div>{renderAccountInput('給与手当')}</div>
          <div><div className="text-xs font-bold text-amber-700">役員報酬（借方・役員のみ）</div>{renderAccountInput('役員報酬')}</div>
          <div><div className="text-xs font-bold">未払金（貸方・差引支給額）</div>{renderAccountInput('未払金')}</div>
          <div><div className="text-xs font-bold">法定福利費（貸方・社会保険料）</div>{renderAccountInput('法定福利費')}</div>
          <div className="col-span-2 md:col-span-3 p-2 bg-gray-50 rounded border">
            <div className="text-xs font-bold mb-1">預り金（貸方・所得税/住民税）— 補助科目で分けます</div>
            {renderAccountInput('預り金')}
            <div className="flex items-center gap-3 mt-2 text-xs">
              <span className="text-gray-600">源泉所得税:</span>{subSelect(incSub, setIncSub)}
              <span className="text-gray-600 ml-2">住民税:</span>{subSelect(resSub, setResSub)}
              {!whCode && <span className="text-gray-400">※ 先に預り金の科目CDを設定すると補助科目を選べます</span>}
            </div>
          </div>
        </div>
      </div>

      {error && <div className="text-sm text-red-600 bg-red-50 p-2 rounded">{error}</div>}
      <div className="flex gap-2 justify-end">
        <button onClick={onCancel} className="px-4 py-2 text-sm bg-gray-200 rounded hover:bg-gray-300">戻る</button>
        <button onClick={onGenerate} className="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700">人別×月別 仕訳を作成</button>
      </div>
    </div>
  )
}
