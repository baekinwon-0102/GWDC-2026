import { z } from "zod";

// 팀 공통 계약. 금액은 모두 문자열(Decimal 문자열)로 주고받는다.

export const DecimalString = z.string().regex(/^\d+(\.\d+)?$/, "숫자 문자열이어야 합니다");
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD 형식이어야 합니다");

export const Chain = z.enum(["mainnet", "nile"]);
export type Chain = z.infer<typeof Chain>;

export const DataMode = z.enum(["live", "snapshot", "synthetic"]);
export type DataMode = z.infer<typeof DataMode>;

export const RiskProfile = z.enum(["conservative", "balanced", "aggressive"]);
export type RiskProfile = z.infer<typeof RiskProfile>;

/** 모든 외부 값에 붙는 출처 메타데이터 */
export const SourceMeta = z.object({
  sourceUrl: z.string(),
  chain: Chain,
  fetchedAt: z.string(),
  sourceUpdatedAt: z.string().optional(),
  mode: DataMode,
  accessMethod: z.enum(["mcp", "direct", "fixture"]),
  serverId: z.string().optional(),
  toolName: z.string().optional(),
  note: z.string().optional(),
});
export type SourceMeta = z.infer<typeof SourceMeta>;

// ---------------------------------------------------------------- UserNeeds

export const Expense = z.object({
  id: z.string(),
  date: IsoDate,
  amount: DecimalString,
  asset: z.string(),
  label: z.string().optional(),
});
export type Expense = z.infer<typeof Expense>;

export const HoldingAsset = z.enum(["USDT", "TRX", "USDD"]);
export const Holding = z.object({ asset: HoldingAsset, amount: DecimalString });
export type Holding = z.infer<typeof Holding>;

export const UserNeeds = z.object({
  chain: Chain,
  /** 대표 보유 자산 (여러 자산이면 holdings의 첫 번째, 비상 여유액은 이 자산으로 둔다) */
  asset: HoldingAsset,
  amount: DecimalString.optional(),
  /** 여러 자산을 보유하면 전체 목록 (Mainnet만). 자산마다 같은 배분 로직을 따로 적용한다 */
  holdings: z.array(Holding).max(4).optional(),
  startDate: IsoDate,
  endDate: IsoDate.optional(),
  expenses: z.array(Expense),
  /** 사용자가 "지출 없음"을 명시했거나 지출 목록을 확인했는지 */
  expensesStated: z.boolean(),
  bufferAmount: DecimalString.optional(),
  riskProfile: RiskProfile.optional(),
  acceptUsddRisk: z.boolean().optional(),
  /** 비용 가정: Energy 조달 방식 (기본 소각) */
  energySource: z.enum(["burn", "stake", "rent"]).optional(),
  /** 비용 가정: 거래 Energy 기준 (기본 실측 최대값) */
  costBasisMode: z.enum(["max", "median", "typical"]).optional(),
  timezone: z.literal("Asia/Seoul"),
  version: z.number().int().nonnegative(),
});
export type UserNeeds = z.infer<typeof UserNeeds>;

/** LLM(또는 템플릿 파서)이 돌려주는 추출 결과. 명시된 정보만 채운다. */
export const NeedsPatch = z.object({
  /** 보유 자산 종류 (Mainnet: USDT·TRX·USDD) */
  asset: z.enum(["USDT", "TRX", "USDD"]).nullish(),
  amount: DecimalString.nullish(),
  /** 여러 자산을 말하면 전체 보유 목록 ("USDT 5,000과 TRX 20,000") */
  holdings: z.array(z.object({ asset: z.enum(["USDT", "TRX", "USDD"]), amount: DecimalString })).max(4).nullish(),
  durationDays: z.number().int().positive().max(3650).nullish(),
  endDate: IsoDate.nullish(),
  expenses: z
    .array(
      z.object({
        date: IsoDate.nullish(),
        inDays: z.number().int().nonnegative().max(3650).nullish(),
        amount: DecimalString,
        asset: z.string().nullish(),
        label: z.string().nullish(),
      }),
    )
    .nullish(),
  noExpenses: z.boolean().nullish(),
  bufferAmount: DecimalString.nullish(),
  riskProfile: RiskProfile.nullish(),
  acceptUsddRisk: z.boolean().nullish(),
});
export type NeedsPatch = z.infer<typeof NeedsPatch>;

