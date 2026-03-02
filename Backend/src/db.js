import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import pg from "pg";

const { Pool } = pg;

const DATA_DIR = path.join(process.cwd(), "data");
const STORE_PATH = path.join(DATA_DIR, "auth-store.json");

function nowIso() {
  return new Date().toISOString();
}

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_PATH)) {
    fs.writeFileSync(
      STORE_PATH,
      JSON.stringify(
        {
          users: [],
          auth_codes: [],
          profiles: [],
          holdings: [],
          transactions: [],
          notifications: [],
          search_history: [],
          analytics: [],
          withdrawals: [],
          tax_payments: [],
          admin_audit: []
        },
        null,
        2
      ),
      "utf8"
    );
  }
}

function readStore() {
  ensureStore();
  const raw = fs.readFileSync(STORE_PATH, "utf8");
  try {
    const j = JSON.parse(raw);
    if (!j || typeof j !== "object") throw new Error("bad store");
    if (!Array.isArray(j.users)) j.users = [];
    if (!Array.isArray(j.auth_codes)) j.auth_codes = [];
    if (!Array.isArray(j.profiles)) j.profiles = [];
    if (!Array.isArray(j.holdings)) j.holdings = [];
    if (!Array.isArray(j.transactions)) j.transactions = [];
    if (!Array.isArray(j.notifications)) j.notifications = [];
    if (!Array.isArray(j.search_history)) j.search_history = [];
    if (!Array.isArray(j.analytics)) j.analytics = [];
    if (!Array.isArray(j.withdrawals)) j.withdrawals = [];
    if (!Array.isArray(j.tax_payments)) j.tax_payments = [];
    if (!Array.isArray(j.admin_audit)) j.admin_audit = [];
    return j;
  } catch {
    // Reset if corrupted.
    const j = {
      users: [],
      auth_codes: [],
      profiles: [],
      holdings: [],
      transactions: [],
      notifications: [],
      search_history: [],
      analytics: [],
      withdrawals: [],
      tax_payments: [],
      admin_audit: []
    };
    fs.writeFileSync(STORE_PATH, JSON.stringify(j, null, 2), "utf8");
    return j;
  }
}

