import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import type { ReplayResult } from "../../../shared/replay";
import type { PlanningResult } from "../../../shared/schemas";
import { Money } from "../common";

// 과거 재생 (Tracking & Review): 같은 계획을 최근 N일 동안 실행했다면 실제 일별 금리로 얼마였을지. 실제 거래가 아닌 시뮬레이션이다.

const KEYS = ["A", "A2", "B"] as const;
type Key = (typeof KEYS)[number];

export default function ReplayCard({ latest }: { latest?: PlanningResult }) {
  const recKey = latest?.plans.find((p) => p.id === latest.recommendation.planId)?.key;
  const [key, setKey] = useState<Key>(KEYS.includes(recKey as Key) ? (recKey as Key) : "A");
  const [res, setRes] = useState<ReplayResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function run(k: Key) {
    if (!latest) return;
    setBusy(true);
    setError(undefined);
    try {
      setRes(await api.replay(latest.needs, k));
    } catch (e) {
      setError((e as Error).message);
      setRes(undefined);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (latest) run(key);
  }, [latest?.id, key]); // eslint-disable-line react-hooks/exhaustive-deps

  const asset = latest?.needs.asset ?? "USDT";
  return (
    <div className="card">
      <div className="row">
        <h3 style={{ margin: 0 }}>과거 재생: 이 계획을 지난 기간에 실행했다면</h3>
        <span className="badge coral">시뮬레이션</span>
        <div className="spacer" />
        <label className="small row" style={{ gap: 6 }}>
          계획
          <select value={key} onChange={(e) => setKey(e.target.value as Key)} disabled={busy || !latest}>
            {KEYS.map((k) => (
              <option key={k} value={k}>
                {latest?.plans.find((p) => p.key === k)?.title ?? k}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="small muted" style={{ marginTop: 6 }}>
        분석 당시 금리가 유지된다는 계획 가정과, JustLend의 최근 실제 일별 금리로 같은 계획을 재생한 결과를 비교합니다. 실제 거래는 없습니다.
      </p>
      {!latest && <p className="small muted">재생할 Mainnet 분석이 없습니다.</p>}
      {busy && <p className="typing">과거 금리로 재생하는 중…</p>}
      {error && <div className="callout red small">{error}</div>}
      {res && !busy && (
        <div className="stack" style={{ gap: 10 }}>
          <div className="small">
            {res.market} · 예치 {res.invested} {asset} · {res.window.from} ~ {res.window.to} ({res.days}일)
          </div>
          <table className="table-simple">
            <thead>
              <tr>
                <th>항목 ({asset})</th>
                <th>계획 가정 (금리 고정)</th>
                <th>과거 재생 (실제 일별 금리)</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>기본 수익</td>
                <td>
                  <Money v={res.expected.baseYield} dp={4} />
                </td>
                <td>
                  <Money v={res.replay.baseYield} dp={4} /> <span className="tiny muted">(평균 연 {(Number(res.replay.avgBaseApy) * 100).toFixed(4)}%)</span>
                </td>
              </tr>
              <tr>
                <td>채굴 보상 (참고)</td>
                <td>-</td>
                <td>
                  <Money v={res.replay.mining} dp={4} /> {Number(res.replay.mining) > 0 && <span className="tiny muted">(평균 연 {(Number(res.replay.avgMiningApy) * 100).toFixed(2)}%)</span>}
                </td>
              </tr>
              <tr>
                <td>거래비용 (현재 실측)</td>
                <td>
                  <Money v={res.costs} dp={4} />
                </td>
                <td>
                  <Money v={res.costs} dp={4} />
                </td>
              </tr>
              <tr>
                <td className="bold">순수익</td>
                <td className="bold">
                  <Money v={res.expected.netReturn} dp={4} signed />
                </td>
                <td className="bold">
                  <Money v={res.replay.netReturn} dp={4} signed />
                </td>
              </tr>
            </tbody>
          </table>
          <div className="small">
            예상 대비 실제 차이: <strong><Money v={res.difference} asset={asset} dp={4} signed /></strong>
          </div>
          <ReplayChart res={res} />
          <ul className="clean tiny muted">
            {res.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** 누적 수익 선 그래프 (계획 가정 vs 과거 재생) */
function ReplayChart({ res }: { res: ReplayResult }) {
  const W = 640;
  const H = 180;
  const P = 34;
  const ys = res.series.flatMap((p) => [Number(p.expected), Number(p.replay)]);
  const max = Math.max(...ys, 0);
  const min = Math.min(...ys, 0);
  const span = max - min || 1;
  const x = (i: number) => P + (i * (W - 2 * P)) / Math.max(res.series.length - 1, 1);
  const y = (v: number) => H - P - ((v - min) * (H - 2 * P)) / span;
  const line = (k: "expected" | "replay") => res.series.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(Number(p[k])).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", maxWidth: W, height: "auto" }} role="img" aria-label="누적 수익 비교 그래프">
      <line x1={P} x2={W - P} y1={y(0)} y2={y(0)} stroke="var(--line)" />
      <path d={line("expected")} fill="none" stroke="var(--muted)" strokeWidth={2} strokeDasharray="5 4" />
      <path d={line("replay")} fill="none" stroke="var(--teal)" strokeWidth={2.5} />
      <text x={P} y={14} fontSize={11} fill="var(--muted)">
        누적 수익 (비용 차감 전)
      </text>
      <text x={W - P} y={y(max) - 4} fontSize={11} textAnchor="end" fill="var(--muted)">
        {max.toFixed(4)}
      </text>
      <text x={P} y={H - 8} fontSize={11} fill="var(--muted)">
        {res.window.from}
      </text>
      <text x={W - P} y={H - 8} fontSize={11} textAnchor="end" fill="var(--muted)">
        {res.window.to}
      </text>
      <g fontSize={11}>
        <line x1={W - 230} x2={W - 205} y1={14} y2={14} stroke="var(--muted)" strokeWidth={2} strokeDasharray="5 4" />
        <text x={W - 200} y={18} fill="var(--muted)">
          계획 가정
        </text>
        <line x1={W - 140} x2={W - 115} y1={14} y2={14} stroke="var(--teal)" strokeWidth={2.5} />
        <text x={W - 110} y={18} fill="var(--ink)">
          과거 재생
        </text>
      </g>
    </svg>
  );
}
