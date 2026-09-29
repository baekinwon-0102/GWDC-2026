import { describe, expect, it } from "vitest";
import { computeNileAdjustment } from "../shared/adjust";
import { addDays, applyPatch, demoNeeds, emptyNeeds, missingFields } from "../shared/needs";
import { templateExtract } from "../server/llm/template";
import { buildMainnetPlans, swapOut, type SwapMarket } from "../shared/planning";
import { Decimal } from "../shared/units";
import { rewardsFromDetail } from "../server/data/justlend";
import { replayPlan } from "../shared/replay";
import type { MarketInfo } from "../shared/screening";
import type { CostBasis, ProductQuote, UserNeeds } from "../shared/schemas";

const TODAY = "2026-09-29";
const NOW = new Date("2026-09-29T03:00:00Z");
const live = { sourceUrl: "test", chain: "mainnet" as const, fetchedAt: NOW.toISOString(), mode: "live" as const, accessMethod: "direct" as const };
const sun = (trx: number) => String(Math.round(trx * 1e6));

// ------------------------------------------------------------------ Nile 포지션 조정
// 수수료: 전액 인출 220,000 Energy → 22.3 TRX, 부분 인출 350,000 → 35.3 TRX, 예치 80,000 → 8.28 TRX
const nileBasis: Pick<CostBasis, "energyFeeSun" | "bandwidthFeeSun" | "jtrxEnergy"> = {
  energyFeeSun: 100,
  bandwidthFeeSun: 1000,
  jtrxEnergy: { mint: 80000, redeem: 220000, redeemUnderlying: 350000, sampleSize: 10 },
};
const jtrx: ProductQuote = {
  id: "nile:jTRX", kind: "lending", market: "jTRX", token: "TRX", address: "Tjtrx", chain: "nile", baseRate: "0.0000026", rateType: "APR",
  liquidity: "1000000", active: true, rewards: { status: "none", note: "" }, source: { ...live, chain: "nile" },
};
const nileNeeds = (reserve: number, days = 20): UserNeeds => ({
  chain: "nile", asset: "TRX", amount: "100", startDate: TODAY, endDate: addDays(TODAY, days), expenses: [], expensesStated: true,
  bufferAmount: String(reserve), riskProfile: "balanced", timezone: "Asia/Seoul", version: 1,
});
const adjust = (walletTrx: number, positionTrx: number, reserve: number, extra: Partial<Parameters<typeof computeNileAdjustment>[0]> = {}) =>
  computeNileAdjustment({
    needs: nileNeeds(reserve),
    planKey: "NILE_80",
    position: { walletSun: sun(walletTrx), jTokenRaw: positionTrx > 0 ? "400000000000" : "0", underlyingSun: sun(positionTrx) },
    quote: jtrx,
    costBasis: nileBasis,
    now: NOW,
    ...extra,
  });

describe("Nile 포지션 조정", () => {
  it("여유액이 늘어 지갑 유동성이 부족하면 부족분 + 부분 인출 수수료만큼 부분 인출한다", () => {
    const a = adjust(60, 80, 50); // 필요 50 + 22.3 = 72.3, 부족 12.3 + 부분 인출 수수료 35.3
    expect(a.status).toBe("adjust");
    expect(a.action?.kind).toBe("withdraw_partial");
    expect(a.action?.method).toBe("redeemUnderlying(uint256)");
    expect(a.action?.amountTrx).toBe("47.6");
    expect(a.action?.amountSun).toBe("47600000");
  });
  it("부족분이 포지션 대부분이면 전액 인출(redeem jToken 전량)로 바꾼다", () => {
    const a = adjust(30, 80, 90);
    expect(a.action?.kind).toBe("withdraw_all");
    expect(a.action?.method).toBe("redeem(uint256)");
    expect(a.action?.amountSun).toBe("400000000000");
  });
  it("인출 수수료 재원조차 없으면 거래를 만들지 않고 막는다", () => {
    const a = adjust(10, 80, 90);
    expect(a.status).toBe("blocked");
    expect(a.action).toBeUndefined();
    expect(a.summary).toMatch(/더 필요/);
  });
  it("운용 기간이 끝나면 전액 인출을 권고한다", () => {
    const a = computeNileAdjustment({ needs: nileNeeds(0, 20), position: { walletSun: sun(50), jTokenRaw: "1", underlyingSun: sun(50) }, quote: jtrx, costBasis: nileBasis, now: new Date("2026-10-20T03:00:00Z") });
    expect(a.action?.kind).toBe("withdraw_all");
    expect(a.summary).toMatch(/끝났/);
  });
  it("조건이 완화되면 추가 예치를 제안하고, 이자 < 수수료면 그 사실을 함께 알린다", () => {
    const a = adjust(100, 20, 0); // 총 120, 목표 min(120, 120 − 22.3 − 8.28) = 89.42
    expect(a.action?.kind).toBe("deposit_more");
    expect(a.action?.amountTrx).toBe("69.42");
    expect(a.action?.label).toBe("조정 권고");
    expect(a.notes.some((n) => /순수익은 음수/.test(n))).toBe(true);
  });
  it("유동성이 충분하고 목표와 차이가 작으면 유지한다", () => {
    const a = adjust(40, 60, 10);
    expect(a.status).toBe("hold_position");
    expect(a.checks.find((c) => c.label === "지갑 유동성")?.ok).toBe(true);
  });
  it("포지션이 없으면 조정하지 않는다", () => {
    expect(adjust(100, 0, 0).status).toBe("no_position");
  });
});

