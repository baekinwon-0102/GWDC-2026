import { Decimal } from "./units";
import { holdingsOf, needsForHolding } from "./needs";
import { buildMainnetPlans, type MainnetInputs } from "./planning";
import type { PlanningResult, PortfolioPart, PortfolioSummary, UserNeeds } from "./schemas";

// 여러 자산 보유 (예: USDT 5,000 + TRX 20,000).
// 자산마다 그 자산으로 낼 지출과 여유액만 떼어 내 같은 계획 엔진을 돌린다:
//   지출 재원 먼저 확보 → 인출일별 구간 → 예치·USDD 경로·스테이킹·인출일별 분산(L)·보유 비교 → 위험 성향으로 추천.
// 자산 간 교환으로 지출을 충당하지는 않는다 (각 지출은 그 자산 보유분에서 낸다). 합계는 USDT로 환산해 보인다.

const EMPTY_EXPLANATION: PlanningResult["explanation"] = { text: "", source: "template" };

export function buildPortfolioPlans(needs: UserNeeds, inputs: MainnetInputs, now = new Date()): Omit<PlanningResult, "explanation"> {
  const held = holdingsOf(needs);
  if (held.length <= 1) return buildMainnetPlans(needs, inputs, now);

  const trxPerUsdt = inputs.costBasis?.trxPerUsdt ? new Decimal(inputs.costBasis.trxPerUsdt) : undefined;
  // USDD는 JustLend 오라클의 USDD·USDT 가격 비율(trxPerUsdd ÷ trxPerUsdt)로 환산, 없으면 PSM 기준 1:1
  const trxPerUsdd = inputs.costBasis?.trxPerUsdd ? new Decimal(inputs.costBasis.trxPerUsdd) : undefined;
  const usddPx = trxPerUsdd && trxPerUsdt && trxPerUsdt.gt(0) ? trxPerUsdd.div(trxPerUsdt) : new Decimal(1);
  const toUsdt = (asset: string, v: Decimal): Decimal | undefined =>
    asset === "USDT" ? v : asset === "USDD" ? v.mul(usddPx) : trxPerUsdt && trxPerUsdt.gt(0) ? v.div(trxPerUsdt) : undefined;

  const parts: PortfolioPart[] = held.map((h) => {
    const r = buildMainnetPlans(needsForHolding(needs, h), inputs, now, `m-${h.asset}`);
    const rec = r.plans.find((p) => p.id === r.recommendation.planId);
    return {
      asset: h.asset,
      amount: h.amount,
      result: { ...r, explanation: EMPTY_EXPLANATION },
      valueUsdt: toUsdt(h.asset, new Decimal(h.amount))?.toFixed(),
      recommendedNetUsdt: rec?.netReturn !== undefined ? toUsdt(h.asset, new Decimal(rec.netReturn))?.toFixed() : undefined,
    };
  });

  const sum = (xs: (string | undefined)[]) => (xs.every((x) => x !== undefined) ? xs.reduce((s, x) => s.plus(x!), new Decimal(0)) : undefined);
  const totalValue = sum(parts.map((p) => p.valueUsdt));
  const totalNet = sum(parts.map((p) => p.recommendedNetUsdt));

  // 추천 계획을 합친 배분표: 인출일별 분산이면 구간별 넣을 곳, 아니면 예치액과 보유액
  const allocation: PortfolioSummary["allocation"] = [];
  const add = (asset: string, product: string, amount: Decimal) => {
    if (amount.lte(0)) return;
    const hit = allocation.find((a) => a.asset === asset && a.product === product);
    if (hit) hit.amount = new Decimal(hit.amount).plus(amount).toFixed();
    else allocation.push({ asset, product, amount: amount.toFixed() });
  };
  for (const p of parts) {
    const rec = p.result.plans.find((x) => x.id === p.result.recommendation.planId)!;
    if (rec.ladder?.length) for (const b of rec.ladder) add(p.asset, b.productLabel, new Decimal(b.amount));
    else {
      add(p.asset, rec.key === "HOLD" ? "보유" : rec.title, new Decimal(rec.allocation.invested));
      if (rec.key !== "HOLD") add(p.asset, "보유 (지출 재원·여유액 포함)", new Decimal(rec.allocation.held));
    }
  }
  if (totalValue && totalValue.gt(0))
    for (const a of allocation) {
      const v = toUsdt(a.asset, new Decimal(a.amount));
      if (v) a.share = v.div(totalValue).toFixed();
    }

  const notes = [
    "자산마다 그 자산으로 낼 지출(과 대표 자산의 비상 여유액)을 먼저 확보하고, 남은 금액에 같은 배분 로직(인출일별 구간·위험 성향·비용 차감)을 적용했습니다.",
    "각 지출은 그 자산 보유분에서 냅니다. 자산 간 교환으로 지출을 충당하지 않습니다.",
    trxPerUsdt ? `USDT 환산은 JustLend 오라클 가격(1 USDT = ${trxPerUsdt.toDecimalPlaces(4).toFixed()} TRX)을 썼습니다. TRX 가격이 바뀌면 합계도 바뀝니다.` : "TRX→USDT 환산 근거가 없어 합계를 산정하지 않았습니다.",
  ];

  const primary = parts[0].result;
  const { explanation: _e, ...primaryBase } = primary;
  return {
    ...primaryBase,
    id: `m-${now.getTime()}`,
    needs,
    warnings: parts.flatMap((p) => p.result.warnings.map((w) => `[${p.asset}] ${w}`)),
    portfolio: { parts, totalValueUsdt: totalValue?.toFixed(), totalNetUsdt: totalNet?.toFixed(), allocation, notes },
  };
}
