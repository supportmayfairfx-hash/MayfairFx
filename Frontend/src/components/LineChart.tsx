import { useEffect, useMemo, useRef } from "react";

export type ChartPoint = { t: number; v: number };

export type ChartOverlay = {
  points: ChartPoint[];
  stroke?: string;
  lineWidth?: number;
  dashed?: boolean;
};

type Props = {
  points: ChartPoint[];
  overlays?: ChartOverlay[];
  height?: number;
  stroke?: string;
  fill?: string;
  grid?: boolean;
  yLabel?: string;
  xLabel?: string;
  xMinLabel?: string;
  xMaxLabel?: string;
};

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

export default function LineChart({
  points,
  overlays = [],
  height = 220,
  stroke = "rgba(79, 227, 194, 0.95)",
  fill = "rgba(79, 227, 194, 0.10)",
  grid = true,
  yLabel,
  xLabel,
  xMinLabel,
  xMaxLabel
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastDrawnRef = useRef<number>(0);

  const stats = useMemo(() => {
    const series: ChartPoint[][] = [points, ...overlays.map((o) => o.points)];
    let min = Infinity;
    let max = -Infinity;
    for (const s of series) {
      for (const p of s) {
        if (!Number.isFinite(p.v)) continue;
        if (p.v < min) min = p.v;
        if (p.v > max) max = p.v;
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 };
    if (min === max) {
      // Avoid a flatline that breaks scaling.
      min -= 1;
      max += 1;
    }
    const pad = (max - min) * 0.12;
    return { min: min - pad, max: max + pad };
  }, [points, overlays]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = Math.max(1, Math.floor(w * dpr));
    canvas.height = Math.max(1, Math.floor(h * dpr));

    const ctx0 = canvas.getContext("2d");
    if (!ctx0) return;
    const ctx = ctx0;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const hasGaps = points.some((p) => !Number.isFinite(p.v));

    const xAt = (idx: number, len: number, left: number, width: number) =>
      left + (idx / Math.max(1, len - 1)) * width;

    const yAt = (v: number, top: number, heightPx: number) => {
      const r = (v - stats.min) / (stats.max - stats.min);
      return top + (1 - clamp(r, 0, 1)) * heightPx;
    };

    function drawLine(
      pts: ChartPoint[],
      strokeStyle: string,
      lineWidth: number,
      dashed: boolean,
      left: number,
      top: number,
      width: number,
      heightPx: number
    ) {
      const len = pts.length;
      if (len < 2) return;

      ctx.save();
      ctx.strokeStyle = strokeStyle;
      ctx.lineWidth = lineWidth;
      if (dashed) ctx.setLineDash([6, 6]);
      else ctx.setLineDash([]);

      let started = false;
      ctx.beginPath();
      for (let i = 0; i < len; i++) {
        const v = pts[i].v;
        if (!Number.isFinite(v)) {
          started = false;
          continue;
        }
        const x = xAt(i, len, left, width);
        const y = yAt(v, top, heightPx);
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

    const draw = (ts: number) => {
      // Keep it light: draw at most ~30fps.
      if (ts - lastDrawnRef.current < 32) {
        requestAnimationFrame(draw);
        return;
      }
      lastDrawnRef.current = ts;

      ctx.clearRect(0, 0, w, h);

      const padX = 10;
      const padY = 10;
      const axisPadBottom = xMinLabel || xMaxLabel || xLabel ? 22 : 0;
      const left = padX;
      const top = padY;
      const right = w - padX;
      const bottom = h - padY - axisPadBottom;
      const width = right - left;
      const heightPx = bottom - top;

      if (grid) {
        ctx.strokeStyle = "rgba(231, 238, 252, 0.10)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 1; i <= 3; i++) {
          const y = top + (heightPx * i) / 4;
          ctx.moveTo(left, y);
          ctx.lineTo(right, y);
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

      if (!points.length) return;

      // Overlays (e.g. target line)
      for (const o of overlays) {
        drawLine(
          o.points,
          o.stroke || "rgba(231, 238, 252, 0.35)",
          o.lineWidth || 2,
          !!o.dashed,
          left,
          top,
          width,
          heightPx
        );
      }

      const len = points.length;

      if (!hasGaps) {
        // Path
        ctx.beginPath();
        for (let i = 0; i < len; i++) {
          const x = xAt(i, len, left, width);
          const y = yAt(points[i].v, top, heightPx);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }

        // Fill
        ctx.lineTo(xAt(len - 1, len, left, width), bottom);
        ctx.lineTo(xAt(0, len, left, width), bottom);
        ctx.closePath();

        ctx.fillStyle = fill;
        ctx.fill();
      }

      // Stroke (handles gaps)
      drawLine(points, stroke, 2, false, left, top, width, heightPx);

      // Glowing head dot (last finite point)
      let lastIdx = -1;
      for (let i = len - 1; i >= 0; i--) {
        if (Number.isFinite(points[i].v)) {
          lastIdx = i;
          break;
        }
      }
      if (lastIdx >= 0) {
        const last = points[lastIdx];
        const lx = xAt(lastIdx, len, left, width);
        const ly = yAt(last.v, top, heightPx);
        ctx.beginPath();
        ctx.arc(lx, ly, 4, 0, Math.PI * 2);
        ctx.fillStyle = stroke;
        ctx.fill();

        ctx.beginPath();
        ctx.arc(lx, ly, 10, 0, Math.PI * 2);
        ctx.fillStyle = stroke.includes("0.95") ? stroke.replace("0.95", "0.10") : "rgba(231, 238, 252, 0.10)";
        ctx.fill();
      }

      requestAnimationFrame(draw);
    };

    const id = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(id);
  }, [points, overlays, stats.min, stats.max, stroke, fill, grid, yLabel, xLabel, xMinLabel, xMaxLabel]);

  return <canvas className="lineChart" ref={canvasRef} style={{ height }} />;
}
