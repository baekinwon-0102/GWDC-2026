import Decimal from "decimal.js";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_DOWN });

export { Decimal };

/** "12.345" (decimals=6) → 12345000n. 정밀도를 넘는 소수는 거부한다. */
export function toBaseUnits(amount: string, decimals: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(amount)) throw new Error(`잘못된 금액: ${amount}`);
  const [int, frac = ""] = amount.split(".");
  if (frac.length > decimals && /[1-9]/.test(frac.slice(decimals))) {
    throw new Error(`소수점 ${decimals}자리를 넘는 금액은 사용할 수 없습니다: ${amount}`);
  }
  return BigInt(int + frac.slice(0, decimals).padEnd(decimals, "0"));
}

/** 12345000n (decimals=6) → "12.345" */
export function fromBaseUnits(value: bigint | string, decimals: number): string {
  const v = BigInt(value);
  const neg = v < 0n;
  const s = (neg ? -v : v).toString().padStart(decimals + 1, "0");
  const int = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return (neg ? "-" : "") + (frac ? `${int}.${frac}` : int);
}

export const sunToTrx = (sun: bigint | string) => fromBaseUnits(sun, 6);
export const trxToSun = (trx: string) => toBaseUnits(trx, 6);

export function d(v: string | number | Decimal): Decimal {
  return new Decimal(v);
}

/** 화면 표시용 고정 소수 문자열 */
export function fmt(v: string | Decimal | undefined, dp = 2): string {
  if (v === undefined) return "-";
  return new Decimal(v).toDecimalPlaces(dp, Decimal.ROUND_HALF_UP).toFixed(dp);
}
