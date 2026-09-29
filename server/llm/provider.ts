import { Decimal } from "../../shared/units";
import type { ChatMessage, NeedsPatch, PlanningResult, UserNeeds } from "../../shared/schemas";

// 공급자 공통 계약. 앱은 이 두 기능만 쓴다. 거래 생성·서명 기능은 모델에 주지 않는다.

export interface ExtractResult {
  patch: NeedsPatch;
  latencyMs: number;
}

export interface LlmProvider {
  name: string;
  model?: string;
  extractNeeds(messages: ChatMessage[], current: UserNeeds, today: string): Promise<ExtractResult>;
  explainPlans(result: Omit<PlanningResult, "explanation">): Promise<{ text: string; latencyMs: number }>;
  /** 에이전트 루프용 범용 호출. 도구 실행 권한은 없고 텍스트만 돌려준다 */
  complete(messages: { role: "system" | "user" | "assistant"; content: string }[], maxTokens: number): Promise<{ content: string; latencyMs: number }>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    public kind: "auth" | "timeout" | "format" | "rate_limit" | "server" | "network" | "config",
  ) {
    super(message);
  }
}

export const EXTRACT_SYSTEM_PROMPT = (today: string, current: UserNeeds) => `너는 TRON 자산 계획 앱의 입력 추출기다. 사용자의 한국어 문장에서 **명시된 정보만** JSON으로 추출한다.
오늘 날짜(Asia/Seoul): ${today}. 운용 시작일은 오늘이다.
현재까지 확인된 입력: ${JSON.stringify({
  asset: current.asset,
  amount: current.amount,
  holdings: current.holdings,
  endDate: current.endDate,
  expenses: current.expenses.map((e) => ({ date: e.date, amount: e.amount, asset: e.asset })),
  bufferAmount: current.bufferAmount,
  riskProfile: current.riskProfile,
  acceptUsddRisk: current.acceptUsddRisk,
})}

규칙:
- 금액·날짜·금리를 추측하거나 계산하지 않는다. 사용자가 말하지 않은 필드는 null.
- 금액은 쉼표 없는 숫자 문자열 ("1,000 USDT" → "1000").
- 보유 자산 종류를 말하면 asset에 "USDT" 또는 "TRX"를 넣는다 ("10,000 TRX를 운용" → "TRX", "테더" → "USDT"). 말하지 않으면 null.
- 보유 자산을 두 가지 이상 말하면 holdings에 전체 목록을 넣고 asset·amount는 첫 번째 자산으로 둔다 ("USDT 5,000과 TRX 20,000" → holdings [{"asset":"USDT","amount":"5000"},{"asset":"TRX","amount":"20000"}]). 한 가지만 말하면 holdings는 null.
- 운용 기간이 "30일", "한 달"처럼 상대값이면 durationDays(정수, 한 달=30). 날짜로 말하면 endDate(YYYY-MM-DD).
- 지출은 "7일 뒤"면 inDays=7, 날짜면 date. 사용자가 지출을 새로 말하거나 바꾸면 **변경 후 전체 지출 목록**을 expenses에 넣는다 (기존 지출 중 유지되는 것도 포함).
- "지출 없음"이면 noExpenses=true.
- 여유액/비상금을 말하면 bufferAmount. "없음"/"0"이면 "0".
- 위험 성향: 보수적/안정 → "conservative", 균형/중립 → "balanced", 공격적 → "aggressive".
- USDD 위험 질문에 "예/감수/괜찮다"면 acceptUsddRisk=true, "아니오/싫다"면 false.
- 다른 설명 없이 아래 형식의 JSON 객체 하나만 출력한다.

{"asset":"USDT"|"TRX"|null,"amount":string|null,"holdings":[{"asset":"USDT"|"TRX","amount":string}]|null,"durationDays":number|null,"endDate":string|null,"expenses":[{"inDays":number|null,"date":string|null,"amount":string,"asset":string|null,"label":string|null}]|null,"noExpenses":boolean|null,"bufferAmount":string|null,"riskProfile":"conservative"|"balanced"|"aggressive"|null,"acceptUsddRisk":boolean|null}`;

