// Turns an X account into a $SHILL shiller. There's no sign-up: the X account is the profile and the
// payout destination (X Money), so the first post of theirs we find (or they submit) creates it.
import { q, one } from "../db.js";

export interface XAuthor { id: string; username: string; followers: number; createdAt: Date }

/** Creates or updates the shiller for this X account. Returns null if the account is banned. */
export async function upsertXShiller(a: XAuthor): Promise<{ id: string } | null> {
  const user = await one<{ id: string; banned: boolean }>(
    `INSERT INTO users (x_user_id, x_handle) VALUES ($1,$2)
     ON CONFLICT (x_user_id) DO UPDATE SET x_handle = EXCLUDED.x_handle RETURNING id, banned`,
    [a.id, a.username]);
  if (!user) throw new Error("user upsert failed");
  if (user.banned) return null;
  await q(
    `INSERT INTO linked_accounts (user_id, platform, handle, external_id, followers, account_created, verified_at)
     VALUES ($1,'x',$2,$3,$4,$5, to_timestamp(0))
     ON CONFLICT (user_id, platform) DO UPDATE SET handle=EXCLUDED.handle, followers=EXCLUDED.followers, account_created=EXCLUDED.account_created`,
    [user.id, a.username, a.id, a.followers, a.createdAt]);
  return { id: user.id };
}
