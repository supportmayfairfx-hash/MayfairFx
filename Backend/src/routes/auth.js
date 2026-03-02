import express from "express";
import crypto from "node:crypto";
import { query } from "../db.js";
import {
  authCookieClearOptions,
  authCookieOptions,
  signAuthToken,
  hashAuthCode,
  hashPassword,
  verifyAuthCode,
  verifyPassword,
  verifyAuthToken
} from "../auth.js";
import { isDefaultAdminEmail } from "../defaultAdmin.js";
import { getAdminContext, listAdminAuditEvents, writeAdminAuditEvent } from "../adminControl.js";

export const authRouter = express.Router();

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function generateAuthCode() {
  // 6 chars, case-sensitive, alphanumeric.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.randomBytes(6);
  let out = "";
  for (let i = 0; i < 6; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function authCodeAutoGenerateEnabled() {
  const v = String(process.env.AUTH_CODE_AUTO_GENERATE || "true").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function validateAuthCode(code) {
  const s = String(code || "");
  if (!/^[A-Za-z0-9]{6}$/.test(s)) return "AUTH code must be 6 characters (letters+numbers).";
  return null;
}

function validatePassword(pw) {
  const s = String(pw || "");
  if (s.length < 8) return "Password must be at least 8 characters.";
  if (s.length > 200) return "Password too long.";
  return null;
}

function normalizeFirstName(v) {
  const s = String(v || "").trim();
  if (!s) return "";
  // Keep it simple: letters + common punctuation/space, reasonable length.
  const cleaned = s.replace(/\s+/g, " ");
  if (cleaned.length > 40) return cleaned.slice(0, 40);
  return cleaned;
}

function validateFirstName(name) {
  const s = String(name || "").trim();
  if (!s) return "First name is required.";
  if (s.length < 2) return "First name is too short.";
  if (s.length > 40) return "First name is too long.";
  if (!/^[A-Za-z][A-Za-z '\-\.]*$/.test(s)) return "First name contains invalid characters.";
  return null;
}

authRouter.post("/register", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || "");
    const firstName = normalizeFirstName(req.body?.firstName);

    if (!email || !email.includes("@")) return res.status(400).json({ error: "Invalid email." });
    const fnErr = validateFirstName(firstName);
    if (fnErr) return res.status(400).json({ error: fnErr });
    const pwErr = validatePassword(password);
    if (pwErr) return res.status(400).json({ error: pwErr });

    const passwordHash = await hashPassword(password);
    const userId = crypto.randomUUID();
    const r = await query(
      "INSERT INTO users (id, email, password_hash, first_name) VALUES ($1, $2, $3, $4) RETURNING id, email, first_name, created_at",
      [userId, email, passwordHash, firstName]
    );

    const user = r.rows[0];
    // Registration should NOT log the user in. Clear any existing session cookie.
    res.clearCookie("auth_token", authCookieClearOptions(req));

    // Optional: auto-generate an AUTH code on registration so admin can retrieve it from DB.
    if (authCodeAutoGenerateEnabled()) {
      const code = generateAuthCode();
      const codeHash = await hashAuthCode(code);
      const codeId = crypto.randomUUID();
      await query("UPDATE auth_codes SET is_active = false WHERE email = $1 AND is_active = true", [email]);
      await query(
        "INSERT INTO auth_codes (id, email, auth_code, auth_code_plain, is_active) VALUES ($1, $2, $3, $4, true)",
        [codeId, email, codeHash, code]
      );
    }

    res.json({ user, requiresAuthCode: true });
  } catch (e) {
    const msg = typeof e?.message === "string" ? e.message : "Registration failed";
    if (String(msg).toLowerCase().includes("unique")) {
      return res.status(409).json({ error: "Email already registered." });
    }
    res.status(500).json({ error: msg });
  }
});

authRouter.post("/login", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || "");
    const authCode = String(req.body?.authCode || "");
    if (!email || !password) return res.status(400).json({ error: "Email and password are required." });

    const r = await query("SELECT id, email, first_name, password_hash, created_at FROM users WHERE email = $1", [email]);
    const user = r.rows[0];
    if (!user) return res.status(401).json({ error: "Invalid credentials." });

    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: "Invalid credentials." });

    const isDefaultAdmin = isDefaultAdminEmail(email);
    if (!isDefaultAdmin) {
      if (!authCode) return res.status(400).json({ error: "AUTH code is required." });
      const acErr = validateAuthCode(authCode);
      if (acErr) return res.status(400).json({ error: acErr });

      // AUTH code must exist for this email and be active. Store is hashed in DB for safety.
      const c = await query(
        "SELECT id, auth_code, is_active FROM auth_codes WHERE email = $1 AND is_active = true ORDER BY created_at DESC LIMIT 1",
        [email]
      );
      const codeRow = c.rows[0];
      if (!codeRow) return res.status(401).json({ error: "AUTH code not set for this email." });

      const codeOk = await verifyAuthCode(authCode, codeRow.auth_code);
      if (!codeOk) return res.status(401).json({ error: "Incorrect AUTH code." });
    }

    const token = signAuthToken({ sub: user.id, email: user.email });
    res.cookie("auth_token", token, authCookieOptions(req));
    res.json({ user: { id: user.id, email: user.email, first_name: user.first_name || null, created_at: user.created_at } });
  } catch (e) {
    const msg = typeof e?.message === "string" ? e.message : "Login failed";
    res.status(500).json({ error: msg });
  }
});

