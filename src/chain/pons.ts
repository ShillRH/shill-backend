// Pons v2 integration (https://docs.ponsfamily.com/v2).
// Launches are signed in the launcher's browser by their own fresh launch wallet. The backend:
//   - tells the site which fee recipient and settings to use (GET /launch/config)
//   - verifies each launch on chain before listing it (verifyLaunch)
//   - sweeps each token's creator fees into the fee wallet's escrow balance, attributed per token (sweepToken)
//   - claims the escrow into the fee wallet (claimEscrow) and pays out from there
import { encodeAbiParameters, keccak256, parseEventLogs, zeroAddress, type Address, type Hash, type Hex } from "viem";
import { config } from "../config.js";
import { publicClient } from "./client.js";
import { feeWallet, feeWalletAddress } from "./feeWallet.js";
import { factoryAbi, curveAbi, hookAbi, escrowAbi, erc20Abi } from "./ponsAbi.js";

const FACTORY = () => config.pons.factory as Address;
const ROUTER = () => config.pons.launchRouter as Address;
const ESCROW = () => config.pons.feeEscrow as Address;
export const HOOK = () => (process.env.PONS_MEME_HOOK ?? "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044") as Address;

export async function launchRecord(token: Address) {
  return publicClient.readContract({ address: FACTORY(), abi: factoryAbi, functionName: "getLaunchedToken", args: [token] });
}

export interface VerifiedLaunch { token: Address; curve: Address; deployer: Address; creatorTaxBps: number; pairToken: Address; block: bigint }

/**
 * Confirms a launch transaction really created a Pons v2 token whose creator fees go to the platform fee
 * wallet. Anything else is rejected, so nobody can list a token that doesn't pay shillers.
 */
export async function verifyLaunch(txHash: Hash): Promise<VerifiedLaunch> {
  const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error("That launch transaction failed on chain.");
  const to = receipt.to?.toLowerCase();
  if (to !== FACTORY().toLowerCase() && to !== ROUTER().toLowerCase()) throw new Error("That transaction wasn't a Pons v2 launch.");
  const ev = parseEventLogs({ abi: factoryAbi, logs: receipt.logs, eventName: "TokenLaunched" })
    .find((e: { address: string }) => e.address.toLowerCase() === FACTORY().toLowerCase());
  if (!ev) throw new Error("No Pons launch found in that transaction.");
  const rec = await launchRecord(ev.args.token);
  if (!rec.exists) throw new Error("Pons doesn't recognize that token.");
  if (rec.creatorFeeRecipient.toLowerCase() !== feeWalletAddress().toLowerCase())
    throw new Error("This token's creator fees don't go to the $SHILL fee wallet, so it can't be listed.");
  return { token: ev.args.token, curve: ev.args.curve, deployer: rec.deployer, creatorTaxBps: Number(rec.creatorTaxBps),
    pairToken: rec.pairToken, block: receipt.blockNumber };
}

async function escrowBalance(pairToken: Address | null): Promise<bigint> {
  const me = feeWalletAddress();
  return pairToken
    ? publicClient.readContract({ address: ESCROW(), abi: escrowAbi, functionName: "balanceOfToken", args: [me, pairToken] })
    : publicClient.readContract({ address: ESCROW(), abi: escrowAbi, functionName: "balanceOf", args: [me] });
}

function poolId(l: { token: Address; pairToken: Address; poolFee: number; tickSpacing: number }): Hex {
  const [c0, c1] = l.pairToken.toLowerCase() < l.token.toLowerCase() ? [l.pairToken, l.token] : [l.token, l.pairToken];
  return keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
    [c0, c1, l.poolFee, l.tickSpacing, HOOK()]));
}

/**
 * Sweeps one token's accrued creator fees into the fee wallet's escrow balance and returns exactly how much
 * arrived (escrow balance after minus before). Returns 0 if Pons requires its own operator for this sweep;
 * in that case Pons sweeps it later and it shows up as unattributed.
 */
export async function sweepToken(token: Address): Promise<{ amount: bigint; tx: Hash | null; pairToken: Address | null }> {
  const rec = await launchRecord(token);
  const pair = rec.pairToken === zeroAddress ? null : rec.pairToken;
  const w = feeWallet();
  const before = await escrowBalance(pair);
  let tx: Hash | null = null;
  try {
    if (rec.phase === 0) {
      const { request } = await publicClient.simulateContract({ account: w.account, address: rec.curve, abi: curveAbi, functionName: "sweepFees", args: [0n] });
      tx = await w.writeContract(request);
    } else if (rec.phase === 2) {
      const id = poolId({ token: rec.token, pairToken: rec.pairToken, poolFee: rec.poolFee, tickSpacing: rec.tickSpacing });
      const { request } = await publicClient.simulateContract({ account: w.account, address: HOOK(), abi: hookAbi, functionName: "sweepPoolFees", args: [id, 0n, 0n] });
      tx = await w.writeContract(request);
    }
    if (tx) {
      const r = await publicClient.waitForTransactionReceipt({ hash: tx });
      if (r.status !== "success") return { amount: 0n, tx, pairToken: pair };
    }
  } catch {
    return { amount: 0n, tx: null, pairToken: pair }; // nothing to sweep, or operator-only sweep
  }
  const after = await escrowBalance(pair);
  return { amount: after > before ? after - before : 0n, tx, pairToken: pair };
}

export async function escrowOf(pairToken: Address | null) { return escrowBalance(pairToken); }

/** Moves the fee wallet's whole escrow balance (for one asset) into the fee wallet. */
export async function claimEscrow(pairToken: Address | null): Promise<Hash | null> {
  const owed = await escrowBalance(pairToken);
  if (owed === 0n) return null;
  const w = feeWallet();
  const { request } = pairToken
    ? await publicClient.simulateContract({ account: w.account, address: ESCROW(), abi: escrowAbi, functionName: "claimToken", args: [pairToken] })
    : await publicClient.simulateContract({ account: w.account, address: ESCROW(), abi: escrowAbi, functionName: "claim" });
  const tx = await w.writeContract(request);
  const r = await publicClient.waitForTransactionReceipt({ hash: tx });
  if (r.status !== "success") throw new Error(`Escrow claim reverted: ${tx}`);
  return tx;
}

export async function balanceOf(owner: Address, token: Address | null): Promise<bigint> {
  if (!token) return publicClient.getBalance({ address: owner });
  return publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
}

export async function decimalsOf(token: Address | null): Promise<number> {
  if (!token) return 18;
  return publicClient.readContract({ address: token, abi: erc20Abi, functionName: "decimals" });
}

/** Sends ETH (token = null) or an ERC-20 from the fee wallet. */
export async function sendFromFeeWallet(to: Address, amount: bigint, token: Address | null): Promise<Hash> {
  const w = feeWallet();
  const hash = token
    ? await w.writeContract({ address: token, abi: erc20Abi, functionName: "transfer", args: [to, amount], chain: w.chain, account: w.account })
    : await w.sendTransaction({ to, value: amount, chain: w.chain, account: w.account });
  const r = await publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`Transfer reverted: ${hash}`);
  return hash;
}
