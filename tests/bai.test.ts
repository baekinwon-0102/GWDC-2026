import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAiCompatible } from "../server/llm/nim";
import { emptyNeeds } from "../shared/needs";

const ok = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }), { status: 200 });

const bai = () =>
  createOpenAiCompatible({
    name: "Bank of AI",
    baseUrl: "https://api.b.ai/v1/",
    apiKey: "test-key",
    model: "gpt-5.6-terra",
    timeoutMs: 5000,
    tokenParam: "max_completion_tokens",
    tokenMultiplier: 2,
    extra: { reasoning_effort: "low" },
  });

afterEach(() => vi.unstubAllGlobals());

describe("Bank of AI 요청 형식", () => {
  it("추론 모델 형식으로 보낸다 (max_completion_tokens, temperature 없음, Bearer)", async () => {
    const fetchMock = vi.fn(async () => ok('{"amount":"1000","durationDays":30}'));
    vi.stubGlobal("fetch", fetchMock);
    const r = await bai().extractNeeds([{ role: "user", content: "1000 USDT 30일" }], emptyNeeds("mainnet"), "2026-09-29");
    expect(r.patch.amount).toBe("1000");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.b.ai/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("gpt-5.6-terra");
    expect(body.max_completion_tokens).toBe(4000);
    expect(body).not.toHaveProperty("max_tokens");
    expect(body).not.toHaveProperty("temperature");
    expect(body.reasoning_effort).toBe("low");
  });

  it("HTTP 400이면 선택 파라미터를 빼고 한 번 다시 보낸다", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('{"error":"unknown parameter reasoning_effort"}', { status: 400 })).mockResolvedValueOnce(ok('{"amount":"5"}'));
    vi.stubGlobal("fetch", fetchMock);
    const r = await bai().extractNeeds([{ role: "user", content: "5 USDT" }], emptyNeeds("mainnet"), "2026-09-29");
    expect(r.patch.amount).toBe("5");
    expect(JSON.parse(String((fetchMock.mock.calls[1] as any)[1].body))).not.toHaveProperty("reasoning_effort");
  });

  it("추론 토큰으로 출력이 비면 형식 오류로 알린다 (→ 템플릿 대체)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "length" }] }), { status: 200 })));
    await expect(bai().extractNeeds([{ role: "user", content: "x" }], emptyNeeds("mainnet"), "2026-09-29")).rejects.toMatchObject({ kind: "format" });
  });
});