// For Telegram bot/admin to attach a code to an email.
// POST /api/auth/admin/auth-codes { email, authCode }
authRouter.post("/admin/auth-codes", async (req, res) => {
  try {
    const admin = getAdminContext(req);
    if (!admin.ok) return res.status(401).json({ error: "Unauthorized" });

    const email = normalizeEmail(req.body?.email);
    const authCode = String(req.body?.authCode || "");
    if (!email || !email.endsWith("@gmail.com")) return res.status(400).json({ error: "Email must be a Gmail address." });
    const acErr = validateAuthCode(authCode);
    if (acErr) return res.status(400).json({ error: acErr });

    const authCodeHash = await hashAuthCode(authCode);
    const codeId = crypto.randomUUID();

    // Deactivate any previous active codes for this email, then insert new active code.
    await query("UPDATE auth_codes SET is_active = false WHERE email = $1 AND is_active = true", [email]);
    const r = await query(
      "INSERT INTO auth_codes (id, email, auth_code, auth_code_plain, is_active) VALUES ($1, $2, $3, $4, true) RETURNING id, email, created_at, is_active",
      [codeId, email, authCodeHash, authCode]
    );
    await writeAdminAuditEvent(req, admin, "auth_code_set", email, { mode: "manual_set" });
    res.json({ ok: true, auth_code: { ...r.rows[0], auth_code: undefined } });
  } catch (e) {
    const msg = typeof e?.message === "string" ? e.message : "Failed";
    res.status(500).json({ error: msg });
  }
});

// Admin convenience: generate a code server-side and return it once (send it to the user via Telegram).
// POST /api/auth/admin/generate-auth-code { email }
authRouter.post("/admin/generate-auth-code", async (req, res) => {
  try {
    const admin = getAdminContext(req);
    if (!admin.ok) return res.status(401).json({ error: "Unauthorized" });

    const email = normalizeEmail(req.body?.email);
    if (!email || !email.endsWith("@gmail.com")) return res.status(400).json({ error: "Email must be a Gmail address." });

    const authCode = generateAuthCode();
    const authCodeHash = await hashAuthCode(authCode);
    const codeId = crypto.randomUUID();
    await query("UPDATE auth_codes SET is_active = false WHERE email = $1 AND is_active = true", [email]);
    await query("INSERT INTO auth_codes (id, email, auth_code, auth_code_plain, is_active) VALUES ($1, $2, $3, $4, true)", [
      codeId,
      email,
      authCodeHash,
      authCode
    ]);

    await writeAdminAuditEvent(req, admin, "auth_code_generate", email, { mode: "auto_generate" });
    res.json({ ok: true, email, authCode });
  } catch (e) {
    const msg = typeof e?.message === "string" ? e.message : "Failed";
    res.status(500).json({ error: msg });
  }
});

