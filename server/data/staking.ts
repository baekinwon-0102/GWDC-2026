import Decimal from "decimal.js";
import { TronWeb } from "tronweb";
import { chainFees, getJson, HOSTS, post } from "./tron-rpc";
import type { Chain, ProductQuote } from "../../shared/schemas";

// TRX 스테이킹(Stake 2.0) + SR 투표 보상. 모두 TronGrid 체인 조회로 계산한다.
// 투표자 APR(SR i) = (블록 생산 보상 몫 + 투표 보상 몫) × (1 − brokerage) ÷ SR i의 득표수
//   블록 생산 보상 몫 = getWitnessPayPerBlock × 연간 블록 수 ÷ 27   (상위 27개 SR이 돌아가며 생산)
//   투표 보상 몫     = getWitness127PayPerBlock × 연간 블록 수 × (SR 득표 ÷ 상위 127개 총 득표)
// 1 TRX를 스테이킹하면 1표. 스테이킹 자체는 이자가 없고 투표해야 보상이 생긴다.

const BLOCKS_PER_YEAR = 10_512_000; // 3초 블록
const PRODUCERS = 27;
const CACHE_MS = 10 * 60 * 1000;
const cache: Partial<Record<Chain, { at: number; quote: ProductQuote }>> = {};

const SYSTEM_TYPES = {
  FreezeBalanceV2Contract: "stake",
  VoteWitnessContract: "vote",
  WithdrawBalanceContract: "claim",
  UnfreezeBalanceV2Contract: "unstake",
  WithdrawExpireUnfreezeContract: "withdrawExpire",
} as const;
type SysKey = (typeof SYSTEM_TYPES)[keyof typeof SYSTEM_TYPES];
let bwCache: { at: number; value: NonNullable<NonNullable<ProductQuote["staking"]>["txBandwidth"]> } | undefined;
let bwFailedAt: number | undefined;
let bwInFlight: Promise<NonNullable<typeof bwCache>["value"]> | undefined;
let bwAttempts = 0;

/**
 * 스테이킹 관련 시스템 거래의 실제 대역폭(bytes) 측정 (1일 캐시).
 * 최근 블록에서 찾은 해당 거래의 영수증과, 그 거래를 보낸 계정들의 최근 이력 영수증(net_usage 또는 net_fee ÷ 대역폭 단가)에서 유형별 최대값을 잰다.
 * 투표는 SR 1곳에 투표한 거래만 센다. 표본이 없는 유형은 측정된 스테이킹 거래 중 최대값으로 채우고 measured에서 뺀다.
 */
export async function measureStakingTxBandwidth() {
  if (bwCache && Date.now() - bwCache.at < 86_400_000) return bwCache.value;
  if (bwInFlight) return bwInFlight;
  // 최근 실패했으면 요청 때마다 다시 훑지 않는다 (백그라운드 재시도가 따로 돈다)
  if (bwFailedAt && Date.now() - bwFailedAt < 10 * 60 * 1000) throw new Error("최근 측정 실패 (백그라운드 재시도 중)");
  return runMeasure();
}

/** 블록 일괄 조회는 TronGrid 요청 제한이 특히 빡빡하다. 실패하면 30·60·90·120초 뒤 백그라운드로 다시 잰다 */
function runMeasure(): Promise<NonNullable<typeof bwCache>["value"]> {
  bwInFlight = measureOnce()
    .then((v) => {
      bwAttempts = 0;
      bwFailedAt = undefined;
      return v;
    })
    .catch((e) => {
      bwFailedAt = Date.now();
      if (bwAttempts < 4) {
        bwAttempts++;
        setTimeout(() => runMeasure().catch(() => undefined), 30_000 * bwAttempts).unref?.();
      }
      throw e;
    })
    .finally(() => {
      bwInFlight = undefined;
    });
  return bwInFlight;
}

