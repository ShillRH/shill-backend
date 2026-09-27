// A simulated Robinhood Chain with Pons v2, following the behavior in Pons's docs:
//  - factory.launchToken / router.launchAndBuy create a token + bonding curve and emit TokenLaunched
//  - trades accrue creator fees on the curve (base fee share + creator tax)
//  - sweepFees (pre-graduation) / sweepPoolFees (post-graduation) move accrued creator fees into the
//    fee escrow, callable by the creator-fee recipient (or Pons's operator)
//  - escrow.claim() pays the recipient's escrow balance out in ETH
//  - only the current fee recipient could redirect fees (not exercised by the backend)
import { createHash } from "node:crypto";

export const ADDR = {
  factory: "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e".toLowerCase(),
  router: "0xe33E9E479dF8802cb0866d5d05258bEc4cF62948".toLowerCase(),
  escrow: "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e".toLowerCase(),
  hook: "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044".toLowerCase(),
  operator: "0x00000000000000000000000000000000000005ee",
};
const ZERO = "0x0000000000000000000000000000000000000000";
const h = (s: string) => createHash("sha256").update(s).digest("hex");
export const addr = (seed: string) => ("0x" + h(seed).slice(0, 40)) as `0x${string}`;
const E18 = 10n ** 18n;

interface Launch { token: string; curve: string; deployer: string; creatorFeeRecipient: string; pairToken: string; phase: number;
  creatorTaxBps: number; poolFee: number; tickSpacing: number; name: string; symbol: string; logo: string; description: string;
  socials: { twitter: string; telegram: string; discord: string; website: string; farcaster: string } }
interface Curve { token: string; quoteReserve: bigint; tokenReserve: bigint; raised: bigint; threshold: bigint; pending: bigint }
interface Log { address: string; eventName: string; args: Record<string, unknown>; blockNumber: bigint; transactionHash: string; logIndex: number }

export class Chain {
  block = 50_000_000n;
  startTs = Math.floor(Date.now() / 1000) - 5_000_000; // head timestamp ≈ now (0.1s blocks)
  eth = new Map<string, bigint>();
  tokens = new Map<string, { name: string; symbol: string; supply: bigint; bal: Map<string, bigint> }>();
  launches = new Map<string, Launch>();
  curves = new Map<string, Curve>();
  escrow = new Map<string, bigint>();
  logs: Log[] = [];
  receipts = new Map<string, { status: "success" | "reverted"; to: string; logs: Log[]; blockNumber: bigint; gasUsed: bigint; effectiveGasPrice: bigint }>();
  gasPrice = 1_000_000_000n;
  nonce = 0;
  launchFee = 5n * 10n ** 14n; // 0.0005 ETH
  whitelistOpen = true;
  calls: string[] = [];

  ts(b: bigint) { return BigInt(this.startTs) + b / 10n; }
  mine() { this.block += 1n; return this.block; }
  bal(a: string) { return this.eth.get(a.toLowerCase()) ?? 0n; }
  setEth(a: string, v: bigint) { this.eth.set(a.toLowerCase(), v); }
  tx(to: string, logs: Log[] = [], status: "success" | "reverted" = "success") {
    const hash = "0x" + h(`tx${this.nonce++}`);
    const bn = this.mine();
    for (const [i, l] of logs.entries()) { l.blockNumber = bn; l.transactionHash = hash; l.logIndex = i; this.logs.push(l); }
    this.receipts.set(hash, { status, to: to.toLowerCase(), logs, blockNumber: bn, gasUsed: 100_000n, effectiveGasPrice: this.gasPrice });
    return hash;
  }
  gas(from: string, units = 100_000n) {
    const cost = units * this.gasPrice;
    if (this.bal(from) < cost) throw new Error(`insufficient funds for gas (${from})`);
    this.setEth(from, this.bal(from) - cost);
  }

