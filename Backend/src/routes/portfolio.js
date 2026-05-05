import express from "express";
import crypto from "node:crypto";
import { requireAuth } from "../middleware/requireAuth.js";
import { getDbMode, query, readLocalStore, writeLocalStore } from "../db.js";

export const portfolioRouter = express.Router();

portfolioRouter.use(requireAuth);

const SYSTEM_PROFILE_OVERRIDES_BY_EMAIL = {
  "tdspierpy@gmail.com": { initial_capital: 300, initial_asset: "GBP", initial_units: null },
  "malkap92@gmail.com": { initial_capital: 500, initial_asset: "GBP", initial_units: null },
  "josewahobe@gmail.com": { initial_capital: 500, initial_asset: "GBP", initial_units: null }
};

function getSystemProfileOverride(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return null;
  const row = SYSTEM_PROFILE_OVERRIDES_BY_EMAIL[e];
  if (!row || typeof row !== "object") return null;
  const initialCapital = Number(row.initial_capital);
  if (!Number.isFinite(initialCapital) || initialCapital < 0) return null;
  return { initial_capital: Number(initialCapital.toFixed(8)) };
}

function seededHoldingsForCapital(usd) {
  // Privacy requirement: keep a single aggregated holding (POOL).
  const cap = Number(usd);
  return [{ symbol: "POOL", quantity: 1, avg_cost: Number.isFinite(cap) ? cap : 0 }];
}

function asNumber(v) {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function normSymbol(s) {
  const v = String(s || "").trim().toUpperCase();
  if (!v) return null;
  if (!/^[A-Z0-9.:-]{1,16}$/.test(v)) return null;
  return v;
}

function applyTxToHoldings(holdingsBySymbol, tx) {
  // holdingsBySymbol: Map(symbol -> { symbol, quantity, avg_cost })
  const kind = tx.kind;
  const symbol = tx.symbol ? normSymbol(tx.symbol) : null;

  if (kind === "BUY" || kind === "SELL") {
    if (!symbol) throw new Error("Symbol required for BUY/SELL.");
    const quantity = asNumber(tx.quantity);
    const price = asNumber(tx.price);
    if (quantity == null || quantity <= 0) throw new Error("Quantity must be > 0.");
    if (price == null || price <= 0) throw new Error("Price must be > 0.");

    const cur = holdingsBySymbol.get(symbol) || { symbol, quantity: 0, avg_cost: 0 };
    if (kind === "BUY") {
      const newQty = cur.quantity + quantity;
      const newAvg = newQty === 0 ? 0 : (cur.quantity * cur.avg_cost + quantity * price) / newQty;
      holdingsBySymbol.set(symbol, { symbol, quantity: newQty, avg_cost: newAvg });
    } else {
      const newQty = cur.quantity - quantity;
      if (newQty < -1e-9) throw new Error("Cannot sell more than current quantity.");
      if (newQty <= 1e-9) holdingsBySymbol.delete(symbol);
      else holdingsBySymbol.set(symbol, { symbol, quantity: newQty, avg_cost: cur.avg_cost });
    }
  }
}

portfolioRouter.get("/holdings", async (req, res) => {
  const userId = req.user?.sub;
  const userEmail = String(req.user?.email || "").trim().toLowerCase();
  const systemOverride = getSystemProfileOverride(userEmail);
  if (!userId) return res.status(401).json({ error: "Not authenticated" });

  try {
    if (getDbMode() === "local") {
      const store = readLocalStore();
      let rows = (store.holdings || []).filter((h) => h.user_id === userId);
      if (!rows.length) {
        const p = (store.profiles || []).find((x) => x.user_id === userId);
        if (p?.initial_capital) {
          store.holdings = Array.isArray(store.holdings) ? store.holdings : [];
          for (const h of seededHoldingsForCapital(p.initial_capital)) {
            store.holdings.push({
              user_id: userId,
              symbol: h.symbol,
              quantity: h.quantity,
              avg_cost: h.avg_cost,
              updated_at: new Date().toISOString()
            });
          }
          writeLocalStore(store);
          rows = (store.holdings || []).filter((h) => h.user_id === userId);
        }
      }
      const p = (store.profiles || []).find((x) => x.user_id === userId);
      const cap = systemOverride
        ? Number(systemOverride.initial_capital)
        : p?.initial_capital != null
          ? Number(p.initial_capital)
          : 0;
      return res.json({ holdings: [{ symbol: "POOL", quantity: 1, avg_cost: Number.isFinite(cap) ? cap : 0 }] });
    }

    let r = await query(
      "SELECT symbol, quantity::float8 AS quantity, avg_cost::float8 AS avg_cost, updated_at FROM holdings WHERE user_id = $1 ORDER BY symbol ASC",
      [userId]
    );
    if (!r.rows.length) {
      const p = await query("SELECT initial_capital::float8 AS initial_capital FROM user_profiles WHERE user_id = $1", [userId]);
      const cap = p.rows?.[0]?.initial_capital;
      if (typeof cap === "number" && Number.isFinite(cap) && cap > 0) {
        for (const h of seededHoldingsForCapital(cap)) {
          await query(
            "INSERT INTO holdings (user_id, symbol, quantity, avg_cost, updated_at) VALUES ($1, $2, $3, $4, now()) ON CONFLICT (user_id, symbol) DO NOTHING",
            [userId, h.symbol, h.quantity, h.avg_cost]
          );
        }
        r = await query(
          "SELECT symbol, quantity::float8 AS quantity, avg_cost::float8 AS avg_cost, updated_at FROM holdings WHERE user_id = $1 ORDER BY symbol ASC",
          [userId]
        );
      }
    }
    const p = await query("SELECT initial_capital::float8 AS initial_capital FROM user_profiles WHERE user_id = $1", [userId]);
    const cap = systemOverride ? Number(systemOverride.initial_capital) : p.rows?.[0]?.initial_capital;
    res.json({ holdings: [{ symbol: "POOL", quantity: 1, avg_cost: typeof cap === "number" && Number.isFinite(cap) ? cap : 0 }] });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed" });
  }
});

portfolioRouter.get("/transactions", async (req, res) => {
  const userId = req.user?.sub;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });

  const limitRaw = Number(req.query.limit || 50);
  const offsetRaw = Number(req.query.offset || 0);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.floor(limitRaw))) : 50;
  const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.floor(offsetRaw)) : 0;

  try {
    if (getDbMode() === "local") {
      const store = readLocalStore();
      const all = (store.transactions || []).filter((t) => t.user_id === userId);
      all.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
      const items = all.slice(offset, offset + limit);
      return res.json({ total: all.length, items, limit, offset });
    }

    const totalR = await query("SELECT count(*)::int AS n FROM transactions WHERE user_id = $1", [userId]);
    const total = totalR.rows?.[0]?.n ?? 0;
    const r = await query(
      "SELECT id, ts, kind, symbol, quantity::float8 AS quantity, price::float8 AS price, note FROM transactions WHERE user_id = $1 ORDER BY ts DESC, id DESC LIMIT $2 OFFSET $3",
      [userId, limit, offset]
    );
    res.json({ total, items: r.rows, limit, offset });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed" });
  }
});

