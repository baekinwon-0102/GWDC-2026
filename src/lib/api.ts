import type { CallAction, CallSpec, ChatMessage, ChatResponse, MissingField, Observation, PlanningResult, TxKind, TxStatusResponse, UserNeeds } from "../../shared/schemas";
import type { AgentContext, AgentResponse, ReevaluateResponse } from "../../shared/agent";
import type { NileAdjustment } from "../../shared/adjust";
import type { ReplayResult } from "../../shared/replay";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error((j as any).error ?? `HTTP ${r.status}`) as Error & { detail?: unknown };
    err.detail = j;
    throw err;
  }
  return j as T;
}

export interface Health {
  ok: boolean;
  time: string;
  config: {
    llmProvider: string;
    llmModel?: string;
    llmConfigured: boolean;
    trongridKeyConfigured: boolean;
    dataMode: "live" | "synthetic";
    enableNileExecution: boolean;
    mcp: Record<string, boolean>;
  };
  mcp: { server: string; state: string; transport?: string; version?: string; tools?: { allowed: string[]; missing: string[]; blocked: string[] }; error?: string; note?: string }[];
}

export interface ObserveResponse {
  observation: Observation;
  snapshot: {
    balanceSun: string;
    jTokenBalance: string;
    energyFeeSun: number;
    bandwidthFeeSun: number;
    contractVerified: boolean;
    contractName?: string;
    contract: string;
    underlyingSun: string;
    marketCashSun: string;
    jtrxEnergy?: { mint: number; redeem: number; redeemUnderlying: number; sampleSize: number };
    /** 스테이킹·투표·해제 대기·미청구 보상 (조회 실패 시 없음) */
    staking?: {
      frozenSun: string;
      tronPower: number;
      votes: { sr: string; count: number }[];
      unfreezing: { amountSun: string; expireAt: string }[];
      withdrawableSun: string;
      rewardSun: string;
    };
  };
  executionEnabled: boolean;
}

export const api = {
  health: () => req<Health>("/api/health"),
  chat: (messages: ChatMessage[], needs: UserNeeds, lastAsked?: MissingField) =>
    req<ChatResponse>("/api/chat", { method: "POST", body: JSON.stringify({ messages, needs, lastAsked }) }),
  plans: (needs: UserNeeds, walletAddress?: string) => req<PlanningResult>("/api/plans", { method: "POST", body: JSON.stringify({ needs, walletAddress }) }),
  market: () => req<any>("/api/market"),
  observe: (wallet: string, planId?: string) =>
    req<ObserveResponse>("/api/observe", { method: "POST", body: JSON.stringify({ chain: "nile", wallet, planId, positionId: "jTRX" }) }),
  tx: (txId: string) => req<TxStatusResponse>(`/api/transactions/${txId}?chain=nile`),
  adjust: (wallet: string, needs: UserNeeds, planKey?: string, plannedRate?: string, mode?: "monitor" | "rebalance") =>
    req<{ adjustment: NileAdjustment; failures: string[] }>("/api/nile/adjust", { method: "POST", body: JSON.stringify({ wallet, needs, planKey, plannedRate, mode }) }),
  nileCall: (wallet: string, action: CallAction, opts: { amountTrx?: string; purpose?: string } = {}) =>
    req<CallSpec>("/api/nile/call", { method: "POST", body: JSON.stringify({ wallet, action, ...opts }) }),
  replay: (needs: UserNeeds, planKey: "A" | "A2" | "B") => req<ReplayResult>("/api/replay", { method: "POST", body: JSON.stringify({ needs, planKey }) }),
  agent: (body: {
    question: string;
    context: AgentContext;
    needs?: UserNeeds;
    nile?: { wallet?: string; txIds: string[]; records?: { txId: string; kind: TxKind; amount: string }[]; needs?: UserNeeds; planKey?: string };
    previousRates?: { market: string; baseRate?: string }[];
  }) =>
    req<AgentResponse>("/api/agent/run", { method: "POST", body: JSON.stringify(body) }),
  reevaluate: (needs: UserNeeds, previous: PlanningResult) =>
    req<ReevaluateResponse>("/api/agent/reevaluate", {
      method: "POST",
      body: JSON.stringify({
        needs,
        previous: {
          createdAt: previous.createdAt,
          recommendedKey: previous.plans.find((p) => p.id === previous.recommendation.planId)?.key ?? "HOLD",
          plans: previous.plans.map((p) => ({ key: p.key, netReturn: p.netReturn })),
          quotes: previous.quotes.map((q) => ({ market: q.market, baseRate: q.baseRate })),
        },
      }),
    }),
};
