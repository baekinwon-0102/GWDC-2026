import { Decimal } from "./units";
import { daysBetween, reservedWithinHorizon } from "./needs";
import { dataIssues, lendingIssues, lendingWarnings, psmIssues } from "./eligibility";
import { prefersLowExposure, RISK_KO, riskBlock } from "./risk";
import { buildScreening, type MarketInfo } from "./screening";
import { buildLadderPlan } from "./ladder";
import { costAssumption, energyCostTrx, stakeNeedNote, statKo } from "./costmode";
import { convertExpenses } from "./fx";
import type { CostBasis, DataMode, Plan, PlanCosts, PlanStep, PlanningResult, ProductQuote, RiskProfile, SourceMeta, UserNeeds } from "./schemas";

export const ENGINE_VERSION = "planning-1.0.0";

/**
 * 거래 유형별 일반 Energy/Bandwidth 사용량.
 * 출처: JustLend 공식 MCP 서버 src/core/services/lending.ts (TYPICAL_RESOURCES).
 * PSM 전환은 최근 성공 거래 실측값(CostBasis.psmEnergy)을 쓴다.
 */
export const TYPICAL_RESOURCES = {
  approve: { energy: 23000, bandwidth: 265 },
  supply_trx: { energy: 80000, bandwidth: 280 },
  supply_trc20: { energy: 100000, bandwidth: 310 },
  withdraw: { energy: 90000, bandwidth: 300 },
  psm: { bandwidth: 345 },
  /** 채굴 보상 청구(multiClaim). 출처 같음 (claim_rewards) */
  claim_rewards: { energy: 60000, bandwidth: 330 },
} as const;
export const JUSTLEND_RES_SRC = "JustLend MCP TYPICAL_RESOURCES (일반값)";
/** TRON 시스템 계약(FreezeBalanceV2·VoteWitness·WithdrawBalance·UnfreezeBalanceV2·WithdrawExpireUnfreeze)은 Energy 없이 대역폭만 쓴다 */
export const SYSTEM_TX = { energy: 0, bandwidth: 300 };
export const SYSTEM_TX_SRC = "TRON 시스템 계약 거래 크기 추정 (보수적 300 bytes, 무료 대역폭 미반영)";

const ZERO = new Decimal(0);

/** 기본 수익: APY면 복리, APR이면 단리 */
export function baseYield(principal: Decimal, rate: Decimal, rateType: "APY" | "APR", days: number): Decimal {
  if (principal.lte(0) || days <= 0) return ZERO;
  if (rateType === "APY") return principal.mul(rate.plus(1).pow(new Decimal(days).div(365)).minus(1));
  return principal.mul(rate).mul(days).div(365);
}

/** 고정 금리·비용 가정에서 기본 수익이 비용을 넘는 데 필요한 일수 */
export function breakEvenDays(principal: Decimal, rate: Decimal, rateType: "APY" | "APR", cost: Decimal): Decimal | undefined {
  if (principal.lte(0) || rate.lte(0)) return undefined;
  if (cost.lte(0)) return ZERO;
  if (rateType === "APY") return new Decimal(365).mul(cost.div(principal).plus(1).ln()).div(rate.plus(1).ln());
  return cost.mul(365).div(principal.mul(rate));
}

/** 순수익을 평가하는 자산 (보유 자산) */
export type EvalAsset = "USDT" | "TRX" | "USDD";

export function stepCosts(steps: PlanStep[], basis: CostBasis | undefined, evalAsset: EvalAsset, conversionFees = ZERO): PlanCosts {
  const energy = steps.reduce((s, x) => s + x.energy, 0);
  const bandwidth = steps.reduce((s, x) => s + x.bandwidth, 0);
  if (!basis) return { energy, bandwidth, trx: "0", inAsset: undefined, conversionFees: conversionFees.toFixed() };
  // Energy는 조달 방식(소각·스테이킹·대여)에 따라, 대역폭은 소각으로 환산한다
  const trx = energyCostTrx(steps, basis).plus(new Decimal(bandwidth * basis.bandwidthFeeSun).div(1_000_000));
  let inAsset: Decimal | undefined;
  const per = evalAsset === "USDD" ? (basis.trxPerUsdd ?? basis.trxPerUsdt) : basis.trxPerUsdt;
  if (evalAsset === "TRX") inAsset = trx;
  else if (per && new Decimal(per).gt(0)) inAsset = trx.div(per);
  return { energy, bandwidth, trx: trx.toFixed(), inAsset: inAsset?.toFixed(), conversionFees: conversionFees.toFixed() };
}

export const step = (
  action: PlanStep["action"],
  label: string,
  asset: string,
  amount: Decimal,
  res: { energy: number; bandwidth: number },
  energySource: string,
  contract?: string,
): PlanStep => ({ action, label, asset, amount: amount.toFixed(), contract, energy: res.energy, bandwidth: res.bandwidth, energySource });

function modesOf(...qs: (ProductQuote | undefined)[]): DataMode[] {
  return [...new Set(qs.filter(Boolean).map((q) => q!.source.mode))];
}

export interface MainnetInputs {
  jusdt?: ProductQuote;
  jusdd?: ProductQuote;
  psm?: ProductQuote;
  /** TRX 스테이킹 + SR 투표 (계획 C) */
  staking?: ProductQuote;
  /** Mainnet jTRX (보유 자산이 TRX일 때 계획 A·A-2) */
  jtrx?: ProductQuote;
  /** 기회 탐색용 JustLend 전체 시장 */
  markets?: MarketInfo[];
  /** SunSwap V2 USDT↔TRX 풀 (USDT 보유자의 TRX 스테이킹 경로) */
  swap?: SwapMarket;
  /** USDD 자체 저축 상품(sUSDD) 배포·금리 상태 */
  usddSavings?: UsddSavings;
  costBasis?: CostBasis;
}

/** USDD 저축(sUSDD): USDD 공식 앱 API의 체인별 저축 금리·예치 규모와 TRON 체인 등록부(chainlog) 등록 여부 */
export interface UsddSavings {
  tron: { apy?: string; earnTvl: string; registered: boolean };
  otherChains: { chain: string; apy?: string; earnTvl: string }[];
  source: SourceMeta;
}

/** SunSwap V2 USDT↔TRX 경로 상태와 교환 거래 비용 실측값 */
export interface SwapMarket {
  router: string;
  pair: string;
  /** USDT → TRX 방향 토큰 경로 (실행용) */
  path?: string[];
  usdt?: string;
  /** 첫 단계의 USDT 쪽 준비금과 마지막 단계의 TRX 쪽 준비금 (한 단계면 그 페어의 준비금) */
  reserveUsdt: string;
  reserveTrx: string;
  /** 두 단계 이상이면 단계별 준비금 (USDT 쪽 → TRX 쪽 순서) */
  hops?: { reserveUsdtSide: string; reserveTrxSide: string }[];
  /**
   * USDT와 V2 풀 사이를 PSM으로 잇는 경우 (Nile: USDT 2.0은 전송 반환값이 false라 V2 풀이 내보내지 못해, USDD(구) PSM으로 1:1 전환).
   * 이때 hops의 "USDT 쪽"은 브리지 토큰(USDD 구버전)이다. feeIn = USDT→브리지(sellGem tin), feeOut = 브리지→USDT(buyGem tout)
   */
  bridge?: { psm: string; gemJoin: string; token: string; symbol: string; feeIn: string; feeOut: string; energy?: { sell: number; buy: number } };
  /** 수수료 반영 분자 (V2: 997/1000 = 0.3%) */
  feeNumerator: number;
  costs: { toTrx: { energy: number; bandwidth: number }; toUsdt: { energy: number; bandwidth: number }; sampleSize: number; median?: { toTrx: number; toUsdt: number } };
  source: SourceMeta;
}

/** UniswapV2 식 교환 결과: out = in×fee×R_out ÷ (R_in×1000 + in×fee), 6자리 내림 (라우터 getAmountsOut과 같은 정수 연산) */
export function swapOut(amountIn: Decimal, reserveIn: Decimal, reserveOut: Decimal, feeNumerator = 997): Decimal {
  if (amountIn.lte(0)) return ZERO;
  const inFee = amountIn.mul(feeNumerator);
  return inFee.mul(reserveOut).div(reserveIn.mul(1000).plus(inFee)).toDecimalPlaces(6, Decimal.ROUND_DOWN);
}

const hopsOf = (sw: SwapMarket) => sw.hops ?? [{ reserveUsdtSide: sw.reserveUsdt, reserveTrxSide: sw.reserveTrx }];
/** USDT → TRX (브리지 PSM이 있으면 먼저 USDT → 브리지 토큰, 그다음 경로의 모든 단계를 차례로) */
export function usdtToTrx(sw: SwapMarket, usdt: Decimal): Decimal {
  const start = sw.bridge ? usdt.mul(new Decimal(1).minus(sw.bridge.feeIn)) : usdt;
  return hopsOf(sw).reduce((a, h) => swapOut(a, new Decimal(h.reserveUsdtSide), new Decimal(h.reserveTrxSide), sw.feeNumerator), start);
}
/** TRX → USDT (역순, 마지막에 브리지 토큰 → USDT) */
export function trxToUsdt(sw: SwapMarket, trx: Decimal): Decimal {
  const out = [...hopsOf(sw)].reverse().reduce((a, h) => swapOut(a, new Decimal(h.reserveTrxSide), new Decimal(h.reserveUsdtSide), sw.feeNumerator), trx);
  return sw.bridge ? out.div(new Decimal(1).plus(sw.bridge.feeOut)).toDecimalPlaces(6, Decimal.ROUND_DOWN) : out;
}
/** 풀 중간 가격: 1 TRX의 USDT 가치 */
export function trxMidUsdt(sw: SwapMarket): Decimal {
  return hopsOf(sw).reduce((m, h) => m.mul(new Decimal(h.reserveUsdtSide).div(h.reserveTrxSide)), new Decimal(1));
}

