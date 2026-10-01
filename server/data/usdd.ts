import Decimal from "decimal.js";
import { TronWeb } from "tronweb";
import { measureContractCosts, readUint, readWords } from "./tron-rpc";
import { fromBaseUnits } from "../../shared/units";
import type { CostBasis, ProductQuote } from "../../shared/schemas";
import type { UsddSavings } from "../../shared/planning";

// USDD PSM(USDT) 독립 조회. JustLend와 별개의 계약 경로다.
// 주소 출처: https://docs.usdd.io/developers/deployment-addresses , 공식 USDD MCP src/core/chains.ts

export const USDD = {
  docsUrl: "https://docs.usdd.io/developers/deployment-addresses",
  psm: "TBXW4hS5KYjjbJXDpnrPf4zhkLwrpUjbyz", // MCD_PSM_USDT_A
  gemJoin: "TSUYvQ5tdd3DijCD1uGunGLpftHuSZ12sQ", // JOIN_PSM_USDT_A
  vat: "TH5dhX7o39afSbfDT2e3c9k4itWjNKD4D9",
  usdt: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
  usdd: "TXDk8mbtRbXeYuMNS83CfKPaYYT8XWv9Hz",
  sellGemSelector: "95991276",
  buyGemSelector: "8d7ef9bb",
};

/**
 * Nile USDD 2.0 PSM (USDT 2.0 ↔ USDD 2.0, Nile jUSDD의 기초자산과 같은 USDD).
 * 출처: GitHub sun-protocol/sunswap-universal-router scripts/config.js (nile: usdt20psmpool, usdd20Token, usdt20Token)
 */
export const USDD_NILE = {
  psm: "TPj6Z88798iDSCuFe5gFcivJCSMsfmHKfr",
  gemJoin: "TSX7g6WiZaKPkVvrPaDHpRgoVsSvbPfrBv",
  usdt: "TZDnq7egPqzi7H4SXy1ABvwaVRvRTaVfJW",
  usdd: "TZ78R2E6ejfFhxq8hxrmuqT6hGBxjHQbo4",
};
const PSM_CFG = {
  mainnet: { psm: USDD.psm, gemJoin: USDD.gemJoin, usdt: USDD.usdt, vat: USDD.vat as string | undefined, explorer: "https://tronscan.org/#/contract/" },
  nile: { psm: USDD_NILE.psm, gemJoin: USDD_NILE.gemJoin, usdt: USDD_NILE.usdt, vat: undefined as string | undefined, explorer: "https://nile.tronscan.org/#/contract/" },
};

const WAD = new Decimal("1e18");
const RAD = new Decimal("1e45");

export async function fetchPsm(chain: "mainnet" | "nile" = "mainnet"): Promise<ProductQuote> {
  const fetchedAt = new Date().toISOString();
  const c = PSM_CFG[chain];
  const [tin, tout, sell, buy, ilkWords, exitRaw] = await Promise.all([
    readUint(chain, c.psm, "tin()"),
    readUint(chain, c.psm, "tout()"),
    readUint(chain, c.psm, "sellEnabled()"),
    readUint(chain, c.psm, "buyEnabled()"),
    readWords(chain, c.psm, "ilk()"),
    readUint(chain, c.usdt, "balanceOf(address)", [{ type: "address", value: c.gemJoin }]),
  ]);
  const vat = c.vat ?? TronWeb.address.fromHex("41" + (await readWords(chain, c.psm, "vat()"))[0].slice(24));
  // Vat.ilks(ilk) → (Art wad, rate ray, spot ray, line rad, dust rad). 진입 여유 = line − Art×rate
  let entryCapacity: string | undefined;
  try {
    const w = await readWords(chain, vat, "ilks(bytes32)", [{ type: "bytes32", value: "0x" + ilkWords[0] }]);
    const Art = BigInt("0x" + w[0]);
    const rate = BigInt("0x" + w[1]);
    const line = BigInt("0x" + w[3]);
    const room = line - Art * rate;
    entryCapacity = Decimal.max(new Decimal(room.toString()).div(RAD), 0).toFixed();
  } catch {
    entryCapacity = undefined;
  }
  return {
    id: `${chain}:PSM-USDT`,
    kind: "psm",
    market: chain === "nile" ? "USDD 2.0 PSM (USDT 2.0, Nile)" : "USDD PSM (USDT)",
    token: "USDD",
    address: c.psm,
    chain,
    active: sell === 1n && buy === 1n,
    inactiveReason: sell !== 1n || buy !== 1n ? "PSM 전환 방향 중 하나 이상이 비활성입니다" : undefined,
    rewards: { status: "none", note: "PSM은 전환 경로이며 수익원이 아닙니다." },
    psm: {
      feeIn: new Decimal(tin.toString()).div(WAD).toFixed(),
      feeOut: new Decimal(tout.toString()).div(WAD).toFixed(),
      sellEnabled: sell === 1n,
      buyEnabled: buy === 1n,
      entryCapacity,
      exitLiquidity: fromBaseUnits(exitRaw, 6),
    },
    source: {
      sourceUrl: `${c.explorer}${c.psm}`,
      chain,
      fetchedAt,
      mode: "live",
      accessMethod: "direct",
      note: "PSM.tin/tout/sellEnabled/buyEnabled, Vat.ilks(PSM-USDT-A), USDT.balanceOf(GemJoin) 온체인 읽기",
    },
  };
}

