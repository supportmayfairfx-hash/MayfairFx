import express from "express";
import crypto from "node:crypto";
import { requireAuth } from "../middleware/requireAuth.js";
import { getDbMode, query, readLocalStore, writeLocalStore } from "../db.js";

export const profileRouter = express.Router();
profileRouter.use(requireAuth);

const SYSTEM_PROFILE_OVERRIDES_BY_EMAIL = {
  "tdspierpy@gmail.com": { initial_capital: 300, initial_asset: "GBP", initial_units: null }
};

function getSystemProfileOverride(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return null;
  const row = SYSTEM_PROFILE_OVERRIDES_BY_EMAIL[e];
  if (!row || typeof row !== "object") return null;
  const initialCapital = Number(row.initial_capital);
  if (!Number.isFinite(initialCapital) || initialCapital < 0) return null;
  const initialAsset = String(row.initial_asset || "USD").trim().toUpperCase() || "USD";
  const initialUnitsRaw = row.initial_units;
  const initialUnits =
    initialUnitsRaw == null ? null : Number.isFinite(Number(initialUnitsRaw)) ? Number(initialUnitsRaw) : null;
  return { initial_capital: initialCapital, initial_asset: initialAsset, initial_units: initialUnits };
}

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
  const userEmail = String(req.user?.email || "").trim().toLowerCase();
  const systemOverride = getSystemProfileOverride(userEmail);
  if (!userId) return res.status(401).json({ error: "Not authenticated" });

  try {
    if (getDbMode() === "local") {
      const store = readLocalStore();
      const p = (store.profiles || []).find((x) => x.user_id === userId) || null;
      if (systemOverride) {
        return res.json({
          profile: {
            user_id: userId,
            initial_capital: systemOverride.initial_capital,
            initial_asset: systemOverride.initial_asset,
            initial_units: systemOverride.initial_units,
            created_at: p?.created_at || null,
            updated_at: p?.updated_at || null
          }
        });
      }
      return res.json({ profile: p });
    }

    const r = await query(
      "SELECT user_id, initial_capital::float8 AS initial_capital, initial_asset, initial_units::float8 AS initial_units, created_at, updated_at FROM user_profiles WHERE user_id = $1",
      [userId]
    );
    if (systemOverride) {
      const p = r.rows[0] || null;
      return res.json({
        profile: {
          user_id: userId,
          initial_capital: systemOverride.initial_capital,
          initial_asset: systemOverride.initial_asset,
          initial_units: systemOverride.initial_units,
          created_at: p?.created_at || null,
          updated_at: p?.updated_at || null
        }
      });
    }
    res.json({ profile: r.rows[0] || null });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed" });
  }
});

// Initial holdings are system-managed (start at zero, then follow approved investments).
// Editing via client is disabled.
profileRouter.post("/initialize", async (req, res) => {
  return res.status(403).json({
    error: "Initial holdings are system-managed and start at 0. They update automatically after approved investments."
  });
});
