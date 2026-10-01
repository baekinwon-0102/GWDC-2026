import { TronWeb } from "tronweb";
import { env } from "../env";
import { sunToTrx } from "../../shared/units";
import type { Chain, TxStatusResponse } from "../../shared/schemas";

// TronGrid 직접 RPC. MCP로 대체하지 않은 체인 조회(계약 읽기, 잔고, 영수증, 수수료 파라미터)를 맡는다.

export const HOSTS: Record<Chain, string> = {
  mainnet: "https://api.trongrid.io",
  nile: "https://nile.trongrid.io",
};
export const EXPLORER: Record<Chain, string> = {
  mainnet: "https://tronscan.org/#/transaction/",
  nile: "https://nile.tronscan.org/#/transaction/",
};

/** 읽기 전용 호출에 쓰는 임의 owner 주소 (서명·전송 없음) */
const READ_OWNER = "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb";
const TIMEOUT_MS = 15000;

const clients: Partial<Record<Chain, TronWeb>> = {};
function tw(chain: Chain): TronWeb {
  if (!clients[chain]) {
    const headers: Record<string, string> = env.trongridApiKey ? { "TRON-PRO-API-KEY": env.trongridApiKey } : {};
    clients[chain] = new TronWeb({ fullHost: HOSTS[chain], headers });
  }
  return clients[chain]!;
}

function withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what} 시간 초과`)), TIMEOUT_MS))]);
}

// TronGrid는 키당 초당 요청 수를 제한한다(HTTP 429). 체인별 동시 요청을 제한하고 429는 잠시 뒤 재시도한다.
const MAX_CONCURRENT = 4;
const active: Record<Chain, number> = { mainnet: 0, nile: 0 };
const waiting: Record<Chain, (() => void)[]> = { mainnet: [], nile: [] };

async function limited<T>(chain: Chain, fn: () => Promise<T>): Promise<T> {
  if (active[chain] >= MAX_CONCURRENT) await new Promise<void>((r) => waiting[chain].push(r));
  active[chain]++;
  try {
    for (let i = 0; ; i++) {
      try {
        return await fn();
      } catch (e) {
        if (i >= 5 || !/429/.test(String((e as Error)?.message ?? e))) throw e;
        await new Promise((r) => setTimeout(r, 800 * (i + 1)));
      }
    }
  } finally {
    active[chain]--;
    waiting[chain].shift()?.();
  }
}

export async function post<T = any>(chain: Chain, pathname: string, body: unknown): Promise<T> {
  return limited(chain, () => postRaw<T>(chain, pathname, body));
}

async function postRaw<T>(chain: Chain, pathname: string, body: unknown): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (env.trongridApiKey) headers["TRON-PRO-API-KEY"] = env.trongridApiKey;
  const r = await fetch(HOSTS[chain] + pathname, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) throw new Error(`TronGrid ${pathname} HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

export async function getJson<T = any>(chain: Chain, pathname: string): Promise<T> {
  return limited(chain, () => getJsonRaw<T>(chain, pathname));
}

