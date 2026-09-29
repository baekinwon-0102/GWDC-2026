import { useMemo, useState } from "react";
import type { PersistedState } from "../../lib/storage";
import { addDays, daysBetween, demoNeeds, reservedWithinHorizon } from "../../../shared/needs";
import { Decimal } from "../../../shared/units";
import { Money } from "../common";

const DOW = ["일", "월", "화", "수", "목", "금", "토"];

function dateParts(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return { y, m, d, dow };
}

export default function Overview({ state, dataMode, onStart }: { state: PersistedState; dataMode?: "live" | "synthetic"; onStart: () => void }) {
  // 사용자가 금액과 지출을 입력했으면 그 값을, 아니면 고정 시연 사례를 보여준다.
  const userReady = Boolean(state.needs.amount && state.needs.expensesStated);
  const needs = userReady ? state.needs : demoNeeds();
  const isDemo = !userReady;

  const firstExpense = needs.expenses[0]?.date;
  const initialOffset = firstExpense ? Math.max(0, Math.floor(daysBetween(needs.startDate, firstExpense) / 7) * 7) : 0;
  const [offset, setOffset] = useState(initialOffset);
  const weekStart = addDays(needs.startDate, offset);
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  const reserved = useMemo(() => reservedWithinHorizon(needs), [needs]);
  const amount = new Decimal(needs.amount ?? 0);
  const investable = Decimal.max(amount.minus(reserved.total), 0);
  const s = dateParts(days[0]);
  const e = dateParts(days[6]);

  return (
    <div>
      <div className="hero">
        <div>
          <div className="eyebrow">Plan today, a brighter tomorrow</div>
          <h1 className="hero-title">
            지출 날짜를 먼저 <em>정해볼까요?</em>
          </h1>
          <p className="sub">미리 정한 지출이, 더 여유로운 자산 계획의 시작입니다.</p>
        </div>
        <div className="stack" style={{ alignItems: "flex-end", gap: 10 }}>
          <div className="hero-quote">
            오늘도, 계획하는 사람이
            <br />더 자유로운 내일을 만듭니다.
          </div>
          <div className="week-nav">
            <button aria-label="이전 주" onClick={() => setOffset((o) => o - 7)}>
              ‹
            </button>
            <span>
              {s.y}년 {s.m}월 {s.d}일 - {e.m}월 {e.d}일
            </span>
            <button aria-label="다음 주" onClick={() => setOffset((o) => o + 7)}>
              ›
            </button>
          </div>
        </div>
      </div>

      <div className="week">
        {days.map((iso) => {
          const p = dateParts(iso);
          const list = needs.expenses.filter((x) => x.date === iso);
          const has = list.length > 0;
          const outside = needs.endDate ? daysBetween(iso, needs.endDate) < 0 || daysBetween(needs.startDate, iso) < 0 : false;
          return (
            <div key={iso} className={`day ${has ? "has" : ""} ${outside && !has ? "outside" : ""}`}>
              <div className="dow">{DOW[p.dow]}</div>
              <div className="md">
                {p.m}월 {p.d}일
              </div>
              <div className="num">{p.d}</div>
              <div className="dot" />
              {has ? (
                list.map((x) => (
                  <div key={x.id} className="expense-chip">
                    <span style={{ fontSize: 22 }}>👛</span>
                    <div>
                      <div className="lbl">{outside ? "기간 밖 지출" : "예정 지출"}</div>
                      <div className="amt">
                        {Number(x.amount).toLocaleString("ko-KR")} {x.asset}
                      </div>
                    </div>
                  </div>
                ))
              ) : (
                <div className="none">{outside ? "운용 기간 밖" : "예정된 지출이 없습니다."}</div>
              )}
            </div>
          );
        })}
      </div>

      <div className="formula">
        <div>
          <h2 style={{ fontSize: 24, lineHeight: 1.35 }}>
            계획된 지출이 만드는
            <br />더 안정적인 오늘
          </h2>
          <p className="sub small">
            지출 일정을 먼저 정하면,
            <br />
            남은 자산을 더욱 현명하게 운용할 수 있습니다.
          </p>
          {isDemo ? (
            <div className="tiny muted" style={{ marginTop: 8 }}>
              <span className="badge coral">가상 시연</span> 1,000 USDT · 30일 · 7일 뒤 200 USDT 지출 사례
            </div>
          ) : (
            <div className="tiny muted" style={{ marginTop: 8 }}>
              <span className="badge teal">내 입력</span> 요구 분석에서 입력한 값 (v{needs.version})
            </div>
          )}
        </div>
        <div className="fcard teal">
          <div className="ico">🪙</div>
          <div>
            <div className="ttl">{isDemo ? "가상 잔액" : "보유 자산"}</div>
            <div className="val">
              {amount.toNumber().toLocaleString("ko-KR")} <small>{needs.asset}</small>
            </div>
            <div className="desc">{isDemo ? "현재 보유한 가상의 자산입니다." : "입력한 운용 대상 자산입니다."}</div>
          </div>
        </div>
        <div className="op">−</div>
        <div className="fcard coral">
          <div className="ico">📅</div>
          <div>
            <div className="ttl">지출 확보</div>
            <div className="val">
              {reserved.total.toNumber().toLocaleString("ko-KR")} <small>{needs.asset}</small>
            </div>
            <div className="desc">
              운용 기간 안 예정 지출{reserved.buffer.gt(0) ? "과 여유액" : ""} 합계입니다.
              {reserved.outside.length > 0 && ` 기간 밖 지출 ${reserved.outside.length}건은 제외.`}
            </div>
          </div>
        </div>
        <div className="op">=</div>
        <div className="fcard result">
          <div className="ico">◔</div>
          <div>
            <div className="ttl">운용 가능 상한</div>
            <div className="val">
              <Money v={investable.toFixed()} dp={0} /> <small>{needs.asset}</small>
            </div>
            <div className="desc">지출을 제외하고 운용할 수 있는 {isDemo ? "가상의 " : ""}상한 금액입니다.</div>
          </div>
        </div>
      </div>

      <div className="cta-wrap">
        <button className="cta" onClick={onStart}>
          조건 입력하기 →
        </button>
        <p className="muted small">지출 조건을 입력하고, 나에게 맞는 자산 계획을 비교해보세요.</p>
        {dataMode === "synthetic" && <p className="tiny muted">현재 DATA_MODE=synthetic: 계획 비교에 가상 금리를 사용합니다.</p>}
      </div>
      <div className="footer-line">GOOD WALLET, BRIGHTER DAYS</div>
    </div>
  );
}
