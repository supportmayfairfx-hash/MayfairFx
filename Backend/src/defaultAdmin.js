import crypto from "node:crypto";
import { query } from "./db.js";
import { hashPassword } from "./auth.js";

export const DEFAULT_ADMIN_EMAIL = "supporiottradefix@gmail.com";
export const DEFAULT_ADMIN_PASSWORD = "Anon001$";

function isTrue(v) {
  const s = String(v || "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

export function isDefaultAdminEmail(email) {
  return String(email || "").trim().toLowerCase() === DEFAULT_ADMIN_EMAIL;
}

export async function ensureDefaultAdminUser() {
  if (isTrue(process.env.DISABLE_DEFAULT_ADMIN_BOOTSTRAP)) return;

  const email = DEFAULT_ADMIN_EMAIL;
  const firstName = "Support";
  const passwordHash = await hashPassword(DEFAULT_ADMIN_PASSWORD);

  const r = await query("SELECT id FROM users WHERE email = $1 LIMIT 1", [email]);
  const existing = r.rows?.[0] || null;

  if (!existing) {
    await query(
      "INSERT INTO users (id, email, password_hash, first_name) VALUES ($1, $2, $3, $4)",
      [crypto.randomUUID(), email, passwordHash, firstName]
    );
    return;
  }

  // Keep the configured default admin password in sync.
  await query("UPDATE users SET password_hash = $2, first_name = coalesce(first_name, $3) WHERE id = $1", [
    existing.id,
    passwordHash,
    firstName
  ]);
}
