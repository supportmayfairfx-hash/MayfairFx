import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import ErrorBoundary from "./components/ErrorBoundary";
import Skeleton from "./components/Skeleton";

const DashboardPage = lazy(() => import("./pages/DashboardPage"));
const MarketsPage = lazy(() => import("./pages/MarketsPage"));
const PortfolioPage = lazy(() => import("./pages/PortfolioPage"));
const ProgressPage = lazy(() => import("./pages/ProgressPage"));
const ChartPage = lazy(() => import("./pages/ChartPage"));
const ContactPage = lazy(() => import("./pages/ContactPage"));
const BlogPage = lazy(() => import("./pages/BlogPage"));

type Page = "dashboard" | "markets" | "portfolio" | "progress" | "chart" | "blog" | "contact";
type MenuItem = { id: string; label: string; icon: string; href: string };
type AuthMe = { user: { id: string; email: string; first_name?: string | null; created_at: string } | null };
type NotificationItem = { id: string; title: string; body: string; ts: string; read: boolean };
type SearchResult = { id: string; type: string; title: string; href: string; relevance: number };
type ThemeMode = "light" | "dark" | "auto";
type ThemeResolved = "light" | "dark";
type SEOConfig = { title: string; description: string };

function parseHashPage(hash: string): Page {
  const h = (hash || "").replace(/^#/, "").trim().toLowerCase();
  if (h === "markets") return "markets";
  if (h === "portfolio") return "portfolio";
  if (h === "progress") return "progress";
  if (h === "chart" || h === "charts") return "chart";
  if (h === "blog") return "blog";
  if (h === "contact") return "contact";
  return "dashboard";
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

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" }
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`);
  return j as T;
}

async function sendJson<T>(method: "POST" | "PUT" | "DELETE", path: string, body?: any): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method,
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: body != null ? JSON.stringify(body) : undefined
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`);
  return j as T;
}

function initials(emailOrName: string): string {
  const s = String(emailOrName || "").trim();
  if (!s) return "--";
  const base = s.includes("@") ? s.split("@")[0] : s;
  const parts = base.split(/[._\s-]+/).filter(Boolean);
  const a = (parts[0] || base).slice(0, 1).toUpperCase();
  const b = (parts[1] || parts[0] || base).slice(1, 2).toUpperCase();
  return (a + b) || "--";
}

const SEO_BY_PAGE: Record<Page, SEOConfig> = {
  dashboard: {
    title: "Trade Fix Dashboard",
    description: "Live market intelligence, trading signals, and portfolio context in one command center."
  },
  markets: {
    title: "Trade Fix Markets",
    description: "Track crypto, FX, and precious metals with real-time charts and focused market views."
  },
  portfolio: {
    title: "Trade Fix Portfolio",
    description: "Manage portfolio access, account setup, and holdings snapshots with secure workflows."
  },
  progress: {
    title: "Trade Fix Progress",
    description: "Monitor account growth, milestones, and risk-adjusted performance analytics."
  },
  chart: {
    title: "Trade Fix Charts",
    description: "View chart tools, signals, and technical overlays built for fast trade decisions."
  },
  blog: {
    title: "Trade Fix Blog",
    description: "Read market updates, strategy notes, and latest wins from the Trade Fix team."
  },
  contact: {
    title: "Trade Fix Contact",
    description: "Contact Trade Fix support for onboarding, account setup, and urgent assistance."
  }
};

