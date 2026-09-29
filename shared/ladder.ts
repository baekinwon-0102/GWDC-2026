import { Decimal } from "./units";
import { addDays, daysBetween, reservedWithinHorizon } from "./needs";
import { baseYield, jTokenResources, JUSTLEND_RES_SRC, step, stepCosts, swapOut, SYSTEM_TX, SYSTEM_TX_SRC, TYPICAL_RESOURCES, type MainnetInputs } from "./planning";
import type { LadderBucket, Plan, PlanStep, UserNeeds } from "./schemas";

// 인출일별 분산 계획 (계획 L).
// 돈을 "언제 필요한지"로 구간을 나누고, 구간마다 보유·같은 자산 예치·USDD 경로·TRX 스테이킹 중 어디에 둘지 모든 조합을 계산해
// 순수익 합계가 가장 큰 배분을 고른다. 판단은 모두 코드이며 LLM은 결과를 설명만 한다.
//
// - 예치(jUSDT·jTRX)는 왕복 비용이 커서 오래 둬야 이익이 난다. 여러 구간을 넣으면 예치는 한 번, 인출은 날짜마다 따로 든다.
// - 스테이킹은 비용이 거의 없어 짧게 둬도 이익이지만, 인출일보다 해제 대기(14일)+투표 반영 지연만큼 먼저 풀어야 한다.
// - 보유는 비용·수익이 0이다. 어떤 상품도 이익이 없으면 그 구간은 보유가 된다.

type Product = LadderBucket["product"];

interface Bucket {
  label: string;
  amount: Decimal;
  needDay: number;
}

interface ProductModel {
  key: Product;
  label: string;
  /** 이 구간에 넣을 수 있는가 (불가면 사유) */
  allowed: (b: Bucket) => string | undefined;
  /** 구간 하나의 수익 (평가 자산) */
  yieldOf: (b: Bucket) => Decimal;
  /** 이 상품에 배정된 구간들의 거래 단계 (예치는 한 번, 인출은 날짜마다) */
  stepsFor: (bs: Bucket[]) => PlanStep[];
  /** 전환 수수료 등 단계 밖 비용 */
  extraCost: (bs: Bucket[]) => Decimal;
}

const MAX_ENUM_BUCKETS = 7;
const ZERO = new Decimal(0);
const at = (s: PlanStep, day: number): PlanStep => ({ ...s, day, label: `D+${day} ${s.label}` });

