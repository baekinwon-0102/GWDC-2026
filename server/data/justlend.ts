import Decimal from "decimal.js";
import { TronWeb } from "tronweb";
import { measureContractCosts, readUint, readWords, type MeasuredCost } from "./tron-rpc";
import { fromBaseUnits } from "../../shared/units";
import type { CostBasis, ProductQuote } from "../../shared/schemas";
import { activeCampaign } from "./campaigns";

// JustLend 시장 데이터.
// Mainnet: 공식 OpenAPI(GET /lend/jtoken) + Comptroller 온체인 읽기로 활성 여부 확인.
// Nile: 공식 API가 Nile을 색인하지 않으므로 jTRX 계약을 직접 읽는다.

export const JUSTLEND = {
  apiUrl: "https://openapi.just.network/lend/jtoken",
  /** JustLend 앱 백엔드. 공식 JustLend MCP(github.com/justlend/mcp-server-justlend)가 채굴 보상 조회에 쓰는 호스트 */
  appApiUrl: "https://labc.ablesdxd.link/justlend",
  /** 보상 청구(multiClaim) 일반 자원. 출처: 공식 JustLend MCP lending.ts TYPICAL_RESOURCES.claim_rewards */
  claimResources: { energy: 60000, bandwidth: 330 },
  docsUrl: "https://docs.justlend.org/developers/deployed_contracts/",
  mainnet: {
    comptroller: "TGjYzgCyPobsNS9n6WcbdLVR9dH7mWqFx7",
    jUSDT: "TXJgMdjVX5dKiQaUi9QobwNxtSQaFqccvd",
    jUSDD: "TKFRELGGoRgiayhwJTNNLqCNjFoLBh3Mnf",
    // 출처: JustLend 공식 OpenAPI(symbol jTRX)와 공식 JustLend MCP src/core/chains.ts가 같은 주소
    jTRX: "TE2RzoSV3wFK99w6J9UnnZ4vLfXYoxvRwP",
    USDT: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    USDD: "TXDk8mbtRbXeYuMNS83CfKPaYYT8XWv9Hz",
  },
  nile: {
    comptroller: "TJUCStq3WqfKqZLuZje5v7z6Ua6iBry1P6",
    // 출처: 공식 JustLend MCP 서버 src/core/chains.ts (Nile 섹션). 온체인 getcontract로 코드 존재를 확인한다.
    jTRX: "TKM7w4qFmkXQLEF2MgrQroBYpd5TY7i1pq",
    /** 기초자산 USDD 2.0 TZ78R2E6ejfFhxq8hxrmuqT6hGBxjHQbo4 (18자리) */
    jUSDD: "TBqtwZhjP49heKsoTHeX5MhKBJMmyuP88b",
    usdd: "TZ78R2E6ejfFhxq8hxrmuqT6hGBxjHQbo4",
  },
  /** JustLend 계약의 연간 블록 수 (3초 블록) */
  blocksPerYear: 10_512_000,
} as const;

interface ApiToken {
  address: string;
  symbol: string;
  underlyingSymbol: string;
  underlyingAddress: string;
  underlyingPriceInTrx: string;
  underlyingDecimal: number;
  supplyRate: string;
  cash: string;
  exchangeRate: string;
}

export interface JTokenDetail {
  farmRewardUSD24h?: number | string;
  /** 최근 30일 일별 이력 (기본 APY, 채굴 APY, 예치 총액) */
  depositDetail?: { date: string; depositedAPY?: string; farmApy?: string; underlyingIncrementApy?: string; depositedUSD?: string }[];
  priceUSD?: number | string;
  farmRewardUsddAmount24h?: number | string;
  farmRewardTrxAmount24h?: number | string;
  depositedUSD?: string;
}

const detailCache = new Map<string, { at: number; value: JTokenDetail }>();

