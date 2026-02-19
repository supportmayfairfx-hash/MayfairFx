import { verifyAuthToken } from "../auth.js";

function parseCookieHeader(header) {
  const out = {};
  const s = typeof header === "string" ? header : "";
  if (!s) return out;
  const parts = s.split(";");
  for (const p of parts) {
    const idx = p.indexOf("=");
    if (idx <= 0) continue;
    const k = p.slice(0, idx).trim();
    const v = p.slice(idx + 1).trim();
    if (!k) continue;
    out[k] = decodeURIComponent(v);
  }
  return out;
}

export function requireAuth(req, res, next) {
  try {
    const cookies = req.cookies || parseCookieHeader(req.headers?.cookie);
    const token = cookies?.auth_token;
    if (!token) return res.status(401).json({ error: "Not authenticated" });
    const payload = verifyAuthToken(token);
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid auth token" });
  }
}