export const EXPLAIN_SYSTEM_PROMPT = `너는 TRON 자산 계획 앱의 설명 담당이다. 코드가 계산해 검증한 결과(JSON)만 근거로 한국어로 설명한다.
규칙:
- JSON에 없는 숫자·금리·비용·계약 주소를 만들지 않는다. 숫자는 JSON에 적힌 값을 **글자 그대로** 인용한다 (새로 계산하거나 단위를 바꾸지 않는다). 숫자가 검증에서 어긋나면 설명이 폐기된다.
- 추천 계획과 그 이유, 지출 재원을 먼저 확보한 이유, 왕복 거래비용이 결과를 바꾸는지를 설명한다. 계획 L(인출일별 분산)이 있으면 돈이 필요한 날짜에 따라 어느 몫을 어디에 넣었는지 한 문장으로 설명한다. 판정이 "제외"인 계획만 "제외"라고 말하고, 그 사유를 설명한다.
- 금액에는 JSON에 적힌 단위(USDT·USDD·TRX)를 그대로 붙인다. TRX 금액을 USDT로 부르지 않는다. 왕복 거래비용의 TRX 값과 환산값은 같은 비용이므로 더하지 않는다.
- JSON 키 이름(예: investable, costsTrx, eligible)이나 영어 단어(horizon, meanwhile 등)를 문장에 쓰지 않는다. 한국어로만 쓴다 (다른 언어 문자를 섞지 않는다). 운용 기간은 "운용 기간", 운용 가능액은 "운용 가능액"이라고 쓴다.
- 수익을 보장하는 표현을 쓰지 않는다. "조건부 분석"임을 밝힌다.
- 4~6문장, 마크다운 없이 평문.`;