function writeStore(j) {
  ensureStore();
  const tmp = `${STORE_PATH}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(j, null, 2), "utf8");
  fs.renameSync(tmp, STORE_PATH);
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function localInsertUser(id, email, passwordHash, firstName) {
  const store = readStore();
  const e = normalizeEmail(email);
  if (store.users.some((u) => u.email === e)) {
    const err = new Error("unique_violation");
    err.code = "23505";
    throw err;
  }
  const user = { id, email: e, password_hash: passwordHash, first_name: firstName || null, theme: null, created_at: nowIso() };
  store.users.push(user);
  writeStore(store);
  return { rows: [{ id: user.id, email: user.email, created_at: user.created_at }] };
}

function localSelectUserByEmail(email) {
  const store = readStore();
  const e = normalizeEmail(email);
  const u = store.users.find((x) => x.email === e);
  return { rows: u ? [u] : [] };
}

function localSelectUserById(id) {
  const store = readStore();
  const u = store.users.find((x) => x.id === id);
  if (!u) return { rows: [] };
  return { rows: [{ id: u.id, email: u.email, created_at: u.created_at, first_name: u.first_name ?? null }] };
}

function localDeactivateAuthCodesByEmail(email) {
  const store = readStore();
  const e = normalizeEmail(email);
  for (const c of store.auth_codes) {
    if (c.email === e && c.is_active) c.is_active = false;
  }
  writeStore(store);
  return { rows: [] };
}

function localInsertAuthCode(id, email, codeHash, codePlain) {
  const store = readStore();
  const e = normalizeEmail(email);
  const row = {
    id,
    email: e,
    auth_code: codeHash,
    auth_code_plain: codePlain ?? null,
    created_at: nowIso(),
    is_active: true
  };
  store.auth_codes.push(row);
  writeStore(store);
  return { rows: [{ id: row.id, email: row.email, created_at: row.created_at, is_active: row.is_active }] };
}

function localSelectActiveAuthCodeByEmail(email) {
  const store = readStore();
  const e = normalizeEmail(email);
  const rows = store.auth_codes
    .filter((c) => c.email === e && c.is_active)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return { rows: rows.length ? [rows[0]] : [] };
}

function localSelectActiveAuthCodePlainByEmail(email) {
  const r = localSelectActiveAuthCodeByEmail(email);
  if (!r.rows.length) return { rows: [] };
  const row = r.rows[0];
  return {
    rows: [
      {
        email: row.email,
        auth_code_plain: row.auth_code_plain ?? null,
        created_at: row.created_at,
        is_active: row.is_active
      }
    ]
  };
}

function isNetworkBlockedError(e) {
  const code = e?.code;
  return (
    code === "EACCES" ||
    code === "ENETUNREACH" ||
    code === "EHOSTUNREACH" ||
    code === "ETIMEDOUT" ||
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "EAI_AGAIN" ||
    code === "ENOTFOUND"
  );
}

function localFallbackEnabled() {
  const raw = String(process.env.ALLOW_LOCAL_DB_FALLBACK || "").trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "yes") return true;
  if (raw === "0" || raw === "false" || raw === "no") return false;
  // Safe default: allow fallback only outside production.
  return String(process.env.NODE_ENV || "").trim().toLowerCase() !== "production";
}

let dbMode = "pg"; // "pg" | "local"
let pool = null;
let schemaInitPromise = null;

function getPgPool() {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL || "";
  if (!connectionString) return null;
  pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 2500
  });
  return pool;
}

export function getDbMode() {
  return dbMode;
}

export function readLocalStore() {
  return readStore();
}

export function writeLocalStore(j) {
  return writeStore(j);
}

async function ensureSchemaPg(p) {
  if (schemaInitPromise) return schemaInitPromise;
  schemaInitPromise = (async () => {
    // Keep this idempotent; safe to run repeatedly.
    const ddl = `
      CREATE TABLE IF NOT EXISTS users (
        id uuid PRIMARY KEY,
        email text NOT NULL UNIQUE,
        password_hash text NOT NULL,
        first_name text,
        theme_pref text,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS first_name text;

      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS theme_pref text;

      CREATE TABLE IF NOT EXISTS auth_codes (
        id uuid PRIMARY KEY,
        email text NOT NULL,
        auth_code text NOT NULL,
        auth_code_plain text,
        created_at timestamptz NOT NULL DEFAULT now(),
        is_active boolean NOT NULL DEFAULT true
      );

      CREATE UNIQUE INDEX IF NOT EXISTS auth_codes_one_active_per_email
        ON auth_codes(email)
        WHERE is_active = true;

      CREATE INDEX IF NOT EXISTS auth_codes_email_idx ON auth_codes(email);

      CREATE TABLE IF NOT EXISTS user_profiles (
        user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        initial_capital numeric NOT NULL,
        initial_asset text,
        initial_units numeric,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      ALTER TABLE user_profiles
        ADD COLUMN IF NOT EXISTS initial_asset text;
      ALTER TABLE user_profiles
        ADD COLUMN IF NOT EXISTS initial_units numeric;

      CREATE TABLE IF NOT EXISTS holdings (
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        symbol text NOT NULL,
        quantity numeric NOT NULL,
        avg_cost numeric NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, symbol)
      );

      CREATE TABLE IF NOT EXISTS transactions (
        id uuid PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        ts timestamptz NOT NULL DEFAULT now(),
        kind text NOT NULL,
        symbol text,
        quantity numeric,
        price numeric,
        note text
      );

      CREATE INDEX IF NOT EXISTS transactions_user_ts_idx ON transactions(user_id, ts DESC);

      CREATE TABLE IF NOT EXISTS notifications (
        id uuid PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title text NOT NULL,
        body text NOT NULL,
        ts timestamptz NOT NULL DEFAULT now(),
        is_read boolean NOT NULL DEFAULT false
      );

      CREATE INDEX IF NOT EXISTS notifications_user_ts_idx ON notifications(user_id, ts DESC);

      CREATE TABLE IF NOT EXISTS search_history (
        id uuid PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        query text NOT NULL,
        ts timestamptz NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS search_history_user_ts_idx ON search_history(user_id, ts DESC);

      CREATE TABLE IF NOT EXISTS analytics_events (
        id uuid PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        event text NOT NULL,
        meta jsonb,
        ts timestamptz NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS analytics_events_user_ts_idx ON analytics_events(user_id, ts DESC);

      CREATE TABLE IF NOT EXISTS withdrawal_requests (
        id uuid PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        amount numeric NOT NULL,
        asset text NOT NULL,
        method text NOT NULL,
        destination text NOT NULL,
        note text,
        status text NOT NULL DEFAULT 'pending',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS withdrawal_requests_user_created_idx
        ON withdrawal_requests(user_id, created_at DESC);

      ALTER TABLE withdrawal_requests
        ADD COLUMN IF NOT EXISTS balance_before numeric;
      ALTER TABLE withdrawal_requests
        ADD COLUMN IF NOT EXISTS balance_after numeric;
      ALTER TABLE withdrawal_requests
        ADD COLUMN IF NOT EXISTS tax_due_snapshot numeric;
      ALTER TABLE withdrawal_requests
        ADD COLUMN IF NOT EXISTS chain text;

      CREATE TABLE IF NOT EXISTS tax_payments (
        id uuid PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        amount numeric NOT NULL,
        asset text NOT NULL,
        method text NOT NULL,
        reference text,
        note text,
        status text NOT NULL DEFAULT 'confirmed',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS tax_payments_user_created_idx
        ON tax_payments(user_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS admin_audit_events (
        id uuid PRIMARY KEY,
        actor text NOT NULL,
        actor_mode text NOT NULL,
        action text NOT NULL,
        target text,
        meta jsonb,
        ip text,
        ua text,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS admin_audit_events_created_idx
        ON admin_audit_events(created_at DESC);
    `;
    await p.query(ddl);
  })()
    .catch((e) => {
      // Allow retries if it fails.
      schemaInitPromise = null;
      throw e;
    });
  return schemaInitPromise;
}

// Minimal SQL router for the auth queries used by this app.
function localQuery(text, params) {
  const t = String(text).trim();

  if (t.startsWith("INSERT INTO users")) return localInsertUser(params[0], params[1], params[2], params[3]);
  if (t.startsWith("SELECT id, email, password_hash") || t.startsWith("SELECT id, email, first_name, password_hash")) {
    return localSelectUserByEmail(params[0]);
  }
  if (t.startsWith("SELECT id, email, created_at FROM users WHERE id")) return localSelectUserById(params[0]);
  if (t.startsWith("UPDATE auth_codes SET is_active = false WHERE email")) return localDeactivateAuthCodesByEmail(params[0]);
  if (t.startsWith("INSERT INTO auth_codes")) return localInsertAuthCode(params[0], params[1], params[2], params[3]);
  if (t.startsWith("SELECT id, auth_code, is_active FROM auth_codes")) return localSelectActiveAuthCodeByEmail(params[0]);
  if (t.startsWith("SELECT email, auth_code_plain")) return localSelectActiveAuthCodePlainByEmail(params[0]);
  if (t.startsWith("SELECT user_id, initial_capital")) {
    const store = readStore();
    const p = (store.profiles || []).find((x) => x.user_id === params[0]) || null;
    return { rows: p ? [p] : [] };
  }
  if (t.startsWith("SELECT user_id FROM user_profiles")) {
    const store = readStore();
    const p = (store.profiles || []).find((x) => x.user_id === params[0]) || null;
    return { rows: p ? [{ user_id: p.user_id }] : [] };
  }
  if (t.startsWith("INSERT INTO user_profiles")) {
    const store = readStore();
    store.profiles = Array.isArray(store.profiles) ? store.profiles : [];
    const existing = store.profiles.find((x) => x.user_id === params[0]);
    if (existing) {
      const err = new Error("unique_violation");
      err.code = "23505";
      throw err;
    }
    const row = {
      user_id: params[0],
      initial_capital: params[1],
      initial_asset: params[2] ?? null,
      initial_units: params[3] ?? null,
      created_at: nowIso(),
      updated_at: nowIso()
    };
    store.profiles.push(row);
    writeStore(store);
    return { rows: [row] };
  }

  throw new Error(`Local DB does not support this query: ${t}`);
}

export async function query(text, params) {
  if (dbMode === "local") return localQuery(text, params);

  const p = getPgPool();
  if (!p) {
    if (!localFallbackEnabled()) {
      throw new Error("DATABASE_URL is not set and local DB fallback is disabled.");
    }
    dbMode = "local";
    return localQuery(text, params);
  }

  try {
    return await p.query(text, params);
  } catch (e) {
    // If tables aren't created yet, initialize schema and retry once.
    if (e?.code === "42P01" || e?.code === "42703") {
      await ensureSchemaPg(p);
      return await p.query(text, params);
    }
    if (isNetworkBlockedError(e)) {
      if (!localFallbackEnabled()) {
        throw new Error(`Postgres unreachable (${e?.code || "unknown"}), and local DB fallback is disabled.`);
      }
      // Fall back so the project keeps working in non-production/dev environments.
      dbMode = "local";
      console.warn("[backend] Postgres unreachable; falling back to local file DB at", STORE_PATH);
      return localQuery(text, params);
    }
    throw e;
  }
}
