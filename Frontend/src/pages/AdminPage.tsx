import { useMemo, useState } from "react";
import Notice from "../components/Notice";
import { apiUrl } from "../lib/api";

type Method = "GET" | "POST" | "PUT";

type ActiveAuthCode = { email?: string; auth_code_plain?: string; created_at?: string; is_active?: boolean };
type AuthCodeHistoryItem = { id: string; email: string; auth_code_plain?: string | null; created_at: string; is_active: boolean };
type AdminUserItem = {
  id: string;
  email: string;
  first_name?: string | null;
  created_at: string;
  active_auth_code?: { auth_code_plain?: string | null; created_at?: string; is_active?: boolean } | null;
};
type TaxPaymentItem = {
  id: string;
  user_id: string;
  email?: string | null;
  amount: number;
  asset: string;
  method: string;
  reference?: string | null;
  note?: string | null;
  status: string;
  created_at: string;
  updated_at: string;
};

async function adminJson<T>(method: Method, path: string, adminKey: string, body?: any): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method,
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(method !== "GET" ? { "Content-Type": "application/json" } : {}),
      "x-admin-api-key": adminKey
    },
    body: method !== "GET" ? JSON.stringify(body || {}) : undefined
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`);
  return j as T;
}

export default function AdminPage() {
  const [adminKey, setAdminKey] = useState(() => sessionStorage.getItem("admin_api_key") || "");
  const [email, setEmail] = useState(() => sessionStorage.getItem("admin_last_email") || "");
  const [customCode, setCustomCode] = useState("");
  const [busyAuth, setBusyAuth] = useState(false);
  const [busyTax, setBusyTax] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeCode, setActiveCode] = useState<ActiveAuthCode | null>(null);
  const [generatedCode, setGeneratedCode] = useState<string>("");
  const [codeHistory, setCodeHistory] = useState<AuthCodeHistoryItem[]>([]);
  const [users, setUsers] = useState<AdminUserItem[]>([]);
  const [taxItems, setTaxItems] = useState<TaxPaymentItem[]>([]);
  const [taxFilterEmail, setTaxFilterEmail] = useState("");
  const [taxCreateEmail, setTaxCreateEmail] = useState("");
  const [taxCreateAmount, setTaxCreateAmount] = useState("");
  const [taxCreateAsset, setTaxCreateAsset] = useState("USD");
  const [taxCreateMethod, setTaxCreateMethod] = useState("Manual Entry");
  const [taxCreateStatus, setTaxCreateStatus] = useState("confirmed");
  const [taxCreateReference, setTaxCreateReference] = useState("");
  const [taxCreateNote, setTaxCreateNote] = useState("");
  const [editingTaxId, setEditingTaxId] = useState("");
  const [editAmount, setEditAmount] = useState("");
  const [editAsset, setEditAsset] = useState("USD");
  const [editMethod, setEditMethod] = useState("");
  const [editStatus, setEditStatus] = useState("confirmed");
  const [editReference, setEditReference] = useState("");
  const [editNote, setEditNote] = useState("");

  const emailNorm = useMemo(() => email.trim().toLowerCase(), [email]);
  const canRun = useMemo(() => !!adminKey.trim() && !!emailNorm, [adminKey, emailNorm]);
  const customCodeValid = useMemo(() => /^[A-Za-z0-9]{6}$/.test(customCode.trim()), [customCode]);
  const canTax = useMemo(() => !!adminKey.trim(), [adminKey]);

  function fmtTs(ts?: string) {
    if (!ts) return "--";
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return "--";
    return d.toLocaleString();
  }

  function rememberKey() {
    sessionStorage.setItem("admin_api_key", adminKey.trim());
  }

  function clearKey() {
    sessionStorage.removeItem("admin_api_key");
    setAdminKey("");
  }

  function rememberEmail(value: string) {
    sessionStorage.setItem("admin_last_email", value);
  }

  async function runAuth(action: "lookup" | "generate" | "set" | "deactivate" | "history" | "users") {
    if (!canRun) return;
    setBusyAuth(true);
    setError(null);
    try {
      const key = adminKey.trim();
      rememberKey();
      rememberEmail(emailNorm);

      if (action === "lookup") {
        const data = await adminJson<{ auth_code?: ActiveAuthCode }>("GET", `/api/auth/admin/active-auth-code?email=${encodeURIComponent(emailNorm)}`, key);
        setActiveCode(data?.auth_code || null);
      } else if (action === "history") {
        const data = await adminJson<{ items: AuthCodeHistoryItem[] }>("GET", `/api/auth/admin/auth-code-history?email=${encodeURIComponent(emailNorm)}&limit=25`, key);
        setCodeHistory(Array.isArray(data.items) ? data.items : []);
      } else if (action === "users") {
        const q = emailNorm ? `?email=${encodeURIComponent(emailNorm)}&limit=50` : "?limit=50";
        const data = await adminJson<{ items: AdminUserItem[] }>("GET", `/api/auth/admin/users${q}`, key);
        setUsers(Array.isArray(data.items) ? data.items : []);
      } else if (action === "generate") {
        const data = await adminJson<{ authCode?: string }>("POST", "/api/auth/admin/generate-auth-code", key, { email: emailNorm });
        setGeneratedCode(data?.authCode || "");
        if (data?.authCode) setCustomCode(data.authCode);
        await runAuth("lookup");
      } else if (action === "deactivate") {
        await adminJson("POST", "/api/auth/admin/deactivate-auth-code", key, { email: emailNorm });
        setGeneratedCode("");
        setActiveCode(null);
        await runAuth("history");
      } else {
        const code = customCode.trim();
        if (!/^[A-Za-z0-9]{6}$/.test(code)) throw new Error("Custom AUTH code must be 6 letters/numbers.");
        await adminJson("POST", "/api/auth/admin/auth-codes", key, { email: emailNorm, authCode: code });
        setGeneratedCode(code);
        await runAuth("lookup");
        await runAuth("history");
      }
    } catch (e: any) {
      setError(typeof e?.message === "string" ? e.message : "Request failed.");
    } finally {
      setBusyAuth(false);
    }
  }

  async function refreshTax() {
    if (!canTax) return;
    setBusyTax(true);
    setError(null);
    try {
      const key = adminKey.trim();
      rememberKey();
      const emailQ = taxFilterEmail.trim().toLowerCase();
      const q = emailQ ? `?email=${encodeURIComponent(emailQ)}&limit=120` : "?limit=120";
      const data = await adminJson<{ items: TaxPaymentItem[] }>("GET", `/api/admin/tax-payments${q}`, key);
      setTaxItems(Array.isArray(data.items) ? data.items : []);
    } catch (e: any) {
      setError(typeof e?.message === "string" ? e.message : "Request failed.");
    } finally {
      setBusyTax(false);
    }
  }

  async function createTaxPayment() {
    if (!canTax) return;
    setBusyTax(true);
    setError(null);
    try {
      const key = adminKey.trim();
      rememberKey();
      const emailV = taxCreateEmail.trim().toLowerCase();
      if (!emailV) throw new Error("Tax payment requires an email.");
      await adminJson("POST", "/api/admin/tax-payments", key, {
        email: emailV,
        amount: taxCreateAmount.trim(),
        asset: taxCreateAsset.trim().toUpperCase(),
        method: taxCreateMethod.trim() || "Manual Entry",
        status: taxCreateStatus,
        reference: taxCreateReference.trim(),
        note: taxCreateNote.trim()
      });
      setTaxCreateAmount("");
      setTaxCreateReference("");
      setTaxCreateNote("");
      await refreshTax();
    } catch (e: any) {
      setError(typeof e?.message === "string" ? e.message : "Request failed.");
    } finally {
      setBusyTax(false);
    }
  }

  function beginEditTax(item: TaxPaymentItem) {
    setEditingTaxId(item.id);
    setEditAmount(String(item.amount ?? ""));
    setEditAsset(item.asset || "USD");
    setEditMethod(item.method || "");
    setEditStatus(item.status || "confirmed");
    setEditReference(item.reference || "");
    setEditNote(item.note || "");
  }

  async function saveTaxEdit() {
    if (!canTax || !editingTaxId) return;
    setBusyTax(true);
    setError(null);
    try {
      const key = adminKey.trim();
      rememberKey();
      await adminJson("PUT", `/api/admin/tax-payments/${encodeURIComponent(editingTaxId)}`, key, {
        amount: editAmount.trim(),
        asset: editAsset.trim().toUpperCase(),
        method: editMethod.trim(),
        status: editStatus,
        reference: editReference,
        note: editNote
      });
      setEditingTaxId("");
      await refreshTax();
    } catch (e: any) {
      setError(typeof e?.message === "string" ? e.message : "Request failed.");
    } finally {
      setBusyTax(false);
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
              <div className="panelSub">All admin actions are signed with x-admin-api-key. Key is saved in this tab only.</div>
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
            {error ? <div className="authError">{error}</div> : null}
          </div>
        </div>

        <div className="marketCard">
          <div className="marketCardHead">
            <div>
              <div className="panelTitle">AUTH code operations</div>
              <div className="panelSub">Run all manual AUTH-code tasks from one place.</div>
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
              <button className="mini" type="button" onClick={() => void runAuth("lookup")} disabled={!canRun || busyAuth}>
                View active code
              </button>
              <button className="mini" type="button" onClick={() => void runAuth("generate")} disabled={!canRun || busyAuth}>
                Generate new code
              </button>
              <button className="mini" type="button" onClick={() => void runAuth("deactivate")} disabled={!canRun || busyAuth}>
                Deactivate active code
              </button>
              <button
                className="mini"
                type="button"
                onClick={() => void runAuth("set")}
                disabled={!canRun || busyAuth || !customCodeValid}
              >
                Set custom code
              </button>
              <button className="mini" type="button" onClick={() => void runAuth("history")} disabled={!canRun || busyAuth}>
                Fetch code history
              </button>
              <button className="mini" type="button" onClick={() => void runAuth("users")} disabled={!adminKey.trim() || busyAuth}>
                Find users
              </button>
            </div>
            {!customCodeValid && customCode.trim() ? (
              <div className="authError">Custom AUTH code must be exactly 6 letters/numbers.</div>
            ) : null}
            {activeCode ? (
              <Notice tone="info" title="Result">
                <div className="pairsNote">Email: <span className="mono">{activeCode.email || emailNorm}</span></div>
                <div className="pairsNote">Code: <span className="mono">{activeCode.auth_code_plain || "--"}</span></div>
                <div className="pairsNote">Active: <span className="mono">{activeCode.is_active === false ? "No" : "Yes"}</span></div>
                <div className="pairsNote">Created: <span className="mono">{fmtTs(activeCode.created_at)}</span></div>
              </Notice>
            ) : null}
            {generatedCode ? (
              <Notice tone="warn" title="Generated/Set AUTH code">
                <div className="pairsNote">
                  Share securely with user: <span className="mono">{generatedCode}</span>
                </div>
              </Notice>
            ) : null}
          </div>
        </div>

        <div className="marketCard">
          <div className="marketCardHead">
            <div>
              <div className="panelTitle">AUTH code history</div>
              <div className="panelSub">Latest code events for this email.</div>
            </div>
          </div>
          <div className="authBody">
            {!codeHistory.length ? (
              <div className="pairsNote">No history loaded yet.</div>
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                {codeHistory.map((it) => (
                  <div key={it.id} className="pairsNote">
                    <span className="mono">{fmtTs(it.created_at)}</span> | <span className="mono">{it.auth_code_plain || "--"}</span> |{" "}
                    <span className="mono">{it.is_active ? "active" : "inactive"}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="marketCard">
          <div className="marketCardHead">
            <div>
              <div className="panelTitle">User lookup</div>
              <div className="panelSub">Find latest users and see active AUTH-code metadata.</div>
            </div>
          </div>
          <div className="authBody">
            {!users.length ? (
              <div className="pairsNote">No user lookup results loaded yet.</div>
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                {users.map((u) => (
                  <div key={u.id} className="pairsNote">
                    <span className="mono">{u.email}</span> | Joined <span className="mono">{fmtTs(u.created_at)}</span> | Active code:{" "}
                    <span className="mono">{u.active_auth_code?.auth_code_plain || "--"}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="marketCard spanFull">
          <div className="marketCardHead">
            <div>
              <div className="panelTitle">Tax payment operations</div>
              <div className="panelSub">List, create, and edit admin tax-payment records.</div>
            </div>
          </div>
          <div className="authBody">
            <label className="authField">
              <span className="muted">Filter by email (optional)</span>
              <input value={taxFilterEmail} onChange={(e) => setTaxFilterEmail(e.target.value)} placeholder="user@gmail.com" />
            </label>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button className="mini" type="button" onClick={() => void refreshTax()} disabled={!canTax || busyTax}>
                Refresh tax records
              </button>
            </div>

            <div className="pairsNote" style={{ marginTop: 12, fontWeight: 700 }}>Create tax payment</div>
            <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
              <input value={taxCreateEmail} onChange={(e) => setTaxCreateEmail(e.target.value)} placeholder="Email" />
              <input value={taxCreateAmount} onChange={(e) => setTaxCreateAmount(e.target.value)} placeholder="Amount" />
              <input value={taxCreateAsset} onChange={(e) => setTaxCreateAsset(e.target.value)} placeholder="Asset (USD)" />
              <input value={taxCreateMethod} onChange={(e) => setTaxCreateMethod(e.target.value)} placeholder="Method" />
              <select value={taxCreateStatus} onChange={(e) => setTaxCreateStatus(e.target.value)}>
                <option value="confirmed">confirmed</option>
                <option value="pending">pending</option>
                <option value="rejected">rejected</option>
                <option value="cancelled">cancelled</option>
              </select>
              <input value={taxCreateReference} onChange={(e) => setTaxCreateReference(e.target.value)} placeholder="Reference (optional)" />
            </div>
            <label className="authField">
              <span className="muted">Note (optional)</span>
              <input value={taxCreateNote} onChange={(e) => setTaxCreateNote(e.target.value)} placeholder="Manual note" />
            </label>
            <button className="mini" type="button" onClick={() => void createTaxPayment()} disabled={!canTax || busyTax}>
              Create tax payment
            </button>

            <div className="pairsNote" style={{ marginTop: 12, fontWeight: 700 }}>Tax records</div>
            {!taxItems.length ? (
              <div className="pairsNote">No tax records loaded yet.</div>
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                {taxItems.map((it) => (
                  <button
                    key={it.id}
                    type="button"
                    className="pairsNote"
                    style={{ textAlign: "left", cursor: "pointer" }}
                    onClick={() => beginEditTax(it)}
                  >
                    <span className="mono">{it.email || it.user_id}</span> | <span className="mono">{it.amount} {it.asset}</span> |{" "}
                    <span className="mono">{it.status}</span> | <span className="mono">{fmtTs(it.created_at)}</span>
                  </button>
                ))}
              </div>
            )}

            {editingTaxId ? (
              <div style={{ marginTop: 12, borderTop: "1px solid var(--line)", paddingTop: 12 }}>
                <div className="pairsNote" style={{ fontWeight: 700 }}>Edit selected tax payment</div>
                <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
                  <input value={editAmount} onChange={(e) => setEditAmount(e.target.value)} placeholder="Amount" />
                  <input value={editAsset} onChange={(e) => setEditAsset(e.target.value)} placeholder="Asset" />
                  <input value={editMethod} onChange={(e) => setEditMethod(e.target.value)} placeholder="Method" />
                  <select value={editStatus} onChange={(e) => setEditStatus(e.target.value)}>
                    <option value="confirmed">confirmed</option>
                    <option value="pending">pending</option>
                    <option value="rejected">rejected</option>
                    <option value="cancelled">cancelled</option>
                  </select>
                  <input value={editReference} onChange={(e) => setEditReference(e.target.value)} placeholder="Reference" />
                </div>
                <label className="authField">
                  <span className="muted">Note</span>
                  <input value={editNote} onChange={(e) => setEditNote(e.target.value)} placeholder="Updated note" />
                </label>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <button className="mini" type="button" onClick={() => void saveTaxEdit()} disabled={!canTax || busyTax}>
                    Save update
                  </button>
                  <button className="mini" type="button" onClick={() => setEditingTaxId("")}>
                    Cancel edit
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </section>
    </>
  );
}
