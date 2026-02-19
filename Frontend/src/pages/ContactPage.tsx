import { useMemo, useState } from "react";

function addRipple(e: React.PointerEvent<HTMLElement>) {
  const el = e.currentTarget as HTMLElement;
  const rect = el.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const s = document.createElement("span");
  s.className = "ripple";
  const size = Math.max(rect.width, rect.height) * 1.2;
  s.style.width = `${size}px`;
  s.style.height = `${size}px`;
  s.style.left = `${x}px`;
  s.style.top = `${y}px`;
  el.appendChild(s);
  window.setTimeout(() => s.remove(), 700);
}

export default function ContactPage() {
  const email = "supporttradefix@gmail.com";
  const tg = "https://t.me/Sr_Haddan";
  const channel = "https://t.me/tradefix1";
  const [copyState, setCopyState] = useState<"idle" | "loading" | "ok" | "err">("idle");

  const copyLabel = useMemo(() => {
    if (copyState === "loading") return "Copying...";
    if (copyState === "ok") return "Copied";
    if (copyState === "err") return "Copy failed";
    return "Copy email";
  }, [copyState]);

  async function copyEmail() {
    if (copyState === "loading") return;
    setCopyState("loading");
    try {
      await navigator.clipboard.writeText(email);
      setCopyState("ok");
      window.setTimeout(() => setCopyState("idle"), 1400);
    } catch {
      setCopyState("err");
      window.setTimeout(() => setCopyState("idle"), 1800);
    }
  }

  return (
    <>
      <section className="pageHero">
        <div>
          <div className="eyebrow">Contact</div>
          <h1 className="pageTitle">Support</h1>
          <p className="pageLead">Reach the admin for onboarding, account setup, and general support.</p>
        </div>
      </section>

      <section className="marketGrid" aria-label="Contact options">
        <div className="marketCard spanFull">
          <div className="marketCardHead">
            <div>
              <div className="panelTitle">Email</div>
              <div className="panelSub">Fastest way to share screenshots and details</div>
            </div>
            <div className="muted mono">{email}</div>
          </div>
          <div className="authBody">
            <div className="pairsNote">
              <span className="muted">Address:</span> <span className="mono">{email}</span>
            </div>
            <div className="contactBtnRow">
              <a
                className="btnContact btnHero fullSm"
                href={`mailto:${email}`}
                onPointerDown={addRipple}
                onClick={() => void 0}
              >
                <i className="fa-regular fa-envelope" aria-hidden="true" />
                <span>Send Email</span>
              </a>

              <button
                className={`btnContact btnGhost btnPill fullSm ${copyState === "loading" ? "isLoading" : ""}`}
                type="button"
                onPointerDown={addRipple}
                onClick={() => void copyEmail()}
                aria-label="Copy support email"
              >
                {copyState === "loading" ? <span className="btnSpinner" aria-hidden="true" /> : <i className="fa-regular fa-copy" aria-hidden="true" />}
                <span>{copyLabel}</span>
                {copyState === "ok" ? (
                  <span className="btnCheck" aria-hidden="true">
                    <i className="fa-solid fa-check" aria-hidden="true" style={{ fontSize: 12 }} />
                  </span>
                ) : null}
              </button>
            </div>
          </div>
        </div>

        <div className="marketCard spanFull">
          <div className="marketCardHead">
            <div>
              <div className="panelTitle">Telegram</div>
              <div className="panelSub">Message the admin directly</div>
            </div>
            <div className="muted mono">@Sr_Haddan</div>
          </div>
          <div className="authBody">
            <div className="pairsNote">
              <span className="muted">Link:</span> <span className="mono">{tg}</span>
            </div>
            <div className="contactBtnRow">
              <a className="btnContact btnGlass btnPill fullSm" href={tg} target="_blank" rel="noreferrer" onPointerDown={addRipple}>
                <i className="fa-brands fa-telegram" aria-hidden="true" />
                <span>Message Admin</span>
              </a>
              <a className="btnContact btnNeumo fullSm" href={tg} target="_blank" rel="noreferrer" onPointerDown={addRipple}>
                <i className="fa-regular fa-message" aria-hidden="true" />
                <span>Open Chat</span>
              </a>
            </div>
          </div>
        </div>

        <div className="marketCard spanFull">
          <div className="marketCardHead">
            <div>
              <div className="panelTitle">Telegram Channel</div>
              <div className="panelSub">Community updates and announcements</div>
            </div>
            <div className="muted mono">@tradefix1</div>
          </div>
          <div className="authBody">
            <div className="pairsNote">
              <span className="muted">Link:</span> <span className="mono">{channel}</span>
            </div>
            <div className="contactBtnRow">
              <a
                className="btnContact btnHero btnPill fullSm"
                href={channel}
                target="_blank"
                rel="noreferrer"
                onPointerDown={addRipple}
              >
                <i className="fa-solid fa-trophy" aria-hidden="true" />
                <span>Join The Winners Circle</span>
              </a>
              <a
                className="btnContact btnGhost btnPill fullSm"
                href={channel}
                target="_blank"
                rel="noreferrer"
                onPointerDown={addRipple}
              >
                <i className="fa-solid fa-clock-rotate-left" aria-hidden="true" />
                <span>History Overview</span>
              </a>
            </div>
          </div>
        </div>
      </section>

      <a className="contactFab" href={tg} target="_blank" rel="noreferrer" aria-label="Contact admin on Telegram">
        <i className="fa-brands fa-telegram" aria-hidden="true" style={{ fontSize: 22 }} />
      </a>
    </>
  );
}