export const ChatMessage = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(2000),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

export type MissingField = "amount" | "endDate" | "expenses" | "bufferAmount" | "riskProfile" | "acceptUsddRisk";

export interface ChatResponse {
  needs: UserNeeds;
  missing: MissingField[];
  problems: string[];
  reply: string;
  state: "collecting" | "awaiting_confirmation";
  llm: { provider: string; model?: string; used: boolean; fallbackReason?: string; latencyMs?: number };
}

// ---------------------------------------------------------------- ProductQuote

export const ProductQuote = z.object({
  id: z.string(),
  kind: z.enum(["lending", "psm", "staking"]),
  market: z.string(),
  token: z.string(),
  address: z.string(),
  chain: Chain,
  /** 기본 공급 금리 (소수, 예: 0.02 = 2%) */
  baseRate: DecimalString.optional(),
  rateType: z.enum(["APY", "APR"]).optional(),
  underlyingDecimals: z.number().int().optional(),
  /** 기초자산 달러 가격 (JustLend 앱 백엔드 priceUSD). 보상의 달러 가치를 자산 수량으로 바꿀 때 쓴다 */
  underlyingPriceUsd: DecimalString.optional(),
  /** 시장에서 즉시 인출 가능한 기초자산 수량 */
  liquidity: DecimalString.optional(),
  active: z.boolean(),
  inactiveReason: z.string().optional(),
  rewards: z.object({
    status: z.enum(["verified", "unverified", "none"]),
    /** 채굴 보상 추정 APR (소수). 일일 보상 가치 × 365 ÷ 시장 예치 총액 */
    apr: DecimalString.optional(),
    /** 보상 토큰과 최근 24시간 보상량 (예: USDD 43672) */
    token: z.string().optional(),
    dailyAmount: DecimalString.optional(),
    note: z.string(),
    source: SourceMeta.optional(),
    /** 공지로 확인한 캠페인 규칙. status가 verified면 이 기간 안의 보상만 순수익에 넣는다 */
    campaign: z
      .object({
        name: z.string(),
        start: z.string(),
        end: z.string(),
        rewardToken: z.string(),
        distribution: z.string(),
        eligibility: z.string(),
        sources: z.array(z.string()),
        checks: z.array(z.string()),
      })
      .optional(),
  }),
  /** TRX 스테이킹(Stake 2.0) + SR 투표. 투표 보상은 체인 파라미터와 SR 수수료로 계산한다 */
  staking: z
    .object({
      srAddress: z.string(),
      srName: z.string(),
      /** SR이 가져가는 몫 (0~1). 투표자 몫 = 1 − brokerage */
      brokerage: DecimalString,
      srVotes: DecimalString,
      totalVotes: DecimalString,
      unfreezeDelayDays: z.number(),
      voteRewardPerBlockTrx: DecimalString,
      blockRewardPerBlockTrx: DecimalString,
      /** SR 선택 기준: 상위 27개 중 투표자 APR 최대 */
      candidates: z.number(),
      /** 투표가 반영되기까지의 최대 지연(일) = getMaintenanceTimeInterval */
      voteDelayDays: DecimalString.optional(),
      /** 시스템 거래별 실측 대역폭(bytes). measured에 없는 유형은 측정된 스테이킹 거래 중 최대값으로 채운다 */
      txBandwidth: z
        .object({ stake: z.number(), vote: z.number(), claim: z.number(), unstake: z.number(), withdrawExpire: z.number(), measured: z.array(z.string()), sampleSize: z.number() })
        .optional(),
    })
    .optional(),
  psm: z
    .object({
      feeIn: DecimalString,
      feeOut: DecimalString,
      sellEnabled: z.boolean(),
      buyEnabled: z.boolean(),
      /** USDT → USDD 전환 가능 여유 (부채 한도 기준) */
      entryCapacity: DecimalString.optional(),
      /** USDD → USDT 전환 가능 물량 (PSM 보유 USDT) */
      exitLiquidity: DecimalString.optional(),
    })
    .optional(),
  source: SourceMeta,
});
export type ProductQuote = z.infer<typeof ProductQuote>;

