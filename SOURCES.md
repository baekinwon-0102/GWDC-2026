# 데이터 출처 · API · MCP · 계산 근거

이 문서는 앱이 **실제로 호출하는** 외부 API와 MCP, 화면에 나오는 모든 숫자의 출처와 계산식, 그리고 외부에서 받지 않고 코드에 둔 값의 사유를 한곳에 정리한다. 코드 기준일은 2026-09-29이다.

## 1. 한눈에 보기

| 외부 서비스 | 네트워크 | 용도 | 인증 | 상태 |
| --- | --- | --- | --- | --- |
| TronGrid HTTP API | Mainnet · Nile | 계약 읽기, 잔고·포지션, 수수료 파라미터, 영수증, 거래비용 실측, 스테이킹 보상 | `TRONGRID_API_KEY` | 사용 |
| TronGrid 호스팅 MCP (`mcp.trongrid.io/mcp`) | Mainnet | 수수료 파라미터 조회 (`getChainParameters`) | `TRONGRID_API_KEY` | 사용 (실패 시 HTTP로 대체) |
| JustLend 공식 OpenAPI (`openapi.just.network`) | Mainnet | jToken 시장 목록·공급 금리·현금·오라클 가격 | 없음 | 사용 |
| JustLend 앱 백엔드 (`labc.ablesdxd.link/justlend`) | Mainnet | 채굴 보상·30일 일별 금리 이력·전체 시장 목록·기초자산 달러 가격 | 없음 | 사용 (공개 문서 없음, §3.4) |
| 채굴 캠페인 공지 (수동 등록부) | — | 캠페인 기간·대상·지급 규칙 | — | 사용 (§3.5) |
| NVIDIA NIM (`integrate.api.nvidia.com/v1`) | — | LLM: 입력 추출, 설명, 에이전트 도구 선택 | `NIM_API_KEY` | 사용 (기본) |
| Bank of AI (`api.b.ai/v1`) | — | LLM (해커톤 "TRON LLM") | `BAI_API_KEY` | 어댑터만 구현, 계정 잔액 0으로 미사용 |
| SunSwap V2 (라우터·USDT/WTRX 페어 계약) | Mainnet | USDT↔TRX 교환 견적(풀 준비금), 교환 거래비용 실측 | 없음 (TronGrid로 계약 읽기) | 사용 (§3.2, USDT 보유자의 계획 C·L) |
| USDD 앱 API (`app-api.usdd.io/data-platform/latest-collateral`) | — | 체인별 USDD 저축(sUSDD) 금리·예치 규모 | 없음 | 사용 (탐색 표 참고, §3.8) |
| TronLink (브라우저 확장) | Nile | 지갑 연결, 거래 생성·서명·방송 (jTRX 계약 호출 + 스테이킹 시스템 거래) | 사용자 지갑 | 사용 (Nile 실행) |
| 공식 JustLend MCP · USDD MCP | — | — | — | **사용 안 함** (§4.2) |

모든 외부 값에는 `sourceUrl`, `chain`, `fetchedAt`, `mode(live·snapshot·synthetic)`, `accessMethod(mcp·direct·fixture)`를 붙여 화면의 출처 줄에 표시한다 (`shared/schemas.ts` `SourceMeta`).

## 2. 원칙

- **숫자는 코드가 계산한다.** LLM은 입력 추출과 설명, 에이전트의 읽기 전용 도구 선택만 한다. 금리·비용·계약 주소를 모델 출력에서 가져오지 않는다.
- **확인하지 못한 값은 추정으로 채우지 않는다.** 비용·환산 근거가 없으면 `산정 불가`, 보상 규칙을 확인하지 못하면 `미확인`으로 두고 순수익에서 뺀다.
- **조회 실패는 실행 불가 사유로 보인다.** 과거 값을 현재처럼 쓰지 않는다. Mainnet 시세는 조회 후 10분이 지나면 실행 판정에서 막는다.
- **실측값을 우선한다.** 거래비용은 최근 성공 거래의 영수증에서 잰 최대값을 쓰고, 표본이 없을 때만 공식 일반값으로 대체한다 (화면에 어느 쪽인지 표시).

## 3. 외부 API 상세

### 3.1 TronGrid HTTP API

호스트: Mainnet `https://api.trongrid.io`, Nile `https://nile.trongrid.io`. 헤더 `TRON-PRO-API-KEY`. 체인별 동시 요청 4개 제한과 HTTP 429 자동 재시도를 공용 계층에 둔다 (`server/data/tron-rpc.ts`).

| 엔드포인트 | 네트워크 | 용도 | 코드 |
| --- | --- | --- | --- |
| `POST /wallet/triggerconstantcontract` (TronWeb) | 둘 다 | 계약 view 함수 읽기 (§3.2) | `tron-rpc.ts` `readWords` |
| `POST /wallet/getchainparameters` | 둘 다 | Energy·대역폭 단가(`getEnergyFee`, `getTransactionFee`), 스테이킹 파라미터(`getWitnessPayPerBlock`, `getWitness127PayPerBlock`, `getUnfreezeDelayDays`, `getMaintenanceTimeInterval`) | `tron-rpc.ts` `chainFees`, `staking.ts` |
| `POST /wallet/getaccount` | Nile | 지갑 TRX 잔고, 스테이킹(`frozenV2`)·투표(`votes`)·해제 대기(`unfrozenV2`) | `tron-rpc.ts` `trxBalanceSun`, `staking.ts` `stakingPosition` |
| `POST /wallet/getReward` · `/wallet/getcanwithdrawunfreezeamount` | Nile | 미청구 투표 보상, 해제 대기가 끝난 인출 가능액 | `staking.ts` `stakingPosition` |
| `POST /wallet/getcontract` | Nile | jTRX 계약 존재·이름(`JustLend-TRX`) 확인 | `tron-rpc.ts` `contractExists` |
| `POST /walletsolidity/gettransactioninfobyid` · `/wallet/gettransactioninfobyid` | Nile | 거래 확정 판정 (확정 노드 영수증이 있어야 `confirmed`) | `tron-rpc.ts` `nileTxStatus` |
| `POST /wallet/gettransactioninfobyid` | Mainnet | 스테이킹 거래 영수증 대역폭 실측 | `staking.ts` |
| `POST /wallet/listwitnesses` | 둘 다 | SR 목록·득표수 (Nile 계획 C·L은 Nile SR 목록) | `staking.ts` |
| `POST /wallet/getBrokerage` | 둘 다 | SR 수수료(투표자에게 주지 않는 몫) | `staking.ts` |
| `POST /wallet/getblockbylatestnum` · `/wallet/getblockbylimitnext` | Mainnet | 최근 블록에서 스테이킹 거래 표본 찾기 | `staking.ts` |
| `POST /wallet/getnowblock` | 둘 다 | 연결 진단 | `doctor.ts` |
| `GET /v1/accounts/{계약}/transactions?only_to=true&only_confirmed=true` | 둘 다 | 계약별 최근 성공 거래의 Energy·대역폭 실측 (§5.3) | `tron-rpc.ts` `measureContractCosts` |
| `GET /v1/accounts/{계정}/transactions?only_from=true` | Mainnet | 스테이킹 거래 표본 보충 | `staking.ts` |

