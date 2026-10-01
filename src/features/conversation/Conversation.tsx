import { useEffect, useRef, useState } from "react";
import type { Update } from "../../App";
import { api, fillExplanation } from "../../lib/api";
import type { PersistedState } from "../../lib/storage";
import { applyPatch, daysBetween, holdingsOf, inputProblems, missingFields, nextQuestion, riskLabel, summarizeNeeds } from "../../../shared/needs";
import type { ChatMessage, NeedsPatch, UserNeeds } from "../../../shared/schemas";

const FIELD_LABEL: Record<string, string> = {
  amount: "보유 금액",
  endDate: "운용 기간",
  expenses: "예정 지출",
  bufferAmount: "추가 여유액",
  riskProfile: "위험 성향",
  acceptUsddRisk: "USDD 위험 수용",
};

const CHIPS = [
  "1,000 USDT를 30일 운용하고, 7일 뒤에 200 USDT를 써야 해요. 여유액은 없어요.",
  "균형형이에요",
  "USDD 위험은 감수할게요",
  "지출일을 45일 뒤로 바꿔 주세요",
  "지출일을 다시 7일 뒤로 당겨 주세요",
  "USDD 위험은 감수하지 않을래요",
  "10,000 TRX를 90일 운용할게요. 지출은 없고 여유액도 없어요.",
  "USDT 5,000과 TRX 20,000을 90일 운용해요. 20일 뒤 1,000 USDT, 60일 뒤 5,000 TRX를 써요. 여유액은 없어요.",
];

interface Meta {
  text: string;
}

