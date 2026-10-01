# GWDC 2026 Challenge B — TRON 지출 일정 기반 자산 계획 (BaekInwon 구현)

사용자의 지출 일정과 위험 성향을 대화로 확인합니다. 지출일에 쓸 돈을 먼저 확보한 뒤, 남은 돈을 JustLend jUSDT 예치(A)와 USDD PSM → jUSDD 경로(B)에 넣었을 때의 **출금까지 포함한 순수익**을 전액 보유 기준선과 비교합니다. Nile 테스트넷에서는 별도 계획으로 실제 jTRX 예치·확정·재조회를 합니다.

## 실행

```powershell
cd TeamBaek\BaekInwon
npm install
Copy-Item .env.example .env.local   # 이미 있으면 생략. 키는 이 파일에만 넣는다
npm run dev          # 웹(http://127.0.0.1:5173) + 로컬 API(127.0.0.1:8787) 동시 실행
npm run typecheck
npm test
npm run build
npm run doctor       # 외부 연결 진단 (성공/실패/미확인)
```

주요 환경 변수 (`.env.example` 참고)

| 변수 | 설명 |
| --- | --- |
| `NIM_API_KEY`, `NIM_MODEL` | NVIDIA NIM. 사용 모델 `openai/gpt-oss-20b` |
| `TRONGRID_API_KEY` | TronGrid RPC와 TronGrid MCP 헤더 |
| `DATA_MODE` | `synthetic`(가상 금리, 배지 표시) / `live`(실데이터) |
| `ENABLE_NILE_EXECUTION` | `true`여야 TronLink 서명 버튼이 활성화됨 |
| `MCP_TRONGRID_ENABLED` | 호스팅 TronGrid MCP 연결 (Mainnet 수수료 파라미터 조회) |
| `MCP_JUSTLEND_COMMAND`, `MCP_USDD_COMMAND` | 공식 MCP stdio 실행 명령 (기본 비움, 아래 한계 참고) |

## 화면 흐름

1. **개요**: 주간 지출 달력과 `보유 − 지출 확보 = 운용 가능 상한`. 입력 전에는 고정 시연 사례를 `가상 시연` 배지와 함께 보여줌
2. **요구 분석**: LLM이 자연어에서 입력만 추출하고, 누락 항목과 다음 질문은 코드가 결정함. 요약을 확인하기 전에는 계획을 만들지 않고, 확인 후 입력이 바뀌면 확인과 선택을 무효화함. LLM 장애 시 규칙 기반 템플릿과 폼으로 대체함
3. **계획 비교**: 맨 위 추천 카드(계획·순수익·배분 막대·이유 한 문장·지출 확보 계산식) → "돈이 필요한 날짜에 맞춰 나눠 넣기" 타임라인(인출일별 분산 L의 구간별 막대, 이유·날짜별 거래는 펼침) → 다른 계획 카드(순수익 큰 순, 손익분기·위험 등급, 사유는 ⓘ) → "계획 자세히 비교"를 펼치면 전체 비교표 → AI 설명(세 줄 요약 + 더 보기)과 질문 → 하단 근거 탭(상품 탐색·보상 검증·최고 APY 비교·데이터 출처). 여러 자산이면 합산 배분 막대와 자산 전환 버튼(USDT / TRX)
4. **시장 데이터**: JustLend, USDD PSM, Nile jTRX 원시 값과 MCP 연결 상태
5. **Nile 실행**: 한 칸 세로 흐름. 맨 위 지갑 상태줄(주소·TRX·jTRX 예치·스테이킹·미청구 보상)이 항상 보이고, 단계 표시줄 아래로 조건(끝나면 한 줄) → 계획 카드(순수익·필요한 서명 수) → 실행 카드(예치/인출 버튼과 진행 점) → 포지션 관리 → 실행 기록 요약 순서. 포지션 조정 거래의 확인은 화면을 바꾸지 않고 가운데 팝업으로 뜸. 세부 흐름: TronLink 연결 → Nile 요구사항을 대화 또는 폼으로 확인(운용 중 지출일·위험 성향 포함) → Mainnet과 같은 계획 엔진으로 계산한 계획 비교(jTRX 최대 예치 / 50%, TRX 스테이킹 C, 인출일별 분산 L, USDD 경로 B는 Nile PSM의 테스트 USDT를 얻을 방법이 없어 제외) → 계획을 고르면 **예치 / 인출 버튼 두 개**로 실행: 버튼을 누르면 묶음 전체(거래 목록·예상 금액·수수료 합계·승인 범위·위험)를 한 번 확인하고, 앱이 거래를 순서대로 진행(거래마다 TronLink 서명 창 → 확정 영수증 확인 → 다음 거래). 중간에 멈추면 다시 눌렀을 때 확정된 거래는 건너뛰고 확정 대기 거래는 원 txID를 기다림. 인출은 날짜별 묶음(인출일별 분산은 날짜마다, 스테이킹은 해제 시작 → 대기 뒤 수령). 예정일 전 묶음은 테스트 확인 후 앞당겨 실행 가능. 각 거래는 → 거래 전 확인(지갑·체인·금액·계약·메서드·승인 범위·비용 상한·위험·유효 시각) → 서명 직전 재확인 → 서명 → txID 즉시 저장 → 확정 영수증 → 같은 포지션 재조회. 인출(redeem)도 같은 절차. jTRX 포지션과 스테이킹 포지션을 각각 모니터링해 조정(부분 인출·해제·해제분 인출·투표·보상 청구)을 제안
6. **실행 기록** (Nile 실행 탭의 "실행 기록 보기" 버튼 또는 상단 탭): 계획별로 묶은 Nile 거래의 txID·확정 여부·실제 수수료·Energy, 상태 필터(전체·진행 중·확정·실패), 최근 관측. 미확정 거래 재조회는 앱 전체에서 돌아 이 탭에 있어도 멈추지 않음
7. **검토**: Mainnet 분석 기록(버전 누적), Nile 거래 기록, 예상 vs 관측 이자, JSON 내보내기

