import fs from "node:fs";
import path from "node:path";

// .env.local을 명시적으로 읽는다. 값은 이 프로세스 안에서만 쓰고 응답·로그에 넣지 않는다.
function loadEnvFile(file: string): Record<string, string> {
  if (!fs.existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = raw.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].replace(/\s+#.*$/, "").trim();
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

const fileEnv = loadEnvFile(path.resolve(process.cwd(), ".env.local"));
const get = (k: string, def = "") => process.env[k] ?? fileEnv[k] ?? def;

/** 알 수 없는 값은 템플릿으로 두고 시작 로그에 경고한다 (조용히 "키 미설정"으로 보이지 않게) */
function parseProvider(v: string): "bai" | "nim" | "template" {
  if (v === "bai" || v === "nim" || v === "template") return v;
  console.warn(`[env] LLM_PROVIDER=${v} 은(는) 지원하지 않습니다 (bai | nim | template). 템플릿으로 동작합니다.`);
  return "template";
}

export const env = {
  llmProvider: parseProvider(get("LLM_PROVIDER", "nim")),
  nimBaseUrl: get("NIM_BASE_URL", "https://integrate.api.nvidia.com/v1"),
  nimApiKey: get("NIM_API_KEY"),
  nimModel: get("NIM_MODEL", "nvidia/nemotron-3-super-120b-a12b"),
  llmTimeoutMs: Number(get("LLM_TIMEOUT_MS", "45000")),
  // Bank of AI (B.AI) LLM Service — OpenAI 호환 /chat/completions. 해커톤 안내의 "TRON LLM"이 이것이다.
  baiBaseUrl: get("BAI_BASE_URL", "https://api.b.ai/v1"),
  baiApiKey: get("BAI_API_KEY"),
  baiModel: get("BAI_MODEL", "gpt-5.6-terra"),
  trongridApiKey: get("TRONGRID_API_KEY"),
  mcpJustlendCommand: get("MCP_JUSTLEND_COMMAND"),
  mcpUsddCommand: get("MCP_USDD_COMMAND"),
  mcpTrongridEnabled: get("MCP_TRONGRID_ENABLED", "false") === "true",
  dataMode: (get("DATA_MODE", "synthetic") === "live" ? "live" : "synthetic") as "live" | "synthetic",
  enableNileExecution: get("ENABLE_NILE_EXECUTION", "false") === "true",
  apiPort: Number(get("API_PORT", "8787")),
};

/** 비밀이 아닌 설정 여부만 공개한다 */
export function publicConfig() {
  return {
    llmProvider: env.llmProvider,
    llmModel: env.llmProvider === "nim" ? env.nimModel : env.llmProvider === "bai" ? env.baiModel : undefined,
    /** 선택한 공급자의 키가 있어 실제 LLM을 호출하는지 */
    llmConfigured: (env.llmProvider === "nim" && Boolean(env.nimApiKey)) || (env.llmProvider === "bai" && Boolean(env.baiApiKey)),
    nimKeyConfigured: Boolean(env.nimApiKey),
    baiKeyConfigured: Boolean(env.baiApiKey),
    trongridKeyConfigured: Boolean(env.trongridApiKey),
    dataMode: env.dataMode,
    enableNileExecution: env.enableNileExecution,
    mcp: {
      justlend: Boolean(env.mcpJustlendCommand),
      usdd: Boolean(env.mcpUsddCommand),
      trongrid: env.mcpTrongridEnabled,
    },
  };
}

/** 로그·오류 메시지에서 키를 지운다 */
export function redact(s: string): string {
  let out = s;
  for (const secret of [env.nimApiKey, env.baiApiKey, env.trongridApiKey]) {
    if (secret && secret.length > 4) out = out.split(secret).join("***");
  }
  return out;
}
