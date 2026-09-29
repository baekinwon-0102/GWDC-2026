import { Decimal } from "./units";
import type { Holding, MissingField, NeedsPatch, UserNeeds } from "./schemas";

// 요구사항 상태 병합, 누락·모순 판정, 다음 질문 결정. 모두 코드가 결정한다 (LLM 아님).

export function todaySeoul(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function addDays(date: string, days: number): string {
  const [y, m, dd] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, dd + days));
  return t.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  const a = Date.parse(from + "T00:00:00Z");
  const b = Date.parse(to + "T00:00:00Z");
  return Math.round((b - a) / 86_400_000);
}

export function emptyNeeds(chain: "mainnet" | "nile" = "mainnet", today = todaySeoul()): UserNeeds {
  return {
    chain,
    asset: chain === "mainnet" ? "USDT" : "TRX",
    startDate: today,
    expenses: [],
    expensesStated: false,
    timezone: "Asia/Seoul",
    version: 0,
  };
}

/** 고정 시연 사례: 1,000 USDT, 30일, 7일 뒤 200 USDT, 여유액 0, 균형형 */
export function demoNeeds(today = todaySeoul()): UserNeeds {
  return {
    chain: "mainnet",
    asset: "USDT",
    amount: "1000",
    startDate: today,
    endDate: addDays(today, 30),
    expenses: [{ id: "e1", date: addDays(today, 7), amount: "200", asset: "USDT", label: "예정 지출" }],
    expensesStated: true,
    bufferAmount: "0",
    riskProfile: "balanced",
    acceptUsddRisk: true,
    timezone: "Asia/Seoul",
    version: 1,
  };
}

export function applyPatch(needs: UserNeeds, patch: NeedsPatch): { needs: UserNeeds; changed: (keyof UserNeeds)[] } {
  const next: UserNeeds = { ...needs, expenses: [...needs.expenses] };
  const changed = new Set<keyof UserNeeds>();
  const set = <K extends keyof UserNeeds>(k: K, v: UserNeeds[K]) => {
    if (JSON.stringify(next[k]) !== JSON.stringify(v)) {
      next[k] = v;
      changed.add(k);
    }
  };

  // 보유 자산은 Mainnet에서만 바꾼다 (Nile은 항상 TRX)
  const multi = patch.holdings ? mergeHoldings(patch.holdings) : undefined;
  if (multi && multi.length > 1 && needs.chain === "mainnet") {
    set("holdings", multi);
    set("asset", multi[0].asset);
    set("amount", multi[0].amount);
  } else {
    // 한 자산만 말하면 여러 자산 목록을 해제하거나, 목록 안의 그 자산 금액만 바꾼다
    const single = multi?.[0] ?? (patch.amount ? { asset: patch.asset ?? next.asset, amount: normalize(patch.amount) } : undefined);
    if (single && needs.chain === "mainnet" && next.holdings && next.holdings.some((h) => h.asset === single.asset) && !patch.asset) {
      const hs = next.holdings.map((h) => (h.asset === single.asset ? { ...h, amount: single.amount } : h));
      set("holdings", hs);
      set("amount", hs[0].amount);
    } else if (single) {
      if (needs.chain === "mainnet") set("asset", single.asset);
      set("amount", single.amount);
      if (next.holdings) set("holdings", undefined);
    } else if (patch.asset && needs.chain === "mainnet") set("asset", patch.asset);
  }
  if (patch.endDate) set("endDate", patch.endDate);
  else if (patch.durationDays) set("endDate", addDays(needs.startDate, patch.durationDays));

  if (patch.noExpenses && !patch.expenses?.length) {
    set("expenses", []);
    set("expensesStated", true);
  } else if (patch.expenses && patch.expenses.length > 0) {
    const list = patch.expenses
      .map((e, i) => {
        const date = e.date ?? (e.inDays != null ? addDays(needs.startDate, e.inDays) : undefined);
        if (!date) return null;
        return { id: `e${i + 1}`, date, amount: normalize(e.amount), asset: (e.asset ?? next.asset).toUpperCase(), label: e.label ?? undefined };
      })
      .filter((e): e is NonNullable<typeof e> => e !== null)
      .sort((a, b) => a.date.localeCompare(b.date));
    if (list.length > 0) {
      set("expenses", list);
      set("expensesStated", true);
    }
  }
  if (patch.bufferAmount != null) set("bufferAmount", normalize(patch.bufferAmount));
  if (patch.riskProfile) set("riskProfile", patch.riskProfile);
  if (patch.acceptUsddRisk != null) set("acceptUsddRisk", patch.acceptUsddRisk);

  if (changed.size > 0) next.version = needs.version + 1;
  return { needs: next, changed: [...changed] };
}

