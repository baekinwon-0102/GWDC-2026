import { useEffect, useRef, useState } from "react";
import type { Update } from "../../App";
import { api, type Health, type ObserveResponse } from "../../lib/api";
import type { PersistedState } from "../../lib/storage";
import { BroadcastRejected, BroadcastUnknown, connect, currentWallet, hasTronLink, signAndSend, signAndSendSystem, SignRejected, type SystemAction, type WalletInfo } from "../../lib/tronlink";
import { addDays, daysBetween, emptyNeeds, missingFields, todaySeoul } from "../../../shared/needs";
import { nileResources, SYSTEM_TX } from "../../../shared/planning";
import { Decimal, sunToTrx, trxToSun } from "../../../shared/units";
import { CALL_ACTION_KO, TX_KIND_KO, type ActionPreview, type CallAction, type CallPurpose, type CostBasis, type ChatMessage, type ExecutionRecord, type Plan, type RiskProfile, type TxKind, type TxStatus, type UserNeeds } from "../../../shared/schemas";
import { computeStakingAdjustment, type NileAdjustment } from "../../../shared/adjust";
import { ModeBadge, pct, SourceLine, Stepper, timeKo, Tip, WarnBadge } from "../common";
import { Modal, PlanCard, ProgressDots } from "../ui";
import { COST_MODE_KO, ENERGY_MODE_KO, type CostMode, type EnergyMode } from "../../../shared/costmode";

const FEE_LIMIT_SUN = 50_000_000n; // 50 TRX 상한
const PREVIEW_TTL_MS = 3 * 60 * 1000;
const IN_FLIGHT: TxStatus[] = ["awaiting_signature", "submitted", "pending", "unknown"];
const SYSTEM_KINDS: TxKind[] = ["stake", "vote", "unstake", "withdraw_unfrozen", "claim_reward"];
const SYSTEM_CONTRACT: Record<string, string> = {
  stake: "FreezeBalanceV2Contract",
  vote: "VoteWitnessContract",
  unstake: "UnfreezeBalanceV2Contract",
  withdraw_unfrozen: "WithdrawExpireUnfreezeContract",
  claim_reward: "WithdrawBalanceContract",
};
const isSystem = (k: TxKind) => SYSTEM_KINDS.includes(k);
const NILE_WELCOME = "Nile 테스트넷 조건을 말씀해 주세요. 예: \"100 TRX를 30일 운용하고 7일 뒤에 20 TRX를 써요. 여유액 10, 균형형\"";
const NILE_CHIPS = [
  "100 TRX를 30일 운용하고 7일 뒤에 20 TRX를 써요. 여유액은 10 TRX, 균형형이에요.",
  "2,000 TRX를 10일 운용하고 3일 뒤 500 TRX를 써요. 여유액 없음, 공격적",
  "1,000 TRX를 30일 운용해요. 지출·여유액 없음, 공격적이고 USDD 위험은 감수할게요",
  "지출은 없어요",
  "USDD 위험은 감수할게요",
];
type Outcome = { ok: boolean; txId?: string; unknown?: boolean; error?: string };

const RISK_OPTIONS: [RiskProfile, string][] = [
  ["conservative", "보수적"],
  ["balanced", "균형형"],
  ["aggressive", "공격적"],
];

/** 계획 단계 → Nile 거래 종류. 보유·승인·교환은 Nile에서 서명할 거래가 아니다 (TRX 보유자는 교환이 없다) */
function stepKind(p: Plan, i: number): TxKind | undefined {
  const s = p.steps[i];
  // USDD 경로(계획 B)의 교환·승인·PSM·jUSDD는 서버가 만든 계약 호출로 실행한다
  if (callOf(p, i)) return "call";
  if (s.action === "supply") return "deposit";
  if (s.action === "withdraw") return s.contract ? "withdraw" : "withdraw_unfrozen";
  if (s.action === "stake") return "stake";
  if (s.action === "vote") return "vote";
  if (s.action === "unstake") return "unstake";
  if (s.action === "claim") return "claim_reward";
  return undefined;
}

/** 계획 B 단계 → 서버 호출 종류 (승인은 받는 쪽 계약으로 목적을 정한다) */
function callOf(p: Plan, i: number): { action: CallAction; amountTrx?: string; purpose?: CallPurpose } | undefined {
  const s = p.steps[i];
  if (p.key !== "B") return undefined;
  const bridge = /브리지/.test(s.label);
  if (s.action === "swap") return s.asset === "TRX" ? { action: "swap_trx_in", amountTrx: s.amount } : { action: "swap_trx_out" };
  if (s.action === "psm_sell") return { action: bridge ? "bridge_out" : "psm_sell" };
  if (s.action === "psm_buy") return { action: bridge ? "bridge_in" : "psm_buy" };
  if (s.action === "supply" && s.asset === "USDD") return { action: "supply_usdd" };
  if (s.action === "withdraw" && s.asset === "USDD") return { action: "withdraw_usdd" };
  if (s.action === "approve") {
    if (/브리지 PSM 출구/.test(s.label)) return { action: "approve", purpose: "bridge_out" };
    if (bridge) return { action: "approve", purpose: "bridge_in" };
    if (/라우터/.test(s.label)) return { action: "approve", purpose: "router" };
    if (/jUSDD/.test(s.label)) return { action: "approve", purpose: "jusdd" };
    return { action: "approve", purpose: s.asset === "USDD" ? "psm_buy" : "psm_sell" };
  }
  return undefined;
}

