import { Decimal } from "./units";
import type { CostBasis, PlanStep } from "./schemas";
import type { SwapMarket } from "./planning";

// 거래비용 가정: 비용 기준(실측 최대값 / 중앙값 / 공식 일반값)과 Energy 조달 방식(소각 / 스테이킹 / 대여).
// 계획 계산은 그대로 두고, 입력(CostBasis·교환 비용)을 고른 기준으로 바꾸고 Energy를 TRX로 환산하는 방식만 바꾼다.

export type CostMode = NonNullable<CostBasis["costMode"]>;
export type EnergyMode = NonNullable<CostBasis["energyMode"]>["mode"];

export const COST_MODE_KO: Record<CostMode, string> = { max: "실측 최대값 (보수적)", median: "실측 중앙값", typical: "공식 일반값" };
export const ENERGY_MODE_KO: Record<EnergyMode, string> = { burn: "TRX 소각", stake: "스테이킹으로 확보", rent: "JustLend 대여" };

/** 실측값 표기 */
export const statKo = (b?: Pick<CostBasis, "costMode">) => (b?.costMode === "median" ? "실측 중앙값" : "실측 최대값");

/** Energy E를 JustLend 대여로 한 번 빌리는 비용 (TRX): 대여료(기간) + 사용분 차감(Energy를 다 쓰면 하루치 × 사용분 비율) + 수수료(최소 수수료 이상) */
export function rentalCostTrx(energy: number, r: NonNullable<NonNullable<CostBasis["energyMode"]>["rent"]>, energyStakePerTrx: string): Decimal {
  if (energy <= 0) return new Decimal(0);
  const trx = new Decimal(energy).div(energyStakePerTrx).ceil(); // 위임받아야 하는 TRX
  const rate = new Decimal(r.ratePerTrxSec);
  const rent = trx.mul(rate).mul(r.durationSec);
  const usage = trx.mul(rate).mul(86400).mul(r.usageChargeRatio);
  const fee = Decimal.max(new Decimal(r.minFeeTrx), trx.mul(r.feeRatio));
  return rent.plus(usage).plus(fee);
}

/** 거래 단계들의 Energy 비용 (TRX). 대여는 같은 날의 Energy를 합쳐 날짜마다 한 번 빌린다 */
export function energyCostTrx(steps: PlanStep[], basis: CostBasis): Decimal {
  const em = basis.energyMode;
  const total = steps.reduce((s, x) => s + x.energy, 0);
  if (em?.mode === "stake") return new Decimal(0);
  if (em?.mode === "rent" && em.rent && em.energyStakePerTrx) {
    const byDay = new Map<number, number>();
    for (const s of steps) if (s.energy > 0) byDay.set(s.day ?? 0, (byDay.get(s.day ?? 0) ?? 0) + s.energy);
    return [...byDay.values()].reduce((a, e) => a.plus(rentalCostTrx(e, em.rent!, em.energyStakePerTrx!)), new Decimal(0));
  }
  return new Decimal(total).mul(basis.energyFeeSun).div(1_000_000);
}

/** 하루에 가장 많이 쓰는 Energy (스테이킹 방식에서 필요한 TRX 계산용) */
export function peakDayEnergy(steps: PlanStep[]): number {
  const byDay = new Map<number, number>();
  for (const s of steps) if (s.energy > 0) byDay.set(s.day ?? 0, (byDay.get(s.day ?? 0) ?? 0) + s.energy);
  return Math.max(0, ...byDay.values());
}

/** 계획 가정 문장 */
export function costAssumption(b?: CostBasis): string {
  const em = b?.energyMode;
  const mode = b?.costMode ?? "max";
  const base = `거래 Energy는 ${COST_MODE_KO[mode]} 기준입니다.`;
  if (!em || em.mode === "burn") return `${base} Energy를 TRX 소각(Energy당 ${b?.energyFeeSun ?? "-"} sun)으로 지불한다고 가정합니다. 대역폭 무료 한도는 반영하지 않았습니다.`;
  if (em.mode === "stake")
    return `${base} Energy는 Energy용으로 스테이킹해 둔 TRX로 충당해 소각 비용이 없다고 가정합니다(스테이킹 1 TRX당 하루 ${Number(em.energyStakePerTrx ?? 0).toFixed(2)} Energy). 스테이킹 TRX는 투표권이 그대로 있어 투표 보상은 받을 수 있지만, 해제에 대기 기간이 있습니다. 대역폭은 소각으로 계산합니다.`;
  return `${base} Energy는 날짜마다 필요한 만큼 JustLend Energy 대여로 ${Math.round((em.rent?.durationSec ?? 3600) / 60)}분 빌린다고 가정합니다(대여료 + 사용분 차감 ${new Decimal(em.rent?.usageChargeRatio ?? 0).mul(100).toFixed()}%일 + 수수료 최소 ${em.rent?.minFeeTrx ?? "-"} TRX). 대역폭은 소각으로 계산합니다.`;
}

/**
 * 입력의 비용 값을 고른 기준으로 바꾼다.
 * median: 실측 최대값 대신 중앙값. typical: jToken은 공식 일반값(JustLend MCP), 일반값이 없는 PSM·교환은 중앙값.
 */
export function applyCostOptions<T extends { costBasis?: CostBasis; swap?: SwapMarket }>(inputs: T, mode: CostMode, energy?: CostBasis["energyMode"]): T {
  const b = inputs.costBasis;
  if (!b) return inputs;
  const nb: CostBasis = { ...b, costMode: mode, energyMode: energy ?? b.energyMode };
  let swap = inputs.swap;
  if (mode !== "max") {
    if (b.psmEnergy?.median) nb.psmEnergy = { ...b.psmEnergy, sell: b.psmEnergy.median.sell, buy: b.psmEnergy.median.buy };
    if (swap?.costs.median)
      swap = { ...swap, costs: { ...swap.costs, toTrx: { ...swap.costs.toTrx, energy: swap.costs.median.toTrx }, toUsdt: { ...swap.costs.toUsdt, energy: swap.costs.median.toUsdt } } };
    if (mode === "median") {
      if (b.jTokenCosts)
        nb.jTokenCosts = Object.fromEntries(Object.entries(b.jTokenCosts).map(([k, v]) => [k, v.median ? { ...v, supply: v.median.supply, withdraw: v.median.withdraw } : v]));
      if (b.jtrxEnergy?.median) nb.jtrxEnergy = { ...b.jtrxEnergy, mint: b.jtrxEnergy.median.mint, redeem: b.jtrxEnergy.median.redeem, redeemUnderlying: b.jtrxEnergy.median.redeemUnderlying };
    } else {
      nb.jTokenCosts = undefined;
      nb.jtrxEnergy = undefined;
    }
  }
  return { ...inputs, costBasis: nb, swap };
}

/** 스테이킹 방식일 때: 계획의 하루 최대 Energy를 만들려면 Energy용으로 스테이킹해 둬야 하는 TRX */
export function stakeNeedNote(p: { title: string; steps: PlanStep[] }, b?: CostBasis): string | undefined {
  const em = b?.energyMode;
  if (em?.mode !== "stake" || !em.energyStakePerTrx) return undefined;
  const peak = peakDayEnergy(p.steps);
  if (!peak) return undefined;
  const trx = new Decimal(peak).div(em.energyStakePerTrx).ceil();
  return `Energy 스테이킹 가정: ${p.title}은 하루 최대 ${peak.toLocaleString()} Energy가 필요해, 약 ${trx.toNumber().toLocaleString()} TRX를 Energy용으로 스테이킹해 두어야 소각 없이 실행할 수 있습니다.`;
}
