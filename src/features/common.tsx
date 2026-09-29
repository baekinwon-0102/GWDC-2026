import { useState } from "react";
import type { DataMode, Eligibility, SourceMeta, TxStatus } from "../../shared/schemas";
import { fmt } from "../../shared/units";

export function ModeBadge({ mode }: { mode: DataMode | "live" | "synthetic" }) {
  if (mode === "synthetic") return <span className="badge coral" title="가상 데이터. 실제 금리가 아닙니다">가상 시연</span>;
  if (mode === "snapshot") return <span className="badge amber">과거 데이터</span>;
  return <span className="badge teal">실데이터</span>;
}

export function ChainBadge({ chain }: { chain: "mainnet" | "nile" }) {
  return chain === "mainnet" ? <span className="badge gray">TRON Mainnet</span> : <span className="badge amber">Nile 테스트넷</span>;
}

export function EligibilityBadge({ e }: { e: Eligibility }) {
  if (e === "eligible") return <span className="badge teal">조건 충족</span>;
  if (e === "conditional") return <span className="badge amber">조건부</span>;
  return <span className="badge red">제외</span>;
}

const TX_LABEL: Record<TxStatus, [string, string]> = {
  preview: ["미리보기", "gray"],
  awaiting_signature: ["서명 대기", "amber"],
  submitted: ["제출됨", "amber"],
  pending: ["확정 대기 중", "amber"],
  confirmed: ["확정", "teal"],
  failed: ["실패", "red"],
  rejected: ["서명 거부", "gray"],
  unknown: ["방송 여부 확인 중", "amber"],
};
export function TxBadge({ s }: { s: TxStatus }) {
  const [label, color] = TX_LABEL[s];
  return <span className={`badge ${color}`}>{label}</span>;
}

export function Money({ v, asset, dp = 2, signed }: { v?: string; asset?: string; dp?: number; signed?: boolean }) {
  if (v === undefined) return <span className="muted">산정 불가</span>;
  const n = Number(v);
  const cls = signed ? (n > 0 ? "pos" : n < 0 ? "neg" : "") : "";
  return (
    <span className={cls}>
      {signed && n > 0 ? "+" : ""}
      {Number(fmt(v, dp)).toLocaleString("ko-KR", { minimumFractionDigits: dp, maximumFractionDigits: dp })}
      {asset ? ` ${asset}` : ""}
    </span>
  );
}

export function pct(v?: string, dp = 2) {
  if (v === undefined) return "-";
  return `${(Number(v) * 100).toFixed(dp)}%`;
}

/**
 * 출처 표시: 데이터 종류 배지와 조회 시각은 항상 보이고, 조회 방식·메모는 ⓘ에 마우스를 올리면 보인다.
 * (과거·가상 데이터 배지는 숨기지 않는다)
 */
export function SourceLine({ s, label }: { s: SourceMeta; label?: string }) {
  const method = s.accessMethod === "mcp" ? `MCP ${s.serverId ?? ""} ${s.toolName ?? ""}` : s.accessMethod === "direct" ? "직접 조회" : "fixture";
  const detail = `${s.chain === "mainnet" ? "Mainnet" : "Nile"} · ${method}${s.note ? ` · ${s.note}` : ""}${s.sourceUrl.startsWith("http") ? "" : ` · ${s.sourceUrl}`}`;
  return (
    <div className="tiny muted src-line">
      <ModeBadge mode={s.mode} />
      {label && <span>{label}</span>}
      <span className="tip" title={detail}>
        ⓘ {new Date(s.fetchedAt).toLocaleString("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })} 조회
      </span>
      {s.sourceUrl.startsWith("http") && (
        <a href={s.sourceUrl} target="_blank" rel="noreferrer">
          원문
        </a>
      )}
    </div>
  );
}

/** 긴 설명은 ⓘ 툴팁으로 (화면에는 아이콘만) */
export function Tip({ text, children }: { text: string; children?: React.ReactNode }) {
  return (
    <span className="tip" title={text}>
      {children ?? "ⓘ"}
    </span>
  );
}

/** 경고 목록은 개수 배지로 접고, 눌러야 펼친다 */
export function WarnBadge({ items, label = "경고" }: { items: string[]; label?: string }) {
  if (!items.length) return null;
  return (
    <details className="warn-details">
      <summary>
        ⚠ {label} {items.length}
      </summary>
      <ul className="clean small">
        {items.map((w) => (
          <li key={w}>{w}</li>
        ))}
      </ul>
    </details>
  );
}

/** 근거 자료를 탭 하나에 묶는다 (한 번에 한 탭만 그림) */
export function Tabs({ tabs }: { tabs: { id: string; label: string; body: React.ReactNode }[] }) {
  const list = tabs.filter((t) => t.body);
  const [cur, setCur] = useState(list[0]?.id);
  if (!list.length) return null;
  const active = list.find((t) => t.id === cur) ?? list[0];
  return (
    <div className="tabs">
      <div className="tabs-head">
        {list.map((t) => (
          <button key={t.id} className={t.id === active.id ? "active" : ""} onClick={() => setCur(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="tabs-body">{active.body}</div>
    </div>
  );
}

/** 단계 표시줄: 끝난 단계·현재 단계·남은 단계 */
export function Stepper({ steps, current, onPick }: { steps: string[]; current: number; onPick?: (i: number) => void }) {
  return (
    <div className="stepper">
      {steps.map((s, i) => (
        <button key={s} className={i < current ? "done" : i === current ? "cur" : ""} onClick={() => onPick?.(i)}>
          <span className="dot">{i < current ? "✓" : i + 1}</span>
          {s}
        </button>
      ))}
    </div>
  );
}

export function timeKo(iso?: string) {
  return iso ? new Date(iso).toLocaleString("ko-KR") : "-";
}
