import { useEffect, useMemo, useState } from "react";
import Notice from "../components/Notice";
import { apiUrl } from "../lib/api";

type User = { id: string; email: string; first_name?: string | null; created_at: string };
type Holding = { symbol: string; quantity: number; avg_cost: number; updated_at?: string };
type Profile = {
  user_id: string;
  initial_capital: number;
  initial_asset?: string | null;
  initial_units?: number | null;
  created_at: string;
  updated_at: string;
};

async function postJson<T>(path: string, body: any): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body)
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`);
  return j as T;
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

export default function PortfolioPage() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [firstName, setFirstName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authCode, setAuthCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authCodeError, setAuthCodeError] = useState<string | null>(null);
  const [authAvailable, setAuthAvailable] = useState(true);
  const [registered, setRegistered] = useState(false);
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [initialCapital, setInitialCapital] = useState("");
  const [initError, setInitError] = useState<string | null>(null);
  const [initialPreset, setInitialPreset] = useState("");

  useEffect(() => {
    let alive = true;
    // Bootstrap user session first so Services doesn't flash login/register for signed-in users.
    getJson<{ user: User | null }>("/api/auth/me")
      .then((r) => {
        if (!alive) return;
        setUser(r.user);
      })
      .catch(() => {
        if (!alive) return;
        setUser(null);
      });

    // Keep auth availability check, but don't block initial user render on it.
    getJson<{ enabled: boolean; reason: string | null }>("/api/auth/status")
      .then((s) => {
        if (!alive) return;
        setAuthAvailable(!!s.enabled);
      })
      .catch(() => {
        if (!alive) return;
        setAuthAvailable(false);
      });

    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!user) return;
    setProfile(null);
    setInitError(null);
    getJson<{ holdings: Holding[] }>("/api/portfolio/holdings")
      .then((r) => setHoldings(r.holdings || []))
      .catch(() => setHoldings([]));
    getJson<{ profile: Profile | null }>("/api/profile/me")
      .then((r) => setProfile(r.profile))
      .catch(() => setProfile(null));
  }, [user]);

  const canSubmit = useMemo(() => {
    if (mode === "register") return firstName.trim().length >= 2 && email.trim().length > 3 && password.length >= 8;
    return email.trim().length > 3 && password.length >= 8;
  }, [mode, firstName, email, password]);
  const authCodeValid = useMemo(() => /^[A-Za-z0-9]{6}$/.test(authCode), [authCode]);

  function fmtUsd(n: number) {
    if (!Number.isFinite(n)) return "--";
    return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  }

  const holdingsSummary = useMemo(() => {
    return {
      positions: profile ? 1 : 0,
      label: "Private "
    };
  }, [holdings, profile]);

  async function submit() {
    setBusy(true);
    setError(null);
    setAuthCodeError(null);
    try {
      if (mode === "register") {
        await postJson<{ user: User }>("/api/auth/register", { firstName, email, password });
        // Registration does not log the user in. Switch to login so they can use AUTH code.
        setMode("login");
        setUser(null);
        setRegistered(true);
      } else {
        if (!authCode) {
          setAuthCodeError("AUTH code not entered.");
          return;
        }
        if (!authCodeValid) {
          setAuthCodeError("AUTH code must be 6 letters/numbers.");
          return;
        }
        const r = await postJson<{ user: User }>("/api/auth/login", { email, password, authCode });
        setUser(r.user);
        window.dispatchEvent(new Event("auth:changed"));
        setRegistered(false);
      }
      setPassword("");
      setAuthCode("");
      setFirstName("");
    } catch (e: any) {
      const msg = typeof e?.message === "string" ? e.message : "Failed";
      // Route AUTH code related backend errors under the auth code field.
      if (mode === "login" && msg.toLowerCase().includes("auth code")) setAuthCodeError(msg);
      else setError(msg);
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    setBusy(true);
    setError(null);
    try {
      await postJson("/api/auth/logout", {});
      setUser(null);
      window.dispatchEvent(new Event("auth:changed"));
    } catch (e: any) {
      setError(typeof e?.message === "string" ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function initialize() {
    if (!user) return;
    setBusy(true);
    setInitError(null);
    try {
      const v = initialPreset || initialCapital;
      const m = String(v).trim();
      const btcMatch = m.match(/^(\d+(?:\.\d+)?)\s*BTC$/i);
      if (btcMatch) {
        const units = Number(btcMatch[1]);
        if (!Number.isFinite(units) || units <= 0) throw new Error("Invalid BTC amount.");
        const snap = await getJson<{ crypto: Array<{ symbol: string; price: number | null }> }>(
          "/api/markets/snapshot?symbols=BTC"
        );
        const btc = (snap.crypto || []).find((c) => String(c.symbol).toUpperCase() === "BTC");
        const px = typeof btc?.price === "number" ? btc.price : null;
        if (px == null) throw new Error("BTC price unavailable.");
        const usd = units * px;
        const r = await postJson<{ profile: Profile }>("/api/profile/initialize", {
          initialCapital: usd,
          initialAsset: "BTC",
          initialUnits: units
        });
        setProfile(r.profile);
        setInitialCapital("");
        setInitialPreset("");
      } else {
        const r = await postJson<{ profile: Profile }>("/api/profile/initialize", {
          initialCapital: m,
          initialAsset: "USD"
        });
        setProfile(r.profile);
        setInitialCapital("");
        setInitialPreset("");
      }
    } catch (e: any) {
      const msg = typeof e?.message === "string" ? e.message : "Failed";
      if (msg.toLowerCase().includes("already initialized")) {
        setInitError("Initial holdings are already set and cannot be changed.");
      } else {
        setInitError(msg);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="pageHero">
        <div>
          <div className="eyebrow">Portfolio</div>
          <h1 className="pageTitle">Your holdings, performance, and risk</h1>
          <p className="pageLead">Sign in to access your portfolio and progress .</p>
        </div>
        <div className="pageHeroActions">
          {user ? (
            <button className="ghost" type="button" onClick={logout} disabled={busy}>
              Logout
            </button>
          ) : null}
        </div>
      </section>

      <section className="marketGrid" aria-label="Portfolio auth">
        <div className="marketCard spanFull">
          <div className="marketCardHead">
            <div>
              <div className="panelTitle">{user ? "Signed in" : mode === "login" ? "Login" : "Create account"}</div>
              <div className="panelSub">
                {user === undefined
                  ? "Checking your session..."
                  : user
                  ? "You can now access portfolio setup and progress."
                  : "Login requires email, password, and your 6-character AUTH code."}
              </div>
            </div>
            <div className="muted mono">{user === undefined ? "loading" : user ? user.email : "auth"}</div>
          </div>

          <div className="authBody">
            {!authAvailable ? (
              <div className="authError">
                Authentication is temporarily unavailable. Please try again later.
              </div>
            ) : null}
            {user === undefined ? (
              <div className="authOk">
                <div className="panelTitle">Loading session</div>
                <div className="panelSub">Please wait...</div>
              </div>
            ) : null}
            {registered ? (
              <div className="authOk">
                <div className="panelTitle">Registered</div>
                <div className="panelSub">
                  Ask admin for your AUTH code, then login with email + password + AUTH code.
                </div>
              </div>
            ) : null}
            {user ? (
              <div className="authOk">
                <div className="panelTitle">Welcome</div>
                <div className="panelSub">Signed in as <span className="mono">{user.email}</span></div>
              </div>
            ) : user === undefined ? null : (
              <>
                <div className="authTabs" role="tablist" aria-label="Auth mode">
                  <button
                    type="button"
                    className={`mini ${mode === "login" ? "activeTab" : ""}`}
                    onClick={() => setMode("login")}
                    disabled={busy}
                  >
                    Login
                  </button>
                  <button
                    type="button"
                    className={`mini ${mode === "register" ? "activeTab" : ""}`}
                    onClick={() => setMode("register")}
                    disabled={busy}
                  >
                    Register
                  </button>
                </div>

                {mode === "register" ? (
                  <label className="authField">
                    <span className="muted">First name</span>
                    <input value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="e.g. Roy" />
                  </label>
                ) : null}

                <label className="authField">
                  <span className="muted">Email</span>
                  <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
                </label>

                <label className="authField">
                  <span className="muted">Password</span>
                  <input
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="min 8 characters"
                    type="password"
                  />
                </label>

                {mode === "login" ? (
                  <label className="authField">
                    <span className="muted">AUTH code</span>
                    <input
                      value={authCode}
                      onChange={(e) => setAuthCode(e.target.value)}
                      placeholder="6 characters (A-Z, a-z, 0-9)"
                      inputMode="text"
                      autoCapitalize="off"
                      autoCorrect="off"
                    />
                  </label>
                ) : null}

                {mode === "login" && authCodeError ? <div className="authError">{authCodeError}</div> : null}
                {error ? (
                  <Notice
                    tone="warn"
                    title={mode === "login" ? "Unable to sign in" : "Unable to create account"}
                    actions={
                      <button className="mini" type="button" onClick={submit} disabled={!canSubmit || busy}>
                        Retry
                      </button>
                    }
                  >
                    Please try again.
                  </Notice>
                ) : null}

                <button
                  className="primary"
                  type="button"
                  onClick={submit}
                  disabled={!canSubmit || busy}
                >
                  {busy ? "Working..." : mode === "login" ? "Login" : "Create account"}
                </button>
              </>
            )}
          </div>
        </div>
      </section>

      {user ? (
        <section className="marketGrid" aria-label="Portfolio data">
          {!profile ? (
            <div className="marketCard">
              <div className="marketCardHead">
                <div>
                  <div className="panelTitle">First Time Setup</div>
                  <div className="panelSub">Enter your initial holdings amount to begin</div>
                </div>
                <div className="muted mono">required</div>
              </div>
              <div className="authBody">
                <label className="authField">
                  <span className="muted">Quick select</span>
                  <select value={initialPreset} onChange={(e) => setInitialPreset(e.target.value)}>
                    <option value="">Choose...</option>
                    <option value="300">$300</option>
                    <option value="500">$500</option>
                    <option value="1000">$1,000</option>
                    <option value="2000">$2,000</option>
                    <option value="5000">$5,000</option>
                    <option value="10000">$10,000</option>
                    <option value="1 BTC">1 BTC</option>
                    <option value="2 BTC">2 BTC</option>
                  </select>
                </label>
                <label className="authField">
                  <span className="muted">Initial holdings amount (USD)</span>
                  <input
                    value={initialCapital}
                    onChange={(e) => setInitialCapital(e.target.value)}
                    placeholder="e.g. 1000"
                    inputMode="decimal"
                  />
                </label>
                {initError ? <div className="authError">{initError}</div> : null}
                <button className="primary" type="button" onClick={initialize} disabled={busy}>
                  {busy ? "Working..." : "Save"}
                </button>
              </div>
            </div>
          ) : null}

          {profile ? (
            <div className="marketCard">
              <div className="marketCardHead">
                <div>
                  <div className="panelTitle">Initial Amount</div>
                  <div className="panelSub">Saved to your profile</div>
                </div>
                <div className="muted mono">
                  {profile.initial_asset === "BTC" && profile.initial_units != null
                    ? `${profile.initial_units} BTC`
                    : "USD"}
                </div>
              </div>
              <div className="authBody">
                <div className="pairsNote">
                  Initial holdings (USD):{" "}
                  <span className="mono">
                    ${Number(profile.initial_capital).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                  </span>
                </div>
                <button
                  className="success"
                  type="button"
                  onClick={() => {
                    window.history.pushState(null, "", "/progress");
                    window.dispatchEvent(new PopStateEvent("popstate"));
                  }}
                  disabled={busy}
                >
                  Progress
                </button>
              </div>
            </div>
          ) : null}

          <div className="marketCard">
            <div className="marketCardHead">
              <div>
                <div className="panelTitle">Holdings</div>
                <div className="panelSub">Linked to your account ({user.email})</div>
              </div>
              <div className="muted mono">Positions: <span className="mono">{holdingsSummary.positions}</span></div>
            </div>
            <div className="authBody">
              <div className="pairsNote">
                Holdings are stored privately and are not disclosed on this website.
              </div>
              <div className="pairsNote">
                Positions: <span className="mono">{holdingsSummary.positions}</span>  |  Privacy: <span className="mono">{holdingsSummary.label}</span>
              </div>
            </div>
          </div>
        </section>
      ) : null}
    </>
  );
}
