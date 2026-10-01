import { Decimal } from "./units";
import type { CostBasis, ExpenseConversion, ProductQuote, UserNeeds } from "./schemas";
import type { SwapMarket } from "./planning";

// 보유 자산과 다른 자산으로 내는 지출 (예: TRX를 보유하고 USDT·USDD로 지출).
// 지출에 필요한 금액을 보유 자산 기준 필요량으로 바꿔 지출 재원으로 확보한다.
//  - 환전은 오늘(D+0) 해서 지출일까지 보유한다고 가정한다 → 그 사이 가격 변동 위험이 없다.
//  - TRX ↔ USDT는 SunSwap V2 견적(원하는 수령량에서 필요한 투입량을 역산, 라우터 getAmountsIn과 같은 식),
//    USDT ↔ USDD는 USDD PSM(수수료 tin/tout). 환전 거래비용(교환·승인·PSM, 소각 기준)도 필요량에 더한다.
//  - 견적이 없으면 필요량을 알 수 없으므로 보유액 전부를 확보(운용 가능액 0)하고 이유를 보인다.

export type Asset = "USDT" | "TRX" | "USDD";
export const EXPENSE_ASSETS: Asset[] = ["USDT", "TRX", "USDD"];


/** V2 역산: 받고 싶은 양(out)에 필요한 투입량. in = R_in×out×1000 ÷ ((R_out − out)×fee), 6자리 올림 */
function amountIn(out: Decimal, rIn: Decimal, rOut: Decimal, fee = 997): Decimal | undefined {
  if (out.gte(rOut)) return undefined;
  return rIn.mul(out).mul(1000).div(rOut.minus(out).mul(fee)).toDecimalPlaces(6, Decimal.ROUND_UP);
}
const hops = (sw: SwapMarket) => sw.hops ?? [{ reserveUsdtSide: sw.reserveUsdt, reserveTrxSide: sw.reserveTrx }];

/** USDT X를 받으려면 필요한 TRX (브리지 PSM이 있으면 브리지 토큰 → USDT 수수료 포함) */
export function trxForUsdt(sw: SwapMarket, usdt: Decimal): Decimal | undefined {
  let need: Decimal | undefined = sw.bridge ? usdt.mul(new Decimal(1).plus(sw.bridge.feeOut)) : usdt;
  for (const h of hops(sw)) {
    if (!need) return undefined;
    need = amountIn(need, new Decimal(h.reserveTrxSide), new Decimal(h.reserveUsdtSide), sw.feeNumerator);
  }
  return need;
}
/** TRX X를 받으려면 필요한 USDT */
export function usdtForTrx(sw: SwapMarket, trx: Decimal): Decimal | undefined {
  let need: Decimal | undefined = trx;
  for (const h of [...hops(sw)].reverse()) {
    if (!need) return undefined;
    need = amountIn(need, new Decimal(h.reserveUsdtSide), new Decimal(h.reserveTrxSide), sw.feeNumerator);
  }
  return need && sw.bridge ? need.div(new Decimal(1).minus(sw.bridge.feeIn)).toDecimalPlaces(6, Decimal.ROUND_UP) : need;
}

