import Decimal from "decimal.js";
import { HOSTS, post, readWords } from "./tron-rpc";
import { applyCostOptions, type CostMode, type EnergyMode } from "../../shared/costmode";
import type { Chain, CostBasis, UserNeeds } from "../../shared/schemas";
import type { SwapMarket } from "../../shared/planning";

// Energy 조달 방식별 단가 (체인에서 읽음).
//  - 스테이킹: 1 TRX당 하루 Energy = TotalEnergyLimit ÷ TotalEnergyWeight (getaccountresource)
//  - 대여: JustLend Energy 대여 시장 계약의 대여율(_rentalRate·_stableRate 중 큰 값, TRX당 초당), 수수료율(feeRatio), 최소 수수료(minFee), 사용분 차감률(usageChargeRatio)
//    주소·계산식 출처: 공식 JustLend MCP src/core/chains.ts (strx.market) · services/energy-rental.ts (calculateRentalPrice), JustLend 문서 Energy Rental
const MARKET: Record<Chain, string> = { mainnet: "TU2MJ5Veik1LRAgjeSzEdvmDYx7mefJZvd", nile: "TSos1xxjqMrGKBxycVmtgrnFvv9M6FDFUX" };
const RENT_DURATION_SEC = 3600; // 거래 묶음마다 1시간 빌린다고 가정
const REF_RENT_SUN = "50000000000"; // 대여율 조회 기준 5만 TRX
const WAD = new Decimal("1e18");
const cache: Partial<Record<Chain, { at: number; value: Econ }>> = {};

interface Econ {
  energyStakePerTrx: string;
  rent?: NonNullable<NonNullable<CostBasis["energyMode"]>["rent"]>;
  rentError?: string;
  fetchedAt: string;
}

async function econ(chain: Chain): Promise<Econ> {
  const hit = cache[chain];
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value;
  const m = MARKET[chain];
  const r = await post<{ TotalEnergyLimit?: number; TotalEnergyWeight?: number }>(chain, "/wallet/getaccountresource", { address: m, visible: true });
  if (!r.TotalEnergyLimit || !r.TotalEnergyWeight) throw new Error("TotalEnergyLimit·TotalEnergyWeight를 읽지 못했습니다.");
  const value: Econ = { energyStakePerTrx: new Decimal(r.TotalEnergyLimit).div(r.TotalEnergyWeight).toFixed(), fetchedAt: new Date().toISOString() };
  try {
    const w = async (sig: string, p: { type: string; value: unknown }[] = []) => new Decimal(BigInt("0x" + (await readWords(chain, m, sig, p))[0]).toString());
    const [rental, stable, feeRatio, minFee, usage, paused] = await Promise.all([
      w("_rentalRate(uint256,uint256)", [{ type: "uint256", value: REF_RENT_SUN }, { type: "uint256", value: 1 }]),
      w("_stableRate(uint256)", [{ type: "uint256", value: 1 }]),
      w("feeRatio()"),
      w("minFee()"),
      w("usageChargeRatio()"),
      w("rentPaused(uint256)", [{ type: "uint256", value: 1 }]),
    ]);
    if (!paused.isZero()) throw new Error("Energy 대여가 일시 중지 상태입니다.");
    value.rent = {
      ratePerTrxSec: Decimal.max(rental, stable).div(WAD).toFixed(),
      feeRatio: feeRatio.div(WAD).toFixed(),
      minFeeTrx: minFee.div(1e6).toFixed(),
      usageChargeRatio: usage.div(WAD).toFixed(),
      durationSec: RENT_DURATION_SEC,
    };
  } catch (e) {
    value.rentError = (e as Error).message;
  }
  cache[chain] = { at: Date.now(), value };
  return value;
}

/** 요구사항의 비용 가정(비용 기준·Energy 조달 방식)을 입력에 적용한다. 대여 단가를 못 읽으면 소각으로 계산하고 경고를 남긴다 */
export async function withCostOptions<T extends { costBasis?: CostBasis; swap?: SwapMarket }>(chain: Chain, needs: UserNeeds, inputs: T): Promise<{ inputs: T; warnings: string[] }> {
  const mode: CostMode = needs.costBasisMode ?? "max";
  const want: EnergyMode = needs.energySource ?? "burn";
  const warnings: string[] = [];
  if (!inputs.costBasis) return { inputs, warnings };
  let energy: CostBasis["energyMode"] = { mode: "burn", burnFeeSun: inputs.costBasis.energyFeeSun };
  if (want !== "burn") {
    try {
      const e = await econ(chain);
      const source = {
        sourceUrl: `${HOSTS[chain]}/wallet/getaccountresource`,
        chain,
        fetchedAt: e.fetchedAt,
        mode: "live" as const,
        accessMethod: "direct" as const,
        note: `스테이킹 1 TRX당 하루 ${Number(e.energyStakePerTrx).toFixed(2)} Energy${e.rent ? ` · JustLend 대여 시장 ${MARKET[chain]} 대여율·수수료 온체인 읽기` : ""}`,
      };
      if (want === "rent" && !e.rent) warnings.push(`Energy 대여 단가를 읽지 못해 소각 기준으로 계산했습니다 (${e.rentError ?? "알 수 없음"}).`);
      else energy = { mode: want, burnFeeSun: inputs.costBasis.energyFeeSun, energyStakePerTrx: e.energyStakePerTrx, rent: want === "rent" ? e.rent : undefined, source };
    } catch (err) {
      warnings.push(`Energy 스테이킹·대여 단가를 읽지 못해 소각 기준으로 계산했습니다 (${(err as Error).message}).`);
    }
  }
  return { inputs: applyCostOptions(inputs, mode, energy), warnings };
}
