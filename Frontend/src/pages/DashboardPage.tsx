import { useEffect, useMemo, useState } from "react";
import { fetchMarketSnapshot, type MarketSnapshot } from "../markets";
import LineChart, { type ChartPoint } from "../components/LineChart";
import { pickTradingQuote } from "../data/tradingQuotes";
import trader1 from "../assets/trader-01.svg";
import trader2 from "../assets/trader-02.svg";
import trader3 from "../assets/trader-03.svg";
import DashVFX from "../components/DashVFX";
import MarketCore3D, { type MarketCorePlate } from "../components/3d/MarketCore3D";
import { motion } from "framer-motion";
import {
  Activity,
  Bell,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  DollarSign,
  Eye,
  Flame,
  Newspaper,
  Rocket,
  Send,
  Shield,
  TrendingUp,
  Wallet,
  X,
  Zap,
  type LucideIcon
} from "lucide-react";
import { buildEquitySeries, computeCurrentValue, pickPlan, type Profile } from "../sim/progressSim";
import Notice from "../components/Notice";
import Skeleton from "../components/Skeleton";
import { apiUrl } from "../lib/api";

type PhotoItem = { name: string; url: string; uploadedMs?: number; mtimeMs?: number };
type DepositItem = {
  id: string;
  amount: number;
  asset: string;
  method: string;
  chain?: string | null;
  reference?: string | null;
  note?: string | null;
  provider?: string | null;
  invoice_id?: string | null;
  payment_url?: string | null;
  qr_code?: string | null;
  status: string;
  created_at: string;
};

type MarketFetchState =
  | { status: "idle" | "loading"; data: MarketSnapshot | null; error: null }
  | { status: "ok"; data: MarketSnapshot; error: null }
  | { status: "error"; data: MarketSnapshot | null; error: string };

type StreamState =
  | { status: "idle" | "connecting"; error: null }
  | { status: "connected"; error: null }
  | { status: "error"; error: string };

type AppleIconKind =
  | "money"
  | "bolt"
  | "fire"
  | "check"
  | "rocket"
  | "chevronDown"
  | "pulse"
  | "session"
  | "context"
  | "shield"
  | "trend"
  | "support"
  | "news"
  | "activity";

function AppleIcon({
  kind,
  className = "",
  size = "md"
}: {
  kind: AppleIconKind;
  className?: string;
  size?: "md" | "sm";
}) {
  const icons: Record<AppleIconKind, LucideIcon> = {
    money: DollarSign,
    bolt: Zap,
    fire: Flame,
    check: Check,
    rocket: Rocket,
    chevronDown: ChevronDown,
    pulse: Activity,
    session: Clock3,
    context: Eye,
    shield: Shield,
    trend: TrendingUp,
    support: Send,
    news: Newspaper,
    activity: Bell
  };
  const Icon = icons[kind];

  return (
    <span className={`appleUiIcon appleUiIcon--${kind} appleUiIcon--${size} ${className}`.trim()} aria-hidden="true">
      <Icon size={size === "sm" ? 16 : 20} strokeWidth={2.4} role="presentation" />
    </span>
  );
}

function isPlausibleQuote(key: string, v: number): boolean {
  if (!Number.isFinite(v)) return false;
  // Hard bounds to prevent nonsense from ever showing on the UI.
  // These are intentionally wide but rule out the "0.013 EURUSD" / "1.56 XAU" type drift.
  if (key === "BTC-USD") return v > 1_000 && v < 5_000_000;
  if (key === "ETH-USD") return v > 1 && v < 500_000;
  if (key === "SOL-USD") return v > 0.01 && v < 50_000;
  if (key === "XAUUSD") return v > 500 && v < 20_000;
  if (key === "EUR/USD") return v > 0.5 && v < 2.5;
  return v > 0;
}

function uiConn(stream: StreamState, hasData: boolean) {
  if (stream.status === "connected") return { label: "Live", cls: "pos" as const };
  if (hasData) return { label: "Updating", cls: "muted" as const };
  if (stream.status === "connecting") return { label: "Connecting", cls: "muted" as const };
  return { label: "Offline", cls: "neg" as const };
}

