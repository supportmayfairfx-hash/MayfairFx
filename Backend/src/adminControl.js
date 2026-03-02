import crypto from "node:crypto";
import { verifyAuthToken } from "./auth.js";
import { getDbMode, query, readLocalStore, writeLocalStore } from "./db.js";

function parseCookieHeader(header) {
  const out = {};
  const s = typeof header === "string" ? header : "";
  if (!s) return out;
  for (const p of s.split(";")) {
    const idx = p.indexOf("=");
    if (idx <= 0) continue;
    const k = p.slice(0, idx).trim();
    const v = p.slice(idx + 1).trim();
    if (!k) continue;
    out[k] = decodeURIComponent(v);
  }
  return out;
}

function getAllowedAdminEmails() {
  return new Set(
    String(process.env.ADMIN_PANEL_ALLOWED_EMAILS || "")
      .split(",")
      .map((x) => String(x || "").trim().toLowerCase())
      .filter(Boolean)
  );
}

export function getAdminContext(req) {
  const apiKey = String(req.headers["x-admin-api-key"] || "");
  if (process.env.ADMIN_API_KEY && apiKey === process.env.ADMIN_API_KEY) {
    const actorHeader = String(req.headers["x-admin-actor"] || "").trim().toLowerCase();
    return {
      ok: true,
      mode: "api_key",
      actor: actorHeader || "api_key_admin",
      email: actorHeader || null
    };
  }

  try {
    const cookies = req.cookies || parseCookieHeader(req.headers?.cookie);
    const token = cookies?.auth_token;
    if (!token) return { ok: false, reason: "missing admin credentials" };
    const payload = verifyAuthToken(token);
    const email = String(payload?.email || "").trim().toLowerCase();
    const allowed = getAllowedAdminEmails();
    if (!email || !allowed.has(email)) return { ok: false, reason: "forbidden admin user" };
    return { ok: true, mode: "role", actor: email, email };
  } catch {
    return { ok: false, reason: "invalid admin token" };
  }
}

export async function writeAdminAuditEvent(req, admin, action, target = "", meta = null) {
  const actor = String(admin?.actor || "unknown");
  const actorMode = String(admin?.mode || "unknown");
  const safeAction = String(action || "").trim();
  if (!safeAction) return;

  const item = {
    id: crypto.randomUUID(),
    actor,
    actor_mode: actorMode,
    action: safeAction,
    target: String(target || ""),
    meta: meta && typeof meta === "object" ? meta : null,
    ip: String(req.headers["x-forwarded-for"] || req.ip || "").slice(0, 200),
    ua: String(req.headers["user-agent"] || "").slice(0, 300),
    created_at: new Date().toISOString()
  };

  try {
    if (getDbMode() === "local") {
      const store = readLocalStore();
      store.admin_audit = Array.isArray(store.admin_audit) ? store.admin_audit : [];
      store.admin_audit.unshift(item);
      store.admin_audit = store.admin_audit.slice(0, 1200);
      writeLocalStore(store);
      return;
    }
    await query(
      `INSERT INTO admin_audit_events
       (id, actor, actor_mode, action, target, meta, ip, ua, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        item.id,
        item.actor,
        item.actor_mode,
        item.action,
        item.target || null,
        item.meta ? JSON.stringify(item.meta) : null,
        item.ip || null,
        item.ua || null,
        item.created_at
      ]
    );
  } catch {}
}

export async function listAdminAuditEvents(limit = 120) {
  const n = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(500, Math.floor(Number(limit)))) : 120;

  if (getDbMode() === "local") {
    const store = readLocalStore();
    store.admin_audit = Array.isArray(store.admin_audit) ? store.admin_audit : [];
    return store.admin_audit
      .slice()
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, n);
  }

  const r = await query(
    `SELECT id, actor, actor_mode, action, target, meta, ip, ua, created_at
     FROM admin_audit_events
     ORDER BY created_at DESC
     LIMIT $1`,
    [n]
  );
  return r.rows.map((x) => ({
    id: x.id,
    actor: x.actor,
    actor_mode: x.actor_mode,
    action: x.action,
    target: x.target || "",
    meta: x.meta && typeof x.meta === "string" ? JSON.parse(x.meta) : x.meta || null,
    ip: x.ip || "",
    ua: x.ua || "",
    created_at: x.created_at
  }));
}