async function measureOnce() {
  const [latest, fees] = await Promise.all([post<{ block?: any[] }>("mainnet", "/wallet/getblockbylatestnum", { num: 8 }), chainFees("mainnet")]);
  const owners = new Map<string, Set<SysKey>>();
  const found: { txID: string; key: SysKey }[] = [];
  const collect = (blocks: any[]) => {
    for (const b of blocks)
      for (const t of b.transactions ?? []) {
        const c = t.raw_data?.contract?.[0];
        const key = SYSTEM_TYPES[c?.type as keyof typeof SYSTEM_TYPES];
        if (!key || !c.parameter?.value?.owner_address) continue;
        const o = TronWeb.address.fromHex(c.parameter.value.owner_address);
        owners.set(o, (owners.get(o) ?? new Set()).add(key));
        if (key !== "vote" || c.parameter.value.votes?.length === 1) found.push({ txID: t.txID, key });
      }
  };
  collect(latest.block ?? []);
  // 표본 계정이 3곳 미만이면 그 이전 8블록씩 최대 두 구간을 더 훑는다
  const top = Math.min(...(latest.block ?? []).map((b) => Number(b.block_header?.raw_data?.number ?? Infinity)));
  for (let k = 0; k < 2 && owners.size < 3 && Number.isFinite(top); k++) {
    const end = top - k * 8;
    const more = await post<{ block?: any[] }>("mainnet", "/wallet/getblockbylimitnext", { startNum: end - 8, endNum: end }).catch(() => ({ block: [] }));
    collect(more.block ?? []);
  }
  // 드문 유형(해제·해제분 인출)을 보낸 계정부터 최대 6곳의 이력을 본다
  const rare = (s: Set<SysKey>) => (s.has("unstake") || s.has("withdrawExpire") ? 0 : s.has("stake") ? 1 : 2);
  const picked = [...owners.entries()].sort((a, b) => rare(a[1]) - rare(b[1])).slice(0, 6).map(([o]) => o);
  const max: Partial<Record<SysKey, number>> = {};
  let n = 0;
  const add = (key: SysKey, netUsage: unknown, netFee: unknown) => {
    const bytes = Number(netUsage ?? 0) || Math.round(Number(netFee ?? 0) / fees.bandwidthFeeSun);
    if (!bytes) return;
    max[key] = Math.max(max[key] ?? 0, bytes);
    n++;
  };
  // 1) 블록에서 찾은 거래 자체의 영수증 (유형별 최대 4건)
  const perType = new Map<SysKey, number>();
  const picks = found.filter((f) => {
    const c = perType.get(f.key) ?? 0;
    perType.set(f.key, c + 1);
    return c < 4;
  });
  const infos = await Promise.all(picks.map((f) => post<any>("mainnet", "/wallet/gettransactioninfobyid", { value: f.txID }).catch(() => undefined)));
  infos.forEach((info, i) => info?.receipt && add(picks[i].key, info.receipt.net_usage, info.receipt.net_fee));
  // 2) 보조: 그 계정들의 최근 이력 (블록에 없던 유형을 보충)
  // 요청 제한은 tron-rpc 공용 계층(동시 요청 제한 + 429 재시도)이 처리한다
  const histories = await Promise.all(
    picked.map((o) => getJson<{ data?: any[] }>("mainnet", `/v1/accounts/${o}/transactions?only_from=true&only_confirmed=true&limit=200`).catch(() => ({ data: [] as any[] }))),
  );
  for (const h of histories)
    for (const t of h.data ?? []) {
      const c = t.raw_data?.contract?.[0];
      const key = SYSTEM_TYPES[c?.type as keyof typeof SYSTEM_TYPES];
      if (!key || t.ret?.[0]?.contractRet === "FAILED") continue;
      if (key === "vote" && c.parameter?.value?.votes?.length !== 1) continue;
      add(key, t.net_usage, t.net_fee);
    }
  const measured = (Object.keys(max) as SysKey[]).filter((k) => max[k]);
  if (!measured.length) throw new Error("스테이킹 거래 표본을 찾지 못했습니다.");
  const fill = Math.max(...measured.map((k) => max[k]!));
  const v = (k: SysKey) => max[k] ?? fill;
  const value = { stake: v("stake"), vote: v("vote"), claim: v("claim"), unstake: v("unstake"), withdrawExpire: v("withdrawExpire"), measured, sampleSize: n };
  bwCache = { at: Date.now(), value };
  return value;
}