export const CostBasis = z.object({
  energyFeeSun: z.number(),
  bandwidthFeeSun: z.number(),
  /** 1 USDT가 몇 TRX인지 (TRX 비용을 USDT로 환산할 근거). 없으면 순수익 산정 불가 */
  trxPerUsdt: DecimalString.optional(),
  /** 1 USDD가 몇 TRX인지 (USDD 보유자의 비용 환산). JustLend 오라클의 USDD·USDT 달러 가격 비율로 구한다 */
  trxPerUsdd: DecimalString.optional(),
  /** PSM 전환 Energy: 최근 성공 거래의 실측 최대값 */
  psmEnergy: z
    .object({ sell: z.number(), buy: z.number(), sampleSize: z.number(), bandwidth: z.object({ sell: z.number(), buy: z.number() }).optional(), median: z.object({ sell: z.number(), buy: z.number() }).optional() })
    .optional(),
  /** Mainnet jToken 예치·인출: 최근 성공 거래의 실측 최대 Energy·대역폭 (인출 = redeem·redeemUnderlying 중 큰 값) */
  jTokenCosts: z
    .record(
      z.string(),
      z.object({
        supply: z.object({ energy: z.number(), bandwidth: z.number() }),
        withdraw: z.object({ energy: z.number(), bandwidth: z.number() }),
        sampleSize: z.number(),
        median: z.object({ supply: z.object({ energy: z.number(), bandwidth: z.number() }), withdraw: z.object({ energy: z.number(), bandwidth: z.number() }) }).optional(),
      }),
    )
    .optional(),
  /** Nile jTRX 거래 Energy: 최근 성공 거래의 실측 최대값 */
  jtrxEnergy: z
    .object({
      mint: z.number(),
      redeem: z.number(),
      redeemUnderlying: z.number(),
      sampleSize: z.number(),
      bandwidth: z.object({ mint: z.number(), redeem: z.number(), redeemUnderlying: z.number() }).optional(),
      median: z.object({ mint: z.number(), redeem: z.number(), redeemUnderlying: z.number() }).optional(),
    })
    .optional(),
  /** 비용 기준: max = 실측 최대값(기본, 보수적), median = 실측 중앙값, typical = 공식 일반값(JustLend MCP) */
  costMode: z.enum(["max", "median", "typical"]).optional(),
  /**
   * Energy 조달 방식. burn = TRX 소각(getEnergyFee), stake = Energy용으로 스테이킹해 둔 TRX로 충당(소각 없음),
   * rent = JustLend Energy 대여(날짜별로 필요한 Energy를 1시간 빌림)
   */
  energyMode: z
    .object({
      mode: z.enum(["burn", "stake", "rent"]),
      burnFeeSun: z.number(),
      /** 스테이킹 1 TRX당 하루 Energy (TotalEnergyLimit ÷ TotalEnergyWeight) */
      energyStakePerTrx: z.string().optional(),
      rent: z.object({ ratePerTrxSec: z.string(), feeRatio: z.string(), minFeeTrx: z.string(), usageChargeRatio: z.string(), durationSec: z.number() }).optional(),
      source: SourceMeta.optional(),
    })
    .optional(),
  source: SourceMeta,
  priceSource: SourceMeta.optional(),
});
export type CostBasis = z.infer<typeof CostBasis>;

// ---------------------------------------------------------------- Plan

