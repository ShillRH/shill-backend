// Text helpers used by the tracker and the trust system.

/** Does this post mention the token (ticker, contract address, or token page link)? */
export function mentionsToken(text: string, ticker: string, contract: string | null, pageUrl?: string): boolean {
  const t = text.toLowerCase();
  const tick = ticker.toLowerCase();
  // $TICKER as a whole cashtag (not $TICKERS or $TICKER2)
  const cashtag = new RegExp(`\\$${escapeRe(tick)}(?![a-z0-9_])`, "i");
  if (cashtag.test(text)) return true;
  if (contract && t.includes(contract.toLowerCase())) return true;
  if (pageUrl && t.includes(pageUrl.toLowerCase())) return true;
  return false;
}

/** Count real words, excluding the cashtag, contract addresses, URLs and @mentions. */
export function realWordCount(text: string): number {
  return text
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/0x[a-f0-9]{40}/gi, " ")
    .replace(/\$[a-z0-9_]+/gi, " ")
    .replace(/@[a-z0-9_]+/gi, " ")
    .split(/\s+/)
    .filter((w) => /[a-z]{2,}/i.test(w)).length;
}

/** Normalized form used for duplicate detection. */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/0x[a-f0-9]{40}/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Jaccard similarity over word sets, 0..1 */
export function similarity(a: string, b: string): number {
  const A = new Set(normalizeText(a).split(" ").filter(Boolean));
  const B = new Set(normalizeText(b).split(" ").filter(Boolean));
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
