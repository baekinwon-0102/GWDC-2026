import { describe, expect, it } from "vitest";
import { applyPatch, demoNeeds, emptyNeeds, inputProblems, missingFields, reservedWithinHorizon } from "../shared/needs";
import { baseYield, breakEvenDays, buildMainnetPlans, buildNilePlans } from "../shared/planning";
import { Decimal, fromBaseUnits, toBaseUnits } from "../shared/units";
import type { CostBasis, ProductQuote, UserNeeds } from "../shared/schemas";

const TODAY = "2026-09-29";
const NOW = new Date("2026-09-29T03:00:00Z");
const live = (chain: "mainnet" | "nile" = "mainnet") => ({ sourceUrl: "test", chain, fetchedAt: NOW.toISOString(), mode: "live" as const, accessMethod: "direct" as const });

function lending(market: string, token: string, rate: string, extra: Partial<ProductQuote> = {}): ProductQuote {
  return { id: market, kind: "lending", market, token, address: "T" + market, chain: "mainnet", baseRate: rate, rateType: "APY", liquidity: "1000000", active: true, rewards: { status: "unverified", note: "" }, source: live(), ...extra };
}
const psm = (over: Partial<NonNullable<ProductQuote["psm"]>> = {}): ProductQuote => ({
  id: "psm", kind: "psm", market: "PSM", token: "USDD", address: "Tpsm", chain: "mainnet", active: true,
  rewards: { status: "none", note: "" },
  psm: { feeIn: "0", feeOut: "0", sellEnabled: true, buyEnabled: true, entryCapacity: "1000000", exitLiquidity: "1000000", ...over },
  source: live(),
});
const basis = (over: Partial<CostBasis> = {}): CostBasis => ({ energyFeeSun: 100, bandwidthFeeSun: 1000, trxPerUsdt: "3", psmEnergy: { sell: 250000, buy: 310000, sampleSize: 10 }, source: live(), ...over });

describe("units", () => {
  it("문자열 금액을 최소 단위로 정확히 변환한다", () => {
    expect(toBaseUnits("1000.123456", 6)).toBe(1000123456n);
    expect(fromBaseUnits(1000123456n, 6)).toBe("1000.123456");
    expect(toBaseUnits("0.1", 18)).toBe(10n ** 17n);
    expect(() => toBaseUnits("1.0000001", 6)).toThrow();
    expect(new Decimal("0.1").plus("0.2").toFixed()).toBe("0.3");
  });
});

describe("수익 계산", () => {
  it("APY는 복리, APR은 단리로 계산한다 (800 USDT, 30일, 5%)", () => {
    const apy = baseYield(new Decimal(800), new Decimal("0.05"), "APY", 30);
    const apr = baseYield(new Decimal(800), new Decimal("0.05"), "APR", 30);
    expect(apy.toFixed(2)).toBe("3.21"); // 문서의 설명용 예시와 일치
    expect(apr.toFixed(4)).toBe("3.2876");
  });
  it("손익분기 기간: 금리가 0이면 산정 불가", () => {
    expect(breakEvenDays(new Decimal(800), new Decimal(0), "APY", new Decimal(1))).toBeUndefined();
    const d = breakEvenDays(new Decimal(800), new Decimal("0.05"), "APY", new Decimal("3.21"))!;
    expect(Math.round(d.toNumber())).toBe(30);
  });
});

