// TronLink 브라우저 지갑 연동. 서명은 항상 사용자가 TronLink 창에서 직접 확인한다.

declare global {
  interface Window {
    tronLink?: { ready?: boolean; request: (args: { method: string; params?: unknown }) => Promise<any>; tronWeb?: any };
    tronWeb?: any;
  }
}

export interface WalletInfo {
  address: string;
  network: "nile" | "mainnet" | "other";
  host: string;
}

function tw(): any {
  return window.tronLink?.tronWeb ?? window.tronWeb;
}

export function hasTronLink() {
  return Boolean(window.tronLink || window.tronWeb);
}

export function currentWallet(): WalletInfo | undefined {
  const t = tw();
  const address: string | undefined = t?.defaultAddress?.base58;
  if (!t || !address) return undefined;
  const host: string = t.fullNode?.host ?? "";
  const network = /nile/i.test(host) ? "nile" : /api\.trongrid\.io|tronstack|trongrid\.io$/i.test(host) ? "mainnet" : "other";
  return { address, network, host };
}

export async function connect(): Promise<WalletInfo> {
  if (!window.tronLink) throw new Error("TronLink 확장이 설치되어 있지 않습니다.");
  const r = await window.tronLink.request({ method: "tron_requestAccounts" });
  if (r?.code === 4001) throw new Error("사용자가 지갑 연결을 거부했습니다.");
  // 연결 직후 tronWeb 주입이 늦을 수 있다.
  for (let i = 0; i < 20 && !currentWallet(); i++) await new Promise((res) => setTimeout(res, 150));
  const w = currentWallet();
  if (!w) throw new Error("지갑 주소를 읽지 못했습니다. TronLink 잠금을 해제해 주세요.");
  return w;
}

export class SignRejected extends Error {}
export class BroadcastUnknown extends Error {
  constructor(
    message: string,
    public txId: string,
  ) {
    super(message);
  }
}

export class BroadcastRejected extends Error {
  constructor(
    message: string,
    public txId: string,
  ) {
    super(message);
  }
}

function decodeMsg(m?: string): string {
  if (!m) return "";
  if (!/^[0-9a-f]+$/i.test(m)) return m;
  try {
    return new TextDecoder().decode(new Uint8Array(m.match(/.{2}/g)!.map((h) => parseInt(h, 16))));
  } catch {
    return m;
  }
}

/**
 * 계약 호출을 만들고 서명한다. 서명된 txID를 먼저 돌려준 뒤(onSigned) 방송한다.
 * 방송 결과를 모르면 BroadcastUnknown을 던진다 — 호출자는 같은 txID를 조회해야 하며 재서명하지 않는다.
 */
export async function signAndSend(opts: {
  contract: string;
  method: string;
  params: { type: string; value: unknown }[];
  callValueSun: bigint;
  feeLimitSun: bigint;
  from: string;
  onSigned: (txId: string) => void;
}): Promise<string> {
  const t = tw();
  if (!t) throw new Error("TronLink가 연결되지 않았습니다.");
  const built = await t.transactionBuilder.triggerSmartContract(
    opts.contract,
    opts.method,
    { callValue: Number(opts.callValueSun), feeLimit: Number(opts.feeLimitSun) },
    opts.params,
    opts.from,
  );
  if (!built?.result?.result || !built.transaction) throw new Error(`거래 생성 실패: ${built?.result?.message ?? "알 수 없음"}`);
  return signBroadcast(t, built.transaction, opts.onSigned);
}

/** TRON 시스템 거래 (Stake 2.0 스테이킹·투표·해제·인출·보상 청구). 계약 호출이 아니라 Energy가 들지 않는다 */
export type SystemAction =
  | { type: "stake"; amountSun: bigint }
  | { type: "vote"; sr: string; votes: number }
  | { type: "unstake"; amountSun: bigint }
  | { type: "withdraw_unfrozen" }
  | { type: "claim_reward" };

export async function signAndSendSystem(opts: { action: SystemAction; from: string; onSigned: (txId: string) => void }): Promise<string> {
  const t = tw();
  if (!t) throw new Error("TronLink가 연결되지 않았습니다.");
  const b = t.transactionBuilder;
  const a = opts.action;
  let tx: any;
  try {
    // 스테이킹 자원은 대역폭으로 고정한다 (투표권은 자원 종류와 무관하게 1 TRX = 1표)
    if (a.type === "stake") tx = await b.freezeBalanceV2(Number(a.amountSun), "BANDWIDTH", opts.from);
    else if (a.type === "vote") tx = await b.vote({ [a.sr]: a.votes }, opts.from);
    else if (a.type === "unstake") tx = await b.unfreezeBalanceV2(Number(a.amountSun), "BANDWIDTH", opts.from);
    else if (a.type === "withdraw_unfrozen") tx = await b.withdrawExpireUnfreeze(opts.from);
    else tx = await b.withdrawBlockRewards(opts.from);
  } catch (e) {
    throw new Error(`거래 생성 실패: ${String((e as Error)?.message ?? e)}`);
  }
  if (!tx?.txID) throw new Error("거래 생성 실패: 노드 응답에 txID가 없습니다.");
  return signBroadcast(t, tx, opts.onSigned);
}

async function signBroadcast(t: any, transaction: any, onSigned: (txId: string) => void): Promise<string> {
  let signed: any;
  try {
    signed = await t.trx.sign(transaction);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (/cancel|reject|declin|denied|확인|취소/i.test(msg)) throw new SignRejected("사용자가 서명을 거부했습니다.");
    throw new SignRejected(`서명되지 않았습니다: ${msg}`);
  }
  const txId: string = signed.txID;
  onSigned(txId);
  try {
    const r = await t.trx.sendRawTransaction(signed);
    if (r?.result === true || r?.txid) return txId;
    const code = r?.code;
    if (code === "DUP_TRANSACTION_ERROR") return txId;
    if (code) throw new BroadcastRejected(`노드가 거래를 거부했습니다 (${code}): ${decodeMsg(r?.message)}`, txId);
    throw new BroadcastUnknown("방송 응답을 해석할 수 없습니다. 같은 txID를 조회합니다.", txId);
  } catch (e) {
    if (e instanceof BroadcastUnknown || e instanceof BroadcastRejected) throw e;
    throw new BroadcastUnknown(`방송 결과를 알 수 없습니다: ${(e as Error).message}`, txId);
  }
}