const r2 = (v?: string) => (v === undefined ? undefined : new Decimal(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed());

/**
 * 설명 문장 속 숫자가 모두 계산 결과에 있는 값인지 검사한다.
 * 모델이 만든 수치가 섞이면 설명을 쓰지 않고 템플릿으로 대체한다.
 */
export function unknownNumbers(text: string, data: unknown): string[] {
  const allowed = new Set<string>();
  const add = (n: Decimal) => {
    // 원래 값 그대로 인용한 경우 (예: 96083.313932 TRX처럼 소수 4자리를 넘는 값)
    allowed.add(n.toFixed());
    allowed.add(n.abs().toFixed());
    for (let dp = 0; dp <= 4; dp++) {
      allowed.add(n.toDecimalPlaces(dp, Decimal.ROUND_HALF_UP).toFixed());
      allowed.add(n.toDecimalPlaces(dp, Decimal.ROUND_DOWN).toFixed());
    }
    allowed.add(n.abs().toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed());
    if (n.abs().lt(1)) for (let dp = 0; dp <= 4; dp++) allowed.add(n.mul(100).toDecimalPlaces(dp, Decimal.ROUND_HALF_UP).toFixed()); // 금리 %
  };
  const walk = (v: unknown) => {
    if (typeof v === "number") add(new Decimal(v));
    else if (typeof v === "string") for (const m of v.match(/-?\d+(?:\.\d+)?/g) ?? []) add(new Decimal(m));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(data);
  const bad: string[] = [];
  for (const raw of text.match(/-?\d[\d,]*(?:\.\d+)?/g) ?? []) {
    const n = raw.replace(/,/g, "");
    if (!/^-?\d+(\.\d+)?$/.test(n)) continue;
    const d = new Decimal(n);
    if (d.abs().lte(3) && d.isInteger()) continue; // "계획 A/B", 순서 등 작은 정수
    if (!allowed.has(d.toFixed()) && !allowed.has(d.abs().toFixed())) bad.push(raw);
  }
  return bad;
}

/** 설명 문장의 형식 문제: 한국어 외 문자, 영문 추론 누출, 코드 식별자가 섞이면 폐기 사유를 돌려준다 */
export function explanationIssues(text: string): string[] {
  const out: string[] = [];
  if (/[぀-ヿ一-鿿]/.test(text)) out.push("한국어 외 문자");
  // 고유명사·단위는 영문이어도 정상이므로 빼고 센다
  const stripped = text.replace(/\b(?:j?USD[TD]|j?TRX|JustLend|PSM|APY|APR|Nile|Mainnet|TRON|TronLink|Energy|Bandwidth|mint|redeem|txID|HOLD)\b/g, " ");
  // 추론 과정(영문)이 답으로 새어 나온 경우
  const hangul = (text.match(/[가-힣]/g) ?? []).length;
  const latin = (stripped.match(/[A-Za-z]/g) ?? []).length;
  if (latin > hangul) out.push("영문 위주 응답");
  // 한국어 문장에 섞인 영어 일반 단어 (예: meanwhile, horizon). 고유명사·단위는 위에서 뺐다
  const words = stripped.match(/\b[a-z]{4,}\b/g);
  if (words && latin <= hangul) out.push(`영어 단어(${[...new Set(words)].slice(0, 3).join(", ")})`);
  const ids = stripped.match(/\b[a-z]+[A-Z][A-Za-z]*\b|\b(?:eligible|ineligible|investable|reserved|principal)\b/g);
  if (ids) out.push(`필드 이름(${[...new Set(ids)].slice(0, 3).join(", ")})`);
  return out;
}

/** 설명용으로 계산 결과를 압축한다 (원본 quote 전체를 보내지 않음). 숫자는 인용하기 쉽게 반올림한다. */
export function compactForExplain(r: Omit<PlanningResult, "explanation">) {
  // 키를 한국어로 둔다. 영문 키를 주면 모델이 설명에 그대로 베껴 쓴다(reserved, horizon 등).
  const ELIG = { eligible: "실행 가능", conditional: "조건부", ineligible: "제외" } as const;
  const REWARD = { verified: "검증됨", unverified: "미확인 (순수익에서 제외)", none: "없음" } as const;
  const a = r.needs.asset;
  return {
    자산: a,
    보유액: `${r.needs.amount} ${a}`,
    운용일수: r.plans[0]?.horizonDays,
    먼저_확보한_금액: { 합계: `${r.reserved.total} ${a}`, 기간_안_지출: `${r.reserved.expensesInHorizon} ${a}`, 여유액: `${r.reserved.buffer} ${a}` },
    운용_가능액: `${r.investable} ${a}`,
    추천: { 계획: r.plans.find((p) => p.id === r.recommendation.planId)?.title, 이유: r.recommendation.reason },
    최고금리만_보고_골랐을_때: r.naiveComparison ? { 설명: r.naiveComparison.title, 순수익: `${r2(r.naiveComparison.netReturn) ?? "산정 불가"} ${a}` } : undefined,
    계획목록: r.plans.map((p) => ({
      제목: p.title,
      판정: ELIG[p.eligibility],
      사유: p.reasons,
      예치액: `${p.allocation.invested} ${a}`,
      기본금리_퍼센트: p.baseRate ? new Decimal(p.baseRate).mul(100).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed() : undefined,
      기본수익: `${r2(p.baseYield)} ${a}`,
      인센티브_보상: p.rewards.amount ? `${REWARD[p.rewards.status]}, 추정 ${r2(p.rewards.amount)}` : REWARD[p.rewards.status],
      // TRX 수수료와 그 환산액은 같은 비용이다. 모델이 두 값을 더하거나 단위를 바꾸지 않도록 단위를 붙인 문장으로 준다.
      왕복_거래비용:
        p.costs.inAsset === undefined
          ? "산정 불가"
          : a === "TRX"
            ? `${r2(p.costs.trx)} TRX`
            : `${r2(p.costs.inAsset)} ${a} (네트워크 수수료 ${r2(p.costs.trx)} TRX를 ${a}로 환산한 같은 비용이며 따로 더하지 않음)`,
      전환_비용: new Decimal(p.costs.conversionFees).isZero() ? undefined : `${r2(p.costs.conversionFees)} ${a} (왕복 거래비용과 별도)`,
      예상_순수익: p.netReturn !== undefined ? `${r2(p.netReturn)} ${a}` : "산정 불가",
      손익분기_일수: p.breakEvenDays ? new Decimal(p.breakEvenDays).ceil().toFixed() : "산정 불가",
      구간별_배분: p.ladder?.map((b) => ({ 구간: b.label, 금액: `${b.amount} ${a}`, 필요한_날: b.needDate, 넣을_곳: b.productLabel, 예상_수익: `${r2(b.yield)} ${a}` })),
      추천됨: p.recommended,
    })),
    경고: r.warnings,
  };
}
