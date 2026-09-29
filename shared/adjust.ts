import { Decimal } from "./units";
import { daysBetween, reservedWithinHorizon, todaySeoul } from "./needs";
import { nileResources } from "./planning";
import type { CostBasis, ProductQuote, UserNeeds } from "./schemas";

// Nile jTRX 포지션 조정 판정. 조정 근거는 유동성·사용자 조건·기간 변화뿐이다
// (Nile 금리는 거의 0이라 수익을 높이려는 조정은 예상 이자와 수수료를 함께 보여 준다).

export interface NilePosition {
  walletSun: string;
  jTokenRaw: string;
  underlyingSun: string;
}

export type AdjustKind = "withdraw_partial" | "withdraw_all" | "deposit_more";

export interface NileAdjustment {
  checkedAt: string;
  status: "adjust" | "hold_position" | "no_position" | "blocked";
  summary: string;
  action?: {
    kind: AdjustKind;
    amountTrx: string;
    /** 부분 인출·추가 예치는 TRX sun, 전액 인출은 jToken 수량(1e-8 단위) */
    amountSun: string;
    method: "redeemUnderlying(uint256)" | "redeem(uint256)" | "mint()";
    estimatedEnergy: number;
    estimatedFeeTrx: string;
    reason: string;
    label: "조정 권고";
  };
  figures: {
    walletTrx: string;
    positionTrx: string;
    reservedTrx: string;
    exitFeeReserveTrx: string;
    walletNeedTrx: string;
    targetDepositTrx: string;
    daysLeft: number;
    marketCashTrx?: string;
  };
  checks: { label: string; ok: boolean; detail: string }[];
  notes: string[];
}

const SUN = new Decimal(1_000_000);
const MIN_ACTION_TRX = new Decimal(1);

