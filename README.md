# 💸 TRON 지출 일정 기반 자산 계획기

> **GWDC 2026 Challenge B · BaekInwon 구현**<br>
> 지출일에 쓸 돈은 먼저 안전하게 확보하고, 남은 자산의 계획별 **출금 비용을 포함한 순수익**을 비교합니다.

`React` · `TypeScript` · `Vite` · `Express` · `TRON` · `JustLend` · `Nile Testnet`

---

## ✨ 무엇을 하나요?

자연어 대화로 보유 자산, 지출 일정, 운용 기간, 위험 성향을 파악합니다. 계획 엔진이 지출 확보액을 먼저 계산한 뒤, 남은 금액을 다음 경로에 배분했을 때의 순수익을 **그냥 보유했을 때**와 비교합니다.

| 계획 | 경로 | 대상 |
| --- | --- | --- |
| **A / A-2** | JustLend 예치 (전액 / 절반) | USDT·USDD·TRX |
| **B** | USDD PSM 전환 → JustLend 예치 → 역전환 | 균형형 이상 |
| **C** | TRX 스테이킹 + SR 투표 | 공격형, 또는 TRX 보유자 |
| **L** | 지출일별 분산 예치·인출 조합 | 모든 허용 경로 |

### 핵심 원칙 🛡️

- **지출 우선** — `보유 자산 − 지출 확보액 = 운용 가능한 최대 금액`을 넘지 않습니다.
- **비용까지 계산** — 예치·인출·승인·전환·청구에 드는 Energy, Bandwidth, 수수료를 순수익에서 뺍니다.
- **위험 성향 반영** — 보수형은 안정자산 예치만, 균형형은 USDD 경로까지, 공격형은 TRX 스테이킹까지 고려합니다.
- **설명 가능한 추천** — 추천 이유, 손익분기점, 위험 등급, 데이터 출처를 화면에서 확인할 수 있습니다.

---

## 🚀 빠르게 시작하기

### 1. 요구 사항

- Node.js **20 이상**
- 선택: NVIDIA NIM API 키, TronGrid API 키, TronLink 지갑 (Nile 실행 시)

### 2. 설치 및 실행

```powershell
npm install
Copy-Item .env.example .env.local   # 이미 있으면 생략
npm run dev                         # 웹 5173 + 로컬 API 8787
```

