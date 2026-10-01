import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { env, publicConfig, redact } from "./env";
import { createNim } from "./llm/nim";
import { createBai } from "./llm/bai";
import { compactForExplain, explanationIssues, LlmError, unknownNumbers, type LlmProvider } from "./llm/provider";
import { templateExplain, templateExtract } from "./llm/template";
import { cachedJtrxEnergy, getMainnetInputs, getNileInputs, refreshMainnetInputs, refreshNileInputs } from "./data/quotes";
import { measureStakingTxBandwidth, stakingPosition } from "./data/staking";
import { computeNileAdjustment } from "../shared/adjust";
import { replayPlan } from "../shared/replay";
import { fetchMarketUniverse } from "./data/discovery";
import { chainFees, contractExists, isBase58Address, nileTxStatus, readUint, trxBalanceSun } from "./data/tron-rpc";
import { fetchJustLendCatalog, JUSTLEND, nileJtrxPosition } from "./data/justlend";
import { runAgent } from "./agent/loop";
import { buildNileCall } from "./data/nile-calls";
import { withCostOptions } from "./data/energy";
import { PreviousAnalysis, reevaluate } from "./agent/reevaluate";
import type { ToolContext } from "./agent/tools";
import { connectAll, mcpStatuses } from "./mcp/clients";
import { applyPatch, emptyNeeds, inputProblems, missingFields, nextQuestion, summarizeNeeds, todaySeoul } from "../shared/needs";
import { buildMainnetPlans, buildNilePlans } from "../shared/planning";
import { buildPortfolioPlans } from "../shared/portfolio";
import { sunToTrx } from "../shared/units";
import { CALL_ACTIONS, CALL_PURPOSES, ChatMessage, TX_KINDS, UserNeeds, type ChatResponse, type MissingField, type Observation, type PlanningResult } from "../shared/schemas";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));

// 허용한 개발 앱 출처만 받는다. (Vite 프록시 경유 요청은 Origin이 없거나 같은 출처)
const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:5173`, `http://localhost:5173`, `http://127.0.0.1:${env.apiPort}`, `http://localhost:${env.apiPort}`]);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) return res.status(403).json({ error: "허용되지 않은 출처입니다" });
  next();
});

function provider(): LlmProvider | undefined {
  if (env.llmProvider === "bai" && env.baiApiKey) return createBai();
  if (env.llmProvider === "nim" && env.nimApiKey) return createNim();
  return undefined;
}

const fallbackReason = (e: unknown) => (e instanceof LlmError ? `${e.kind}: ${e.message}` : redact(String((e as Error)?.message ?? e)));

// ------------------------------------------------------------------ health
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString(), config: publicConfig(), mcp: mcpStatuses() });
});

// ------------------------------------------------------------------ chat
const ChatBody = z.object({
  messages: z.array(ChatMessage).min(1).max(40),
  needs: UserNeeds,
  lastAsked: z.enum(["amount", "endDate", "expenses", "bufferAmount", "riskProfile", "acceptUsddRisk"]).optional(),
});

app.post("/api/chat", async (req, res) => {
  const body = ChatBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "요청 형식이 올바르지 않습니다" });
  const { messages, needs, lastAsked } = body.data;
  const last = messages[messages.length - 1];
  if (last.role !== "user") return res.status(400).json({ error: "마지막 메시지는 사용자 입력이어야 합니다" });
  const today = todaySeoul();

  const p = provider();
  let patch;
  const llm: ChatResponse["llm"] = { provider: p?.name ?? "template", model: p?.model, used: false };
  if (p) {
    try {
      const r = await p.extractNeeds(messages, needs, today);
      patch = r.patch;
      llm.used = true;
      llm.latencyMs = r.latencyMs;
    } catch (e) {
      llm.fallbackReason = fallbackReason(e);
      console.warn("[chat] LLM 추출 실패 → 템플릿:", llm.fallbackReason);
    }
  } else {
    llm.fallbackReason = env.llmProvider === "template" ? "LLM_PROVIDER=template" : "LLM 키 미설정";
  }
  if (!patch) patch = templateExtract(last.content, lastAsked, today, needs);

  const { needs: next, changed } = applyPatch(needs, patch);
  const missing = missingFields(next);
  const problems = inputProblems(next);

  const parts: string[] = [];
  if (changed.length) parts.push("이렇게 이해했어요.\n" + summarizeNeeds(next).map((l) => `• ${l}`).join("\n"));
  else parts.push("새로 반영할 정보를 찾지 못했어요.");
  if (problems.length) parts.push(problems.map((x) => `⚠ ${x}`).join("\n"));
  const q = nextQuestion(missing);
  if (q) parts.push(q);
  else if (!problems.length) parts.push("필요한 정보가 모두 모였어요. 아래 요약을 확인하고 '이대로 확인'을 눌러 주세요. 확인 전에는 계획을 확정하지 않습니다.");

  const out: ChatResponse = {
    needs: next,
    missing,
    problems,
    reply: parts.join("\n\n"),
    state: missing.length || problems.length ? "collecting" : "awaiting_confirmation",
    llm,
  };
  res.json(out);
});