  // ---- Pons actions ----
  launch(o: { deployer: string; feeRecipient: string; name: string; symbol: string; tax: number; via?: "factory" | "router" | "proxima"; logo?: string; twitter?: string }) {
    if (!this.whitelistOpen) throw new Error("NotWhitelisted");
    const token = addr(`token${this.nonce}${o.symbol}`), curve = addr(`curve${this.nonce}${o.symbol}`);
    this.tokens.set(token, { name: o.name, symbol: o.symbol, supply: 1_000_000_000n * E18, bal: new Map() });
    this.launches.set(token, { token, curve, deployer: o.deployer.toLowerCase(), creatorFeeRecipient: o.feeRecipient.toLowerCase(), pairToken: ZERO, phase: 0,
      creatorTaxBps: o.tax, poolFee: 10000, tickSpacing: 200, name: o.name, symbol: o.symbol, logo: o.logo ?? "", description: `${o.name} on Pons`,
      socials: { twitter: o.twitter ?? "", telegram: "", discord: "", website: "", farcaster: "" } });
    this.curves.set(curve, { token, quoteReserve: 3n * E18, tokenReserve: 1_000_000_000n * E18, raised: 0n, threshold: 42n * E18 / 10n, pending: 0n });
    const to = o.via === "router" ? ADDR.router : o.via === "proxima" ? addr("proxima-bundler") : ADDR.factory;
    const hash = this.tx(to, [{ address: ADDR.factory, eventName: "TokenLaunched", args: { token, curve, deployer: o.deployer.toLowerCase(), pairToken: ZERO, launchConfigId: 0n, graduationThreshold: 42n * E18 / 10n }, blockNumber: 0n, transactionHash: "", logIndex: 0 }]);
    return { hash, token, curve };
  }
  /** A buy on the curve: moves price, accrues creator fees (creator's share of the 1% base fee + creator tax). */
  buy(token: string, ethIn: bigint) {
    const l = this.launches.get(token)!, c = this.curves.get(l.curve)!;
    const creatorFee = ethIn * BigInt(l.creatorTaxBps) / 10_000n + ethIn * 70n / 10_000n; // 0.7% of the 1% base fee to creator
    const net = ethIn - ethIn / 100n - ethIn * BigInt(l.creatorTaxBps) / 10_000n;
    const out = c.tokenReserve * net / (c.quoteReserve + net);
    c.quoteReserve += net; c.tokenReserve -= out; c.raised += net; c.pending += creatorFee;
    this.tx(l.curve, [{ address: l.curve, eventName: "CurveBuy", args: { buyer: ZERO, recipient: ZERO, quoteIn: ethIn, tokensOut: out, fee: ethIn / 100n, tax: 0n }, blockNumber: 0n, transactionHash: "", logIndex: 0 }]);
  }
  /** Pons's own operator sweeping a token's fees (what creates "unattributed" fees for the platform). */
  operatorSweep(token: string) {
    const l = this.launches.get(token)!, c = this.curves.get(l.curve)!;
    this.escrow.set(l.creatorFeeRecipient, (this.escrow.get(l.creatorFeeRecipient) ?? 0n) + c.pending); c.pending = 0n;
  }
  graduate(token: string) { this.launches.get(token)!.phase = 2; }

  // ---- contract reads ----
  read(address: string, fn: string, args: unknown[] = []): unknown {
    const a = address.toLowerCase();
    this.calls.push(`read ${fn}`);
    if (a === ADDR.factory) {
      if (fn === "getLaunchedToken") {
        const l = this.launches.get(String(args[0]).toLowerCase());
        if (!l) return { exists: false, token: ZERO, curve: ZERO, deployer: ZERO, creatorFeeRecipient: ZERO, pairToken: ZERO, phase: 0, creatorTaxBps: 0, poolFee: 0, tickSpacing: 0 };
        return { ...l, exists: true, graduationThreshold: 42n * E18 / 10n, buybackEnabled: false, sweptQuote: 0n, sweptTokens: 0n, sweptAt: 0n };
      }
      if (fn === "canLaunch") return this.whitelistOpen;
      if (fn === "launchFee") return this.launchFee;
    }
    if (a === ADDR.escrow) {
      if (fn === "balanceOf") return this.escrow.get(String(args[0]).toLowerCase()) ?? 0n;
      if (fn === "balanceOfToken") return 0n;
    }
    const tk = this.tokens.get(a);
    if (tk) {
      if (fn === "name") return tk.name; if (fn === "symbol") return tk.symbol; if (fn === "decimals") return 18;
      if (fn === "totalSupply") return tk.supply; if (fn === "balanceOf") return tk.bal.get(String(args[0]).toLowerCase()) ?? 0n;
      if (fn === "getTokenInfo") { const l = this.launches.get(a)!; return [l.deployer, l.logo, l.description, l.socials]; }
    }
    const cv = this.curves.get(a);
    if (cv) {
      if (fn === "getReserves") return [cv.quoteReserve, cv.tokenReserve];
      if (fn === "realQuoteReserve") return cv.raised;
      if (fn === "graduationThreshold") return cv.threshold;
    }
    throw new Error(`execution reverted: unknown read ${fn} on ${address}`);
  }