브라우저에서 [http://127.0.0.1:5173](http://127.0.0.1:5173)을 엽니다.

### 3. 품질 확인

```powershell
npm run typecheck   # 타입 검사
npm test            # 테스트 실행
npm run build       # 프로덕션 빌드
npm run doctor      # 외부 연결 상태 진단
```

### 환경 변수 🔐

키는 `.env.local`에만 넣고 커밋하지 마세요. 전체 목록과 예시는 [.env.example](./.env.example)를 참고하세요.

| 변수 | 용도 |
| --- | --- |
| `NIM_API_KEY`, `NIM_MODEL` | NVIDIA NIM LLM 연결 |
| `TRONGRID_API_KEY` | TronGrid RPC 및 MCP 인증 |
| `DATA_MODE` | `synthetic`(가상 금리·배지 표시) / `live`(실데이터) |
| `ENABLE_NILE_EXECUTION` | `true`일 때 Nile TronLink 서명 버튼 활성화 |
| `MCP_TRONGRID_ENABLED` | 호스팅 TronGrid MCP 사용 |
| `MCP_JUSTLEND_COMMAND`, `MCP_USDD_COMMAND` | 공식 MCP stdio 실행 명령 |

---

## 🗺️ 화면 안내

| 화면 | 할 수 있는 일 |
| --- | --- |
| **개요** | 주간 지출 달력과 운용 가능 상한을 확인합니다. 입력 전에는 `가상 시연` 사례를 보여 줍니다. |
| **요구 분석** | LLM은 자연어에서 값만 추출하고, 누락 정보·다음 질문·확인은 코드가 결정합니다. 장애 시 폼과 규칙 기반 대화로 대체합니다. |
| **계획 비교** | 추천 카드, 지출일별 분산 타임라인, 비교표, AI 설명, 근거 탭을 제공합니다. 복수 자산은 합산 카드와 자산별 전환을 지원합니다. |
| **시장 데이터** | JustLend, USDD PSM, Nile jTRX 원시값 및 MCP 연결 상태를 봅니다. |
| **Nile 실행** | 계획 선택부터 TronLink 서명, 영수증 확정, 포지션 재조회와 조정까지 안내합니다. |
| **실행 기록** | Nile 거래를 계획별로 묶어 txID, 확정 상태, 실제 수수료와 Energy를 확인합니다. |
| **검토** | Mainnet 분석 버전, Nile 거래, 예상 대비 관측 이자, JSON 내보내기를 관리합니다. |

### Nile 실행 흐름 ⛓️

```text
지갑 연결 → 요구사항 확인 → 계획 비교 → 계획 선택
        → 거래 묶음 확인 → 거래별 서명 → 영수증 확정 → 포지션 재조회
```

- 예치와 인출은 별도 버튼으로 실행하며, 서명 전 거래 목록·금액·수수료 합계·승인 범위·위험을 한 번 더 확인합니다.
- 중단 후 다시 실행하면 확정 거래는 건너뛰고, 확정 대기 거래는 기존 txID를 계속 확인합니다.
- 지출일별 분산안은 날짜별로 인출합니다. 스테이킹은 해제 시작 후 대기 기간을 거쳐 수령합니다.
- 앱이 열려 있는 동안 Nile 포지션을 1분마다 다시 읽어, 부족 시 부분 인출·종료 시 전액 인출·조건 완화 시 추가 예치를 제안합니다. 백그라운드 감시는 하지 않습니다.

---

## 🧮 계획과 계산 방식

### 지출일별 분산 계획 L

지출일을 기준으로 `비상 여유액 → 각 지출일까지 → 운용 종료일까지` 구간을 나눕니다. 구간마다 보유·예치·USDD 경로·스테이킹의 허용 조합을 계산해 순수익 합계가 가장 높은 배분을 선택합니다.

같은 상품은 한 번 예치하고 인출만 날짜별로 수행합니다. 스테이킹은 필요한 날짜보다 14일 먼저 해제합니다. 단일 계획 A도 후보 조합 중 하나이므로 **L의 수익은 항상 A 이상**입니다.

### 보유 자산과 지출 자산이 다를 때

USDT·USDD·TRX 복수 보유를 지원하며, 지출 자산이 다르면 SunSwap 견적으로 필요한 보유 자산량과 환전 비용을 역산합니다. 견적을 받지 못하면 보유액 전부를 지출 확보액으로 두고 이유를 알립니다.

### 비용 가정 선택

계획 비교 및 Nile 조건 폼에서 아래 기준을 선택해 다시 계산할 수 있습니다.

- Energy 조달: **TRX 소각 / 스테이킹 확보 / JustLend 대여**
- 거래 비용: **실측 최대값 / 실측 중앙값 / 공식 일반값**

스테이킹 선택 시 필요한 TRX를 경고하며, 대여 선택 시 체인에서 읽은 대여율·수수료·최소 수수료를 반영합니다.

---

## 🏗️ 프로젝트 구조

```text
shared/
  schemas.ts       공통 계약과 스키마
  needs.ts         요구사항·누락 정보 판정
  planning.ts      계획 A / A-2 / B / C / L 계산 엔진
  ladder.ts        지출일별 분산 계산
  risk.ts          위험 성향 정책
  screening.ts     기회 탐색과 심사
  replay.ts        과거 재생
  adjust.ts        Nile 조정·리밸런스
  eligibility.ts · units.ts · fx.ts · costmode.ts · agent.ts

server/
  index.ts         로컬 API
  env.ts · doctor.ts
  llm/             NIM, Bank of AI, 템플릿 제공자
  agent/           읽기 전용 도구 루프와 재평가
  mcp/             읽기 전용 허용 목록과 클라이언트
  data/            JustLend · USDD · SunSwap · 스테이킹 · Tron RPC 데이터

src/
  App.tsx
  features/        overview · conversation · plans · market · execution · review · agent
  lib/             API · 저장소 · TronLink · 거래 폴링

fixtures/          synthetic-quotes.json
tests/             계획 · LLM/MCP · 에이전트 · Nile 포트폴리오 테스트
```

### 로컬 API

| 목적 | 엔드포인트 |
| --- | --- |
| 상태 확인 | `GET /api/health` |
| 대화·계획 생성 | `POST /api/chat`, `POST /api/plans` |
| 시장·관측 | `GET /api/market`, `POST /api/observe` |
| Nile 거래·조정 | `GET /api/transactions/:txId?chain=nile`, `POST /api/nile/adjust` |
| 조사·재평가 | `POST /api/agent/run`, `POST /api/agent/reevaluate` |
| 과거 재생 | `POST /api/replay` |

---

## 📡 데이터와 검증

> 실제 API·MCP 호출 전체, 계산식, 코드 상수의 사유, 검증 내역은 **[SOURCES.md](./SOURCES.md)**에 정리되어 있습니다.

| 데이터 | 출처와 방식 |
| --- | --- |
| jUSDT/jUSDD APY·유동성·TRX 가격 | JustLend 공식 OpenAPI `GET /lend/jtoken` 직접 조회 및 공식 배포 주소 대조 |
| 예치 중지 여부 | Comptroller `mintGuardianPaused` 온체인 읽기 |
| PSM 수수료·활성 상태·여유 | USDD PSM·Vat·GemJoin 계약 온체인 읽기 |
| PSM 및 jToken 거래비용 | TronGrid의 최근 성공 거래 영수증에서 Energy·Bandwidth 실측 최대값 산출 |
| Energy/Bandwidth 단가 | TronGrid MCP 우선, 실패 시 직접 RPC `getChainParameters` |
| jToken 채굴 보상 | JustLend 앱 백엔드의 최근 24시간 보상량·예치 총액 조회 |
| TRX 스테이킹·투표 보상 | 체인 파라미터, SR 목록, brokerage를 이용해 투표자 APR 산출 |
| Nile jTRX 금리·포지션 | JustLend-TRX 계약 온체인 읽기 |

### 코드에 둔 값과 대체값

공식 조회 수단이 없는 TRON 프로토콜 상수, 화면 정책 임계값, 승인·보상 청구의 공식 일반값은 코드에 명시합니다. 실측이 실패하면 스테이킹 대역폭 `300 bytes`, 투표 반영 지연 `6시간`, jToken 일반값을 사용하고 화면에 `추정` 또는 `일반값`으로 표시합니다.

---

## 🔎 구현 현황 및 알아둘 점

<details>
<summary><strong>LLM · 조사 에이전트</strong></summary>

- NVIDIA NIM의 `nvidia/nemotron-3-super-120b-a12b`를 호출합니다. 사고 과정은 끄고, 계산 결과에 없는 숫자·영문 추론·필드명이 섞인 답변은 템플릿으로 대체합니다.
- `LLM_PROVIDER=bai` Bank of AI 어댑터도 구현되어 있습니다. 현재 확인 당시 계정 잔액이 0이어서 실제 응답은 검증하지 못했습니다. 크레딧 충전 뒤 `npm run doctor`로 확인할 수 있습니다.
- 조사 에이전트는 상품·시뮬레이션·손익분기점·시세 이상·Nile 영수증을 읽기 전용 도구로 조회합니다. 최종 금액과 추천은 항상 계획 엔진 및 검증 게이트가 결정합니다.
</details>

<details>
<summary><strong>MCP · 외부 연결</strong></summary>

- TronGrid 호스팅 MCP는 읽기 도구 2개만 허용합니다.
- 공식 JustLend·USDD MCP는 시작 시 `~/.agent-wallet`을 만들며, USDD MCP PSM 도구는 물량을 반환하지 않습니다. 이 때문에 시장·PSM 조회는 직접 온체인 조회로 대체합니다.
- TronGrid 요청 제한(HTTP 429)에 대비해 체인별 동시 요청을 4개로 제한하고 자동 재시도합니다. 서버 직후 1분 내 첫 계산은 느릴 수 있습니다.
</details>

<details>
<summary><strong>상품별 처리</strong></summary>

- **jUSDD 보상**은 공지 기간·실제 지급·30일 연속 지급으로 검증된 기간의 몫만 순수익에 넣고, 이후 보상은 참고로만 보입니다.
- **USDD 보유자**도 jUSDD 예치(A), PSM→jUSDT(B), PSM→SunSwap→스테이킹(C), 구간별 조합(L)을 이용할 수 있습니다.
- **TRX 보유자**는 jTRX 예치(A/A-2), 직접 스테이킹(C), SunSwap과 PSM을 거치는 B를 비교합니다. USDT 보유자가 C를 선택하면 SunSwap 왕복 비용·가격 스트레스도 포함합니다.
- **sUSDD**는 TRON에 배포되지 않아 탐색 표에서 `TRON 미배포`로 표시하며, Ethereum·BSC 금리는 참고용입니다.
</details>

<details>
<summary><strong>실행 범위와 미구현 항목</strong></summary>

- Mainnet은 **조회 전용 조건부 분석**입니다. Mainnet USDT·USDD 계획의 실제 실행 기준은 부분 구현 상태입니다.
- Nile은 예상 손실이어도 실행할 수 있으나 추천은 보유가 될 수 있습니다. 현재 거래비용은 체인 영수증 실측 최대값을 사용합니다.
- Nile 부분 인출의 실제 TronLink 서명 테스트와 JSON 가져오기(P1)는 아직 구현하지 않았습니다. 과거 재생은 최근 30일 이력만 지원합니다.
</details>

---

## 📌 예시 관측값

> 시장 데이터는 계속 변합니다. 아래 값은 구현 검증에 사용한 당시의 관측 예시이며, 실행 전에는 반드시 최신 데이터를 다시 조회합니다.

| 사례 | 결과 |
| --- | --- |
| 1,000 USDT · 30일 | A 기본 이자보다 왕복 비용이 커 `보유` 권고 |
| 60,000 USDT · 90일 · 60일 뒤 30,000 지출 | L 약 `+211` vs A 약 `+125` |
| 60,000 USDT · 180일 · 공격형 | C 약 `+359.40 USDT` |
| 20,000 USDD · 90일 · 30일 뒤 5,000 USDT 지출 | B 약 `+34.62 USDD`로 추천 |
| 10,000 TRX · 90일 | C 약 `+66.6 TRX`로 추천 |

---

## ⚠️ 면책 및 보안

- 이 도구는 자산 계획을 돕는 분석 도구이며, 투자 조언이나 수익을 보장하지 않습니다.
- 거래 전 지갑 주소, 체인, 계약, 메서드, 승인 범위, 비용 상한, 유효 시각을 확인하세요.
- `.env.local`, 지갑 비밀키, 시드 문구는 절대 공유하거나 커밋하지 마세요.

즐거운 계획, 안전한 실행을 바랍니다. 🌱