export interface PlanStep {
  action: "hold" | "approve" | "psm_sell" | "supply" | "withdraw" | "psm_buy" | "swap" | "stake" | "vote" | "claim" | "unstake";
  label: string;
  asset: string;
  amount: string;
  contract?: string;
  energy: number;
  bandwidth: number;
  energySource: string;
  /** 인출일별 분산 계획의 타임라인: 시작일로부터 며칠째 실행하는 거래인지 */
  day?: number;
}

export interface PlanCosts {
  energy: number;
  bandwidth: number;
  trx: string;
  /** 평가 자산(USDT/TRX) 기준. 환산 근거가 없으면 undefined */
  inAsset?: string;
  conversionFees: string;
}

export type Eligibility = "eligible" | "conditional" | "ineligible";

export interface Plan {
  id: string;
  key: "A" | "A2" | "B" | "C" | "L" | "HOLD" | "NILE_80" | "NILE_50";
  /** 위험 등급: 원금 고정 스테이블 / 스테이블 전환(디페깅 위험) / 가격 변동 */
  riskClass?: "stable" | "stable_conversion" | "volatile";
  title: string;
  chain: Chain;
  asset: string;
  inputVersion: number;
  horizonDays: number;
  principal: string;
  allocation: { invested: string; held: string };
  steps: PlanStep[];
  baseRate?: string;
  rateType?: "APY" | "APR";
  baseYield: string;
  rewards: { status: "verified" | "unverified" | "none"; amount?: string; note: string };
  costs: PlanCosts;
  /** 산정 불가면 undefined. 미확인 보상은 포함하지 않는다 */
  netReturn?: string;
  /** 참고용: 미확인 채굴 보상 추정치 − 보상 청구 비용을 더한 값. 추천·순위에는 쓰지 않는다 */
  netWithUnverifiedRewards?: string;
  breakEvenDays?: string;
  eligibility: Eligibility;
  reasons: string[];
  risks: string[];
  assumptions: string[];
  stress?: { label: string; netReturn: string }[];
  /** 인출일별 분산 계획(L)의 구간별 배분 */
  ladder?: LadderBucket[];
  recommended: boolean;
  quoteIds: string[];
  dataModes: DataMode[];
  label: "조건부 분석" | "Nile 실행 계획";
}

export interface LadderBucket {
  label: string;
  amount: string;
  /** 이 돈이 필요한 날 (시작일로부터 며칠째) */
  needDay: number;
  needDate: string;
  product: "HOLD" | "LEND" | "USDD" | "STAKE";
  productLabel: string;
  yield: string;
  /** 이 구간만 각 상품에 넣었을 때의 순수익 (단독 기준, 설명용) */
  alternatives: { product: string; netAlone?: string; note?: string }[];
  why: string;
}

export interface ScreeningRow {
  product: string;
  project: "JustLend" | "USDD" | "TRON";
  underlying: string;
  category: "same_asset" | "psm_route" | "stable_conversion" | "volatile" | "staking" | "paused" | "not_on_tron";
  baseApy?: string;
  underlyingApy?: string;
  miningApy?: string;
  miningStatus?: "verified" | "unverified" | "none";
  totalApy?: string;
  depositedUsd?: string;
  analyzedAs?: string;
  verdict: "analyzed" | "excluded";
  reasons: string[];
}

export interface PlanningResult {
  id: string;
  chain: Chain;
  createdAt: string;
  engineVersion: string;
  needs: UserNeeds;
  reserved: { total: string; expensesInHorizon: string; buffer: string; outsideHorizon: Expense[] };
  investable: string;
  plans: Plan[];
  recommendation: { planId: string; reason: string };
  naiveComparison?: { title: string; description: string; netReturn?: string };
  quotes: ProductQuote[];
  costBasis?: CostBasis;
  /** 기회 탐색: 검토한 모든 상품과 분석 대상 여부·제외 사유 */
  screening?: ScreeningRow[];
  warnings: string[];
  /** pending: AI 설명을 따로 만드는 중 (그동안 템플릿 설명을 보인다) */
  explanation: { text: string; source: "llm" | "template"; provider?: string; model?: string; fallbackReason?: string; pending?: boolean };
  /** 여러 자산 보유: 자산별 결과와 합산. 최상위 필드는 첫 번째(대표) 자산의 결과와 같다 */
  portfolio?: PortfolioSummary;
  /** 보유 자산과 다른 자산으로 내는 지출: 오늘 환전해 보유하는 필요량 */
  conversions?: ExpenseConversion[];
}