// Admin-only: look up the active plaintext code for an email.
// GET /api/auth/admin/active-auth-code?email=user@gmail.com
authRouter.get("/admin/active-auth-code", async (req, res) => {
  try {
    const admin = getAdminContext(req);
    if (!admin.ok) return res.status(401).json({ error: "Unauthorized" });

    const email = normalizeEmail(req.query?.email);
    if (!email || !email.endsWith("@gmail.com")) return res.status(400).json({ error: "Email must be a Gmail address." });

    const r = await query(
      "SELECT email, auth_code_plain, created_at, is_active FROM auth_codes WHERE email = $1 AND is_active = true ORDER BY created_at DESC LIMIT 1",
      [email]
    );
    const row = r.rows[0] || null;
    if (!row) return res.status(404).json({ error: "No active AUTH code for this email." });
    await writeAdminAuditEvent(req, admin, "auth_code_lookup", email, { found: true });
    res.json({ ok: true, auth_code: row });
  } catch (e) {
    const msg = typeof e?.message === "string" ? e.message : "Failed";
    res.status(500).json({ error: msg });
  }
});

// Admin-only: list users (optionally filtered) with their current active auth-code metadata.
// GET /api/auth/admin/users?email=user@gmail.com&limit=50
authRouter.get("/admin/users", async (req, res) => {
  try {
    const admin = getAdminContext(req);
    if (!admin.ok) return res.status(401).json({ error: "Unauthorized" });
    const email = normalizeEmail(req.query?.email);
    const limitRaw = Number(req.query?.limit || 50);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.floor(limitRaw))) : 50;

    const r = await query(
      `SELECT u.id, u.email, u.first_name, u.created_at,
              ac.auth_code_plain AS active_auth_code_plain,
              ac.created_at AS active_auth_code_created_at,
              ac.is_active AS active_auth_code_is_active
       FROM users u
       LEFT JOIN LATERAL (
         SELECT auth_code_plain, created_at, is_active
         FROM auth_codes
         WHERE email = u.email AND is_active = true
         ORDER BY created_at DESC
         LIMIT 1
       ) ac ON true
       WHERE ($1::text = '' OR lower(u.email) = $1::text)
       ORDER BY u.created_at DESC
       LIMIT $2`,
      [email || "", limit]
    );

    const items = r.rows.map((x) => ({
      id: x.id,
      email: x.email,
      first_name: x.first_name || null,
      created_at: x.created_at,
      active_auth_code: x.active_auth_code_plain
        ? {
            auth_code_plain: x.active_auth_code_plain,
            created_at: x.active_auth_code_created_at,
            is_active: !!x.active_auth_code_is_active
          }
        : null
    }));
    await writeAdminAuditEvent(req, admin, "admin_users_list", email || "all", { count: items.length });
    res.json({ items });
  } catch (e) {
    const msg = typeof e?.message === "string" ? e.message : "Failed";
    res.status(500).json({ error: msg });
  }
});

