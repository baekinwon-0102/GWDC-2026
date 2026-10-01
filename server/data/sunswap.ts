import Decimal from "decimal.js";
import { TronWeb } from "tronweb";
import { measureContractCosts, readWords, type MeasuredCost } from "./tron-rpc";
import type { SwapMarket } from "../../shared/planning";
import type { Chain } from "../../shared/schemas";

// SunSwap V2 USDT↔TRX 교환. 교환 결과는 풀 준비금으로 계산한다 (UniswapV2 공식: out = in×997×R_out ÷ (R_in×1000 + in×997)).
// 계산식이 라우터 getAmountsOut과 일치하는지 매번 교차 검증하고, 다르면 교환을 쓰지 않는다.
// 주소 출처:
//  - Mainnet 라우터 TKzxdSv2FZKQrEqkKVgp5DcwEXBEKMg2Ax: SunSwap 2.0 인터페이스 문서 · GitHub sunswap2.0-contracts
//  - Nile 라우터 TMn1qrmYUMSTXo9babrJLzepKZoPC7M6Sy, USDT 2.0 TZDnq7…, USDD(구, TYQF9c…): GitHub sun-protocol/sunswap-universal-router scripts/config.js (nile)
//    Nile USDT 2.0은 transfer가 성공해도 false를 돌려줘(TRON판 USDT 계약의 알려진 동작) V2 풀이 USDT를 내보내지 못한다(모의 실행으로 확인).
//    그래서 V2 풀은 TRX ↔ USDD(구) 한 단계만 쓰고, USDD(구) ↔ USDT 2.0은 USDD(구) PSM(chainlog MCD_PSM_USDT_A)으로 1:1 전환한다.
// WTRX·팩토리·페어는 라우터의 WETH()·factory()·getPair()로 체인에서 읽는다.

/** usdt: V2 풀의 스테이블 쪽 토큰 (Nile은 브리지 토큰 USDD 구버전). bridge: 스테이블 쪽 토큰 ↔ USDT를 잇는 PSM */
export const SUNSWAP: Record<Chain, { router: string; usdt: string; via?: string; docsUrl: string; explorer: string; bridge?: { psm: string; gemJoin: string; symbol: string } }> = {
  mainnet: {
    router: "TKzxdSv2FZKQrEqkKVgp5DcwEXBEKMg2Ax",
    usdt: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    docsUrl: "https://www.sunswap.com/docs/sunswapV2-interfaces_en.pdf",
    explorer: "https://tronscan.org/#/contract/",
  },
  nile: {
    router: "TMn1qrmYUMSTXo9babrJLzepKZoPC7M6Sy",
    usdt: "TYQF9cAeJ3Faq8QXpHxTcFco72DRCQbgFt",
    // USDD(구) PSM: USDD(구) ↔ USDT 2.0 (USDD Nile chainlog MCD_PSM_USDT_A · MCD_JOIN_PSM_USDT_A)
    bridge: { psm: "TEwUGMSAvbmzjxWoV8JWoSqvQm1A3AXs1V", gemJoin: "TBm4W3JpzsQC4z5mk96fLWZbfNKcfJ5Bxy", symbol: "USDD(구)" },
    docsUrl: "https://github.com/sun-protocol/sunswap-universal-router/blob/main/scripts/config.js",
    explorer: "https://nile.tronscan.org/#/contract/",
  },
};

const sel = (sig: string) => TronWeb.sha3(sig).slice(2, 10);
export const SWAP_SELECTORS = {
  toTrx: sel("swapExactTokensForETH(uint256,uint256,address[],address,uint256)"),
  toUsdt: sel("swapExactETHForTokens(uint256,address[],address,uint256)"),
};
const ZERO_ADDR = "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb";
const addr = (w: string) => TronWeb.address.fromHex("41" + w.slice(24));
const word = (w: string) => BigInt("0x" + w);

interface Meta {
  at: number;
  wtrx: string;
  /** USDT → TRX 방향 토큰 경로 */
  path: string[];
  decimals: number[];
  /** 경로의 각 단계: 페어 주소와 token0이 경로상 앞 토큰인지 */
  pairs: { pair: string; forward: boolean }[];
}
const metaCache: Partial<Record<Chain, Meta>> = {};
const costCache: Partial<Record<Chain, { at: number; value: SwapMarket["costs"] }>> = {};