// ------------------------------------------------------------------ Mainnet: 보상 · 계획 C
const lending = (market: string, token: string, rate: string, extra: Partial<ProductQuote> = {}): ProductQuote => ({
  id: market, kind: "lending", market, token, address: "T" + market, chain: "mainnet", baseRate: rate, rateType: "APY", liquidity: "1000000", active: true,
  rewards: { status: "none", note: "" }, source: live, ...extra,
});
const psm: ProductQuote = {
  id: "psm", kind: "psm", market: "PSM", token: "USDD", address: "Tpsm", chain: "mainnet", active: true, rewards: { status: "none", note: "" },
  psm: { feeIn: "0", feeOut: "0", sellEnabled: true, buyEnabled: true, entryCapacity: "1000000", exitLiquidity: "1000000" }, source: live,
};
const staking: ProductQuote = {
  id: "stake", kind: "staking", market: "TRX 스테이킹 + SR 투표", token: "TRX", address: "Tsr", chain: "mainnet", baseRate: "0.0328", rateType: "APR", active: true,
  rewards: { status: "none", note: "" }, source: live,
  staking: { srAddress: "Tsr", srName: "sr", brokerage: "0", srVotes: "1", totalVotes: "44", unfreezeDelayDays: 14, voteRewardPerBlockTrx: "128", blockRewardPerBlockTrx: "8", candidates: 27 },
};
const basis: CostBasis = { energyFeeSun: 100, bandwidthFeeSun: 1000, trxPerUsdt: "3", psmEnergy: { sell: 250000, buy: 310000, sampleSize: 10 }, source: live };
const usddWithRewards = lending("jUSDD", "USDD", "0.00001", { rewards: { status: "unverified", apr: "0.04", token: "USDD", dailyAmount: "43672", note: "추정" } });
const inputs = { jusdt: lending("jUSDT", "USDT", "0.02"), jusdd: usddWithRewards, psm, staking, costBasis: basis };
const swap: SwapMarket = {
  router: "TKzxdSv2FZKQrEqkKVgp5DcwEXBEKMg2Ax", pair: "TFGDbUyP8xez44C76fin3bn3Ss6jugoUwJ", reserveUsdt: "46990000", reserveTrx: "140210000", feeNumerator: 997,
  costs: { toTrx: { energy: 130000, bandwidth: 345 }, toUsdt: { energy: 120000, bandwidth: 360 }, sampleSize: 30 }, source: live,
};

describe("JustLend 채굴 보상 (미확인 → 순수익과 분리)", () => {
  it("API 응답에서 보상 APR을 계산하고 항상 미확인으로 둔다", () => {
    const r = rewardsFromDetail({ farmRewardUSD24h: 43672, farmRewardUsddAmount24h: 43672, depositedUSD: "400000000" }, NOW.toISOString(), "Tx");
    expect(r.status).toBe("unverified");
    expect(Number(r.apr)).toBeCloseTo(0.03985, 4);
    expect(r.token).toBe("USDD");
    expect(rewardsFromDetail({ farmRewardUSD24h: 0, depositedUSD: "1" }, NOW.toISOString(), "Tx").status).toBe("none");
    expect(rewardsFromDetail(undefined, NOW.toISOString(), "Tx").status).toBe("unverified");
  });
  it("B의 순수익에는 넣지 않고, 보상과 청구 비용을 반영한 참고값만 따로 둔다", () => {
    const withR = buildMainnetPlans(demoNeeds(TODAY), inputs, NOW).plans.find((p) => p.key === "B")!;
    const noR = buildMainnetPlans(demoNeeds(TODAY), { ...inputs, jusdd: lending("jUSDD", "USDD", "0.00001") }, NOW).plans.find((p) => p.key === "B")!;
    expect(withR.netReturn).toBe(noR.netReturn);
    expect(Number(withR.rewards.amount)).toBeGreaterThan(2); // 800 × 4% × 30/365 ≈ 2.63
    // 청구 비용 60,000 Energy + 330 bytes = 6.33 TRX ÷ 3 = 2.11 USDT
    const expected = Number(withR.netReturn) + Number(withR.rewards.amount) - 6.33 / 3;
    expect(Number(withR.netWithUnverifiedRewards)).toBeCloseTo(expected, 6);
  });
});

