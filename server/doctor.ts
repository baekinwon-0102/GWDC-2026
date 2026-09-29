import { env, publicConfig, redact } from "./env";
import { createNim } from "./llm/nim";
import { createBai, listBaiModels } from "./llm/bai";
import { contractExists, nowBlock } from "./data/tron-rpc";
import { fetchMainnetMarkets, fetchNileJtrx, JUSTLEND, mainnetJTokenCosts, nileJtrxEnergy } from "./data/justlend";
import { fetchStaking } from "./data/staking";
import { fetchPsm, psmEnergyFromRecentTxs } from "./data/usdd";
import { fetchSwapMarket } from "./data/sunswap";
import { closeAll, connectAll } from "./mcp/clients";
import { checkToolCall } from "./mcp/registry";
import { emptyNeeds, todaySeoul } from "../shared/needs";

// 외부 연결 진단. 결과를 성공 / 실패 / 미확인으로 기록한다. 키 값은 출력하지 않는다.

type Result = { name: string; status: "성공" | "실패" | "미확인"; detail: string };
const results: Result[] = [];

async function check(name: string, fn: () => Promise<string>, skip?: string) {
  if (skip) return results.push({ name, status: "미확인", detail: skip });
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, status: "성공", detail: `${detail} (${Date.now() - t0}ms)` });
  } catch (e) {
    results.push({ name, status: "실패", detail: redact(String((e as Error).message ?? e)) });
  }
}

console.log("설정:", JSON.stringify(publicConfig()));

