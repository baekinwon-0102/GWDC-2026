import { Decimal } from "./units";
import { riskAllows, RISK_KO } from "./risk";
import type { Plan, ProductQuote, ScreeningRow, UserNeeds } from "./schemas";
import type { UsddSavings } from "./planning";

// 기회 탐색: JustLend 전체 시장 + USDD PSM 경로 + TRX 스테이킹을 같은 기준으로 심사한다.
// 분석 대상(계획으로 계산)과 제외(사유)를 나눠 보이며, 판정은 모두 코드 규칙이다.

export interface MarketInfo {
  symbol: string;
  jToken: string;
  baseApy: string;
  underlyingApy: string;
  miningApy: string;
  paused: boolean;
  depositedUsd: string;
  history?: { date: string; baseApy: string; farmApy: string; underlyingApy: string }[];
  fetchedAt: string;
}

/** USDT와 가격이 같도록 설계된 자산 (전환은 필요) */
const STABLES = new Set(["USDT", "USDD", "USD1", "TUSD", "wstUSDT", "USDC", "USDJ"]);
/** 가격이 변하는 것으로 확인한 자산. 목록에 없는 자산은 '분류 미확인'으로 표시하되 위험 판정은 가격 변동과 같게 둔다 */
const VOLATILE = new Set(["TRX", "sTRX", "SUN", "BTT", "NFT", "JST", "WIN", "HTX", "WBTC", "BTC", "ETH", "ETHB", "WBTT"]);
const WRAPPED_NOTE: Record<string, string> = {
  wstUSDT: "스테이킹된 USDT(wstUSDT)라 기초자산 자체 수익이 붙습니다",
  sTRX: "스테이킹된 TRX(sTRX)라 기초자산 자체 수익이 붙습니다",
};