describe("체인 실측 비용 반영", () => {
  it("jUSDT 예치·인출 실측값이 있으면 일반값 대신 쓴다 (승인은 일반값)", () => {
    const measured: CostBasis = { ...basis, jTokenCosts: { jUSDT: { supply: { energy: 192907, bandwidth: 450 }, withdraw: { energy: 214649, bandwidth: 448 }, sampleSize: 45 } } };
    const a = buildMainnetPlans(demoNeeds(TODAY), { ...inputs, costBasis: measured }, NOW).plans.find((p) => p.key === "A")!;
    expect(a.costs.energy).toBe(23000 + 192907 + 214649);
    expect(a.costs.bandwidth).toBe(265 + 450 + 448);
    expect(a.steps.find((s) => s.action === "supply")?.energySource).toMatch(/실측/);
  });
  it("보상의 달러 가치를 기초자산·평가자산 가격 비율로 환산한다", () => {
    const priced = { ...inputs, jusdt: lending("jUSDT", "USDT", "0.02", { underlyingPriceUsd: "1" }), jusdd: { ...usddWithRewards, underlyingPriceUsd: "0.98" } };
    const b = buildMainnetPlans(demoNeeds(TODAY), priced, NOW).plans.find((p) => p.key === "B")!;
    const b1 = buildMainnetPlans(demoNeeds(TODAY), inputs, NOW).plans.find((p) => p.key === "B")!;
    expect(Number(b.rewards.amount)).toBeCloseTo(Number(b1.rewards.amount) * 0.98, 8);
  });
  it("스테이킹 거래 대역폭·투표 반영 지연 실측값을 쓴다", () => {
    const st = { ...staking, staking: { ...staking.staking!, voteDelayDays: "0.25", txBandwidth: { stake: 253, vote: 272, claim: 246, unstake: 272, withdrawExpire: 272, measured: ["stake", "vote", "claim"], sampleSize: 50 } } };
    const n: UserNeeds = { ...demoNeeds(TODAY), asset: "TRX", amount: "10000", expenses: [], bufferAmount: "0", acceptUsddRisk: false };
    const c = buildMainnetPlans(n, { ...inputs, staking: st }, NOW).plans.find((p) => p.key === "C")!;
    expect(c.costs.bandwidth).toBe(253 + 272 + 246 + 272 + 272);
    expect(c.steps.find((s) => s.action === "unstake")?.energySource).toMatch(/표본 없음/);
    expect(Number(c.netReturn)).toBeCloseTo((10000 * 0.0328 * 15.75) / 365 - 1.315, 6);
  });
});

