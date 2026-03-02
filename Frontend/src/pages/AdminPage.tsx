import { useMemo, useState } from "react";
import Notice from "../components/Notice";
import { apiUrl } from "../lib/api";

type Method = "GET" | "POST" | "PUT";
type ConfirmAction = "deactivate" | "bulk_destructive" | "tax_update" | null;
type BulkAction = "generate" | "deactivate" | "lookup";
type KeyStatus = "idle" | "ok" | "error";

type ActiveAuthCode = { email?: string; auth_code_plain?: string; created_at?: string; is_active?: boolean };
type AuthCodeHistoryItem = { id: string; email: string; auth_code_plain?: string | null; created_at: string; is_active: boolean };
type AdminUserItem = { id: string; email: string; created_at: string; active_auth_code?: { auth_code_plain?: string | null } | null };
type AuditItem = { id: string; actor: string; action: string; target: string; created_at: string };
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
};

async function apiJson<T>(method: Method, path: string, adminKey: string, body?: any): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (method !== "GET") headers["Content-Type"] = "application/json";
  if (adminKey.trim()) headers["x-admin-api-key"] = adminKey.trim();
  const res = await fetch(apiUrl(path), {
    method,
    credentials: "include",
    headers,
    body: method !== "GET" ? JSON.stringify(body || {}) : undefined
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`);
  return j as T;
}

async function siteJson<T>(method: Method, path: string, body?: any): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (method !== "GET") headers["Content-Type"] = "application/json";
  const res = await fetch(apiUrl(path), {
    method,
    credentials: "include",
    headers,
    body: method !== "GET" ? JSON.stringify(body || {}) : undefined
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`);
  return j as T;
}

function normEmails(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(/\r?\n|,|;|\s+/)
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean)
    )
  );
}

function fmt(ts?: string) {
  if (!ts) return "--";
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "--" : d.toLocaleString();
}