export function computeNileAdjustment(input: {
  needs: UserNeeds;
  planKey?: string;
  position: NilePosition;
  quote?: ProductQuote;
  costBasis?: Pick<CostBasis, "energyFeeSun" | "bandwidthFeeSun" | "jtrxEnergy">;
  plannedRate?: string;
  /** monitor: 유동성·기간 변화만 본다. rebalance: 사용자가 고른 목표 배분(planKey)에 포지션을 맞춘다 (넘치면 부분 인출) */
  mode?: "monitor" | "rebalance";
  now?: Date;
}): NileAdjustment {
  const now = input.now ?? new Date();
  const { needs, position, quote, costBasis } = input;
  const wallet = new Decimal(position.walletSun).div(SUN);
  const underlying = new Decimal(position.underlyingSun).div(SUN);
  const total = wallet.plus(underlying);
  const today = todaySeoul(now);
  const daysLeft = needs.endDate ? daysBetween(today, needs.endDate) : 0;
  // 오늘 이후 기간 안의 지출 + 여유액 (이미 지난 지출은 이미 쓴 것으로 본다)
  const reserved = reservedWithinHorizon({ ...needs, startDate: today }).total;
  const notes: string[] = [];
  const checks: NileAdjustment["checks"] = [];
  const r2 = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed();

  const base = { checkedAt: now.toISOString(), checks, notes };
  const emptyFigures = (need = new Decimal(0), fee = new Decimal(0), target = new Decimal(0)) => ({
    walletTrx: r2(wallet),
    positionTrx: underlying.toDecimalPlaces(6, Decimal.ROUND_DOWN).toFixed(),
    reservedTrx: r2(reserved),
    exitFeeReserveTrx: r2(fee),
    walletNeedTrx: r2(need),
    targetDepositTrx: r2(target),
    daysLeft,
    marketCashTrx: quote?.liquidity ? r2(new Decimal(quote.liquidity)) : undefined,
  });

  if (new Decimal(position.jTokenRaw).lte(0) || underlying.lte(0))
    return { ...base, status: "no_position", summary: "jTRX 포지션이 없습니다. 조정할 대상이 없습니다.", figures: emptyFigures() };
  if (!costBasis) return { ...base, status: "blocked", summary: "Nile 수수료 파라미터를 조회하지 못해 조정 비용을 계산할 수 없습니다.", figures: emptyFigures() };

  const res = nileResources(costBasis);
  const feeOf = (r: { energy: number; bandwidth: number }) => new Decimal(r.energy * costBasis.energyFeeSun + r.bandwidth * costBasis.bandwidthFeeSun).div(SUN);
  const fullFee = feeOf(res.withdrawRes);
  const partialFee = feeOf(res.partialRes);
  const depositFee = feeOf(res.depositRes);
  const walletNeed = reserved.plus(fullFee);
  const cash = quote?.liquidity ? new Decimal(quote.liquidity) : undefined;

  checks.push({ label: "지갑 유동성", ok: wallet.gte(walletNeed), detail: `지갑 ${r2(wallet)} TRX / 필요 ${r2(walletNeed)} TRX (지출·여유 ${r2(reserved)} + 전액 인출 수수료 재원 ${r2(fullFee)})` });
  checks.push({ label: "남은 운용 기간", ok: daysLeft > 0, detail: daysLeft > 0 ? `${daysLeft}일 남음 (종료 ${needs.endDate})` : `종료일(${needs.endDate})이 지났습니다` });
  if (cash) checks.push({ label: "시장 인출 가능 현금", ok: cash.gte(underlying), detail: `jTRX 시장 현금 ${r2(cash)} TRX / 내 포지션 ${r2(underlying)} TRX` });
  if (quote) checks.push({ label: "jTRX 시장 상태", ok: quote.active, detail: quote.active ? "예치 가능" : quote.inactiveReason ?? "비활성" });
  if (input.plannedRate && quote?.baseRate && new Decimal(input.plannedRate).gt(0)) {
    const change = new Decimal(quote.baseRate).minus(input.plannedRate).div(input.plannedRate);
    if (change.abs().gt("0.3")) notes.push(`계획 당시 대비 jTRX 금리가 ${new Decimal(input.plannedRate).mul(100).toDecimalPlaces(6).toFixed()}% → ${new Decimal(quote.baseRate).mul(100).toDecimalPlaces(6).toFixed()}%로 크게 바뀌었습니다. Nile 금리는 거의 0이라 수익 기준 조정은 권하지 않습니다.`);
  }

  const withdrawAll = (reason: string): NileAdjustment => {
    const figures = emptyFigures(walletNeed, fullFee, new Decimal(0));
    if (wallet.lt(fullFee))
      return { ...base, status: "blocked", summary: `전액 인출이 필요하지만 수수료 재원이 부족합니다. 지갑에 ${r2(fullFee.minus(wallet))} TRX 이상 더 필요합니다.`, figures };
    if (cash && cash.lt(underlying)) notes.push("시장 현금이 포지션보다 적어 전액 인출이 실패할 수 있습니다.");
    return {
      ...base,
      status: "adjust",
      summary: `전액 인출을 권고합니다: ${reason}`,
      action: {
        kind: "withdraw_all",
        amountTrx: underlying.toDecimalPlaces(6, Decimal.ROUND_DOWN).toFixed(),
        amountSun: position.jTokenRaw,
        method: "redeem(uint256)",
        estimatedEnergy: res.withdrawRes.energy,
        estimatedFeeTrx: fullFee.toDecimalPlaces(6, Decimal.ROUND_UP).toFixed(),
        reason,
        label: "조정 권고",
      },
      figures,
    };
  };

  // 1) 기간 종료
  if (daysLeft <= 0) return withdrawAll(`운용 기간(${needs.endDate})이 끝났습니다.`);

  // 2) 유동성 부족: 지갑이 지출·여유 + 나중의 전액 인출 수수료를 감당하지 못한다
  if (wallet.lt(walletNeed)) {
    const shortfall = walletNeed.minus(wallet).plus(partialFee); // 부분 인출 거래 자체도 지갑 TRX를 소각한다
    if (shortfall.gte(underlying.mul("0.98")) || underlying.minus(shortfall).lt(MIN_ACTION_TRX))
      return withdrawAll(`지출·여유액과 수수료 재원을 맞추려면 포지션 대부분(${r2(shortfall)} TRX)이 필요합니다.`);
    const amount = shortfall.toDecimalPlaces(6, Decimal.ROUND_UP);
    const figures = emptyFigures(walletNeed, fullFee, underlying.minus(amount));
    if (wallet.lt(partialFee))
      return { ...base, status: "blocked", summary: `부분 인출이 필요하지만 수수료 재원이 부족합니다. 지갑에 ${r2(partialFee.minus(wallet))} TRX 이상 더 필요합니다.`, figures };
    if (cash && cash.lt(amount)) notes.push("시장 현금이 인출액보다 적어 부분 인출이 실패할 수 있습니다.");
    if (partialFee.gt(fullFee))
      notes.push(`부분 인출 수수료(${r2(partialFee)} TRX, 최근 거래 실측 최대)가 전액 인출(${r2(fullFee)} TRX)보다 큽니다. 포지션을 유지할 필요가 없다면 전액 인출이 더 저렴합니다.`);
    return {
      ...base,
      status: "adjust",
      summary: `${r2(amount)} TRX 부분 인출을 권고합니다. 지갑 TRX가 지출·여유액과 인출 수수료 재원보다 ${r2(walletNeed.minus(wallet))} TRX 부족합니다.`,
      action: {
        kind: "withdraw_partial",
        amountTrx: amount.toFixed(),
        amountSun: amount.mul(SUN).toFixed(0),
        method: "redeemUnderlying(uint256)",
        estimatedEnergy: res.partialRes.energy,
        estimatedFeeTrx: partialFee.toDecimalPlaces(6, Decimal.ROUND_UP).toFixed(),
        reason: "지갑 유동성 부족 (지출·여유액 또는 수수료 재원 변경)",
        label: "조정 권고",
      },
      figures,
    };
  }

  // 3) 조건 완화: 목표 예치액이 현재보다 크다
  const maxDeposit = Decimal.max(total.minus(reserved).minus(fullFee).minus(depositFee), 0);
  const intended = input.planKey === "NILE_50" ? total.mul("0.5") : total.minus(reserved);
  const target = Decimal.min(Decimal.max(intended, 0), maxDeposit);
  const extra = target.minus(underlying);
  const figures = emptyFigures(walletNeed, fullFee, target);
  const planKo = input.planKey === "NILE_50" ? "절반 예치안" : "최대 예치안";
  // 리밸런스: 목표보다 많이 예치돼 있으면 초과분을 부분 인출한다 (사용자가 목표 배분을 바꾼 경우에만)
  if (input.mode === "rebalance" && extra.neg().gt(Decimal.max(MIN_ACTION_TRX, 0))) {
    const excess = extra.neg().toDecimalPlaces(6, Decimal.ROUND_DOWN);
    if (wallet.lt(partialFee))
      return { ...base, status: "blocked", summary: `${planKo}으로 리밸런스하려면 ${r2(excess)} TRX를 인출해야 하지만 수수료 재원이 부족합니다.`, figures };
    if (excess.gte(underlying.mul("0.98"))) return withdrawAll(`목표 배분(${planKo})에 맞추면 포지션 대부분을 인출해야 합니다.`);
    notes.push(`리밸런스 인출 수수료(${r2(partialFee)} TRX)가 발생합니다. Nile 금리는 거의 0이라 경제적 이익이 아니라 목표 배분을 맞추기 위한 조정입니다.`);
    return {
      ...base,
      status: "adjust",
      summary: `목표 배분(${planKo})에 맞추도록 ${r2(excess)} TRX 부분 인출을 권고합니다 (리밸런스: 예치 ${r2(underlying)} → ${r2(target)} TRX).`,
      action: {
        kind: "withdraw_partial",
        amountTrx: excess.toFixed(),
        amountSun: excess.mul(SUN).toFixed(0),
        method: "redeemUnderlying(uint256)",
        estimatedEnergy: res.partialRes.energy,
        estimatedFeeTrx: partialFee.toDecimalPlaces(6, Decimal.ROUND_UP).toFixed(),
        reason: `목표 배분(${planKo})으로 리밸런스`,
        label: "조정 권고",
      },
      figures,
    };
  }
  if (extra.gt(Decimal.max(MIN_ACTION_TRX, depositFee))) {
    const amount = extra.toDecimalPlaces(6, Decimal.ROUND_DOWN);
    const rate = quote?.baseRate ? new Decimal(quote.baseRate) : new Decimal(0);
    const expected = amount.mul(rate).mul(daysLeft).div(365);
    const economic = expected.gt(depositFee);
    if (!economic) notes.push(`추가 예치의 예상 이자(${expected.toDecimalPlaces(8).toFixed()} TRX)가 예치 수수료(${r2(depositFee)} TRX)보다 작습니다. 순수익은 음수입니다.`);
    return {
      ...base,
      status: "adjust",
      summary:
        input.mode === "rebalance"
          ? `목표 배분(${planKo})에 맞추도록 ${r2(amount)} TRX 추가 예치를 권고합니다 (리밸런스: 예치 ${r2(underlying)} → ${r2(target)} TRX)${economic ? "" : " (예상 이자 < 수수료)"}.`
          : `조건이 완화되어 ${r2(amount)} TRX를 추가로 예치할 수 있습니다${economic ? "" : " (예상 이자 < 수수료)"}.`,
      action: {
        kind: "deposit_more",
        amountTrx: amount.toFixed(),
        amountSun: amount.mul(SUN).toFixed(0),
        method: "mint()",
        estimatedEnergy: res.depositRes.energy,
        estimatedFeeTrx: depositFee.toDecimalPlaces(6, Decimal.ROUND_UP).toFixed(),
        reason: input.mode === "rebalance" ? `목표 배분(${planKo})으로 리밸런스` : "목표 예치액 증가 (여유액 축소 또는 계획 변경)",
        label: "조정 권고",
      },
      figures,
    };
  }
  return {
    ...base,
    status: "hold_position",
    summary: input.mode === "rebalance" ? `이미 목표 배분(${planKo})에 가깝습니다 (차이 ${r2(extra.abs())} TRX). 리밸런스가 필요 없습니다.` : "현재 포지션을 유지해도 됩니다. 지갑 유동성과 수수료 재원이 충분합니다.",
    figures,
  };
}