describe("계획 C: TRX 스테이킹 + SR 투표", () => {
  it("USDT 보유자인데 교환 견적이 없으면 제외하고 순수익을 산정하지 않는다 (추천에 영향 없음)", () => {
    const r = buildMainnetPlans(demoNeeds(TODAY), inputs, NOW);
    const c = r.plans.find((p) => p.key === "C")!;
    expect(c.eligibility).toBe("ineligible");
    expect(c.reasons[0]).toMatch(/교환 견적/);
    expect(c.netReturn).toBeUndefined();
    expect(r.recommendation).toEqual(buildMainnetPlans(demoNeeds(TODAY), { ...inputs, staking: undefined }, NOW).recommendation);
  });
  it("SunSwap 교환 견적이 있으면 USDT→TRX→스테이킹→USDT 왕복으로 순수익을 계산한다 (교환 손실은 전환 비용)", () => {
    const n: UserNeeds = { ...demoNeeds(TODAY), amount: "10000", endDate: addDays(TODAY, 90), expenses: [], riskProfile: "aggressive" };
    const c = buildMainnetPlans(n, { ...inputs, swap }, NOW).plans.find((p) => p.key === "C")!;
    const rU = new Decimal(swap.reserveUsdt), rT = new Decimal(swap.reserveTrx);
    const trx = swapOut(new Decimal(10000), rU, rT);
    const yieldTrx = trx.mul("0.0328").mul(90 - 14 - 0.25).div(365);
    const back = swapOut(trx.plus(yieldTrx), rT, rU);
    // 거래비용: 승인 23,000 + 교환 2회 Energy, 대역폭 265 + 교환 2회 + 시스템 거래 5회 × 300
    const energy = 23000 + swap.costs.toTrx.energy + swap.costs.toUsdt.energy;
    const bw = 265 + swap.costs.toTrx.bandwidth + swap.costs.toUsdt.bandwidth + 1500;
    expect(c.costs.energy).toBe(energy);
    expect(c.costs.bandwidth).toBe(bw);
    const txCost = (energy * 100 + bw * 1000) / 1e6 / 3;
    expect(Number(c.netReturn)).toBeCloseTo(back.toNumber() - 10000 - txCost, 6);
    expect(Number(c.costs.conversionFees)).toBeGreaterThan(10000 * 0.006 * 0.99); // 수수료 0.3% × 2
    expect(c.riskClass).toBe("volatile");
    expect(c.eligibility).toBe("eligible");
    expect(c.stress?.map((x) => x.label)).toEqual(["기간 끝 TRX 가격 -20%", "기간 끝 TRX 가격 -10%", "기간 끝 TRX 가격 +10%"]);
    expect(Number(c.stress![0].netReturn)).toBeCloseTo(back.toNumber() * 0.8 - 10000 - txCost, 6);
    // 보수적·균형형 성향은 가격 변동 자산이라 제외
    const cons = buildMainnetPlans({ ...n, riskProfile: "conservative" }, { ...inputs, swap }, NOW).plans.find((p) => p.key === "C")!;
    expect(cons.eligibility).toBe("ineligible");
  });
  it("풀 잔고 대비 교환 금액이 2%를 넘으면 가격 영향이 커 제외한다", () => {
    const n: UserNeeds = { ...demoNeeds(TODAY), amount: "2000000", endDate: addDays(TODAY, 90), expenses: [], riskProfile: "aggressive" };
    const c = buildMainnetPlans(n, { ...inputs, swap: { ...swap, reserveUsdt: "50000000", reserveTrx: "150000000" } }, NOW).plans.find((p) => p.key === "C")!;
    expect(c.reasons.some((x) => /가격 영향/.test(x))).toBe(true);
  });
  it("swapOut은 라우터 getAmountsOut과 같은 정수 연산이다", () => {
    // 1,000 USDT, 준비금 USDT 46,990,000 / TRX 140,210,000: 1000×997×140210000 ÷ (46990000×1000 + 1000×997)
    const out = swapOut(new Decimal(1000), new Decimal(46990000), new Decimal(140210000));
    const exact = (1000n * 997n * 140210000n * 1000000n) / (46990000n * 1000n + 1000n * 997n);
    expect(out.toFixed(6)).toBe(new Decimal(exact.toString()).div(1e6).toFixed(6));
  });
  it("인출일별 분산: USDT 보유자(공격적)는 오래 둘 구간을 교환 후 스테이킹할 수 있다", () => {
    const n: UserNeeds = { ...demoNeeds(TODAY), amount: "100000", endDate: addDays(TODAY, 180), expenses: [{ id: "e1", date: addDays(TODAY, 7), amount: "200", asset: "USDT", label: "지출" }], riskProfile: "aggressive" };
    const r = buildMainnetPlans(n, { ...inputs, jusdt: lending("jUSDT", "USDT", "0.001"), swap }, NOW);
    const L = r.plans.find((p) => p.key === "L")!;
    const stakeBucket = L.ladder!.find((b) => b.product === "STAKE");
    expect(stakeBucket?.needDay).toBe(180);
    expect(L.steps.filter((s) => s.action === "swap").map((s) => s.day)).toEqual([0, 180]);
    expect(L.riskClass).toBe("volatile");
  });
  it("운용 기간이 해제 대기 14일 이하이면 기간 안에 돌려받을 수 없어 제외한다", () => {
    const n = { ...demoNeeds(TODAY), endDate: addDays(TODAY, 10), expenses: [] };
    const c = buildMainnetPlans(n, inputs, NOW).plans.find((p) => p.key === "C")!;
    expect(c.reasons.some((x) => /해제 대기/.test(x))).toBe(true);
  });
  it("TRX 보유자라면 전환 없이 순수익을 계산한다 (보상 − 대역폭 비용, 공격적 성향)", () => {
    const n: UserNeeds = { ...demoNeeds(TODAY), asset: "TRX", amount: "10000", expenses: [], bufferAmount: "0", acceptUsddRisk: false, riskProfile: "aggressive" };
    const c = buildMainnetPlans(n, inputs, NOW).plans.find((p) => p.key === "C")!;
    const yieldTrx = (10000 * 0.0328 * 15.75) / 365;
    expect(Number(c.netReturn)).toBeCloseTo(yieldTrx - 1.5, 6);
    expect(c.eligibility).toBe("eligible");
  });
});

