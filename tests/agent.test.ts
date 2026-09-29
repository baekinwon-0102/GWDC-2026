import { describe, expect, it } from "vitest";
import { demoNeeds } from "../shared/needs";
import { buildMainnetPlans, type MainnetInputs } from "../shared/planning";
import type { CostBasis, ProductQuote, UserNeeds } from "../shared/schemas";
import { parseAction, ruleCalls, runAgent } from "../server/agent/loop";
import { checkAnomalies, findBreakEven, runTool, type ToolContext } from "../server/agent/tools";
import { reevaluate } from "../server/agent/reevaluate";
import type { LlmProvider } from "../server/llm/provider";

const TODAY = "2026-09-29";
const NOW = new Date("2026-09-29T03:00:00Z");
const live = { sourceUrl: "test", chain: "mainnet" as const, fetchedAt: NOW.toISOString(), mode: "live" as const, accessMethod: "direct" as const };
const lending = (market: string, token: string, rate: string, extra: Partial<ProductQuote> = {}): ProductQuote => ({
  id: market, kind: "lending", market, token, address: "T" + market, chain: "mainnet", baseRate: rate, rateType: "APY", liquidity: "1000000", active: true,
  rewards: { status: "unverified", note: "" }, source: live, ...extra,
});
const psm: ProductQuote = {
  id: "psm", kind: "psm", market: "PSM", token: "USDD", address: "Tpsm", chain: "mainnet", active: true, rewards: { status: "none", note: "" },
  psm: { feeIn: "0", feeOut: "0", sellEnabled: true, buyEnabled: true, entryCapacity: "1000000", exitLiquidity: "1000000" }, source: live,
};
const basis: CostBasis = { energyFeeSun: 100, bandwidthFeeSun: 1000, trxPerUsdt: "3", psmEnergy: { sell: 250000, buy: 310000, sampleSize: 10 }, source: live };
const inputs = (over: Partial<MainnetInputs> = {}): MainnetInputs => ({ jusdt: lending("jUSDT", "USDT", "0.02"), jusdd: lending("jUSDD", "USDD", "0.00001"), psm, costBasis: basis, ...over });

function ctxOf(needs: UserNeeds = demoNeeds(TODAY), inp: MainnetInputs = inputs(), extra: Partial<ToolContext> = {}): ToolContext {
  return {
    context: "mainnet", needs, inputs: inp, failures: [], mode: "live", now: NOW, base: buildMainnetPlans(needs, inp, NOW),
    loadCatalog: async () => ({
      items: [
        { symbol: "jUSDT", underlying: "USDT", address: "a", supplyRate: "0.02", liquidity: "5000000" },
        { symbol: "jUSDD", underlying: "USDD", address: "b", supplyRate: "0.00001", liquidity: "100" },
        { symbol: "jSUN", underlying: "SUN", address: "c", supplyRate: "0.08", liquidity: "300" },
      ],
      fetchedAt: NOW.toISOString(),
    }),
    loadTx: async (txId) => ({ txId, chain: "nile", status: "confirmed", blockNumber: 1, feeTrx: "8.1", result: "SUCCESS", source: { ...live, chain: "nile" } }),
    loadPosition: async (wallet) => ({ wallet, trx: "20", jTrx: "3900", underlyingTrx: "80", observedAt: NOW.toISOString() }),
    ...extra,
  };
}

/** 정해진 응답을 순서대로 돌려주는 가짜 LLM */
function fakeLlm(replies: string[]): LlmProvider & { calls: number } {
  const p = {
    name: "fake",
    model: "fake-1",
    calls: 0,
    async complete() {
      const c = replies[Math.min(p.calls, replies.length - 1)];
      p.calls++;
      return { content: c, latencyMs: 1 };
    },
    async extractNeeds(): Promise<never> {
      throw new Error("unused");
    },
    async explainPlans(): Promise<never> {
      throw new Error("unused");
    },
  };
  return p;
}
const J = (o: unknown) => JSON.stringify(o);

