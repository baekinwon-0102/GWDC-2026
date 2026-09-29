import Decimal from "decimal.js";
import { JUSTLEND, jTokenDetail } from "./justlend";
import type { MarketInfo } from "../../shared/screening";

// 기회 탐색용 JustLend 전체 시장. 앱 백엔드의 시장 목록 + 시장별 상세(채굴 APY·30일 이력)를 합친다. 10분 캐시.

interface ApiMarket {
  collateralSymbol: string;
  jtokenAddress: string;
  depositedAPY?: string;
  underlyingIncrementApy?: string;
  mintPaused?: number;
  depositedUSD?: string;
}

let cache: { at: number; value: MarketInfo[] } | undefined;

export async function fetchMarketUniverse(): Promise<MarketInfo[]> {
  if (cache && Date.now() - cache.at < 10 * 60 * 1000) return cache.value;
  const r = await fetch(`${JUSTLEND.appApiUrl}/markets`, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`JustLend 시장 목록 HTTP ${r.status}`);
  const j = (await r.json()) as { code?: number; data?: { jtokenList?: ApiMarket[] } };
  const list = j.data?.jtokenList;
  if (j.code !== 0 || !Array.isArray(list)) throw new Error("JustLend 시장 목록 응답 스키마가 예상과 다릅니다.");
  const out: MarketInfo[] = [];
  // 예치 가능한 시장만 상세(채굴 APY)를 읽는다. 동시에 4개씩.
  const active = list.filter((m) => m.mintPaused !== 1);
  const details = new Map<string, Awaited<ReturnType<typeof jTokenDetail>>>();
  for (let i = 0; i < active.length; i += 4) {
    const batch = active.slice(i, i + 4);
    const res = await Promise.all(batch.map((m) => jTokenDetail(m.jtokenAddress)));
    batch.forEach((m, k) => details.set(m.jtokenAddress, res[k]));
  }
  const fetchedAt = new Date().toISOString();
  for (const m of list) {
    const d = details.get(m.jtokenAddress);
    const last = d?.depositDetail?.[d.depositDetail.length - 1];
    const usd = new Decimal(d?.farmRewardUSD24h ?? 0);
    const tvl = new Decimal(d?.depositedUSD ?? m.depositedUSD ?? 0);
    out.push({
      symbol: m.collateralSymbol,
      jToken: m.jtokenAddress,
      baseApy: new Decimal(m.depositedAPY ?? 0).toFixed(),
      underlyingApy: new Decimal(m.underlyingIncrementApy ?? 0).toFixed(),
      miningApy: usd.gt(0) && tvl.gt(0) ? usd.mul(365).div(tvl).toFixed() : last?.farmApy ? new Decimal(last.farmApy).toFixed() : "0",
      paused: m.mintPaused === 1,
      depositedUsd: new Decimal(m.depositedUSD ?? 0).toFixed(),
      history: d?.depositDetail?.map((h) => ({ date: h.date, baseApy: h.depositedAPY ?? "0", farmApy: h.farmApy ?? "0", underlyingApy: h.underlyingIncrementApy ?? "0" })),
      fetchedAt,
    });
  }
  cache = { at: Date.now(), value: out };
  return out;
}
