import express from "express";
import crypto from "node:crypto";
import { query } from "../db.js";
import { authCookieOptions, signAuthToken, hashAuthCode, hashPassword, verifyAuthCode, verifyPassword, verifyAuthToken } from "../auth.js";

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
  const v = String(process.env.AUTH_CODE_AUTO_GENERATE || "false").trim().toLowerCase();
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
    res.clearCookie("auth_token", { path: "/" });

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
    if (!authCode) return res.status(400).json({ error: "AUTH code is required." });
    const acErr = validateAuthCode(authCode);
    if (acErr) return res.status(400).json({ error: acErr });

    const r = await query("SELECT id, email, first_name, password_hash, created_at FROM users WHERE email = $1", [email]);
    const user = r.rows[0];
    if (!user) return res.status(401).json({ error: "Invalid credentials." });

    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: "Invalid credentials." });

    // AUTH code must exist for this email and be active. Store is hashed in DB for safety.
    const c = await query(
      "SELECT id, auth_code, is_active FROM auth_codes WHERE email = $1 AND is_active = true ORDER BY created_at DESC LIMIT 1",
      [email]
    );
    const codeRow = c.rows[0];
    if (!codeRow) return res.status(401).json({ error: "AUTH code not set for this email." });

    const codeOk = await verifyAuthCode(authCode, codeRow.auth_code);
    if (!codeOk) return res.status(401).json({ error: "Incorrect AUTH code." });

    // Code is linked to the email and remains active for future logins
    // until the admin replaces it (or deactivates it).

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
    const key = String(req.headers["x-admin-api-key"] || "");
    if (!process.env.ADMIN_API_KEY || key !== process.env.ADMIN_API_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }

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
    const key = String(req.headers["x-admin-api-key"] || "");
    if (!process.env.ADMIN_API_KEY || key !== process.env.ADMIN_API_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }

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
    const key = String(req.headers["x-admin-api-key"] || "");
    if (!process.env.ADMIN_API_KEY || key !== process.env.ADMIN_API_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const email = normalizeEmail(req.query?.email);
    if (!email || !email.endsWith("@gmail.com")) return res.status(400).json({ error: "Email must be a Gmail address." });

    const r = await query(
      "SELECT email, auth_code_plain, created_at, is_active FROM auth_codes WHERE email = $1 AND is_active = true ORDER BY created_at DESC LIMIT 1",
      [email]
    );
    const row = r.rows[0] || null;
    if (!row) return res.status(404).json({ error: "No active AUTH code for this email." });
    res.json({ ok: true, auth_code: row });
  } catch (e) {
    const msg = typeof e?.message === "string" ? e.message : "Failed";
    res.status(500).json({ error: msg });
  }
});

authRouter.post("/logout", async (req, res) => {
  res.clearCookie("auth_token", { path: "/" });
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