describe("위험 성향 반영", () => {
  // 10,000 USDT / 90일이면 A·A-2 모두 순수익 양수
  const big = (risk: UserNeeds["riskProfile"]): UserNeeds => ({ ...demoNeeds(TODAY), amount: "10000", endDate: addDays(TODAY, 90), riskProfile: risk });
  it("보수적: 스테이블 전환(B)·가격 변동(C)을 제외하고, 수익이 나는 계획 중 예치 비중이 가장 작은 A-2를 추천한다", () => {
    const r = buildMainnetPlans(big("conservative"), inputs, NOW);
    expect(r.plans.find((p) => p.key === "B")!.reasons.some((x) => /보수적/.test(x))).toBe(true);
    expect(r.plans.find((p) => p.key === "C")!.reasons.some((x) => /보수적/.test(x))).toBe(true);
    expect(r.plans.find((p) => p.id === r.recommendation.planId)!.key).toBe("A2");
  });
  it("균형형·공격적: 순수익이 가장 큰 계획을 추천한다 (A 전액)", () => {
    for (const risk of ["balanced", "aggressive"] as const) {
      const r = buildMainnetPlans(big(risk), inputs, NOW);
      expect(r.plans.find((p) => p.id === r.recommendation.planId)!.key).toBe("A");
    }
  });
  it("A-2는 운용 가능액의 절반만 예치하고 나머지를 보유한다", () => {
    const r = buildMainnetPlans(big("balanced"), inputs, NOW);
    const a2 = r.plans.find((p) => p.key === "A2")!;
    expect(a2.allocation.invested).toBe("4900"); // (10000 − 200) × 50%
    expect(a2.allocation.held).toBe("5100");
    expect(a2.riskClass).toBe("stable");
  });
});

describe("채굴 보상 검증 (캠페인 기간 안만 순수익에 포함)", () => {
  const campaign = { name: "USDD 2.0 공급 채굴 Phase 22", start: "2026-09-12T20:00:00+08:00", end: "2026-10-10T20:00:00+08:00", rewardToken: "USDD", distribution: "매주", eligibility: "jUSDD 공급", sources: ["x"], checks: ["y"] };
  const verifiedUsdd = lending("jUSDD", "USDD", "0.00001", { rewards: { status: "verified", apr: "0.04", token: "USDD", note: "검증", campaign } });
  it("캠페인 종료일까지의 보상만 순수익에 넣고, 이후는 미확인 참고값으로 둔다", () => {
    const r = buildMainnetPlans(demoNeeds(TODAY), { ...inputs, jusdd: verifiedUsdd }, NOW);
    const b = r.plans.find((p) => p.key === "B")!;
    const unv = buildMainnetPlans(demoNeeds(TODAY), inputs, NOW).plans.find((p) => p.key === "B")!;
    // NOW = 2026-09-29T03:00Z → 종료 2026-10-10T12:00Z 까지 11.375일
    const verified = (800 * 0.04 * 11.375) / 365;
    expect(b.rewards.status).toBe("verified");
    expect(Number(b.rewards.amount)).toBeCloseTo(verified, 6);
    expect(Number(b.netReturn)).toBeCloseTo(Number(unv.netReturn) + verified - 6.33 / 3, 6);
    expect(Number(b.netWithUnverifiedRewards)).toBeCloseTo(Number(b.netReturn) + (800 * 0.04 * (30 - 11.375)) / 365, 6);
  });
  it("캠페인이 이미 끝났으면 검증 보상은 0이다", () => {
    const ended = { ...verifiedUsdd, rewards: { ...verifiedUsdd.rewards, campaign: { ...campaign, end: "2026-09-20T20:00:00+08:00" } } };
    const b = buildMainnetPlans(demoNeeds(TODAY), { ...inputs, jusdd: ended }, NOW).plans.find((p) => p.key === "B")!;
    expect(b.rewards.status).toBe("unverified");
  });
});