/**
 * USDT → TRX → (기간 뒤) TRX → USDT 왕복. 출구 시 풀 가격이 지금과 같다고 가정한다 (가격 변동은 스트레스로 따로 본다).
 * 반환: 진입 TRX, 수수료·가격 영향으로 잃는 USDT(원금 기준)
 */
export function swapRoundTrip(sw: SwapMarket, usdtIn: Decimal, trxExtra = ZERO) {
  const trx = usdtToTrx(sw, usdtIn);
  const usdtBack = trxToUsdt(sw, trx.plus(trxExtra));
  const mid = trxMidUsdt(sw);
  const extraUsdt = trxExtra.mul(mid);
  return { trx, usdtBack, mid, loss: usdtIn.plus(extraUsdt).minus(usdtBack), impactPct: usdtIn.gt(0) ? usdtIn.div(sw.reserveUsdt).mul(100) : ZERO };
}

/** Mainnet jToken 예치·인출 자원: 체인 실측값이 있으면 쓰고, 없으면 JustLend MCP 일반값 */
export function jTokenResources(basis: CostBasis | undefined, market: string) {
  const m = basis?.jTokenCosts?.[market];
  return m
    ? { supply: m.supply, withdraw: m.withdraw, src: `${market} 최근 성공 거래 ${m.sampleSize}건 ${statKo(basis)}` }
    : { supply: market === "jTRX" ? TYPICAL_RESOURCES.supply_trx : TYPICAL_RESOURCES.supply_trc20, withdraw: TYPICAL_RESOURCES.withdraw, src: JUSTLEND_RES_SRC };
}

/**
 * 채굴 보상. 공지로 확인한 캠페인 기간 안의 보상(verified)만 순수익에 넣고(청구 비용 차감),
 * 캠페인이 끝난 뒤 기간이나 규칙을 확인하지 못한 보상은 미확인 참고값(remainder)으로 둔다.
 * 보상 APR은 달러 기준이므로 원금의 달러 가치(기초자산 가격 ÷ 평가 자산 가격)로 환산한다. 가격이 없으면 1:1.
 */
function rewardsFor(q: ProductQuote | undefined, principal: Decimal, days: number, basis: CostBasis | undefined, assetPriceUsd: string | undefined, now: Date, endDate: string | undefined, evalAsset: EvalAsset = "USDT") {
  const base = q?.rewards ?? { status: "unverified" as const, note: "보상 데이터를 확인하지 못했습니다." };
  if (!base.apr || principal.lte(0) || days <= 0) return { rewards: { status: base.status, note: base.note }, netAdd: ZERO, remainder: ZERO };
  const px = q?.underlyingPriceUsd && assetPriceUsd && new Decimal(assetPriceUsd).gt(0) ? new Decimal(q.underlyingPriceUsd).div(assetPriceUsd) : new Decimal(1);
  const perDay = principal.mul(px).mul(base.apr).div(365);
  const total = perDay.mul(days);
  const c = base.campaign;
  let verifiedDays = ZERO;
  if (base.status === "verified" && c) {
    const endMs = endDate ? Date.parse(`${endDate}T00:00:00+09:00`) : now.getTime();
    const from = Math.max(now.getTime(), Date.parse(c.start));
    const to = Math.min(endMs, Date.parse(c.end));
    verifiedDays = Decimal.min(Decimal.max(new Decimal(to - from).div(86_400_000), 0), days);
  }
  const verified = perDay.mul(verifiedDays);
  const claim = stepCosts([step("claim", "", "", ZERO, TYPICAL_RESOURCES.claim_rewards, JUSTLEND_RES_SRC)], basis, evalAsset).inAsset;
  const tok = base.token ?? "";
  const aprPct = new Decimal(base.apr).mul(100).toDecimalPlaces(2).toFixed();
  if (verified.gt(0) && claim !== undefined) {
    const remainder = total.minus(verified);
    const restDays = new Decimal(days).minus(verifiedDays);
    return {
      rewards: {
        status: "verified" as const,
        amount: verified.toFixed(),
        note: `${c!.name} 기간(${c!.end.slice(0, 10)} 종료) 안의 ${verifiedDays.toDecimalPlaces(2).toFixed()}일분 보상 ${verified.toDecimalPlaces(4).toFixed()} ${tok}(연 ${aprPct}%)을 검증된 보상으로 순수익에 넣었습니다(청구 비용 ${new Decimal(claim).toDecimalPlaces(4).toFixed()} 차감). ${restDays.gt(0) ? `종료 후 ${restDays.toDecimalPlaces(2).toFixed()}일분 ${remainder.toDecimalPlaces(4).toFixed()} ${tok}는 다음 회차가 공지되지 않아 미확인으로 뺐습니다.` : ""}`,
      },
      netAdd: verified.minus(claim),
      remainder,
    };
  }
  const note = `${base.note} 추정 보상 ${total.toDecimalPlaces(4).toFixed()} ${tok} (연 ${aprPct}%).`;
  return { rewards: { status: "unverified" as const, amount: total.toFixed(), note }, netAdd: ZERO, remainder: claim !== undefined ? total.minus(claim) : ZERO };
}

/**
 * 계획 엔진. Mainnet 분석이 기본이고, chain을 "nile"로 주면 같은 로직(지출 재원·위험 성향·스테이킹·인출일별 분산·추천)을
 * Nile 실시간 값으로 계산한다 (Nile 결과는 테스트 TRX 기준이며 Mainnet 수익과 섞지 않는다).
 */