/** SR 수수료는 자주 바뀌지 않아 1시간 캐시한다 (상위 27개 조회가 요청 제한에 걸리지 않게) */
const brokerageCache = new Map<string, { at: number; value: number }>();
async function brokerageOf(chain: Chain, address: string): Promise<number | undefined> {
  const key = `${chain}:${address}`;
  const hit = brokerageCache.get(key);
  if (hit && Date.now() - hit.at < 3_600_000) return hit.value;
  const v = await post<{ brokerage?: number }>(chain, "/wallet/getBrokerage", { address })
    .then((r) => r.brokerage)
    .catch(() => undefined);
  if (v !== undefined) brokerageCache.set(key, { at: Date.now(), value: v });
  return v;
}

/**
 * 거래 대역폭 실측은 무거워서 계획 계산을 기다리게 하지 않는다. 캐시가 있으면 붙이고, 없으면 백그라운드 측정을 시작한다
 * (그동안은 planning.ts의 추정값을 쓰고 화면에 "추정"으로 표시한다).
 */
function withBandwidth(q: ProductQuote): ProductQuote {
  if (!q.staking) return q;
  if (!bwCache) measureStakingTxBandwidth().catch(() => undefined);
  return { ...q, staking: { ...q.staking, txBandwidth: bwCache?.value } };
}

/**
 * 체인별 스테이킹 견적. Nile도 같은 계산식을 쓰되 Nile 체인 파라미터(해제 대기 1일, 유지보수 30분 등)와 Nile SR 목록을 읽는다.
 * 거래 대역폭(bytes)은 거래 구조가 체인과 무관하므로 Mainnet 실측값을 함께 쓴다.
 */