async function loadMeta(chain: Chain): Promise<Meta> {
  const hit = metaCache[chain];
  if (hit && Date.now() - hit.at < 86_400_000) return hit;
  const c = SUNSWAP[chain];
  const wtrx = addr((await readWords(chain, c.router, "WETH()"))[0]);
  const factory = addr((await readWords(chain, c.router, "factory()"))[0]);
  const path = [c.usdt, ...(c.via ? [c.via] : []), wtrx];
  const pairs: Meta["pairs"] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const pair = addr((await readWords(chain, factory, "getPair(address,address)", [{ type: "address", value: path[i] }, { type: "address", value: path[i + 1] }]))[0]);
    if (pair === ZERO_ADDR) throw new Error(`SunSwap V2 풀이 없습니다 (${path[i]} ↔ ${path[i + 1]}).`);
    const t0 = addr((await readWords(chain, pair, "token0()"))[0]);
    pairs.push({ pair, forward: t0 === path[i] });
  }
  const decimals = await Promise.all(path.map((t) => readWords(chain, t, "decimals()").then((w) => Number(word(w[0])))));
  const meta = { at: Date.now(), wtrx, path, decimals, pairs };
  metaCache[chain] = meta;
  return meta;
}

/** 경로의 각 단계 준비금(원시 단위): [앞 토큰 쪽, 뒤 토큰 쪽] (USDT → TRX 방향) */
async function reservesRaw(chain: Chain, meta: Meta): Promise<[bigint, bigint][]> {
  return Promise.all(
    meta.pairs.map(async ({ pair, forward }) => {
      const r = await readWords(chain, pair, "getReserves()");
      const r0 = word(r[0]);
      const r1 = word(r[1]);
      return (forward ? [r0, r1] : [r1, r0]) as [bigint, bigint];
    }),
  );
}

/** 라우터와 같은 정수 연산으로 USDT(원시) → TRX(원시) */
function amountsOutRaw(amountIn: bigint, hops: [bigint, bigint][]): bigint {
  let a = amountIn;
  for (const [rin, rout] of hops) a = (a * 997n * rout) / (rin * 1000n + a * 997n);
  return a;
}

