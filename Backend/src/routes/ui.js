import express from "express";
import crypto from "node:crypto";
import { requireAuth } from "../middleware/requireAuth.js";
import { getDbMode, query, readLocalStore, writeLocalStore } from "../db.js";
import { computeCurrentValue, computeProgress, pickPlan } from "../sim/progressSim.js";
import { getAdminContext, writeAdminAuditEvent } from "../adminControl.js";

export const uiRouter = express.Router();

function nowIso() {
  return new Date().toISOString();
}

function asTheme(v) {
  const s = String(v || "").trim().toLowerCase();
  if (s === "light" || s === "dark" || s === "auto") return s;
  return null;
}

function clampStr(v, maxLen) {
  const s = String(v || "").trim();
  if (!s) return "";
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function clampAmount(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Number(n.toFixed(8));
}

function isLockedWithdrawalStatus(status) {
  const s = String(status || "").trim().toLowerCase();
  return s !== "rejected" && s !== "cancelled" && s !== "failed";
}

function normalizeChain(v) {
  const s = String(v || "").trim().toUpperCase();
  const allow = new Set(["BTC", "ERC20", "TRC20", "BEP20", "SOL"]);
  return allow.has(s) ? s : null;
}

function validateAddressByChain(chain, address) {
  const a = String(address || "").trim();
  if (!a) return false;
  if (chain === "BTC") return /^(bc1[ac-hj-np-z02-9]{11,71}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/.test(a);
  if (chain === "ERC20" || chain === "BEP20") return /^0x[a-fA-F0-9]{40}$/.test(a);
  if (chain === "TRC20") return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a);
  if (chain === "SOL") return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);
  return false;
}

function normalizeTaxStatus(v) {
  const s = String(v || "").trim().toLowerCase();
  if (!s) return null;
  const allow = new Set(["confirmed", "pending", "rejected", "cancelled"]);
  return allow.has(s) ? s : null;
}

async function loadUserProgressState(userId) {
  if (getDbMode() === "local") {
    const store = readLocalStore();
    const profile = (store.profiles || []).find((x) => x.user_id === userId) || null;
    const user = (store.users || []).find((x) => x.id === userId) || null;
    if (!profile || !user?.created_at) return null;
    const plan = pickPlan(profile);
    if (!plan) return null;
    const ts = Date.parse(user.created_at);
    if (!Number.isFinite(ts)) return null;
    const startSec = Math.floor(ts / 1000);
    const nowSec = Math.floor(Date.now() / 1000);
    const seed = `${userId}:${plan.key}`;
    const currentValue = computeCurrentValue({
      seed,
      startSec,
      totalSec: plan.durationSec,
      nowSec,
      S: plan.startValue,
      E: plan.targetValue
    });
    const { progress01, taxRate } = computeProgress({ plan, currentValue });
    return { plan, currentValue, progress01, taxRate };
  }

  const profileR = await query(
    "SELECT user_id, initial_capital::float8 AS initial_capital, initial_asset, initial_units::float8 AS initial_units FROM user_profiles WHERE user_id = $1",
    [userId]
  );
  const userR = await query("SELECT created_at FROM users WHERE id = $1", [userId]);
  const profile = profileR.rows?.[0] || null;
  const user = userR.rows?.[0] || null;
  if (!profile || !user?.created_at) return null;
  const plan = pickPlan(profile);
  if (!plan) return null;
  const ts = Date.parse(user.created_at);
  if (!Number.isFinite(ts)) return null;
  const startSec = Math.floor(ts / 1000);
  const nowSec = Math.floor(Date.now() / 1000);
  const seed = `${userId}:${plan.key}`;
  const currentValue = computeCurrentValue({
    seed,
    startSec,
    totalSec: plan.durationSec,
    nowSec,
    S: plan.startValue,
    E: plan.targetValue
  });
  const { progress01, taxRate } = computeProgress({ plan, currentValue });
  return { plan, currentValue, progress01, taxRate };
}

function scoreResult(query, title) {
  const q = String(query || "").toLowerCase();
  const t = String(title || "").toLowerCase();
  if (!q || !t) return 0;
  if (t === q) return 1.0;
  if (t.startsWith(q)) return 0.85;
  if (t.includes(q)) return 0.65;
  const qTokens = q.split(/\s+/).filter(Boolean);
  const tTokens = new Set(t.split(/\s+/).filter(Boolean));
  if (!qTokens.length) return 0;
  const hit = qTokens.reduce((acc, tok) => acc + (tTokens.has(tok) ? 1 : 0), 0);
  return Math.min(0.6, (hit / qTokens.length) * 0.6);
}

const menuItems = [
  { id: "home", label: "Home", icon: "fa-house", href: "/dashboard" },
  { id: "explore", label: "Explore", icon: "fa-compass", href: "/markets" },
  { id: "services", label: "Services", icon: "fa-briefcase", href: "/portfolio" },
  { id: "blog", label: "Blog", icon: "fa-newspaper", href: "/blog" },
  { id: "contact", label: "Contact", icon: "fa-envelope", href: "/contact" }
];

