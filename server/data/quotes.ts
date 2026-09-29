import fs from "node:fs";
import path from "node:path";
import { env } from "../env";
import { chainFees } from "./tron-rpc";
import { fetchMainnetMarkets, fetchNileJtrx, fetchNileJusdd, JUSTLEND, mainnetJTokenCosts, nileJtrxEnergy } from "./justlend";
import { fetchStaking } from "./staking";
import { fetchMarketUniverse } from "./discovery";
import { fetchSwapMarket } from "./sunswap";
import { fetchPsm, fetchUsddSavings, psmEnergyFromRecentTxs, USDD } from "./usdd";
import { callReadTool, isConnected } from "../mcp/clients";
import type { CostBasis, ProductQuote, SourceMeta } from "../../shared/schemas";
import type { MainnetInputs, NileInputs } from "../../shared/planning";

// ② 데이터 조회 → 정규화 quote. 실패하면 unavailable과 사유를 돌려준다 (과거 값을 현재처럼 쓰지 않음).

export interface Fetched<T> {
  inputs: T;
  failures: string[];
  mode: "live" | "synthetic";
}

const fixture = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "fixtures/synthetic-quotes.json"), "utf8"));

function syntheticSource(chain: "mainnet" | "nile", now: string): SourceMeta {
  return { sourceUrl: "fixtures/synthetic-quotes.json", chain, fetchedAt: now, mode: "synthetic", accessMethod: "fixture", note: "가상 값 (실제 금리 아님)" };
}

function syntheticMainnet(): MainnetInputs {
  const now = new Date().toISOString();
  const src = syntheticSource("mainnet", now);
  const lending = (market: string, token: string, address: string, f: any): ProductQuote => ({
    id: `synthetic:${market}`, kind: "lending", market, token, address, chain: "mainnet",
    baseRate: f.baseRate, rateType: "APY", liquidity: f.liquidity, active: f.active,
    rewards: { status: "unverified", note: "가상 데이터: 보상 미확인" }, source: src,
  });
  return {
    jusdt: lending("jUSDT", "USDT", JUSTLEND.mainnet.jUSDT, fixture.jusdt),
    jusdd: lending("jUSDD", "USDD", JUSTLEND.mainnet.jUSDD, fixture.jusdd),
    jtrx: lending("jTRX", "TRX", JUSTLEND.mainnet.jTRX, fixture.jtrx),
    psm: {
      id: "synthetic:PSM-USDT", kind: "psm", market: "USDD PSM (USDT)", token: "USDD", address: USDD.psm, chain: "mainnet",
      active: true, rewards: { status: "none", note: "PSM은 수익원이 아닙니다." }, psm: fixture.psm, source: src,
    },
    staking: {
      id: "synthetic:TRX-STAKE-VOTE", kind: "staking", market: "TRX 스테이킹 + SR 투표", token: "TRX", address: fixture.staking.srAddress, chain: "mainnet",
      baseRate: fixture.staking.baseRate, rateType: "APR", active: true, rewards: { status: "none", note: "가상 데이터" },
      staking: { srAddress: fixture.staking.srAddress, srName: "가상 SR", brokerage: "0", srVotes: "1", totalVotes: "1", unfreezeDelayDays: 14, voteRewardPerBlockTrx: "128", blockRewardPerBlockTrx: "8", candidates: 27 },
      source: src,
    },
    swap: {
      router: "TKzxdSv2FZKQrEqkKVgp5DcwEXBEKMg2Ax", pair: "synthetic", reserveUsdt: fixture.swap.reserveUsdt, reserveTrx: fixture.swap.reserveTrx, feeNumerator: 997,
      costs: { toTrx: fixture.swap.toTrx, toUsdt: fixture.swap.toUsdt, sampleSize: 0 }, source: src,
    },
    costBasis: { ...fixture.costBasis, source: src, priceSource: src },
  };
}

