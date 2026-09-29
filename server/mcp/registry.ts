import { z } from "zod";

// 서버별 읽기 도구 허용 목록과 인자 스키마. 목록 밖 도구와 잘못된 인자는 거부한다.
// 거래·승인·지갑 관련 도구는 이름에 읽기 표시가 있어도 허용하지 않는다.

export type ServerId = "justlend" | "usdd" | "trongrid";

const network = z.enum(["mainnet", "nile", "tron", "tron_nile"]).optional();

export const ALLOWED_TOOLS: Record<ServerId, Record<string, z.ZodType>> = {
  justlend: {
    get_all_markets: z.object({ network }).strict(),
    get_market_data: z.object({ market: z.string().max(20), network }).strict(),
    get_account_summary: z.object({ address: z.string().regex(/^T[1-9A-HJ-NP-Za-km-z]{33}$/), network }).strict(),
    check_allowance: z.object({ address: z.string(), market: z.string(), network }).strict(),
    estimate_lending_energy: z.object({ operation: z.string(), market: z.string().optional(), network }).strict(),
    get_mining_rewards: z.object({ address: z.string().optional(), network }).strict(),
    get_usdd_mining_config: z.object({ network }).strict(),
  },
  usdd: {
    get_protocol_overview: z.object({ network }).strict(),
    get_psm_status: z.object({ market: z.literal("PSM-USDT"), network: z.literal("tron") }).strict(),
    get_psm_metrics: z.object({ market: z.literal("PSM-USDT"), network: z.literal("tron") }).strict(),
  },
  // TronGrid 호스팅 MCP는 Mainnet 전용이다 (network 인자 없음). tools/list로 확인한 읽기 도구만 허용한다.
  trongrid: {
    getChainParameters: z.object({}).strict(),
    getContract: z.object({ value: z.string().regex(/^T[1-9A-HJ-NP-Za-km-z]{33}$/) }).strict(),
  },
};

const BLOCKED = /(approve|supply|mint|redeem|withdraw|borrow|repay|swap|sell|buy|transfer|send|broadcast|sign|wallet|import|create|set_|enter|exit|claim|rent|purchase|stake|vote)/i;

export function checkToolCall(server: ServerId, tool: string, args: unknown): { ok: true; args: unknown } | { ok: false; error: string } {
  if (BLOCKED.test(tool)) return { ok: false, error: `차단된 도구입니다 (쓰기/지갑 관련): ${server}.${tool}` };
  const schema = ALLOWED_TOOLS[server]?.[tool];
  if (!schema) return { ok: false, error: `허용 목록에 없는 도구입니다: ${server}.${tool}` };
  const parsed = schema.safeParse(args ?? {});
  if (!parsed.success) return { ok: false, error: `잘못된 인자입니다: ${server}.${tool}` };
  return { ok: true, args: parsed.data };
}

/** tools/list로 발견한 도구 중 우리가 노출할 수 있는 것만 고른다 */
export function filterDiscovered(server: ServerId, discovered: string[]) {
  const allowed = discovered.filter((t) => !BLOCKED.test(t) && ALLOWED_TOOLS[server][t]);
  const missing = Object.keys(ALLOWED_TOOLS[server]).filter((t) => !discovered.includes(t));
  const blocked = discovered.filter((t) => BLOCKED.test(t));
  return { allowed, missing, blocked };
}
