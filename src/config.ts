// Central configuration. Everything comes from environment variables (see .env.example).

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}
function opt(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}
function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Env var ${name} must be a number`);
  return n;
}

/**
 * Railway (and most hosts) expose the database as DATABASE_URL, but only on services where you add it.
 * Accept the other names Railway uses too, or build it from the separate PG* variables.
 */
export function resolveDatabaseUrl(): string {
  const direct = process.env.DATABASE_URL || process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_PUBLIC_URL || process.env.POSTGRES_URL;
  if (direct) return direct;
  const { PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE } = process.env;
  if (PGHOST && PGUSER && PGDATABASE) {
    return `postgresql://${encodeURIComponent(PGUSER)}:${encodeURIComponent(PGPASSWORD ?? "")}@${PGHOST}:${PGPORT || 5432}/${PGDATABASE}`;
  }
  throw new Error("Missing required env var DATABASE_URL");
}

export const config = {
  port: num("PORT", 8080),
  publicBaseUrl: opt("PUBLIC_BASE_URL", "http://localhost:8080"),
  frontendOrigin: opt("FRONTEND_ORIGIN", "http://localhost:3000"),
  adminToken: () => req("ADMIN_TOKEN"),
  databaseUrl: () => resolveDatabaseUrl(),

  rpcUrl: () => opt("RH_RPC_URL", "https://rpc.mainnet.chain.robinhood.com"),
  chainId: num("RH_CHAIN_ID", 4663),
  explorerUrl: opt("EXPLORER_URL", "https://robinhoodchain.blockscout.com"),

  pons: {
    // Pons v2 addresses from https://docs.ponsfamily.com/v2 (override in settings if Pons publishes new ones)
    launchRouter: opt("PONS_LAUNCH_ROUTER", "0xe33E9E479dF8802cb0866d5d05258bEc4cF62948"),
    factory: opt("PONS_FACTORY", "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e"),
    feeEscrow: opt("PONS_FEE_ESCROW", "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e"),
  },

  /** Extra ETH the launcher sends to their launch wallet to cover gas (on top of Pons's launch fee + initial buy). */
  launchGasBufferEth: opt("LAUNCH_GAS_BUFFER_ETH", "0.0003"),
  platformFeePct: num("PLATFORM_FEE_PCT", 20),
  minPayoutUsd: num("MIN_PAYOUT_USD", 0.1),
  shillToken: opt("SHILL_TOKEN_ADDRESS"),
  burnAddress: opt("BURN_ADDRESS", "0x000000000000000000000000000000000000dEaD"),
  /** Receives each cycle's burn share and runs the $SHILL buyback & burn. */
  treasuryAddress: opt("TREASURY_ADDRESS"),
  /** Receives each cycle's shillers' pool, where it is converted and paid out via X Money. */
  payoutFundingAddress: opt("PAYOUT_FUNDING_ADDRESS"),

  x: {
    bearer: opt("X_BEARER_TOKEN"),
  },
  youtubeKey: opt("YOUTUBE_API_KEY"),
  reddit: {
    clientId: opt("REDDIT_CLIENT_ID"),
    clientSecret: opt("REDDIT_CLIENT_SECRET"),
    userAgent: opt("REDDIT_USER_AGENT", "shill-tracker/0.1"),
  },
};

export const CYCLE_SECONDS: Record<string, number> = {
  "1h": 3600,
  "4h": 4 * 3600,
  "12h": 12 * 3600,
  "24h": 24 * 3600,
  "7d": 7 * 24 * 3600,
};

export const STOCK_PAIRS = ["TSLA", "NVDA", "AAPL", "SPY", "AMZN"] as const;
