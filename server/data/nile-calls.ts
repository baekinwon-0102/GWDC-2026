import Decimal from "decimal.js";
import { chainFees, readUint, simulateCall, trxBalanceSun } from "./tron-rpc";
import { JUSTLEND } from "./justlend";
import { USDD_NILE } from "./usdd";
import { routerQuote, SUNSWAP } from "./sunswap";
import type { CallAction, CallPurpose, CallSpec } from "../../shared/schemas";

// Nile USDD 경로(계획 B) 실행용 계약 호출을 서버가 만든다 (서명·방송은 하지 않음. 사용자가 TronLink로 서명).
//   진입: TRX →[SunSwap V2]→ USDD(구) →[구 PSM buyGem]→ USDT 2.0 →[USDD 2.0 PSM sellGem]→ USDD 2.0 → jUSDD mint
//   출구: jUSDD redeem → USDD 2.0 →[USDD 2.0 PSM buyGem]→ USDT 2.0 →[구 PSM sellGem]→ USDD(구) →[SunSwap V2]→ TRX
// (Nile USDT 2.0은 transfer가 false를 돌려줘 V2 풀을 거칠 수 없어서, USDT 구간은 PSM 두 개로만 잇는다.)
// 금액은 계획 값이 아니라 지금 지갑 잔고(바로 앞 단계의 결과)로 정한다. 승인은 무제한이 아니라 그 금액만큼만 한다.
// 모든 호출은 서명 전에 지갑 주소로 모의 실행(triggerconstantcontract)해 실패하면 막는다.

const BR = SUNSWAP.nile.bridge!;
const C = {
  router: SUNSWAP.nile.router,
  usddOld: SUNSWAP.nile.usdt,
  usdt: USDD_NILE.usdt,
  usdd: USDD_NILE.usdd,
  psm: USDD_NILE.psm,
  gemJoin: USDD_NILE.gemJoin,
  psmOld: BR.psm,
  gemJoinOld: BR.gemJoin,
  jusdd: JUSTLEND.nile.jUSDD,
};
const NAME: Record<string, string> = {
  [C.router]: "SunSwap V2 라우터",
  [C.psm]: "USDD 2.0 PSM",
  [C.gemJoin]: "USDD 2.0 PSM GemJoin",
  [C.psmOld]: "USDD(구) PSM (브리지)",
  [C.gemJoinOld]: "USDD(구) PSM GemJoin (브리지)",
  [C.jusdd]: "JustLend jUSDD",
  [C.usdt]: "USDT 2.0 (Nile)",
  [C.usdd]: "USDD 2.0 (Nile)",
  [C.usddOld]: "USDD(구) (Nile)",
};
const TOKEN = {
  usdt: { addr: C.usdt, dec: 6, sym: "USDT 2.0" },
  usdd: { addr: C.usdd, dec: 18, sym: "USDD 2.0" },
  usddOld: { addr: C.usddOld, dec: 18, sym: "USDD(구)" },
};
/** 승인 목적별 토큰·받는 쪽. PSM sellGem은 GemJoin이 USDT를 가져가고, buyGem은 PSM이 USDD를 가져간다 */
const APPROVE: Record<CallPurpose, { token: (typeof TOKEN)[keyof typeof TOKEN]; spender: string }> = {
  bridge_in: { token: TOKEN.usddOld, spender: C.psmOld },
  psm_sell: { token: TOKEN.usdt, spender: C.gemJoin },
  jusdd: { token: TOKEN.usdd, spender: C.jusdd },
  psm_buy: { token: TOKEN.usdd, spender: C.psm },
  bridge_out: { token: TOKEN.usdt, spender: C.gemJoinOld },
  router: { token: TOKEN.usddOld, spender: C.router },
};
const FEE_LIMIT_SUN = 150_000_000n; // 150 TRX 상한 (교환·PSM은 Energy가 크다)
const SLIPPAGE_BPS = 100n; // 최소 수령량 = 견적의 99%
const WAD = 10n ** 18n;
const USDD_PER_USDT = 10n ** 12n; // USDD 18자리, USDT 6자리