/** 시장 상세(최근 24시간 채굴 보상, 30일 일별 이력). 60초 캐시. 실패하면 undefined (보상은 미확인으로 둔다) */
export async function jTokenDetail(address: string): Promise<JTokenDetail | undefined> {
  const hit = detailCache.get(address);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  const v = await jTokenDetailRaw(address);
  if (v) detailCache.set(address, { at: Date.now(), value: v });
  return v;
}

async function jTokenDetailRaw(address: string): Promise<JTokenDetail | undefined> {
  try {
    const r = await fetch(`${JUSTLEND.appApiUrl}/markets/jtokenDetails?jtokenAddr=${address}`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return undefined;
    const j = (await r.json()) as { code?: number; data?: JTokenDetail };
    return j.code === 0 && j.data ? j.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 채굴 보상 추정. 규칙 중 캠페인 종료 시점은 공개 API로 확인할 수 없어 항상 unverified로 두고 순수익에서 뺀다.
 * APR = 최근 24시간 보상 가치(USD) × 365 ÷ 시장 예치 총액(USD)
 */
/**
 * 채굴 보상. 추정 APR = 최근 24시간 보상 가치(USD) × 365 ÷ 시장 예치 총액(USD).
 * verified 조건: (1) 등록된 캠페인 공지 기간 안 (2) 최근 24시간 보상이 실제로 지급 중 (3) 최근 일별 이력의 채굴 APY가 끊기지 않음.
 * 하나라도 어긋나면 unverified로 두고 사유를 남긴다 (순수익에서 제외).
 */
export function rewardsFromDetail(d: JTokenDetail | undefined, fetchedAt: string, address: string, market?: string, now = new Date()): ProductQuote["rewards"] {
  const source = {
    sourceUrl: `${JUSTLEND.appApiUrl}/markets/jtokenDetails?jtokenAddr=${address}`,
    chain: "mainnet" as const,
    fetchedAt,
    mode: "live" as const,
    accessMethod: "direct" as const,
    note: "JustLend 앱 백엔드 farmReward*24h / depositedUSD (공식 JustLend MCP와 같은 계산)",
  };
  if (!d) return { status: "unverified", note: "채굴 보상 데이터를 조회하지 못해 미확인으로 두고 수익에서 제외합니다." };
  const usd = new Decimal(d.farmRewardUSD24h ?? 0);
  const tvl = new Decimal(d.depositedUSD ?? 0);
  const campaign = market ? activeCampaign(market, now) : undefined;
  if (usd.lte(0))
    return { status: "none", note: campaign ? `공지된 ${campaign.name} 기간이지만 최근 24시간 보상이 0이라 보상을 넣지 않습니다.` : "최근 24시간 채굴 보상이 없습니다 (0).", source };
  const usdd = new Decimal(d.farmRewardUsddAmount24h ?? 0);
  const trx = new Decimal(d.farmRewardTrxAmount24h ?? 0);
  const token = [usdd.gt(0) ? "USDD" : "", trx.gt(0) ? "TRX" : ""].filter(Boolean).join("+") || "USD 환산";
  const dailyAmount = usdd.gt(0) && trx.lte(0) ? usdd.toFixed() : usd.toFixed();
  const apr = tvl.gt(0) ? usd.mul(365).div(tvl) : undefined;
  const daily = `최근 24시간 채굴 보상 ${usdd.gt(0) ? `${usdd.toFixed(0)} USDD` : ""}${trx.gt(0) ? ` ${trx.toFixed(0)} TRX` : ""}(약 $${usd.toFixed(0)})`;
  const hist = d.depositDetail ?? [];
  const paidDays = hist.filter((h) => new Decimal(h.farmApy ?? 0).gt(0)).length;
  const continuous = hist.length > 0 && paidDays === hist.length;
  const base = { apr: apr?.toFixed(), token, dailyAmount, source };
  if (!campaign)
    return { ...base, status: "unverified", note: `${daily}를 예치 총액으로 나눈 추정치입니다. 이 시장의 캠페인 기간·규칙을 확인한 공지가 등록되어 있지 않아 순수익에서 뺍니다.` };
  if (!continuous)
    return { ...base, status: "unverified", note: `${campaign.name} 공지는 있으나 최근 ${hist.length}일 이력 중 ${paidDays}일만 보상이 지급되어 규칙대로 지급되는지 확인하지 못했습니다. 순수익에서 뺍니다.` };
  return {
    ...base,
    status: "verified",
    note: `${campaign.name}: 공지 기간·대상·지급 규칙과 실제 지급 데이터를 모두 확인했습니다. ${daily} 기준 연 ${apr ? apr.mul(100).toDecimalPlaces(2).toFixed() : "-"}%.`,
    campaign: {
      name: campaign.name,
      start: campaign.start,
      end: campaign.end,
      rewardToken: campaign.rewardToken,
      distribution: campaign.distribution,
      eligibility: campaign.eligibility,
      sources: campaign.sources,
      checks: [
        `공지 기간 ${campaign.start.slice(0, 16).replace("T", " ")} ~ ${campaign.end.slice(0, 16).replace("T", " ")} (UTC+8) 안`,
        `JustLend 백엔드: ${daily} 지급 중 (공지 APY ${campaign.announcedApy}, 실데이터 연 ${apr ? apr.mul(100).toDecimalPlaces(2).toFixed() : "-"}%)`,
        `최근 ${hist.length}일 일별 이력에서 ${paidDays}일 모두 채굴 APY > 0`,
        `대상: ${campaign.eligibility}`,
        `공지 확인·등록일 ${campaign.registeredAt}${campaign.note ? ` — ${campaign.note}` : ""}`,
      ],
    },
  };
}

/** 예치 중지 여부. 한 번 실패하면 시장 전체가 비활성으로 처리되므로 일시 오류에 대비해 한 번 더 읽는다 */
async function mintPaused(chain: "mainnet" | "nile", comptroller: string, jToken: string): Promise<boolean | undefined> {
  for (let i = 0; i < 2; i++) {
    try {
      return (await readUint(chain, comptroller, "mintGuardianPaused(address)", [{ type: "address", value: jToken }])) !== 0n;
    } catch {
      if (i === 0) await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return undefined;
}

export async function fetchMainnetMarkets(): Promise<{ jusdt: ProductQuote; jusdd: ProductQuote; jtrx: ProductQuote; trxPerUsdt?: string; fetchedAt: string }> {
  const fetchedAt = new Date().toISOString();
  const r = await fetch(JUSTLEND.apiUrl, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`JustLend API HTTP ${r.status}`);
  const body = (await r.json()) as { code: number; data?: { tokenList?: ApiToken[] } };
  if (body.code !== 0 || !Array.isArray(body.data?.tokenList)) throw new Error("JustLend API 응답 스키마가 예상과 다릅니다.");
  const list = body.data!.tokenList!;

  const [pausedUsdt, pausedUsdd, detailUsdt, detailUsdd, pausedTrx, detailTrx] = await Promise.all([
    mintPaused("mainnet", JUSTLEND.mainnet.comptroller, JUSTLEND.mainnet.jUSDT),
    mintPaused("mainnet", JUSTLEND.mainnet.comptroller, JUSTLEND.mainnet.jUSDD),
    jTokenDetail(JUSTLEND.mainnet.jUSDT),
    jTokenDetail(JUSTLEND.mainnet.jUSDD),
    mintPaused("mainnet", JUSTLEND.mainnet.comptroller, JUSTLEND.mainnet.jTRX),
    jTokenDetail(JUSTLEND.mainnet.jTRX),
  ]);
  const detailOf = (symbol: "jUSDT" | "jUSDD" | "jTRX") => (symbol === "jUSDT" ? detailUsdt : symbol === "jUSDD" ? detailUsdd : detailTrx);

  const build = (symbol: "jUSDT" | "jUSDD" | "jTRX", paused: boolean | undefined): ProductQuote => {
    const expected = JUSTLEND.mainnet[symbol];
    const t = list.find((x) => x.symbol === symbol);
    const source = {
      sourceUrl: JUSTLEND.apiUrl,
      chain: "mainnet" as const,
      fetchedAt,
      mode: "live" as const,
      accessMethod: "direct" as const,
      note: "JustLend 공식 OpenAPI + Comptroller.mintGuardianPaused 온체인 읽기",
    };
    if (!t) return { id: `mainnet:${symbol}`, kind: "lending", market: symbol, token: symbol.slice(1), address: expected, chain: "mainnet", active: false, inactiveReason: "API 목록에 시장이 없습니다", rewards: { status: "unverified", note: "-" }, source };
    const addressOk = t.address === expected;
    const inactiveReason = !addressOk
      ? `API 주소(${t.address})가 공식 배포 주소(${expected})와 다릅니다`
      : paused === true
        ? "예치(mint)가 일시 중지 상태입니다"
        : paused === undefined
          ? "Comptroller에서 예치 중지 여부를 확인하지 못했습니다"
          : undefined;
    return {
      id: `mainnet:${symbol}`,
      kind: "lending",
      market: symbol,
      token: t.underlyingSymbol,
      address: t.address,
      chain: "mainnet",
      baseRate: new Decimal(t.supplyRate).toFixed(),
      rateType: "APY",
      underlyingDecimals: t.underlyingDecimal,
      liquidity: new Decimal(t.cash).toFixed(),
      underlyingPriceUsd: (() => { const d = detailOf(symbol); return d?.priceUSD ? new Decimal(d.priceUSD).toFixed() : undefined; })(),
      active: !inactiveReason,
      inactiveReason,
      rewards: rewardsFromDetail(detailOf(symbol), fetchedAt, expected, symbol),
      source,
    };
  };

  const usdt = list.find((x) => x.symbol === "jUSDT");
  // underlyingPriceInTrx(USDT) = 1 USDT가 몇 TRX인지. TRX 수수료를 USDT로 환산하는 근거로 쓴다.
  const trxPerUsdt = usdt?.underlyingPriceInTrx ? new Decimal(usdt.underlyingPriceInTrx).toFixed() : undefined;
  return { jusdt: build("jUSDT", pausedUsdt), jusdd: build("jUSDD", pausedUsdd), jtrx: build("jTRX", pausedTrx), trxPerUsdt, fetchedAt };
}

export interface CatalogItem {
  symbol: string;
  underlying: string;
  address: string;
  supplyRate: string;
  liquidity: string;
}

let catalogCache: { at: number; items: CatalogItem[]; fetchedAt: string } | undefined;

/** 에이전트 상품 탐색용: JustLend Mainnet 전체 시장 목록 (공식 OpenAPI). 60초 캐시 */
export async function fetchJustLendCatalog(): Promise<{ items: CatalogItem[]; fetchedAt: string }> {
  if (catalogCache && Date.now() - catalogCache.at < 60_000) return catalogCache;
  const r = await fetch(JUSTLEND.apiUrl, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`JustLend API HTTP ${r.status}`);
  const body = (await r.json()) as { code: number; data?: { tokenList?: ApiToken[] } };
  if (body.code !== 0 || !Array.isArray(body.data?.tokenList)) throw new Error("JustLend API 응답 스키마가 예상과 다릅니다.");
  const items = body.data!.tokenList!
    .filter((t) => typeof t.symbol === "string" && t.supplyRate !== undefined)
    .map((t) => ({ symbol: t.symbol, underlying: t.underlyingSymbol, address: t.address, supplyRate: new Decimal(t.supplyRate).toFixed(), liquidity: new Decimal(t.cash ?? 0).toFixed() }));
  catalogCache = { at: Date.now(), items, fetchedAt: new Date().toISOString() };
  return catalogCache;
}

/** jToken 금리 모델 계약의 blocksPerYear(). 금리 계산에 계약이 실제로 쓰는 값이다 (1일 캐시) */
const bpyCache = new Map<string, { at: number; value: bigint }>();
async function blocksPerYear(chain: "mainnet" | "nile", jToken: string): Promise<bigint> {
  const key = `${chain}:${jToken}`;
  const hit = bpyCache.get(key);
  if (hit && Date.now() - hit.at < 86_400_000) return hit.value;
  try {
    const words = await readWords(chain, jToken, "interestRateModel()");
    const model = TronWeb.address.fromHex("41" + words[0].slice(24));
    const value = await readUint(chain, model, "blocksPerYear()");
    if (value <= 0n) throw new Error("0");
    bpyCache.set(key, { at: Date.now(), value });
    return value;
  } catch {
    return BigInt(JUSTLEND.blocksPerYear); // 모델을 읽지 못하면 3초 블록 기준값
  }
}

/** Nile jUSDD (기초자산 USDD 2.0). 계획 B(USDD 경로)를 Nile에서 실행할 때 쓴다 */
export async function fetchNileJusdd(): Promise<ProductQuote> {
  const fetchedAt = new Date().toISOString();
  const a = JUSTLEND.nile.jUSDD;
  const [ratePerBlock, cashRaw, paused, bpy] = await Promise.all([
    readUint("nile", a, "supplyRatePerBlock()"),
    readUint("nile", a, "getCash()"),
    mintPaused("nile", JUSTLEND.nile.comptroller, a),
    blocksPerYear("nile", a),
  ]);
  const apr = new Decimal(ratePerBlock.toString()).mul(bpy.toString()).div("1e18");
  return {
    id: "nile:jUSDD",
    kind: "lending",
    market: "jUSDD",
    token: "USDD",
    address: a,
    chain: "nile",
    baseRate: apr.toFixed(),
    rateType: "APR",
    underlyingDecimals: 18,
    liquidity: fromBaseUnits(cashRaw, 18),
    active: paused === false,
    inactiveReason: paused === true ? "예치(mint)가 일시 중지 상태입니다" : paused === undefined ? "예치 중지 여부를 확인하지 못했습니다" : undefined,
    rewards: { status: "none", note: "Nile 보상은 계산하지 않습니다." },
    source: {
      sourceUrl: `https://nile.tronscan.org/#/contract/${a}`,
      chain: "nile",
      fetchedAt,
      mode: "live",
      accessMethod: "direct",
      note: `jUSDD.supplyRatePerBlock × 금리 모델 blocksPerYear(${bpy}) + getCash + Comptroller.mintGuardianPaused 온체인 읽기 (주소: 공식 JustLend MCP chains.ts Nile)`,
    },
  };
}

export async function fetchNileJtrx(): Promise<ProductQuote> {
  const fetchedAt = new Date().toISOString();
  const a = JUSTLEND.nile.jTRX;
  const [ratePerBlock, cashSun, paused, bpy] = await Promise.all([
    readUint("nile", a, "supplyRatePerBlock()"),
    readUint("nile", a, "getCash()"),
    mintPaused("nile", JUSTLEND.nile.comptroller, a),
    blocksPerYear("nile", a),
  ]);
  const apr = new Decimal(ratePerBlock.toString()).mul(bpy.toString()).div("1e18");
  return {
    id: "nile:jTRX",
    kind: "lending",
    market: "jTRX",
    token: "TRX",
    address: a,
    chain: "nile",
    baseRate: apr.toFixed(),
    rateType: "APR",
    underlyingDecimals: 6,
    liquidity: fromBaseUnits(cashSun, 6),
    active: paused === false,
    inactiveReason: paused === true ? "예치(mint)가 일시 중지 상태입니다" : paused === undefined ? "예치 중지 여부를 확인하지 못했습니다" : undefined,
    rewards: { status: "none", note: "Nile 보상은 계산하지 않습니다." },
    source: {
      sourceUrl: `https://nile.tronscan.org/#/contract/${a}`,
      chain: "nile",
      fetchedAt,
      mode: "live",
      accessMethod: "direct",
      note: `jTRX.supplyRatePerBlock × 금리 모델 blocksPerYear(${bpy}) + getCash + Comptroller.mintGuardianPaused 온체인 읽기`,
    },
  };
}

const JTOKEN_SELECTORS = { mint: "1249c58b", mintTrc20: "a0712d68", redeem: "db006a75", redeemUnderlying: "852a12e3" } as const;

/**
 * Nile jTRX 최근 성공 거래 100건의 메서드별 실측 최대 Energy·대역폭. 일반값보다 인출 비용이 커서 실측을 쓴다.
 * mint·redeem 표본이 없으면 undefined (호출자가 일반값을 쓴다). redeemUnderlying 표본이 없으면 redeem 값을 쓴다.
 */
export async function nileJtrxEnergy(): Promise<NonNullable<CostBasis["jtrxEnergy"]> | undefined> {
  const m = await measureContractCosts("nile", JUSTLEND.nile.jTRX, { mint: JTOKEN_SELECTORS.mint, redeem: JTOKEN_SELECTORS.redeem, redeemUnderlying: JTOKEN_SELECTORS.redeemUnderlying });
  if (!m.mint || !m.redeem) return undefined;
  const ru = m.redeemUnderlying ?? m.redeem;
  return {
    mint: m.mint.energy,
    redeem: m.redeem.energy,
    redeemUnderlying: ru.energy,
    sampleSize: m.mint.sampleSize + m.redeem.sampleSize + (m.redeemUnderlying?.sampleSize ?? 0),
    bandwidth: { mint: m.mint.bandwidth, redeem: m.redeem.bandwidth, redeemUnderlying: ru.bandwidth },
  };
}

/** Mainnet jUSDT·jUSDD 예치(mint(uint256))·인출(redeem/redeemUnderlying 중 큰 값) 실측 최대 비용 */
export async function mainnetJTokenCosts(): Promise<NonNullable<CostBasis["jTokenCosts"]>> {
  const out: NonNullable<CostBasis["jTokenCosts"]> = {};
  await Promise.all(
    (["jUSDT", "jUSDD", "jTRX"] as const).map(async (sym) => {
      // jTRX는 TRX를 callValue로 보내는 mint(), TRC20 시장은 mint(uint256)
      const mint = sym === "jTRX" ? JTOKEN_SELECTORS.mint : JTOKEN_SELECTORS.mintTrc20;
      const m = await measureContractCosts("mainnet", JUSTLEND.mainnet[sym], { mint, redeem: JTOKEN_SELECTORS.redeem, redeemUnderlying: JTOKEN_SELECTORS.redeemUnderlying });
      const w = [m.redeem, m.redeemUnderlying].filter(Boolean) as MeasuredCost[];
      if (!m.mint || !w.length) return;
      out[sym] = {
        supply: { energy: m.mint.energy, bandwidth: m.mint.bandwidth },
        withdraw: { energy: Math.max(...w.map((x) => x.energy)), bandwidth: Math.max(...w.map((x) => x.bandwidth)) },
        sampleSize: m.mint.sampleSize + w.reduce((s, x) => s + x.sampleSize, 0),
      };
    }),
  );
  return out;
}

/** 지갑의 jTRX 포지션: jToken 잔고 × exchangeRateStored → 기초자산 TRX */
export async function nileJtrxPosition(wallet: string) {
  const a = JUSTLEND.nile.jTRX;
  const [bal, rate] = await Promise.all([
    readUint("nile", a, "balanceOf(address)", [{ type: "address", value: wallet }]),
    readUint("nile", a, "exchangeRateStored()"),
  ]);
  // underlying(sun) = jToken(1e8 단위) × rate / 1e18
  const underlyingSun = (bal * rate) / 10n ** 18n;
  return { jTokenRaw: bal, jToken: fromBaseUnits(bal, 8), exchangeRateRaw: rate, underlyingSun, underlyingTrx: fromBaseUnits(underlyingSun, 6) };
}