export interface ExpenseConversion {
  expenseId: string;
  date: string;
  need: { amount: string; asset: string };
  pay: { amount: string; asset: string };
  route: string;
  costTrx: string;
}

export interface PortfolioPart {
  asset: "USDT" | "TRX" | "USDD";
  amount: string;
  /** 이 자산만 떼어 낸 요구사항으로 계산한 결과 (지출·여유액·위험 성향·인출일별 분산 모두 적용) */
  result: Omit<PlanningResult, "portfolio">;
  /** USDT 환산 가치 (TRX는 JustLend 오라클 가격). 환산 근거가 없으면 없음 */
  valueUsdt?: string;
  recommendedNetUsdt?: string;
}

export interface PortfolioSummary {
  parts: PortfolioPart[];
  totalValueUsdt?: string;
  /** 자산별 추천 계획 순수익의 USDT 환산 합계. 하나라도 산정 불가면 없음 */
  totalNetUsdt?: string;
  /** 추천 계획을 합친 배분: 넣을 곳별 금액 */
  allocation: { asset: string; product: string; amount: string; share?: string }[];
  notes: string[];
}

// ---------------------------------------------------------------- Execution

/** Nile에서 사용자가 서명할 수 있는 거래 종류: jTRX 예치·인출과 Stake 2.0 시스템 거래 */
export const TX_KINDS = ["deposit", "withdraw", "stake", "vote", "unstake", "withdraw_unfrozen", "claim_reward", "call"] as const;
export type TxKind = (typeof TX_KINDS)[number];
export const TX_KIND_KO: Record<TxKind, string> = {
  deposit: "예치",
  withdraw: "인출",
  stake: "스테이킹",
  vote: "SR 투표",
  unstake: "스테이킹 해제",
  withdraw_unfrozen: "해제분 인출",
  claim_reward: "투표 보상 청구",
  call: "계약 거래",
};

/** Nile USDD 경로(계획 B)의 계약 호출 종류 */
export const CALL_ACTIONS = ["swap_trx_in", "approve", "bridge_in", "psm_sell", "supply_usdd", "withdraw_usdd", "psm_buy", "bridge_out", "swap_trx_out"] as const;
export type CallAction = (typeof CALL_ACTIONS)[number];
export const CALL_ACTION_KO: Record<CallAction, string> = {
  swap_trx_in: "교환 TRX → USDD(구)",
  approve: "토큰 사용 승인",
  bridge_in: "브리지 PSM USDD(구) → USDT",
  psm_sell: "PSM USDT → USDD",
  supply_usdd: "jUSDD 예치",
  withdraw_usdd: "jUSDD 인출",
  psm_buy: "PSM USDD → USDT",
  bridge_out: "브리지 PSM USDT → USDD(구)",
  swap_trx_out: "교환 USDD(구) → TRX",
};
/** 승인 목적: 어떤 토큰을 어느 계약에 승인하는지 */
export const CALL_PURPOSES = ["bridge_in", "psm_sell", "jusdd", "psm_buy", "bridge_out", "router"] as const;
export type CallPurpose = (typeof CALL_PURPOSES)[number];

/** 서버가 현재 체인 상태로 만든 계약 호출 (서명은 사용자가 TronLink로) */
export interface CallSpec {
  action: CallAction;
  contract: string;
  contractName: string;
  method: string;
  params: { type: string; value: unknown }[];
  callValueSun: string;
  amountDisplay: string;
  /** 승인 범위 설명 (정확한 금액만 승인) */
  approval: string;
  /** 비교용 주 금액 (원시 단위) */
  primaryAmount: string;
  /** 교환 최소 수령량 (원시 단위) */
  minOut?: string;
  checks: { label: string; ok: boolean; detail: string }[];
  estimatedEnergy: number;
  estimatedFeeTrx: string;
  feeLimitSun: string;
  ok: boolean;
}