export function buildMainnetPlans(needsIn: UserNeeds, inputs: MainnetInputs, now = new Date(), idPrefix = "m", chain: "mainnet" | "nile" = "mainnet"): Omit<PlanningResult, "explanation"> {
  const { jusdt, jusdd, psm, staking, jtrx, costBasis } = inputs;
  // 보유 자산과 다른 자산의 지출은 오늘 환전해 보유할 필요량(보유 자산 기준)으로 바꿔 확보한다
  const fx = convertExpenses(needsIn, inputs);
  const needs = fx.needs;
  // 보유 자산이 TRX면 같은 자산 예치는 jTRX, USDT면 jUSDT. 자산을 바꾸는 경로(USDT→TRX 스테이킹, TRX→USDT→USDD)는 SunSwap V2 교환 견적으로 계산한다.
  const holdsTrx = needs.asset === "TRX";
  // USDD 보유자: 같은 자산 예치는 jUSDD(채굴 보상 포함), B는 반대 방향(USDD → PSM → USDT → jUSDT), C는 PSM → SunSwap → 스테이킹
  const holdsUsdd = needs.asset === "USDD";
  const evalAsset: EvalAsset = needs.asset;
  const lendQ = holdsTrx ? jtrx : holdsUsdd ? jusdd : jusdt;
  const lendMarket = holdsTrx ? "jTRX" : holdsUsdd ? "jUSDD" : "jUSDT";
  const amount = new Decimal(needs.amount ?? 0);
  const days = needs.endDate ? daysBetween(needs.startDate, needs.endDate) : 0;
  const reserved = reservedWithinHorizon(needs);
  const investable = Decimal.max(amount.minus(reserved.total), 0);
  const warnings: string[] = [];
  if (!costBasis) warnings.push("체인 수수료 파라미터를 조회하지 못해 거래비용과 순수익을 산정할 수 없습니다.");
  else if (!holdsTrx && !costBasis.trxPerUsdt) warnings.push("TRX→USDT 환산 근거가 없어 순수익을 산정할 수 없습니다.");
  if (reserved.outside.length)
    warnings.push(`운용 기간 밖 지출 ${reserved.outside.map((e) => `${e.date} ${e.amount} ${e.asset}`).join(", ")}은 이번 기간에 확보하지 않습니다.`);
  warnings.push(...fx.problems);
  if (fx.conversions.length && reserved.total.gt(amount)) warnings.push(`환전 필요량을 더한 지출 재원(${reserved.total.toDecimalPlaces(6).toFixed()} ${needs.asset})이 보유액보다 커서 운용 가능한 금액이 없습니다.`);

  const base = {
    chain,
    asset: needs.asset,
    inputVersion: needs.version,
    horizonDays: days,
    principal: amount.toFixed(),
    label: chain === "nile" ? ("Nile 실행 계획" as const) : ("조건부 분석" as const),
    recommended: false,
  };
  const commonAssumptions = [
    `지출 재원 ${reserved.total.toFixed()} ${needs.asset}은 처음부터 예치하지 않고 보유합니다.`,
    "조회 시점의 금리가 운용 기간 내내 유지된다고 가정합니다 (보장 아님).",
    costAssumption(costBasis),
  ];
  const resA = jTokenResources(costBasis, lendMarket);
  const resB = jTokenResources(costBasis, "jUSDD");

  // ---------------- Plan A / A-2: 같은 자산 예치 (jUSDT 또는 jTRX)
  const lendingPlan = (key: Plan["key"], share: Decimal, title: string): Plan => {
    const q = lendQ;
    const invest = investable.mul(share).toDecimalPlaces(6, Decimal.ROUND_DOWN);
    const held = amount.minus(invest);
    const a = needs.asset;
    const steps = [
      step("hold", share.lt(1) ? "지출 재원 + 추가 유동성 보유" : "지출 재원 보유", a, held, { energy: 0, bandwidth: 0 }, "-"),
      ...(holdsTrx ? [] : [step("approve", `${a} 사용 승인 (${lendMarket})`, a, invest, TYPICAL_RESOURCES.approve, JUSTLEND_RES_SRC, q?.address)]),
      step("supply", `JustLend ${lendMarket} 예치`, a, invest, resA.supply, resA.src, q?.address),
      step("withdraw", `만기 인출 ${lendMarket} → ${a}`, a, invest, resA.withdraw, resA.src, q?.address),
    ];
    // 실행 날짜: 승인·예치는 D+0, 인출은 기간 끝 (Energy 대여는 날짜마다 따로 빌린다)
    for (const s of steps) if (s.action !== "hold") s.day = s.action === "withdraw" ? days : 0;
    const rate = q?.baseRate ? new Decimal(q.baseRate) : undefined;
    const rt = q?.rateType ?? "APY";
    const y = rate ? baseYield(invest, rate, rt, days) : ZERO;
    const costs = stepCosts(steps, costBasis, evalAsset);
    const rw = rewardsFor(q, invest, days, costBasis, q?.underlyingPriceUsd, now, needs.endDate, evalAsset);
    const net = costs.inAsset !== undefined && rate ? y.minus(costs.inAsset).plus(rw.netAdd) : undefined;
    const di = dataIssues(q, chain, now);
    const blocking = [...di.blocking, ...lendingIssues(q, invest)];
    if (invest.lte(0)) blocking.push("지출 재원을 빼면 운용 가능한 금액이 없습니다.");
    const rb = riskBlock(needs.riskProfile, "stable");
    if (rb) blocking.push(rb);
    const conditional = [...di.conditional, ...lendingWarnings(q, invest)];
    if (net === undefined) conditional.push("비용 또는 TRX 환산 근거가 없어 순수익 산정 불가입니다.");
    return {
      ...base,
      id: `${idPrefix}-${key}`,
      key,
      riskClass: "stable",
      title,
      allocation: { invested: invest.toFixed(), held: held.toFixed() },
      steps,
      baseRate: q?.baseRate,
      rateType: rt,
      baseYield: y.toFixed(),
      rewards: rw.rewards,
      costs,
      netReturn: net?.toFixed(),
      netWithUnverifiedRewards: net !== undefined && rw.remainder.gt(0) ? net.plus(rw.remainder).toFixed() : undefined,
      breakEvenDays: rate && costs.inAsset ? breakEvenDays(invest, rate, rt, new Decimal(costs.inAsset))?.toFixed() : undefined,
      eligibility: blocking.length ? "ineligible" : conditional.length ? "conditional" : "eligible",
      reasons: [...blocking, ...conditional],
      risks: ["JustLend 시장 인출 유동성 부족 시 지연", "금리 변동", "스마트 계약 위험"],
      assumptions: share.lt(1)
        ? [...commonAssumptions, `운용 가능액의 ${share.mul(100).toFixed()}%만 예치하고 나머지 ${investable.minus(invest).toFixed()} ${a}는 예상 밖 지출에 대비해 보유합니다.`]
        : commonAssumptions,
      quoteIds: q ? [q.id] : [],
      dataModes: modesOf(q),
    };
  };
  const planA = lendingPlan("A", new Decimal(1), `A. ${needs.asset} 전액 예치 (JustLend ${lendMarket})`);
  const planA2 = lendingPlan("A2", new Decimal("0.5"), `A-2. ${needs.asset} 절반 예치 + 추가 유동성`);

  // ---------------- Plan B: USDD 경로 (PSM 전환 → JustLend jUSDD)
  // TRX 보유자는 SunSwap V2로 TRX→USDT 교환 후 같은 경로를 타고, 기간 끝에 USDT→TRX로 되돌린다 (출구 시 풀 가격이 지금과 같다고 가정).
  // USDD 보유자의 B: USDD → PSM buyGem(tout) → USDT → jUSDT, 만기에 jUSDT 인출 → PSM sellGem(tin) → USDD
  const planBUsdd = (): Plan => {
    const title = "B. USDT 경로 (PSM 전환 USDD → USDT → JustLend jUSDT)";
    const feeIn = psm?.psm ? new Decimal(psm.psm.feeIn) : ZERO;
    const feeOut = psm?.psm ? new Decimal(psm.psm.feeOut) : ZERO;
    const usdtIn = investable.div(new Decimal(1).plus(feeOut)).toDecimalPlaces(6, Decimal.ROUND_DOWN);
    const rate = jusdt?.baseRate ? new Decimal(jusdt.baseRate) : undefined;
    const rt = jusdt?.rateType ?? "APY";
    const yieldUsdt = rate ? baseYield(usdtIn, rate, rt, days) : ZERO;
    const usdtOut = usdtIn.plus(yieldUsdt);
    const usddBack = usdtOut.mul(new Decimal(1).minus(feeIn));
    // PSM은 1:1 전환이라 USDT 이자를 그대로 USDD 수익으로 보고, 전환 수수료는 비용으로 뺀다
    const conversionFees = investable.minus(usdtIn).plus(usdtOut.minus(usddBack));
    const resT = jTokenResources(costBasis, "jUSDT");
    const pe = costBasis?.psmEnergy;
    const psmSrc = pe ? `PSM 최근 성공 거래 ${pe.sampleSize}건 ${statKo(costBasis)}` : "미확인";
    const steps: PlanStep[] = [
      step("hold", "지출 재원 보유", "USDD", reserved.total, { energy: 0, bandwidth: 0 }, "-"),
      step("approve", "USDD 사용 승인 (PSM)", "USDD", investable, TYPICAL_RESOURCES.approve, JUSTLEND_RES_SRC, psm?.address),
      step("psm_buy", "PSM 전환 USDD → USDT", "USDD", investable, { energy: pe?.buy ?? 0, bandwidth: pe?.bandwidth?.buy ?? TYPICAL_RESOURCES.psm.bandwidth }, psmSrc, psm?.address),
      step("approve", "USDT 사용 승인 (jUSDT)", "USDT", usdtIn, TYPICAL_RESOURCES.approve, JUSTLEND_RES_SRC, jusdt?.address),
      step("supply", "JustLend jUSDT 예치", "USDT", usdtIn, resT.supply, resT.src, jusdt?.address),
      step("withdraw", "만기 인출 jUSDT → USDT", "USDT", usdtOut, resT.withdraw, resT.src, jusdt?.address),
      step("approve", "USDT 사용 승인 (PSM 출구)", "USDT", usdtOut, TYPICAL_RESOURCES.approve, JUSTLEND_RES_SRC, psm?.address),
      step("psm_sell", "PSM 전환 USDT → USDD", "USDT", usdtOut, { energy: pe?.sell ?? 0, bandwidth: pe?.bandwidth?.sell ?? TYPICAL_RESOURCES.psm.bandwidth }, psmSrc, psm?.address),
    ];
    let exiting = false;
    for (const x of steps) {
      if (x.action === "withdraw") exiting = true;
      if (x.action !== "hold") x.day = exiting ? days : 0;
    }
    const costs = stepCosts(steps, costBasis, "USDD", conversionFees);
    const rw = rewardsFor(jusdt, usdtIn, days, costBasis, jusdt?.underlyingPriceUsd, now, needs.endDate, "USDD");
    const net = costs.inAsset !== undefined && rate && pe ? yieldUsdt.minus(conversionFees).minus(costs.inAsset).plus(rw.netAdd) : undefined;
    const blocking: string[] = [];
    const rbB = riskBlock(needs.riskProfile, "stable_conversion");
    if (rbB) blocking.push(rbB);
    const d1 = dataIssues(jusdt, chain, now);
    const d2 = dataIssues(psm, chain, now);
    blocking.push(...d1.blocking, ...d2.blocking, ...lendingIssues(jusdt, usdtIn), ...psmIssues(psm, usdtIn));
    if (!pe) blocking.push("PSM 전환 거래비용(Energy)을 확인하지 못했습니다.");
    if (investable.lte(0)) blocking.push("지출 재원을 빼면 운용 가능한 금액이 없습니다.");
    const conditional = [...new Set([...d1.conditional, ...d2.conditional]), ...lendingWarnings(jusdt, usdtIn)];
    if (net === undefined) conditional.push("비용·환산 근거가 부족해 순수익 산정 불가입니다.");
    return {
      ...base,
      id: `${idPrefix}-B`,
      key: "B",
      riskClass: "stable_conversion",
      title,
      allocation: { invested: investable.toFixed(), held: reserved.total.toFixed() },
      steps,
      baseRate: jusdt?.baseRate,
      rateType: rt,
      baseYield: yieldUsdt.toFixed(),
      rewards: rw.rewards,
      costs,
      netReturn: net?.toFixed(),
      breakEvenDays: rate && costs.inAsset ? breakEvenDays(usdtIn, rate, rt, new Decimal(costs.inAsset).plus(conversionFees))?.toFixed() : undefined,
      eligibility: blocking.length ? "ineligible" : conditional.length ? "conditional" : "eligible",
      reasons: [...blocking, ...conditional],
      risks: ["PSM 출구(USDT 보유량)·진입(부채 한도) 물량 부족", "전환 단계가 많아 거래비용 증가", "금리 변동", "스마트 계약 위험 (PSM + JustLend)"],
      assumptions: [
        ...commonAssumptions,
        `PSM으로 USDD ${investable.toFixed()} → USDT ${usdtIn.toFixed()}(출구 수수료 ${feeOut.mul(100).toFixed()}%), 만기에 USDT ${usdtOut.toDecimalPlaces(4).toFixed()} → USDD ${usddBack.toDecimalPlaces(4).toFixed()}(진입 수수료 ${feeIn.mul(100).toFixed()}%). PSM은 1:1 전환이라 USDT 이자를 그대로 USDD 수익으로 봅니다.`,
      ],
      quoteIds: [jusdt, psm].filter(Boolean).map((q) => q!.id),
      dataModes: modesOf(jusdt, psm),
    };
  };

  const planB = holdsUsdd ? planBUsdd() : ((): Plan => {
    const sw = inputs.swap;
    const title = holdsTrx ? "B. USDD 경로 (TRX→USDT 교환 → PSM → JustLend jUSDD)" : "B. USDD 경로 (PSM 전환 → JustLend jUSDD)";
    if (holdsTrx && !sw)
      return excludedPlan(base, `${idPrefix}-B`, "B", title, "volatile", amount, [
        "보유 자산이 TRX라 PSM(USDT↔USDD)을 쓰려면 먼저 TRX→USDT 교환이 필요한데, SunSwap 교환 견적을 확인하지 못했습니다.",
      ]);
    const feeIn = psm?.psm ? new Decimal(psm.psm.feeIn) : ZERO;
    const feeOut = psm?.psm ? new Decimal(psm.psm.feeOut) : ZERO;
    const usdtIn = holdsTrx ? trxToUsdt(sw!, investable) : investable;
    const usddIn = usdtIn.mul(new Decimal(1).minus(feeIn));
    const rate = jusdd?.baseRate ? new Decimal(jusdd.baseRate) : undefined;
    const rt = jusdd?.rateType ?? "APY";
    const yieldUsdd = rate ? baseYield(usddIn, rate, rt, days) : ZERO;
    const usddOut = usddIn.plus(yieldUsdd);
    const usdtBack = usddOut.mul(new Decimal(1).minus(feeOut));
    const trxBack = holdsTrx ? usdtToTrx(sw!, usdtBack) : undefined;
    // 평가 자산(USDT 또는 TRX) 기준. TRX 보유자는 USDD 수익을 풀 중간 가격으로 TRX 환산하고, 교환·PSM 손실은 전환 비용으로 뺀다.
    const mid = holdsTrx ? trxMidUsdt(sw!) : new Decimal(1); // 1 TRX의 USDT 가치
    const toEval = (usd: Decimal) => (holdsTrx ? usd.div(mid) : usd);
    const yieldEval = toEval(yieldUsdd);
    const conversionFees = holdsTrx ? investable.plus(yieldEval).minus(trxBack!) : investable.minus(usddIn).plus(usddOut.minus(usdtBack));
    const pe = costBasis?.psmEnergy;
    const psmSrc = pe ? `PSM 최근 성공 거래 ${pe.sampleSize}건 ${statKo(costBasis)}` : "미확인";
    const swapSrc = sw ? (sw.costs.sampleSize ? `SunSwap V2 라우터 최근 성공 거래 ${sw.costs.sampleSize}건 ${statKo(costBasis)}` : "SunSwap V2 교환 비용 (Mainnet 실측값)") : "미확인";
    const br = holdsTrx ? sw?.bridge : undefined;
    const steps: PlanStep[] = [
      step("hold", "지출 재원 보유", needs.asset, reserved.total, { energy: 0, bandwidth: 0 }, "-"),
      ...(holdsTrx && !br ? [step("swap", `SunSwap V2 교환 TRX → USDT (예상 ${usdtIn.toDecimalPlaces(2).toFixed()} USDT)`, "TRX", investable, sw!.costs.toUsdt, swapSrc, sw!.router)] : []),
      ...(holdsTrx && br
        ? [
            step("swap", `SunSwap V2 교환 TRX → ${br.symbol}`, "TRX", investable, sw!.costs.toUsdt, swapSrc, sw!.router),
            step("approve", `${br.symbol} 사용 승인 (브리지 PSM)`, br.symbol, usdtIn, TYPICAL_RESOURCES.approve, JUSTLEND_RES_SRC, br.psm),
            step("psm_buy", `브리지 PSM 전환 ${br.symbol} → USDT (예상 ${usdtIn.toDecimalPlaces(2).toFixed()} USDT)`, br.symbol, usdtIn, { energy: br.energy?.buy ?? pe?.buy ?? 0, bandwidth: TYPICAL_RESOURCES.psm.bandwidth }, psmSrc, br.psm),
          ]
        : []),
      step("approve", "USDT 사용 승인 (PSM)", "USDT", usdtIn, TYPICAL_RESOURCES.approve, JUSTLEND_RES_SRC, psm?.address),
      step("psm_sell", "PSM 전환 USDT → USDD", "USDT", usdtIn, { energy: pe?.sell ?? 0, bandwidth: pe?.bandwidth?.sell ?? TYPICAL_RESOURCES.psm.bandwidth }, psmSrc, psm?.address),
      step("approve", "USDD 사용 승인 (jUSDD)", "USDD", usddIn, TYPICAL_RESOURCES.approve, JUSTLEND_RES_SRC, jusdd?.address),
      step("supply", "JustLend jUSDD 예치", "USDD", usddIn, resB.supply, resB.src, jusdd?.address),
      step("withdraw", "만기 인출 jUSDD → USDD", "USDD", usddOut, resB.withdraw, resB.src, jusdd?.address),
      step("approve", "USDD 사용 승인 (PSM 출구)", "USDD", usddOut, TYPICAL_RESOURCES.approve, JUSTLEND_RES_SRC, psm?.address),
      step("psm_buy", "PSM 전환 USDD → USDT", "USDD", usddOut, { energy: pe?.buy ?? 0, bandwidth: pe?.bandwidth?.buy ?? TYPICAL_RESOURCES.psm.bandwidth }, psmSrc, psm?.address),
      ...(holdsTrx && !br
        ? [
            step("approve", "USDT 사용 승인 (SunSwap V2 라우터)", "USDT", usdtBack, TYPICAL_RESOURCES.approve, JUSTLEND_RES_SRC, sw!.router),
            step("swap", "SunSwap V2 교환 USDT → TRX", "USDT", usdtBack, sw!.costs.toTrx, swapSrc, sw!.router),
          ]
        : []),
      ...(holdsTrx && br
        ? [
            step("approve", "USDT 사용 승인 (브리지 PSM 출구)", "USDT", usdtBack, TYPICAL_RESOURCES.approve, JUSTLEND_RES_SRC, br.gemJoin),
            step("psm_sell", `브리지 PSM 전환 USDT → ${br.symbol}`, "USDT", usdtBack, { energy: br.energy?.sell ?? pe?.sell ?? 0, bandwidth: TYPICAL_RESOURCES.psm.bandwidth }, psmSrc, br.psm),
            step("approve", `${br.symbol} 사용 승인 (SunSwap V2 라우터)`, br.symbol, usdtBack, TYPICAL_RESOURCES.approve, JUSTLEND_RES_SRC, sw!.router),
            step("swap", `SunSwap V2 교환 ${br.symbol} → TRX`, br.symbol, usdtBack, sw!.costs.toTrx, swapSrc, sw!.router),
          ]
        : []),
    ];
    // 실행 날짜: 인출 전까지는 D+0, 인출부터 되돌림 교환까지는 기간 끝
    let exiting = false;
    for (const s of steps) {
      if (s.action === "withdraw") exiting = true;
      if (s.action !== "hold") s.day = exiting ? days : 0;
    }
    const costs = stepCosts(steps, costBasis, evalAsset, conversionFees);
    const rw = rewardsFor(jusdd, usddIn, days, costBasis, jusdt?.underlyingPriceUsd, now, needs.endDate);
    const netAdd = toEval(rw.netAdd);
    const net = costs.inAsset !== undefined && rate && pe ? yieldEval.minus(conversionFees).minus(costs.inAsset).plus(netAdd) : undefined;
    const riskClass: NonNullable<Plan["riskClass"]> = holdsTrx ? "volatile" : "stable_conversion";
    const blocking: string[] = [];
    const rbB = riskBlock(needs.riskProfile, riskClass);
    if (rbB) blocking.push(holdsTrx ? `${rbB} (TRX 보유자에게 USDD 경로는 원금이 달러 자산으로 바뀌어 TRX 기준 가치가 변합니다.)` : rbB);
    if (needs.acceptUsddRisk !== true) blocking.push("사용자가 USDD 가격 변동 위험을 받아들이지 않아 추천 후보에서 제외합니다.");
    const d1 = dataIssues(jusdd, chain, now);
    const d2 = dataIssues(psm, chain, now);
    blocking.push(...d1.blocking, ...d2.blocking, ...lendingIssues(jusdd, usddIn), ...psmIssues(psm, usdtIn));
    if (!pe) blocking.push("PSM 전환 거래비용(Energy)을 확인하지 못했습니다.");
    if (investable.lte(0)) blocking.push("지출 재원을 빼면 운용 가능한 금액이 없습니다.");
    if (holdsTrx && sw && investable.div(sw.reserveTrx).gt("0.02"))
      blocking.push(`교환 금액이 SunSwap 풀 TRX 잔고의 ${investable.div(sw.reserveTrx).mul(100).toDecimalPlaces(2).toFixed()}%라 가격 영향이 너무 큽니다 (2% 초과).`);
    const conditional = [...new Set([...d1.conditional, ...d2.conditional]), ...lendingWarnings(jusdd, usddIn)];
    if (sw && holdsTrx && sw.source.mode !== "live") conditional.push("SunSwap 풀 준비금이 실시간 값이 아닙니다.");
    if (net === undefined) conditional.push("비용·환산 근거가 부족해 순수익 산정 불가입니다.");
    const stress =
      net !== undefined
        ? [
            { label: "출구 시 USDD 0.5% 디페깅 (PSM 출구 불가, 시장 매도)", netReturn: net.minus(toEval(usddOut.mul("0.005"))).toFixed() },
            { label: "출구 시 USDD 2% 디페깅", netReturn: net.minus(toEval(usddOut.mul("0.02"))).toFixed() },
            // TRX 보유자: 기간 끝 TRX 가격이 오르면 같은 달러로 되돌려 받는 TRX가 줄어든다
            ...(holdsTrx
              ? ["-10", "10", "20"].map((pct) => ({
                  label: `기간 끝 TRX 가격 ${pct.startsWith("-") ? "" : "+"}${pct}%`,
                  netReturn: net.plus(trxBack!.div(new Decimal(pct).div(100).plus(1)).minus(trxBack!)).toFixed(),
                }))
              : []),
          ]
        : undefined;
    return {
      ...base,
      id: `${idPrefix}-B`,
      key: "B",
      riskClass,
      title,
      allocation: { invested: investable.toFixed(), held: reserved.total.toFixed() },
      steps,
      baseRate: jusdd?.baseRate,
      rateType: rt,
      baseYield: yieldEval.toFixed(),
      rewards: rw.rewards,
      costs,
      netReturn: net?.toFixed(),
      netWithUnverifiedRewards: net !== undefined && rw.remainder.gt(0) ? net.plus(toEval(rw.remainder)).toFixed() : undefined,
      breakEvenDays: rate && costs.inAsset ? breakEvenDays(holdsTrx ? investable : usddIn, rate, rt, new Decimal(costs.inAsset).plus(conversionFees))?.toFixed() : undefined,
      eligibility: blocking.length ? "ineligible" : conditional.length ? "conditional" : "eligible",
      reasons: [...blocking, ...conditional],
      risks: [
        "USDD 디페깅(가격 이탈)",
        "PSM 출구 물량 부족",
        "전환 단계가 많아 거래비용 증가",
        "스마트 계약 위험 (PSM + JustLend)",
        ...(holdsTrx ? ["TRX 가격 변동 (원금이 달러 자산으로 바뀜, 스트레스 결과 참고)", "교환 시점 풀 가격·슬리피지 변동 (실행 직전 최소 수령량을 다시 계산)"] : []),
      ],
      assumptions: [
        ...commonAssumptions,
        "PSM은 전환 경로일 뿐 수익원이 아닙니다. 이자는 jUSDD 예치에서만 발생합니다.",
        "USDD→USDT 출구 시 PSM이 정상 1:1(수수료 제외) 전환된다고 가정합니다. 디페깅은 스트레스 결과로 따로 봅니다.",
        ...(holdsTrx
          ? [
              `SunSwap V2 ${br ? `TRX↔${br.symbol} 풀과 브리지 PSM(${br.symbol}↔USDT, 수수료 ${new Decimal(br.feeIn).mul(100).toFixed()}%/${new Decimal(br.feeOut).mul(100).toFixed()}%)` : sw!.hops ? "2단계 경로" : "풀"} 기준 ${investable.toFixed()} TRX → ${usdtIn.toDecimalPlaces(4).toFixed()} USDT, 기간 끝 ${usdtBack.toDecimalPlaces(4).toFixed()} USDT → ${trxBack!.toDecimalPlaces(4).toFixed()} TRX (풀 가격이 지금과 같다고 가정). 교환·PSM 손실 ${conversionFees.toDecimalPlaces(4).toFixed()} TRX는 전환 비용으로 뺐습니다.`,
            ]
          : []),
      ],
      stress,
      quoteIds: [jusdd, psm].filter(Boolean).map((q) => q!.id),
      dataModes: modesOf(jusdd, psm),
    };
  })();

  // ---------------- Plan C: TRX 스테이킹(Stake 2.0) + SR 투표
  // 자금을 기간 끝에 돌려받으려면 해제 대기(보통 14일) 전에 해제해야 하므로 보상 기간 = 운용 기간 − 해제 대기 − 투표 반영 지연(최대 6시간).
  const planC = ((): Plan => {
    const q = staking;
    const st = q?.staking;
    const delay = st?.unfreezeDelayDays ?? 14;
    // 투표는 다음 유지보수 주기(getMaintenanceTimeInterval, 보통 6시간)부터 반영된다. 조회하지 못하면 6시간을 쓴다.
    const voteDelay = st?.voteDelayDays ? new Decimal(st.voteDelayDays) : new Decimal("0.25");
    const rewardDays = Decimal.max(new Decimal(days).minus(delay).minus(voteDelay), 0);
    const bw = st?.txBandwidth;
    const sys = (bytes: number | undefined) => ({ energy: 0, bandwidth: bytes ?? SYSTEM_TX.bandwidth });
    const sysSrc = (k: string) =>
      bw ? (bw.measured.includes(k) ? `최근 스테이킹 거래 영수증 실측 최대값 (표본 ${bw.sampleSize}건)` : "이 유형 표본 없음 → 측정된 스테이킹 거래 중 최대값") : SYSTEM_TX_SRC;
    // USDT 보유자는 SunSwap V2로 USDT→TRX 교환 후 스테이킹하고, 기간 끝에 TRX→USDT로 되돌린다 (풀 준비금으로 계산, 라우터 견적과 교차 검증)
    const sw = inputs.swap;
    const rate = q?.baseRate ? new Decimal(q.baseRate) : undefined;
    // USDD 보유자는 PSM으로 USDT를 받아(tout) 같은 교환 경로를 타고, 만기에 USDT → PSM(tin) → USDD로 되돌린다
    const pIn = holdsUsdd && psm?.psm ? new Decimal(psm.psm.feeIn) : ZERO;
    const pOut = holdsUsdd && psm?.psm ? new Decimal(psm.psm.feeOut) : ZERO;
    const usdtStart = holdsUsdd ? investable.div(new Decimal(1).plus(pOut)).toDecimalPlaces(6, Decimal.ROUND_DOWN) : investable;
    const trxIn = holdsTrx ? investable : sw ? swapRoundTrip(sw, usdtStart).trx : undefined;
    const yieldTrx = trxIn && rate ? trxIn.mul(rate).mul(rewardDays).div(365) : ZERO;
    const rt = !holdsTrx && sw ? swapRoundTrip(sw, usdtStart, yieldTrx) : undefined;
    const backInAsset = rt ? (holdsUsdd ? rt.usdtBack.mul(new Decimal(1).minus(pIn)) : rt.usdtBack) : undefined;
    // 기본 수익은 풀 중간 가격으로 환산한 보상, 교환·PSM 손실은 전환 비용으로 따로 뺀다
    const yieldInAsset = holdsTrx ? yieldTrx : rt ? yieldTrx.mul(rt.mid) : ZERO;
    const conversionFees = rt ? (holdsUsdd ? investable.plus(yieldInAsset).minus(backInAsset!) : rt.loss) : ZERO;
    const pe = costBasis?.psmEnergy;
    const trxLabel = trxIn ? trxIn.toDecimalPlaces(6, Decimal.ROUND_DOWN) : ZERO;
    const swapSrc = sw ? `SunSwap V2 라우터 최근 성공 거래 ${sw.costs.sampleSize}건 ${statKo(costBasis)}` : "미확인";
    const steps = [
      step("hold", "지출 재원 보유", needs.asset, reserved.total, { energy: 0, bandwidth: 0 }, "-"),
      ...(holdsUsdd
        ? [
            step("approve", "USDD 사용 승인 (PSM)", "USDD", investable, TYPICAL_RESOURCES.approve, JUSTLEND_RES_SRC, psm?.address),
            step("psm_buy", "PSM 전환 USDD → USDT", "USDD", investable, { energy: pe?.buy ?? 0, bandwidth: pe?.bandwidth?.buy ?? TYPICAL_RESOURCES.psm.bandwidth }, "PSM 실측", psm?.address),
          ]
        : []),
      ...(holdsTrx
        ? []
        : [
            step("approve", "USDT 사용 승인 (SunSwap V2 라우터)", "USDT", usdtStart, TYPICAL_RESOURCES.approve, JUSTLEND_RES_SRC, sw?.router),
            step("swap", `SunSwap V2 교환 USDT → TRX (예상 ${trxLabel.toDecimalPlaces(2).toFixed()} TRX)`, "USDT", usdtStart, sw?.costs.toTrx ?? { energy: 0, bandwidth: 0 }, swapSrc, sw?.router),
          ]),
      step("stake", "TRX 스테이킹 (FreezeBalanceV2)", "TRX", trxLabel, sys(bw?.stake), sysSrc("stake")),
      step("vote", `SR 투표 (${st?.srName ?? "SR 미확인"})`, "TRX", trxLabel, sys(bw?.vote), sysSrc("vote"), st?.srAddress),
      step("claim", "투표 보상 청구 (WithdrawBalance)", "TRX", yieldTrx, sys(bw?.claim), sysSrc("claim")),
      step("unstake", `스테이킹 해제 (UnfreezeBalanceV2, ${delay}일 대기 시작)`, "TRX", trxLabel, sys(bw?.unstake), sysSrc("unstake")),
      step("withdraw", "해제 완료분 인출 (WithdrawExpireUnfreeze)", "TRX", trxLabel, sys(bw?.withdrawExpire), sysSrc("withdrawExpire")),
      ...(holdsTrx
        ? []
        : [step("swap", "SunSwap V2 교환 TRX → USDT (원금+보상)", "TRX", trxLabel.plus(yieldTrx).toDecimalPlaces(6, Decimal.ROUND_DOWN), sw?.costs.toUsdt ?? { energy: 0, bandwidth: 0 }, swapSrc, sw?.router)]),
      ...(holdsUsdd && rt
        ? [
            step("approve", "USDT 사용 승인 (PSM 출구)", "USDT", rt.usdtBack, TYPICAL_RESOURCES.approve, JUSTLEND_RES_SRC, psm?.address),
            step("psm_sell", "PSM 전환 USDT → USDD", "USDT", rt.usdtBack, { energy: pe?.sell ?? 0, bandwidth: pe?.bandwidth?.sell ?? TYPICAL_RESOURCES.psm.bandwidth }, "PSM 실측", psm?.address),
          ]
        : []),
    ];
    // 실행 날짜: 진입(교환·스테이킹·투표)은 D+0, 해제는 인출일보다 해제 대기만큼 먼저, 해제분 인출·보상 청구·되돌림 교환은 기간 끝
    const unstakeDay = Math.max(0, days - delay);
    let seenSwap = false;
    let exited = false;
    for (const s of steps) {
      if (s.action === "unstake") s.day = unstakeDay;
      else if (s.action === "withdraw" || s.action === "claim") s.day = days;
      else if (s.action === "swap") (s.day = seenSwap ? days : 0), (seenSwap = true), (exited = seenSwap && s.asset === "TRX");
      else if (s.action !== "hold") s.day = exited ? days : 0; // 되돌림 교환 뒤의 PSM 출구는 기간 끝
    }
    const costs = stepCosts(steps, costBasis, evalAsset, conversionFees);
    // 순수익 = 보상(중간 가격 환산) − 교환 손실 − 거래비용 = 돌려받는 USDT − 넣은 USDT − 거래비용
    const net = costs.inAsset !== undefined && rate && (holdsTrx || rt) ? yieldInAsset.minus(conversionFees).minus(costs.inAsset) : undefined;
    const di = dataIssues(q, chain, now);
    const blocking = [...di.blocking];
    const conditional = [...di.conditional];
    if (!holdsTrx && !sw) blocking.push(`보유 자산이 ${needs.asset}인데 SunSwap USDT↔TRX 교환 견적을 확인하지 못해 스테이킹 수량과 교환 비용을 계산할 수 없습니다.`);
    if (rt && rt.impactPct.gt(2)) blocking.push(`교환 금액이 SunSwap 풀 USDT 잔고의 ${rt.impactPct.toDecimalPlaces(2).toFixed()}%라 가격 영향이 너무 큽니다 (2% 초과).`);
    if (sw && sw.source.mode !== "live") conditional.push("SunSwap 풀 준비금이 실시간 값이 아닙니다.");
    if (days <= delay) blocking.push(`운용 기간(${days}일)이 스테이킹 해제 대기(${delay}일)보다 짧아 기간 안에 자금을 돌려받을 수 없습니다.`);
    if (q && !rate) blocking.push("투표 보상률을 계산하지 못했습니다.");
    if (investable.lte(0)) blocking.push("지출 재원을 빼면 운용 가능한 금액이 없습니다.");
    // TRX 가격 스트레스: 돌려받는 USDT가 TRX 가격 변동만큼 바뀐다
    const stress =
      rt && net !== undefined && costs.inAsset !== undefined
        ? ["-20", "-10", "10"].map((pct) => ({
            label: `기간 끝 TRX 가격 ${pct.startsWith("-") ? "" : "+"}${pct}%`,
            netReturn: backInAsset!.mul(new Decimal(pct).div(100).plus(1)).minus(investable).minus(costs.inAsset!).toFixed(),
          }))
        : undefined;
    const rbC = riskBlock(needs.riskProfile, holdsTrx ? "stable" : "volatile");
    if (rbC) blocking.push(rbC);
    return {
      ...base,
      id: `${idPrefix}-C`,
      key: "C",
      riskClass: holdsTrx ? "stable" : "volatile",
      title: "C. TRX 스테이킹 + SR 투표",
      allocation: { invested: investable.toFixed(), held: reserved.total.toFixed() },
      steps,
      baseRate: q?.baseRate,
      rateType: "APR",
      baseYield: yieldInAsset.toFixed(),
      rewards: { status: "none", note: "투표 보상은 프로토콜 보상이라 기본 수익에 포함했습니다." },
      costs,
      netReturn: net?.toFixed(),
      breakEvenDays: undefined,
      eligibility: blocking.length ? "ineligible" : conditional.length ? "conditional" : "eligible",
      reasons: [...blocking, ...conditional],
      stress,
      risks: [
        holdsTrx ? "TRX 가격 변동 (보유 자산 그대로라 전환에 따른 추가 위험은 없음)" : "TRX 가격 변동 (원금이 TRX로 바뀜, 아래 스트레스 결과 참고)",
        ...(holdsTrx ? [] : ["교환 시점 풀 가격·슬리피지 변동 (실행 직전 최소 수령량을 다시 계산해야 함)"]),
        `해제 후 ${delay}일 동안 자금을 쓸 수 없음 (급한 지출에 대응 불가)`,
        "SR 수수료(brokerage) 변경·순위 하락 시 보상 감소",
        "투표 보상은 전체 득표 변화에 따라 달라짐",
      ],
      assumptions: [
        `투표 대상: ${st?.srName ?? "-"} (상위 ${st?.candidates ?? 27}개 SR 중 투표자 APR 최대, SR 수수료 ${st ? new Decimal(st.brokerage).mul(100).toFixed() : "-"}%).`,
        `투표자 APR = (블록 보상 ${st?.blockRewardPerBlockTrx ?? "-"} TRX × 연간 블록 ÷ 27 + 투표 보상 ${st?.voteRewardPerBlockTrx ?? "-"} TRX × 연간 블록 × 득표 비율) × (1 − 수수료) ÷ 득표수.`,
        `보상 기간 ${rewardDays.toFixed()}일 = 운용 ${days}일 − 해제 대기 ${delay}일 − 투표 반영 지연 ${voteDelay.toFixed()}일(유지보수 주기${st?.voteDelayDays ? "" : ", 조회 실패로 6시간 가정"}).`,
        holdsTrx
          ? "TRX를 그대로 스테이킹합니다."
          : rt
            ? `${holdsUsdd ? `PSM으로 USDD ${investable.toFixed()} → USDT ${usdtStart.toFixed()}, ` : ""}SunSwap V2 풀(USDT ${new Decimal(sw!.reserveUsdt).toDecimalPlaces(0).toFixed()} / TRX ${new Decimal(sw!.reserveTrx).toDecimalPlaces(0).toFixed()}) 기준 ${usdtStart.toFixed()} USDT → ${trxLabel.toDecimalPlaces(4).toFixed()} TRX. 기간 끝 풀 가격이 지금과 같다고 보고 ${rt.usdtBack.toDecimalPlaces(4).toFixed()} USDT로 되돌립니다. 교환 손실(수수료 0.3%×2 + 가격 영향) ${rt.loss.toDecimalPlaces(4).toFixed()} USDT는 전환 비용으로 뺐습니다.`
            : "교환 견적이 없어 계산하지 않았습니다.",
      ],
      quoteIds: q ? [q.id] : [],
      dataModes: modesOf(q),
    };
  })();

  const hold: Plan = {
    ...base,
    id: `${idPrefix}-HOLD`,
    key: "HOLD",
    title: "기준선: 전액 보유",
    allocation: { invested: "0", held: amount.toFixed() },
    steps: [step("hold", "전액 보유", needs.asset, amount, { energy: 0, bandwidth: 0 }, "-")],
    baseYield: "0",
    rewards: { status: "none", note: "예치하지 않으므로 보상이 없습니다." },
    costs: { energy: 0, bandwidth: 0, trx: "0", inAsset: "0", conversionFees: "0" },
    netReturn: "0",
    eligibility: "eligible",
    reasons: [],
    risks: ["수익 없음"],
    assumptions: ["거래하지 않으므로 비용이 없습니다."],
    quoteIds: [],
    dataModes: [],
  };

  // 인출일별 분산: 필요한 날짜별 구간을 여러 상품에 나눠 넣는 조합 중 최선 (단일 계획 A도 조합 중 하나라 A 이상)
  const planL = buildLadderPlan(needs, inputs, { A: planA, B: planB, C: planC }, base, idPrefix, now);
  const plans = [planA, planA2, planB, planC, planL, hold];
  const rec = recommend(plans, needs.riskProfile);
  rec.plan.recommended = true;
  const stakeNote = stakeNeedNote(rec.plan, costBasis);
  if (stakeNote) warnings.push(stakeNote);

  // 차별점 비교: 지출 일정·비용을 무시하고 최고 APY에 전액 예치했다면
  const naive = naiveComparison(needs, amount, days, holdsTrx ? [jtrx] : holdsUsdd ? [jusdd] : [jusdt, jusdd], costBasis, reserved.inside.length);

  return {
    id: `${idPrefix}-${now.getTime()}`,
    chain,
    createdAt: now.toISOString(),
    engineVersion: ENGINE_VERSION,
    needs: needsIn,
    conversions: fx.conversions.length ? fx.conversions : undefined,
    reserved: {
      total: reserved.total.toFixed(),
      expensesInHorizon: reserved.expenses.toFixed(),
      buffer: reserved.buffer.toFixed(),
      outsideHorizon: reserved.outside,
    },
    investable: investable.toFixed(),
    plans,
    recommendation: { planId: rec.plan.id, reason: rec.reason },
    naiveComparison: naive,
    quotes: (holdsTrx ? [jtrx, staking, jusdd, psm] : holdsUsdd ? [jusdd, jusdt, psm, staking] : [jusdt, jusdd, psm, staking]).filter(Boolean) as ProductQuote[],
    screening: buildScreening(needs, investable, inputs.markets ?? marketsFromQuotes(holdsTrx ? [jtrx] : [jusdt, jusdd]), { jusdd, staking, plans, usddSavings: inputs.usddSavings }),
    costBasis,
    warnings,
  };
}