export async function fetchStaking(chain: Chain = "mainnet"): Promise<ProductQuote> {
  const hit = cache[chain];
  if (hit && Date.now() - hit.at < CACHE_MS) return withBandwidth(hit.quote);
  const fetchedAt = new Date().toISOString();
  const [params, list] = await Promise.all([
    post<{ chainParameter: { key: string; value?: number }[] }>(chain, "/wallet/getchainparameters", {}),
    post<{ witnesses: { address: string; voteCount?: number; url?: string; isJobs?: boolean }[] }>(chain, "/wallet/listwitnesses", {}),
  ]);
  const p = (k: string) => params.chainParameter.find((x) => x.key === k)?.value;
  const blockPay = p("getWitnessPayPerBlock");
  const votePay = p("getWitness127PayPerBlock");
  const unfreezeDelayDays = p("getUnfreezeDelayDays");
  const maintenanceMs = p("getMaintenanceTimeInterval");
  if (!blockPay || !votePay || !unfreezeDelayDays) throw new Error("스테이킹 보상 체인 파라미터를 찾지 못했습니다.");

  const sorted = [...list.witnesses].filter((w) => (w.voteCount ?? 0) > 0).sort((a, b) => (b.voteCount ?? 0) - (a.voteCount ?? 0));
  const top127 = sorted.slice(0, 127);
  const totalVotes = top127.reduce((s, w) => s.plus(w.voteCount ?? 0), new Decimal(0));
  const producers = sorted.slice(0, PRODUCERS);
  const brokerages = await Promise.all(producers.map((w) => brokerageOf(chain, w.address)));

  const blockShare = new Decimal(blockPay).div(1e6).mul(BLOCKS_PER_YEAR).div(PRODUCERS);
  const voteTotal = new Decimal(votePay).div(1e6).mul(BLOCKS_PER_YEAR);
  let best: { w: (typeof producers)[number]; apr: Decimal; brokerage: number } | undefined;
  producers.forEach((w, i) => {
    const b = brokerages[i];
    if (b === undefined) return; // 수수료를 확인하지 못한 SR은 후보에서 뺀다
    const votes = new Decimal(w.voteCount!);
    const annual = blockShare.plus(voteTotal.mul(votes).div(totalVotes));
    const apr = annual.mul(new Decimal(1).minus(new Decimal(b).div(100))).div(votes);
    if (!best || apr.gt(best.apr)) best = { w, apr, brokerage: b };
  });
  if (!best) throw new Error("상위 SR의 수수료(brokerage)를 조회하지 못했습니다.");

  const address = TronWeb.address.fromHex(best.w.address);
  const quote: ProductQuote = {
    id: `${chain}:TRX-STAKE-VOTE`,
    kind: "staking",
    market: "TRX 스테이킹 + SR 투표",
    token: "TRX",
    address,
    chain,
    baseRate: best.apr.toFixed(),
    rateType: "APR",
    active: true,
    rewards: { status: "none", note: "투표 보상은 프로토콜 보상이라 기본 수익에 포함했습니다. 별도 인센티브는 없습니다." },
    staking: {
      srAddress: address,
      srName: (best.w.url ?? address).replace(/^https?:\/\//, "").replace(/\/$/, ""),
      brokerage: new Decimal(best.brokerage).div(100).toFixed(),
      srVotes: String(best.w.voteCount),
      totalVotes: totalVotes.toFixed(),
      unfreezeDelayDays,
      voteRewardPerBlockTrx: new Decimal(votePay).div(1e6).toFixed(),
      blockRewardPerBlockTrx: new Decimal(blockPay).div(1e6).toFixed(),
      candidates: producers.length,
      voteDelayDays: maintenanceMs ? new Decimal(maintenanceMs).div(86_400_000).toFixed() : undefined,
      txBandwidth: undefined,
    },
    source: {
      sourceUrl: `${HOSTS[chain]}/wallet/listwitnesses`,
      chain,
      fetchedAt,
      mode: "live",
      accessMethod: "direct",
      note: "getchainparameters(getWitnessPayPerBlock, getWitness127PayPerBlock, getUnfreezeDelayDays, getMaintenanceTimeInterval) + listwitnesses + getBrokerage 체인 조회로 계산. 거래 대역폭은 최근 스테이킹 거래 영수증 실측",
    },
  };
  cache[chain] = { at: Date.now(), quote };
  return withBandwidth(quote);
}

export interface StakingPosition {
  /** 스테이킹(동결)된 TRX (sun, 대역폭+Energy 합) */
  frozenSun: string;
  /** 투표권 = 동결 TRX 수 (1 TRX = 1표) */
  tronPower: number;
  votes: { sr: string; count: number }[];
  /** 해제 대기 중인 금액과 인출 가능 시각 */
  unfreezing: { amountSun: string; expireAt: string }[];
  /** 해제 대기가 끝나 지금 인출할 수 있는 금액 */
  withdrawableSun: string;
  /** 청구하지 않은 투표 보상 */
  rewardSun: string;
}

/** 지갑의 스테이킹·투표·해제 대기·미청구 보상을 체인에서 읽는다 (서명 없음) */
export async function stakingPosition(chain: Chain, wallet: string): Promise<StakingPosition> {
  const [acct, reward, can] = await Promise.all([
    post<any>(chain, "/wallet/getaccount", { address: wallet, visible: true }),
    post<{ reward?: number }>(chain, "/wallet/getReward", { address: wallet, visible: true }),
    post<{ amount?: number }>(chain, "/wallet/getcanwithdrawunfreezeamount", { owner_address: wallet, timestamp: Date.now(), visible: true }).catch(() => ({ amount: 0 })),
  ]);
  const frozen = ((acct?.frozenV2 ?? []) as { amount?: number }[]).reduce((s, f) => s + BigInt(f.amount ?? 0), 0n);
  const now = Date.now();
  return {
    frozenSun: frozen.toString(),
    tronPower: Number(frozen / 1_000_000n),
    votes: ((acct?.votes ?? []) as { vote_address: string; vote_count: number }[]).map((v) => ({ sr: v.vote_address, count: v.vote_count })),
    unfreezing: ((acct?.unfrozenV2 ?? []) as { unfreeze_amount?: number; unfreeze_expire_time?: number }[])
      .filter((u) => (u.unfreeze_expire_time ?? 0) > now)
      .map((u) => ({ amountSun: String(u.unfreeze_amount ?? 0), expireAt: new Date(u.unfreeze_expire_time ?? 0).toISOString() })),
    withdrawableSun: String(can?.amount ?? 0),
    rewardSun: String(reward?.reward ?? 0),
  };
}