/** 최근 성공한 PSM 전환 거래 50건의 실측 최대 Energy·대역폭을 비용 근거로 쓴다 */
export async function psmEnergyFromRecentTxs(chain: "mainnet" | "nile" = "mainnet"): Promise<NonNullable<CostBasis["psmEnergy"]> | undefined> {
  const m = await measureContractCosts(chain, PSM_CFG[chain].psm, { sell: USDD.sellGemSelector, buy: USDD.buyGemSelector }, 50);
  if (!m.sell || !m.buy) return undefined;
  return { sell: m.sell.energy, buy: m.buy.energy, sampleSize: m.sell.sampleSize + m.buy.sampleSize, bandwidth: { sell: m.sell.bandwidth, buy: m.buy.bandwidth }, median: { sell: m.sell.median.energy, buy: m.buy.median.energy } };
}

// ---------------------------------------------------------------- USDD 저축 (sUSDD)
// 출처: USDD 공식 MCP(decentralized-usd/mcp-server-usdd)가 쓰는 앱 API /data-platform/latest-collateral (체인별 apy·earnTvl)와
// USDD 체인 등록부(chainlog, 공식 MCP src/core/chains.ts의 TRON_CHAINLOG_ADDRESS)의 SUSDD·MCD_POT 키.
export const USDD_APP_API = "https://app-api.usdd.io/data-platform/latest-collateral";
export const USDD_TRON_CHAINLOG = "TH2iieRStHtzDMTPXdFcgixQLBuhrtq6p9";
let savingsCache: { at: number; value: UsddSavings } | undefined;

async function chainMetrics(chain: string): Promise<{ apy?: string; earnTvl: string }> {
  const r = await fetch(`${USDD_APP_API}?chain=${chain}`, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`USDD 앱 API HTTP ${r.status}`);
  const d = (await r.json())?.data;
  if (!d) throw new Error("USDD 앱 API 응답 없음");
  return { apy: d.apy != null ? String(d.apy) : undefined, earnTvl: String(d.earnTvl ?? 0) };
}

async function tronRegistered(key: string): Promise<boolean> {
  const hex = "0x" + Buffer.from(key).toString("hex").padEnd(64, "0");
  // 등록되지 않은 키는 getAddress가 되돌려진다(revert)
  return readWords("mainnet", USDD_TRON_CHAINLOG, "getAddress(bytes32)", [{ type: "bytes32", value: hex }]).then(
    () => true,
    () => false,
  );
}

export async function fetchUsddSavings(): Promise<UsddSavings> {
  if (savingsCache && Date.now() - savingsCache.at < 10 * 60 * 1000) return savingsCache.value;
  const [tron, eth, bsc, susdd, pot] = await Promise.all([
    chainMetrics("tron"),
    chainMetrics("eth").catch(() => undefined),
    chainMetrics("bsc").catch(() => undefined),
    tronRegistered("SUSDD"),
    tronRegistered("MCD_POT"),
  ]);
  const value: UsddSavings = {
    tron: { ...tron, registered: susdd || pot },
    otherChains: [eth && { chain: "Ethereum", ...eth }, bsc && { chain: "BSC", ...bsc }].filter(Boolean) as UsddSavings["otherChains"],
    source: { sourceUrl: `${USDD_APP_API}?chain=tron`, chain: "mainnet", fetchedAt: new Date().toISOString(), mode: "live", accessMethod: "direct", note: "USDD 앱 API 체인별 저축 금리·예치 규모 + TRON chainlog SUSDD·MCD_POT 등록 여부" },
  };
  savingsCache = { at: Date.now(), value };
  return value;
}