const bal = (token: string, who: string) => readUint("nile", token, "balanceOf(address)", [{ type: "address", value: who }]);
const allowance = (token: string, owner: string, spender: string) =>
  readUint("nile", token, "allowance(address,address)", [
    { type: "address", value: owner },
    { type: "address", value: spender },
  ]);
const fmt = (raw: bigint, dec: number) => new Decimal(raw.toString()).div(new Decimal(10).pow(dec)).toDecimalPlaces(6, Decimal.ROUND_DOWN).toFixed();
const pctOf = (wad: bigint) => new Decimal(wad.toString()).div(1e16).toFixed();

type Spec = Omit<CallSpec, "checks" | "estimatedEnergy" | "estimatedFeeTrx" | "ok" | "feeLimitSun">;

/** PSM sellGem: USDT(6자리) 전부 → USDD(18자리). USDT는 GemJoin이 가져간다 */
async function psmSell(wallet: string, psm: string, gemJoin: string, usddSym: string, checks: CallSpec["checks"], action: CallAction): Promise<Spec> {
  const [gem, alw, tin] = await Promise.all([bal(C.usdt, wallet), allowance(C.usdt, wallet, gemJoin), readUint("nile", psm, "tin()")]);
  checks.push({ label: "USDT 2.0 잔고", ok: gem > 0n, detail: `${fmt(gem, 6)} USDT` });
  checks.push({ label: `${NAME[gemJoin]} 승인 한도`, ok: alw >= gem && gem > 0n, detail: `${fmt(alw, 6)} / 필요 ${fmt(gem, 6)} USDT` });
  const out = (gem * USDD_PER_USDT * (WAD - tin)) / WAD;
  return {
    action,
    contract: psm,
    contractName: NAME[psm],
    method: "sellGem(address,uint256)",
    params: [
      { type: "address", value: wallet },
      { type: "uint256", value: gem.toString() },
    ],
    callValueSun: "0",
    amountDisplay: `${fmt(gem, 6)} USDT 2.0 → ${fmt(out, 18)} ${usddSym} (PSM 수수료 ${pctOf(tin)}%)`,
    approval: "사용: 직전에 승인한 USDT 한도 (새 승인 없음)",
    primaryAmount: gem.toString(),
  };
}

/** PSM buyGem: 가진 USDD 전부로 살 수 있는 만큼 USDT를 받는다. USDD는 PSM이 가져간다 */
async function psmBuy(wallet: string, psm: string, gemJoin: string, usddToken: string, usddSym: string, checks: CallSpec["checks"], action: CallAction): Promise<Spec> {
  const [usdd, tout, liq] = await Promise.all([bal(usddToken, wallet), readUint("nile", psm, "tout()"), bal(C.usdt, gemJoin)]);
  // 받을 USDT(6자리) = USDD ÷ (1 + tout), 필요한 USDD = USDT × 1e12 × (1 + tout)
  const gem = (usdd * WAD) / (WAD + tout) / USDD_PER_USDT;
  const need = (gem * USDD_PER_USDT * (WAD + tout)) / WAD;
  const alw = await allowance(usddToken, wallet, psm);
  checks.push({ label: `${usddSym} 잔고`, ok: gem > 0n, detail: `${fmt(usdd, 18)} ${usddSym}` });
  checks.push({ label: `${NAME[psm]} 승인 한도`, ok: alw >= need && gem > 0n, detail: `${fmt(alw, 18)} / 필요 ${fmt(need, 18)} ${usddSym}` });
  checks.push({ label: "PSM 출구 물량", ok: liq >= gem, detail: `${fmt(liq, 6)} USDT 보유` });
  return {
    action,
    contract: psm,
    contractName: NAME[psm],
    method: "buyGem(address,uint256)",
    params: [
      { type: "address", value: wallet },
      { type: "uint256", value: gem.toString() },
    ],
    callValueSun: "0",
    amountDisplay: `${fmt(need, 18)} ${usddSym} → ${fmt(gem, 6)} USDT 2.0 (PSM 수수료 ${pctOf(tout)}%)`,
    approval: `사용: 직전에 승인한 ${usddSym} 한도 (새 승인 없음)`,
    primaryAmount: gem.toString(),
  };
}

