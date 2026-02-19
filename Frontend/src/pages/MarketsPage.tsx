import { useEffect, useMemo, useRef, useState } from "react";
import { fetchCryptoPairs, fetchMarketSnapshot, type MarketSnapshot, type PairItem } from "../markets";
import LineChart, { type ChartPoint } from "../components/LineChart";

import trader01 from "../assets/trader-01.svg";
import trader02 from "../assets/trader-02.svg";
import trader03 from "../assets/trader-03.svg";
import Notice from "../components/Notice";
import Skeleton from "../components/Skeleton";

type MarketFetchState =
  | { status: "idle" | "loading"; data: MarketSnapshot | null; error: null }
  | { status: "ok"; data: MarketSnapshot; error: null }
  | { status: "error"; data: MarketSnapshot | null; error: string };

type StreamState =
  | { status: "idle" | "connecting"; error: null }
  | { status: "connected"; error: null }
  | { status: "error"; error: string };

function isPlausibleQuote(key: string, v: number): boolean {
  if (!Number.isFinite(v)) return false;
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

function uiLoad(status: "idle" | "loading" | "ok" | "error") {
  if (status === "loading") return { label: "Updating", cls: "muted" as const };
  if (status === "ok") return { label: "Ready", cls: "pos" as const };
  if (status === "error") return { label: "Unavailable", cls: "neg" as const };
  return { label: "Loading", cls: "muted" as const };
}

function apiBase(): string {
  const envBase = (import.meta as any)?.env?.VITE_API_BASE;
  if (typeof envBase === "string" && envBase.trim()) return envBase.trim().replace(/\/+$/, "");
  if (typeof window !== "undefined") {
    const isDevVite = window.location.hostname === "localhost" && window.location.port === "5173";
    if (isDevVite) return "http://localhost:8787";
  }
  return "";
}

function apiUrl(path: string): string {
  const base = apiBase();
  if (!base) return path;
  return `${base}${path.startsWith("/") ? "" : "/"}${path}`;
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

  return { asOf, sources, crypto, fx, metals, marketStatus } as MarketSnapshot;
}

export default function MarketsPage() {
  const [marketState, setMarketState] = useState<MarketFetchState>({
    status: "idle",
    data: null,
    error: null
  });

  const [stream, setStream] = useState<StreamState>({ status: "idle", error: null });

  const prevSnapshotRef = useRef<MarketSnapshot | null>(null);
  const currentSnapshotRef = useRef<MarketSnapshot | null>(null);

  const [series, setSeries] = useState<Record<string, ChartPoint[]>>(() => {
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

    // Match Dashboard: seed from last known quotes so Explore never starts from nonsense
    // and stays consistent between pages.
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
          "XAUUSD": mk(okXau ? g : 2034.2, 6.2, 90),
          "BTC-USD": mk(okBtc ? b : 68000, 220, 90),
          "ETH-USD": mk(okEth ? e : 3400, 28, 90),
          "EUR/USD": mk(okFx ? fx : 1.085, 0.004, 90)
        };
      }
    } catch {}

    return {
      "XAUUSD": mk(2034.2, 6.2, 90),
      "BTC-USD": mk(68000, 220, 90),
      "ETH-USD": mk(3400, 28, 90),
      "EUR/USD": mk(1.085, 0.004, 90)
    };
  });

  const [pairs, setPairs] = useState<{
    status: "idle" | "loading" | "ok" | "error";
    q: string;
    quote: string;
    limit: number;
    offset: number;
    total: number;
    items: PairItem[];
    error: string | null;
  }>({
    status: "idle",
    q: "",
    quote: "USD",
    limit: 50,
    offset: 0,
    total: 0,
    items: [],
    error: null
  });
  const [pairsReloadKey, setPairsReloadKey] = useState(0);

  const refreshMarkets = useMemo(() => {
    return async (signal?: AbortSignal) => {
      setMarketState((s) => ({ status: "loading", data: s.data, error: null }));
      try {
        const snap = await fetchMarketSnapshot(signal);
        prevSnapshotRef.current = currentSnapshotRef.current;
        currentSnapshotRef.current = snap;
        setMarketState({ status: "ok", data: snap, error: null });

        // Feed the charts with the latest snapshot where available.
        setSeries((prev) => {
          const next: Record<string, ChartPoint[]> = { ...prev };
          const push = (key: string, v: number) => {
            if (!isPlausibleQuote(key, v)) return;
            const pts = next[key] ? [...next[key]] : [];
            pts.push({ t: Date.now(), v });
            // Keep last ~120 points.
            next[key] = pts.slice(Math.max(0, pts.length - 120));
          };

          for (const c of snap.crypto) push(c.productId, c.price);
          for (const f of snap.fx) push(f.pair, f.rate);
          for (const m of snap.metals ?? []) {
            if (m.symbol === "XAU") push("XAUUSD", m.price);
          }

          return next;
        });

        // Keep the same cache key as Dashboard so the whole app stays consistent.
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
      } catch (e: any) {
        const msg = typeof e?.message === "string" ? e.message : "Failed to fetch market data";
        setMarketState((s) => ({ status: "error", data: s.data, error: msg }));
      }
    };
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    const t = window.setTimeout(() => {
      setPairs((s) => ({ ...s, status: "loading", error: null }));
      fetchCryptoPairs({
        q: pairs.q,
        quote: pairs.quote || undefined,
        limit: pairs.limit,
        offset: pairs.offset,
        signal: ac.signal
      })
        .then((r) => {
          setPairs((s) => ({
            ...s,
            status: "ok",
            total: r.total,
            items: r.items,
            error: null
          }));
        })
        .catch((e: any) => {
          const msg = typeof e?.message === "string" ? e.message : "Failed to load pairs";
          setPairs((s) => ({ ...s, status: "error", error: msg }));
        });
    }, 250);

    return () => {
      window.clearTimeout(t);
      ac.abort();
    };
  }, [pairs.q, pairs.quote, pairs.limit, pairs.offset, pairsReloadKey]);

  useEffect(() => {
    let es: EventSource | null = null;
    let closed = false;
    setStream({ status: "connecting", error: null });

    // Wider symbol set for the "active pairs" feel.
    const url = new URL(apiUrl("/api/markets/stream"), typeof window !== "undefined" ? window.location.origin : "http://localhost");
    url.searchParams.set("symbols", "BTC,ETH,SOL,BNB,XRP,ADA,DOGE,TRX");

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
          prevSnapshotRef.current = currentSnapshotRef.current;
          currentSnapshotRef.current = snap;
          setMarketState({ status: "ok", data: snap, error: null });

          setSeries((prev) => {
            const next: Record<string, ChartPoint[]> = { ...prev };
            const push = (key: string, v: number) => {
              if (!isPlausibleQuote(key, v)) return;
              const pts = next[key] ? [...next[key]] : [];
              pts.push({ t: Date.now(), v });
              next[key] = pts.slice(Math.max(0, pts.length - 120));
            };

            for (const c of snap.crypto) push(c.productId, c.price);
            for (const f of snap.fx) push(f.pair, f.rate);
            for (const m of snap.metals ?? []) {
              if (m.symbol === "XAU") push("XAUUSD", m.price);
            }
            return next;
          });

          // Persist last known quotes for instant consistency across pages.
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
          const rs = es ? es.readyState : 0;
          if (rs === (EventSource as any).CONNECTING) setStream({ status: "connecting", error: null });
          else setStream({ status: "error", error: "Live updates unavailable" });
        });
      } catch {
        setStream({ status: "error", error: "Live updates unavailable" });
      }
    }

    // Fallback poll if SSE can't connect.
    const ac = new AbortController();
    void refreshMarkets(ac.signal);
    const id = window.setInterval(() => {
      if (es && es.readyState === EventSource.OPEN) return;
      const acTick = new AbortController();
      void refreshMarkets(acTick.signal);
    }, 12000);

    return () => {
      closed = true;
      ac.abort();
      window.clearInterval(id);
      try {
        es?.close();
      } catch {}
    };
  }, [refreshMarkets]);

  const marketRows = useMemo(() => {
    const cur = marketState.data;
    const prev = prevSnapshotRef.current;
    const out: {
      kind: "crypto" | "fx";
      symbol: string;
      price: number;
      changePct: number | null;
    }[] = [];

    if (!cur) return out;

    const prevCrypto = new Map(prev?.crypto?.map((q) => [q.productId, q.price]) ?? []);
    const prevFx = new Map(prev?.fx?.map((q) => [q.pair, q.rate]) ?? []);

    for (const q of cur.crypto) {
      const p = prevCrypto.get(q.productId);
      const changePct = typeof p === "number" && p !== 0 ? ((q.price - p) / p) * 100 : null;
      out.push({ kind: "crypto", symbol: q.productId, price: q.price, changePct });
    }

    for (const q of cur.fx) {
      const p = prevFx.get(q.pair);
      const changePct = typeof p === "number" && p !== 0 ? ((q.rate - p) / p) * 100 : null;
      out.push({ kind: "fx", symbol: q.pair, price: q.rate, changePct });
    }

    return out;
  }, [marketState.data]);

  const updatedAt =
    marketState.data?.asOf != null ? new Date(marketState.data.asOf).toLocaleTimeString() : "--:--:--";
  const fxStatus = marketState.data?.marketStatus?.fx || "open";
  const metalsStatus = marketState.data?.marketStatus?.metals || "open";
  const conn = uiConn(stream, !!marketState.data);
  const fxUi = uiSession(fxStatus);
  const metalsUi = uiSession(metalsStatus);
  const pairsUi = uiLoad(pairs.status);

  const xau = series["XAUUSD"] ?? [];
  const btc = series["BTC-USD"] ?? [];
  const eth = series["ETH-USD"] ?? [];
  const eurusd = series["EUR/USD"] ?? [];

  const lastVal = (pts: ChartPoint[]) => (pts.length ? pts[pts.length - 1].v : null);
  const chgPct = (pts: ChartPoint[]) => {
    if (pts.length < 2) return null;
    const a = pts[pts.length - 2].v;
    const b = pts[pts.length - 1].v;
    if (a === 0) return null;
    return ((b - a) / a) * 100;
  };

  const pulse = [
    {
      sym: "XAUUSD",
      name: "Gold Spot",
      tag: "Commodities",
      price: lastVal(xau) ?? 0,
      chg: chgPct(xau) ?? 0,
      vol: "High"
    },
    { sym: "BTC-USD", name: "Bitcoin", tag: "Crypto", price: lastVal(btc) ?? 0, chg: chgPct(btc) ?? 0, vol: "High" },
    { sym: "ETH-USD", name: "Ethereum", tag: "Crypto", price: lastVal(eth) ?? 0, chg: chgPct(eth) ?? 0, vol: "Med" },
    { sym: "EUR/USD", name: "Euro / US Dollar", tag: "FX", price: lastVal(eurusd) ?? 0, chg: chgPct(eurusd) ?? 0, vol: "Med" }
  ];

  const xauLast = lastVal(xau);
  const xauHigh = xau.length ? Math.max(...xau.map((p) => p.v)) : null;
  const xauLow = xau.length ? Math.min(...xau.map((p) => p.v)) : null;
  const xauMid = xauHigh != null && xauLow != null ? (xauHigh + xauLow) / 2 : null;

  const xauLevels = useMemo(() => {
    if (xauHigh == null || xauLow == null) return [];
    const r1 = xauLow + (xauHigh - xauLow) * 0.72;
    const r2 = xauLow + (xauHigh - xauLow) * 0.88;
    const s1 = xauLow + (xauHigh - xauLow) * 0.28;
    const s2 = xauLow + (xauHigh - xauLow) * 0.12;
    return [
      { k: "R2", v: r2 },
      { k: "R1", v: r1 },
      { k: "MID", v: (xauHigh + xauLow) / 2 },
      { k: "S1", v: s1 },
      { k: "S2", v: s2 }
    ];
  }, [xauHigh, xauLow]);

  return (
    <>
      <section className="pageHero">
        <div>
          <div className="eyebrow">Markets</div>
          <h1 className="pageTitle">Realtime crypto and forex</h1>
          <p className="pageLead">
            Live market dashboard with crypto, FX, and gold.
          </p>
        </div>
        <div className="pageHeroActions">
          <button
            className="primary"
            type="button"
            onClick={() => void refreshMarkets()}
            disabled={marketState.status === "loading"}
            aria-busy={marketState.status === "loading"}
            title={marketState.status === "loading" ? "Updating..." : "Refresh"}
          >
            {marketState.status === "loading" ? "Updating..." : "Refresh"}
          </button>
        </div>
      </section>

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
          Some panels may show the last known prices.
        </Notice>
      ) : null}

      <section className="marketHeroGrid" aria-label="Featured market charts">
        <div className="heroChartCard">
          <div className="heroChartHead">
            <div>
              <div className="panelTitle">XAUUSD</div>
              <div className="panelSub">Gold spot</div>
            </div>
            <div className="heroChartNums">
              <div className="heroPx mono">
                {lastVal(xau) == null ? "--" : lastVal(xau)!.toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </div>
              <div className={`heroChg mono ${chgPct(xau) == null ? "muted" : chgPct(xau)! >= 0 ? "pos" : "neg"}`}>
                {chgPct(xau) == null ? "--" : `${chgPct(xau)! >= 0 ? "+" : ""}${chgPct(xau)!.toFixed(3)}%`}
              </div>
            </div>
          </div>
          {marketState.data ? (
            <LineChart points={xau} height={260} stroke="rgba(255, 95, 122, 0.92)" fill="rgba(255, 95, 122, 0.10)" yLabel="USD" />
          ) : (
            <Skeleton style={{ height: 260, width: "100%", borderRadius: 16 }} />
          )}
        </div>

        <div className="heroSide">
          <div className="miniChartCard">
            <div className="miniChartHead">
              <div className="panelTitle">BTC-USD</div>
              <div className="heroChartNums">
                <div className="heroPx mono">
                  {lastVal(btc) == null ? "--" : `$${lastVal(btc)!.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
                </div>
                <div className={`heroChg mono ${chgPct(btc) == null ? "muted" : chgPct(btc)! >= 0 ? "pos" : "neg"}`}>
                  {chgPct(btc) == null ? "--" : `${chgPct(btc)! >= 0 ? "+" : ""}${chgPct(btc)!.toFixed(3)}%`}
                </div>
              </div>
            </div>
            {marketState.data ? <LineChart points={btc} height={120} /> : <Skeleton style={{ height: 120, width: "100%", borderRadius: 16 }} />}
          </div>

          <div className="miniChartCard">
            <div className="miniChartHead">
              <div className="panelTitle">ETH-USD</div>
              <div className="heroChartNums">
                <div className="heroPx mono">
                  {lastVal(eth) == null ? "--" : `$${lastVal(eth)!.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
                </div>
                <div className={`heroChg mono ${chgPct(eth) == null ? "muted" : chgPct(eth)! >= 0 ? "pos" : "neg"}`}>
                  {chgPct(eth) == null ? "--" : `${chgPct(eth)! >= 0 ? "+" : ""}${chgPct(eth)!.toFixed(3)}%`}
                </div>
              </div>
            </div>
            {marketState.data ? (
              <LineChart points={eth} height={120} stroke="rgba(122, 167, 255, 0.95)" fill="rgba(122, 167, 255, 0.10)" />
            ) : (
              <Skeleton style={{ height: 120, width: "100%", borderRadius: 16 }} />
            )}
          </div>

          <div className="miniChartCard">
            <div className="miniChartHead">
              <div className="panelTitle">EUR/USD</div>
              <div className="heroChartNums">
                <div className="heroPx mono">
                  {lastVal(eurusd) == null ? "--" : lastVal(eurusd)!.toLocaleString(undefined, { maximumFractionDigits: 5 })}
                </div>
                <div
                  className={`heroChg mono ${chgPct(eurusd) == null ? "muted" : chgPct(eurusd)! >= 0 ? "pos" : "neg"}`}
                >
                  {chgPct(eurusd) == null ? "--" : `${chgPct(eurusd)! >= 0 ? "+" : ""}${chgPct(eurusd)!.toFixed(3)}%`}
                </div>
              </div>
            </div>
            {marketState.data ? (
              <LineChart points={eurusd} height={120} stroke="rgba(231, 238, 252, 0.72)" fill="rgba(231, 238, 252, 0.08)" />
            ) : (
              <Skeleton style={{ height: 120, width: "100%", borderRadius: 16 }} />
            )}
          </div>
        </div>
      </section>

      <section className="marketMeta">
        <div>
          Feed: <span className={`${conn.cls} mono`}>{conn.label}</span>
          {stream.status === "error" && stream.error ? <span className="muted">{" - "}{stream.error}</span> : null}
          {marketState.status === "error" && marketState.error ? (
            <span className="muted">{" - "}{marketState.error}</span>
          ) : null}
        </div>
        <div className="muted">
          Updated: <span className="mono">{updatedAt}</span> | FX:{" "}
          <span className={`${fxUi.cls} mono`}>{fxUi.label}</span> | Metals:{" "}
          <span className={`${metalsUi.cls} mono`}>{metalsUi.label}</span>
        </div>
      </section>

      <section className="marketGrid" aria-label="Crypto pairs">
        <div className="marketCard">
          <div className="marketCardHead">
            <div>
              <div className="panelTitle">Crypto Pairs</div>
              <div className="panelSub">Browse available trading pairs</div>
            </div>
            <div className={`${pairsUi.cls} mono`}>{pairsUi.label}</div>
          </div>

          <div className="pairsControls" aria-label="Pairs controls">
            <label className="pairsSearch">
              <span className="muted">Search</span>
              <input
                value={pairs.q}
                onChange={(e) => setPairs((s) => ({ ...s, q: e.target.value, offset: 0 }))}
                placeholder="e.g. BTC, ETH, SOL, USDT..."
              />
            </label>

            <label className="pairsSelect">
              <span className="muted">Quote</span>
              <select
                value={pairs.quote}
                onChange={(e) => setPairs((s) => ({ ...s, quote: e.target.value, offset: 0 }))}
              >
                <option value="USD">USD</option>
                <option value="USDT">USDT</option>
                <option value="BTC">BTC</option>
                <option value="ETH">ETH</option>
                <option value="">All</option>
              </select>
            </label>

            <div className="pairsPager">
              <button
                className="mini"
                type="button"
                disabled={pairs.offset === 0}
                onClick={() => setPairs((s) => ({ ...s, offset: Math.max(0, s.offset - s.limit) }))}
              >
                Prev
              </button>
              <div className="muted mono">
                {pairs.total ? `${pairs.offset + 1}-${Math.min(pairs.total, pairs.offset + pairs.limit)}` : "--"} /{" "}
                {pairs.total ? pairs.total.toLocaleString() : "--"}
              </div>
              <button
                className="mini"
                type="button"
                disabled={pairs.offset + pairs.limit >= pairs.total}
                onClick={() => setPairs((s) => ({ ...s, offset: s.offset + s.limit }))}
              >
                Next
              </button>
            </div>
          </div>

          {pairs.status === "error" && pairs.error ? (
            <Notice
              tone="warn"
              title="Pairs list is unavailable"
              actions={
                <button
                  className="mini"
                  type="button"
                  onClick={() => setPairsReloadKey((k) => k + 1)}
                  title="Reload"
                >
                  Retry
                </button>
              }
            >
              Try again in a moment.
            </Notice>
          ) : null}

          <div className="pairsTable" role="table" aria-label="Pairs table">
            <div className="pairsHeader" role="row">
              <div role="columnheader">Pair</div>
              <div role="columnheader">Base</div>
              <div role="columnheader">Quote</div>
            </div>
            {pairs.status === "loading" ? (
              Array.from({ length: 10 }).map((_, i) => (
                <div className="pairsRow" role="row" key={`sk-pair-${i}`}>
                  <Skeleton style={{ height: 14, width: "70%", borderRadius: 999 }} />
                  <Skeleton style={{ height: 14, width: "60%", borderRadius: 999 }} />
                  <Skeleton style={{ height: 14, width: "60%", borderRadius: 999 }} />
                </div>
              ))
            ) : (
              pairs.items.map((it) => (
                <div className="pairsRow" role="row" key={it.pair}>
                  <div className="mono" role="cell">
                    {it.pair}
                  </div>
                  <div className="muted mono" role="cell">
                    {it.base ?? "--"}
                  </div>
                  <div className="muted mono" role="cell">
                    {it.quote ?? "--"}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </section>

      <section className="traderStrip" aria-label="Traders">
        <div className="traderCard">
          <img className="traderImg" src={trader01} alt="3D trader illustration 1" />
          <div className="traderInfo">
            <div className="panelTitle">Momentum</div>
            <div className="panelSub">Breakouts, volume, trend confirmation</div>
          </div>
        </div>
        <div className="traderCard">
          <img className="traderImg" src={trader02} alt="3D trader illustration 2" />
          <div className="traderInfo">
            <div className="panelTitle">Macro</div>
            <div className="panelSub">Rates, USD strength, risk-on/off regimes</div>
          </div>
        </div>
        <div className="traderCard">
          <img className="traderImg" src={trader03} alt="3D trader illustration 3" />
          <div className="traderInfo">
            <div className="panelTitle">Mean Reversion</div>
            <div className="panelSub">Ranges, oversold/overbought, fade extremes</div>
          </div>
        </div>
      </section>

      <section className="marketGrid">
        <div className="marketCard">
          <div className="marketCardHead">
            <div>
              <div className="panelTitle">Crypto</div>
              <div className="panelSub">BTC-USD, ETH-USD, SOL-USD</div>
            </div>
            <div className={`${conn.cls} mono`}>{conn.label}</div>
          </div>

          <div className="quoteList" role="table" aria-label="Crypto quotes">
            {marketRows
              .filter((r) => r.kind === "crypto")
              .map((r) => (
                <div className="quoteRow" role="row" key={r.symbol}>
                  <div className="quoteSym mono" role="cell">
                    {r.symbol}
                  </div>
                  <div className="quotePx mono" role="cell">
                    ${r.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                  </div>
                  <div
                    className={`quoteChg mono ${r.changePct == null ? "muted" : r.changePct >= 0 ? "pos" : "neg"}`}
                    role="cell"
                  >
                    {r.changePct == null ? "--" : `${r.changePct >= 0 ? "+" : ""}${r.changePct.toFixed(3)}%`}
                  </div>
                </div>
              ))}
          </div>
        </div>

        <div className="marketCard">
          <div className="marketCardHead">
            <div>
              <div className="panelTitle">Forex</div>
              <div className="panelSub">EUR/USD, GBP/USD, USD/JPY</div>
            </div>
            <div className={`${fxUi.cls} mono`}>{fxUi.label}</div>
          </div>

          <div className="quoteList" role="table" aria-label="Forex quotes">
            {marketRows
              .filter((r) => r.kind === "fx")
              .map((r) => (
                <div className="quoteRow" role="row" key={r.symbol}>
                  <div className="quoteSym mono" role="cell">
                    {r.symbol}
                  </div>
                  <div className="quotePx mono" role="cell">
                    {r.price.toLocaleString(undefined, { maximumFractionDigits: 5 })}
                  </div>
                  <div
                    className={`quoteChg mono ${r.changePct == null ? "muted" : r.changePct >= 0 ? "pos" : "neg"}`}
                    role="cell"
                  >
                    {r.changePct == null ? "--" : `${r.changePct >= 0 ? "+" : ""}${r.changePct.toFixed(3)}%`}
                  </div>
                </div>
              ))}
          </div>
        </div>
      </section>

      <section className="marketGrid" aria-label="Market pulse and insights">
        <div className="marketCard">
          <div className="marketCardHead">
            <div>
              <div className="panelTitle">Market Pulse</div>
              <div className="panelSub">Quick scan of key symbols</div>
            </div>
            <div className="muted mono">auto</div>
          </div>

          <div className="pulse">
            {pulse.map((p) => {
              const good = p.chg >= 0;
              return (
                <div className="pulseRow" key={p.sym}>
                  <div className="pulseLeft">
                    <div className="pulseSym mono">{p.sym}</div>
                    <div className="pulseName muted">{p.name}</div>
                  </div>
                  <div className="pulseMid">
                    <span className="pill">{p.tag}</span>
                    <span className="pill">{p.vol} vol</span>
                  </div>
                  <div className="pulseRight">
                    <div className="mono pulsePx">
                      {p.sym === "EUR/USD"
                        ? p.price.toLocaleString(undefined, { maximumFractionDigits: 5 })
                        : p.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </div>
                    <div className={`mono pulseChg ${good ? "pos" : "neg"}`}>
                      {good ? "+" : ""}
                      {p.chg.toFixed(3)}%
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="marketCard">
          <div className="marketCardHead">
            <div>
              <div className="panelTitle">XAUUSD Levels</div>
              <div className="panelSub">Derived from the current visible range</div>
            </div>
            <div className="muted mono">{xauLast == null ? "--" : xauLast.toFixed(2)}</div>
          </div>

          <div className="levels">
            <div className="levelsTop">
              <div className="levelsStat">
                <div className="levelsLabel">High</div>
                <div className="levelsVal mono">{xauHigh == null ? "--" : xauHigh.toFixed(2)}</div>
              </div>
              <div className="levelsStat">
                <div className="levelsLabel">Mid</div>
                <div className="levelsVal mono">{xauMid == null ? "--" : xauMid.toFixed(2)}</div>
              </div>
              <div className="levelsStat">
                <div className="levelsLabel">Low</div>
                <div className="levelsVal mono">{xauLow == null ? "--" : xauLow.toFixed(2)}</div>
              </div>
            </div>

            <div className="levelsList" aria-label="Support and resistance">
              {xauLevels.map((l) => (
                <div className="levelsRow" key={l.k}>
                  <div className="levelsKey mono">{l.k}</div>
                  <div className="levelsBar" aria-hidden="true">
                    <div
                      className={`levelsFill ${l.k.startsWith("R") ? "r" : l.k.startsWith("S") ? "s" : "m"}`}
                      style={{
                        width:
                          xauHigh == null || xauLow == null
                            ? "0%"
                            : `${((l.v - xauLow) / Math.max(0.0001, xauHigh - xauLow)) * 100}%`
                      }}
                    />
                  </div>
                  <div className="levelsNum mono">{l.v.toFixed(2)}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="tgCta" aria-label="Join our Telegram channel">
        <div className="tgCtaInner">
          <div className="tgCtaBadge">
            <i className="fa-brands fa-telegram" aria-hidden="true" /> Telegram
          </div>
          <h2 className="tgCtaTitle">
            <span className="tg3d" data-text="Join The Winners Circle">
              Join The Winners Circle
            </span>
          </h2>
          <p className="tgCtaLead">
            Get updates, support, and onboarding details. The channel is where we post the latest notes and announcements.
          </p>
          <div className="tgCtaActions">
            <a className="primary" href="https://t.me/tradefix1" target="_blank" rel="noreferrer">
              Join Telegram Channel
            </a>
            <a className="ghost" href="https://t.me/Sr_Haddan" target="_blank" rel="noreferrer">
              Message Admin
            </a>
          </div>
          <div className="tgCtaFine muted">
            Tip: keep notifications on for fast updates. Markets can move quickly.
          </div>
        </div>

        <div className="tgCtaArt" aria-hidden="true">
          <div className="tgOrb" />
          <div className="tgGrid" />
        </div>
      </section>
    </>
  );
}