function uiSession(v: "open" | "closed") {
  return v === "open" ? { label: "Open", cls: "pos" as const } : { label: "Closed", cls: "muted" as const };
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(apiUrl(path), { method: "GET", credentials: "include", headers: { Accept: "application/json" } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`);
  return j as T;
}

async function postJson<T>(path: string, body: any): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body || {})
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`);
  return j as T;
}

function backendToMarketSnapshot(j: any): MarketSnapshot {
  const asOf = typeof j?.asOf === "string" ? j.asOf : new Date().toISOString();
  const sources = {
    crypto: typeof j?.sources?.crypto === "string" ? j.sources.crypto : "Backend",
    fx: typeof j?.sources?.fx === "string" ? j.sources.fx : "Backend",
    metals: typeof j?.sources?.metals === "string" ? j.sources.metals : "Backend"
  };

  const crypto = (Array.isArray(j?.crypto) ? j.crypto : [])
    .map((c: any) => {
      const sym = typeof c?.symbol === "string" ? c.symbol.toUpperCase() : null;
      const price = typeof c?.price === "number" ? c.price : typeof c?.price === "string" ? Number(c.price) : null;
      if (!sym || !Number.isFinite(price)) return null;
      return { productId: `${sym}-USD`, price, time: asOf };
    })
    .filter(Boolean) as any;

  const fx = (Array.isArray(j?.fx) ? j.fx : [])
    .map((f: any) => {
      const pair = typeof f?.pair === "string" ? f.pair : null;
      const rate = typeof f?.rate === "number" ? f.rate : typeof f?.rate === "string" ? Number(f.rate) : null;
      if (!pair || !Number.isFinite(rate)) return null;
      return { pair, rate, time: asOf };
    })
    .filter(Boolean) as any;

  const metals = (Array.isArray(j?.metals) ? j.metals : [])
    .map((m: any) => {
      const symbol = typeof m?.symbol === "string" ? m.symbol.toUpperCase() : null;
      const price = typeof m?.price === "number" ? m.price : typeof m?.price === "string" ? Number(m.price) : null;
      const updatedAt = typeof m?.updatedAt === "string" ? m.updatedAt : null;
      if (!symbol || !Number.isFinite(price)) return null;
      return { symbol, price, time: updatedAt || asOf };
    })
    .filter(Boolean) as any;

  const marketStatus: MarketSnapshot["marketStatus"] = j?.marketStatus
    ? {
        crypto: j.marketStatus.crypto === "closed" ? "closed" : "open",
        fx: j.marketStatus.fx === "closed" ? "closed" : "open",
        metals: j.marketStatus.metals === "closed" ? "closed" : "open",
        tz: typeof j.marketStatus.tz === "string" ? j.marketStatus.tz : undefined
      }
    : undefined;

  return { asOf, sources, crypto, fx, metals, marketStatus };
}

export default function DashboardPage({
  displayName,
  userId,
  userCreatedAt
}: {
  displayName: string;
  userId: string | null;
  userCreatedAt: string | null;
}) {
  const [marketState, setMarketState] = useState<MarketFetchState>({
    status: "idle",
    data: null,
    error: null
  });

  const [stream, setStream] = useState<StreamState>({ status: "idle", error: null });

  const [series, setSeries] = useState<Record<string, ChartPoint[]>>(() => {
    // Seed so the dashboard never looks empty on first load.
    // Real prices overwrite this immediately once SSE/polling returns.
    const now = Date.now();
    const mk = (base: number, vol: number, n: number) => {
      const pts: ChartPoint[] = [];
      let v = base;
      for (let i = 0; i < n; i++) {
        const t = now - (n - 1 - i) * 60_000;
        const step = (Math.sin(i * 0.55) + Math.cos(i * 0.23)) * (vol * 0.28) + (Math.random() - 0.5) * vol;
        v = Math.max(0.0001, v + step);
        pts.push({ t, v });
      }
      return pts;
    };

    // Try to start from last known quotes to feel "real" even before the first fetch.
    try {
      const raw = localStorage.getItem("last_quotes_v1");
      if (raw) {
        const j = JSON.parse(raw);
        const b = Number(j?.btc);
        const e = Number(j?.eth);
        const g = Number(j?.xau);
        const fx = Number(j?.eurusd);

        const okBtc = isPlausibleQuote("BTC-USD", b);
        const okEth = isPlausibleQuote("ETH-USD", e);
        const okXau = isPlausibleQuote("XAUUSD", g);
        const okFx = isPlausibleQuote("EUR/USD", fx);
        return {
          "XAUUSD": mk(okXau ? g : 2034.2, 2.4, 90),
          "BTC-USD": mk(okBtc ? b : 68000, 220, 90),
          "ETH-USD": mk(okEth ? e : 3400, 28, 90),
          "EUR/USD": mk(okFx ? fx : 1.085, 0.004, 90)
        };
      }
    } catch {}

    return {
      "XAUUSD": mk(2034.2, 2.4, 90),
      "BTC-USD": mk(68000, 220, 90),
      "ETH-USD": mk(3400, 28, 90),
      "EUR/USD": mk(1.085, 0.004, 90)
    };
  });

  const [photos, setPhotos] = useState<{ status: "idle" | "loading" | "ok" | "error"; items: PhotoItem[]; error: string | null }>({
    status: "idle",
    items: [],
    error: null
  });
  const [photosReloadKey, setPhotosReloadKey] = useState(0);

  const [profile, setProfile] = useState<Profile | null>(null);
  const [depositOpen, setDepositOpen] = useState(false);
  const [depositBusy, setDepositBusy] = useState(false);
  const [depositMsg, setDepositMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [depositAmount, setDepositAmount] = useState("");
  const [depositAsset, setDepositAsset] = useState("BTC");
  const [depositMethod, setDepositMethod] = useState<"Bank Transfer" | "Crypto Wallet" | "Card">("Crypto Wallet");
  const [depositChain, setDepositChain] = useState<"BTC" | "ERC20" | "TRC20" | "BEP20" | "SOL">("BTC");
  const [depositReference, setDepositReference] = useState("");
  const [depositNote, setDepositNote] = useState("");
  const [deposits, setDeposits] = useState<DepositItem[]>([]);
  const [lastPaymentUrl, setLastPaymentUrl] = useState<string | null>(null);
  const [lastQrCode, setLastQrCode] = useState<string | null>(null);

  const refreshMarkets = useMemo(() => {
    return async (signal?: AbortSignal) => {
      setMarketState((s) => ({ status: "loading", data: s.data, error: null }));
      try {
        const snap = await fetchMarketSnapshot(signal);
        setMarketState({ status: "ok", data: snap, error: null });

        setSeries((prev) => {
          const next: Record<string, ChartPoint[]> = { ...prev };
          const seed = (key: string, last: number, pct: number) => {
            const now = Date.now();
            const n = 72;
            const pts: ChartPoint[] = [];
            let v = Math.max(0.0001, last);
            const vol = Math.max(1e-9, Math.abs(last) * pct);
            for (let i = 0; i < n; i++) {
              const t = now - (n - 1 - i) * 60_000;
              const wave = (Math.sin(i * 0.45) + Math.cos(i * 0.22)) * (vol * 0.18);
              const noise = (Math.random() - 0.5) * (vol * 0.9);
              v = Math.max(0.0001, v + wave + noise);
              pts.push({ t, v });
            }
            // Anchor the last point to the actual value for credibility.
            pts[pts.length - 1] = { t: now, v: last };
            next[key] = pts;
          };

          const push = (key: string, v: number) => {
            const pts = next[key] ? [...next[key]] : [];
            if (pts.length < 2) {
              // Per-symbol volatility tuning (keeps it realistic for known traders).
              const p =
                key === "BTC-USD" ? 0.0032 :
                key === "ETH-USD" ? 0.0042 :
                key === "SOL-USD" ? 0.006 :
                key === "XAUUSD" ? 0.0012 :
                key === "EUR/USD" ? 0.00045 :
                0.002;
              seed(key, v, p);
              return;
            }
            pts.push({ t: Date.now(), v });
            next[key] = pts.slice(Math.max(0, pts.length - 240));
          };

          for (const c of snap.crypto) push(c.productId, c.price);
          for (const f of snap.fx) push(f.pair, f.rate);
          const xau = (snap.metals ?? []).find((m) => m.symbol === "XAU" && Number.isFinite(m.price));
          if (xau) push("XAUUSD", xau.price);
          return next;
        });
      } catch (e: any) {
        const msg = typeof e?.message === "string" ? e.message : "Failed to fetch market data";
        setMarketState((s) => ({ status: "error", data: s.data, error: msg }));
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let es: EventSource | null = null;
    let closed = false;
    setStream({ status: "connecting", error: null });

    // Prefer SSE for true per-second pushes. If it fails, fallback to polling.
    const url = new URL(apiUrl("/api/markets/stream"), typeof window !== "undefined" ? window.location.origin : "http://localhost");
    url.searchParams.set("symbols", "BTC,ETH,SOL");

    if (typeof (window as any).EventSource === "undefined") {
      setStream({ status: "error", error: "Live updates unavailable" });
    } else {
      try {
        es = new EventSource(url.toString());
        es.addEventListener("open", () => {
          if (closed) return;
          setStream({ status: "connected", error: null });
        });

      es.addEventListener("snapshot", (evt: any) => {
        if (closed) return;
        try {
          const data = typeof evt?.data === "string" ? JSON.parse(evt.data) : null;
          if (!data) return;
          const snap = backendToMarketSnapshot(data);
          setMarketState({ status: "ok", data: snap, error: null });

          setSeries((prev) => {
            const next: Record<string, ChartPoint[]> = { ...prev };
            const seed = (key: string, last: number, pct: number) => {
              const now = Date.now();
              const n = 72;
              const pts: ChartPoint[] = [];
              let v = Math.max(0.0001, last);
              const vol = Math.max(1e-9, Math.abs(last) * pct);
              for (let i = 0; i < n; i++) {
                const t = now - (n - 1 - i) * 60_000;
                const wave = (Math.sin(i * 0.45) + Math.cos(i * 0.22)) * (vol * 0.18);
                const noise = (Math.random() - 0.5) * (vol * 0.9);
                v = Math.max(0.0001, v + wave + noise);
                pts.push({ t, v });
              }
              pts[pts.length - 1] = { t: now, v: last };
              next[key] = pts;
            };

            const push = (key: string, v: number) => {
              if (!isPlausibleQuote(key, v)) return;
              const pts = next[key] ? [...next[key]] : [];
              if (pts.length < 2) {
                const p =
                  key === "BTC-USD" ? 0.0032 :
                  key === "ETH-USD" ? 0.0042 :
                  key === "SOL-USD" ? 0.006 :
                  key === "XAUUSD" ? 0.0012 :
                  key === "EUR/USD" ? 0.00045 :
                  0.002;
                seed(key, v, p);
                return;
              }
              pts.push({ t: Date.now(), v });
              next[key] = pts.slice(Math.max(0, pts.length - 240));
            };

            for (const c of snap.crypto) push(c.productId, c.price);

            // FX/metals gating: if backend says closed, we still display the last value but we don't
            // artificially animate it. (SSE will send the same value while frozen.)
            for (const f of snap.fx) push(f.pair, f.rate);
            const xau = (snap.metals ?? []).find((m) => m.symbol === "XAU" && Number.isFinite(m.price));
            if (xau) push("XAUUSD", xau.price);

            return next;
          });

          // Persist last known quotes so reloads feel instant.
          try {
            const btc = snap.crypto.find((c) => c.productId === "BTC-USD")?.price;
            const eth = snap.crypto.find((c) => c.productId === "ETH-USD")?.price;
            const eurusd = snap.fx.find((f) => f.pair === "EUR/USD")?.rate;
            const xau = snap.metals?.find((m) => m.symbol === "XAU")?.price;
            localStorage.setItem(
              "last_quotes_v1",
              JSON.stringify({
                asOf: snap.asOf,
                btc: typeof btc === "number" ? btc : null,
                eth: typeof eth === "number" ? eth : null,
                eurusd: typeof eurusd === "number" ? eurusd : null,
                xau: typeof xau === "number" ? xau : null
              })
            );
          } catch {}
        } catch {
          // ignore parse errors
        }
      });

        es.addEventListener("error", () => {
          if (closed) return;
          // EventSource auto-reconnects; treat errors as "connecting" unless the browser fully closed it.
          const rs = es ? es.readyState : 0;
          if (rs === (EventSource as any).CONNECTING) setStream({ status: "connecting", error: null });
          else setStream({ status: "error", error: "Live updates unavailable" });
        });
      } catch {
        setStream({ status: "error", error: "Live updates unavailable" });
      }
    }

    // Fallback polling if SSE doesn't connect or drops.
    const ac = new AbortController();
    void refreshMarkets(ac.signal);
    const t = window.setInterval(() => {
      // Only poll if SSE isn't connected.
      if (es && es.readyState === EventSource.OPEN) return;
      const acTick = new AbortController();
      void refreshMarkets(acTick.signal);
    }, 2500);

    return () => {
      closed = true;
      ac.abort();
      window.clearInterval(t);
      try {
        es?.close();
      } catch {}
    };
  }, [refreshMarkets]);

  // Micro-tick: update the UI every second between real fetches to feel alive,
  // while staying close to the last real prices (corrected on next fetch).
  useEffect(() => {
    if (stream.status === "connected") return;
    const id = window.setInterval(() => {
      setSeries((prev) => {
        const next: Record<string, ChartPoint[]> = { ...prev };
        // Only micro-tick crypto. FX/metals should not "move" when the market is closed,
        // and we should never invent ticks for those on the dashboard.
        const keys = Object.keys(next).filter((k) => k === "BTC-USD" || k === "ETH-USD" || k === "SOL-USD");
        if (!keys.length) return prev;

        const stepFor = (k: string) => {
          // Approx "per-second" volatility caps (keeps it believable).
          if (k === "BTC-USD") return 0.00025;
          if (k === "ETH-USD") return 0.00035;
          if (k === "SOL-USD") return 0.0006;
          return 0.0002;
        };

        for (const k of keys) {
          const pts = next[k] ? [...next[k]] : [];
          if (pts.length < 3) continue;
          const last = pts[pts.length - 1].v;
          const prev1 = pts[pts.length - 2].v;
          const prev2 = pts[pts.length - 3].v;

          const trend = (last - prev1) + 0.35 * (prev1 - prev2);
          const cap = Math.max(1e-9, Math.abs(last) * stepFor(k));
          const noise = (Math.random() - 0.5) * cap * 2.0;
          const drift = Math.max(-cap, Math.min(cap, trend * 0.12));
          const v = Math.max(0.00000001, last + drift + noise);

          if (!isPlausibleQuote(k, v)) continue;
          pts.push({ t: Date.now(), v });
          next[k] = pts.slice(Math.max(0, pts.length - 240));
        }
        return next;
      });
    }, 1000);

    return () => window.clearInterval(id);
  }, [stream.status]);

  useEffect(() => {
    let alive = true;
    setPhotos((s) => ({ ...s, status: "loading", error: null }));
    const load = async () => {
      try {
        const r = await getJson<{ items: PhotoItem[] }>("/api/photos");
        const items = Array.isArray(r.items) ? r.items : [];
        if (!alive) return;
        setPhotos({ status: "ok", items, error: null });
      } catch (e: any) {
        if (!alive) return;
        setPhotos({ status: "error", items: [], error: typeof e?.message === "string" ? e.message : "Failed" });
      }
    };
    void load();
    const t = window.setInterval(load, 16_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [photosReloadKey]);

  useEffect(() => {
    if (!userId) {
      setProfile(null);
      return;
    }
    let alive = true;
    getJson<{ profile: Profile | null }>("/api/profile/me")
      .then((r) => {
        if (!alive) return;
        setProfile(r.profile);
      })
      .catch(() => {
        if (!alive) return;
        setProfile(null);
      });
    return () => {
      alive = false;
    };
  }, [userId]);

  useEffect(() => {
    if (!userId) {
      setDeposits([]);
      return;
    }
    let alive = true;
    const load = async () => {
      try {
        const r = await getJson<{ items: DepositItem[] }>("/api/deposits/me");
        if (!alive) return;
        setDeposits(Array.isArray(r.items) ? r.items : []);
      } catch {
        if (!alive) return;
        setDeposits([]);
      }
    };
    void load();
    const t = window.setInterval(load, 5000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [userId]);

  useEffect(() => {
    if (depositAsset !== "BTC") return;
    if (depositMethod !== "Crypto Wallet") setDepositMethod("Crypto Wallet");
    if (depositChain !== "BTC") setDepositChain("BTC");
  }, [depositAsset, depositMethod, depositChain]);

  const greeting = useMemo(() => {
    if (!userId || displayName === "Guest") return "Know what changed. Act with context.";
    const k = `seen:${userId}`;
    const seen = typeof window !== "undefined" ? window.localStorage.getItem(k) : null;
    if (!seen) {
      try {
        window.localStorage.setItem(k, "1");
      } catch {}
      return `Welcome ${displayName}`;
    }
    return `Welcome back ${displayName}`;
  }, [displayName, userId]);

  const updatedAt = marketState.data?.asOf ? new Date(marketState.data.asOf).toLocaleTimeString() : "--:--:--";
  const fxStatus = marketState.data?.marketStatus?.fx || "open";
  const metalsStatus = marketState.data?.marketStatus?.metals || "open";
  const conn = uiConn(stream, !!marketState.data);
  const fxUi = uiSession(fxStatus);
  const metalsUi = uiSession(metalsStatus);

  const lastVal = (pts: ChartPoint[]) => (pts.length ? pts[pts.length - 1].v : null);
  const pctChg = (pts: ChartPoint[]) => {
    if (pts.length < 2) return null;
    const a = pts[pts.length - 2].v;
    const b = pts[pts.length - 1].v;
    if (a === 0) return null;
    return ((b - a) / a) * 100;
  };

  const xau = series["XAUUSD"] ?? [];
  const btc = series["BTC-USD"] ?? [];
  const eth = series["ETH-USD"] ?? [];
  const eurusd = series["EUR/USD"] ?? [];

  // If anything ever drifts into an impossible range (bad localStorage, offline mode, etc),
  // immediately snap back to a sane baseline so the UI never shows nonsense like XAU=1.56.
  useEffect(() => {
    const x = xau.length ? xau[xau.length - 1].v : null;
    const e = eurusd.length ? eurusd[eurusd.length - 1].v : null;
    if ((typeof x === "number" && !isPlausibleQuote("XAUUSD", x)) || (typeof e === "number" && !isPlausibleQuote("EUR/USD", e))) {
      setSeries((prev) => {
        const next = { ...prev };
        const seed = (key: string, base: number, vol: number) => {
          const now = Date.now();
          const n = 90;
          const pts: ChartPoint[] = [];
          let v = base;
          for (let i = 0; i < n; i++) {
            const t = now - (n - 1 - i) * 60_000;
            const step = (Math.sin(i * 0.55) + Math.cos(i * 0.23)) * (vol * 0.28) + (Math.random() - 0.5) * vol;
            v = Math.max(0.0001, v + step);
            pts.push({ t, v });
          }
          next[key] = pts;
        };

        // Use last known from the backend if we have it, otherwise fall back to realistic defaults.
        const snap = marketState.data;
        const xauReal = snap?.metals?.find((m) => m.symbol === "XAU")?.price;
        const eurReal = snap?.fx?.find((f) => f.pair === "EUR/USD")?.rate;
        seed("XAUUSD", typeof xauReal === "number" && isPlausibleQuote("XAUUSD", xauReal) ? xauReal : 2034.2, 2.4);
        seed("EUR/USD", typeof eurReal === "number" && isPlausibleQuote("EUR/USD", eurReal) ? eurReal : 1.085, 0.004);
        return next;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketState.data, xau, eurusd]);

  const stats = [
    {
      id: "xau",
      label: "XAUUSD",
      sub: "Gold spot",
      value: lastVal(xau),
      fmt: (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 2 }),
      chg: pctChg(xau),
      points: xau,
      stroke: "rgba(255, 95, 122, 0.92)",
      fill: "rgba(255, 95, 122, 0.10)"
    },
    {
      id: "btc",
      label: "BTC-USD",
      sub: "Bitcoin",
      value: lastVal(btc),
      fmt: (v: number) => `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
      chg: pctChg(btc),
      points: btc,
      stroke: "rgba(52, 211, 153, 0.92)",
      fill: "rgba(52, 211, 153, 0.10)"
    },
    {
      id: "eth",
      label: "ETH-USD",
      sub: "Ethereum",
      value: lastVal(eth),
      fmt: (v: number) => `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
      chg: pctChg(eth),
      points: eth,
      stroke: "rgba(122, 167, 255, 0.95)",
      fill: "rgba(122, 167, 255, 0.10)"
    },
    {
      id: "eurusd",
      label: "EUR/USD",
      sub: "FX rate",
      value: lastVal(eurusd),
      fmt: (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 5 }),
      chg: pctChg(eurusd),
      points: eurusd,
      stroke: "rgba(231, 238, 252, 0.72)",
      fill: "rgba(231, 238, 252, 0.08)"
    }
  ];

  const winPreview = useMemo(() => {
    const sorted = [...photos.items].sort(
      (a, b) =>
        (b.uploadedMs ?? b.mtimeMs ?? 0) - (a.uploadedMs ?? a.mtimeMs ?? 0) ||
        String(a.name).localeCompare(String(b.name))
    );
    const items = sorted.slice(0, 8);
    return items.map((p, idx) => ({
      id: `${p.name}-${idx}`,
      src: apiUrl(p.url),
      title: `Win ${idx + 1}`,
      caption: pickTradingQuote(p.name)
    }));
  }, [photos.items]);

  const heroTone = useMemo<"cool" | "profit" | "risk">(() => {
    const btcChg = pctChg(series["BTC-USD"] ?? []);
    if (btcChg != null && btcChg >= 0) return "profit";
    if (btcChg != null && btcChg < 0) return "risk";
    return "cool";
  }, [series]);

  const plates = useMemo<MarketCorePlate[]>(() => {
    return stats.map((s) => {
      const up = (s.chg ?? 0) >= 0;
      const tone = s.chg == null ? "muted" : up ? "pos" : "neg";
      const chg = s.chg == null ? "--" : `${up ? "+" : ""}${s.chg.toFixed(3)}%`;
      return {
        id: s.id,
        label: s.label,
        value: s.value == null ? "--" : s.fmt(s.value),
        chg,
        tone
      };
    });
  }, [stats]);

  const tapeItems = useMemo(() => [...stats, ...stats], [stats]);

  const fadeUp = {
    hidden: { opacity: 0, y: 10 },
    show: { opacity: 1, y: 0 }
  };

  const [perfTf, setPerfTf] = useState<"1D" | "1W" | "1M" | "3M" | "6M" | "1Y" | "ALL">("1W");

  const perf = useMemo(() => {
    if (!userId || !userCreatedAt || !profile) return null;
    const plan = pickPlan(profile);
    if (!plan) return null;
    const startSec = Math.floor(Date.parse(userCreatedAt) / 1000);
    const nowSec = Math.floor(Date.now() / 1000);
    const endSec = startSec + plan.durationSec;
    const current = computeCurrentValue({
      seed: `${userId}:${plan.key}`,
      startSec,
      totalSec: plan.durationSec,
      nowSec,
      S: plan.startValue,
      E: plan.targetValue
    });
    const done = nowSec >= endSec;

    const windowSec =
      perfTf === "1D" ? 24 * 3600 :
      perfTf === "1W" ? 7 * 24 * 3600 :
      perfTf === "1M" ? 30 * 24 * 3600 :
      perfTf === "3M" ? 90 * 24 * 3600 :
      perfTf === "6M" ? 180 * 24 * 3600 :
      perfTf === "1Y" ? 365 * 24 * 3600 :
      365 * 24 * 3600;

    const stepSec =
      perfTf === "1D" ? 5 * 60 :
      perfTf === "1W" ? 30 * 60 :
      perfTf === "1M" ? 2 * 3600 :
      perfTf === "3M" ? 6 * 3600 :
      perfTf === "6M" ? 12 * 3600 :
      perfTf === "1Y" ? 24 * 3600 :
      24 * 3600;

    const points = buildEquitySeries({
      seed: `${userId}:${plan.key}`,
      startSec,
      totalSec: plan.durationSec,
      nowSec,
      S: plan.startValue,
      E: plan.targetValue,
      windowSec,
      stepSec
    }).map((p) => ({ t: p.t, v: p.v }));

    return { plan, startSec, endSec, nowSec, current, done, points };
  }, [userId, userCreatedAt, profile, perfTf]);

  const perfOverlays = useMemo(() => {
    // Benchmarks: normalize BTC and XAU to an index scale (start=100).
    const mkIndex = (pts: ChartPoint[]) => {
      if (!pts.length) return [];
      const base = pts[0].v || 1;
      return pts.map((p) => ({ t: p.t, v: (p.v / base) * 100 }));
    };
    const btcIdx = mkIndex(btc);
    const xauIdx = mkIndex(xau);
    return [
      { points: btcIdx, stroke: "rgba(52, 211, 153, 0.72)", lineWidth: 2, dashed: true },
      { points: xauIdx, stroke: "rgba(255, 95, 122, 0.62)", lineWidth: 2, dashed: true }
    ];
  }, [btc, xau]);

  const returns = useMemo(() => {
    if (!perf?.points?.length) return null;
    const pts = perf.points;
    const last = pts[pts.length - 1];
    const atOrBefore = (msAgo: number) => {
      const t0 = last.t - msAgo;
      for (let i = pts.length - 1; i >= 0; i--) {
        if (pts[i].t <= t0) return pts[i];
      }
      return pts[0];
    };
    const fmt = (d: number) => (perf.plan.unit === "USD" ? `$${d.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : `${d.toFixed(6)} BTC`);
    const pct = (a: number, b: number) => (a === 0 ? 0 : ((b - a) / a) * 100);
    const mk = (label: string, ms: number) => {
      const p0 = atOrBefore(ms);
      const d = last.v - p0.v;
      const p = pct(p0.v, last.v);
      return { label, delta: fmt(d), pct: `${p >= 0 ? "+" : ""}${p.toFixed(2)}%` };
    };
    return [
      mk("Today", 24 * 3600 * 1000),
      mk("This Week", 7 * 24 * 3600 * 1000),
      mk("This Month", 30 * 24 * 3600 * 1000),
      mk("This Year", 365 * 24 * 3600 * 1000),
      mk("All Time", 3650 * 24 * 3600 * 1000)
    ];
  }, [perf]);

  const news = useMemo(() => {
    const now = Date.now();
    return [
      { id: "n1", tag: "Market", title: "Gold volatility ticked up on session open", meta: "Watch XAUUSD spreads and wicks.", ts: now - 40 * 60 * 1000 },
      { id: "n2", tag: "Crypto", title: "BTC liquidity tightened across major venues", meta: "Expect sharper moves on low volume.", ts: now - 3 * 60 * 60 * 1000 },
      { id: "n3", tag: "FX", title: "EUR/USD range compression continues", meta: "Breakout risk increases as range narrows.", ts: now - 14 * 60 * 60 * 1000 },
      { id: "n4", tag: "Insight", title: "Discipline beats prediction", meta: "Define risk first. Let the market do the rest.", ts: now - 2 * 24 * 60 * 60 * 1000 }
    ];
  }, []);

  const activity = useMemo(() => {
    const now = Date.now();
    const base = userId ? Math.abs(Array.from(userId).reduce((a, c) => a + c.charCodeAt(0), 0)) : 17;
    const pick = (n: number) => (base + n) % 3;
    const items = [
      { k: "SEC", t: "Security check", d: "Session verified and cookies refreshed.", ts: now - 18 * 60 * 1000 },
      { k: "MKT", t: "Market snapshot", d: "Market Core updated from backend.", ts: now - 6 * 60 * 1000 },
      { k: "SYS", t: "Layout", d: "Dashboard modules loaded.", ts: now - 2 * 60 * 1000 }
    ];
    // rotate order per user for realism
    return [items[pick(0)], items[pick(1)], items[pick(2)]];
  }, [userId]);

  const approvedDeposits = useMemo(
    () => deposits.filter((d) => String(d.status || "").toLowerCase() === "confirmed"),
    [deposits]
  );
  const depositPendingCount = 0;
  const recentDepositVolume = useMemo(
    () => approvedDeposits.slice(0, 20).reduce((sum, d) => sum + Number(d.amount || 0), 0),
    [approvedDeposits]
  );

  const fmtDepositAmount = (amount: number, asset: string) => {
    const a = String(asset || "USD").toUpperCase();
    if (a === "USD") return `$${Number(amount || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
    return `${Number(amount || 0).toLocaleString(undefined, { maximumFractionDigits: 8 })} ${a}`;
  };

  async function submitDeposit(e: React.FormEvent) {
    e.preventDefault();
    if (!userId) {
      setDepositMsg({ tone: "err", text: "Login first to open your deposit gateway." });
      return;
    }
    const amountNum = Number(depositAmount);
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      setDepositMsg({ tone: "err", text: "Enter a valid deposit amount." });
      return;
    }
    const asset = String(depositAsset || "USD").trim().toUpperCase();
    if (!asset) {
      setDepositMsg({ tone: "err", text: "Select a valid asset." });
      return;
    }

    setDepositBusy(true);
    setDepositMsg(null);
    setLastPaymentUrl(null);
    setLastQrCode(null);
    try {
      const payload = {
        amount: amountNum,
        asset,
        method: depositMethod,
        chain: depositMethod === "Crypto Wallet" || asset === "BTC" ? depositChain : null,
        reference: depositReference.trim() || null,
        note: depositNote.trim() || null
      };
      const r = await postJson<{ request?: DepositItem }>("/api/deposits", payload);
      if (r?.request?.id) {
        setDeposits((prev) => [r.request as DepositItem, ...prev].slice(0, 20));
      }
      if (typeof r?.request?.payment_url === "string" && r.request.payment_url.trim()) {
        setLastPaymentUrl(r.request.payment_url);
      }
      if (typeof r?.request?.qr_code === "string" && r.request.qr_code.trim()) {
        setLastQrCode(r.request.qr_code);
      }
      setDepositMsg({ tone: "ok", text: "Deposit request submitted. Awaiting confirmation." });
      setDepositAmount("");
      setDepositReference("");
      setDepositNote("");
    } catch (e: any) {
      const msg = typeof e?.message === "string" && e.message ? e.message : "Unable to submit deposit request.";
      setDepositMsg({ tone: "err", text: msg });
    } finally {
      setDepositBusy(false);
    }
  }

  const depositPreviewAmount = (() => {
    const n = Number(depositAmount);
    if (!Number.isFinite(n) || n <= 0) return "--";
    return fmtDepositAmount(n, depositAsset);
  })();
  const depositRailLabel =
    depositMethod === "Crypto Wallet"
      ? `${String(depositAsset || "BTC").toUpperCase()} on ${String(depositChain || "BTC").toUpperCase()}`
      : `${depositMethod} · ${String(depositAsset || "USD").toUpperCase()}`;

  return (
    <>
      <section className="depositHeroPrime" aria-label="Primary deposit gateway">
        <div className="depositHeroPrimeTop">
          <div className="depositHeroPrimeBadge">Top Tier Gateway</div>
          <div className="depositHeroPrimeStatus mono">{userId ? "Authenticated" : "Login Required"}</div>
        </div>
        <div className="depositHeroPrimeGrid">
          <div>
            <h2 className="depositHeroPrimeTitle">Fund Your Account Instantly</h2>
            <p className="depositHeroPrimeLead">
              Professional deposit gateway built into your dashboard. Bitcoin-first payment rail, secure request flow, and immediate admin visibility.
            </p>
            <div className="depositHeroPrimeActions">
              <a className="calloutPrimary depositHeroPrimeCta" href="/checkout">
                Open Deposit Gateway
              </a>
              {userId ? (
                <a className="calloutPrimary depositHeroAuthBtn" href="/progress">
                  Progress
                </a>
              ) : (
                <>
                  <a className="calloutPrimary depositHeroAuthBtn" href="/portfolio?mode=login">
                    Login
                  </a>
                  <a className="calloutPrimary depositHeroAuthBtn depositHeroAuthBtnGhost" href="/portfolio?mode=register">
                    Sign Up
                  </a>
                </>
              )}
              <a className="mini" href="#contact">Need payment assistance?</a>
            </div>
          </div>
          <div className="depositHeroPrimeStats progressKpis" role="list" aria-label="Deposit gateway summary">
            <div className="kpi" role="listitem">
              <div className="kpiLabel">Pending</div>
              <div className="kpiValue mono">{depositPendingCount}</div>
            </div>
            <div className="kpi" role="listitem">
              <div className="kpiLabel">Recent Requests</div>
              <div className="kpiValue mono">{approvedDeposits.length}</div>
            </div>
            <div className="kpi" role="listitem">
              <div className="kpiLabel">Recent Volume</div>
              <div className="kpiValue mono">{fmtDepositAmount(recentDepositVolume, "USD")}</div>
            </div>
          </div>
        </div>
      </section>

      <section className="priorityCallout" role="note" aria-label="Priority announcement">
        <div className="calloutTop">
          <div className="calloutBadge">Priority</div>
          <div className="calloutTitle">TRADE FIX WEEKEND POOL TRADING INVESTMENT</div>
        </div>
        <p className="calloutBody">Contact the admin for onboarding and account setup.</p>
        <div className="calloutActions">
          <a className="calloutPrimary" href="#portfolio">
            Go to Portfolio
          </a>
          <a className="calloutPrimary" href="#contact">
            Contact Admin
          </a>
          <div className="calloutLinkHint">Telegram: @Sr_Haddan</div>
        </div>
        <p className="calloutDisclaimer">
          100% Gurantee of Returns.
        </p>
      </section>

      <motion.section
        className="dashHeroPro"
        aria-label="Dashboard hero"
        variants={fadeUp}
        initial="hidden"
        animate="show"
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      >
        <div className="dashHeroGrid">
  <div className="dashHeroLeft">
    <div className="eyebrow">Dashboard</div>

    <h1 className="dashTitle dashTitleTight">
      Know what changed. Act with context.
    </h1>

    <p className="dashLead dashLeadLarge">
      Live markets, clean signals, lightning-fast execution.<br />
      <strong>Precision dashboard built for fast decision loops.</strong>
    </p>
    <div className="dashLeadIconRow" aria-label="Core dashboard capabilities">
      <span className="dashLeadChip">
        <AppleIcon kind="pulse" size="sm" />
        Track the tape
      </span>
      <span className="dashLeadChip">
        <AppleIcon kind="session" size="sm" />
        Monitor sessions
      </span>
      <span className="dashLeadChip">
        <AppleIcon kind="context" size="sm" />
        Act with full context
      </span>
    </div>

    <div className="poolSection">
      <h2 className="poolTitle">
        <span className="iconInlineRow">
          <AppleIcon kind="money" />
          Want reliable, explosive capital growth?
        </span>
      </h2>

      <p className="poolLead">
        Join our <strong>high-performance pool trading plans</strong> — structured, expert-driven, consistent returns.
      </p>

      {/* ───────────── 48H PLAN ───────────── */}
      <div className="planBox planBox24">
        <h3 className="planTitle planTitle24">
          <span className="iconInlineRow">
            <AppleIcon kind="bolt" />
            48-HOUR POOL TRADING PLAN
          </span>
        </h3>

        <div className="planList">
          <div className="planLine"><AppleIcon kind="check" size="sm" />Deposit <strong>£500</strong> → Get <strong>£5,000</strong></div>
          <div className="planLine"><AppleIcon kind="check" size="sm" />Deposit <strong>£600</strong> → Get <strong>£6,000</strong></div>
          <div className="planLine"><AppleIcon kind="check" size="sm" />Deposit <strong>£700</strong> → Get <strong>£7,000</strong></div>
          <div className="planLine"><AppleIcon kind="check" size="sm" />Deposit <strong>£800</strong> → Get <strong>£8,000</strong></div>
          <div className="planLine"><AppleIcon kind="check" size="sm" />Deposit <strong>£900</strong> → Get <strong>£9,000</strong></div>
          <div className="planLine"><AppleIcon kind="check" size="sm" />Deposit <strong>£1,000</strong> → Get <strong>£10,000</strong></div>
        </div>
      </div>

      {/* ───────────── WEEKLY PLAN ───────────── */}
      <div className="planBox planBox48">
        <h3 className="planTitle planTitle48">
          <span className="iconInlineRow">
            <AppleIcon kind="fire" />
            WEEKLY POOL TRADING PLAN
          </span>
        </h3>

        <div className="planList">
          <div className="planLine"><AppleIcon kind="check" size="sm" />Deposit <strong>£2,000</strong> → Get <strong>£20,000</strong></div>
          <div className="planLine"><AppleIcon kind="check" size="sm" />Deposit <strong>£3,000</strong> → Get <strong>£30,000</strong></div>
          <div className="planLine"><AppleIcon kind="check" size="sm" />Deposit <strong>£4,000</strong> → Get <strong>£40,000</strong></div>
          <div className="planLine"><AppleIcon kind="check" size="sm" />Deposit <strong>£5,000</strong> → Get <strong>£50,000</strong></div>
          <div className="planLine"><AppleIcon kind="check" size="sm" />Deposit <strong>£6,000</strong> → Get <strong>£60,000</strong></div>
          <div className="planLine"><AppleIcon kind="check" size="sm" />Deposit <strong>£7,000</strong> → Get <strong>£70,000</strong></div>
        </div>
      </div>

      {/* Important notes */}
      <div className="planNote">
        <strong className="planNoteStrong">
          <span className="iconInlineRow">
            <AppleIcon kind="check" />
            48-hour plans settle in 48 hours, weekly plans settle in 7 days
          </span>
        </strong><br />
        <strong>Duration:</strong> Choose <strong>48-Hour (48h)</strong> or <strong>Weekly (7 days)</strong> based on your target.
      </div>

      {/* Strong CTA */}
      <div className="poolCtaWrap">
        <div className="poolCtaTitle">
          <span className="iconInlineRow">
            <AppleIcon kind="rocket" />
            Message admin NOW to secure your spot!
          </span>
        </div>

        <div className="poolCtaHint">
          <span className="iconInlineRow">
            <AppleIcon kind="chevronDown" size="sm" />
            Click below & lock your position today
            <AppleIcon kind="chevronDown" size="sm" />
          </span>
        </div>
      </div>
    </div>
  </div>
</div>

        <motion.div
          className="dashKpiGrid"
          aria-label="Live market stats"
          initial="hidden"
          animate="show"
          variants={{ hidden: {}, show: { transition: { staggerChildren: 0.06 } } }}
        >
          {stats.map((s) => {
            const up = (s.chg ?? 0) >= 0;
            return (
              <motion.div className="dashStatCard" key={s.id} variants={fadeUp} transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}>
                <div className="dashStatHead">
                  <div>
                    <div className="dashStatLabel">
                      <AppleIcon kind={s.id === "xau" ? "fire" : s.id === "eurusd" ? "session" : "trend"} size="sm" />
                      {s.label}
                    </div>
                    <div className="dashStatSub">{s.sub}</div>
                  </div>
                  <div className={`dashStatChg mono ${s.chg == null ? "muted" : up ? "pos" : "neg"}`}>
                    {s.chg == null ? "--" : `${up ? "+" : ""}${s.chg.toFixed(3)}%`}
                  </div>
                </div>
                <div className="dashStatBody">
                  <div className="dashStatValue mono">
                    {s.value == null ? "--" : s.fmt(s.value)}
                  </div>
                  <div className="dashSpark">
                    <LineChart points={s.points} height={64} stroke={s.stroke} fill={s.fill} />
                  </div>
                </div>
              </motion.div>
            );
          })}
        </motion.div>
      </motion.section>

      {marketState.status === "error" && marketState.error ? (
        <Notice
          tone="warn"
          title="Market data is temporarily unavailable"
          actions={
            <button className="mini" type="button" onClick={() => void refreshMarkets()}>
              Retry
            </button>
          }
        >
          Some panels may show the last known prices. Try again in a moment.
        </Notice>
      ) : null}

      <section className="dashProGrid" aria-label="Dashboard panels">
        <div className="panel">
          <div className="panelHead">
            <div>
              <div className="panelTitle">
                <AppleIcon kind="pulse" size="sm" />
                Market Pulse
              </div>
              <div className="panelSub">Quick scan of the key instruments</div>
            </div>
            <a className="mini" href="#markets">
              Details
            </a>
          </div>

          <div className="pulse" aria-label="Pulse list">
            {stats.map((s) => {
              const up = (s.chg ?? 0) >= 0;
              return (
                <div className="pulseRow" key={s.id}>
                  <div className="pulseLeft">
                    <div className="pulseSym mono">{s.label}</div>
                    <div className="pulseName muted">{s.sub}</div>
                  </div>
                  <div className="pulseMid">
                    <span className="pill">{conn.label}</span>
                    <span className="pill">FX {fxUi.label}</span>
                    <span className="pill">Metals {metalsUi.label}</span>
                  </div>
                  <div className="pulseRight">
                    <div className="mono pulsePx">{s.value == null ? "--" : s.fmt(s.value)}</div>
                    <div className={`mono pulseChg ${s.chg == null ? "muted" : up ? "pos" : "neg"}`}>
                      {s.chg == null ? "--" : `${up ? "+" : ""}${s.chg.toFixed(3)}%`}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="panel">
          <div className="panelHead">
            <div>
              <div className="panelTitle">
                <AppleIcon kind="bolt" size="sm" />
                Quick Actions
              </div>
              <div className="panelSub">The next best click</div>
            </div>
          </div>

          <div className="dashQuick">
            <a className="quickBtn q4 q4Prime" href="/checkout">
              <div className="qIcon" aria-hidden="true">
                <Wallet size={20} />
              </div>
              <div>
                <div className="qTitle">Deposit Gateway</div>
                <div className="qSub">{userId ? `${approvedDeposits.length} approved request(s)` : "Login to open gateway"}</div>
              </div>
              <ChevronRight size={18} aria-hidden="true" />
            </a>

            <a className="quickBtn q1" href="#portfolio">
              <div className="qIcon" aria-hidden="true">
                <AppleIcon kind="shield" />
              </div>
              <div>
                <div className="qTitle">Portfolio Access</div>
                <div className="qSub">Login with email + password</div>
              </div>
              <ChevronRight size={18} aria-hidden="true" />
            </a>

            <a className="quickBtn q2" href="#markets">
              <div className="qIcon" aria-hidden="true">
                <AppleIcon kind="trend" />
              </div>
              <div>
                <div className="qTitle">Markets</div>
                <div className="qSub">Crypto pairs, FX, and gold</div>
              </div>
              <ChevronRight size={18} aria-hidden="true" />
            </a>

            <a className="quickBtn q3" href="#contact">
              <div className="qIcon" aria-hidden="true">
                <AppleIcon kind="support" />
              </div>
              <div>
                <div className="qTitle">Admin Support</div>
                <div className="qSub">Telegram and email</div>
              </div>
              <ChevronRight size={18} aria-hidden="true" />
            </a>
          </div>
        </div>

        <div className="panel">
          <div className="panelHead">
            <div>
              <div className="panelTitle">
                <AppleIcon kind="rocket" size="sm" />
                Latest Wins
              </div>
              <div className="panelSub">From your uploaded gallery</div>
            </div>
            <a className="mini" href="#blog">
              Open
            </a>
          </div>

          {photos.status === "error" && photos.error ? (
            <Notice
              tone="warn"
              title="Gallery is unavailable"
              actions={
                <button className="mini" type="button" onClick={() => setPhotosReloadKey((k) => k + 1)}>
                  Retry
                </button>
              }
            >
              Try again later.
            </Notice>
          ) : null}
          {!winPreview.length ? (
            <div className="pairsNote">New wins will appear here as they are posted.</div>
          ) : (
            <div className="dashWins" aria-label="Wins gallery preview">
              {winPreview.map((w) => (
                <a className="winThumb" key={w.id} href="#blog" title={w.caption}>
                  <img src={w.src} alt={w.title} loading="lazy" />
                  <div className="winThumbCap">
                    <div className="winThumbTitle">{w.title}</div>
                    <div className="winThumbQuote">{w.caption}</div>
                  </div>
                </a>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="dashWide" aria-label="Performance analytics">
        <div className="panel panelWide">
          <div className="panelHead">
            <div>
              <div className="panelTitle">
                <AppleIcon kind="trend" size="sm" />
                Performance
              </div>
              <div className="panelSub">
                {perf
                  ? `Account curve (${perf.plan.unit}) vs benchmarks (BTC, XAU).`
                  : userId
                    ? "Initialize holdings in Portfolio to unlock account performance."
                    : "Login to unlock account performance modules."}
              </div>
            </div>
            <div className="seg" role="group" aria-label="Timeframe">
              {(["1D", "1W", "1M", "3M", "6M", "1Y", "ALL"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`segBtn ${perfTf === t ? "on" : ""}`}
                  onClick={() => setPerfTf(t)}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          <div className="perfGrid">
            <div className="perfChart">
              {perf ? (
                <LineChart
                  points={perf.points}
                  overlays={perfOverlays}
                  height={340}
                  stroke="rgba(231, 238, 252, 0.92)"
                  fill="rgba(231, 238, 252, 0.07)"
                  yLabel={perf.plan.unit === "USD" ? "USD" : "BTC"}
                  xLabel="Time"
                />
              ) : (
                <div className="emptyState">
                  <div className="panelTitle">
                    <AppleIcon kind="shield" size="sm" />
                    Performance locked
                  </div>
                  <div className="panelSub">Go to Portfolio to login, then invest from Checkout to activate movement.</div>
                  <div style={{ marginTop: 12 }}>
                    <a className="primary" href="#portfolio">
                      Open Portfolio
                    </a>
                  </div>
                </div>
              )}
            </div>

            <div className="perfSide">
              <div className="perfCard">
                <div className="panelTitle">
                  <AppleIcon kind="money" size="sm" />
                  Returns Breakdown
                </div>
                <div className="panelSub">Computed from the current visible curve</div>
                {!returns ? (
                  <div className="pairsNote" style={{ marginTop: 10 }}>
                    Sign in and complete an approved investment to populate this module.
                  </div>
                ) : (
                  <div className="rbList" role="table" aria-label="Returns breakdown">
                    {returns.map((r) => (
                      <div className="rbRow" role="row" key={r.label}>
                        <div className="rbL" role="cell">
                          <AppleIcon kind="check" size="sm" />
                          {r.label}
                        </div>
                        <div className="rbM mono" role="cell">{r.delta}</div>
                        <div className="rbR mono" role="cell">{r.pct}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="perfCard">
                <div className="panelTitle">
                  <AppleIcon kind="context" size="sm" />
                  Market Overview
                </div>
                <div className="panelSub">Key instruments from your feed</div>
                <div className="miList" role="table" aria-label="Market overview list">
                  {stats.map((s) => {
                    const up = (s.chg ?? 0) >= 0;
                    return (
                      <div className="miRow" role="row" key={s.id}>
                        <div className="miSym mono" role="cell">
                          <AppleIcon kind={s.id === "xau" ? "fire" : s.id === "eurusd" ? "session" : "trend"} size="sm" />
                          {s.label}
                        </div>
                        <div className="miPx mono" role="cell">{s.value == null ? "--" : s.fmt(s.value)}</div>
                        <div className={`miChg mono ${s.chg == null ? "muted" : up ? "pos" : "neg"}`} role="cell">
                          {s.chg == null ? "--" : `${up ? "+" : ""}${s.chg.toFixed(3)}%`}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="dashBelow" aria-label="News and activity">
        <div className="panel">
          <div className="panelHead">
            <div>
              <div className="panelTitle">
                <AppleIcon kind="news" size="sm" />
                News & Insights
              </div>
              <div className="panelSub">Headlines, notes, and quick context</div>
            </div>
            <a className="mini" href="#markets">Markets</a>
          </div>
          <div className="newsList" role="list">
            {news.map((n) => (
              <div className="newsRow" role="listitem" key={n.id}>
                <div className="newsTag">
                  <AppleIcon kind={n.tag === "Market" ? "trend" : n.tag === "Crypto" ? "bolt" : n.tag === "FX" ? "session" : "context"} size="sm" />
                  {n.tag}
                </div>
                <div className="newsMain">
                  <div className="newsTitle">{n.title}</div>
                  <div className="newsMeta muted">{n.meta}</div>
                </div>
                <div className="newsTime muted mono">{new Date(n.ts).toLocaleString()}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="panel">
          <div className="panelHead">
            <div>
              <div className="panelTitle">
                <AppleIcon kind="activity" size="sm" />
                Recent Activity
              </div>
              <div className="panelSub">System and session events</div>
            </div>
            <span className="pill">live</span>
          </div>
          <div className="actList" role="list">
            {activity.map((a, idx) => (
              <div className="actRow" role="listitem" key={`${a.k}-${idx}`}>
                <div className="actKey mono">
                  <AppleIcon kind={a.k === "SEC" ? "shield" : a.k === "MKT" ? "trend" : "context"} size="sm" />
                  {a.k}
                </div>
                <div className="actMain">
                  <div className="actTitle">{a.t}</div>
                  <div className="actMeta muted">{a.d}</div>
                </div>
                <div className="actTime muted mono">{new Date(a.ts).toLocaleTimeString()}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="trustSection" aria-label="Trust and credibility">
        <div className="trustHead">
          <div>
            <div className="panelTitle">
              <AppleIcon kind="shield" size="sm" />
              Why Traders Trust Trade Fix
            </div>
            <div className="panelSub">Security-first onboarding, transparent updates, and verified payout workflow.</div>
          </div>
          <a className="mini" href="#contact">Verify with Admin</a>
        </div>

        <div className="trustGrid">
          <div className="trustCard">
            <div className="trustTitle">Security Controls</div>
            <div className="trustList">
              <div className="trustRow"><AppleIcon kind="check" size="sm" /> Session and account validation checks</div>
              <div className="trustRow"><AppleIcon kind="check" size="sm" /> Controlled onboarding via admin approval</div>
              <div className="trustRow"><AppleIcon kind="check" size="sm" /> Encrypted credentials and scoped access</div>
            </div>
          </div>
          <div className="trustCard">
            <div className="trustTitle">Live Transparency</div>
            <div className="trustList">
              <div className="trustRow"><AppleIcon kind="trend" size="sm" /> Real-time market feed updates</div>
              <div className="trustRow"><AppleIcon kind="news" size="sm" /> Regular news and activity posting</div>
              <div className="trustRow"><AppleIcon kind="activity" size="sm" /> Continuous dashboard heartbeat monitoring</div>
            </div>
          </div>
          <div className="trustCard">
            <div className="trustTitle">Proof Layer</div>
            <div className="trustStats">
              <div className="trustStat"><span>300K+</span><small>Active users</small></div>
              <div className="trustStat"><span>3M+</span><small>Total transactions</small></div>
              <div className="trustStat"><span>24/7</span><small>Support coverage</small></div>
            </div>
          </div>
        </div>
      </section>

      <section className="tgCta" aria-label="Join our Telegram channel">
        <div className="tgCtaInner">
          <div className="tgCtaBadge">
            <AppleIcon kind="support" size="sm" /> Telegram
          </div>
          <h2 className="tgCtaTitle">
            <span className="tg3d" data-text="Join The Winners Circle">
              Join The Winners Circle
            </span>
          </h2>
          <p className="tgCtaLead">
            Join the official channel for updates, onboarding steps, and priority announcements. This is where we post the latest notes.
          </p>
          <div className="tgCtaActions">
            <a className="primary" href="https://t.me/tradefix1" target="_blank" rel="noreferrer">
              Join Telegram Channel
            </a>
            <a className="ghost" href="https://t.me/Sr_Haddan" target="_blank" rel="noreferrer">
              Message Admin
            </a>
          </div>
          <div className="tgCtaFine muted">Keep notifications on so you don’t miss key updates.</div>
        </div>

        <div className="tgCtaArt" aria-hidden="true">
          <div className="tgOrb" />
          <div className="tgGrid" />
        </div>
      </section>

      {depositOpen ? (
        <div className="withdrawModalOverlay" onMouseDown={(e) => e.target === e.currentTarget && setDepositOpen(false)}>
          <section className="withdrawModal depositModal" role="dialog" aria-modal="true" aria-label="Deposit gateway form">
            <div className="withdrawHead">
              <div>
                <div className="panelTitle">Deposit Gateway</div>
                <div className="panelSub">Submit deposits directly from this dashboard.</div>
              </div>
              <button type="button" className="iconBtn" aria-label="Close deposit form" onClick={() => setDepositOpen(false)}>
                <X size={18} />
              </button>
            </div>

            <div className="depositCheckoutGrid">
              <div className="depositCheckoutMain">
                <form className="withdrawForm depositCheckoutForm" onSubmit={submitDeposit}>
                  <label className="depositField">
                    <span className="muted">Amount</span>
                    <input
                      className="withdrawAmountInput mono"
                      inputMode="decimal"
                      value={depositAmount}
                      onChange={(e) => setDepositAmount(e.target.value)}
                      placeholder={depositAsset === "BTC" ? "0.01000000" : "0.00"}
                      required
                    />
                  </label>
                  <div className="depositFieldRow">
                    <label className="depositField">
                      <span className="muted">Asset</span>
                      <select value={depositAsset} onChange={(e) => setDepositAsset(e.target.value)}>
                        <option value="BTC">BTC</option>
                        <option value="USD">USD</option>
                        <option value="USDT">USDT</option>
                        <option value="ETH">ETH</option>
                      </select>
                    </label>
                    <label className="depositField">
                      <span className="muted">Method</span>
                      <select
                        value={depositMethod}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v === "Card" || v === "Bank Transfer" || v === "Crypto Wallet") setDepositMethod(v);
                        }}
                      >
                        <option value="Crypto Wallet">Crypto Wallet</option>
                        <option value="Card">Card</option>
                        <option value="Bank Transfer">Bank Transfer</option>
                      </select>
                    </label>
                  </div>
                  {depositMethod === "Crypto Wallet" ? (
                    <label className="depositField">
                      <span className="muted">Blockchain</span>
                      <select
                        value={depositChain}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v === "BTC" || v === "ERC20" || v === "TRC20" || v === "BEP20" || v === "SOL") setDepositChain(v);
                        }}
                      >
                        <option value="BTC">BTC</option>
                        <option value="ERC20">ERC20</option>
                        <option value="TRC20">TRC20</option>
                        <option value="BEP20">BEP20</option>
                        <option value="SOL">SOL</option>
                      </select>
                    </label>
                  ) : null}
                  <label className="depositField">
                    <span className="muted">Transaction Ref (optional)</span>
                    <input value={depositReference} onChange={(e) => setDepositReference(e.target.value)} placeholder="e.g. tx hash or transfer id" />
                  </label>
                  <label className="depositField">
                    <span className="muted">Note (optional)</span>
                    <textarea value={depositNote} onChange={(e) => setDepositNote(e.target.value)} placeholder="Any extra details for the admin team." />
                  </label>

                  <div className="depositFine muted">
                    Secure invoice checkout powered by Bitcart. Payment status syncs automatically after confirmation.
                  </div>
                  <div className="withdrawActions">
                    <button type="submit" className="primary depositSubmitBtn" disabled={depositBusy}>
                      {depositBusy ? "Submitting..." : "Submit Deposit"}
                    </button>
                    <button type="button" className="mini" onClick={() => setDepositOpen(false)} disabled={depositBusy}>
                      Cancel
                    </button>
                  </div>
                </form>

                {depositMsg ? (
                  <Notice tone={depositMsg.tone === "ok" ? "info" : "warn"} title={depositMsg.tone === "ok" ? "Deposit submitted" : "Deposit error"}>
                    {depositMsg.text}
                  </Notice>
                ) : null}
              </div>

              <aside className="depositCheckoutSide">
                <div className="depositSummaryCard">
                  <div className="miniLabel">Payment Summary</div>
                  <div className="depositSummaryAmount mono">{depositPreviewAmount}</div>
                  <div className="pairsNote">Rail: <span className="mono">{depositRailLabel}</span></div>
                  <div className="pairsNote">Provider: <span className="mono">Bitcart Invoice</span></div>
                </div>

                {lastPaymentUrl ? (
                  <div className="depositPayNow">
                    <a className="primary" href={lastPaymentUrl} target="_blank" rel="noreferrer">
                      Continue to Bitcart Payment
                    </a>
                    {lastQrCode ? (
                      <img src={lastQrCode} alt="Bitcart payment QR code" className="depositQrImage" />
                    ) : null}
                  </div>
                ) : null}

                <div className="depositHistory">
                  <div className="panelTitle">Recent Deposits</div>
                  {deposits.length ? (
                    <div className="mileList" aria-label="Recent deposits">
                      {deposits.slice(0, 4).map((d) => (
                        <div className="mileRow" key={d.id}>
                          <span className="mono">{fmtDepositAmount(d.amount, d.asset)}</span>
                          <span className="muted">{d.method}{d.chain ? ` ${d.chain}` : ""}{d.provider === "bitcart" ? " | Bitcart" : ""}</span>
                          {d.payment_url ? (
                            <a className="mini" href={d.payment_url} target="_blank" rel="noreferrer">
                              Pay now
                            </a>
                          ) : null}
                          <span className="pill">{String(d.status || "pending").toUpperCase()}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="pairsNote">No deposit requests yet.</div>
                  )}
                </div>
              </aside>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
