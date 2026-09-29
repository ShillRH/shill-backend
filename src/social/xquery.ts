// Builds X search queries for tokens, packed to fit the query length limit.
const MAX_QUERY = Number(process.env.X_QUERY_MAX_LEN ?? 512);

/** The search term for one token: its $TICKER cashtag and/or its contract address. Null if neither is searchable. */
export function tokenTerm(ticker: string, contract: string | null): string | null {
  const parts: string[] = [];
  if (/^[A-Za-z][A-Za-z0-9_]{0,15}$/.test(ticker)) parts.push(`$${ticker}`);
  if (contract && /^0x[0-9a-fA-F]{40}$/.test(contract)) parts.push(`"${contract}"`);
  return parts.length ? parts.join(" OR ") : null;
}

/** Packs several tokens' terms into as few queries as fit, so each search pass makes few requests. */
export function packQueries<K>(items: { key: K; term: string }[], maxLen = MAX_QUERY): { query: string; keys: K[] }[] {
  const make = (g: { term: string }[]) => `(${g.map((i) => i.term).join(" OR ")}) -is:retweet`;
  const out: { query: string; keys: K[] }[] = [];
  let group: { key: K; term: string }[] = [];
  for (const it of items) {
    const next = [...group, it];
    if (group.length && make(next).length > maxLen) { out.push({ query: make(group), keys: group.map((g) => g.key) }); group = [it]; }
    else group = next;
  }
  if (group.length) out.push({ query: make(group), keys: group.map((g) => g.key) });
  return out;
}