portfolioRouter.post("/transactions", async (req, res) => {
  const userId = req.user?.sub;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });

  try {
    const kind = String(req.body?.kind || "").trim().toUpperCase();
    const allowed = new Set(["BUY", "SELL", "DIVIDEND", "DEPOSIT", "WITHDRAW"]);
    if (!allowed.has(kind)) return res.status(400).json({ error: "Invalid transaction kind." });

    const symbol = req.body?.symbol != null ? normSymbol(req.body.symbol) : null;
    const quantity = req.body?.quantity != null ? asNumber(req.body.quantity) : null;
    const price = req.body?.price != null ? asNumber(req.body.price) : null;
    const note = req.body?.note != null ? String(req.body.note).slice(0, 500) : null;
    const ts = req.body?.ts ? new Date(req.body.ts) : new Date();
    if (Number.isNaN(ts.getTime())) return res.status(400).json({ error: "Invalid timestamp." });

    const id = crypto.randomUUID();

    if (getDbMode() === "local") {
      const store = readLocalStore();
      store.transactions = Array.isArray(store.transactions) ? store.transactions : [];
      store.holdings = Array.isArray(store.holdings) ? store.holdings : [];

      // Build holdings map for this user
      const map = new Map();
      for (const h of store.holdings.filter((h) => h.user_id === userId)) {
        map.set(h.symbol, { symbol: h.symbol, quantity: Number(h.quantity), avg_cost: Number(h.avg_cost) });
      }

      const tx = { id, user_id: userId, ts: ts.toISOString(), kind, symbol, quantity, price, note };
      applyTxToHoldings(map, tx);

      // Rewrite holdings for user
      store.holdings = store.holdings.filter((h) => h.user_id !== userId);
      for (const h of map.values()) {
        store.holdings.push({
          user_id: userId,
          symbol: h.symbol,
          quantity: h.quantity,
          avg_cost: h.avg_cost,
          updated_at: new Date().toISOString()
        });
      }

      store.transactions.push(tx);
      writeLocalStore(store);
      return res.json({ ok: true, id });
    }

    // PG path: insert transaction then update holdings atomically.
    await query("BEGIN", []);
    try {
      await query(
        "INSERT INTO transactions (id, user_id, ts, kind, symbol, quantity, price, note) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        [id, userId, ts.toISOString(), kind, symbol, quantity, price, note]
      );

      if (kind === "BUY" || kind === "SELL") {
        if (!symbol || quantity == null || price == null) throw new Error("symbol/quantity/price required for BUY/SELL");
        // Load current
        const curR = await query(
          "SELECT quantity::float8 AS quantity, avg_cost::float8 AS avg_cost FROM holdings WHERE user_id = $1 AND symbol = $2",
          [userId, symbol]
        );
        const cur = curR.rows[0] || { quantity: 0, avg_cost: 0 };

        if (kind === "BUY") {
          const newQty = cur.quantity + quantity;
          const newAvg = newQty === 0 ? 0 : (cur.quantity * cur.avg_cost + quantity * price) / newQty;
          await query(
            "INSERT INTO holdings (user_id, symbol, quantity, avg_cost, updated_at) VALUES ($1, $2, $3, $4, now()) ON CONFLICT (user_id, symbol) DO UPDATE SET quantity = EXCLUDED.quantity, avg_cost = EXCLUDED.avg_cost, updated_at = now()",
            [userId, symbol, newQty, newAvg]
          );
        } else {
          const newQty = cur.quantity - quantity;
          if (newQty < -1e-9) throw new Error("Cannot sell more than current quantity.");
          if (newQty <= 1e-9) {
            await query("DELETE FROM holdings WHERE user_id = $1 AND symbol = $2", [userId, symbol]);
          } else {
            await query(
              "UPDATE holdings SET quantity = $3, updated_at = now() WHERE user_id = $1 AND symbol = $2",
              [userId, symbol, newQty]
            );
          }
        }
      }

      await query("COMMIT", []);
    } catch (e) {
      await query("ROLLBACK", []);
      throw e;
    }

    res.json({ ok: true, id });
  } catch (e) {
    try {
      if (getDbMode() !== "local") await query("ROLLBACK", []);
    } catch {}
    res.status(400).json({ error: e?.message || "Failed" });
  }
});