// ------------------------------------------------------------------ plans
const PlansBody = z.object({ needs: UserNeeds, walletAddress: z.string().optional() });

app.post("/api/plans", async (req, res) => {
  const body = PlansBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "요구사항 형식이 올바르지 않습니다" });
  const { needs, walletAddress } = body.data;
  const missing: MissingField[] = missingFields(needs);
  const problems = inputProblems(needs);
  if (missing.length || problems.length) return res.status(422).json({ error: "확인되지 않은 입력이 있습니다", missing, problems });

  let base: Omit<PlanningResult, "explanation">;
  if (needs.chain === "mainnet") {
    const f = await getMainnetInputs();
    // 비용 가정(비용 기준·Energy 조달 방식)을 입력에 적용한다
    const c = await withCostOptions("mainnet", needs, f.inputs);
    // 여러 자산이면 자산마다 같은 계획 엔진을 돌린다 (한 자산이면 buildMainnetPlans와 같다)
    base = buildPortfolioPlans(needs, c.inputs);
    base.warnings.unshift(...f.failures, ...c.warnings);
  } else {
    const f = await getNileInputs();
    let walletBalanceTrx: string | undefined;
    if (walletAddress) {
      if (!isBase58Address(walletAddress)) return res.status(400).json({ error: "지갑 주소 형식이 올바르지 않습니다" });
      try {
        walletBalanceTrx = sunToTrx(await trxBalanceSun("nile", walletAddress));
      } catch (e) {
        f.failures.push(`Nile 지갑 잔고 조회 실패: ${(e as Error).message}`);
      }
    }
    const c = await withCostOptions("nile", needs, f.inputs);
    base = buildNilePlans(needs, { ...c.inputs, walletBalanceTrx });
    base.warnings.unshift(...f.failures, ...c.warnings);
  }

  // 계획은 바로 돌려주고(템플릿 설명), AI 설명은 /api/explain에서 따로 만든다 (계산 0.02초 vs AI 설명 수 초).
  // Nile 탭은 설명을 화면에 쓰지 않으므로 AI 설명을 만들지 않는다.
  const wantsAi = needs.chain === "mainnet" && Boolean(provider());
  if (wantsAi) {
    explainCache.set(base.id, { at: Date.now(), base });
    for (const [k, v] of explainCache) if (Date.now() - v.at > 10 * 60_000) explainCache.delete(k);
  }
  res.json(withTemplateExplanation(base, wantsAi) satisfies PlanningResult);
});

/** 서버가 계산한 결과만 설명한다 (브라우저가 보낸 계획은 쓰지 않음): 계산 결과를 id로 잠시 보관 */
const explainCache = new Map<string, { at: number; base: Omit<PlanningResult, "explanation"> }>();

function withTemplateExplanation(base: Omit<PlanningResult, "explanation">, pending: boolean): PlanningResult {
  const reason = pending ? "AI 설명을 만드는 중입니다" : provider() ? "Nile 탭은 AI 설명을 쓰지 않음" : "LLM 키 미설정";
  if (base.portfolio) {
    for (const pt of base.portfolio.parts) pt.result.explanation = { text: templateExplain(pt.result), source: "template", fallbackReason: reason, pending };
    const text = base.portfolio.parts.map((pt) => `[${pt.asset} ${pt.amount}] ${pt.result.explanation.text}`).join("\n\n");
    return { ...base, explanation: { text, source: "template", fallbackReason: reason, pending } };
  }
  return { ...base, explanation: { text: templateExplain(base), source: "template", fallbackReason: reason, pending } };
}

