// Small fetch wrapper with timeouts and readable errors, shared by the adapters.
export async function getJson<T>(url: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal });
    if (r.status === 429) throw new Error(`Rate limited by ${new URL(url).host}`);
    if (!r.ok) throw new Error(`${new URL(url).host} responded ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return (await r.json()) as T;
  } finally {
    clearTimeout(t);
  }
}
export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
