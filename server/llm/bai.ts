import { env } from "../env";
import { createOpenAiCompatible } from "./nim";
import type { LlmProvider } from "./provider";

// Bank of AI (B.AI) LLM Service. 해커톤 안내의 "TRON LLM"이 이 서비스다.
// 명세: https://docs.b.ai/llmservice/api/ — Base URL https://api.b.ai/v1, Bearer 인증, OpenAI 호환 /chat/completions.
// 기본 모델 gpt-5.6-terra는 추론 모델이라 max_completion_tokens를 쓰고 temperature를 보내지 않는다.

export function createBai(): LlmProvider {
  return createOpenAiCompatible({
    name: "Bank of AI",
    baseUrl: env.baiBaseUrl,
    apiKey: env.baiApiKey,
    model: env.baiModel,
    timeoutMs: env.llmTimeoutMs,
    tokenParam: "max_completion_tokens",
    tokenMultiplier: 2,
    extra: { reasoning_effort: "low" },
  });
}

/** doctor용: 키로 조회 가능한 모델 ID 목록 */
export async function listBaiModels(): Promise<string[]> {
  const r = await fetch(`${env.baiBaseUrl.replace(/\/$/, "")}/models`, {
    headers: { Authorization: `Bearer ${env.baiApiKey}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`Bank of AI /models HTTP ${r.status}`);
  const j: any = await r.json();
  return (j?.data ?? []).map((m: any) => String(m?.id));
}
