import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import morgan from "morgan";
import { getDbMode } from "./db.js";
import { ensureDefaultAdminUser } from "./defaultAdmin.js";
import { portfolioRouter } from "./routes/portfolio.js";
import { profileRouter } from "./routes/profile.js";
import { uiRouter } from "./routes/ui.js";

const PORT = Number(process.env.PORT || 8787);
const FREECRYPTOAPI_KEY = process.env.FREECRYPTOAPI_KEY || "";

if (!FREECRYPTOAPI_KEY) {
  // Don't crash; but make it obvious in responses.
  console.warn("[backend] FREECRYPTOAPI_KEY is not set. Set it in Backend/.env");
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(morgan("dev"));

// Ensure default admin account exists for first-time operations login.
ensureDefaultAdminUser()
  .then(() => {
    console.log("[backend] default admin ready");
  })
  .catch((e) => {
    console.warn("[backend] default admin bootstrap failed:", e?.message || e);
  });
// When deployed behind a proxy/load balancer (Render/Fly/Railway/Nginx), this allows
// `req.secure` and `x-forwarded-*` to behave correctly for cookies and URLs.
if (String(process.env.TRUST_PROXY || "").trim()) {
  app.set("trust proxy", 1);
}

// CORS should be applied before routes (especially auth and public endpoints used by the frontend).
app.use(
  cors({
    origin: (origin, cb) => {
      const allow = new Set(
        String(process.env.CORS_ORIGINS || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      );
      if (!origin) return cb(null, true); // curl/Invoke-WebRequest
      if (origin === "http://localhost:5173") return cb(null, true);
      if (origin === "http://127.0.0.1:5173") return cb(null, true);
      if (allow.has(origin)) return cb(null, true);
      return cb(new Error("CORS blocked"), false);
    },
    credentials: true
  })
);

// Serve uploaded media from Backend/Photos at /photos/<filename>
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const photosDir = path.join(__dirname, "..", "Photos");
app.use(
  "/photos",
  express.static(photosDir, {
    fallthrough: true,
    // Blog should reflect new uploads quickly; avoid browser caching surprises.
    maxAge: 0,
    etag: true,
    setHeaders(res) {
      res.setHeader("Cache-Control", "no-store");
    }
  })
);

// Public list endpoint for Blog/gallery (filters to common image extensions).
app.get("/api/photos", async (_req, res) => {
  try {
    const { readdir } = await import("node:fs/promises");
    const { stat } = await import("node:fs/promises");
    const entries = await readdir(photosDir, { withFileTypes: true });
    const allowed = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg"]);
    const files = entries
      .filter((e) => e.isFile())
      .map((e) => String(e.name || ""))
      .filter((name) => name && name !== ".gitkeep")
      .filter((name) => {
        const ext = name.toLowerCase().slice(Math.max(0, name.lastIndexOf(".")));
        return allowed.has(ext);
      });

    const out = (
      await Promise.all(
        files.map(async (name) => {
          try {
            const st = await stat(path.join(photosDir, name));
            // Prefer "added/uploaded" time over "modified" time so newest uploads are first,
            // even if the image file's internal modified time is old.
            const birth = Number.isFinite(st.birthtimeMs) ? st.birthtimeMs : 0;
            const mtime = Number.isFinite(st.mtimeMs) ? st.mtimeMs : 0;
            const uploadedMs = Math.max(birth, mtime) || undefined;
            return { name, url: `/photos/${encodeURIComponent(name)}`, uploadedMs, mtimeMs: st.mtimeMs };
          } catch {
            return null;
          }
        })
      )
    ).filter(Boolean);

    // Newest first.
    out.sort(
      (a, b) =>
        (b.uploadedMs || b.mtimeMs || 0) - (a.uploadedMs || a.mtimeMs || 0) ||
        String(a.name).localeCompare(String(b.name))
    );

    res.setHeader("Cache-Control", "no-store");
    res.json({ items: out });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed" });
  }
});

// Auth is optional here because this environment may not allow `npm install`.
// When dependencies are installed and env vars are set, we mount /api/auth.
let authEnabled = false;
let authDisabledReason = "deps not installed";
try {
  const [{ default: cookieParser }, { authRouter }] = await Promise.all([import("cookie-parser"), import("./routes/auth.js")]);
  app.use(cookieParser());
  app.use("/api/auth", authRouter);
  authEnabled = true;
  authDisabledReason = "";
  console.log("[backend] auth enabled at /api/auth");
} catch (e) {
  authDisabledReason = e?.code ? String(e.code) : "deps/env";
  console.warn("[backend] auth disabled (deps not installed or env not set).");
}

app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/api/auth/status", (_req, res) =>
  res.json({
    enabled: authEnabled,
    reason: authEnabled ? null : authDisabledReason,
    dbMode: getDbMode()
  })
);

app.use("/api/portfolio", portfolioRouter);
app.use("/api/profile", profileRouter);
app.use("/api", uiRouter);

const FREECRYPTO_BASE = "https://api.freecryptoapi.com/v1";
const GOLD_API_BASE = "https://api.gold-api.com";

async function fetchJson(url, { signal, headers } = {}) {
  const res = await fetch(url, {
    method: "GET",
    signal,
    headers: {
      Accept: "application/json",
      ...(headers || {})
    }
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} from upstream`);
    err.status = res.status;
    err.upstream = body;
    throw err;
  }
  return body;
}

function authHeaders() {
  return FREECRYPTOAPI_KEY ? { Authorization: `Bearer ${FREECRYPTOAPI_KEY}` } : {};
}

// Small in-memory cache to avoid hammering upstream during UI polling.
const cache = new Map();
function cacheGet(key) {
  const v = cache.get(key);
  if (!v) return null;
  if (Date.now() > v.expiresAt) {
    cache.delete(key);
    return null;
  }
  return v.value;
}
function cacheSet(key, value, ttlMs) {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

async function getCryptoQuotes(symbols, signal) {
  const cacheKey = `crypto:${symbols.join(",")}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  // FreeCryptoAPI /getData accepts a symbol param; official docs show example with `symbol=BTC`.
  // We fan out to keep behavior robust even if multi-symbol isn't supported on your plan.
  const results = await Promise.allSettled(
    symbols.map(async (sym) => {
      const url = new URL(`${FREECRYPTO_BASE}/getData`);
      url.searchParams.set("symbol", sym);
      const j = await fetchJson(url.toString(), { signal, headers: authHeaders() });
      return j;
    })
  );

  const out = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled" && r.value) {
      out.push(r.value);
    }
  }

  // Small cache to support near-realtime UI polling without hammering upstream.
  cacheSet(cacheKey, out, 1200);
  return out;
}