export function convertExpenses(
  needs: UserNeeds,
  inputs: { swap?: SwapMarket; psm?: ProductQuote; costBasis?: CostBasis },
): { needs: UserNeeds; conversions: ExpenseConversion[]; problems: string[] } {
  const hold = needs.asset;
  const foreign = needs.expenses.filter((e) => e.asset !== hold);
  if (!foreign.length) return { needs, conversions: [], problems: [] };
  const sw = inputs.swap;
  const p = inputs.psm?.psm;
  const b = inputs.costBasis;
  const feeIn = p ? new Decimal(p.feeIn) : undefined;
  // 환전 거래비용 (TRX, 소각 기준): 교환 Energy·대역폭 + 필요하면 승인·PSM
  const txTrx = (energy: number, bw: number) => (b ? new Decimal(energy * b.energyFeeSun + bw * b.bandwidthFeeSun).div(1e6) : new Decimal(0));
  const swapTrx = (dir: "toUsdt" | "toTrx") => (sw ? txTrx(sw.costs[dir].energy + (sw.bridge?.energy ? (dir === "toUsdt" ? sw.bridge.energy.buy : sw.bridge.energy.sell) + 23000 : 0), sw.costs[dir].bandwidth + (sw.bridge ? 610 : 0)) : new Decimal(0));
  const psmTrx = (dir: "sell" | "buy") => (b?.psmEnergy ? txTrx((dir === "sell" ? b.psmEnergy.sell : b.psmEnergy.buy) + 23000, 345 + 265) : new Decimal(0));
  const trxPerUsdt = b?.trxPerUsdt ? new Decimal(b.trxPerUsdt) : sw ? new Decimal(sw.reserveTrx).div(sw.reserveUsdt) : undefined;

  const conversions: ExpenseConversion[] = [];
  const problems: string[] = [];
  const expenses = needs.expenses.map((e) => {
    if (e.asset === hold) return e;
    const want = new Decimal(e.amount);
    let pay: Decimal | undefined;
    let route = "";
    let cost = new Decimal(0);
    if (hold === "TRX" && e.asset === "USDT" && sw) {
      pay = trxForUsdt(sw, want);
      route = "SunSwap V2 TRX → USDT";
      cost = swapTrx("toUsdt");
    } else if (hold === "TRX" && e.asset === "USDD" && sw && feeIn) {
      const usdt = want.div(new Decimal(1).minus(feeIn));
      pay = trxForUsdt(sw, usdt);
      route = "SunSwap V2 TRX → USDT → PSM → USDD";
      cost = swapTrx("toUsdt").plus(psmTrx("sell"));
    } else if (hold === "USDT" && e.asset === "TRX" && sw) {
      pay = usdtForTrx(sw, want);
      route = "SunSwap V2 USDT → TRX";
      cost = swapTrx("toTrx").plus(txTrx(23000, 265));
    } else if (hold === "USDD" && e.asset === "USDT" && p) {
      pay = want.mul(new Decimal(1).plus(p.feeOut)).toDecimalPlaces(6, Decimal.ROUND_UP);
      route = "USDD PSM USDD → USDT";
      cost = psmTrx("buy");
    } else if (hold === "USDD" && e.asset === "TRX" && sw && p) {
      const usdt = usdtForTrx(sw, want);
      pay = usdt ? usdt.mul(new Decimal(1).plus(p.feeOut)).toDecimalPlaces(6, Decimal.ROUND_UP) : undefined;
      route = "USDD PSM USDD → USDT → SunSwap V2 → TRX";
      cost = psmTrx("buy").plus(swapTrx("toTrx")).plus(txTrx(23000, 265));
    } else if (hold === "USDT" && e.asset === "USDD" && feeIn) {
      pay = want.div(new Decimal(1).minus(feeIn)).toDecimalPlaces(6, Decimal.ROUND_UP);
      route = "USDD PSM USDT → USDD";
      cost = psmTrx("sell");
    }
    if (!pay) {
      problems.push(`${e.date} 지출(${e.amount} ${e.asset})을 ${hold}로 마련할 환전 견적이 없어 필요량을 알 수 없습니다. 안전하게 보유액 전부를 지출 재원으로 둡니다.`);
      return { ...e, asset: hold, amount: needs.amount ?? "0", label: `${e.label ?? "지출"} (${e.amount} ${e.asset}, 환전 견적 없음)` };
    }
    // 환전 거래비용을 보유 자산으로 더한다
    const perHold = hold === "USDD" && b?.trxPerUsdd ? new Decimal(b.trxPerUsdd) : trxPerUsdt;
    const costInHold = hold === "TRX" ? cost : perHold && perHold.gt(0) ? cost.div(perHold) : new Decimal(0);
    const total = pay.plus(costInHold).toDecimalPlaces(6, Decimal.ROUND_UP);
    conversions.push({ expenseId: e.id, date: e.date, need: { amount: e.amount, asset: e.asset }, pay: { amount: total.toFixed(), asset: hold }, route, costTrx: cost.toDecimalPlaces(6).toFixed() });
    return { ...e, asset: hold, amount: total.toFixed(), label: `${e.label ?? "지출"} (${e.amount} ${e.asset} 환전용)` };
  });
  return { needs: { ...needs, expenses }, conversions, problems };
}
