import type { Plan, RiskProfile } from "./schemas";

// 위험 성향 정책. 계획의 후보 자격과 추천 기준을 바꾼다 (코드가 결정, LLM 아님).
//
// | 성향   | 허용 위험 등급                         | 추천 기준                                   |
// | 보수적 | 보유 자산 그대로 (가격 전환 없음)       | 순수익 > 0인 계획 중 예치 비중이 가장 작은 것 |
// | 균형형 | + 스테이블 전환(USDD 디페깅 위험)       | 순수익 최대                                  |
// | 공격적 | + 가격 변동 자산(TRX 등)                | 순수익 최대                                  |

export type RiskClass = NonNullable<Plan["riskClass"]>;

const ALLOWED: Record<RiskProfile, RiskClass[]> = {
  conservative: ["stable"],
  balanced: ["stable", "stable_conversion"],
  aggressive: ["stable", "stable_conversion", "volatile"],
};

const CLASS_KO: Record<RiskClass, string> = {
  stable: "보유 자산 그대로(가격 전환 없음)",
  stable_conversion: "스테이블 전환(디페깅 위험)",
  volatile: "가격 변동 자산",
};

export const RISK_KO: Record<RiskProfile, string> = { conservative: "보수적", balanced: "균형형", aggressive: "공격적" };

/** 성향이 허용하지 않는 위험 등급이면 제외 사유를 돌려준다 */
export function riskBlock(profile: RiskProfile | undefined, cls: RiskClass | undefined): string | undefined {
  if (!profile || !cls || ALLOWED[profile].includes(cls)) return undefined;
  return `${RISK_KO[profile]} 성향에서는 ${CLASS_KO[cls]} 경로를 후보에서 제외합니다.`;
}

export function riskAllows(profile: RiskProfile | undefined, cls: RiskClass): boolean {
  return !profile || ALLOWED[profile].includes(cls);
}

/** 보수적 성향은 수익이 나는 계획 중 노출이 가장 작은 것을 고른다 */
export function prefersLowExposure(profile: RiskProfile | undefined): boolean {
  return profile === "conservative";
}