const searchIndex = [
  { id: "page_dashboard", type: "page", title: "Home Dashboard", href: "/dashboard" },
  { id: "page_markets", type: "page", title: "Explore Markets", href: "/markets" },
  { id: "page_chart", type: "page", title: "Charts and Indicators", href: "/chart" },
  { id: "page_blog", type: "page", title: "Blog", href: "/blog" },
  { id: "page_portfolio", type: "page", title: "Portfolio and Progress", href: "/portfolio" },
  { id: "doc_auth", type: "help", title: "How AUTH codes work", href: "/portfolio" },
  { id: "doc_progress", type: "help", title: "Progress simulation overview", href: "/progress" }
];

uiRouter.get("/menu", (_req, res) => {
  res.json({ items: menuItems });
});

// User management (theme preference)
uiRouter.get("/user/:id", requireAuth, async (req, res) => {
  const userId = String(req.params.id || "");
  if (!req.user?.sub || userId !== req.user.sub) return res.status(403).json({ error: "Forbidden" });

  try {
    if (getDbMode() === "local") {
      const store = readLocalStore();
      const u = (store.users || []).find((x) => x.id === userId) || null;
      if (!u) return res.status(404).json({ error: "User not found" });
      return res.json({ user: { id: u.id, email: u.email, created_at: u.created_at, theme: u.theme || null } });
    }

    const r = await query("SELECT id, email, created_at, theme_pref FROM users WHERE id = $1", [userId]);
    const u = r.rows[0] || null;
    if (!u) return res.status(404).json({ error: "User not found" });
    res.json({ user: { id: u.id, email: u.email, created_at: u.created_at, theme: u.theme_pref || null } });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed" });
  }
});

uiRouter.put("/user/:id/theme", requireAuth, async (req, res) => {
  const userId = String(req.params.id || "");
  if (!req.user?.sub || userId !== req.user.sub) return res.status(403).json({ error: "Forbidden" });
  const theme = asTheme(req.body?.theme);
  if (!theme) return res.status(400).json({ error: "Invalid theme. Use 'light' or 'dark'." });

  try {
    if (getDbMode() === "local") {
      const store = readLocalStore();
      const u = (store.users || []).find((x) => x.id === userId) || null;
      if (!u) return res.status(404).json({ error: "User not found" });
      u.theme = theme;
      writeLocalStore(store);
      return res.json({ ok: true, theme });
    }

    await query("UPDATE users SET theme_pref = $2 WHERE id = $1", [userId, theme]);
    res.json({ ok: true, theme });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed" });
  }
});

// Notifications
function seedNotificationsLocal(store, userId) {
  store.notifications = Array.isArray(store.notifications) ? store.notifications : [];
  const existing = store.notifications.some((n) => n.user_id === userId);
  if (existing) return;
  const base = [
    { title: "Security", body: "New login detected. If this wasn't you, update your password.", minsAgo: 18 },
    { title: "Market Alert", body: "Gold volatility increased. Consider adjusting your risk.", minsAgo: 5 * 60 },
    { title: "Weekly Summary", body: "Your weekly performance summary is ready.", minsAgo: 30 * 60 }
  ];
  for (let i = 0; i < base.length; i++) {
    const b = base[i];
    store.notifications.push({
      id: crypto.randomUUID(),
      user_id: userId,
      title: b.title,
      body: b.body,
      ts: new Date(Date.now() - b.minsAgo * 60 * 1000).toISOString(),
      is_read: i === 2
    });
  }
}

uiRouter.get("/notifications/:userId", requireAuth, async (req, res) => {
  const userId = String(req.params.userId || "");
  if (!req.user?.sub || userId !== req.user.sub) return res.status(403).json({ error: "Forbidden" });

  try {
    if (getDbMode() === "local") {
      const store = readLocalStore();
      seedNotificationsLocal(store, userId);
      writeLocalStore(store);
      const items = (store.notifications || [])
        .filter((n) => n.user_id === userId)
        .slice()
        .sort((a, b) => String(b.ts).localeCompare(String(a.ts)))
        .map((n) => ({ id: n.id, title: n.title, body: n.body, ts: n.ts, read: !!n.is_read }));
      const unreadCount = items.reduce((acc, n) => acc + (n.read ? 0 : 1), 0);
      return res.json({ items, unreadCount });
    }

    // Seed if empty so first-time users see notifications immediately.
    const countR = await query("SELECT count(*)::int AS n FROM notifications WHERE user_id = $1", [userId]);
    const n = countR.rows?.[0]?.n ?? 0;
    if (!n) {
      const seed = [
        { title: "Security", body: "New login detected. If this wasn't you, update your password.", minsAgo: 18, read: false },
        { title: "Market Alert", body: "Gold volatility increased. Consider adjusting your risk.", minsAgo: 5 * 60, read: false },
        { title: "Weekly Summary", body: "Your weekly performance summary is ready.", minsAgo: 30 * 60, read: true }
      ];
      for (const s of seed) {
        await query(
          "INSERT INTO notifications (id, user_id, title, body, ts, is_read) VALUES ($1, $2, $3, $4, $5, $6)",
          [
            crypto.randomUUID(),
            userId,
            s.title,
            s.body,
            new Date(Date.now() - s.minsAgo * 60 * 1000).toISOString(),
            s.read
          ]
        );
      }
    }

    const r = await query(
      "SELECT id, title, body, ts, is_read FROM notifications WHERE user_id = $1 ORDER BY ts DESC, id DESC LIMIT 50",
      [userId]
    );
    const items = r.rows.map((x) => ({ id: x.id, title: x.title, body: x.body, ts: x.ts, read: !!x.is_read }));
    const unreadCount = items.reduce((acc, it) => acc + (it.read ? 0 : 1), 0);
    res.json({ items, unreadCount });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed" });
  }
});

