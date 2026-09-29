import { env, redact } from "../env";
import { NeedsPatch, type ChatMessage, type UserNeeds } from "../../shared/schemas";
import { compactForExplain, EXPLAIN_SYSTEM_PROMPT, EXTRACT_SYSTEM_PROMPT, LlmError, type LlmProvider } from "./provider";

// OpenAI 호환 chat/completions 공통 호출부 (NVIDIA NIM, Bank of AI). 비스트리밍.

interface OpenAiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OpenAiCompatibleOptions {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  /** GPT-5 계열 추론 모델은 max_tokens 대신 max_completion_tokens만 받는다 (추론 토큰 포함 상한) */
  tokenParam?: "max_tokens" | "max_completion_tokens";
  /** 추론 모델은 기본값 외 temperature를 거부하므로 생략할 수 있게 한다 */
  temperature?: number;
  /** 공급자별 선택 파라미터. HTTP 400이면 이것을 빼고 한 번 다시 보낸다 */
  extra?: Record<string, unknown>;
  /** 추론 토큰을 감안해 출력 상한에 곱할 배수 */
  tokenMultiplier?: number;
}

export function createOpenAiCompatible(opts: OpenAiCompatibleOptions): LlmProvider {
  async function complete(messages: OpenAiMessage[], maxTokens: number): Promise<{ content: string; latencyMs: number }> {
    if (!opts.apiKey || !opts.model) throw new LlmError(`${opts.name} 키 또는 모델이 설정되지 않았습니다`, "config");
    const makeBody = (withExtra: boolean) =>
      JSON.stringify({
        model: opts.model,
        messages,
        [opts.tokenParam ?? "max_tokens"]: Math.round(maxTokens * (opts.tokenMultiplier ?? 1)),
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(withExtra ? opts.extra : {}),
      });
    let withExtra = Boolean(opts.extra);
    let lastErr: LlmError | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      const body = makeBody(withExtra);
      const t0 = Date.now();
      let r: Response;
      try {
        r = await fetch(`${opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
          body,
          signal: AbortSignal.timeout(opts.timeoutMs),
        });
      } catch (e) {
        const name = (e as Error).name;
        throw new LlmError(name === "TimeoutError" || name === "AbortError" ? `${opts.name} 응답 시간 초과 (${opts.timeoutMs}ms)` : `${opts.name} 네트워크 오류`, name === "TimeoutError" ? "timeout" : "network");
      }
      if (r.status === 401 || r.status === 403) {
        // 403은 키 오류가 아니라 잔액 부족·모델 권한일 수 있어 공급자 메시지를 함께 남긴다
        const msg = await r.text().then((t) => { try { return String(JSON.parse(t)?.error?.message ?? t); } catch { return t; } }).catch(() => "");
        throw new LlmError(`${opts.name} 인증·권한 거부 (HTTP ${r.status}): ${redact(msg.replace(/\s*\(request id:[^)]*\)/, "").slice(0, 160))}`, "auth");
      }
      if (r.status === 429 || r.status >= 500) {
        lastErr = new LlmError(`${opts.name} 일시 오류 (HTTP ${r.status})`, r.status === 429 ? "rate_limit" : "server");
        if (attempt < 2) await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
        continue;
      }
      if (r.status === 400 && withExtra) {
        // 선택 파라미터(reasoning_effort 등)를 공급자가 모르면 빼고 다시 보낸다
        lastErr = new LlmError(`${opts.name} 요청 형식 거부 (HTTP 400): ${redact((await r.text()).slice(0, 200))}`, "server");
        withExtra = false;
        continue;
      }
      if (!r.ok) throw new LlmError(`${opts.name} 요청 실패 (HTTP ${r.status}): ${redact((await r.text()).slice(0, 200))}`, "server");
      const j: any = await r.json();
      const choice = j?.choices?.[0];
      const content = choice?.message?.content;
      if (typeof content !== "string" || !content.trim())
        throw new LlmError(choice?.finish_reason === "length" ? `${opts.name} 출력 상한 도달 (추론 토큰 소진)` : `${opts.name} 빈 응답`, "format");
      return { content, latencyMs: Date.now() - t0 };
    }
    throw lastErr!;
  }

  return {
    name: opts.name,
    model: opts.model,
    complete,

    async extractNeeds(messages: ChatMessage[], current: UserNeeds, today: string) {
      const convo: OpenAiMessage[] = [
        { role: "system", content: EXTRACT_SYSTEM_PROMPT(today, current) },
        // 최근 대화만 보낸다. 마지막 사용자 문장이 추출 대상이다.
        ...messages.slice(-6).map((m) => ({ role: m.role, content: m.content }) as OpenAiMessage),
      ];
      const first = await complete(convo, 2000);
      let parsed = parsePatch(first.content);
      let latency = first.latencyMs;
      if (!parsed.ok) {
        // 형식 오류는 한 번만 보정 요청한다.
        const repair = await complete(
          [...convo, { role: "assistant", content: first.content.slice(0, 1500) }, { role: "user", content: `형식 오류: ${parsed.error}. 지정한 JSON 객체 하나만 다시 출력해.` }],
          2000,
        );
        latency += repair.latencyMs;
        parsed = parsePatch(repair.content);
        if (!parsed.ok) throw new LlmError(`모델 응답 형식 오류: ${parsed.error}`, "format");
      }
      return { patch: parsed.patch, latencyMs: latency };
    },

    async explainPlans(result) {
      const r = await complete(
        [
          { role: "system", content: EXPLAIN_SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(compactForExplain(result)) },
        ],
        2500,
      );
      return { text: r.content.trim(), latencyMs: r.latencyMs };
    },
  };
}

export function parsePatch(content: string): { ok: true; patch: NeedsPatch } | { ok: false; error: string } {
  const cleaned = content.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return { ok: false, error: "JSON 객체가 없습니다" };
  let raw: unknown;
  try {
    raw = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return { ok: false, error: "JSON 파싱 실패" };
  }
  // 모델이 숫자로 준 금액을 문자열로 정규화
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, any>;
    for (const k of ["amount", "bufferAmount"]) if (typeof o[k] === "number") o[k] = String(o[k]);
    if (Array.isArray(o.expenses)) for (const e of o.expenses) if (e && typeof e.amount === "number") e.amount = String(e.amount);
    for (const k of ["amount", "bufferAmount"]) if (typeof o[k] === "string") o[k] = o[k].replace(/,/g, "");
    if (Array.isArray(o.expenses)) for (const e of o.expenses) if (e && typeof e.amount === "string") e.amount = e.amount.replace(/,/g, "");
  }
  const r = NeedsPatch.safeParse(raw);
  if (!r.success) return { ok: false, error: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 300) };
  return { ok: true, patch: r.data };
}

export function createNim(): LlmProvider {
  return createOpenAiCompatible({
    name: "NVIDIA NIM",
    baseUrl: env.nimBaseUrl,
    apiKey: env.nimApiKey,
    model: env.nimModel,
    timeoutMs: env.llmTimeoutMs,
    temperature: 0,
    // Nemotron 3 계열은 사고 과정을 켜 두면 출력 상한에서 영문 사고 과정이 답변(content)으로 새어 나온다.
    // 끄면 응답도 빨라진다(약 7초 → 2.5초). 지원하지 않는 모델은 HTTP 400 → 이 옵션을 빼고 재요청한다.
    extra: { chat_template_kwargs: { enable_thinking: false } },
  });
}