## 구조

```text
shared/   schemas.ts(공통 계약) · needs.ts(요구사항·누락 판정) · planning.ts(계산 엔진, 계획 A/A-2/B/C/L) · ladder.ts(인출일별 분산) · risk.ts(위험 성향 정책) · screening.ts(기회 탐색) · replay.ts(과거 재생) · adjust.ts(Nile 조정·리밸런스) · eligibility.ts · units.ts · agent.ts
server/   index.ts(로컬 API) · env.ts · doctor.ts
          llm/ provider.ts · nim.ts(OpenAI 호환 공통 + NIM) · bai.ts(Bank of AI) · template.ts
          agent/ tools.ts(읽기 전용 도구) · loop.ts(도구 선택 루프·최종 게이트) · reevaluate.ts
          mcp/ clients.ts · registry.ts(읽기 전용 허용 목록)
          data/ justlend.ts(시장·채굴 보상·실측 비용) · campaigns.ts(채굴 캠페인 공지 등록부) · discovery.ts(전체 시장) · usdd.ts · staking.ts(TRX 스테이킹·SR 투표) · tron-rpc.ts · quotes.ts
src/      App.tsx · features/{overview,conversation,plans,market,execution,review,agent} · lib/{api,storage,tronlink}.ts
fixtures/ synthetic-quotes.json (DATA_MODE=synthetic용 가상 시세)
tests/    planning.test.ts · llm-and-mcp.test.ts · bai.test.ts · agent.test.ts · adjust-staking-rewards.test.ts
```

로컬 API는 `GET /api/health`, `POST /api/chat`, `POST /api/plans`, `POST /api/observe`, `GET /api/transactions/:txId?chain=nile`이고, 시장 데이터 탭용으로 `GET /api/market`, P1 조사 에이전트용으로 `POST /api/agent/run`·`POST /api/agent/reevaluate`, Nile 포지션 조정·리밸런스용으로 `POST /api/nile/adjust`, 과거 재생용으로 `POST /api/replay`가 추가되어 있습니다.

## 데이터 출처와 접근 방식

> 실제 호출하는 API·MCP 전체 목록, 계산식, 코드에 둔 값의 사유, 검증 내역은 [SOURCES.md](./SOURCES.md)에 한 문서로 정리했습니다.

