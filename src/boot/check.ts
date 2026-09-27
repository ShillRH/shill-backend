// Startup check: explains every missing setting at once, in plain words, instead of crashing on the first.
import { resolveDatabaseUrl } from "../config.js";

type Role = "api" | "worker" | "migrate";

export function checkEnvOrExit(role: Role) {
  const errors: string[] = [];
  const warnings: string[] = [];
  const has = (k: string) => Boolean(process.env[k]?.trim());

  try { resolveDatabaseUrl(); }
  catch {
    errors.push(
      "DATABASE_URL is not set, so the backend can't reach its database.\n" +
      "     On Railway: open THIS service > Variables > New Variable, name it DATABASE_URL and set the value to\n" +
      "     ${{Postgres.DATABASE_URL}}  (\"Postgres\" must match your database service's name exactly).\n" +
      "     Add it to BOTH the API and the Worker service, then click Deploy to apply the change.");
  }
  if (role === "api") {
    if (!has("ADMIN_TOKEN")) errors.push("ADMIN_TOKEN is not set. Make up a long random password and add it as ADMIN_TOKEN.");
    if (!has("PUBLIC_BASE_URL")) warnings.push("PUBLIC_BASE_URL is not set. Set it to this service's public address (e.g. https://your-app.up.railway.app) so token images get the right links.");
    if (!has("FRONTEND_ORIGIN")) warnings.push("FRONTEND_ORIGIN is not set. Set it to your website's address so the site is allowed to call this API.");
  }
  if (role === "worker") {
    if (!has("FEE_WALLET_PRIVATE_KEY") && !has("FEE_WALLET_MNEMONIC"))
      warnings.push("No fee wallet secret (FEE_WALLET_MNEMONIC or FEE_WALLET_PRIVATE_KEY). Tracking and listing still run; fee collection and payouts are skipped until it's set.");
    if (!has("X_BEARER_TOKEN")) warnings.push("X_BEARER_TOKEN is not set, so X posts aren't tracked yet.");
    if (!has("TREASURY_ADDRESS") || !has("PAYOUT_FUNDING_ADDRESS")) warnings.push("TREASURY_ADDRESS / PAYOUT_FUNDING_ADDRESS are not set, so payout cycles wait until they are.");
  }

  for (const w of warnings) console.warn(`[setup] note: ${w}`);
  if (!errors.length) return;
  console.error(`\n[setup] The ${role} can't start yet. Fix ${errors.length === 1 ? "this" : "these"} in your host's settings:\n`);
  errors.forEach((e, i) => console.error(`  ${i + 1}. ${e}\n`));
  // Wait before exiting so the host doesn't restart it in a tight loop and flood the logs.
  setTimeout(() => process.exit(1), 30_000);
  throw new SetupError();
}

export class SetupError extends Error { constructor() { super("setup incomplete"); this.name = "SetupError"; } }