/** 보유 자산에 맞지 않아 계산하지 않는 계획 (숫자는 0, 사유만) */
function excludedPlan(base: Pick<Plan, "chain" | "asset" | "inputVersion" | "horizonDays" | "principal" | "label" | "recommended">, id: string, key: Plan["key"], title: string, riskClass: NonNullable<Plan["riskClass"]>, amount: Decimal, reasons: string[]): Plan {
  return {
    ...base,
    id,
    key,
    riskClass,
    title,
    allocation: { invested: "0", held: amount.toFixed() },
    steps: [],
    baseYield: "0",
    rewards: { status: "none", note: "계산하지 않았습니다." },
    costs: { energy: 0, bandwidth: 0, trx: "0", inAsset: undefined, conversionFees: "0" },
    netReturn: undefined,
    eligibility: "ineligible",
    reasons,
    risks: [],
    assumptions: [],
    quoteIds: [],
    dataModes: [],
  };
}

/** 전체 시장 목록을 받지 못했을 때 가진 시세로 만든 최소 탐색 표 */
function marketsFromQuotes(qs: (ProductQuote | undefined)[]): MarketInfo[] {
  return (qs.filter(Boolean) as ProductQuote[]).map((q) => ({
    symbol: q.token,
    jToken: q.address,
    baseApy: q.baseRate ?? "0",
    underlyingApy: "0",
    miningApy: q.rewards.apr ?? "0",
    paused: !q.active,
    depositedUsd: q.liquidity ?? "0",
    fetchedAt: q.source.fetchedAt,
  }));
}

