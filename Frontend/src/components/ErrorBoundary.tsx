import React from "react";

type Props = {
  children: React.ReactNode;
  fallback?: (err: Error) => React.ReactNode;
};

type State = { err: Error | null };
const isDev = (import.meta as any)?.env?.DEV === true;
const RECOVERY_KEY = "ui_recovery_attempts_v2";

function isRecoverableChunkError(err: Error | null | undefined) {
  const m = String(err?.message || "").toLowerCase();
  return (
    m.includes("failed to fetch dynamically imported module") ||
    m.includes("dynamically imported module") ||
    m.includes("chunkloaderror") ||
    m.includes("loading chunk") ||
    m.includes("importing a module script failed")
  );
}

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { err: null };

  static getDerivedStateFromError(err: Error): State {
    return { err };
  }

  componentDidCatch(err: Error) {
    if (isRecoverableChunkError(err)) {
      try {
        const raw = sessionStorage.getItem(RECOVERY_KEY);
        const map = raw ? (JSON.parse(raw) as Record<string, number>) : {};
        const path = window.location.pathname || "/";
        const attempts = Number(map[path] || 0);
        if (attempts < 2) {
          map[path] = attempts + 1;
          sessionStorage.setItem(RECOVERY_KEY, JSON.stringify(map));
          window.location.reload();
          return;
        }
      } catch {}
    } else {
      try {
        sessionStorage.removeItem(RECOVERY_KEY);
      } catch {}
    }
    if (isDev) {
      console.error("UI crashed:", err);
    }
  }

  render() {
    const { err } = this.state;
    if (!err) return this.props.children;
    if (this.props.fallback) return this.props.fallback(err);
    return (
      <div style={{ padding: 18 }}>
        <div style={{ fontWeight: 950, letterSpacing: "0.04em", textTransform: "uppercase", fontSize: 12, color: "var(--muted)" }}>
          UI Error
        </div>
        <div style={{ marginTop: 10, fontWeight: 900, fontSize: 18 }}>Something crashed while rendering.</div>
        <div style={{ marginTop: 10, color: "var(--muted)", lineHeight: 1.5 }}>
          Please refresh and try again. If this keeps happening, contact support from the Contact page.
        </div>
        {isDev ? (
          <pre
            style={{
              marginTop: 12,
              padding: 12,
              borderRadius: 16,
              border: "1px solid var(--line)",
              background: "rgba(11, 18, 32, 0.4)",
              overflow: "auto",
              maxHeight: 240
            }}
          >
            {String(err?.message || err)}
          </pre>
        ) : null}
        <button
          className="primary"
          type="button"
          onClick={() => {
            try {
              sessionStorage.removeItem(RECOVERY_KEY);
            } catch {}
            this.setState({ err: null });
            const bust = `cb=${Date.now()}`;
            const hasQuery = window.location.search && window.location.search.length > 1;
            const next = `${window.location.pathname}${window.location.search || ""}${hasQuery ? "&" : "?"}${bust}${window.location.hash || ""}`;
            window.location.assign(next);
          }}
          style={{ marginTop: 12 }}
        >
          Reload
        </button>
      </div>
    );
  }
}
