import { useMemo, useState } from "react";
import Notice from "../components/Notice";
import { apiUrl } from "../lib/api";

type AdminAuthCodeResponse = {
  ok?: boolean;
  email?: string;
  authCode?: string;
  auth_code?: {
    email?: string;
    auth_code_plain?: string;
    created_at?: string;
    is_active?: boolean;
  };
};

async function adminJson<T>(method: "GET" | "POST", path: string, adminKey: string, body?: any): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method,
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
      "x-admin-api-key": adminKey
    },
    body: method === "POST" ? JSON.stringify(body || {}) : undefined
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`);
  return j as T;
}

export default function AdminPage() {
  const [adminKey, setAdminKey] = useState(() => sessionStorage.getItem("admin_api_key") || "");
  const [email, setEmail] = useState("");
  const [customCode, setCustomCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string>("");

  const emailNorm = useMemo(() => email.trim().toLowerCase(), [email]);
  const canRun = useMemo(() => !!adminKey.trim() && !!emailNorm, [adminKey, emailNorm]);
  const customCodeValid = useMemo(() => /^[A-Za-z0-9]{6}$/.test(customCode.trim()), [customCode]);

  function rememberKey() {
    sessionStorage.setItem("admin_api_key", adminKey.trim());
  }

  function clearKey() {
    sessionStorage.removeItem("admin_api_key");
    setAdminKey("");
  }

  async function run(action: "lookup" | "generate" | "set") {
    if (!canRun) return;
    setBusy(true);
    setError(null);
    setResult("");
    try {
      const key = adminKey.trim();
      rememberKey();

      if (action === "lookup") {
        const data = await adminJson<AdminAuthCodeResponse>(
          "GET",
          `/api/auth/admin/active-auth-code?email=${encodeURIComponent(emailNorm)}`,
          key
        );
        const row = data?.auth_code || {};
        setResult(
          [
            `Email: ${row.email || emailNorm}`,
            `Active: ${row.is_active === false ? "No" : "Yes"}`,
            `AUTH Code: ${row.auth_code_plain || "--"}`,
            `Created: ${row.created_at ? new Date(row.created_at).toLocaleString() : "--"}`
          ].join("\n")
        );
      } else if (action === "generate") {
        const data = await adminJson<AdminAuthCodeResponse>("POST", "/api/auth/admin/generate-auth-code", key, { email: emailNorm });
        setResult(
          [
            `Generated for: ${data.email || emailNorm}`,
            `AUTH Code: ${data.authCode || "--"}`,
            "",
            "Send this code to the user privately."
          ].join("\n")
        );
      } else {
        const code = customCode.trim();
        if (!/^[A-Za-z0-9]{6}$/.test(code)) throw new Error("Custom AUTH code must be 6 letters/numbers.");
        await adminJson<AdminAuthCodeResponse>("POST", "/api/auth/admin/auth-codes", key, {
          email: emailNorm,
          authCode: code
        });
        setResult([`Custom AUTH code has been set for: ${emailNorm}`, `AUTH Code: ${code}`].join("\n"));
      }
    } catch (e: any) {
      setError(typeof e?.message === "string" ? e.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="pageHero">
        <div>
          <div className="eyebrow">Admin</div>
          <h1 className="pageTitle">Private operations panel</h1>
          <p className="pageLead">This page is intentionally hidden from website navigation and should be shared only with admins.</p>
        </div>
      </section>

      <section className="marketGrid">
        <div className="marketCard spanFull">
          <div className="marketCardHead">
            <div>
              <div className="panelTitle">Admin API key</div>
              <div className="panelSub">Required for all admin actions.</div>
            </div>
          </div>
          <div className="authBody">
            <label className="authField">
              <span className="muted">x-admin-api-key</span>
              <input
                type="password"
                value={adminKey}
                onChange={(e) => setAdminKey(e.target.value)}
                placeholder="Enter admin API key"
                autoCapitalize="off"
                autoCorrect="off"
              />
            </label>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button className="mini" type="button" onClick={rememberKey} disabled={!adminKey.trim()}>
                Save for this tab
              </button>
              <button className="mini" type="button" onClick={clearKey}>
                Clear
              </button>
            </div>
          </div>
        </div>

        <div className="marketCard">
          <div className="marketCardHead">
            <div>
              <div className="panelTitle">AUTH code management</div>
              <div className="panelSub">Lookup, generate, or set a custom 6-character code.</div>
            </div>
          </div>
          <div className="authBody">
            <label className="authField">
              <span className="muted">User email (Gmail)</span>
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="user@gmail.com"
                autoCapitalize="off"
                autoCorrect="off"
              />
            </label>
            <label className="authField">
              <span className="muted">Custom AUTH code (optional)</span>
              <input
                value={customCode}
                onChange={(e) => setCustomCode(e.target.value)}
                placeholder="e.g. Ab1Xz9"
                autoCapitalize="off"
                autoCorrect="off"
              />
            </label>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button className="mini" type="button" onClick={() => void run("lookup")} disabled={!canRun || busy}>
                View active code
              </button>
              <button className="mini" type="button" onClick={() => void run("generate")} disabled={!canRun || busy}>
                Generate new code
              </button>
              <button
                className="mini"
                type="button"
                onClick={() => void run("set")}
                disabled={!canRun || busy || !customCodeValid}
              >
                Set custom code
              </button>
            </div>
            {!customCodeValid && customCode.trim() ? (
              <div className="authError">Custom AUTH code must be exactly 6 letters/numbers.</div>
            ) : null}
            {error ? <div className="authError">{error}</div> : null}
            {result ? (
              <Notice tone="info" title="Result">
                <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{result}</pre>
              </Notice>
            ) : null}
          </div>
        </div>
      </section>
    </>
  );
}