function recommend(plans: Plan[], profile?: RiskProfile): { plan: Plan; reason: string } {
  const hold = plans.find((p) => p.key === "HOLD" || p.key.startsWith("HOLD"))!;
  const candidates = plans.filter((p) => p !== hold && p.eligibility !== "ineligible" && p.netReturn !== undefined);
  const positive = candidates.filter((p) => new Decimal(p.netReturn!).gt(0));
  if (positive.length) {
    if (prefersLowExposure(profile)) {
      // 보수적: 수익이 나는 계획 중 예치 비중이 가장 작은 것 (같으면 순수익이 큰 것)
      const best = [...positive].sort((a, b) => new Decimal(a.allocation.invested).cmp(b.allocation.invested) || new Decimal(b.netReturn!).cmp(a.netReturn!))[0];
      return { plan: best, reason: `${RISK_KO.conservative} 성향이라 순수익이 양수인 계획 중 예치 비중이 가장 작은 ${best.title}을(를) 고릅니다 (조건부 분석).` };
    }
    const best = [...positive].sort((a, b) => new Decimal(b.netReturn!).cmp(a.netReturn!))[0];
    return { plan: best, reason: `${best.title}의 예상 순수익이 비용을 빼고도 가장 큽니다${profile ? ` (${RISK_KO[profile]} 성향 허용 범위 안)` : ""} (조건부 분석).` };
  }
  const unknown = plans.some((p) => p !== hold && p.eligibility !== "ineligible" && p.netReturn === undefined);
  if (unknown) return { plan: hold, reason: "비용 또는 환산 근거를 확인하지 못해 순수익 순위를 매길 수 없습니다. 실행 권고를 보류하고 보유를 기준으로 둡니다." };
  if (candidates.length) return { plan: hold, reason: "왕복 거래비용이 예상 이자보다 커서 모든 예치 경로의 순수익이 0 이하입니다. 거래를 보류하고 보유를 권고합니다." };
  return { plan: hold, reason: "실행 조건을 통과한 예치 경로가 없습니다. 보유를 권고합니다." };
}

