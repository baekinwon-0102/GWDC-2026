import type { ActionPreview, ChatMessage, ExecutionRecord, MissingField, Observation, PlanningResult, UserNeeds } from "../../shared/schemas";

// 버전 있는 로컬 저장. 비밀 정보(키·복구 구문·개인키)는 저장하지 않는다.
// 새 데이터를 읽어도 원계획을 덮어쓰지 않고 목록에 새 버전으로 추가한다.

export const SCHEMA_VERSION = 1;
const KEY = "gwdc.planner.v1";

export type ConvState = "collecting" | "awaiting_confirmation" | "confirmed" | "comparing";

export interface PersistedState {
  schemaVersion: number;
  needs: UserNeeds;
  convState: ConvState;
  messages: ChatMessage[];
  lastAsked?: MissingField;
  confirmedVersion?: number;
  analyses: PlanningResult[];
  selectedPlanId?: string;
  nile: {
    needs?: UserNeeds;
    /** Nile 요구사항 대화 (Mainnet 대화와 별도) */
    chat?: ChatMessage[];
    /** 대화로 모은 Nile 요구사항 초안. 폼에 반영되고, '이대로 확인'을 눌러야 계획을 계산한다 */
    draft?: UserNeeds;
    result?: PlanningResult;
    selectedPlanId?: string;
    preview?: ActionPreview;
    records: ExecutionRecord[];
    observations: Observation[];
  };
}

export function load(): PersistedState | undefined {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return undefined;
    const s = JSON.parse(raw) as PersistedState;
    if (s.schemaVersion !== SCHEMA_VERSION) return undefined;
    // 서명 창이 열린 채 새로고침하면 txID 없는 awaiting_signature가 남아 이후 거래를 영구히 막는다.
    // txID가 없으면 방송된 적이 없으므로(방송은 이 앱이 서명 후에만 한다) 거부로 정리한다.
    s.nile.records = s.nile.records.map((r) =>
      r.status === "awaiting_signature" && !r.txId ? { ...r, status: "rejected", error: "서명 완료 전에 페이지를 벗어났습니다. 방송되지 않았습니다." } : r,
    );
    return s;
  } catch {
    return undefined;
  }
}

export function save(s: PersistedState): string | undefined {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
    return undefined;
  } catch (e) {
    return `로컬 저장 실패 (${(e as Error).name}). JSON 내보내기로 백업하세요.`;
  }
}

export function clear() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* noop */
  }
}

export function exportJson(s: PersistedState) {
  const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), ...s }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `tromm-plan-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