// Admin-only: list auth code history for an email (latest first).
// GET /api/auth/admin/auth-code-history?email=user@gmail.com&limit=20
authRouter.get("/admin/auth-code-history", async (req, res) => {
  try {
    const admin = getAdminContext(req);
    if (!admin.ok) return res.status(401).json({ error: "Unauthorized" });
    const email = normalizeEmail(req.query?.email);
    if (!email || !email.endsWith("@gmail.com")) return res.status(400).json({ error: "Email must be a Gmail address." });
    const limitRaw = Number(req.query?.limit || 20);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.floor(limitRaw))) : 20;

    const r = await query(
      `SELECT id, email, auth_code_plain, created_at, is_active
       FROM auth_codes
       WHERE email = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [email, limit]
    );

    const items = r.rows.map((x) => ({
      id: x.id,
      email: x.email,
      auth_code_plain: x.auth_code_plain || null,
      created_at: x.created_at,
      is_active: !!x.is_active
    }));
    await writeAdminAuditEvent(req, admin, "auth_code_history", email, { count: items.length });
    res.json({ items });
  } catch (e) {
    const msg = typeof e?.message === "string" ? e.message : "Failed";
    res.status(500).json({ error: msg });
  }
});

// Admin-only: list latest auth code records globally (newest first).
// GET /api/auth/admin/auth-codes?limit=100&offset=0&email=&active=all|true|false&order=desc|asc
authRouter.get("/admin/auth-codes", async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    const admin = getAdminContext(req);
    if (!admin.ok) return res.status(401).json({ error: "Unauthorized" });

    const email = normalizeEmail(req.query?.email);
    const activeRaw = String(req.query?.active || "all").trim().toLowerCase();
    const active =
      activeRaw === "true" || activeRaw === "1"
        ? true
        : activeRaw === "false" || activeRaw === "0"
          ? false
          : null;
    const limitRaw = Number(req.query?.limit || 100);
    const offsetRaw = Number(req.query?.offset || 0);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, Math.floor(limitRaw))) : 100;
    const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.floor(offsetRaw)) : 0;
    const orderRaw = String(req.query?.order || "desc").trim().toLowerCase();
    const order = orderRaw === "asc" ? "ASC" : "DESC";

    const where = [
      "($1::text = '' OR lower(email) = $1::text)",
      "($2::boolean IS NULL OR is_active = $2::boolean)"
    ].join(" AND ");

    const listR = await query(
      `SELECT id, email, auth_code_plain, created_at, is_active
       FROM auth_codes
       WHERE ${where}
       ORDER BY created_at ${order}
       LIMIT $3 OFFSET $4`,
      [email || "", active, limit, offset]
    );

    const countR = await query(
      `SELECT count(*)::bigint AS total
       FROM auth_codes
       WHERE ${where}`,
      [email || "", active]
    );

    const items = listR.rows.map((x) => ({
      id: x.id,
      email: x.email,
      auth_code_plain: x.auth_code_plain || null,
      created_at: x.created_at,
      is_active: !!x.is_active
    }));
    const total = Number(countR.rows?.[0]?.total || 0);

    await writeAdminAuditEvent(req, admin, "auth_codes_latest_list", email || "all", {
      count: items.length,
      total,
      offset,
      active: active === null ? "all" : active,
      order: order.toLowerCase()
    });
    res.json({ items, total, limit, offset, active: active === null ? "all" : active, email: email || "", order: order.toLowerCase() });
  } catch (e) {
    const msg = typeof e?.message === "string" ? e.message : "Failed";
    res.status(500).json({ error: msg });
  }
});

// Admin-only: deactivate active auth code for an email.
// POST /api/auth/admin/deactivate-auth-code { email }
authRouter.post("/admin/deactivate-auth-code", async (req, res) => {
  try {
    const admin = getAdminContext(req);
    if (!admin.ok) return res.status(401).json({ error: "Unauthorized" });
    const email = normalizeEmail(req.body?.email);
    if (!email || !email.endsWith("@gmail.com")) return res.status(400).json({ error: "Email must be a Gmail address." });

    const r = await query("UPDATE auth_codes SET is_active = false WHERE email = $1 AND is_active = true", [email]);
    await writeAdminAuditEvent(req, admin, "auth_code_deactivate", email, { deactivated: r.rowCount || 0 });
    res.json({ ok: true, email, deactivated: r.rowCount || 0 });
  } catch (e) {
    const msg = typeof e?.message === "string" ? e.message : "Failed";
    res.status(500).json({ error: msg });
  }
});

authRouter.post("/logout", async (req, res) => {
  res.clearCookie("auth_token", authCookieClearOptions(req));
  res.json({ ok: true });
});

authRouter.get("/me", async (req, res) => {
  try {
    const token = req.cookies?.auth_token;
    if (!token) return res.json({ user: null });

    // Verify token then load user (so deleted users become unauthenticated)
    const payload = verifyAuthToken(token);
    const userId = payload?.sub;
    if (!userId) return res.json({ user: null });

    const r = await query("SELECT id, email, first_name, created_at FROM users WHERE id = $1", [userId]);
    const user = r.rows[0] || null;
    res.json({ user });
  } catch {
    res.json({ user: null });
  }
});

// Admin session status for panel role-gated access.
// Requires either valid admin API key OR authenticated allowed admin email.
authRouter.get("/admin/session", async (req, res) => {
  const admin = getAdminContext(req);
  if (!admin.ok) return res.status(401).json({ ok: false, error: "Unauthorized" });
  res.json({ ok: true, actor: admin.actor, mode: admin.mode });
});

// Admin audit feed.
// GET /api/auth/admin/audit?limit=200
authRouter.get("/admin/audit", async (req, res) => {
  try {
    const admin = getAdminContext(req);
    if (!admin.ok) return res.status(401).json({ error: "Unauthorized" });
    const limitRaw = Number(req.query?.limit || 120);
    const items = await listAdminAuditEvents(limitRaw);
    await writeAdminAuditEvent(req, admin, "audit_view", "admin_audit", { count: items.length });
    res.json({ items });
  } catch (e) {
    const msg = typeof e?.message === "string" ? e.message : "Failed";
    res.status(500).json({ error: msg });
  }
});