describe("캠페인 보상 검증 조건 (서버)", () => {
  const hist = (n: number, paid: number) => Array.from({ length: n }, (_, i) => ({ date: `d${i}`, farmApy: i < paid ? "0.04" : "0" }));
  const d = (h: ReturnType<typeof hist>) => ({ farmRewardUSD24h: 43672, farmRewardUsddAmount24h: 43672, depositedUSD: "400000000", depositDetail: h });
  it("공지 기간 안 + 실제 지급 + 30일 연속 지급이면 verified", () => {
    const r = rewardsFromDetail(d(hist(30, 30)), NOW.toISOString(), "Tx", "jUSDD", NOW);
    expect(r.status).toBe("verified");
    expect(r.campaign?.end).toBe("2026-10-10T20:00:00+08:00");
    expect(r.campaign?.checks.length).toBeGreaterThanOrEqual(4);
  });
  it("지급이 끊긴 날이 있으면 unverified", () => {
    expect(rewardsFromDetail(d(hist(30, 25)), NOW.toISOString(), "Tx", "jUSDD", NOW).status).toBe("unverified");
  });
  it("공지 기간 밖이거나 등록된 공지가 없는 시장이면 unverified", () => {
    expect(rewardsFromDetail(d(hist(30, 30)), NOW.toISOString(), "Tx", "jUSDD", new Date("2026-10-15T00:00:00Z")).status).toBe("unverified");
    expect(rewardsFromDetail(d(hist(30, 30)), NOW.toISOString(), "Tx", "jUSDT", NOW).status).toBe("unverified");
  });
});

describe("기회 탐색 (전체 시장 심사)", () => {
  const mk = (symbol: string, base: string, extra: Partial<MarketInfo> = {}): MarketInfo => ({ symbol, jToken: "T" + symbol, baseApy: base, underlyingApy: "0", miningApy: "0", paused: false, depositedUsd: "100000000", fetchedAt: NOW.toISOString(), ...extra });
  const markets = [mk("USDT", "0.019"), mk("USDD", "0.00001", { miningApy: "0.04" }), mk("USD1", "0.029"), mk("wstUSDT", "0.005", { underlyingApy: "0.031" }), mk("TRX", "0.003"), mk("SUNOLD", "0", { paused: true })];
  it("같은 자산은 A·A-2로, USDD는 B로 분석하고 나머지는 사유와 함께 제외한다", () => {
    const r = buildMainnetPlans(demoNeeds(TODAY), { ...inputs, markets }, NOW);
    const row = (p: string) => r.screening!.find((x) => x.product === p)!;
    expect(row("jUSDT").analyzedAs).toBe("A, A2");
    expect(r.screening!.find((x) => x.product.startsWith("TRX 스테이킹"))!.analyzedAs).toBe("C (제외)");
    expect(row("jUSDD").analyzedAs).toBe("B");
    expect(row("jUSD1").verdict).toBe("excluded");
    expect(row("jUSD1").reasons[0]).toMatch(/전환 경로/);
    expect(row("jwstUSDT").totalApy).toBe("0.036");
    expect(row("jTRX").category).toBe("volatile");
    expect(row("jSUNOLD").category).toBe("paused");
    expect(r.screening!.some((x) => x.product.startsWith("USDD PSM"))).toBe(true);
    expect(r.screening!.some((x) => x.product.startsWith("TRX 스테이킹"))).toBe(true);
  });
  it("보수적 성향이면 스테이블 전환·가격 변동 자산에 성향 사유를 붙인다", () => {
    const r = buildMainnetPlans({ ...demoNeeds(TODAY), riskProfile: "conservative" }, { ...inputs, markets }, NOW);
    expect(r.screening!.find((x) => x.product === "jUSD1")!.reasons.some((x) => /보수적/.test(x))).toBe(true);
    expect(r.screening!.find((x) => x.product === "jTRX")!.reasons.some((x) => /보수적/.test(x))).toBe(true);
  });
});

