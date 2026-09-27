// Test stand-in for "viem/accounts". The configured test key maps to the real platform fee wallet address.
import { createHash } from "node:crypto";
const h = (s: string) => createHash("sha256").update(s).digest("hex");
export const FEE_WALLET = "0xf71a301d178686324254ddd6d1972cc839dc16d3";
export function privateKeyToAccount(pk: string) {
  const address = pk === process.env.TEST_FEE_WALLET_KEY ? FEE_WALLET : "0x" + h(pk).slice(0, 40);
  return { address, type: "local" };
}
export function mnemonicToAccount(m: string, o: { addressIndex?: number } = {}) {
  const address = m === process.env.TEST_FEE_WALLET_MNEMONIC && (o.addressIndex ?? 0) === 0 ? FEE_WALLET : "0x" + h(m + (o.addressIndex ?? 0)).slice(0, 40);
  return { address, type: "local" };
}
export const generatePrivateKey = () => "0x" + h(String(Math.random()));
