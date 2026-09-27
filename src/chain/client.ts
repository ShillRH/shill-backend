// viem clients for Robinhood Chain.
import { createPublicClient, createWalletClient, defineChain, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "../config.js";

export const robinhood = defineChain({
  id: config.chainId,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [config.rpcUrl()] } },
  blockExplorers: { default: { name: "Explorer", url: config.explorerUrl } },
});

export const publicClient = createPublicClient({ chain: robinhood, transport: http(config.rpcUrl()) });

export function walletFor(privateKey: Hex) {
  const account = privateKeyToAccount(privateKey);
  return createWalletClient({ account, chain: robinhood, transport: http(config.rpcUrl()) });
}