describe("과거 재생 (시뮬레이션)", () => {
  const hist = Array.from({ length: 30 }, (_, i) => ({ date: `2026-09-${String(i + 1).padStart(2, "0")}`, baseApy: i < 15 ? "0.02" : "0.03", farmApy: "0", underlyingApy: "0" }));
  const markets: MarketInfo[] = [{ symbol: "USDT", jToken: "T", baseApy: "0.02", underlyingApy: "0", miningApy: "0", paused: false, depositedUsd: "1", history: hist, fetchedAt: NOW.toISOString() }];
  it("실제 일별 금리로 재생하고 계획 가정(금리 고정)과 비교한다", () => {
    const plan = buildMainnetPlans(demoNeeds(TODAY), inputs, NOW).plans.find((p) => p.key === "A")!;
    const r = replayPlan(plan, markets);
    expect(r.days).toBe(30);
    expect(r.series).toHaveLength(30);
    // 후반 15일 금리가 3%로 올라 재생 수익이 가정(2% 고정)보다 크다
    expect(Number(r.replay.baseYield)).toBeGreaterThan(Number(r.expected.baseYield));
    expect(Number(r.difference)).toBeGreaterThan(0);
    expect(r.notes[0]).toMatch(/시뮬레이션/);
  });
  it("JustLend 예치 계획이 아니면 재생하지 않는다", () => {
    const hold = buildMainnetPlans(demoNeeds(TODAY), inputs, NOW).plans.find((p) => p.key === "HOLD")!;
    expect(() => replayPlan(hold, markets)).toThrow();
  });
});

describe("Nile 리밸런스 (목표 배분 변경)", () => {
  it("목표보다 많이 예치돼 있으면 초과분을 부분 인출한다", () => {
    // 지갑 60, 포지션 80, 절반 예치안 목표 = 140 × 50% = 70 → 초과 10
    const a = adjust(60, 80, 0, { planKey: "NILE_50", mode: "rebalance" });
    expect(a.action?.kind).toBe("withdraw_partial");
    expect(a.action?.amountTrx).toBe("10");
    expect(a.summary).toMatch(/리밸런스/);
  });
  it("모니터링 모드에서는 초과 예치를 건드리지 않는다", () => {
    expect(adjust(60, 80, 0, { planKey: "NILE_50" }).status).toBe("hold_position");
  });
  it("목표보다 적게 예치돼 있으면 추가 예치를 제안한다", () => {
    const a = adjust(100, 20, 0, { planKey: "NILE_80", mode: "rebalance" });
    expect(a.action?.kind).toBe("deposit_more");
  });
});

describe("보유 자산 TRX 선택", () => {
  const jtrxQ = lending("jTRX", "TRX", "0.00316", { rateType: "APY" });
  const trxNeeds = (risk: UserNeeds["riskProfile"] = "balanced"): UserNeeds => ({
    ...demoNeeds(TODAY), asset: "TRX", amount: "10000", endDate: addDays(TODAY, 90), expenses: [], bufferAmount: "0", acceptUsddRisk: undefined, riskProfile: risk,
  });
  it("A·A-2는 jTRX 예치로 계산하고 승인 단계가 없으며 비용은 TRX로 평가한다", () => {
    const r = buildMainnetPlans(trxNeeds(), { ...inputs, jtrx: jtrxQ }, NOW);
    const a = r.plans.find((p) => p.key === "A")!;
    expect(a.title).toMatch(/jTRX/);
    expect(a.steps.some((s) => s.action === "approve")).toBe(false);
    expect(a.costs.inAsset).toBe(a.costs.trx);
    expect(a.allocation.invested).toBe("10000");
  });
  it("B(USDD 경로)는 TRX→USDT 교환 비용 미검증으로 제외한다", () => {
    const b = buildMainnetPlans(trxNeeds(), { ...inputs, jtrx: jtrxQ }, NOW).plans.find((p) => p.key === "B")!;
    expect(b.eligibility).toBe("ineligible");
    expect(b.reasons[0]).toMatch(/TRX→USDT/);
    expect(b.netReturn).toBeUndefined();
  });
  it("C(스테이킹)는 보유 자산 그대로라 균형형에서도 후보가 되고 순수익을 계산한다", () => {
    const r = buildMainnetPlans(trxNeeds("balanced"), { ...inputs, jtrx: jtrxQ }, NOW);
    const c = r.plans.find((p) => p.key === "C")!;
    expect(c.riskClass).toBe("stable");
    expect(c.eligibility).toBe("eligible");
    expect(Number(c.netReturn)).toBeGreaterThan(0);
    // 스테이킹 3.28% > jTRX 0.32%라 균형형 추천은 C
    expect(r.plans.find((p) => p.id === r.recommendation.planId)!.key).toBe("C");
  });
  it("TRX 보유자에게도 USDD 위험을 묻는다 (교환 후 USDD 경로가 가능)", () => {
    const n = { ...trxNeeds(), riskProfile: "balanced" as const };
    expect(missingFields(n)).toEqual(["acceptUsddRisk"]);
    expect(missingFields({ ...n, acceptUsddRisk: false })).toEqual([]);
  });
  it("대화에서 TRX 금액을 말하면 자산을 TRX로 바꾼다", () => {
    const p = templateExtract("10,000 TRX를 90일 운용할게요", undefined, TODAY);
    expect(p.asset).toBe("TRX");
    expect(applyPatch(emptyNeeds("mainnet", TODAY), p).needs.asset).toBe("TRX");
  });
});