export function buildLadderPlan(
  needs: UserNeeds,
  inputs: MainnetInputs,
  singles: { A?: Plan; B?: Plan; C?: Plan },
  base: Pick<Plan, "chain" | "asset" | "inputVersion" | "horizonDays" | "principal" | "label" | "recommended">,
  idPrefix: string,
  now: Date,
): Plan {
  const asset = needs.asset;
  const holdsTrx = asset === "TRX";
  const evalAsset: "USDT" | "TRX" = holdsTrx ? "TRX" : "USDT";
  const days = base.horizonDays;
  const amount = new Decimal(needs.amount ?? 0);
  const reserved = reservedWithinHorizon(needs);
  const basis = inputs.costBasis;

  // ---------------------------------------------------------------- 구간
  const buckets: Bucket[] = [];
  if (reserved.buffer.gt(0)) buckets.push({ label: "비상 여유액 (언제든 인출)", amount: reserved.buffer, needDay: 0 });
  // 같은 날 지출은 합친다
  const byDay = new Map<number, Decimal>();
  for (const e of reserved.inside) {
    const d = daysBetween(needs.startDate, e.date);
    byDay.set(d, (byDay.get(d) ?? ZERO).plus(e.amount));
  }
  for (const [d, amt] of [...byDay.entries()].sort((a, b) => a[0] - b[0])) buckets.push({ label: `${addDays(needs.startDate, d)} 지출`, amount: amt, needDay: d });
  const rest = Decimal.max(amount.minus(reserved.total), 0);
  if (rest.gt(0)) buckets.push({ label: "운용 기간 끝까지 둘 돈", amount: rest, needDay: days });

  // ---------------------------------------------------------------- 상품 모델
  const models: ProductModel[] = [
    { key: "HOLD", label: "보유", allowed: () => undefined, yieldOf: () => ZERO, stepsFor: () => [], extraCost: () => ZERO },
  ];
  const usable = (p?: Plan) => p && p.eligibility !== "ineligible";
  // 쓸 수 없는 상품과 그 사유 (단일 계획의 제외 사유) — "왜 보유인지"를 설명할 때 쓴다
  const unavailable: string[] = [];
  const noteUnusable = (label: string, p?: Plan) => {
    if (p && p.eligibility === "ineligible" && p.reasons[0]) unavailable.push(`${label}: ${p.reasons[0]}`);
  };
  noteUnusable(holdsTrx ? "jTRX 예치" : "jUSDT 예치", singles.A);
  if (!holdsTrx) noteUnusable("USDD 경로", singles.B);
  noteUnusable("TRX 스테이킹", singles.C);

  // 같은 자산 예치 (jUSDT 또는 jTRX)
  const lendQ = holdsTrx ? inputs.jtrx : inputs.jusdt;
  const lendMarket = holdsTrx ? "jTRX" : "jUSDT";
  if (usable(singles.A) && lendQ?.baseRate) {
    const res = jTokenResources(basis, lendMarket);
    const rate = new Decimal(lendQ.baseRate);
    models.push({
      key: "LEND",
      label: `JustLend ${lendMarket} 예치`,
      allowed: (b) => (b.needDay <= 0 ? "바로 쓸 돈이라 예치할 수 없습니다." : undefined),
      yieldOf: (b) => baseYield(b.amount, rate, lendQ.rateType ?? "APY", b.needDay),
      stepsFor: (bs) => {
        const total = bs.reduce((s, b) => s.plus(b.amount), ZERO);
        const steps: PlanStep[] = [];
        if (!holdsTrx) steps.push(at(step("approve", `${asset} 사용 승인 (${lendMarket})`, asset, total, TYPICAL_RESOURCES.approve, JUSTLEND_RES_SRC, lendQ.address), 0));
        steps.push(at(step("supply", `${lendMarket} 예치`, asset, total, res.supply, res.src, lendQ.address), 0));
        for (const [d, amt] of groupByDay(bs)) steps.push(at(step("withdraw", `${lendMarket} 인출 → ${asset}`, asset, amt, res.withdraw, res.src, lendQ.address), d));
        return steps;
      },
      extraCost: () => ZERO,
    });
  }

  // USDD 경로 (USDT 보유자, 동의·성향 허용 시)
  const { jusdd, psm } = inputs;
  const pe = basis?.psmEnergy;
  if (!holdsTrx && usable(singles.B) && jusdd?.baseRate && psm?.psm && pe) {
    const res = jTokenResources(basis, "jUSDD");
    const rate = new Decimal(jusdd.baseRate);
    const feeIn = new Decimal(psm.psm.feeIn);
    const feeOut = new Decimal(psm.psm.feeOut);
    const c = jusdd.rewards.status === "verified" ? jusdd.rewards.campaign : undefined;
    const apr = c && jusdd.rewards.apr ? new Decimal(jusdd.rewards.apr) : ZERO;
    const px = jusdd.underlyingPriceUsd && inputs.jusdt?.underlyingPriceUsd ? new Decimal(jusdd.underlyingPriceUsd).div(inputs.jusdt.underlyingPriceUsd) : new Decimal(1);
    /** 검증된 캠페인 기간 안에서 이 구간이 예치돼 있는 일수 */
    const minedDays = (b: Bucket) => {
      if (!c) return ZERO;
      const from = Math.max(now.getTime(), Date.parse(c.start));
      const to = Math.min(Date.parse(`${addDays(needs.startDate, b.needDay)}T00:00:00+09:00`), Date.parse(c.end));
      return Decimal.max(new Decimal(to - from).div(86_400_000), 0);
    };
    models.push({
      key: "USDD",
      label: "USDD 경로 (PSM → jUSDD)",
      allowed: (b) => (b.needDay <= 0 ? "바로 쓸 돈이라 예치할 수 없습니다." : undefined),
      yieldOf: (b) => {
        const usdd = b.amount.mul(new Decimal(1).minus(feeIn));
        return baseYield(usdd, rate, jusdd.rateType ?? "APY", b.needDay).plus(usdd.mul(px).mul(apr).mul(minedDays(b)).div(365));
      },
      stepsFor: (bs) => {
        const total = bs.reduce((s, b) => s.plus(b.amount), ZERO);
        const steps: PlanStep[] = [
          at(step("approve", "USDT 사용 승인 (PSM)", "USDT", total, TYPICAL_RESOURCES.approve, JUSTLEND_RES_SRC, psm.address), 0),
          at(step("psm_sell", "PSM 전환 USDT → USDD", "USDT", total, { energy: pe.sell, bandwidth: pe.bandwidth?.sell ?? TYPICAL_RESOURCES.psm.bandwidth }, "PSM 실측", psm.address), 0),
          at(step("approve", "USDD 사용 승인 (jUSDD)", "USDD", total, TYPICAL_RESOURCES.approve, JUSTLEND_RES_SRC, jusdd.address), 0),
          at(step("supply", "jUSDD 예치", "USDD", total, res.supply, res.src, jusdd.address), 0),
        ];
        for (const [d, amt] of groupByDay(bs)) {
          steps.push(at(step("withdraw", "jUSDD 인출 → USDD", "USDD", amt, res.withdraw, res.src, jusdd.address), d));
          steps.push(at(step("approve", "USDD 사용 승인 (PSM 출구)", "USDD", amt, TYPICAL_RESOURCES.approve, JUSTLEND_RES_SRC, psm.address), d));
          steps.push(at(step("psm_buy", "PSM 전환 USDD → USDT", "USDD", amt, { energy: pe.buy, bandwidth: pe.bandwidth?.buy ?? TYPICAL_RESOURCES.psm.bandwidth }, "PSM 실측", psm.address), d));
        }
        if (bs.some((b) => minedDays(b).gt(0))) steps.push(at(step("claim", "채굴 보상 청구", "USDD", ZERO, TYPICAL_RESOURCES.claim_rewards, JUSTLEND_RES_SRC), Math.max(...bs.map((b) => b.needDay))));
        return steps;
      },
      extraCost: (bs) => bs.reduce((s, b) => s.plus(b.amount.mul(feeIn)).plus(b.amount.mul(feeOut)), ZERO),
    });
  }

  // TRX 스테이킹. USDT 보유자는 SunSwap V2로 교환해 넣고 인출일마다 되돌린다 (교환 손실은 전환 비용)
  const st = inputs.staking;
  const sw = holdsTrx ? undefined : inputs.swap;
  if (usable(singles.C) && st?.baseRate && st.staking && (holdsTrx || sw)) {
    const s = st.staking;
    const delay = new Decimal(s.unfreezeDelayDays);
    const voteDelay = s.voteDelayDays ? new Decimal(s.voteDelayDays) : new Decimal("0.25");
    const apr = new Decimal(st.baseRate);
    const bw = s.txBandwidth;
    const sys = (bytes?: number) => ({ energy: 0, bandwidth: bytes ?? SYSTEM_TX.bandwidth });
    const src = bw ? "최근 스테이킹 거래 영수증 실측" : SYSTEM_TX_SRC;
    const rewardDays = (b: Bucket) => Decimal.max(new Decimal(b.needDay).minus(delay).minus(voteDelay), 0);
    const rU = sw ? new Decimal(sw.reserveUsdt) : ZERO;
    const rT = sw ? new Decimal(sw.reserveTrx) : ZERO;
    const swapSrc = sw ? `SunSwap V2 라우터 최근 성공 거래 ${sw.costs.sampleSize}건 실측` : "";
    /** USDT 보유자: 배정된 구간 합계를 한 번에 TRX로 바꾸고, 인출일마다 그 몫을 되돌린다 */
    const swapPlan = (bs: Bucket[]) => {
      const total = bs.reduce((s2, b) => s2.plus(b.amount), ZERO);
      const trx = swapOut(total, rU, rT, sw!.feeNumerator);
      const back = groupByDay(bs).map(([d, amt]) => ({ d, trx: trx.mul(amt).div(total).toDecimalPlaces(6, Decimal.ROUND_DOWN) }));
      return { total, trx, back, loss: total.minus(back.reduce((s2, x) => s2.plus(swapOut(x.trx, rT, rU, sw!.feeNumerator)), ZERO)) };
    };
    models.push({
      key: "STAKE",
      label: `TRX 스테이킹 + SR 투표 (${s.srName})`,
      allowed: (b) => (rewardDays(b).lte(0) ? `필요한 날까지 ${b.needDay}일이라 해제 대기 ${delay.toFixed()}일을 빼면 보상 기간이 없습니다.` : undefined),
      // USDT 보유자: 보상(TRX)을 풀 중간 가격으로 환산하면 금액×APR×일수와 같다. 교환 수수료·가격 영향은 extraCost로 뺀다
      yieldOf: (b) => b.amount.mul(apr).mul(rewardDays(b)).div(365),
      stepsFor: (bs) => {
        const total = bs.reduce((s2, b) => s2.plus(b.amount), ZERO);
        const sp = sw ? swapPlan(bs) : undefined;
        const trxTotal = sp ? sp.trx : total;
        const steps: PlanStep[] = [];
        if (sp) {
          steps.push(at(step("approve", "USDT 사용 승인 (SunSwap V2 라우터)", "USDT", total, TYPICAL_RESOURCES.approve, JUSTLEND_RES_SRC, sw!.router), 0));
          steps.push(at(step("swap", "SunSwap V2 교환 USDT → TRX", "USDT", total, sw!.costs.toTrx, swapSrc, sw!.router), 0));
        }
        steps.push(at(step("stake", "TRX 스테이킹 (FreezeBalanceV2)", "TRX", trxTotal, sys(bw?.stake), src), 0), at(step("vote", `SR 투표 (${s.srName})`, "TRX", trxTotal, sys(bw?.vote), src, s.srAddress), 0));
        for (const [d, amt] of groupByDay(bs)) {
          const off = Math.max(0, d - delay.toNumber());
          const trxAmt = sp ? sp.back.find((x) => x.d === d)!.trx : amt;
          steps.push(at(step("unstake", `스테이킹 해제 (${delay.toFixed()}일 뒤 인출 가능)`, "TRX", trxAmt, sys(bw?.unstake), src), off));
          steps.push(at(step("withdraw", "해제 완료분 인출 (WithdrawExpireUnfreeze)", "TRX", trxAmt, sys(bw?.withdrawExpire), src), d));
          if (sp) steps.push(at(step("swap", "SunSwap V2 교환 TRX → USDT", "TRX", trxAmt, sw!.costs.toUsdt, swapSrc, sw!.router), d));
        }
        steps.push(at(step("claim", "투표 보상 청구 (WithdrawBalance)", "TRX", ZERO, sys(bw?.claim), src), Math.max(...bs.map((b) => b.needDay))));
        return steps;
      },
      extraCost: (bs) => (sw ? swapPlan(bs).loss : ZERO),
    });
  }

  // ---------------------------------------------------------------- 조합 탐색
  const costOf = (m: ProductModel, bs: Bucket[]) => {
    if (!bs.length || m.key === "HOLD") return { steps: [] as PlanStep[], cost: ZERO };
    const steps = m.stepsFor(bs);
    const c = stepCosts(steps, basis, evalAsset).inAsset;
    return { steps, cost: c === undefined ? undefined : new Decimal(c).plus(m.extraCost(bs)) };
  };
  const options = buckets.map((b) => models.filter((m) => !m.allowed(b)));
  const evaluate = (assign: ProductModel[]) => {
    let total = ZERO;
    for (const m of models) {
      const bs = buckets.filter((_, i) => assign[i] === m);
      if (!bs.length) continue;
      const { cost } = costOf(m, bs);
      if (cost === undefined) return undefined;
      total = total.plus(bs.reduce((s, b) => s.plus(m.yieldOf(b)), ZERO)).minus(cost);
    }
    return total;
  };
  let best: { assign: ProductModel[]; net: Decimal } | undefined;
  if (buckets.length && buckets.length <= MAX_ENUM_BUCKETS) {
    const idx = buckets.map(() => 0);
    for (;;) {
      const assign = idx.map((k, i) => options[i][k]);
      const net = evaluate(assign);
      const used = new Set(assign.filter((m) => m.key !== "HOLD")).size;
      const bestUsed = best ? new Set(best.assign.filter((m) => m.key !== "HOLD")).size : Infinity;
      // 순수익이 같으면 상품 수가 적은 쪽 (거래가 단순한 쪽)
      if (net !== undefined && (!best || net.gt(best.net) || (net.eq(best.net) && used < bestUsed))) best = { assign, net };
      let i = 0;
      while (i < idx.length && ++idx[i] >= options[i].length) idx[i++] = 0;
      if (i === idx.length) break;
    }
  } else if (buckets.length) {
    // 구간이 많으면 구간마다 단독 순수익이 가장 큰 곳을 고른다 (근사, 예치 비용 공유는 무시)
    const aloneNet = (m: ProductModel, b: Bucket) => {
      const { cost } = costOf(m, [b]);
      return cost === undefined ? undefined : m.yieldOf(b).minus(cost);
    };
    const assign = buckets.map((b, i) =>
      options[i].reduce((bestM, m) => {
        const n = aloneNet(m, b);
        const bn = aloneNet(bestM, b) ?? ZERO;
        return n !== undefined && n.gt(bn) ? m : bestM;
      }, models[0]),
    );
    best = { assign, net: evaluate(assign) ?? ZERO };
  }

  // ---------------------------------------------------------------- 결과
  const assign = best?.assign ?? buckets.map(() => models[0]);
  const steps: PlanStep[] = [];
  let yieldSum = ZERO;
  let invested = ZERO;
  let extra = ZERO;
  for (const m of models) {
    const bs = buckets.filter((_, i) => assign[i] === m);
    if (!bs.length || m.key === "HOLD") continue;
    steps.push(...costOf(m, bs).steps);
    yieldSum = yieldSum.plus(bs.reduce((s, b) => s.plus(m.yieldOf(b)), ZERO));
    invested = invested.plus(bs.reduce((s, b) => s.plus(b.amount), ZERO));
    extra = extra.plus(m.extraCost(bs));
  }
  steps.sort((a, b) => (a.day ?? 0) - (b.day ?? 0));
  const costs = stepCosts(steps, basis, evalAsset, extra);
  const net = best?.net;
  const r4 = (d: Decimal) => d.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed();

  const ladder: LadderBucket[] = buckets.map((b, i) => {
    const m = assign[i];
    const alternatives = models
      .filter((x) => x.key !== "HOLD")
      .map((x) => {
        const why = x.allowed(b);
        if (why) return { product: x.label, note: why };
        const { cost } = costOf(x, [b]);
        return { product: x.label, netAlone: cost === undefined ? undefined : r4(x.yieldOf(b).minus(cost)) };
      });
    const y = m.yieldOf(b);
    const why =
      m.key === "HOLD"
        ? b.needDay <= 0
          ? "언제든 꺼낼 수 있어야 하는 돈이라 보유합니다."
          : alternatives.length
            ? `${b.needDay}일 동안 넣어도 이자가 추가 거래비용보다 작아 보유가 유리합니다.`
            : `넣을 수 있는 상품이 없어 보유합니다${unavailable.length ? ` (${unavailable[0]})` : ""}.`
        : `${b.needDay}일 동안 ${m.label}에 넣으면 ${r4(y)} ${asset}의 수익이 납니다${buckets.filter((_, j) => assign[j] === m).length > 1 ? " (다른 구간과 같은 상품이라 예치 비용을 한 번만 냅니다)" : ""}.`;
    return {
      label: b.label,
      amount: b.amount.toFixed(),
      needDay: b.needDay,
      needDate: addDays(needs.startDate, b.needDay),
      product: m.key,
      productLabel: m.label,
      yield: r4(y),
      alternatives,
      why,
    };
  });

  const usedProducts = [...new Set(assign.filter((m) => m.key !== "HOLD").map((m) => m.label))];
  const reasons: string[] = [];
  if (!usedProducts.length) reasons.push(models.length > 1 ? "어느 구간도 거래비용을 넘는 수익이 나지 않아 모두 보유합니다." : "지금 넣을 수 있는 상품이 없어 모두 보유합니다.");
  reasons.push(...unavailable.map((u) => `쓰지 않은 상품 — ${u}`));
  if (buckets.length > MAX_ENUM_BUCKETS) reasons.push(`구간이 ${buckets.length}개라 모든 조합 대신 구간별 최선으로 근사했습니다.`);
  const riskClass: Plan["riskClass"] = assign.some((m) => m.key === "STAKE") && !holdsTrx ? "volatile" : assign.some((m) => m.key === "USDD") ? "stable_conversion" : "stable";

  return {
    ...base,
    id: `${idPrefix}-L`,
    key: "L",
    riskClass,
    title: "L. 인출일별 분산 (기간별 배분)",
    allocation: { invested: invested.toFixed(), held: amount.minus(invested).toFixed() },
    steps,
    baseYield: yieldSum.toFixed(),
    rewards: { status: "none", note: "USDD 경로의 검증된 채굴 보상은 구간 수익에 포함했습니다." },
    costs,
    netReturn: net?.toFixed(),
    eligibility: net === undefined ? "conditional" : "eligible",
    reasons,
    risks: ["구간마다 인출 날짜에 맞춰 거래해야 합니다", "금리 변동", "스마트 계약 위험", ...(assign.some((m) => m.key === "STAKE") ? ["스테이킹 해제는 인출일 14일 전에 해야 합니다"] : [])],
    assumptions: [
      "돈이 필요한 날짜별로 구간을 나누고, 구간마다 보유·예치·USDD 경로·스테이킹의 모든 조합을 계산해 순수익 합계가 가장 큰 배분을 골랐습니다.",
      "같은 상품에 여러 구간을 넣으면 예치 거래는 한 번, 인출 거래는 날짜마다 따로 계산했습니다.",
      "조회 시점 금리가 유지된다고 가정합니다 (보장 아님).",
      ...(usedProducts.length ? [`사용 상품: ${usedProducts.join(", ")}`] : []),
    ],
    quoteIds: [],
    dataModes: [],
    ladder,
  };
}

function groupByDay(bs: { amount: Decimal; needDay: number }[]): [number, Decimal][] {
  const m = new Map<number, Decimal>();
  for (const b of bs) m.set(b.needDay, (m.get(b.needDay) ?? new Decimal(0)).plus(b.amount));
  return [...m.entries()].sort((a, b) => a[0] - b[0]);
}
