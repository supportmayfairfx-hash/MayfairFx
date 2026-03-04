import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendDir = path.resolve(__dirname, "..");
const storePath = path.join(backendDir, "data", "auth-store.json");

const port = 8790;
const base = `http://localhost:${port}`;
const adminKey = "hard-test-key";
const testEmail = `taxhard_${Date.now()}@example.com`;
const testPassword = "Passw0rd!234";

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

function almostEq(a, b, eps = 1e-6) {
  return Math.abs(Number(a) - Number(b)) <= eps;
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function requestJson(url, { method = "GET", headers = {}, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      Accept: "application/json",
      ...(body != null ? { "Content-Type": "application/json" } : {}),
      ...headers
    },
    body: body != null ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  return {
    ok: res.ok,
    status: res.status,
    data,
    setCookie: res.headers.get("set-cookie") || ""
  };
}

function authTokenCookieFromSetCookie(setCookie) {
  const m = String(setCookie || "").match(/auth_token=([^;]+)/i);
  if (!m) return "";
  return `auth_token=${m[1]}`;
}

async function waitForHealth(baseUrl, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await requestJson(`${baseUrl}/health`);
      if (r.ok && r.data?.ok === true) return;
    } catch {}
    await sleep(500);
  }
  throw new Error(`Backend did not become healthy at ${baseUrl}`);
}

async function seedProfileLocal(userId) {
  let raw = "{}";
  try {
    raw = await fs.readFile(storePath, "utf8");
  } catch {}
  const store = JSON.parse(raw || "{}");
  store.profiles = Array.isArray(store.profiles) ? store.profiles : [];

  const nowIso = new Date().toISOString();
  const idx = store.profiles.findIndex((p) => p?.user_id === userId);
  const row = {
    user_id: userId,
    initial_capital: 1000,
    initial_asset: "GBP",
    initial_units: null,
    created_at: idx >= 0 ? store.profiles[idx].created_at || nowIso : nowIso,
    updated_at: nowIso
  };
  if (idx >= 0) store.profiles[idx] = { ...(store.profiles[idx] || {}), ...row };
  else store.profiles.push(row);

  await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf8");
}

async function seedProfileDb(cookie, adminHeaders) {
  const createDeposit = await requestJson(`${base}/api/deposits`, {
    method: "POST",
    headers: { Cookie: cookie },
    body: {
      amount: 1000,
      asset: "GBP",
      method: "Bank Transfer",
      note: "seed_profile_for_tax_tests"
    }
  });
  assert(createDeposit.ok, `Failed to create deposit seed (${createDeposit.status})`);
  const depositId = createDeposit.data?.request?.id;
  assert(depositId, "Missing deposit id for profile seed");

  const confirmDeposit = await requestJson(`${base}/api/admin/deposits/${encodeURIComponent(depositId)}`, {
    method: "PUT",
    headers: adminHeaders,
    body: { status: "confirmed", note: "package=daily-1000" }
  });
  assert(confirmDeposit.ok, `Failed to confirm deposit seed (${confirmDeposit.status})`);
}

