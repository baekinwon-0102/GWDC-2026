import { useState } from "react";
import type { PersistedState } from "../../lib/storage";
import { TX_KIND_KO, type ExecutionRecord, type TxStatus } from "../../../shared/schemas";
import { Money, timeKo, TxBadge } from "../common";

const EXPLORER = "https://nile.tronscan.org/#/transaction/";
const IN_FLIGHT: TxStatus[] = ["awaiting_signature", "submitted", "pending", "unknown"];
type Filter = "all" | "flight" | "confirmed" | "failed";
const FILTERS: [Filter, string][] = [
  ["all", "전체"],
  ["flight", "진행 중"],
  ["confirmed", "확정"],
  ["failed", "실패·거부"],
];

/** Nile 실행 기록: 계획별로 묶어 txID·확정 여부·실제 수수료를 보인다. 가짜 txID나 가짜 성공 상태는 만들지 않는다 */
export default function ExecutionLog({ state, goNile }: { state: PersistedState; goNile: () => void }) {
  const [filter, setFilter] = useState<Filter>("all");
  const nile = state.nile;
  const recs = [...nile.records].reverse();
  const match = (r: ExecutionRecord) =>
    filter === "all" ? true : filter === "flight" ? IN_FLIGHT.includes(r.status) : filter === "confirmed" ? r.status === "confirmed" : r.status === "failed" || r.status === "rejected";
  const shown = recs.filter(match);
  const count = (f: Filter) => recs.filter((r) => (f === "all" ? true : f === "flight" ? IN_FLIGHT.includes(r.status) : f === "confirmed" ? r.status === "confirmed" : r.status === "failed" || r.status === "rejected")).length;
  const planTitle = (id: string) => nile.result?.plans.find((p) => p.id === id)?.title ?? (id === "nile-adjust" ? "포지션 조정" : "이전 계획");
  const groups = [...new Set(shown.map((r) => r.planId))];
  const fees = recs.filter((r) => r.status === "confirmed").reduce((a, r) => a + Number(r.feeTrx ?? 0), 0);
  const latestObs = nile.observations[nile.observations.length - 1];

  return (
    <div className="stack">
      <div className="row">
        <div>
          <div className="eyebrow">Nile testnet · Log</div>
          <h1 className="hero-title" style={{ fontSize: 34 }}>
            실행 <em>기록</em>
          </h1>
          <p className="sub">서명한 거래의 txID, 확정 여부, 실제 수수료입니다. 확정되지 않은 거래는 이 탭에 있어도 원 txID를 계속 조회합니다.</p>
        </div>
        <div className="spacer" />
        <button className="btn" onClick={goNile}>
          Nile 실행으로
        </button>
      </div>

      <div className="card">
        <div className="row" style={{ gap: 8 }}>
          {FILTERS.map(([f, ko]) => (
            <button key={f} className={`btn small ${filter === f ? "teal" : "ghost"}`} onClick={() => setFilter(f)}>
              {ko} {count(f)}
            </button>
          ))}
          <div className="spacer" />
          <span className="small muted">확정 거래 실제 수수료 합계 {fees.toFixed(4)} TRX</span>
        </div>
        {latestObs && (
          <div className="small" style={{ marginTop: 10 }}>
            최근 관측 {timeKo(latestObs.observedAt)} · TRX {latestObs.balances.find((b) => b.asset === "TRX")?.amount} · jTRX ≈ <strong>{latestObs.underlyingValue} TRX</strong>
            {latestObs.balances.find((b) => b.asset === "스테이킹 TRX") && ` · 스테이킹 ${latestObs.balances.find((b) => b.asset === "스테이킹 TRX")?.amount} TRX`}
          </div>
        )}
      </div>

      {recs.length === 0 && (
        <div className="card" style={{ textAlign: "center", padding: 40 }}>
          <p className="muted">아직 거래가 없습니다.</p>
          <button className="btn primary" onClick={goNile}>
            Nile 실행하러 가기
          </button>
        </div>
      )}
      {recs.length > 0 && shown.length === 0 && <p className="small muted">이 조건에 맞는 거래가 없습니다.</p>}

      {groups.map((pid) => (
        <div className="card" key={pid}>
          <h3 style={{ marginTop: 0 }}>{planTitle(pid)}</h3>
          {shown
            .filter((r) => r.planId === pid)
            .map((r) => (
              <div key={r.id} className="callout gray small" style={{ marginBottom: 8 }}>
                <div className="row" style={{ gap: 8 }}>
                  <TxBadge s={r.status} />
                  <strong>{r.kind === "call" ? r.amountDisplay.split(" · ")[0] : TX_KIND_KO[r.kind]}</strong>
                  <span>{r.kind === "call" ? r.amountDisplay.split(" · ").slice(1).join(" · ") || r.amountDisplay : r.amountDisplay}</span>
                  {r.stepDay !== undefined && <span className="tiny muted">(계획 D+{r.stepDay})</span>}
                  {r.origin === "adjust" && <span className="badge amber">조정</span>}
                  <div className="spacer" />
                  <span className="tiny muted">{timeKo(r.submittedAt)}</span>
                </div>
                {r.txId && (
                  <div className="tiny">
                    txID{" "}
                    <a href={EXPLORER + r.txId} target="_blank" rel="noreferrer">
                      <code>{r.txId}</code>
                    </a>
                  </div>
                )}
                {r.status === "confirmed" && (
                  <div className="tiny muted">
                    블록 {r.blockNumber} · 실제 수수료 <Money v={r.feeTrx} dp={4} /> TRX · Energy {r.energyUsed?.toLocaleString() ?? "-"} · 확정 {timeKo(r.confirmedAt)}
                  </div>
                )}
                {(r.status === "pending" || r.status === "unknown" || r.status === "submitted") && <div className="tiny muted">원 txID를 계속 조회합니다. 자동으로 다시 서명하지 않습니다.</div>}
                {r.error && <div className="tiny neg">{r.error}</div>}
              </div>
            ))}
        </div>
      ))}
    </div>
  );
}
