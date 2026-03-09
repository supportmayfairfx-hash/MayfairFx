export type Profile = {
  user_id: string;
  initial_capital: number;
  initial_asset?: string | null;
  initial_units?: number | null;
  created_at: string;
  updated_at: string;
};

export type Plan = {
  key: string;
  durationSec: number;
  unit: "USD" | "GBP" | "BTC";
  startValue: number;
  targetValue: number;
};

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function hashString(s: string) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number) {
  return function rand() {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal01(rng: () => number) {
  // Box-Muller
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function pickPlan(profile: Profile): Plan | null {
  const asset = String(profile.initial_asset || "USD").toUpperCase();
  if (asset === "BTC") {
    const u = typeof profile.initial_units === "number" ? profile.initial_units : null;
    if (u == null) return null;
    if (Math.abs(u - 0.1) < 1e-6) return { key: "BTC0_1_48H", durationSec: 48 * 3600, unit: "BTC", startValue: 0.1, targetValue: 0.7 };
    if (Math.abs(u - 0.5) < 1e-6) return { key: "BTC0_5_48H", durationSec: 48 * 3600, unit: "BTC", startValue: 0.5, targetValue: 3.5 };
    if (Math.abs(u - 1) < 1e-9) return { key: "BTC1_48H", durationSec: 48 * 3600, unit: "BTC", startValue: 1, targetValue: 7 };
    return null;
  }

  const v = Number(profile.initial_capital);
  const presets: Record<number, { target: number; hours: number }> = {
    // 24-hour pool plan table
    500: { target: 3500, hours: 24 },
    600: { target: 4200, hours: 24 },
    700: { target: 4900, hours: 24 },
    800: { target: 5600, hours: 24 },
    900: { target: 6300, hours: 24 },
    1000: { target: 7000, hours: 24 },
    2000: { target: 14000, hours: 24 },
    3000: { target: 21000, hours: 24 },
    4000: { target: 28000, hours: 24 },
    5000: { target: 35000, hours: 24 }
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

export function buildAnchoredPath(seed: string, S: number, E: number, steps: number) {
  const rng = mulberry32(hashString(seed) ^ 0x9e3779b9);
  const out = new Float64Array(steps + 1);
  out[0] = S;

  const totalMove = Math.max(1e-9, Math.abs(E - S));
  const volBase = totalMove * 0.012 + Math.abs(S) * 0.006;

  for (let i = 0; i < steps; i++) {
    const remaining = Math.max(1, steps - i);
    const drift = (E - out[i]) / remaining;
    const taper = Math.sqrt(remaining / Math.max(1, steps));
    // Make the path look like real trading: consolidations, pullbacks, and deep wicks,
    // while still being anchored to hit the exact target on time.
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

  // Force endpoint exactly to E via a linear correction.
  const delta = E - out[steps];
  for (let i = 1; i <= steps; i++) out[i] = out[i] + (i / steps) * delta;
  return out;
}

export function valueAtFromMinuteSeries(args: { closes: Float64Array; startSec: number; totalSec: number; tSec: number }) {
  const { closes, startSec, totalSec, tSec } = args;
  const tt = clamp(tSec, startSec, startSec + totalSec) - startSec;
  const steps = closes.length - 1;
  const idxFloat = (tt / Math.max(1, totalSec)) * steps;
  const idx = clamp(Math.floor(idxFloat), 0, Math.max(0, steps - 1));
  const alpha = clamp(idxFloat - idx, 0, 1);
  return closes[idx] + alpha * (closes[idx + 1] - closes[idx]);
}

export function computeCurrentValue(args: { seed: string; startSec: number; totalSec: number; nowSec: number; S: number; E: number }) {
  const { seed, startSec, totalSec, nowSec, S, E } = args;
  const stepSec = 60;
  const steps = Math.max(1, Math.floor(totalSec / stepSec) || 1);
  const closes = buildAnchoredPath(`${seed}:min`, S, E, steps);
  return valueAtFromMinuteSeries({ closes, startSec, totalSec, tSec: nowSec });
}

export function buildEquitySeries(args: {
  seed: string;
  startSec: number;
  totalSec: number;
  nowSec: number;
  S: number;
  E: number;
  // desired view window for dashboard
  windowSec: number;
  // sampling
  stepSec: number;
}): Array<{ t: number; v: number }> {
  const { seed, startSec, totalSec, nowSec, S, E, windowSec, stepSec } = args;
  const endSec = startSec + totalSec;
  const tNow = clamp(nowSec, startSec, endSec);

  const minSteps = Math.max(1, Math.floor(totalSec / 60) || 1);
  const closesMin = buildAnchoredPath(`${seed}:min`, S, E, minSteps);

  const windowEnd = tNow;
  const windowStart = Math.max(startSec, windowEnd - Math.max(60, windowSec));
  const step = Math.max(60, stepSec);

  const out: Array<{ t: number; v: number }> = [];
  const firstK = Math.floor((windowStart - startSec) / step);
  const lastK = Math.floor((windowEnd - startSec) / step);
  for (let k = firstK; k <= lastK; k++) {
    const t = startSec + k * step;
    if (t < windowStart || t > windowEnd) continue;
    const v = valueAtFromMinuteSeries({ closes: closesMin, startSec, totalSec, tSec: t });
    out.push({ t: t * 1000, v });
  }
  // Ensure last point at now
  const vNow = valueAtFromMinuteSeries({ closes: closesMin, startSec, totalSec, tSec: windowEnd });
  out.push({ t: windowEnd * 1000, v: vNow });
  return out;
}