app.post("/api/explain", async (req, res) => {
  const id = z.object({ id: z.string().max(80) }).safeParse(req.body);
  if (!id.success) return res.status(400).json({ error: "요청 형식이 올바르지 않습니다" });
  const hit = explainCache.get(id.data.id);
  if (!hit) return res.status(404).json({ error: "설명할 계산 결과가 없습니다 (10분이 지났거나 서버가 재시작됨)" });
  const base = hit.base;
  if (base.portfolio) {
    // 자산별 설명을 각각 만들고(숫자 검증 포함), 대표 설명은 자산별 설명을 이어 붙인다
    const parts = base.portfolio.parts;
    const explained = await Promise.all(parts.map((pt) => explainBase(pt.result)));
    const text = parts.map((pt, i) => `[${pt.asset} ${pt.amount}] ${explained[i].text}`).join("\n\n");
    const allLlm = explained.every((e) => e.source === "llm");
    const explanation: PlanningResult["explanation"] = allLlm
      ? { text, source: "llm", provider: explained[0].provider, model: explained[0].model }
      : { text, source: "template", fallbackReason: explained.find((e) => e.fallbackReason)?.fallbackReason };
    return res.json({ explanation, parts: explained });
  }
  res.json({ explanation: await explainBase(base) });
});

/** LLM 설명 → 숫자·형식 검증 → 실패하면 템플릿 */
async function explainBase(base: Omit<PlanningResult, "explanation" | "portfolio">): Promise<PlanningResult["explanation"]> {
  const p = provider();
  if (!p) return { text: templateExplain(base), source: "template", fallbackReason: "LLM 키 미설정" };
  try {
    const r = await p.explainPlans(base);
    const bad = unknownNumbers(r.text, compactForExplain(base));
    const issues = explanationIssues(r.text);
    return bad.length
      ? { text: templateExplain(base), source: "template", fallbackReason: `AI 설명에 계산 결과에 없는 숫자(${bad.slice(0, 3).join(", ")})가 있어 폐기했습니다` }
      : issues.length
        ? { text: templateExplain(base), source: "template", fallbackReason: `AI 설명 형식 문제(${issues.join(", ")})로 폐기했습니다` }
        : { text: r.text, source: "llm", provider: p.name, model: p.model };
  } catch (e) {
    return { text: templateExplain(base), source: "template", fallbackReason: fallbackReason(e) };
  }
}

// ------------------------------------------------------------------ market (시장 데이터 탭)
app.get("/api/market", async (_req, res) => {
  const [m, n] = await Promise.all([getMainnetInputs(), getNileInputs()]);
  res.json({ mainnet: m, nile: n });
});

// ------------------------------------------------------------------ observe
const ObserveBody = z.object({ chain: z.literal("nile"), wallet: z.string(), planId: z.string().optional(), positionId: z.literal("jTRX") });

app.post("/api/observe", async (req, res) => {
  const body = ObserveBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "요청 형식이 올바르지 않습니다 (Nile jTRX 포지션만 지원)" });
  const { wallet, planId } = body.data;
  if (!isBase58Address(wallet)) return res.status(400).json({ error: "지갑 주소 형식이 올바르지 않습니다" });
  try {
    const [balanceSun, pos, fees, code, cashSun, jtrxEnergy] = await Promise.all([
      trxBalanceSun("nile", wallet),
      nileJtrxPosition(wallet),
      chainFees("nile"),
      contractExists("nile", JUSTLEND.nile.jTRX),
      readUint("nile", JUSTLEND.nile.jTRX, "getCash()"),
      cachedJtrxEnergy().catch(() => undefined),
    ]);
    // 스테이킹 상태는 실패해도 jTRX 관측에는 지장이 없다
    const staking = await stakingPosition("nile", wallet).catch(() => undefined);
    const observedAt = new Date().toISOString();
    const observation: Observation = {
      id: `obs-${Date.now()}`,
      planId: planId ?? "",
      positionId: `nile:jTRX:${wallet}`,
      chain: "nile",
      wallet,
      observedAt,
      balances: [
        { asset: "TRX", amount: sunToTrx(balanceSun) },
        { asset: "jTRX", amount: pos.jToken },
        ...(staking ? [{ asset: "스테이킹 TRX", amount: sunToTrx(staking.frozenSun) }, { asset: "미청구 투표 보상 TRX", amount: sunToTrx(staking.rewardSun) }] : []),
      ],
      underlyingValue: pos.underlyingTrx,
      valuationBasis: "jTRX 잔고 × exchangeRateStored (기초자산 TRX)",
      source: { sourceUrl: `https://nile.tronscan.org/#/address/${wallet}`, chain: "nile", fetchedAt: observedAt, mode: "live", accessMethod: "direct" },
    };
    res.json({
      observation,
      snapshot: {
        balanceSun: balanceSun.toString(),
        jTokenBalance: pos.jTokenRaw.toString(),
        energyFeeSun: fees.energyFeeSun,
        bandwidthFeeSun: fees.bandwidthFeeSun,
        contractVerified: code.exists && code.name === "JustLend-TRX",
        contractName: code.name,
        contract: JUSTLEND.nile.jTRX,
        underlyingSun: pos.underlyingSun.toString(),
        marketCashSun: cashSun.toString(),
        jtrxEnergy,
        staking,
      },
      executionEnabled: env.enableNileExecution,
    });
  } catch (e) {
    res.status(502).json({ error: `Nile 조회 실패: ${redact((e as Error).message)}` });
  }
});

