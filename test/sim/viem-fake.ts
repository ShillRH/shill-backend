// Test stand-in for "viem": same function names the backend uses, backed by the simulated chain.
import { createHash } from "node:crypto";
import { chain } from "./chain.ts";

export type Address = `0x${string}`; export type Hex = `0x${string}`; export type Hash = `0x${string}`; export type Abi = readonly unknown[];
export const zeroAddress = "0x0000000000000000000000000000000000000000";
function item(sig: string) {
  const m = /^\s*(event|function|struct)\s+(\w+)/.exec(sig);
  return m ? { type: m[1], name: m[2], sig } : { type: "unknown", name: "", sig };
}
export const parseAbi = (sigs: readonly string[]) => sigs.map(item).filter((x) => x.type !== "struct");
export const parseAbiItem = (sig: string) => item(sig);
export const defineChain = <T>(c: T) => c;
export const http = (_u?: string) => ({});
export function parseEther(v: string): bigint {
  const [i, d = ""] = String(v).split(".");
  return BigInt(i || "0") * 10n ** 18n + BigInt((d + "0".repeat(18)).slice(0, 18) || "0");
}
export function formatUnits(v: bigint, dec: number): string {
  const neg = v < 0n; let x = neg ? -v : v; const base = 10n ** BigInt(dec);
  const frac = (x % base).toString().padStart(dec, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${x / base}${frac ? "." + frac : ""}`;
}
export const formatEther = (v: bigint) => formatUnits(v, 18);
export const keccak256 = (v: string) => ("0x" + createHash("sha256").update(v).digest("hex")) as Hex;
export const encodeAbiParameters = (_t: unknown, v: unknown[]) => ("0x" + Buffer.from(JSON.stringify(v, (_k, x) => typeof x === "bigint" ? x.toString() : x)).toString("hex")) as Hex;
export const toHex = (v: Uint8Array | string) => ("0x" + Buffer.from(v as Uint8Array).toString("hex")) as Hex;

export function parseEventLogs(o: { abi: unknown; logs: { eventName: string }[]; eventName?: string }) {
  return o.logs.filter((l) => !o.eventName || l.eventName === o.eventName);
}

const publicClient = {
  async readContract(o: { address: string; functionName: string; args?: unknown[] }) { return chain.read(o.address, o.functionName, o.args ?? []); },
  async simulateContract(o: { account: { address: string }; address: string; functionName: string; args?: unknown[]; value?: bigint }) {
    chain.check(o.account.address, o.address, o.functionName, o.args ?? []);
    return { request: { ...o, args: o.args ?? [] } };
  },
  async getBalance(o: { address: string }) { return chain.bal(o.address); },
  async getBlockNumber() { return chain.block; },
  async getBlock(o: { blockNumber: bigint }) { return { number: o.blockNumber, timestamp: chain.ts(o.blockNumber) }; },
  async getGasPrice() { return chain.gasPrice; },
  async getTransactionReceipt(o: { hash: string }) { const r = chain.receipts.get(o.hash); if (!r) throw new Error("receipt not found"); return r; },
  async waitForTransactionReceipt(o: { hash: string }) { return this.getTransactionReceipt(o); },
  async getLogs(o: { address: string; event?: { name: string }; events?: { name: string }[]; fromBlock: bigint; toBlock: bigint }) {
    const names = new Set((o.events ?? (o.event ? [o.event] : [])).map((e) => e.name));
    return chain.logs.filter((l) => l.address.toLowerCase() === o.address.toLowerCase() && l.blockNumber >= o.fromBlock && l.blockNumber <= o.toBlock && (!names.size || names.has(l.eventName)));
  },
};
export const createPublicClient = (_o: unknown) => publicClient;
export const createWalletClient = (o: { account: { address: string } }) => ({
  account: o.account,
  chain: {},
  async writeContract(r: { address: string; functionName: string; args: unknown[] }) { return chain.write(o.account.address, r.address, r.functionName, r.args); },
  async sendTransaction(r: { to: string; value: bigint }) { return chain.sendEth(o.account.address, r.to, r.value); },
});