describe("인출일별 분산 계획 (L)", () => {
  const jtrxQ = lending("jTRX", "TRX", "0.00316");
  const exp = (inDays: number, amount: string, asset = "USDT") => ({ id: `e${inDays}`, date: addDays(TODAY, inDays), amount, asset });
  it("지출일별로 구간을 나누고, 단일 계획 A보다 나쁘지 않다", () => {
    const n: UserNeeds = { ...demoNeeds(TODAY), amount: "60000", endDate: addDays(TODAY, 90), expenses: [exp(7, "200"), exp(60, "30000")] };
    const r = buildMainnetPlans(n, inputs, NOW);
    const L = r.plans.find((p) => p.key === "L")!;
    const A = r.plans.find((p) => p.key === "A")!;
    expect(L.ladder!.map((b) => b.needDay)).toEqual([7, 60, 90]);
    expect(Number(L.netReturn)).toBeGreaterThanOrEqual(Number(A.netReturn));
    // 7일 뒤 쓸 200은 보유, 60일 뒤 쓸 30,000은 예치 (예치는 한 번, 인출은 날짜마다)
    expect(L.ladder![0].product).toBe("HOLD");
    expect(L.ladder![1].product).toBe("LEND");
    expect(L.steps.filter((s) => s.action === "supply")).toHaveLength(1);
    expect(L.steps.filter((s) => s.action === "withdraw").map((s) => s.day)).toEqual([60, 90]);
    expect(Number(L.netReturn)).toBeGreaterThan(Number(A.netReturn)); // A는 60일 뒤 쓸 돈을 놀린다
  });
  it("수익이 나는 구간이 없으면 모두 보유한다 (1,000 USDT / 30일)", () => {
    const L = buildMainnetPlans(demoNeeds(TODAY), inputs, NOW).plans.find((p) => p.key === "L")!;
    expect(L.ladder!.every((b) => b.product === "HOLD")).toBe(true);
    expect(L.netReturn).toBe("0");
  });
  it("TRX 보유자: 짧은 지출도 스테이킹으로 굴리고, 인출일 14일 전에 해제한다", () => {
    const n: UserNeeds = { ...demoNeeds(TODAY), asset: "TRX", amount: "10000", endDate: addDays(TODAY, 90), expenses: [exp(20, "2000", "TRX"), exp(45, "3000", "TRX")], bufferAmount: "0", acceptUsddRisk: undefined, riskProfile: "balanced" };
    const r = buildMainnetPlans(n, { ...inputs, jtrx: jtrxQ }, NOW);
    const L = r.plans.find((p) => p.key === "L")!;
    const C = r.plans.find((p) => p.key === "C")!;
    expect(L.ladder!.map((b) => b.product)).toEqual(["STAKE", "STAKE", "STAKE"]);
    expect(L.steps.filter((s) => s.action === "unstake").map((s) => s.day)).toEqual([6, 31, 76]);
    expect(Number(L.netReturn)).toBeGreaterThan(Number(C.netReturn)); // C는 지출 재원을 놀린다
    expect(r.plans.find((p) => p.id === r.recommendation.planId)!.key).toBe("L");
  });
  it("해제 대기보다 짧은 구간은 스테이킹할 수 없어 보유하고 사유를 남긴다", () => {
    const n: UserNeeds = { ...demoNeeds(TODAY), asset: "TRX", amount: "10000", endDate: addDays(TODAY, 90), expenses: [exp(10, "2000", "TRX")], bufferAmount: "500", acceptUsddRisk: undefined, riskProfile: "balanced" };
    const L = buildMainnetPlans(n, { ...inputs, jtrx: jtrxQ }, NOW).plans.find((p) => p.key === "L")!;
    expect(L.ladder![0]).toMatchObject({ needDay: 0, product: "HOLD" }); // 비상 여유액
    expect(L.ladder![1]).toMatchObject({ needDay: 10, product: "HOLD" });
    expect(L.ladder![1].alternatives.find((a) => /스테이킹/.test(a.product))?.note).toMatch(/해제 대기/);
  });
});
