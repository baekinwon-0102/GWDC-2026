import { describe, expect, it } from "vitest";
import { computeStakingAdjustment } from "../shared/adjust";
import { addDays, applyPatch, emptyNeeds, holdingsOf, inputProblems, missingFields, needsForHolding } from "../shared/needs";
import { templateExtract } from "../server/llm/template";
import { buildMainnetPlans, buildNilePlans, swapOut, trxToUsdt, usdtToTrx, type SwapMarket } from "../shared/planning";
import { applyCostOptions, rentalCostTrx } from "../shared/costmode";
import { buildPortfolioPlans } from "../shared/portfolio";
import { buildScreening } from "../shared/screening";
import { Decimal } from "../shared/units";
import type { CostBasis, ProductQuote, UserNeeds } from "../shared/schemas";

const TODAY = "2026-09-29";
const NOW = new Date("2026-09-29T03:00:00Z");
const live = (chain: "mainnet" | "nile" = "mainnet") => ({ sourceUrl: "t", chain, fetchedAt: NOW.toISOString(), mode: "live" as const, accessMethod: "direct" as const });
const lending = (market: string, token: string, rate: string, chain: "mainnet" | "nile" = "mainnet"): ProductQuote => ({
  id: market, kind: "lending", market, token, address: "T" + market, chain, baseRate: rate, rateType: "APY", liquidity: "100000000", active: true,
  rewards: { status: "none", note: "" }, source: live(chain),
});
const staking: ProductQuote = {
  id: "stake", kind: "staking", market: "TRX 스테이킹 + SR 투표", token: "TRX", address: "Tsr", chain: "mainnet", baseRate: "0.0328", rateType: "APR", active: true,
  rewards: { status: "none", note: "" }, source: live(),
  staking: { srAddress: "Tsr", srName: "sr", brokerage: "0", srVotes: "1", totalVotes: "44", unfreezeDelayDays: 14, voteRewardPerBlockTrx: "128", blockRewardPerBlockTrx: "8", candidates: 27 },
};
const basis: CostBasis = { energyFeeSun: 100, bandwidthFeeSun: 1000, trxPerUsdt: "3", psmEnergy: { sell: 250000, buy: 310000, sampleSize: 10 }, source: live() };
const inputs = { jusdt: lending("jUSDT", "USDT", "0.05"), jtrx: lending("jTRX", "TRX", "0.01"), staking, costBasis: basis };

const multi: UserNeeds = {
  ...emptyNeeds("mainnet", TODAY),
  asset: "USDT",
  amount: "5000",
  holdings: [
    { asset: "USDT", amount: "5000" },
    { asset: "TRX", amount: "20000" },
  ],
  endDate: addDays(TODAY, 90),
  expenses: [
    { id: "e1", date: addDays(TODAY, 20), amount: "1000", asset: "USDT" },
    { id: "e2", date: addDays(TODAY, 60), amount: "5000", asset: "TRX" },
  ],
  expensesStated: true,
  bufferAmount: "100",
  riskProfile: "balanced",
  acceptUsddRisk: false,
  version: 3,
};

