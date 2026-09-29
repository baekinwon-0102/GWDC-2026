import { useEffect, useRef } from "react";
import type { Update } from "../App";
import { api } from "./api";
import type { PersistedState } from "./storage";
import { TX_KIND_KO, type TxStatus } from "../../shared/schemas";

const TX_EXPIRED_MS = 5 * 60 * 1000;

/**
 * 미확정 Nile 거래의 원 txID를 재조회한다 (새로고침 후 포함). 자동으로 다시 서명하지 않는다.
 * 어느 탭을 보고 있어도 돌도록 App에서 한 번만 쓴다. 확정되면 같은 포지션을 다시 읽어 관측으로 남긴다.
 */
export function useTxPolling(state: PersistedState, update: Update, notify: (m: string) => void) {
  const polling = useRef(false);
  const records = state.nile.records;
  useEffect(() => {
    const pending = records.filter((r) => r.txId && ["submitted", "pending", "unknown"].includes(r.status));
    if (!pending.length) return;
    const timer = window.setInterval(async () => {
      if (polling.current) return;
      polling.current = true;
      try {
        for (const rec of pending) {
          const t = await api.tx(rec.txId!).catch(() => undefined);
          if (!t) continue;
          if (t.status === "confirmed" || t.status === "failed") {
            update((s) => ({
              ...s,
              nile: {
                ...s.nile,
                records: s.nile.records.map((r) =>
                  r.id === rec.id
                    ? { ...r, status: t.status as TxStatus, confirmedAt: new Date().toISOString(), blockNumber: t.blockNumber, feeTrx: t.feeTrx, energyUsed: t.energyUsed, error: t.status === "failed" ? `계약 실행 결과: ${t.result}` : undefined }
                    : r,
                ),
              },
            }));
            if (t.status === "confirmed") {
              try {
                const o = await api.observe(rec.wallet, rec.planId);
                update((s) => ({ ...s, nile: { ...s.nile, observations: [...s.nile.observations, { ...o.observation, planId: rec.planId }] } }));
                notify(`거래 확정: ${TX_KIND_KO[rec.kind]} ${rec.amountDisplay}. 포지션을 다시 조회했습니다.`);
              } catch {
                notify("거래는 확정됐지만 포지션 재조회에 실패했습니다. 검토 탭에서 다시 조회하세요.");
              }
            }
          } else if (t.status === "not_found" && rec.submittedAt && Date.now() - Date.parse(rec.submittedAt) > TX_EXPIRED_MS) {
            // TRON 거래는 참조 블록 후 약 60초에 만료된다. 충분히 지나도 없으면 포함되지 않은 것으로 본다 (재서명은 사용자가 새로).
            update((s) => ({ ...s, nile: { ...s.nile, records: s.nile.records.map((r) => (r.id === rec.id ? { ...r, status: "failed", error: "거래가 만료 시간까지 체인에 포함되지 않았습니다 (자금 이동 없음)." } : r)) } }));
          } else if (t.status === "pending" && rec.status !== "pending") {
            update((s) => ({ ...s, nile: { ...s.nile, records: s.nile.records.map((r) => (r.id === rec.id ? { ...r, status: "pending", blockNumber: t.blockNumber } : r)) } }));
          }
        }
      } finally {
        polling.current = false;
      }
    }, 4000);
    return () => window.clearInterval(timer);
  }, [records, update, notify]);
}
