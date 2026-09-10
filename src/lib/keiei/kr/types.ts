// 月次経営レポート の型定義。
//
// データ源は会計ソフトから吐き出した月次推移(PL/BS)のJSONファイル
// （schema: "keiei-monthly/1"）。これを取り込み、Firestore の
// tenants/{tenantId}/apps/keiei-report/state/current に保存する（方針B）。
// 閲覧が中心・編集は税理士のメモ等のみのため方針Bで問題ない。

export const APP_ID = 'keiei-report';
export const STATE_VERSION = 2;

/** 取込JSONのスキーマ識別子（これ以外のファイルは受け付けない） */
export const IMPORT_SCHEMA = 'keiei-monthly/1';

/** 月次推移表の1行（勘定科目 or 小計行）。 */
export interface AccountRow {
  /** 会計ソフトの科目コード（小計は95xx等） */
  code: string;
  /** 科目名（例: 現金 /【現金及び預金】/〔経常利益〕） */
  name: string;
  /** BS か PL か */
  statement: 'BS' | 'PL';
  /** 月別金額（決算月基準で12ヶ月。BSは月末残高・PLは月中発生額） */
  monthly: number[];
  /** 年度累計（BSは期末残高） */
  annual: number;
  /** 構成比（%）。会計ソフトの出力値そのまま */
  ratio: number;
  /** 小計・合計行か */
  isSubtotal: boolean;
  /** 会計ソフトの区分（group / profit / 空） */
  bracket: string;
  /** インデントレベル */
  level: number;
}

/** 1事業年度分の月次推移データ。 */
export interface FiscalYearData {
  /** 例: "2026-09"（決算年-決算月） */
  id: string;
  /** 例: "令和8年9月期" */
  label: string;
  /** 決算年（西暦） */
  endYear: number;
  /** 決算月 */
  endMonth: number;
  /** 各列が暦の何月か（例: [10,11,12,1,...,9]） */
  fiscalMonths: number[];
  /** データが入っている最後の列（0始まり）。進行期は途中まで */
  lastFilledIndex: number;
  /** 月次推移の全行 */
  rows: AccountRow[];
}

/** 変動費/固定費の分類上書き（損益分岐点分析用）。 */
export type CostClass = 'variable' | 'fixed';

/**
 * 「AIに質問」の1件分の記録（顧問先が何を聞いたかを税理士が把握するため）。
 * 顧問先データそのものではなく、質問と回答文だけを残す。
 */
export interface QaEntry {
  id: string;
  /** 質問した日時（ISO） */
  at: string;
  /** 質問文 */
  question: string;
  /** 回答の要約（画面に出した文章） */
  answer: string;
  /** どの集計で答えたか（未対応の質問は null） */
  tool: string | null;
  /** 税務判断などで回答しなかった場合 true */
  declined: boolean;
  /** 税理士が付ける「面談で触れる」印 */
  starred: boolean;
  /**
   * キーワードでは読み取れず、AI（Vertex AI）に読み取ってもらった場合 true。
   * どんな聞き方が定型から外れているかが分かり、次のプリセット追加の材料になる。
   * 旧い記録には無いため任意。
   */
  viaAi?: boolean;
}

/** アプリの State（全体を1ドキュメントに保存）。 */
export interface State {
  version: number;
  /** 取込元の会社（会計ソフトの顧問先コード・名称） */
  client: { code: string; name: string } | null;
  /** 取込元JSONの生成日時 */
  generatedAt: string;
  /** 最終取込日時 */
  uploadedAt: string;
  /** 事業年度（決算期の昇順） */
  years: FiscalYearData[];
  settings: {
    /** 実効税率（%）。返済原資を確保する必要売上高などの逆算に使う */
    taxRate: number;
    /** 法人住民税の均等割（円/年）。納税予測に使う */
    equalization: number;
    /** 科目コード→変動費/固定費の上書き（未指定は自動判定） */
    costClass: Record<string, CostClass>;
    /** 税理士の所見メモ。キーは 年度id または `${年度id}:${月index}` */
    notes: Record<string, string>;
    /** 年度ごとの従業員数（労働分配率の1人当たり分析に使う）。キーは年度id */
    employees: Record<string, number>;
    /** 顧問先がAI機能の説明に同意した記録（未同意は null） */
    aiConsent: { acceptedAt: string; uid: string } | null;
    /** 「AIに質問」の記録（新しい順・直近200件まで） */
    qaLog: QaEntry[];
  };
}

export function emptyState(): State {
  return {
    version: STATE_VERSION,
    client: null,
    generatedAt: '',
    uploadedAt: '',
    years: [],
    settings: {
      taxRate: 34, equalization: 70000, costClass: {}, notes: {}, employees: {},
      aiConsent: null, qaLog: [],
    },
  };
}
