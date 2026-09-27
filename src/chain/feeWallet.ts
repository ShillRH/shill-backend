// The platform fee wallet: the creator-fee recipient for every token launched through the site.
// Set ONE of these in your host's secret settings (never in code, never in chat):
//   FEE_WALLET_PRIVATE_KEY=0x...        or
//   FEE_WALLET_MNEMONIC="twelve words ..."   (+ optional FEE_WALLET_ACCOUNT_INDEX, default 0)
// Use a wallet created only for this. Whoever holds this key controls all collected creator fees.
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { createWalletClient, http, type Address } from "viem";
import { config } from "../config.js";
import { robinhood } from "./client.js";

/** The platform fee wallet's public address. Every launch through the site sends its creator fees here. */
export const DEFAULT_FEE_WALLET: Address = "0xf71a301d178686324254ddd6d1972cc839dc16d3";

let cached: ReturnType<typeof build> | null = null;

function expectedAddress(): Address {
  return (process.env.FEE_WALLET_ADDRESS?.trim() || DEFAULT_FEE_WALLET) as Address;
}

function build() {
  const pk = process.env.FEE_WALLET_PRIVATE_KEY?.trim();
  const phrase = process.env.FEE_WALLET_MNEMONIC?.trim();
  let account;
  if (pk) account = privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`);
  else if (phrase) account = mnemonicToAccount(phrase, { addressIndex: Number(process.env.FEE_WALLET_ACCOUNT_INDEX ?? 0) });
  else throw new Error("Set FEE_WALLET_PRIVATE_KEY or FEE_WALLET_MNEMONIC to collect and pay out fees.");
  // Safety check: the secret must unlock the fee wallet launches actually pay into.
  if (account.address.toLowerCase() !== expectedAddress().toLowerCase()) {
    throw new Error(`The fee wallet secret unlocks ${account.address}, but the fee wallet is ${expectedAddress()}. ` +
      "Check FEE_WALLET_PRIVATE_KEY / FEE_WALLET_MNEMONIC / FEE_WALLET_ACCOUNT_INDEX.");
  }
  return createWalletClient({ account, chain: robinhood, transport: http(config.rpcUrl()) });
}

export function feeWallet() {
  return (cached ??= build());
}

/** Public address only. Safe to show anywhere. Works even before the secret is set. */
export function feeWalletAddress(): Address {
  return expectedAddress();
}