function symToCoinbaseProduct(sym) {
  const s = String(sym || "").trim().toUpperCase();
  const map = {
    BTC: "BTC-USD",
    ETH: "ETH-USD",
    SOL: "SOL-USD",
    BNB: "BNB-USD",
    XRP: "XRP-USD",
    ADA: "ADA-USD",
    DOGE: "DOGE-USD",
    AVAX: "AVAX-USD",
    DOT: "DOT-USD",
    TRX: "TRX-USD"
  };
  return map[s] || `${s}-USD`;
}

async function getCryptoQuotesCoinbase(symbols, signal) {
  const cacheKey = `crypto:coinbase:${symbols.join(",")}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const COINBASE = "https://api.coinbase.com/v2";
  const COINBASE_EX = "https://api.exchange.coinbase.com";

  const results = await Promise.allSettled(
    symbols.map(async (sym) => {
      const symbol = String(sym || "").trim().toUpperCase();
      if (!symbol) return null;
      const product = symToCoinbaseProduct(symbol);

      const uSpot = `${COINBASE}/prices/${encodeURIComponent(product)}/spot`;
      const spot = await fetchJson(uSpot, { signal });

      const uStats = `${COINBASE_EX}/products/${encodeURIComponent(product)}/stats`;
      const stats = await fetchJson(uStats, { signal }).catch(() => null);

      const priceRaw = spot?.data?.amount;
      const price = typeof priceRaw === "string" ? Number(priceRaw) : typeof priceRaw === "number" ? priceRaw : null;
      if (!Number.isFinite(price)) return null;

      let change24h = null;
      const openRaw = stats?.open;
      const lastRaw = stats?.last;
      const open = typeof openRaw === "string" ? Number(openRaw) : typeof openRaw === "number" ? openRaw : null;
      const last = typeof lastRaw === "string" ? Number(lastRaw) : typeof lastRaw === "number" ? lastRaw : null;
      if (Number.isFinite(open) && open && Number.isFinite(last)) change24h = ((last - open) / open) * 100;

      return {
        symbol,
        price,
        change_24h: change24h,
        raw: { provider: "coinbase", spot, stats }
      };
    })
  );

  const out = [];
  for (const r of results) if (r.status === "fulfilled" && r.value) out.push(r.value);

  cacheSet(cacheKey, out, 1200);
  return out;
}

function symToKrakenPair(sym) {
  const s = String(sym || "").trim().toUpperCase();
  const map = {
    BTC: "XBTUSD",
    ETH: "ETHUSD",
    SOL: "SOLUSD",
    XRP: "XRPUSD",
    ADA: "ADAUSD",
    DOGE: "DOGEUSD",
    DOT: "DOTUSD",
    AVAX: "AVAXUSD"
  };
  return map[s] || null;
}

async function getCryptoQuotesKraken(symbols, signal) {
  const cacheKey = `crypto:kraken:${symbols.join(",")}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const base = "https://api.kraken.com/0/public/Ticker";
  const wanted = symbols
    .map((s) => ({ sym: String(s || "").trim().toUpperCase(), pair: symToKrakenPair(s) }))
    .filter((x) => x.sym && x.pair);
  if (!wanted.length) return [];

  const url = new URL(base);
  url.searchParams.set("pair", wanted.map((x) => x.pair).join(","));

  const j = await fetchJson(url.toString(), { signal }).catch(() => null);
  const result = j?.result && typeof j.result === "object" ? j.result : null;
  if (!result) return [];

  const out = [];
  for (const w of wanted) {
    // Kraken returns result keyed by pair (sometimes with alternate key); try best-effort.
    const row = result[w.pair] || result[Object.keys(result).find((k) => k.includes(w.pair)) || ""] || null;
    const lastRaw = row?.c?.[0];
    const openRaw = row?.o;
    const last = typeof lastRaw === "string" ? Number(lastRaw) : typeof lastRaw === "number" ? lastRaw : null;
    const open = typeof openRaw === "string" ? Number(openRaw) : typeof openRaw === "number" ? openRaw : null;
    if (!Number.isFinite(last)) continue;
    const change24h = Number.isFinite(open) && open ? ((last - open) / open) * 100 : null;
    out.push({
      symbol: w.sym,
      price: last,
      change_24h: change24h,
      raw: { provider: "kraken", pair: w.pair, row }
    });
  }

  cacheSet(cacheKey, out, 8000);
  return out;
}