  // ---- contract writes (validated like the real contracts) ----
  check(from: string, address: string, fn: string, args: unknown[]) {
    const a = address.toLowerCase(), f = from.toLowerCase();
    if (fn === "sweepFees") {
      const l = [...this.launches.values()].find((x) => x.curve === a);
      if (!l) throw new Error("execution reverted: not a curve");
      if (l.phase !== 0) throw new Error("execution reverted: curve closed");
      if (f !== l.creatorFeeRecipient && f !== ADDR.operator) throw new Error("execution reverted: Unauthorized");
    } else if (fn === "sweepPoolFees") {
      if (a !== ADDR.hook) throw new Error("execution reverted");
    } else if (fn === "claim") {
      if (a !== ADDR.escrow) throw new Error("execution reverted");
      if (!(this.escrow.get(f) ?? 0n)) throw new Error("execution reverted: NothingToClaim");
    } else if (fn === "transfer") {
      const tk = this.tokens.get(a); if (!tk) throw new Error("execution reverted");
      if ((tk.bal.get(f) ?? 0n) < (args[1] as bigint)) throw new Error("execution reverted: ERC20InsufficientBalance");
    } else throw new Error(`execution reverted: unknown write ${fn}`);
  }
  write(from: string, address: string, fn: string, args: unknown[]): string {
    this.check(from, address, fn, args);
    const a = address.toLowerCase(), f = from.toLowerCase();
    this.gas(f);
    this.calls.push(`write ${fn}`);
    if (fn === "sweepFees") {
      const l = [...this.launches.values()].find((x) => x.curve === a)!, c = this.curves.get(a)!;
      this.escrow.set(l.creatorFeeRecipient, (this.escrow.get(l.creatorFeeRecipient) ?? 0n) + c.pending); c.pending = 0n;
    } else if (fn === "sweepPoolFees") {
      for (const l of this.launches.values()) if (l.phase === 2 && f === l.creatorFeeRecipient) {
        const c = this.curves.get(l.curve)!; this.escrow.set(f, (this.escrow.get(f) ?? 0n) + c.pending); c.pending = 0n;
      }
    } else if (fn === "claim") {
      const v = this.escrow.get(f)!; this.escrow.set(f, 0n); this.setEth(f, this.bal(f) + v);
    } else if (fn === "transfer") {
      const tk = this.tokens.get(a)!, [to, v] = args as [string, bigint];
      tk.bal.set(f, (tk.bal.get(f) ?? 0n) - v); tk.bal.set(to.toLowerCase(), (tk.bal.get(to.toLowerCase()) ?? 0n) + v);
    }
    return this.tx(a);
  }
  sendEth(from: string, to: string, value: bigint): string {
    this.gas(from, 21_000n);
    if (this.bal(from) < value) throw new Error("insufficient funds");
    this.setEth(from, this.bal(from) - value); this.setEth(to, this.bal(to) + value);
    this.calls.push(`send ${value} to ${to.toLowerCase()}`);
    return this.tx(to);
  }
}
export const chain: Chain = ((globalThis as Record<string, unknown>).__chain ??= new Chain()) as Chain;