describe("여러 자산 보유: 입력", () => {
  it("대화에서 두 자산을 모두 뽑아 보유 목록으로 저장한다 (템플릿 추출)", () => {
    const p = templateExtract("USDT 5,000과 TRX 20,000을 90일 운용해요. 20일 뒤 1,000 USDT, 60일 뒤 5,000 TRX를 써요. 여유액은 없어요.", undefined, TODAY);
    expect(p.holdings).toEqual([
      { asset: "USDT", amount: "5000" },
      { asset: "TRX", amount: "20000" },
    ]);
    expect(p.expenses?.map((e) => [e.inDays, e.amount, e.asset])).toEqual([
      [20, "1000", "USDT"],
      [60, "5000", "TRX"],
    ]);
    const { needs } = applyPatch(emptyNeeds("mainnet", TODAY), p);
    expect(holdingsOf(needs)).toHaveLength(2);
    expect(needs.asset).toBe("USDT");
    expect(needs.amount).toBe("5000");
  });

  it("한 자산 금액만 바꾸면 목록 안에서 그 자산만 바뀌고, 자산을 지정해 하나만 말하면 목록이 해제된다", () => {
    const a = applyPatch(multi, { amount: "6000" }).needs;
    expect(a.holdings).toEqual([
      { asset: "USDT", amount: "6000" },
      { asset: "TRX", amount: "20000" },
    ]);
    const b = applyPatch(multi, { asset: "TRX", amount: "300" }).needs;
    expect(b.holdings).toBeUndefined();
    expect([b.asset, b.amount]).toEqual(["TRX", "300"]);
  });

  it("보유하지 않은 자산(USDD)의 지출은 대표 자산에서 환전하고, 자산별 재원 부족은 막는다", () => {
    const withUsdd = { ...multi, expenses: [...multi.expenses, { id: "e3", date: addDays(TODAY, 5), amount: "10", asset: "USDD" }] };
    expect(inputProblems(withUsdd)).toEqual([]);
    expect(needsForHolding(withUsdd, { asset: "USDT", amount: "5000" }).expenses.map((e) => e.asset)).toEqual(["USDT", "USDD"]);
    expect(needsForHolding(withUsdd, { asset: "TRX", amount: "20000" }).expenses.map((e) => e.asset)).toEqual(["TRX"]);
    const short = { ...multi, expenses: [{ id: "e1", date: addDays(TODAY, 20), amount: "25000", asset: "TRX" }] };
    expect(inputProblems(short).some((x) => /TRX/.test(x) && /보유액/.test(x))).toBe(true);
    expect(inputProblems(multi)).toEqual([]);
  });

  it("보유 자산과 무관하게 USDD 위험 질문을 한다 (TRX 보유자도 교환을 거쳐 USDD 경로를 쓸 수 있음)", () => {
    expect(missingFields({ ...multi, acceptUsddRisk: undefined })).toContain("acceptUsddRisk");
    expect(missingFields({ ...multi, holdings: undefined, asset: "TRX", amount: "100", acceptUsddRisk: undefined })).toContain("acceptUsddRisk");
  });

  it("자산별 요구사항은 그 자산의 지출만, 여유액은 대표 자산에만 둔다", () => {
    const trx = needsForHolding(multi, { asset: "TRX", amount: "20000" });
    expect(trx.expenses.map((e) => e.asset)).toEqual(["TRX"]);
    expect(trx.bufferAmount).toBe("0");
    expect(trx.acceptUsddRisk).toBe(false);
    expect(needsForHolding(multi, { asset: "USDT", amount: "5000" }).bufferAmount).toBe("100");
  });
});

