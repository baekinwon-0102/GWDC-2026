import { useState } from "react";
import { api } from "../../lib/api";
import type { AgentContext, AgentResponse } from "../../../shared/agent";
import type { TxKind, UserNeeds } from "../../../shared/schemas";
import { EligibilityBadge, Tip, TxBadge } from "../common";

// 조사 에이전트 패널. 에이전트는 읽기 전용 도구만 쓰고, 추천·숫자는 코드가 검증한 값만 화면에 둔다.

const TOOL_KO: Record<string, string> = {
  list_products: "상품 목록 조회",
  simulate: "조건 시뮬레이션",
  find_breakeven: "손익분기 탐색",
  check_anomalies: "시세 이상 점검",
  get_tx_status: "거래 영수증 조회",
  get_position: "포지션 재조회",
  propose_adjustment: "조정 판정",
  ask_user: "사용자에게 질문",
  finish: "최종 답 제출",
};
const SEV = { high: ["red", "심각"], warn: ["amber", "주의"], info: ["gray", "참고"] } as const;

// 탭을 오가도 마지막 결과를 유지한다 (저장소에는 남기지 않음)
const lastResult = new Map<string, AgentResponse>();

export default function AgentPanel({
  context,
  needs,
  nile,
  previousRates,
  chips,
  title,
  disabledReason,
  intro,
}: {
  context: AgentContext;
  needs?: UserNeeds;
  nile?: { wallet?: string; txIds: string[]; records?: { txId: string; kind: TxKind; amount: string }[]; needs?: UserNeeds; planKey?: string };
  previousRates?: { market: string; baseRate?: string }[];
  chips: string[];
  title: string;
  disabledReason?: string;
  /** 첫 메시지로 보일 설명 (계획 설명을 AI 패널의 시작으로 합친다) */
  intro?: { text: string; badge: string; note?: string };
}) {
  const cacheKey = `${context}:${needs?.version ?? ""}`;
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [res, setRes] = useState<AgentResponse | undefined>(() => lastResult.get(cacheKey));
  const [asked, setAsked] = useState<string>();
  const [introOpen, setIntroOpen] = useState(false);

  async function run(q: string) {
    if (!q.trim() || busy || disabledReason) return;
    setBusy(true);
    setError(undefined);
    setAsked(q);
    try {
      const r = await api.agent({ question: q.trim(), context, needs, nile, previousRates });
      lastResult.set(cacheKey, r);
      setRes(r);
      setQuestion("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const art = res?.artifacts;
  const asset = needs?.asset ?? "TRX";

  return (
    <div className="card" style={{ border: "2px solid var(--teal)" }}>
      <div className="row">
        <h3 style={{ margin: 0 }}>{title}</h3>
        <Tip text="질문하면 AI가 필요한 조회·시뮬레이션 도구(읽기 전용)를 직접 골라 실행합니다. 금액·적격성·최종 추천은 계획 엔진이 계산하고 검증하며, AI는 거래를 만들거나 서명할 수 없습니다." />
      </div>
      {intro && !res && (
        <div className="callout teal" style={{ marginTop: 10 }}>
          <div className="row" style={{ gap: 8, marginBottom: 6 }}>
            <strong>AI 설명</strong>
            <div className="spacer" />
            <span className="badge gray" title={intro.note}>
              {intro.badge}
            </span>
          </div>
          <div className={introOpen ? "" : "clamp3"} style={{ whiteSpace: "pre-wrap" }}>
            {intro.text}
          </div>
          {intro.text.length > 160 && (
            <button className="btn small ghost" style={{ marginTop: 6 }} onClick={() => setIntroOpen(!introOpen)}>
              {introOpen ? "접기" : "더 보기"}
            </button>
          )}
        </div>
      )}
      {disabledReason ? (
        <div className="callout gray small">{disabledReason}</div>
      ) : (
        <>
          <div className="chips">
            {chips.map((c) => (
              <button key={c} className="chip" disabled={busy} onClick={() => run(c)}>
                {c}
              </button>
            ))}
          </div>
          <div className="chat-input" style={{ borderTop: 0, paddingTop: 0 }}>
            <textarea
              value={question}
              placeholder={context === "mainnet" ? "예: 지출을 45일 뒤로 미루면 어떻게 돼? / 최소 얼마부터 예치가 이득이야?" : "예: 마지막 예치가 확정됐어? / 지금 jTRX 포지션 가치는?"}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  run(question);
                }
              }}
            />
            <button className="btn teal" disabled={busy || !question.trim()} onClick={() => run(question)}>
              {busy ? "조사 중…" : "질문하기"}
            </button>
          </div>
        </>
      )}
      {busy && <p className="typing">에이전트가 도구를 고르고 실행하는 중입니다… (최대 6단계)</p>}
      {error && <div className="callout red small">{error}</div>}

      {intro && res && (
        <details style={{ marginTop: 8 }}>
          <summary className="small muted">처음 AI 설명 다시 보기</summary>
          <div className="small" style={{ whiteSpace: "pre-wrap" }}>
            {intro.text}
          </div>
        </details>
      )}
      {res && !busy && (
        <div className="stack" style={{ marginTop: 12, gap: 12 }}>
          {asked && <div className="tiny muted">질문: {asked}</div>}
          <div className={`callout ${res.stoppedBy === "ask_user" ? "amber" : "teal"}`}>
            <div className="row" style={{ gap: 8, marginBottom: 6 }}>
              <strong>{res.stoppedBy === "ask_user" ? "AI가 확인을 요청했어요" : "AI 답변"}</strong>
              <div className="spacer" />
              <span className={`badge ${res.answerSource === "llm" ? "teal" : "gray"}`}>
                {res.answerSource === "llm" ? `${res.llm.provider} · ${res.llm.model}` : res.llm.used ? "템플릿 대체" : "규칙 기반 (LLM 미사용)"}
              </span>
            </div>
            <div style={{ whiteSpace: "pre-wrap" }}>{res.answer}</div>
            {res.fallbackReason && <div className="tiny muted" style={{ marginTop: 6 }}>대체 사유: {res.fallbackReason}</div>}
          </div>

          {res.recommendation && (
            <div className="callout gray small">
              <div className="row" style={{ gap: 8 }}>
                <strong>코드 검증 추천:</strong> {res.recommendation.title}
                {res.recommendation.agentPlanKey && (
                  <span className={`badge ${res.recommendation.agreesWithCode ? "teal" : "coral"}`}>
                    {res.recommendation.agreesWithCode ? `AI 제안(${res.recommendation.agentPlanKey})과 일치` : `AI 제안(${res.recommendation.agentPlanKey}) 불채택`}
                  </span>
                )}
              </div>
              <div className="tiny muted">{res.recommendation.note ?? res.recommendation.reason}</div>
            </div>
          )}

          {art?.whatIf && (
            <div>
              <div className="bold small">조건 바꿔 보기: {art.whatIf.changes.join(", ")}</div>
              <table className="table-simple">
                <thead>
                  <tr>
                    <th>항목</th>
                    <th>현재 조건</th>
                    <th>바꾼 조건</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>운용 가능액</td>
                    <td>
                      {art.whatIf.before.investable} {asset}
                    </td>
                    <td className="bold">
                      {art.whatIf.after.investable} {asset}
                    </td>
                  </tr>
                  <tr>
                    <td>추천</td>
                    <td>{art.whatIf.before.recommendedTitle}</td>
                    <td className={art.whatIf.recommendationChanged ? "bold pos" : ""}>{art.whatIf.after.recommendedTitle}</td>
                  </tr>
                  {art.whatIf.after.plans
                    .filter((p) => p.key !== "HOLD")
                    .map((p) => {
                      const b = art.whatIf!.before.plans.find((x) => x.key === p.key);
                      return (
                        <tr key={p.key}>
                          <td>계획 {p.key} 순수익</td>
                          <td>
                            {b?.netReturn} {b && <EligibilityBadge e={b.eligibility} />}
                          </td>
                          <td>
                            {p.netReturn} <EligibilityBadge e={p.eligibility} />
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          )}

          {art?.breakEven?.length ? (
            <div>
              <div className="bold small">손익분기 탐색 (코드 계산)</div>
              <ul className="clean small">
                {art.breakEven.map((b) => (
                  <li key={b.planKey + b.dimension}>
                    계획 {b.planKey} · {b.dimension === "days" ? "최소 운용 일수" : "최소 총 보유액"}:{" "}
                    {b.found ? (
                      <strong>
                        {b.value} {b.unit}
                      </strong>
                    ) : (
                      <span className="muted">없음</span>
                    )}{" "}
                    <span className="tiny muted">
                      (현재 {b.current} {b.unit}
                      {b.netAtValue ? ` · 그때 순수익 ${b.netAtValue} ${asset}` : ""}) {b.found ? "" : b.note}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="tiny muted">조회 시점 금리·수수료가 유지된다는 가정입니다 (보장 아님).</div>
            </div>
          ) : null}

          {art?.anomalies && (
            <div>
              <div className="bold small">시세 이상 점검</div>
              {art.anomalies.filter((a) => a.severity !== "info").length === 0 && <div className="small muted">심각·주의 항목 없음</div>}
              <ul className="clean small">
                {art.anomalies.map((a, i) => (
                  <li key={i}>
                    <span className={`badge ${SEV[a.severity][0]}`}>{SEV[a.severity][1]}</span> {a.market} — {a.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {art?.catalog && (
            <details>
              <summary>
                조회한 JustLend 시장 {art.catalog.total}개 (금리 상위 {art.catalog.entries.length}개)
              </summary>
              <table className="table-simple">
                <thead>
                  <tr>
                    <th>시장</th>
                    <th>기초자산</th>
                    <th>공급 APY</th>
                    <th>분석</th>
                  </tr>
                </thead>
                <tbody>
                  {art.catalog.entries.map((e) => (
                    <tr key={e.symbol}>
                      <td>{e.symbol}</td>
                      <td>{e.underlying}</td>
                      <td>{e.supplyApyPercent}%</td>
                      <td className="tiny">{e.analyzedAs ? <span className="badge teal">계획 {e.analyzedAs}</span> : <span className="muted">{e.note}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}

          {art?.tx?.map((t) => (
            <div key={t.txId} className="small row" style={{ gap: 8 }}>
              <TxBadge s={t.status === "not_found" ? "unknown" : t.status} />
              <code>{t.txId.slice(0, 16)}…</code>
              {t.status === "confirmed" && (
                <span className="tiny muted">
                  블록 {t.blockNumber} · 수수료 {t.feeTrx} TRX · Energy {t.energyUsed?.toLocaleString() ?? "-"}
                </span>
              )}
            </div>
          ))}
          {art?.adjustment && (
            <div className={`callout ${art.adjustment.status === "adjust" ? "amber" : art.adjustment.status === "blocked" ? "red" : "gray"} small`}>
              <strong>조정 판정 (코드 계산):</strong> {art.adjustment.summary}
              {art.adjustment.action && <div className="tiny muted">Nile 실행 탭의 "포지션 모니터링 · 조정" 카드에서 미리보기와 서명을 거쳐 실행합니다. AI는 거래를 만들지 않습니다.</div>}
            </div>
          )}
          {art?.position && (
            <div className="small">
              포지션: jTRX {art.position.jTrx} ≈ <strong>{art.position.underlyingTrx} TRX</strong> · 지갑 {art.position.trx} TRX
            </div>
          )}

          <details>
            <summary>
              AI가 확인한 것 — {res.steps.length}단계 · LLM 호출 {res.llm.calls}회 · {(res.elapsedMs / 1000).toFixed(1)}초
            </summary>
            <ol className="clean small" style={{ paddingLeft: 0 }}>
              {res.steps.map((s) => (
                <li key={s.i} className="step">
                  <span className="n">{s.i}</span>
                  <span className={`badge ${s.by === "llm" ? "teal" : "gray"}`}>{s.by === "llm" ? "AI 선택" : "코드 고정"}</span>
                  <span className={s.ok ? "" : "neg"}>
                    <strong>{TOOL_KO[s.tool] ?? s.tool}</strong> — {s.summary}
                  </span>
                  <span className="tiny muted">{s.durationMs}ms</span>
                </li>
              ))}
            </ol>
            <div className="tiny muted">종료 사유: {{ finish: "AI가 답을 제출", ask_user: "사용자 확인 필요", max_steps: "최대 단계 도달", timeout: "시간 예산 초과", error: "오류로 규칙 경로 대체", rule: "규칙 기반 실행" }[res.stoppedBy]}</div>
          </details>
        </div>
      )}
    </div>
  );
}