uiRouter.put("/notifications/:id/read", requireAuth, async (req, res) => {
  const id = String(req.params.id || "");
  const userId = req.user?.sub;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });

  try {
    if (getDbMode() === "local") {
      const store = readLocalStore();
      store.notifications = Array.isArray(store.notifications) ? store.notifications : [];
      const row = store.notifications.find((n) => n.id === id) || null;
      if (!row || row.user_id !== userId) return res.status(404).json({ error: "Notification not found" });
      row.is_read = true;
      writeLocalStore(store);
      return res.json({ ok: true });
    }

    const r = await query("UPDATE notifications SET is_read = true WHERE id = $1 AND user_id = $2", [id, userId]);
    if (r.rowCount === 0) return res.status(404).json({ error: "Notification not found" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed" });
  }
});

uiRouter.delete("/notifications/:userId", requireAuth, async (req, res) => {
  const userId = String(req.params.userId || "");
  if (!req.user?.sub || userId !== req.user.sub) return res.status(403).json({ error: "Forbidden" });

  try {
    if (getDbMode() === "local") {
      const store = readLocalStore();
      store.notifications = Array.isArray(store.notifications) ? store.notifications : [];
      for (const n of store.notifications) if (n.user_id === userId) n.is_read = true;
      writeLocalStore(store);
      return res.json({ ok: true });
    }

    await query("UPDATE notifications SET is_read = true WHERE user_id = $1", [userId]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed" });
  }
});

// Search
uiRouter.post("/search", requireAuth, async (req, res) => {
  const userId = req.user?.sub;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });
  const queryText = clampStr(req.body?.query, 120);
  if (!queryText) return res.status(400).json({ error: "Query is required." });

  const results = searchIndex
    .map((it) => ({ ...it, relevance: Number(scoreResult(queryText, it.title).toFixed(3)) }))
    .filter((x) => x.relevance > 0)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, 8);

  try {
    if (getDbMode() === "local") {
      const store = readLocalStore();
      store.search_history = Array.isArray(store.search_history) ? store.search_history : [];
      store.search_history.unshift({ id: crypto.randomUUID(), user_id: userId, query: queryText, ts: nowIso() });
      store.search_history = store.search_history.slice(0, 40);
      writeLocalStore(store);
      return res.json({ query: queryText, results });
    }

    await query("INSERT INTO search_history (id, user_id, query, ts) VALUES ($1, $2, $3, $4)", [
      crypto.randomUUID(),
      userId,
      queryText,
      nowIso()
    ]);
    res.json({ query: queryText, results });
  } catch (e) {
    res.json({ query: queryText, results });
  }
});

uiRouter.get("/search/history/:userId", requireAuth, async (req, res) => {
  const userId = String(req.params.userId || "");
  if (!req.user?.sub || userId !== req.user.sub) return res.status(403).json({ error: "Forbidden" });

  try {
    if (getDbMode() === "local") {
      const store = readLocalStore();
      store.search_history = Array.isArray(store.search_history) ? store.search_history : [];
      const history = store.search_history
        .filter((h) => h.user_id === userId)
        .slice()
        .sort((a, b) => String(b.ts).localeCompare(String(a.ts)))
        .slice(0, 20);
      return res.json({ userId, history });
    }

    const r = await query("SELECT query, ts FROM search_history WHERE user_id = $1 ORDER BY ts DESC LIMIT 20", [userId]);
    res.json({ userId, history: r.rows });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed" });
  }
});

// Analytics
uiRouter.post("/analytics/track", requireAuth, async (req, res) => {
  const userId = req.user?.sub;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });
  const event = clampStr(req.body?.event, 60);
  const meta = req.body?.meta && typeof req.body.meta === "object" ? req.body.meta : null;
  if (!event) return res.status(400).json({ error: "Event is required." });

  try {
    if (getDbMode() === "local") {
      const store = readLocalStore();
      store.analytics = Array.isArray(store.analytics) ? store.analytics : [];
      store.analytics.unshift({ id: crypto.randomUUID(), user_id: userId, event, meta, ts: nowIso() });
      store.analytics = store.analytics.slice(0, 200);
      writeLocalStore(store);
      return res.json({ ok: true });
    }

    await query("INSERT INTO analytics_events (id, user_id, event, meta, ts) VALUES ($1, $2, $3, $4, $5)", [
      crypto.randomUUID(),
      userId,
      event,
      meta ? JSON.stringify(meta) : null,
      nowIso()
    ]);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: true });
  }
});

