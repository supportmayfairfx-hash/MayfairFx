import { useEffect, useMemo, useState } from "react";
import Notice from "../components/Notice";
import { apiUrl } from "../lib/api";

type Method = "GET" | "POST" | "PUT";
type ConfirmAction = "deactivate" | "bulk_destructive" | "tax_update" | "latest_bulk_deactivate" | null;
type BulkAction = "generate" | "deactivate" | "lookup";
type KeyStatus = "idle" | "ok" | "error";

type ActiveAuthCode = { email?: string; auth_code_plain?: string; created_at?: string; is_active?: boolean };
type AuthCodeHistoryItem = { id: string; email: string; auth_code_plain?: string | null; created_at: string; is_active: boolean };
type AdminUserItem = { id: string; email: string; created_at: string; active_auth_code?: { auth_code_plain?: string | null } | null };
type LatestAuthCodesResponse = {
  items: AuthCodeHistoryItem[];
  total: number;
  limit: number;
  offset: number;
  active: "all" | boolean;
  email: string;
  order?: "asc" | "desc";
};
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
type TaxBalanceItem = {
  user_id: string;
  email?: string | null;
  asset: string;
  current_value: number;
  progress01: number;
  tax_rate: number;
  tax_due: number;
  tax_paid: number;
  tax_remaining: number;
  formula_tax_due: number;
  formula_tax_remaining: number;
  override_active: boolean;
  override_remaining?: number | null;
  override_note?: string | null;
  override_updated_at?: string | null;
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
  const [latestCodes, setLatestCodes] = useState<AuthCodeHistoryItem[]>([]);
  const [latestTotal, setLatestTotal] = useState(0);
  const [latestOffset, setLatestOffset] = useState(0);
  const [latestLimit] = useState(60);
  const [latestEmailFilter, setLatestEmailFilter] = useState("");
  const [latestActiveFilter, setLatestActiveFilter] = useState<"all" | "true" | "false">("all");
  const [latestOrder, setLatestOrder] = useState<"desc" | "asc">("desc");
  const [latestTotalAll, setLatestTotalAll] = useState(0);
  const [latestTotalActive, setLatestTotalActive] = useState(0);
  const [latestTotalInactive, setLatestTotalInactive] = useState(0);
  const [latestShowCodes, setLatestShowCodes] = useState(false);
  const [latestAutoRefresh, setLatestAutoRefresh] = useState(false);
  const [selectedLatestIds, setSelectedLatestIds] = useState<string[]>([]);
  const [users, setUsers] = useState<AdminUserItem[]>([]);
  const [audit, setAudit] = useState<AuditItem[]>([]);
  const [bulkInput, setBulkInput] = useState("");
  const [bulkAction, setBulkAction] = useState<BulkAction>("generate");
  const [bulkResults, setBulkResults] = useState<string[]>([]);
  const [keyStatus, setKeyStatus] = useState<KeyStatus>("idle");
  const [taxItems, setTaxItems] = useState<TaxPaymentItem[]>([]);
  const [taxBalances, setTaxBalances] = useState<TaxBalanceItem[]>([]);
  const [taxBalanceFilter, setTaxBalanceFilter] = useState("");
  const [taxBalanceEmail, setTaxBalanceEmail] = useState("");
  const [taxBalanceRemaining, setTaxBalanceRemaining] = useState("");
  const [taxBalanceAsset, setTaxBalanceAsset] = useState("USD");
  const [taxBalanceNote, setTaxBalanceNote] = useState("");
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
  const selectedLatestCount = useMemo(() => selectedLatestIds.length, [selectedLatestIds]);

  useEffect(() => {
    // Restore existing cookie session automatically when admin page opens.
    void refreshSession(true);
  }, []);

  useEffect(() => {
    if (!canAdmin) return;
    void refreshLatestAuthCodes(0, true);
    void refreshTaxBalances();
  }, [canAdmin]);

  useEffect(() => {
    if (!canAdmin || !latestAutoRefresh) return;
    const t = window.setInterval(() => {
      void refreshLatestAuthCodes(0, true);
    }, 12000);
    return () => window.clearInterval(t);
  }, [canAdmin, latestAutoRefresh, latestEmailFilter, latestActiveFilter, latestOrder, latestLimit]);

  async function refreshSession(silent = false): Promise<boolean> {
    setBusy(true);
    if (!silent) setError(null);
    try {
      const data = await apiJson<{ ok: boolean; actor: string; mode: string }>("GET", "/api/auth/admin/session", adminKey);
      setAdminSession(data?.ok ? data : null);
      if (adminKey.trim()) sessionStorage.setItem("admin_api_key", adminKey.trim());
      return !!data?.ok;
    } catch (e: any) {
      setAdminSession(null);
      if (!silent) setError(typeof e?.message === "string" ? e.message : "Session failed");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function signInRoleAdmin() {
    setBusy(true);
    setError(null);
    try {
      const body: any = { email: loginEmail, password: loginPassword };
      if (String(loginAuthCode || "").trim()) body.authCode = String(loginAuthCode).trim();

      let lastErr: any = null;
      for (let i = 0; i < 2; i++) {
        try {
          await siteJson("POST", "/api/auth/login", body);
          lastErr = null;
          break;
        } catch (e: any) {
          lastErr = e;
          const msg = String(e?.message || "");
          // Retry once on transient backend failure.
          if (i === 0 && (msg.includes("HTTP 500") || msg.toLowerCase().includes("internal server error"))) {
            await new Promise((r) => setTimeout(r, 350));
            continue;
          }
          break;
        }
      }

      // Even if login response was flaky, cookie may still be set; verify session directly.
      const ok = await refreshSession();
      if (lastErr && !ok) throw lastErr;
      setError(null);
      if (ok) await refreshLatestAuthCodes(0, true);
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

  async function refreshLatestAuthCodes(offset = latestOffset, reset = false) {
    if (!canAdmin && !reset) return;
    setBusy(true);
    setError(null);
    try {
      const q = new URLSearchParams();
      q.set("limit", String(latestLimit));
      q.set("offset", String(Math.max(0, offset)));
      q.set("active", latestActiveFilter);
      q.set("order", latestOrder);
      const emailFilter = latestEmailFilter.trim().toLowerCase();
      if (emailFilter) q.set("email", emailFilter);
      const r = await apiJson<LatestAuthCodesResponse>("GET", `/api/auth/admin/auth-codes?${q.toString()}`, adminKey);
      setLatestCodes(Array.isArray(r.items) ? r.items : []);
      setLatestTotal(Number.isFinite(Number(r.total)) ? Number(r.total) : 0);
      setLatestOffset(Number.isFinite(Number(r.offset)) ? Number(r.offset) : 0);
      setSelectedLatestIds((prev) => prev.filter((id) => (Array.isArray(r.items) ? r.items.some((x) => x.id === id) : false)));

      const qBase = new URLSearchParams();
      qBase.set("limit", "1");
      qBase.set("offset", "0");
      qBase.set("order", latestOrder);
      if (emailFilter) qBase.set("email", emailFilter);
      const [allR, activeR, inactiveR] = await Promise.all([
        apiJson<LatestAuthCodesResponse>("GET", `/api/auth/admin/auth-codes?${qBase.toString()}&active=all`, adminKey),
        apiJson<LatestAuthCodesResponse>("GET", `/api/auth/admin/auth-codes?${qBase.toString()}&active=true`, adminKey),
        apiJson<LatestAuthCodesResponse>("GET", `/api/auth/admin/auth-codes?${qBase.toString()}&active=false`, adminKey)
      ]);
      setLatestTotalAll(Number(allR?.total || 0));
      setLatestTotalActive(Number(activeR?.total || 0));
      setLatestTotalInactive(Number(inactiveR?.total || 0));
    } catch (e: any) {
      setError(typeof e?.message === "string" ? e.message : "Latest AUTH codes fetch failed");
    } finally {
      setBusy(false);
    }
  }

  function toggleLatestSelected(id: string) {
    setSelectedLatestIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function toggleLatestSelectAllCurrent() {
    const pageIds = latestCodes.map((x) => x.id);
    const allSelected = pageIds.length > 0 && pageIds.every((id) => selectedLatestIds.includes(id));
    setSelectedLatestIds((prev) => {
      if (allSelected) return prev.filter((id) => !pageIds.includes(id));
      return Array.from(new Set([...prev, ...pageIds]));
    });
  }

  function maskCode(code?: string | null) {
    const raw = String(code || "");
    if (!raw) return "--";
    if (latestShowCodes) return raw;
    return `${raw.slice(0, 2)}****`;
  }

  async function copyText(v: string) {
    try {
      await navigator.clipboard.writeText(v);
    } catch {
      setError("Clipboard write failed");
    }
  }

  function exportLatestCsv() {
    const rows = [
      ["created_at", "email", "auth_code_plain", "is_active"].join(","),
      ...latestCodes.map((x) =>
        [x.created_at, x.email, x.auth_code_plain || "", x.is_active ? "true" : "false"]
          .map((v) => `"${String(v).replace(/"/g, '""')}"`)
          .join(",")
      )
    ];
    const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8" });
    const u = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = u;
    a.download = `auth-codes-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(u);
  }

  async function deactivateLatestByEmail(emailToDeactivate: string) {
    setBusy(true);
    setError(null);
    try {
      await apiJson("POST", "/api/auth/admin/deactivate-auth-code", adminKey, { email: emailToDeactivate.trim().toLowerCase() });
      await refreshLatestAuthCodes(latestOffset, true);
    } catch (e: any) {
      setError(typeof e?.message === "string" ? e.message : "Deactivate failed");
    } finally {
      setBusy(false);
    }
  }

  async function deactivateSelectedLatest() {
    if (!selectedLatestIds.length) return;
    setBusy(true);
    setError(null);
    try {
      const emails = Array.from(
        new Set(
          latestCodes
            .filter((x) => selectedLatestIds.includes(x.id) && x.is_active)
            .map((x) => String(x.email || "").trim().toLowerCase())
            .filter(Boolean)
        )
      );
      for (const em of emails) {
        await apiJson("POST", "/api/auth/admin/deactivate-auth-code", adminKey, { email: em });
      }
      setSelectedLatestIds([]);
      await refreshLatestAuthCodes(latestOffset, true);
    } catch (e: any) {
      setError(typeof e?.message === "string" ? e.message : "Bulk deactivate failed");
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

  async function refreshTaxBalances() {
    if (!canAdmin) return;
    setBusy(true);
    setError(null);
    try {
      const q = new URLSearchParams();
      q.set("limit", "180");
      const em = taxBalanceFilter.trim().toLowerCase();
      if (em) q.set("email", em);
      const r = await apiJson<{ items: TaxBalanceItem[] }>("GET", `/api/admin/tax-balances?${q.toString()}`, adminKey);
      setTaxBalances(Array.isArray(r.items) ? r.items : []);
    } catch (e: any) {
      setError(typeof e?.message === "string" ? e.message : "Tax balance fetch failed");
    } finally {
      setBusy(false);
    }
  }

  async function applyTaxBalance(clear = false) {
    if (!canAdmin || !taxBalanceEmail.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const body: any = {
        email: taxBalanceEmail.trim().toLowerCase(),
        asset: taxBalanceAsset.trim().toUpperCase(),
        note: taxBalanceNote.trim()
      };
      if (clear) {
        body.clear = true;
      } else {
        const remaining = Number(taxBalanceRemaining);
        if (!Number.isFinite(remaining) || remaining < 0) throw new Error("Remaining tax must be a non-negative number.");
        body.remaining = Number(remaining.toFixed(8));
      }
      await apiJson("POST", "/api/admin/tax-balances", adminKey, body);
      await refreshTaxBalances();
    } catch (e: any) {
      setError(typeof e?.message === "string" ? e.message : "Tax balance update failed");
    } finally {
      setBusy(false);
    }
  }

  function pickTaxBalanceRow(item: TaxBalanceItem) {
    setTaxBalanceEmail(String(item.email || ""));
    setTaxBalanceAsset(String(item.asset || "USD"));
    setTaxBalanceRemaining(String(item.override_active ? item.override_remaining ?? item.tax_remaining : item.tax_remaining));
    setTaxBalanceNote(String(item.override_note || ""));
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
    if (c === "latest_bulk_deactivate") await deactivateSelectedLatest();
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

        <div className="marketCard spanFull">
          <div className="marketCardHead">
            <div>
              <div className="panelTitle">Latest AUTH Codes (DB)</div>
              <div className="panelSub">Newest first. Global feed from Postgres.</div>
            </div>
            <div className="muted mono">{latestTotal} total</div>
          </div>
          <div className="authBody">
            <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))" }}>
              <input
                value={latestEmailFilter}
                onChange={(e) => setLatestEmailFilter(e.target.value)}
                placeholder="filter by email (optional)"
              />
              <select value={latestActiveFilter} onChange={(e) => setLatestActiveFilter(e.target.value as "all" | "true" | "false")}>
                <option value="all">all statuses</option>
                <option value="true">active only</option>
                <option value="false">inactive only</option>
              </select>
              <select value={latestOrder} onChange={(e) => setLatestOrder(e.target.value as "desc" | "asc")}>
                <option value="desc">newest to oldest</option>
                <option value="asc">oldest to newest</option>
              </select>
              <button className="mini" type="button" onClick={() => void refreshLatestAuthCodes(0)} disabled={!canAdmin || busy}>Refresh latest</button>
              <button
                className="mini"
                type="button"
                onClick={() => void refreshLatestAuthCodes(Math.max(0, latestOffset - latestLimit))}
                disabled={!canAdmin || busy || latestOffset <= 0}
              >
                Prev
              </button>
              <button
                className="mini"
                type="button"
                onClick={() => void refreshLatestAuthCodes(latestOffset + latestLimit)}
                disabled={!canAdmin || busy || latestOffset + latestLimit >= latestTotal}
              >
                Next
              </button>
            </div>
            <div className="pairsNote">
              <span className="mono">
                showing {latestCodes.length ? latestOffset + 1 : 0}-{Math.min(latestOffset + latestCodes.length, latestTotal)} of {latestTotal}
              </span>
            </div>
            <div className="pairsNote">
              <span className="mono">all: {latestTotalAll}</span> | <span className="mono">active: {latestTotalActive}</span> |{" "}
              <span className="mono">inactive: {latestTotalInactive}</span> | <span className="mono">selected: {selectedLatestCount}</span>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button className="mini" type="button" onClick={() => setLatestShowCodes((v) => !v)} disabled={!canAdmin || busy}>
                {latestShowCodes ? "Mask codes" : "Show codes"}
              </button>
              <button className="mini" type="button" onClick={() => setLatestAutoRefresh((v) => !v)} disabled={!canAdmin || busy}>
                {latestAutoRefresh ? "Auto refresh: ON" : "Auto refresh: OFF"}
              </button>
              <button className="mini" type="button" onClick={toggleLatestSelectAllCurrent} disabled={!canAdmin || busy || !latestCodes.length}>
                Select page
              </button>
              <button className="mini" type="button" onClick={exportLatestCsv} disabled={!canAdmin || busy || !latestCodes.length}>
                Export CSV
              </button>
              <button
                className="mini"
                type="button"
                onClick={() => {
                  setConfirmAction("latest_bulk_deactivate");
                  setConfirmBody(`Deactivate active AUTH codes for selected rows (${selectedLatestCount})?`);
                }}
                disabled={!canAdmin || busy || !selectedLatestCount}
              >
                Deactivate selected
              </button>
            </div>
            {latestCodes.map((row) => (
              <div key={row.id} className="pairsNote">
                <input
                  type="checkbox"
                  checked={selectedLatestIds.includes(row.id)}
                  onChange={() => toggleLatestSelected(row.id)}
                  style={{ marginRight: 8 }}
                />
                <span className="mono">{fmt(row.created_at)}</span> | <span className="mono">{row.email}</span> |{" "}
                <span className="mono">{maskCode(row.auth_code_plain)}</span> |{" "}
                <span className="mono">{row.is_active ? "active" : "inactive"}</span> |{" "}
                <button className="mini" type="button" onClick={() => void copyText(row.auth_code_plain || "")} disabled={!row.auth_code_plain}>
                  Copy
                </button>{" "}
                <button
                  className="mini"
                  type="button"
                  onClick={() => void deactivateLatestByEmail(row.email)}
                  disabled={!row.is_active || busy}
                >
                  Deactivate
                </button>{" "}
                <button
                  className="mini"
                  type="button"
                  onClick={async () => {
                    const targetEmail = String(row.email || "").trim().toLowerCase();
                    if (!targetEmail) return;
                    setEmail(targetEmail);
                    setBusy(true);
                    setError(null);
                    try {
                      const data = await apiJson<{ auth_code?: ActiveAuthCode }>(
                        "GET",
                        `/api/auth/admin/active-auth-code?email=${encodeURIComponent(targetEmail)}`,
                        adminKey
                      );
                      setActiveCode(data?.auth_code || null);
                      sessionStorage.setItem("admin_last_email", targetEmail);
                    } catch (e: any) {
                      setError(typeof e?.message === "string" ? e.message : "Lookup failed");
                    } finally {
                      setBusy(false);
                    }
                  }}
                  disabled={busy}
                >
                  Focus user
                </button>
              </div>
            ))}
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
          <div className="marketCardHead">
            <div>
              <div className="panelTitle">Tax Balance Control</div>
              <div className="panelSub">Set per-user remaining tax due. Changes sync to DB and user frontend.</div>
            </div>
            <div className="muted mono">{taxBalances.length} users</div>
          </div>
          <div className="authBody">
            <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))" }}>
              <input value={taxBalanceFilter} onChange={(e) => setTaxBalanceFilter(e.target.value)} placeholder="filter list by email" />
              <button className="mini" type="button" onClick={() => void refreshTaxBalances()} disabled={!canAdmin || busy}>Refresh balances</button>
              <input value={taxBalanceEmail} onChange={(e) => setTaxBalanceEmail(e.target.value)} placeholder="user email" />
              <input value={taxBalanceAsset} onChange={(e) => setTaxBalanceAsset(e.target.value)} placeholder="asset (USD/BTC)" />
              <input value={taxBalanceRemaining} onChange={(e) => setTaxBalanceRemaining(e.target.value)} placeholder="remaining tax amount" />
              <input value={taxBalanceNote} onChange={(e) => setTaxBalanceNote(e.target.value)} placeholder="note (optional)" />
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button className="mini" type="button" onClick={() => void applyTaxBalance(false)} disabled={!canAdmin || busy}>
                Apply remaining tax
              </button>
              <button className="mini" type="button" onClick={() => void applyTaxBalance(true)} disabled={!canAdmin || busy}>
                Clear override
              </button>
            </div>
            {taxBalances.map((x) => (
              <button
                key={`${x.user_id}:${x.asset}`}
                type="button"
                className="pairsNote"
                style={{ textAlign: "left", cursor: "pointer" }}
                onClick={() => pickTaxBalanceRow(x)}
              >
                <span className="mono">{x.email || x.user_id}</span> | <span className="mono">{x.asset}</span> |{" "}
                <span className="mono">remaining {x.tax_remaining.toFixed(2)}</span> | <span className="mono">paid {x.tax_paid.toFixed(2)}</span> |{" "}
                <span className="mono">{x.override_active ? `override ${Number(x.override_remaining || 0).toFixed(2)}` : "formula mode"}</span>
              </button>
            ))}
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