// ---------------------------------------------------------------- 스테이킹 포지션 조정
// 스테이킹한 TRX는 해제 후 대기 기간이 지나야 쓸 수 있다. 그래서 "돈이 필요한 날 − 해제 대기"보다 늦으면 지출에 못 쓴다.
// 판정 근거: 해제 완료분·미청구 보상·투표하지 않은 투표권, 지출일까지 남은 날과 지갑 잔고, 운용 종료일.

export interface StakingState {
  walletSun: string;
  frozenSun: string;
  tronPower: number;
  votedCount: number;
  withdrawableSun: string;
  rewardSun: string;
  unfreezing: { amountSun: string; expireAt: string }[];
}

export type StakingActionKind = "withdraw_unfrozen" | "claim_reward" | "vote" | "unstake";

export interface StakingAdjustment {
  checkedAt: string;
  status: "adjust" | "hold_position" | "no_position";
  summary: string;
  actions: { kind: StakingActionKind; amountTrx?: string; votes?: number; sr?: string; reason: string; urgent: boolean }[];
  checks: { label: string; ok: boolean; detail: string }[];
}

export function computeStakingAdjustment(input: {
  needs: UserNeeds;
  state: StakingState;
  unfreezeDelayDays: number;
  /** 투표할 SR (계획의 SR 또는 현재 견적의 SR) */
  sr?: string;
  now?: Date;
}): StakingAdjustment {
  const now = input.now ?? new Date();
  const today = todaySeoul(now);
  const s = input.state;
  const toTrx = (sun: string | Decimal) => new Decimal(sun).div(SUN);
  const frozen = toTrx(s.frozenSun);
  const wallet = toTrx(s.walletSun);
  const withdrawable = toTrx(s.withdrawableSun);
  const reward = toTrx(s.rewardSun);
  const unfreezing = s.unfreezing.reduce((a, u) => a.plus(toTrx(u.amountSun)), new Decimal(0));
  const actions: StakingAdjustment["actions"] = [];
  const checks: StakingAdjustment["checks"] = [];
  const delay = input.unfreezeDelayDays;

  if (frozen.lte(0) && unfreezing.lte(0) && withdrawable.lte(0) && reward.lte(0))
    return { checkedAt: now.toISOString(), status: "no_position", summary: "스테이킹 포지션이 없습니다.", actions: [], checks: [] };

  // 1) 해제 대기가 끝난 금액은 바로 인출해야 쓸 수 있다
  checks.push({ label: "해제 완료분", ok: withdrawable.lte(0), detail: withdrawable.gt(0) ? `${withdrawable.toFixed()} TRX 인출 가능` : "없음" });
  if (withdrawable.gt(0)) actions.push({ kind: "withdraw_unfrozen", amountTrx: withdrawable.toFixed(), reason: "해제 대기가 끝난 TRX를 지갑으로 인출합니다.", urgent: true });

  // 2) 지출 대비 유동성: 해제 대기일 안에 오는 지출·여유액은 지금 지갑(+해제 중·완료분)으로 충당돼야 한다
  const end = input.needs.endDate;
  const daysLeft = end ? daysBetween(today, end) : 0;
  const near = input.needs.expenses.filter((e) => e.asset === "TRX" && daysBetween(today, e.date) >= 0 && daysBetween(today, e.date) <= delay + 1);
  const buffer = new Decimal(input.needs.bufferAmount ?? 0);
  const needSoon = near.reduce((a, e) => a.plus(e.amount), buffer);
  const liquid = wallet.plus(withdrawable).plus(unfreezing);
  const shortfall = needSoon.minus(liquid);
  checks.push({
    label: `해제 대기(${delay}일) 안의 지출·여유액`,
    ok: shortfall.lte(0),
    detail: `필요 ${needSoon.toFixed()} TRX / 지갑+해제 중 ${liquid.toDecimalPlaces(6).toFixed()} TRX`,
  });
  // 운용 종료일까지 해제 대기보다 적게 남았으면 전부 해제해야 종료일에 돌려받는다
  const mustExitAll = end !== undefined && daysLeft <= delay + 1;
  checks.push({ label: "운용 종료까지", ok: !mustExitAll, detail: end ? `${Math.max(daysLeft, 0)}일 남음 (해제 대기 ${delay}일)` : "종료일 없음" });
  if (frozen.gt(0) && (mustExitAll || shortfall.gt(0))) {
    const amt = mustExitAll ? frozen : Decimal.min(frozen, shortfall.ceil());
    actions.push({
      kind: "unstake",
      amountTrx: amt.toFixed(),
      reason: mustExitAll
        ? `운용 종료일까지 ${Math.max(daysLeft, 0)}일이라 지금 전부 해제해야 종료일 무렵 돌려받습니다 (해제 대기 ${delay}일).`
        : `${delay}일 안에 필요한 ${needSoon.toFixed()} TRX 중 ${shortfall.toDecimalPlaces(6).toFixed()} TRX가 부족해 그만큼 해제합니다. 해제 대기 뒤 인출할 수 있습니다.`,
      urgent: true,
    });
  }

  // 3) 투표하지 않은 투표권은 보상이 없다
  const unvoted = s.tronPower - s.votedCount;
  checks.push({ label: "투표권 사용", ok: unvoted <= 0, detail: `${s.votedCount.toLocaleString()} / ${s.tronPower.toLocaleString()}표` });
  if (unvoted > 0 && input.sr && !mustExitAll) actions.push({ kind: "vote", votes: s.tronPower, sr: input.sr, reason: `투표하지 않은 ${unvoted.toLocaleString()}표가 있어 보상이 생기지 않습니다. 전체 투표권을 SR에 투표합니다.`, urgent: false });

  // 4) 미청구 보상 (청구는 24시간에 한 번)
  checks.push({ label: "미청구 투표 보상", ok: true, detail: `${reward.toFixed()} TRX` });
  if (reward.gt(0) && (mustExitAll || reward.gte(MIN_ACTION_TRX))) actions.push({ kind: "claim_reward", amountTrx: reward.toFixed(), reason: "쌓인 투표 보상을 지갑으로 청구합니다.", urgent: mustExitAll });

  const urgent = actions.filter((a) => a.urgent);
  return {
    checkedAt: now.toISOString(),
    status: actions.length ? "adjust" : "hold_position",
    summary: urgent.length ? `조정 필요: ${urgent.map((a) => a.reason).join(" ")}` : actions.length ? `권장: ${actions[0].reason}` : "스테이킹 포지션을 유지합니다. 지출·기간 조건에 문제가 없습니다.",
    actions,
    checks,
  };
}