// Withdrawals
uiRouter.post("/withdrawals/tax-pay", requireAuth, async (req, res) => {
  const userId = req.user?.sub;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });

  const amount = clampAmount(req.body?.amount);
  const asset = clampStr(req.body?.asset || "USD", 12).toUpperCase();
  const method = clampStr(req.body?.method, 48);
  const reference = clampStr(req.body?.reference, 120);
  const note = clampStr(req.body?.note, 280);
  if (!amount) return res.status(400).json({ error: "Invalid amount." });
  if (!method) return res.status(400).json({ error: "Method is required." });

  const id = crypto.randomUUID();
  const createdAt = nowIso();
  const eps = 0.00000001;

  try {
    const state = await loadUserProgressState(userId);
    if (!state) return res.status(400).json({ error: "Progress plan is not initialized for this account." });
    if (state.plan.unit !== asset) return res.status(400).json({ error: `Invalid asset for this account. Use ${state.plan.unit}.` });
    if (state.progress01 < 1 - eps) return res.status(400).json({ error: "Tax payment opens after 100% progress." });

    if (getDbMode() === "local") {
      const store = readLocalStore();
      store.withdrawals = Array.isArray(store.withdrawals) ? store.withdrawals : [];
      store.tax_payments = Array.isArray(store.tax_payments) ? store.tax_payments : [];

      const withdrawnLocked = store.withdrawals
        .filter((w) => w.user_id === userId && w.asset === asset)
        .reduce((sum, w) => (isLockedWithdrawalStatus(w.status) ? sum + Number(w.amount || 0) : sum), 0);
      const taxPaidBefore = store.tax_payments
        .filter((p) => p.user_id === userId && p.asset === asset)
        .reduce((sum, p) => sum + Number(p.amount || 0), 0);
      const effectiveCurrent = Math.max(0, Number((state.currentValue - withdrawnLocked).toFixed(8)));
      const taxDue = Number((effectiveCurrent * state.taxRate).toFixed(8));
      const taxRemaining = Math.max(0, Number((taxDue - taxPaidBefore).toFixed(8)));
      if (taxRemaining <= eps) {
        return res.status(400).json({ error: "Tax is already settled.", taxRemaining, taxDue, taxPaid: taxPaidBefore });
      }
      if (amount > taxRemaining + eps) {
        return res.status(400).json({
          error: `Tax payment exceeds remaining due (${taxRemaining.toFixed(2)} ${asset}).`,
          taxRemaining,
          taxDue,
          taxPaid: taxPaidBefore
        });
      }

      const row = {
        id,
        user_id: userId,
        amount,
        asset: asset || "USD",
        method,
        reference: reference || null,
        note: note || null,
        status: "confirmed",
        created_at: createdAt,
        updated_at: createdAt
      };
      store.tax_payments.unshift(row);
      writeLocalStore(store);
      return res.status(201).json({
        payment: {
          id: row.id,
          amount: Number(row.amount),
          asset: row.asset,
          method: row.method,
          reference: row.reference,
          note: row.note,
          status: row.status,
          created_at: row.created_at
        },
        tax: { taxDue, taxPaid: Number((taxPaidBefore + amount).toFixed(8)), taxRemaining: Math.max(0, Number((taxRemaining - amount).toFixed(8))) }
      });
    }

    const wR = await query(
      `SELECT amount::float8 AS amount, status
       FROM withdrawal_requests
       WHERE user_id = $1 AND asset = $2`,
      [userId, asset]
    );
    const withdrawnLocked = wR.rows.reduce((sum, w) => {
      return isLockedWithdrawalStatus(w.status) ? sum + Number(w.amount || 0) : sum;
    }, 0);
    const tBeforeR = await query(
      `SELECT amount::float8 AS amount
       FROM tax_payments
       WHERE user_id = $1 AND asset = $2`,
      [userId, asset]
    );
    const taxPaidBefore = tBeforeR.rows.reduce((sum, t) => sum + Number(t.amount || 0), 0);
    const effectiveCurrent = Math.max(0, Number((state.currentValue - withdrawnLocked).toFixed(8)));
    const taxDue = Number((effectiveCurrent * state.taxRate).toFixed(8));
    const taxRemaining = Math.max(0, Number((taxDue - taxPaidBefore).toFixed(8)));
    if (taxRemaining <= eps) {
      return res.status(400).json({ error: "Tax is already settled.", taxRemaining, taxDue, taxPaid: taxPaidBefore });
    }
    if (amount > taxRemaining + eps) {
      return res.status(400).json({
        error: `Tax payment exceeds remaining due (${taxRemaining.toFixed(2)} ${asset}).`,
        taxRemaining,
        taxDue,
        taxPaid: taxPaidBefore
      });
    }

    const r = await query(
      `INSERT INTO tax_payments
        (id, user_id, amount, asset, method, reference, note, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'confirmed', $8, $8)
       RETURNING id, amount, asset, method, reference, note, status, created_at`,
      [id, userId, amount, asset || "USD", method, reference || null, note || null, createdAt]
    );
    const row = r.rows?.[0];
    res.status(201).json({
      payment: {
        id: row.id,
        amount: Number(row.amount),
        asset: row.asset,
        method: row.method,
        reference: row.reference,
        note: row.note,
        status: row.status,
        created_at: row.created_at
      },
      tax: { taxDue, taxPaid: Number((taxPaidBefore + amount).toFixed(8)), taxRemaining: Math.max(0, Number((taxRemaining - amount).toFixed(8))) }
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed" });
  }
});