export const ActionPreview = z.object({
  id: z.string(),
  planId: z.string(),
  kind: z.enum(TX_KINDS),
  /** 계약 거래(kind = call): 서버가 만든 호출 종류·인자·승인 목적 */
  callAction: z.enum(CALL_ACTIONS).optional(),
  callParams: z.array(z.object({ type: z.string(), value: z.unknown() })).optional(),
  callPurpose: z.string().optional(),
  callPrimary: z.string().optional(),
  contractName: z.string().optional(),
  /** 투표 대상 SR과 표 수 (kind = vote) */
  sr: z.string().optional(),
  votes: z.number().int().optional(),
  /** 계획 단계의 예정일(D+n). 예정일 전에 실행하면 early = true (테스트 목적, 사용자 확인 필요) */
  stepDay: z.number().int().optional(),
  /** 계획 단계 번호 (plan.steps의 인덱스). 같은 단계를 두 번 실행하지 않게 기록과 연결한다 */
  step: z.number().int().optional(),
  early: z.boolean().optional(),
  /** plan: 계획 실행, adjust: 포지션 조정 제안에서 만든 거래 */
  origin: z.enum(["plan", "adjust"]).optional(),
  /** 부분 인출(redeemUnderlying)이면 true. 전액 인출은 redeem(jToken 전량) */
  partial: z.boolean().optional(),
  wallet: z.string(),
  chain: z.literal("nile"),
  asset: z.string(),
  amountSun: z.string(),
  amountDisplay: z.string(),
  contract: z.string(),
  method: z.string(),
  approval: z.string(),
  estimatedEnergy: z.number(),
  estimatedFeeTrx: z.string(),
  feeLimitSun: z.string(),
  risks: z.array(z.string()),
  createdAt: z.string(),
  validUntil: z.string(),
  snapshot: z.object({ balanceSun: z.string(), jTokenBalance: z.string(), energyFeeSun: z.number(), contractVerified: z.boolean(), underlyingSun: z.string().optional() }),
});
export type ActionPreview = z.infer<typeof ActionPreview>;

export type TxStatus = "preview" | "awaiting_signature" | "submitted" | "pending" | "confirmed" | "failed" | "rejected" | "unknown";

export interface ExecutionRecord {
  id: string;
  planId: string;
  previewId: string;
  kind: TxKind;
  chain: "nile";
  stepDay?: number;
  step?: number;
  /** 실행 시점의 계획 금리 (jTRX 예치는 jTRX APR, 스테이킹 계열은 투표자 APR). 계획을 다시 계산해도 예상 vs 실제 비교에 쓴다 */
  plannedRate?: string;
  wallet: string;
  txId?: string;
  status: TxStatus;
  amountDisplay: string;
  /** 예치액 또는 부분 인출액 (TRX). 전액 인출은 비움 */
  amountTrx?: string;
  partial?: boolean;
  origin?: "plan" | "adjust";
  submittedAt?: string;
  confirmedAt?: string;
  blockNumber?: number;
  feeTrx?: string;
  energyUsed?: number;
  error?: string;
}

export interface Observation {
  id: string;
  planId: string;
  positionId: string;
  chain: Chain;
  wallet: string;
  observedAt: string;
  balances: { asset: string; amount: string }[];
  underlyingValue: string;
  valuationBasis: string;
  source: SourceMeta;
}

export interface TxStatusResponse {
  txId: string;
  chain: "nile";
  status: "pending" | "confirmed" | "failed" | "not_found";
  blockNumber?: number;
  feeTrx?: string;
  energyUsed?: number;
  result?: string;
  source: SourceMeta;
}
