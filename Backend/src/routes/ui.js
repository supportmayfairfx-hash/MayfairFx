import express from "express";
import crypto from "node:crypto";
import { requireAuth } from "../middleware/requireAuth.js";
import { getDbMode, query, readLocalStore, writeLocalStore } from "../db.js";
import { computeCurrentValue, computeProgress, pickPlan } from "../sim/progressSim.js";
import { getAdminContext, listAdminAuditEvents, writeAdminAuditEvent } from "../adminControl.js";

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
  const allow = new Set(["BTC", "LTC", "ERC20", "TRC20", "BEP20", "SOL"]);
  return allow.has(s) ? s : null;
}

function validateAddressByChain(chain, address) {
  const a = String(address || "").trim();
  if (!a) return false;
  if (chain === "BTC") return /^(bc1[ac-hj-np-z02-9]{11,71}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/.test(a);
  if (chain === "LTC") return /^(ltc1[ac-hj-np-z02-9]{39,59}|[LM3][a-km-zA-HJ-NP-Z1-9]{26,34})$/.test(a);
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

function normalizeDepositAdminStatus(v) {
  const s = String(v || "").trim().toLowerCase();
  if (!s) return null;
  const allow = new Set(["awaiting_payment", "pending", "confirmed", "failed", "expired", "cancelled", "rejected"]);
  return allow.has(s) ? s : null;
}

function normalizeAsset(v, fallback = "USD") {
  const s = clampStr(v || fallback, 12).toUpperCase();
  return s || fallback;
}

function normalizeQuoteAsset(v, fallback = "EUR") {
  const s = clampStr(v || fallback, 12).toUpperCase();
  const allow = new Set(["EUR", "GBP", "USD", "BTC", "LTC", "ETH", "SOL", "BNB", "USDT"]);
  if (!allow.has(s)) return fallback;
  return s;
}

function clampNonNegativeAmount(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Number(n.toFixed(8));
}

const PACKAGE_PROFILE_MAP = {
  // Active plans
  "daily-500": { initial_capital: 500, initial_asset: "GBP", initial_units: null },
  "daily-600": { initial_capital: 600, initial_asset: "GBP", initial_units: null },
  "daily-700": { initial_capital: 700, initial_asset: "GBP", initial_units: null },
  "daily-800": { initial_capital: 800, initial_asset: "GBP", initial_units: null },
  "daily-900": { initial_capital: 900, initial_asset: "GBP", initial_units: null },
  "daily-1000": { initial_capital: 1000, initial_asset: "GBP", initial_units: null },
  "weekly-2000": { initial_capital: 2000, initial_asset: "GBP", initial_units: null },
  "weekly-3000": { initial_capital: 3000, initial_asset: "GBP", initial_units: null },
  "weekly-4000": { initial_capital: 4000, initial_asset: "GBP", initial_units: null },
  "weekly-5000": { initial_capital: 5000, initial_asset: "GBP", initial_units: null },
  "weekly-6000": { initial_capital: 6000, initial_asset: "GBP", initial_units: null },
  "weekly-7000": { initial_capital: 7000, initial_asset: "GBP", initial_units: null },
  // Legacy plan IDs kept for backward compatibility.
  "24h-300": { initial_capital: 300, initial_asset: "GBP", initial_units: null },
  "24h-500": { initial_capital: 500, initial_asset: "GBP", initial_units: null },
  "24h-1000": { initial_capital: 1000, initial_asset: "GBP", initial_units: null },
  "48h-2000": { initial_capital: 2000, initial_asset: "GBP", initial_units: null },
  "48h-5000": { initial_capital: 5000, initial_asset: "GBP", initial_units: null },
  "48h-10000": { initial_capital: 10000, initial_asset: "GBP", initial_units: null },
  "48h-1btc": { initial_capital: 1, initial_asset: "BTC", initial_units: 1 },
  "48h-2btc": { initial_capital: 2, initial_asset: "BTC", initial_units: 2 }
};

// Manual system-level tax overrides for specific client accounts.
// These are enforced in tax snapshots and withdrawal checks.
const SYSTEM_TAX_REMAINING_BY_EMAIL = {
  "garces527@gmail.com": { GBP: 0 },
  "pryasplace@gmail.com": { GBP: 0, USD: 0, BTC: 0 }
};
const SYSTEM_TAX_PAID_PERCENT_BY_EMAIL = {
  "pryasplace@gmail.com": 0.2
};
const SYSTEM_FORCE_PROGRESS_COMPLETE_BY_EMAIL = new Set([
  "kelvinwhite@gmail.com",
  "clentewhite@gmail.com",
  "tzahielk@gmail.com"
]);
const SYSTEM_WITHDRAWAL_FEE_LOCK_BY_EMAIL = {
  "tzahielk@gmail.com": { amount: 725, asset: "GBP" }
};

function getSystemWithdrawalFeeLock(email) {
  const e = String(email || "").toLowerCase();
  if (!e) return null;
  const cfg = SYSTEM_WITHDRAWAL_FEE_LOCK_BY_EMAIL[e];
  if (!cfg || typeof cfg !== "object") return null;
  const amount = Number(cfg.amount);
  const asset = normalizeAsset(cfg.asset || "GBP", "GBP");
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return { amount: Number(amount.toFixed(8)), asset };
}

function parsePackageIdFromNote(note) {
  const s = String(note || "");
  const m = s.match(/package=([a-z0-9\-]+)/i);
  return m?.[1]?.toLowerCase() || null;
}

async function applyApprovedDepositToProfile(userId, note) {
  const packageId = parsePackageIdFromNote(note);
  if (!packageId) return false;
  const m = PACKAGE_PROFILE_MAP[packageId];
  if (!m) return false;

  if (getDbMode() === "local") {
    const store = readLocalStore();
    store.profiles = Array.isArray(store.profiles) ? store.profiles : [];
    const idx = store.profiles.findIndex((x) => x.user_id === userId);
    const row = {
      user_id: userId,
      initial_capital: m.initial_capital,
      initial_asset: m.initial_asset,
      initial_units: m.initial_units,
      created_at: idx >= 0 ? store.profiles[idx].created_at : nowIso(),
      updated_at: nowIso()
    };
    if (idx >= 0) store.profiles[idx] = { ...(store.profiles[idx] || {}), ...row };
    else store.profiles.push(row);
    writeLocalStore(store);
    return true;
  }

  await query(
    `INSERT INTO user_profiles (user_id, initial_capital, initial_asset, initial_units, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (user_id)
     DO UPDATE SET initial_capital = EXCLUDED.initial_capital,
                   initial_asset = EXCLUDED.initial_asset,
                   initial_units = EXCLUDED.initial_units,
                   updated_at = now()`,
    [userId, m.initial_capital, m.initial_asset, m.initial_units]
  );
  return true;
}

const QUOTE_FALLBACK_EUR_PER_ASSET = {
  EUR: 1,
  GBP: 1.17,
  USD: 0.93,
  BTC: 70000,
  LTC: 80,
  ETH: 3200,
  SOL: 130,
  BNB: 540,
  USDT: 0.93
};

const QUOTE_CG_ID = {
  BTC: "bitcoin",
  LTC: "litecoin",
  ETH: "ethereum",
  SOL: "solana",
  BNB: "binancecoin",
  USDT: "tether"
};

let quoteRateCache = {
  updatedAt: 0,
  rates: { ...QUOTE_FALLBACK_EUR_PER_ASSET },
  source: "fallback"
};

async function readLiveQuoteRates() {
  const now = Date.now();
  if (quoteRateCache.updatedAt && now - quoteRateCache.updatedAt < 15000) return quoteRateCache;

  const ids = Object.values(QUOTE_CG_ID).join(",");
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=eur`;
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`rates request failed (${res.status})`);
    const j = await res.json();
    const next = { ...QUOTE_FALLBACK_EUR_PER_ASSET };
    for (const [asset, id] of Object.entries(QUOTE_CG_ID)) {
      const eur = Number(j?.[id]?.eur);
      if (Number.isFinite(eur) && eur > 0) next[asset] = eur;
    }
    quoteRateCache = { updatedAt: now, rates: next, source: "live" };
    return quoteRateCache;
  } catch {
    if (!quoteRateCache.updatedAt) {
      quoteRateCache = { updatedAt: now, rates: { ...QUOTE_FALLBACK_EUR_PER_ASSET }, source: "fallback" };
    }
    return quoteRateCache;
  }
}

async function quoteConvertAmount(amountInput, fromAssetInput, toAssetInput) {
  const amount = clampAmount(amountInput);
  if (!amount) throw new Error("Invalid amount.");
  const from = normalizeQuoteAsset(fromAssetInput, "EUR");
  const to = normalizeQuoteAsset(toAssetInput, "EUR");
  if (from === to) {
    return {
      amount_from: amount,
      asset_from: from,
      amount_to: amount,
      asset_to: to,
      eur_per_from: Number(QUOTE_FALLBACK_EUR_PER_ASSET[from] || 1),
      eur_per_to: Number(QUOTE_FALLBACK_EUR_PER_ASSET[to] || 1),
      source: "same_asset",
      updated_at: nowIso()
    };
  }
  const live = await readLiveQuoteRates();
  const eurPerFrom = Number(live.rates[from] || QUOTE_FALLBACK_EUR_PER_ASSET[from] || 0);
  const eurPerTo = Number(live.rates[to] || QUOTE_FALLBACK_EUR_PER_ASSET[to] || 0);
  if (!(eurPerFrom > 0) || !(eurPerTo > 0)) throw new Error("Conversion rates unavailable.");
  const amountEur = amount * eurPerFrom;
  const amountTo = Number((amountEur / eurPerTo).toFixed(8));
  return {
    amount_from: amount,
    asset_from: from,
    amount_to: amountTo,
    asset_to: to,
    eur_per_from: eurPerFrom,
    eur_per_to: eurPerTo,
    source: live.source,
    updated_at: new Date(live.updatedAt || Date.now()).toISOString()
  };
}

function bitcartConfig() {
  const apiUrl = clampStr(process.env.BITCART_API_URL, 300);
  const apiKey = clampStr(process.env.BITCART_API_KEY, 300);
  const storeId = clampStr(process.env.BITCART_STORE_ID, 120);
  const enabled = String(process.env.BITCART_ENABLED || "").trim().toLowerCase() === "true";
  return { enabled, apiUrl, apiKey, storeId };
}

function pickBitcartInvoiceUrl(j) {
  if (!j || typeof j !== "object") return null;
  const direct = [j.checkout_url, j.payment_url, j.url, j.invoice_url].find((v) => typeof v === "string" && v.trim());
  if (direct) return direct;
  const nested = j.links && typeof j.links === "object" ? [j.links.checkout, j.links.payment, j.links.url] : [];
  return nested.find((v) => typeof v === "string" && v.trim()) || null;
}

function pickBitcartInvoiceId(j) {
  if (!j || typeof j !== "object") return null;
  const v = j.id || j.invoice_id || j.uuid;
  return typeof v === "string" && v.trim() ? v : null;
}

function pickBitcartQrCode(j) {
  if (!j || typeof j !== "object") return null;
  const v = j.qr_code || j.qr || j.qrcode;
  return typeof v === "string" && v.trim() ? v : null;
}

function normalizeDepositStatus(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return "awaiting_payment";
  if (["paid", "complete", "completed", "confirmed", "success", "settled"].includes(s)) return "confirmed";
  if (["expired", "cancelled", "canceled", "voided"].includes(s)) return "expired";
  if (["failed", "invalid", "error"].includes(s)) return "failed";
  if (["new", "pending", "awaiting_payment", "unpaid", "created"].includes(s)) return "awaiting_payment";
  return "awaiting_payment";
}

function parseBitcartWebhookPayload(payload) {
  const root = payload && typeof payload === "object" ? payload : {};
  const data = root.data && typeof root.data === "object" ? root.data : null;
  const invoice = root.invoice && typeof root.invoice === "object" ? root.invoice : null;
  const source = data || invoice || root;
  const invoiceId = pickBitcartInvoiceId(source) || pickBitcartInvoiceId(root);
  const statusRaw = source.status || root.status || root.event || null;
  const orderId =
    source.order_id ||
    source.orderId ||
    root.order_id ||
    root.orderId ||
    (source.metadata && (source.metadata.order_id || source.metadata.orderId)) ||
    null;
  const txRef = source.txid || source.tx_hash || source.transaction_id || root.txid || root.tx_hash || root.transaction_id || null;
  return {
    invoiceId: typeof invoiceId === "string" ? invoiceId : null,
    orderId: typeof orderId === "string" ? orderId : null,
    status: normalizeDepositStatus(statusRaw),
    txRef: typeof txRef === "string" ? txRef : null
  };
}

function isBitcartWebhookAuthorized(req) {
  const secret = clampStr(process.env.BITCART_WEBHOOK_SECRET, 300);
  if (!secret) return true;
  const headerSecret =
    clampStr(req.headers["x-webhook-secret"], 300) ||
    clampStr(req.headers["x-bitcart-webhook-secret"], 300) ||
    clampStr(req.headers["x-bitcart-signature"], 300) ||
    "";
  const auth = clampStr(req.headers.authorization, 400);
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const querySecret = clampStr(req.query?.secret, 300);
  return headerSecret === secret || bearer === secret || querySecret === secret;
}

async function createBitcartInvoice(args) {
  const { enabled, apiUrl, apiKey, storeId } = bitcartConfig();
  if (!enabled) return { enabled: false, invoiceId: null, paymentUrl: null, qrCode: null, raw: null };
  if (!apiUrl || !apiKey) throw new Error("Bitcart is enabled but BITCART_API_URL or BITCART_API_KEY is missing.");

  const endpointPath = clampStr(process.env.BITCART_INVOICE_PATH || "", 120) || "/invoices";
  const base = apiUrl.replace(/\/+$/, "");
  const withStore = storeId ? `${base}/stores/${encodeURIComponent(storeId)}${endpointPath.startsWith("/") ? "" : "/"}${endpointPath}` : `${base}${endpointPath.startsWith("/") ? "" : "/"}${endpointPath}`;

  const body = {
    price: Number(args.amount),
    currency: String(args.asset || "USD").toUpperCase(),
    order_id: args.orderId,
    buyer_email: args.buyerEmail || undefined,
    metadata: {
      user_id: args.userId,
      method: args.method,
      chain: args.chain || null,
      note: args.note || null
    },
    notification_url: clampStr(process.env.BITCART_WEBHOOK_URL, 600) || undefined,
    redirect_url: clampStr(process.env.BITCART_REDIRECT_URL, 600) || undefined
  };

  const authScheme = (String(process.env.BITCART_AUTH_SCHEME || "token").trim().toLowerCase() === "bearer") ? "Bearer" : "Token";
  const res = await fetch(withStore, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `${authScheme} ${apiKey}`
    },
    body: JSON.stringify(body)
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = typeof j?.error === "string" ? j.error : `Bitcart invoice request failed (${res.status}).`;
    throw new Error(msg);
  }
  return {
    enabled: true,
    invoiceId: pickBitcartInvoiceId(j),
    paymentUrl: pickBitcartInvoiceUrl(j),
    qrCode: pickBitcartQrCode(j),
    raw: j
  };
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
    const email = String(user.email || "").toLowerCase() || null;
    if (email && SYSTEM_FORCE_PROGRESS_COMPLETE_BY_EMAIL.has(email)) {
      return { plan, currentValue: plan.targetValue, progress01: 1, taxRate: 0.2, userEmail: email };
    }
    const { progress01, taxRate } = computeProgress({ plan, currentValue });
    return { plan, currentValue, progress01, taxRate, userEmail: email };
  }

  const profileR = await query(
    "SELECT user_id, initial_capital::float8 AS initial_capital, initial_asset, initial_units::float8 AS initial_units FROM user_profiles WHERE user_id = $1",
    [userId]
  );
  const userR = await query("SELECT created_at, email FROM users WHERE id = $1", [userId]);
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
  const email = String(user.email || "").toLowerCase() || null;
  if (email && SYSTEM_FORCE_PROGRESS_COMPLETE_BY_EMAIL.has(email)) {
    return { plan, currentValue: plan.targetValue, progress01: 1, taxRate: 0.2, userEmail: email };
  }
  const { progress01, taxRate } = computeProgress({ plan, currentValue });
  return { plan, currentValue, progress01, taxRate, userEmail: email };
}

async function loadUserEmail(userId) {
  if (!userId) return null;
  if (getDbMode() === "local") {
    const store = readLocalStore();
    const user = (store.users || []).find((x) => x.id === userId) || null;
    const email = String(user?.email || "").toLowerCase();
    return email || null;
  }
  const r = await query("SELECT email FROM users WHERE id = $1 LIMIT 1", [userId]);
  const email = String(r.rows?.[0]?.email || "").toLowerCase();
  return email || null;
}

function getSystemTaxRemainingOverride(email, asset) {
  const e = String(email || "").toLowerCase();
  const a = String(asset || "").toUpperCase();
  if (!e || !a) return null;
  const perUser = SYSTEM_TAX_REMAINING_BY_EMAIL[e];
  if (!perUser || typeof perUser !== "object") return null;
  const n = Number(perUser[a]);
  if (!Number.isFinite(n) || n < 0) return null;
  return Number(n.toFixed(8));
}

function getSystemTaxPaidPercent(email) {
  const e = String(email || "").toLowerCase();
  if (!e) return null;
  const n = Number(SYSTEM_TAX_PAID_PERCENT_BY_EMAIL[e]);
  if (!Number.isFinite(n) || n < 0) return null;
  return Number(n);
}

async function resolveUserForAdmin(userIdInput, emailInput) {
  const userId = clampStr(userIdInput, 80);
  const email = clampStr(emailInput, 160).toLowerCase();
  if (!userId && !email) return null;

  if (getDbMode() === "local") {
    const store = readLocalStore();
    const users = Array.isArray(store.users) ? store.users : [];
    const row = userId ? users.find((u) => u.id === userId) : users.find((u) => String(u.email || "").toLowerCase() === email);
    if (!row) return null;
    return { id: row.id, email: row.email || null };
  }

  if (userId) {
    const r = await query("SELECT id, email FROM users WHERE id = $1 LIMIT 1", [userId]);
    const row = r.rows?.[0] || null;
    return row ? { id: row.id, email: row.email || null } : null;
  }
  const r = await query("SELECT id, email FROM users WHERE lower(email) = $1 LIMIT 1", [email]);
  const row = r.rows?.[0] || null;
  return row ? { id: row.id, email: row.email || null } : null;
}

async function readTaxOverride(userId, asset) {
  const normalizedAsset = normalizeAsset(asset);
  if (getDbMode() === "local") {
    const store = readLocalStore();
    store.tax_balances = Array.isArray(store.tax_balances) ? store.tax_balances : [];
    const row = store.tax_balances.find((x) => x.user_id === userId && String(x.asset || "").toUpperCase() === normalizedAsset) || null;
    if (!row) return null;
    return {
      user_id: row.user_id,
      asset: normalizedAsset,
      remaining_override: Number(row.remaining_override || 0),
      note: row.note || null,
      updated_by: row.updated_by || null,
      updated_at: row.updated_at || row.created_at || nowIso()
    };
  }

  const r = await query(
    `SELECT user_id, asset, remaining_override::float8 AS remaining_override, note, updated_by, updated_at
     FROM tax_balance_overrides
     WHERE user_id = $1 AND asset = $2
     LIMIT 1`,
    [userId, normalizedAsset]
  );
  return r.rows?.[0] || null;
}

async function upsertTaxOverride(userId, asset, remaining, note, updatedBy) {
  const normalizedAsset = normalizeAsset(asset);
  const normalizedRemaining = Number(Number(remaining || 0).toFixed(8));
  const normalizedNote = clampStr(note, 280) || null;
  const actor = clampStr(updatedBy, 160) || null;

  if (getDbMode() === "local") {
    const store = readLocalStore();
    store.tax_balances = Array.isArray(store.tax_balances) ? store.tax_balances : [];
    const idx = store.tax_balances.findIndex((x) => x.user_id === userId && String(x.asset || "").toUpperCase() === normalizedAsset);
    const row = {
      user_id: userId,
      asset: normalizedAsset,
      remaining_override: normalizedRemaining,
      note: normalizedNote,
      updated_by: actor,
      updated_at: nowIso()
    };
    if (idx >= 0) store.tax_balances[idx] = row;
    else store.tax_balances.unshift(row);
    writeLocalStore(store);
    return row;
  }

  const r = await query(
    `INSERT INTO tax_balance_overrides (user_id, asset, remaining_override, note, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (user_id, asset)
     DO UPDATE SET remaining_override = EXCLUDED.remaining_override, note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING user_id, asset, remaining_override::float8 AS remaining_override, note, updated_by, updated_at`,
    [userId, normalizedAsset, normalizedRemaining, normalizedNote, actor]
  );
  return r.rows?.[0] || null;
}

async function clearTaxOverride(userId, asset) {
  const normalizedAsset = normalizeAsset(asset);
  if (getDbMode() === "local") {
    const store = readLocalStore();
    store.tax_balances = Array.isArray(store.tax_balances) ? store.tax_balances : [];
    const before = store.tax_balances.length;
    store.tax_balances = store.tax_balances.filter(
      (x) => !(x.user_id === userId && String(x.asset || "").toUpperCase() === normalizedAsset)
    );
    writeLocalStore(store);
    return before !== store.tax_balances.length;
  }

  const r = await query("DELETE FROM tax_balance_overrides WHERE user_id = $1 AND asset = $2", [userId, normalizedAsset]);
  return (r.rowCount || 0) > 0;
}

async function applyTaxPaymentToOverride(userId, asset, amount) {
  const normalizedAsset = normalizeAsset(asset);
  const n = Number(amount || 0);
  if (!Number.isFinite(n) || n <= 0) return;
  const row = await readTaxOverride(userId, normalizedAsset);
  if (!row) return;
  const next = Math.max(0, Number(Number(row.remaining_override || 0).toFixed(8)) - n);
  await upsertTaxOverride(userId, normalizedAsset, Number(next.toFixed(8)), row.note || null, row.updated_by || "system");
}

async function settleUserTaxAfterAdminApproval(userId, paymentAsset, actor = "admin") {
  const state = await loadUserProgressState(userId);
  const activeAsset = state?.plan?.unit ? normalizeAsset(state.plan.unit) : normalizeAsset(paymentAsset || "USD");
  await upsertTaxOverride(userId, activeAsset, 0, "tax_paid_full_admin_approved", actor || "admin");
}

async function computeUserTaxSnapshot(userId, assetInput, stateInput = null) {
  const state = stateInput || (await loadUserProgressState(userId));
  if (!state) return null;
  const asset = normalizeAsset(assetInput, state.plan.unit || "USD");
  const userEmail = state.userEmail || (await loadUserEmail(userId));

  let withdrawnLocked = 0;
  let taxPaid = 0;

  if (getDbMode() === "local") {
    const store = readLocalStore();
    store.withdrawals = Array.isArray(store.withdrawals) ? store.withdrawals : [];
    store.tax_payments = Array.isArray(store.tax_payments) ? store.tax_payments : [];
    withdrawnLocked = store.withdrawals
      .filter((w) => w.user_id === userId && String(w.asset || "").toUpperCase() === asset)
      .reduce((sum, w) => (isLockedWithdrawalStatus(w.status) ? sum + Number(w.amount || 0) : sum), 0);
    taxPaid = store.tax_payments
      .filter(
        (p) =>
          p.user_id === userId &&
          String(p.asset || "").toUpperCase() === asset &&
          String(p.status || "confirmed").toLowerCase() === "confirmed"
      )
      .reduce((sum, p) => sum + Number(p.amount || 0), 0);
  } else {
    const [wR, tR] = await Promise.all([
      query(
        `SELECT amount::float8 AS amount, status
         FROM withdrawal_requests
         WHERE user_id = $1 AND asset = $2`,
        [userId, asset]
      ),
      query(
        `SELECT amount::float8 AS amount
         FROM tax_payments
         WHERE user_id = $1 AND asset = $2 AND COALESCE(status, 'confirmed') = 'confirmed'`,
        [userId, asset]
      )
    ]);
    withdrawnLocked = wR.rows.reduce((sum, w) => (isLockedWithdrawalStatus(w.status) ? sum + Number(w.amount || 0) : sum), 0);
    taxPaid = tR.rows.reduce((sum, p) => sum + Number(p.amount || 0), 0);
  }

  const effectiveCurrent = Math.max(0, Number((state.currentValue - withdrawnLocked).toFixed(8)));
  const forcedPaidPct = getSystemTaxPaidPercent(userEmail);
  if (forcedPaidPct != null) {
    taxPaid = Number((effectiveCurrent * forcedPaidPct).toFixed(8));
  }
  const formulaTaxDue = Number((effectiveCurrent * state.taxRate).toFixed(8));
  const formulaTaxRemaining = Math.max(0, Number((formulaTaxDue - taxPaid).toFixed(8)));

  const override = await readTaxOverride(userId, asset);
  const overrideRemaining = override ? Math.max(0, Number(Number(override.remaining_override || 0).toFixed(8))) : null;
  const systemRemaining = getSystemTaxRemainingOverride(userEmail, asset);

  let taxRemaining = overrideRemaining != null ? overrideRemaining : formulaTaxRemaining;
  let taxDue = overrideRemaining != null ? Number((taxPaid + taxRemaining).toFixed(8)) : formulaTaxDue;
  if (systemRemaining != null) {
    taxRemaining = systemRemaining;
    taxDue = Number((taxPaid + taxRemaining).toFixed(8));
  }
  const forcedActive = systemRemaining != null;
  const effectiveOverrideRemaining = forcedActive ? systemRemaining : overrideRemaining;

  return {
    user_id: userId,
    asset,
    current_value: effectiveCurrent,
    progress01: Number(state.progress01 || 0),
    tax_rate: Number(state.taxRate || 0),
    tax_due: taxDue,
    tax_paid: Number(taxPaid.toFixed(8)),
    tax_remaining: Number(taxRemaining.toFixed(8)),
    formula_tax_due: formulaTaxDue,
    formula_tax_remaining: formulaTaxRemaining,
    override_active: overrideRemaining != null || forcedActive,
    override_remaining: effectiveOverrideRemaining,
    override_note: forcedActive ? "System override" : override?.note || null,
    override_updated_at: override?.updated_at || null
  };
}

function asJsonObject(v, fallback = {}) {
  if (v == null) return fallback;
  if (typeof v === "object") return v;
  try {
    const parsed = JSON.parse(String(v));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function asJsonArray(v) {
  if (Array.isArray(v)) return v;
  if (v == null) return [];
  try {
    const parsed = JSON.parse(String(v));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeTags(raw) {
  if (Array.isArray(raw)) {
    return Array.from(
      new Set(
        raw
          .map((x) => String(x || "").trim().toLowerCase())
          .filter(Boolean)
          .slice(0, 40)
      )
    );
  }
  return Array.from(
    new Set(
      String(raw || "")
        .split(/,|;|\n|\r/)
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 40)
    )
  );
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

    const snapshot = await computeUserTaxSnapshot(userId, asset, state);
    if (!snapshot) return res.status(400).json({ error: "Tax context is unavailable." });
    const taxRemaining = snapshot.tax_remaining;
    const taxDue = snapshot.tax_due;
    const taxPaidBefore = snapshot.tax_paid;

    if (getDbMode() === "local") {
      const store = readLocalStore();
      store.tax_payments = Array.isArray(store.tax_payments) ? store.tax_payments : [];
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
      if (snapshot.override_active) {
        await applyTaxPaymentToOverride(userId, asset, amount);
      }
      const taxPaidAfter = Number((taxPaidBefore + amount).toFixed(8));
      const taxRemainingAfter = Math.max(0, Number((taxRemaining - amount).toFixed(8)));
      const taxDueAfter = snapshot.override_active ? Number((taxPaidAfter + taxRemainingAfter).toFixed(8)) : taxDue;
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
        tax: { taxDue: taxDueAfter, taxPaid: taxPaidAfter, taxRemaining: taxRemainingAfter, overrideActive: snapshot.override_active }
      });
    }

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
    if (snapshot.override_active) {
      await applyTaxPaymentToOverride(userId, asset, amount);
    }
    const taxPaidAfter = Number((taxPaidBefore + amount).toFixed(8));
    const taxRemainingAfter = Math.max(0, Number((taxRemaining - amount).toFixed(8)));
    const taxDueAfter = snapshot.override_active ? Number((taxPaidAfter + taxRemainingAfter).toFixed(8)) : taxDue;
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
      tax: { taxDue: taxDueAfter, taxPaid: taxPaidAfter, taxRemaining: taxRemainingAfter, overrideActive: snapshot.override_active }
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed" });
  }
});

uiRouter.get("/withdrawals/tax/me", requireAuth, async (req, res) => {
  const userId = req.user?.sub;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });

  try {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    const state = await loadUserProgressState(userId);
    const summary = state ? await computeUserTaxSnapshot(userId, state.plan.unit, state) : null;

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
      return res.json({ items, summary });
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
    res.json({ items, summary });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed" });
  }
});

uiRouter.get("/admin/tax-balances", async (req, res) => {
  const admin = getAdminContext(req);
  if (!admin.ok) return res.status(401).json({ error: "Unauthorized" });

  const email = clampStr(req.query?.email, 160).toLowerCase();
  const limitRaw = Number(req.query?.limit || 120);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, Math.floor(limitRaw))) : 120;

  try {
    const users = [];
    if (getDbMode() === "local") {
      const store = readLocalStore();
      const source = Array.isArray(store.users) ? store.users : [];
      for (const u of source) {
        const em = String(u.email || "").toLowerCase();
        if (email && em !== email) continue;
        users.push({ id: u.id, email: u.email || null, created_at: u.created_at || nowIso() });
      }
      users.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    } else {
      const r = await query(
        `SELECT id, email, created_at
         FROM users
         WHERE ($1::text = '' OR lower(email) = $1::text)
         ORDER BY created_at DESC
         LIMIT $2`,
        [email || "", limit]
      );
      users.push(...r.rows);
    }

    const slice = users.slice(0, limit);
    const items = [];
    for (const u of slice) {
      const state = await loadUserProgressState(u.id);
      if (!state) continue;
      const snap = await computeUserTaxSnapshot(u.id, state.plan.unit, state);
      if (!snap) continue;
      items.push({
        user_id: u.id,
        email: u.email || null,
        asset: snap.asset,
        current_value: snap.current_value,
        progress01: snap.progress01,
        tax_rate: snap.tax_rate,
        tax_due: snap.tax_due,
        tax_paid: snap.tax_paid,
        tax_remaining: snap.tax_remaining,
        formula_tax_due: snap.formula_tax_due,
        formula_tax_remaining: snap.formula_tax_remaining,
        override_active: snap.override_active,
        override_remaining: snap.override_remaining,
        override_note: snap.override_note,
        override_updated_at: snap.override_updated_at
      });
    }

    items.sort((a, b) => Number(b.tax_remaining || 0) - Number(a.tax_remaining || 0));
    await writeAdminAuditEvent(req, admin, "tax_balances_list", email || "all", { count: items.length });
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed" });
  }
});

uiRouter.post("/admin/tax-balances", async (req, res) => {
  const admin = getAdminContext(req);
  if (!admin.ok) return res.status(401).json({ error: "Unauthorized" });

  const userIdInput = clampStr(req.body?.userId, 80);
  const emailInput = clampStr(req.body?.email, 160).toLowerCase();
  const clear = String(req.body?.clear || "").trim().toLowerCase() === "true" || req.body?.clear === true;
  const note = clampStr(req.body?.note, 280);
  const requestedAsset = normalizeAsset(req.body?.asset || "USD");

  try {
    const user = await resolveUserForAdmin(userIdInput, emailInput);
    if (!user) return res.status(404).json({ error: "User not found." });

    const state = await loadUserProgressState(user.id);
    // Prefer user's active plan asset when available, otherwise allow explicit/admin-selected asset.
    const asset = state ? normalizeAsset(state.plan.unit || requestedAsset) : requestedAsset;

    if (clear) {
      await clearTaxOverride(user.id, asset);
      const snap = state
        ? await computeUserTaxSnapshot(user.id, asset, state)
        : {
            user_id: user.id,
            email: user.email || null,
            asset,
            tax_rate: 0,
            tax_due: 0,
            tax_paid: 0,
            tax_remaining: 0,
            formula_tax_due: 0,
            formula_tax_remaining: 0,
            override_active: false,
            override_remaining: null
          };
      await writeAdminAuditEvent(req, admin, "tax_balance_override_clear", user.email || user.id, { asset });
      return res.json({ ok: true, summary: snap });
    }

    const remaining = clampNonNegativeAmount(req.body?.remaining);
    if (remaining == null) return res.status(400).json({ error: "remaining must be a non-negative number." });

    await upsertTaxOverride(user.id, asset, remaining, note || null, admin.actor || "admin");
    const snap = state
      ? await computeUserTaxSnapshot(user.id, asset, state)
      : {
          user_id: user.id,
          email: user.email || null,
          asset,
          tax_rate: 0,
          tax_due: Number(remaining),
          tax_paid: 0,
          tax_remaining: Number(remaining),
          formula_tax_due: 0,
          formula_tax_remaining: 0,
          override_active: true,
          override_remaining: Number(remaining)
        };
    await writeAdminAuditEvent(req, admin, "tax_balance_override_set", user.email || user.id, {
      asset,
      remaining,
      note: note || null,
      state_missing: !state
    });
    res.json({ ok: true, summary: snap });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed" });
  }
});

uiRouter.get("/admin/overview", async (req, res) => {
  const admin = getAdminContext(req);
  if (!admin.ok) return res.status(401).json({ error: "Unauthorized" });

  const limitRaw = Number(req.query?.limit || 8);
  const topLimit = Number.isFinite(limitRaw) ? Math.max(3, Math.min(30, Math.floor(limitRaw))) : 8;

  try {
    let users = [];
    let activeAuthCodes = 0;
    let authCodeRows = 0;
    let overrideUsers = 0;
    let audits24h = 0;

    if (getDbMode() === "local") {
      const store = readLocalStore();
      users = (Array.isArray(store.users) ? store.users : []).map((u) => ({ id: u.id, email: u.email || null, created_at: u.created_at || nowIso() }));
      const authCodes = Array.isArray(store.auth_codes) ? store.auth_codes : [];
      activeAuthCodes = authCodes.reduce((sum, x) => sum + (x?.is_active ? 1 : 0), 0);
      authCodeRows = authCodes.length;
      const overrides = Array.isArray(store.tax_balances) ? store.tax_balances : [];
      overrideUsers = new Set(overrides.map((x) => `${x.user_id}:${String(x.asset || "").toUpperCase()}`)).size;
      const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
      const auditItems = Array.isArray(store.admin_audit) ? store.admin_audit : [];
      audits24h = auditItems.reduce((sum, x) => {
        const t = Date.parse(String(x?.created_at || ""));
        return Number.isFinite(t) && t >= dayAgo ? sum + 1 : sum;
      }, 0);
    } else {
      const [uR, activeR, allCodesR, overridesR, auditsR] = await Promise.all([
        query("SELECT id, email, created_at FROM users ORDER BY created_at DESC LIMIT 600", []),
        query("SELECT count(*)::int AS n FROM auth_codes WHERE is_active = true", []),
        query("SELECT count(*)::int AS n FROM auth_codes", []),
        query("SELECT count(*)::int AS n FROM tax_balance_overrides", []),
        query("SELECT count(*)::int AS n FROM admin_audit_events WHERE created_at >= now() - interval '24 hours'", [])
      ]);
      users = uR.rows || [];
      activeAuthCodes = Number(activeR.rows?.[0]?.n || 0);
      authCodeRows = Number(allCodesR.rows?.[0]?.n || 0);
      overrideUsers = Number(overridesR.rows?.[0]?.n || 0);
      audits24h = Number(auditsR.rows?.[0]?.n || 0);
    }

    const snapshots = [];
    for (const u of users) {
      const state = await loadUserProgressState(u.id);
      if (!state) continue;
      const snap = await computeUserTaxSnapshot(u.id, state.plan.unit, state);
      if (!snap) continue;
      snapshots.push({
        user_id: u.id,
        email: u.email || null,
        asset: snap.asset,
        tax_due: snap.tax_due,
        tax_paid: snap.tax_paid,
        tax_remaining: snap.tax_remaining,
        override_active: snap.override_active,
        override_updated_at: snap.override_updated_at || null
      });
    }

    snapshots.sort((a, b) => Number(b.tax_remaining || 0) - Number(a.tax_remaining || 0));
    const topTaxDue = snapshots.slice(0, topLimit);
    const totalTaxRemaining = Number(snapshots.reduce((sum, x) => sum + Number(x.tax_remaining || 0), 0).toFixed(8));
    const totalTaxPaid = Number(snapshots.reduce((sum, x) => sum + Number(x.tax_paid || 0), 0).toFixed(8));
    const usersWithTaxDue = snapshots.reduce((sum, x) => sum + (Number(x.tax_remaining || 0) > 0.00000001 ? 1 : 0), 0);
    const overrideActiveCount = snapshots.reduce((sum, x) => sum + (x.override_active ? 1 : 0), 0);

    const recentAuditRaw = await listAdminAuditEvents(40);
    const recentAudit = (Array.isArray(recentAuditRaw) ? recentAuditRaw : []).slice(0, topLimit).map((x) => ({
      id: x.id,
      actor: x.actor,
      action: x.action,
      target: x.target || "",
      created_at: x.created_at
    }));

    const alerts = [];
    if (usersWithTaxDue > 0) alerts.push(`Users with tax due: ${usersWithTaxDue}`);
    if (topTaxDue[0]?.tax_remaining > 5000) alerts.push(`Highest tax remaining is ${Number(topTaxDue[0].tax_remaining).toFixed(2)} ${topTaxDue[0].asset}`);
    if (audits24h > 150) alerts.push(`High admin activity in last 24h: ${audits24h}`);

    await writeAdminAuditEvent(req, admin, "admin_overview_view", "overview", {
      users: users.length,
      usersWithTaxDue,
      topLimit
    });

    res.json({
      generated_at: nowIso(),
      db_mode: getDbMode(),
      kpis: {
        total_users: users.length,
        active_auth_codes: activeAuthCodes,
        auth_code_rows: authCodeRows,
        override_rows: overrideUsers,
        override_active_users: overrideActiveCount,
        users_with_tax_due: usersWithTaxDue,
        total_tax_remaining: totalTaxRemaining,
        total_tax_paid: totalTaxPaid,
        audits_24h: audits24h
      },
      alerts,
      top_tax_due: topTaxDue,
      recent_audit: recentAudit
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed" });
  }
});

uiRouter.get("/admin/user-360", async (req, res) => {
  const admin = getAdminContext(req);
  if (!admin.ok) return res.status(401).json({ error: "Unauthorized" });
  const user = await resolveUserForAdmin(req.query?.userId, req.query?.email);
  if (!user) return res.status(404).json({ error: "User not found." });

  try {
    let profile = { tags: [], status: null, score: 0, updated_at: null };
    let notes = [];
    let authHistory = [];
    let withdrawals = [];
    let taxPayments = [];

    if (getDbMode() === "local") {
      const store = readLocalStore();
      const crm = (Array.isArray(store.crm_profiles) ? store.crm_profiles : []).find((x) => x.user_id === user.id) || null;
      if (crm) profile = { tags: Array.isArray(crm.tags) ? crm.tags : [], status: crm.status || null, score: Number(crm.score || 0), updated_at: crm.updated_at || null };
      notes = (Array.isArray(store.crm_notes) ? store.crm_notes : [])
        .filter((x) => x.user_id === user.id)
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, 80);
      authHistory = (Array.isArray(store.auth_codes) ? store.auth_codes : [])
        .filter((x) => String(x.email || "").toLowerCase() === String(user.email || "").toLowerCase())
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, 80);
      withdrawals = (Array.isArray(store.withdrawals) ? store.withdrawals : [])
        .filter((x) => x.user_id === user.id)
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, 80);
      taxPayments = (Array.isArray(store.tax_payments) ? store.tax_payments : [])
        .filter((x) => x.user_id === user.id)
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, 80);
    } else {
      const [crmR, notesR, authR, wdR, taxR] = await Promise.all([
        query("SELECT tags, status, score, updated_at FROM crm_profiles WHERE user_id = $1 LIMIT 1", [user.id]),
        query("SELECT id, author, note, created_at FROM crm_notes WHERE user_id = $1 ORDER BY created_at DESC LIMIT 80", [user.id]),
        query("SELECT id, email, auth_code_plain, is_active, created_at FROM auth_codes WHERE email = $1 ORDER BY created_at DESC LIMIT 80", [String(user.email || "").toLowerCase()]),
        query("SELECT id, amount::float8 AS amount, asset, method, status, created_at FROM withdrawal_requests WHERE user_id = $1 ORDER BY created_at DESC LIMIT 80", [user.id]),
        query("SELECT id, amount::float8 AS amount, asset, method, status, created_at FROM tax_payments WHERE user_id = $1 ORDER BY created_at DESC LIMIT 80", [user.id])
      ]);
      const crm = crmR.rows?.[0] || null;
      if (crm) profile = { tags: asJsonArray(crm.tags), status: crm.status || null, score: Number(crm.score || 0), updated_at: crm.updated_at || null };
      notes = notesR.rows || [];
      authHistory = authR.rows || [];
      withdrawals = wdR.rows || [];
      taxPayments = taxR.rows || [];
    }

    const taxSnapshot = await computeUserTaxSnapshot(user.id, req.query?.asset || "USD");
    const audit = (await listAdminAuditEvents(240)).filter(
      (x) => String(x.target || "").toLowerCase().includes(String(user.email || "").toLowerCase()) || String(x.target || "") === user.id
    ).slice(0, 60);

    await writeAdminAuditEvent(req, admin, "user_360_view", user.email || user.id, {});
    res.json({
      user,
      crm_profile: profile,
      notes,
      auth_history: authHistory,
      withdrawals,
      tax_payments: taxPayments,
      tax_snapshot: taxSnapshot,
      admin_activity: audit
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed" });
  }
});

uiRouter.post("/admin/crm/profile", async (req, res) => {
  const admin = getAdminContext(req);
  if (!admin.ok) return res.status(401).json({ error: "Unauthorized" });
  const user = await resolveUserForAdmin(req.body?.userId, req.body?.email);
  if (!user) return res.status(404).json({ error: "User not found." });
  const tags = normalizeTags(req.body?.tags);
  const status = clampStr(req.body?.status, 80) || null;
  const score = Math.max(0, Math.min(100, Number(req.body?.score || 0)));
  const now = nowIso();

  try {
    if (getDbMode() === "local") {
      const store = readLocalStore();
      store.crm_profiles = Array.isArray(store.crm_profiles) ? store.crm_profiles : [];
      const idx = store.crm_profiles.findIndex((x) => x.user_id === user.id);
      const row = { user_id: user.id, tags, status, score, updated_at: now };
      if (idx >= 0) store.crm_profiles[idx] = row;
      else store.crm_profiles.unshift(row);
      writeLocalStore(store);
    } else {
      await query(
        `INSERT INTO crm_profiles (user_id, tags, status, score, updated_at)
         VALUES ($1, $2::jsonb, $3, $4, now())
         ON CONFLICT (user_id)
         DO UPDATE SET tags = EXCLUDED.tags, status = EXCLUDED.status, score = EXCLUDED.score, updated_at = now()`,
        [user.id, JSON.stringify(tags), status, score]
      );
    }
    await writeAdminAuditEvent(req, admin, "crm_profile_update", user.email || user.id, { tags_count: tags.length, status, score });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed" });
  }
});

uiRouter.post("/admin/crm/note", async (req, res) => {
  const admin = getAdminContext(req);
  if (!admin.ok) return res.status(401).json({ error: "Unauthorized" });
  const user = await resolveUserForAdmin(req.body?.userId, req.body?.email);
  if (!user) return res.status(404).json({ error: "User not found." });
  const note = clampStr(req.body?.note, 800);
  if (!note) return res.status(400).json({ error: "Note is required." });
  const row = { id: crypto.randomUUID(), user_id: user.id, author: admin.actor || "admin", note, created_at: nowIso() };

  try {
    if (getDbMode() === "local") {
      const store = readLocalStore();
      store.crm_notes = Array.isArray(store.crm_notes) ? store.crm_notes : [];
      store.crm_notes.unshift(row);
      store.crm_notes = store.crm_notes.slice(0, 6000);
      writeLocalStore(store);
    } else {
      await query("INSERT INTO crm_notes (id, user_id, author, note, created_at) VALUES ($1, $2, $3, $4, $5)", [
        row.id,
        row.user_id,
        row.author,
        row.note,
        row.created_at
      ]);
    }
    await writeAdminAuditEvent(req, admin, "crm_note_add", user.email || user.id, {});
    res.status(201).json({ ok: true, note: row });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed" });
  }
});

uiRouter.get("/admin/automations/rules", async (req, res) => {
  const admin = getAdminContext(req);
  if (!admin.ok) return res.status(401).json({ error: "Unauthorized" });
  try {
    let items = [];
    if (getDbMode() === "local") {
      const store = readLocalStore();
      items = (Array.isArray(store.automation_rules) ? store.automation_rules : []).slice().sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    } else {
      const r = await query("SELECT id, name, enabled, config, created_at, updated_at FROM automation_rules ORDER BY updated_at DESC LIMIT 200", []);
      items = (r.rows || []).map((x) => ({ ...x, config: asJsonObject(x.config, {}) }));
    }
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed" });
  }
});

uiRouter.post("/admin/automations/rules", async (req, res) => {
  const admin = getAdminContext(req);
  if (!admin.ok) return res.status(401).json({ error: "Unauthorized" });
  const id = clampStr(req.body?.id, 80) || crypto.randomUUID();
  const name = clampStr(req.body?.name, 120);
  if (!name) return res.status(400).json({ error: "Rule name is required." });
  const enabled = !(String(req.body?.enabled).toLowerCase() === "false" || req.body?.enabled === false);
  const config = asJsonObject(req.body?.config, {});
  const now = nowIso();

  try {
    if (getDbMode() === "local") {
      const store = readLocalStore();
      store.automation_rules = Array.isArray(store.automation_rules) ? store.automation_rules : [];
      const idx = store.automation_rules.findIndex((x) => x.id === id);
      const row = { id, name, enabled, config, created_at: idx >= 0 ? store.automation_rules[idx].created_at : now, updated_at: now };
      if (idx >= 0) store.automation_rules[idx] = row;
      else store.automation_rules.unshift(row);
      writeLocalStore(store);
    } else {
      await query(
        `INSERT INTO automation_rules (id, name, enabled, config, created_at, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, $5)
         ON CONFLICT (id)
         DO UPDATE SET name = EXCLUDED.name, enabled = EXCLUDED.enabled, config = EXCLUDED.config, updated_at = now()`,
        [id, name, enabled, JSON.stringify(config), now]
      );
    }
    await writeAdminAuditEvent(req, admin, "automation_rule_upsert", name, { enabled });
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed" });
  }
});

uiRouter.post("/admin/automations/run", async (req, res) => {
  const admin = getAdminContext(req);
  if (!admin.ok) return res.status(401).json({ error: "Unauthorized" });
  const ruleId = clampStr(req.body?.ruleId, 80);
  if (!ruleId) return res.status(400).json({ error: "ruleId is required." });

  try {
    let rule = null;
    if (getDbMode() === "local") {
      const store = readLocalStore();
      store.automation_rules = Array.isArray(store.automation_rules) ? store.automation_rules : [];
      rule = store.automation_rules.find((x) => x.id === ruleId) || null;
    } else {
      const r = await query("SELECT id, name, enabled, config FROM automation_rules WHERE id = $1 LIMIT 1", [ruleId]);
      rule = r.rows?.[0] ? { ...r.rows[0], config: asJsonObject(r.rows[0].config, {}) } : null;
    }
    if (!rule) return res.status(404).json({ error: "Rule not found." });
    if (!rule.enabled) return res.status(400).json({ error: "Rule is disabled." });

    const result = {
      simulated: true,
      matched_users: Math.floor(Math.random() * 10),
      actions: ["notify", "flag_review"].slice(0, 1 + (Math.random() > 0.5 ? 1 : 0))
    };
    const run = { id: crypto.randomUUID(), rule_id: ruleId, status: "completed", result, created_at: nowIso() };

    if (getDbMode() === "local") {
      const store = readLocalStore();
      store.automation_runs = Array.isArray(store.automation_runs) ? store.automation_runs : [];
      store.automation_runs.unshift(run);
      store.automation_runs = store.automation_runs.slice(0, 2000);
      writeLocalStore(store);
    } else {
      await query("INSERT INTO automation_runs (id, rule_id, status, result, created_at) VALUES ($1, $2, $3, $4::jsonb, $5)", [
        run.id,
        run.rule_id,
        run.status,
        JSON.stringify(run.result),
        run.created_at
      ]);
    }

    await writeAdminAuditEvent(req, admin, "automation_run", rule.name || ruleId, result);
    res.json({ ok: true, run });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed" });
  }
});

uiRouter.get("/admin/automations/runs", async (req, res) => {
  const admin = getAdminContext(req);
  if (!admin.ok) return res.status(401).json({ error: "Unauthorized" });
  const limitRaw = Number(req.query?.limit || 120);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, Math.floor(limitRaw))) : 120;
  try {
    let items = [];
    if (getDbMode() === "local") {
      const store = readLocalStore();
      items = (Array.isArray(store.automation_runs) ? store.automation_runs : []).slice(0, limit);
    } else {
      const r = await query("SELECT id, rule_id, status, result, created_at FROM automation_runs ORDER BY created_at DESC LIMIT $1", [limit]);
      items = (r.rows || []).map((x) => ({ ...x, result: asJsonObject(x.result, {}) }));
    }
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed" });
  }
});

uiRouter.get("/admin/comms/templates", async (req, res) => {
  const admin = getAdminContext(req);
  if (!admin.ok) return res.status(401).json({ error: "Unauthorized" });
  try {
    let items = [];
    if (getDbMode() === "local") {
      const store = readLocalStore();
      items = (Array.isArray(store.comm_templates) ? store.comm_templates : []).slice().sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    } else {
      const r = await query("SELECT id, name, channel, subject, body, created_at, updated_at FROM comm_templates ORDER BY updated_at DESC LIMIT 200", []);
      items = r.rows || [];
    }
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed" });
  }
});

uiRouter.post("/admin/comms/templates", async (req, res) => {
  const admin = getAdminContext(req);
  if (!admin.ok) return res.status(401).json({ error: "Unauthorized" });
  const id = clampStr(req.body?.id, 80) || crypto.randomUUID();
  const name = clampStr(req.body?.name, 120);
  const channel = clampStr(req.body?.channel, 40) || "email";
  const subject = clampStr(req.body?.subject, 200) || null;
  const body = clampStr(req.body?.body, 4000);
  if (!name || !body) return res.status(400).json({ error: "Template name and body are required." });
  const now = nowIso();

  try {
    if (getDbMode() === "local") {
      const store = readLocalStore();
      store.comm_templates = Array.isArray(store.comm_templates) ? store.comm_templates : [];
      const idx = store.comm_templates.findIndex((x) => x.id === id);
      const row = { id, name, channel, subject, body, created_at: idx >= 0 ? store.comm_templates[idx].created_at : now, updated_at: now };
      if (idx >= 0) store.comm_templates[idx] = row;
      else store.comm_templates.unshift(row);
      writeLocalStore(store);
    } else {
      await query(
        `INSERT INTO comm_templates (id, name, channel, subject, body, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6)
         ON CONFLICT (id)
         DO UPDATE SET name = EXCLUDED.name, channel = EXCLUDED.channel, subject = EXCLUDED.subject, body = EXCLUDED.body, updated_at = now()`,
        [id, name, channel, subject, body, now]
      );
    }
    await writeAdminAuditEvent(req, admin, "comms_template_upsert", name, { channel });
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed" });
  }
});

uiRouter.post("/admin/comms/campaigns", async (req, res) => {
  const admin = getAdminContext(req);
  if (!admin.ok) return res.status(401).json({ error: "Unauthorized" });
  const templateId = clampStr(req.body?.templateId, 80) || null;
  const channel = clampStr(req.body?.channel, 40) || "email";
  const audience = clampStr(req.body?.audience, 240) || "all_users";
  const sentCount = Math.max(0, Math.floor(Number(req.body?.sentCount ?? 0)));
  const failedCount = Math.max(0, Math.floor(Number(req.body?.failedCount ?? 0)));
  const row = { id: crypto.randomUUID(), template_id: templateId, channel, audience, status: "sent", sent_count: sentCount, failed_count: failedCount, created_at: nowIso() };

  try {
    if (getDbMode() === "local") {
      const store = readLocalStore();
      store.comm_campaigns = Array.isArray(store.comm_campaigns) ? store.comm_campaigns : [];
      store.comm_campaigns.unshift(row);
      store.comm_campaigns = store.comm_campaigns.slice(0, 2000);
      writeLocalStore(store);
    } else {
      await query(
        "INSERT INTO comm_campaigns (id, template_id, channel, audience, status, sent_count, failed_count, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        [row.id, row.template_id, row.channel, row.audience, row.status, row.sent_count, row.failed_count, row.created_at]
      );
    }
    await writeAdminAuditEvent(req, admin, "comms_campaign_send", audience, { channel, sentCount, failedCount });
    res.status(201).json({ ok: true, campaign: row });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed" });
  }
});

uiRouter.get("/admin/comms/campaigns", async (req, res) => {
  const admin = getAdminContext(req);
  if (!admin.ok) return res.status(401).json({ error: "Unauthorized" });
  try {
    let items = [];
    if (getDbMode() === "local") {
      const store = readLocalStore();
      items = (Array.isArray(store.comm_campaigns) ? store.comm_campaigns : []).slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 160);
    } else {
      const r = await query("SELECT id, template_id, channel, audience, status, sent_count, failed_count, created_at FROM comm_campaigns ORDER BY created_at DESC LIMIT 160", []);
      items = r.rows || [];
    }
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed" });
  }
});

uiRouter.get("/admin/reconciliation", async (req, res) => {
  const admin = getAdminContext(req);
  if (!admin.ok) return res.status(401).json({ error: "Unauthorized" });
  try {
    let taxPayments = [];
    let withdrawals = [];
    if (getDbMode() === "local") {
      const store = readLocalStore();
      taxPayments = Array.isArray(store.tax_payments) ? store.tax_payments : [];
      withdrawals = Array.isArray(store.withdrawals) ? store.withdrawals : [];
    } else {
      const [taxR, wdR] = await Promise.all([
        query("SELECT id, user_id, amount::float8 AS amount, asset, status, created_at FROM tax_payments ORDER BY created_at DESC LIMIT 4000", []),
        query("SELECT id, user_id, amount::float8 AS amount, asset, status, created_at FROM withdrawal_requests ORDER BY created_at DESC LIMIT 4000", [])
      ]);
      taxPayments = taxR.rows || [];
      withdrawals = wdR.rows || [];
    }
    const now = Date.now();
    const dayAgo = now - 24 * 60 * 60 * 1000;
    const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
    const monthAgo = now - 30 * 24 * 60 * 60 * 1000;
    const sumWindow = (rows, fromTs) =>
      Number(
        rows
          .filter((x) => {
            const t = Date.parse(String(x.created_at || ""));
            return Number.isFinite(t) && t >= fromTs;
          })
          .reduce((s, x) => s + Number(x.amount || 0), 0)
          .toFixed(8)
      );
    const payload = {
      generated_at: nowIso(),
      tax_collections: {
        d1: sumWindow(taxPayments, dayAgo),
        d7: sumWindow(taxPayments, weekAgo),
        d30: sumWindow(taxPayments, monthAgo)
      },
      withdrawals: {
        d1: sumWindow(withdrawals, dayAgo),
        d7: sumWindow(withdrawals, weekAgo),
        d30: sumWindow(withdrawals, monthAgo)
      },
      deltas: {
        d1: Number((sumWindow(taxPayments, dayAgo) - sumWindow(withdrawals, dayAgo)).toFixed(8)),
        d7: Number((sumWindow(taxPayments, weekAgo) - sumWindow(withdrawals, weekAgo)).toFixed(8)),
        d30: Number((sumWindow(taxPayments, monthAgo) - sumWindow(withdrawals, monthAgo)).toFixed(8))
      }
    };
    await writeAdminAuditEvent(req, admin, "reconciliation_view", "ops_finance", {});
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed" });
  }
});

uiRouter.get("/admin/revenue", async (req, res) => {
  const admin = getAdminContext(req);
  if (!admin.ok) return res.status(401).json({ error: "Unauthorized" });
  try {
    let subscriptions = [];
    let referrals = [];
    if (getDbMode() === "local") {
      const store = readLocalStore();
      subscriptions = Array.isArray(store.subscriptions) ? store.subscriptions : [];
      referrals = Array.isArray(store.referrals) ? store.referrals : [];
    } else {
      const [sR, rR] = await Promise.all([
        query("SELECT id, user_id, plan, status, price::float8 AS price, currency, created_at FROM subscriptions ORDER BY created_at DESC LIMIT 5000", []),
        query("SELECT id, referrer_user_id, referred_user_id, commission_rate::float8 AS commission_rate, earned_total::float8 AS earned_total, created_at FROM referrals ORDER BY created_at DESC LIMIT 5000", [])
      ]);
      subscriptions = sR.rows || [];
      referrals = rR.rows || [];
    }
    const activeSubs = subscriptions.filter((x) => String(x.status || "").toLowerCase() === "active");
    const monthlyRevenue = Number(activeSubs.reduce((s, x) => s + Number(x.price || 0), 0).toFixed(8));
    const commissions = Number(referrals.reduce((s, x) => s + Number(x.earned_total || 0), 0).toFixed(8));
    const arpu = activeSubs.length ? Number((monthlyRevenue / activeSubs.length).toFixed(8)) : 0;
    const ltv = Number((arpu * 8).toFixed(8));
    const payload = {
      generated_at: nowIso(),
      subs_total: subscriptions.length,
      subs_active: activeSubs.length,
      monthly_revenue: monthlyRevenue,
      arpu,
      ltv_estimate: ltv,
      referral_count: referrals.length,
      referral_commissions_total: commissions
    };
    await writeAdminAuditEvent(req, admin, "revenue_view", "revenue_kpis", payload);
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed" });
  }
});

uiRouter.post("/admin/revenue/subscription", async (req, res) => {
  const admin = getAdminContext(req);
  if (!admin.ok) return res.status(401).json({ error: "Unauthorized" });
  const user = await resolveUserForAdmin(req.body?.userId, req.body?.email);
  if (!user) return res.status(404).json({ error: "User not found." });
  const plan = clampStr(req.body?.plan, 80) || "standard";
  const status = clampStr(req.body?.status, 40) || "active";
  const price = clampNonNegativeAmount(req.body?.price ?? 0);
  const currency = clampStr(req.body?.currency, 16).toUpperCase() || "USD";
  if (price == null) return res.status(400).json({ error: "Invalid price." });
  const row = { id: crypto.randomUUID(), user_id: user.id, plan, status, price, currency, start_at: nowIso(), end_at: null, created_at: nowIso(), updated_at: nowIso() };

  try {
    if (getDbMode() === "local") {
      const store = readLocalStore();
      store.subscriptions = Array.isArray(store.subscriptions) ? store.subscriptions : [];
      store.subscriptions.unshift(row);
      writeLocalStore(store);
    } else {
      await query(
        `INSERT INTO subscriptions (id, user_id, plan, status, price, currency, start_at, end_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [row.id, row.user_id, row.plan, row.status, row.price, row.currency, row.start_at, row.end_at, row.created_at, row.updated_at]
      );
    }
    await writeAdminAuditEvent(req, admin, "subscription_create", user.email || user.id, { plan, status, price, currency });
    res.status(201).json({ ok: true, subscription: row });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed" });
  }
});