export default function App() {
  const [page, setPage] = useState<Page>(() => parseHashPage(window.location.hash));
  const [me, setMe] = useState<AuthMe["user"]>(null);
  const [menu, setMenu] = useState<MenuItem[]>([]);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [logoSrc, setLogoSrc] = useState("/brand/photo_2026-02-15_07-59-19.jpg");

  const [themeMode, setThemeMode] = useState<ThemeMode>("dark");
  const [themeResolved, setThemeResolved] = useState<ThemeResolved>("dark");

  const [notifOpen, setNotifOpen] = useState(false);
  const [notifs, setNotifs] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(0);

  const [searchQ, setSearchQ] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const searchTimerRef = useRef<number | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [statusTick, setStatusTick] = useState(0);

  const ribbonMessages = useMemo(
    () => [
      "Live data engine running",
      "Tax and withdrawal safety checks enabled",
      "Portfolio sync optimized",
      "24/7 support on Contact page"
    ],
    []
  );

  const track = (event: string, meta: Record<string, any> = {}) => {
    const payload = { event, meta: { ...meta, page, ts: Date.now() } };
    void sendJson("POST", "/api/analytics/track", payload).catch(() => {});
    try {
      (window as any).dataLayer = (window as any).dataLayer || [];
      (window as any).dataLayer.push(payload);
      const q = JSON.parse(localStorage.getItem("analytics_fallback_q") || "[]");
      q.push(payload);
      localStorage.setItem("analytics_fallback_q", JSON.stringify(q.slice(-120)));
    } catch {}
  };

  useEffect(() => {
    const onHash = () => setPage(parseHashPage(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll as any);
  }, []);

  useEffect(() => {
    return () => {
      if (searchTimerRef.current) window.clearTimeout(searchTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const t = window.setInterval(() => {
      setStatusTick((v) => v + 1);
    }, 4000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    let alive = true;
    const refreshMe = async () => {
      try {
        const r = await getJson<AuthMe>("/api/auth/me");
        if (!alive) return;
        setMe(r.user);
      } catch {
        if (!alive) return;
        setMe(null);
      }
    };
    void refreshMe();

    const onAuthChanged = () => {
      void refreshMe();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshMe();
    };
    window.addEventListener("auth:changed", onAuthChanged as EventListener);
    document.addEventListener("visibilitychange", onVisible);
    const t = window.setInterval(refreshMe, 30000);
    return () => {
      alive = false;
      window.clearInterval(t);
      window.removeEventListener("auth:changed", onAuthChanged as EventListener);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  useEffect(() => {
    getJson<{ items: MenuItem[] }>("/api/menu")
      .then((r) => setMenu(Array.isArray(r.items) ? r.items : []))
      .catch(() =>
        setMenu([
          { id: "home", label: "Home", icon: "fa-house", href: "#dashboard" },
          { id: "explore", label: "Explore", icon: "fa-compass", href: "#markets" },
          { id: "services", label: "Services", icon: "fa-briefcase", href: "#portfolio" },
          { id: "blog", label: "Blog", icon: "fa-newspaper", href: "#blog" },
          { id: "contact", label: "Contact", icon: "fa-envelope", href: "#contact" }
        ])
      );
  }, []);

  useEffect(() => {
    // Prefer the mode set by the inline index.html theme bootstrap (prevents FOUC).
    const d = document.documentElement;
    const modeAttr = d.getAttribute("data-theme-mode");
    const themeAttr = d.getAttribute("data-theme");
    let mode: ThemeMode | null =
      modeAttr === "light" || modeAttr === "dark" || modeAttr === "auto" ? (modeAttr as ThemeMode) : null;

    // If inline bootstrap didn't run (or localStorage isn't accessible), default to DARK.
    if (!mode) {
      try {
        const saved = localStorage.getItem("theme_mode") || localStorage.getItem("theme");
        if (saved === "light" || saved === "dark" || saved === "auto") mode = saved;
      } catch {}
    }
    const normalized: ThemeMode = mode === "light" || mode === "dark" || mode === "auto" ? mode : "dark";

    const resolvedFromAttr: ThemeResolved =
      themeAttr === "light" || themeAttr === "dark" ? (themeAttr as ThemeResolved) : resolveTheme(normalized);

    setThemeMode(normalized);
    setThemeResolved(resolvedFromAttr);

    // Ensure DOM reflects the chosen mode (covers cases where index.html script is blocked).
    d.setAttribute("data-theme-mode", normalized);
    d.setAttribute("data-theme", resolvedFromAttr);
  }, []);

  useEffect(() => {
    // If user has a server theme preference, apply it once (but keep localStorage as the primary source).
    if (!me?.id) return;
    getJson<{ user: { theme: ThemeMode | null } }>("/api/user/" + encodeURIComponent(me.id))
      .then((r) => {
        const t = r?.user?.theme;
        const hasLocal = !!(localStorage.getItem("theme_mode") || localStorage.getItem("theme"));
        // Default behavior: dark unless the user explicitly chose otherwise locally.
        // Don't auto-apply a "light" server pref over the dark default.
        if (!hasLocal && (t === "dark" || t === "auto")) {
          applyThemeMode(t, false);
        }
      })
      .catch(() => {});
  }, [me?.id]);

  useEffect(() => {
    // When in AUTO mode, resolve theme from system and react to system changes.
    if (typeof window === "undefined") return;
    const mql = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    if (!mql) return;
    const update = () => {
      if (themeMode !== "auto") return;
      const next: ThemeResolved = mql.matches ? "dark" : "light";
      setThemeResolved(next);
      document.documentElement.setAttribute("data-theme", next);
    };
    update();
    const handler = () => update();
    try {
      mql.addEventListener("change", handler);
      return () => mql.removeEventListener("change", handler);
    } catch {
      // Safari fallback
      mql.addListener(handler);
      return () => mql.removeListener(handler);
    }
  }, [themeMode]);

  useEffect(() => {
    // Poll notifications lightly when logged in.
    if (!me?.id) {
      setNotifs([]);
      setUnread(0);
      return;
    }
    let alive = true;
    const tick = async () => {
      try {
        const r = await getJson<{ items: NotificationItem[]; unreadCount: number }>(
          "/api/notifications/" + encodeURIComponent(me.id)
        );
        if (!alive) return;
        setNotifs(Array.isArray(r.items) ? r.items : []);
        setUnread(typeof r.unreadCount === "number" ? r.unreadCount : 0);
      } catch {
        if (!alive) return;
        setNotifs([]);
        setUnread(0);
      }
    };
    void tick();
    const t = window.setInterval(tick, 20000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [me?.id]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const el = e.target as any;
      const inNotif = el?.closest?.("[data-drop='notif']");
      const inSearch = el?.closest?.("[data-drop='search']");
      const inMobile = el?.closest?.("[data-drop='mobile']");
      const inProfile = el?.closest?.("[data-drop='profile']");
      if (!inNotif) setNotifOpen(false);
      if (!inSearch) setSearchOpen(false);
      if (!inMobile) setMobileOpen(false);
      if (!inProfile) setProfileOpen(false);
    };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setNotifOpen(false);
      setSearchOpen(false);
      setMobileOpen(false);
      setProfileOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const anchor = target?.closest?.("a") as HTMLAnchorElement | null;
      const button = target?.closest?.("button") as HTMLButtonElement | null;
      const href = anchor?.getAttribute("href") || "";
      const label = (anchor?.textContent || button?.textContent || "").trim().toLowerCase();

      if (!href && !label) return;
      if (href.includes("t.me") || label.includes("telegram")) {
        track("funnel_contact", { channel: "telegram", href });
        return;
      }
      if (href.includes("#portfolio") || label.includes("portfolio")) {
        track("funnel_portfolio_open", { href, label });
        return;
      }
      if (href.includes("#contact") || label.includes("contact") || label.includes("support")) {
        track("funnel_contact", { channel: "site", href, label });
        return;
      }
      if (href.includes("#blog") || label.includes("blog")) {
        track("funnel_blog_open", { href });
      }
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [page]);

  useEffect(() => {
    const seo = SEO_BY_PAGE[page];
    document.title = seo.title;

    const ensure = (name: string, attr: "name" | "property") => {
      let el = document.head.querySelector(`meta[${attr}="${name}"]`) as HTMLMetaElement | null;
      if (!el) {
        el = document.createElement("meta");
        el.setAttribute(attr, name);
        document.head.appendChild(el);
      }
      return el;
    };

    ensure("description", "name").setAttribute("content", seo.description);
    ensure("og:title", "property").setAttribute("content", seo.title);
    ensure("og:description", "property").setAttribute("content", seo.description);
    ensure("twitter:title", "name").setAttribute("content", seo.title);
    ensure("twitter:description", "name").setAttribute("content", seo.description);
  }, [page]);

  const content = useMemo(() => {
    const displayName = me?.first_name || "Guest";
    if (page === "markets") return <MarketsPage />;
    if (page === "portfolio") return <PortfolioPage />;
    if (page === "progress") return <ProgressPage />;
    if (page === "chart") return <ChartPage />;
    if (page === "blog") return <BlogPage />;
    if (page === "contact") return <ContactPage />;
    return <DashboardPage displayName={displayName} userId={me?.id || null} userCreatedAt={me?.created_at || null} />;
  }, [page, me?.first_name, me?.id]);

  const activeMenuId = useMemo(() => {
    if (page === "dashboard") return "home";
    if (page === "markets") return "explore";
    if (page === "portfolio" || page === "progress") return "services";
    if (page === "chart" || page === "blog") return "blog";
    if (page === "contact") return "contact";
    return "home";
  }, [page]);

  function resolveTheme(mode: ThemeMode): ThemeResolved {
    if (mode === "light" || mode === "dark") return mode;
    const mql = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    return mql && mql.matches ? "dark" : "light";
  }

  function applyThemeMode(mode: ThemeMode, syncToServer: boolean) {
    const resolved = resolveTheme(mode);
    setThemeMode(mode);
    setThemeResolved(resolved);
    document.documentElement.setAttribute("data-theme-mode", mode);
    document.documentElement.setAttribute("data-theme", resolved);
    localStorage.setItem("theme_mode", mode);
    // Back-compat: keep "theme" in sync if the user picks an explicit theme.
    if (mode === "light" || mode === "dark") localStorage.setItem("theme", mode);
    else localStorage.removeItem("theme");

    if (syncToServer && me?.id) {
      void sendJson("PUT", "/api/user/" + encodeURIComponent(me.id) + "/theme", { theme: mode }).catch(() => {});
    }
    track("theme_toggle", { mode, resolved });
  }

  async function doSearch(q: string) {
    const query = q.trim();
    if (!query) return;
    setSearchBusy(true);
    try {
      if (!me?.id) {
        setSearchResults([]);
        setSearchOpen(true);
        return;
      }
      const r = await sendJson<{ query: string; results: SearchResult[] }>("POST", "/api/search", { query });
      setSearchResults(Array.isArray(r.results) ? r.results : []);
      setSearchOpen(true);
      track("search", { q: query, n: (r.results || []).length });
    } catch {
      setSearchResults([]);
      setSearchOpen(true);
    } finally {
      setSearchBusy(false);
    }
  }

  async function markNotifRead(id: string) {
    if (!me?.id) return;
    try {
      await sendJson("PUT", "/api/notifications/" + encodeURIComponent(id) + "/read", {});
      const r = await getJson<{ items: NotificationItem[]; unreadCount: number }>(
        "/api/notifications/" + encodeURIComponent(me.id)
      );
      setNotifs(Array.isArray(r.items) ? r.items : []);
      setUnread(typeof r.unreadCount === "number" ? r.unreadCount : 0);
      track("notif_read", { id });
    } catch {}
  }

  async function clearAllNotifs() {
    if (!me?.id) return;
    try {
      await sendJson("DELETE", "/api/notifications/" + encodeURIComponent(me.id), {});
      const r = await getJson<{ items: NotificationItem[]; unreadCount: number }>(
        "/api/notifications/" + encodeURIComponent(me.id)
      );
      setNotifs(Array.isArray(r.items) ? r.items : []);
      setUnread(typeof r.unreadCount === "number" ? r.unreadCount : 0);
      track("notif_clear_all");
    } catch {}
  }

  async function logout() {
    try {
      await sendJson("POST", "/api/auth/logout", {});
      setMe(null);
      setNotifOpen(false);
      setSearchOpen(false);
      setProfileOpen(false);
      window.dispatchEvent(new Event("auth:changed"));
      track("logout");
      window.location.hash = "#dashboard";
    } catch {}
  }

  return (
    <div className={`page page-${page}`} data-page={page}>
      <div className="siteAurora" aria-hidden="true" />
      <div className="siteGridGlow" aria-hidden="true" />
      <a className="skipLink" href="#main-content">Skip to content</a>
      <header className={`topbar ${scrolled ? "scrolled" : ""}`} id="topbar">
        <div className="topbarInner">
          <a className="brand" href="#dashboard" aria-label="Home">
            <img
              className="brandLogo"
              src={logoSrc}
              alt="Trading Fix"
              loading="eager"
              decoding="async"
              onError={() => {
                // Use an SVG fallback shipped in the repo. If you later add the PNG at the same path, it will be used.
                if (!logoSrc.endsWith(".svg")) setLogoSrc("/brand/trading-fix-logo.svg");
              }}
            />
            <div className="brandText">
              <div className="brandName">Investment</div>
              <div className="brandTag">TRADE FIX</div>
            </div>
          </a>

          <nav className="navMenu" aria-label="Primary navigation">
            {menu.map((it) => (
              <a
                key={it.id}
                className={`navItem ${activeMenuId === it.id ? "active" : ""}`}
                href={it.href}
                onClick={() => {
                  track("nav_click", { id: it.id });
                }}
                aria-current={activeMenuId === it.id ? "page" : undefined}
              >
                <i className={`fa-solid ${it.icon}`} aria-hidden="true" />
                <span>{it.label}</span>
              </a>
            ))}
          </nav>

          <div className="navActions">
            <button
              className="iconBtn hamburger"
              type="button"
              aria-label="Open menu"
              aria-expanded={mobileOpen}
              aria-controls="mobile-menu"
              data-drop="mobile"
              onClick={(e) => {
                e.stopPropagation();
                setMobileOpen(true);
              }}
            >
              <i className="fa-solid fa-bars" aria-hidden="true" />
            </button>

            <form
              className="searchWrap"
              role="search"
              aria-label="Search"
              data-drop="search"
              onSubmit={(e) => {
                e.preventDefault();
                void doSearch(searchQ);
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <i className="fa-solid fa-magnifying-glass" aria-hidden="true" />
              <input
                aria-label="Search content"
                value={searchQ}
                onChange={(e) => {
                  const v = e.target.value;
                  setSearchQ(v);
                  if (v.trim()) {
                    if (searchTimerRef.current) window.clearTimeout(searchTimerRef.current);
                    searchTimerRef.current = window.setTimeout(() => void doSearch(v), 220);
                  } else {
                    if (searchTimerRef.current) {
                      window.clearTimeout(searchTimerRef.current);
                      searchTimerRef.current = null;
                    }
                    setSearchOpen(false);
                    setSearchResults([]);
                  }
                }}
                placeholder="Search..."
                onKeyDown={(e) => {
                  if (e.key === "Escape") setSearchOpen(false);
                }}
              />
              {searchOpen ? (
                <div className="searchDrop" role="listbox" aria-label="Search results">
                  <div className="searchDropHead">
                    {searchBusy ? "Searching..." : me?.id ? "Results" : "Sign in required"}
                  </div>
                  {!me?.id ? (
                    <div className="searchRow" role="option">
                      <div>
                        <div className="searchTitle">Login to search</div>
                        <div className="searchMeta">Go to Portfolio and sign in to enable search.</div>
                      </div>
                      <div className="searchScore">--</div>
                    </div>
                  ) : searchResults.length ? (
                    searchResults.map((r) => (
                      <div
                        key={r.id}
                        className="searchRow"
                        role="option"
                        onClick={() => {
                          setSearchOpen(false);
                          window.location.hash = r.href || "#dashboard";
                          track("search_select", { id: r.id });
                        }}
                      >
                        <div>
                          <div className="searchTitle">{r.title}</div>
                          <div className="searchMeta">{r.type}</div>
                        </div>
                        <div className="searchScore">{Number(r.relevance || 0).toFixed(3)}</div>
                      </div>
                    ))
                  ) : (
                    <div className="searchRow" role="option">
                      <div>
                        <div className="searchTitle">No results</div>
                        <div className="searchMeta">Try a different query.</div>
                      </div>
                      <div className="searchScore">--</div>
                    </div>
                  )}
                </div>
              ) : null}
            </form>

            <div style={{ position: "relative" }} data-drop="notif" onClick={(e) => e.stopPropagation()}>
              <button
                className="iconBtn"
                type="button"
                aria-label="Notifications"
                aria-haspopup="menu"
                aria-expanded={notifOpen}
                onClick={() => {
                  setNotifOpen((v) => !v);
                  track("notif_open");
                }}
              >
                <i className="fa-regular fa-bell" aria-hidden="true" />
              </button>
              {unread > 0 ? <div className="badge" aria-label="Unread notifications">{unread}</div> : null}
              {notifOpen ? (
                <div className="drop" role="menu" aria-label="Notifications dropdown">
                  <div className="dropHead">
                    <div className="dropTitle">Notifications</div>
                    <button className="dropBtn" type="button" onClick={() => void clearAllNotifs()} disabled={!me?.id}>
                      Clear all
                    </button>
                  </div>
                  {!me?.id ? (
                    <div className="notifRow">
                      <div className="notifTitle">Login to view notifications</div>
                      <div className="notifBody">Go to Portfolio and sign in.</div>
                    </div>
                  ) : notifs.length ? (
                    notifs.map((n) => (
                      <div key={n.id} className="notifRow" onClick={() => void markNotifRead(n.id)}>
                        <div className="notifTop">
                          <div className="notifTitleWrap">
                            {!n.read ? <span className="unreadDot" aria-hidden="true" /> : null}
                            <span className="notifTitle">{n.title}</span>
                          </div>
                          <div className="notifTime">{new Date(n.ts).toLocaleString()}</div>
                        </div>
                        <div className="notifBody">{n.body}</div>
                      </div>
                    ))
                  ) : (
                    <div className="notifRow">
                      <div className="notifTitle">You're all caught up</div>
                      <div className="notifBody">No new notifications.</div>
                    </div>
                  )}
                </div>
              ) : null}
            </div>

            <button
              className="themeSwitch"
              type="button"
              aria-label="Toggle theme"
              aria-pressed={themeResolved === "dark"}
              onClick={() => applyThemeMode(themeResolved === "dark" ? "light" : "dark", true)}
            >
              <div className="themeKnob" aria-hidden="true">
                <i className={`fa-solid ${themeResolved === "dark" ? "fa-moon" : "fa-sun"}`} aria-hidden="true" />
              </div>
            </button>

            <div style={{ position: "relative" }} data-drop="profile" onClick={(e) => e.stopPropagation()}>
              <button
                className="profileBtn"
                type="button"
                aria-label="User profile"
                aria-haspopup="menu"
                aria-expanded={profileOpen}
                onClick={() => {
                  setMobileOpen(false);
                  setProfileOpen((v) => !v);
                  track("profile_open");
                }}
              >
                <div className="avatar">{initials(me?.first_name || me?.email || "Guest")}</div>
                <div className="whoWrap">
                  <div className="whoName">{me?.first_name || "Guest"}</div>
                  <div className="whoSub">{me ? "Signed in" : "Not signed in"}</div>
                </div>
                <i className="fa-solid fa-chevron-down" aria-hidden="true" />
              </button>

              {profileOpen ? (
                <div className="drop" style={{ width: 260 }} role="menu" aria-label="Profile menu">
                  <div className="dropHead">
                    <div className="dropTitle">Account</div>
                    <button
                      className="dropBtn"
                      type="button"
                      onClick={() => applyThemeMode(themeMode === "auto" ? "light" : "auto", true)}
                      title="Auto uses your system theme"
                    >
                      <i className="fa-solid fa-circle-half-stroke" aria-hidden="true" /> {themeMode === "auto" ? "Auto" : "Set Auto"}
                    </button>
                  </div>
                  <div style={{ padding: 12, display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <button className="dropBtn" type="button" onClick={() => applyThemeMode("light", true)}>
                      <i className="fa-solid fa-sun" aria-hidden="true" /> Light
                    </button>
                    <button className="dropBtn" type="button" onClick={() => applyThemeMode("dark", true)}>
                      <i className="fa-solid fa-moon" aria-hidden="true" /> Dark
                    </button>
                    <button className="dropBtn" type="button" onClick={() => applyThemeMode("auto", true)}>
                      <i className="fa-solid fa-circle-half-stroke" aria-hidden="true" /> Auto
                    </button>
                  </div>
                  <div className="notifRow" onClick={() => { window.location.hash = "#portfolio"; setProfileOpen(false); }}>
                    <div className="notifTitle">Portfolio</div>
                    <div className="notifBody">Login, setup, and progress</div>
                  </div>
                  {me ? (
                    <div className="notifRow" onClick={() => void logout()}>
                      <div className="notifTitle">Logout</div>
                      <div className="notifBody">End this session</div>
                    </div>
                  ) : (
                    <div className="notifRow" onClick={() => { window.location.hash = "#portfolio"; setProfileOpen(false); }}>
                      <div className="notifTitle">Login</div>
                      <div className="notifBody">Sign in to enable features</div>
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </header>
      <div className="metaRibbon" aria-label="System status">
        <div className="metaRibbonInner">
          <span className="metaPill">
            <i className={`fa-solid ${me ? "fa-circle-check" : "fa-user-lock"}`} aria-hidden="true" />
            {me ? "Authenticated" : "Guest mode"}
          </span>
          <span className="metaText">{ribbonMessages[statusTick % ribbonMessages.length]}</span>
          <span className="metaTime mono">{new Date().toLocaleString()}</span>
        </div>
      </div>

      {mobileOpen ? (
        <div
          className="mobilePanel"
          id="mobile-menu"
          data-drop="mobile"
          style={{ display: "block" }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setMobileOpen(false);
          }}
        >
          <div className="mobileSheet" role="dialog" aria-label="Mobile menu" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
              <div style={{ fontWeight: 900, letterSpacing: "0.08em", textTransform: "uppercase", fontSize: 12, color: "var(--muted)" }}>
                Menu
              </div>
              <button className="iconBtn" type="button" aria-label="Close menu" onClick={() => setMobileOpen(false)}>
                <i className="fa-solid fa-xmark" aria-hidden="true" />
              </button>
            </div>
            <div className="mobileNav" aria-label="Mobile navigation">
              {menu.map((it) => (
                <a
                  key={it.id}
                  href={it.href}
                  onClick={() => {
                    setMobileOpen(false);
                    track("nav_click", { id: it.id, mobile: true });
                  }}
                >
                  <i className={`fa-solid ${it.icon}`} aria-hidden="true" />
                  <span>{it.label}</span>
                </a>
              ))}
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "space-between" }}>
              <button className="themeSwitch" type="button" aria-label="Toggle theme" onClick={() => applyThemeMode(themeResolved === "dark" ? "light" : "dark", true)}>
                <div className="themeKnob" aria-hidden="true">
                  <i className={`fa-solid ${themeResolved === "dark" ? "fa-moon" : "fa-sun"}`} aria-hidden="true" />
                </div>
              </button>
              {me ? (
                <button className="dropBtn" type="button" onClick={() => void logout()}>
                  Logout
                </button>
              ) : (
                <a className="dropBtn" href="#portfolio" onClick={() => setMobileOpen(false)}>
                  Login
                </a>
              )}
            </div>
          </div>
        </div>
      ) : null}

      <main className="content" id="main-content" tabIndex={-1}>
        <ErrorBoundary>
          <Suspense fallback={<div className="panel"><Skeleton style={{ height: 420 }} /></div>}>{content}</Suspense>
        </ErrorBoundary>
      </main>

      <aside className="conversionDock" aria-label="Quick actions">
        <div className="conversionDockHead">
          <span className="conversionDot" aria-hidden="true" />
          <span>Priority Access</span>
        </div>
        <div className="conversionDockBody">
          <div className="conversionTitle">Trade with confidence and speed</div>
          <div className="conversionSub">
            {me
              ? "Open progress, monitor your path, and contact admin for immediate support."
              : "Sign in to unlock portfolio tools, then continue to progress and support."}
          </div>
          <div className="conversionActions">
            <a className="primary" href={me ? "#progress" : "#portfolio"}>
              {me ? "Open Progress" : "Login Now"}
            </a>
            <a className="ghost" href="#contact">Contact Admin</a>
          </div>
        </div>
      </aside>

      <footer className="siteFooter" aria-label="Footer">
        <div className="siteFooterInner">
          <div className="footBrand">
            <div className="mono footMark">TRADE FIX</div>
            <div className="muted footNote">Markets, portfolio tracking, and progress analytics in one place.</div>
          </div>
          <div className="footLinks" aria-label="Footer links">
            <a className="footLink" href="#markets">Markets</a>
            <a className="footLink" href="#portfolio">Portfolio</a>
            <a className="footLink" href="#blog">Insights</a>
            <a className="footLink" href="#contact">Support</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
