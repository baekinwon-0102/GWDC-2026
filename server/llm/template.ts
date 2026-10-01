import { fmt } from "../../shared/units";
import type { MissingField, NeedsPatch, PlanningResult, UserNeeds } from "../../shared/schemas";

// API 키가 없거나 LLM이 실패할 때 쓰는 규칙 기반 추출·설명. 흐름이 끊기지 않게 하는 것이 목적이다.

const NUM = "([\\d,]+(?:\\.\\d+)?)";
const clean = (s: string) => s.replace(/,/g, "");

export function templateExtract(text: string, lastAsked?: MissingField, today?: string, current?: UserNeeds): NeedsPatch {
  const patch: NeedsPatch = {};
  let rest = text;

  // 지출: "7일 뒤 200 USDT", "10월 5일에 150 USDT"
  const expenses: NonNullable<NeedsPatch["expenses"]> = [];
  rest = rest.replace(new RegExp(`(\\d+)\\s*일\\s*(?:뒤|후)(?:에)?[^\\d]{0,6}${NUM}\\s*(USDT|TRX|USDD)?`, "gi"), (_, days, amt, asset) => {
    expenses.push({ inDays: Number(days), amount: clean(amt), asset: asset?.toUpperCase() ?? null });
    return " ";
  });
  if (today) {
    const year = Number(today.slice(0, 4));
    rest = rest.replace(new RegExp(`(\\d{1,2})\\s*월\\s*(\\d{1,2})\\s*일(?:에)?[^\\d]{0,6}${NUM}\\s*(USDT|TRX|USDD)?`, "gi"), (_, m, dd, amt, asset) => {
      let date = `${year}-${String(m).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
      if (date < today) date = `${year + 1}${date.slice(4)}`;
      expenses.push({ date, amount: clean(amt), asset: asset?.toUpperCase() ?? null });
      return " ";
    });
  }
  // "지출일을 45일 뒤로 바꿔 주세요"처럼 금액 없이 날짜만 옮기면, 기존 지출이 하나일 때 그 지출을 옮긴다.
  const move = rest.match(/(\d+)\s*일\s*(?:뒤|후)/);
  if (!expenses.length && move && /지출/.test(text) && current?.expenses.length === 1) {
    const e = current.expenses[0];
    expenses.push({ inDays: Number(move[1]), amount: e.amount, asset: e.asset, label: e.label ?? null });
    rest = rest.replace(move[0], " ");
  }
  if (expenses.length) patch.expenses = expenses;
  if (/지출\s*(?:은|이)?\s*(?:없|안\s*해|no)/i.test(text)) patch.noExpenses = true;

  // 여유액
  const buf = rest.match(new RegExp(`(?:여유|비상)[^\\d]{0,10}${NUM}`));
  if (buf) {
    patch.bufferAmount = clean(buf[1]);
    rest = rest.replace(buf[0], " ");
  } else if (/(?:여유|비상)[^.]{0,10}(?:없|0)/.test(text)) patch.bufferAmount = "0";

  // 기간: "30일 동안", "한 달", "2개월"
  const months = rest.match(/(\d+)\s*(?:개월|달)/);
  const days = rest.match(/(\d+)\s*일(?!\s*(?:뒤|후))/);
  if (/한\s*달/.test(rest)) patch.durationDays = 30;
  else if (months) patch.durationDays = Number(months[1]) * 30;
  else if (days) {
    patch.durationDays = Number(days[1]);
    rest = rest.replace(days[0], " ");
  }

  // 보유 금액: "1,000 USDT", "USDT 5,000", 여러 자산이면 전체 목록
  const found: { asset: "USDT" | "TRX" | "USDD"; amount: string }[] = [];
  rest.replace(new RegExp(`${NUM}\\s*(USDT|TRX|USDD|테더)|(USDT|TRX|USDD|테더)\\s*${NUM}`, "gi"), (_, a1, s1, s2, a2) => {
    const sym = s1 ?? s2;
    const asset = /TRX/i.test(sym) ? "TRX" : /USDD/i.test(sym) ? "USDD" : "USDT";
    found.push({ asset, amount: clean(a1 ?? a2) });
    return " ";
  });
  const assets = new Set(found.map((f) => f.asset));
  if (assets.size > 1) {
    patch.holdings = found;
    patch.asset = found[0].asset;
    patch.amount = found[0].amount;
  } else if (found.length) {
    patch.amount = found[0].amount;
    patch.asset = found[0].asset;
  }

  // 위험 성향
  if (/보수|안정적|안전/.test(text)) patch.riskProfile = "conservative";
  else if (/균형|중립|중간/.test(text)) patch.riskProfile = "balanced";
  else if (/공격/.test(text)) patch.riskProfile = "aggressive";

  // 직전 질문에 대한 짧은 답
  const t = text.trim();
  if (lastAsked === "acceptUsddRisk") {
    if (/^(예|네|응|좋|감수|괜찮|수용|yes|ok)/i.test(t)) patch.acceptUsddRisk = true;
    else if (/(아니|싫|거부|안\s*할|no)/i.test(t)) patch.acceptUsddRisk = false;
  } else if (/USDD/.test(t) && /(감수|수용|괜찮)/.test(t)) patch.acceptUsddRisk = !/(않|안|못|싫)/.test(t);
  const bare = t.match(/^([\d,]+(?:\.\d+)?)\s*(USDT|TRX)?$/i);
  if (bare && lastAsked === "bufferAmount") patch.bufferAmount = clean(bare[1]);
  if (bare && lastAsked === "amount") patch.amount = clean(bare[1]);
  if (/^(없|없음|없어|0)/.test(t) && lastAsked === "bufferAmount") patch.bufferAmount = "0";
  if (/^(없|없음|없어)/.test(t) && lastAsked === "expenses") patch.noExpenses = true;
  return patch;
}

export function templateExplain(r: Omit<PlanningResult, "explanation">): string {
  const rec = r.plans.find((p) => p.id === r.recommendation.planId)!;
  const asset = r.needs.asset;
  const lines: string[] = [];
  lines.push(
    `운용 기간 안의 지출 ${fmt(r.reserved.expensesInHorizon)} ${asset}와 여유액 ${fmt(r.reserved.buffer)} ${asset}를 먼저 확보하고, 남은 ${fmt(r.investable)} ${asset}로 계획을 비교했습니다.`,
  );
  for (const p of r.plans.filter((x) => x.key !== "HOLD")) {
    if (p.eligibility === "ineligible") lines.push(`${p.title}: 제외 — ${p.reasons[0] ?? "조건 미충족"}`);
    else
      lines.push(
        `${p.title}: 기본 수익 ${fmt(p.baseYield, 4)} ${asset}, 왕복 비용 ${p.costs.inAsset ? fmt(p.costs.inAsset, 4) : "산정 불가"} ${asset}, 예상 순수익 ${p.netReturn !== undefined ? fmt(p.netReturn, 4) : "산정 불가"} ${asset}.`,
      );
  }
  lines.push(`추천: ${rec.title}. ${r.recommendation.reason}`);
  if (r.chain === "mainnet") lines.push("이 결과는 입력과 조회 시점 데이터에 근거한 조건부 분석이며 수익을 보장하지 않습니다.");
  return lines.join(" ");
}