await check("TronGrid Mainnet", async () => `블록 ${await nowBlock("mainnet")}`, env.trongridApiKey ? undefined : "TRONGRID_API_KEY 없음");
await check("TronGrid Nile", async () => `블록 ${await nowBlock("nile")}`);
await check("JustLend OpenAPI (jUSDT/jUSDD)", async () => {
  const m = await fetchMainnetMarkets();
  return `jUSDT APY ${m.jusdt.baseRate} active=${m.jusdt.active}, jUSDD APY ${m.jusdd.baseRate} active=${m.jusdd.active}, 1 USDT=${m.trxPerUsdt} TRX`;
});
await check("USDD PSM 온체인", async () => {
  const p = await fetchPsm();
  return `tin=${p.psm!.feeIn} tout=${p.psm!.feeOut} sell=${p.psm!.sellEnabled} buy=${p.psm!.buyEnabled} 진입여유=${p.psm!.entryCapacity} 출구USDT=${p.psm!.exitLiquidity}`;
});
await check("PSM 거래비용 실측", async () => {
  const e = await psmEnergyFromRecentTxs();
  if (!e) throw new Error("최근 성공 거래에서 sell/buy를 모두 찾지 못함");
  return `sell≤${e.sell} buy≤${e.buy} energy (표본 ${e.sampleSize})`;
});
await check("JustLend 채굴 보상 (앱 백엔드)", async () => {
  const m = await fetchMainnetMarkets();
  const f = (q: typeof m.jusdt) => (q.rewards.apr ? `${q.market} 추정 연 ${(Number(q.rewards.apr) * 100).toFixed(2)}% (${q.rewards.token}, 미확인)` : `${q.market} ${q.rewards.status}`);
  if (!m.jusdd.rewards.source) throw new Error("보상 API 응답 없음");
  return `${f(m.jusdt)}, ${f(m.jusdd)}`;
});
await check("TRX 스테이킹·투표 보상", async () => {
  const s = await fetchStaking();
  const bw = s.staking!.txBandwidth;
  return `${s.staking!.srName} 수수료 ${(Number(s.staking!.brokerage) * 100).toFixed(0)}% → 투표자 APR ${(Number(s.baseRate) * 100).toFixed(4)}%, 해제 대기 ${s.staking!.unfreezeDelayDays}일, 투표 반영 ${s.staking!.voteDelayDays}일, 거래 대역폭 ${bw ? `실측(${bw.measured.join("/")}) 최대 ${Math.max(bw.stake, bw.vote, bw.claim)} bytes` : "측정 실패 → 추정"}`;
});
await check("Nile TRX 스테이킹·투표 보상", async () => {
  const s = await fetchStaking("nile");
  return `투표자 APR ${(Number(s.baseRate) * 100).toFixed(2)}% (${s.staking?.srName}), 해제 대기 ${s.staking?.unfreezeDelayDays}일`;
});
await check("SunSwap V2 USDT↔TRX 교환 견적", async () => {
  const m = await fetchSwapMarket();
  return `준비금 USDT ${Number(m.reserveUsdt).toFixed(0)} / TRX ${Number(m.reserveTrx).toFixed(0)}, 교환 Energy ${m.costs.toTrx.energy}·${m.costs.toUsdt.energy} (표본 ${m.costs.sampleSize}건)`;
});
await check("Nile jTRX 거래비용 실측", async () => {
  const e = await nileJtrxEnergy();
  if (!e) throw new Error("최근 성공 거래에서 mint/redeem을 모두 찾지 못함 (일반값 사용)");
  return `mint≤${e.mint} redeem≤${e.redeem} redeemUnderlying≤${e.redeemUnderlying} energy (표본 ${e.sampleSize})`;
});
await check("Mainnet jUSDT·jUSDD 거래비용 실측", async () => {
  const c = await mainnetJTokenCosts();
  if (!Object.keys(c).length) throw new Error("최근 성공 거래 표본 없음 (일반값 사용)");
  return Object.entries(c).map(([m, v]) => `${m} 예치≤${v.supply.energy} 인출≤${v.withdraw.energy} energy (표본 ${v.sampleSize})`).join(", ");
});
await check("Nile jTRX 계약", async () => {
  const c = await contractExists("nile", JUSTLEND.nile.jTRX);
  if (!c.exists) throw new Error("계약 없음");
  const q = await fetchNileJtrx();
  return `${c.name}, APR ${q.baseRate}, 현금 ${q.liquidity} TRX, active=${q.active}`;
});
await check(
  "Bank of AI 모델 목록",
  async () => {
    const ids = await listBaiModels();
    if (!ids.includes(env.baiModel)) throw new Error(`BAI_MODEL=${env.baiModel} 이(가) 목록에 없음. GPT 계열: ${ids.filter((x) => /gpt/i.test(x)).join(", ") || ids.slice(0, 15).join(", ")}`);
    return `${env.baiModel} 사용 가능 (전체 ${ids.length}개)`;
  },
  env.llmProvider !== "bai" ? `LLM_PROVIDER=${env.llmProvider} (Bank of AI 미사용)` : env.baiApiKey ? undefined : "BAI_API_KEY 없음",
);
await check(
  "LLM (Bank of AI) 추출",
  async () => {
    const r = await createBai().extractNeeds([{ role: "user", content: "1,000 USDT를 30일 운용하고 7일 뒤 200 USDT를 써요" }], emptyNeeds("mainnet"), todaySeoul());
    if (r.patch.amount !== "1000" || r.patch.durationDays !== 30 || r.patch.expenses?.[0]?.amount !== "200") throw new Error(`추출 결과 불일치: ${JSON.stringify(r.patch)}`);
    return `${env.baiModel} ${r.latencyMs}ms: ${JSON.stringify(r.patch)}`;
  },
  env.llmProvider !== "bai" ? `LLM_PROVIDER=${env.llmProvider} (Bank of AI 미사용)` : env.baiApiKey ? undefined : "BAI_API_KEY 없음",
);
await check(
  "LLM (NIM) 추출",
  async () => {
    const r = await createNim().extractNeeds([{ role: "user", content: "1,000 USDT를 30일 운용하고 7일 뒤 200 USDT를 써요" }], emptyNeeds("mainnet"), todaySeoul());
    return `${env.nimModel}: ${JSON.stringify(r.patch)}`;
  },
  env.llmProvider !== "nim" ? `LLM_PROVIDER=${env.llmProvider} (NIM 미사용)` : env.nimApiKey ? undefined : "NIM_API_KEY 없음",
);
await check("MCP 허용 목록 거부 테스트", async () => {
  const bad = checkToolCall("justlend", "supply", {});
  const unknown = checkToolCall("usdd", "psm_sell_gem", {});
  const okCall = checkToolCall("usdd", "get_psm_status", { market: "PSM-USDT", network: "tron" });
  if (bad.ok || unknown.ok || !okCall.ok) throw new Error("허용 목록 판정 오류");
  return "쓰기 도구 거부, 읽기 도구 허용 확인";
});
await check("MCP 연결", async () => {
  const s = await connectAll();
  await closeAll();
  return s.map((x) => `${x.server}=${x.state}${x.tools ? ` (허용 ${x.tools.allowed.length}, 누락 ${x.tools.missing.length})` : ""}${x.error ? ` [${x.error}]` : ""}`).join(", ");
});

console.log("\n=== doctor 결과 ===");
for (const r of results) console.log(`[${r.status}] ${r.name} — ${r.detail}`);
process.exit(results.some((r) => r.status === "실패") ? 1 : 0);