// ------------------------------------------------------------------ Nile 포지션 조정 (모니터링)
const AdjustBody = z.object({
  wallet: z.string(),
  needs: UserNeeds,
  planKey: z.string().max(20).optional(),
  plannedRate: z.string().max(60).optional(),
  mode: z.enum(["monitor", "rebalance"]).optional(),
});

/** 서버가 지갑·포지션·시세·수수료를 직접 다시 읽어 조정안을 계산한다 (브라우저 값은 조건 입력으로만 쓴다) */
async function nileAdjustmentFor(wallet: string, needs: UserNeeds, planKey?: string, plannedRate?: string, mode?: "monitor" | "rebalance") {
  const [balanceSun, pos, f] = await Promise.all([trxBalanceSun("nile", wallet), nileJtrxPosition(wallet), getNileInputs()]);
  return {
    adjustment: computeNileAdjustment({
      needs,
      planKey,
      plannedRate,
      mode,
      position: { walletSun: balanceSun.toString(), jTokenRaw: pos.jTokenRaw.toString(), underlyingSun: pos.underlyingSun.toString() },
      quote: f.inputs.jtrx,
      costBasis: f.inputs.costBasis,
    }),
    failures: f.failures,
  };
}

app.post("/api/nile/adjust", async (req, res) => {
  const body = AdjustBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "요청 형식이 올바르지 않습니다" });
  const { wallet, needs, planKey, plannedRate, mode } = body.data;
  if (!isBase58Address(wallet)) return res.status(400).json({ error: "지갑 주소 형식이 올바르지 않습니다" });
  if (needs.chain !== "nile") return res.status(400).json({ error: "Nile 요구사항이 필요합니다" });
  try {
    res.json(await nileAdjustmentFor(wallet, needs, planKey, plannedRate, mode));
  } catch (e) {
    res.status(502).json({ error: `조정 판정 실패: ${redact((e as Error).message)}` });
  }
});

// ------------------------------------------------------------------ Nile 계약 거래 (USDD 경로) 호출 만들기 (서명은 브라우저 TronLink)
const CallBody = z.object({
  wallet: z.string(),
  action: z.enum(CALL_ACTIONS),
  amountTrx: z.string().regex(/^\d+(\.\d+)?$/).optional(),
  purpose: z.enum(CALL_PURPOSES).optional(),
});
app.post("/api/nile/call", async (req, res) => {
  const body = CallBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "요청 형식이 올바르지 않습니다" });
  const { wallet, action, amountTrx, purpose } = body.data;
  if (!isBase58Address(wallet)) return res.status(400).json({ error: "지갑 주소 형식이 올바르지 않습니다" });
  if (action === "approve" && !purpose) return res.status(400).json({ error: "승인 목적이 필요합니다" });
  try {
    res.json(await buildNileCall(wallet, action, { amountTrx, purpose }));
  } catch (e) {
    res.status(502).json({ error: `거래 준비 실패: ${redact((e as Error).message)}` });
  }
});

