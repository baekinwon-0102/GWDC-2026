import { Decimal } from "./units";
import type { Plan } from "./schemas";
import type { MarketInfo } from "./screening";

// 과거 재생 (Tracking & Review): 같은 계획을 최근 N일 동안 실행했다면 실제 일별 금리로 얼마였을지 계산한다.
// 원문이 허용한 "명확히 표시한 과거 재생"이다. 실제 거래는 없으며 화면에 '시뮬레이션'으로 표시한다.
// 비용은 현재 실측 비용을 쓴다 (과거 수수료 단가 이력은 받지 않음).

export interface ReplayPoint {
  date: string;
  /** 계획 가정(분석 시점 금리 고정)의 누적 수익 */
  expected: string;
  /** 실제 일별 금리의 누적 수익 (기본 + 채굴) */
  replay: string;
}

export interface ReplayResult {
  planKey: string;
  planTitle: string;
  market: string;
  invested: string;
  days: number;
  horizonDays: number;
  window: { from: string; to: string };
  expected: { baseYield: string; netReturn: string };
  replay: { baseYield: string; mining: string; netReturn: string; avgBaseApy: string; avgMiningApy: string };
  costs: string;
  difference: string;
  series: ReplayPoint[];
  notes: string[];
}

/** 재생 가능한 계획: A·A-2는 보유 자산 시장(jUSDT 또는 jTRX), B는 jUSDD */
const MARKET_OF: Record<string, true> = { A: true, A2: true, B: true };

export function replayPlan(plan: Plan, markets: MarketInfo[]): ReplayResult {
  const market = plan.key === "B" ? "USDD" : MARKET_OF[plan.key] ? plan.asset : undefined;
  if (!market) throw new Error(`계획 ${plan.key}는 과거 재생을 지원하지 않습니다 (JustLend 예치 계획 A·A-2·B만).`);
  const m = markets.find((x) => x.symbol === market);
  const hist = m?.history ?? [];
  if (!hist.length) throw new Error(`j${market} 일별 금리 이력을 받지 못했습니다.`);
  const days = Math.min(plan.horizonDays, hist.length);
  const window = hist.slice(-days);
  const invested = new Decimal(plan.allocation.invested);
  const rate = new Decimal(plan.baseRate ?? 0);
  const costs = new Decimal(plan.costs.inAsset ?? 0).plus(plan.costs.conversionFees);

  let expected = new Decimal(0);
  let base = new Decimal(0);
  let mining = new Decimal(0);
  let sumBase = new Decimal(0);
  let sumFarm = new Decimal(0);
  const series: ReplayPoint[] = [];
  for (const h of window) {
    const apy = new Decimal(h.baseApy).plus(h.underlyingApy);
    // APY는 복리: 하루 이자율 = (1 + APY)^(1/365) − 1. 원금 + 누적 이자에 붙는다.
    base = base.plus(invested.plus(base).mul(apy.plus(1).pow(new Decimal(1).div(365)).minus(1)));
    expected = expected.plus(invested.plus(expected).mul(rate.plus(1).pow(new Decimal(1).div(365)).minus(1)));
    // 채굴 보상은 원금에 대해 매일 단리로 지급된다 (매주 청구)
    mining = mining.plus(invested.mul(h.farmApy).div(365));
    sumBase = sumBase.plus(apy);
    sumFarm = sumFarm.plus(h.farmApy);
    series.push({ date: h.date, expected: expected.toFixed(6), replay: base.plus(mining).toFixed(6) });
  }
  const r4 = (d: Decimal) => d.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed();
  const expectedNet = expected.minus(costs);
  const replayNet = base.plus(mining).minus(costs);
  const notes = [
    `시뮬레이션: 실제 거래 없이 j${market}의 최근 ${days}일 실제 일별 금리(JustLend 앱 백엔드 depositDetail)로 계산했습니다.`,
    "비용은 현재 실측 거래비용을 썼습니다 (과거 수수료 단가 이력은 반영하지 않음).",
  ];
  if (plan.horizonDays > days) notes.push(`운용 기간 ${plan.horizonDays}일 중 이력이 있는 ${days}일만 재생했습니다.`);
  if (mining.gt(0)) notes.push("채굴 보상은 해당 기간 실제로 지급된 채굴 APY로 계산한 참고값입니다. 매주 직접 청구해야 합니다.");
  return {
    planKey: plan.key,
    planTitle: plan.title,
    market: `j${market}`,
    invested: invested.toFixed(),
    days,
    horizonDays: plan.horizonDays,
    window: { from: window[0].date, to: window[window.length - 1].date },
    expected: { baseYield: r4(expected), netReturn: r4(expectedNet) },
    replay: { baseYield: r4(base), mining: r4(mining), netReturn: r4(replayNet), avgBaseApy: sumBase.div(days).toFixed(), avgMiningApy: sumFarm.div(days).toFixed() },
    costs: r4(costs),
    difference: r4(replayNet.minus(expectedNet)),
    series,
    notes,
  };
}