/** Mainnet 수수료 파라미터: TronGrid MCP 우선, 실패하면 직접 RPC로 보완하고 그 사실을 기록한다 */
async function mainnetFees(): Promise<{ fees: { energyFeeSun: number; bandwidthFeeSun: number }; meta: Pick<SourceMeta, "accessMethod" | "serverId" | "toolName" | "note"> }> {
  if (isConnected("trongrid")) {
    try {
      const { data, version } = await callReadTool("trongrid", "getChainParameters", {});
      const list = (data as any)?.chainParameter;
      const find = (k: string) => (Array.isArray(list) ? list.find((p: any) => p?.key === k)?.value : undefined);
      const energyFeeSun = Number(find("getEnergyFee"));
      const bandwidthFeeSun = Number(find("getTransactionFee"));
      if (energyFeeSun > 0 && bandwidthFeeSun > 0)
        return { fees: { energyFeeSun, bandwidthFeeSun }, meta: { accessMethod: "mcp", serverId: `trongrid@${version ?? "?"}`, toolName: "getChainParameters" } };
    } catch (e) {
      return { fees: await chainFees("mainnet"), meta: { accessMethod: "direct", note: `TronGrid MCP 실패 → 직접 RPC 대체: ${(e as Error).message}` } };
    }
  }
  return { fees: await chainFees("mainnet"), meta: { accessMethod: "direct" } };
}

let cache: { at: number; value: Fetched<MainnetInputs> } | undefined;
const CACHE_MS = 60_000;

export async function getMainnetInputs(force = false): Promise<Fetched<MainnetInputs>> {
  if (env.dataMode === "synthetic") return { inputs: syntheticMainnet(), failures: [], mode: "synthetic" };
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.value;

  const failures: string[] = [];
  const [markets, psm, feeResult, psmEnergy, staking, jTokenCosts, universe, swap, usddSavings] = await Promise.all([
    fetchMainnetMarkets().catch((e) => (failures.push(`JustLend 시장 조회 실패: ${e.message}`), undefined)),
    fetchPsm().catch((e) => (failures.push(`USDD PSM 조회 실패: ${e.message}`), undefined)),
    mainnetFees().catch((e) => (failures.push(`Mainnet 수수료 파라미터 조회 실패: ${e.message}`), undefined)),
    psmEnergyFromRecentTxs().catch((e) => (failures.push(`PSM 거래비용 실측 조회 실패: ${e.message}`), undefined)),
    fetchStaking().catch((e) => (failures.push(`TRX 스테이킹·투표 보상 조회 실패: ${e.message}`), undefined)),
    // 실측에 실패해도 공식 일반값으로 계산할 수 있으므로 실패 목록에 넣지 않는다
    mainnetJTokenCosts().catch(() => undefined),
    // 탐색 표용 전체 시장. 실패해도 계획 계산에는 지장이 없다 (가진 시세로 최소 표를 만든다)
    fetchMarketUniverse().catch(() => undefined),
    // USDT 보유자의 TRX 스테이킹 경로 (없으면 그 경로만 제외되므로 실패 목록에 사유를 남긴다)
    fetchSwapMarket().catch((e) => (failures.push(`SunSwap USDT↔TRX 교환 견적 조회 실패: ${e.message}`), undefined)),
    // 탐색 표용 USDD 저축 상태. 실패해도 계획 계산에는 지장이 없다
    fetchUsddSavings().catch(() => undefined),
  ]);
  const now = new Date().toISOString();
  let costBasis: CostBasis | undefined;
  if (feeResult) {
    const { fees, meta } = feeResult;
    costBasis = {
      ...fees,
      trxPerUsdt: markets?.trxPerUsdt,
      psmEnergy,
      jTokenCosts: jTokenCosts && Object.keys(jTokenCosts).length ? jTokenCosts : undefined,
      source: { sourceUrl: "https://api.trongrid.io/wallet/getchainparameters", chain: "mainnet", fetchedAt: now, mode: "live", note: "getEnergyFee / getTransactionFee", ...meta },
      priceSource: markets
        ? { sourceUrl: JUSTLEND.apiUrl, chain: "mainnet", fetchedAt: markets.fetchedAt, mode: "live", accessMethod: "direct", note: "jUSDT.underlyingPriceInTrx (JustLend 오라클 가격)" }
        : undefined,
    };
  }
  const value: Fetched<MainnetInputs> = { inputs: { jusdt: markets?.jusdt, jusdd: markets?.jusdd, jtrx: markets?.jtrx, psm, staking, swap, usddSavings, costBasis, markets: universe }, failures, mode: "live" };
  if (!failures.length) cache = { at: Date.now(), value };
  return value;
}