function normalize(v: string): string {
  return new Decimal(v).toFixed();
}

/** 같은 자산은 합치고 0 이하는 뺀다 */
function mergeHoldings(hs: { asset: "USDT" | "TRX"; amount: string }[]): Holding[] {
  const m = new Map<"USDT" | "TRX", Decimal>();
  for (const h of hs) m.set(h.asset, (m.get(h.asset) ?? new Decimal(0)).plus(h.amount));
  return [...m.entries()].filter(([, a]) => a.gt(0)).map(([asset, a]) => ({ asset, amount: a.toFixed() }));
}

/** 보유 자산 목록 (한 자산이면 asset·amount 하나) */
export function holdingsOf(n: UserNeeds): Holding[] {
  if (n.holdings && n.holdings.length > 1) return n.holdings;
  return n.amount ? [{ asset: n.asset, amount: n.amount }] : [];
}

/**
 * 여러 자산 보유 시 자산 하나만 떼어 낸 요구사항. 그 자산의 지출만 남기고, 비상 여유액은 대표 자산에만 둔다.
 * 자산마다 이 요구사항으로 같은 계획 엔진(지출 재원 확보 → 인출일별 구간 → 계획 비교·추천)을 돌린다.
 */
export function needsForHolding(n: UserNeeds, h: Holding): UserNeeds {
  return {
    ...n,
    asset: h.asset,
    amount: h.amount,
    holdings: undefined,
    expenses: n.expenses.filter((e) => e.asset === h.asset),
    bufferAmount: h.asset === n.asset ? n.bufferAmount : "0",
    acceptUsddRisk: n.acceptUsddRisk,
  };
}

export function missingFields(n: UserNeeds): MissingField[] {
  const m: MissingField[] = [];
  if (!n.amount) m.push("amount");
  if (!n.endDate) m.push("endDate");
  if (!n.expensesStated) m.push("expenses");
  if (n.bufferAmount === undefined) m.push("bufferAmount");
  if (!n.riskProfile) m.push("riskProfile");
  // USDD 경로(계획 B)는 USDT 보유자와 (TRX→USDT 교환을 거치는) TRX 보유자 모두 해당된다
  if (n.acceptUsddRisk === undefined) m.push("acceptUsddRisk");
  return m;
}

/** 모순·지원 불가 입력. 하나라도 있으면 계획을 만들지 않는다. */
export function inputProblems(n: UserNeeds): string[] {
  const p: string[] = [];
  if (n.endDate && daysBetween(n.startDate, n.endDate) <= 0) p.push("운용 종료일이 시작일보다 뒤여야 합니다.");
  const held = holdingsOf(n);
  const heldAssets = held.map((h) => h.asset as string);
  for (const e of n.expenses) {
    if (held.length && !heldAssets.includes(e.asset))
      p.push(`${e.date} 지출(${e.amount} ${e.asset})은 보유하지 않은 자산입니다. 보유 자산(${heldAssets.join("·")}) 중 하나로 입력해 주세요.`);
    if (daysBetween(n.startDate, e.date) < 0) p.push(`${e.date} 지출이 오늘보다 이전입니다.`);
  }
  if (n.endDate) {
    // 자산마다 그 자산으로 낼 지출(+대표 자산의 여유액)이 보유액 안에 있어야 한다
    for (const h of held) {
      const reserve = reservedWithinHorizon(needsForHolding(n, h)).total;
      if (reserve.gt(h.amount)) p.push(`확보해야 할 금액(${reserve.toFixed()} ${h.asset})이 보유액(${h.amount} ${h.asset})보다 큽니다. 금액이나 지출을 수정해 주세요.`);
    }
  }
  return p;
}

