// Module hooks for the offline simulation: swap the real "pg" and "viem" packages for local stand-ins.
const map = {
  pg: new URL("./pg-sqlite.ts", import.meta.url).href,
  viem: new URL("./viem-fake.ts", import.meta.url).href,
  "viem/accounts": new URL("./viem-accounts-fake.ts", import.meta.url).href,
};
export async function resolve(specifier, context, next) {
  if (map[specifier]) return { url: map[specifier], shortCircuit: true };
  return next(specifier, context);
}