let energyCache: { at: number; value: Awaited<ReturnType<typeof nileJtrxEnergy>> } | undefined;
/** Nile jTRX 거래 Energy 실측은 10분 캐시한다 (거래 목록 조회가 무겁다) */
export async function cachedJtrxEnergy() {
  if (energyCache && Date.now() - energyCache.at < 10 * 60 * 1000) return energyCache.value;
  const value = await nileJtrxEnergy();
  energyCache = { at: Date.now(), value };
  return value;
}

export async function getNileInputs(): Promise<Fetched<Omit<NileInputs, "walletBalanceTrx">>> {
  // 실거래가 켜져 있으면 Nile은 항상 실제 계약 값을 읽는다 (가상 값으로 거래 판단 금지).
  if (env.dataMode === "synthetic" && !env.enableNileExecution) {
    const now = new Date().toISOString();
    const src = syntheticSource("nile", now);
    return {
      inputs: {
        jtrx: {
          id: "synthetic:jTRX", kind: "lending", market: "jTRX", token: "TRX", address: JUSTLEND.nile.jTRX, chain: "nile",
          baseRate: fixture.jtrx.baseRate, rateType: "APR", liquidity: fixture.jtrx.liquidity, active: true,
          rewards: { status: "none", note: "-" }, source: src,
        },
        costBasis: { energyFeeSun: fixture.costBasis.energyFeeSun, bandwidthFeeSun: fixture.costBasis.bandwidthFeeSun, source: src },
      },
      failures: [],
      mode: "synthetic",
    };
  }
  const failures: string[] = [];
  // Nile 라우터·PSM에 최근 직접 거래가 없으면 같은 계약 코드의 Mainnet 실측값을 쓴다 (출처에 표시)
  const mainnetSwapCosts = cache?.value.inputs.swap?.costs ?? (await fetchSwapMarket("mainnet").then((m) => m.costs, () => undefined));
  const [jtrx, fees, jtrxEnergy, staking, jusdd, psm, swap, psmNile, psmMain] = await Promise.all([
    fetchNileJtrx().catch((e) => (failures.push(`Nile jTRX 조회 실패: ${e.message}`), undefined)),
    chainFees("nile").catch((e) => (failures.push(`Nile 수수료 파라미터 조회 실패: ${e.message}`), undefined)),
    cachedJtrxEnergy().catch((e) => (failures.push(`Nile jTRX 거래비용 실측 실패(일반값 사용): ${e.message}`), undefined)),
    // Nile SR 목록·체인 파라미터로 계산한 스테이킹 견적 (계획 C·L)
    fetchStaking("nile").catch((e) => (failures.push(`Nile 스테이킹·투표 보상 조회 실패: ${e.message}`), undefined)),
    fetchNileJusdd().catch((e) => (failures.push(`Nile jUSDD 조회 실패: ${e.message}`), undefined)),
    fetchPsm("nile").catch((e) => (failures.push(`Nile USDD PSM 조회 실패: ${e.message}`), undefined)),
    fetchSwapMarket("nile", mainnetSwapCosts).catch((e) => (failures.push(`Nile SunSwap TRX↔USDT 경로 조회 실패: ${e.message}`), undefined)),
    psmEnergyFromRecentTxs("nile").catch(() => undefined),
    psmEnergyFromRecentTxs("mainnet").catch(() => undefined),
  ]);
  const psmEnergy = psmNile ?? psmMain;
  const costBasis: CostBasis | undefined = fees
    ? { ...fees, jtrxEnergy, psmEnergy, source: { sourceUrl: "https://nile.trongrid.io/wallet/getchainparameters", chain: "nile", fetchedAt: new Date().toISOString(), mode: "live", accessMethod: "direct", note: jtrxEnergy ? `jTRX 거래 Energy: 최근 성공 거래 ${jtrxEnergy.sampleSize}건 실측 최대값` : "jTRX 거래 Energy: JustLend MCP 일반값" } }
    : undefined;
  return { inputs: { jtrx, staking, jusdd, psm, swap, costBasis }, failures, mode: "live" };
}
