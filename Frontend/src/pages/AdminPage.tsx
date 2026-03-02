import { useEffect, useMemo, useRef, useState } from "react";
import Notice from "../components/Notice";
import { apiUrl } from "../lib/api";

type Method = "GET" | "POST" | "PUT";
type ConfirmAction = "deactivate" | "bulk_destructive" | "tax_update" | "latest_bulk_deactivate" | "tax_reset" | null;
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
type TaxResetUndo = {
  user_id: string;
  email: string;
  asset: string;
  previous_remaining: number;
  expires_at: number;
};
type AdminOverview = {
  generated_at: string;
  db_mode: string;
  kpis: {
    total_users: number;
    active_auth_codes: number;
    auth_code_rows: number;
    override_rows: number;
    override_active_users: number;
    users_with_tax_due: number;
    total_tax_remaining: number;
    total_tax_paid: number;
    audits_24h: number;
  };
  alerts: string[];
  top_tax_due: Array<{
    user_id: string;
    email?: string | null;
    asset: string;
    tax_due: number;
    tax_paid: number;
    tax_remaining: number;
    override_active: boolean;
    override_updated_at?: string | null;
  }>;
  recent_audit: Array<{ id: string; actor: string; action: string; target?: string; created_at: string }>;
};
type User360 = {
  user: { id: string; email?: string | null };
  crm_profile?: { tags?: string[]; status?: string | null; score?: number; updated_at?: string | null };
  notes?: Array<{ id: string; author?: string | null; note: string; created_at: string }>;
  auth_history?: Array<{ id: string; created_at: string; auth_code_plain?: string | null; is_active?: boolean }>;
  withdrawals?: Array<{ id: string; amount: number; asset: string; status: string; created_at: string }>;
  tax_payments?: Array<{ id: string; amount: number; asset: string; status: string; created_at: string }>;
  tax_snapshot?: { tax_due: number; tax_paid: number; tax_remaining: number; override_active?: boolean };
};
type AutomationRule = { id: string; name: string; enabled: boolean; config?: any; created_at?: string; updated_at?: string };
type AutomationRun = { id: string; rule_id?: string | null; status: string; result?: any; created_at: string };
type CommsTemplate = { id: string; name: string; channel: string; subject?: string | null; body: string; updated_at?: string };
type CommsCampaign = {
  id: string;
  template_id?: string | null;
  channel: string;
  audience?: string | null;
  status: string;
  sent_count: number;
  failed_count: number;
  created_at: string;
};
type Reconciliation = {
  generated_at: string;
  tax_collections: { d1: number; d7: number; d30: number };
  withdrawals: { d1: number; d7: number; d30: number };
  deltas: { d1: number; d7: number; d30: number };
};
type Revenue = {
  generated_at: string;
  subs_total?: number;
  subs_active: number;
  monthly_revenue: number;
  arpu: number;
  ltv_estimate: number;
  referral_count?: number;
  referral_commissions_total: number;
};

