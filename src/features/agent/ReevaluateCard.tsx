import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import type { ReevaluateResponse } from "../../../shared/agent";
import type { PlanningResult } from "../../../shared/schemas";
import { ChainBadge, timeKo } from "../common";

// 재평가 에이전트: 마지막 Mainnet 분석을 최신 시세로 다시 계산한다. 추천 변경 판정은 코드가 한다.

const INTERVAL_MS = 5 * 60 * 1000;
const SEV = { high: ["red", "심각"], warn: ["amber", "주의"], info: ["gray", "참고"] } as const;

export default function ReevaluateCard({ latest, notify }: { latest?: PlanningResult; notify: (m: string) => void }) {
  const [res, setRes] = useState<ReevaluateResponse>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [auto, setAuto] = useState(true);
  const running = useRef(false);

  const check = useCallback(
    async (silent = false) => {
      if (!latest || running.current) return;
      running.current = true;
      setBusy(true);
      setError(undefined);
      try {
        const r = await api.reevaluate(latest.needs, latest);
        setRes(r);
        if (r.recommendationChanged) notify(`재평가: 추천이 ${r.previousKey} → ${r.currentKey}(으)로 바뀌었습니다. 검토 탭을 확인하세요.`);
        else if (!silent) notify("재평가 완료: 추천은 그대로입니다.");
      } catch (e) {
        setError((e as Error).message);
      } finally {
        running.current = false;
        setBusy(false);
      }
    },
    [latest, notify],
  );

  useEffect(() => {
    if (!latest || !auto) return;
    check(true);
    const t = window.setInterval(() => check(true), INTERVAL_MS);
    return () => window.clearInterval(t);
  }, [latest?.id, auto]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="card">
      <div className="row">
        <h3 style={{ margin: 0 }}>재평가 에이전트</h3>
        <ChainBadge chain="mainnet" />
        <div className="spacer" />
        <label className="tiny row" style={{ gap: 6 }}>
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> 5분마다 자동 확인
        </label>
        <button className="btn small" disabled={!latest || busy} onClick={() => check(false)}>
          {busy ? "확인 중…" : "지금 재평가"}
        </button>
      </div>
      <p className="small muted" style={{ marginTop: 6 }}>
        마지막 분석을 최신 시세로 다시 계산해 추천이 바뀌었는지 코드가 판정하고, AI가 바뀐 점을 요약합니다. 원래 분석은 덮어쓰지 않습니다.
      </p>
      {!latest && <p className="small muted">재평가할 Mainnet 분석이 없습니다.</p>}
      {error && <div className="callout red small">{error}</div>}
      {res && (
        <div className="stack" style={{ gap: 10 }}>
          <div className={`callout ${res.recommendationChanged ? "coral" : "teal"} small`}>
            <div className="row" style={{ gap: 8 }}>
              <strong>{res.recommendationChanged ? `추천 변경: ${res.previousKey} → ${res.currentKey}` : `추천 유지: ${res.currentTitle}`}</strong>
              <div className="spacer" />
              <span className={`badge ${res.messageSource === "llm" ? "teal" : "gray"}`}>{res.messageSource === "llm" ? "AI 요약" : "템플릿"}</span>
            </div>
            <div style={{ marginTop: 4 }}>{res.message}</div>
          </div>
          {res.changes.length > 0 && (
            <table className="table-simple">
              <thead>
                <tr>
                  <th>항목</th>
                  <th>분석 당시 ({timeKo(latest?.createdAt)})</th>
                  <th>지금 ({timeKo(res.checkedAt)})</th>
                </tr>
              </thead>
              <tbody>
                {res.changes.map((c) => (
                  <tr key={c.label}>
                    <td>{c.label}</td>
                    <td>{c.before}</td>
                    <td className="bold">{c.after}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {res.rebalance && (
            <div className={`callout ${res.rebalance.recommendSwitch ? "amber" : "gray"} small`}>
              <strong>
                리밸런스 분석: {res.rebalance.from} → {res.rebalance.to} {res.rebalance.recommendSwitch ? "전환이 유리" : "유지가 유리"}
              </strong>
              <div className="kv" style={{ marginTop: 6 }}>
                <div>유지할 때 가치</div>
                <div>{res.rebalance.stayValue} (남은 기본 수익 − 기존 인출 비용)</div>
                <div>전환할 때 가치</div>
                <div>{res.rebalance.switchValue} (새 계획 순수익 − 기존 인출 비용)</div>
                <div>기존 인출 비용</div>
                <div>{res.rebalance.exitCost}</div>
              </div>
              {res.rebalance.steps.length > 0 && (
                <ol className="clean tiny" style={{ marginTop: 6 }}>
                  {res.rebalance.steps.map((s, i) => (
                    <li key={s}>
                      {i + 1}. {s}
                    </li>
                  ))}
                </ol>
              )}
              <div className="tiny muted">{res.rebalance.note}</div>
            </div>
          )}
          {res.anomalies.length > 0 && (
            <ul className="clean small">
              {res.anomalies.map((a, i) => (
                <li key={i}>
                  <span className={`badge ${SEV[a.severity][0]}`}>{SEV[a.severity][1]}</span> {a.market} — {a.message}
                </li>
              ))}
            </ul>
          )}
          {res.failures.length > 0 && <div className="tiny neg">조회 실패: {res.failures.join(" / ")}</div>}
        </div>
      )}
    </div>
  );
}