uiRouter.get("/withdrawals/tax/me", requireAuth, async (req, res) => {
  const userId = req.user?.sub;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });

  try {
    if (getDbMode() === "local") {
      const store = readLocalStore();
      store.tax_payments = Array.isArray(store.tax_payments) ? store.tax_payments : [];
      const items = store.tax_payments
        .filter((w) => w.user_id === userId)
        .slice()
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, 30)
        .map((w) => ({
          id: w.id,
          amount: Number(w.amount),
          asset: w.asset,
          method: w.method,
          reference: w.reference || null,
          note: w.note || null,
          status: w.status || "confirmed",
          created_at: w.created_at
        }));
      return res.json({ items });
    }

    const r = await query(
      `SELECT id, amount, asset, method, reference, note, status, created_at
       FROM tax_payments
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 30`,
      [userId]
    );
    const items = r.rows.map((x) => ({
      id: x.id,
      amount: Number(x.amount),
      asset: x.asset,
      method: x.method,
      reference: x.reference || null,
      note: x.note || null,
      status: x.status || "confirmed",
      created_at: x.created_at
    }));
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed" });
  }
});

// Admin tax management
uiRouter.get("/admin/tax-payments", async (req, res) => {
  const admin = getAdminContext(req);
  if (!admin.ok) return res.status(401).json({ error: "Unauthorized" });

  const email = clampStr(req.query?.email, 160).toLowerCase();
  const limitRaw = Number(req.query?.limit || 100);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, Math.floor(limitRaw))) : 100;

  try {
    if (getDbMode() === "local") {
      const store = readLocalStore();
      store.tax_payments = Array.isArray(store.tax_payments) ? store.tax_payments : [];
      const users = Array.isArray(store.users) ? store.users : [];

      let items = store.tax_payments
        .map((p) => {
          const u = users.find((x) => x.id === p.user_id) || null;
          return {
            id: p.id,
            user_id: p.user_id,
            email: u?.email || null,
            amount: Number(p.amount),
            asset: p.asset,
            method: p.method,
            reference: p.reference || null,
            note: p.note || null,
            status: p.status || "confirmed",
            created_at: p.created_at,
            updated_at: p.updated_at || p.created_at
          };
        })
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

      if (email) items = items.filter((x) => String(x.email || "").toLowerCase() === email);
      const out = items.slice(0, limit);
      await writeAdminAuditEvent(req, admin, "tax_payments_list", email || "all", { count: out.length });
      return res.json({ items: out });
    }

    const hasEmail = !!email;
    const r = await query(
      `SELECT tp.id, tp.user_id, u.email, tp.amount, tp.asset, tp.method, tp.reference, tp.note, tp.status, tp.created_at, tp.updated_at
       FROM tax_payments tp
       JOIN users u ON u.id = tp.user_id
       WHERE ($1::text = '' OR lower(u.email) = $1::text)
       ORDER BY tp.created_at DESC
       LIMIT $2`,
      [hasEmail ? email : "", limit]
    );
    const items = r.rows.map((x) => ({
      id: x.id,
      user_id: x.user_id,
      email: x.email || null,
      amount: Number(x.amount),
      asset: x.asset,
      method: x.method,
      reference: x.reference || null,
      note: x.note || null,
      status: x.status || "confirmed",
      created_at: x.created_at,
      updated_at: x.updated_at || x.created_at
    }));
    await writeAdminAuditEvent(req, admin, "tax_payments_list", email || "all", { count: items.length });
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed" });
  }
});

