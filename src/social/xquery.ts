// Builds X search queries limited to linked authors, split to fit the query length limit.
const MAX_QUERY = Number(process.env.X_QUERY_MAX_LEN ?? 512);

/** Splits `from:` filters into as few queries as fit X's query length limit. */
export function buildQueries(base: string, authors: string[], maxLen = MAX_QUERY): string[] {
  if (!authors.length) return [];
  const out: string[] = [];
  let group: string[] = [];
  const make = (g: string[]) => `${base} (${g.map((a) => `from:${a}`).join(" OR ")})`;
  for (const a of authors) {
    const next = [...group, a];
    if (group.length && make(next).length > maxLen) { out.push(make(group)); group = [a]; }
    else group = next;
  }
  if (group.length) out.push(make(group));
  return out;
}
