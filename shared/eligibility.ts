import { Decimal } from "./units";
import type { ProductQuote } from "./schemas";

// 경로 실행 조건 판정. 사유 문자열을 그대로 화면에 보여준다.

export const QUOTE_MAX_AGE_MS = 10 * 60 * 1000;

export function isStale(q: ProductQuote, now: Date): boolean {
  return now.getTime() - Date.parse(q.source.fetchedAt) > QUOTE_MAX_AGE_MS;
}

/** 공통 데이터 조건: 실데이터 여부, 신선도, 체인 일치 */
export function dataIssues(q: ProductQuote | undefined, chain: ProductQuote["chain"], now: Date): { blocking: string[]; conditional: string[] } {
  const blocking: string[] = [];
  const conditional: string[] = [];
  if (!q) {
    blocking.push("상품 데이터를 조회하지 못했습니다 (unavailable).");
    return { blocking, conditional };
  }
  if (q.chain !== chain) blocking.push(`${q.market} 데이터의 체인(${q.chain})이 요청 체인(${chain})과 다릅니다.`);
  if (q.source.mode === "synthetic") conditional.push(`${q.market}: 가상(synthetic) 데이터로 계산했습니다. 실행 판정에 쓰지 않습니다.`);
  if (q.source.mode === "snapshot") conditional.push(`${q.market}: 과거 스냅샷 데이터입니다. 현재 값이 아닙니다.`);
  if (q.source.mode === "live" && isStale(q, now)) blocking.push(`${q.market}: 조회 후 10분이 지나 오래된 데이터입니다. 다시 조회해야 합니다.`);
  return { blocking, conditional };
}

export function lendingIssues(q: ProductQuote | undefined, _invested: Decimal): string[] {
  const r: string[] = [];
  if (!q) return r;
  if (!q.active) r.push(`${q.market} 시장이 비활성 상태입니다${q.inactiveReason ? `: ${q.inactiveReason}` : ""}.`);
  if (!q.baseRate) r.push(`${q.market} 기본 금리를 확인하지 못했습니다.`);
  return r;
}

/**
 * 인출 유동성 주의: 시장 현금이 예치 예정액보다 적으면, 예치 직후에는 내 예치금만큼 현금이 늘지만 차입자가 빌려 가면 만기 인출이 늦어질 수 있다.
 * 실행을 막을 사유는 아니므로 조건부(주의)로 보인다.
 */
export function lendingWarnings(q: ProductQuote | undefined, invested: Decimal): string[] {
  if (!q || q.liquidity === undefined || !new Decimal(q.liquidity).lt(invested)) return [];
  return [`${q.market} 시장 현금(${new Decimal(q.liquidity).toFixed(2)} ${q.token})이 예치 예정액보다 적습니다. 예치 직후에는 인출할 수 있지만, 차입이 늘면 만기 인출이 늦어질 수 있습니다.`];
}

export function psmIssues(q: ProductQuote | undefined, invested: Decimal): string[] {
  const r: string[] = [];
  if (!q?.psm) {
    r.push("USDD PSM 전환 조건(수수료·물량)을 확인하지 못했습니다.");
    return r;
  }
  const p = q.psm;
  if (!p.sellEnabled) r.push("PSM USDT→USDD 전환(sellGem)이 비활성입니다.");
  if (!p.buyEnabled) r.push("PSM USDD→USDT 출구(buyGem)가 비활성입니다.");
  if (p.entryCapacity === undefined) r.push("PSM 진입 가능 물량(부채 한도 여유)을 확인하지 못했습니다.");
  else if (new Decimal(p.entryCapacity).lt(invested)) r.push(`PSM 진입 가능 물량(${new Decimal(p.entryCapacity).toFixed(2)} USDD)이 부족합니다.`);
  if (p.exitLiquidity === undefined) r.push("PSM 출구 물량(보유 USDT)을 확인하지 못했습니다.");
  else if (new Decimal(p.exitLiquidity).lt(invested)) r.push(`PSM 출구 물량(${new Decimal(p.exitLiquidity).toFixed(2)} USDT)이 부족합니다.`);
  return r;
}