export async function fetchSwapMarket(chain: Chain = "mainnet", fallbackCosts?: SwapMarket["costs"]): Promise<SwapMarket> {
  const c = SUNSWAP[chain];
  const fetchedAt = new Date().toISOString();
  const meta = await loadMeta(chain);

  // 교차 검증: 1,000 USDT를 라우터 견적과 준비금 공식으로 각각 계산한다. 두 읽기가 다른 블록에 걸리면(그사이 거래) 조금 다를 수 있어
  // 동시에 다시 읽고, 세 번 모두 어긋나면 0.1% 이내일 때만 받아들인다.
  const probe = 1000n * 10n ** BigInt(meta.decimals[0]);
  let hops: [bigint, bigint][] = [];
  let diffNote = "일치";
  for (let i = 0; ; i++) {
    const [h, q] = await Promise.all([
      reservesRaw(chain, meta),
      readWords(chain, c.router, "getAmountsOut(uint256,address[])", [
        { type: "uint256", value: probe.toString() },
        { type: "address[]", value: meta.path },
      ]),
    ]);
    hops = h;
    const routerOut = word(q[q.length - 1]);
    const localOut = amountsOutRaw(probe, hops);
    if (routerOut === localOut) break;
    const rel = new Decimal((localOut - routerOut).toString()).abs().div(routerOut.toString());
    if (i >= 2) {
      if (rel.gt("0.001")) throw new Error(`SunSwap 준비금 계산(${localOut})이 라우터 견적(${routerOut})과 ${rel.mul(100).toDecimalPlaces(3).toFixed()}% 다릅니다. 교환을 쓰지 않습니다.`);
      diffNote = `읽기 블록 차이로 ${rel.mul(100).toDecimalPlaces(3).toFixed()}% 차이 (0.1% 이내)`;
      break;
    }
  }

  const cc = costCache[chain];
  let costs = cc && Date.now() - cc.at < 10 * 60 * 1000 ? cc.value : undefined;
  let costNote = "";
  if (!costs) {
    const m: Record<string, MeasuredCost | undefined> = await measureContractCosts(chain, c.router, SWAP_SELECTORS, 200).catch(() => ({}));
    if (m.toTrx && m.toUsdt) {
      costs = {
        toTrx: { energy: m.toTrx.energy, bandwidth: m.toTrx.bandwidth },
        toUsdt: { energy: m.toUsdt.energy, bandwidth: m.toUsdt.bandwidth },
        sampleSize: m.toTrx.sampleSize + m.toUsdt.sampleSize,
        median: { toTrx: m.toTrx.median.energy, toUsdt: m.toUsdt.median.energy },
      };
      costCache[chain] = { at: Date.now(), value: costs };
    } else if (fallbackCosts) {
      costs = fallbackCosts;
      costNote = " · 이 체인의 라우터 표본이 없어 교환 거래 비용은 Mainnet 실측값 사용";
    } else throw new Error("SunSwap 교환 거래 비용 표본을 찾지 못했습니다.");
  }
  if (!costNote) costNote = ` · 교환 거래 비용은 라우터 최근 성공 거래 ${costs.sampleSize}건 실측 최대값`;

  const human = (raw: bigint, dec: number) => new Decimal(raw.toString()).div(new Decimal(10).pow(dec)).toFixed();
  // 브리지 PSM 수수료·거래비용 (체인에서 읽음)
  let bridge: SwapMarket["bridge"];
  if (c.bridge) {
    const b = c.bridge;
    const [tin, tout, m] = await Promise.all([
      readWords(chain, b.psm, "tin()").then((w) => word(w[0])),
      readWords(chain, b.psm, "tout()").then((w) => word(w[0])),
      measureContractCosts(chain, b.psm, { sell: sel("sellGem(address,uint256)"), buy: sel("buyGem(address,uint256)") }, 100).catch(() => ({}) as Record<string, undefined>),
    ]);
    bridge = {
      psm: b.psm,
      gemJoin: b.gemJoin,
      token: c.usdt,
      symbol: b.symbol,
      feeIn: new Decimal(tin.toString()).div("1e18").toFixed(),
      feeOut: new Decimal(tout.toString()).div("1e18").toFixed(),
      energy: m.sell && m.buy ? { sell: m.sell.energy, buy: m.buy.energy } : undefined,
    };
  }
  const hopsHuman = hops.map(([a, b], i) => ({ reserveUsdtSide: human(a, meta.decimals[i]), reserveTrxSide: human(b, meta.decimals[i + 1]) }));
  return {
    router: c.router,
    pair: meta.pairs.map((p) => p.pair).join(" → "),
    path: meta.path,
    usdt: c.usdt,
    reserveUsdt: hopsHuman[0].reserveUsdtSide,
    reserveTrx: hopsHuman[hopsHuman.length - 1].reserveTrxSide,
    hops: hopsHuman.length > 1 ? hopsHuman : undefined,
    bridge,
    feeNumerator: 997,
    costs,
    source: {
      sourceUrl: `${c.explorer}${meta.pairs[0].pair}`,
      chain,
      fetchedAt,
      mode: "live",
      accessMethod: "direct",
      note: `SunSwap V2 ${bridge ? `${bridge.symbol}/WTRX 페어 + 브리지 PSM(${bridge.symbol}↔USDT, tin ${new Decimal(bridge.feeIn).mul(100).toFixed()}% · tout ${new Decimal(bridge.feeOut).mul(100).toFixed()}%)` : hopsHuman.length > 1 ? "2단계 경로" : "USDT/WTRX 페어"} getReserves (라우터 getAmountsOut과 교차 검증: ${diffNote})${costNote}`,
    },
  };
}

/** 서명용 견적: 라우터 getAmountsOut을 그대로 쓴다 (toTrx: USDT → TRX, toUsdt: TRX → USDT) */
export async function routerQuote(chain: Chain, direction: "toTrx" | "toUsdt", amountInRaw: bigint): Promise<{ path: string[]; out: bigint }> {
  const meta = await loadMeta(chain);
  const path = direction === "toTrx" ? meta.path : [...meta.path].reverse();
  const q = await readWords(chain, SUNSWAP[chain].router, "getAmountsOut(uint256,address[])", [
    { type: "uint256", value: amountInRaw.toString() },
    { type: "address[]", value: path },
  ]);
  return { path, out: word(q[q.length - 1]) };
}