| 값 | 출처 | 방식 |
| --- | --- | --- |
| jUSDT/jUSDD 공급 APY, 인출 유동성, USDT의 TRX 가격 | JustLend 공식 OpenAPI `GET /lend/jtoken` | 직접 조회. 주소를 공식 배포 주소와 대조함 |
| 예치 중지 여부 | Comptroller `mintGuardianPaused` | 온체인 읽기 |
| PSM 수수료·활성 상태, 진입 여유(`Vat.ilks` line − Art×rate), 출구 USDT | USDD PSM·Vat·GemJoin 계약 | 온체인 읽기 |
| PSM 전환 Energy·대역폭 | 최근 성공한 sellGem/buyGem 거래 50건의 영수증 실측 최대값 | TronGrid |
| Energy/Bandwidth 단가 | `getChainParameters` | **TronGrid MCP** 우선, 실패 시 직접 RPC |
| jUSDT·jUSDD 예치·인출 Energy·대역폭 | 각 jToken 계약 최근 성공 거래 100건(mint(uint256)·redeem·redeemUnderlying) | TronGrid 영수증 실측 최대값. 실패하면 공식 JustLend MCP `TYPICAL_RESOURCES` 일반값 |
| 승인(approve)·보상 청구 Energy | 공식 JustLend MCP 소스의 `TYPICAL_RESOURCES` (approve 23,000, claim 60,000) | 일반값. 승인은 USDT 계약 거래가 너무 많아 JustLend용만 골라낼 수 없고, 보상 분배 계약은 조회되는 최근 거래가 없어 실측하지 못함 |
| jUSDT/jUSDD 채굴 보상 (최근 24시간 보상량, 예치 총액) | JustLend 앱 백엔드 `labc.ablesdxd.link/justlend/markets/jtokenDetails` (공식 JustLend MCP가 쓰는 호스트) | 직접 조회. 추정 APR = 일일 보상 가치 × 365 ÷ 예치 총액. **캠페인 종료 시점을 확인할 수 없어 미확인으로 두고 순수익에서 제외**, "참고" 줄에만 표시 |
| TRX 스테이킹·투표 보상 (계획 C) | `getchainparameters`(블록당 투표 보상·생산 보상, 해제 대기 일수, 유지보수 주기 = 투표 반영 지연) + `listwitnesses` + `getBrokerage` | TronGrid 체인 조회로 투표자 APR 계산. 상위 27개 SR 중 최대값 선택 |
| 스테이킹 거래 대역폭 (스테이킹·투표·청구·해제·해제분 인출) | 최근 블록에서 해당 거래를 보낸 계정들의 거래 이력 영수증 | 유형별 실측 최대값(1일 캐시). 표본이 없는 유형(주로 해제)은 측정된 스테이킹 거래 중 최대값으로 채우고 화면에 표시. 측정 실패 시 300 bytes 추정 |
| Nile jTRX 연간 블록 수 | jTRX 금리 모델 계약 `blocksPerYear()` | 온체인 읽기 (계약이 실제 금리 계산에 쓰는 값) |
| 보상의 달러 → 자산 환산 | JustLend 앱 백엔드 `priceUSD` (USDT·USDD) | 보상 가치(USD) × (기초자산 가격 ÷ USDT 가격) |
| Nile jTRX 거래 Energy·대역폭 (예치·전액 인출·부분 인출) | jTRX 계약 최근 성공 거래 100건 | TronGrid(Nile) 영수증 실측 최대값. 표본이 없으면 일반값 |
| Nile jTRX 금리·현금·포지션 | `TKM7w4qFmkXQLEF2MgrQroBYpd5TY7i1pq` (계약명 JustLend-TRX 확인) | 온체인 읽기 |

### 외부에서 받지 않는 값 (공식 조회 수단이 없어 코드에 둠)

- **TRON 프로토콜 상수**: 3초 블록(연 10,512,000블록, 스테이킹 보상 계산용), 블록 생산 SR 27개·투표 보상 대상 127개
- **공식 일반값**: 승인 23,000 / 보상 청구 60,000 Energy (공식 JustLend MCP 소스)
- **판단 기준(정책)**: 시세 이상 감지 임계값(금리 50% 초과·0.01% 미만·30% 급변, 유동성 2배 미만, 1 USDT 0.5~50 TRX 범위, SR 수수료 50% 초과), 포지션 조정(최소 1 TRX, 부족분 98% 이상이면 전액 인출), USDD 디페깅 스트레스(0.5%·2%), SR 후보(상위 27개 중 APR 최대), 수수료 상한 50 TRX, 모니터링·재평가 주기
- **측정 실패 시 대체값**: 스테이킹 거래 300 bytes 추정, 투표 반영 지연 6시간, jToken 거래 일반값 (화면에 "추정"·"일반값"으로 표시)

## 구현 범위와 한계