/** 차별점 비교: 지출 일정·거래비용을 무시하고 최고 APY 상품에 전액 예치했다면 (지출일마다 중도 인출) */
function naiveComparison(
  needs: UserNeeds,
  amount: Decimal,
  days: number,
  quotes: (ProductQuote | undefined)[],
  basis: CostBasis | undefined,
  expenseCount: number,
): PlanningResult["naiveComparison"] {
  const best = (quotes.filter((q) => q?.baseRate) as ProductQuote[]).sort((a, b) => new Decimal(b.baseRate!).cmp(a.baseRate!))[0];
  if (!best || amount.lte(0)) return undefined;
  const y = baseYield(amount, new Decimal(best.baseRate!), best.rateType ?? "APY", days);
  const steps = [
    step("approve", "", "", amount, TYPICAL_RESOURCES.approve, JUSTLEND_RES_SRC),
    step("supply", "", "", amount, jTokenResources(basis, best.market).supply, ""),
    ...Array.from({ length: expenseCount + 1 }, () => step("withdraw", "", "", amount, jTokenResources(basis, best.market).withdraw, "")),
  ];
  const c = stepCosts(steps, basis, needs.asset === "TRX" ? "TRX" : "USDT");
  return {
    title: `최고 APY(${best.market})에 ${amount.toFixed()} ${needs.asset} 전액 예치`,
    description:
      expenseCount > 0
        ? `지출일마다 중도 인출이 필요하고(인출 ${expenseCount + 1}회), 그날 시장 유동성이 부족하면 지출 재원을 제때 꺼내지 못할 수 있습니다.`
        : "지출은 없지만 거래비용을 고려하지 않고 APY만 보고 고른 결과입니다.",
    netReturn: c.inAsset !== undefined ? y.minus(c.inAsset).toFixed() : undefined,
  };
}

