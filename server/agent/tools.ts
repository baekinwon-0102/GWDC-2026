import { z } from "zod";
import { Decimal } from "../../shared/units";
import { addDays, applyPatch, daysBetween, inputProblems } from "../../shared/needs";
import { buildMainnetPlans, type MainnetInputs } from "../../shared/planning";
import { isStale } from "../../shared/eligibility";
import { DecimalString, TX_KIND_KO, type NeedsPatch, type PlanningResult, type TxKind, type UserNeeds } from "../../shared/schemas";
import type { AgentArtifacts, AgentContext, AgentToolName, AnomalyFinding, BreakEvenResult, CatalogEntry, PositionSnapshot, ScenarioSummary, WhatIfResult } from "../../shared/agent";
import type { CatalogItem } from "../data/justlend";
import type { TxStatusResponse } from "../../shared/schemas";
import type { NileAdjustment } from "../../shared/adjust";

// 에이전트 도구. 모두 읽기 전용이며 인자는 Zod로 검증한다.
// 계산은 기존 계획 엔진(buildMainnetPlans)을 그대로 호출하므로 같은 입력·시세면 결과가 같다.

export interface ToolContext {
  context: AgentContext;
  needs: UserNeeds;
  inputs: MainnetInputs;
  failures: string[];
  mode: "live" | "synthetic";
  now: Date;
  /** 이번 요청에서 서버가 직접 계산한 기준 결과 (브라우저가 보낸 계획은 믿지 않는다) */
  base?: Omit<PlanningResult, "explanation">;
  nile?: { wallet?: string; txIds: string[]; records?: { txId: string; kind: TxKind; amount: string }[]; needs?: UserNeeds; planKey?: string };
  /** 이전 분석의 금리 (변화 감지용 참고값. 판정에는 쓰지 않는다) */
  previousRates?: { market: string; baseRate?: string }[];
  loadCatalog: () => Promise<{ items: CatalogItem[]; fetchedAt: string }>;
  loadTx: (txId: string) => Promise<TxStatusResponse>;
  loadPosition: (wallet: string) => Promise<PositionSnapshot>;
  loadAdjustment?: (wallet: string, needs: UserNeeds, planKey?: string) => Promise<NileAdjustment>;
}

export interface ToolResult {
  ok: boolean;
  /** 모델에게 돌려줄 관측값 (데이터) */
  data: unknown;
  /** 화면 단계 기록용 한 줄 요약 (코드가 작성) */
  summary: string;
  artifacts?: AgentArtifacts;
}