export default function Conversation({
  state,
  update,
  goPlans,
  notify,
}: {
  state: PersistedState;
  update: Update;
  goPlans: () => void;
  notify: (m: string) => void;
}) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [metas, setMetas] = useState<Record<number, Meta>>({});
  const reqId = useRef(0);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [state.messages.length, busy]);

  const needs = state.needs;
  // 추가 보유 자산 (대표 자산이 아닌 것 중 고름). 이미 목록에 있으면 그 자산
  const others = (["USDT", "TRX", "USDD"] as const).filter((a) => a !== needs.asset);
  const [otherPick, setOtherPick] = useState<(typeof others)[number]>();
  const listed = holdingsOf(needs).find((h) => h.asset !== needs.asset)?.asset as (typeof others)[number] | undefined;
  const other = otherPick && others.includes(otherPick) ? otherPick : listed ?? others[0];
  const missing = missingFields(needs);
  const problems = inputProblems(needs);
  const confirmed = state.convState === "confirmed" || state.convState === "comparing";

  /** 확인 이후 입력이 바뀌면 확인과 계획 선택을 무효화한다 */
  function applyNeeds(s: PersistedState, next: UserNeeds, extraAssistant?: string): PersistedState {
    const changed = next.version !== s.needs.version;
    const wasConfirmed = s.convState === "confirmed" || s.convState === "comparing";
    const m = missingFields(next);
    const p = inputProblems(next);
    const convState = m.length || p.length ? "collecting" : "awaiting_confirmation";
    const msgs = [...s.messages];
    if (extraAssistant) msgs.push({ role: "assistant", content: extraAssistant });
    if (changed && wasConfirmed) msgs.push({ role: "assistant", content: "입력이 바뀌어 이전 확인과 계획 선택을 무효화했어요. 요약을 다시 확인해 주세요." });
    return {
      ...s,
      needs: next,
      messages: msgs,
      convState: changed || !wasConfirmed ? convState : s.convState,
      confirmedVersion: changed ? undefined : s.confirmedVersion,
      selectedPlanId: changed ? undefined : s.selectedPlanId,
      lastAsked: m[0],
    };
  }

  async function send(text: string) {
    const t = text.trim();
    if (!t || busy) return;
    setInput("");
    setBusy(true);
    const id = ++reqId.current;
    const userMsg: ChatMessage = { role: "user", content: t.slice(0, 2000) };
    const history = [...state.messages, userMsg];
    update((s) => ({ ...s, messages: [...s.messages, userMsg] }));
    try {
      const res = await api.chat(history.slice(-12), state.needs, state.lastAsked);
      if (id !== reqId.current) return; // 오래된 응답은 버린다
      const idx = history.length;
      setMetas((m) => ({
        ...m,
        [idx]: {
          text: res.llm.used
            ? `AI 추출 · ${res.llm.provider} ${res.llm.model ?? ""} · ${((res.llm.latencyMs ?? 0) / 1000).toFixed(1)}초`
            : `템플릿 대체 · ${res.llm.fallbackReason ?? ""}`,
        },
      }));
      update((s) => applyNeeds({ ...s }, res.needs, res.reply));
    } catch (e) {
      update((s) => ({ ...s, messages: [...s.messages, { role: "assistant", content: `요청을 처리하지 못했어요: ${(e as Error).message}\n입력은 그대로 보존했습니다. 다시 시도하거나 오른쪽 폼으로 직접 입력해 주세요.` }] }));
    } finally {
      if (id === reqId.current) setBusy(false);
    }
  }

  function patchForm(p: NeedsPatch) {
    const { needs: next } = applyPatch(state.needs, p);
    if (next.version === state.needs.version) return;
    const m = missingFields(next);
    update((s) => applyNeeds(s, next, `폼 입력을 반영했어요.${m.length ? "\n\n" + nextQuestion(m) : ""}`));
  }

  async function confirmAndPlan() {
    if (missing.length || problems.length) return;
    setPlanning(true);
    update((s) => ({ ...s, convState: "confirmed", confirmedVersion: s.needs.version }));
    try {
      const result = await api.plans(needs);
      update((s) => ({
        ...s,
        convState: "comparing",
        analyses: [...s.analyses, result],
        messages: [...s.messages, { role: "assistant", content: `요구사항 v${needs.version}을 확인했어요. 계획 비교 탭에서 A/B/보유 기준선을 비교해 보세요.` }],
      }));
      fillExplanation(result, update);
      goPlans();
    } catch (e) {
      update((s) => ({ ...s, convState: "awaiting_confirmation", confirmedVersion: undefined }));
      notify(`계획 생성 실패: ${(e as Error).message}`);
    } finally {
      setPlanning(false);
    }
  }

  return (
    <div>
      <div className="row" style={{ marginBottom: 18 }}>
        <div>
          <div className="eyebrow">Step 1 · Needs</div>
          <h1 className="hero-title" style={{ fontSize: 34 }}>
            조건을 <em>대화로</em> 알려 주세요
          </h1>
        </div>
      </div>

      <div className="grid-2">
        <div className="card chat">
          <div className="chat-log" ref={logRef}>
            {state.messages.map((m, i) => (
              <div key={i} className={`msg ${m.role}`}>
                {m.content}
                {metas[i] && <span className="meta">{metas[i].text}</span>}
              </div>
            ))}
            {busy && <div className="typing">AI가 입력을 정리하는 중… (최대 45초)</div>}
          </div>
          <div className="chips">
            {CHIPS.map((c) => (
              <button key={c} className="chip" disabled={busy} onClick={() => send(c)}>
                {c}
              </button>
            ))}
          </div>
          <div className="chat-input">
            <textarea
              value={input}
              placeholder="예: 1,000 USDT를 30일 운용하고 7일 뒤에 200 USDT를 써요"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send(input);
                }
              }}
            />
            <button className="btn primary" disabled={busy || !input.trim()} onClick={() => send(input)}>
              보내기
            </button>
          </div>
        </div>

        <div className="stack">
          <div className="card">
            <div className="row">
              <h3>요구사항 요약</h3>
              <div className="spacer" />
              <span className={`badge ${confirmed ? "teal" : state.convState === "awaiting_confirmation" ? "amber" : "gray"}`}>
                {confirmed ? `확인됨 v${state.confirmedVersion}` : state.convState === "awaiting_confirmation" ? "확인 대기" : "수집 중"}
              </span>
            </div>
            {summarizeNeeds(needs).length === 0 && <p className="muted small">아직 입력된 정보가 없습니다.</p>}
            {summarizeNeeds(needs).map((l) => (
              <div className="summary-line" key={l}>
                ✓ {l}
              </div>
            ))}
            {missing.length > 0 && (
              <div className="callout gray small" style={{ marginTop: 10 }}>
                아직 필요한 정보: {missing.map((m) => FIELD_LABEL[m]).join(", ")}
              </div>
            )}
            {problems.length > 0 && (
              <div className="callout red small" style={{ marginTop: 10 }}>
                {problems.map((p) => (
                  <div key={p}>⚠ {p}</div>
                ))}
              </div>
            )}
            <hr className="soft" />
            <button className="btn teal" style={{ width: "100%" }} disabled={missing.length > 0 || problems.length > 0 || planning || busy} onClick={confirmAndPlan}>
              {planning ? "데이터 조회·계산 중…" : confirmed ? "다시 조회해서 계획 비교" : "이대로 확인하고 계획 비교"}
            </button>
            <p className="tiny muted" style={{ marginBottom: 0 }}>
              확인 전에는 계획을 확정하지 않습니다. 확인 후 입력을 바꾸면 확인과 계획 선택이 무효화됩니다.
            </p>
          </div>

          <details className="card">
            <summary>폼으로 직접 입력·수정</summary>
            <div className="row" style={{ marginTop: 10, alignItems: "flex-end" }}>
              <label className="field">
                보유 자산
                <select value={needs.asset} onChange={(e) => patchForm({ asset: e.target.value as "USDT" | "TRX" | "USDD" })}>
                  <option value="USDT">USDT</option>
                  <option value="TRX">TRX</option>
                  <option value="USDD">USDD</option>
                </select>
              </label>
              <label className="field">
                보유 {needs.asset}
                <input defaultValue={needs.amount} key={`a${needs.version}`} onBlur={(e) => /^\d+(\.\d+)?$/.test(e.target.value) && patchForm({ amount: e.target.value })} />
              </label>
              <label className="field">
                추가 보유 자산
                <select value={other} onChange={(e) => setOtherPick(e.target.value as (typeof others)[number])}>
                  {others.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                추가 보유 {other} (없으면 비움)
                <input
                  key={`o${needs.version}${other}`}
                  defaultValue={holdingsOf(needs).find((h) => h.asset === other)?.amount ?? ""}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (!needs.amount) return;
                    if (!v || Number(v) === 0) patchForm({ asset: needs.asset, amount: needs.amount });
                    else if (/^\d+(\.\d+)?$/.test(v)) patchForm({ holdings: [{ asset: needs.asset, amount: needs.amount }, { asset: other, amount: v }] });
                  }}
                />
              </label>
              <label className="field">
                운용 일수
                <input
                  type="number"
                  min={1}
                  key={`d${needs.version}`}
                  defaultValue={needs.endDate ? daysBetween(needs.startDate, needs.endDate) : ""}
                  onBlur={(e) => Number(e.target.value) > 0 && patchForm({ durationDays: Number(e.target.value) })}
                />
              </label>
              <label className="field">
                여유액
                <input key={`b${needs.version}`} defaultValue={needs.bufferAmount} onBlur={(e) => /^\d+(\.\d+)?$/.test(e.target.value) && patchForm({ bufferAmount: e.target.value })} />
              </label>
              <label className="field">
                위험 성향
                <select value={needs.riskProfile ?? ""} onChange={(e) => e.target.value && patchForm({ riskProfile: e.target.value as any })}>
                  <option value="">선택</option>
                  <option value="conservative">{riskLabel("conservative")}</option>
                  <option value="balanced">{riskLabel("balanced")}</option>
                  <option value="aggressive">{riskLabel("aggressive")}</option>
                </select>
              </label>
              <label className="field">
                USDD 위험
                <select
                  value={needs.acceptUsddRisk === undefined ? "" : needs.acceptUsddRisk ? "y" : "n"}
                  onChange={(e) => e.target.value && patchForm({ acceptUsddRisk: e.target.value === "y" })}
                >
                  <option value="">선택</option>
                  <option value="y">감수</option>
                  <option value="n">감수 안 함</option>
                </select>
              </label>
            </div>
            <ExpenseForm
              assets={holdingsOf(needs).map((h) => h.asset)}
              fallback={needs.asset}
              onAdd={(inDays, amount, asset) => patchForm({ expenses: [...needs.expenses.map((x) => ({ date: x.date, amount: x.amount, asset: x.asset })), { inDays, amount, asset }] })}
            />
            {needs.expenses.length > 0 && (
              <button className="btn small ghost" onClick={() => patchForm({ noExpenses: true })}>
                지출 모두 지우기 (지출 없음)
              </button>
            )}
            {!needs.expensesStated && (
              <button className="btn small ghost" onClick={() => patchForm({ noExpenses: true })}>
                지출 없음
              </button>
            )}
          </details>
        </div>
      </div>
    </div>
  );
}

