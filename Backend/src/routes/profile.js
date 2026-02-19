import express from "express";
import crypto from "node:crypto";
import { requireAuth } from "../middleware/requireAuth.js";
import { getDbMode, query, readLocalStore, writeLocalStore } from "../db.js";

export const profileRouter = express.Router();
profileRouter.use(requireAuth);

function seededHoldingsForCapital(usd) {
  // Privacy requirement: keep a single aggregated holding in the DB (no per-asset disclosure).
  const cap = Number(usd);
  return [{ symbol: "POOL", quantity: 1, avg_cost: Number.isFinite(cap) ? cap : 0 }];
}

function asMoney(v) {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return null;
  if (n > 1e12) return null;
  return Math.round(n * 100) / 100;
}

profileRouter.get("/me", async (req, res) => {
  const userId = req.user?.sub;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });

  try {
    if (getDbMode() === "local") {
      const store = readLocalStore();
      const p = (store.profiles || []).find((x) => x.user_id === userId) || null;
      return res.json({ profile: p });
    }

    const r = await query(
      "SELECT user_id, initial_capital::float8 AS initial_capital, initial_asset, initial_units::float8 AS initial_units, created_at, updated_at FROM user_profiles WHERE user_id = $1",
      [userId]
    );
    res.json({ profile: r.rows[0] || null });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed" });
  }
});

// First-time user initialization. Only allowed if profile doesn't exist.
profileRouter.post("/initialize", async (req, res) => {
  const userId = req.user?.sub;
  const email = req.user?.email;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });

  const initialCapital = asMoney(req.body?.initialCapital);
  if (initialCapital == null) return res.status(400).json({ error: "Initial capital must be a positive number." });
  const initialAsset = req.body?.initialAsset ? String(req.body.initialAsset).trim().toUpperCase() : "USD";
  const initialUnits = req.body?.initialUnits != null ? asMoney(req.body.initialUnits) : null;
  if (!["USD", "BTC"].includes(initialAsset)) return res.status(400).json({ error: "Invalid initial asset." });
  if (initialAsset === "BTC" && (initialUnits == null || initialUnits <= 0)) {
    return res.status(400).json({ error: "BTC units must be a positive number." });
  }

  try {
    if (getDbMode() === "local") {
      const store = readLocalStore();
      store.profiles = Array.isArray(store.profiles) ? store.profiles : [];
      const existing = store.profiles.find((x) => x.user_id === userId);
      if (existing) return res.status(409).json({ error: "Profile already initialized." });

      const row = {
        user_id: userId,
        email: email || null,
        initial_capital: initialCapital,
        initial_asset: initialAsset,
        initial_units: initialUnits,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      store.profiles.push(row);

      // Seed a minimal holdings row once, so the portfolio has an initial state.
      store.holdings = Array.isArray(store.holdings) ? store.holdings : [];
      const hasHoldings = store.holdings.some((h) => h.user_id === userId);
      if (!hasHoldings) {
        for (const h of seededHoldingsForCapital(initialCapital)) {
          store.holdings.push({
            user_id: userId,
            symbol: h.symbol,
            quantity: h.quantity,
            avg_cost: h.avg_cost,
            updated_at: new Date().toISOString()
          });
        }
      }

      writeLocalStore(store);
      return res.json({ ok: true, profile: row });
    }

    const existing = await query("SELECT user_id FROM user_profiles WHERE user_id = $1", [userId]);
    if (existing.rows.length) return res.status(409).json({ error: "Profile already initialized." });

    const id = crypto.randomUUID(); // unused, but keeps parity with UUID needs if you later change PK.
    void id;
    const r = await query(
      "INSERT INTO user_profiles (user_id, initial_capital, initial_asset, initial_units) VALUES ($1, $2, $3, $4) RETURNING user_id, initial_capital::float8 AS initial_capital, initial_asset, initial_units::float8 AS initial_units, created_at, updated_at",
      [userId, initialCapital, initialAsset, initialUnits]
    );

    // Seed holdings if the user has none yet.
    const hCount = await query("SELECT count(*)::int AS n FROM holdings WHERE user_id = $1", [userId]);
    const n = hCount.rows?.[0]?.n ?? 0;
    if (!n) {
      const seeded = seededHoldingsForCapital(initialCapital);
      for (const h of seeded) {
        await query(
          "INSERT INTO holdings (user_id, symbol, quantity, avg_cost, updated_at) VALUES ($1, $2, $3, $4, now()) ON CONFLICT (user_id, symbol) DO NOTHING",
          [userId, h.symbol, h.quantity, h.avg_cost]
        );
      }
    }

    res.json({ ok: true, profile: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed" });
  }
});