const r2 = (v?: string | Decimal) => (v === undefined ? undefined : new Decimal(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed());
const pct4 = (v?: string) => (v === undefined ? undefined : new Decimal(v).mul(100).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed());
const r4 = (v?: string) => (v === undefined ? undefined : new Decimal(v).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed());

// ------------------------------------------------------------------ 요약

export function summarize(r: Omit<PlanningResult, "explanation">): ScenarioSummary {
  const rec = r.plans.find((p) => p.id === r.recommendation.planId)!;
  return {
    amount: r.needs.amount ?? "0",
    horizonDays: r.plans[0]?.horizonDays ?? 0,
    reserved: r2(r.reserved.total)!,
    investable: r2(r.investable)!,
    recommendedKey: rec.key,
    recommendedTitle: rec.title,
    recommendationReason: r.recommendation.reason,
    plans: r.plans.map((p) => ({
      key: p.key,
      title: p.title,
      eligibility: p.eligibility,
      invested: r2(p.allocation.invested)!,
      ratePercent: pct4(p.baseRate),
      baseYield: r2(p.baseYield)!,
      roundTripFee: p.costs.inAsset === undefined ? "산정 불가" : `${r2(p.costs.inAsset)} ${r.needs.asset}`,
      netReturn: r2(p.netReturn) ?? "산정 불가",
      breakEvenDays: p.breakEvenDays ? new Decimal(p.breakEvenDays).ceil().toFixed() : "산정 불가",
      reasons: p.reasons.slice(0, 2),
      구간별_배분: p.ladder?.map((b) => ({ 구간: b.label, 금액: `${b.amount} ${r.needs.asset}`, 필요한_날: b.needDate, 넣을_곳: b.productLabel, 예상_수익: `${r2(b.yield)} ${r.needs.asset}`, 이유: b.why })),
    })),
  };
}

// ------------------------------------------------------------------ 인자 스키마

export const SimulateArgs = z
  .object({
    amount: DecimalString.optional(),
    durationDays: z.number().int().min(1).max(3650).optional(),
    expenseInDays: z.number().int().min(0).max(3650).optional(),
    expenseAmount: DecimalString.optional(),
    noExpenses: z.boolean().optional(),
    bufferAmount: DecimalString.optional(),
  })
  .strict();
export type SimulateArgs = z.infer<typeof SimulateArgs>;

export const BreakEvenArgs = z.object({ planKey: z.enum(["A", "B"]), dimension: z.enum(["days", "amount"]) }).strict();
const Empty = z.object({}).strict();
const TxArgs = z.object({ txId: z.string().regex(/^[0-9a-f]{64}$/i) }).strict();
export const FinishArgs = z.object({ answer: z.string().min(1).max(2000), planKey: z.enum(["A", "A2", "B", "C", "L", "HOLD"]).optional() }).strict();
export const AskArgs = z.object({ question: z.string().min(1).max(300) }).strict();

export const TOOL_SPECS: Record<AgentToolName, { contexts: AgentContext[]; args: z.ZodType; doc: string }> = {
  list_products: { contexts: ["mainnet"], args: Empty, doc: '{} — JustLend Mainnet 전체 시장 목록과 금리. 어떤 시장이 계획 A/B로 분석되는지, 나머지는 왜 분석하지 않는지 알려 준다.' },
  simulate: {
    contexts: ["mainnet"],
    args: SimulateArgs,
    doc: '{"amount"?:"숫자문자열","durationDays"?:정수,"expenseInDays"?:정수,"expenseAmount"?:"숫자문자열","noExpenses"?:bool,"bufferAmount"?:"숫자문자열"} — 바꿀 조건만 넣어 계획 엔진을 다시 계산하고 바꾸기 전과 비교한다. durationDays는 오늘부터 운용 일수, expenseInDays는 지출일이 오늘부터 며칠 뒤인지("45일 뒤로 미루면" → 45). 인자가 없으면 현재 조건 결과. USDD 위험 동의는 바꿀 수 없다.',
  },
  find_breakeven: { contexts: ["mainnet"], args: BreakEvenArgs, doc: '{"planKey":"A"|"B","dimension":"days"|"amount"} — 순수익이 0보다 커지는 최소 운용 일수 또는 최소 보유액을 코드가 탐색한다.' },
  check_anomalies: { contexts: ["mainnet"], args: Empty, doc: "{} — 시세·유동성·주소·데이터 신선도 이상을 규칙으로 점검한다." },
  get_tx_status: { contexts: ["nile"], args: TxArgs, doc: '{"txId":"64자리 hex"} — 사용자 기록에 있는 Nile 거래의 확정 영수증 상태를 조회한다.' },
  get_position: { contexts: ["nile"], args: Empty, doc: "{} — 연결된 Nile 지갑의 TRX 잔고, jTRX 포지션 가치, 스테이킹·투표·해제 대기·미청구 보상을 다시 읽는다." },
  propose_adjustment: { contexts: ["nile"], args: Empty, doc: "{} — 현재 포지션·지갑 잔고·사용자 조건(유동성 확보액·기간)으로 부분 인출/전액 인출/추가 예치/유지 중 조정안을 코드가 판정한다. 거래는 만들지 않는다." },
  ask_user: { contexts: ["mainnet", "nile"], args: AskArgs, doc: '{"question":"한국어 질문"} — 정보가 부족하거나 사용자 동의가 필요할 때 루프를 멈추고 묻는다.' },
  finish: { contexts: ["mainnet", "nile"], args: FinishArgs, doc: '{"answer":"한국어 3~6문장","planKey"?:"A"|"A2"|"B"|"C"|"L"|"HOLD"} — 최종 답. planKey는 코드가 적격으로 판정한 계획 중에서만 고른다.' },
};

export function toolsFor(context: AgentContext): AgentToolName[] {
  return (Object.keys(TOOL_SPECS) as AgentToolName[]).filter((t) => TOOL_SPECS[t].contexts.includes(context));
}

// ------------------------------------------------------------------ simulate (조건 바꿔 보기)

export function applyChanges(needs: UserNeeds, ch: SimulateArgs): { needs: UserNeeds; changes: string[] } {
  const patch: NeedsPatch = {};
  const changes: string[] = [];
  if (ch.amount !== undefined) patch.amount = ch.amount;
  if (ch.durationDays !== undefined) patch.durationDays = ch.durationDays;
  if (ch.bufferAmount !== undefined) patch.bufferAmount = ch.bufferAmount;
  if (ch.noExpenses) patch.noExpenses = true;
  if (ch.expenseInDays !== undefined || ch.expenseAmount !== undefined) {
    if (needs.expenses.length > 1) throw new Error("지출이 여러 건이라 어느 지출을 바꿀지 특정할 수 없습니다.");
    const cur = needs.expenses[0];
    const inDays = ch.expenseInDays ?? (cur ? daysBetween(needs.startDate, cur.date) : undefined);
    const amount = ch.expenseAmount ?? cur?.amount;
    if (inDays === undefined || amount === undefined) throw new Error("새 지출을 만들려면 expenseInDays와 expenseAmount가 모두 필요합니다.");
    patch.expenses = [{ inDays, amount, asset: needs.asset, label: cur?.label ?? "예정 지출" }];
  }
  const { needs: next } = applyPatch(needs, patch);
  const problems = inputProblems(next);
  if (problems.length) throw new Error(problems.join(" "));

  const asset = needs.asset;
  if (next.amount !== needs.amount) changes.push(`보유액 ${needs.amount} → ${next.amount} ${asset}`);
  if (next.endDate !== needs.endDate)
    changes.push(`운용 기간 ${daysBetween(needs.startDate, needs.endDate!)}일 → ${daysBetween(next.startDate, next.endDate!)}일`);
  if (JSON.stringify(next.expenses) !== JSON.stringify(needs.expenses)) {
    const fmtE = (n: UserNeeds) => (n.expenses.length ? n.expenses.map((e) => `${e.date} ${e.amount} ${e.asset}`).join(", ") : "없음");
    changes.push(`지출 ${fmtE(needs)} → ${fmtE(next)}`);
  }
  if (next.bufferAmount !== needs.bufferAmount) changes.push(`여유액 ${needs.bufferAmount ?? 0} → ${next.bufferAmount} ${asset}`);
  return { needs: next, changes };
}

export function simulate(ctx: ToolContext, args: SimulateArgs): ToolResult {
  const base = ctx.base ?? buildMainnetPlans(ctx.needs, ctx.inputs, ctx.now);
  const before = summarize(base);
  if (!Object.keys(args).length) return { ok: true, data: before, summary: `현재 조건 계산: 추천 ${before.recommendedTitle}`, artifacts: { base: before } };
  const { needs, changes } = applyChanges(ctx.needs, args);
  if (!changes.length) return { ok: true, data: { note: "바뀐 조건이 없습니다.", before }, summary: "바뀐 조건 없음" };
  const after = summarize(buildMainnetPlans(needs, ctx.inputs, ctx.now));
  const whatIf: WhatIfResult = { changes, before, after, recommendationChanged: before.recommendedKey !== after.recommendedKey };
  return {
    ok: true,
    data: whatIf,
    summary: `${changes.join(", ")} → 운용 가능액 ${before.investable} → ${after.investable}, 추천 ${before.recommendedKey} → ${after.recommendedKey}`,
    artifacts: { whatIf },
  };
}

// ------------------------------------------------------------------ find_breakeven (손익분기·최소 운용액)

export function findBreakEven(ctx: ToolContext, planKey: "A" | "B", dimension: "days" | "amount"): BreakEvenResult {
  const n = ctx.needs;
  const asset = n.asset;
  const note = "조회 시점의 금리·수수료가 그대로 유지된다고 가정한 코드 탐색 결과입니다 (보장 아님).";
  const curDays = daysBetween(n.startDate, n.endDate!);
  const planOf = (needs: UserNeeds) => buildMainnetPlans(needs, ctx.inputs, ctx.now).plans.find((p) => p.key === planKey)!;
  const profitable = (needs: UserNeeds) => {
    const p = planOf(needs);
    return p.netReturn !== undefined && new Decimal(p.netReturn).gt(0) && p.eligibility !== "ineligible" ? p : undefined;
  };
  const base: Omit<BreakEvenResult, "found" | "note"> = { planKey, dimension, unit: dimension === "days" ? "일" : asset, current: dimension === "days" ? String(curDays) : n.amount! };

  if (planKey === "B" && n.acceptUsddRisk !== true) return { ...base, found: false, note: "사용자가 USDD 위험을 받아들이지 않아 계획 B는 탐색하지 않습니다." };
  const probe = planOf(n);
  if (probe.netReturn === undefined) return { ...base, found: false, note: "거래비용 또는 환산 근거가 없어 순수익을 산정할 수 없습니다." };
  const hard = probe.reasons.find((r) => /비활성|일시 중지|체인|오래된|조회하지 못|전환 조건|주소/.test(r));
  if (probe.eligibility === "ineligible" && hard) return { ...base, found: false, note: `현재 실행 조건을 통과하지 못해 탐색하지 않습니다: ${hard}` };

  if (dimension === "days") {
    // 지출이 기간 안에 들어오면 운용 가능액이 바뀌므로 단조롭지 않다. 1일 단위로 끝까지 훑는다.
    for (let d = 1; d <= 3650; d++) {
      const needs = { ...n, endDate: addDays(n.startDate, d) };
      if (inputProblems(needs).length) continue;
      const p = profitable(needs);
      if (p) return { ...base, found: true, value: String(d), netAtValue: r4(p.netReturn), note };
    }
    return { ...base, found: false, note: `10년(3650일) 안에는 순수익이 0보다 커지지 않습니다. ${note}` };
  }

  // 보유액이 늘면 예치액만 늘고 왕복 비용은 거의 고정이라 순수익이 단조 증가한다 → 이분 탐색
  const reserved = new Decimal(buildMainnetPlans(n, ctx.inputs, ctx.now).reserved.total);
  const withAmount = (x: Decimal) => ({ ...n, amount: x.toDecimalPlaces(2, Decimal.ROUND_UP).toFixed() });
  const netAt = (x: Decimal) => {
    const p = planOf(withAmount(x));
    return p.netReturn === undefined ? undefined : new Decimal(p.netReturn);
  };
  let lo = reserved;
  let hi = new Decimal(100_000_000);
  const top = netAt(hi);
  if (!top || top.lte(0)) return { ...base, found: false, note: `보유액 1억 ${asset}까지도 순수익이 0보다 커지지 않습니다. ${note}` };
  for (let i = 0; i < 80 && hi.minus(lo).gt("0.01"); i++) {
    const mid = lo.plus(hi).div(2);
    const v = netAt(mid);
    if (v && v.gt(0)) hi = mid;
    else lo = mid;
  }
  const value = hi.toDecimalPlaces(2, Decimal.ROUND_UP);
  const p = planOf(withAmount(value));
  const blocked = p.eligibility === "ineligible" ? ` 다만 이 금액에서는 실행 조건을 통과하지 못합니다: ${p.reasons[0]}` : "";
  return { ...base, found: true, value: value.toFixed(), netAtValue: r4(p.netReturn), note: `지출 재원 ${r2(reserved)} ${asset}을 포함한 총 보유액입니다. ${note}${blocked}` };
}

// ------------------------------------------------------------------ check_anomalies (시세 이상 감지)

export function checkAnomalies(ctx: Pick<ToolContext, "inputs" | "failures" | "now" | "base" | "previousRates">): AnomalyFinding[] {
  const out: AnomalyFinding[] = [];
  const { jusdt, jusdd, psm, staking, costBasis } = ctx.inputs;
  const investable = new Decimal(ctx.base?.investable ?? 0);
  for (const f of ctx.failures) out.push({ severity: "high", market: "데이터", message: f });
  for (const [label, q] of [["jUSDT", jusdt], ["jUSDD", jusdd], ["USDD PSM", psm], ["TRX 스테이킹", staking]] as const) {
    if (!q) {
      out.push({ severity: "high", market: label, message: "데이터를 조회하지 못했습니다." });
      continue;
    }
    if (q.source.mode === "synthetic") out.push({ severity: "info", market: label, message: "가상(synthetic) 데이터입니다. 실제 시세가 아닙니다." });
    if (q.source.mode === "live" && isStale(q, ctx.now)) out.push({ severity: "high", market: label, message: "조회 후 10분이 지나 오래된 데이터입니다." });
    if (!q.active) out.push({ severity: "high", market: label, message: `비활성: ${q.inactiveReason ?? "사유 미상"}` });
    if (q.baseRate !== undefined) {
      const rate = new Decimal(q.baseRate);
      if (rate.gt("0.5")) out.push({ severity: "warn", market: label, message: `공급 금리가 연 ${pct4(q.baseRate)}%로 비정상적으로 높습니다. 일시적 급등일 수 있습니다.` });
      else if (rate.lt("0.0001")) out.push({ severity: "info", market: label, message: `공급 금리가 연 ${pct4(q.baseRate)}%로 거의 0입니다.` });
      const prev = ctx.previousRates?.find((x) => x.market === q.market)?.baseRate;
      if (prev && new Decimal(prev).gt(0)) {
        const change = rate.minus(prev).div(prev).abs();
        if (change.gt("0.3")) out.push({ severity: "warn", market: label, message: `이전 분석 대비 금리가 ${pct4(prev)}% → ${pct4(q.baseRate)}%로 크게 바뀌었습니다.` });
      }
    }
    if (q.liquidity !== undefined && investable.gt(0)) {
      const liq = new Decimal(q.liquidity);
      if (liq.lt(investable)) out.push({ severity: "high", market: label, message: `인출 가능 유동성 ${r2(liq)} ${q.token}이 예치 예정액보다 적습니다.` });
      else if (liq.lt(investable.mul(2))) out.push({ severity: "warn", market: label, message: `인출 가능 유동성 ${r2(liq)} ${q.token}이 예치 예정액의 2배 미만입니다.` });
    }
    if (q.psm) {
      if (!q.psm.sellEnabled || !q.psm.buyEnabled) out.push({ severity: "high", market: label, message: "PSM 전환(진입 또는 출구)이 막혀 있습니다." });
      if (q.psm.exitLiquidity !== undefined && investable.gt(0) && new Decimal(q.psm.exitLiquidity).lt(investable))
        out.push({ severity: "high", market: label, message: "PSM 출구 USDT 물량이 예치 예정액보다 적습니다." });
      if (new Decimal(q.psm.feeIn).gt(0) || new Decimal(q.psm.feeOut).gt(0)) out.push({ severity: "info", market: label, message: `PSM 수수료 진입 ${pct4(q.psm.feeIn)}%, 출구 ${pct4(q.psm.feeOut)}%.` });
    }
    if (q.rewards.status === "unverified")
      out.push({ severity: "info", market: label, message: q.rewards.apr ? `채굴 보상 추정 연 ${pct4(q.rewards.apr)}% (${q.rewards.token ?? ""})는 종료 시점 미확인이라 순수익에서 제외했습니다.` : "채굴 보상을 확인하지 못해 수익에서 제외했습니다." });
    if (q.staking && new Decimal(q.staking.brokerage).gt("0.5")) out.push({ severity: "warn", market: label, message: `선택된 SR의 수수료가 ${pct4(q.staking.brokerage)}%로 높습니다.` });
  }
  if (!costBasis) out.push({ severity: "high", market: "수수료", message: "체인 수수료 파라미터를 조회하지 못했습니다." });
  else if (!costBasis.trxPerUsdt) out.push({ severity: "warn", market: "수수료", message: "TRX→USDT 환산 가격이 없어 순수익을 산정할 수 없습니다." });
  else {
    const p = new Decimal(costBasis.trxPerUsdt);
    if (p.lt("0.5") || p.gt("50")) out.push({ severity: "warn", market: "가격", message: `1 USDT = ${p.toDecimalPlaces(4).toFixed()} TRX로 정상 범위를 벗어났습니다. 오라클 값을 확인하세요.` });
  }
  const order = { high: 0, warn: 1, info: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}

// ------------------------------------------------------------------ list_products

export function catalogEntries(items: CatalogItem[], asset: string): CatalogEntry[] {
  return [...items]
    .sort((a, b) => new Decimal(b.supplyRate).cmp(a.supplyRate))
    .slice(0, 15)
    .map((t) => {
      // 보유 자산과 같은 시장은 계획 A, USDT 보유자의 jUSDD는 계획 B(PSM 경로)
      const analyzedAs = t.symbol === `j${asset}` ? "A" : asset === "USDT" && t.symbol === "jUSDD" ? "B" : undefined;
      const note =
        analyzedAs === "A"
          ? `계획 A로 분석 (보유 ${asset}를 그대로 예치)`
          : analyzedAs === "B"
            ? "계획 B로 분석 (PSM으로 USDT→USDD 전환 후 예치)"
            : t.underlying === asset
              ? "같은 기초자산이지만 비용 모델이 없어 분석하지 않음"
              : `기초자산(${t.underlying})이 보유 자산(${asset})과 달라 전환 비용·가격 위험 모델이 없어 분석하지 않음`;
      return { symbol: t.symbol, underlying: t.underlying, supplyApyPercent: pct4(t.supplyRate)!, liquidity: r2(t.liquidity)!, analyzedAs, note };
    });
}

async function listProducts(ctx: ToolContext): Promise<ToolResult> {
  let items: CatalogItem[];
  let fetchedAt: string;
  if (ctx.mode === "synthetic") {
    items = [ctx.inputs.jusdt, ctx.inputs.jusdd]
      .filter(Boolean)
      .map((q) => ({ symbol: q!.market, underlying: q!.token, address: q!.address, supplyRate: q!.baseRate ?? "0", liquidity: q!.liquidity ?? "0" }));
    fetchedAt = ctx.now.toISOString();
  } else ({ items, fetchedAt } = await ctx.loadCatalog());
  const entries = catalogEntries(items, ctx.needs.asset);
  const catalog = { total: items.length, entries, fetchedAt, mode: ctx.mode };
  return {
    ok: true,
    data: catalog,
    summary: `JustLend 시장 ${items.length}개 조회 (상위 ${entries.length}개 금리순), 분석 대상 ${entries.filter((e) => e.analyzedAs).length}개`,
    artifacts: { catalog },
  };
}

// ------------------------------------------------------------------ 실행기

/** 모델이 자주 보내는 별칭(horizonDays)과 의미 없는 값(noExpenses:false)을 정리한다. 그 밖의 키는 strict 검증에서 거부된다 */
function normalizeSimulateArgs(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw ?? {};
  const o: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  if (o.horizonDays !== undefined && o.durationDays === undefined) o.durationDays = o.horizonDays;
  delete o.horizonDays;
  if (o.noExpenses === false) delete o.noExpenses;
  return o;
}

export async function runTool(name: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
  const spec = TOOL_SPECS[name as AgentToolName];
  if (!spec || !spec.contexts.includes(ctx.context)) return { ok: false, data: { error: `허용되지 않은 도구: ${name}. 사용 가능: ${toolsFor(ctx.context).join(", ")}` }, summary: `거부: 허용 목록 밖 도구 ${name}` };
  const parsed = spec.args.safeParse(name === "simulate" ? normalizeSimulateArgs(rawArgs) : (rawArgs ?? {}));
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".") || "(args)"}: ${i.message}`).join("; ").slice(0, 300);
    return { ok: false, data: { error: `인자 오류: ${msg}` }, summary: `거부: ${name} 인자 오류` };
  }
  const args = parsed.data as any;
  try {
    switch (name as AgentToolName) {
      case "list_products":
        return await listProducts(ctx);
      case "simulate":
        return simulate(ctx, args);
      case "find_breakeven": {
        const r = findBreakEven(ctx, args.planKey, args.dimension);
        const what = args.dimension === "days" ? "최소 운용 일수" : "최소 보유액";
        return {
          ok: true,
          data: r,
          summary: `계획 ${args.planKey} ${what}: ${r.found ? `${r.value} ${r.unit}` : "없음"} (현재 ${r.current} ${r.unit})`,
          artifacts: { breakEven: [r] },
        };
      }
      case "check_anomalies": {
        const f = checkAnomalies(ctx);
        const c = (s: string) => f.filter((x) => x.severity === s).length;
        return { ok: true, data: f, summary: `시세 점검: 심각 ${c("high")} · 주의 ${c("warn")} · 참고 ${c("info")}`, artifacts: { anomalies: f } };
      }
      case "get_tx_status": {
        if (!ctx.nile?.txIds.includes(args.txId)) return { ok: false, data: { error: "사용자 기록에 없는 txID는 조회하지 않습니다." }, summary: "거부: 기록에 없는 txID" };
        const t = await ctx.loadTx(args.txId);
        const rec = ctx.nile.records?.find((r) => r.txId === args.txId);
        // 사용자 기록의 거래 종류·금액을 함께 준다 (모델이 예치/인출을 추측하지 않도록)
        const data = rec ? { ...t, userRecord: { kind: rec.kind === "deposit" ? "예치(jTRX mint)" : rec.kind === "withdraw" ? "인출(jTRX redeem)" : TX_KIND_KO[rec.kind], amount: rec.amount } } : t;
        return { ok: true, data, summary: `거래 ${args.txId.slice(0, 10)}… 상태 ${t.status}`, artifacts: { tx: [t] } };
      }
      case "get_position": {
        if (!ctx.nile?.wallet) return { ok: false, data: { error: "연결된 Nile 지갑 기록이 없습니다." }, summary: "지갑 없음" };
        const p = await ctx.loadPosition(ctx.nile.wallet);
        return { ok: true, data: p, summary: `포지션 재조회: jTRX ${p.jTrx} ≈ ${p.underlyingTrx} TRX, 잔고 ${p.trx} TRX`, artifacts: { position: p } };
      }
      case "propose_adjustment": {
        if (!ctx.nile?.wallet || !ctx.nile.needs || !ctx.loadAdjustment) return { ok: false, data: { error: "Nile 지갑 또는 Nile 요구사항 기록이 없습니다." }, summary: "조정 판정 불가: 기록 없음" };
        const a = await ctx.loadAdjustment(ctx.nile.wallet, ctx.nile.needs, ctx.nile.planKey);
        const label = { adjust: "조정 필요", hold_position: "유지", no_position: "포지션 없음", blocked: "진행 불가" }[a.status];
        return { ok: true, data: a, summary: `조정 판정: ${label}${a.action ? ` — ${a.action.kind} ${a.action.amountTrx} TRX` : ""}`, artifacts: { adjustment: a } };
      }
      default:
        return { ok: false, data: { error: `${name}은 루프 종료 행동입니다.` }, summary: name };
    }
  } catch (e) {
    return { ok: false, data: { error: (e as Error).message.slice(0, 300) }, summary: `실패: ${name} — ${(e as Error).message.slice(0, 80)}` };
  }
}