export interface NileInputs {
  jtrx?: ProductQuote;
  /** Nile USDD 경로(계획 B): jUSDD, USDD 2.0 PSM, SunSwap V2 TRX↔USDT 2.0 경로 */
  jusdd?: ProductQuote;
  psm?: ProductQuote;
  swap?: SwapMarket;
  /** Nile TRX 스테이킹 + SR 투표 (Nile 체인 파라미터·SR 목록) */
  staking?: ProductQuote;
  costBasis?: CostBasis;
  /** 지갑에서 읽은 실제 TRX 잔고. 없으면 입력 금액(가정)을 쓴다 */
  walletBalanceTrx?: string;
}

/** Nile jTRX 거래 자원: 체인 실측값이 있으면 쓰고, 없으면 JustLend MCP 일반값 */
export function nileResources(costBasis?: Pick<CostBasis, "jtrxEnergy" | "costMode">) {
  const m = costBasis?.jtrxEnergy;
  return m
    ? {
        depositRes: { energy: m.mint, bandwidth: m.bandwidth?.mint ?? TYPICAL_RESOURCES.supply_trx.bandwidth },
        withdrawRes: { energy: m.redeem, bandwidth: m.bandwidth?.redeem ?? TYPICAL_RESOURCES.withdraw.bandwidth },
        partialRes: { energy: m.redeemUnderlying, bandwidth: m.bandwidth?.redeemUnderlying ?? TYPICAL_RESOURCES.withdraw.bandwidth },
        resSrc: `Nile jTRX 최근 성공 거래 ${m.sampleSize}건 ${statKo(costBasis)}`,
      }
    : { depositRes: TYPICAL_RESOURCES.supply_trx, withdrawRes: TYPICAL_RESOURCES.withdraw, partialRes: TYPICAL_RESOURCES.withdraw, resSrc: JUSTLEND_RES_SRC };
}