describe("요구사항 상태", () => {
  it("누락 항목을 코드가 판정하고 날짜가 빠지면 질문한다", () => {
    const { needs } = applyPatch(emptyNeeds("mainnet", TODAY), { amount: "1000" });
    expect(missingFields(needs)).toEqual(["endDate", "expenses", "bufferAmount", "riskProfile", "acceptUsddRisk"]);
  });
  it("여유액을 지출마다 중복 합산하지 않는다", () => {
    const n: UserNeeds = { ...demoNeeds(TODAY), bufferAmount: "50", expenses: [
      { id: "1", date: "2026-10-01", amount: "100", asset: "USDT" },
      { id: "2", date: "2026-10-05", amount: "100", asset: "USDT" },
    ] };
    expect(reservedWithinHorizon(n).total.toFixed()).toBe("250");
  });
  it("확보액이 보유액보다 크면 계획을 만들지 않는다", () => {
    const n: UserNeeds = { ...demoNeeds(TODAY), amount: "100" };
    expect(inputProblems(n).some((p) => p.includes("보다 큽니다"))).toBe(true);
  });
  it("다른 자산 지출은 USDT·TRX·USDD면 허용하고(환전해서 냄), 그 밖의 자산은 막는다", () => {
    const n: UserNeeds = { ...demoNeeds(TODAY), expenses: [{ id: "1", date: "2026-10-01", amount: "10", asset: "TRX" }] };
    expect(inputProblems(n)).toEqual([]);
    expect(inputProblems({ ...n, expenses: [{ id: "1", date: "2026-10-01", amount: "10", asset: "BTC" }] }).length).toBe(1);
  });
  it("입력이 바뀌면 버전이 올라간다 (확인 무효화 근거)", () => {
    const n = demoNeeds(TODAY);
    expect(applyPatch(n, { expenses: [{ inDays: 45, amount: "200" }] }).needs.version).toBe(n.version + 1);
    expect(applyPatch(n, { amount: "1000" }).needs.version).toBe(n.version);
  });
});

