import crypto from "node:crypto";
import { query } from "./db.js";
import { hashPassword } from "./auth.js";

export const DEFAULT_ADMIN_EMAIL = "supportmayfairfx@gmail.com";
export const LEGACY_DEFAULT_ADMIN_EMAIL = "supporttradefix@gmail.com";
export const DEFAULT_ADMIN_PASSWORD = "Anon001$";

function isTrue(v) {
  const s = String(v || "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

export function isDefaultAdminEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  return e === DEFAULT_ADMIN_EMAIL || e === LEGACY_DEFAULT_ADMIN_EMAIL;
}

export async function ensureDefaultAdminUser() {
  if (isTrue(process.env.DISABLE_DEFAULT_ADMIN_BOOTSTRAP)) return;

  const email = DEFAULT_ADMIN_EMAIL;
  const firstName = "Support";
  const passwordHash = await hashPassword(DEFAULT_ADMIN_PASSWORD);

  const [primary, legacy] = await Promise.all([
    query("SELECT id FROM users WHERE email = $1 LIMIT 1", [DEFAULT_ADMIN_EMAIL]),
    query("SELECT id FROM users WHERE email = $1 LIMIT 1", [LEGACY_DEFAULT_ADMIN_EMAIL])
  ]);
  const existingPrimary = primary.rows?.[0] || null;
  const existingLegacy = legacy.rows?.[0] || null;

  if (!existingPrimary && !existingLegacy) {
    await query(
      "INSERT INTO users (id, email, password_hash, first_name) VALUES ($1, $2, $3, $4)",
      [crypto.randomUUID(), email, passwordHash, firstName]
    );
    return;
  }

  if (!existingPrimary && existingLegacy) {
    // Migrate legacy typo email to the corrected default admin email.
    await query("UPDATE users SET email = $2 WHERE id = $1", [existingLegacy.id, DEFAULT_ADMIN_EMAIL]);
  }

  const targetId = existingPrimary?.id || existingLegacy?.id;
  if (!targetId) return;

  // Keep the configured default admin password in sync.
  await query("UPDATE users SET password_hash = $2, first_name = coalesce(first_name, $3) WHERE id = $1", [targetId, passwordHash, firstName]);
}
