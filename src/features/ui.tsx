import type { ReactNode } from "react";
import type { Plan } from "../../shared/schemas";
import { Money, Tip } from "./common";

// 계획 비교·Nile 실행 탭이 같이 쓰는 화면 부품: 배분 막대, 계획 카드, 인출일 타임라인, 진행 점, 팝업.

/** 넣을 곳 이름으로 색을 고른다 (보유 = 회색, 예치 = 청록, USDD = 호박, 스테이킹 = 산호) */
export function productTone(label: string): "gray" | "teal" | "amber" | "coral" {
  if (/보유|HOLD/.test(label)) return "gray";
  if (/USDD|PSM/.test(label)) return "amber";
  if (/스테이킹|STAKE|투표/.test(label)) return "coral";
  return "teal";
}

/** 가로 막대 하나로 배분을 보인다. 각 칸의 너비 = 금액 비율 */
export function AllocationBar({ segments, unit }: { segments: { label: string; amount: number; sub?: string }[]; unit?: string }) {
  const total = segments.reduce((a, s) => a + Math.max(s.amount, 0), 0);
  if (total <= 0) return null;
  const shown = segments.filter((s) => s.amount > 0);
  return (
    <div className="alloc">
      <div className="alloc-bar">
        {shown.map((s, i) => (
          <div key={i} className={`alloc-seg ${productTone(s.label)}`} style={{ flexGrow: s.amount, flexBasis: 0 }} title={`${s.label} ${s.amount.toLocaleString()}${unit ? ` ${unit}` : ""}`} />
        ))}
      </div>
      <div className="alloc-legend">
        {shown.map((s, i) => (
          <div key={i} className="alloc-item">
            <span className={`dot ${productTone(s.label)}`} />
            <span>
              <strong>{s.label}</strong> {s.amount.toLocaleString(undefined, { maximumFractionDigits: 4 })}
              {unit ? ` ${unit}` : ""} <span className="muted">({((s.amount / total) * 100).toFixed(0)}%)</span>
              {s.sub && <span className="tiny muted"> · {s.sub}</span>}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 추천(또는 선택) 계획의 배분 칸: 인출일별 분산이면 구간별, 아니면 예치·보유 */
export function planSegments(p: Plan): { label: string; amount: number; sub?: string }[] {
  if (p.ladder?.length) return p.ladder.map((b) => ({ label: b.productLabel, amount: Number(b.amount), sub: `D+${b.needDay}에 필요` }));
  if (p.key === "HOLD") return [{ label: "보유", amount: Number(p.allocation.held) }];
  return [
    { label: p.title.replace(/^[A-Z0-9-]+\.\s*/, ""), amount: Number(p.allocation.invested) },
    { label: "보유 (지출 재원·여유액)", amount: Number(p.allocation.held) },
  ];
}

const RISK_KO = { stable: "보유 자산 그대로", stable_conversion: "스테이블 전환", volatile: "가격 변동" } as const;

/** 계획 카드: 순수익을 크게, 나머지는 두세 줄. 사유·가정은 ⓘ */
export function PlanCard({
  plan,
  asset,
  selected,
  onSelect,
  lines = [],
  disabled,
}: {
  plan: Plan;
  asset: string;
  selected?: boolean;
  onSelect?: () => void;
  lines?: string[];
  disabled?: boolean;
}) {
  const info = [...plan.reasons, ...plan.assumptions].join("\n");
  const be = plan.key !== "HOLD" && plan.breakEvenDays ? `손익분기 ${Math.ceil(Number(plan.breakEvenDays)).toLocaleString()}일` : undefined;
  return (
    <div className={`pcard ${plan.recommended ? "rec" : ""} ${selected ? "sel" : ""}`}>
      <div className="row" style={{ gap: 6 }}>
        {plan.recommended && <span className="badge teal">추천</span>}
        {plan.eligibility === "conditional" && <span className="badge amber">조건부</span>}
        <div className="spacer" />
        {info && <Tip text={info} />}
      </div>
      <div className="pcard-title">{plan.title}</div>
      <div className="pcard-net">
        <Money v={plan.netReturn} dp={plan.netReturn !== undefined && Math.abs(Number(plan.netReturn)) >= 100 ? 2 : 4} signed /> <small>{asset}</small>
      </div>
      <div className="pcard-lines">
        {[be, plan.riskClass ? RISK_KO[plan.riskClass] : undefined, plan.key !== "HOLD" ? `예치 ${Number(plan.allocation.invested).toLocaleString()} · 보유 ${Number(plan.allocation.held).toLocaleString()}` : "거래 없음", ...lines]
          .filter(Boolean)
          .map((l) => (
            <div key={l}>{l}</div>
          ))}
      </div>
      {onSelect && (
        <button className={`btn small ${selected ? "teal" : ""}`} disabled={disabled} onClick={onSelect}>
          {selected ? "선택됨" : "선택"}
        </button>
      )}
    </div>
  );
}

/** 인출일별 분산 타임라인: 구간마다 D+0부터 돈이 필요한 날까지의 막대 */
export function LadderTimeline({ plan, asset }: { plan: Plan; asset: string }) {
  const ladder = plan.ladder ?? [];
  const horizon = Math.max(plan.horizonDays, ...ladder.map((b) => b.needDay), 1);
  return (
    <div className="tl">
      <div className="tl-axis">
        <span>D+0</span>
        <span>D+{horizon}</span>
      </div>
      {ladder.map((b) => (
        <div className="tl-row" key={b.label}>
          <div className="tl-label">
            <strong>
              {Number(b.amount).toLocaleString()} {asset}
            </strong>{" "}
            → {b.productLabel}
          </div>
          <div className="tl-track">
            <div className={`tl-bar ${productTone(b.productLabel)}`} style={{ width: `${Math.max((b.needDay / horizon) * 100, 4)}%` }}>
              <span>D+{b.needDay}</span>
            </div>
          </div>
          <div className="tl-yield">
            <Money v={b.yield} dp={2} signed />
          </div>
        </div>
      ))}
    </div>
  );
}

/** 진행 점: 끝난 거래 ●, 진행 중 ◉, 남은 거래 ○ */
export function ProgressDots({ steps }: { steps: { label: string; state: "done" | "run" | "wait" }[] }) {
  return (
    <div className="pdots">
      {steps.map((s, i) => (
        <div key={i} className={`pdot ${s.state}`} title={s.label}>
          <span className="pdot-c" />
          {i < steps.length - 1 && <span className="pdot-l" />}
        </div>
      ))}
    </div>
  );
}

/** 가운데 확인 창 (배경을 누르면 닫힘) */
export function Modal({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}
