import { useState } from "react";
import type { Update } from "../../App";
import { api } from "../../lib/api";
import { exportJson, type PersistedState } from "../../lib/storage";
import { Decimal } from "../../../shared/units";
import { TX_KIND_KO, type PlanningResult } from "../../../shared/schemas";
import { ChainBadge, EligibilityBadge, ModeBadge, Money, timeKo, TxBadge } from "../common";
import AgentPanel from "../agent/AgentPanel";
import ReevaluateCard from "../agent/ReevaluateCard";
import ReplayCard from "./ReplayCard";

export default function Review({ state, update, notify }: { state: PersistedState; update: Update; notify: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  const nile = state.nile;
  const confirmedDeposits = nile.records.filter((r) => r.kind === "deposit" && r.status === "confirmed");
  const confirmedWithdraws = nile.records.filter((r) => r.kind === "withdraw" && r.status === "confirmed");
  // 전액 인출이 있으면 포지션이 닫힌 것이다. 부분 인출은 순예치 원금에서 뺀다.
  const fullyWithdrawn = confirmedWithdraws.some((r) => !r.partial);
  const partialWithdrawn = confirmedWithdraws.filter((r) => r.partial).reduce((s, r) => s.plus(r.amountTrx ?? 0), new Decimal(0));
  const latestObs = nile.observations[nile.observations.length - 1];
  const nilePlan = nile.result?.plans.find((p) => p.id === confirmedDeposits[0]?.planId);

  // 예상 vs 실제: 같은 Nile 포지션·자산·체인일 때만 직접 비교한다. 예치 원금은 수익으로 세지 않는다.
  let comparison: { deposited: Decimal; elapsedDays: number; expected: Decimal; actual: Decimal; fees: Decimal } | undefined;
  // 계획 금리는 실행 시점에 기록한 값을 쓴다 (계획을 다시 계산해도 원래 가정으로 비교)
  const plannedRate = confirmedDeposits[0]?.plannedRate ?? nilePlan?.baseRate;
  if (confirmedDeposits.length && !fullyWithdrawn && latestObs && plannedRate) {
    const deposited = confirmedDeposits.reduce((s, r) => s.plus(r.amountTrx ?? r.amountDisplay.split(" ")[0]), new Decimal(0)).minus(partialWithdrawn);
    const first = Date.parse(confirmedDeposits[0].confirmedAt ?? confirmedDeposits[0].submittedAt ?? latestObs.observedAt);
    const elapsedDays = Math.max(0, (Date.parse(latestObs.observedAt) - first) / 86_400_000);
    const expected = deposited.mul(plannedRate).mul(elapsedDays).div(365);
    const actual = new Decimal(latestObs.underlyingValue).minus(deposited);
    const fees = confirmedDeposits.reduce((s, r) => s.plus(r.feeTrx ?? 0), new Decimal(0));
    comparison = { deposited, elapsedDays, expected, actual, fees };
  }

  // 스테이킹 예상 vs 실제: 투표가 확정된 뒤부터 보상이 쌓인다. 실제 = 미청구 보상(관측) + 청구해 받은 보상
  const ok = (k: string) => nile.records.filter((r) => r.kind === k && r.status === "confirmed");
  const staked = ok("stake").reduce((s, r) => s.plus(r.amountTrx ?? 0), new Decimal(0)).minus(ok("unstake").reduce((s, r) => s.plus(r.amountTrx ?? 0), new Decimal(0)));
  const firstVote = ok("vote")[0];
  const stakeRate = firstVote?.plannedRate ?? ok("stake")[0]?.plannedRate;
  let stakingCmp: { staked: Decimal; days: number; expected: Decimal; actual: Decimal; claimed: Decimal } | undefined;
  if (firstVote && stakeRate && latestObs && staked.gt(0)) {
    const days = Math.max(0, (Date.parse(latestObs.observedAt) - Date.parse(firstVote.confirmedAt ?? firstVote.submittedAt ?? latestObs.observedAt)) / 86_400_000);
    const claimed = ok("claim_reward").reduce((s, r) => s.plus(r.amountTrx ?? 0), new Decimal(0));
    const unclaimed = new Decimal(latestObs.balances.find((b) => b.asset === "미청구 투표 보상 TRX")?.amount ?? 0);
    stakingCmp = { staked, days, expected: staked.mul(stakeRate).mul(days).div(365), actual: unclaimed.plus(claimed), claimed };
  }

  async function reobserve() {
    const wallet = nile.records[nile.records.length - 1]?.wallet;
    if (!wallet) return notify("관측할 Nile 지갑 기록이 없습니다.");
    setBusy(true);
    try {
      const o = await api.observe(wallet, confirmedDeposits[0]?.planId);
      update((s) => ({ ...s, nile: { ...s.nile, observations: [...s.nile.observations, { ...o.observation, planId: confirmedDeposits[0]?.planId ?? "" }] } }));
      notify("같은 포지션을 다시 조회했습니다.");
    } catch (e) {
      notify(`재조회 실패: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <div className="row">
        <div>
          <div className="eyebrow">Step 4 · Review</div>
          <h1 className="hero-title" style={{ fontSize: 34 }}>
            원래 계획과 <em>실제 결과</em>
          </h1>
          <p className="sub">원계획은 덮어쓰지 않고 버전으로 쌓입니다. 잔고·거래 상태는 체인에서 다시 읽습니다.</p>
        </div>
        <div className="spacer" />
        <button className="btn" onClick={() => exportJson(state)}>
          JSON 내보내기
        </button>
      </div>

      <div className="card">
        <div className="row">
          <h3 style={{ margin: 0 }}>Nile 포지션: 예상 vs 실제</h3>
          <ChainBadge chain="nile" />
          <div className="spacer" />
          <button className="btn small" onClick={reobserve} disabled={busy || !nile.records.length}>
            {busy ? "조회 중…" : "새로고침 (재조회)"}
          </button>
        </div>
        {comparison ? (
          <div className="kv" style={{ marginTop: 12 }}>
            <div>순예치 원금 (예치 − 부분 인출)</div>
            <div>{comparison.deposited.toFixed()} TRX</div>
            <div>경과 시간</div>
            <div>{comparison.elapsedDays.toFixed(3)}일</div>
            <div>예상 이자 (계획 금리)</div>
            <div>
              <Money v={comparison.expected.toFixed()} asset="TRX" dp={8} />
            </div>
            <div>관측 이자 (포지션 가치 − 원금)</div>
            <div>
              <Money v={comparison.actual.toFixed()} asset="TRX" dp={8} signed />
            </div>
            <div>실제 거래비용</div>
            <div>{comparison.fees.toFixed()} TRX (소각)</div>
            <div>차이</div>
            <div>
              <Money v={comparison.actual.minus(comparison.expected).toFixed()} asset="TRX" dp={8} signed />
            </div>
          </div>
        ) : (
          <p className="small muted">확정된 Nile 예치와 이후 관측이 있으면 같은 포지션의 예상/실제를 비교합니다.</p>
        )}
        {stakingCmp && (
          <div className="kv" style={{ marginTop: 10 }}>
            <div>스테이킹 (순)</div>
            <div>{stakingCmp.staked.toFixed()} TRX</div>
            <div>투표 확정 후 경과</div>
            <div>{stakingCmp.days.toFixed(3)}일</div>
            <div>예상 투표 보상</div>
            <div>
              <Money v={stakingCmp.expected.toFixed()} asset="TRX" dp={6} /> <span className="tiny muted">(실행 시점 투표자 APR 기준)</span>
            </div>
            <div>실제 보상</div>
            <div>
              <Money v={stakingCmp.actual.toFixed()} asset="TRX" dp={6} /> <span className="tiny muted">(미청구 + 청구 {stakingCmp.claimed.toFixed()} TRX)</span>
            </div>
            <div>차이</div>
            <div>
              <Money v={stakingCmp.actual.minus(stakingCmp.expected).toFixed()} asset="TRX" dp={6} signed />
              <span className="tiny muted"> · 보상은 유지보수 주기마다 쌓여 짧은 기간에는 0일 수 있습니다</span>
            </div>
          </div>
        )}
        {latestObs && (
          <div className="tiny muted" style={{ marginTop: 8 }}>
            <ModeBadge mode={latestObs.source.mode} /> 최근 관측 {timeKo(latestObs.observedAt)} · {latestObs.valuationBasis}
          </div>
        )}
        {nile.observations.length > 0 && (
          <details>
            <summary>관측 기록 ({nile.observations.length})</summary>
            <table className="table-simple">
              <thead>
                <tr>
                  <th>시각</th>
                  <th>TRX</th>
                  <th>jTRX</th>
                  <th>기초자산 가치</th>
                  <th>스테이킹 · 미청구 보상</th>
                </tr>
              </thead>
              <tbody>
                {[...nile.observations].reverse().map((o) => (
                  <tr key={o.id}>
                    <td>{timeKo(o.observedAt)}</td>
                    <td>{o.balances.find((b) => b.asset === "TRX")?.amount}</td>
                    <td>{o.balances.find((b) => b.asset === "jTRX")?.amount}</td>
                    <td>{o.underlyingValue} TRX</td>
                    <td>
                      {o.balances.find((b) => b.asset === "스테이킹 TRX")?.amount ?? "-"} · {o.balances.find((b) => b.asset === "미청구 투표 보상 TRX")?.amount ?? "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}
      </div>

      <div className="card">
        <h3>Nile 거래 기록</h3>
        {nile.records.length === 0 ? (
          <p className="small muted">거래 기록이 없습니다.</p>
        ) : (
          <table className="table-simple">
            <thead>
              <tr>
                <th>상태</th>
                <th>종류</th>
                <th>금액</th>
                <th>Plan ID</th>
                <th>txID</th>
                <th>수수료</th>
              </tr>
            </thead>
            <tbody>
              {[...nile.records].reverse().map((r) => (
                <tr key={r.id}>
                  <td>
                    <TxBadge s={r.status} />
                  </td>
                  <td>{TX_KIND_KO[r.kind]}</td>
                  <td>{r.amountDisplay}</td>
                  <td>
                    <code>{r.planId}</code>
                  </td>
                  <td>
                    {r.txId ? (
                      <a href={`https://nile.tronscan.org/#/transaction/${r.txId}`} target="_blank" rel="noreferrer">
                        <code>{r.txId.slice(0, 16)}…</code>
                      </a>
                    ) : (
                      "-"
                    )}
                  </td>
                  <td>{r.feeTrx ? `${r.feeTrx} TRX` : "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <AgentPanel
        context="nile"
        nile={{
          wallet: nile.records[nile.records.length - 1]?.wallet,
          txIds: nile.records.filter((r) => r.txId).map((r) => r.txId!),
          records: nile.records.filter((r) => r.txId).map((r) => ({ txId: r.txId!, kind: r.kind, amount: r.amountDisplay })),
          needs: nile.needs,
          planKey: nile.result?.plans.find((p) => p.id === (nile.records.find((r) => r.kind === "deposit" && r.status === "confirmed")?.planId ?? nile.selectedPlanId))?.key,
        }}
        title="AI 에이전트: 내 Nile 거래 확인"
        chips={["내 예치 어떻게 됐어?", "최근 거래가 확정됐어?", "지금 포지션 가치는?", "포지션 조정이 필요해?"]}
        disabledReason={nile.records.length ? undefined : "아직 Nile 거래 기록이 없습니다. Nile 실행 탭에서 거래하면 AI가 영수증과 포지션을 확인해 줍니다."}
      />

      {/* 여러 자산이면 대표 자산 결과로 재평가·과거 재생한다 (자산별 요구사항이 들어 있다) */}
      <ReevaluateCard latest={primaryOf(state.analyses[state.analyses.length - 1])} notify={notify} />

      <ReplayCard latest={primaryOf(state.analyses[state.analyses.length - 1])} />

      <div className="card">
        <div className="row">
          <h3 style={{ margin: 0 }}>Mainnet 분석 기록 (조건부 분석)</h3>
          <ChainBadge chain="mainnet" />
        </div>
        {state.analyses.length === 0 ? (
          <p className="small muted">저장된 분석이 없습니다.</p>
        ) : (
          <table className="table-simple" style={{ marginTop: 10 }}>
            <thead>
              <tr>
                <th>계산 시각</th>
                <th>입력</th>
                <th>운용 가능액</th>
                <th>A 순수익</th>
                <th>B 순수익</th>
                <th>추천</th>
              </tr>
            </thead>
            <tbody>
              {[...state.analyses].reverse().map((a) => {
                const A = a.plans.find((p) => p.key === "A");
                const B = a.plans.find((p) => p.key === "B");
                const rec = a.plans.find((p) => p.id === a.recommendation.planId);
                return (
                  <tr key={a.id}>
                    <td>
                      {timeKo(a.createdAt)} {[...new Set(a.quotes.map((q) => q.source.mode))].map((m) => <ModeBadge key={m} mode={m} />)}
                    </td>
                    <td className="tiny">
                      v{a.needs.version} · {a.needs.amount} {a.needs.asset} · {a.plans[0].horizonDays}일 · 지출 {a.needs.expenses.map((e) => `${e.date} ${e.amount}`).join(", ") || "없음"}
                    </td>
                    <td>{a.investable}</td>
                    <td>
                      {A && <EligibilityBadge e={A.eligibility} />} <Money v={A?.netReturn} dp={4} signed />
                    </td>
                    <td>
                      {B && <EligibilityBadge e={B.eligibility} />} <Money v={B?.netReturn} dp={4} signed />
                    </td>
                    <td>{rec?.title}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <p className="tiny muted">Mainnet 예상 APY를 Nile 실제 결과와 합산하지 않습니다. 예정·실제 지출은 외부 현금흐름이며 투자 손실로 계산하지 않습니다.</p>
      </div>
    </div>
  );
}

function primaryOf(r?: PlanningResult): PlanningResult | undefined {
  const p = r?.portfolio?.parts[0];
  return p ? { ...p.result, portfolio: undefined } : r;
}
