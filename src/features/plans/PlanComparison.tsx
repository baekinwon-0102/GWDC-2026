import { useState } from "react";
import type { Update } from "../../App";
import type { PersistedState } from "../../lib/storage";
import type { Plan, PlanningResult, ScreeningRow } from "../../../shared/schemas";
import { ChainBadge, EligibilityBadge, ModeBadge, Money, pct, SourceLine, Tabs, timeKo, Tip, WarnBadge } from "../common";
import { riskLabel } from "../../../shared/needs";
import AgentPanel from "../agent/AgentPanel";
import { api, fillExplanation } from "../../lib/api";
import { COST_MODE_KO, ENERGY_MODE_KO, type CostMode, type EnergyMode } from "../../../shared/costmode";
import { AllocationBar, LadderTimeline, PlanCard, planSegments, TrxAmount, trxPer } from "../ui";

type Props = {
  state: PersistedState;
  update: Update;
  result?: PlanningResult;
  goNeeds: () => void;
  goNile: () => void;
};

/** 여러 자산이면 합산 카드와 자산별 탭을 보이고, 탭마다 같은 비교 화면(자산별 결과)을 그린다 */
export default function PlanComparison(props: Props) {
  const [partIdx, setPartIdx] = useState(0);
  const pf = props.result?.portfolio;
  if (!pf) return <PlanComparisonBody {...props} />;
  const idx = Math.min(partIdx, pf.parts.length - 1);
  const part = pf.parts[idx];
  return (
    <div className="stack">
      <PortfolioCard result={props.result!} />
      <div className="row" style={{ gap: 10 }}>
        <span className="small muted">자산별 계획</span>
        <div className="seg-switch">
          {pf.parts.map((p, i) => (
            <button key={p.asset} className={i === idx ? "active" : ""} onClick={() => setPartIdx(i)}>
              {p.asset} {Number(p.amount).toLocaleString()}
            </button>
          ))}
        </div>
      </div>
      <PlanComparisonBody {...props} result={{ ...part.result, portfolio: undefined }} />
    </div>
  );
}