### 3.2 스마트 계약 읽기

| 계약 (주소) | 함수 | 용도 |
| --- | --- | --- |
| JustLend Comptroller Mainnet `TGjYzgCyPobsNS9n6WcbdLVR9dH7mWqFx7` · Nile `TJUCStq3WqfKqZLuZje5v7z6Ua6iBry1P6` | `mintGuardianPaused(address)` | 예치 중지 여부 (jUSDT·jUSDD·Mainnet jTRX, 일시 오류 시 1회 재시도) |
| Nile jTRX `TKM7w4qFmkXQLEF2MgrQroBYpd5TY7i1pq` | `supplyRatePerBlock()`, `getCash()`, `balanceOf(address)`, `exchangeRateStored()`, `interestRateModel()` | 금리, 인출 가능 현금, 포지션 가치, 금리 모델 주소 |
| jTRX 금리 모델 (`interestRateModel()`이 돌려준 주소) | `blocksPerYear()` | 연간 블록 수 (계약이 금리 계산에 쓰는 값, 현재 10,512,000) |
| USDD PSM `TBXW4hS5KYjjbJXDpnrPf4zhkLwrpUjbyz` (MCD_PSM_USDT_A) | `tin()`, `tout()`, `sellEnabled()`, `buyEnabled()`, `ilk()` | 전환 수수료, 전환 가능 여부, 담보 유형 |
| USDD Vat `TH5dhX7o39afSbfDT2e3c9k4itWjNKD4D9` | `ilks(bytes32)` | PSM 진입 여유 = line − Art × rate |
| USDT `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` | `balanceOf(GemJoin TSUYvQ5tdd3DijCD1uGunGLpftHuSZ12sQ)` | PSM 출구(USDD→USDT) 가능 물량 |
| SunSwap V2 라우터 `TKzxdSv2FZKQrEqkKVgp5DcwEXBEKMg2Ax` | `WETH()`, `factory()`, `getAmountsOut(uint256,address[])` | WTRX·팩토리 주소, 교환 견적 교차 검증 |
| SunSwap V2 팩토리 (`factory()`가 돌려준 주소, 현재 `TKWJdrQkqHisa1X8HUdHEfREvTzw4pMAaY`) | `getPair(USDT, WTRX)` | USDT/WTRX 페어 주소 (현재 `TFGDbUyP8xez44C76fin3bn3Ss6jugoUwJ`) |
| USDT/WTRX 페어 | `token0()`, `getReserves()` | 풀 준비금 → 교환 결과 `out = in×997×R_out ÷ (R_in×1000 + in×997)` (6자리 내림) |

