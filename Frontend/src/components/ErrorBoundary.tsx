import React from "react";

type Props = {
  children: React.ReactNode;
  fallback?: (err: Error) => React.ReactNode;
};

type State = { err: Error | null };
const isDev = (import.meta as any)?.env?.DEV === true;

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { err: null };

  static getDerivedStateFromError(err: Error): State {
    return { err };
  }

  componentDidCatch(err: Error) {
    if (isDev) {
      // eslint-disable-next-line no-console
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
            this.setState({ err: null });
            window.location.reload();
          }}
          style={{ marginTop: 12 }}
        >
          Reload
        </button>
      </div>
    );
  }
}