export default function NileExecution({ state, update, health, notify, goLog }: { state: PersistedState; update: Update; health?: Health; notify: (m: string) => void; goLog: () => void }) {
  const [wallet, setWallet] = useState<WalletInfo | undefined>(() => currentWallet());
  const [obs, setObs] = useState<ObserveResponse>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [devAck, setDevAck] = useState(false);
  const [form, setForm] = useState({ total: "100", days: "30", reserve: "20" });
  const [risk, setRisk] = useState<RiskProfile>("balanced");
  /** USDD 경로(계획 B: TRX→USDT 교환 → PSM → jUSDD)의 USDD 가격 위험 수용 여부. 기본은 감수하지 않음 */
  const [usddRisk, setUsddRisk] = useState(false);
  /** 운용 중 지출 (D+일수, TRX). 인출일별 분산(L)이 이 날짜로 구간을 나눈다 */
  const [exps, setExps] = useState<{ day: string; amount: string; asset?: string }[]>([{ day: "", amount: "" }]);
  /** 비용 가정: Energy 조달 방식과 비용 기준 */
  const [energySrc, setEnergySrc] = useState<EnergyMode>("burn");
  const [costMode, setCostMode] = useState<CostMode>("max");
  const [inputMode, setInputMode] = useState<"chat" | "form">("chat");
  const [editNeeds, setEditNeeds] = useState(false);
  const [walletOpen, setWalletOpen] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const chat: ChatMessage[] = state.nile.chat ?? [{ role: "assistant", content: NILE_WELCOME }];

  /** 대화로 모은 초안을 폼에 반영한다 (지갑이 연결돼 있으면 보유액은 실제 잔고를 쓴다) */
  function syncForm(d: UserNeeds) {
    setForm((f) => ({
      total: wallet && obs ? f.total : d.amount ?? f.total,
      days: d.endDate ? String(daysBetween(d.startDate, d.endDate)) : f.days,
      reserve: d.bufferAmount ?? f.reserve,
    }));
    if (d.expensesStated) setExps(d.expenses.length ? d.expenses.map((e) => ({ day: String(daysBetween(d.startDate, e.date)), amount: e.amount, asset: e.asset })) : [{ day: "", amount: "" }]);
    if (d.riskProfile) setRisk(d.riskProfile);
    if (d.acceptUsddRisk !== undefined) setUsddRisk(d.acceptUsddRisk);
  }

  /** Mainnet과 같은 대화 추출(/api/chat)을 Nile 요구사항에 쓴다. LLM은 입력만 뽑고 누락 질문은 코드가 정한다 */
  async function sendChat(text: string) {
    const t = text.trim();
    if (!t || chatBusy) return;
    setChatInput("");
    setChatBusy(true);
    const draft = nile.draft && nile.draft.startDate === todaySeoul() ? nile.draft : emptyNeeds("nile");
    const history = [...chat, { role: "user" as const, content: t.slice(0, 2000) }];
    update((s) => ({ ...s, nile: { ...s.nile, chat: history } }));
    try {
      const lastAsked = missingFields(draft)[0];
      const r = await api.chat(history.slice(-12), draft, lastAsked);
      syncForm(r.needs);
      const tail = !r.missing.length && !r.problems.length ? "\n\n오른쪽 폼에 반영했어요. 확인 후 '이대로 확인하고 Nile 계획 계산'을 눌러 주세요." : "";
      update((s) => ({ ...s, nile: { ...s.nile, draft: r.needs, chat: [...history, { role: "assistant", content: r.reply + tail }] } }));
    } catch (e) {
      update((s) => ({ ...s, nile: { ...s.nile, chat: [...history, { role: "assistant", content: `요청을 처리하지 못했어요: ${(e as Error).message}. 폼으로 직접 입력해 주세요.` }] } }));
    } finally {
      setChatBusy(false);
    }
  }

  const nile = state.nile;
  const result = nile.result;
  const preview = nile.preview;
  const inFlight = nile.records.find((r) => IN_FLIGHT.includes(r.status));
  const execEnabled = health?.config.enableNileExecution ?? false;

  // TronLink 계정·네트워크 변경 감지
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const action = e.data?.message?.action;
      if (action === "accountsChanged" || action === "setAccount" || action === "setNode" || action === "connect" || action === "disconnect") {
        setTimeout(() => setWallet(currentWallet()), 300);
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  // 지갑이 바뀌면 미리보기를 무효화한다
  useEffect(() => {
    if (preview && wallet && preview.wallet !== wallet.address) {
      update((s) => ({ ...s, nile: { ...s.nile, preview: undefined } }));
      setError("지갑 계정이 바뀌어 거래 미리보기를 무효화했습니다.");
    }
  }, [wallet?.address]); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshObs = async (w = wallet) => {
    if (!w || w.network !== "nile") return undefined;
    const r = await api.observe(w.address, nile.selectedPlanId);
    setObs(r);
    setForm((f) => ({ ...f, total: new Decimal(sunToTrx(r.snapshot.balanceSun)).toDecimalPlaces(2, Decimal.ROUND_DOWN).toFixed() }));
    return r;
  };

  useEffect(() => {
    if (wallet?.network === "nile") refreshObs().catch((e) => setError(e.message));
  }, [wallet?.address, wallet?.network]); // eslint-disable-line react-hooks/exhaustive-deps

  // 미확정 거래 재조회는 App의 useTxPolling이 어느 탭에서든 맡는다. 확정으로 관측이 새로 쌓이면 지갑 상태도 다시 읽는다.
  useEffect(() => {
    if (nile.observations.length && wallet?.network === "nile") refreshObs().catch(() => undefined);
  }, [nile.observations.length]); // eslint-disable-line react-hooks/exhaustive-deps

  async function onConnect() {
    setError(undefined);
    try {
      const w = await connect();
      setWallet(w);
      if (w.network !== "nile") setError("TronLink 네트워크가 Nile 테스트넷이 아닙니다. TronLink에서 Nile로 전환해 주세요.");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const validExps = exps.filter((e) => /^\d+$/.test(e.day) && /^\d+(\.\d+)?$/.test(e.amount) && Number(e.amount) > 0);
  const expsInvalid = exps.some((e) => (e.day || e.amount) && !validExps.includes(e)) || validExps.some((e) => Number(e.day) < 1 || Number(e.day) > (Number(form.days) || 0));

  async function makePlans() {
    setError(undefined);
    setBusy("plans");
    const today = todaySeoul();
    const needs: UserNeeds = {
      chain: "nile",
      asset: "TRX",
      amount: new Decimal(form.total || 0).toFixed(),
      startDate: today,
      endDate: addDays(today, Number(form.days) || 30),
      expenses: validExps.map((e, i) => ({ id: `nx${i}`, date: addDays(today, Number(e.day)), amount: new Decimal(e.amount).toFixed(), asset: e.asset ?? "TRX", label: `D+${e.day} 지출` })),
      energySource: energySrc,
      costBasisMode: costMode,
      expensesStated: true,
      bufferAmount: new Decimal(form.reserve || 0).toFixed(),
      riskProfile: risk,
      acceptUsddRisk: usddRisk,
      timezone: "Asia/Seoul",
      version: (nile.needs?.version ?? 0) + 1,
    };
    try {
      const r = await api.plans(needs, wallet?.network === "nile" ? wallet.address : undefined);
      update((s) => ({ ...s, nile: { ...s.nile, needs, result: r, selectedPlanId: undefined, preview: undefined } }));
      setEditNeeds(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  /**
   * 거래 미리보기. 계획 실행(예치·전액 인출)과 포지션 조정(추가 예치·부분 인출·전액 인출)이 같은 경로를 쓴다.
   * opts.amountSun: 예치·부분 인출 금액(TRX sun). 없으면 예치는 계획 예치액, 인출은 jTRX 전량.
   */
  async function buildPreview(
    planId: string,
    kind: "deposit" | "withdraw",
    opts: { amountSun?: bigint; partial?: boolean; origin?: "plan" | "adjust"; reason?: string; step?: number; stepDay?: number } = {},
    silent = false,
  ): Promise<ActionPreview | undefined> {
    if (!silent) {
      setError(undefined);
      setDevAck(false);
    }
    if (!wallet || wallet.network !== "nile") {
      if (silent) throw new Error("Nile 네트워크의 TronLink 지갑을 먼저 연결하세요.");
      setError("Nile 네트워크의 TronLink 지갑을 먼저 연결하세요.");
      return undefined;
    }
    const plan = result?.plans.find((p) => p.id === planId);
    if (!silent) setBusy("preview");
    try {
      const o = await refreshObs();
      if (!o) throw new Error("지갑 상태를 읽지 못했습니다.");
      const s = o.snapshot;
      // 체인 실측 Energy가 있으면 쓴다 (인출은 일반값보다 훨씬 크다)
      const r = nileResources({ jtrxEnergy: s.jtrxEnergy });
      const res = kind === "deposit" ? r.depositRes : opts.partial ? r.partialRes : r.withdrawRes;
      const feeSun = BigInt(res.energy * s.energyFeeSun + res.bandwidth * s.bandwidthFeeSun);
      if (feeSun > FEE_LIMIT_SUN) throw new Error(`예상 수수료 ${sunToTrx(feeSun)} TRX가 수수료 상한 ${sunToTrx(FEE_LIMIT_SUN)} TRX를 넘습니다.`);
      let amountSun: bigint;
      let amountDisplay: string;
      let method: string;
      if (kind === "deposit") {
        amountSun = opts.amountSun ?? (plan ? trxToSun(new Decimal(plan.allocation.invested).toDecimalPlaces(6, Decimal.ROUND_DOWN).toFixed()) : 0n);
        amountDisplay = `${sunToTrx(amountSun)} TRX${opts.origin === "adjust" ? " (추가 예치)" : ""}`;
        method = "mint()";
        if (amountSun <= 0n) throw new Error("예치 금액이 0입니다.");
        if (BigInt(s.balanceSun) < amountSun + feeSun) throw new Error(`잔고 부족: ${sunToTrx(s.balanceSun)} TRX < 예치 ${sunToTrx(amountSun)} + 예상 수수료 ${sunToTrx(feeSun)} TRX`);
      } else if (opts.partial) {
        amountSun = opts.amountSun ?? 0n; // redeemUnderlying은 기초자산 TRX(sun) 수량
        amountDisplay = `${sunToTrx(amountSun)} TRX (부분 인출)`;
        method = "redeemUnderlying(uint256)";
        if (amountSun <= 0n) throw new Error("부분 인출 금액이 0입니다.");
        if (BigInt(s.underlyingSun) < amountSun) throw new Error(`포지션 가치 ${sunToTrx(s.underlyingSun)} TRX가 인출액보다 작습니다.`);
        if (BigInt(s.marketCashSun) < amountSun) throw new Error(`jTRX 시장 현금 ${sunToTrx(s.marketCashSun)} TRX가 인출액보다 작습니다.`);
        if (BigInt(s.balanceSun) < feeSun) throw new Error(`수수료 잔고 부족: ${sunToTrx(s.balanceSun)} TRX < ${sunToTrx(feeSun)} TRX`);
      } else {
        amountSun = BigInt(s.jTokenBalance); // redeem은 jToken 수량(1e8 단위)
        amountDisplay = `jTRX ${o.observation.balances.find((b) => b.asset === "jTRX")?.amount} (≈ ${o.observation.underlyingValue} TRX)`;
        method = "redeem(uint256)";
        if (amountSun <= 0n) throw new Error("인출할 jTRX 포지션이 없습니다.");
        if (BigInt(s.balanceSun) < feeSun) throw new Error(`수수료 잔고 부족: ${sunToTrx(s.balanceSun)} TRX < ${sunToTrx(feeSun)} TRX`);
      }
      const now = Date.now();
      const early = opts.stepDay !== undefined && opts.stepDay > elapsedDays();
      const p: ActionPreview = {
        id: `pv-${now}`,
        planId,
        kind,
        step: opts.step,
        stepDay: opts.stepDay,
        early,
        origin: opts.origin ?? "plan",
        partial: opts.partial,
        wallet: wallet.address,
        chain: "nile",
        asset: "TRX",
        amountSun: amountSun.toString(),
        amountDisplay,
        contract: s.contract,
        method,
        approval: "없음 (네이티브 TRX는 토큰 승인이 필요 없습니다)",
        estimatedEnergy: res.energy,
        estimatedFeeTrx: sunToTrx(feeSun),
        feeLimitSun: FEE_LIMIT_SUN.toString(),
        risks: [
          ...(opts.origin === "adjust" ? [`포지션 조정 거래입니다: ${opts.reason ?? "조건 변화"}`] : []),
          "Nile 테스트넷 거래이며 테스트 TRX는 실제 가치가 없습니다.",
          "스마트 계약 위험: 계약 오류나 일시 중지 시 인출이 지연될 수 있습니다.",
          `실제 Energy 사용량은 예상(${s.jtrxEnergy ? `최근 거래 실측 최대 ${res.energy.toLocaleString()}` : "일반값"})과 다를 수 있으며 수수료 상한까지 소각될 수 있습니다.`,
          ...(plan?.netReturn !== undefined && Number(plan.netReturn) <= 0 && opts.origin !== "adjust" ? [`이 계획의 예상 순수익은 ${plan.netReturn} TRX입니다 (0 이하).`] : []),
          ...(early ? [`계획상 D+${opts.stepDay} 단계를 오늘(D+${elapsedDays()}) 앞당겨 실행합니다 (테스트 목적).`] : []),
        ],
        createdAt: new Date(now).toISOString(),
        validUntil: new Date(now + PREVIEW_TTL_MS).toISOString(),
        snapshot: { balanceSun: s.balanceSun, jTokenBalance: s.jTokenBalance, energyFeeSun: s.energyFeeSun, contractVerified: s.contractVerified, underlyingSun: s.underlyingSun },
      };
      if (!s.contractVerified) throw new Error(`jTRX 계약 확인 실패 (${s.contractName ?? "코드 없음"}). 거래를 만들지 않습니다.`);
      if (!silent) update((st) => ({ ...st, nile: { ...st.nile, preview: p, selectedPlanId: planId } }));
      return p;
    } catch (e) {
      if (silent) throw e;
      setError((e as Error).message);
    } finally {
      if (!silent) setBusy(undefined);
    }
    return undefined;
  }

  /** 화면의 "확인했습니다 — 서명" 버튼 (단건 미리보기: 포지션 조정 등) */
  function execute() {
    if (preview) void executePreview(preview);
  }

  /** 미리보기 하나를 서명·제출한다. 결과(txID·성공 여부)를 돌려줘 예치/인출 실행기가 다음 단계로 넘어갈지 정한다 */
  async function executePreview(preview: ActionPreview, opts: { ackEarly?: boolean; runner?: boolean } = {}): Promise<Outcome> {
    setError(undefined);
    const fail = (msg: string): Outcome => {
      setError(msg);
      return { ok: false, error: msg };
    };
    const invalidate = (why: string) => {
      update((s) => ({ ...s, nile: { ...s.nile, preview: undefined } }));
      setError(`미리보기를 무효화했습니다: ${why} 다시 확인해 주세요.`);
      return { ok: false, error: why } as Outcome;
    };
    if (!execEnabled) return fail("ENABLE_NILE_EXECUTION=false 입니다. .env.local에서 true로 바꾸고 API를 재시작하세요.");
    if (inFlight && !opts.runner) return fail("확정되지 않은 거래가 있습니다. 먼저 결과를 확인하세요 (중복 거래 방지).");
    if (Date.now() > Date.parse(preview.validUntil)) return invalidate("유효 시간이 지났습니다.");
    if (preview.early && !devAck && !opts.ackEarly) return fail("예정일 전 실행(테스트)임을 확인해 주세요.");
    if (isSystem(preview.kind)) return executeSystem(preview, invalidate);
    if (preview.kind === "call") return executeCall(preview, invalidate);

    setBusy("sign");
    // 서명 직전 체인·계정·금액·계약·비용을 다시 읽는다
    const w = currentWallet();
    if (!w || w.address !== preview.wallet) return setBusy(undefined), invalidate("지갑 계정이 바뀌었습니다.");
    if (w.network !== "nile") return setBusy(undefined), invalidate("TronLink 네트워크가 Nile이 아닙니다.");
    let fresh: ObserveResponse;
    try {
      fresh = await api.observe(w.address, preview.planId);
    } catch (e) {
      setBusy(undefined);
      return fail(`재확인 조회 실패: ${(e as Error).message}`);
    }
    const s = fresh.snapshot;
    const feeSun = trxToSun(preview.estimatedFeeTrx);
    if (!s.contractVerified || s.contract !== preview.contract) return setBusy(undefined), invalidate("대상 계약 확인이 달라졌습니다.");
    if (s.energyFeeSun !== preview.snapshot.energyFeeSun) return setBusy(undefined), invalidate(`Energy 단가가 바뀌었습니다 (${preview.snapshot.energyFeeSun} → ${s.energyFeeSun}).`);
    if (preview.kind === "deposit" && BigInt(s.balanceSun) < BigInt(preview.amountSun) + feeSun) return setBusy(undefined), invalidate("잔고가 부족해졌습니다.");
    if (preview.kind === "withdraw" && !preview.partial && BigInt(s.jTokenBalance) !== BigInt(preview.amountSun)) return setBusy(undefined), invalidate("jTRX 잔고가 바뀌었습니다.");
    if (preview.kind === "withdraw" && preview.partial) {
      if (BigInt(s.underlyingSun) < BigInt(preview.amountSun)) return setBusy(undefined), invalidate("포지션 가치가 인출액보다 작아졌습니다.");
      if (BigInt(s.marketCashSun) < BigInt(preview.amountSun)) return setBusy(undefined), invalidate("jTRX 시장 현금이 인출액보다 작아졌습니다.");
    }
    if (preview.kind === "withdraw" && BigInt(s.balanceSun) < feeSun) return setBusy(undefined), invalidate("수수료 잔고가 부족해졌습니다.");

    const rec: ExecutionRecord = {
      id: `ex-${Date.now()}`,
      planId: preview.planId,
      previewId: preview.id,
      kind: preview.kind,
      chain: "nile",
      wallet: preview.wallet,
      status: "awaiting_signature",
      amountDisplay: preview.amountDisplay,
      // 예치·부분 인출은 TRX 수량을 남겨 예상 vs 실제 비교에 쓴다 (전액 인출은 jToken 수량이라 비움)
      amountTrx: preview.kind === "deposit" || preview.partial ? sunToTrx(preview.amountSun) : undefined,
      partial: preview.partial,
      origin: preview.origin,
      step: preview.step,
      stepDay: preview.stepDay,
      plannedRate: rateFor(preview.kind),
    };
    const patchRec = (p: Partial<ExecutionRecord>) =>
      update((st) => ({ ...st, nile: { ...st.nile, records: st.nile.records.map((r) => (r.id === rec.id ? { ...r, ...p } : r)) } }));
    update((st) => ({ ...st, nile: { ...st.nile, records: [...st.nile.records, rec], preview: undefined } }));

    let sentTx: string | undefined;
    try {
      await signAndSend({
        contract: preview.contract,
        method: preview.method,
        params: preview.kind === "withdraw" ? [{ type: "uint256", value: preview.amountSun }] : [],
        callValueSun: preview.kind === "deposit" ? BigInt(preview.amountSun) : 0n,
        feeLimitSun: BigInt(preview.feeLimitSun),
        from: preview.wallet,
        // txID를 받는 즉시 저장한다 (방송 결과를 모르더라도 같은 txID를 조회하기 위해)
        onSigned: (txId) => ((sentTx = txId), patchRec({ txId, status: "unknown", submittedAt: new Date().toISOString() })),
      });
      patchRec({ status: "submitted" });
      notify("거래를 제출했습니다. 확정 영수증을 확인하는 중입니다.");
      return { ok: true, txId: sentTx };
    } catch (e) {
      if (e instanceof SignRejected) patchRec({ status: "rejected", error: e.message });
      else if (e instanceof BroadcastRejected) patchRec({ status: "failed", error: e.message });
      else if (e instanceof BroadcastUnknown) patchRec({ status: "unknown", error: e.message });
      else patchRec({ status: "failed", error: (e as Error).message });
      return { ok: false, unknown: e instanceof BroadcastUnknown, txId: sentTx, error: (e as Error).message };
    } finally {
      setBusy(undefined);
    }
  }

  /** 거래 종류에 맞는 계획 금리 (jTRX 예치·인출은 jTRX, 스테이킹 계열은 투표자 APR) */
  function rateFor(k: TxKind) {
    return result?.quotes.find((q) => (isSystem(k) ? q.kind === "staking" : q.market === "jTRX"))?.baseRate;
  }

  /** 계획 시작일로부터 지난 일수 (계획 단계의 D+n과 비교) */
  function elapsedDays() {
    return nile.needs ? Math.max(0, daysBetween(nile.needs.startDate, todaySeoul())) : 0;
  }

  /**
   * Stake 2.0 시스템 거래 미리보기 (스테이킹·투표·해제·해제분 인출·보상 청구).
   * 금액은 계획 단계 값이지만 실제 지갑 상태(잔고·동결액·투표권·인출 가능액·미청구 보상)로 다시 검증한다.
   */
  async function buildSystemPreview(
    kind: TxKind,
    o: { planId: string; plan?: Plan; amountTrx?: string; sr?: string; srLabel?: string; step?: number; stepDay?: number; origin?: "plan" | "adjust"; reason?: string; silent?: boolean },
  ): Promise<ActionPreview | undefined> {
    const silent = Boolean(o.silent);
    if (!silent) {
      setError(undefined);
      setDevAck(false);
    }
    if (!wallet || wallet.network !== "nile") {
      if (silent) throw new Error("Nile 네트워크의 TronLink 지갑을 먼저 연결하세요.");
      setError("Nile 네트워크의 TronLink 지갑을 먼저 연결하세요.");
      return undefined;
    }
    if (!silent) setBusy("preview");
    try {
      const ob = await refreshObs();
      if (!ob) throw new Error("지갑 상태를 읽지 못했습니다.");
      const s = ob.snapshot;
      const k = s.staking;
      if (!k) throw new Error("스테이킹 상태를 읽지 못했습니다. 잠시 뒤 다시 시도하세요.");
      // 시스템 거래는 Energy 없이 대역폭만 쓴다. 무료 대역폭이 모자라면 bytes × 단가만큼 TRX가 소각된다
      const feeSun = BigInt(SYSTEM_TX.bandwidth * s.bandwidthFeeSun);
      const stepSun = trxToSun(new Decimal(o.amountTrx ?? 0).toDecimalPlaces(6, Decimal.ROUND_DOWN).toFixed());
      let amountSun = 0n;
      let amountDisplay = "";
      let sr: string | undefined;
      let votes: number | undefined;
      if (kind === "stake") {
        amountSun = (stepSun / 1_000_000n) * 1_000_000n; // 투표권은 1 TRX 단위라 정수 TRX만 스테이킹한다
        if (amountSun < 1_000_000n) throw new Error("스테이킹은 1 TRX 이상이어야 합니다.");
        if (BigInt(s.balanceSun) < amountSun + feeSun) throw new Error(`잔고 부족: ${sunToTrx(s.balanceSun)} TRX < 스테이킹 ${sunToTrx(amountSun)} + 예상 수수료 ${sunToTrx(feeSun)} TRX`);
        amountDisplay = `${sunToTrx(amountSun)} TRX 스테이킹 (대역폭 자원, 1 TRX = 1표)`;
      } else if (kind === "vote") {
        sr = o.sr;
        if (!sr) throw new Error("투표할 SR 주소가 없습니다.");
        votes = k.tronPower;
        if (votes < 1) throw new Error("투표권이 없습니다. 스테이킹 거래가 확정된 뒤 투표하세요.");
        amountDisplay = `${votes.toLocaleString()}표 → ${o.srLabel ?? sr}`;
      } else if (kind === "unstake") {
        const frozen = BigInt(k.frozenSun);
        if (frozen <= 0n) throw new Error("스테이킹된 TRX가 없습니다.");
        amountSun = stepSun > frozen ? frozen : stepSun;
        amountDisplay = `${sunToTrx(amountSun)} TRX 해제 (해제 대기 뒤 인출 가능)`;
      } else if (kind === "withdraw_unfrozen") {
        amountSun = BigInt(k.withdrawableSun);
        if (amountSun <= 0n) {
          const next = k.unfreezing[0];
          throw new Error(next ? `아직 해제 대기 중입니다: ${sunToTrx(next.amountSun)} TRX는 ${new Date(next.expireAt).toLocaleString("ko-KR")}부터 인출할 수 있습니다.` : "해제 대기가 끝난 금액이 없습니다. 먼저 스테이킹 해제를 실행하세요.");
        }
        amountDisplay = `${sunToTrx(amountSun)} TRX 인출 (해제 완료분 전체)`;
      } else {
        amountSun = BigInt(k.rewardSun);
        if (amountSun <= 0n) throw new Error("청구할 투표 보상이 없습니다. 투표 후 유지보수 주기가 지나야 보상이 쌓이며, 청구는 24시간에 한 번만 됩니다.");
        amountDisplay = `${sunToTrx(amountSun)} TRX 보상 청구`;
      }
      if (BigInt(s.balanceSun) < feeSun && kind !== "stake") throw new Error(`수수료 잔고 부족: ${sunToTrx(s.balanceSun)} TRX < ${sunToTrx(feeSun)} TRX`);
      const now = Date.now();
      const early = o.stepDay !== undefined && o.stepDay > elapsedDays();
      const p: ActionPreview = {
        id: `pv-${now}`,
        planId: o.planId,
        kind,
        origin: o.origin ?? "plan",
        step: o.step,
        stepDay: o.stepDay,
        early,
        sr,
        votes,
        wallet: wallet.address,
        chain: "nile",
        asset: "TRX",
        amountSun: amountSun.toString(),
        amountDisplay,
        contract: "TRON 시스템 계약",
        method: SYSTEM_CONTRACT[kind],
        approval: "없음 (시스템 거래는 토큰 승인이 필요 없습니다)",
        estimatedEnergy: 0,
        estimatedFeeTrx: sunToTrx(feeSun),
        feeLimitSun: "0",
        risks: [
          ...(o.origin === "adjust" ? [`포지션 조정 거래입니다: ${o.reason ?? "조건 변화"}`] : []),
          "Nile 테스트넷 거래이며 테스트 TRX는 실제 가치가 없습니다.",
          ...(kind === "vote" ? ["투표는 기존 투표를 모두 대체합니다 (이 SR에 전체 투표권을 씁니다)."] : []),
          ...(kind === "unstake" ? ["해제한 TRX는 해제 대기 기간이 끝나야 인출할 수 있고, 해제분만큼 투표권이 줄어 투표가 취소될 수 있습니다."] : []),
          ...(kind === "stake" ? ["스테이킹한 TRX는 해제 후 대기 기간이 지나야 쓸 수 있습니다."] : []),
          `대역폭 약 ${SYSTEM_TX.bandwidth} bytes (보수적 추정). 무료 대역폭이 있으면 수수료가 들지 않습니다.`,
          ...(early ? [`계획상 D+${o.stepDay} 단계를 오늘(D+${elapsedDays()}) 앞당겨 실행합니다 (테스트 목적).`] : []),
        ],
        createdAt: new Date(now).toISOString(),
        validUntil: new Date(now + PREVIEW_TTL_MS).toISOString(),
        snapshot: { balanceSun: s.balanceSun, jTokenBalance: s.jTokenBalance, energyFeeSun: s.energyFeeSun, contractVerified: true, underlyingSun: s.underlyingSun },
      };
      if (!silent) update((x) => ({ ...x, nile: { ...x.nile, preview: p, selectedPlanId: o.plan ? o.plan.id : x.nile.selectedPlanId } }));
      return p;
    } catch (e) {
      if (silent) throw e;
      setError((e as Error).message);
    } finally {
      if (!silent) setBusy(undefined);
    }
    return undefined;
  }

  /** 시스템 거래 서명: 서명 직전 지갑 상태를 다시 읽어 미리보기 조건이 그대로인지 확인한다 */
  async function executeSystem(pv: ActionPreview, invalidate: (why: string) => Outcome): Promise<Outcome> {
    setBusy("sign");
    const w = currentWallet();
    if (!w || w.address !== pv.wallet) return setBusy(undefined), invalidate("지갑 계정이 바뀌었습니다.");
    if (w.network !== "nile") return setBusy(undefined), invalidate("TronLink 네트워크가 Nile이 아닙니다.");
    let fresh: ObserveResponse;
    try {
      fresh = await api.observe(w.address, pv.planId);
    } catch (e) {
      setBusy(undefined);
      const m = `재확인 조회 실패: ${(e as Error).message}`;
      setError(m);
      return { ok: false, error: m };
    }
    const s = fresh.snapshot;
    const k = s.staking;
    const amt = BigInt(pv.amountSun);
    const feeSun = trxToSun(pv.estimatedFeeTrx);
    if (!k) return setBusy(undefined), invalidate("스테이킹 상태를 다시 읽지 못했습니다.");
    if (pv.kind === "stake" && BigInt(s.balanceSun) < amt + feeSun) return setBusy(undefined), invalidate("잔고가 부족해졌습니다.");
    if (pv.kind === "vote" && k.tronPower < (pv.votes ?? 0)) return setBusy(undefined), invalidate("투표권이 줄었습니다.");
    if (pv.kind === "unstake" && BigInt(k.frozenSun) < amt) return setBusy(undefined), invalidate("스테이킹 금액이 줄었습니다.");
    if (pv.kind === "withdraw_unfrozen" && BigInt(k.withdrawableSun) <= 0n) return setBusy(undefined), invalidate("인출 가능한 해제분이 없습니다.");
    if (pv.kind === "claim_reward" && BigInt(k.rewardSun) <= 0n) return setBusy(undefined), invalidate("청구할 보상이 없습니다.");

    const action: SystemAction =
      pv.kind === "stake"
        ? { type: "stake", amountSun: amt }
        : pv.kind === "vote"
          ? { type: "vote", sr: pv.sr!, votes: pv.votes! }
          : pv.kind === "unstake"
            ? { type: "unstake", amountSun: amt }
            : pv.kind === "withdraw_unfrozen"
              ? { type: "withdraw_unfrozen" }
              : { type: "claim_reward" };
    const rec: ExecutionRecord = {
      id: `ex-${Date.now()}`,
      planId: pv.planId,
      previewId: pv.id,
      kind: pv.kind,
      chain: "nile",
      wallet: pv.wallet,
      status: "awaiting_signature",
      amountDisplay: pv.amountDisplay,
      amountTrx: pv.kind === "vote" ? undefined : sunToTrx(pv.amountSun),
      origin: pv.origin ?? "plan",
      step: pv.step,
      stepDay: pv.stepDay,
      plannedRate: rateFor(pv.kind),
    };
    const patchRec = (p: Partial<ExecutionRecord>) =>
      update((st) => ({ ...st, nile: { ...st.nile, records: st.nile.records.map((r) => (r.id === rec.id ? { ...r, ...p } : r)) } }));
    update((st) => ({ ...st, nile: { ...st.nile, records: [...st.nile.records, rec], preview: undefined } }));
    let sentTx: string | undefined;
    try {
      await signAndSendSystem({ action, from: pv.wallet, onSigned: (txId) => ((sentTx = txId), patchRec({ txId, status: "unknown", submittedAt: new Date().toISOString() })) });
      patchRec({ status: "submitted" });
      notify("거래를 제출했습니다. 확정 영수증을 확인하는 중입니다.");
      return { ok: true, txId: sentTx };
    } catch (e) {
      if (e instanceof SignRejected) patchRec({ status: "rejected", error: e.message });
      else if (e instanceof BroadcastRejected) patchRec({ status: "failed", error: e.message });
      else if (e instanceof BroadcastUnknown) patchRec({ status: "unknown", error: e.message });
      else patchRec({ status: "failed", error: (e as Error).message });
      return { ok: false, unknown: e instanceof BroadcastUnknown, txId: sentTx, error: (e as Error).message };
    } finally {
      setBusy(undefined);
    }
  }

  /** 계획 단계 하나의 미리보기를 만든다 (jTRX 예치·인출 / 스테이킹 계열 시스템 거래 / USDD 경로 계약 거래). silent면 화면에 띄우지 않고 돌려준다 */
  async function buildFor(plan: Plan, i: number, silent = false): Promise<ActionPreview | undefined> {
    const kind = stepKind(plan, i);
    const st = plan.steps[i];
    if (!kind) return undefined;
    if (isSystem(kind))
      return buildSystemPreview(kind, { planId: plan.id, plan, amountTrx: st.amount, sr: st.contract, srLabel: st.label.replace(/^D\+\d+ /, ""), step: i, stepDay: st.day, silent });
    if (kind === "call") return buildCallPreview(plan, i, silent);
    const sun = trxToSun(new Decimal(st.amount).toDecimalPlaces(6, Decimal.ROUND_DOWN).toFixed());
    if (kind === "deposit") return buildPreview(plan.id, "deposit", { amountSun: sun, step: i, stepDay: st.day }, silent);
    // 인출: 단계 금액이 현재 포지션 가치 이상이면 전액(redeem), 아니면 부분(redeemUnderlying). 포지션은 방금 읽은 값으로 판단
    const o = silent ? await api.observe(wallet!.address, plan.id) : obs;
    const full = !o || BigInt(o.snapshot.underlyingSun) <= sun;
    return buildPreview(plan.id, "withdraw", { amountSun: full ? undefined : sun, partial: !full, step: i, stepDay: st.day }, silent);
  }

  // ------------------------------------------------ 예치 / 인출 실행기
  // 버튼 하나로 계획의 한 묶음(예치 = D+0 단계들, 인출 = 다음 인출일의 단계들)을 순서대로 실행한다.
  // 단계마다: 미리보기(서버·체인 재조회) → 서명 직전 재확인 → TronLink 서명 → 확정 영수증 확인 → 다음 단계.
  // 중간에 멈추면 다시 눌렀을 때 확정된 단계는 건너뛰고, 확정 대기 중인 단계는 원 txID를 기다린다 (다시 서명하지 않음).
  const recordsRef = useRef(nile.records);
  recordsRef.current = nile.records;
  const [running, setRunning] = useState(false);
  const [runLog, setRunLog] = useState<{ step: number; label: string; status: "wait" | "run" | "done" | "skip" | "fail"; note?: string }[]>();
  const [confirmRun, setConfirmRun] = useState<{ mode: "deposit" | "withdraw"; steps: number[]; day: number; ack: boolean }>();

  async function waitConfirmed(txId: string): Promise<"confirmed" | "failed" | "timeout"> {
    for (let k = 0; k < 40; k++) {
      const t = await api.tx(txId).catch(() => undefined);
      if (t?.status === "confirmed") return "confirmed";
      if (t?.status === "failed") return "failed";
      await new Promise((r) => setTimeout(r, 3000));
    }
    return "timeout";
  }

  async function runGroup(plan: Plan, idxs: number[], ackEarly: boolean) {
    setConfirmRun(undefined);
    setError(undefined);
    setRunning(true);
    type RunStatus = "wait" | "run" | "done" | "skip" | "fail";
    const log: { step: number; label: string; status: RunStatus; note?: string }[] = idxs.map((i) => ({ step: i, label: plan.steps[i].label.replace(/^D\+\d+ /, ""), status: "wait" }));
    const put = (i: number, status: RunStatus, note?: string) => {
      const row = log.find((x) => x.step === i)!;
      Object.assign(row, { status, note });
      setRunLog(log.map((x) => ({ ...x })));
    };
    setRunLog(log.map((x) => ({ ...x })));
    try {
      for (const i of idxs) {
        put(i, "run");
        const recs = recordsRef.current.filter((r) => r.planId === plan.id && r.step === i);
        if (recs.some((r) => r.status === "confirmed")) {
          put(i, "done", "이미 확정됨");
          continue;
        }
        const pending = recs.find((r) => r.txId && ["submitted", "pending", "unknown"].includes(r.status));
        let txId = pending?.txId;
        if (!txId) {
          let pv: ActionPreview | undefined;
          try {
            pv = await buildFor(plan, i, true);
          } catch (e) {
            const msg = (e as Error).message;
            // 보상이 아직 없으면 청구는 건너뛴다 (나머지 인출은 계속)
            if (plan.steps[i].action === "claim" && /청구할 투표 보상이 없습니다/.test(msg)) {
              put(i, "skip", "청구할 보상이 아직 없어 건너뜀");
              continue;
            }
            put(i, "fail", msg);
            setError(`${log.find((x) => x.step === i)!.label}: ${msg}`);
            return;
          }
          if (!pv) {
            put(i, "skip", "실행할 거래가 없는 단계");
            continue;
          }
          const out = await executePreview(pv, { ackEarly, runner: true });
          if (!out.ok && !out.unknown) {
            put(i, "fail", out.error);
            return;
          }
          txId = out.txId;
        }
        if (!txId) {
          put(i, "fail", "txID를 받지 못했습니다");
          return;
        }
        put(i, "run", "확정 영수증 확인 중…");
        const st = await waitConfirmed(txId);
        if (st === "failed") {
          put(i, "fail", "계약 실행이 실패했습니다 (영수증). 자금 이동이 없었는지 기록을 확인하세요.");
          return;
        }
        if (st === "timeout") {
          put(i, "fail", "아직 확정되지 않았습니다. 확정되면 같은 버튼을 다시 누르세요 (다시 서명하지 않고 이어서 진행).");
          return;
        }
        put(i, "done");
        await refreshObs().catch(() => undefined);
      }
      notify(`${plan.title}: ${idxs.length}단계를 모두 확정했습니다.`);
    } finally {
      setRunning(false);
    }
  }

  /** 계약 거래 미리보기: 서버가 지금 지갑·체인 상태로 호출을 만들고 모의 실행까지 해서 돌려준다 */
  async function buildCallPreview(plan: Plan, i: number, silent = false): Promise<ActionPreview | undefined> {
    if (!silent) {
      setError(undefined);
      setDevAck(false);
    }
    if (!wallet || wallet.network !== "nile") {
      if (silent) throw new Error("Nile 네트워크의 TronLink 지갑을 먼저 연결하세요.");
      setError("Nile 네트워크의 TronLink 지갑을 먼저 연결하세요.");
      return undefined;
    }
    const c = callOf(plan, i)!;
    const st = plan.steps[i];
    if (!silent) setBusy("preview");
    try {
      const o = await refreshObs();
      if (!o) throw new Error("지갑 상태를 읽지 못했습니다.");
      const spec = await api.nileCall(wallet.address, c.action, { amountTrx: c.amountTrx, purpose: c.purpose });
      const bad = spec.checks.filter((x) => !x.ok);
      if (bad.length) throw new Error(`지금은 실행할 수 없습니다: ${bad.map((x) => `${x.label} — ${x.detail}`).join(" / ")}`);
      const now = Date.now();
      const early = st.day !== undefined && st.day > elapsedDays();
      const p: ActionPreview = {
        id: `pv-${now}`,
        planId: plan.id,
        kind: "call",
        callAction: c.action,
        callParams: spec.params,
        callPurpose: c.purpose,
        callPrimary: spec.primaryAmount,
        contractName: spec.contractName,
        step: i,
        stepDay: st.day,
        early,
        origin: "plan",
        wallet: wallet.address,
        chain: "nile",
        asset: c.action === "swap_trx_in" ? "TRX" : st.asset,
        amountSun: spec.callValueSun,
        amountDisplay: `${CALL_ACTION_KO[c.action]} · ${spec.amountDisplay}`,
        contract: spec.contract,
        method: spec.method,
        approval: spec.approval,
        estimatedEnergy: spec.estimatedEnergy,
        estimatedFeeTrx: spec.estimatedFeeTrx,
        feeLimitSun: spec.feeLimitSun,
        risks: [
          ...(plan.netReturn !== undefined && Number(plan.netReturn) <= 0 ? [`이 계획의 예상 순수익은 ${plan.netReturn} TRX입니다 (0 이하).`] : []),
          ...(c.action.startsWith("swap") ? ["교환은 풀 가격에 따라 받는 양이 달라집니다. 최소 수령량(견적의 99%)보다 적으면 거래가 실패하고 자금은 이동하지 않습니다."] : []),
          "Nile 테스트넷 거래이며 테스트 토큰은 실제 가치가 없습니다.",
          "스마트 계약 위험 (SunSwap · USDD PSM · JustLend).",
          ...spec.checks.map((x) => `확인: ${x.label} — ${x.detail}`),
          ...(early ? [`계획상 D+${st.day} 단계를 오늘(D+${elapsedDays()}) 앞당겨 실행합니다 (테스트 목적).`] : []),
        ],
        createdAt: new Date(now).toISOString(),
        validUntil: new Date(now + PREVIEW_TTL_MS).toISOString(),
        snapshot: { balanceSun: o.snapshot.balanceSun, jTokenBalance: o.snapshot.jTokenBalance, energyFeeSun: o.snapshot.energyFeeSun, contractVerified: true, underlyingSun: o.snapshot.underlyingSun },
      };
      if (!silent) update((x) => ({ ...x, nile: { ...x.nile, preview: p, selectedPlanId: plan.id } }));
      return p;
    } catch (e) {
      if (silent) throw e;
      setError((e as Error).message);
    } finally {
      if (!silent) setBusy(undefined);
    }
    return undefined;
  }

  /** 계약 거래 서명: 서버에 같은 호출을 다시 만들게 해서 금액·대상·모의 실행이 그대로인지 확인한 뒤 서명한다 */
  async function executeCall(pv: ActionPreview, invalidate: (why: string) => Outcome): Promise<Outcome> {
    setBusy("sign");
    const w = currentWallet();
    if (!w || w.address !== pv.wallet) return setBusy(undefined), invalidate("지갑 계정이 바뀌었습니다.");
    if (w.network !== "nile") return setBusy(undefined), invalidate("TronLink 네트워크가 Nile이 아닙니다.");
    let fresh;
    try {
      const plan = result?.plans.find((p) => p.id === pv.planId);
      const c = plan && pv.step !== undefined ? callOf(plan, pv.step) : undefined;
      fresh = await api.nileCall(w.address, pv.callAction!, { amountTrx: c?.amountTrx, purpose: pv.callPurpose });
    } catch (e) {
      setBusy(undefined);
      const m = `재확인 실패: ${(e as Error).message}`;
      setError(m);
      return { ok: false, error: m };
    }
    if (!fresh.ok) return setBusy(undefined), invalidate(`지금 상태로는 실패합니다 (${fresh.checks.filter((x) => !x.ok).map((x) => x.label).join(", ")}).`);
    if (fresh.contract !== pv.contract || fresh.method !== pv.method) return setBusy(undefined), invalidate("대상 계약이나 메서드가 달라졌습니다.");
    if (fresh.primaryAmount !== pv.callPrimary) return setBusy(undefined), invalidate("금액(잔고)이 바뀌었습니다.");
    if (fresh.callValueSun !== pv.amountSun) return setBusy(undefined), invalidate("보낼 TRX가 바뀌었습니다.");

    const rec: ExecutionRecord = {
      id: `ex-${Date.now()}`,
      planId: pv.planId,
      previewId: pv.id,
      kind: "call",
      chain: "nile",
      wallet: pv.wallet,
      status: "awaiting_signature",
      amountDisplay: pv.amountDisplay,
      amountTrx: pv.amountSun !== "0" ? sunToTrx(pv.amountSun) : undefined,
      origin: "plan",
      step: pv.step,
      stepDay: pv.stepDay,
      plannedRate: result?.quotes.find((q) => q.market === "jUSDD")?.baseRate,
    };
    const patchRec = (p: Partial<ExecutionRecord>) =>
      update((st) => ({ ...st, nile: { ...st.nile, records: st.nile.records.map((r) => (r.id === rec.id ? { ...r, ...p } : r)) } }));
    update((st) => ({ ...st, nile: { ...st.nile, records: [...st.nile.records, rec], preview: undefined } }));
    let sentTx: string | undefined;
    try {
      await signAndSend({
        contract: pv.contract,
        method: pv.method,
        params: pv.callParams ?? [],
        callValueSun: BigInt(pv.amountSun),
        feeLimitSun: BigInt(pv.feeLimitSun),
        from: pv.wallet,
        onSigned: (txId) => ((sentTx = txId), patchRec({ txId, status: "unknown", submittedAt: new Date().toISOString() })),
      });
      patchRec({ status: "submitted" });
      notify("거래를 제출했습니다. 확정 영수증을 확인하는 중입니다.");
      return { ok: true, txId: sentTx };
    } catch (e) {
      if (e instanceof SignRejected) patchRec({ status: "rejected", error: e.message });
      else if (e instanceof BroadcastRejected) patchRec({ status: "failed", error: e.message });
      else if (e instanceof BroadcastUnknown) patchRec({ status: "unknown", error: e.message });
      else patchRec({ status: "failed", error: (e as Error).message });
      return { ok: false, unknown: e instanceof BroadcastUnknown, txId: sentTx, error: (e as Error).message };
    } finally {
      setBusy(undefined);
    }
  }

  const selectedPlan = result?.plans.find((p) => p.id === nile.selectedPlanId);
  const connected = wallet?.network === "nile";
  const executed = selectedPlan ? nile.records.some((r) => r.planId === selectedPlan.id && r.status === "confirmed") : false;
  const currentStep = !connected ? 0 : !result ? 1 : !selectedPlan ? 2 : !executed ? 3 : 4;
  const needsCollapsed = Boolean(result && nile.needs) && !editNeeds;
  const hasPosition = obs ? BigInt(obs.snapshot.jTokenBalance) > 0n : false;

  // ------------------------------------------------ 포지션 모니터링 · 조정 (서버가 체인을 다시 읽어 판정)
  const [adj, setAdj] = useState<NileAdjustment>();
  const [adjErr, setAdjErr] = useState<string>();
  /** 사용자가 고른 목표 배분. 있으면 리밸런스 모드(넘치는 예치도 되돌림), 없으면 모니터링 모드 */
  const [rbTarget, setRbTarget] = useState<"NILE_80" | "NILE_50">();
  const lastAdjStatus = useRef<string | undefined>(undefined);
  const positionPlanId = nile.records.find((r) => r.kind === "deposit" && r.status === "confirmed")?.planId ?? nile.selectedPlanId;
  const positionPlan = result?.plans.find((p) => p.id === positionPlanId);

  /** 조정 판정용 Nile 조건: 원래 요구사항에 현재 폼의 유동성 확보액·운용 일수를 덮어쓴다 (사용자 조건 변경) */
  function adjustNeeds(): UserNeeds {
    const start = nile.needs?.startDate ?? todaySeoul();
    const baseNeeds: UserNeeds = nile.needs ?? { chain: "nile", asset: "TRX", startDate: start, expenses: [], expensesStated: true, riskProfile: "balanced", timezone: "Asia/Seoul", version: 0 };
    return { ...baseNeeds, amount: new Decimal(form.total || 0).toFixed(), endDate: addDays(start, Number(form.days) || 30), bufferAmount: new Decimal(form.reserve || 0).toFixed() };
  }

  async function checkAdjust() {
    if (!wallet || wallet.network !== "nile" || !hasPosition) return;
    if (!/^\d+(\.\d+)?$/.test(form.reserve) || !/^\d+$/.test(form.days)) return;
    try {
      const r = await api.adjust(wallet.address, adjustNeeds(), rbTarget ?? positionPlan?.key, positionPlan?.baseRate, rbTarget ? "rebalance" : "monitor");
      setAdj(r.adjustment);
      setAdjErr(undefined);
      if (r.adjustment.status === "adjust" && lastAdjStatus.current !== "adjust") notify(`포지션 조정 제안: ${r.adjustment.summary}`);
      lastAdjStatus.current = r.adjustment.status;
    } catch (e) {
      setAdjErr((e as Error).message);
    }
  }

  useEffect(() => {
    if (!hasPosition) {
      setAdj(undefined);
      return;
    }
    const t = window.setTimeout(checkAdjust, 600); // 조건 입력이 바뀌면 잠시 뒤 다시 판정
    const iv = window.setInterval(checkAdjust, 60_000); // 앱이 열려 있는 동안 1분마다 모니터링
    return () => {
      window.clearTimeout(t);
      window.clearInterval(iv);
    };
  }, [hasPosition, wallet?.address, form.reserve, form.days, obs?.snapshot.jTokenBalance, obs?.snapshot.balanceSun, rbTarget]); // eslint-disable-line react-hooks/exhaustive-deps

  function previewAdjustment() {
    const a = adj?.action;
    if (!a) return;
    buildPreview(positionPlanId ?? "nile-adjust", a.kind === "deposit_more" ? "deposit" : "withdraw", {
      amountSun: a.kind === "withdraw_all" ? undefined : BigInt(a.amountSun),
      partial: a.kind === "withdraw_partial",
      origin: "adjust",
      reason: a.reason,
    });
  }
  const ADJ_KO = { withdraw_partial: "부분 인출", withdraw_all: "전액 인출", deposit_more: "추가 예치" } as const;

  // 스테이킹 포지션 모니터링: 관측한 지갑·스테이킹 상태와 현재 조건(유동성·기간)으로 조정안을 계산한다
  const stakingQuote = result?.quotes.find((q) => q.kind === "staking");
  const planSr = selectedPlan?.steps.find((s) => s.action === "vote")?.contract;
  const sk = obs?.snapshot.staking;
  const stakeAdj =
    sk && obs
      ? computeStakingAdjustment({
          needs: adjustNeeds(),
          state: {
            walletSun: obs.snapshot.balanceSun,
            frozenSun: sk.frozenSun,
            tronPower: sk.tronPower,
            votedCount: sk.votes.reduce((a, v) => a + v.count, 0),
            withdrawableSun: sk.withdrawableSun,
            rewardSun: sk.rewardSun,
            unfreezing: sk.unfreezing,
          },
          unfreezeDelayDays: stakingQuote?.staking?.unfreezeDelayDays ?? 1,
          sr: planSr ?? stakingQuote?.staking?.srAddress,
        })
      : undefined;
  const STAKE_ACT_KO = { withdraw_unfrozen: "해제분 인출", claim_reward: "보상 청구", vote: "SR 투표", unstake: "스테이킹 해제" } as const;
  const ADJ_STATUS = { adjust: ["amber", "조정 필요"], hold_position: ["teal", "유지"], no_position: ["gray", "포지션 없음"], blocked: ["red", "진행 불가"] } as const;

  // 계획 카드 순서: 추천 → 순수익 큰 순 → 보유. 제외된 계획은 아래 한 줄로
  const cardPlans = result
    ? result.plans
        .filter((p) => p.eligibility !== "ineligible")
        .sort((a, b) => Number(b.recommended) - Number(a.recommended) || (a.key === "HOLD" ? 1 : b.key === "HOLD" ? -1 : Number(b.netReturn ?? -1e18) - Number(a.netReturn ?? -1e18)))
    : [];
  const excludedPlans = result ? result.plans.filter((p) => p.eligibility === "ineligible") : [];
  const signCount = (p: Plan) => {
    const g = runGroups(p);
    const w = g.withdraw.reduce((a, x) => a + x.steps.length, 0);
    return g.deposit.length || w ? `서명: 예치 ${g.deposit.length}번 · 인출 ${w}번` : undefined;
  };
  const sk0 = obs?.snapshot.staking;

  return (
    <div className="stack">
      <div className="row">
        <div>
          <div className="eyebrow">Step 3 · Nile testnet</div>
          <h1 className="hero-title" style={{ fontSize: 34 }}>
            Nile에서 <em>직접 실행</em>해 보기
          </h1>
          <div className="row" style={{ gap: 8 }}>
            <span className="badge amber" title="테스트 TRX 수익은 실제 USDT 수익으로 환산하지 않으며, Mainnet 계획의 실행 증거가 아닙니다.">Nile 테스트넷 · 실제 가치 없음</span>
            {!execEnabled && health && (
              <span className="badge gray" title="계획·미리보기까지만 동작합니다. .env.local에서 ENABLE_NILE_EXECUTION=true로 바꾸고 API를 재시작하세요.">
                실행 꺼짐 (ENABLE_NILE_EXECUTION=false)
              </span>
            )}
          </div>
        </div>
      </div>

      {/* 1. 지갑 상태줄: 항상 보인다 */}
      <div className="card wallet-bar">
        {wallet ? (
          <>
            <div className="wstat">
              <span className="k">지갑</span>
              <span className="v" style={{ fontSize: 15 }}>
                <code>
                  {wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}
                </code>{" "}
                {wallet.network === "nile" ? <span className="badge teal">Nile</span> : <span className="badge red">Nile 아님</span>}
              </span>
            </div>
            {obs && (
              <>
                <div className="wstat">
                  <span className="k">TRX</span>
                  <span className="v">{Number(sunToTrx(obs.snapshot.balanceSun)).toLocaleString()}</span>
                </div>
                <div className="wstat">
                  <span className="k">jTRX 예치</span>
                  <span className="v">≈ {Number(obs.observation.underlyingValue).toLocaleString()}</span>
                </div>
                <div className="wstat">
                  <span className="k">스테이킹</span>
                  <span className="v">{sk0 ? Number(sunToTrx(sk0.frozenSun)).toLocaleString() : "-"}</span>
                </div>
                <div className="wstat">
                  <span className="k">미청구 보상</span>
                  <span className="v">{sk0 ? Number(sunToTrx(sk0.rewardSun)).toLocaleString() : "-"}</span>
                </div>
              </>
            )}
            <div className="spacer" />
            <button className="btn small" onClick={() => refreshObs().catch((e) => setError(e.message))}>
              재조회
            </button>
            <a className="small" href="https://nileex.io/join/getJoinPage" target="_blank" rel="noreferrer">
              Faucet
            </a>
            {sk0 && (sk0.votes.length > 0 || sk0.unfreezing.length > 0 || BigInt(sk0.withdrawableSun) > 0n) && (
              <details open={walletOpen} onToggle={(e) => setWalletOpen((e.target as HTMLDetailsElement).open)} style={{ flexBasis: "100%" }}>
                <summary className="small muted">스테이킹 자세히</summary>
                <div className="small">
                  투표권 {sk0.tronPower.toLocaleString()}
                  {sk0.votes.length > 0 && ` · 투표 ${sk0.votes.map((v) => `${v.sr.slice(0, 6)}… ${v.count}표`).join(", ")}`}
                  {sk0.unfreezing.length > 0 && ` · 해제 대기 ${sk0.unfreezing.map((u) => `${sunToTrx(u.amountSun)} TRX (${new Date(u.expireAt).toLocaleString("ko-KR")} 이후)`).join(", ")}`}
                  {BigInt(sk0.withdrawableSun) > 0n && ` · 인출 가능 ${sunToTrx(sk0.withdrawableSun)} TRX`}
                </div>
              </details>
            )}
          </>
        ) : (
          <>
            <strong>지갑을 연결하세요</strong>
            <span className="small muted">
              {hasTronLink() ? "TronLink를 Nile 테스트넷으로 전환한 뒤 연결합니다." : <>TronLink 확장이 없습니다. <a href="https://www.tronlink.org/" target="_blank" rel="noreferrer">설치</a> 후 개발 전용 지갑을 만드세요.</>}
            </span>
            <div className="spacer" />
            <button className="btn primary" onClick={onConnect} disabled={!hasTronLink()}>
              TronLink 연결
            </button>
          </>
        )}
      </div>

      <Stepper steps={["지갑 연결", "조건", "계획 선택", "실행", "관리"]} current={currentStep} onPick={(i) => (i === 0 ? setWalletOpen(true) : i === 1 ? setEditNeeds(true) : undefined)} />
      {error && <div className="callout red small">{error}</div>}

      {/* 2. 조건 */}
      {needsCollapsed ? (
        <div className="card collapsed-line">
          <strong>2. 조건</strong>
          <span>
            {nile.needs?.amount} TRX · {nile.needs?.endDate ? daysBetween(nile.needs.startDate, nile.needs.endDate) : "-"}일 · 여유 {nile.needs?.bufferAmount} TRX · 지출{" "}
            {nile.needs?.expenses.length ? nile.needs.expenses.map((e) => `D+${daysBetween(nile.needs!.startDate, e.date)} ${e.amount} ${e.asset}`).join(", ") : "없음"} ·{" "}
            {RISK_OPTIONS.find(([v]) => v === nile.needs?.riskProfile)?.[1]} · USDD 위험 {nile.needs?.acceptUsddRisk ? "감수" : "감수 안 함"} · Energy {ENERGY_MODE_KO[nile.needs?.energySource ?? "burn"]} · {COST_MODE_KO[nile.needs?.costBasisMode ?? "max"]}
          </span>
          <div className="spacer" />
          <button className="btn small ghost" onClick={() => setEditNeeds(true)}>
            조건 수정
          </button>
        </div>
      ) : (
      <>
      {inputMode === "chat" && (
      <div className="card chat">
        <div className="row">
          <h3 style={{ margin: 0 }}>2. 조건 알려 주기</h3>
          <div className="spacer" />
          <button className="btn small ghost" onClick={() => setInputMode("form")}>
            직접 입력
          </button>
        </div>
        <div className="chat-log" style={{ maxHeight: 260 }}>
          {chat.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>
              {m.content}
            </div>
          ))}
          {chatBusy && <div className="typing">AI가 입력을 정리하는 중…</div>}
        </div>
        <div className="chips">
          {NILE_CHIPS.map((c) => (
            <button key={c} className="chip" disabled={chatBusy} onClick={() => sendChat(c)}>
              {c}
            </button>
          ))}
        </div>
        <div className="chat-input">
          <textarea
            value={chatInput}
            placeholder="예: 100 TRX를 30일 운용하고 7일 뒤 20 TRX를 써요"
            onChange={(e) => setChatInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                sendChat(chatInput);
              }
            }}
          />
          <button className="btn primary" disabled={chatBusy || !chatInput.trim()} onClick={() => sendChat(chatInput)}>
            보내기
          </button>
        </div>
        <div className="row small" style={{ marginTop: 8 }}>
          <span className="muted">
            반영된 조건: {form.total} TRX{wallet && obs ? " (지갑 잔고)" : ""} · {form.days}일 · 여유 {form.reserve} · 지출 {validExps.length ? validExps.map((e) => `D+${e.day} ${e.amount} ${e.asset ?? "TRX"}`).join(", ") : "없음"} ·{" "}
            {RISK_OPTIONS.find(([v]) => v === risk)?.[1]} · USDD 위험 {usddRisk ? "감수" : "감수 안 함"} · Energy {ENERGY_MODE_KO[energySrc]}
          </span>
          <div className="spacer" />
          <button className="btn teal small" onClick={makePlans} disabled={busy === "plans" || expsInvalid || !/^\d+(\.\d+)?$/.test(form.total) || !/^\d+$/.test(form.days) || !/^\d+(\.\d+)?$/.test(form.reserve)}>
            {busy === "plans" ? "계산 중…" : "이대로 확인하고 계획 계산"}
          </button>
        </div>
      </div>
      )}

      {inputMode === "form" && (
      <div className="card">
        <div className="row">
          <h3 style={{ margin: 0 }}>2. 조건 직접 입력</h3>
          <Tip text="Mainnet 입력과 별도로 받습니다. 지갑이 연결되면 실제 잔고로 다시 계산합니다. Mainnet과 같은 계획 엔진(지출 재원 확보·위험 성향·스테이킹·인출일별 분산·추천)을 Nile 실시간 값으로 계산합니다." />
          <div className="spacer" />
          <button className="btn small ghost" onClick={() => setInputMode("chat")}>
            대화로 입력
          </button>
        </div>
        <div className="row" style={{ alignItems: "flex-end" }}>
          <label className="field">
            보유 TRX
            <input value={form.total} onChange={(e) => setForm({ ...form, total: e.target.value })} disabled={Boolean(wallet && obs)} />
          </label>
          <label className="field">
            운용 일수
            <input value={form.days} onChange={(e) => setForm({ ...form, days: e.target.value })} />
          </label>
          <label className="field">
            유동성 확보 (TRX)
            <input value={form.reserve} onChange={(e) => setForm({ ...form, reserve: e.target.value })} />
          </label>
          <label className="field">
            위험 성향
            <select value={risk} onChange={(e) => setRisk(e.target.value as RiskProfile)}>
              {RISK_OPTIONS.map(([v, ko]) => (
                <option key={v} value={v}>
                  {ko}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            USDD 위험 <Tip text="USDD 경로(계획 B)는 TRX를 USDT로 바꾼 뒤 PSM으로 USDD를 받아 JustLend jUSDD에 예치합니다. USDD 디페깅·PSM 출구 물량 위험을 감수해야 B를 비교합니다. TRX 기준으로는 원금이 달러 자산이 되므로 공격적 성향에서만 후보가 됩니다." />
            <select value={usddRisk ? "y" : "n"} onChange={(e) => setUsddRisk(e.target.value === "y")}>
              <option value="n">감수 안 함</option>
              <option value="y">감수</option>
            </select>
          </label>
          <label className="field">
            Energy 조달 <Tip text="소각 = TRX를 태워 지불 / 스테이킹 = Energy용으로 스테이킹해 둔 TRX로 충당 / 대여 = JustLend Energy 대여(날짜마다 1시간). Nile 대여 단가를 못 읽으면 소각으로 계산합니다." />
            <select value={energySrc} onChange={(e) => setEnergySrc(e.target.value as EnergyMode)}>
              {(Object.keys(ENERGY_MODE_KO) as EnergyMode[]).map((k) => (
                <option key={k} value={k}>
                  {ENERGY_MODE_KO[k]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            비용 기준
            <select value={costMode} onChange={(e) => setCostMode(e.target.value as CostMode)}>
              {(Object.keys(COST_MODE_KO) as CostMode[]).map((k) => (
                <option key={k} value={k}>
                  {COST_MODE_KO[k]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="small" style={{ marginTop: 10 }}>
          운용 중 지출 (인출일별 분산이 이 날짜로 구간을 나눕니다)
        </div>
        {exps.map((e, i) => (
          <div className="row" key={i} style={{ alignItems: "flex-end", marginTop: 4 }}>
            <label className="field">
              D+일수
              <input value={e.day} placeholder="예: 7" onChange={(ev) => setExps(exps.map((x, j) => (j === i ? { ...x, day: ev.target.value } : x)))} />
            </label>
            <label className="field">
              금액
              <input value={e.amount} placeholder="예: 20" onChange={(ev) => setExps(exps.map((x, j) => (j === i ? { ...x, amount: ev.target.value } : x)))} />
            </label>
            <label className="field">
              자산 <Tip text="TRX가 아닌 자산(USDT·USDD)으로 낼 지출은 오늘 환전할 TRX 필요량으로 확보합니다 (SunSwap + PSM 경로 견적)." />
              <select value={e.asset ?? "TRX"} onChange={(ev) => setExps(exps.map((x, j) => (j === i ? { ...x, asset: ev.target.value } : x)))}>
                {["TRX", "USDT", "USDD"].map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </label>
            {exps.length > 1 && (
              <button className="btn ghost small" onClick={() => setExps(exps.filter((_, j) => j !== i))}>
                삭제
              </button>
            )}
          </div>
        ))}
        <div className="row" style={{ marginTop: 8 }}>
          {exps.length < 4 && (
            <button className="btn ghost small" onClick={() => setExps([...exps, { day: "", amount: "" }])}>
              + 지출 추가
            </button>
          )}
          {expsInvalid && <span className="tiny neg">지출은 D+1 ~ 운용 일수 안의 날짜와 0보다 큰 금액이어야 합니다.</span>}
          <div className="spacer" />
          <button className="btn teal" onClick={makePlans} disabled={busy === "plans" || expsInvalid || !/^\d+(\.\d+)?$/.test(form.total) || !/^\d+$/.test(form.days) || !/^\d+(\.\d+)?$/.test(form.reserve)}>
            {busy === "plans" ? "계산 중…" : "이대로 확인하고 Nile 계획 계산"}
          </button>
        </div>
      </div>
      )}
      </>
      )}

      {/* 3. 계획 선택 */}
      {result && (
        <div className="card">
          <div className="row">
            <h3 style={{ margin: 0 }}>3. 계획 선택</h3>
            {[...new Set(result.quotes.map((q) => q.source.mode))].map((m) => (
              <ModeBadge key={m} mode={m} />
            ))}
            <div className="spacer" />
            <WarnBadge items={result.warnings} />
          </div>
          <p className="small muted" style={{ margin: "6px 0 0" }}>
            {result.recommendation.reason}
          </p>
          {result.conversions?.map((c) => (
            <div key={c.expenseId} className="tiny muted">
              지출 환전: {c.date} {c.need.amount} {c.need.asset} ← 오늘 {Number(c.pay.amount).toLocaleString()} TRX를 환전해 보유 ({c.route}) · 이 환전은 계획 실행과 별도로 직접 진행해야 합니다
            </div>
          ))}
          <div className="plan-grid">
            {cardPlans.map((p) => (
              <PlanCard
                key={p.id}
                plan={p}
                asset="TRX"
                selected={nile.selectedPlanId === p.id}
                lines={[signCount(p)].filter(Boolean) as string[]}
                onSelect={p.key === "HOLD" ? undefined : () => update((s) => ({ ...s, nile: { ...s.nile, selectedPlanId: p.id } }))}
                disabled={Boolean(busy) || running}
              />
            ))}
          </div>
          {excludedPlans.length > 0 && (
            <details style={{ marginTop: 10 }}>
              <summary className="small muted">
                제외 {excludedPlans.length}개: {excludedPlans.map((p) => p.title.split(".")[0]).join(", ")} (이유 보기)
              </summary>
              <ul className="clean small">
                {excludedPlans.map((p) => (
                  <li key={p.id}>
                    <strong>{p.title}</strong> — {p.reasons[0] ?? "조건 미충족"}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <details style={{ marginTop: 6 }}>
            <summary className="small muted">금리·출처</summary>
            <p className="tiny muted">
              단위 TRX · jTRX 기본 금리 {pct(result.quotes.find((q) => q.market === "jTRX")?.baseRate, 6)} APR
              {stakingQuote ? ` · Nile 투표 보상 ${pct(stakingQuote.baseRate, 4)} APR (${stakingQuote.staking?.srName ?? "-"}, 해제 대기 ${stakingQuote.staking?.unfreezeDelayDays ?? "-"}일)` : ""} · 금리 유지 가정 · 비용 = 계획의 모든 거래 수수료
            </p>
            {result.quotes.map((q) => (
              <SourceLine key={q.id} s={q.source} label={q.market} />
            ))}
            {result.costBasis && <SourceLine s={result.costBasis.source} label="수수료" />}
          </details>
        </div>
      )}

      {/* 4. 실행 */}
      {selectedPlan && (
        <RunCard
          plan={selectedPlan}
          records={nile.records}
          elapsed={elapsedDays()}
          costBasis={result?.costBasis}
          running={running}
          runLog={runLog}
          confirmRun={confirmRun}
          disabled={Boolean(busy) || Boolean(inFlight) || !connected}
          execEnabled={execEnabled}
          onAsk={(mode, steps, day) => {
            setRunLog(undefined);
            setConfirmRun({ mode, steps, day, ack: false });
          }}
          onAck={(ack) => setConfirmRun((c) => (c ? { ...c, ack } : c))}
          onCancel={() => setConfirmRun(undefined)}
          onStart={() => confirmRun && runGroup(selectedPlan, confirmRun.steps, confirmRun.ack)}
        />
      )}

      {/* 5. 관리 */}
      {(hasPosition || (stakeAdj && stakeAdj.status !== "no_position")) && (
      <div className="card">
        <h3 style={{ marginTop: 0 }}>5. 포지션 관리</h3>
      {hasPosition && (
        <div className="manage-sec">
          <div className="row">
            <h4 style={{ margin: 0 }}>jTRX 예치</h4>
            {adj && <span className={`badge ${ADJ_STATUS[adj.status][0]}`}>{ADJ_STATUS[adj.status][1]}</span>}
            <div className="spacer" />
            <button className="btn small" onClick={checkAdjust} disabled={Boolean(busy)}>
              지금 확인
            </button>
          </div>
          <Tip text="앱이 열려 있는 동안 1분마다, 그리고 '유동성 확보'·'운용 일수'를 바꾸면 곧바로 서버가 지갑·포지션·시세·수수료를 다시 읽어 판정합니다. 조정 근거는 유동성·조건·기간 변화와 사용자가 고른 목표 배분뿐입니다." />
          <div className="row small" style={{ gap: 8 }}>
            <span>목표 배분 (리밸런스)</span>
            <select value={rbTarget ?? ""} onChange={(e) => setRbTarget((e.target.value || undefined) as typeof rbTarget)}>
              <option value="">현재 계획 유지 (모니터링만)</option>
              <option value="NILE_80">최대 예치안 (지출 재원만 보유)</option>
              <option value="NILE_50">절반 예치안 (50% 보유)</option>
            </select>
            {rbTarget && <span className="badge amber">리밸런스 모드</span>}
          </div>
          {adjErr && <div className="callout red small">{adjErr}</div>}
          {adj && (
            <div className="stack" style={{ gap: 8 }}>
              <div className={`callout ${ADJ_STATUS[adj.status][0]} small`}>{adj.summary}</div>
              <details>
                <summary className="small muted">판정 근거 {adj.checks.length}</summary>
                <ul className="clean small">
                  {adj.checks.map((c) => (
                    <li key={c.label}>
                      <span className={c.ok ? "pos" : "neg"}>{c.ok ? "✓" : "✗"}</span> {c.label}: {c.detail}
                    </li>
                  ))}
                  {adj.notes.map((n) => (
                    <li key={n} className="muted">
                      {n}
                    </li>
                  ))}
                </ul>
              </details>
              {adj.action && (
                <div className="row">
                  <span className="small">
                    제안: <strong>{ADJ_KO[adj.action.kind]} {adj.action.amountTrx} TRX</strong> · 예상 수수료 ≈ {adj.action.estimatedFeeTrx} TRX ({adj.action.estimatedEnergy.toLocaleString()} Energy){" "}

                  </span>
                  <div className="spacer" />
                  <button className="btn primary small" disabled={Boolean(busy) || Boolean(inFlight)} onClick={previewAdjustment}>
                    조정 미리보기
                  </button>
                </div>
              )}
              <div className="tiny muted">판정 시각 {timeKo(adj.checkedAt)} · 미리보기 후 서명 직전에 다시 한 번 체인을 읽어 검증합니다.</div>
            </div>
          )}
        </div>
      )}

      {stakeAdj && stakeAdj.status !== "no_position" && (
        <div className="manage-sec">
          <div className="row">
            <h4 style={{ margin: 0 }}>스테이킹</h4>
            <span className={`badge ${stakeAdj.actions.some((a) => a.urgent) ? "amber" : "teal"}`}>{stakeAdj.actions.some((a) => a.urgent) ? "조정 필요" : "유지"}</span>
            <div className="spacer" />
            <button className="btn small" onClick={() => refreshObs().catch((e) => setError(e.message))} disabled={Boolean(busy)}>
              지금 확인
            </button>
          </div>
          <Tip text={`지갑·스테이킹 상태를 다시 읽고, 유동성 확보액·운용 일수·지출(현재 조건)과 해제 대기(${stakingQuote?.staking?.unfreezeDelayDays ?? "1(가정)"}일)를 기준으로 판정합니다. 스테이킹한 TRX는 해제 후 대기 기간이 지나야 쓸 수 있습니다.`} />
          <div className={`callout ${stakeAdj.actions.some((a) => a.urgent) ? "amber" : "teal"} small`}>{stakeAdj.summary}</div>
          <details>
            <summary className="small muted">판정 근거 {stakeAdj.checks.length}</summary>
            <ul className="clean small">
              {stakeAdj.checks.map((c) => (
                <li key={c.label}>
                  <span className={c.ok ? "pos" : "neg"}>{c.ok ? "✓" : "✗"}</span> {c.label}: {c.detail}
                </li>
              ))}
            </ul>
          </details>
          {stakeAdj.actions.map((a) => (
            <div className="row" key={a.kind} style={{ marginTop: 6 }}>
              <span className="small">
                제안: <strong>{STAKE_ACT_KO[a.kind]}</strong> {a.amountTrx ? `${a.amountTrx} TRX` : a.votes ? `${a.votes.toLocaleString()}표` : ""} · <span className="tiny muted">{a.reason}</span>
              </span>
              <div className="spacer" />
              <button
                className="btn primary small"
                disabled={Boolean(busy) || Boolean(inFlight)}
                onClick={() => buildSystemPreview(a.kind, { planId: positionPlanId ?? "nile-adjust", amountTrx: a.amountTrx, sr: a.sr, srLabel: stakingQuote?.staking?.srName, origin: "adjust", reason: a.reason })}
              >
                조정 미리보기
              </button>
            </div>
          ))}
        </div>
      )}

      {hasPosition && (
        <div className="manage-sec row">
          <span className="small">jTRX 전액 인출 (redeem, 예치와 같은 확인 과정)</span>
          <div className="spacer" />
          <button
            className="btn small"
            disabled={Boolean(busy) || Boolean(inFlight)}
            onClick={() => {
              const plan = result?.plans.find((p) => p.id === nile.selectedPlanId) ?? result?.plans.find((p) => p.key !== "HOLD");
              if (plan) buildPreview(plan.id, "withdraw");
              else setError("먼저 Nile 계획을 계산하세요.");
            }}
          >
            인출 미리보기
          </button>
        </div>
      )}
      </div>
      )}

      <div className="card collapsed-line">
        <strong>실행 기록</strong>
        <span>
          {nile.records.length}건 · 확정 {nile.records.filter((r) => r.status === "confirmed").length}
          {nile.records.some((r) => IN_FLIGHT.includes(r.status)) && ` · 진행 중 ${nile.records.filter((r) => IN_FLIGHT.includes(r.status)).length}`}
          {nile.records.some((r) => r.status === "failed") && ` · 실패 ${nile.records.filter((r) => r.status === "failed").length}`}
        </span>
        <div className="spacer" />
        <button className="btn small" onClick={goLog}>
          실행 기록 보기
        </button>
      </div>

      {/* 거래 전 확인 (포지션 조정 등 단건): 화면을 바꾸지 않고 팝업으로 */}
      {preview && (
        <Modal onClose={() => update((s) => ({ ...s, nile: { ...s.nile, preview: undefined } }))}>
          <div>
          <div className="row">
            <h3 style={{ margin: 0 }}>4. 거래 전 확인 ({preview.kind === "withdraw" && preview.partial ? "부분 인출" : TX_KIND_KO[preview.kind]}{preview.origin === "adjust" ? " · 포지션 조정" : ""}{preview.stepDay !== undefined ? ` · 계획 D+${preview.stepDay} 단계` : ""})</h3>
            <div className="spacer" />
            <span className="badge gray">유효 ~ {new Date(preview.validUntil).toLocaleTimeString("ko-KR")}</span>
          </div>
          <div className="kv" style={{ marginTop: 10 }}>
            <div>체인</div>
            <div>
              <span className="badge amber">Nile 테스트넷</span>
            </div>
            <div>지갑</div>
            <div>
              <code>{preview.wallet}</code>
            </div>
            <div>금액</div>
            <div className="bold">{preview.amountDisplay}</div>
            <div>최소 단위</div>
            <div>
              <code>{preview.kind === "vote" ? `${preview.votes}표` : preview.amountSun}</code>{" "}
              {preview.kind === "vote" ? "" : preview.kind === "call" ? `sun · 함께 보낼 TRX ${sunToTrx(preview.amountSun)}` : preview.kind === "withdraw" && !preview.partial ? "jTRX 단위(1e-8)" : "sun (TRX × 1e6)"}
            </div>
            <div>대상</div>
            <div>
              {isSystem(preview.kind) ? (
                <>
                  {preview.contract} <code>{preview.method}</code>
                  {preview.sr && (
                    <>
                      {" "}
                      · SR <code>{preview.sr}</code>
                    </>
                  )}
                </>
              ) : preview.kind === "call" ? (
                <>
                  {preview.contractName} <code>{preview.contract}</code> · 서명 전 모의 실행 성공
                </>
              ) : (
                <>
                  <code>{preview.contract}</code> (JustLend-TRX 확인됨)
                </>
              )}
            </div>
            <div>메서드</div>
            <div>
              <code>{preview.method}</code>
            </div>
            <div>승인 범위</div>
            <div>{preview.approval}</div>
            <div>예상 비용</div>
            <div>
              ≈ {preview.estimatedFeeTrx} TRX ({preview.estimatedEnergy.toLocaleString()} Energy){isSystem(preview.kind) ? " · 시스템 거래라 수수료 상한 없음" : ` · 상한 ${sunToTrx(preview.feeLimitSun)} TRX`}
            </div>
          </div>
          <ul className="clean small" style={{ marginTop: 10 }}>
            {preview.risks.slice(0, 2).map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          {preview.risks.length > 2 && (
            <details>
              <summary className="small muted">위험 전체 보기 ({preview.risks.length})</summary>
              <ul className="clean small">
                {preview.risks.slice(2).map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </details>
          )}
          {preview.early && (
            <label className="small row" style={{ gap: 8 }}>
              <input type="checkbox" checked={devAck} onChange={(e) => setDevAck(e.target.checked)} />
              예정일 전에 앞당겨 실행하는 테스트임을 이해했습니다.
            </label>
          )}
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn primary" disabled={Boolean(busy) || Boolean(inFlight) || !execEnabled} onClick={execute}>
              {busy === "sign" ? "재확인·서명 대기 중…" : "확인했습니다 — TronLink로 서명"}
            </button>
            <button className="btn ghost" onClick={() => update((s) => ({ ...s, nile: { ...s.nile, preview: undefined } }))}>
              취소
            </button>
          </div>
          <p className="tiny muted">서명 직전에 체인·계정·잔고·계약·Energy 단가를 다시 읽고, 달라지면 미리보기를 무효화합니다.</p>
        </div>
        </Modal>
      )}
    </div>
  );
}

/** 계획의 실행 묶음: 예치 = D+0 단계, 인출 = D+n 단계들을 날짜별로 */
function runGroups(plan: Plan) {
  const exec = plan.steps.map((_, i) => i).filter((i) => stepKind(plan, i));
  const deposit = exec.filter((i) => (plan.steps[i].day ?? 0) === 0);
  const days = [...new Set(exec.map((i) => plan.steps[i].day ?? 0).filter((d) => d > 0))].sort((a, b) => a - b);
  return { deposit, withdraw: days.map((day) => ({ day, steps: exec.filter((i) => plan.steps[i].day === day) })) };
}

const RUN_ICON = { wait: "○", run: "…", done: "✓", skip: "–", fail: "✗" } as const;

/** 예치 / 인출 버튼 두 개. 누르면 묶음 전체의 금액·수수료·승인 범위·위험을 한 번 보여 주고, 확인하면 단계를 순서대로 실행한다 */
function RunCard(p: {
  plan: Plan;
  records: ExecutionRecord[];
  elapsed: number;
  costBasis?: CostBasis;
  running: boolean;
  runLog?: { step: number; label: string; status: keyof typeof RUN_ICON; note?: string }[];
  confirmRun?: { mode: "deposit" | "withdraw"; steps: number[]; day: number; ack: boolean };
  disabled: boolean;
  execEnabled: boolean;
  onAsk: (mode: "deposit" | "withdraw", steps: number[], day: number) => void;
  onAck: (ack: boolean) => void;
  onCancel: () => void;
  onStart: () => void;
}) {
  const { plan, records } = p;
  const g = runGroups(plan);
  const done = (i: number) => records.some((r) => r.planId === plan.id && r.step === i && r.status === "confirmed");
  const depPending = g.deposit.filter((i) => !done(i));
  const depDone = depPending.length === 0;
  const nextW = g.withdraw.findIndex((w) => w.steps.some((i) => !done(i)));
  const w = nextW >= 0 ? g.withdraw[nextW] : undefined;
  const wPending = w ? w.steps.filter((i) => !done(i)) : [];
  const allDone = depDone && !w;
  const feeOf = (i: number) => {
    const s = plan.steps[i];
    const b = p.costBasis;
    return b ? (s.energy * b.energyFeeSun + s.bandwidth * b.bandwidthFeeSun) / 1e6 : undefined;
  };
  const c = p.confirmRun;
  const early = c ? c.day > p.elapsed : false;
  const approvals = c ? c.steps.filter((i) => plan.steps[i].action === "approve") : [];
  const total = c ? c.steps.reduce((a, i) => a + (feeOf(i) ?? 0), 0) : 0;
  const withdrawTotal = g.withdraw.reduce((a, x) => a + x.steps.length, 0);

  return (
    <div className="card">
      <div className="row">
        <h3 style={{ margin: 0 }}>3-1. 실행 · {plan.title}</h3>
        <div className="spacer" />
        <span className="badge gray">오늘 D+{p.elapsed}</span>
      </div>
      <p className="small muted" style={{ marginTop: 6 }}>
        버튼을 누르면 필요한 거래를 순서대로 진행합니다. 거래마다 TronLink 서명 창이 뜨고, 확정 영수증을 확인한 뒤 다음 거래로 넘어갑니다.{" "}
        <Tip text="중간에 서명을 거부하거나 실패하면 거기서 멈춥니다. 같은 버튼을 다시 누르면 확정된 거래는 건너뛰고, 확정 대기 중인 거래는 원 txID를 기다립니다(다시 서명하지 않음). 금액은 거래마다 지금 지갑 잔고로 다시 정하고, 서명 직전에 체인을 다시 읽어 달라졌으면 멈춥니다." />
      </p>

      <div className="row" style={{ gap: 10 }}>
        <button className="btn primary" disabled={p.disabled || p.running || depDone || g.deposit.length === 0} onClick={() => p.onAsk("deposit", depPending, 0)}>
          {g.deposit.length === 0 ? "예치할 거래 없음" : depDone ? "예치 완료 ✓" : `예치 (${depPending.length}건)`}
        </button>
        <button className="btn" disabled={p.disabled || p.running || !depDone || !w} onClick={() => w && p.onAsk("withdraw", wPending, w.day)}>
          {allDone ? "인출 완료 ✓" : w ? `인출${g.withdraw.length > 1 ? ` ${nextW + 1}/${g.withdraw.length}` : ""} (D+${w.day} · ${wPending.length}건)` : "인출"}
        </button>
        <span className="small muted">
          예치 {g.deposit.length - depPending.length}/{g.deposit.length}
          {withdrawTotal > 0 && ` · 인출 ${g.withdraw.reduce((a, x) => a + x.steps.filter(done).length, 0)}/${withdrawTotal}`}
        </span>
      </div>
      <ProgressDots
        steps={[...g.deposit, ...g.withdraw.flatMap((x) => x.steps)].map((i) => ({
          label: plan.steps[i].label.replace(/^D\+\d+ /, ""),
          state: done(i) ? "done" : p.runLog?.some((x) => x.step === i && x.status === "run") ? "run" : "wait",
        }))}
      />
      {!depDone && withdrawTotal > 0 && <div className="tiny muted" style={{ marginTop: 6 }}>인출은 예치가 모두 확정된 뒤 누를 수 있습니다.</div>}
      {w && g.withdraw.length > 1 && depDone && (
        <div className="tiny muted" style={{ marginTop: 6 }}>
          인출은 날짜별로 나뉩니다{plan.key === "C" ? " (스테이킹: 해제를 시작하고, 해제 대기가 끝나면 수령)" : " (돈이 필요한 날짜마다 그 몫만)"}. 이번 인출은 D+{w.day} 몫입니다.
        </div>
      )}

      {c && (
        <div className="callout gray" style={{ marginTop: 12 }}>
          <strong>
            {c.mode === "deposit" ? "예치" : `인출 (D+${c.day})`} 확인 · 거래 {c.steps.length}건 · TronLink 서명 {c.steps.length}번
          </strong>
          <table className="table-simple" style={{ marginTop: 8 }}>
            <thead>
              <tr>
                <th>#</th>
                <th>거래</th>
                <th>예상 금액</th>
                <th>예상 수수료</th>
              </tr>
            </thead>
            <tbody>
              {c.steps.map((i, k) => {
                const s = plan.steps[i];
                const f = feeOf(i);
                return (
                  <tr key={i}>
                    <td>{k + 1}</td>
                    <td>{s.label.replace(/^D\+\d+ /, "")}</td>
                    <td>
                      {s.amount} {s.asset}
                    </td>
                    <td>{f !== undefined ? `≈ ${f.toFixed(2)} TRX` : "-"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="small" style={{ marginTop: 6 }}>
            예상 수수료 합계 ≈ <strong>{total.toFixed(2)} TRX</strong> · 금액은 계획 기준 예상이며, 실제로는 거래마다 지갑 잔고로 다시 정합니다.
          </div>
          <div className="small">승인 범위: {approvals.length ? `토큰 승인 ${approvals.length}건, 모두 그 단계에서 쓸 금액만큼만 (무제한 승인 없음)` : "토큰 승인 없음"}</div>
          <ul className="clean small" style={{ marginTop: 6 }}>
            {plan.risks.slice(0, 3).map((r) => (
              <li key={r}>{r}</li>
            ))}
            {plan.netReturn !== undefined && Number(plan.netReturn) <= 0 && <li>이 계획의 예상 순수익은 {plan.netReturn} TRX입니다 (0 이하).</li>}
          </ul>
          {early && (
            <label className="small row" style={{ gap: 8 }}>
              <input type="checkbox" checked={c.ack} onChange={(e) => p.onAck(e.target.checked)} />
              계획상 D+{c.day} 거래를 오늘(D+{p.elapsed}) 앞당겨 실행하는 테스트임을 이해했습니다.
            </label>
          )}
          {!p.execEnabled && <div className="small neg">ENABLE_NILE_EXECUTION=false라 서명할 수 없습니다.</div>}
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn primary" disabled={(early && !c.ack) || !p.execEnabled || p.running} onClick={p.onStart}>
              확인하고 시작 (서명 {c.steps.length}번)
            </button>
            <button className="btn ghost" onClick={p.onCancel}>
              취소
            </button>
          </div>
        </div>
      )}

      {p.runLog && (
        <div style={{ marginTop: 12 }}>
          {p.runLog.map((r, k) => (
            <div key={r.step} className={`small ${r.status === "fail" ? "neg" : r.status === "done" ? "pos" : ""}`}>
              {RUN_ICON[r.status]} {k + 1}. {r.label}
              {r.note && <span className="tiny muted"> · {r.note}</span>}
            </div>
          ))}
          {p.running && <div className="typing">진행 중입니다. TronLink 서명 창을 확인해 주세요.</div>}
        </div>
      )}

      <details style={{ marginTop: 10 }}>
        <summary className="small muted">전체 거래 단계 보기 ({g.deposit.length + withdrawTotal}건)</summary>
        {plan.steps.map((s, i) =>
          stepKind(plan, i) ? (
            <div className="step" key={i}>
              <span className="n">{i + 1}</span>
              <div style={{ flex: 1 }}>
                {!/^D\+/.test(s.label) ? `D+${s.day ?? 0} ` : ""}
                {s.label} · {s.amount} {s.asset}
                <div className="tiny muted">
                  {s.energy > 0 ? `${s.energy.toLocaleString()} Energy · ` : ""}
                  {s.bandwidth} bytes · {s.energySource}
                </div>
              </div>
              {done(i) ? <span className="badge teal">확정</span> : <span className="badge gray">대기</span>}
            </div>
          ) : null,
        )}
      </details>
    </div>
  );
}
