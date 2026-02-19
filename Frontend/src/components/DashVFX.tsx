import { useEffect, useRef } from "react";

type Props = {
  className?: string;
  tone?: "cool" | "profit" | "risk";
};

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

// Lightweight canvas VFX: grid + particles + soft orb glow.
// No external deps (Three.js install isn't available in this environment).
export default function DashVFX({ className, tone = "cool" }: Props) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number>(0);
  const stoppedRef = useRef(false);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;

    const ro = new ResizeObserver(() => {
      const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
      const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
    });
    ro.observe(canvas);

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduce = prefersReducedMotion();

    const particles = Array.from({ length: 46 }, () => ({
      x: Math.random(),
      y: Math.random(),
      r: 0.6 + Math.random() * 1.8,
      s: 0.12 + Math.random() * 0.55,
      a: 0.18 + Math.random() * 0.42
    }));

    const palette =
      tone === "profit"
        ? { a: "rgba(52,211,153,", b: "rgba(96,165,250," }
        : tone === "risk"
          ? { a: "rgba(255,95,122,", b: "rgba(255,206,84," }
          : { a: "rgba(96,165,250,", b: "rgba(52,211,153," };

    const draw = (ts: number) => {
      if (stoppedRef.current) return;
      const w = canvas.width;
      const h = canvas.height;
      if (!w || !h) {
        rafRef.current = requestAnimationFrame(draw);
        return;
      }

      // Scale into CSS pixels for line widths.
      const dpr = w / Math.max(1, canvas.clientWidth);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = "source-over";

      // Base tint
      ctx.fillStyle = "rgba(11,18,32,0.35)";
      ctx.fillRect(0, 0, w, h);

      // Soft orb glow
      const cx = w * 0.72;
      const cy = h * 0.38;
      const orb = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * 0.55);
      orb.addColorStop(0, `${palette.a}0.28)`);
      orb.addColorStop(0.38, `${palette.b}0.12)`);
      orb.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = orb;
      ctx.fillRect(0, 0, w, h);

      // Grid
      ctx.strokeStyle = "rgba(231,238,252,0.06)";
      ctx.lineWidth = 1 * dpr;
      const step = 56 * dpr;
      const ox = ((ts / 70) % step) * (reduce ? 0 : 1);
      const oy = ((ts / 95) % step) * (reduce ? 0 : 1);
      ctx.beginPath();
      for (let x = -step + ox; x < w + step; x += step) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
      }
      for (let y = -step + oy; y < h + step; y += step) {
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
      }
      ctx.stroke();

      // Particles
      const t = reduce ? 0 : ts / 1000;
      for (const p of particles) {
        const driftX = Math.sin(t * p.s + p.y * 8) * 0.012;
        const driftY = Math.cos(t * (p.s * 0.9) + p.x * 7) * 0.012;
        const x = clamp((p.x + driftX) * w, 0, w);
        const y = clamp((p.y + driftY) * h, 0, h);
        ctx.beginPath();
        ctx.arc(x, y, p.r * dpr, 0, Math.PI * 2);
        ctx.fillStyle = `${palette.b}${p.a})`;
        ctx.fill();
      }

      // Light streak (subtle)
      ctx.globalCompositeOperation = "screen";
      const streak = ctx.createLinearGradient(w * 0.1, h * 0.2, w * 0.9, h * 0.9);
      streak.addColorStop(0, "rgba(255,255,255,0)");
      streak.addColorStop(0.5, "rgba(255,255,255,0.06)");
      streak.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = streak;
      ctx.save();
      ctx.translate(w * 0.5, h * 0.5);
      ctx.rotate((reduce ? 0 : ts / 11000) % (Math.PI * 2));
      ctx.translate(-w * 0.5, -h * 0.5);
      ctx.fillRect(0, 0, w, h);
      ctx.restore();

      ctx.globalCompositeOperation = "source-over";
      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);

    const onVis = () => {
      // Pause when tab hidden.
      const hidden = typeof document !== "undefined" && document.hidden;
      stoppedRef.current = !!hidden;
      if (!hidden) rafRef.current = requestAnimationFrame(draw);
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      cancelAnimationFrame(rafRef.current);
    };
  }, [tone]);

  return <canvas ref={ref} className={className} aria-hidden="true" />;
}