describe("Mainnet 계획", () => {
  const inputs = { jusdt: lending("jUSDT", "USDT", "0.05"), jusdd: lending("jUSDD", "USDD", "0.06"), psm: psm(), costBasis: basis() };

  it("고정 사례: 7일 뒤 지출이면 800, 45일 뒤로 옮기면 1,000 USDT를 운용한다", () => {
    const n7 = demoNeeds(TODAY);
    const r7 = buildMainnetPlans(n7, inputs, NOW);
    expect(r7.investable).toBe("800");
    expect(r7.plans.find((p) => p.key === "A")!.allocation.invested).toBe("800");
    const n45 = applyPatch(n7, { expenses: [{ inDays: 45, amount: "200", asset: "USDT" }] }).needs;
    const r45 = buildMainnetPlans(n45, inputs, NOW);
    expect(r45.investable).toBe("1000");
    expect(r45.reserved.outsideHorizon).toHaveLength(1);
  });

  it("USDD 위험을 거부하면 B를 제외한다", () => {
    const r = buildMainnetPlans({ ...demoNeeds(TODAY), acceptUsddRisk: false }, inputs, NOW);
    const B = r.plans.find((p) => p.key === "B")!;
    expect(B.eligibility).toBe("ineligible");
    expect(B.recommended).toBe(false);
  });

  it("PSM은 수익원이 아니다: B의 이자는 jUSDD 금리에서만 나온다", () => {
    const r = buildMainnetPlans(demoNeeds(TODAY), { ...inputs, jusdd: lending("jUSDD", "USDD", "0") }, NOW);
    expect(r.plans.find((p) => p.key === "B")!.baseYield).toBe("0");
  });

  it("왕복 비용이 이자보다 크면 음수 순익을 그대로 보이고 보유를 권고한다", () => {
    const r = buildMainnetPlans(demoNeeds(TODAY), { ...inputs, jusdt: lending("jUSDT", "USDT", "0.02"), jusdd: lending("jUSDD", "USDD", "0.00001") }, NOW);
    const A = r.plans.find((p) => p.key === "A")!;
    expect(new Decimal(A.netReturn!).lt(0)).toBe(true);
    expect(r.plans.find((p) => p.recommended)!.key).toBe("HOLD");
  });

  it("비용이 이익보다 작으면 순수익이 큰 계획을 추천한다", () => {
    const r = buildMainnetPlans({ ...demoNeeds(TODAY), amount: "1000000" }, inputs, NOW);
    expect(r.plans.find((p) => p.recommended)!.key).not.toBe("HOLD");
  });

  it("TRX 환산 근거가 없으면 순수익 산정 불가", () => {
    const r = buildMainnetPlans(demoNeeds(TODAY), { ...inputs, costBasis: basis({ trxPerUsdt: undefined }) }, NOW);
    expect(r.plans.find((p) => p.key === "A")!.netReturn).toBeUndefined();
    expect(r.plans.find((p) => p.recommended)!.key).toBe("HOLD");
  });

  it("보상이 미확인이면 기본 수익에서 제외한다", () => {
    const r = buildMainnetPlans(demoNeeds(TODAY), inputs, NOW);
    expect(r.plans.find((p) => p.key === "A")!.rewards.status).toBe("unverified");
  });

  it("PSM 출구 물량 부족·비활성 시장·체인 불일치·오래된 데이터는 실행을 제한한다", () => {
    const n = demoNeeds(TODAY);
    expect(buildMainnetPlans(n, { ...inputs, psm: psm({ exitLiquidity: "10" }) }, NOW).plans.find((p) => p.key === "B")!.eligibility).toBe("ineligible");
    expect(buildMainnetPlans(n, { ...inputs, jusdt: lending("jUSDT", "USDT", "0.05", { active: false }) }, NOW).plans.find((p) => p.key === "A")!.eligibility).toBe("ineligible");
    expect(buildMainnetPlans(n, { ...inputs, jusdt: lending("jUSDT", "USDT", "0.05", { chain: "nile" }) }, NOW).plans.find((p) => p.key === "A")!.eligibility).toBe("ineligible");
    const later = new Date(NOW.getTime() + 11 * 60 * 1000);
    expect(buildMainnetPlans(n, inputs, later).plans.find((p) => p.key === "A")!.eligibility).toBe("ineligible");
  });

  it("가상 데이터는 조건부로만 판정한다", () => {
    const syn = { ...live(), mode: "synthetic" as const };
    const r = buildMainnetPlans(demoNeeds(TODAY), { ...inputs, jusdt: lending("jUSDT", "USDT", "0.05", { source: syn }) }, NOW);
    expect(r.plans.find((p) => p.key === "A")!.eligibility).toBe("conditional");
  });

  it("같은 입력과 quote면 결과가 같다 (LLM 공급자와 무관)", () => {
    const a = buildMainnetPlans(demoNeeds(TODAY), inputs, NOW, "x");
    const b = buildMainnetPlans(demoNeeds(TODAY), inputs, NOW, "x");
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("Nile 계획", () => {
  const jtrx: ProductQuote = { ...lending("jTRX", "TRX", "0.03"), chain: "nile", rateType: "APR", source: live("nile") };
  const nileNeeds: UserNeeds = { ...emptyNeeds("nile", TODAY), amount: "100", endDate: "2026-10-29", expensesStated: true, bufferAmount: "20", riskProfile: "balanced", version: 1 };

  it("수수료 재원을 남기도록 예치액을 줄인다 (예치액 ≤ 총잔고 − 확보액 − 비용 예산)", () => {
    const r = buildNilePlans(nileNeeds, { jtrx, costBasis: basis({ source: live("nile") }) }, NOW);
    const p80 = r.plans.find((p) => p.key === "NILE_80")!;
    const p50 = r.plans.find((p) => p.key === "NILE_50")!;
    // 비용 예산 = (80000+90000)*100 + (280+300)*1000 sun = 17.58 TRX
    expect(p80.allocation.invested).toBe("62.42");
    expect(p50.allocation.invested).toBe("50");
  });

  it("순익이 음수면 보유를 권고하되 계획은 그대로 실행 가능하게 둔다", () => {
    const r = buildNilePlans(nileNeeds, { jtrx: { ...jtrx, baseRate: "0.000003" }, costBasis: basis({ source: live("nile") }) }, NOW);
    expect(r.plans.find((p) => p.key === "NILE_80")!.label).toBe("Nile 실행 계획");
    expect(r.plans.find((p) => p.key === "NILE_80")!.eligibility).not.toBe("ineligible");
    expect(r.plans.find((p) => p.recommended)!.key).toBe("HOLD");
  });

  it("지갑 잔고가 있으면 입력 금액 대신 실제 잔고를 쓴다", () => {
    const r = buildNilePlans(nileNeeds, { jtrx, costBasis: basis({ source: live("nile") }), walletBalanceTrx: "40" }, NOW);
    expect(r.plans.find((p) => p.key === "NILE_80")!.allocation.invested).toBe("2.42");
  });
  // Nile 체인 파라미터: 해제 대기 1일, 유지보수 30분
  const nileStaking: ProductQuote = {
    id: "nile:TRX-STAKE-VOTE", kind: "staking", market: "TRX 스테이킹 + SR 투표", token: "TRX", address: "TSr", chain: "nile", baseRate: "0.2", rateType: "APR", active: true,
    rewards: { status: "none", note: "-" },
    staking: { srAddress: "TSr", srName: "nile-sr", brokerage: "0.2", srVotes: "1", totalVotes: "1", unfreezeDelayDays: 1, voteRewardPerBlockTrx: "128", blockRewardPerBlockTrx: "8", candidates: 27, voteDelayDays: "0.0208" },
    source: live("nile"),
  };
  const bigNeeds: UserNeeds = { ...nileNeeds, amount: "10000", bufferAmount: "0", expenses: [{ id: "e", date: "2026-10-06", amount: "2000", asset: "TRX", label: "D+7 지출" }] };

  it("같은 계획 엔진으로 Nile 스테이킹(C)·인출일별 분산(L)·제외 경로(B)를 계산한다", () => {
    const r = buildNilePlans(bigNeeds, { jtrx, staking: nileStaking, costBasis: basis({ source: live("nile") }) }, NOW);
    const keys = r.plans.map((p) => p.key);
    expect(keys).toEqual(["NILE_80", "NILE_50", "B", "C", "L", "HOLD"]);
    expect(r.plans.every((p) => p.chain === "nile")).toBe(true);
    const b = r.plans.find((p) => p.key === "B")!;
    expect(b.eligibility).toBe("ineligible");
    expect(b.reasons[0]).toMatch(/교환 견적/); // 이 입력에는 Nile SunSwap 경로가 없다
    const c = r.plans.find((p) => p.key === "C")!;
    expect(c.eligibility).not.toBe("ineligible");
    // 해제 대기 1일: 보상 기간 = 30 − 1 − 0.0208일, 해제는 D+29
    expect(c.steps.find((s) => s.action === "unstake")?.day).toBe(29);
    expect(c.steps.find((s) => s.action === "stake")?.day).toBe(0);
    const L = r.plans.find((p) => p.key === "L")!;
    // D+7에 필요한 2,000 TRX도 해제 대기(1일)가 짧아 스테이킹할 수 있다
    expect(L.ladder!.map((x) => x.needDay)).toEqual([7, 30]);
    expect(L.ladder!.every((x) => x.product === "STAKE")).toBe(true);
    expect(L.steps.find((s) => s.action === "unstake" && s.day === 6)).toBeTruthy();
    expect(r.screening?.some((x) => x.category === "staking")).toBe(true);
    expect(r.recommendation.planId).toBe(r.plans.find((p) => p.recommended)!.id);
  });

  it("Mainnet 데이터가 섞이면 체인 불일치로 제외한다", () => {
    const r = buildNilePlans(bigNeeds, { jtrx, staking: { ...nileStaking, chain: "mainnet", source: live() }, costBasis: basis({ source: live("nile") }) }, NOW);
    expect(r.plans.find((p) => p.key === "C")!.reasons.some((x) => /체인/.test(x))).toBe(true);
  });

  it("위험 성향이 추천에 반영된다 (보수적은 수익 나는 계획 중 예치 비중 최소)", () => {
    const r = buildNilePlans({ ...bigNeeds, riskProfile: "conservative" }, { jtrx, staking: nileStaking, costBasis: basis({ source: live("nile") }) }, NOW);
    const rec = r.plans.find((p) => p.recommended)!;
    const positive = r.plans.filter((p) => p.key !== "HOLD" && p.eligibility !== "ineligible" && Number(p.netReturn) > 0);
    expect(Number(rec.allocation.invested)).toBe(Math.min(...positive.map((p) => Number(p.allocation.invested))));
  });
});