주소 출처: JustLend Mainnet은 [JustLend 공식 배포 주소 문서](https://docs.justlend.org/developers/deployed_contracts/)와 OpenAPI 응답을 대조한다(다르면 해당 시장을 비활성으로 표시). USDD 계약은 [USDD 공식 배포 주소 문서](https://docs.usdd.io/developers/deployment-addresses). Nile jTRX·Comptroller는 공식 JustLend MCP 소스(`src/core/chains.ts` Nile 섹션)에서 가져오고, 사용 전 `getcontract`로 계약명을 확인한다. SunSwap V2 라우터는 [SunSwap V2 인터페이스 문서](https://www.sunswap.com/docs/sunswapV2-interfaces_en.pdf)와 GitHub `sun-protocol/sunswap2.0-contracts`의 주소이며, WTRX·팩토리·페어는 라우터에서 체인으로 읽는다. 준비금 계산은 매번 라우터 `getAmountsOut`(1,000 USDT)과 비교해 같아야 쓴다. 두 읽기가 다른 블록에 걸려 다르면 동시에 다시 읽고, 세 번 모두 다르면 0.1% 이내일 때만 받아들인다(출처 줄에 차이를 표시).

### 3.3 JustLend 공식 OpenAPI

- `GET https://openapi.just.network/lend/jtoken` (`server/data/justlend.ts`)
- 사용 필드: `symbol`, `address`, `underlyingSymbol`, `supplyRate`(공급 APY), `cash`(인출 가능 현금), `underlyingPriceInTrx`(1 USDT의 TRX 가격 = 거래비용 TRX → USDT 환산 근거)
- AI 에이전트의 `list_products` 도구는 같은 응답의 전체 시장 목록을 금리순으로 보여 준다.

### 3.4 JustLend 앱 백엔드 (채굴 보상 · 전체 시장 · 30일 이력)

- `GET https://labc.ablesdxd.link/justlend/markets/jtokenDetails?jtokenAddr={jToken}` — 사용 필드: `farmRewardUSD24h`, `farmRewardUsddAmount24h`, `farmRewardTrxAmount24h`, `depositedUSD`, `priceUSD`, `depositDetail`(최근 30일 일별 기본 APY·채굴 APY·기초자산 APY·예치 총액)
- `GET https://labc.ablesdxd.link/justlend/markets` — JustLend 전체 24개 시장의 기본 공급 APY(`depositedAPY`), 기초자산 자체 수익(`underlyingIncrementApy`), 예치 중지(`mintPaused`), 예치 총액 → 기회 탐색 표 (`server/data/discovery.ts`)
- **근거:** 공개 API 문서는 없다. JustLend 공식 GitHub 조직의 MCP 서버([github.com/justlend/mcp-server-justlend](https://github.com/justlend/mcp-server-justlend))가 채굴 보상과 USDD 채굴 설정 조회에 같은 호스트와 같은 계산(일일 보상 가치 × 365 ÷ 예치 총액)을 쓴다 (`src/core/services/markets.ts`, `rewards.ts`). 예고 없이 바뀔 수 있어 실패하면 보상을 `미확인`으로 둔다.
- 2026-09-29 조회값: jUSDD 하루 43,672 USDD(연 약 4.06%, 최근 30일 매일 지급), jUSDT 0.

### 3.5 채굴 캠페인 공지 (등록부)

캠페인 기간·대상·지급 규칙은 공개 API로 받을 수 없어 공지를 확인해 `server/data/campaigns.ts`에 등록한다. 새 회차가 공지되면 항목을 추가한다.

| 캠페인 | 시장 | 기간 (UTC+8) | 공지 APY | 지급 | 출처 |
| --- | --- | --- | --- | --- | --- |
| USDD 2.0 공급 채굴 Phase 22 | jUSDD | 2026-09-12 20:00 ~ 2026-10-10 20:00 | 약 4.00% (동적) | 매주 USDD, 머클 분배 청구 | [Phase 22 공지 재게시](https://www.kucoin.com/news/trends/USDD/6aa7ab27ccf4ec00077d6dcf), [1주차 보상 청구 개시](https://www.kucoin.com/news/community/USDD/6ab1969e74fd460007c49bf2), 이전 회차 [XV](https://www.chaincatcher.com/en/article/2248564)·[XVI](https://crypto-economy.com/justlend-launches-usdd-v2-0-mining-phase-xvi/) |

**검증 규칙** (`server/data/justlend.ts` `rewardsFromDetail`) — 아래 세 조건을 모두 만족해야 `검증됨`:
1. 지금이 등록된 공지 기간 안
2. JustLend 백엔드에서 최근 24시간 보상이 실제로 지급 중
3. 최근 30일 일별 이력(`depositDetail`)에서 채굴 APY가 하루도 끊기지 않음

검증되면 **캠페인 종료일까지의 보상만** 순수익에 넣고(청구 비용 차감), 종료일 이후 몫은 다음 회차가 공지되지 않았으므로 `미확인` 참고값으로 둔다.

**근거의 한계**: Phase 22 기간은 USDD 측 공지 재게시로 확인했고, JustLend 지원 사이트의 Phase 22 원문은 찾지 못했다. 회차 교체 시각(20:00 SGT)과 4주 주기는 Phase XV·XVI 공지와 같다.

### 3.6 LLM

| 공급자 | 엔드포인트 | 모델 | 설정 |
| --- | --- | --- | --- |
| NVIDIA NIM (기본) | `POST https://integrate.api.nvidia.com/v1/chat/completions` | `nvidia/nemotron-3-super-120b-a12b` | `temperature: 0`, `chat_template_kwargs.enable_thinking: false` (사고 과정이 답변으로 새는 문제 방지, 지원하지 않는 모델은 HTTP 400 → 이 옵션을 빼고 재요청) |
| Bank of AI | `POST https://api.b.ai/v1/chat/completions`, `GET /models` | `gpt-5.6-terra` | `max_completion_tokens`, `reasoning_effort: "low"`, temperature 미전송 ([B.AI API Reference](https://docs.b.ai/llmservice/api/)) |

- 기존 `openai/gpt-oss-20b`는 2026-09-29 기준 45초 시간 초과로 응답이 없어 교체했다.
- Bank of AI는 키 인증과 모델 목록 조회는 성공했지만 계정 잔액 0으로 모든 모델이 `Deposit required`/`insufficient balance`로 거부되어 실제 응답은 확인하지 못했다. `LLM_PROVIDER=bai`로 바꾸면 바로 쓸 수 있다.
- LLM 실패·형식 오류 시 규칙 기반 템플릿(`server/llm/template.ts`)으로 대체한다.

**LLM 출력 검증** (`server/llm/provider.ts`)
- 추출: Zod 스키마로 검증, 형식 오류는 한 번만 보정 요청
- 설명·에이전트 답변: 계산 결과·도구 결과에 없는 숫자가 있으면 폐기(`unknownNumbers`), 한국어 외 문자·영문 사고 과정·영어 일반 단어·데이터 필드 이름이 있으면 폐기(`explanationIssues`) → 템플릿 사용
- 모델에 주는 계산 결과는 한국어 키와 단위를 붙인 문장으로 준다(`compactForExplain`). 영문 키를 주면 모델이 그대로 베껴 쓰기 때문이다.

### 3.7 TronLink (Nile 실행)

`src/lib/tronlink.ts`. `tron_requestAccounts`로 연결하고, TronLink가 주입한 TronWeb으로 `triggerSmartContract` → `trx.sign` → `trx.sendRawTransaction` 순서로 실행한다. 서명 직후 txID를 저장하며, 방송 응답이 아니라 **확정 노드 영수증**이 있어야 성공으로 본다.

| 거래 | 계약 메서드 |
| --- | --- |
| 예치·추가 예치 | jTRX `mint()` (callValue = TRX sun) |
| 전액 인출 | jTRX `redeem(uint256 jToken 수량)` |
| 부분 인출 (포지션 조정·인출일별 분산의 날짜별 인출) | jTRX `redeemUnderlying(uint256 TRX sun)` |
| 스테이킹 | 시스템 거래 `FreezeBalanceV2` (대역폭 자원, 정수 TRX) — `transactionBuilder.freezeBalanceV2` |
| SR 투표 | `VoteWitness` (현재 투표권 전체를 계획의 SR에, 기존 투표 대체) — `transactionBuilder.vote` |
| 스테이킹 해제 | `UnfreezeBalanceV2` — `transactionBuilder.unfreezeBalanceV2` |
| 해제분 인출 | `WithdrawExpireUnfreeze` — `transactionBuilder.withdrawExpireUnfreeze` |
| 투표 보상 청구 | `WithdrawBalance` — `transactionBuilder.withdrawBlockRewards` |

시스템 거래는 Energy가 들지 않고 대역폭만 쓴다. 서명 직전 잔고·동결액·투표권·인출 가능액·미청구 보상을 다시 읽어 미리보기와 다르면 무효화한다. 시스템 거래는 검증 실패 시 방송 단계에서 거부되므로, 확정 노드 영수증이 있으면 성공으로 본다.

### 3.8 USDD 저축 (sUSDD) 확인

USDD의 자체 수익 상품은 sUSDD(USDD 저축, ERC-4626)다. 공식 USDD MCP(`decentralized-usd/mcp-server-usdd`)의 `chains.ts`에는 Ethereum·BSC에만 sUSDD·Pot 주소가 있고 TRON에는 없다. 그래서 TRON 배포 여부를 두 가지로 확인한다 (`server/data/usdd.ts` `fetchUsddSavings`).

1. USDD 앱 API `latest-collateral?chain=tron|eth|bsc`의 `apy`·`earnTvl` (공식 MCP `getChainMetrics`가 쓰는 엔드포인트). 2026-09-29: TRON earnTvl 0, Ethereum 1.99억 달러, BSC 0.14억 달러, 금리 연 4%.
2. USDD TRON 체인 등록부(chainlog `TH2iieRStHtzDMTPXdFcgixQLBuhrtq6p9`)의 `getAddress("SUSDD")`·`getAddress("MCD_POT")` — 둘 다 되돌려짐(미등록). 등록부 전체 84개 키에도 없다.

결론: TRON에는 배포되지 않아 계산하지 않고, 탐색 표에 "TRON 미배포"로 사유와 다른 체인 금리를 참고로 보인다. TRON에서 USDD로 수익을 내는 경로는 JustLend jUSDD 예치(계획 B)다. 같은 조회에서 Nile 등록부(`TRuw52wuVD61n1HB8b7V8d8sNPUfoUCj3w`)에 USDD PSM(`TEwUGMSAvbmzjxWoV8JWoSqvQm1A3AXs1V`)과 그 기초 USDT(`TZDnq7egPqzi7H4SXy1ABvwaVRvRTaVfJW`)가 있음을 확인했다. 이 USDT는 faucet이 없지만 USDD(구) PSM의 buyGem으로 얻을 수 있어, Nile에서도 B를 실행한다 (§5.4).

## 4. MCP

### 4.1 TronGrid 호스팅 MCP — 사용

- Streamable HTTP `https://mcp.trongrid.io/mcp` (`server/mcp/clients.ts`)
- 연결 시 `tools/list`로 도구 149개를 발견하고, 허용 목록의 읽기 도구 2개만 노출한다: `getChainParameters`, `getContract` (`server/mcp/registry.ts`)
- 실제 호출: Mainnet 수수료 파라미터 `getChainParameters` (`server/data/quotes.ts`). MCP가 실패하면 TronGrid HTTP로 대체하고 출처에 그 사실을 남긴다.
- 거래·승인·지갑 관련 이름(`approve|supply|mint|redeem|withdraw|borrow|repay|swap|sell|buy|transfer|send|broadcast|sign|wallet|…`)은 이름에 관계없이 거부하고, 허용 도구도 Zod `strict` 스키마로 인자를 검증한다.
- MCP 응답은 JSON 데이터로만 파싱하며 안의 문장을 지시로 실행하지 않는다. MCP 설정에 개인키를 넣지 않는다.

### 4.2 공식 JustLend MCP · USDD MCP — 사용하지 않음

| 서버 | 사용하지 않는 이유 | 대체 |
| --- | --- | --- |
| JustLend MCP | 시작할 때 `~/.agent-wallet` 지갑을 초기화한다(`AGENT_WALLET_PASSWORD`). 읽기 전용 앱에서 지갑 생성을 분리할 수 없다 | 공식 OpenAPI + 온체인 읽기 |
| USDD MCP | 첫 시작 시 기본 지갑을 자동 생성한다. PSM 도구가 물량(진입 여유·출구 USDT)을 돌려주지 않는다 | 온체인 PSM·Vat·GemJoin 읽기 |

클라이언트와 허용 목록(`get_all_markets`, `get_market_data`, `get_psm_status` 등 읽기 도구)은 구현되어 있어 `.env.local`에 실행 명령(`MCP_JUSTLEND_COMMAND`, `MCP_USDD_COMMAND`)을 넣으면 연결된다.

**공식 JustLend MCP 소스에서 참고한 것** (서버를 실행하지 않고 코드만 읽음, [github.com/justlend/mcp-server-justlend](https://github.com/justlend/mcp-server-justlend))
- `TYPICAL_RESOURCES` 일반값: approve 23,000 / supply(TRC20) 100,000 / supply(TRX) 80,000 / withdraw 90,000 / claim_rewards 60,000 Energy — 실측 표본이 없을 때의 대체값
- Nile jTRX·Comptroller 주소
- 채굴 보상 호스트와 계산식, 머클 분배·기간별 청구 방식

### 4.3 AI 에이전트 내부 도구 (MCP 아님)

AI 조사 에이전트(`server/agent/`)는 MCP가 아니라 앱 내부의 읽기 전용 함수만 호출한다. 도구마다 Zod 인자 검증과 맥락별 허용 목록이 있고, 사용자 동의(`acceptUsddRisk`)를 바꾸거나 거래를 만들 수 없다.

| 도구 | 맥락 | 하는 일 |
| --- | --- | --- |
| `list_products` | Mainnet | JustLend 전체 시장과 분석 대상 여부 |
| `simulate` | Mainnet | 조건 일부를 바꿔 계획 엔진 재계산, 전후 비교 |
| `find_breakeven` | Mainnet | 순수익 > 0이 되는 최소 운용 일수(1일 단위 탐색)·최소 보유액(이분 탐색) |
| `check_anomalies` | Mainnet | 시세·유동성·신선도·PSM·환산 가격 이상 규칙 점검 |
| `get_tx_status` · `get_position` | Nile | 사용자 기록에 있는 txID의 영수증, 기록된 지갑의 포지션 |
| `propose_adjustment` | Nile | 포지션 조정안 판정 (거래는 만들지 않음) |

최종 추천은 항상 코드 추천을 쓴다. 에이전트가 다른 계획이나 부적격 계획을 제안하면 채택하지 않고 답변을 템플릿으로 바꾼다. 추천 전 `check_anomalies`를 부르지 않으면 한 번 되돌려 보낸다.

## 5. 계산 근거

### 5.1 수익과 비용

| 값 | 계산 | 코드 |
| --- | --- | --- |
| 운용 가능액 | 보유액 − (운용 기간 안 지출 + 여유액) | `shared/needs.ts` `reservedWithinHorizon` |
| 기본 수익 (APY) | 원금 × ((1 + APY)^(일수/365) − 1) | `shared/planning.ts` `baseYield` |
| 기본 수익 (APR) | 원금 × APR × 일수 / 365 | 같음 |
| 거래비용 (TRX) | Σ(Energy × `getEnergyFee` + 대역폭 bytes × `getTransactionFee`) ÷ 1,000,000 | `stepCosts` |
| 거래비용 (USDT) | 거래비용 TRX ÷ `underlyingPriceInTrx` | 같음 |
| 순수익 | 기본 수익 + 검증된 보상 − 진입·보유·출구 비용 (계획 B는 PSM 전환 수수료도 뺌) | 계획별 |
| 손익분기 기간 | 비용을 기본 수익으로 회수하는 일수 (APY는 로그식, APR은 비용 × 365 ÷ (원금 × APR)) | `breakEvenDays` |
| 추천 | 적격 계획 중 순수익이 가장 큰 계획. 모두 0 이하면 보유, 비용 근거가 없으면 보유 | `recommend` |

비용은 Energy를 스테이킹하지 않고 TRX를 소각한다고 가정하며 무료 대역폭은 반영하지 않는다(보수적).

### 5.2 계획별 추가 근거

- **여러 자산 보유** (`shared/portfolio.ts`): 대화("테더 5천개랑 트론 2만개")나 폼으로 USDT와 TRX를 함께 입력할 수 있다. 자산마다 그 자산으로 낼 지출만 떼어 내고(비상 여유액은 대표 자산에만) 같은 계획 엔진을 따로 돌린다 — 지출 재원 확보, 인출일별 구간, 위험 성향, 추천이 자산마다 적용된다. 합계는 JustLend 오라클 가격으로 USDT 환산하고, 추천 계획들을 합친 배분표(자산·넣을 곳·금액·전체 대비 비율)를 보인다. 보유하지 않은 자산의 지출이나 자산별 재원 부족은 입력 문제로 막는다. 자산 간 교환으로 지출을 충당하지는 않는다.
- **보유 자산**: Mainnet 입력은 USDT, TRX 또는 둘 다. TRX 보유자는 A·A-2가 jTRX(`TE2RzoSV3wFK99w6J9UnnZ4vLfXYoxvRwP`, OpenAPI·공식 MCP 소스 주소 일치) 예치로 바뀌고 승인 단계가 없으며 비용은 TRX로 평가한다. B는 SunSwap V2로 TRX→USDT 교환 → PSM → jUSDD → 역순으로 계산한다(교환·PSM 손실은 전환 비용, 원금이 달러 자산이 되므로 위험 등급 "가격 변동", TRX 가격 −10%·+10%·+20% 스트레스). C는 교환이 없어 위험 등급 "보유 자산 그대로"로 계산한다. USDD 위험 질문은 모든 보유자에게 한다.
- **계획 A (jUSDT 전액 예치)**: 승인 → 예치 → 만기 인출. 금리는 OpenAPI `supplyRate`(APY).
- **계획 A-2 (jUSDT 절반 예치)**: 같은 상품에 운용 가능액의 50%만 예치하고 나머지는 예상 밖 지출에 대비해 보유한다.
- **위험 성향 정책** (`shared/risk.ts`): 계획마다 위험 등급(원금 고정 스테이블 A·A-2 / 스테이블 전환 B / 가격 변동 C)을 붙인다.

  | 성향 | 허용 위험 등급 | 추천 기준 |
  | --- | --- | --- |
  | 보수적 | 원금 고정 스테이블 | 순수익 > 0인 계획 중 예치 비중이 가장 작은 것 |
  | 균형형 | + 스테이블 전환 | 순수익 최대 |
  | 공격적 | + 가격 변동 자산 | 순수익 최대 |
- **계획 B (USDD 경로)**: 승인 → PSM 전환 → 승인 → jUSDD 예치 → 인출 → 승인 → PSM 역전환. PSM은 전환 경로이며 수익원이 아니다. 사용자가 USDD 가격 위험을 받아들이지 않으면 제외한다. 스트레스 결과로 출구 시 USDD 0.5%·2% 디페깅을 따로 보인다.
- **계획 C (TRX 스테이킹 + SR 투표)**
  - 투표자 APR(SR i) = (블록 생산 보상 × 연간 블록 ÷ 27 + 투표 보상 × 연간 블록 × SR i 득표 ÷ 상위 127개 총 득표) × (1 − SR 수수료) ÷ SR i 득표
  - 블록당 보상은 `getWitnessPayPerBlock`(현재 8 TRX), `getWitness127PayPerBlock`(현재 128 TRX). 상위 27개 SR 중 투표자 APR이 가장 큰 SR을 고른다.
  - 보상 기간 = 운용 기간 − 해제 대기(`getUnfreezeDelayDays`, 현재 14일) − 투표 반영 지연(`getMaintenanceTimeInterval`, 현재 6시간)
  - 보유 자산이 USDT이면 SunSwap V2로 USDT→TRX 교환 → 스테이킹 → 기간 끝 TRX(원금+보상)→USDT 교환. 교환 결과는 풀 준비금 공식으로 계산하고, 출구 시 풀 가격이 지금과 같다고 가정한다. 순수익 = 보상(풀 중간 가격 환산) − 교환 손실(수수료 0.3%×2 + 가격 영향, 전환 수수료로 표시) − 거래비용(승인 + 교환 2회 실측 + 시스템 거래). 위험 등급은 가격 변동이라 보수적·균형형에서는 제외하고, 스트레스로 기간 끝 TRX 가격 −20%·−10%·+10%를 보인다. 교환액이 풀 USDT 잔고의 2%를 넘으면 가격 영향이 커 제외한다. 교환 견적을 읽지 못하면 제외한다. 운용 기간이 해제 대기 이하이면 제외한다.
- **채굴 보상**: APR = 최근 24시간 보상 가치(USD) × 365 ÷ 시장 예치 총액(USD). 보상액 = 원금 × (기초자산 달러 가격 ÷ USDT 달러 가격) × APR × 일수 / 365. §3.5 검증을 통과하면 캠페인 종료일까지의 일수만 순수익에 넣고 청구 비용을 뺀다. 나머지 기간(또는 검증 실패 시 전체)은 "참고: 미확인 보상 포함" 줄에만 보인다.
- **인출일별 분산 (계획 L)** (`shared/ladder.ts`): 구간 = 비상 여유액(D+0, 보유만) · 운용 기간 안 지출일마다(같은 날은 합침) · 나머지(운용 끝까지). 상품 = 보유 · 같은 자산 예치(jUSDT/jTRX) · USDD 경로(USDT 보유자, 동의·성향 허용 시) · TRX 스테이킹(TRX 보유자, 또는 SunSwap 교환을 거치는 USDT 보유자 — 배정 구간 합계를 D+0에 한 번 교환하고 인출일마다 그 몫을 되돌리며 교환 손실은 전환 비용). 단일 계획이 부적격인 상품은 쓰지 않는다. 비용 = 상품마다 진입 거래 한 번 + 인출 날짜마다 출구 거래(스테이킹은 인출일 − 해제 대기일에 해제, 인출일에 해제분 인출, 보상 청구 한 번) + PSM 전환 수수료. 수익 = 구간 금액의 필요일까지 수익(예치는 APY 복리, 스테이킹은 인출일 − 14일 − 투표 반영 지연 동안 APR, USDD 경로는 검증된 캠페인 기간분 채굴 보상 포함). 구간 7개 이하는 모든 조합을 계산해 순수익 합계 최대(같으면 상품 수가 적은 쪽), 초과 시 구간별 단독 최선으로 근사한다. 구간별로 다른 선택지의 단독 순수익과 쓰지 않은 상품의 사유를 보인다.
- **기회 탐색** (`shared/screening.ts`): JustLend 전체 시장 + USDD PSM + TRX 스테이킹을 심사해 분석 대상과 제외 사유를 표로 보인다. 보유 자산과 같은 시장 → 계획 A·A-2, USDD → 계획 B(PSM 경로), 다른 스테이블(USD1·TUSD·wstUSDT 등) → 전환 경로 비용 미검증으로 제외, 가격 변동 자산 → 원금 비보장·전환 비용 미검증으로 제외(성향 사유 추가), 분류를 모르는 자산 → "분류 미확인"으로 가격 변동과 같게 취급, 예치 중지·이전 버전 시장 → 제외.

### 5.3 거래비용 실측

계약의 최근 성공 거래를 메서드 선택자(함수 서명 해시 앞 4바이트)로 분류하고, 영수증의 Energy(`energy_usage_total`)와 대역폭(`net_usage`, 없으면 `net_fee ÷ getTransactionFee`)의 **최대값**을 쓴다. 신규 예치자는 저장 공간을 새로 만드는 경우가 많아 높은 쪽이 현실적이다.

| 대상 | 표본 | 2026-09-29 실측 최대 (Energy / bytes) | 표본 없을 때 |
| --- | --- | --- | --- |
| jUSDT `mint(uint256)` / 인출(`redeem`·`redeemUnderlying` 중 큰 값) | 최근 100건 | 192,907 / 450 · 214,649 / 448 | 일반값 100,000 · 90,000 |
| jUSDD 예치 / 인출 | 최근 100건 | 104,948 / 313 · 252,115 / 313 | 같음 |
| jTRX(Mainnet) `mint()` / 인출 | 최근 100건 | 실시간 실측 | 일반값 80,000 · 90,000 |
| USDD PSM `sellGem` / `buyGem` | 최근 50건 | 248,941 · 308,692 / 348 | PSM 계획은 실행 불가 |
| Nile jTRX `mint()` / `redeem` / `redeemUnderlying` | 최근 100건 | 80,894 · 223,341 · 359,300 / 287~314 | 일반값 80,000 · 90,000 |
| SunSwap V2 `swapExactTokensForETH` / `swapExactETHForTokens` | 라우터 최근 200건 | 215,865 / 542 · 223,354 / 514 | 교환 경로 제외 (승인은 일반값 23,000) |
| 스테이킹 시스템 거래 (스테이킹·투표·청구·해제·해제분 인출) | 최근 블록의 해당 거래 영수증 + 그 계정들의 최근 이력 | 253 · 273 · 246 · 256 bytes (Energy 없음) | 표본 없는 유형은 측정 최대값, 전부 실패 시 300 bytes 추정 |

측정값은 Mainnet 시세와 함께 60초, Nile은 10분, 스테이킹 대역폭은 1일 캐시한다. 스테이킹 대역폭 측정은 무거워서 서버 시작 시 먼저 수행하고, 실패하면 백그라운드에서 최대 4번 다시 잰다.

### 5.4 Nile 실행과 포지션

- **jTRX 금리 (APR)** = `supplyRatePerBlock` × 금리 모델 `blocksPerYear()` ÷ 1e18
- **포지션 가치 (TRX)** = jTRX 잔고(1e-8 단위) × `exchangeRateStored` ÷ 1e18
- **Nile 계획**: 최대 예치안(지출 재원만 보유)과 50% 예치안. 예치액은 실제 지갑 잔고 − 확보액 − (예치 + 전액 인출 수수료 예산) 이하로 줄인다. 순수익이 0 이하여도 별도 표시 없이 예상 손익을 그대로 보이고, 추천은 보유로 둔다.
- **Nile 전체 로직**: 같은 계획 엔진(`buildMainnetPlans`, `chain = "nile"`)을 Nile 값만으로 돌려 계획 C(Nile 스테이킹: `getchainparameters`·`listwitnesses`·`getBrokerage`를 Nile에서 읽음, 현재 해제 대기 1일·유지보수 30분), 계획 L(운용 중 지출일로 구간을 나눈 인출일별 분산), 기회 탐색, 위험 성향 추천을 계산한다. 수수료 재원(예치 + 전액 인출 예산)은 먼저 떼어 둔다. B(USDD 경로)도 계산·실행한다. Nile USDT 2.0(`TZDnq7…`)은 transfer가 성공해도 false를 돌려줘 SunSwap V2 풀이 내보내지 못하므로(지갑 주소로 모의 실행해 확인: TRX→USDD(구) 1단은 성공, USDD(구)→USDT 2.0 풀은 되돌림), USDT 구간은 PSM 두 개로 잇는다: TRX →(SunSwap V2 라우터 `TMn1qrmYUMSTXo9babrJLzepKZoPC7M6Sy`, 주소 출처 GitHub `sun-protocol/sunswap-universal-router` scripts/config.js) USDD(구) `TYQF9c…` →(USDD(구) PSM `TEwUGM…` buyGem, tout 0.2%) USDT 2.0 →(USDD 2.0 PSM `TPj6Z8…` sellGem, 수수료 0) USDD 2.0 `TZ78R2…` → Nile jUSDD `TBqtwZhjP49heKsoTHeX5MhKBJMmyuP88b`(주소 출처 공식 JustLend MCP chains.ts Nile). 만기에는 역순(구 PSM sellGem tin 0.12%). 두 PSM 모두 최근 직접 buyGem·sellGem 성공 거래가 다수 있다. 계산은 V2 풀 준비금(라우터 견적과 교차 검증)과 PSM tin/tout, 거래비용은 Nile 라우터·PSM 실측값을 쓴다. 실행은 `POST /api/nile/call`이 단계마다 지금 잔고로 호출을 만든다: 승인은 바로 앞 단계에서 받은 금액만큼만(무제한 아님), 교환 최소 수령량은 라우터 견적의 99%, 서명 전에 지갑 주소로 모의 실행해 실패하면 막는다. 서명 직전 같은 호출을 다시 만들어 금액·대상이 달라졌으면 미리보기를 무효화한다. Nile 요구사항은 Mainnet과 같은 대화 추출(`/api/chat`)로도 받는다. Mainnet 값이 섞이면 체인 불일치로 부적격이 된다. 스테이킹 거래 크기(bytes)는 체인과 무관해 Mainnet 실측값을 쓴다.
- **계획 ID**: Nile 계획 ID는 계산마다 다르다(`n<계산 시각>-키`). 실행 기록은 계획 ID와 단계 번호로 묶이므로, 다시 계산한 새 계획에 이전 실행이 "확정"으로 붙지 않는다. 실행 기록에는 실행 시점의 계획 금리(`plannedRate`)를 남겨 계획을 다시 계산해도 원래 가정으로 예상 vs 실제를 비교한다.
- **스테이킹 모니터링** (`shared/adjust.ts` `computeStakingAdjustment`): 해제 완료분이 있으면 인출, 해제 대기(Nile 1일) 안에 오는 지출·여유액이 지갑+해제 중 금액보다 크면 부족분만큼 해제, 운용 종료까지 해제 대기 이하로 남으면 전부 해제·보상 청구, 투표하지 않은 투표권이 있으면 투표를 제안한다. 제안은 같은 미리보기 → 서명 직전 재조회 → 서명 흐름으로 실행한다. 검토 탭은 "스테이킹 예상 보상(투표 확정 후 경과일 × 실행 시점 APR) vs 실제(미청구 + 청구한 보상)"를 보인다.
- **예치 / 인출 실행기**: 계획의 거래를 묶음으로 나눈다(예치 = D+0 거래, 인출 = D+n 날짜별 거래). 버튼을 누르면 묶음 전체의 거래 목록·예상 금액·예상 수수료 합계·승인 범위·위험을 한 번 보여 주고, 확인하면 거래마다 미리보기(서버·체인 재조회) → 서명 직전 재확인 → TronLink 서명 → 확정 영수증(최대 2분 대기)을 거쳐 다음 거래로 넘어간다. 실패·거부·확정 지연이면 멈추고, 다시 누르면 확정된 거래는 건너뛰고 확정 대기 거래는 원 txID를 기다린다(다시 서명하지 않음). 보상이 아직 없는 청구 거래는 건너뛴다. 예정일이 오지 않은 묶음은 "앞당겨 실행(테스트)" 확인을 한 번 받는다. 실행 기록은 계획 ID·단계 번호로 연결해 같은 단계를 두 번 실행하지 않게 한다. 스테이킹 계열 단계는 실제 지갑 상태로 금액을 다시 정한다(스테이킹은 정수 TRX, 투표는 현재 투표권 전체, 해제는 동결액 이하, 해제분 인출은 인출 가능액 전체).
- **서명 직전 재조회**: 네트워크·계정·잔고·jTRX 잔고·계약 이름·Energy 단가를 다시 읽고, 부분 인출은 포지션 가치와 시장 현금도 확인한다. 하나라도 다르면 미리보기를 무효화한다.
- **포지션 조정 판정** (`shared/adjust.ts`, 서버가 지갑·포지션·시세·수수료를 다시 읽어 계산)
  1. 운용 종료일이 지났으면 → 전액 인출
  2. 지갑 TRX < 기간 안 지출·여유액 + 전액 인출 수수료 → 부족분 + 부분 인출 수수료만큼 부분 인출. 부족분이 포지션의 98% 이상이면 전액 인출
  3. 목표 예치액이 현재보다 크면 → 추가 예치 (예상 이자 < 수수료면 그 사실을 함께 표시)
  4. 그 외 → 유지. 수수료 재원조차 없으면 거래를 만들지 않는다.
- **리밸런스**: 사용자가 목표 배분(최대 예치안 ↔ 절반 예치안)을 고르면 리밸런스 모드로 판정한다. 목표보다 많으면 초과분 부분 인출, 적으면 추가 예치. 실행은 같은 미리보기 → 서명 직전 재조회 → 서명 → 확정 영수증 흐름을 쓴다.
- **Mainnet 전환 분석** (재평가, `server/agent/reevaluate.ts`): 추천이 바뀌면 이전 계획을 이미 실행했다고 가정하고 비교한다. 유지 가치 = 이전 계획의 남은 기본 수익(+검증 보상) − 이전 계획 인출 비용, 전환 가치 = 새 계획 순수익 − 이전 계획 인출 비용. 전환 단계(기존 인출 → 신규 승인·예치)도 보인다. Mainnet 거래는 실행하지 않는다.

### 5.5 과거 재생 (Tracking & Review, 시뮬레이션)

`shared/replay.ts`, `POST /api/replay`. 같은 계획(A·A-2·B)을 최근 30일 동안 실행했다면 **JustLend의 실제 일별 기본 APY·채굴 APY**(`depositDetail`)로 얼마였을지 계산해, 분석 시점 금리를 고정한 계획 가정과 비교한다. 기본 수익은 일복리((1 + APY)^(1/365) − 1), 채굴 보상은 원금에 일할 단리로 계산한다. 비용은 현재 실측 비용을 쓴다. 화면에 "시뮬레이션"으로 표시하며 실제 거래는 없다(원문이 허용한 "명확히 표시한 과거 재생").

## 6. 외부에서 받지 않고 코드에 둔 값

공식 조회 수단이 없거나 정책으로 정한 값이다. 표본·조회 실패 시의 대체값도 여기에 적는다.

| 값 | 어디서 | 사유 |
| --- | --- | --- |
| 3초 블록 → 연 10,512,000블록 (스테이킹 보상 계산) | `server/data/staking.ts` | TRON 프로토콜 규칙. 블록 간격을 돌려주는 체인 파라미터가 없다 (JustLend 금리 계산은 계약값을 읽음) |
| 블록 생산 SR 27개, 투표 보상 대상 127개 | `staking.ts` | TRON 프로토콜 규칙 |
| approve 23,000 / claim_rewards 60,000 Energy | `shared/planning.ts` `TYPICAL_RESOURCES` | 공식 JustLend MCP 일반값. 승인은 USDT 계약 거래가 너무 많아 JustLend용만 골라낼 수 없고, 보상 분배 계약은 조회되는 최근 거래가 없어 실측하지 못했다 |
| 실측 실패 시 대체값: jToken 예치·인출 일반값, 스테이킹 거래 300 bytes, 투표 반영 지연 6시간 | `planning.ts` | 화면에 "일반값"·"추정"으로 표시 |
| 시세 이상 감지 임계값: 금리 50% 초과·0.01% 미만·30% 급변, 유동성 < 예치액 2배, 1 USDT가 0.5~50 TRX 밖, SR 수수료 50% 초과 | `server/agent/tools.ts` | 정책값 (경고용, 판정에는 영향 없음) |
| 조정 기준: 최소 1 TRX, 부족분 98% 이상이면 전액 인출, 금리 30% 변동 안내 | `shared/adjust.ts` | 정책값 |
| USDD 디페깅 스트레스 0.5%·2%, TRX 가격 스트레스 −20%·−10%·+10% | `planning.ts` | 정책값 (참고 결과) |
| SunSwap 교환액 한도: 풀 USDT 잔고의 2%, 교차 검증 허용 차이 0.1% | `planning.ts`, `server/data/sunswap.ts` | 정책값 |
| 시스템 거래 대역폭 300 bytes (Nile 단계 실행 미리보기의 수수료 추정) | `NileExecution.tsx` | 보수적 추정. 무료 대역폭이 있으면 수수료가 들지 않는다 |
| 수수료 상한 50 TRX, 미리보기 유효 3분, 미포함 거래 만료 판단 5분 | `src/features/execution/NileExecution.tsx` | 정책값. TRON 거래는 참조 블록 후 약 60초에 만료된다 |
| 시세 신선도 10분, 모니터링 1분, 재평가 5분 | `shared/eligibility.ts`, 화면 | 정책값 |
| 가상 시세 (`fixtures/synthetic-quotes.json`) | `DATA_MODE=synthetic`일 때만 | 키 없이 흐름을 보여 주는 가상값. 화면에 "가상" 배지를 붙이고 실행 판정에 쓰지 않는다. 현재 설정은 `live` |

## 7. 검증

**자동 테스트** — `npm test`, 121개

| 파일 | 개수 | 내용 |
| --- | --- | --- |
| `tests/planning.test.ts` | 24 | 단위 변환, APY/APR, 누락·모순 판정, 고정 사례(45일 이동 시 800 → 1,000), USDD 거부 시 B 제외, 음수 순익 보유 권고, 공급자와 무관한 동일 결과, Nile 수수료 재원, Nile 전체 로직(C·L·B 제외·체인 불일치·위험 성향) |
| `tests/adjust-staking-rewards.test.ts` | 43 | 포지션 조정 판정·리밸런스, 보상 분리·가격 환산·캠페인 검증 조건, 실측 비용 반영, 계획 C(USDT 보유자 SunSwap 왕복·스트레스·가격 영향 한도), 교환 공식, 위험 성향, 기회 탐색, 과거 재생, 보유 자산 TRX, 인출일별 분산(USDT 보유자 스테이킹 구간 포함) |
| `tests/agent.test.ts` | 23 | 도구 허용 목록·인자 검증, 동의 변경 차단, 최종 게이트(부적격·불일치 추천 불채택, 숫자 검증), 반복·단계 한도, 규칙 경로, 재평가 |
| `tests/llm-and-mcp.test.ts` | 9 | LLM 응답 정규화·거부, 템플릿 추출, MCP 허용 목록, 설명 숫자·형식 검증 |
| `tests/portfolio-nile.test.ts` | 19 | 여러 자산 입력 추출·수정·검증, 자산별 요구사항, 자산별 배분(지출 확보·인출일별 분산·추천)과 USDT 합계, 스테이킹 조정 판정, Nile 계획 ID 고유성, sUSDD 탐색 행, TRX 보유자 USDD 경로(직접 교환·브리지 PSM·성향 제외) |
| `tests/bai.test.ts` | 3 | Bank of AI 요청 형식, 400 재시도, 빈 응답 처리 |

**외부 연결 진단** — `npm run doctor`: TronGrid Mainnet·Nile, JustLend OpenAPI, USDD PSM 온체인, PSM·Nile jTRX·Mainnet jToken 거래비용 실측, JustLend 채굴 보상, TRX 스테이킹 보상, Nile jTRX 계약, 선택한 LLM 공급자, MCP 허용 목록 거부 테스트, MCP 연결.

**실제 데이터로 확인한 것 (2026-09-29)**
- Nile jTRX에서 80 TRX `mint()` 모의 실행 성공(80,894 Energy), 같은 계약에서 다른 사용자의 `mint`·`redeem`·`redeemUnderlying` 성공 기록 확인
- 실제 jTRX 포지션이 있는 공개 Nile 지갑으로 조정 판정(유지·부분 인출·전액 인출)과 부분 인출 미리보기 확인 (서명하지 않음)
- 실시세로 계획 A/B/C·보상·AI 설명·AI 에이전트(도구 선택, 게이트 되돌려 보내기, NIM 장애 시 대체) 동작 확인
- SunSwap V2: 준비금 공식이 라우터 `getAmountsOut`과 정확히 일치(1,000 USDT → 2,974.710595 TRX 등). 공격적 성향 기준 10,000 USDT·90일 계획 C −12.76 USDT(교환 손실 62.98), 60,000 USDT·180일 +359.40 USDT (같은 조건 A +547.50)
- 여러 자산(USDT 60,000 + TRX 100,000, 180일, 지출 30일 뒤 20,000 USDT·60일 뒤 30,000 TRX, 공격적): USDT는 L +384.9 USDT(A +361.1), TRX는 L +1,166.9 TRX(C +1,043.8), 합계 순수익 약 776 USDT. NIM이 "테더 5천개랑 트론 2만개…" 문장에서 두 자산·지출·성향을 정확히 추출
- USDD 저축: TRON earnTvl 0·등록부 미등록 확인, Ethereum·BSC 연 4%
- Nile 전체 로직: Nile 스테이킹 견적(SR sr-8.com, 투표자 APR 1.22%, 해제 대기 1일, 유지보수 30분)으로 계획 C·L 계산, B 제외 사유, 추천 확인

## 8. 한계와 미검증

- **Nile 실거래 서명 테스트 미완료**: 예치 → 확정 → 인출, 특히 부분 인출(`redeemUnderlying`)과 스테이킹 시스템 거래(스테이킹·투표·해제·해제분 인출·보상 청구)는 실제 TronLink로 서명해 본 적이 없다.
- **Nile 수익성**: Nile jTRX 인출 Energy가 커서 jTRX 계획은 대부분 음수이고, Nile 투표자 APR(약 1.2%)도 시스템 거래 대역폭 비용(보수적 300 bytes × 5건)보다 작은 경우가 많다. 이때도 계획은 예상 손익을 그대로 보인 채 실행할 수 있고, 추천은 보유다. 무료 대역폭(하루 600 bytes)은 계산에 넣지 않았다.
- **여러 자산**: 자산마다 따로 배분하며, 한 자산의 지출이 그 자산 보유액보다 크면 다른 자산을 교환해 충당하지 않고 입력 문제로 막는다.
- **sUSDD**: TRON에 배포되지 않아 계산하지 않는다 (배포가 감지되면 표에 알리지만 계약 검증 전까지 계산하지 않음).
- **Nile의 USDT**: Nile JustLend jUSDT의 기초 USDT(`TPYwAC…`)는 얻을 방법이 없어 USDT 보유자 계획은 Nile에서 실행하지 않는다. USDT 2.0은 V2 풀을 거칠 수 없어 PSM으로만 다룬다. 앞서 "Nile에 SunSwap V2 라우터가 없다", "Nile PSM의 USDT는 얻을 수 없다"고 적었던 것은 잘못이었다 (라우터 `TMn1qr…` 존재, USDT 2.0은 구 PSM buyGem으로 얻음).
- **Nile B의 실제 서명**: 14단계(교환·승인·PSM·예치와 그 역순)를 실제 TronLink로 서명해 본 적은 없다. 단계별 모의 실행으로 첫 교환과 승인 호출의 성공을 확인했다.
- **Bank of AI**: 크레딧 충전 전이라 실제 응답을 확인하지 못했다.
- **채굴 보상**: 백엔드는 공개 문서가 없는 앱 API다. 캠페인 기간은 공지 재게시와 이전 회차 패턴으로 확인해 수동 등록했고, JustLend 지원 사이트의 Phase 22 원문은 찾지 못했다. 다음 회차가 공지되면 등록부에 추가해야 한다.
- **기회 탐색**: 다른 스테이블(USD1 연 2.9%, wstUSDT 연 3.7% 등)이 jUSDT보다 금리가 높지만, USDT에서 바꾸는 경로의 비용을 검증하지 못해 계산하지 않는다. (검증한 교환 경로는 SunSwap V2 USDT↔TRX 하나다.)
- **계획 C (USDT 보유자)**: 출구 교환 시 풀 가격이 지금과 같다고 가정한다. TRX 가격 변동은 스트레스 결과로만 보이며, 실행 시 최소 수령량은 실행 직전 다시 계산해야 한다 (Mainnet 거래는 실행하지 않음).
- **Mainnet 거래는 실행하지 않는다.** Mainnet은 조회 전용 조건부 분석이다.
- **모니터링은 앱이 열려 있을 때만** 동작한다 (배포 서버 없음).
- **TronGrid 요청 제한**: 서버를 켠 직후 1분 안에는 첫 계산이 느리거나 일부 값이 추정으로 나올 수 있다.
