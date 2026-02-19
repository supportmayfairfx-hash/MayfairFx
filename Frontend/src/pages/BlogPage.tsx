import { useEffect, useMemo, useRef, useState, type TouchEvent } from "react";
import { pickTradingQuote } from "../data/tradingQuotes";
import Notice from "../components/Notice";
import Skeleton from "../components/Skeleton";

type BlogItem = {
  id: string;
  title: string;
  caption: string;
  imageSrc: string;
  tag: string;
  date: string;
  stamp?: string;
  ms?: number;
};

type PhotoItem = { name: string; url: string; uploadedMs?: number; mtimeMs?: number };

function apiBase(): string {
  const envBase = (import.meta as any)?.env?.VITE_API_BASE;
  if (typeof envBase === "string" && envBase.trim()) return envBase.trim().replace(/\/+$/, "");
  if (typeof window !== "undefined") {
    const host = window.location.hostname.toLowerCase();
    const isDevVite = window.location.hostname === "localhost" && window.location.port === "5173";
    if (isDevVite) return "http://localhost:8787";
    if (host.endsWith(".vercel.app")) return "https://investment-backend-9nxb.onrender.com";
  }
  return "";
}

function apiUrl(path: string): string {
  const base = apiBase();
  if (!base) return path;
  return `${base}${path.startsWith("/") ? "" : "/"}${path}`;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(apiUrl(path), { method: "GET", headers: { Accept: "application/json" } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`);
  return j as T;
}

function fmtDate(ms?: number): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "New";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "New";
  return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "2-digit" }).format(d);
}

const fallbackItems: BlogItem[] = [
  {
    id: "xau-session",
    title: "XAUUSD Session Notes",
    caption: "A quick recap of the range, key levels, and how to avoid chasing candles during volatility.",
    imageSrc: "/blog/xau-session.svg",
    tag: "Gold",
    date: "Update"
  },
  {
    id: "risk-checklist",
    title: "Risk Management Checklist",
    caption: "Before you place a trade: position sizing, stop placement, and what to do when the market spikes.",
    imageSrc: "/blog/risk-checklist.svg",
    tag: "Risk",
    date: "Guide"
  },
  {
    id: "candles-101",
    title: "Candles 101",
    caption: "How to read structure: impulse, pullback, and why wicks matter when liquidity is thin.",
    imageSrc: "/blog/candles-101.svg",
    tag: "Basics",
    date: "Lesson"
  }
];

export default function BlogPage() {
  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTRef = useRef<number | null>(null);
  const lastActiveRef = useRef<HTMLElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    let alive = true;
    let lastSig = "";
    let lastCount = 0;

    async function refresh() {
      try {
        setError(null);
        const r = await getJson<{ items: PhotoItem[] }>("/api/photos");
        const items = Array.isArray(r.items) ? r.items : [];
        const sig = items.map((x) => `${x.name}:${x.uploadedMs ?? x.mtimeMs ?? ""}`).join("|");
        if (alive && sig !== lastSig) {
          lastSig = sig;
          setPhotos(items);
          if (lastCount > 0 && items.length > lastCount) {
            setToast(`New win added (${items.length - lastCount})`);
            if (toastTRef.current) window.clearTimeout(toastTRef.current);
            toastTRef.current = window.setTimeout(() => setToast(null), 2400);
          }
          lastCount = items.length;
        }
        setLoadedOnce(true);
      } catch (e: any) {
        if (!alive) return;
        setError(typeof e?.message === "string" ? e.message : "Failed");
        setLoadedOnce(true);
      }
    }

    // Initial load + polling so new uploads appear without refresh.
    refresh();
    const t = window.setInterval(refresh, 8000);

    // Refresh when returning to the tab.
    const onVis = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      alive = false;
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
      if (toastTRef.current) window.clearTimeout(toastTRef.current);
    };
  }, [reloadKey]);

  const items = useMemo((): BlogItem[] => {
    if (!photos.length) return fallbackItems;
    const sorted = [...photos].sort(
      (a, b) =>
        (b.uploadedMs ?? b.mtimeMs ?? 0) - (a.uploadedMs ?? a.mtimeMs ?? 0) ||
        String(a.name).localeCompare(String(b.name))
    );
    return sorted.map((p, idx) => {
      const ext = p.name.toLowerCase().slice(Math.max(0, p.name.lastIndexOf(".")));
      const tag = ext === ".jpg" || ext === ".jpeg" || ext === ".png" || ext === ".webp" ? "Photo" : "Media";
      const winN = idx + 1;
      const quote = pickTradingQuote(p.name);
      const ms = p.uploadedMs ?? p.mtimeMs;
      return {
        id: `photo-${idx}-${p.name}`,
        title: `Win ${winN}`,
        caption: quote,
        imageSrc: apiUrl(p.url),
        tag,
        date: fmtDate(ms),
        stamp: typeof ms === "number" ? new Date(ms).toISOString() : "",
        ms: typeof ms === "number" && Number.isFinite(ms) ? ms : undefined
      };
    });
  }, [photos]);

  const usingUploads = photos.length > 0;
  const selected = openIdx != null ? items[openIdx] : null;

  function openAt(idx: number) {
    lastActiveRef.current = (document.activeElement as HTMLElement) || null;
    setOpenIdx(idx);
  }

  function close() {
    setOpenIdx(null);
  }

  function next() {
    if (openIdx == null) return;
    setOpenIdx((i) => {
      const cur = typeof i === "number" ? i : 0;
      return (cur + 1) % items.length;
    });
  }

  function prev() {
    if (openIdx == null) return;
    setOpenIdx((i) => {
      const cur = typeof i === "number" ? i : 0;
      return (cur - 1 + items.length) % items.length;
    });
  }

  async function copyLink() {
    if (!selected) return;
    try {
      await navigator.clipboard.writeText(selected.imageSrc);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1100);
    } catch {
      // Ignore; clipboard permissions can be blocked in some environments.
    }
  }

  // Lightbox behavior: lock scroll, keyboard navigation, focus management.
  useEffect(() => {
    if (openIdx == null) return;

    setCopied(false);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // Focus close button for keyboard users.
    const t = window.setTimeout(() => closeBtnRef.current?.focus(), 0);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      if (e.key === "ArrowRight") next();
      if (e.key === "ArrowLeft") prev();
    };
    window.addEventListener("keydown", onKey);

    return () => {
      window.clearTimeout(t);
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      // Restore focus to the element that opened the lightbox.
      lastActiveRef.current?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openIdx, items.length]);

  // Basic swipe for mobile.
  const swipeRef = useRef<{ x: number; y: number; t: number } | null>(null);
  function onTouchStart(e: TouchEvent) {
    const p = e.touches?.[0];
    if (!p) return;
    swipeRef.current = { x: p.clientX, y: p.clientY, t: Date.now() };
  }
  function onTouchEnd(e: TouchEvent) {
    const start = swipeRef.current;
    swipeRef.current = null;
    if (!start) return;
    const p = e.changedTouches?.[0];
    if (!p) return;
    const dx = p.clientX - start.x;
    const dy = p.clientY - start.y;
    const dt = Date.now() - start.t;
    if (dt > 900) return;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    if (dx < 0) next();
    else prev();
  }

  const [view, setView] = useState<"grid" | "list">("grid");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"newest" | "oldest">("newest");

  const filteredIdxs = useMemo(() => {
    if (!usingUploads) return items.map((_it, i) => i);
    const qq = q.trim().toLowerCase();
    const idxs: number[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!qq) {
        idxs.push(i);
        continue;
      }
      const hay = `${it.title} ${it.caption}`.toLowerCase();
      if (hay.includes(qq)) idxs.push(i);
    }

    idxs.sort((a, b) => {
      const am = items[a]?.ms ?? 0;
      const bm = items[b]?.ms ?? 0;
      return sort === "newest" ? bm - am : am - bm;
    });
    return idxs;
  }, [usingUploads, items, photos, q, sort]);

  return (
    <>
      <div className="blogPage">
        <section className="pageHero blogHero">
        <div>
          <div className="eyebrow">Blog</div>
          <h1 className="pageTitle">Insights, Recaps, and Guides</h1>
          <p className="pageLead">
            Stay updated with wins, recaps, and trading notes.
          </p>
        </div>
        <div className="pageHeroActions">
          <div className="chip" title="Live gallery updates">
            <span className="dot" />
            <span className="mono">{usingUploads ? "Live Gallery" : "Insights"}</span>
          </div>
          <div className="chip" title="Total items shown">
            <span className="mono">{items.length}</span>
            <span className="muted">items</span>
          </div>
        </div>
        </section>

        {error ? (
          <Notice
            tone="warn"
            title="Gallery is temporarily unavailable"
            actions={
              <button className="mini" type="button" onClick={() => setReloadKey((k) => k + 1)}>
                Retry
              </button>
            }
          >
            Try again in a moment.
          </Notice>
        ) : null}

        {usingUploads ? (
          <section className="galleryBar" aria-label="Gallery controls">
            <div className="galleryLeft">
              <div className="gallerySearch">
                <i className="fa-solid fa-magnifying-glass" aria-hidden="true" />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search wins or quotes..."
                  aria-label="Search"
                />
              </div>
            </div>

            <div className="galleryRight">
              <div className="viewTog" role="group" aria-label="View mode">
                <button type="button" className={`vBtn ${view === "grid" ? "on" : ""}`} onClick={() => setView("grid")}>
                  <i className="fa-solid fa-border-all" aria-hidden="true" /> Grid
                </button>
                <button type="button" className={`vBtn ${view === "list" ? "on" : ""}`} onClick={() => setView("list")}>
                  <i className="fa-solid fa-list" aria-hidden="true" /> List
                </button>
              </div>
              <div className="viewTog" role="group" aria-label="Sort">
                <button type="button" className={`vBtn ${sort === "newest" ? "on" : ""}`} onClick={() => setSort("newest")}>
                  <i className="fa-solid fa-arrow-down-wide-short" aria-hidden="true" /> Newest
                </button>
                <button type="button" className={`vBtn ${sort === "oldest" ? "on" : ""}`} onClick={() => setSort("oldest")}>
                  <i className="fa-solid fa-arrow-up-wide-short" aria-hidden="true" /> Oldest
                </button>
              </div>
            </div>
          </section>
        ) : null}

        <section className={`blogGrid ${view}`} aria-label="Blog posts">
          {!loadedOnce ? (
            Array.from({ length: 9 }).map((_, i) => (
              <article className="blogCard" key={`sk-blog-${i}`}>
                <div className="blogMedia">
                  <div style={{ padding: 0 }}>
                    <Skeleton style={{ height: 210, width: "100%", borderRadius: 0 }} />
                  </div>
                </div>
                <div className="blogBody" style={{ display: "grid", gap: 8 }}>
                  <Skeleton style={{ height: 14, width: "55%", borderRadius: 999 }} />
                  <Skeleton style={{ height: 12, width: "90%", borderRadius: 999 }} />
                  <Skeleton style={{ height: 12, width: "82%", borderRadius: 999 }} />
                </div>
              </article>
            ))
          ) : (
            (usingUploads ? filteredIdxs : items.map((_it, i) => i)).map((idx) => {
              const it = items[idx];
              return (
                <article className={`blogCard`} key={it.id}>
                  <div className="blogMedia">
                    <button type="button" className="blogMediaBtn" onClick={() => openAt(idx)} aria-label={`Open ${it.title} in gallery`}>
                      <img src={it.imageSrc} alt={it.title} loading="lazy" />
                      <div className="winOverlay" aria-hidden="true">
                        <div className="winLeft">
                          <div className="winTitle">{it.title}</div>
                          <div className="winCaption">{it.caption}</div>
                        </div>
                        <div className="winRight">
                          <span className="pill">{it.date}</span>
                        </div>
                      </div>
                      <div className="blogHover">
                        <div className="blogHoverInner">
                          <span className="blogHoverIcon" aria-hidden="true">
                            <i className="fa-solid fa-up-right-and-down-left-from-center" />
                          </span>
                          <span className="blogHoverText">Open</span>
                        </div>
                      </div>
                    </button>
                    <div className="blogTagRow">
                      <span className="pill">{it.tag}</span>
                      <span className="pill">{it.date}</span>
                    </div>
                  </div>
                  <div className="blogBody">
                    <div className="panelTitle">{it.title}</div>
                    <div className="panelSub">{it.caption}</div>
                  </div>
                </article>
              );
            })
          )}
        </section>

      {selected ? (
        <div
          className="lightbox"
          role="dialog"
          aria-modal="true"
          aria-label="Gallery viewer"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) close();
          }}
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
        >
          <div className="lightboxPanel">
            <div className="lightboxTop">
              <div className="lightboxMeta">
                <div className="pill">{selected.title}</div>
                <div className="pill">{selected.date}</div>
              </div>
              <div className="lightboxActions">
                <a
                  className="iconBtn"
                  href={selected.imageSrc}
                  target="_blank"
                  rel="noreferrer"
                  title="Open original"
                  aria-label="Open original"
                >
                  <i className="fa-solid fa-arrow-up-right-from-square" />
                </a>
                <button className="iconBtn" type="button" onClick={copyLink} title="Copy link" aria-label="Copy link">
                  <i className={`fa-solid ${copied ? "fa-check" : "fa-link"}`} />
                </button>
                <a className="iconBtn" href={selected.imageSrc} download title="Download" aria-label="Download">
                  <i className="fa-solid fa-download" />
                </a>
                <button className="iconBtn" type="button" onClick={close} ref={closeBtnRef} aria-label="Close">
                  <i className="fa-solid fa-xmark" />
                </button>
              </div>
            </div>

            <div className="lightboxStage">
              <button className="lightboxNav prev" type="button" onClick={prev} aria-label="Previous">
                <i className="fa-solid fa-chevron-left" />
              </button>

              <div className="lightboxMedia">
                <img src={selected.imageSrc} alt={selected.title} draggable={false} />
              </div>

              <button className="lightboxNav next" type="button" onClick={next} aria-label="Next">
                <i className="fa-solid fa-chevron-right" />
              </button>
            </div>

            <div className="lightboxBottom">
              <div className="lightboxCap">
                <div className="panelTitle">{selected.title}</div>
                <div className="panelSub">{selected.caption}</div>
              </div>
              <div className="mono lightboxCount">
                {openIdx! + 1} / {items.length}
              </div>
            </div>
          </div>
        </div>
      ) : null}
      {toast ? (
        <div className="toast" role="status" aria-live="polite" onClick={() => setToast(null)}>
          <i className="fa-solid fa-bolt" aria-hidden="true" />
          <span>{toast}</span>
        </div>
      ) : null}
      </div>
    </>
  );
}