export function buildScreening(needs: UserNeeds, investable: Decimal, markets: MarketInfo[], extra: { jusdd?: ProductQuote; staking?: ProductQuote; plans: Plan[]; usddSavings?: UsddSavings }): ScreeningRow[] {
  const asset = needs.asset;
  const planOf = (k: string) => extra.plans.find((p) => p.key === k);
  const label = (k: string) => (planOf(k)?.eligibility === "ineligible" ? `${k} (제외)` : k);
  const rows: ScreeningRow[] = [];

  for (const m of markets) {
    const total = new Decimal(m.baseApy).plus(m.underlyingApy).plus(m.miningApy);
    const reasons: string[] = [];
    let category: ScreeningRow["category"];
    let analyzedAs: string | undefined;
    const isOld = /OLD$/.test(m.symbol);
    if (m.paused || isOld) {
      category = "paused";
      reasons.push(isOld ? "이전 버전 시장이라 신규 예치를 받지 않습니다." : "예치(mint)가 중지된 시장입니다.");
    } else if (m.symbol === asset) {
      category = "same_asset";
      analyzedAs = ["A", "A2"].filter((k) => planOf(k)).map(label).join(", ");
      const b = planOf("A");
      if (b?.eligibility === "ineligible") reasons.push(...b.reasons.slice(0, 1));
    } else if (m.symbol === "USDD") {
      category = "psm_route";
      analyzedAs = planOf("B") ? label("B") : undefined;
      const b = planOf("B");
      if (b?.eligibility === "ineligible") reasons.push(...b.reasons.slice(0, 2));
    } else if (STABLES.has(m.symbol)) {
      category = "stable_conversion";
      reasons.push(`${asset}→${m.symbol} 전환 경로(스왑·랩핑)의 비용·슬리피지를 검증하지 못해 계산하지 않습니다.`);
      if (!riskAllows(needs.riskProfile, "stable_conversion")) reasons.push(`${RISK_KO[needs.riskProfile!]} 성향에서는 스테이블 전환 경로를 제외합니다.`);
    } else {
      category = "volatile";
      reasons.push(
        VOLATILE.has(m.symbol)
          ? `${m.symbol}는 가격이 변하는 자산이라 ${asset} 기준 원금이 보장되지 않고, 전환 비용도 검증하지 못했습니다.`
          : `${m.symbol}의 자산 분류(스테이블 여부)를 확인하지 못해 가격 위험을 평가할 수 없고, 전환 비용도 검증하지 못했습니다. 가격 변동 자산과 같이 취급합니다.`,
      );
      if (!riskAllows(needs.riskProfile, "volatile")) reasons.push(`${RISK_KO[needs.riskProfile!]} 성향에서는 가격 변동 자산을 제외합니다.`);
    }
    if (WRAPPED_NOTE[m.symbol] && category !== "paused") reasons.push(WRAPPED_NOTE[m.symbol]);
    if (analyzedAs && new Decimal(m.depositedUsd).lt(investable)) reasons.push("시장 예치 총액이 예치 예정액보다 작습니다.");
    const miningStatus: ScreeningRow["miningStatus"] = new Decimal(m.miningApy).lte(0) ? "none" : m.symbol === "USDD" && extra.jusdd?.rewards.status === "verified" ? "verified" : "unverified";
    rows.push({
      product: `j${m.symbol}`,
      project: "JustLend",
      underlying: m.symbol,
      category,
      baseApy: m.baseApy,
      underlyingApy: m.underlyingApy,
      miningApy: m.miningApy,
      miningStatus,
      totalApy: total.toFixed(),
      depositedUsd: m.depositedUsd,
      analyzedAs: analyzedAs || undefined,
      verdict: analyzedAs ? "analyzed" : "excluded",
      reasons,
    });
  }

  // USDD PSM은 수익원이 아니라 전환 경로다 (계획 B의 일부)
  rows.push({
    product: "USDD PSM (USDT↔USDD)",
    project: "USDD",
    underlying: "USDT",
    category: "psm_route",
    analyzedAs: planOf("B") ? "B (전환 경로)" : undefined,
    verdict: planOf("B") ? "analyzed" : "excluded",
    reasons: ["수익원이 아니라 USDT를 USDD로 1:1(수수료 제외) 바꾸는 경로입니다. 계획 B에서 진입·출구로 씁니다."],
  });

  // USDD 자체 저축 상품(sUSDD). TRON에 배포·등록되지 않았으면 다른 체인 금리를 참고로만 보인다
  const sv = extra.usddSavings;
  if (sv) {
    const deployed = sv.tron.registered && new Decimal(sv.tron.earnTvl).gt(0);
    const ref = sv.otherChains.filter((c) => new Decimal(c.earnTvl).gt(0));
    rows.push({
      product: "sUSDD (USDD 저축)",
      project: "USDD",
      underlying: "USDD",
      category: "not_on_tron",
      baseApy: deployed ? sv.tron.apy : ref[0]?.apy,
      totalApy: deployed ? sv.tron.apy : ref[0]?.apy,
      depositedUsd: deployed ? sv.tron.earnTvl : undefined,
      verdict: "excluded",
      reasons: deployed
        ? ["TRON 배포가 감지됐지만 계약 주소·입출금 조건을 아직 검증하지 않아 계산하지 않습니다."]
        : [
            `USDD의 자체 저축 상품이지만 TRON에는 배포되지 않았습니다 (TRON 저축 예치 규모 ${new Decimal(sv.tron.earnTvl).toFixed(0)}달러, TRON 체인 등록부에 SUSDD·MCD_POT 없음).`,
            ...(ref.length ? [`${ref.map((c) => `${c.chain} 연 ${c.apy ? (Number(c.apy) * 100).toFixed(2) : "-"}% · 예치 ${(Number(c.earnTvl) / 1e6).toFixed(1)}백만 달러`).join(", ")}에서만 운영 중이라 참고로만 보입니다 (브리지가 필요해 이 앱의 범위 밖).`] : []),
            "TRON에서 USDD로 수익을 내는 경로는 JustLend jUSDD 예치(계획 B)입니다.",
          ],
    });
  }

  if (extra.staking) {
    const c = planOf("C");
    rows.push({
      product: "TRX 스테이킹 + SR 투표",
      project: "TRON",
      underlying: "TRX",
      category: "staking",
      baseApy: extra.staking.baseRate,
      totalApy: extra.staking.baseRate,
      analyzedAs: c ? label("C") : undefined,
      verdict: c ? "analyzed" : "excluded",
      reasons: c?.reasons.slice(0, 2) ?? [],
    });
  }

  const order = { analyzed: 0, excluded: 1 };
  return rows.sort((a, b) => order[a.verdict] - order[b.verdict] || new Decimal(b.totalApy ?? 0).cmp(a.totalApy ?? 0));
}
