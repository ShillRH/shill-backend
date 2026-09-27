// Simple in-memory rate limiter (per IP). Good enough for one API instance;
// use Redis or your host's rate limiting if you run several.
import type { IncomingMessage } from "node:http";
import { HttpError } from "../http/router.js";

const hits = new Map<string, number[]>();

export function clientIp(req: IncomingMessage): string {
  const fwd = String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim();
  return fwd || req.socket.remoteAddress || "unknown";
}

/** Allows `max` requests per `windowMs` per IP for a given bucket name. */
export function rateLimit(req: IncomingMessage, bucket: string, max: number, windowMs: number, message: string) {
  const key = `${bucket}:${clientIp(req)}`;
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) throw new HttpError(429, message);
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 50_000) hits.clear(); // crude memory guard
}