describe("에이전트 도구", () => {
  it("조건 바꿔 보기: 지출을 45일 뒤로 옮기면 운용 가능액 800 → 1000", async () => {
    const r = await runTool("simulate", { expenseInDays: 45 }, ctxOf());
    expect(r.ok).toBe(true);
    expect(r.artifacts?.whatIf?.before.investable).toBe("800");
    expect(r.artifacts?.whatIf?.after.investable).toBe("1000");
  });
  it("사용자 동의(USDD 위험)는 도구 인자로 바꿀 수 없다", async () => {
    const r = await runTool("simulate", { acceptUsddRisk: true }, ctxOf());
    expect(r.ok).toBe(false);
  });
  it("허용 목록 밖 도구와 다른 맥락의 도구를 거부한다", async () => {
    expect((await runTool("broadcast_transaction", {}, ctxOf())).ok).toBe(false);
    expect((await runTool("get_tx_status", { txId: "a".repeat(64) }, ctxOf())).ok).toBe(false);
  });
  it("손익분기: 최소 운용 일수와 최소 보유액을 찾는다 (순수익 > 0)", () => {
    const d = findBreakEven(ctxOf(), "A", "days");
    expect(d.found).toBe(true);
    expect(Number(d.value)).toBeGreaterThan(30);
    const a = findBreakEven(ctxOf(), "A", "amount");
    expect(a.found).toBe(true);
    expect(Number(a.value)).toBeGreaterThan(1000);
    // 찾은 금액에서는 실제로 순수익이 양수
    const at = buildMainnetPlans({ ...demoNeeds(TODAY), amount: a.value! }, inputs(), NOW).plans.find((p) => p.key === "A")!;
    expect(Number(at.netReturn)).toBeGreaterThan(0);
  });
  it("손익분기: USDD 위험 미동의면 B는 탐색하지 않는다", () => {
    const r = findBreakEven(ctxOf({ ...demoNeeds(TODAY), acceptUsddRisk: false }), "B", "days");
    expect(r.found).toBe(false);
    expect(r.note).toMatch(/USDD/);
  });
  it("시세 이상 감지: 비정상 금리·유동성 부족을 찾는다", () => {
    const f = checkAnomalies(ctxOf(demoNeeds(TODAY), inputs({ jusdt: lending("jUSDT", "USDT", "0.9", { liquidity: "100" }) })));
    expect(f.some((x) => x.severity === "high" && /유동성/.test(x.message))).toBe(true);
    expect(f.some((x) => x.severity === "warn" && /비정상/.test(x.message))).toBe(true);
    expect(f[0].severity).toBe("high");
  });
  it("Nile: 사용자 기록에 없는 txID는 조회하지 않는다", async () => {
    const ctx = ctxOf(demoNeeds(TODAY), inputs(), { context: "nile", nile: { wallet: "Twallet", txIds: ["b".repeat(64)] } });
    expect((await runTool("get_tx_status", { txId: "a".repeat(64) }, ctx)).ok).toBe(false);
    expect((await runTool("get_tx_status", { txId: "b".repeat(64) }, ctx)).ok).toBe(true);
  });
});

describe("Nile 조정 도구", () => {
  it("기록과 조건이 있으면 코드 판정 결과를 돌려주고, 없으면 거부한다", async () => {
    const adj = { checkedAt: NOW.toISOString(), status: "adjust" as const, summary: "부분 인출 권고", checks: [], notes: [], figures: { walletTrx: "1", positionTrx: "2", reservedTrx: "0", exitFeeReserveTrx: "0", walletNeedTrx: "0", targetDepositTrx: "0", daysLeft: 1 } };
    const nileNeeds: UserNeeds = { ...demoNeeds(TODAY), chain: "nile", asset: "TRX" };
    const ctx = ctxOf(demoNeeds(TODAY), inputs(), { context: "nile", nile: { wallet: "Tw", txIds: [], needs: nileNeeds, planKey: "NILE_80" }, loadAdjustment: async () => adj });
    const r = await runTool("propose_adjustment", {}, ctx);
    expect(r.ok).toBe(true);
    expect(r.artifacts?.adjustment?.summary).toBe("부분 인출 권고");
    expect((await runTool("propose_adjustment", {}, { ...ctx, nile: { wallet: "Tw", txIds: [] } })).ok).toBe(false);
    expect((await runTool("propose_adjustment", {}, ctxOf())).ok).toBe(false); // Mainnet 맥락에서는 허용 목록 밖
  });
});

