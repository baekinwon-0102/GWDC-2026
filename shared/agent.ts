import type { Eligibility, TxStatusResponse } from "./schemas";
import type { NileAdjustment } from "./adjust";

// 에이전트 루프 공통 타입. LLM은 도구를 고르고 설명만 한다. 숫자·적격성·최종 추천은 코드가 정한다.

export type AgentContext = "mainnet" | "nile";

export type AgentToolName =
  | "list_products"
  | "simulate"
  | "find_breakeven"
  | "check_anomalies"
  | "get_tx_status"
  | "get_position"
  | "propose_adjustment"
  | "ask_user"
  | "finish";

export interface AgentStep {
  i: number;
  tool: AgentToolName | string;
  args: unknown;
  ok: boolean;
  /** 코드가 만든 한 줄 요약 (모델 문장 아님) */
  summary: string;
  durationMs: number;
  /** llm: 모델이 고른 호출, rule: 코드가 고정 순서로 실행한 호출 */
  by: "llm" | "rule";
}

export interface PlanSummary {
  key: string;
  title: string;
  eligibility: Eligibility;
  invested: string;
  ratePercent?: string;
  baseYield: string;
  roundTripFee: string;
  netReturn: string;
  breakEvenDays: string;
  reasons: string[];
  /** 계획 L의 구간별 배분 (한국어 키: 모델이 영문 키를 베껴 쓰지 않게) */
  구간별_배분?: { 구간: string; 금액: string; 필요한_날: string; 넣을_곳: string; 예상_수익: string; 이유: string }[];
}

export interface ScenarioSummary {
  amount: string;
  horizonDays: number;
  reserved: string;
  investable: string;
  recommendedKey: string;
  recommendedTitle: string;
  recommendationReason: string;
  plans: PlanSummary[];
}

export interface WhatIfResult {
  changes: string[];
  before: ScenarioSummary;
  after: ScenarioSummary;
  recommendationChanged: boolean;
}

export interface BreakEvenResult {
  planKey: "A" | "B";
  dimension: "days" | "amount";
  found: boolean;
  /** days: 일수, amount: 필요한 총 보유액 */
  value?: string;
  unit: string;
  current: string;
  netAtValue?: string;
  note: string;
}

export interface AnomalyFinding {
  severity: "high" | "warn" | "info";
  market: string;
  message: string;
}

export interface CatalogEntry {
  symbol: string;
  underlying: string;
  supplyApyPercent: string;
  liquidity: string;
  analyzedAs?: "A" | "B";
  note: string;
}

export interface PositionSnapshot {
  wallet: string;
  trx: string;
  jTrx: string;
  underlyingTrx: string;
  /** 스테이킹·투표·해제 대기·미청구 보상 (조회 실패 시 없음) */
  staking?: { frozenTrx: string; tronPower: number; votes: number; unfreezingTrx: string; withdrawableTrx: string; rewardTrx: string };
  observedAt: string;
}

export interface AgentArtifacts {
  base?: ScenarioSummary;
  whatIf?: WhatIfResult;
  breakEven?: BreakEvenResult[];
  anomalies?: AnomalyFinding[];
  catalog?: { total: number; entries: CatalogEntry[]; fetchedAt: string; mode: "live" | "synthetic" };
  tx?: TxStatusResponse[];
  position?: PositionSnapshot;
  adjustment?: NileAdjustment;
}

export interface AgentResponse {
  answer: string;
  answerSource: "llm" | "template";
  fallbackReason?: string;
  /** Mainnet: 코드가 검증한 최종 추천. 에이전트 제안과 다르면 코드 쪽을 채택하고 note로 알린다 */
  recommendation?: { planKey: string; title: string; reason: string; agentPlanKey?: string; agreesWithCode: boolean; note?: string };
  question?: string;
  stoppedBy: "finish" | "ask_user" | "max_steps" | "timeout" | "error" | "rule";
  steps: AgentStep[];
  artifacts: AgentArtifacts;
  llm: { provider: string; model?: string; used: boolean; calls: number };
  elapsedMs: number;
}

export interface ReevaluateResponse {
  checkedAt: string;
  recommendationChanged: boolean;
  previousKey: string;
  currentKey: string;
  currentTitle: string;
  changes: { label: string; before: string; after: string }[];
  anomalies: AnomalyFinding[];
  message: string;
  messageSource: "llm" | "template";
  failures: string[];
  /** 추천이 바뀌었을 때: 이미 이전 계획을 실행했다고 가정한 전환(리밸런스) 분석. 코드 계산 */
  rebalance?: {
    from: string;
    to: string;
    stayValue: string;
    switchValue: string;
    recommendSwitch: boolean;
    exitCost: string;
    steps: string[];
    note: string;
  };
}