async function run() {
  const proc = spawn("node", ["src/index.js"], {
    cwd: backendDir,
    stdio: "ignore",
    env: {
      ...process.env,
      PORT: String(port),
      ADMIN_API_KEY: adminKey,
      JWT_SECRET: "hard-test-jwt",
      AUTH_COOKIE_SECURE: "false",
      AUTH_COOKIE_SAMESITE: "lax"
    }
  });

  try {
    await waitForHealth(base);

    const status = await requestJson(`${base}/api/auth/status`);
    assert(status.ok, "Failed to read auth status");
    const dbMode = String(status.data?.dbMode || "unknown");

    const register = await requestJson(`${base}/api/auth/register`, {
      method: "POST",
      body: { email: testEmail, password: testPassword, firstName: "Tax" }
    });
    assert(register.ok, `Register failed (${register.status})`);

    const login = await requestJson(`${base}/api/auth/login`, {
      method: "POST",
      body: { email: testEmail, password: testPassword }
    });
    assert(login.ok, `Login failed (${login.status})`);
    const userId = String(login.data?.user?.id || "");
    assert(userId, "Login returned no user id");

    const cookie = authTokenCookieFromSetCookie(login.setCookie);
    assert(cookie, "Login did not return auth cookie");
    const adminHeaders = { "x-admin-api-key": adminKey, "x-admin-actor": "qa-bot@local" };

    if (dbMode === "local") await seedProfileLocal(userId);
    else await seedProfileDb(cookie, adminHeaders);

    const set500 = await requestJson(`${base}/api/admin/tax-balances`, {
      method: "POST",
      headers: adminHeaders,
      body: { email: testEmail, asset: "GBP", remaining: 500, note: "hard_case_seed_500" }
    });
    assert(set500.ok, `Set tax balance failed (${set500.status})`);
    assert(almostEq(set500.data?.summary?.tax_remaining, 500), "Expected initial tax remaining 500");

    const pending = await requestJson(`${base}/api/admin/tax-payments`, {
      method: "POST",
      headers: adminHeaders,
      body: { email: testEmail, amount: 500, asset: "GBP", method: "Manual Entry", status: "pending", note: "pending should not clear" }
    });
    assert(pending.ok, `Create pending tax payment failed (${pending.status})`);
    assert(String(pending.data?.payment?.status || "") === "pending", "Expected pending payment status");
    const pendingId = String(pending.data?.payment?.id || "");
    assert(pendingId, "Pending payment id missing");

    const userTaxAfterPending = await requestJson(`${base}/api/withdrawals/tax/me`, {
      headers: { Cookie: cookie }
    });
    assert(userTaxAfterPending.ok, `Tax summary after pending failed (${userTaxAfterPending.status})`);
    assert(almostEq(userTaxAfterPending.data?.summary?.tax_remaining, 500), "Pending payment incorrectly changed tax_remaining");

    const confirmed = await requestJson(`${base}/api/admin/tax-payments/${encodeURIComponent(pendingId)}`, {
      method: "PUT",
      headers: adminHeaders,
      body: { status: "confirmed" }
    });
    assert(confirmed.ok, `Confirm tax payment failed (${confirmed.status})`);
    assert(String(confirmed.data?.payment?.status || "") === "confirmed", "Expected confirmed status on update");

    const userTaxAfterConfirm = await requestJson(`${base}/api/withdrawals/tax/me`, {
      headers: { Cookie: cookie }
    });
    assert(userTaxAfterConfirm.ok, `Tax summary after confirm failed (${userTaxAfterConfirm.status})`);
    assert(almostEq(userTaxAfterConfirm.data?.summary?.tax_remaining, 0), "Confirmed payment did not reset tax_remaining to 0");

    const set300 = await requestJson(`${base}/api/admin/tax-balances`, {
      method: "POST",
      headers: adminHeaders,
      body: { email: testEmail, asset: "GBP", remaining: 300, note: "hard_case_seed_300" }
    });
    assert(set300.ok, `Set tax 300 failed (${set300.status})`);

    const rejected = await requestJson(`${base}/api/admin/tax-payments`, {
      method: "POST",
      headers: adminHeaders,
      body: { email: testEmail, amount: 300, asset: "GBP", method: "Manual Entry", status: "rejected", note: "rejected should not clear" }
    });
    assert(rejected.ok, `Create rejected tax payment failed (${rejected.status})`);
    assert(String(rejected.data?.payment?.status || "") === "rejected", "Expected rejected payment status");

    const userTaxAfterRejected = await requestJson(`${base}/api/withdrawals/tax/me`, {
      headers: { Cookie: cookie }
    });
    assert(userTaxAfterRejected.ok, `Tax summary after rejected failed (${userTaxAfterRejected.status})`);
    assert(almostEq(userTaxAfterRejected.data?.summary?.tax_remaining, 300), "Rejected payment incorrectly changed tax_remaining");

    const set250 = await requestJson(`${base}/api/admin/tax-balances`, {
      method: "POST",
      headers: adminHeaders,
      body: { email: testEmail, asset: "GBP", remaining: 250, note: "hard_case_seed_250" }
    });
    assert(set250.ok, `Set tax 250 failed (${set250.status})`);

    const directConfirmed = await requestJson(`${base}/api/admin/tax-payments`, {
      method: "POST",
      headers: adminHeaders,
      body: { email: testEmail, amount: 250, asset: "GBP", method: "Manual Entry", status: "confirmed", note: "direct confirmed should clear" }
    });
    assert(directConfirmed.ok, `Create direct confirmed tax payment failed (${directConfirmed.status})`);
    assert(String(directConfirmed.data?.payment?.status || "") === "confirmed", "Expected direct confirmed status");

    const userTaxAfterDirectConfirm = await requestJson(`${base}/api/withdrawals/tax/me`, {
      headers: { Cookie: cookie }
    });
    assert(userTaxAfterDirectConfirm.ok, `Tax summary after direct confirmed failed (${userTaxAfterDirectConfirm.status})`);
    assert(almostEq(userTaxAfterDirectConfirm.data?.summary?.tax_remaining, 0), "Direct confirmed payment did not reset tax_remaining");

    const result = {
      ok: true,
      email: testEmail,
      dbMode,
      cases: [
        "pending_payment_keeps_remaining",
        "status_change_to_confirmed_resets_remaining",
        "rejected_payment_keeps_remaining",
        "direct_confirmed_payment_resets_remaining"
      ],
      final_summary: userTaxAfterDirectConfirm.data?.summary || null
    };
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (!proc.killed) {
      proc.kill("SIGTERM");
      await sleep(300);
      if (!proc.killed) proc.kill("SIGKILL");
    }
  }
}

run().catch((e) => {
  console.error(e?.stack || e?.message || String(e));
  process.exit(1);
});