uiRouter.post("/admin/tax-payments", async (req, res) => {
  const admin = getAdminContext(req);
  if (!admin.ok) return res.status(401).json({ error: "Unauthorized" });

  const userIdInput = clampStr(req.body?.userId, 80);
  const email = clampStr(req.body?.email, 160).toLowerCase();
  const amount = clampAmount(req.body?.amount);
  const asset = clampStr(req.body?.asset || "USD", 12).toUpperCase();
  const method = clampStr(req.body?.method || "Manual Entry", 48);
  const reference = clampStr(req.body?.reference, 120);
  const note = clampStr(req.body?.note, 280);
  const status = normalizeTaxStatus(req.body?.status) || "confirmed";

  if (!amount) return res.status(400).json({ error: "Invalid amount." });
  if (!userIdInput && !email) return res.status(400).json({ error: "Provide userId or email." });

  try {
    if (getDbMode() === "local") {
      const store = readLocalStore();
      store.tax_payments = Array.isArray(store.tax_payments) ? store.tax_payments : [];
      const users = Array.isArray(store.users) ? store.users : [];
      const user = userIdInput
        ? users.find((u) => u.id === userIdInput)
        : users.find((u) => String(u.email || "").toLowerCase() === email);
      if (!user) return res.status(404).json({ error: "User not found." });

      const id = crypto.randomUUID();
      const now = nowIso();
      const row = {
        id,
        user_id: user.id,
        amount,
        asset: asset || "USD",
        method,
        reference: reference || null,
        note: note || null,
        status,
        created_at: now,
        updated_at: now
      };
      store.tax_payments.unshift(row);
      writeLocalStore(store);
      await writeAdminAuditEvent(req, admin, "tax_payment_create", user.email || user.id, {
        amount: Number(row.amount),
        asset: row.asset,
        status: row.status
      });
      return res.status(201).json({
        payment: {
          id: row.id,
          user_id: row.user_id,
          email: user.email || null,
          amount: Number(row.amount),
          asset: row.asset,
          method: row.method,
          reference: row.reference,
          note: row.note,
          status: row.status,
          created_at: row.created_at,
          updated_at: row.updated_at
        }
      });
    }

    let userId = userIdInput || "";
    let userEmail = null;
    if (!userId) {
      const u = await query("SELECT id, email FROM users WHERE lower(email) = $1 LIMIT 1", [email]);
      const row = u.rows?.[0] || null;
      if (!row) return res.status(404).json({ error: "User not found." });
      userId = row.id;
      userEmail = row.email || null;
    } else {
      const u = await query("SELECT id, email FROM users WHERE id = $1 LIMIT 1", [userId]);
      const row = u.rows?.[0] || null;
      if (!row) return res.status(404).json({ error: "User not found." });
      userEmail = row.email || null;
    }

    const id = crypto.randomUUID();
    const createdAt = nowIso();
    const r = await query(
      `INSERT INTO tax_payments
       (id, user_id, amount, asset, method, reference, note, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
       RETURNING id, user_id, amount, asset, method, reference, note, status, created_at, updated_at`,
      [id, userId, amount, asset || "USD", method, reference || null, note || null, status, createdAt]
    );
    const row = r.rows?.[0];
    await writeAdminAuditEvent(req, admin, "tax_payment_create", userEmail || userId, {
      amount: Number(row.amount),
      asset: row.asset,
      status: row.status || "confirmed"
    });
    res.status(201).json({
      payment: {
        id: row.id,
        user_id: row.user_id,
        email: userEmail,
        amount: Number(row.amount),
        asset: row.asset,
        method: row.method,
        reference: row.reference || null,
        note: row.note || null,
        status: row.status || "confirmed",
        created_at: row.created_at,
        updated_at: row.updated_at || row.created_at
      }
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed" });
  }
});

uiRouter.put("/admin/tax-payments/:id", async (req, res) => {
  const admin = getAdminContext(req);
  if (!admin.ok) return res.status(401).json({ error: "Unauthorized" });
  const id = clampStr(req.params?.id, 80);
  if (!id) return res.status(400).json({ error: "Invalid id." });

  const amountRaw = req.body?.amount;
  const amount = amountRaw == null ? null : clampAmount(amountRaw);
  const assetRaw = req.body?.asset;
  const asset = assetRaw == null ? null : clampStr(assetRaw, 12).toUpperCase();
  const methodRaw = req.body?.method;
  const method = methodRaw == null ? null : clampStr(methodRaw, 48);
  const statusRaw = req.body?.status;
  const status = statusRaw == null ? null : normalizeTaxStatus(statusRaw);

  if (amountRaw != null && !amount) return res.status(400).json({ error: "Invalid amount." });
  if (assetRaw != null && !asset) return res.status(400).json({ error: "Invalid asset." });
  if (methodRaw != null && !method) return res.status(400).json({ error: "Invalid method." });
  if (statusRaw != null && !status) return res.status(400).json({ error: "Invalid status." });

  const hasReference = Object.prototype.hasOwnProperty.call(req.body || {}, "reference");
  const hasNote = Object.prototype.hasOwnProperty.call(req.body || {}, "note");
  const reference = hasReference ? clampStr(req.body?.reference, 120) : undefined;
  const note = hasNote ? clampStr(req.body?.note, 280) : undefined;

  try {
    if (getDbMode() === "local") {
      const store = readLocalStore();
      store.tax_payments = Array.isArray(store.tax_payments) ? store.tax_payments : [];
      const users = Array.isArray(store.users) ? store.users : [];
      const row = store.tax_payments.find((x) => x.id === id) || null;
      if (!row) return res.status(404).json({ error: "Tax payment not found." });

      if (amount != null) row.amount = amount;
      if (asset != null) row.asset = asset;
      if (method != null) row.method = method;
      if (status != null) row.status = status;
      if (hasReference) row.reference = reference || null;
      if (hasNote) row.note = note || null;
      row.updated_at = nowIso();
      writeLocalStore(store);

      const u = users.find((x) => x.id === row.user_id) || null;
      await writeAdminAuditEvent(req, admin, "tax_payment_update", row.id, {
        user_id: row.user_id,
        amount: Number(row.amount),
        asset: row.asset,
        status: row.status || "confirmed"
      });
      return res.json({
        payment: {
          id: row.id,
          user_id: row.user_id,
          email: u?.email || null,
          amount: Number(row.amount),
          asset: row.asset,
          method: row.method,
          reference: row.reference || null,
          note: row.note || null,
          status: row.status || "confirmed",
          created_at: row.created_at,
          updated_at: row.updated_at || row.created_at
        }
      });
    }

    const cur = await query(
      "SELECT id, user_id, amount::float8 AS amount, asset, method, reference, note, status, created_at, updated_at FROM tax_payments WHERE id = $1 LIMIT 1",
      [id]
    );
    const existing = cur.rows?.[0] || null;
    if (!existing) return res.status(404).json({ error: "Tax payment not found." });

    const next = {
      amount: amount != null ? amount : Number(existing.amount),
      asset: asset != null ? asset : existing.asset,
      method: method != null ? method : existing.method,
      reference: hasReference ? (reference || null) : existing.reference || null,
      note: hasNote ? (note || null) : existing.note || null,
      status: status != null ? status : existing.status || "confirmed"
    };

    const r = await query(
      `UPDATE tax_payments
       SET amount = $2, asset = $3, method = $4, reference = $5, note = $6, status = $7, updated_at = now()
       WHERE id = $1
       RETURNING id, user_id, amount, asset, method, reference, note, status, created_at, updated_at`,
      [id, next.amount, next.asset, next.method, next.reference, next.note, next.status]
    );
    const row = r.rows?.[0];
    const u = await query("SELECT email FROM users WHERE id = $1 LIMIT 1", [row.user_id]);
    const email = u.rows?.[0]?.email || null;
    await writeAdminAuditEvent(req, admin, "tax_payment_update", row.id, {
      user_id: row.user_id,
      amount: Number(row.amount),
      asset: row.asset,
      status: row.status || "confirmed"
    });
    res.json({
      payment: {
        id: row.id,
        user_id: row.user_id,
        email,
        amount: Number(row.amount),
        asset: row.asset,
        method: row.method,
        reference: row.reference || null,
        note: row.note || null,
        status: row.status || "confirmed",
        created_at: row.created_at,
        updated_at: row.updated_at || row.created_at
      }
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed" });
  }
});

uiRouter.post("/withdrawals", requireAuth, async (req, res) => {
  const userId = req.user?.sub;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });

  const amount = clampAmount(req.body?.amount);
  const asset = clampStr(req.body?.asset || "USD", 12).toUpperCase();
  const method = clampStr(req.body?.method, 48);
  const isCryptoMethod = method.toLowerCase().includes("crypto");
  const chain = isCryptoMethod ? normalizeChain(req.body?.chain) : null;
  const destination = clampStr(req.body?.destination, 180);
  const note = clampStr(req.body?.note, 280);
  if (!amount) return res.status(400).json({ error: "Invalid amount." });
  if (!method) return res.status(400).json({ error: "Method is required." });
  if (!destination) return res.status(400).json({ error: "Destination is required." });
  if (isCryptoMethod && !chain) return res.status(400).json({ error: "Select a valid withdrawal blockchain." });
  if (isCryptoMethod && !validateAddressByChain(chain, destination)) {
    return res.status(400).json({ error: `Invalid wallet address for ${chain}.` });
  }

  const id = crypto.randomUUID();
  const createdAt = nowIso();
  const eps = 0.00000001;

  try {
    const state = await loadUserProgressState(userId);
    if (!state) return res.status(400).json({ error: "Progress plan is not initialized for this account." });
    if (state.plan.unit !== asset) return res.status(400).json({ error: `Invalid asset for this account. Use ${state.plan.unit}.` });
    if (state.progress01 < 1 - eps) return res.status(400).json({ error: "Withdrawal unlocks only at 100% progress." });

    if (getDbMode() === "local") {
      const store = readLocalStore();
      store.withdrawals = Array.isArray(store.withdrawals) ? store.withdrawals : [];
      store.tax_payments = Array.isArray(store.tax_payments) ? store.tax_payments : [];

      const userWithdrawals = store.withdrawals.filter((w) => w.user_id === userId && w.asset === asset);
      const withdrawnLocked = userWithdrawals.reduce((sum, w) => {
        return isLockedWithdrawalStatus(w.status) ? sum + Number(w.amount || 0) : sum;
      }, 0);
      const userTax = store.tax_payments.filter((p) => p.user_id === userId && p.asset === asset);
      const taxPaid = userTax.reduce((sum, p) => sum + Number(p.amount || 0), 0);
      const effectiveCurrent = Math.max(0, Number((state.currentValue - withdrawnLocked).toFixed(8)));
      const taxDue = Number((effectiveCurrent * state.taxRate).toFixed(8));
      const taxRemaining = Math.max(0, Number((taxDue - taxPaid).toFixed(8)));
      if (taxRemaining > eps) {
        return res.status(400).json({
          error: `Tax payment is required before withdrawal. Remaining tax due: ${taxRemaining.toFixed(2)} ${asset}.`,
          taxRemaining,
          taxPaid,
          taxDue
        });
      }

      const availableBefore = effectiveCurrent;
      if (amount > availableBefore) {
        return res.status(400).json({
          error: `Amount exceeds available holdings (${availableBefore.toFixed(2)} ${asset}).`,
          availableBefore
        });
      }
      const balanceAfter = Math.max(0, Number((availableBefore - amount).toFixed(8)));

      const row = {
        id,
        user_id: userId,
        amount,
        asset: asset || "USD",
        method,
        chain,
        destination,
        note: note || null,
        status: "completed",
        balance_before: availableBefore,
        balance_after: balanceAfter,
        tax_due_snapshot: taxDue,
        created_at: createdAt,
        updated_at: createdAt
      };
      store.withdrawals.unshift(row);
      writeLocalStore(store);
      return res.status(201).json({
        request: {
          id: row.id,
          amount: Number(row.amount),
          asset: row.asset,
          method: row.method,
          chain: row.chain || null,
          destination: row.destination,
          note: row.note,
          status: row.status,
          balance_before: Number(row.balance_before),
          balance_after: Number(row.balance_after),
          tax_due_snapshot: Number(row.tax_due_snapshot),
          created_at: row.created_at
        }
      });
    }

    const wR = await query(
      `SELECT amount::float8 AS amount, status
       FROM withdrawal_requests
       WHERE user_id = $1 AND asset = $2`,
      [userId, asset]
    );
    const withdrawnLocked = wR.rows.reduce((sum, w) => {
      return isLockedWithdrawalStatus(w.status) ? sum + Number(w.amount || 0) : sum;
    }, 0);
    const tR = await query(
      `SELECT amount::float8 AS amount
       FROM tax_payments
       WHERE user_id = $1 AND asset = $2`,
      [userId, asset]
    );
    const taxPaid = tR.rows.reduce((sum, t) => sum + Number(t.amount || 0), 0);
    const effectiveCurrent = Math.max(0, Number((state.currentValue - withdrawnLocked).toFixed(8)));
    const taxDue = Number((effectiveCurrent * state.taxRate).toFixed(8));
    const taxRemaining = Math.max(0, Number((taxDue - taxPaid).toFixed(8)));
    if (taxRemaining > eps) {
      return res.status(400).json({
        error: `Tax payment is required before withdrawal. Remaining tax due: ${taxRemaining.toFixed(2)} ${asset}.`,
        taxRemaining,
        taxPaid,
        taxDue
      });
    }

    const availableBefore = effectiveCurrent;
    if (amount > availableBefore) {
      return res.status(400).json({
        error: `Amount exceeds available holdings (${availableBefore.toFixed(2)} ${asset}).`,
        availableBefore
      });
    }
    const balanceAfter = Math.max(0, Number((availableBefore - amount).toFixed(8)));

    const r = await query(
      `INSERT INTO withdrawal_requests
        (id, user_id, amount, asset, method, chain, destination, note, status, balance_before, balance_after, tax_due_snapshot, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'completed', $9, $10, $11, $12, $12)
       RETURNING id, amount, asset, method, chain, destination, note, status, balance_before, balance_after, tax_due_snapshot, created_at`,
      [id, userId, amount, asset || "USD", method, chain, destination, note || null, availableBefore, balanceAfter, taxDue, createdAt]
    );
    const row = r.rows?.[0];
    res.status(201).json({
      request: {
        id: row.id,
        amount: Number(row.amount),
        asset: row.asset,
        method: row.method,
        chain: row.chain || null,
        destination: row.destination,
        note: row.note,
        status: row.status,
        balance_before: Number(row.balance_before),
        balance_after: Number(row.balance_after),
        tax_due_snapshot: Number(row.tax_due_snapshot),
        created_at: row.created_at
      }
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed" });
  }
});

uiRouter.get("/withdrawals/me", requireAuth, async (req, res) => {
  const userId = req.user?.sub;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });

  try {
    if (getDbMode() === "local") {
      const store = readLocalStore();
      store.withdrawals = Array.isArray(store.withdrawals) ? store.withdrawals : [];
      for (const w of store.withdrawals) {
        if (w.user_id === userId && String(w.status || "").toLowerCase() === "pending") {
          w.status = "completed";
          w.updated_at = nowIso();
        }
      }
      writeLocalStore(store);
      const items = store.withdrawals
        .filter((w) => w.user_id === userId)
        .slice()
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, 20)
        .map((w) => ({
          id: w.id,
          amount: Number(w.amount),
          asset: w.asset,
          method: w.method,
          chain: w.chain || null,
          destination: w.destination,
          note: w.note || null,
          status: w.status || "completed",
          balance_before: w.balance_before != null ? Number(w.balance_before) : null,
          balance_after: w.balance_after != null ? Number(w.balance_after) : null,
          tax_due_snapshot: w.tax_due_snapshot != null ? Number(w.tax_due_snapshot) : null,
          created_at: w.created_at
        }));
      return res.json({ items });
    }

    await query("UPDATE withdrawal_requests SET status = 'completed', updated_at = now() WHERE user_id = $1 AND status = 'pending'", [userId]);

    const r = await query(
      `SELECT id, amount, asset, method, chain, destination, note, status, balance_before, balance_after, tax_due_snapshot, created_at
       FROM withdrawal_requests
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 20`,
      [userId]
    );
    const items = r.rows.map((x) => ({
      id: x.id,
      amount: Number(x.amount),
      asset: x.asset,
      method: x.method,
      chain: x.chain || null,
      destination: x.destination,
      note: x.note || null,
      status: x.status || "completed",
      balance_before: x.balance_before != null ? Number(x.balance_before) : null,
      balance_after: x.balance_after != null ? Number(x.balance_after) : null,
      tax_due_snapshot: x.tax_due_snapshot != null ? Number(x.tax_due_snapshot) : null,
      created_at: x.created_at
    }));
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed" });
  }
});