function simulateCryptoQuotes(symbols) {
  const base = {
    BTC: 48000,
    ETH: 2600,
    SOL: 105,
    BNB: 520,
    XRP: 0.55,
    ADA: 0.48,
    DOGE: 0.085,
    TRX: 0.12,
    AVAX: 36,
    DOT: 7.2
  };

  // Small deterministic-ish jitter for an indicative fallback when upstream providers are unavailable.
  const seed = Math.floor(Date.now() / 15000);
  function jitter(sym) {
    let h = 0;
    const s = `${sym}:${seed}`;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return (h % 2000) / 100000; // 0.0% - 2.0%
  }

  return symbols.map((sym) => {
    const b = base[sym] ?? (sym.length <= 6 ? 10 : 1);
    const j = jitter(sym);
    const dir = (seed + sym.charCodeAt(0)) % 2 === 0 ? 1 : -1;
    const price = b * (1 + dir * j);
    const change24h = dir * (j * 100);
      return {
        symbol: sym,
        price: Number(price.toFixed(price >= 100 ? 2 : price >= 1 ? 4 : 6)),
        change_24h: Number(change24h.toFixed(3)),
        raw: { simulated: true, base: b, seed }
      };
  });
}

function getFallbackPairs() {
  return [
    "BTC/USD",
    "ETH/USD",
    "SOL/USD",
    "BNB/USD",
    "XRP/USD",
    "ADA/USD",
    "DOGE/USD",
    "TRX/USD",
    "AVAX/USD",
    "DOT/USD",
    "BTC/USDT",
    "ETH/USDT",
    "SOL/USDT",
    "BNB/USDT",
    "XRP/USDT",
    "ADA/USDT",
    "DOGE/USDT"
  ];
}

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  return function rand() {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal01(rng) {
  // Box-Muller
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function intervalToSec(interval) {
  const v = String(interval || "1h").trim().toLowerCase();
  const map = {
    "1m": 60,
    "5m": 5 * 60,
    "15m": 15 * 60,
    "30m": 30 * 60,
    "1h": 60 * 60,
    "4h": 4 * 60 * 60,
    "1d": 24 * 60 * 60,
    "1w": 7 * 24 * 60 * 60,
    "1mth": 30 * 24 * 60 * 60,
    "1mo": 30 * 24 * 60 * 60
  };
  return map[v] || 60 * 60;
}

function alignDown(tsSec, stepSec) {
  return Math.floor(tsSec / stepSec) * stepSec;
}

function generateCandles({ symbol, intervalSec, limit, endTimeSec }) {
  const sym = String(symbol || "BTCUSD").trim().toUpperCase();
  const step = Math.max(60, intervalSec);
  const n = Math.max(1, Math.min(2000, Math.floor(limit || 500)));
  const endAligned = alignDown(endTimeSec, step);
  const start = endAligned - (n - 1) * step;

  // Deterministic-ish seed per symbol + interval.
  const seed = hashString(`${sym}:${step}`);
  const rng = mulberry32(seed ^ (start >>> 0));

  // Pick a base price based on symbol name.
  let base = 100;
  if (sym.includes("BTC")) base = 48000;
  else if (sym.includes("ETH")) base = 2600;
  else if (sym.includes("XAU")) base = 2000;
  else if (sym.includes("EUR")) base = 1.08;
  else if (sym.includes("GBP")) base = 1.25;
  else if (sym.includes("JPY")) base = 150;

  // Start price changes slowly with start time for some variety.
  const driftSeed = (seed % 1000) / 1000;
  let prevClose = base * (0.9 + 0.2 * driftSeed);

  const out = [];
  for (let i = 0; i < n; i++) {
    const t = start + i * step;
    const open = prevClose;

    // Volatility scaled by price and timeframe.
    const tf = Math.sqrt(step / 60);
    const sigma = Math.max(1e-6, (open * 0.0015 + 0.2) * tf);
    const ret = normal01(rng) * sigma;
    const close = Math.max(1e-9, open + ret);

    const wick = Math.abs(normal01(rng)) * sigma * 1.2;
    const high = Math.max(open, close) + wick * (0.5 + rng());
    const low = Math.max(1e-9, Math.min(open, close) - wick * (0.5 + rng()));

    const volumeBase = 1000 * tf * (1 + rng() * 2);
    const volume = Math.max(1, Math.floor(volumeBase * (1 + Math.abs(ret) / Math.max(1e-6, sigma))));

    out.push({
      time: t, // unix seconds
      open: Number(open.toFixed(open >= 100 ? 2 : open >= 1 ? 5 : 8)),
      high: Number(high.toFixed(high >= 100 ? 2 : high >= 1 ? 5 : 8)),
      low: Number(low.toFixed(low >= 100 ? 2 : low >= 1 ? 5 : 8)),
      close: Number(close.toFixed(close >= 100 ? 2 : close >= 1 ? 5 : 8)),
      volume
    });
    prevClose = out[out.length - 1].close;
  }
  return out;
}

async function getFxPairs(signal) {
  const cacheKey = "fx:usd";
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  // No key required. If you later want a paid FX provider, swap this impl.
  const j = await fetchJson("https://open.er-api.com/v6/latest/USD", { signal });
  const rates = j?.rates || {};

  const eur = Number(rates.EUR);
  const gbp = Number(rates.GBP);
  const jpy = Number(rates.JPY);

  const fx = [];
  if (Number.isFinite(eur) && eur > 0) fx.push({ pair: "EUR/USD", rate: 1 / eur });
  if (Number.isFinite(gbp) && gbp > 0) fx.push({ pair: "GBP/USD", rate: 1 / gbp });
  if (Number.isFinite(jpy) && jpy > 0) fx.push({ pair: "USD/JPY", rate: jpy });

  cacheSet(cacheKey, fx, 20000);
  return fx;
}

async function getMetals(symbols, signal) {
  const cacheKey = `metals:${symbols.join(",")}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  // Gold API has free, no-auth realtime prices: https://api.gold-api.com/price/{symbol}
  const results = await Promise.allSettled(
    symbols.map(async (sym) => {
      const url = `${GOLD_API_BASE}/price/${encodeURIComponent(sym)}`;
      const j = await fetchJson(url, { signal });
      const priceRaw = j?.price;
      const price = typeof priceRaw === "number" ? priceRaw : typeof priceRaw === "string" ? Number(priceRaw) : null;
      const symbol = typeof j?.symbol === "string" ? j.symbol.toUpperCase() : sym.toUpperCase();
      const updatedAt = typeof j?.updatedAt === "string" ? j.updatedAt : null;
      if (!Number.isFinite(price)) return null;
      return { symbol, price, updatedAt, raw: j };
    })
  );

  const out = [];
  for (const r of results) {
    if (r.status === "fulfilled" && r.value) out.push(r.value);
  }

  cacheSet(cacheKey, out, 8000);
  return out;
}

function normalizePairString(s) {
  if (typeof s !== "string") return null;
  const v = s.trim();
  return v ? v : null;
}

function extractPairsFromCryptoListPayload(j) {
  // The provider docs say "/getCryptoList" returns supported currencies and pairs.
  // Response shape is not consistently documented publicly, so handle a few common patterns.
  const candidates = [];

  if (Array.isArray(j)) candidates.push(j);
  if (Array.isArray(j?.pairs)) candidates.push(j.pairs);
  if (Array.isArray(j?.data?.pairs)) candidates.push(j.data.pairs);
  if (Array.isArray(j?.result?.pairs)) candidates.push(j.result.pairs);
  if (Array.isArray(j?.data)) candidates.push(j.data);
  if (Array.isArray(j?.result)) candidates.push(j.result);

  for (const c of candidates) {
    const pairs = c.map(normalizePairString).filter(Boolean);
    if (pairs.length) return pairs;
  }

  // Sometimes "pairs" might be embedded as values in an object.
  if (j && typeof j === "object") {
    const vals = Object.values(j);
    for (const v of vals) {
      if (Array.isArray(v)) {
        const pairs = v.map(normalizePairString).filter(Boolean);
        if (pairs.length) return pairs;
      }
    }
  }

  return [];
}

function tryParsePair(pair) {
  const raw = String(pair);
  const p = raw.trim();
  if (!p) return { pair: raw, base: null, quote: null };

  for (const sep of ["/", "-", "_", ":"]) {
    if (p.includes(sep)) {
      const [a, b] = p.split(sep).map((x) => x.trim());
      return { pair: raw, base: a || null, quote: b || null };
    }
  }

  // Heuristic split for common quote assets.
  const quotes = ["USDT", "USD", "BTC", "ETH", "EUR", "TRY", "GBP"];
  for (const q of quotes) {
    if (p.endsWith(q) && p.length > q.length) {
      return { pair: raw, base: p.slice(0, -q.length), quote: q };
    }
  }

  return { pair: raw, base: null, quote: null };
}

async function getCryptoPairsList(signal) {
  const cacheKey = "freecrypto:pairlist:v1";
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const url = `${FREECRYPTO_BASE}/getCryptoList`;
  const j = await fetchJson(url, { signal, headers: authHeaders() });
  const pairs = extractPairsFromCryptoListPayload(j);

  const unique = Array.from(new Set(pairs));
  // Avoid caching an empty list for a long time; upstream might be temporarily blocked/unavailable.
  cacheSet(cacheKey, { raw: j, pairs: unique }, unique.length ? 60 * 60 * 1000 : 10 * 1000);
  return { raw: j, pairs: unique };
}

app.get("/api/markets/snapshot", async (req, res) => {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 9000);

  try {
    const symbolsParam = String(req.query.symbols || "BTC,ETH,SOL");
    const symbols = symbolsParam
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
      .slice(0, 12);

    const snap = await buildMarketsSnapshot(symbols, ac.signal);
    res.json(snap);
  } catch (e) {
    const status = typeof e?.status === "number" ? e.status : 502;
    res.status(status).json({
      error: e?.message || "Upstream error",
      upstream: e?.upstream || null
    });
  } finally {
    clearTimeout(t);
  }
});

function normalizeBackendSnapshot({ asOf, sources, crypto, fx, metals, marketStatus }) {
  return {
    asOf: asOf || new Date().toISOString(),
    sources: sources || {},
    crypto: Array.isArray(crypto) ? crypto : [],
    fx: Array.isArray(fx) ? fx : [],
    metals: Array.isArray(metals) ? metals : [],
    marketStatus: marketStatus && typeof marketStatus === "object" ? marketStatus : undefined
  };
}

function getEtParts(now = new Date()) {
  // Use a stable market timezone for session gating.
  // Parsing formatToParts avoids locale-string parsing quirks.
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const parts = dtf.formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    weekday: get("weekday"), // e.g. Mon
    hour: Number(get("hour")),
    minute: Number(get("minute"))
  };
}

function toMin(h, m) {
  return h * 60 + m;
}

function isFxOpenET(now = new Date()) {
  // Retail FX is effectively closed on weekends:
  // open Sun 17:00 ET -> close Fri 17:00 ET (approx).
  const { weekday, hour, minute } = getEtParts(now);
  const t = toMin(hour, minute);
  if (weekday === "Sat") return false;
  if (weekday === "Sun") return t >= toMin(17, 0);
  if (weekday === "Fri") return t < toMin(17, 0);
  return true; // Mon-Thu
}

function isMetalsOpenET(now = new Date()) {
  // Approx CME metals session:
  // open Sun 18:00 ET -> close Fri 17:00 ET
  // daily maintenance break 17:00-18:00 ET (Mon-Thu).
  const { weekday, hour, minute } = getEtParts(now);
  const t = toMin(hour, minute);
  if (weekday === "Sat") return false;
  if (weekday === "Sun") return t >= toMin(18, 0);
  if (weekday === "Fri") return t < toMin(17, 0);
  // Mon-Thu: closed during 17:00-18:00
  if (t >= toMin(17, 0) && t < toMin(18, 0)) return false;
  return true;
}

const lastGood = {
  fx: null,
  metals: null
};

async function buildMarketsSnapshot(symbols, signal) {
  const now = new Date();
  const fxOpen = isFxOpenET(now);
  const metalsOpen = isMetalsOpenET(now);

  const [fxRes, metalsRes] = await Promise.allSettled([
    fxOpen ? getFxPairs(signal) : lastGood.fx ? Promise.resolve(lastGood.fx) : getFxPairs(signal),
    metalsOpen ? getMetals(["XAU"], signal) : lastGood.metals ? Promise.resolve(lastGood.metals) : getMetals(["XAU"], signal)
  ]);

  const fx = fxRes.status === "fulfilled" ? fxRes.value : lastGood.fx || [];
  const metals = metalsRes.status === "fulfilled" ? metalsRes.value : lastGood.metals || [];

  // Cache last known values (even if market is closed) so we can display "frozen" last prices on cold start.
  if (fxRes.status === "fulfilled" && Array.isArray(fx) && fx.length) lastGood.fx = fx;
  if (metalsRes.status === "fulfilled" && Array.isArray(metals) && metals.length) lastGood.metals = metals;

  const normalize = (raw) =>
    (Array.isArray(raw) ? raw : [raw])
      .map((c) => {
        const symbol = c?.symbol ?? c?.data?.symbol ?? null;
        const price = c?.price ?? c?.data?.price ?? null;
        const change24h = c?.change_24h ?? c?.data?.change_24h ?? null;
        return {
          symbol,
          price: typeof price === "number" ? price : typeof price === "string" ? Number(price) : null,
          change_24h: typeof change24h === "number" ? change24h : typeof change24h === "string" ? Number(change24h) : null,
          raw: c
        };
      })
      .filter((c) => typeof c.symbol === "string" && Number.isFinite(c.price));

  let crypto = [];
  let cryptoSource = "Aggregated";

  if (FREECRYPTOAPI_KEY) {
    try {
      const raw = await getCryptoQuotes(symbols, signal);
      crypto = normalize(raw);
      if (crypto.length) cryptoSource = "FreeCryptoAPI";
    } catch {}
  }

  if (crypto.length === 0) {
    try {
      const raw = await getCryptoQuotesCoinbase(symbols, signal);
      crypto = normalize(raw);
      if (crypto.length) cryptoSource = FREECRYPTOAPI_KEY ? "Coinbase (fallback)" : "Coinbase";
    } catch {}
  }

  if (crypto.length === 0) {
    try {
      const raw = await getCryptoQuotesKraken(symbols, signal);
      crypto = normalize(raw);
      if (crypto.length) cryptoSource = FREECRYPTOAPI_KEY ? "Kraken (fallback)" : "Kraken";
    } catch {}
  }

  const cryptoOut = crypto.length ? crypto : simulateCryptoQuotes(symbols);
  const cryptoLabel = crypto.length ? cryptoSource : "Aggregated (delayed)";

  return normalizeBackendSnapshot({
    asOf: new Date().toISOString(),
    sources: {
      crypto: cryptoLabel,
      fx: fxOpen ? "open.er-api.com" : "FX market closed (frozen)",
      metals: metalsOpen ? "Gold API" : "Metals market closed (frozen)"
    },
    crypto: cryptoOut,
    fx,
    metals,
    marketStatus: {
      crypto: "open",
      fx: fxOpen ? "open" : "closed",
      metals: metalsOpen ? "open" : "closed",
      tz: "America/New_York"
    }
  });
}

// Server-Sent Events stream for per-second market snapshots (shared poller per symbol set).
const streamHubs = new Map();
function hubKeyFromSymbols(symbols) {
  return symbols.slice().sort().join(",");
}

function startHub(symbols) {
  const key = hubKeyFromSymbols(symbols);
  const existing = streamHubs.get(key);
  if (existing) return existing;

  const hub = {
    key,
    symbols,
    clients: new Set(),
    timer: null,
    pingTimer: null,
    inFlight: false
  };

  const tick = async () => {
    if (hub.inFlight) return;
    hub.inFlight = true;

    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 2200);
    try {
      const snap = await buildMarketsSnapshot(symbols, ac.signal);
      const payload = `event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`;
      for (const res of hub.clients) {
        try {
          res.write(payload);
        } catch {}
      }
    } catch (e) {
      const errPayload = `event: error\ndata: ${JSON.stringify({
        error: e?.message || "stream tick failed",
        asOf: new Date().toISOString()
      })}\n\n`;
      for (const res of hub.clients) {
        try {
          res.write(errPayload);
        } catch {}
      }
    } finally {
      clearTimeout(t);
      ac.abort();
      hub.inFlight = false;
    }
  };

  hub.timer = setInterval(tick, 1000);
  // Send first tick immediately so the UI populates fast.
  void tick();

  // Keep-alive ping (some proxies terminate idle connections).
  hub.pingTimer = setInterval(() => {
    const ping = `: ping ${Date.now()}\n\n`;
    for (const res of hub.clients) {
      try {
        res.write(ping);
      } catch {}
    }
  }, 15000);

  streamHubs.set(key, hub);
  return hub;
}

function stopHubIfEmpty(hub) {
  if (hub.clients.size > 0) return;
  try {
    clearInterval(hub.timer);
    clearInterval(hub.pingTimer);
  } catch {}
  streamHubs.delete(hub.key);
}

app.get("/api/markets/stream", (req, res) => {
  const symbolsParam = String(req.query.symbols || "BTC,ETH,SOL");
  const symbols = symbolsParam
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 12);

  // SSE headers.
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  // Avoid proxy buffering (otherwise "realtime" becomes batch-delivered).
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Content-Encoding", "none");
  // Tell the browser how quickly to retry if the stream drops.
  res.write("retry: 1500\n\n");
  // Flush headers if supported (Express).
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  const hub = startHub(symbols);
  hub.clients.add(res);

  // Clean up on disconnect.
  req.on("close", () => {
    try {
      hub.clients.delete(res);
    } finally {
      stopHubIfEmpty(hub);
    }
  });
});

app.get("/api/markets/pairs", async (req, res) => {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 12000);

  try {
    const q = String(req.query.q || "").trim().toUpperCase();
    const quote = String(req.query.quote || "").trim().toUpperCase(); // optional filter like USD/USDT
    const limitRaw = Number(req.query.limit || 100);
    const offsetRaw = Number(req.query.offset || 0);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, Math.floor(limitRaw))) : 100;
    const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.floor(offsetRaw)) : 0;

    let pairs = [];
    let source = "Generated pair list";

    if (FREECRYPTOAPI_KEY) {
      const list = await getCryptoPairsList(ac.signal);
      pairs = list.pairs;
      source = "FreeCryptoAPI /getCryptoList";
    }

    if (!pairs || pairs.length === 0) {
      pairs = getFallbackPairs();
      source = FREECRYPTOAPI_KEY ? "Generated list (provider unavailable)" : "Generated list (provider not configured)";
    }

    if (quote) {
      pairs = pairs.filter((p) => {
        const parsed = tryParsePair(p);
        return parsed.quote ? parsed.quote === quote : p.toUpperCase().endsWith(quote);
      });
    }

    if (q) {
      pairs = pairs.filter((p) => p.toUpperCase().includes(q));
    }

    const total = pairs.length;
    const items = pairs.slice(offset, offset + limit).map((p) => tryParsePair(p));

    res.json({
      asOf: new Date().toISOString(),
      source,
      q,
      quote: quote || null,
      limit,
      offset,
      total,
      items
    });
  } catch (e) {
    // Keep the UI working: return a filtered fallback list on upstream errors.
    const q = String(req.query.q || "").trim().toUpperCase();
    const quote = String(req.query.quote || "").trim().toUpperCase();
    const limitRaw = Number(req.query.limit || 100);
    const offsetRaw = Number(req.query.offset || 0);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, Math.floor(limitRaw))) : 100;
    const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.floor(offsetRaw)) : 0;

    let pairs = getFallbackPairs();
    if (quote) {
      pairs = pairs.filter((p) => {
        const parsed = tryParsePair(p);
        return parsed.quote ? parsed.quote === quote : p.toUpperCase().endsWith(quote);
      });
    }
    if (q) pairs = pairs.filter((p) => p.toUpperCase().includes(q));
    const total = pairs.length;
    const items = pairs.slice(offset, offset + limit).map((p) => tryParsePair(p));

    res.json({
      asOf: new Date().toISOString(),
      source: "Generated list (fallback)",
      q,
      quote: quote || null,
      limit,
      offset,
      total,
      items
    });
  } finally {
    clearTimeout(t);
    ac.abort();
  }
});

// Synthetic OHLCV endpoint for charts (no external deps).
// Example: /api/chart-data?symbol=BTCUSD&interval=1h&limit=1000
app.get("/api/chart-data", (req, res) => {
  try {
    const symbol = String(req.query.symbol || "BTCUSD");
    const interval = String(req.query.interval || "1h");
    const intervalSec = intervalToSec(interval);
    const limitRaw = Number(req.query.limit || 500);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(2000, Math.floor(limitRaw))) : 500;
    const endRaw = req.query.endTime != null ? Number(req.query.endTime) : Math.floor(Date.now() / 1000);
    const endTimeSec = Number.isFinite(endRaw) ? Math.floor(endRaw) : Math.floor(Date.now() / 1000);

    const data = generateCandles({ symbol, intervalSec, limit, endTimeSec });
    res.json({ data });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed" });
  }
});

app.listen(PORT, () => {
  console.log(`[backend] listening on http://localhost:${PORT}`);
});
