import { useEffect, useMemo, useRef, useState } from "react";
import { apiUrl } from "../lib/api";

export type Candle = {
  time: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type Timeframe = "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1D" | "1W" | "1M";
type ChartType = "Candlestick" | "Hollow Candles" | "Bar" | "Line" | "Area";
type Tool = "Cursor" | "Trendline" | "H-Line" | "Fib";

export type Overlay = {
  id: string;
  name: string;
  values: number[]; // aligned with candles array
  color: string;
  lineWidth?: number;
  dashed?: boolean;
};

export type ChartMarker = {
  time: number; // unix seconds
  label: string;
  color?: string;
  dashed?: boolean;
};

type IndicatorState = {
  volume: boolean;
  ema20: boolean;
  ema50: boolean;
  sma20: boolean;
  bbands: boolean;
  rsi: boolean;
  macd: boolean;
};

type Trendline = { t1: number; p1: number; t2: number; p2: number };
type HLine = { price: number; label?: string };
type Fib = { t1: number; p1: number; t2: number; p2: number };

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

async function fetchCandles(params: {
  symbol: string;
  interval: string;
  limit: number;
  endTimeSec?: number;
  signal?: AbortSignal;
}): Promise<Candle[]> {
  const u = new URL(apiUrl("/api/chart-data"), typeof window !== "undefined" ? window.location.origin : "http://localhost");
  u.searchParams.set("symbol", params.symbol);
  u.searchParams.set("interval", params.interval);
  u.searchParams.set("limit", String(params.limit));
  if (params.endTimeSec != null) u.searchParams.set("endTime", String(params.endTimeSec));
  const res = await fetch(u.toString(), { method: "GET", signal: params.signal, headers: { Accept: "application/json" } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`);
  return Array.isArray(j?.data) ? (j.data as Candle[]) : [];
}

function sma(values: number[], period: number) {
  const out = new Array(values.length).fill(Number.NaN);
  if (period <= 1) return values.slice();
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    sum += v;
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function ema(values: number[], period: number) {
  const out = new Array(values.length).fill(Number.NaN);
  if (period <= 1) return values.slice();
  const k = 2 / (period + 1);
  let prev = Number.NaN;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(prev)) prev = v;
    else prev = v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function stddev(values: number[], period: number) {
  const out = new Array(values.length).fill(Number.NaN);
  if (period <= 1) return out;
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    let sum2 = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const v = values[j];
      sum += v;
      sum2 += v * v;
    }
    const mean = sum / period;
    const var0 = Math.max(0, sum2 / period - mean * mean);
    out[i] = Math.sqrt(var0);
  }
  return out;
}

function rsi(values: number[], period = 14) {
  const out = new Array(values.length).fill(Number.NaN);
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i < values.length; i++) {
    const ch = values[i] - values[i - 1];
    const gain = Math.max(0, ch);
    const loss = Math.max(0, -ch);
    if (i <= period) {
      avgGain += gain;
      avgLoss += loss;
      if (i === period) {
        avgGain /= period;
        avgLoss /= period;
      }
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }
    if (i >= period) {
      const rs = avgLoss === 0 ? Infinity : avgGain / avgLoss;
      out[i] = 100 - 100 / (1 + rs);
    }
  }
  return out;
}

function macd(values: number[], fast = 12, slow = 26, signal = 9) {
  const ef = ema(values, fast);
  const es = ema(values, slow);
  const line = values.map((_v, i) => ef[i] - es[i]);
  const sig = ema(line, signal);
  const hist = line.map((v, i) => v - sig[i]);
  return { line, signal: sig, hist };
}

export default function TradingChart({
  symbol = "BTCUSD",
  dataProvider,
  overlaysBuilder,
  heightPx,
  markers
}: {
  symbol?: string;
  dataProvider?: (params: {
    symbol: string;
    interval: string;
    limit: number;
    endTimeSec?: number;
    signal?: AbortSignal;
  }) => Promise<Candle[]>;
  overlaysBuilder?: (candles: Candle[], interval: string) => Overlay[];
  heightPx?: number;
  markers?: ChartMarker[];
}) {
  // Default to 1m for the Progress simulation (and to match trader expectations).
  const [tf, setTf] = useState<Timeframe>("1m");
  const [chartType, setChartType] = useState<ChartType>("Candlestick");
  const [tool, setTool] = useState<Tool>("Cursor");
  const [ind, setInd] = useState<IndicatorState>({
    volume: true,
    ema20: true,
    ema50: false,
    sma20: false,
    bbands: false,
    rsi: false,
    macd: false
  });
  const [autoScale, setAutoScale] = useState(true);
  const [logScale, setLogScale] = useState(false);

  const [candles, setCandles] = useState<Candle[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function defaultBarsPerScreen(x: Timeframe) {
    // TradingView-ish: 1m should feel "zoomed in" by default.
    if (x === "1m") return 180;
    if (x === "5m") return 240;
    if (x === "15m") return 240;
    if (x === "30m") return 240;
    if (x === "1h") return 240;
    if (x === "4h") return 240;
    if (x === "1D") return 200;
    if (x === "1W") return 160;
    if (x === "1M") return 120;
    return 240;
  }

  const [barsPerScreen, setBarsPerScreen] = useState(() => defaultBarsPerScreen("1m"));
  const [startIndex, setStartIndex] = useState(0);

  const [hover, setHover] = useState<{ i: number; x: number; y: number; price: number } | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);

  const [trendlines, setTrendlines] = useState<Trendline[]>([]);
  const [hlines, setHlines] = useState<HLine[]>([]);
  const [fibs, setFibs] = useState<Fib[]>([]);
  const pendingRef = useRef<{ tool: Tool; t?: number; p?: number } | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ active: boolean; x0: number; start0: number; stepPx: number } | null>(null);
  const rafRef = useRef<number | null>(null);
  const interval = useMemo(() => (tf === "1M" ? "1mo" : tf), [tf]);
  const provider = useMemo(() => dataProvider || fetchCandles, [dataProvider]);

  // When the timeframe changes, reset the zoom to a sensible default (like TradingView).
  useEffect(() => {
    setBarsPerScreen(defaultBarsPerScreen(tf));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tf]);

  useEffect(() => {
    const ac = new AbortController();
    setBusy(true);
    setErr(null);
    // Pull enough history so 1m charts feel like real trading platforms.
    provider({ symbol, interval, limit: 3000, signal: ac.signal })
      .then((d) => {
        const sorted = d.slice().sort((a, b) => a.time - b.time);
        setCandles(sorted);
        setStartIndex(Math.max(0, sorted.length - barsPerScreen));
      })
      .catch((e: any) => setErr(typeof e?.message === "string" ? e.message : "Failed"))
      .finally(() => setBusy(false));
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, interval, provider]);

  // Real-time poll of latest candle.
  useEffect(() => {
    if (!candles.length) return;
    const id = window.setInterval(() => {
      const endTime = Math.floor(Date.now() / 1000);
      provider({ symbol, interval, limit: 1, endTimeSec: endTime })
        .then((d) => {
          if (!d.length) return;
          const last = d[d.length - 1];
          setCandles((prev) => {
            if (!prev.length) return [last];
            const pLast = prev[prev.length - 1];
            if (pLast.time === last.time) {
              const out = prev.slice();
              out[out.length - 1] = last;
              return out;
            }
            const out = prev.concat([last]);
            if (out.length > 5000) out.splice(0, out.length - 5000);
            return out;
          });
        })
        .catch(() => {});
    }, 1000);
    return () => window.clearInterval(id);
  }, [candles.length, symbol, interval, provider]);

  const derived = useMemo(() => {
    const closes = candles.map((c) => c.close);
    return {
      ema20: ema(closes, 20),
      ema50: ema(closes, 50),
      sma20: sma(closes, 20),
      rsi14: rsi(closes, 14),
      macd: macd(closes, 12, 26, 9),
      bb: (() => {
        const mid = sma(closes, 20);
        const sd = stddev(closes, 20);
        const upper = mid.map((m, i) => m + 2 * sd[i]);
        const lower = mid.map((m, i) => m - 2 * sd[i]);
        return { mid, upper, lower };
      })()
    };
  }, [candles]);

  const overlays = useMemo(() => {
    if (!overlaysBuilder) return [];
    try {
      return overlaysBuilder(candles, interval) || [];
    } catch {
      return [];
    }
  }, [overlaysBuilder, candles, interval]);

  const markerList = useMemo(() => (Array.isArray(markers) ? markers : []), [markers]);

  const view = useMemo(() => {
    const s = clamp(startIndex, 0, Math.max(0, candles.length - 1));
    const e = clamp(s + barsPerScreen, 0, candles.length);
    return { s, e, items: candles.slice(s, e) };
  }, [candles, startIndex, barsPerScreen]);

  function toScaledPrice(v: number) {
    if (!logScale) return v;
    return Math.log(Math.max(1e-12, v));
  }
  function fromScaledPrice(v: number) {
    if (!logScale) return v;
    return Math.exp(v);
  }

  function formatPrice(vScaled: number) {
    const x = fromScaledPrice(vScaled);
    if (x >= 100) return x.toFixed(2);
    if (x >= 1) return x.toFixed(5);
    return x.toFixed(8);
  }

  function formatTime(tsSec: number) {
    const d = new Date(tsSec * 1000);
    const tfLow = interval.toLowerCase();
    const isIntra = ["1m", "5m", "15m", "30m", "1h", "4h"].includes(tfLow);
    if (isIntra) return d.toLocaleString([], { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    return d.toLocaleDateString([], { year: "numeric", month: "short", day: "2-digit" });
  }

  function scheduleDraw() {
    if (rafRef.current != null) return;
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      draw();
    });
  }

  function draw() {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host) return;

    const rect = host.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(420, Math.floor(rect.height));
    const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));

    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // TradingView-ish theme.
    const bg = "#131722";
    const gridCol = "#1e222d";
    const txtMuted = "rgba(231, 238, 252, 0.55)";
    const txt = "rgba(231, 238, 252, 0.92)";
    const up = "rgba(0, 200, 83, 0.98)";
    const down = "rgba(239, 83, 80, 0.98)";

    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    const padL = 10;
    const padT = 10;
    const padB = 22;
    const scaleW = 72;
    const volH = ind.volume ? 90 : 0;
    const indH = ind.rsi || ind.macd ? 120 : 0;

    const chartLeft = padL;
    const chartRight = w - scaleW;
    const chartTop = padT;
    const chartBottom = h - padB - volH - indH;
    const chartW = chartRight - chartLeft;
    const chartH = chartBottom - chartTop;

    const volTop = chartBottom;
    const volBottom = chartBottom + volH;
    const indTop = volBottom;
    const indBottom = h - padB;

    // Grid
    ctx.strokeStyle = gridCol;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i <= 4; i++) {
      const y = chartTop + (chartH * i) / 5;
      ctx.moveTo(chartLeft, y);
      ctx.lineTo(chartRight, y);
    }
    for (let i = 1; i <= 6; i++) {
      const x = chartLeft + (chartW * i) / 7;
      ctx.moveTo(x, chartTop);
      ctx.lineTo(x, chartBottom);
      if (volH) {
        ctx.moveTo(x, volTop);
        ctx.lineTo(x, volBottom);
      }
      if (indH) {
        ctx.moveTo(x, indTop);
        ctx.lineTo(x, indBottom);
      }
    }
    ctx.stroke();

    const items = view.items;
    if (!items.length) return;

    const step = chartW / Math.max(1, items.length);
    const bodyW = Math.max(1, Math.min(12, step * 0.70));

    // Visible y-range
    let minY = Infinity;
    let maxY = -Infinity;
    for (const c of items) {
      minY = Math.min(minY, toScaledPrice(c.low));
      maxY = Math.max(maxY, toScaledPrice(c.high));
    }
    if (!Number.isFinite(minY) || !Number.isFinite(maxY) || minY === maxY) {
      minY = toScaledPrice(items[0].close) - 1;
      maxY = toScaledPrice(items[0].close) + 1;
    }
    if (autoScale) {
      const pad = (maxY - minY) * 0.12;
      minY -= pad;
      maxY += pad;
    }

    const yAt = (v: number) => {
      const r = (toScaledPrice(v) - minY) / (maxY - minY);
      return chartTop + (1 - clamp(r, 0, 1)) * chartH;
    };
    const xAt = (i: number) => chartLeft + i * step + step / 2;

    // Markers (vertical lines with labels), e.g. milestones on Progress.
    if (markerList.length) {
      ctx.save();
      ctx.font = "12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial";
      for (const m of markerList) {
        if (!m || !Number.isFinite(m.time)) continue;
        // Find the nearest candle in the current view.
        let iBest = -1;
        for (let i = 0; i < items.length; i++) {
          const t0 = items[i].time;
          const t1 = items[i + 1]?.time ?? Infinity;
          if (m.time >= t0 && m.time < t1) {
            iBest = i;
            break;
          }
        }
        if (iBest < 0) continue;
        const x = xAt(iBest);
        const col = m.color || "rgba(231, 238, 252, 0.22)";
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.2;
        if (m.dashed) ctx.setLineDash([6, 6]);
        else ctx.setLineDash([4, 8]);
        ctx.beginPath();
        ctx.moveTo(x, chartTop);
        ctx.lineTo(x, chartBottom);
        if (volH) {
          ctx.moveTo(x, volTop);
          ctx.lineTo(x, volBottom);
        }
        if (indH) {
          ctx.moveTo(x, indTop);
          ctx.lineTo(x, indBottom);
        }
        ctx.stroke();

        const label = String(m.label || "").trim();
        if (label) {
          ctx.setLineDash([]);
          const pad = 6;
          const tw = ctx.measureText(label).width;
          const bw = Math.ceil(tw + pad * 2);
          const bh = 20;
          const bx = clamp(x - bw / 2, chartLeft + 2, chartRight - bw - 2);
          const by = chartTop + 8;
          ctx.fillStyle = "rgba(11, 18, 32, 0.70)";
          ctx.strokeStyle = "rgba(231, 238, 252, 0.16)";
          ctx.lineWidth = 1;
          const rr = (ctx as any).roundRect as undefined | ((x: number, y: number, w: number, h: number, r: number) => void);
          ctx.beginPath();
          if (typeof rr === "function") rr.call(ctx, bx, by, bw, bh, 10);
          else ctx.rect(bx, by, bw, bh);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = "rgba(231, 238, 252, 0.86)";
          ctx.fillText(label, bx + pad, by + 14);
        }
      }
      ctx.restore();
    }

    // Overlay lines (MA, BB)
    const drawLine = (arr: number[], col: string, width = 2, dashed = false) => {
      ctx.save();
      ctx.strokeStyle = col;
      ctx.lineWidth = width;
      if (dashed) ctx.setLineDash([6, 6]);
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < items.length; i++) {
        const idx = view.s + i;
        const v = arr[idx];
        if (!Number.isFinite(v)) {
          started = false;
          continue;
        }
        const x = xAt(i);
        const y = chartTop + (1 - clamp((toScaledPrice(v) - minY) / (maxY - minY), 0, 1)) * chartH;
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();
    };

    if (ind.bbands) {
      drawLine(derived.bb.upper, "rgba(231, 238, 252, 0.28)", 1.6);
      drawLine(derived.bb.mid, "rgba(231, 238, 252, 0.35)", 1.6);
      drawLine(derived.bb.lower, "rgba(231, 238, 252, 0.28)", 1.6);
    }
    if (ind.ema20) drawLine(derived.ema20, "rgba(90, 210, 255, 0.95)", 2);
    if (ind.ema50) drawLine(derived.ema50, "rgba(255, 203, 92, 0.95)", 2);
    if (ind.sma20) drawLine(derived.sma20, "rgba(231, 238, 252, 0.65)", 2);

    // Chart type
    if (chartType === "Line" || chartType === "Area") {
      ctx.beginPath();
      for (let i = 0; i < items.length; i++) {
        const x = xAt(i);
        const y = yAt(items[i].close);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      if (chartType === "Area") {
        ctx.lineTo(xAt(items.length - 1), chartBottom);
        ctx.lineTo(xAt(0), chartBottom);
        ctx.closePath();
        ctx.fillStyle = "rgba(90, 210, 255, 0.14)";
        ctx.fill();
        ctx.beginPath();
        for (let i = 0; i < items.length; i++) {
          const x = xAt(i);
          const y = yAt(items[i].close);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = "rgba(90, 210, 255, 0.95)";
        ctx.lineWidth = 2;
        ctx.stroke();
      } else {
        ctx.strokeStyle = "rgba(231, 238, 252, 0.90)";
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    } else {
      // Candles / hollow / bar
      for (let i = 0; i < items.length; i++) {
        const c = items[i];
        const x = xAt(i);
        const oY = yAt(c.open);
        const cY = yAt(c.close);
        const hY = yAt(c.high);
        const lY = yAt(c.low);
        const bull = c.close >= c.open;

        if (chartType === "Bar") {
          ctx.strokeStyle = bull ? up : down;
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.moveTo(x, hY);
          ctx.lineTo(x, lY);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(x - bodyW / 2, oY);
          ctx.lineTo(x, oY);
          ctx.moveTo(x, cY);
          ctx.lineTo(x + bodyW / 2, cY);
          ctx.stroke();
          continue;
        }

        // wick
        ctx.strokeStyle = bull ? "rgba(0, 200, 83, 0.65)" : "rgba(239, 83, 80, 0.65)";
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(x, hY);
        ctx.lineTo(x, lY);
        ctx.stroke();

        // body
        const yTop = Math.min(oY, cY);
        const yBot = Math.max(oY, cY);
        const bodyH = Math.max(2, yBot - yTop);
        if (chartType === "Hollow Candles" && bull) {
          ctx.strokeStyle = up;
          ctx.lineWidth = 1.2;
          ctx.strokeRect(x - bodyW / 2, yTop, bodyW, bodyH);
        } else {
          ctx.fillStyle = bull ? up : down;
          ctx.fillRect(x - bodyW / 2, yTop, bodyW, bodyH);
          ctx.strokeStyle = "rgba(11, 18, 32, 0.85)";
          ctx.lineWidth = 1;
          ctx.strokeRect(x - bodyW / 2, yTop, bodyW, bodyH);
        }
      }
    }

    // Custom overlays (e.g. target path). Draw after price so it's visible.
    for (const o of overlays) {
      if (!o || !Array.isArray(o.values) || o.values.length !== candles.length) continue;
      drawLine(o.values, o.color, o.lineWidth || 2, !!o.dashed);
    }

    // Volume
    if (volH) {
      let maxVol = 1;
      for (const c of items) maxVol = Math.max(maxVol, c.volume || 0);
      const vAt = (vol: number) => volBottom - clamp(vol / Math.max(1, maxVol), 0, 1) * (volH - 6);
      for (let i = 0; i < items.length; i++) {
        const c = items[i];
        const x = xAt(i);
        const bull = c.close >= c.open;
        ctx.fillStyle = bull ? "rgba(0, 200, 83, 0.35)" : "rgba(239, 83, 80, 0.35)";
        const y = vAt(c.volume || 0);
        ctx.fillRect(x - bodyW / 2, y, bodyW, volBottom - y);
      }
      ctx.strokeStyle = gridCol;
      ctx.beginPath();
      ctx.moveTo(chartLeft, volTop);
      ctx.lineTo(chartRight, volTop);
      ctx.stroke();
    }

    // Indicator pane (RSI or MACD)
    if (indH) {
      ctx.strokeStyle = gridCol;
      ctx.beginPath();
      ctx.moveTo(chartLeft, indTop);
      ctx.lineTo(chartRight, indTop);
      ctx.stroke();

      const paneH = indBottom - indTop;
      const yIndAt = (v: number, min: number, max: number) => {
        const r = (v - min) / (max - min);
        return indTop + (1 - clamp(r, 0, 1)) * paneH;
      };

      if (ind.rsi) {
        const arr = derived.rsi14;
        ctx.save();
        ctx.strokeStyle = "rgba(180, 140, 255, 0.92)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < items.length; i++) {
          const idx = view.s + i;
          const v = arr[idx];
          if (!Number.isFinite(v)) {
            started = false;
            continue;
          }
          const x = xAt(i);
          const y = yIndAt(v, 0, 100);
          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.strokeStyle = "rgba(231, 238, 252, 0.18)";
        ctx.setLineDash([6, 6]);
        ctx.beginPath();
        ctx.moveTo(chartLeft, yIndAt(70, 0, 100));
        ctx.lineTo(chartRight, yIndAt(70, 0, 100));
        ctx.moveTo(chartLeft, yIndAt(30, 0, 100));
        ctx.lineTo(chartRight, yIndAt(30, 0, 100));
        ctx.stroke();
        ctx.restore();
      } else if (ind.macd) {
        const m = derived.macd;
        let mn = Infinity;
        let mx = -Infinity;
        for (let i = 0; i < items.length; i++) {
          const idx = view.s + i;
          const a = m.line[idx];
          const b = m.signal[idx];
          const c = m.hist[idx];
          if (Number.isFinite(a)) {
            mn = Math.min(mn, a);
            mx = Math.max(mx, a);
          }
          if (Number.isFinite(b)) {
            mn = Math.min(mn, b);
            mx = Math.max(mx, b);
          }
          if (Number.isFinite(c)) {
            mn = Math.min(mn, c);
            mx = Math.max(mx, c);
          }
        }
        if (!Number.isFinite(mn) || !Number.isFinite(mx) || mn === mx) {
          mn = -1;
          mx = 1;
        }
        const pad2 = (mx - mn) * 0.12;
        mn -= pad2;
        mx += pad2;

        // hist
        for (let i = 0; i < items.length; i++) {
          const idx = view.s + i;
          const v = m.hist[idx];
          if (!Number.isFinite(v)) continue;
          const x = xAt(i);
          const y0 = yIndAt(0, mn, mx);
          const y1 = yIndAt(v, mn, mx);
          ctx.fillStyle = v >= 0 ? "rgba(0, 200, 83, 0.35)" : "rgba(239, 83, 80, 0.35)";
          ctx.fillRect(x - bodyW / 2, Math.min(y0, y1), bodyW, Math.max(2, Math.abs(y1 - y0)));
        }

        const drawMacdLine = (arr: number[], col: string) => {
          ctx.save();
          ctx.strokeStyle = col;
          ctx.lineWidth = 2;
          ctx.beginPath();
          let started = false;
          for (let i = 0; i < items.length; i++) {
            const idx = view.s + i;
            const v = arr[idx];
            if (!Number.isFinite(v)) {
              started = false;
              continue;
            }
            const x = xAt(i);
            const y = yIndAt(v, mn, mx);
            if (!started) {
              ctx.moveTo(x, y);
              started = true;
            } else ctx.lineTo(x, y);
          }
          ctx.stroke();
          ctx.restore();
        };
        drawMacdLine(m.line, "rgba(90, 210, 255, 0.95)");
        drawMacdLine(m.signal, "rgba(255, 203, 92, 0.95)");
      }
    }

    // Drawings
    const visStartT = items[0].time;
    const visEndT = items[items.length - 1].time;
    const xForTime = (tSec: number) => {
      const r = (tSec - visStartT) / Math.max(1, visEndT - visStartT);
      return chartLeft + clamp(r, 0, 1) * chartW;
    };

    ctx.font = "12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial";
    ctx.textBaseline = "middle";

    for (const l of hlines) {
      const y = yAt(l.price);
      ctx.strokeStyle = "rgba(231, 238, 252, 0.28)";
      ctx.setLineDash([6, 6]);
      ctx.beginPath();
      ctx.moveTo(chartLeft, y);
      ctx.lineTo(chartRight, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = txtMuted;
      ctx.fillText(formatPrice(toScaledPrice(l.price)), chartRight + 8, y);
    }

    for (const tl of trendlines) {
      ctx.strokeStyle = "rgba(90, 210, 255, 0.75)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(xForTime(tl.t1), yAt(tl.p1));
      ctx.lineTo(xForTime(tl.t2), yAt(tl.p2));
      ctx.stroke();
    }

    for (const f of fibs) {
      const x1 = xForTime(f.t1);
      const x2 = xForTime(f.t2);
      const leftX = Math.min(x1, x2);
      const rightX = Math.max(x1, x2);
      const p1 = f.p1;
      const p2 = f.p2;
      const levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
      for (const lv of levels) {
        const p = p2 + (p1 - p2) * lv;
        const y = yAt(p);
        ctx.strokeStyle = "rgba(231, 238, 252, 0.18)";
        ctx.beginPath();
        ctx.moveTo(leftX, y);
        ctx.lineTo(rightX, y);
        ctx.stroke();
        ctx.fillStyle = txtMuted;
        ctx.fillText(`${Math.round(lv * 100)}%`, rightX + 8, y);
      }
    }

    // Price scale labels + last price tag
    ctx.fillStyle = txtMuted;
    ctx.font = "12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial";
    ctx.textBaseline = "middle";
    const ticks = 6;
    for (let i = 0; i <= ticks; i++) {
      const v = minY + ((maxY - minY) * i) / ticks;
      const y = chartTop + (chartH * (ticks - i)) / ticks;
      ctx.fillText(formatPrice(v), chartRight + 8, y);
    }

    const last = items[items.length - 1];
    const lastScaled = toScaledPrice(last.close);
    const lastY = chartTop + (1 - clamp((lastScaled - minY) / (maxY - minY), 0, 1)) * chartH;
    const lastBull = last.close >= last.open;
    const tagW = 62;
    const tagH = 18;
    ctx.fillStyle = lastBull ? up : down;
    ctx.fillRect(chartRight + 4, lastY - tagH / 2, tagW, tagH);
    ctx.fillStyle = "rgba(11, 18, 32, 0.95)";
    ctx.fillText(formatPrice(lastScaled), chartRight + 8, lastY);

    // Time axis labels
    ctx.fillStyle = txtMuted;
    ctx.font = "12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial";
    ctx.textBaseline = "alphabetic";
    const labelEvery = Math.max(1, Math.floor(items.length / 6));
    for (let i = 0; i < items.length; i += labelEvery) {
      const x = xAt(i);
      const s = formatTime(items[i].time);
      const m = ctx.measureText(s);
      ctx.fillText(s, clamp(x - m.width / 2, chartLeft, chartRight - m.width), h - 6);
    }

    // Crosshair
    if (hover) {
      ctx.strokeStyle = "rgba(231, 238, 252, 0.22)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 6]);
      ctx.beginPath();
      ctx.moveTo(hover.x, chartTop);
      ctx.lineTo(hover.x, chartBottom);
      ctx.moveTo(chartLeft, hover.y);
      ctx.lineTo(chartRight, hover.y);
      ctx.stroke();
      ctx.setLineDash([]);

      const lbl = formatPrice(toScaledPrice(hover.price));
      const boxW = 74;
      const boxH = 18;
      ctx.fillStyle = "rgba(30, 34, 45, 0.98)";
      ctx.fillRect(chartRight + 4, hover.y - boxH / 2, boxW, boxH);
      ctx.fillStyle = txt;
      ctx.textBaseline = "middle";
      ctx.fillText(lbl, chartRight + 8, hover.y);
    }
  }

  useEffect(() => {
    scheduleDraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    candles,
    view.s,
    view.e,
    barsPerScreen,
    startIndex,
    chartType,
    ind,
    autoScale,
    logScale,
    hover,
    trendlines,
    hlines,
    fibs
  ]);

  function pointToData(x: number, y: number) {
    const host = hostRef.current;
    if (!host || !view.items.length) return null;
    const rect = host.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;

    const padL = 10;
    const padT = 10;
    const padB = 22;
    const scaleW = 72;
    const volH = ind.volume ? 90 : 0;
    const indH = ind.rsi || ind.macd ? 120 : 0;

    const chartLeft = padL;
    const chartRight = w - scaleW;
    const chartTop = padT;
    const chartBottom = h - padB - volH - indH;
    const chartW = chartRight - chartLeft;
    const chartH = chartBottom - chartTop;

    if (x < chartLeft || x > chartRight || y < chartTop || y > chartBottom) return null;

    const items = view.items;
    const stepPx = chartW / Math.max(1, items.length);
    const i = clamp(Math.floor((x - chartLeft) / stepPx), 0, items.length - 1);

    // Recompute current visible scale (same as draw).
    let minY = Infinity;
    let maxY = -Infinity;
    for (const c of items) {
      minY = Math.min(minY, toScaledPrice(c.low));
      maxY = Math.max(maxY, toScaledPrice(c.high));
    }
    if (!Number.isFinite(minY) || !Number.isFinite(maxY) || minY === maxY) {
      minY = toScaledPrice(items[0].close) - 1;
      maxY = toScaledPrice(items[0].close) + 1;
    }
    if (autoScale) {
      const pad = (maxY - minY) * 0.12;
      minY -= pad;
      maxY += pad;
    }

    const r = 1 - (y - chartTop) / Math.max(1, chartH);
    const scaled = minY + clamp(r, 0, 1) * (maxY - minY);
    const price = fromScaledPrice(scaled);
    const globalIndex = view.s + i;
    const t = candles[globalIndex]?.time ?? items[i].time;

    return { i, globalIndex, t, price, stepPx };
  }

  function onPointerMove(e: React.PointerEvent) {
    const host = hostRef.current;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (dragRef.current?.active) {
      const d = dragRef.current;
      const dx = x - d.x0;
      const deltaBars = Math.round(dx / Math.max(1, d.stepPx));
      setStartIndex((_) => clamp(d.start0 - deltaBars, 0, Math.max(0, candles.length - barsPerScreen)));
      return;
    }

    const p = pointToData(x, y);
    if (!p) {
      setHover(null);
      return;
    }
    setHover({ i: p.globalIndex, x, y, price: p.price });
  }

  function onPointerLeave() {
    setHover(null);
  }

  function onPointerDown(e: React.PointerEvent) {
    const host = hostRef.current;
    if (!host) return;
    host.setPointerCapture(e.pointerId);

    const rect = host.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const p = pointToData(x, y);
    if (!p) return;

    if (tool === "Cursor") {
      dragRef.current = { active: true, x0: x, start0: startIndex, stepPx: p.stepPx };
      return;
    }

    // Drawing tools use clicks.
    if (tool === "H-Line") {
      setHlines((prev) => prev.concat([{ price: p.price, label: "Alert" }]));
      return;
    }

    const pending = pendingRef.current;
    if (!pending || pending.tool !== tool || pending.t == null || pending.p == null) {
      pendingRef.current = { tool, t: p.t, p: p.price };
      return;
    }
    const t1 = pending.t;
    const p1 = pending.p;
    const t2 = p.t;
    const p2 = p.price;
    pendingRef.current = null;
    if (tool === "Trendline") setTrendlines((prev) => prev.concat([{ t1, p1, t2, p2 }]));
    if (tool === "Fib") setFibs((prev) => prev.concat([{ t1, p1, t2, p2 }]));
  }

  function onPointerUp(e: React.PointerEvent) {
    const host = hostRef.current;
    if (!host) return;
    try {
      host.releasePointerCapture(e.pointerId);
    } catch {}
    if (dragRef.current) dragRef.current.active = false;
  }

  function onWheel(e: React.WheelEvent) {
    const host = hostRef.current;
    if (!host) return;
    e.preventDefault();

    const rect = host.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const p = pointToData(x, rect.height / 2);
    const focusGlobal = p?.globalIndex ?? view.s + Math.floor(barsPerScreen / 2);

    const dir = e.deltaY > 0 ? 1 : -1;
    const next = clamp(barsPerScreen + dir * 20, 40, 900);
    const ratio = (focusGlobal - startIndex) / Math.max(1, barsPerScreen);
    const nextStart = Math.round(focusGlobal - ratio * next);
    setBarsPerScreen(next);
    setStartIndex(clamp(nextStart, 0, Math.max(0, candles.length - next)));
  }

  useEffect(() => {
    const el = tooltipRef.current;
    if (!el) return;
    if (!hover || !candles[hover.i]) {
      el.style.opacity = "0";
      return;
    }
    const c = candles[hover.i];
    el.style.opacity = "1";
    el.innerHTML = `
      <div style="font-weight:900; letter-spacing:0.02em;">${symbol} <span style="opacity:.7;">${tf}</span></div>
      <div style="opacity:.75; margin-top:4px;">${formatTime(c.time)}</div>
      <div style="margin-top:8px; display:grid; grid-template-columns:auto auto; gap:6px 10px;">
        <div style="opacity:.7;">O</div><div class="mono">${c.open}</div>
        <div style="opacity:.7;">H</div><div class="mono">${c.high}</div>
        <div style="opacity:.7;">L</div><div class="mono">${c.low}</div>
        <div style="opacity:.7;">C</div><div class="mono">${c.close}</div>
        <div style="opacity:.7;">V</div><div class="mono">${c.volume}</div>
      </div>
      <div style="opacity:.7; margin-top:8px;">Pan: drag | Zoom: mouse wheel | Draw: pick a tool then click</div>
    `;
  }, [hover, candles, symbol, tf]);

  return (
    <div className="tvWrap">
      <div className="tvToolbar">
        <div className="tvLeft">
          <div className="tvSym mono">{symbol}</div>
          <div className="tvBtnRow">
            {(["1m", "5m", "15m", "30m", "1h", "4h", "1D", "1W", "1M"] as Timeframe[]).map((t) => (
              <button
                key={t}
                type="button"
                className={`tvBtn ${tf === t ? "tvBtnOn" : ""}`}
                onClick={() => setTf(t)}
                disabled={busy}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        <div className="tvRight">
          <label className="tvSelect">
            <span className="muted">Type</span>
            <select value={chartType} onChange={(e) => setChartType(e.target.value as ChartType)}>
              {(["Candlestick", "Hollow Candles", "Bar", "Line", "Area"] as ChartType[]).map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>

          <label className="tvSelect">
            <span className="muted">Tool</span>
            <select value={tool} onChange={(e) => setTool(e.target.value as Tool)}>
              {(["Cursor", "Trendline", "H-Line", "Fib"] as Tool[]).map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>

          <div className="tvToggles">
            <button
              type="button"
              className={`tvPill ${autoScale ? "tvPillOn" : ""}`}
              onClick={() => setAutoScale((v) => !v)}
            >
              Auto
            </button>
            <button
              type="button"
              className={`tvPill ${logScale ? "tvPillOn" : ""}`}
              onClick={() => setLogScale((v) => !v)}
            >
              Log
            </button>
          </div>

          <details className="tvIndicators">
            <summary className="tvPill">Indicators</summary>
            <div className="tvMenu">
              {([
                ["volume", "Volume"],
                ["ema20", "EMA 20"],
                ["ema50", "EMA 50"],
                ["sma20", "SMA 20"],
                ["bbands", "Bollinger (20,2)"],
                ["rsi", "RSI (14)"],
                ["macd", "MACD (12,26,9)"]
              ] as Array<[keyof IndicatorState, string]>).map(([k, label]) => (
                <label key={k} className="tvMenuRow">
                  <input
                    type="checkbox"
                    checked={ind[k]}
                    onChange={(e) => setInd((prev) => ({ ...prev, [k]: e.target.checked }))}
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
          </details>
        </div>
      </div>

      {err ? <div className="pairsError">Chart error: {err}</div> : null}

      <div
        className="tvHost"
        ref={hostRef}
        style={typeof heightPx === "number" ? { height: `${Math.max(420, Math.floor(heightPx))}px` } : undefined}
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onWheel={onWheel}
        role="application"
        aria-label="Interactive trading chart"
      >
        <canvas ref={canvasRef} />
        <div className="tvTooltip" ref={tooltipRef} />
      </div>
    </div>
  );
}