uiRouter.post("/admin/revenue/referral", async (req, res) => {
  const admin = getAdminContext(req);
  if (!admin.ok) return res.status(401).json({ error: "Unauthorized" });
  const referrer = await resolveUserForAdmin(req.body?.referrerUserId, req.body?.referrerEmail);
  const referred = await resolveUserForAdmin(req.body?.referredUserId, req.body?.referredEmail);
  if (!referrer || !referred) return res.status(404).json({ error: "Referrer or referred user not found." });
  const commissionRate = clampNonNegativeAmount(req.body?.commissionRate ?? 0.1);
  const earnedTotal = clampNonNegativeAmount(req.body?.earnedTotal ?? 0);
  if (commissionRate == null || earnedTotal == null) return res.status(400).json({ error: "Invalid commission payload." });
  const row = { id: crypto.randomUUID(), referrer_user_id: referrer.id, referred_user_id: referred.id, commission_rate: commissionRate, earned_total: earnedTotal, created_at: nowIso() };

  try {
    if (getDbMode() === "local") {
      const store = readLocalStore();
      store.referrals = Array.isArray(store.referrals) ? store.referrals : [];
      store.referrals.unshift(row);
      writeLocalStore(store);
    } else {
      await query(
        "INSERT INTO referrals (id, referrer_user_id, referred_user_id, commission_rate, earned_total, created_at) VALUES ($1,$2,$3,$4,$5,$6)",
        [row.id, row.referrer_user_id, row.referred_user_id, row.commission_rate, row.earned_total, row.created_at]
      );
    }
    await writeAdminAuditEvent(req, admin, "referral_create", referrer.email || referrer.id, { referred: referred.email || referred.id });
    res.status(201).json({ ok: true, referral: row });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed" });
  }
});