describe("여러 자산 보유: 배분 로직", () => {
  const r = buildPortfolioPlans(multi, inputs, NOW);
  const pf = r.portfolio!;

  it("자산마다 같은 계획 엔진(지출 확보·인출일별 분산·추천)을 적용한다", () => {
    expect(pf.parts.map((p) => p.asset)).toEqual(["USDT", "TRX"]);
    const [u, t] = pf.parts.map((p) => p.result);
    // USDT: 1,000 지출 + 100 여유액 확보, TRX: 5,000 지출 확보
    expect(u.reserved.total).toBe("1100");
    expect(t.reserved.total).toBe("5000");
    expect(u.investable).toBe("3900");
    expect(t.investable).toBe("15000");
    for (const p of [u, t]) {
      expect(p.plans.map((x) => x.key)).toContain("L");
      expect(p.plans.filter((x) => x.recommended)).toHaveLength(1);
      expect(p.reserved.outsideHorizon).toEqual([]); // 다른 자산 지출이 기간 밖 지출로 잘못 잡히지 않는다
    }
    // TRX 보유분의 인출일별 분산은 D+60 지출과 나머지로 구간을 나눈다
    expect(t.plans.find((x) => x.key === "L")!.ladder!.map((b) => b.needDay)).toEqual([60, 90]);
    // 계획 ID가 자산별로 겹치지 않는다
    const ids = [...u.plans, ...t.plans].map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("합계를 USDT로 환산하고, 추천 계획 순수익을 더한다", () => {
    expect(pf.totalValueUsdt).toBe(new Decimal(5000).plus(new Decimal(20000).div(3)).toFixed());
    const nets = pf.parts.map((p) => {
      const rec = p.result.plans.find((x) => x.id === p.result.recommendation.planId)!;
      return p.asset === "USDT" ? new Decimal(rec.netReturn!) : new Decimal(rec.netReturn!).div(3);
    });
    expect(pf.totalNetUsdt).toBe(nets[0].plus(nets[1]).toFixed());
    const shares = pf.allocation.reduce((s, a) => s.plus(a.share ?? 0), new Decimal(0));
    expect(shares.toNumber()).toBeCloseTo(1, 9);
  });

  it("최상위 결과는 대표 자산 결과이고 요구사항은 전체 목록을 유지한다", () => {
    expect(r.needs.holdings).toHaveLength(2);
    expect(r.plans).toEqual(pf.parts[0].result.plans);
  });

  it("한 자산이면 기존 계산과 같다", () => {
    const one = { ...multi, holdings: undefined, expenses: [multi.expenses[0]] };
    const a = buildPortfolioPlans(one, inputs, NOW);
    expect(a.portfolio).toBeUndefined();
    expect(a.plans.map((p) => p.key)).toEqual(["A", "A2", "B", "C", "L", "HOLD"]);
  });
});

describe("스테이킹 포지션 조정", () => {
  const nileNeeds: UserNeeds = { ...emptyNeeds("nile", TODAY), amount: "1000", endDate: addDays(TODAY, 30), expensesStated: true, expenses: [], bufferAmount: "0", riskProfile: "balanced", version: 1 };
  const st = (o: Partial<Parameters<typeof computeStakingAdjustment>[0]["state"]> = {}) => ({
    walletSun: "50000000", frozenSun: "900000000", tronPower: 900, votedCount: 900, withdrawableSun: "0", rewardSun: "0", unfreezing: [], ...o,
  });
  const adj = (needs: UserNeeds, state = st()) => computeStakingAdjustment({ needs, state, unfreezeDelayDays: 1, sr: "Tsr", now: NOW });

  it("문제가 없으면 유지한다", () => {
    expect(adj(nileNeeds).status).toBe("hold_position");
  });
  it("해제 대기 안에 오는 지출이 지갑보다 크면 부족분만큼 해제를 제안한다", () => {
    const n = { ...nileNeeds, expenses: [{ id: "e", date: addDays(TODAY, 1), amount: "200", asset: "TRX" }] };
    const a = adj(n);
    const u = a.actions.find((x) => x.kind === "unstake")!;
    expect(u.amountTrx).toBe("150"); // 200 − 지갑 50
    expect(u.urgent).toBe(true);
  });
  it("운용 종료까지 해제 대기보다 적게 남으면 전부 해제하고 보상을 청구한다", () => {
    const a = adj({ ...nileNeeds, endDate: addDays(TODAY, 1) }, st({ rewardSun: "300000" }));
    expect(a.actions.find((x) => x.kind === "unstake")!.amountTrx).toBe("900");
    expect(a.actions.some((x) => x.kind === "claim_reward")).toBe(true);
    expect(a.actions.some((x) => x.kind === "vote")).toBe(false);
  });
  it("해제 완료분 인출과 투표하지 않은 투표권을 알린다", () => {
    const a = adj(nileNeeds, st({ withdrawableSun: "5000000", votedCount: 0 }));
    expect(a.actions.map((x) => x.kind)).toEqual(["withdraw_unfrozen", "vote"]);
    expect(a.actions[1].votes).toBe(900);
  });
  it("스테이킹이 없으면 포지션 없음", () => {
    expect(adj(nileNeeds, st({ frozenSun: "0", tronPower: 0, votedCount: 0 })).status).toBe("no_position");
  });
});

describe("Nile 계획 ID와 USDD 저축", () => {
  it("다시 계산하면 계획 ID가 달라져 이전 실행 기록이 새 계획에 붙지 않는다", () => {
    const n: UserNeeds = { ...emptyNeeds("nile", TODAY), amount: "100", endDate: addDays(TODAY, 30), expensesStated: true, bufferAmount: "0", riskProfile: "balanced", version: 1 };
    const nb = { ...basis, source: live("nile") };
    const a = buildNilePlans(n, { jtrx: lending("jTRX", "TRX", "0.03", "nile"), costBasis: nb }, NOW);
    const b = buildNilePlans(n, { jtrx: lending("jTRX", "TRX", "0.03", "nile"), costBasis: nb }, new Date(NOW.getTime() + 60_000));
    expect(a.plans[0].id).not.toBe(b.plans[0].id);
    expect(a.plans[0].key).toBe(b.plans[0].key);
  });
  it("sUSDD가 TRON에 없으면 탐색 표에 사유와 다른 체인 금리를 참고로 보인다", () => {
    const rows = buildScreening(multi, new Decimal(1000), [], {
      plans: [],
      usddSavings: { tron: { apy: "0.04", earnTvl: "0", registered: false }, otherChains: [{ chain: "Ethereum", apy: "0.04", earnTvl: "198905691" }], source: live() },
    });
    const s = rows.find((r) => r.product.startsWith("sUSDD"))!;
    expect(s.category).toBe("not_on_tron");
    expect(s.verdict).toBe("excluded");
    expect(s.reasons[0]).toMatch(/TRON에는 배포되지 않았습니다/);
    expect(s.reasons[1]).toMatch(/Ethereum 연 4.00%/);
  });
});

describe("TRX 보유자의 USDD 경로 (계획 B)", () => {
  const psmQ: ProductQuote = {
    id: "psm", kind: "psm", market: "PSM", token: "USDD", address: "Tpsm", chain: "mainnet", active: true, rewards: { status: "none", note: "" },
    psm: { feeIn: "0", feeOut: "0", sellEnabled: true, buyEnabled: true, entryCapacity: "100000000", exitLiquidity: "100000000" }, source: live(),
  };
  const swap: SwapMarket = {
    router: "Trouter", pair: "Tpair", reserveUsdt: "47000000", reserveTrx: "140000000", feeNumerator: 997,
    costs: { toTrx: { energy: 200000, bandwidth: 500 }, toUsdt: { energy: 210000, bandwidth: 520 }, sampleSize: 10 }, source: live(),
  };
  const trxNeeds: UserNeeds = { ...emptyNeeds("mainnet", TODAY), asset: "TRX", amount: "100000", endDate: addDays(TODAY, 180), expensesStated: true, bufferAmount: "0", riskProfile: "aggressive", acceptUsddRisk: true, version: 1 };
  const b = (n: UserNeeds, extra: object = {}) =>
    buildMainnetPlans(n, { ...inputs, jusdd: lending("jUSDD", "USDD", "0.08"), psm: psmQ, costBasis: { ...basis, psmEnergy: { sell: 250000, buy: 310000, sampleSize: 10 } }, swap, ...extra }, NOW).plans.find((p) => p.key === "B")!;

  it("TRX→USDT 교환 → PSM → jUSDD → 역순으로 계산하고, 교환 손실은 전환 비용으로 뺀다", () => {
    const B = b(trxNeeds);
    expect(B.eligibility).toBe("eligible");
    expect(B.riskClass).toBe("volatile");
    expect(B.steps.filter((s) => s.action === "swap").map((s) => [s.asset, s.day])).toEqual([["TRX", 0], ["USDT", 180]]);
    const usdtIn = trxToUsdt(swap, new Decimal(100000));
    expect(B.steps.find((s) => s.action === "psm_sell")!.amount).toBe(usdtIn.toFixed());
    expect(Number(B.costs.conversionFees)).toBeGreaterThan(100000 * 0.006 * 0.99); // 교환 수수료 0.3% × 2
    expect(B.stress?.some((x) => /TRX 가격/.test(x.label))).toBe(true);
  });
  it("균형형은 가격 변동 경로라 제외하고, 교환 견적이 없으면 사유와 함께 제외한다", () => {
    expect(b({ ...trxNeeds, riskProfile: "balanced" }).reasons[0]).toMatch(/TRX 보유자에게 USDD 경로는/);
    const none = b(trxNeeds, { swap: undefined });
    expect(none.eligibility).toBe("ineligible");
    expect(none.reasons[0]).toMatch(/교환 견적/);
  });
  it("브리지 PSM(Nile): USDT 구간을 PSM 수수료로 1:1 전환하고, 진입·출구 단계에 브리지 승인·전환이 들어간다", () => {
    const bridged: SwapMarket = { ...swap, bridge: { psm: "Tbridge", gemJoin: "TbridgeJoin", token: "TusddOld", symbol: "USDD(구)", feeIn: "0.0012", feeOut: "0.002" } };
    // TRX → 브리지 토큰(V2) → USDT: 브리지 토큰 ÷ (1 + tout)
    const viaPool = swapOut(new Decimal(1000), new Decimal(swap.reserveTrx), new Decimal(swap.reserveUsdt));
    expect(trxToUsdt(bridged, new Decimal(1000)).toFixed()).toBe(viaPool.div("1.002").toDecimalPlaces(6, Decimal.ROUND_DOWN).toFixed());
    // USDT → 브리지 토큰: × (1 − tin), 그다음 V2
    expect(usdtToTrx(bridged, new Decimal(300)).toFixed()).toBe(swapOut(new Decimal(300).mul("0.9988"), new Decimal(swap.reserveUsdt), new Decimal(swap.reserveTrx)).toFixed());
    const B = b(trxNeeds, { swap: bridged });
    const labels = B.steps.map((s) => s.label);
    expect(labels.filter((l) => /브리지/.test(l))).toHaveLength(4); // 진입 승인·전환, 출구 승인·전환
    expect(B.steps.filter((s) => s.action === "swap").map((s) => s.asset)).toEqual(["TRX", "USDD(구)"]);
  });
});

describe("보유 자산과 다른 자산으로 내는 지출 (환전)", () => {
  const swap: SwapMarket = {
    router: "Tr", pair: "Tp", reserveUsdt: "47000000", reserveTrx: "140000000", feeNumerator: 997,
    costs: { toTrx: { energy: 200000, bandwidth: 500 }, toUsdt: { energy: 210000, bandwidth: 520 }, sampleSize: 10 }, source: live(),
  };
  const psm: ProductQuote = { id: "psm", kind: "psm", market: "PSM", token: "USDD", address: "Tpsm", chain: "mainnet", active: true, rewards: { status: "none", note: "" }, psm: { feeIn: "0.001", feeOut: "0", sellEnabled: true, buyEnabled: true, entryCapacity: "1e9", exitLiquidity: "1e9" }, source: live() };
  const trxNeeds: UserNeeds = { ...emptyNeeds("mainnet", TODAY), asset: "TRX", amount: "10000", endDate: addDays(TODAY, 60), expensesStated: true, bufferAmount: "0", riskProfile: "balanced", acceptUsddRisk: false, version: 1,
    expenses: [{ id: "u", date: addDays(TODAY, 7), amount: "200", asset: "USDT" }, { id: "d", date: addDays(TODAY, 30), amount: "100", asset: "USDD" }] };

  it("TRX 보유자의 USDT·USDD 지출을 오늘 환전할 TRX 필요량으로 확보한다 (역산이 실제 교환 결과를 채운다)", () => {
    const r = buildMainnetPlans(trxNeeds, { ...inputs, psm, swap }, NOW);
    expect(r.conversions?.map((c) => [c.need.asset, c.pay.asset])).toEqual([["USDT", "TRX"], ["USDD", "TRX"]]);
    const u = r.conversions![0];
    // 필요량(비용 제외)으로 교환하면 USDT 200 이상을 받는다
    const payNoCost = new Decimal(u.pay.amount).minus(u.costTrx);
    expect(trxToUsdt(swap, payNoCost).gte(200)).toBe(true);
    expect(Number(r.reserved.total)).toBeCloseTo(r.conversions!.reduce((a, c) => a + Number(c.pay.amount), 0), 6);
    expect(r.needs.expenses.map((e) => e.asset)).toEqual(["USDT", "USDD"]); // 결과에는 사용자가 말한 그대로 남긴다
  });
  it("USDT 보유자의 TRX 지출도 필요량을 역산하고, 견적이 없으면 보유액 전부를 확보하며 이유를 남긴다", () => {
    const n: UserNeeds = { ...trxNeeds, asset: "USDT", amount: "5000", expenses: [{ id: "t", date: addDays(TODAY, 7), amount: "1000", asset: "TRX" }] };
    const r = buildMainnetPlans(n, { ...inputs, swap }, NOW);
    expect(usdtToTrx(swap, new Decimal(r.conversions![0].pay.amount)).gte(1000)).toBe(true);
    const none = buildMainnetPlans(n, { ...inputs, swap: undefined }, NOW);
    expect(none.investable).toBe("0");
    expect(none.warnings.some((w) => /환전 견적이 없어/.test(w))).toBe(true);
  });
});

describe("비용 가정 (비용 기준 · Energy 조달 방식)", () => {
  const b: CostBasis = {
    ...basis,
    jTokenCosts: { jUSDT: { supply: { energy: 190000, bandwidth: 400 }, withdraw: { energy: 210000, bandwidth: 400 }, sampleSize: 30, median: { supply: { energy: 120000, bandwidth: 350 }, withdraw: { energy: 110000, bandwidth: 350 } } } },
  };
  const n: UserNeeds = { ...emptyNeeds("mainnet", TODAY), amount: "10000", endDate: addDays(TODAY, 30), expensesStated: true, bufferAmount: "0", riskProfile: "balanced", acceptUsddRisk: false, version: 1 };
  const A = (inp: object) => buildMainnetPlans(n, { ...inputs, ...inp }, NOW).plans.find((p) => p.key === "A")!;

  it("중앙값·일반값 기준은 실측 최대값보다 Energy가 적다", () => {
    const max = A({ costBasis: b });
    const med = A(applyCostOptions({ ...inputs, costBasis: b }, "median"));
    const typ = A(applyCostOptions({ ...inputs, costBasis: b }, "typical"));
    expect(max.costs.energy).toBe(23000 + 190000 + 210000);
    expect(med.costs.energy).toBe(23000 + 120000 + 110000);
    expect(typ.costs.energy).toBe(23000 + 100000 + 90000); // JustLend MCP 일반값
    expect(med.steps.find((s) => s.action === "supply")!.energySource).toMatch(/중앙값/);
  });
  it("스테이킹 방식은 Energy 소각이 없고, 필요한 스테이킹 TRX를 알려 준다", () => {
    const st = { mode: "stake" as const, burnFeeSun: 100, energyStakePerTrx: "10" };
    const r = buildMainnetPlans(n, applyCostOptions({ ...inputs, costBasis: b }, "max", st), NOW);
    const a = r.plans.find((p) => p.key === "A")!;
    expect(Number(a.costs.trx)).toBeCloseTo((400 + 400 + 265) * 1000 / 1e6, 9); // 대역폭만
    if (a.recommended) expect(r.warnings.some((w) => /스테이킹해 두어야/.test(w))).toBe(true);
  });
  it("대여 방식은 날짜별로 한 번 빌린다: 대여료 + 사용분 차감 + 최소 수수료", () => {
    const rent = { ratePerTrxSec: "0.00000000625", feeRatio: "0.00008", minFeeTrx: "20", usageChargeRatio: "0.75", durationSec: 3600 };
    const one = rentalCostTrx(233000, rent, "10");
    const trx = Math.ceil(233000 / 10);
    expect(one.toNumber()).toBeCloseTo(trx * 6.25e-9 * 3600 + trx * 6.25e-9 * 86400 * 0.75 + 20, 9);
    const a = A(applyCostOptions({ ...inputs, costBasis: b }, "max", { mode: "rent", burnFeeSun: 100, energyStakePerTrx: "10", rent }));
    // D+0(승인+예치)과 D+30(인출) 두 번 빌림
    const expected = rentalCostTrx(23000 + 190000, rent, "10").plus(rentalCostTrx(210000, rent, "10")).plus((400 + 400 + 265) * 1000 / 1e6);
    expect(Number(a.costs.trx)).toBeCloseTo(expected.toNumber(), 9);
  });
});

describe("USDD 보유자", () => {
  const psmQ: ProductQuote = { id: "psm", kind: "psm", market: "PSM", token: "USDD", address: "Tpsm", chain: "mainnet", active: true, rewards: { status: "none", note: "" }, psm: { feeIn: "0.001", feeOut: "0.002", sellEnabled: true, buyEnabled: true, entryCapacity: "1e9", exitLiquidity: "1e9" }, source: live() };
  const swap: SwapMarket = { router: "Tr", pair: "Tp", reserveUsdt: "47000000", reserveTrx: "140000000", feeNumerator: 997, costs: { toTrx: { energy: 200000, bandwidth: 500 }, toUsdt: { energy: 210000, bandwidth: 520 }, sampleSize: 10 }, source: live() };
  const bUsdd: CostBasis = { ...basis, trxPerUsdd: "2.97", psmEnergy: { sell: 250000, buy: 310000, sampleSize: 10 } };
  const inp = { ...inputs, jusdd: lending("jUSDD", "USDD", "0.02"), psm: psmQ, swap, costBasis: bUsdd };
  const n: UserNeeds = { ...emptyNeeds("mainnet", TODAY), asset: "USDD", amount: "20000", endDate: addDays(TODAY, 120), expensesStated: true, expenses: [], bufferAmount: "0", riskProfile: "aggressive", version: 1 };

  it("USDD만 보유하면 USDD 위험 동의를 묻지 않고, 대화에서 USDD 금액을 뽑는다", () => {
    expect(missingFields(n)).toEqual([]);
    const p = templateExtract("USDD 2,000을 60일 운용해요", undefined, TODAY);
    expect([p.asset, p.amount]).toEqual(["USDD", "2000"]);
  });
  it("A는 jUSDD 예치(승인 포함), B는 PSM으로 USDT를 받아 jUSDT, C는 PSM → SunSwap → 스테이킹으로 계산한다", () => {
    const r = buildMainnetPlans(n, inp, NOW);
    const A = r.plans.find((p) => p.key === "A")!;
    expect(A.steps.filter((x) => x.action !== "hold").map((x) => x.action)).toEqual(["approve", "supply", "withdraw"]);
    expect(A.steps.find((x) => x.action === "supply")!.contract).toBe("TjUSDD");
    expect(A.riskClass).toBe("stable");
    const B = r.plans.find((p) => p.key === "B")!;
    expect(B.eligibility).not.toBe("ineligible");
    expect(B.steps.filter((x) => x.action !== "hold").map((x) => x.action)).toEqual(["approve", "psm_buy", "approve", "supply", "withdraw", "approve", "psm_sell"]);
    expect(B.steps.find((x) => x.action === "supply")!.contract).toBe("TjUSDT");
    expect(B.riskClass).toBe("stable_conversion");
    const C = r.plans.find((p) => p.key === "C")!;
    expect(C.steps.filter((x) => x.action === "psm_buy" || x.action === "psm_sell").map((x) => [x.action, x.day])).toEqual([["psm_buy", 0], ["psm_sell", 120]]);
    expect(C.riskClass).toBe("volatile");
    // 거래비용은 USDD로 환산 (1 USDD = 2.97 TRX)
    expect(Number(A.costs.inAsset)).toBeCloseTo(Number(A.costs.trx) / 2.97, 9);
  });
  it("USDD 보유자의 USDT·TRX 지출은 PSM 출구 수수료(와 교환)를 포함해 USDD 필요량으로 확보한다", () => {
    const m: UserNeeds = { ...n, expenses: [{ id: "u", date: addDays(TODAY, 10), amount: "1000", asset: "USDT" }, { id: "t", date: addDays(TODAY, 20), amount: "3000", asset: "TRX" }] };
    const r = buildMainnetPlans(m, inp, NOW);
    const [u, t] = r.conversions!;
    expect(new Decimal(u.pay.amount).minus(new Decimal(u.costTrx).div("2.97")).toNumber()).toBeCloseTo(1000 * 1.002, 5);
    expect(t.route).toMatch(/PSM USDD → USDT → SunSwap/);
  });
});