describe("에이전트 루프 (LLM 없음 → 규칙 순서)", () => {
  it("질문 의도에 맞는 도구를 고른다", () => {
    const c = ctxOf();
    expect(ruleCalls("지출을 45일 뒤로 미루면?", c)[0]).toEqual({ tool: "simulate", args: { expenseInDays: 45 } });
    expect(ruleCalls("며칠 이상 맡겨야 이득이야?", c).map((x) => x.args)).toContainEqual({ planKey: "A", dimension: "days" });
    expect(ruleCalls("추천해 줘", c).map((x) => x.tool)).toEqual(["list_products", "check_anomalies"]);
  });
  it("규칙 경로도 코드 추천과 템플릿 답을 돌려준다", async () => {
    const r = await runAgent("지출을 45일 뒤로 미루면?", ctxOf());
    expect(r.stoppedBy).toBe("rule");
    expect(r.answerSource).toBe("template");
    expect(r.answer).toMatch(/800 USDT에서 1000 USDT/);
    expect(r.recommendation?.planKey).toBe("HOLD");
    expect(r.steps.every((s) => s.by === "rule")).toBe(true);
  });
});

describe("에이전트 루프 (LLM)", () => {
  it("LLM이 도구를 고르고, 검증을 통과한 답을 채택한다", async () => {
    const llm = fakeLlm([
      J({ tool: "simulate", args: { expenseInDays: 45 } }),
      J({ tool: "check_anomalies", args: {} }),
      J({ tool: "finish", args: { answer: "지출일을 옮기면 운용 가능액이 800 USDT에서 1000 USDT로 늘어납니다. 그래도 왕복 비용이 이자보다 커서 보유가 낫습니다. 이 결과는 조건부 분석입니다.", planKey: "HOLD" } }),
    ]);
    const r = await runAgent("지출을 45일 뒤로 미루면?", ctxOf(), llm);
    expect(r.answerSource).toBe("llm");
    expect(r.stoppedBy).toBe("finish");
    expect(r.recommendation?.agreesWithCode).toBe(true);
    expect(r.steps.map((s) => `${s.by}:${s.tool}`)).toEqual(["rule:simulate", "llm:simulate", "llm:check_anomalies", "llm:finish"]);
    expect(r.artifacts.whatIf?.after.investable).toBe("1000");
  });
  it("시세 점검 없이 추천하면 한 번 되돌려 보낸다", async () => {
    const llm = fakeLlm([
      J({ tool: "finish", args: { answer: "보유를 권고합니다. 조건부 분석입니다.", planKey: "HOLD" } }),
      J({ tool: "check_anomalies", args: {} }),
      J({ tool: "finish", args: { answer: "시세 점검 후에도 보유를 권고합니다. 조건부 분석입니다.", planKey: "HOLD" } }),
    ]);
    const r = await runAgent("추천해 줘", ctxOf(), llm);
    expect(r.steps.map((s) => `${s.tool}:${s.ok}`)).toEqual(["simulate:true", "finish:false", "check_anomalies:true", "finish:true"]);
    expect(r.answerSource).toBe("llm");
  });
  it("부적격 계획 추천은 채택하지 않고 코드 결과를 쓴다", async () => {
    const llm = fakeLlm([J({ tool: "finish", args: { answer: "계획 B를 추천합니다. 조건부 분석입니다.", planKey: "B" } })]);
    const r = await runAgent("추천해 줘", ctxOf({ ...demoNeeds(TODAY), acceptUsddRisk: false }), llm);
    expect(r.recommendation?.planKey).toBe("HOLD");
    expect(r.recommendation?.agreesWithCode).toBe(false);
    expect(r.recommendation?.note).toMatch(/실행 조건/);
    expect(r.answerSource).toBe("template");
  });
  it("도구 결과에 없는 숫자를 쓴 답은 폐기한다", async () => {
    const llm = fakeLlm([J({ tool: "finish", args: { answer: "예상 순수익은 12.34 USDT입니다. 조건부 분석입니다." } })]);
    const r = await runAgent("추천해 줘", ctxOf(), llm);
    expect(r.answerSource).toBe("template");
    expect(r.fallbackReason).toMatch(/12.34/);
  });
  it("허용되지 않은 도구 호출은 거부 기록만 남기고 계속한다", async () => {
    const llm = fakeLlm([J({ tool: "broadcast_transaction", args: {} }), J({ tool: "finish", args: { answer: "현재 조건에서는 보유가 권고됩니다. 조건부 분석입니다." } })]);
    const r = await runAgent("추천해 줘", ctxOf(), llm);
    expect(r.steps.find((s) => s.tool === "broadcast_transaction")?.ok).toBe(false);
    expect(r.answerSource).toBe("llm");
  });
  it("같은 호출을 반복하면 중단하고 템플릿으로 대체한다", async () => {
    const llm = fakeLlm([J({ tool: "check_anomalies", args: {} })]);
    const r = await runAgent("시세 괜찮아?", ctxOf(), llm);
    expect(r.stoppedBy).toBe("error");
    expect(r.answerSource).toBe("template");
    expect(r.steps.filter((s) => s.tool === "check_anomalies").length).toBe(3);
  });
  it("최대 단계에 도달하면 멈춘다", async () => {
    const llm = fakeLlm([
      J({ tool: "find_breakeven", args: { planKey: "A", dimension: "days" } }),
      J({ tool: "find_breakeven", args: { planKey: "A", dimension: "amount" } }),
      J({ tool: "list_products", args: {} }),
      J({ tool: "check_anomalies", args: {} }),
    ]);
    const r = await runAgent("분석해 줘", ctxOf(), llm, { maxSteps: 3, budgetMs: 60_000 });
    expect(r.stoppedBy).toBe("max_steps");
    expect(llm.calls).toBe(3);
  });
  it("형식 오류는 한 번 보정 요청하고, 계속 틀리면 규칙 경로로 대체한다", async () => {
    const llm = fakeLlm(["음… 생각해 볼게요"]);
    const r = await runAgent("추천해 줘", ctxOf(), llm);
    expect(llm.calls).toBe(2);
    expect(r.stoppedBy).toBe("error");
    expect(r.steps.some((s) => s.tool === "list_products" && s.by === "rule")).toBe(true);
  });
  it("형식을 두 번 어기고 평문으로 답하면 그 평문을 게이트로 검증해 채택한다", async () => {
    const llm = fakeLlm(["지출 재원을 먼저 떼어 두고 남은 돈의 기간에 맞춰 나눠 넣었습니다. 조건부 분석입니다."]);
    const r = await runAgent("왜 이렇게 나눠서 넣었어?", ctxOf(), llm);
    expect(r.stoppedBy).toBe("finish");
    expect(r.answerSource).toBe("llm");
    expect(r.steps.at(-1)?.summary).toMatch(/평문/);
  });
  it("평문 답에 도구 결과에 없는 숫자가 있으면 폐기한다", async () => {
    const llm = fakeLlm(["예상 순수익은 777.77 USDT입니다. 조건부 분석입니다."]);
    const r = await runAgent("왜 이렇게 나눠서 넣었어?", ctxOf(), llm);
    expect(r.answerSource).toBe("template");
  });
  it("ask_user로 멈추고 질문을 돌려준다", async () => {
    const llm = fakeLlm([J({ tool: "ask_user", args: { question: "USDD 가격 위험을 감수하실 건가요?" } })]);
    const r = await runAgent("B도 가능해?", ctxOf(), llm);
    expect(r.stoppedBy).toBe("ask_user");
    expect(r.question).toMatch(/USDD/);
  });
});

