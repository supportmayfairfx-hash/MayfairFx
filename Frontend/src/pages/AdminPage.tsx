import { useEffect, useMemo, useRef, useState } from "react";
import Notice from "../components/Notice";
import { apiUrl } from "../lib/api";

type Method = "GET" | "POST" | "PUT";
type ConfirmAction = "deactivate" | "bulk_destructive" | "tax_update" | "deposit_update" | "latest_bulk_deactivate" | null;
type BulkAction = "generate" | "deactivate" | "lookup";

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
type DepositAdminItem = {
  id: string;
  user_id: string;
  email?: string | null;
  amount: number;
  asset: string;
  method: string;
  chain?: string | null;
  reference?: string | null;
  note?: string | null;
  provider?: string | null;
  invoice_id?: string | null;
  payment_url?: string | null;
  qr_code?: string | null;
  status: string;
  created_at: string;
  updated_at?: string;
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
  const [adminKey] = useState(() => sessionStorage.getItem("admin_api_key") || "");
  const [adminSession, setAdminSession] = useState<{ ok: boolean; actor: string; mode: string } | null>(null);
  const [loginEmail, setLoginEmail] = useState("supportmayfairfx@gmail.com");
  const [loginPassword, setLoginPassword] = useState("Admin123");
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
  const [taxItems, setTaxItems] = useState<TaxPaymentItem[]>([]);
  const [depositItems, setDepositItems] = useState<DepositAdminItem[]>([]);
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
  const [depositFilterEmail, setDepositFilterEmail] = useState("");
  const [depositFilterStatus, setDepositFilterStatus] = useState("all");
  const [editingDepositId, setEditingDepositId] = useState("");
  const [editDepositStatus, setEditDepositStatus] = useState("awaiting_payment");
  const [editDepositReference, setEditDepositReference] = useState("");
  const [editDepositNote, setEditDepositNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  const [confirmBody, setConfirmBody] = useState("");
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
  const undoSecondsLeft = useMemo(() => {
    if (!undoTaxReset) return 0;
    return Math.max(0, Math.ceil((undoTaxReset.expires_at - undoNowTick) / 1000));
  }, [undoNowTick, undoTaxReset]);
  const pendingDeposits = useMemo(
    () =>
      depositItems
        .filter((x) => {
          const s = String(x.status || "").toLowerCase();
          return s === "pending" || s === "awaiting_payment";
        })
        .slice()
        .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || ""))),
    [depositItems]
  );
  const confirmedDeposits = useMemo(
    () =>
      depositItems
        .filter((x) => String(x.status || "").toLowerCase() === "confirmed")
        .slice()
        .sort((a, b) => String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || ""))),
    [depositItems]
  );

  function closeConfirm() {
    setConfirmAction(null);
    setConfirmBody("");
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
    // Session bootstrap runs once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    void refreshDeposits();
    void refreshOverview();
    void refreshAutomations();
    void refreshComms();
    void refreshFinance();
    // Intentional fan-out on auth state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminSession]);

  useEffect(() => {
    if (!canAdmin || !overviewAutoRefresh) return;
    const t = window.setInterval(() => {
      void refreshOverview(true);
    }, 15000);
    return () => window.clearInterval(t);
    // Keep polling cadence stable while admin + toggle state are unchanged.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canAdmin, overviewAutoRefresh]);

  useEffect(() => {
    if (!canAdmin || !latestAutoRefresh) return;
    const t = window.setInterval(() => {
      void refreshLatestAuthCodes(0, true, true);
    }, 4000);
    return () => window.clearInterval(t);
    // Polling keys are intentionally scoped to filters and toggles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // Visibility/focus listeners are rebound only when admin/filter context changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  async function refreshDeposits() {
    if (!canAdmin) return;
    setBusy(true);
    setError(null);
    try {
      const q = new URLSearchParams();
      q.set("limit", "180");
      const em = depositFilterEmail.trim().toLowerCase();
      if (em) q.set("email", em);
      const st = depositFilterStatus.trim().toLowerCase();
      if (st && st !== "all") q.set("status", st);
      const r = await apiJson<{ items: DepositAdminItem[] }>("GET", `/api/admin/deposits?${q.toString()}`, adminKey);
      setDepositItems(Array.isArray(r.items) ? r.items : []);
    } catch (e: any) {
      setError(typeof e?.message === "string" ? e.message : "Deposit fetch failed");
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

  async function resetTypedTaxBalance() {
    if (!canAdmin || !taxBalanceEmail.trim()) {
      setError("Enter a user email first.");
      return;
    }
    const prev = taxBalanceRemaining;
    setBusy(true);
    setError(null);
    setTaxBalanceRemaining("0");
    try {
      await apiJson("POST", "/api/admin/tax-balances", adminKey, {
        email: taxBalanceEmail.trim().toLowerCase(),
        asset: taxBalanceAsset.trim().toUpperCase(),
        remaining: 0,
        note: taxBalanceNote.trim() || "reset_to_zero_from_typed_user"
      });
      pushToast(`Tax reset to 0 for ${taxBalanceEmail.trim().toLowerCase()}.`);
      await Promise.all([refreshTaxBalances(), refreshOverview(true), refreshFinance()]);
    } catch (e: any) {
      setTaxBalanceRemaining(prev);
      setError(typeof e?.message === "string" ? e.message : "Tax reset failed");
    } finally {
      setBusy(false);
    }
  }

  async function resetTaxBalanceForUser(item: TaxBalanceItem) {
    if (!canAdmin) return;
    setBusy(true);
    setError(null);
    try {
      const body: any = { remaining: 0, note: "reset_to_zero_from_list" };
      const em = String(item.email || "").trim().toLowerCase();
      if (em) body.email = em;
      else body.userId = item.user_id;
      const r = await apiJson<{ ok?: boolean; summary?: { tax_remaining?: number } }>("POST", "/api/admin/tax-balances", adminKey, body);
      const after = Number(r?.summary?.tax_remaining ?? 0);
      if (Number.isFinite(after) && after > 0.00000001) {
        throw new Error(`Reset was not applied. Remaining is still ${after.toFixed(2)}.`);
      }
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
      const msg = typeof e?.message === "string" ? e.message : "Tax reset failed";
      setError(msg);
      pushToast(`Reset failed: ${msg}`);
    } finally {
      setBusy(false);
    }
  }

  async function requestTaxReset(item: TaxBalanceItem) {
    const who = String(item.email || item.user_id);
    const asset = String(item.asset || "USD").toUpperCase();
    const token = window.prompt(`Type RESET to zero tax for ${who} (${asset}).`) || "";
    if (token.trim().toUpperCase() !== "RESET") return;
    await resetTaxBalanceForUser(item);
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

  function beginDepositEdit(item: DepositAdminItem) {
    setEditingDepositId(item.id);
    setEditDepositStatus(item.status || "awaiting_payment");
    setEditDepositReference(item.reference || "");
    setEditDepositNote(item.note || "");
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

  async function saveDeposit(force = false) {
    if (!canAdmin || !editingDepositId) return;
    if (!force) {
      setConfirmAction("deposit_update");
      setConfirmBody(`Apply updates to deposit ${editingDepositId}?`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiJson("PUT", `/api/admin/deposits/${encodeURIComponent(editingDepositId)}`, adminKey, {
        status: editDepositStatus,
        reference: editDepositReference,
        note: editDepositNote
      });
      setEditingDepositId("");
      await refreshDeposits();
    } catch (e: any) {
      setError(typeof e?.message === "string" ? e.message : "Deposit update failed");
    } finally {
      setBusy(false);
    }
  }

  async function quickUpdateDeposit(item: DepositAdminItem, status: "confirmed" | "rejected") {
    if (!canAdmin || !item?.id) return;
    setBusy(true);
    setError(null);
    try {
      await apiJson("PUT", `/api/admin/deposits/${encodeURIComponent(item.id)}`, adminKey, {
        status,
        reference: item.reference || "",
        note: item.note || ""
      });
      await refreshDeposits();
      pushToast(
        status === "confirmed"
          ? `Deposit approved for ${item.email || item.user_id}. Progress profile synced.`
          : `Deposit rejected for ${item.email || item.user_id}.`
      );
    } catch (e: any) {
      setError(typeof e?.message === "string" ? e.message : "Deposit approval failed");
    } finally {
      setBusy(false);
    }
  }

  async function confirmNow() {
    const c = confirmAction;
    closeConfirm();
    if (c === "deactivate") await runAuth("deactivate", true);
    if (c === "bulk_destructive") await runBulk(true);
    if (c === "tax_update") await saveTax(true);
    if (c === "deposit_update") await saveDeposit(true);
    if (c === "latest_bulk_deactivate") await deactivateSelectedLatest();
  }

  return (
    <>
      <section className="pageHero">
        <div>
          <div className="eyebrow">Admin</div>
          <h1 className="pageTitle">Admin Access Portal</h1>
          <p className="pageLead">Secure sign-in for Mayfair Forex operations. After login, you can manage checkout deposit approvals.</p>
        </div>
      </section>

      {confirmAction ? (
        <div className="mobilePanel" style={{ display: "block" }} onClick={closeConfirm}>
          <div className="mobileSheet" role="dialog" onClick={(e) => e.stopPropagation()}>
            <div className="panelTitle">Confirm action</div>
            <div className="panelSub">{confirmBody}</div>
            <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
              <button className="mini" type="button" onClick={() => void confirmNow()}>Confirm</button>
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
                <div className="panelTitle">Admin Login Portal</div>
                <div className="panelSub">Sign in to access checkout deposit approvals and workflow actions.</div>
              </div>
              <div className="muted mono">status: not authenticated</div>
            </div>
            <div className="authBody">
              <div style={{ display: "grid", gap: 16, gridTemplateColumns: "minmax(340px,2fr) minmax(260px,1fr)" }}>
                <div
                  style={{
                    border: "1px solid rgba(255,255,255,.14)",
                    borderRadius: 14,
                    padding: 14,
                    background: "linear-gradient(180deg, rgba(9,22,48,.45), rgba(4,13,31,.35))"
                  }}
                >
                  <div className="panelTitle" style={{ marginBottom: 4 }}>Credentials</div>
                  <div className="panelSub" style={{ marginBottom: 12 }}>Use your admin account to continue.</div>

                  <div style={{ display: "grid", gap: 12 }}>
                    <div style={{ display: "grid", gap: 6 }}>
                      <div className="muted" style={{ fontSize: 12, letterSpacing: ".04em", textTransform: "uppercase" }}>Admin Email</div>
                      <input value={loginEmail} onChange={(e) => setLoginEmail(e.target.value)} placeholder="admin email" />
                    </div>
                    <div style={{ display: "grid", gap: 6 }}>
                      <div className="muted" style={{ fontSize: 12, letterSpacing: ".04em", textTransform: "uppercase" }}>Password</div>
                      <input type="password" value={loginPassword} onChange={(e) => setLoginPassword(e.target.value)} placeholder="password" />
                    </div>
                    <div style={{ display: "grid", gap: 6 }}>
                      <div className="muted" style={{ fontSize: 12, letterSpacing: ".04em", textTransform: "uppercase" }}>AUTH Code (Optional)</div>
                      <input value={loginAuthCode} onChange={(e) => setLoginAuthCode(e.target.value)} placeholder="leave blank for default admin" />
                    </div>
                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 2 }}>
                      <button className="primary" type="button" onClick={() => void signInRoleAdmin()} disabled={busy}>
                        {busy ? "Signing in..." : "Sign in"}
                      </button>
                      <button className="mini" type="button" onClick={() => void refreshSession()} disabled={busy}>Validate session</button>
                    </div>
                    <div className="pairsNote">
                      <span className="mono">Security note:</span> access is role-gated and session-validated on the server.
                    </div>
                  </div>
                </div>

                <div
                  style={{
                    border: "1px solid rgba(74,190,255,.24)",
                    borderRadius: 14,
                    padding: 14,
                    background: "linear-gradient(180deg, rgba(16,41,58,.42), rgba(6,20,34,.35))"
                  }}
                >
                  <div className="panelTitle" style={{ marginBottom: 8 }}>Operations Flow</div>
                  <div className="pairsNote"><span className="mono">Step 1:</span> Review prefilled credentials.</div>
                  <div className="pairsNote"><span className="mono">Step 2:</span> Sign in and confirm session.</div>
                  <div className="pairsNote"><span className="mono">Step 3:</span> Open pending checkout requests.</div>
                  <div className="pairsNote"><span className="mono">Step 4:</span> Approve or reject each deposit.</div>
                  <div className="pairsNote" style={{ marginTop: 10 }}>
                    <span className="mono">Scope:</span> This admin is intentionally limited to deposit queue operations.
                  </div>
                </div>
              </div>
              {error ? <Notice tone="warn" title="Login failed">{error}</Notice> : null}
            </div>
          </div>
        </section>
      ) : (

      <section className="marketGrid">
        <div className="marketCard spanFull">
          <div className="marketCardHead">
            <div>
              <div className="panelTitle">Checkout Deposit Approval Queue</div>
              <div className="panelSub">Approve requests from checkout. Approved requests unlock user progress data.</div>
            </div>
            <div className="muted mono">{pendingDeposits.length} pending</div>
          </div>
          <div className="authBody">
            <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))" }}>
              <div className="pairsNote">
                <span className="mono">Pending (no movement): {pendingDeposits.length}</span>
              </div>
              <div className="pairsNote">
                <span className="mono">Approved (position active): {confirmedDeposits.length}</span>
              </div>
              <div className="pairsNote">
                <span className="mono">Rule: Progress stays 0 until status = confirmed</span>
              </div>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 980 }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left", padding: "10px 8px" }}>Date</th>
                    <th style={{ textAlign: "left", padding: "10px 8px" }}>User</th>
                    <th style={{ textAlign: "left", padding: "10px 8px" }}>Amount</th>
                    <th style={{ textAlign: "left", padding: "10px 8px" }}>Asset</th>
                    <th style={{ textAlign: "left", padding: "10px 8px" }}>Network</th>
                    <th style={{ textAlign: "left", padding: "10px 8px" }}>Status</th>
                    <th style={{ textAlign: "left", padding: "10px 8px" }}>Progress Impact</th>
                    <th style={{ textAlign: "left", padding: "10px 8px" }}>Reference</th>
                    <th style={{ textAlign: "left", padding: "10px 8px" }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {pendingDeposits.length ? (
                    pendingDeposits.map((it) => (
                      <tr key={it.id} style={{ borderTop: "1px solid rgba(255,255,255,.08)" }}>
                        <td style={{ padding: "10px 8px" }} className="mono">{fmt(it.created_at)}</td>
                        <td style={{ padding: "10px 8px" }} className="mono">{it.email || it.user_id}</td>
                        <td style={{ padding: "10px 8px" }} className="mono">{Number(it.amount || 0).toFixed(8)}</td>
                        <td style={{ padding: "10px 8px" }} className="mono">{it.asset || "--"}</td>
                        <td style={{ padding: "10px 8px" }} className="mono">{it.chain || "--"}</td>
                        <td style={{ padding: "10px 8px" }} className="mono">{it.status || "--"}</td>
                        <td style={{ padding: "10px 8px" }} className="mono">No movement until approved</td>
                        <td style={{ padding: "10px 8px" }} className="mono">{it.reference || "--"}</td>
                        <td style={{ padding: "10px 8px", display: "flex", gap: 8, flexWrap: "wrap" }}>
                          <button
                            className="mini"
                            type="button"
                            onClick={() => void quickUpdateDeposit(it, "confirmed")}
                            disabled={busy}
                            style={{ borderColor: "rgba(60,210,120,.65)", color: "#aaf5c7" }}
                          >
                            Approve
                          </button>
                          <button
                            className="mini"
                            type="button"
                            onClick={() => void quickUpdateDeposit(it, "rejected")}
                            disabled={busy}
                            style={{ borderColor: "rgba(255,90,90,.65)", color: "#ffd3d3" }}
                          >
                            Reject
                          </button>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={9} style={{ padding: "12px 8px" }} className="pairsNote">
                        No pending checkout deposit requests.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>
      )}
    </>
  );
}

