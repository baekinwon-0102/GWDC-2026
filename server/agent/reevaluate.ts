import { z } from "zod";
import { Decimal } from "../../shared/units";
import { buildMainnetPlans, stepCosts, type MainnetInputs } from "../../shared/planning";
import type { ReevaluateResponse } from "../../shared/agent";
import type { Plan, UserNeeds } from "../../shared/schemas";
import { explanationIssues, unknownNumbers, type LlmProvider } from "../llm/provider";
import { checkAnomalies } from "./tools";

// 재평가 에이전트: 저장된 분석을 최신 시세로 다시 계산해 추천이 바뀌었는지 코드가 판정한다.
// LLM은 바뀐 점을 2~3문장으로 설명만 한다. 이전 값(브라우저 저장)은 비교 표시용이며 판정에 쓰지 않는다.

export const PreviousAnalysis = z.object({
  createdAt: z.string(),
  recommendedKey: z.string(),
  plans: z.array(z.object({ key: z.string(), netReturn: z.string().optional() })).max(10),
  quotes: z.array(z.object({ market: z.string(), baseRate: z.string().optional() })).max(10),
});
export type PreviousAnalysis = z.infer<typeof PreviousAnalysis>;

/** 계획의 출구 거래(인출·PSM 역전환) 비용을 평가 자산으로. 계획 계산과 같은 단가·환산을 쓴다 */
function exitCostOf(p: Plan, basis: MainnetInputs["costBasis"]): Decimal {
  const exitSteps = p.steps.filter((s) => ["withdraw", "psm_buy"].includes(s.action));
  return new Decimal(stepCosts(exitSteps, basis, "USDT").inAsset ?? 0);
}

function verifiedReward(p: Plan): Decimal {
  return p.rewards.status === "verified" && p.rewards.amount ? new Decimal(p.rewards.amount) : new Decimal(0);
}

const r2 = (v?: string) => (v === undefined ? "산정 불가" : new Decimal(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed());
const pct4 = (v?: string) => (v === undefined ? "-" : `${new Decimal(v).mul(100).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed()}%`);

export async function reevaluate(
  needs: UserNeeds,
  previous: PreviousAnalysis,
  inputs: MainnetInputs,
  failures: string[],
  provider?: LlmProvider,
  now = new Date(),
): Promise<ReevaluateResponse> {
  const fresh = buildMainnetPlans(needs, inputs, now);
  const rec = fresh.plans.find((p) => p.id === fresh.recommendation.planId)!;
  const changes: ReevaluateResponse["changes"] = [];
  for (const p of fresh.plans.filter((x) => x.key !== "HOLD")) {
    const before = previous.plans.find((x) => x.key === p.key)?.netReturn;
    if (r2(before) !== r2(p.netReturn)) changes.push({ label: `계획 ${p.key} 예상 순수익 (${needs.asset})`, before: r2(before), after: r2(p.netReturn) });
  }
  for (const q of fresh.quotes.filter((x) => x.kind === "lending")) {
    const before = previous.quotes.find((x) => x.market === q.market)?.baseRate;
    if (pct4(before) !== pct4(q.baseRate)) changes.push({ label: `${q.market} 공급 금리`, before: pct4(before), after: pct4(q.baseRate) });
  }
  const anomalies = checkAnomalies({ inputs, failures, now, base: fresh, previousRates: previous.quotes }).filter((a) => a.severity !== "info");
  const changed = previous.recommendedKey !== rec.key;

  const template = [
    changed ? `추천이 계획 ${previous.recommendedKey}에서 ${rec.title}(으)로 바뀌었습니다. ${fresh.recommendation.reason}` : `추천은 ${rec.title}(으)로 그대로입니다.`,
    changes.length ? `바뀐 값: ${changes.slice(0, 3).map((c) => `${c.label} ${c.before} → ${c.after}`).join(", ")}.` : "금리와 예상 순수익에 의미 있는 변화가 없습니다.",
    anomalies.length ? `점검 필요 ${anomalies.length}건: ${anomalies[0].market} — ${anomalies[0].message}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  let message = template;
  let messageSource: "llm" | "template" = "template";
  if (provider) {
    const data = { recommendationChanged: changed, previous: previous.recommendedKey, current: rec.title, reason: fresh.recommendation.reason, changes, anomalies };
    try {
      const r = await provider.complete(
        [
          {
            role: "system",
            content:
              "너는 자산 계획 재평가 알림을 쓰는 담당이다. 주어진 JSON만 근거로 한국어 2~3문장 평문을 쓴다. 숫자는 JSON 값을 글자 그대로 쓰고 단위를 붙인다. JSON 키 이름을 쓰지 않고, 수익을 보장하지 않는다.",
          },
          { role: "user", content: JSON.stringify(data) },
        ],
        800,
      );
      const text = r.content.trim();
      if (!unknownNumbers(text, data).length && !explanationIssues(text).length) {
        message = text;
        messageSource = "llm";
      }
    } catch {
      /* 템플릿 유지 */
    }
  }
  // 리밸런스(전환) 분석: 이전 추천 계획을 이미 실행했다고 가정한다 (Mainnet은 분석 전용이라 실제 거래는 없음).
  // 유지 가치 = 이전 계획의 남은 기본 수익 − 이전 계획 인출 비용, 전환 가치 = 새 계획 순수익(진입·출구 포함) − 이전 계획 인출 비용.
  let rebalance: ReevaluateResponse["rebalance"];
  if (changed) {
    const prevPlan = fresh.plans.find((p) => p.key === previous.recommendedKey);
    const exit = prevPlan && prevPlan.key !== "HOLD" ? exitCostOf(prevPlan, inputs.costBasis) : new Decimal(0);
    const stay = prevPlan && prevPlan.key !== "HOLD" ? new Decimal(prevPlan.baseYield).plus(verifiedReward(prevPlan)).minus(exit) : new Decimal(0);
    const switchV = rec.key === "HOLD" ? exit.neg() : new Decimal(rec.netReturn ?? 0).minus(exit);
    const steps: string[] = [];
    if (prevPlan && prevPlan.key !== "HOLD") steps.push(...prevPlan.steps.filter((s) => ["withdraw", "psm_buy"].includes(s.action)).map((s) => `기존: ${s.label}`));
    if (rec.key !== "HOLD") steps.push(...rec.steps.filter((s) => ["approve", "psm_sell", "supply"].includes(s.action)).map((s) => `신규: ${s.label}`));
    rebalance = {
      from: previous.recommendedKey,
      to: rec.key,
      stayValue: r2(stay.toFixed()),
      switchValue: r2(switchV.toFixed()),
      recommendSwitch: switchV.gt(stay),
      exitCost: r2(exit.toFixed()),
      steps,
      note: `이전 계획(${previous.recommendedKey})을 이미 실행했다고 가정한 분석입니다. 조회 시점 금리가 남은 기간 유지된다고 봅니다. Mainnet 거래는 실행하지 않습니다.`,
    };
  }

  return {
    rebalance,
    checkedAt: now.toISOString(),
    recommendationChanged: changed,
    previousKey: previous.recommendedKey,
    currentKey: rec.key,
    currentTitle: rec.title,
    changes,
    anomalies,
    message,
    messageSource,
    failures,
  };
}