/** Nile jTRX 두 배분안. 실제 잔고·수수료 재원에 맞춰 예치액을 줄인다. */
// 계획 ID는 계산마다 달라야 한다: 실행 기록(계획 ID + 단계 번호)이 다시 계산한 새 계획에 달라붙지 않게
export function buildNilePlans(needsIn: UserNeeds, inputs: NileInputs, now = new Date(), idPrefix = `n${now.getTime().toString(36)}`): Omit<PlanningResult, "explanation"> {
  const { jtrx, costBasis } = inputs;
  // USDT·USDD 지출은 오늘 환전할 TRX 필요량으로 바꾼다 (Nile은 브리지 PSM 경로 견적)
  const fx = convertExpenses({ ...needsIn, asset: "TRX" }, inputs);
  const needs = fx.needs;
  const days = needs.endDate ? daysBetween(needs.startDate, needs.endDate) : 30;
  const total = new Decimal(inputs.walletBalanceTrx ?? needs.amount ?? 0);
  const reserved = reservedWithinHorizon(needs);
  const warnings: string[] = [];
  if (!inputs.walletBalanceTrx) warnings.push("지갑이 연결되지 않아 입력한 보유액을 가정으로 사용했습니다. 실행 전에 실제 잔고로 다시 계산합니다.");
  warnings.push(...fx.problems);

  const { depositRes, withdrawRes, resSrc } = nileResources(costBasis);
  const feeBudget = costBasis
    ? new Decimal((depositRes.energy + withdrawRes.energy) * costBasis.energyFeeSun + (depositRes.bandwidth + withdrawRes.bandwidth) * costBasis.bandwidthFeeSun).div(1_000_000)
    : new Decimal(0);
  const maxDeposit = Decimal.max(total.minus(reserved.total).minus(feeBudget), 0);

  const variants: { key: Plan["key"]; share: Decimal; title: string }[] = [
    { key: "NILE_80", share: total.minus(reserved.total), title: "최대 예치안 (지출 재원만 보유)" },
    { key: "NILE_50", share: total.mul("0.5"), title: "절반 예치안 (50% 보유)" },
  ];

  const plans: Plan[] = variants.map(({ key, share, title }) => {
    const intended = Decimal.max(share, 0);
    const deposit = Decimal.min(intended, maxDeposit).toDecimalPlaces(6, Decimal.ROUND_DOWN);
    const steps = [
      step("hold", "지출 재원·수수료 재원 보유", "TRX", total.minus(deposit), { energy: 0, bandwidth: 0 }, "-"),
      { ...step("supply", "JustLend jTRX 예치 (mint)", "TRX", deposit, depositRes, resSrc, jtrx?.address), day: 0 },
      { ...step("withdraw", "인출 (redeem)", "TRX", deposit, withdrawRes, resSrc, jtrx?.address), day: days },
    ];
    const rate = jtrx?.baseRate ? new Decimal(jtrx.baseRate) : undefined;
    const rt = jtrx?.rateType ?? "APR";
    const y = rate ? baseYield(deposit, rate, rt, days) : ZERO;
    const costs = stepCosts(steps, costBasis, "TRX");
    const net = costs.inAsset !== undefined && rate ? y.minus(costs.inAsset) : undefined;
    const di = dataIssues(jtrx, "nile", now);
    const blocking = [...di.blocking, ...lendingIssues(jtrx, deposit)];
    di.conditional.push(...lendingWarnings(jtrx, deposit));
    if (deposit.lte(0)) blocking.push("지출 재원과 수수료 재원을 빼면 예치할 TRX가 없습니다.");
    const reasons = [...blocking, ...di.conditional];
    if (deposit.lt(intended)) reasons.push(`수수료 재원 ${feeBudget.toFixed(2)} TRX를 남기기 위해 예치액을 ${intended.toFixed(2)} → ${deposit.toFixed(2)} TRX로 줄였습니다.`);
    return {
      id: `${idPrefix}-${key}`,
      key,
      title,
      chain: "nile",
      asset: "TRX",
      inputVersion: needs.version,
      horizonDays: days,
      principal: total.toFixed(),
      allocation: { invested: deposit.toFixed(), held: total.minus(deposit).toFixed() },
      steps,
      baseRate: jtrx?.baseRate,
      rateType: rt,
      baseYield: y.toFixed(),
      rewards: { status: "none", note: "Nile 테스트넷 보상은 계산하지 않습니다." },
      costs,
      netReturn: net?.toFixed(),
      breakEvenDays: rate && costs.inAsset ? breakEvenDays(deposit, rate, rt, new Decimal(costs.inAsset))?.toFixed() : undefined,
      eligibility: blocking.length ? "ineligible" : di.conditional.length ? "conditional" : "eligible",
      reasons,
      risks: ["테스트 토큰이며 실제 가치가 없습니다", "Nile 네트워크 상태에 따라 확정이 지연될 수 있습니다", "스마트 계약 위험"],
      assumptions: [
        "Nile jTRX 계약에서 읽은 supplyRatePerBlock × 연간 블록 수(10,512,000)로 APR을 계산했습니다.",
        "테스트 TRX 수익은 실제 USDT 수익으로 환산하지 않습니다. Mainnet 계획의 실행 증거가 아닙니다.",
      ],
      recommended: false,
      quoteIds: jtrx ? [jtrx.id] : [],
      dataModes: modesOf(jtrx),
      label: "Nile 실행 계획",
    };
  });

  const hold: Plan = {
    id: `${idPrefix}-HOLD`,
    key: "HOLD",
    title: "기준선: 전액 보유",
    chain: "nile",
    asset: "TRX",
    inputVersion: needs.version,
    horizonDays: days,
    principal: total.toFixed(),
    allocation: { invested: "0", held: total.toFixed() },
    steps: [step("hold", "전액 보유", "TRX", total, { energy: 0, bandwidth: 0 }, "-")],
    baseYield: "0",
    rewards: { status: "none", note: "-" },
    costs: { energy: 0, bandwidth: 0, trx: "0", inAsset: "0", conversionFees: "0" },
    netReturn: "0",
    eligibility: "eligible",
    reasons: [],
    risks: ["수익 없음"],
    assumptions: [],
    recommended: false,
    quoteIds: [],
    dataModes: [],
    label: "Nile 실행 계획",
  };
  // 같은 계획 엔진으로 스테이킹(C)·인출일별 분산(L)·제외 경로(B)를 Nile 실시간 값으로 계산한다.
  // jTRX 전액·절반 예치(A·A-2)는 위 두 배분안과 같으므로 엔진 결과에서 뺀다. 수수료 재원은 먼저 떼어 둔다.
  const engineNeeds: UserNeeds = { ...needs, asset: "TRX", amount: Decimal.max(total.minus(feeBudget), 0).toDecimalPlaces(6, Decimal.ROUND_DOWN).toFixed() };
  const m = costBasis?.jtrxEnergy;
  const engineBasis: CostBasis | undefined = costBasis && {
    ...costBasis,
    jTokenCosts: m ? { jTRX: { supply: depositRes, withdraw: withdrawRes, sampleSize: m.sampleSize } } : undefined,
  };
  const engine = buildMainnetPlans(engineNeeds, { jtrx, staking: inputs.staking, jusdd: inputs.jusdd, psm: inputs.psm, swap: inputs.swap, costBasis: engineBasis }, now, idPrefix, "nile");
  const fromEngine = engine.plans
    .filter((p) => p.key === "B" || p.key === "C" || p.key === "L")
    .map((p) => ({
      ...p,
      recommended: false,
      principal: total.toFixed(),
      reasons: p.reasons,
      assumptions: [...p.assumptions, `수수료 재원 ${feeBudget.toDecimalPlaces(2).toFixed()} TRX를 뺀 ${engineNeeds.amount} TRX로 계산했습니다 (Nile 테스트 TRX, 실제 가치 없음).`],
      label: "Nile 실행 계획" as const,
    }));
  const all = [...plans, ...fromEngine, hold];
  const rec = recommend(all, needs.riskProfile);
  rec.plan.recommended = true;
  const stakeNote = stakeNeedNote(rec.plan, costBasis);
  if (stakeNote) warnings.push(stakeNote);
  if (rec.plan === hold) warnings.push("모든 계획의 순수익이 0 이하라 경제적으로는 보유가 유리합니다. 테스트넷 흐름을 확인하려면 원하는 계획을 골라 실행할 수 있습니다 (예상 손익은 표에 그대로 표시).");

  return {
    id: `${idPrefix}-${now.getTime()}`,
    chain: "nile",
    createdAt: now.toISOString(),
    engineVersion: ENGINE_VERSION,
    needs: needsIn,
    conversions: fx.conversions.length ? fx.conversions : undefined,
    reserved: {
      total: reserved.total.toFixed(),
      expensesInHorizon: reserved.expenses.toFixed(),
      buffer: reserved.buffer.toFixed(),
      outsideHorizon: reserved.outside,
    },
    investable: maxDeposit.toFixed(),
    plans: all,
    recommendation: { planId: rec.plan.id, reason: rec.reason },
    quotes: [jtrx, inputs.staking, inputs.jusdd, inputs.psm].filter(Boolean) as ProductQuote[],
    screening: engine.screening,
    costBasis,
    warnings: [...warnings, ...engine.warnings.filter((w) => !warnings.includes(w))],
  };
}