// ------------------------------------------------------------------ agent (P1: 도구 선택형 조사 에이전트)
const AgentBody = z.object({
  question: z.string().trim().min(1).max(500),
  context: z.enum(["mainnet", "nile"]),
  needs: UserNeeds.optional(),
  nile: z
    .object({
      wallet: z.string().optional(),
      txIds: z.array(z.string().regex(/^[0-9a-f]{64}$/i)).max(50),
      records: z.array(z.object({ txId: z.string(), kind: z.enum(TX_KINDS), amount: z.string().max(100) })).max(50).optional(),
      needs: UserNeeds.optional(),
      planKey: z.string().max(20).optional(),
    })
    .optional(),
  previousRates: z.array(z.object({ market: z.string(), baseRate: z.string().optional() })).max(10).optional(),
});

async function loadPosition(wallet: string) {
  const [balanceSun, pos, st] = await Promise.all([trxBalanceSun("nile", wallet), nileJtrxPosition(wallet), stakingPosition("nile", wallet).catch(() => undefined)]);
  return {
    wallet,
    trx: sunToTrx(balanceSun),
    jTrx: pos.jToken,
    underlyingTrx: pos.underlyingTrx,
    staking: st && {
      frozenTrx: sunToTrx(st.frozenSun),
      tronPower: st.tronPower,
      votes: st.votes.reduce((a, v) => a + v.count, 0),
      unfreezingTrx: sunToTrx(st.unfreezing.reduce((a, u) => a + BigInt(u.amountSun), 0n)),
      withdrawableTrx: sunToTrx(st.withdrawableSun),
      rewardTrx: sunToTrx(st.rewardSun),
    },
    observedAt: new Date().toISOString(),
  };
}

app.post("/api/agent/run", async (req, res) => {
  const body = AgentBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "요청 형식이 올바르지 않습니다" });
  const { question, context, needs, nile, previousRates } = body.data;
  const now = new Date();
  let ctx: ToolContext;
  if (context === "mainnet") {
    if (!needs || needs.chain !== "mainnet") return res.status(400).json({ error: "Mainnet 요구사항이 필요합니다" });
    const missing = missingFields(needs);
    const problems = inputProblems(needs);
    if (missing.length || problems.length) return res.status(422).json({ error: "확인되지 않은 입력이 있습니다", missing, problems });
    const f0 = await getMainnetInputs();
    const c = await withCostOptions("mainnet", needs, f0.inputs);
    const f = { ...f0, inputs: c.inputs };
    ctx = {
      context, needs, inputs: f.inputs, failures: f.failures, mode: f.mode, now, previousRates,
      base: buildMainnetPlans(needs, f.inputs, now),
      loadCatalog: fetchJustLendCatalog, loadTx: nileTxStatus, loadPosition,
    };
  } else {
    if (nile?.wallet && !isBase58Address(nile.wallet)) return res.status(400).json({ error: "지갑 주소 형식이 올바르지 않습니다" });
    ctx = {
      context, needs: needs ?? emptyNeeds("nile"), inputs: {}, failures: [], mode: "live", now,
      nile: { wallet: nile?.wallet, txIds: nile?.txIds ?? [], records: nile?.records, needs: nile?.needs?.chain === "nile" ? nile.needs : undefined, planKey: nile?.planKey },
      loadCatalog: fetchJustLendCatalog, loadTx: nileTxStatus, loadPosition,
      loadAdjustment: async (w, n, k) => (await nileAdjustmentFor(w, n, k)).adjustment,
    };
  }
  const out = await runAgent(question, ctx, provider());
  console.log(`[agent] ${context} steps=${out.steps.length} llmCalls=${out.llm.calls} stop=${out.stoppedBy} src=${out.answerSource} ${out.elapsedMs}ms${out.fallbackReason ? ` (${out.fallbackReason})` : ""}`);
  res.json(out);
});

const ReevaluateBody = z.object({ needs: UserNeeds, previous: PreviousAnalysis });

app.post("/api/agent/reevaluate", async (req, res) => {
  const body = ReevaluateBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "요청 형식이 올바르지 않습니다" });
  const { needs, previous } = body.data;
  if (missingFields(needs).length || inputProblems(needs).length) return res.status(422).json({ error: "확인되지 않은 입력이 있습니다" });
  const f = await getMainnetInputs(true);
  const c = await withCostOptions("mainnet", needs, f.inputs);
  res.json(await reevaluate(needs, previous, c.inputs, f.failures, provider()));
});