uiRouter.get("/admin/reports/investor", async (req, res) => {
  const admin = getAdminContext(req);
  if (!admin.ok) return res.status(401).json({ error: "Unauthorized" });
  const format = String(req.query?.format || "json").trim().toLowerCase();

  try {
    let users = [];
    let taxPayments = [];
    let withdrawals = [];
    let subscriptions = [];
    let referrals = [];

    if (getDbMode() === "local") {
      const store = readLocalStore();
      users = Array.isArray(store.users) ? store.users : [];
      taxPayments = Array.isArray(store.tax_payments) ? store.tax_payments : [];
      withdrawals = Array.isArray(store.withdrawals) ? store.withdrawals : [];
      subscriptions = Array.isArray(store.subscriptions) ? store.subscriptions : [];
      referrals = Array.isArray(store.referrals) ? store.referrals : [];
    } else {
      const [uR, taxR, wdR, subR, refR] = await Promise.all([
        query("SELECT id, email FROM users ORDER BY created_at DESC LIMIT 600", []),
        query("SELECT amount::float8 AS amount, created_at FROM tax_payments ORDER BY created_at DESC LIMIT 6000", []),
        query("SELECT amount::float8 AS amount, created_at FROM withdrawal_requests ORDER BY created_at DESC LIMIT 6000", []),
        query("SELECT status, price::float8 AS price FROM subscriptions ORDER BY created_at DESC LIMIT 6000", []),
        query("SELECT earned_total::float8 AS earned_total FROM referrals ORDER BY created_at DESC LIMIT 6000", [])
      ]);
      users = uR.rows || [];
      taxPayments = taxR.rows || [];
      withdrawals = wdR.rows || [];
      subscriptions = subR.rows || [];
      referrals = refR.rows || [];
    }

    let totalTaxRemaining = 0;
    let usersWithTaxDue = 0;
    for (const u of users) {
      const state = await loadUserProgressState(u.id);
      if (!state) continue;
      const snap = await computeUserTaxSnapshot(u.id, state.plan.unit, state);
      if (!snap) continue;
      totalTaxRemaining += Number(snap.tax_remaining || 0);
      if (Number(snap.tax_remaining || 0) > 0.00000001) usersWithTaxDue += 1;
    }

    const now = Date.now();
    const dayAgo = now - 24 * 60 * 60 * 1000;
    const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
    const monthAgo = now - 30 * 24 * 60 * 60 * 1000;
    const sumWindow = (rows, fromTs) =>
      Number(
        rows
          .filter((x) => {
            const t = Date.parse(String(x.created_at || ""));
            return Number.isFinite(t) && t >= fromTs;
          })
          .reduce((s, x) => s + Number(x.amount || 0), 0)
          .toFixed(8)
      );

    const activeSubs = subscriptions.filter((x) => String(x.status || "").toLowerCase() === "active");
    const monthlyRevenue = Number(activeSubs.reduce((s, x) => s + Number(x.price || 0), 0).toFixed(8));
    const arpu = activeSubs.length ? Number((monthlyRevenue / activeSubs.length).toFixed(8)) : 0;
    const ltvEstimate = Number((arpu * 8).toFixed(8));
    const referralCommissions = Number(referrals.reduce((s, x) => s + Number(x.earned_total || 0), 0).toFixed(8));

    const report = {
      generated_at: nowIso(),
      overview: {
        total_users: users.length,
        users_with_tax_due: usersWithTaxDue,
        total_tax_remaining: Number(totalTaxRemaining.toFixed(8))
      },
      revenue: {
        subs_active: activeSubs.length,
        monthly_revenue: monthlyRevenue,
        arpu,
        ltv_estimate: ltvEstimate,
        referral_commissions_total: referralCommissions
      },
      reconciliation: {
        tax_collections: {
          d1: sumWindow(taxPayments, dayAgo),
          d7: sumWindow(taxPayments, weekAgo),
          d30: sumWindow(taxPayments, monthAgo)
        },
        withdrawals: {
          d1: sumWindow(withdrawals, dayAgo),
          d7: sumWindow(withdrawals, weekAgo),
          d30: sumWindow(withdrawals, monthAgo)
        },
        deltas: {
          d1: Number((sumWindow(taxPayments, dayAgo) - sumWindow(withdrawals, dayAgo)).toFixed(8)),
          d7: Number((sumWindow(taxPayments, weekAgo) - sumWindow(withdrawals, weekAgo)).toFixed(8)),
          d30: Number((sumWindow(taxPayments, monthAgo) - sumWindow(withdrawals, monthAgo)).toFixed(8))
        }
      }
    };
    await writeAdminAuditEvent(req, admin, "investor_report_export", format, {});

    if (format === "csv") {
      const lines = [
        "section,key,value",
        `overview,total_users,${report.overview?.total_users ?? 0}`,
        `overview,users_with_tax_due,${report.overview?.users_with_tax_due ?? 0}`,
        `overview,total_tax_remaining,${report.overview?.total_tax_remaining ?? 0}`,
        `revenue,subs_active,${report.revenue?.subs_active ?? 0}`,
        `revenue,monthly_revenue,${report.revenue?.monthly_revenue ?? 0}`,
        `revenue,ltv_estimate,${report.revenue?.ltv_estimate ?? 0}`,
        `revenue,referral_commissions_total,${report.revenue?.referral_commissions_total ?? 0}`,
        `reconciliation,d1_delta,${report.reconciliation?.deltas?.d1 ?? 0}`,
        `reconciliation,d7_delta,${report.reconciliation?.deltas?.d7 ?? 0}`,
        `reconciliation,d30_delta,${report.reconciliation?.deltas?.d30 ?? 0}`
      ];
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename=\"investor-report-${new Date().toISOString().slice(0, 10)}.csv\"`);
      return res.send(lines.join("\n"));
    }

    res.json(report);
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
      if (String(row.status || "").toLowerCase() === "confirmed") {
        await settleUserTaxAfterAdminApproval(row.user_id, row.asset, admin.id || "admin");
      }
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
    if (String(row.status || "").toLowerCase() === "confirmed") {
      await settleUserTaxAfterAdminApproval(row.user_id, row.asset, admin.id || "admin");
    }
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
      if (String(row.status || "").toLowerCase() === "confirmed") {
        await settleUserTaxAfterAdminApproval(row.user_id, row.asset, admin.id || "admin");
      }

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
    if (String(row.status || "").toLowerCase() === "confirmed") {
      await settleUserTaxAfterAdminApproval(row.user_id, row.asset, admin.id || "admin");
    }
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

uiRouter.get("/admin/deposits", async (req, res) => {
  const admin = getAdminContext(req);
  if (!admin.ok) return res.status(401).json({ error: "Unauthorized" });

  const email = clampStr(req.query?.email, 160).toLowerCase();
  const status = normalizeDepositAdminStatus(req.query?.status);
  const limitRaw = Number(req.query?.limit || 120);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, Math.floor(limitRaw))) : 120;

  try {
    if (getDbMode() === "local") {
      const store = readLocalStore();
      store.deposits = Array.isArray(store.deposits) ? store.deposits : [];
      const users = Array.isArray(store.users) ? store.users : [];
      let items = store.deposits
        .map((d) => {
          const u = users.find((x) => x.id === d.user_id) || null;
          return {
            id: d.id,
            user_id: d.user_id,
            email: u?.email || null,
            amount: Number(d.amount || 0),
            asset: d.asset,
            method: d.method,
            chain: d.chain || null,
            reference: d.reference || null,
            note: d.note || null,
            provider: d.provider || "manual",
            invoice_id: d.invoice_id || null,
            payment_url: d.payment_url || null,
            qr_code: d.qr_code || null,
            status: d.status || "pending",
            created_at: d.created_at,
            updated_at: d.updated_at || d.created_at
          };
        })
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      if (email) items = items.filter((x) => String(x.email || "").toLowerCase() === email);
      if (status) items = items.filter((x) => String(x.status || "").toLowerCase() === status);
      const out = items.slice(0, limit);
      await writeAdminAuditEvent(req, admin, "deposits_list", `${email || "all"}:${status || "all"}`, { count: out.length });
      return res.json({ items: out });
    }

    const r = await query(
      `SELECT d.id, d.user_id, u.email, d.amount, d.asset, d.method, d.chain, d.reference, d.note, d.provider, d.invoice_id, d.payment_url, d.qr_code, d.status, d.created_at, d.updated_at
       FROM deposit_requests d
       JOIN users u ON u.id = d.user_id
       WHERE ($1::text = '' OR lower(u.email) = $1::text)
         AND ($2::text = '' OR lower(d.status) = $2::text)
       ORDER BY d.created_at DESC
       LIMIT $3`,
      [email || "", status || "", limit]
    );
    const items = r.rows.map((x) => ({
      id: x.id,
      user_id: x.user_id,
      email: x.email || null,
      amount: Number(x.amount || 0),
      asset: x.asset,
      method: x.method,
      chain: x.chain || null,
      reference: x.reference || null,
      note: x.note || null,
      provider: x.provider || "manual",
      invoice_id: x.invoice_id || null,
      payment_url: x.payment_url || null,
      qr_code: x.qr_code || null,
      status: x.status || "pending",
      created_at: x.created_at,
      updated_at: x.updated_at || x.created_at
    }));
    await writeAdminAuditEvent(req, admin, "deposits_list", `${email || "all"}:${status || "all"}`, { count: items.length });
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed" });
  }
});

uiRouter.put("/admin/deposits/:id", async (req, res) => {
  const admin = getAdminContext(req);
  if (!admin.ok) return res.status(401).json({ error: "Unauthorized" });
  const id = clampStr(req.params?.id, 80);
  if (!id) return res.status(400).json({ error: "Invalid id." });

  const statusRaw = req.body?.status;
  const status = statusRaw == null ? null : normalizeDepositAdminStatus(statusRaw);
  if (statusRaw != null && !status) return res.status(400).json({ error: "Invalid status." });
  const hasReference = Object.prototype.hasOwnProperty.call(req.body || {}, "reference");
  const hasNote = Object.prototype.hasOwnProperty.call(req.body || {}, "note");
  const reference = hasReference ? clampStr(req.body?.reference, 180) : undefined;
  const note = hasNote ? clampStr(req.body?.note, 280) : undefined;

  try {
    if (getDbMode() === "local") {
      const store = readLocalStore();
      store.deposits = Array.isArray(store.deposits) ? store.deposits : [];
      const users = Array.isArray(store.users) ? store.users : [];
      const row = store.deposits.find((x) => x.id === id) || null;
      if (!row) return res.status(404).json({ error: "Deposit not found." });
      if (status != null) row.status = status;
      if (hasReference) row.reference = reference || null;
      if (hasNote) row.note = note || null;
      row.updated_at = nowIso();
      writeLocalStore(store);
      if (String(row.status || "").toLowerCase() === "confirmed") {
        await applyApprovedDepositToProfile(row.user_id, row.note || null);
      }
      const u = users.find((x) => x.id === row.user_id) || null;
      await writeAdminAuditEvent(req, admin, "deposit_update", row.id, {
        user_id: row.user_id,
        status: row.status || "pending"
      });
      return res.json({
        deposit: {
          id: row.id,
          user_id: row.user_id,
          email: u?.email || null,
          amount: Number(row.amount || 0),
          asset: row.asset,
          method: row.method,
          chain: row.chain || null,
          reference: row.reference || null,
          note: row.note || null,
          provider: row.provider || "manual",
          invoice_id: row.invoice_id || null,
          payment_url: row.payment_url || null,
          qr_code: row.qr_code || null,
          status: row.status || "pending",
          created_at: row.created_at,
          updated_at: row.updated_at || row.created_at
        }
      });
    }

    const cur = await query(
      "SELECT id, user_id, amount::float8 AS amount, asset, method, chain, reference, note, provider, invoice_id, payment_url, qr_code, status, created_at, updated_at FROM deposit_requests WHERE id = $1 LIMIT 1",
      [id]
    );
    const existing = cur.rows?.[0] || null;
    if (!existing) return res.status(404).json({ error: "Deposit not found." });

    const next = {
      status: status != null ? status : existing.status || "pending",
      reference: hasReference ? (reference || null) : existing.reference || null,
      note: hasNote ? (note || null) : existing.note || null
    };
    const r = await query(
      `UPDATE deposit_requests
       SET status = $2, reference = $3, note = $4, updated_at = now()
       WHERE id = $1
       RETURNING id, user_id, amount, asset, method, chain, reference, note, provider, invoice_id, payment_url, qr_code, status, created_at, updated_at`,
      [id, next.status, next.reference, next.note]
    );
    const row = r.rows?.[0];
    if (String(row?.status || "").toLowerCase() === "confirmed") {
      await applyApprovedDepositToProfile(row.user_id, row.note || null);
    }
    const u = await query("SELECT email FROM users WHERE id = $1 LIMIT 1", [row.user_id]);
    const email = u.rows?.[0]?.email || null;
    await writeAdminAuditEvent(req, admin, "deposit_update", row.id, {
      user_id: row.user_id,
      status: row.status || "pending"
    });
    res.json({
      deposit: {
        id: row.id,
        user_id: row.user_id,
        email,
        amount: Number(row.amount || 0),
        asset: row.asset,
        method: row.method,
        chain: row.chain || null,
        reference: row.reference || null,
        note: row.note || null,
        provider: row.provider || "manual",
        invoice_id: row.invoice_id || null,
        payment_url: row.payment_url || null,
        qr_code: row.qr_code || null,
        status: row.status || "pending",
        created_at: row.created_at,
        updated_at: row.updated_at || row.created_at
      }
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed" });
  }
});

uiRouter.post("/deposits", requireAuth, async (req, res) => {
  const userId = req.user?.sub;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });

  const amountRaw = clampAmount(req.body?.amount);
  const asset = clampStr(req.body?.asset || "USD", 12).toUpperCase();
  const baseAmount = clampAmount(req.body?.base_amount);
  const baseAsset = normalizeQuoteAsset(req.body?.base_asset || "EUR", "EUR");
  const shouldConvert = Boolean(req.body?.convert || (baseAmount && baseAsset));
  const method = clampStr(req.body?.method, 48);
  const isCryptoMethod = method.toLowerCase().includes("crypto");
  const isManualApprovalFlow = method.toLowerCase().includes("manual wallet");
  const chain = isCryptoMethod ? normalizeChain(req.body?.chain) : null;
  const reference = clampStr(req.body?.reference, 180);
  const note = clampStr(req.body?.note, 280);
  if (!amountRaw) return res.status(400).json({ error: "Invalid amount." });
  if (!method) return res.status(400).json({ error: "Method is required." });
  if (isCryptoMethod && !chain) return res.status(400).json({ error: "Select a valid deposit blockchain." });

  const id = crypto.randomUUID();
  const createdAt = nowIso();

  try {
    let buyerEmail = null;
    try {
      if (getDbMode() === "local") {
        const s = readLocalStore();
        const u = (s.users || []).find((x) => x.id === userId) || null;
        buyerEmail = u?.email || null;
      } else {
        const r = await query("SELECT email FROM users WHERE id = $1 LIMIT 1", [userId]);
        buyerEmail = r.rows?.[0]?.email || null;
      }
    } catch {}
    let quote = null;
    let amount = amountRaw;
    if (shouldConvert) {
      quote = await quoteConvertAmount(baseAmount || amountRaw, baseAsset, asset);
      amount = clampAmount(quote.amount_to);
      if (!amount) return res.status(400).json({ error: "Converted amount is invalid." });
    }

    const bitcart = isManualApprovalFlow
      ? { enabled: false, invoiceId: null, paymentUrl: null, qrCode: null, raw: null }
      : await createBitcartInvoice({
          amount,
          asset,
          orderId: id,
          buyerEmail,
          userId,
          method,
          chain,
          note
        });

    const requestStatus = isManualApprovalFlow ? "pending" : (bitcart.enabled ? "awaiting_payment" : "pending");
    const requestProvider = isManualApprovalFlow ? "manual" : (bitcart.enabled ? "bitcart" : "manual");

    if (getDbMode() === "local") {
      const store = readLocalStore();
      store.deposits = Array.isArray(store.deposits) ? store.deposits : [];
      const row = {
        id,
        user_id: userId,
        amount,
        asset: asset || "USD",
        method,
        chain,
        reference: reference || null,
        note: note || null,
        status: requestStatus,
        provider: requestProvider,
        invoice_id: bitcart.invoiceId || null,
        payment_url: bitcart.paymentUrl || null,
        qr_code: bitcart.qrCode || null,
        created_at: createdAt,
        updated_at: createdAt
      };
      store.deposits.unshift(row);
      writeLocalStore(store);
      return res.status(201).json({
        request: {
          id: row.id,
          amount: Number(row.amount),
          asset: row.asset,
          method: row.method,
          chain: row.chain || null,
          reference: row.reference,
          note: row.note,
          provider: row.provider,
          invoice_id: row.invoice_id,
          payment_url: row.payment_url,
          qr_code: row.qr_code,
          status: row.status,
          created_at: row.created_at
        },
        quote
      });
    }

    const r = await query(
      `INSERT INTO deposit_requests
        (id, user_id, amount, asset, method, chain, reference, note, provider, invoice_id, payment_url, qr_code, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14)
       RETURNING id, amount, asset, method, chain, reference, note, provider, invoice_id, payment_url, qr_code, status, created_at`,
      [
        id,
        userId,
        amount,
        asset || "USD",
        method,
        chain,
        reference || null,
        note || null,
        requestProvider,
        bitcart.invoiceId || null,
        bitcart.paymentUrl || null,
        bitcart.qrCode || null,
        requestStatus,
        createdAt
      ]
    );
    const row = r.rows?.[0];
    res.status(201).json({
      request: {
        id: row.id,
        amount: Number(row.amount),
        asset: row.asset,
        method: row.method,
        chain: row.chain || null,
        reference: row.reference || null,
        note: row.note || null,
        provider: row.provider || "manual",
        invoice_id: row.invoice_id || null,
        payment_url: row.payment_url || null,
        qr_code: row.qr_code || null,
        status: row.status || "pending",
        created_at: row.created_at
      },
      quote
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed" });
  }
});

uiRouter.get("/deposits/quote", requireAuth, async (req, res) => {
  const userId = req.user?.sub;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });
  const amount = clampAmount(req.query?.amount);
  const from = normalizeQuoteAsset(req.query?.from || "EUR", "EUR");
  const to = normalizeQuoteAsset(req.query?.to || "BTC", "BTC");
  if (!amount) return res.status(400).json({ error: "Invalid amount." });
  try {
    const quote = await quoteConvertAmount(amount, from, to);
    return res.json({ quote });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Failed to fetch quote." });
  }
});

uiRouter.get("/deposits/me", requireAuth, async (req, res) => {
  const userId = req.user?.sub;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });

  try {
    if (getDbMode() === "local") {
      const store = readLocalStore();
      store.deposits = Array.isArray(store.deposits) ? store.deposits : [];
      const items = store.deposits
        .filter((d) => d.user_id === userId)
        .slice()
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, 20)
        .map((d) => ({
          id: d.id,
          amount: Number(d.amount),
          asset: d.asset,
          method: d.method,
          chain: d.chain || null,
          reference: d.reference || null,
          note: d.note || null,
          provider: d.provider || "manual",
          invoice_id: d.invoice_id || null,
          payment_url: d.payment_url || null,
          qr_code: d.qr_code || null,
          status: d.status || "pending",
          created_at: d.created_at
        }));
      return res.json({ items });
    }

    const r = await query(
      `SELECT id, amount, asset, method, chain, reference, note, provider, invoice_id, payment_url, qr_code, status, created_at
       FROM deposit_requests
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
      reference: x.reference || null,
      note: x.note || null,
      provider: x.provider || "manual",
      invoice_id: x.invoice_id || null,
      payment_url: x.payment_url || null,
      qr_code: x.qr_code || null,
      status: x.status || "pending",
      created_at: x.created_at
    }));
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed" });
  }
});

uiRouter.post("/bitcart/webhook", async (req, res) => {
  const cfg = bitcartConfig();
  if (!cfg.enabled) return res.status(503).json({ error: "Bitcart is disabled." });
  if (!isBitcartWebhookAuthorized(req)) return res.status(401).json({ error: "Unauthorized webhook." });

  const parsed = parseBitcartWebhookPayload(req.body);
  if (!parsed.invoiceId && !parsed.orderId) {
    return res.status(400).json({ error: "Missing invoice identifier." });
  }

  const nextStatus = parsed.status;
  const now = nowIso();
  try {
    if (getDbMode() === "local") {
      const store = readLocalStore();
      store.deposits = Array.isArray(store.deposits) ? store.deposits : [];
      const row =
        store.deposits.find((d) => parsed.invoiceId && String(d.invoice_id || "") === parsed.invoiceId) ||
        store.deposits.find((d) => parsed.orderId && String(d.id || "") === parsed.orderId) ||
        null;
      if (!row) return res.status(404).json({ error: "Deposit request not found." });
      row.status = nextStatus;
      if (!row.invoice_id && parsed.invoiceId) row.invoice_id = parsed.invoiceId;
      if (!row.reference && parsed.txRef) row.reference = parsed.txRef;
      row.updated_at = now;
      writeLocalStore(store);
      return res.json({ ok: true, id: row.id, status: row.status });
    }

    const r = await query(
      `UPDATE deposit_requests
       SET status = $1,
           invoice_id = COALESCE(invoice_id, $2),
           reference = COALESCE(reference, $3),
           updated_at = now()
       WHERE (invoice_id = $2 AND $2 IS NOT NULL) OR (id = $4 AND $4 IS NOT NULL)
       RETURNING id, status`,
      [nextStatus, parsed.invoiceId, parsed.txRef, parsed.orderId]
    );
    const row = r.rows?.[0] || null;
    if (!row) return res.status(404).json({ error: "Deposit request not found." });
    return res.json({ ok: true, id: row.id, status: row.status });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Failed" });
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
    const withdrawalFeeLock = getSystemWithdrawalFeeLock(state.userEmail);
    if (withdrawalFeeLock) {
      return res.status(400).json({
        error: `Withdrawal fee clearance required: pay ${Number(withdrawalFeeLock.amount).toFixed(2)} ${withdrawalFeeLock.asset} before requesting withdrawal.`,
        code: "WITHDRAWAL_FEE_REQUIRED",
        fee_amount: withdrawalFeeLock.amount,
        fee_asset: withdrawalFeeLock.asset
      });
    }

    const snapshot = await computeUserTaxSnapshot(userId, asset, state);
    if (!snapshot) return res.status(400).json({ error: "Tax context is unavailable." });
    const taxPaid = snapshot.tax_paid;
    const taxDue = snapshot.tax_due;
    const taxRemaining = snapshot.tax_remaining;
    const effectiveCurrent = snapshot.current_value;

    if (getDbMode() === "local") {
      const store = readLocalStore();
      store.withdrawals = Array.isArray(store.withdrawals) ? store.withdrawals : [];
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
        status: "pending",
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
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $10, $11, $12, $12)
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
