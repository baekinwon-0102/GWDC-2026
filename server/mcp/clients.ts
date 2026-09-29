import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { env, redact } from "../env";
import { checkToolCall, filterDiscovered, type ServerId } from "./registry";

// 공식 MCP 연결·종료. P0에서는 앱이 정해진 순서로 호출하고, LLM에 도구를 넘기지 않는다.
// MCP 응답 안의 문장은 데이터로만 다루며 지시로 실행하지 않는다.

export interface McpStatus {
  server: ServerId;
  state: "connected" | "disabled" | "failed";
  transport?: "stdio" | "http";
  version?: string;
  tools?: { allowed: string[]; missing: string[]; blocked: string[] };
  error?: string;
  note?: string;
}

const CALL_TIMEOUT_MS = 20000;
const clients = new Map<ServerId, { client: Client; version?: string }>();
const statuses = new Map<ServerId, McpStatus>();

const DISABLED_NOTE: Record<ServerId, string> = {
  justlend:
    "공식 JustLend MCP는 시작 시 ~/.agent-wallet 지갑을 초기화합니다(AGENT_WALLET_PASSWORD). 지갑 생성을 분리할 수 없어 시장 조회는 JustLend 공식 OpenAPI와 온체인 읽기로 대체했습니다.",
  usdd: "공식 USDD MCP는 첫 시작 시 ~/.agent-wallet 기본 지갑을 자동 생성합니다. 또한 PSM 도구가 물량(부채 한도 여유·출구 USDT)을 반환하지 않아 PSM은 온체인 직접 조회로 대체했습니다.",
  trongrid: "MCP_TRONGRID_ENABLED=false입니다. Mainnet 수수료 파라미터를 직접 RPC로 읽습니다.",
};

function splitCommand(cmd: string): { command: string; args: string[] } {
  const parts = cmd.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((p) => p.replace(/^"|"$/g, "")) ?? [];
  return { command: parts[0], args: parts.slice(1) };
}

async function connectOne(server: ServerId): Promise<McpStatus> {
  let transport;
  let kind: "stdio" | "http";
  if (server === "trongrid") {
    if (!env.mcpTrongridEnabled) return { server, state: "disabled", note: DISABLED_NOTE[server] };
    kind = "http";
    transport = new StreamableHTTPClientTransport(new URL("https://mcp.trongrid.io/mcp"), {
      requestInit: { headers: env.trongridApiKey ? { "TRON-PRO-API-KEY": env.trongridApiKey } : {} },
    });
  } else {
    const cmd = server === "justlend" ? env.mcpJustlendCommand : env.mcpUsddCommand;
    if (!cmd) return { server, state: "disabled", note: DISABLED_NOTE[server] };
    kind = "stdio";
    const { command, args } = splitCommand(cmd);
    // 개인키·니모닉은 절대 넘기지 않는다. 읽기에 필요한 키만 전달한다.
    transport = new StdioClientTransport({
      command,
      args,
      env: { PATH: process.env.PATH ?? "", TRONGRID_API_KEY: env.trongridApiKey },
      stderr: "ignore",
    });
  }
  const client = new Client({ name: "gwdc-planner", version: "0.1.0" });
  try {
    await Promise.race([client.connect(transport), timeout(CALL_TIMEOUT_MS, "연결")]);
    const version = client.getServerVersion()?.version;
    const list = await client.listTools();
    const tools = filterDiscovered(server, list.tools.map((t) => t.name));
    clients.set(server, { client, version });
    return { server, state: "connected", transport: kind, version, tools };
  } catch (e) {
    await client.close().catch(() => {});
    return { server, state: "failed", transport: kind, error: redact(String((e as Error).message ?? e)) };
  }
}

function timeout(ms: number, what: string) {
  return new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`MCP ${what} 시간 초과`)), ms));
}

export async function connectAll(): Promise<McpStatus[]> {
  const results = await Promise.all((["justlend", "usdd", "trongrid"] as ServerId[]).map(connectOne));
  for (const s of results) statuses.set(s.server, s);
  return results;
}

export function mcpStatuses(): McpStatus[] {
  return [...statuses.values()];
}

export function isConnected(server: ServerId) {
  return clients.has(server);
}

/** 허용 목록을 통과한 읽기 도구만 호출한다. 결과는 JSON으로 파싱한 데이터만 돌려준다. */
export async function callReadTool(server: ServerId, tool: string, args: unknown): Promise<{ data: unknown; version?: string }> {
  const check = checkToolCall(server, tool, args);
  if (!check.ok) throw new Error(check.error);
  const c = clients.get(server);
  if (!c) throw new Error(`MCP ${server} 미연결`);
  const res: any = await Promise.race([c.client.callTool({ name: tool, arguments: check.args as Record<string, unknown> }), timeout(CALL_TIMEOUT_MS, tool)]);
  if (res?.isError) throw new Error(`MCP ${server}.${tool} 오류`);
  const text = (res?.content ?? []).find((x: any) => x.type === "text")?.text;
  if (res?.structuredContent) return { data: res.structuredContent, version: c.version };
  try {
    return { data: JSON.parse(text), version: c.version };
  } catch {
    throw new Error(`MCP ${server}.${tool} 응답이 JSON이 아닙니다 (스키마 변경 가능성)`);
  }
}

export async function closeAll() {
  await Promise.all([...clients.values()].map((c) => c.client.close().catch(() => {})));
  clients.clear();
}
