function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function hashString(s) {
  let h = 2166136261 >>> 0;
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
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function pickPlan(profile) {
  const asset = String(profile?.initial_asset || "USD").toUpperCase();
  if (asset === "BTC") {
    const u = typeof profile?.initial_units === "number" ? profile.initial_units : Number(profile?.initial_units);
    if (!Number.isFinite(u)) return null;
    if (Math.abs(u - 1) < 1e-9) return { key: "BTC1_48H", durationSec: 48 * 3600, unit: "BTC", startValue: 1, targetValue: 2.5 };
    if (Math.abs(u - 2) < 1e-9) return { key: "BTC2_48H", durationSec: 48 * 3600, unit: "BTC", startValue: 2, targetValue: 5 };
    return null;
  }

  const v = Number(profile?.initial_capital);
  const presets = {
    // Active plan table
    500: { target: 5000, hours: 48 },
    600: { target: 6000, hours: 48 },
    700: { target: 7000, hours: 48 },
    800: { target: 8000, hours: 48 },
    900: { target: 9000, hours: 48 },
    1000: { target: 10000, hours: 48 },
    2000: { target: 20000, hours: 168 },
    3000: { target: 30000, hours: 168 },
    4000: { target: 40000, hours: 168 },
    5000: { target: 50000, hours: 168 },
    6000: { target: 60000, hours: 168 },
    7000: { target: 70000, hours: 168 },
    // Legacy support
    300: { target: 3500, hours: 24 },
    10000: { target: 100000, hours: 48 }
  };

  for (const k of Object.keys(presets)) {
    const n = Number(k);
    if (Math.abs(v - n) < 0.01) {
      const p = presets[n];
      const fiatUnit = asset === "GBP" ? "GBP" : "USD";
      return { key: `${fiatUnit}${n}_${p.hours}H`, durationSec: p.hours * 3600, unit: fiatUnit, startValue: n, targetValue: p.target };
    }
  }
  return null;
}

function buildAnchoredPath(seed, S, E, steps) {
  const rng = mulberry32(hashString(seed) ^ 0x9e3779b9);
  const out = new Float64Array(steps + 1);
  out[0] = S;

  const totalMove = Math.max(1e-9, Math.abs(E - S));
  const volBase = totalMove * 0.012 + Math.abs(S) * 0.006;

  for (let i = 0; i < steps; i++) {
    const remaining = Math.max(1, steps - i);
    const drift = (E - out[i]) / remaining;
    const taper = Math.sqrt(remaining / Math.max(1, steps));
    const sigma = volBase * taper * 0.18;
    const z = normal01(rng);

    const prev = i > 0 ? out[i] - out[i - 1] : 0;
    const anchor = S + ((E - S) * i) / Math.max(1, steps);
    const meanRev = (anchor - out[i]) * 0.08;
    const momentum = prev * 0.45;

    const u = rng();
    const isConsolidation = u < 0.22;
    const isDip = u >= 0.22 && u < 0.28;

    let step = drift + meanRev + momentum + sigma * z;
    if (isConsolidation) step *= 0.15;
    if (isDip) step -= Math.abs(normal01(rng)) * volBase * 0.35;

    out[i + 1] = out[i] + step;
    if (!Number.isFinite(out[i + 1])) out[i + 1] = out[i] + drift;
    if (out[i + 1] <= 0) out[i + 1] = Math.max(1e-9, (S + ((E - S) * (i + 1)) / steps) * 0.25);
  }

  const delta = E - out[steps];
  for (let i = 1; i <= steps; i++) out[i] = out[i] + (i / steps) * delta;
  return out;
}

function valueAtFromMinuteSeries(args) {
  const { closes, startSec, totalSec, tSec } = args;
  const tt = clamp(tSec, startSec, startSec + totalSec) - startSec;
  const steps = closes.length - 1;
  const idxFloat = (tt / Math.max(1, totalSec)) * steps;
  const idx = clamp(Math.floor(idxFloat), 0, Math.max(0, steps - 1));
  const alpha = clamp(idxFloat - idx, 0, 1);
  return closes[idx] + alpha * (closes[idx + 1] - closes[idx]);
}

export function computeCurrentValue(args) {
  const { seed, startSec, totalSec, nowSec, S, E } = args;
  const stepSec = 60;
  const steps = Math.max(1, Math.floor(totalSec / stepSec) || 1);
  const closes = buildAnchoredPath(`${seed}:min`, S, E, steps);
  return valueAtFromMinuteSeries({ closes, startSec, totalSec, tSec: nowSec });
}

export function computeProgress(args) {
  const { plan, currentValue } = args;
  const denom = plan.targetValue - plan.startValue;
  const num = currentValue - plan.startValue;
  const progress01 = denom === 0 ? 1 : clamp(num / denom, 0, 1);
  return { progress01, taxRate: 0.2 * progress01 };
}