export default function AdminPage() {
  const [adminKey, setAdminKey] = useState(() => sessionStorage.getItem("admin_api_key") || "");
  const [adminSession, setAdminSession] = useState<{ ok: boolean; actor: string; mode: string } | null>(null);
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginAuthCode, setLoginAuthCode] = useState("");
  const [email, setEmail] = useState(() => sessionStorage.getItem("admin_last_email") || "");
  const [customCode, setCustomCode] = useState("");
  const [activeCode, setActiveCode] = useState<ActiveAuthCode | null>(null);
  const [history, setHistory] = useState<AuthCodeHistoryItem[]>([]);
  const [users, setUsers] = useState<AdminUserItem[]>([]);
  const [audit, setAudit] = useState<AuditItem[]>([]);
  const [bulkInput, setBulkInput] = useState("");
  const [bulkAction, setBulkAction] = useState<BulkAction>("generate");
  const [bulkResults, setBulkResults] = useState<string[]>([]);
  const [keyStatus, setKeyStatus] = useState<KeyStatus>("idle");
  const [taxItems, setTaxItems] = useState<TaxPaymentItem[]>([]);
  const [editingTaxId, setEditingTaxId] = useState("");
  const [editAmount, setEditAmount] = useState("");
  const [editAsset, setEditAsset] = useState("USD");
  const [editMethod, setEditMethod] = useState("");
  const [editStatus, setEditStatus] = useState("confirmed");
  const [editReference, setEditReference] = useState("");
  const [editNote, setEditNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  const [confirmBody, setConfirmBody] = useState("");

  const emailNorm = useMemo(() => email.trim().toLowerCase(), [email]);
  const canAdmin = useMemo(() => !!adminSession?.ok, [adminSession?.ok]);
  const authReady = useMemo(() => canAdmin && !!emailNorm, [canAdmin, emailNorm]);
  const bulkEmails = useMemo(() => normEmails(bulkInput), [bulkInput]);
  const customCodeValid = useMemo(() => /^[A-Za-z0-9]{6}$/.test(customCode.trim()), [customCode]);

  async function refreshSession() {
    setBusy(true);
    setError(null);
    try {
      const data = await apiJson<{ ok: boolean; actor: string; mode: string }>("GET", "/api/auth/admin/session", adminKey);
      setAdminSession(data?.ok ? data : null);
      if (adminKey.trim()) sessionStorage.setItem("admin_api_key", adminKey.trim());
    } catch (e: any) {
      setAdminSession(null);
      setError(typeof e?.message === "string" ? e.message : "Session failed");
    } finally {
      setBusy(false);
    }
  }

  async function signInRoleAdmin() {
    setBusy(true);
    setError(null);
    try {
      await siteJson("POST", "/api/auth/login", { email: loginEmail, password: loginPassword, authCode: loginAuthCode });
      await refreshSession();
    } catch (e: any) {
      setError(typeof e?.message === "string" ? e.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  async function logoutAdmin() {
    setBusy(true);
    setError(null);
    try {
      await siteJson("POST", "/api/auth/logout", {});
      setAdminSession(null);
    } catch (e: any) {
      setError(typeof e?.message === "string" ? e.message : "Logout failed");
    } finally {
      setBusy(false);
    }
  }

  async function runAuth(action: "lookup" | "generate" | "set" | "deactivate" | "history" | "users", force = false) {
    if (!authReady) return;
    if (action === "deactivate" && !force) {
      setConfirmAction("deactivate");
      setConfirmBody(`Deactivate active AUTH code for ${emailNorm}?`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (action === "lookup") {
        const data = await apiJson<{ auth_code?: ActiveAuthCode }>("GET", `/api/auth/admin/active-auth-code?email=${encodeURIComponent(emailNorm)}`, adminKey);
        setActiveCode(data?.auth_code || null);
      } else if (action === "generate") {
        const r = await apiJson<{ authCode?: string }>("POST", "/api/auth/admin/generate-auth-code", adminKey, { email: emailNorm });
        if (r?.authCode) setCustomCode(r.authCode);
        await runAuth("lookup", true);
      } else if (action === "set") {
        await apiJson("POST", "/api/auth/admin/auth-codes", adminKey, { email: emailNorm, authCode: customCode.trim() });
        await runAuth("lookup", true);
      } else if (action === "deactivate") {
        await apiJson("POST", "/api/auth/admin/deactivate-auth-code", adminKey, { email: emailNorm });
        setActiveCode(null);
      } else if (action === "history") {
        const r = await apiJson<{ items: AuthCodeHistoryItem[] }>("GET", `/api/auth/admin/auth-code-history?email=${encodeURIComponent(emailNorm)}&limit=100`, adminKey);
        setHistory(Array.isArray(r.items) ? r.items : []);
      } else {
        const r = await apiJson<{ items: AdminUserItem[] }>("GET", `/api/auth/admin/users?email=${encodeURIComponent(emailNorm)}&limit=50`, adminKey);
        setUsers(Array.isArray(r.items) ? r.items : []);
      }
      sessionStorage.setItem("admin_last_email", emailNorm);
    } catch (e: any) {
      setError(typeof e?.message === "string" ? e.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  async function runBulk(force = false) {
    if (!canAdmin || !bulkEmails.length) return;
    if (!force && (bulkAction === "generate" || bulkAction === "deactivate")) {
      setConfirmAction("bulk_destructive");
      setConfirmBody(`Run '${bulkAction}' on ${bulkEmails.length} users?`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const out: string[] = [];
      for (const em of bulkEmails) {
        try {
          if (bulkAction === "generate") {
            const r = await apiJson<{ authCode?: string }>("POST", "/api/auth/admin/generate-auth-code", adminKey, { email: em });
            out.push(`${em} | generated | ${r.authCode || "--"}`);
          } else if (bulkAction === "deactivate") {
            const r = await apiJson<{ deactivated?: number }>("POST", "/api/auth/admin/deactivate-auth-code", adminKey, { email: em });
            out.push(`${em} | deactivated ${r.deactivated ?? 0}`);
          } else {
            const r = await apiJson<{ auth_code?: ActiveAuthCode }>("GET", `/api/auth/admin/active-auth-code?email=${encodeURIComponent(em)}`, adminKey);
            out.push(`${em} | ${r?.auth_code?.auth_code_plain || "no active code"}`);
          }
        } catch (e: any) {
          out.push(`${em} | error | ${typeof e?.message === "string" ? e.message : "failed"}`);
        }
      }
      setBulkResults(out);
    } finally {
      setBusy(false);
    }
  }

  async function refreshAudit() {
    if (!canAdmin) return;
    setBusy(true);
    setError(null);
    try {
      const r = await apiJson<{ items: AuditItem[] }>("GET", "/api/auth/admin/audit?limit=180", adminKey);
      setAudit(Array.isArray(r.items) ? r.items : []);
    } catch (e: any) {
      setError(typeof e?.message === "string" ? e.message : "Audit failed");
    } finally {
      setBusy(false);
    }
  }

  async function refreshTax() {
    if (!canAdmin) return;
    setBusy(true);
    setError(null);
    try {
      const r = await apiJson<{ items: TaxPaymentItem[] }>("GET", "/api/admin/tax-payments?limit=120", adminKey);
      setTaxItems(Array.isArray(r.items) ? r.items : []);
    } catch (e: any) {
      setError(typeof e?.message === "string" ? e.message : "Tax fetch failed");
    } finally {
      setBusy(false);
    }
  }

  function beginTaxEdit(item: TaxPaymentItem) {
    setEditingTaxId(item.id);
    setEditAmount(String(item.amount || ""));
    setEditAsset(item.asset || "USD");
    setEditMethod(item.method || "");
    setEditStatus(item.status || "confirmed");
    setEditReference(item.reference || "");
    setEditNote(item.note || "");
  }

  async function saveTax(force = false) {
    if (!canAdmin || !editingTaxId) return;
    if (!force) {
      setConfirmAction("tax_update");
      setConfirmBody(`Apply updates to tax payment ${editingTaxId}?`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiJson("PUT", `/api/admin/tax-payments/${encodeURIComponent(editingTaxId)}`, adminKey, {
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
      setError(typeof e?.message === "string" ? e.message : "Tax update failed");
    } finally {
      setBusy(false);
    }
  }

  async function confirmNow() {
    const c = confirmAction;
    setConfirmAction(null);
    setConfirmBody("");
    if (c === "deactivate") await runAuth("deactivate", true);
    if (c === "bulk_destructive") await runBulk(true);
    if (c === "tax_update") await saveTax(true);
  }

  return (
    <>
      <section className="pageHero">
        <div>
          <div className="eyebrow">Admin</div>
          <h1 className="pageTitle">Elite operations console</h1>
          <p className="pageLead">Role-gated access, audit trail, and confirmation-protected destructive actions.</p>
        </div>
      </section>

      {confirmAction ? (
        <div className="mobilePanel" style={{ display: "block" }} onClick={() => setConfirmAction(null)}>
          <div className="mobileSheet" role="dialog" onClick={(e) => e.stopPropagation()}>
            <div className="panelTitle">Confirm action</div>
            <div className="panelSub">{confirmBody}</div>
            <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
              <button className="mini" type="button" onClick={() => void confirmNow()}>Confirm</button>
              <button className="mini" type="button" onClick={() => setConfirmAction(null)}>Cancel</button>
            </div>
          </div>
        </div>
      ) : null}

      {!canAdmin ? (
        <section className="marketGrid">
          <div className="marketCard spanFull">
            <div className="marketCardHead">
              <div>
                <div className="panelTitle">Role Admin Login</div>
                <div className="panelSub">Login first. Admin tools unlock only after successful admin session.</div>
              </div>
              <div className="muted mono">not authenticated</div>
            </div>
            <div className="authBody">
              <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))" }}>
                <input value={loginEmail} onChange={(e) => setLoginEmail(e.target.value)} placeholder="admin email" />
                <input type="password" value={loginPassword} onChange={(e) => setLoginPassword(e.target.value)} placeholder="password" />
                <input value={loginAuthCode} onChange={(e) => setLoginAuthCode(e.target.value)} placeholder="AUTH code (default admin can leave blank)" />
              </div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button className="mini" type="button" onClick={() => void signInRoleAdmin()} disabled={busy}>Sign in</button>
                <button className="mini" type="button" onClick={() => void refreshSession()} disabled={busy}>Check admin session</button>
              </div>
              {error ? <div className="authError">{error}</div> : null}
            </div>
          </div>
        </section>
      ) : (

      <section className="marketGrid">
        <div className="marketCard spanFull">
          <div className="marketCardHead">
            <div>
              <div className="panelTitle">Role Admin Login</div>
              <div className="panelSub">Authenticated admin session.</div>
            </div>
            <div className="muted mono">{adminSession?.ok ? `${adminSession.actor} (${adminSession.mode})` : "not authenticated"}</div>
          </div>
          <div className="authBody">
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button className="mini" type="button" onClick={() => void logoutAdmin()} disabled={busy}>Logout</button>
              <button className="mini" type="button" onClick={() => void refreshSession()} disabled={busy}>Check admin session</button>
            </div>
          </div>
        </div>

        <div className="marketCard spanFull">
          <div className="marketCardHead">
            <div>
              <div className="panelTitle">API Key Fallback</div>
              <div className="panelSub">Optional emergency access path.</div>
            </div>
            <div className="muted mono">key: {keyStatus}</div>
          </div>
          <div className="authBody">
            <input type="password" value={adminKey} onChange={(e) => setAdminKey(e.target.value)} placeholder="x-admin-api-key" />
            <div style={{ display: "flex", gap: 10 }}>
              <button className="mini" type="button" onClick={() => { sessionStorage.setItem("admin_api_key", adminKey.trim()); setKeyStatus("ok"); }} disabled={!adminKey.trim()}>Save key</button>
              <button className="mini" type="button" onClick={() => { sessionStorage.removeItem("admin_api_key"); setAdminKey(""); setKeyStatus("idle"); }}>Clear key</button>
            </div>
            {error ? <div className="authError">{error}</div> : null}
          </div>
        </div>

        <div className="marketCard">
          <div className="marketCardHead"><div><div className="panelTitle">AUTH Controls</div><div className="panelSub">Lookup, set, generate, deactivate.</div></div></div>
          <div className="authBody">
            <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="user@gmail.com" />
            <input value={customCode} onChange={(e) => setCustomCode(e.target.value)} placeholder="Custom code (6 chars)" />
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button className="mini" type="button" onClick={() => void runAuth("lookup")} disabled={!authReady || busy}>Lookup</button>
              <button className="mini" type="button" onClick={() => void runAuth("generate")} disabled={!authReady || busy}>Generate</button>
              <button className="mini" type="button" onClick={() => void runAuth("set")} disabled={!authReady || busy || !customCodeValid}>Set</button>
              <button className="mini" type="button" onClick={() => void runAuth("deactivate")} disabled={!authReady || busy}>Deactivate</button>
              <button className="mini" type="button" onClick={() => void runAuth("history")} disabled={!authReady || busy}>History</button>
              <button className="mini" type="button" onClick={() => void runAuth("users")} disabled={!authReady || busy}>Users</button>
            </div>
            {activeCode ? <Notice tone="info" title="Active code"><div className="pairsNote"><span className="mono">{activeCode.auth_code_plain || "--"}</span> ({fmt(activeCode.created_at)})</div></Notice> : null}
            {history.map((h) => <div key={h.id} className="pairsNote"><span className="mono">{fmt(h.created_at)}</span> | <span className="mono">{h.auth_code_plain || "--"}</span> | <span className="mono">{h.is_active ? "active" : "inactive"}</span></div>)}
            {users.map((u) => <div key={u.id} className="pairsNote"><span className="mono">{u.email}</span> | <span className="mono">{u.active_auth_code?.auth_code_plain || "--"}</span></div>)}
          </div>
        </div>

        <div className="marketCard">
          <div className="marketCardHead"><div><div className="panelTitle">Bulk AUTH</div><div className="panelSub">Batch generate/deactivate/lookup.</div></div></div>
          <div className="authBody">
            <textarea rows={5} value={bulkInput} onChange={(e) => setBulkInput(e.target.value)} placeholder="one email per line" />
            <select value={bulkAction} onChange={(e) => setBulkAction(e.target.value as BulkAction)}>
              <option value="generate">generate</option>
              <option value="deactivate">deactivate</option>
              <option value="lookup">lookup</option>
            </select>
            <button className="mini" type="button" onClick={() => void runBulk()} disabled={!canAdmin || !bulkEmails.length || busy}>Run bulk</button>
            {bulkResults.map((r, i) => <div key={`${i}-${r}`} className="pairsNote">{r}</div>)}
          </div>
        </div>

        <div className="marketCard spanFull">
          <div className="marketCardHead"><div><div className="panelTitle">Admin Audit Trail</div><div className="panelSub">Who did what and when.</div></div></div>
          <div className="authBody">
            <button className="mini" type="button" onClick={() => void refreshAudit()} disabled={!canAdmin || busy}>Refresh audit</button>
            {audit.map((a) => <div key={a.id} className="pairsNote"><span className="mono">{fmt(a.created_at)}</span> | <span className="mono">{a.actor}</span> | <span className="mono">{a.action}</span> | <span className="mono">{a.target || "--"}</span></div>)}
          </div>
        </div>

        <div className="marketCard spanFull">
          <div className="marketCardHead"><div><div className="panelTitle">Tax Admin</div><div className="panelSub">Edit with confirmation.</div></div></div>
          <div className="authBody">
            <button className="mini" type="button" onClick={() => void refreshTax()} disabled={!canAdmin || busy}>Refresh tax</button>
            {taxItems.map((it) => (
              <button key={it.id} type="button" className="pairsNote" style={{ textAlign: "left", cursor: "pointer" }} onClick={() => beginTaxEdit(it)}>
                <span className="mono">{it.email || it.user_id}</span> | <span className="mono">{it.amount} {it.asset}</span> | <span className="mono">{it.status}</span>
              </button>
            ))}
            {editingTaxId ? (
              <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
                <input value={editAmount} onChange={(e) => setEditAmount(e.target.value)} placeholder="amount" />
                <input value={editAsset} onChange={(e) => setEditAsset(e.target.value)} placeholder="asset" />
                <input value={editMethod} onChange={(e) => setEditMethod(e.target.value)} placeholder="method" />
                <select value={editStatus} onChange={(e) => setEditStatus(e.target.value)}>
                  <option value="confirmed">confirmed</option>
                  <option value="pending">pending</option>
                  <option value="rejected">rejected</option>
                  <option value="cancelled">cancelled</option>
                </select>
                <input value={editReference} onChange={(e) => setEditReference(e.target.value)} placeholder="reference" />
                <input value={editNote} onChange={(e) => setEditNote(e.target.value)} placeholder="note" />
                <div style={{ display: "flex", gap: 10 }}>
                  <button className="mini" type="button" onClick={() => void saveTax()} disabled={busy}>Save update</button>
                  <button className="mini" type="button" onClick={() => setEditingTaxId("")}>Cancel</button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </section>
      )}
    </>
  );
}