// ------------------------------------------------------------------ 과거 재생 (P1 Tracking & Review, 시뮬레이션)
const ReplayBody = z.object({ needs: UserNeeds, planKey: z.enum(["A", "A2", "B"]) });

app.post("/api/replay", async (req, res) => {
  const body = ReplayBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "요청 형식이 올바르지 않습니다 (A·A-2·B만 재생)" });
  const { needs, planKey } = body.data;
  if (missingFields(needs).length || inputProblems(needs).length) return res.status(422).json({ error: "확인되지 않은 입력이 있습니다" });
  try {
    const f = await getMainnetInputs();
    const markets = f.inputs.markets ?? (await fetchMarketUniverse());
    // 서버가 자기 시세로 계획을 다시 계산한다 (브라우저가 보낸 계획은 쓰지 않음)
    const plan = buildMainnetPlans(needs, (await withCostOptions("mainnet", needs, f.inputs)).inputs).plans.find((p) => p.key === planKey)!;
    res.json(replayPlan(plan, markets));
  } catch (e) {
    res.status(502).json({ error: `과거 재생 실패: ${redact((e as Error).message)}` });
  }
});

// ------------------------------------------------------------------ transactions
app.get("/api/transactions/:txId", async (req, res) => {
  const txId = String(req.params.txId);
  if (req.query.chain !== "nile") return res.status(400).json({ error: "chain=nile만 지원합니다" });
  if (!/^[0-9a-f]{64}$/i.test(txId)) return res.status(400).json({ error: "txID 형식이 올바르지 않습니다" });
  try {
    res.json(await nileTxStatus(txId));
  } catch (e) {
    res.status(502).json({ error: `영수증 조회 실패: ${redact((e as Error).message)}` });
  }
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[api]", redact(String((err as Error)?.stack ?? err)));
  res.status(500).json({ error: "서버 오류" });
});

app.listen(env.apiPort, "127.0.0.1", () => {
  const c = publicConfig();
  console.log(`[api] http://127.0.0.1:${env.apiPort}  LLM=${c.llmProvider}${c.llmModel ? `:${c.llmModel}` : ""}(${c.llmConfigured ? "키 있음" : "키 없음 → 템플릿"}) DATA_MODE=${c.dataMode} NILE_EXEC=${c.enableNileExecution}`);
  connectAll().then((s) => console.log("[mcp]", s.map((x) => `${x.server}:${x.state}`).join(" ")));
  // 첫 사용자 요청이 느리지 않도록 시세·실측 비용을 미리 받아 둔다 (TronGrid 요청 제한 때문에 콜드 스타트가 수십 초 걸릴 수 있다)
  // 가장 무거운 블록 조회(스테이킹 거래 대역폭 실측)를 먼저 한가할 때 끝내고, 그다음 시세를 받아 첫 캐시에 실측값이 들어가게 한다.
  if (env.dataMode === "live") {
    measureStakingTxBandwidth()
      .then(() => console.log("[warmup] 스테이킹 거래 대역폭 실측 완료"))
      .catch((e) => console.log("[warmup] 스테이킹 대역폭 실측 실패 → 추정값 사용 (백그라운드 재시도):", e.message))
      .finally(() => {
        getMainnetInputs(true)
          .then((f) => console.log(`[warmup] Mainnet 시세 준비${f.failures.length ? ` (실패 ${f.failures.length}건)` : ""}`))
          .catch(() => undefined)
          .finally(() => refreshNileInputs().then((f) => console.log(`[warmup] Nile 시세 준비${f.failures.length ? ` (실패 ${f.failures.length}건)` : ""}`)).catch(() => undefined));
        cachedJtrxEnergy().catch(() => undefined);
        // 백그라운드 갱신: 사용자가 누를 때 기다리지 않도록 약 50초마다 미리 조회해 둔다 (Mainnet·Nile을 번갈아, 요청 제한을 넘지 않게)
        let tick = 0;
        setInterval(() => {
          const job = tick++ % 2 === 0 ? refreshMainnetInputs() : refreshNileInputs();
          job.catch(() => undefined);
        }, 25_000).unref?.();
      });
  }
});