- **LLM**: NVIDIA NIM `nvidia/nemotron-3-super-120b-a12b`를 실제로 호출함(추출 약 1초, 설명 약 2~6초). 사고 과정(`enable_thinking`)을 꺼서 영문 사고 과정이 답변으로 새는 문제를 막았고, 설명용 데이터의 키도 한국어로 둠. 기존 `openai/gpt-oss-20b`는 2026-09-29 기준 응답이 없어(45초 시간 초과) 교체함. AI 설명은 계산 결과에 없는 숫자, 한국어 외 문자, 영문 추론 누출, 필드 이름이 있으면 폐기하고 템플릿을 씀
- **Bank of AI(해커톤 "TRON LLM")**: 어댑터(`bai.ts`, `LLM_PROVIDER=bai`)는 구현했고 키 인증·모델 목록(`gpt-5.6-terra` 포함)은 확인함. 하지만 계정 잔액이 0이라 모든 모델이 `Deposit required`/`insufficient balance`로 거부되어 **실제 응답은 확인하지 못함**. 크레딧 충전 후 `LLM_PROVIDER=bai`로 바꾸고 `npm run doctor`로 확인
- **MCP**: TronGrid 호스팅 MCP는 연결되며, 도구 149개를 발견하고 읽기 도구 2개만 허용함. 공식 JustLend·USDD MCP는 시작할 때 `~/.agent-wallet` 지갑을 자동으로 만들고, USDD MCP의 PSM 도구는 물량을 반환하지 않음. 그래서 문서 규칙에 따라 시장·PSM 조회는 직접 조회로 대체함. 클라이언트와 허용 목록은 구현되어 있어 실행 명령을 넣으면 연결됨
- **보상**: jUSDD 채굴 보상(현재 연 약 4%, USDD 2.0 공급 채굴 Phase 22)을 **공지 기간 + 실제 지급 + 30일 연속 지급**으로 검증해, 캠페인 종료일(10/10)까지의 몫만 순수익에 넣음(청구 비용 차감). 이후 기간은 다음 회차 공지 전이라 "참고" 줄에만 보임. 캠페인 기간은 공지를 확인해 `server/data/campaigns.ts`에 수동 등록함
- **인출일별 분산 (계획 L)**: 돈이 필요한 날짜별로 구간(비상 여유액 · 지출일마다 · 운용 끝까지)을 나누고, 구간마다 보유·같은 자산 예치(jUSDT/jTRX)·USDD 경로·TRX 스테이킹의 모든 조합을 계산해 순수익 합계가 최대인 배분을 고름(`shared/ladder.ts`). 같은 상품은 예치 한 번·인출은 날짜마다, 스테이킹은 인출일 14일 전 해제를 반영. 단일 계획 A도 조합 중 하나라 L은 항상 A 이상. 실데이터: USDT 60,000/90일(60일 뒤 30,000 지출) L +211 vs A +125, TRX 10,000/90일(20·45일 뒤 지출) L +41 vs C +33
- **위험 성향**: 보수적은 원금 고정 스테이블(A·A-2)만 허용하고 수익이 나는 계획 중 예치 비중이 가장 작은 것을 추천. 균형형은 USDD 경로까지, 공격적은 TRX 스테이킹까지 허용하고 순수익 최대를 추천
- **계획 A-2**: 같은 jUSDT에 운용 가능액의 절반만 예치하는 배분안. 10,000 USDT / 90일이면 A(+31)와 A-2(+8) 모두 순수익이 양수라 실행 가능한 계획이 두 개가 됨
- **기회 탐색**: JustLend 24개 시장 + USDD PSM + TRX 스테이킹(26개)을 심사해 분석 대상과 제외 사유를 표로 보임
- **과거 재생(시뮬레이션)**: 검토 탭에서 계획 A·A-2·B를 최근 30일 실제 일별 금리로 재생해 계획 가정과 비교
- **리밸런스**: Nile은 목표 배분(최대 ↔ 절반) 변경 시 초과분 부분 인출·부족분 추가 예치, Mainnet은 재평가에서 추천이 바뀌면 유지 vs 전환 가치를 코드로 비교
- **현재 실데이터 결과**: 1,000 USDT·30일 사례에서 A의 기본 이자(약 1.30 USDT)보다 왕복 비용(약 22 TRX ≈ 7.4 USDT)이 커서 **거래 보류(보유)를 권고함**. jUSDD 금리가 거의 0이라 B도 음수임
- **계획 C (TRX 스테이킹 + SR 투표)**: 투표자 APR(현재 약 3.2%)과 해제 대기 14일을 반영한 보상 기간(운용 기간 − 14일 − 0.25일)으로 수익을 계산함. 보유 자산이 USDT이면 **SunSwap V2로 USDT→TRX 교환 → 스테이킹 → TRX→USDT 되돌림** 왕복으로 계산함(풀 준비금 공식을 라우터 견적과 교차 검증, 교환 거래비용 실측, 교환 손실은 전환 수수료, TRX 가격 스트레스 표시, 가격 변동 등급이라 공격적 성향에서만 후보). 실데이터 기준 60,000 USDT·180일 +359.40 USDT
- **수익 표시 단위 TRX 통일**: 계획 비교 탭의 모든 순수익(추천 카드·계획 카드·타임라인·비교표·여러 자산 합계)을 TRX로 크게 보이고 원래 자산 금액을 작게 함께 적음(예: +95.34 TRX (+31.96 USDT)). 환산은 JustLend 오라클 가격(1 USDT·1 USDD가 몇 TRX인지, 조회 시점). 계산과 추천 순위는 보유 자산 단위 그대로라 바뀌지 않음
- **비용 가정 선택**: 계획 비교 탭의 "비용 가정"(또는 Nile 조건 폼)에서 Energy 조달 방식(TRX 소각 / 스테이킹으로 확보 / JustLend 대여)과 비용 기준(실측 최대값 / 실측 중앙값 / 공식 일반값)을 골라 다시 계산함. 스테이킹은 필요한 스테이킹 TRX를 경고로 알려 주고, 대여는 JustLend 대여 계약의 대여율·수수료·최소 수수료를 체인에서 읽어 날짜마다 1시간 빌린다고 계산함. 실데이터 기준 10,000 USDT·30일 A의 순수익: 소각·최대값 +0.77 → 중앙값 +3.70 → 일반값 +8.12 → 스테이킹 +15.21, 대여 −4.53(최소 수수료 20 TRX × 2회 때문에 소각보다 비쌈)
- **USDD 보유자**: 보유 자산으로 USDD를 고를 수 있음(대화 "USDD 2,000…"·폼·여러 자산 조합). A = jUSDD 예치(검증된 채굴 보상 포함), B = PSM으로 USDT를 받아 jUSDT 예치 후 되돌림(USDD만 가진 사람에게는 USDD 위험 동의를 묻지 않음), C = PSM → SunSwap → TRX 스테이킹 → 역순, L = 구간마다 jUSDD 예치·스테이킹·보유 조합. 비용은 JustLend 오라클의 USDD·USDT 가격 비율로 USDD 환산. 실데이터(20,000 USDD·90일·30일 뒤 5,000 USDT 지출): B +34.62 USDD(추천), L +4.90, A +2.78(채굴 보상 17.40 포함)
- **보유 자산과 다른 자산의 지출**: TRX를 보유해도 USDT·USDD로 지출할 수 있음(반대도 가능). 지출 금액을 받으려면 필요한 보유 자산량을 SunSwap 견적으로 역산(USDD는 PSM 수수료 포함)하고 환전 거래비용까지 더해, 오늘 환전해 보유하는 것으로 확보함. 견적이 없으면 보유액 전부를 확보하고 이유를 보임
- **여러 자산 보유**: "테더 5천개랑 트론 2만개" 같은 대화나 폼의 "추가 보유"로 USDT와 TRX를 함께 입력함. 자산마다 그 자산의 지출로 같은 배분 로직(지출 확보·인출일별 분산·위험 성향·추천)을 따로 적용하고, 합산 카드(USDT 환산 총액·순수익 합계·합친 배분표)와 자산별 탭으로 보여 줌
- **USDD 저축(sUSDD)**: USDD 자체 수익 상품이지만 TRON에는 배포되지 않아(USDD 앱 API earnTvl 0, TRON 등록부 미등록) 탐색 표에 "TRON 미배포"와 Ethereum·BSC 금리(연 4%)를 참고로 표시
- **보유 자산 TRX 선택**: 대화("10,000 TRX를 90일…")나 폼에서 Mainnet 보유 자산을 TRX로 고를 수 있음. TRX 보유자는 A·A-2가 JustLend jTRX 예치(승인 단계 없음, 비용은 TRX로 평가), C(스테이킹)는 교환 없이 보유 자산 그대로라 모든 성향에서 후보, B는 SunSwap V2로 TRX→USDT 교환 후 PSM → jUSDD, 만기에 역순으로 계산(원금이 달러 자산이 되므로 가격 변동 등급, TRX 가격 스트레스 표시). USDD 위험 질문은 모든 보유자에게 함. 10,000 TRX / 90일 실데이터 기준 C +66.6 TRX(추천), jTRX 예치는 금리 0.32%라 음수
- **Mainnet**: 조회 전용 조건부 분석이며 Mainnet 거래는 실행하지 않음. **Mainnet USDT·USDD 계획의 실행 기준은 부분 구현**
- **Nile**: 순익이 음수여도 별도 표시 없이 예상 손익을 그대로 보이고 실행할 수 있음(추천은 보유). Nile에서도 TRX 보유자가 USDD 경로(B)를 실행할 수 있음: TRX → SunSwap V2 → USDD(구) → 구 PSM → USDT 2.0 → USDD 2.0 PSM → USDD 2.0 → jUSDD (Nile USDT 2.0은 전송 반환값이 false라 V2 풀을 거칠 수 없어 PSM 두 개로 이음). 서버가 지금 잔고로 호출을 만들고(정확한 금액만 승인, 최소 수령량 99%) 서명 전 모의 실행으로 확인함. 테스트 TRX 수익은 USDT로 환산하지 않음. 거래 비용은 체인 실측 최대값을 써서 인출 수수료 재원을 넉넉히 남김(예치 약 8 TRX, 전액 인출 약 22 TRX, 부분 인출 약 36 TRX). Mainnet도 실측값을 써서 jUSDT 왕복 비용이 일반값 기준보다 약 2배 큼
- **Nile 포지션 모니터링·조정**: 실행 탭에서 앱이 열려 있는 동안 1분마다, 그리고 유동성 확보액·운용 일수를 바꾸면 서버가 지갑·포지션·시세·수수료를 다시 읽어 판정함(`shared/adjust.ts`). 기간 종료 → 전액 인출, 지갑 TRX가 "지출·여유 + 전액 인출 수수료"보다 부족 → 부분 인출(`redeemUnderlying`, 부족분이 크면 전액 인출), 조건 완화 → 추가 예치(이자 < 수수료면 그 사실을 함께 표시). 제안은 기존 미리보기 → 서명 직전 재조회(부분 인출은 포지션 가치·시장 현금 재확인) → TronLink 서명 → 확정 영수증 → 재조회 흐름으로 실행함. **백그라운드 감시는 없음**(배포 서버가 없는 구조). 부분 인출의 실제 서명 테스트는 아직 하지 않음
- **AI 조사 에이전트(P1)**: 계획 비교 탭과 검토 탭에서 질문하면 LLM이 읽기 전용 도구(상품 목록, 조건 시뮬레이션, 손익분기·최소 운용액 탐색, 시세 이상 점검, Nile 영수증·포지션 조회)를 직접 골라 실행함. 금액·적격성·최종 추천은 계획 엔진이 계산하고 최종 게이트가 검증함(추천 전 시세 점검 필수, 코드와 다른 추천은 불채택, 도구 결과에 없는 숫자·영어 단어가 있으면 답변 폐기). LLM이 없거나 실패하면 같은 도구를 규칙 순서로 실행함. Nemotron 3 Super 기준 한 질문에 약 5~10초 (사고 과정 끔)
- **재평가 에이전트(P1)**: 검토 탭에서 마지막 분석을 최신 시세로 다시 계산해 추천 변경을 알려 줌(탭이 열려 있으면 5분마다 자동)
- **TronGrid 요청 제한**: 실측 조회가 늘어 TronGrid 요청 제한(HTTP 429)에 걸릴 수 있어, 체인별 동시 요청을 4개로 제한하고 429는 자동 재시도함(`tron-rpc.ts`). 서버 시작 시 스테이킹 대역폭 실측 → Mainnet 시세 순으로 미리 받아 두며, 대역폭 실측이 실패하면 추정값을 쓰고 백그라운드에서 최대 4번 다시 잼. 서버를 켠 직후 1분 안에는 첫 계산이 느릴 수 있음
- JSON 가져오기(P1)는 구현하지 않음. 과거 재생은 최근 30일 이력까지만 가능
