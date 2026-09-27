// Encryption for launch-wallet private keys, and helpers for sessions and codes.
// AES-256-GCM with a 32-byte master key. In production, load WALLET_MASTER_KEY from a
// secrets manager / KMS and restrict who can read it. Never log decrypted keys.
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

function keyFromHex(hex: string): Buffer {
  const k = Buffer.from(hex.replace(/^0x/, ""), "hex");
  if (k.length !== 32) throw new Error("WALLET_MASTER_KEY must be 32 bytes (64 hex characters)");
  return k;
}

/** Returns "v1.<iv>.<tag>.<ciphertext>" (base64url parts). */
export function encryptSecret(plain: string, masterKeyHex: string): string {
  const key = keyFromHex(masterKeyHex);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(".");
}

export function decryptSecret(payload: string, masterKeyHex: string): string {
  const [v, ivB, tagB, ctB] = payload.split(".");
  if (v !== "v1" || !ivB || !tagB || !ctB) throw new Error("Unrecognized secret format");
  const decipher = createDecipheriv("aes-256-gcm", keyFromHex(masterKeyHex), Buffer.from(ivB, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ctB, "base64url")), decipher.final()]).toString("utf8");
}

/** Signed, tamper-proof token for sessions: base64url(json).signature */
export function sign(data: object, secret: string): string {
  const body = Buffer.from(JSON.stringify(data)).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}
export function verify<T>(token: string, secret: string): T | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", secret).update(body).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try { return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T; } catch { return null; }
}

/** Short human-friendly verification code, e.g. SHILL-7KQ2-M9XD */
export function verificationCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
  const b = randomBytes(8);
  let s = "";
  for (let i = 0; i < 8; i++) s += alphabet[b[i]! % alphabet.length];
  return `SHILL-${s.slice(0, 4)}-${s.slice(4)}`;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