export async function buildNileCall(wallet: string, action: CallAction, opts: { amountTrx?: string; purpose?: CallPurpose } = {}): Promise<CallSpec> {
  const checks: CallSpec["checks"] = [];
  const deadline = Math.floor(Date.now() / 1000) + 600;
  let spec: Spec;

  if (action === "swap_trx_in") {
    const sun = BigInt(new Decimal(opts.amountTrx ?? 0).mul(1e6).toFixed(0, Decimal.ROUND_DOWN));
    const walletSun = await trxBalanceSun("nile", wallet);
    checks.push({ label: "교환할 TRX", ok: sun > 0n && walletSun > sun, detail: `${fmt(sun, 6)} TRX / 지갑 ${fmt(walletSun, 6)} TRX` });
    const q = await routerQuote("nile", "toUsdt", sun);
    const min = (q.out * (10000n - SLIPPAGE_BPS)) / 10000n;
    spec = {
      action,
      contract: C.router,
      contractName: NAME[C.router],
      method: "swapExactETHForTokens(uint256,address[],address,uint256)",
      params: [
        { type: "uint256", value: min.toString() },
        { type: "address[]", value: q.path },
        { type: "address", value: wallet },
        { type: "uint256", value: String(deadline) },
      ],
      callValueSun: sun.toString(),
      amountDisplay: `${fmt(sun, 6)} TRX → 약 ${fmt(q.out, 18)} USDD(구) (최소 ${fmt(min, 18)})`,
      approval: "없음 (TRX는 토큰 승인이 필요 없습니다)",
      primaryAmount: sun.toString(),
      minOut: min.toString(),
    };
  } else if (action === "approve") {
    const a = APPROVE[opts.purpose ?? "psm_sell"];
    const amount = await bal(a.token.addr, wallet);
    checks.push({ label: `승인할 ${a.token.sym}`, ok: amount > 0n, detail: `${fmt(amount, a.token.dec)} ${a.token.sym} (바로 앞 단계에서 받은 잔고)` });
    spec = {
      action,
      contract: a.token.addr,
      contractName: NAME[a.token.addr],
      method: "approve(address,uint256)",
      params: [
        { type: "address", value: a.spender },
        { type: "uint256", value: amount.toString() },
      ],
      callValueSun: "0",
      amountDisplay: `${fmt(amount, a.token.dec)} ${a.token.sym} 사용 승인 → ${NAME[a.spender]}`,
      approval: `${fmt(amount, a.token.dec)} ${a.token.sym}까지만 ${NAME[a.spender]}(${a.spender})에 승인 (무제한 아님)`,
      primaryAmount: amount.toString(),
    };
  } else if (action === "bridge_in") spec = await psmBuy(wallet, C.psmOld, C.gemJoinOld, C.usddOld, "USDD(구)", checks, action);
  else if (action === "psm_sell") spec = await psmSell(wallet, C.psm, C.gemJoin, "USDD 2.0", checks, action);
  else if (action === "supply_usdd") {
    const [amt, alw] = await Promise.all([bal(C.usdd, wallet), allowance(C.usdd, wallet, C.jusdd)]);
    checks.push({ label: "USDD 2.0 잔고", ok: amt > 0n, detail: `${fmt(amt, 18)} USDD` });
    checks.push({ label: "jUSDD 승인 한도", ok: alw >= amt && amt > 0n, detail: `${fmt(alw, 18)} / 필요 ${fmt(amt, 18)} USDD` });
    spec = {
      action,
      contract: C.jusdd,
      contractName: NAME[C.jusdd],
      method: "mint(uint256)",
      params: [{ type: "uint256", value: amt.toString() }],
      callValueSun: "0",
      amountDisplay: `${fmt(amt, 18)} USDD 2.0 예치 (JustLend jUSDD)`,
      approval: "사용: 직전에 승인한 USDD 한도 (새 승인 없음)",
      primaryAmount: amt.toString(),
    };
  } else if (action === "withdraw_usdd") {
    const [jt, rate, cash] = await Promise.all([bal(C.jusdd, wallet), readUint("nile", C.jusdd, "exchangeRateStored()"), readUint("nile", C.jusdd, "getCash()")]);
    const under = (jt * rate) / WAD;
    checks.push({ label: "jUSDD 포지션", ok: jt > 0n, detail: `${fmt(jt, 8)} jUSDD ≈ ${fmt(under, 18)} USDD` });
    checks.push({ label: "시장 현금", ok: cash >= under, detail: `${fmt(cash, 18)} USDD (인출 필요 ${fmt(under, 18)})` });
    spec = {
      action,
      contract: C.jusdd,
      contractName: NAME[C.jusdd],
      method: "redeem(uint256)",
      params: [{ type: "uint256", value: jt.toString() }],
      callValueSun: "0",
      amountDisplay: `jUSDD ${fmt(jt, 8)} 전액 인출 (≈ ${fmt(under, 18)} USDD 2.0)`,
      approval: "없음",
      primaryAmount: jt.toString(),
    };
  } else if (action === "psm_buy") spec = await psmBuy(wallet, C.psm, C.gemJoin, C.usdd, "USDD 2.0", checks, action);
  else if (action === "bridge_out") spec = await psmSell(wallet, C.psmOld, C.gemJoinOld, "USDD(구)", checks, action);
  else {
    // swap_trx_out: USDD(구) 전부 → TRX
    const [amt, alw] = await Promise.all([bal(C.usddOld, wallet), allowance(C.usddOld, wallet, C.router)]);
    checks.push({ label: "USDD(구) 잔고", ok: amt > 0n, detail: `${fmt(amt, 18)} USDD(구)` });
    checks.push({ label: "라우터 승인 한도", ok: alw >= amt && amt > 0n, detail: `${fmt(alw, 18)} / 필요 ${fmt(amt, 18)} USDD(구)` });
    const q = amt > 0n ? await routerQuote("nile", "toTrx", amt) : { path: [] as string[], out: 0n };
    const min = (q.out * (10000n - SLIPPAGE_BPS)) / 10000n;
    spec = {
      action,
      contract: C.router,
      contractName: NAME[C.router],
      method: "swapExactTokensForETH(uint256,uint256,address[],address,uint256)",
      params: [
        { type: "uint256", value: amt.toString() },
        { type: "uint256", value: min.toString() },
        { type: "address[]", value: q.path },
        { type: "address", value: wallet },
        { type: "uint256", value: String(deadline) },
      ],
      callValueSun: "0",
      amountDisplay: `${fmt(amt, 18)} USDD(구) → 약 ${fmt(q.out, 6)} TRX (최소 ${fmt(min, 6)})`,
      approval: "사용: 직전에 승인한 USDD(구) 한도 (새 승인 없음)",
      primaryAmount: amt.toString(),
      minOut: min.toString(),
    };
  }

  // 서명 전 모의 실행: 지금 상태로 성공하는지와 Energy
  const pre = checks.every((c) => c.ok);
  const sim = pre ? await simulateCall("nile", wallet, spec.contract, spec.method, spec.params, BigInt(spec.callValueSun)) : { ok: false, message: "앞의 확인 항목이 충족되지 않아 모의 실행을 건너뛰었습니다", energy: undefined };
  checks.push({ label: "모의 실행 (서명 없이 지금 상태로 실행해 봄)", ok: sim.ok, detail: sim.ok ? `성공 · Energy ${sim.energy?.toLocaleString() ?? "-"}` : `실패: ${sim.message ?? "-"}` });
  const fees = await chainFees("nile");
  const energy = sim.energy ?? 0;
  const feeSun = BigInt(energy * fees.energyFeeSun + 400 * fees.bandwidthFeeSun);
  const trx = await trxBalanceSun("nile", wallet);
  const needTrx = feeSun + BigInt(spec.callValueSun);
  checks.push({ label: "수수료 재원 (TRX)", ok: trx >= needTrx, detail: `지갑 ${fmt(trx, 6)} TRX / 필요 약 ${fmt(needTrx, 6)} TRX` });
  if (feeSun > FEE_LIMIT_SUN) checks.push({ label: "수수료 상한", ok: false, detail: `예상 ${fmt(feeSun, 6)} TRX > 상한 ${fmt(FEE_LIMIT_SUN, 6)} TRX` });
  return { ...spec, checks, estimatedEnergy: energy, estimatedFeeTrx: fmt(feeSun, 6), feeLimitSun: FEE_LIMIT_SUN.toString(), ok: checks.every((c) => c.ok) };
}