function PortfolioCard({ result }: { result: PlanningResult }) {
  const pf = result.portfolio!;
  return (
    <div className="card" style={{ border: "2px solid var(--teal)" }}>
      <div className="row">
        <h3 style={{ margin: 0 }}>여러 자산 배분 요약</h3>
        <Tip text={pf.notes.join(" ")} />
        <div className="spacer" />
        {pf.totalValueUsdt && (
          <span className="small">
            총 가치 ≈ <strong><TrxAmount v={pf.totalValueUsdt} asset="USDT" basis={result.costBasis} /></strong>
          </span>
        )}
        <span className="small">
          추천 계획 순수익 합계 <strong><TrxAmount v={pf.totalNetUsdt} asset="USDT" basis={result.costBasis} dp={4} signed /></strong>
        </span>
      </div>
      <div style={{ marginTop: 14 }}>
        <AllocationBar
          segments={pf.allocation.map((a) => {
            const px = a.share && pf.totalValueUsdt ? Number(a.share) * Number(pf.totalValueUsdt) * (trxPer("USDT", result.costBasis) ?? 1) : Number(a.amount);
            return { label: `${a.asset} ${a.product}`, amount: Math.round(px * 100) / 100, sub: `${Number(a.amount).toLocaleString()} ${a.asset}` };
          })}
          unit={trxPer("USDT", result.costBasis) ? "TRX" : "USDT"}
        />
      </div>
      <div className="plan-grid">
        {pf.parts.map((p) => {
          const rec = p.result.plans.find((x) => x.id === p.result.recommendation.planId)!;
          return (
            <div className="pcard" key={p.asset}>
              <div className="pcard-title">
                {p.asset} {Number(p.amount).toLocaleString()}
                {p.valueUsdt && p.asset !== "USDT" && <span className="tiny muted"> (≈ {Number(p.valueUsdt).toLocaleString()} USDT)</span>}
              </div>
              <div className="pcard-net">
                <TrxAmount v={rec.netReturn} asset={p.asset} basis={result.costBasis} signed />
              </div>
              <div className="pcard-lines">
                <div>추천: {rec.title}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PlanComparisonBody({ state, update, result, goNeeds, goNile }: Props) {
  const [detail, setDetail] = useState(false);
  if (!result) {
    return (
      <div className="card" style={{ textAlign: "center", padding: 48 }}>
        <h2>아직 비교할 계획이 없어요</h2>
        <p className="muted">요구 분석에서 조건을 입력하고 요약을 확인하면 A/B/보유 기준선을 비교합니다.</p>
        <button className="btn primary" onClick={goNeeds}>
          조건 입력하러 가기
        </button>
      </div>
    );
  }
  const stale = result.needs.version !== state.needs.version || state.convState === "collecting" || state.convState === "awaiting_confirmation";
  const asset = result.needs.asset;
  const modes = [...new Set(result.quotes.map((q) => q.source.mode))];
  const rec = result.plans.find((p) => p.id === result.recommendation.planId)!;
  const plans = result.plans;

  const shown = plans.filter((p) => p.eligibility !== "ineligible");
  const excluded = plans.filter((p) => p.eligibility === "ineligible");
  const ladderPlan = plans.find((p) => p.key === "L");
  // 추천과 L(타임라인에서 따로 보임)을 뺀 나머지를 순수익 큰 순으로, 보유는 맨 뒤
  const others = shown
    .filter((p) => p !== rec && !(p.key === "L" && p.ladder?.length))
    .sort((a, b) => (a.key === "HOLD" ? 1 : b.key === "HOLD" ? -1 : Number(b.netReturn ?? -1e18) - Number(a.netReturn ?? -1e18)));
  return (
    <div className="stack">
      <div className="row">
        <div>
          <div className="eyebrow">Step 2 · Compare</div>
          <h1 className="hero-title" style={{ fontSize: 34 }}>
            지출을 먼저 확보하고, <em>출금까지</em> 비교했어요
          </h1>
          <div className="row" style={{ gap: 8 }}>
            <ChainBadge chain={result.chain} />
            <span className="badge amber">조건부 분석</span>
            {modes.map((m) => (
              <ModeBadge key={m} mode={m} />
            ))}
            <Tip text={`입력 v${result.needs.version} · 계산 ${timeKo(result.createdAt)} · ${result.engineVersion} · 날짜는 Asia/Seoul 기준. Mainnet은 조회 전용이며 거래를 실행하지 않습니다.`} />
          </div>
        </div>
        <div className="spacer" />
        <button className="btn" onClick={goNeeds}>
          조건 바꾸기
        </button>
      </div>

      <CostOptions state={state} update={update} disabled={stale} />

      {stale && (
        <div className="callout amber small">
          요구사항이 이 분석 이후 바뀌었습니다 (분석 v{result.needs.version} → 현재 v{state.needs.version}). 요구 분석에서 다시 확인하면 새 계획을 계산합니다.
        </div>
      )}
      <WarnBadge items={result.warnings} />

      {/* 1. 추천 한 줄 + 지출 확보 계산식 */}
      <div className="card" style={{ border: `2px solid var(--${rec.key === "HOLD" ? "coral" : "teal"})` }}>
        <div className="rec-hero">
          <div>
            <div className="tiny muted">추천</div>
            <div className="big">{rec.title}</div>
          </div>
          <div>
            <div className="tiny muted">
              예상 순수익{" "}
              {asset !== "TRX" && trxPer(asset, result.costBasis) && (
                <Tip text={`모든 보유 자산의 결과를 같은 단위로 비교하도록 TRX로 환산해 보입니다. 1 ${asset} = ${trxPer(asset, result.costBasis)!.toFixed(4)} TRX (JustLend 오라클, 조회 시점 가격). 단위만 바꾸는 것이라 계획 순위는 같습니다.`} />
              )}
            </div>
            <div className="big">
              <TrxAmount v={rec.netReturn} asset={asset} basis={result.costBasis} dp={4} signed />
            </div>
          </div>
          {rec.key === "HOLD" && <span className="badge red">거래 보류</span>}
        </div>
        <div style={{ marginTop: 14 }}>
          <AllocationBar segments={planSegments(rec)} unit={asset} />
        </div>
        <div className="small" style={{ marginTop: 10 }}>
          {result.recommendation.reason}
        </div>
        <div className="tiny muted" style={{ marginTop: 6 }}>
          보유 <strong><Money v={result.needs.amount} dp={0} /> {asset}</strong> − 지출 확보 <strong><Money v={result.reserved.total} dp={0} /> {asset}</strong>{" "}
          <Tip text={`기간 안 지출 ${result.reserved.expensesInHorizon} + 여유액 ${result.reserved.buffer}${result.reserved.outsideHorizon.length ? ` · 기간 밖 ${result.reserved.outsideHorizon.map((e) => `${e.date} ${e.amount}`).join(", ")} 제외` : ""}`} /> = 운용 가능{" "}
          <strong><Money v={result.investable} dp={0} /> {asset}</strong> · {result.needs.startDate} ~ {result.needs.endDate} ({result.plans[0].horizonDays}일) · {riskLabel(result.needs.riskProfile)}
          {asset === "USDT" && ` · USDD 위험 ${result.needs.acceptUsddRisk ? "수용" : "미수용"}`}
        </div>
        {result.conversions?.map((c) => (
          <div key={c.expenseId} className="tiny muted">
            지출 환전: {c.date} {c.need.amount} {c.need.asset} ← 오늘 {Number(c.pay.amount).toLocaleString()} {c.pay.asset}를 환전해 보유 ({c.route}, 환전 거래비용 ≈ {Number(c.costTrx).toFixed(2)} TRX 포함)
          </div>
        ))}
      </div>

      {/* 2. 핵심 아이디어: 돈이 필요한 날짜별 배분 (인출일별 분산) */}
      {ladderPlan?.ladder?.length ? (
        <div className="card" style={ladderPlan.recommended ? undefined : { borderStyle: "dashed" }}>
          <div className="row">
            <h3 style={{ margin: 0 }}>돈이 필요한 날짜에 맞춰 나눠 넣기</h3>
            {ladderPlan.recommended ? <span className="badge teal">추천</span> : <span className="badge gray">L 계획</span>}
            <Tip text="곧 쓸 돈은 짧게, 오래 둘 돈은 오래 둘수록 이익인 곳에 넣습니다. 구간마다 가능한 모든 조합(보유·예치·USDD 경로·스테이킹)의 순수익을 코드가 계산해 합계가 가장 큰 배분을 골랐습니다." />
            <div className="spacer" />
            <span className="small">
              예상 순수익 <strong><TrxAmount v={ladderPlan.netReturn} asset={asset} basis={result.costBasis} signed /></strong>
            </span>
          </div>
          <LadderTimeline plan={ladderPlan} asset={asset} basis={result.costBasis} />
          <details style={{ marginTop: 10 }}>
            <summary className="small muted">구간별 이유 · 다른 선택지 · 날짜별 거래</summary>
            <LadderCard plan={ladderPlan} asset={asset} />
          </details>
        </div>
      ) : null}

      {/* 3. 다른 계획: 카드 (순수익 큰 순), 전체 비교표는 펼쳐서 */}
      <div className="card">
        <div className="row">
          <h3 style={{ margin: 0 }}>다른 계획 ({asset} 기준)</h3>
          <Tip text="순수익 = 기본 수익 + 검증된 보상 − 진입·보유·출구 비용. 채굴 보상은 공지 기간·실제 지급을 확인한 캠페인 기간분만 넣습니다. 조회 시점 금리가 기간 내내 유지된다는 가정이며 수익을 보장하지 않습니다." />
        </div>
        <div className="plan-grid">
          {others.map((p) => (
            <PlanCard key={p.id} plan={p} asset={asset} basis={result.costBasis} selected={state.selectedPlanId === p.id} onSelect={() => update((s) => ({ ...s, selectedPlanId: p.id }))} disabled={stale} />
          ))}
        </div>
        {excluded.length > 0 && (
          <details style={{ marginTop: 10 }}>
            <summary className="small muted">
              제외 {excluded.length}개: {excluded.map((p) => p.title.split(".")[0]).join(", ")} (이유 보기)
            </summary>
            <ul className="clean small">
              {excluded.map((p) => (
                <li key={p.id}>
                  <strong>{p.title}</strong> — {p.reasons[0] ?? "조건 미충족"}
                  {p.netReturn === undefined && Number(p.baseYield) > 0 && <span className="muted"> (참고 수익 <Money v={p.baseYield} dp={4} /> {asset})</span>}
                </li>
              ))}
            </ul>
          </details>
        )}
        <div style={{ marginTop: 10 }}>
          <button className="btn small ghost" onClick={() => setDetail(!detail)}>
            {detail ? "전체 비교표 접기 ▴" : "계획 자세히 비교 ▾"}
          </button>
        </div>
        {detail && (
          <div style={{ overflowX: "auto", marginTop: 8 }}>
        <table className="plan-table" style={{ marginTop: 10 }}>
          <thead>
            <tr>
              <th />
              {shown.map((p) => (
                <th key={p.id} className={p.recommended ? "rec" : ""}>
                  {p.title}
                  {p.recommended && <div className="badge teal" style={{ marginTop: 4 }}>추천</div>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <Row label="예상 순수익" plans={shown} cell={(p) => <strong><TrxAmount v={p.netReturn} asset={asset} basis={result.costBasis} dp={4} signed /></strong>} />
            <Row label="예치 / 보유" plans={shown} cell={(p) => `${p.allocation.invested} / ${p.allocation.held}`} />
            <Row label="손익분기" plans={shown} cell={(p) => (p.key === "HOLD" ? "-" : p.breakEvenDays ? `${Math.ceil(Number(p.breakEvenDays)).toLocaleString()}일` : "산정 불가")} />
            <Row label="위험 등급" plans={shown} cell={(p) => (p.riskClass ? RISK_CLASS[p.riskClass][0] : "-")} />
            {(
              <>
                <Row label="판정" plans={shown} cell={(p) => <EligibilityBadge e={p.eligibility} />} />
                <Row label="기본 금리" plans={shown} cell={(p) => (p.baseRate ? `${pct(p.baseRate, 4)} ${p.rateType}` : "-")} />
                <Row label="기본 수익" plans={shown} cell={(p) => <Money v={p.baseYield} dp={4} />} />
                <Row
                  label="인센티브 보상"
                  plans={shown}
                  cell={(p) =>
                    p.rewards.status === "verified" ? (
                      <span title={p.rewards.note}>
                        검증됨 <Money v={p.rewards.amount} dp={4} />
                      </span>
                    ) : p.rewards.status === "unverified" ? (
                      <span title={p.rewards.note} className="muted">
                        미확인 (제외){p.rewards.amount && <> · 추정 <Money v={p.rewards.amount} dp={4} /></>}
                      </span>
                    ) : (
                      "없음"
                    )
                  }
                />
                <Row
                  label="왕복 거래비용"
                  plans={shown}
                  cell={(p) =>
                    p.costs.energy || p.costs.bandwidth ? (
                      <span title={p.costs.energy ? `${p.costs.energy.toLocaleString()} Energy · ${p.costs.bandwidth} bytes` : `대역폭 ${p.costs.bandwidth} bytes`}>
                        {Number(p.costs.trx).toFixed(2)} TRX <span className="tiny muted">≈ <Money v={p.costs.inAsset} dp={2} /></span>
                      </span>
                    ) : (
                      "0"
                    )
                  }
                />
                <Row label="전환 수수료" plans={shown} cell={(p) => <Money v={p.costs.conversionFees} dp={4} />} />
                {shown.some((p) => p.netWithUnverifiedRewards) && (
                  <Row label="참고: 미확인 보상 포함" plans={shown} cell={(p) => (p.netWithUnverifiedRewards ? <span className="muted"><Money v={p.netWithUnverifiedRewards} dp={4} signed /></span> : "-")} />
                )}
                <Row label="거래 단계" plans={shown} cell={(p) => <DetailList title={`${p.steps.length}건`} items={p.steps.map((s) => `${s.label} · ${s.amount} ${s.asset}${s.energy ? ` · ${s.energy.toLocaleString()} Energy` : ""}`)} />} />
                <Row label="위험" plans={shown} cell={(p) => <DetailList title={`${p.risks.length}개`} items={p.risks} />} />
                <Row label="스트레스" plans={shown} cell={(p) => (p.stress ? <DetailList title={`${p.stress.length}개`} items={p.stress.map((s) => `${s.label}: ${Number(s.netReturn) > 0 ? "+" : ""}${Number(s.netReturn).toFixed(2)} ${asset}`)} /> : "-")} />
                <Row label="가정·조건" plans={shown} cell={(p) => <DetailList title={`${p.assumptions.length + p.reasons.length}개`} items={[...p.reasons, ...p.assumptions]} />} />
              </>
            )}
            <tr>
              <td />
              {shown.map((p) => (
                <td key={p.id} className={p.recommended ? "rec" : ""}>
                  <button className={`btn small ${state.selectedPlanId === p.id ? "teal" : ""}`} disabled={stale} onClick={() => update((s) => ({ ...s, selectedPlanId: p.id }))}>
                    {state.selectedPlanId === p.id ? "선택됨" : "선택"}
                  </button>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
          </div>
        )}
      </div>

      {/* 4. AI: 설명이 첫 메시지이고, 이어서 질문한다 */}
      <AgentPanel
        context="mainnet"
        needs={result.needs}
        intro={{
          text: result.explanation.text,
          badge: result.explanation.pending ? "AI 설명 생성 중… (지금은 템플릿)" : result.explanation.source === "llm" ? `${result.explanation.provider} · ${result.explanation.model}` : "템플릿 대체",
          note: result.explanation.fallbackReason,
        }}
        previousRates={state.analyses.length > 1 ? state.analyses[state.analyses.length - 2].quotes.map((q) => ({ market: q.market, baseRate: q.baseRate })) : undefined}
        title="AI 설명 · 질문하기"
        chips={["왜 이렇게 나눠서 넣었어?", "지출을 45일 뒤로 미루면?", "며칠 이상 맡겨야 이득이야?"]}
        disabledReason={stale ? "조건이 바뀌었습니다. 요구 분석에서 다시 확인하고 계획을 계산하면 질문할 수 있습니다." : undefined}
      />

      {/* 5. 근거 자료는 탭 하나에 */}
      <Tabs
        tabs={[
          { id: "screen", label: `상품 탐색 (${result.screening?.length ?? 0})`, body: result.screening ? <ScreeningCard rows={result.screening} asset={asset} risk={riskLabel(result.needs.riskProfile)} /> : null },
          { id: "reward", label: "보상 검증", body: result.quotes.some((x) => x.rewards.apr || x.rewards.campaign) ? <RewardCheckCard result={result} /> : null },
          {
            id: "naive",
            label: "최고 APY만 골랐다면",
            body: result.naiveComparison ? (
              <div className="small">
                {result.naiveComparison.title} → 예상 순수익 <TrxAmount v={result.naiveComparison.netReturn} asset={asset} basis={result.costBasis} dp={4} signed />. {result.naiveComparison.description}
              </div>
            ) : null,
          },
          { id: "src", label: "데이터 출처", body: <SourcesList result={result} /> },
        ]}
      />

      <p className="small muted">
        Mainnet 계획은 조회 전용 조건부 분석입니다. 실행은 Nile 테스트넷에서 별도 조건·계획으로 합니다.{" "}
        <button className="btn small ghost" onClick={goNile}>
          Nile 실행 탭으로
        </button>
      </p>
    </div>
  );
}

/** 표 칸 안의 목록: 개수만 보이고 눌러야 펼친다 */
function DetailList({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return <span className="muted">-</span>;
  return (
    <details>
      <summary className="small">{title}</summary>
      <ul className="clean tiny" style={{ textAlign: "left" }}>
        {items.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ul>
    </details>
  );
}

function SourcesList({ result }: { result: PlanningResult }) {
  return (
    <div className="stack" style={{ gap: 10 }}>
      {result.quotes.map((q) => (
        <div key={q.id}>
          <div className="small bold">
            {q.market} <code>{q.address}</code> {!q.active && <span className="badge red">비활성: {q.inactiveReason}</span>}
          </div>
          {q.psm && (
            <div className="tiny muted">
              수수료 in {pct(q.psm.feeIn)} / out {pct(q.psm.feeOut)} · 진입 여유 {q.psm.entryCapacity ? Number(q.psm.entryCapacity).toLocaleString() : "미확인"} USDD · 출구 물량{" "}
              {q.psm.exitLiquidity ? Number(q.psm.exitLiquidity).toLocaleString() : "미확인"} USDT
            </div>
          )}
          {q.liquidity && <div className="tiny muted">인출 가능 유동성 {Number(q.liquidity).toLocaleString()} {q.token}</div>}
          <SourceLine s={q.source} />
        </div>
      ))}
      {result.costBasis && (
        <div>
          <div className="small bold">
            거래비용 근거: Energy {result.costBasis.energyFeeSun} sun · Bandwidth {result.costBasis.bandwidthFeeSun} sun
            {result.costBasis.trxPerUsdt && ` · 1 USDT = ${Number(result.costBasis.trxPerUsdt).toFixed(4)} TRX`}
          </div>
          <SourceLine s={result.costBasis.source} />
          {result.costBasis.priceSource && <SourceLine s={result.costBasis.priceSource} label="가격" />}
        </div>
      )}
    </div>
  );
}

const RISK_CLASS = { stable: ["보유 자산 그대로", "teal"], stable_conversion: ["스테이블 전환 (디페깅 위험)", "amber"], volatile: ["가격 변동", "red"] } as const;
const CAT_KO: Record<ScreeningRow["category"], string> = {
  same_asset: "보유 자산 그대로",
  psm_route: "USDD 경로",
  stable_conversion: "다른 스테이블 (전환 필요)",
  volatile: "가격 변동·미분류 자산",
  staking: "TRX 스테이킹",
  paused: "예치 중지",
  not_on_tron: "TRON 미배포",
};
const pctOr = (v?: string) => (v === undefined ? "-" : `${(Number(v) * 100).toFixed(2)}%`);

const PRODUCT_BADGE = { HOLD: "gray", LEND: "teal", USDD: "amber", STAKE: "coral" } as const;

/** 인출일별 분산: 돈이 필요한 날짜별 구간과 넣을 곳, 날짜별 거래 타임라인 */
function LadderCard({ plan, asset }: { plan?: Plan; asset: string }) {
  if (!plan?.ladder?.length) return null;
  return (
    <div className="card" style={{ border: plan.recommended ? "2px solid var(--teal)" : undefined }}>
      <div className="row">
        <h3 style={{ margin: 0 }}>인출일별 분산 · 돈이 필요한 날짜에 맞춰 나눠 넣기</h3>
        {plan.recommended && <span className="badge teal">추천</span>}
        <div className="spacer" />
        <span className="small">
          예상 순수익 <strong><Money v={plan.netReturn} asset={asset} dp={4} signed /></strong>
        </span>
      </div>
      <p className="small muted" style={{ marginTop: 6 }}>
        곧 쓸 돈은 짧게, 오래 둘 돈은 오래 둘수록 이익인 곳에 넣습니다.{" "}
        <Tip text="구간마다 가능한 모든 조합(보유·예치·USDD 경로·스테이킹)의 순수익을 코드가 계산해 합계가 가장 큰 배분을 골랐습니다. 예치는 진입 한 번, 인출은 날짜마다 비용이 듭니다." />
      </p>
      <table className="table-simple">
        <thead>
          <tr>
            <th>구간</th>
            <th>금액</th>
            <th>필요한 날</th>
            <th>넣을 곳</th>
            <th>구간 수익</th>
            <th>이유</th>
          </tr>
        </thead>
        <tbody>
          {plan.ladder.map((b) => (
            <tr key={b.label}>
              <td>{b.label}</td>
              <td>
                {b.amount} {asset}
              </td>
              <td>
                {b.needDate} <span className="tiny muted">(D+{b.needDay})</span>
              </td>
              <td>
                <span className={`badge ${PRODUCT_BADGE[b.product]}`}>{b.productLabel}</span>
              </td>
              <td>
                <Money v={b.yield} dp={4} />
              </td>
              <td className="tiny">
                {b.why}
                {b.alternatives.length > 0 && (
                  <details>
                    <summary className="muted">다른 선택지 {b.alternatives.length}</summary>
                    {b.alternatives.map((a) => (
                      <div key={a.product} className="muted">
                        • {a.product}: {a.note ?? (a.netAlone !== undefined ? `${Number(a.netAlone) >= 0 ? "+" : ""}${Number(a.netAlone).toFixed(4)} ${asset}` : "산정 불가")}
                      </div>
                    ))}
                  </details>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {plan.steps.length > 0 && (
        <details>
          <summary>날짜별 거래 타임라인 ({plan.steps.length}건) · 비용 {Number(plan.costs.trx).toFixed(2)} TRX</summary>
          {plan.steps.map((s, i) => (
            <div className="step" key={i}>
              <span className="n">{i + 1}</span>
              <div>
                {s.label} · {s.amount} {s.asset}
                <div className="tiny muted">
                  {s.energy > 0 ? `${s.energy.toLocaleString()} Energy · ` : ""}
                  {s.bandwidth} bytes · {s.energySource}
                </div>
              </div>
            </div>
          ))}
        </details>
      )}
      <WarnBadge items={plan.reasons} label="참고" />
    </div>
  );
}

function RewardCheckCard({ result }: { result: PlanningResult }) {
  const q = result.quotes.find((x) => x.rewards.apr || x.rewards.campaign);
  if (!q) return null;
  const r = q.rewards;
  return (
    <div className="card">
      <div className="row">
        <h3 style={{ margin: 0 }}>채굴 보상 검증 · {q.market}</h3>
        <span className={`badge ${r.status === "verified" ? "teal" : "amber"}`}>{r.status === "verified" ? "검증됨" : "미확인"}</span>
      </div>
      <p className="small" style={{ margin: "8px 0" }}>{r.note}</p>
      {r.campaign ? (
        <>
          <div className="kv">
            <div>캠페인</div>
            <div>{r.campaign.name}</div>
            <div>기간</div>
            <div>
              {r.campaign.start.slice(0, 16).replace("T", " ")} ~ {r.campaign.end.slice(0, 16).replace("T", " ")} (UTC+8)
            </div>
            <div>보상 · 지급</div>
            <div>
              {r.campaign.rewardToken} · {r.campaign.distribution}
            </div>
            <div>참여 조건</div>
            <div>{r.campaign.eligibility}</div>
          </div>
          <div className="bold small" style={{ marginTop: 8 }}>검증 항목</div>
          <ul className="clean small">
            {r.campaign.checks.map((c) => (
              <li key={c}>✓ {c}</li>
            ))}
          </ul>
          <div className="tiny muted">
            공지 출처:{" "}
            {r.campaign.sources.map((u, i) => (
              <a key={u} href={u} target="_blank" rel="noreferrer" style={{ marginRight: 8 }}>
                [{i + 1}]
              </a>
            ))}
          </div>
        </>
      ) : (
        <p className="tiny muted">이 시장의 캠페인 공지가 등록되어 있지 않거나 실제 지급이 확인되지 않아 보상을 순수익에서 뺐습니다.</p>
      )}
      {r.source && <SourceLine s={r.source} />}
    </div>
  );
}

function ScreeningCard({ rows, asset, risk }: { rows: ScreeningRow[]; asset: string; risk: string }) {
  const analyzed = rows.filter((r) => r.verdict === "analyzed").length;
  return (
    <div className="card" style={{ overflowX: "auto" }}>
      <div className="row">
        <h3 style={{ margin: 0 }}>기회 탐색 · 상품 {rows.length}개 검토 → {analyzed}개 분석</h3>
        <span className="tiny muted">보유 자산 {asset} · 위험 성향 {risk} · 코드 규칙으로 심사</span>
      </div>
      <table className="table-simple" style={{ marginTop: 10 }}>
        <thead>
          <tr>
            <th>상품</th>
            <th>분류</th>
            <th>기본</th>
            <th>기초자산</th>
            <th>채굴</th>
            <th>합계</th>
            <th>판정</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.product}>
              <td>
                <strong>{r.product}</strong>
                <div className="tiny muted">{r.project}</div>
              </td>
              <td className="tiny">{CAT_KO[r.category]}</td>
              <td>{pctOr(r.baseApy)}</td>
              <td>{r.underlyingApy && Number(r.underlyingApy) > 0 ? pctOr(r.underlyingApy) : "-"}</td>
              <td>
                {r.miningApy && Number(r.miningApy) > 0 ? (
                  <>
                    {pctOr(r.miningApy)} <span className={`badge ${r.miningStatus === "verified" ? "teal" : "amber"}`}>{r.miningStatus === "verified" ? "검증" : "미확인"}</span>
                  </>
                ) : (
                  "-"
                )}
              </td>
              <td className="bold">{pctOr(r.totalApy)}</td>
              <td className="tiny">
                {r.verdict === "analyzed" ? <span className={`badge ${r.analyzedAs?.includes("제외") ? "gray" : "teal"}`}>계획 {r.analyzedAs}</span> : <span className="badge gray">제외</span>}
                {r.reasons.map((x) => (
                  <div key={x} className="muted">
                    • {x}
                  </div>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="tiny muted">합계 = 기본 공급 APY + 기초자산 자체 수익 + 채굴 APY. 금리가 높아도 전환 경로 비용을 검증하지 못한 상품은 계산하지 않고 사유를 보입니다.</p>
    </div>
  );
}

function Row({ label, plans, cell }: { label: string; plans: Plan[]; cell: (p: Plan) => React.ReactNode }) {
  return (
    <tr>
      <td>{label}</td>
      {plans.map((p) => (
        <td key={p.id} className={p.recommended ? "rec" : ""}>
          {cell(p)}
        </td>
      ))}
    </tr>
  );
}

/** 비용 가정: Energy 조달 방식과 비용 기준을 바꿔 같은 조건으로 다시 계산한다 (새 분석 버전으로 쌓임) */
function CostOptions({ state, update, disabled }: { state: PersistedState; update: Update; disabled: boolean }) {
  const n = state.needs;
  const [energy, setEnergy] = useState<EnergyMode>(n.energySource ?? "burn");
  const [cost, setCost] = useState<CostMode>(n.costBasisMode ?? "max");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const changed = energy !== (n.energySource ?? "burn") || cost !== (n.costBasisMode ?? "max");
  async function apply() {
    const next = { ...n, energySource: energy, costBasisMode: cost, version: n.version + 1 };
    setBusy(true);
    setErr(undefined);
    try {
      const r = await api.plans(next);
      update((s) => ({ ...s, needs: next, confirmedVersion: next.version, convState: "comparing", analyses: [...s.analyses, r] }));
      fillExplanation(r, update);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="card collapsed-line">
      <strong>비용 가정</strong>
      <Tip text="Energy 조달: 소각 = TRX를 태워 지불 / 스테이킹 = Energy용으로 스테이킹해 둔 TRX로 충당(필요한 TRX를 경고로 알려 줌) / 대여 = JustLend Energy 대여로 날짜마다 1시간 빌림(대여율·수수료는 계약에서 읽음). 비용 기준: 실측 최대값(보수적) / 실측 중앙값 / 공식 일반값(JustLend MCP)." />
      <label className="small">
        Energy{" "}
        <select value={energy} onChange={(e) => setEnergy(e.target.value as EnergyMode)}>
          {(Object.keys(ENERGY_MODE_KO) as EnergyMode[]).map((k) => (
            <option key={k} value={k}>
              {ENERGY_MODE_KO[k]}
            </option>
          ))}
        </select>
      </label>
      <label className="small">
        비용 기준{" "}
        <select value={cost} onChange={(e) => setCost(e.target.value as CostMode)}>
          {(Object.keys(COST_MODE_KO) as CostMode[]).map((k) => (
            <option key={k} value={k}>
              {COST_MODE_KO[k]}
            </option>
          ))}
        </select>
      </label>
      <div className="spacer" />
      {err && <span className="tiny neg">{err}</span>}
      <button className="btn small teal" disabled={!changed || busy || disabled} onClick={apply}>
        {busy ? "다시 계산 중…" : "이 가정으로 다시 계산"}
      </button>
    </div>
  );
}