function ExpenseForm({ assets, fallback, onAdd }: { assets: string[]; fallback: string; onAdd: (inDays: number, amount: string, asset: string) => void }) {
  const [days, setDays] = useState("7");
  const [amt, setAmt] = useState("200");
  const [asset, setAsset] = useState<string>();
  // 보유 자산을 먼저, 그다음 환전해서 낼 수 있는 자산 (USDT·TRX·USDD)
  const opts = [...new Set([...(assets.length ? assets : [fallback]), "USDT", "TRX", "USDD"])];
  const cur = asset && opts.includes(asset) ? asset : opts[0];
  return (
    <div className="row" style={{ marginTop: 10, alignItems: "flex-end" }}>
      <label className="field">
        지출: 며칠 뒤
        <input type="number" min={0} value={days} onChange={(e) => setDays(e.target.value)} />
      </label>
      <label className="field">
        금액
        <input value={amt} onChange={(e) => setAmt(e.target.value)} />
      </label>
      <label className="field">
        자산
        <select value={cur} onChange={(e) => setAsset(e.target.value)}>
          {opts.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </label>
      <button className="btn small" disabled={!/^\d+$/.test(days) || !/^\d+(\.\d+)?$/.test(amt)} onClick={() => onAdd(Number(days), amt, cur)}>
        지출 추가
      </button>
    </div>
  );
}
