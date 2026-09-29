// 채굴 캠페인 등록부. 캠페인 기간·대상·지급 규칙은 공개 API로 받을 수 없어 공지를 확인해 여기에 적는다.
// 실행 시점에 (1) 공지 기간 안인지 (2) JustLend 백엔드에서 보상이 실제로 지급되는지 (3) 최근 일별 이력이 끊기지 않았는지를
// 모두 확인해야 verified로 둔다 (server/data/justlend.ts rewardsFromDetail). 새 회차가 공지되면 항목을 추가한다.

export interface Campaign {
  id: string;
  name: string;
  /** JustLend 시장 심볼 */
  market: string;
  /** ISO 8601 (시간대 포함) */
  start: string;
  end: string;
  rewardToken: string;
  announcedApy: string;
  distribution: string;
  eligibility: string;
  sources: string[];
  /** 공지를 확인하고 등록한 날짜 */
  registeredAt: string;
  note?: string;
}

export const CAMPAIGNS: Campaign[] = [
  {
    id: "usdd2-supply-mining-phase-22",
    name: "USDD 2.0 공급 채굴 Phase 22",
    market: "jUSDD",
    start: "2026-09-12T20:00:00+08:00",
    end: "2026-10-10T20:00:00+08:00",
    rewardToken: "USDD",
    announcedApy: "약 4.00% (동적)",
    distribution: "매주 USDD로 지급, JustLend DAO에서 머클 분배 청구(multiClaim)",
    eligibility: "JustLend jUSDD 시장에 USDD를 공급하고 포지션을 유지한 주소 (최소 금액 조건 공지 없음)",
    sources: [
      "https://www.kucoin.com/news/trends/USDD/6aa7ab27ccf4ec00077d6dcf",
      "https://www.kucoin.com/news/community/USDD/6ab1969e74fd460007c49bf2",
      "https://www.chaincatcher.com/en/article/2248564",
      "https://crypto-economy.com/justlend-launches-usdd-v2-0-mining-phase-xvi/",
    ],
    registeredAt: "2026-09-29",
    note: "Phase 22 기간(9/12~10/10)은 USDD 측 공지 재게시로 확인했다. 회차 교체 시각(20:00 SGT)과 4주 주기는 Phase XV·XVI 공지와 같다. JustLend 지원 사이트의 Phase 22 원문은 찾지 못했다.",
  },
];

export function activeCampaign(market: string, now = new Date()): Campaign | undefined {
  const t = now.getTime();
  return CAMPAIGNS.find((c) => c.market === market && Date.parse(c.start) <= t && t < Date.parse(c.end));
}