async function getJsonRaw<T>(chain: Chain, pathname: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (env.trongridApiKey) headers["TRON-PRO-API-KEY"] = env.trongridApiKey;
  const r = await fetch(HOSTS[chain] + pathname, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) throw new Error(`TronGrid ${pathname} HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

/** view 함수 호출 → 32바이트 워드 배열(hex) */
export async function readWords(chain: Chain, contract: string, signature: string, params: { type: string; value: unknown }[] = []): Promise<string[]> {
  const r: any = await limited(chain, () => withTimeout(tw(chain).transactionBuilder.triggerConstantContract(contract, signature, {}, params as any, READ_OWNER), signature));
  const hex: string | undefined = r?.constant_result?.[0];
  if (!r?.result?.result || hex === undefined) throw new Error(`${signature} 호출 실패: ${r?.result?.message ?? "응답 없음"}`);
  return hex.match(/.{1,64}/g) ?? [];
}

export async function readUint(chain: Chain, contract: string, signature: string, params: { type: string; value: unknown }[] = []): Promise<bigint> {
  const words = await readWords(chain, contract, signature, params);
  if (!words[0]) throw new Error(`${signature} 빈 응답`);
  return BigInt("0x" + words[0]);
}

export async function chainFees(chain: Chain): Promise<{ energyFeeSun: number; bandwidthFeeSun: number }> {
  const r = await post<{ chainParameter: { key: string; value?: number }[] }>(chain, "/wallet/getchainparameters", {});
  const find = (k: string) => r.chainParameter.find((p) => p.key === k)?.value;
  const energyFeeSun = find("getEnergyFee");
  const bandwidthFeeSun = find("getTransactionFee");
  if (!energyFeeSun || !bandwidthFeeSun) throw new Error("수수료 파라미터 없음");
  return { energyFeeSun, bandwidthFeeSun };
}

export async function trxBalanceSun(chain: Chain, address: string): Promise<bigint> {
  const r = await post<{ balance?: number }>(chain, "/wallet/getaccount", { address, visible: true });
  return BigInt(r.balance ?? 0);
}

export async function contractExists(chain: Chain, address: string): Promise<{ exists: boolean; name?: string }> {
  const r = await post<{ contract_address?: string; name?: string }>(chain, "/wallet/getcontract", { value: address, visible: true });
  return { exists: Boolean(r.contract_address), name: r.name };
}

export async function nowBlock(chain: Chain): Promise<number> {
  const r = await post<any>(chain, "/wallet/getnowblock", {});
  return r?.block_header?.raw_data?.number;
}

/** 확정(solidity) 노드의 영수증과 최신 노드의 영수증을 함께 본다 */
export async function txInfo(chain: Chain, txId: string) {
  const [solid, latest] = await Promise.all([
    post<any>(chain, "/walletsolidity/gettransactioninfobyid", { value: txId }).catch(() => ({})),
    post<any>(chain, "/wallet/gettransactioninfobyid", { value: txId }).catch(() => ({})),
  ]);
  return { solid, latest };
}

export interface MeasuredCost {
  /** 최대값 (보수적 기준) */
  energy: number;
  bandwidth: number;
  sampleSize: number;
  /** 중앙값 (비용 기준을 "중앙값"으로 고를 때) */
  median: { energy: number; bandwidth: number };
}

const medianOf = (xs: number[]) => {
  const a = [...xs].sort((x, y) => x - y);
  return a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : Math.round((a[a.length / 2 - 1] + a[a.length / 2]) / 2)) : 0;
};

/**
 * 계약의 최근 성공 거래에서 메서드(선택자)별 Energy·대역폭 실측 최대값을 뽑는다.
 * 대역폭 = 영수증의 net_usage(무료·스테이킹 대역폭) 또는 net_fee ÷ 체인의 대역폭 단가(TRX 소각).
 * 표본이 없는 메서드는 결과에 넣지 않는다 (호출자가 일반값을 쓴다).
 */
export async function measureContractCosts(chain: Chain, contract: string, selectors: Record<string, string>, limit = 100): Promise<Record<string, MeasuredCost>> {
  const [j, fees] = await Promise.all([
    getJson<{ data?: any[] }>(chain, `/v1/accounts/${contract}/transactions?only_to=true&only_confirmed=true&limit=${limit}`),
    chainFees(chain),
  ]);
  const samples: Record<string, { e: number[]; b: number[] }> = {};
  for (const t of j.data ?? []) {
    if (t?.ret?.[0]?.contractRet !== "SUCCESS") continue;
    const data: string = t?.raw_data?.contract?.[0]?.parameter?.value?.data ?? "";
    const name = Object.keys(selectors).find((k) => data.startsWith(selectors[k]));
    if (!name) continue;
    const bw = Number(t.net_usage ?? 0) || Math.round(Number(t.net_fee ?? 0) / fees.bandwidthFeeSun);
    const cur = (samples[name] ??= { e: [], b: [] });
    cur.e.push(Number(t.energy_usage_total ?? 0));
    cur.b.push(bw);
  }
  const out: Record<string, MeasuredCost> = {};
  for (const [k, v] of Object.entries(samples))
    out[k] = { energy: Math.max(...v.e), bandwidth: Math.max(...v.b), sampleSize: v.e.length, median: { energy: medianOf(v.e), bandwidth: medianOf(v.b) } };
  return out;
}

/** 확정 영수증 기준 Nile 거래 상태. 방송 응답이 아니라 solidity 노드 영수증이 있어야 confirmed */
export async function nileTxStatus(txId: string): Promise<TxStatusResponse> {
  const { solid, latest } = await txInfo("nile", txId);
  const src = { sourceUrl: EXPLORER.nile + txId, chain: "nile" as const, fetchedAt: new Date().toISOString(), mode: "live" as const, accessMethod: "direct" as const };
  if (solid?.id) {
    const result = solid.receipt?.result;
    return {
      txId,
      chain: "nile",
      status: result && result !== "SUCCESS" ? "failed" : "confirmed",
      blockNumber: solid.blockNumber,
      feeTrx: sunToTrx(BigInt(solid.fee ?? 0)),
      energyUsed: solid.receipt?.energy_usage_total,
      result: result ?? "SUCCESS",
      source: { ...src, note: "확정(solidity) 노드 영수증" },
    };
  }
  if (latest?.id) return { txId, chain: "nile", status: "pending", blockNumber: latest.blockNumber, result: latest.receipt?.result, source: { ...src, note: "블록 포함, 확정 대기" } };
  return { txId, chain: "nile", status: "not_found", source: src };
}

export function isBase58Address(a: string): boolean {
  return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a) && TronWeb.isAddress(a);
}

/**
 * 서명 전 모의 실행 (triggerconstantcontract, 서명·방송 없음). 실제 지갑 주소를 owner로 넣어
 * 잔고·승인 한도·계약 상태가 지금 그대로일 때 성공하는지와 Energy 사용량을 본다.
 */
export async function simulateCall(
  chain: Chain,
  owner: string,
  contract: string,
  method: string,
  params: { type: string; value: unknown }[],
  callValueSun = 0n,
): Promise<{ ok: boolean; energy?: number; message?: string }> {
  try {
    const r: any = await limited(chain, () =>
      withTimeout(tw(chain).transactionBuilder.triggerConstantContract(contract, method, { callValue: Number(callValueSun) }, params as any, owner), method),
    );
    const ok = Boolean(r?.result?.result) && r?.transaction?.ret?.[0]?.ret !== "FAILED";
    const raw = r?.result?.message ?? r?.transaction?.ret?.[0]?.ret;
    let message: string | undefined;
    if (!ok) {
      const hex = r?.constant_result?.[0] as string | undefined;
      // Error(string) 되돌림 사유 디코딩
      if (hex && hex.startsWith("08c379a0")) {
        try {
          const len = parseInt(hex.slice(8 + 64, 8 + 128), 16);
          message = Buffer.from(hex.slice(8 + 128, 8 + 128 + len * 2), "hex").toString();
        } catch {
          message = raw;
        }
      } else message = raw ? (/^[0-9a-f]+$/i.test(raw) ? Buffer.from(raw, "hex").toString() : String(raw)) : "되돌림(revert)";
    }
    return { ok, energy: r?.energy_used, message };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}
