import { useEffect, useMemo, useRef } from "react";

export type Candle = { t: number; o: number; h: number; l: number; c: number };

export type LineOverlay = {
  points: Array<{ t: number; v: number }>;
  stroke?: string;
  lineWidth?: number;
  dashed?: boolean;
};

type Props = {
  candles: Candle[];
  overlays?: LineOverlay[];
  maxCandles?: number;
  height?: number;
  grid?: boolean;
  yLabel?: string;
  xLabel?: string;
  xMinLabel?: string;
  xMaxLabel?: string;
  showPriceScale?: boolean;
  showLastPrice?: boolean;
};

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

export default function CandlesChart({
  candles,
  overlays = [],
  maxCandles = 200,
  height = 420,
  grid = true,
  yLabel,
  xLabel,
  xMinLabel,
  xMaxLabel,
  showPriceScale = true,
  showLastPrice = true
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastDrawnRef = useRef<number>(0);

  const stats = useMemo(() => {
    const view = maxCandles > 0 ? candles.slice(Math.max(0, candles.length - maxCandles)) : candles;
    let min = Infinity;
    let max = -Infinity;
    for (const c of view) {
      if (!Number.isFinite(c.l) || !Number.isFinite(c.h)) continue;
      if (c.l < min) min = c.l;
      if (c.h > max) max = c.h;
    }
    for (const o of overlays) {
      // If overlay matches candle count, slice to the same viewport.
      const pts =
        o.points.length === candles.length && view.length <= candles.length
          ? o.points.slice(o.points.length - view.length)
          : o.points;
      for (const p of pts) {
        if (!Number.isFinite(p.v)) continue;
        if (p.v < min) min = p.v;
        if (p.v > max) max = p.v;
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return { min: 0, max: 1 };
    const pad = (max - min) * 0.12;
    return { min: min - pad, max: max + pad };
  }, [candles, overlays, maxCandles]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = Math.max(1, Math.floor(w * dpr));
    canvas.height = Math.max(1, Math.floor(h * dpr));

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const draw = (ts: number) => {
      if (ts - lastDrawnRef.current < 32) {
        requestAnimationFrame(draw);
        return;
      }
      lastDrawnRef.current = ts;

      ctx.clearRect(0, 0, w, h);

      const padX = 12;
      const padY = 12;
      const axisPadBottom = xMinLabel || xMaxLabel || xLabel ? 26 : 0;
      const axisPadRight = showPriceScale ? 56 : 0;
      const left = padX;
      const top = padY;
      const right = w - padX - axisPadRight;
      const bottom = h - padY - axisPadBottom;
      const width = right - left;
      const heightPx = bottom - top;

      if (grid) {
        ctx.strokeStyle = "rgba(231, 238, 252, 0.10)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 1; i <= 4; i++) {
          const y = top + (heightPx * i) / 5;
          ctx.moveTo(left, y);
          ctx.lineTo(right, y);
        }
        for (let i = 1; i <= 5; i++) {
          const x = left + (width * i) / 6;
          ctx.moveTo(x, top);
          ctx.lineTo(x, bottom);
        }
        ctx.stroke();
      }

      if (yLabel) {
        ctx.fillStyle = "rgba(231, 238, 252, 0.55)";
        ctx.font = "12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial";
        ctx.fillText(yLabel, left, top + 12);
      }

      if (xLabel || xMinLabel || xMaxLabel) {
        ctx.fillStyle = "rgba(231, 238, 252, 0.55)";
        ctx.font = "12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial";
        const y = h - padY;
        if (xLabel) ctx.fillText(xLabel, left, y);
        if (xMinLabel) ctx.fillText(xMinLabel, left, y - 12);
        if (xMaxLabel) {
          const m = ctx.measureText(xMaxLabel);
          ctx.fillText(xMaxLabel, Math.max(left, right - m.width), y - 12);
        }
      }

      const view = maxCandles > 0 ? candles.slice(Math.max(0, candles.length - maxCandles)) : candles;

      if (!view.length) {
        requestAnimationFrame(draw);
        return;
      }

      const yAt = (v: number) => {
        const r = (v - stats.min) / (stats.max - stats.min);
        return top + (1 - clamp(r, 0, 1)) * heightPx;
      };

      // Candle layout
      const n = view.length;
      const step = width / Math.max(1, n);
      // Allow many candles like TradingView (thin at high counts, thicker when fewer candles).
      const bodyW = Math.max(1, Math.min(14, step * 0.75));

      // Candles
      const upBody = "rgba(0, 200, 83, 0.98)"; // TradingView-ish green
      const downBody = "rgba(239, 83, 80, 0.98)"; // TradingView-ish red
      const upWick = "rgba(0, 200, 83, 0.65)";
      const downWick = "rgba(239, 83, 80, 0.65)";

      for (let i = 0; i < n; i++) {
        const c = view[i];
        const x = left + i * step + step / 2;
        const up = c.c >= c.o;
        const wickCol = up ? upWick : downWick;
        const bodyCol = up ? upBody : downBody;
        const oY = yAt(c.o);
        const cY = yAt(c.c);
        const hY = yAt(c.h);
        const lY = yAt(c.l);

        // Wick
        ctx.strokeStyle = wickCol;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(x, hY);
        ctx.lineTo(x, lY);
        ctx.stroke();

        // Body
        const yTop = Math.min(oY, cY);
        const yBot = Math.max(oY, cY);
        const bodyH = Math.max(3, yBot - yTop);
        ctx.fillStyle = bodyCol;
        ctx.fillRect(x - bodyW / 2, yTop, bodyW, bodyH);

        // Subtle outline (helps on dark background)
        ctx.strokeStyle = "rgba(11, 18, 32, 0.85)";
        ctx.lineWidth = 1;
        ctx.strokeRect(x - bodyW / 2, yTop, bodyW, bodyH);
      }

      // Overlays on top (closer to TradingView)
      for (const o of overlays) {
        const pts =
          o.points.length === candles.length && view.length <= candles.length
            ? o.points.slice(o.points.length - view.length)
            : o.points.filter((p) => p.t >= view[0].t && p.t <= view[view.length - 1].t);
        if (pts.length < 2) continue;
        ctx.save();
        ctx.strokeStyle = o.stroke || "rgba(231, 238, 252, 0.35)";
        ctx.lineWidth = o.lineWidth || 2;
        if (o.dashed) ctx.setLineDash([6, 6]);
        else ctx.setLineDash([]);
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < pts.length; i++) {
          if (!Number.isFinite(pts[i].v)) {
            started = false;
            continue;
          }
          const x = left + (i / Math.max(1, pts.length - 1)) * width;
          const y = yAt(pts[i].v);
          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else {
            ctx.lineTo(x, y);
          }
        }
        ctx.stroke();
        ctx.restore();
      }

      // Price scale (right side)
      if (showPriceScale) {
        ctx.fillStyle = "rgba(231, 238, 252, 0.55)";
        ctx.font = "12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        const ticks = 5;
        for (let i = 0; i <= ticks; i++) {
          const v = stats.min + ((stats.max - stats.min) * i) / ticks;
          const y = yAt(v);
          const label = v >= 100 ? v.toFixed(2) : v >= 1 ? v.toFixed(4) : v.toFixed(6);
          ctx.fillText(label, right + 10, y);
        }

        if (showLastPrice) {
          const last = view[view.length - 1];
          const lastPx = last.c;
          const up = last.c >= last.o;
          const y = yAt(lastPx);
          const label = lastPx >= 100 ? lastPx.toFixed(2) : lastPx >= 1 ? lastPx.toFixed(4) : lastPx.toFixed(6);
          const boxW = 52;
          const boxH = 18;
          ctx.fillStyle = up ? "rgba(0, 200, 83, 0.92)" : "rgba(239, 83, 80, 0.92)";
          ctx.fillRect(right + 4, y - boxH / 2, boxW, boxH);
          ctx.fillStyle = "rgba(11, 18, 32, 0.95)";
          ctx.textAlign = "left";
          ctx.textBaseline = "middle";
          ctx.fillText(label, right + 8, y);
        }
      }

      requestAnimationFrame(draw);
    };

    const id = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(id);
  }, [
    candles,
    overlays,
    maxCandles,
    stats.min,
    stats.max,
    height,
    grid,
    yLabel,
    xLabel,
    xMinLabel,
    xMaxLabel,
    showPriceScale,
    showLastPrice
  ]);

  return <canvas className="candleChart" ref={canvasRef} style={{ height }} />;
}