async function apiJson<T>(method: Method, path: string, adminKey: string, body?: any): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (method !== "GET") headers["Content-Type"] = "application/json";
  if (adminKey.trim()) headers["x-admin-api-key"] = adminKey.trim();
  const res = await fetch(apiUrl(path), {
    method,
    credentials: "include",
    cache: "no-store",
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
    cache: "no-store",
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

const ADMIN_SESSION_CACHE_KEY = "admin_role_session";

export default function AdminPage() {
  const TAX_RESET_UNDO_WINDOW_MS = 12000;
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
  const [latestAutoRefresh, setLatestAutoRefresh] = useState(true);
  const [selectedLatestIds, setSelectedLatestIds] = useState<string[]>([]);
  const [users, setUsers] = useState<AdminUserItem[]>([]);
  const [audit, setAudit] = useState<AuditItem[]>([]);
  const [bulkInput, setBulkInput] = useState("");
  const [bulkAction, setBulkAction] = useState<BulkAction>("generate");
  const [bulkResults, setBulkResults] = useState<string[]>([]);
  const [keyStatus, setKeyStatus] = useState<KeyStatus>("idle");
  const [taxItems, setTaxItems] = useState<TaxPaymentItem[]>([]);
  const [taxBalances, setTaxBalances] = useState<TaxBalanceItem[]>([]);
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [overviewAutoRefresh, setOverviewAutoRefresh] = useState(true);
  const [user360Email, setUser360Email] = useState("");
  const [user360Note, setUser360Note] = useState("");
  const [user360Tags, setUser360Tags] = useState("");
  const [user360Status, setUser360Status] = useState("");
  const [user360Score, setUser360Score] = useState("0");
  const [user360Data, setUser360Data] = useState<User360 | null>(null);
  const [automationRules, setAutomationRules] = useState<AutomationRule[]>([]);
  const [automationRuns, setAutomationRuns] = useState<AutomationRun[]>([]);
  const [automationName, setAutomationName] = useState("");
  const [automationConfig, setAutomationConfig] = useState("{\"condition\":\"tax_remaining_gt\",\"value\":1000}");
  const [automationSelectedRuleId, setAutomationSelectedRuleId] = useState("");
  const [commsTemplates, setCommsTemplates] = useState<CommsTemplate[]>([]);
  const [commsCampaigns, setCommsCampaigns] = useState<CommsCampaign[]>([]);
  const [commsTemplateName, setCommsTemplateName] = useState("");
  const [commsTemplateChannel, setCommsTemplateChannel] = useState("email");
  const [commsTemplateSubject, setCommsTemplateSubject] = useState("");
  const [commsTemplateBody, setCommsTemplateBody] = useState("");
  const [commsCampaignTemplateId, setCommsCampaignTemplateId] = useState("");
  const [commsCampaignAudience, setCommsCampaignAudience] = useState("all_users");
  const [reconciliation, setReconciliation] = useState<Reconciliation | null>(null);
  const [revenue, setRevenue] = useState<Revenue | null>(null);
  const [subEmail, setSubEmail] = useState("");
  const [subPlan, setSubPlan] = useState("pro");
  const [subPrice, setSubPrice] = useState("99");
  const [referrerEmail, setReferrerEmail] = useState("");
  const [referredEmail, setReferredEmail] = useState("");
  const [refEarned, setRefEarned] = useState("0");
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
  const [confirmToken, setConfirmToken] = useState("");
  const [pendingTaxReset, setPendingTaxReset] = useState<TaxBalanceItem | null>(null);
  const [undoTaxReset, setUndoTaxReset] = useState<TaxResetUndo | null>(null);
  const [undoNowTick, setUndoNowTick] = useState(() => Date.now());
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const undoTimerRef = useRef<number | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  const emailNorm = useMemo(() => email.trim().toLowerCase(), [email]);
  const canAdmin = useMemo(() => !!adminSession?.ok, [adminSession?.ok]);
  const authReady = useMemo(() => canAdmin && !!emailNorm, [canAdmin, emailNorm]);
  const bulkEmails = useMemo(() => normEmails(bulkInput), [bulkInput]);
  const customCodeValid = useMemo(() => /^[A-Za-z0-9]{6}$/.test(customCode.trim()), [customCode]);
  const selectedLatestCount = useMemo(() => selectedLatestIds.length, [selectedLatestIds]);
  const confirmReady = useMemo(() => {
    if (confirmAction !== "tax_reset") return true;
    return confirmToken.trim().toUpperCase() === "RESET";
  }, [confirmAction, confirmToken]);
  const undoSecondsLeft = useMemo(() => {
    if (!undoTaxReset) return 0;
    return Math.max(0, Math.ceil((undoTaxReset.expires_at - undoNowTick) / 1000));
  }, [undoNowTick, undoTaxReset]);

  function closeConfirm() {
    setConfirmAction(null);
    setConfirmBody("");
    setConfirmToken("");
    setPendingTaxReset(null);
  }

  function pushToast(msg: string) {
    setToastMsg(msg);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToastMsg(null), 3500);
  }

  function replaceUndoWindow(payload: Omit<TaxResetUndo, "expires_at">) {
    if (undoTimerRef.current) window.clearTimeout(undoTimerRef.current);
    const expiresAt = Date.now() + TAX_RESET_UNDO_WINDOW_MS;
    setUndoTaxReset({ ...payload, expires_at: expiresAt });
    setUndoNowTick(Date.now());
    undoTimerRef.current = window.setTimeout(() => {
      setUndoTaxReset(null);
      undoTimerRef.current = null;
    }, TAX_RESET_UNDO_WINDOW_MS);
  }

  useEffect(() => {
    // Restore existing session cache immediately, then verify against backend.
    try {
      const raw = sessionStorage.getItem(ADMIN_SESSION_CACHE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed?.ok && parsed?.actor && parsed?.mode) setAdminSession(parsed);
      }
    } catch {}
    void refreshSession(true, { preserveOnError: true, retries: 3 });
  }, []);

  useEffect(() => {
    if (!undoTaxReset) return;
    const timer = window.setInterval(() => setUndoNowTick(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [undoTaxReset]);

  useEffect(() => {
    return () => {
      if (undoTimerRef.current) window.clearTimeout(undoTimerRef.current);
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!adminSession?.ok) return;
    void refreshLatestAuthCodes(0, true);
    void refreshTaxBalances();
    void refreshOverview();
    void refreshAutomations();
    void refreshComms();
    void refreshFinance();
  }, [adminSession]);

  useEffect(() => {
    if (!canAdmin || !overviewAutoRefresh) return;
    const t = window.setInterval(() => {
      void refreshOverview(true);
    }, 15000);
    return () => window.clearInterval(t);
  }, [canAdmin, overviewAutoRefresh]);

  useEffect(() => {
    if (!canAdmin || !latestAutoRefresh) return;
    const t = window.setInterval(() => {
      void refreshLatestAuthCodes(0, true, true);
    }, 4000);
    return () => window.clearInterval(t);
  }, [canAdmin, latestAutoRefresh, latestEmailFilter, latestActiveFilter, latestOrder, latestLimit]);

  useEffect(() => {
    if (!canAdmin) return;
    const onFocus = () => void refreshLatestAuthCodes(0, true, true);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshLatestAuthCodes(0, true, true);
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [canAdmin, latestEmailFilter, latestActiveFilter, latestOrder, latestLimit]);

  async function refreshSession(
    silent = false,
    opts: { preserveOnError?: boolean; retries?: number } = {}
  ): Promise<boolean> {
    let preserveOnError = !!opts.preserveOnError;
    const retries = Math.max(1, Math.min(4, Number(opts.retries || 1)));
    setBusy(true);
    if (!silent) setError(null);
    let lastErr: any = null;
    for (let i = 0; i < retries; i++) {
      try {
        const data = await apiJson<{ ok: boolean; actor: string; mode: string }>("GET", "/api/auth/admin/session", adminKey);
        if (data?.ok) {
          setAdminSession(data);
          try {
            sessionStorage.setItem(ADMIN_SESSION_CACHE_KEY, JSON.stringify(data));
          } catch {}
          if (adminKey.trim()) sessionStorage.setItem("admin_api_key", adminKey.trim());
          setBusy(false);
          return true;
        }
      } catch (e: any) {
        lastErr = e;
        const msg = String(e?.message || "").toLowerCase();
        // If backend confirms unauthorized, do not keep stale cached session.
        if (msg.includes("unauthorized") || msg.includes("http 401")) preserveOnError = false;
        if (i < retries - 1) await new Promise((r) => setTimeout(r, 260));
      }
    }
    if (!preserveOnError) {
      setAdminSession(null);
      try {
        sessionStorage.removeItem(ADMIN_SESSION_CACHE_KEY);
      } catch {}
    }
    if (!silent && !preserveOnError) {
      setError(typeof lastErr?.message === "string" ? lastErr.message : "Session failed");
    }
    setBusy(false);
    return false;
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
      const ok = await refreshSession(false, { preserveOnError: false, retries: 3 });
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
      try {
        sessionStorage.removeItem(ADMIN_SESSION_CACHE_KEY);
      } catch {}
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
        await refreshLatestAuthCodes(0, true);
      } else if (action === "set") {
        await apiJson("POST", "/api/auth/admin/auth-codes", adminKey, { email: emailNorm, authCode: customCode.trim() });
        await runAuth("lookup", true);
        await refreshLatestAuthCodes(0, true);
      } else if (action === "deactivate") {
        await apiJson("POST", "/api/auth/admin/deactivate-auth-code", adminKey, { email: emailNorm });
        setActiveCode(null);
        await refreshLatestAuthCodes(0, true);
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
      await refreshLatestAuthCodes(0, true);
    } finally {
      setBusy(false);
    }
  }

  async function refreshLatestAuthCodes(offset = latestOffset, reset = false, silent = false) {
    if (!canAdmin && !reset) return;
    if (!silent) {
      setBusy(true);
      setError(null);
    }
    try {
      const q = new URLSearchParams();
      q.set("limit", String(latestLimit));
      q.set("offset", String(Math.max(0, offset)));
      q.set("active", latestActiveFilter);
      q.set("order", latestOrder);
      q.set("ts", String(Date.now()));
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
      if (!silent) setError(typeof e?.message === "string" ? e.message : "Latest AUTH codes fetch failed");
    } finally {
      if (!silent) setBusy(false);
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

  async function refreshOverview(silent = false) {
    if (!canAdmin) return;
    if (!silent) {
      setBusy(true);
      setError(null);
    }
    try {
      const r = await apiJson<AdminOverview>("GET", "/api/admin/overview?limit=8", adminKey);
      setOverview(r && typeof r === "object" ? r : null);
    } catch (e: any) {
      if (!silent) setError(typeof e?.message === "string" ? e.message : "Overview fetch failed");
    } finally {
      if (!silent) setBusy(false);
    }
  }

  function parseConfigJson(raw: string) {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      throw new Error("Automation config must be valid JSON.");
    }
  }

  async function loadUser360() {
    if (!canAdmin || !user360Email.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await apiJson<User360>("GET", `/api/admin/user-360?email=${encodeURIComponent(user360Email.trim().toLowerCase())}`, adminKey);
      setUser360Data(r || null);
      const p = r?.crm_profile || {};
      setUser360Tags(Array.isArray(p.tags) ? p.tags.join(", ") : "");
      setUser360Status(String(p.status || ""));
      setUser360Score(String(Number(p.score || 0)));
    } catch (e: any) {
      setError(typeof e?.message === "string" ? e.message : "User 360 load failed");
    } finally {
      setBusy(false);
    }
  }

  async function saveCrmProfile() {
    if (!canAdmin || !user360Email.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await apiJson("POST", "/api/admin/crm/profile", adminKey, {
        email: user360Email.trim().toLowerCase(),
        tags: user360Tags,
        status: user360Status,
        score: Number(user360Score || 0)
      });
      await loadUser360();
    } catch (e: any) {
      setError(typeof e?.message === "string" ? e.message : "CRM profile save failed");
    } finally {
      setBusy(false);
    }
  }

  async function addCrmNote() {
    if (!canAdmin || !user360Email.trim() || !user360Note.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await apiJson("POST", "/api/admin/crm/note", adminKey, {
        email: user360Email.trim().toLowerCase(),
        note: user360Note.trim()
      });
      setUser360Note("");
      await loadUser360();
    } catch (e: any) {
      setError(typeof e?.message === "string" ? e.message : "CRM note save failed");
    } finally {
      setBusy(false);
    }
  }

  async function refreshAutomations() {
    if (!canAdmin) return;
    setBusy(true);
    setError(null);
    try {
      const [rulesR, runsR] = await Promise.all([
        apiJson<{ items: AutomationRule[] }>("GET", "/api/admin/automations/rules", adminKey),
        apiJson<{ items: AutomationRun[] }>("GET", "/api/admin/automations/runs?limit=80", adminKey)
      ]);
      setAutomationRules(Array.isArray(rulesR.items) ? rulesR.items : []);
      setAutomationRuns(Array.isArray(runsR.items) ? runsR.items : []);
    } catch (e: any) {
      setError(typeof e?.message === "string" ? e.message : "Automation fetch failed");
    } finally {
      setBusy(false);
    }
  }

  async function saveAutomationRule() {
    if (!canAdmin || !automationName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await apiJson("POST", "/api/admin/automations/rules", adminKey, {
        id: automationSelectedRuleId || undefined,
        name: automationName.trim(),
        enabled: true,
        config: parseConfigJson(automationConfig)
      });
      setAutomationName("");
      setAutomationSelectedRuleId("");
      await refreshAutomations();
    } catch (e: any) {
      setError(typeof e?.message === "string" ? e.message : "Automation rule save failed");
    } finally {
      setBusy(false);
    }
  }

  async function runAutomationRule(ruleId: string) {
    if (!canAdmin || !ruleId) return;
    setBusy(true);
    setError(null);
    try {
      await apiJson("POST", "/api/admin/automations/run", adminKey, { ruleId });
      await refreshAutomations();
    } catch (e: any) {
      setError(typeof e?.message === "string" ? e.message : "Automation run failed");
    } finally {
      setBusy(false);
    }
  }

  async function refreshComms() {
    if (!canAdmin) return;
    setBusy(true);
    setError(null);
    try {
      const [tR, cR] = await Promise.all([
        apiJson<{ items: CommsTemplate[] }>("GET", "/api/admin/comms/templates", adminKey),
        apiJson<{ items: CommsCampaign[] }>("GET", "/api/admin/comms/campaigns", adminKey)
      ]);
      setCommsTemplates(Array.isArray(tR.items) ? tR.items : []);
      setCommsCampaigns(Array.isArray(cR.items) ? cR.items : []);
    } catch (e: any) {
      setError(typeof e?.message === "string" ? e.message : "Comms fetch failed");
    } finally {
      setBusy(false);
    }
  }

  async function saveCommsTemplate() {
    if (!canAdmin || !commsTemplateName.trim() || !commsTemplateBody.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await apiJson("POST", "/api/admin/comms/templates", adminKey, {
        name: commsTemplateName.trim(),
        channel: commsTemplateChannel,
        subject: commsTemplateSubject.trim(),
        body: commsTemplateBody.trim()
      });
      setCommsTemplateName("");
      setCommsTemplateSubject("");
      setCommsTemplateBody("");
      await refreshComms();
    } catch (e: any) {
      setError(typeof e?.message === "string" ? e.message : "Template save failed");
    } finally {
      setBusy(false);
    }
  }

  async function sendCampaign() {
    if (!canAdmin) return;
    setBusy(true);
    setError(null);
    try {
      await apiJson("POST", "/api/admin/comms/campaigns", adminKey, {
        templateId: commsCampaignTemplateId || null,
        channel: commsTemplateChannel,
        audience: commsCampaignAudience
      });
      await refreshComms();
    } catch (e: any) {
      setError(typeof e?.message === "string" ? e.message : "Campaign send failed");
    } finally {
      setBusy(false);
    }
  }

  async function refreshFinance() {
    if (!canAdmin) return;
    setBusy(true);
    setError(null);
    try {
      const [recR, revR] = await Promise.all([
        apiJson<Reconciliation>("GET", "/api/admin/reconciliation", adminKey),
        apiJson<Revenue>("GET", "/api/admin/revenue", adminKey)
      ]);
      setReconciliation(recR || null);
      setRevenue(revR || null);
    } catch (e: any) {
      setError(typeof e?.message === "string" ? e.message : "Finance dashboard fetch failed");
    } finally {
      setBusy(false);
    }
  }

  async function createSubscription() {
    if (!canAdmin || !subEmail.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await apiJson("POST", "/api/admin/revenue/subscription", adminKey, {
        email: subEmail.trim().toLowerCase(),
        plan: subPlan,
        status: "active",
        price: Number(subPrice || 0),
        currency: "USD"
      });
      await refreshFinance();
    } catch (e: any) {
      setError(typeof e?.message === "string" ? e.message : "Subscription create failed");
    } finally {
      setBusy(false);
    }
  }

  async function createReferral() {
    if (!canAdmin || !referrerEmail.trim() || !referredEmail.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await apiJson("POST", "/api/admin/revenue/referral", adminKey, {
        referrerEmail: referrerEmail.trim().toLowerCase(),
        referredEmail: referredEmail.trim().toLowerCase(),
        commissionRate: 0.1,
        earnedTotal: Number(refEarned || 0)
      });
      await refreshFinance();
    } catch (e: any) {
      setError(typeof e?.message === "string" ? e.message : "Referral create failed");
    } finally {
      setBusy(false);
    }
  }

  async function exportInvestorReport(format: "json" | "csv") {
    if (!canAdmin) return;
    try {
      if (format === "json") {
        const r = await apiJson<any>("GET", "/api/admin/reports/investor?format=json", adminKey);
        const blob = new Blob([JSON.stringify(r, null, 2)], { type: "application/json;charset=utf-8" });
        const u = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = u;
        a.download = `investor-report-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(u);
        return;
      }
      const headers: Record<string, string> = { Accept: "text/csv" };
      if (adminKey.trim()) headers["x-admin-api-key"] = adminKey.trim();
      const res = await fetch(apiUrl("/api/admin/reports/investor?format=csv"), {
        method: "GET",
        credentials: "include",
        headers
      });
      const text = await res.text();
      if (!res.ok) throw new Error(text || `HTTP ${res.status}`);
      const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
      const u = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = u;
      a.download = `investor-report-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(u);
    } catch (e: any) {
      setError(typeof e?.message === "string" ? e.message : "Investor report export failed");
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

  async function resetTaxBalanceForUser(item: TaxBalanceItem) {
    if (!canAdmin) return;
    setBusy(true);
    setError(null);
    try {
      await apiJson("POST", "/api/admin/tax-balances", adminKey, {
        userId: item.user_id,
        remaining: 0,
        note: "reset_to_zero_from_list"
      });
      if (String(item.email || "").trim()) {
        setTaxBalanceEmail(String(item.email || ""));
      }
      replaceUndoWindow({
        user_id: item.user_id,
        email: String(item.email || item.user_id),
        asset: String(item.asset || "USD").toUpperCase(),
        previous_remaining: Number(item.tax_remaining || 0)
      });
      pushToast(`Tax reset to 0 for ${String(item.email || item.user_id)}.`);
      await Promise.all([refreshTaxBalances(), refreshOverview(true), refreshFinance()]);
    } catch (e: any) {
      setError(typeof e?.message === "string" ? e.message : "Tax reset failed");
    } finally {
      setBusy(false);
    }
  }

  function requestTaxReset(item: TaxBalanceItem) {
    setPendingTaxReset(item);
    setConfirmAction("tax_reset");
    setConfirmToken("");
    setConfirmBody(
      `Type RESET to zero tax for ${String(item.email || item.user_id)} (${String(item.asset || "USD").toUpperCase()}).`
    );
  }

  async function undoLastTaxReset() {
    if (!canAdmin || !undoTaxReset) return;
    setBusy(true);
    setError(null);
    try {
      await apiJson("POST", "/api/admin/tax-balances", adminKey, {
        userId: undoTaxReset.user_id,
        asset: undoTaxReset.asset,
        remaining: Number(Number(undoTaxReset.previous_remaining || 0).toFixed(8)),
        note: "undo_reset_to_zero"
      });
      pushToast(`Undo complete for ${undoTaxReset.email}.`);
      setUndoTaxReset(null);
      if (undoTimerRef.current) {
        window.clearTimeout(undoTimerRef.current);
        undoTimerRef.current = null;
      }
      await Promise.all([refreshTaxBalances(), refreshOverview(true), refreshFinance()]);
    } catch (e: any) {
      setError(typeof e?.message === "string" ? e.message : "Undo tax reset failed");
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
    const resetTarget = pendingTaxReset;
    closeConfirm();
    if (c === "deactivate") await runAuth("deactivate", true);
    if (c === "bulk_destructive") await runBulk(true);
    if (c === "tax_update") await saveTax(true);
    if (c === "latest_bulk_deactivate") await deactivateSelectedLatest();
    if (c === "tax_reset" && resetTarget) await resetTaxBalanceForUser(resetTarget);
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
        <div className="mobilePanel" style={{ display: "block" }} onClick={closeConfirm}>
          <div className="mobileSheet" role="dialog" onClick={(e) => e.stopPropagation()}>
            <div className="panelTitle">Confirm action</div>
            <div className="panelSub">{confirmBody}</div>
            {confirmAction === "tax_reset" ? (
              <div style={{ marginTop: 10 }}>
                <input value={confirmToken} onChange={(e) => setConfirmToken(e.target.value)} placeholder="Type RESET to confirm" />
              </div>
            ) : null}
            <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
              <button className="mini" type="button" onClick={() => void confirmNow()} disabled={!confirmReady}>Confirm</button>
              <button className="mini" type="button" onClick={closeConfirm}>Cancel</button>
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

        {toastMsg ? (
          <div className="marketCard spanFull">
            <Notice tone="info" title="Action completed">{toastMsg}</Notice>
          </div>
        ) : null}

        {undoTaxReset ? (
          <div className="marketCard spanFull">
            <Notice
              tone="warn"
              title="Tax reset applied"
              actions={
                <button className="mini" type="button" onClick={() => void undoLastTaxReset()} disabled={busy || undoSecondsLeft <= 0}>
                  Undo ({undoSecondsLeft}s)
                </button>
              }
            >
              <div className="pairsNote">
                <span className="mono">{undoTaxReset.email}</span> | <span className="mono">{undoTaxReset.asset}</span> |{" "}
                <span className="mono">previous {Number(undoTaxReset.previous_remaining || 0).toFixed(2)}</span>
              </div>
            </Notice>
          </div>
        ) : null}

        <div className="marketCard spanFull">
          <div className="marketCardHead">
            <div>
              <div className="panelTitle">Executive Overview</div>
              <div className="panelSub">Live operations metrics, exposure ranking, and audit pulse.</div>
            </div>
            <div className="muted mono">{overview?.db_mode || "db: --"}</div>
          </div>
          <div className="authBody">
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button className="mini" type="button" onClick={() => void refreshOverview()} disabled={!canAdmin || busy}>Refresh overview</button>
              <button className="mini" type="button" onClick={() => setOverviewAutoRefresh((v) => !v)} disabled={!canAdmin || busy}>
                {overviewAutoRefresh ? "Auto: ON" : "Auto: OFF"}
              </button>
              <span className="pairsNote mono">updated: {fmt(overview?.generated_at)}</span>
            </div>

            <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))" }}>
              <div className="pairsNote"><span className="mono">users</span> | <span className="mono">{overview?.kpis?.total_users ?? "--"}</span></div>
              <div className="pairsNote"><span className="mono">active codes</span> | <span className="mono">{overview?.kpis?.active_auth_codes ?? "--"}</span></div>
              <div className="pairsNote"><span className="mono">tax due users</span> | <span className="mono">{overview?.kpis?.users_with_tax_due ?? "--"}</span></div>
              <div className="pairsNote"><span className="mono">override rows</span> | <span className="mono">{overview?.kpis?.override_rows ?? "--"}</span></div>
              <div className="pairsNote"><span className="mono">override active</span> | <span className="mono">{overview?.kpis?.override_active_users ?? "--"}</span></div>
              <div className="pairsNote"><span className="mono">audits 24h</span> | <span className="mono">{overview?.kpis?.audits_24h ?? "--"}</span></div>
              <div className="pairsNote"><span className="mono">total tax paid</span> | <span className="mono">{Number(overview?.kpis?.total_tax_paid || 0).toFixed(2)}</span></div>
              <div className="pairsNote"><span className="mono">total remaining</span> | <span className="mono">{Number(overview?.kpis?.total_tax_remaining || 0).toFixed(2)}</span></div>
            </div>

            {(overview?.alerts || []).map((a, i) => (
              <Notice key={`${i}-${a}`} tone="warn" title="Ops alert">{a}</Notice>
            ))}

            <div className="pairsNote"><b>Top Tax Exposure</b></div>
            {(overview?.top_tax_due || []).map((x) => (
              <div key={`${x.user_id}:${x.asset}`} className="pairsNote">
                <span className="mono">{x.email || x.user_id}</span> | <span className="mono">{x.asset}</span> |{" "}
                <span className="mono">remaining {Number(x.tax_remaining || 0).toFixed(2)}</span> |{" "}
                <span className="mono">{x.override_active ? "override" : "formula"}</span>
              </div>
            ))}

            <div className="pairsNote"><b>Recent Admin Activity</b></div>
            {(overview?.recent_audit || []).map((a) => (
              <div key={a.id} className="pairsNote">
                <span className="mono">{fmt(a.created_at)}</span> | <span className="mono">{a.actor}</span> |{" "}
                <span className="mono">{a.action}</span> | <span className="mono">{a.target || "--"}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="marketCard spanFull">
          <div className="marketCardHead">
            <div>
              <div className="panelTitle">User 360 + CRM</div>
              <div className="panelSub">Unified profile, notes, tags, risk score, and account financial stream.</div>
            </div>
          </div>
          <div className="authBody">
            <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))" }}>
              <input value={user360Email} onChange={(e) => setUser360Email(e.target.value)} placeholder="user email" />
              <button className="mini" type="button" onClick={() => void loadUser360()} disabled={!canAdmin || busy}>Load User 360</button>
              <input value={user360Tags} onChange={(e) => setUser360Tags(e.target.value)} placeholder="tags: vip, high-risk" />
              <input value={user360Status} onChange={(e) => setUser360Status(e.target.value)} placeholder="status" />
              <input value={user360Score} onChange={(e) => setUser360Score(e.target.value)} placeholder="score 0-100" />
              <button className="mini" type="button" onClick={() => void saveCrmProfile()} disabled={!canAdmin || busy}>Save CRM profile</button>
            </div>
            <div style={{ display: "grid", gap: 8, gridTemplateColumns: "1fr auto" }}>
              <input value={user360Note} onChange={(e) => setUser360Note(e.target.value)} placeholder="add CRM note" />
              <button className="mini" type="button" onClick={() => void addCrmNote()} disabled={!canAdmin || busy || !user360Note.trim()}>Add note</button>
            </div>
            {user360Data ? (
              <div className="pairsNote">
                <span className="mono">{user360Data.user?.email || user360Data.user?.id}</span> |{" "}
                <span className="mono">tax remaining {Number(user360Data.tax_snapshot?.tax_remaining || 0).toFixed(2)}</span> |{" "}
                <span className="mono">{user360Data.tax_snapshot?.override_active ? "override mode" : "formula mode"}</span>
              </div>
            ) : null}
            {(user360Data?.notes || []).slice(0, 6).map((n) => (
              <div key={n.id} className="pairsNote">
                <span className="mono">{fmt(n.created_at)}</span> | <span className="mono">{n.author || "--"}</span> | {n.note}
              </div>
            ))}
          </div>
        </div>

        <div className="marketCard spanFull">
          <div className="marketCardHead">
            <div>
              <div className="panelTitle">Automation Engine</div>
              <div className="panelSub">Define operational rules, then trigger controlled runs.</div>
            </div>
          </div>
          <div className="authBody">
            <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))" }}>
              <input value={automationName} onChange={(e) => setAutomationName(e.target.value)} placeholder="rule name" />
              <input value={automationConfig} onChange={(e) => setAutomationConfig(e.target.value)} placeholder='{"condition":"tax_remaining_gt","value":1000}' />
              <button className="mini" type="button" onClick={() => void saveAutomationRule()} disabled={!canAdmin || busy}>Save rule</button>
              <button className="mini" type="button" onClick={() => void refreshAutomations()} disabled={!canAdmin || busy}>Refresh automation</button>
            </div>
            {automationRules.map((r) => (
              <div key={r.id} className="pairsNote">
                <span className="mono">{r.name}</span> | <span className="mono">{r.enabled ? "enabled" : "disabled"}</span> |{" "}
                <button className="mini" type="button" onClick={() => void runAutomationRule(r.id)} disabled={!canAdmin || busy}>Run</button>
              </div>
            ))}
            {(automationRuns || []).slice(0, 6).map((r) => (
              <div key={r.id} className="pairsNote">
                <span className="mono">{fmt(r.created_at)}</span> | <span className="mono">{r.rule_id || "--"}</span> | <span className="mono">{r.status}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="marketCard spanFull">
          <div className="marketCardHead">
            <div>
              <div className="panelTitle">Communication Center</div>
              <div className="panelSub">Templates + campaign dispatch log for operational messaging.</div>
            </div>
          </div>
          <div className="authBody">
            <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))" }}>
              <input value={commsTemplateName} onChange={(e) => setCommsTemplateName(e.target.value)} placeholder="template name" />
              <select value={commsTemplateChannel} onChange={(e) => setCommsTemplateChannel(e.target.value)}>
                <option value="email">email</option>
                <option value="telegram">telegram</option>
                <option value="in_app">in_app</option>
              </select>
              <input value={commsTemplateSubject} onChange={(e) => setCommsTemplateSubject(e.target.value)} placeholder="subject (optional)" />
              <input value={commsTemplateBody} onChange={(e) => setCommsTemplateBody(e.target.value)} placeholder="message body" />
              <button className="mini" type="button" onClick={() => void saveCommsTemplate()} disabled={!canAdmin || busy}>Save template</button>
            </div>
            <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))" }}>
              <select value={commsCampaignTemplateId} onChange={(e) => setCommsCampaignTemplateId(e.target.value)}>
                <option value="">no template</option>
                {commsTemplates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
              <input value={commsCampaignAudience} onChange={(e) => setCommsCampaignAudience(e.target.value)} placeholder="audience e.g. all_users / vip" />
              <button className="mini" type="button" onClick={() => void sendCampaign()} disabled={!canAdmin || busy}>Send campaign</button>
              <button className="mini" type="button" onClick={() => void refreshComms()} disabled={!canAdmin || busy}>Refresh comms</button>
            </div>
            {(commsCampaigns || []).slice(0, 8).map((c) => (
              <div key={c.id} className="pairsNote">
                <span className="mono">{fmt(c.created_at)}</span> | <span className="mono">{c.channel}</span> |{" "}
                <span className="mono">{c.audience || "--"}</span> | <span className="mono">{c.sent_count} sent / {c.failed_count} failed</span>
              </div>
            ))}
          </div>
        </div>

        <div className="marketCard spanFull">
          <div className="marketCardHead">
            <div>
              <div className="panelTitle">Finance + Investor Reports</div>
              <div className="panelSub">Reconciliation, revenue pipeline, subscriptions/referrals, and export-ready investor pack.</div>
            </div>
          </div>
          <div className="authBody">
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button className="mini" type="button" onClick={() => void refreshFinance()} disabled={!canAdmin || busy}>Refresh finance</button>
              <button className="mini" type="button" onClick={() => void exportInvestorReport("json")} disabled={!canAdmin || busy}>Export report JSON</button>
              <button className="mini" type="button" onClick={() => void exportInvestorReport("csv")} disabled={!canAdmin || busy}>Export report CSV</button>
            </div>
            <div className="pairsNote">
              <span className="mono">MRR {Number(revenue?.monthly_revenue || 0).toFixed(2)}</span> |{" "}
              <span className="mono">ARPU {Number(revenue?.arpu || 0).toFixed(2)}</span> |{" "}
              <span className="mono">LTV est. {Number(revenue?.ltv_estimate || 0).toFixed(2)}</span> |{" "}
              <span className="mono">Referral commissions {Number(revenue?.referral_commissions_total || 0).toFixed(2)}</span>
            </div>
            <div className="pairsNote">
              <span className="mono">Reconciliation delta D1 {Number(reconciliation?.deltas?.d1 || 0).toFixed(2)}</span> |{" "}
              <span className="mono">D7 {Number(reconciliation?.deltas?.d7 || 0).toFixed(2)}</span> |{" "}
              <span className="mono">D30 {Number(reconciliation?.deltas?.d30 || 0).toFixed(2)}</span>
            </div>
            <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))" }}>
              <input value={subEmail} onChange={(e) => setSubEmail(e.target.value)} placeholder="subscription user email" />
              <input value={subPlan} onChange={(e) => setSubPlan(e.target.value)} placeholder="plan name" />
              <input value={subPrice} onChange={(e) => setSubPrice(e.target.value)} placeholder="price" />
              <button className="mini" type="button" onClick={() => void createSubscription()} disabled={!canAdmin || busy}>Create subscription</button>
            </div>
            <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))" }}>
              <input value={referrerEmail} onChange={(e) => setReferrerEmail(e.target.value)} placeholder="referrer email" />
              <input value={referredEmail} onChange={(e) => setReferredEmail(e.target.value)} placeholder="referred email" />
              <input value={refEarned} onChange={(e) => setRefEarned(e.target.value)} placeholder="commission earned" />
              <button className="mini" type="button" onClick={() => void createReferral()} disabled={!canAdmin || busy}>Create referral</button>
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
              <div key={`${x.user_id}:${x.asset}`} className="pairsNote" style={{ display: "grid", gap: 8, gridTemplateColumns: "1fr auto auto", alignItems: "center" }}>
                <div>
                  <span className="mono">{x.email || x.user_id}</span> | <span className="mono">{x.asset}</span> |{" "}
                  <span className="mono">remaining {x.tax_remaining.toFixed(2)}</span> | <span className="mono">paid {x.tax_paid.toFixed(2)}</span> |{" "}
                  <span className="mono">{x.override_active ? `override ${Number(x.override_remaining || 0).toFixed(2)}` : "formula mode"}</span>
                </div>
                <button className="mini" type="button" onClick={() => pickTaxBalanceRow(x)} disabled={busy}>Use in form</button>
                <button className="mini" type="button" onClick={() => requestTaxReset(x)} disabled={busy}>Reset to 0</button>
              </div>
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