/** 운용 기간 안의 지출 합계 + 여유액(한 번만). 기간 밖 지출은 제외한다. */
export function reservedWithinHorizon(n: UserNeeds) {
  const end = n.endDate ?? n.startDate;
  const inside = n.expenses.filter((e) => e.asset === n.asset && daysBetween(n.startDate, e.date) >= 0 && daysBetween(e.date, end) >= 0);
  const outside = n.expenses.filter((e) => !inside.includes(e));
  const expenses = inside.reduce((s, e) => s.plus(e.amount), new Decimal(0));
  const buffer = new Decimal(n.bufferAmount ?? 0);
  return { total: expenses.plus(buffer), expenses, buffer, inside, outside };
}

const QUESTIONS: Record<MissingField, string> = {
  amount: "운용할 자산과 금액을 알려 주세요. 예: \"1,000 USDT\", \"10,000 TRX\", 여러 자산이면 \"USDT 5,000과 TRX 20,000\"",
  endDate: "얼마 동안 운용할 계획인가요? 예: \"30일\" 또는 종료 날짜",
  expenses: "운용 기간 중 예정된 지출이 있나요? 날짜와 금액을 알려 주세요. 예: \"7일 뒤 200 USDT\" (없으면 \"지출 없음\")",
  bufferAmount: "지출 외에 따로 남겨 둘 비상 여유액이 있나요? 없으면 \"0\"이라고 답해 주세요.",
  riskProfile: "위험 성향을 알려 주세요: 보수적 / 균형형 / 공격적",
  acceptUsddRisk:
    "USDD 경로(계획 B)는 USDT(TRX는 먼저 USDT로 교환)를 USDD로 바꿔 예치합니다. USDD 가격이 1달러에서 벗어나거나(디페깅) PSM 출구 물량이 부족할 위험이 있습니다. 이 위험을 감수하고 B도 비교할까요? (예/아니오)",
};

export function nextQuestion(missing: MissingField[]): string | undefined {
  return missing.length ? QUESTIONS[missing[0]] : undefined;
}

const RISK_KO = { conservative: "보수적", balanced: "균형형", aggressive: "공격적" } as const;
export const riskLabel = (r?: UserNeeds["riskProfile"]) => (r ? RISK_KO[r] : "-");

export function summarizeNeeds(n: UserNeeds): string[] {
  const lines: string[] = [];
  const held = holdingsOf(n);
  if (held.length) lines.push(`보유 자산: ${held.map((h) => `${h.amount} ${h.asset}`).join(" + ")} (${n.chain === "mainnet" ? "TRON Mainnet" : "Nile 테스트넷"})`);
  if (n.endDate) lines.push(`운용 기간: ${n.startDate} ~ ${n.endDate} (${daysBetween(n.startDate, n.endDate)}일)`);
  if (n.expensesStated)
    lines.push(n.expenses.length ? `예정 지출: ${n.expenses.map((e) => `${e.date} ${e.amount} ${e.asset}`).join(", ")}` : "예정 지출: 없음");
  if (n.bufferAmount !== undefined) lines.push(`추가 여유액: ${n.bufferAmount} ${n.asset}${held.length > 1 ? " (대표 자산에서 확보)" : ""}`);
  if (n.riskProfile) lines.push(`위험 성향: ${riskLabel(n.riskProfile)}`);
  if (n.acceptUsddRisk !== undefined) lines.push(`USDD 가격 위험 수용: ${n.acceptUsddRisk ? "예" : "아니오"}`);
  return lines;
}