describe("행동 파싱", () => {
  it("코드 블록·action 키·바깥 인자를 받아 준다", () => {
    expect(parseAction('```json\n{"tool":"simulate","args":{"durationDays":60}}\n```')).toEqual({ ok: true, tool: "simulate", args: { durationDays: 60 } });
    expect(parseAction('{"action":"finish","answer":"끝"}')).toEqual({ ok: true, tool: "finish", args: { answer: "끝" } });
    expect(parseAction("도구 없음").ok).toBe(false);
    expect(parseAction('{"answer":"보유를 권고합니다."}')).toEqual({ ok: true, tool: "finish", args: { answer: "보유를 권고합니다." } });
  });
});

describe("재평가", () => {
  it("금리가 올라 추천이 보유 → A로 바뀌면 알린다", async () => {
    const needs = demoNeeds(TODAY);
    const prev = buildMainnetPlans(needs, inputs(), NOW);
    const r = await reevaluate(
      needs,
      { createdAt: prev.createdAt, recommendedKey: "HOLD", plans: prev.plans.map((p) => ({ key: p.key, netReturn: p.netReturn })), quotes: prev.quotes.map((q) => ({ market: q.market, baseRate: q.baseRate })) },
      inputs({ jusdt: lending("jUSDT", "USDT", "0.2") }),
      [],
      undefined,
      NOW,
    );
    expect(r.recommendationChanged).toBe(true);
    expect(r.currentKey).toBe("A");
    expect(r.changes.some((c) => c.label.includes("jUSDT"))).toBe(true);
    expect(r.anomalies.some((a) => /크게 바뀌었/.test(a.message))).toBe(true);
  });
});
