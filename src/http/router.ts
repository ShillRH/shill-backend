// A tiny router on top of node:http. No framework needed for an API this size.
import type { IncomingMessage, ServerResponse } from "node:http";
import { config } from "../config.js";

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  cookies: Record<string, string>;
}
export type Handler = (ctx: Ctx) => Promise<unknown> | unknown;

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

interface Route { method: string; re: RegExp; keys: string[]; handler: Handler }
const routes: Route[] = [];

export function route(method: string, path: string, handler: Handler) {
  const keys: string[] = [];
  const re = new RegExp("^" + path.replace(/\/:([a-zA-Z_]+)/g, (_, k) => { keys.push(k); return "/([^/]+)"; }) + "/?$");
  routes.push({ method, re, keys, handler });
}

const MAX_BODY = 8 * 1024 * 1024; // images (up to 5 MB) arrive as base64 data URLs, about a third larger

async function readBody(req: IncomingMessage): Promise<unknown> {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "Request is too large. Images must be 5 MB or smaller.");
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return undefined;
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new HttpError(400, "Body must be valid JSON."); }
}

function parseCookies(h?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (h ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cors(req: IncomingMessage, res: ServerResponse) {
  const origin = req.headers.origin;
  if (origin && origin === config.frontendOrigin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  }
}

export function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}) {
  if (res.headersSent) return;
  if (typeof body === "string" || Buffer.isBuffer(body)) {
    res.writeHead(status, headers);
    res.end(body);
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

export async function dispatch(req: IncomingMessage, res: ServerResponse) {
  cors(req, res);
  if (req.method === "OPTIONS") return send(res, 204, "");
  const url = new URL(req.url ?? "/", "http://x");
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.re.exec(url.pathname);
    if (!m) continue;
    const params: Record<string, string> = {};
    r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)));
    try {
      const body = await readBody(req);
      const out = await r.handler({ req, res, params, query: url.searchParams, body, cookies: parseCookies(req.headers.cookie) });
      if (!res.headersSent) send(res, 200, out ?? { ok: true });
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      console.error(e);
      return send(res, 500, { error: "Something went wrong on our side. Try again in a moment." });
    }
    return;
  }
  send(res, 404, { error: "Not found" });
}

/** Validation helpers */
export function str(v: unknown, field: string, max = 500): string {
  if (typeof v !== "string") throw new HttpError(400, `${field} is required.`);
  const s = v.trim();
  if (s.length > max) throw new HttpError(400, `${field} must be ${max} characters or fewer.`);
  return s;
}
export function isAddress(v: unknown): v is `0x${string}` {
  return typeof v === "string" && /^0x[a-fA-F0-9]{40}$/.test(v);
}
