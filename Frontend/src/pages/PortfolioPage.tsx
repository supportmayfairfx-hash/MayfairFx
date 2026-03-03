import { useEffect, useMemo, useState } from "react";
import Notice from "../components/Notice";
import { apiUrl } from "../lib/api";
import { cacheProfile, cacheUser, clearCachedSession, getCachedUser } from "../lib/sessionCache";

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authAvailable, setAuthAvailable] = useState(true);
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);

  useEffect(() => {
    let alive = true;
    // Bootstrap user session first so Services doesn't flash login/register for signed-in users.
    const cached = getCachedUser() as any;
    if (cached) setUser(cached);
    getJson<{ user: User | null }>("/api/auth/me")
      .then((r) => {
        if (!alive) return;
        if (r.user) {
          cacheUser(r.user as any);
          setUser(r.user);
          return;
        }
        clearCachedSession();
        setUser(null);
      })
      .catch(() => {
        if (!alive) return;
        setUser((getCachedUser() as any) || null);
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
    getJson<{ holdings: Holding[] }>("/api/portfolio/holdings")
      .then((r) => setHoldings(r.holdings || []))
      .catch(() => setHoldings([]));
    getJson<{ profile: Profile | null }>("/api/profile/me")
      .then((r) => {
        setProfile(r.profile);
        if (r.profile) cacheProfile(r.profile as any);
      })
      .catch(() => setProfile(null));
  }, [user]);

  const canSubmit = useMemo(() => {
    if (mode === "register") return firstName.trim().length >= 2 && email.trim().length > 3 && password.length >= 8;
    return email.trim().length > 3 && password.length >= 8;
  }, [mode, firstName, email, password]);

  function fmtUsd(n: number) {
    if (!Number.isFinite(n)) return "--";
    return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  }

  const holdingsSummary = useMemo(() => {
    const initialCapital = Number(profile?.initial_capital || 0);
    const initialUnits = Number(profile?.initial_units || 0);
    const hasApprovedHoldings = initialCapital > 0 || initialUnits > 0;
    return {
      positions: hasApprovedHoldings ? 1 : 0,
      label: "Private "
    };
  }, [holdings, profile]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (mode === "register") {
        const reg = await postJson<{ user: User; requiresAuthCode?: boolean }>("/api/auth/register", {
          firstName,
          email,
          password
        });
        if (reg?.requiresAuthCode) {
          throw new Error(
            "Login service is still running old AUTH-code mode. Please restart backend and redeploy, then try again."
          );
        }
        // Registration does not log the user in. Switch to login.
        setMode("login");
        setUser(null);
      } else {
        const r = await postJson<{ user: User }>("/api/auth/login", { email, password });
        setUser(r.user);
        cacheUser(r.user as any);
        window.dispatchEvent(new Event("auth:changed"));
      }
      setPassword("");
      setFirstName("");
    } catch (e: any) {
      const raw = typeof e?.message === "string" ? e.message : "Failed";
      const msg =
        /auth code is required/i.test(raw) || /requiresauthcode/i.test(raw)
          ? "This backend is still on old AUTH-code login mode. Contact support to restart/redeploy the backend auth service."
          : raw;
      setError(msg);
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
      clearCachedSession();
      window.dispatchEvent(new Event("auth:changed"));
    } catch (e: any) {
      setError(typeof e?.message === "string" ? e.message : "Failed");
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
                  : "Login with your email and password."}
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
                    <input value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="e.g. Paul" />
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
                    {error}
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
          {profile ? (
            <div className="marketCard">
              <div className="marketCardHead">
                <div>
                  <div className="panelTitle">Initial Holdings</div>
                  <div className="panelSub">System-managed (starts at 0 and updates from approved investments)</div>
                </div>
                <div className="muted mono">Locked</div>
              </div>
              <div className="authBody">
                <div className="pairsNote">
                  Initial holdings:{" "}
                  <span className="mono">
                    {String(profile.initial_asset || "USD").toUpperCase() === "BTC" && Number.isFinite(Number(profile.initial_units))
                      ? `${Number(profile.initial_units).toLocaleString(undefined, { maximumFractionDigits: 6 })} BTC`
                      : fmtUsd(Number(profile.initial_capital || 0))}
                  </span>
                </div>
                <div className="pairsNote">
                  To start movement, make an investment on Checkout and wait for admin confirmation.
                </div>
                <button
                  className="success"
                  type="button"
                  onClick={() => {
                    window.history.pushState(null, "", "/checkout");
                    window.dispatchEvent(new PopStateEvent("popstate"));
                  }}
                  disabled={busy}
                >
                  Deposit
                </button>
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
          ) : (
            <div className="marketCard">
              <div className="marketCardHead">
                <div>
                  <div className="panelTitle">Initial Holdings</div>
                  <div className="panelSub">Creating your profile...</div>
                </div>
                <div className="muted mono">sync</div>
              </div>
              <div className="authBody">
                <div className="pairsNote">Your account profile is being prepared. Reload in a moment.</div>
              </div>
            </div>
          )}

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
