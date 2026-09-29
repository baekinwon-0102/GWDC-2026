import { describe, expect, it } from "vitest";
import { parsePatch } from "../server/llm/nim";
import { templateExtract } from "../server/llm/template";
import { demoNeeds } from "../shared/needs";
import { checkToolCall, filterDiscovered } from "../server/mcp/registry";

describe("LLM 응답 검증", () => {
  it("코드 블록·숫자 금액을 정규화해 스키마로 검증한다", () => {
    const r = parsePatch('```json\n{"amount":1000,"durationDays":30,"expenses":[{"inDays":7,"amount":"200","asset":"USDT"}]}\n```');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.patch.amount).toBe("1000");
  });
  it("형식 오류와 잘못된 값은 거부한다", () => {
    expect(parsePatch("죄송합니다").ok).toBe(false);
    expect(parsePatch('{"amount":"천"}').ok).toBe(false);
    expect(parsePatch('{"riskProfile":"yolo"}').ok).toBe(false);
  });
});

describe("템플릿 추출 (LLM 장애 시)", () => {
  it("고정 사례 문장을 추출한다", () => {
    const p = templateExtract("1,000 USDT를 30일 운용하고, 7일 뒤에 200 USDT를 써야 해요. 여유액은 없어요.", undefined, "2026-09-29");
    expect(p.amount).toBe("1000");
    expect(p.durationDays).toBe(30);
    expect(p.expenses).toEqual([{ inDays: 7, amount: "200", asset: "USDT" }]);
    expect(p.bufferAmount).toBe("0");
  });
  it("직전 질문에 대한 짧은 답을 해석한다", () => {
    expect(templateExtract("네", "acceptUsddRisk").acceptUsddRisk).toBe(true);
    expect(templateExtract("아니요", "acceptUsddRisk").acceptUsddRisk).toBe(false);
    expect(templateExtract("균형형이요").riskProfile).toBe("balanced");
    expect(templateExtract("0", "bufferAmount").bufferAmount).toBe("0");
  });
  it("지출일 변경 문장", () => {
    expect(templateExtract("지출일을 45일 뒤로 바꿔 주세요", undefined, "2026-09-29", demoNeeds("2026-09-29")).expenses?.[0]).toMatchObject({ inDays: 45, amount: "200" });
    expect(templateExtract("45일 뒤에 200 USDT 지출").expenses?.[0].inDays).toBe(45);
  });
});

describe("MCP 허용 목록", () => {
  it("쓰기·지갑 도구와 목록 밖 도구, 잘못된 인자를 거부한다", () => {
    expect(checkToolCall("justlend", "supply", {}).ok).toBe(false);
    expect(checkToolCall("usdd", "psm_sell_gem", {}).ok).toBe(false);
    expect(checkToolCall("trongrid", "broadcastTransaction", {}).ok).toBe(false);
    expect(checkToolCall("trongrid", "getAccount", {}).ok).toBe(false);
    expect(checkToolCall("usdd", "get_psm_status", { market: "PSM-USDC", network: "tron" }).ok).toBe(false);
    expect(checkToolCall("usdd", "get_psm_status", { market: "PSM-USDT", network: "tron" }).ok).toBe(true);
    expect(checkToolCall("trongrid", "getChainParameters", {}).ok).toBe(true);
  });
  it("발견된 도구 중 허용된 읽기 도구만 노출한다", () => {
    const f = filterDiscovered("trongrid", ["getChainParameters", "broadcastHex", "createTransaction"]);
    expect(f.allowed).toEqual(["getChainParameters"]);
    expect(f.blocked).toEqual(["broadcastHex", "createTransaction"]);
  });
});

describe("AI 설명 숫자 검증", () => {
  it("계산 결과에 없는 숫자를 찾아낸다", async () => {
    const { unknownNumbers } = await import("../server/llm/provider");
    const data = { investable: "800", plans: [{ netReturn: "-6.1", breakEvenDays: "146320", baseRatePercent: "2.0022" }] };
    expect(unknownNumbers("800 USDT를 예치하면 순수익 -6.10 USDT, 손익분기 146,320일, 금리 2.0022%", data)).toEqual([]);
    expect(unknownNumbers("손익분기는 1,463,199일입니다", data)).toEqual(["1,463,199"]);
    expect(unknownNumbers("계획 A와 B 중 2개", data)).toEqual([]);
    // 소수 4자리를 넘는 값을 글자 그대로 인용한 경우는 허용한다
    expect(unknownNumbers("지갑 잔고는 96083.313932 TRX입니다", { trx: "96083.313932" })).toEqual([]);
    expect(unknownNumbers("지갑 잔고는 96083.313933 TRX입니다", { trx: "96083.313932" })).toEqual(["96083.313933"]);
  });
  it("다른 언어·필드 이름·영문 추론 누출을 찾아낸다", async () => {
    const { explanationIssues } = await import("../server/llm/provider");
    expect(explanationIssues("JustLend jUSDT에 800 USDT를 예치하면 왕복 거래비용 7.44 USDT를 차감해 순수익은 -6.14 USDT입니다.")).toEqual([]);
    expect(explanationIssues("투자 가능 금액이 남는다,これにより 비용이 없다")).toContain("한국어 외 문자");
    expect(explanationIssues("계획 A는 왕복 비용을 뜻하는 costsTrx 값이 크고 모든 계획이 eligible 상태이다").some((x) => x.startsWith("필드 이름"))).toBe(true);
    expect(explanationIssues("We need to produce a Korean explanation 4-6 sentences. 좋다")).toContain("영문 위주 응답");
    expect(explanationIssues("jTRX 잔고가 0입니다. meanwhile, 지갑 잔고는 유지됩니다.").some((x) => x.startsWith("영어 단어"))).toBe(true);
    expect(explanationIssues("jTRX 전체를 redeem했고 Energy 223341을 썼습니다. 보유(HOLD)를 권고합니다.")).toEqual([]);
  });
});
