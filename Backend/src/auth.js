import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "";

export function assertJwtConfigured() {
  if (!JWT_SECRET) throw new Error("JWT_SECRET is not set on the backend.");
}

export async function hashPassword(password) {
  // bcryptjs (pure JS) keeps install simple on Windows.
  const saltRounds = 12;
  return bcrypt.hash(password, saltRounds);
}

export async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

export async function hashAuthCode(code) {
  // Same hashing as password, but codes are short; still fine for this scale.
  const saltRounds = 12;
  return bcrypt.hash(code, saltRounds);
}

export async function verifyAuthCode(code, hash) {
  return bcrypt.compare(code, hash);
}

export function signAuthToken(payload) {
  assertJwtConfigured();
  return jwt.sign(payload, JWT_SECRET, { algorithm: "HS256", expiresIn: "7d" });
}

export function verifyAuthToken(token) {
  assertJwtConfigured();
  return jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
}

export function authCookieOptions(req) {
  const isHttps = Boolean(req.secure) || req.headers["x-forwarded-proto"] === "https";
  const rawSameSite = String(process.env.AUTH_COOKIE_SAMESITE || "lax").trim().toLowerCase();
  const sameSite = rawSameSite === "none" || rawSameSite === "strict" || rawSameSite === "lax" ? rawSameSite : "lax";
  const rawSecure = String(process.env.AUTH_COOKIE_SECURE || "").trim().toLowerCase();
  const forceSecure = rawSecure === "1" || rawSecure === "true" || rawSecure === "yes";
  return {
    httpOnly: true,
    sameSite,
    secure: sameSite === "none" ? true : isHttps || forceSecure,
    path: "/",
    maxAge: 7 * 24 * 60 * 60 * 1000
  };
}

export function authCookieClearOptions(req) {
  const base = authCookieOptions(req);
  return {
    httpOnly: base.httpOnly,
    sameSite: base.sameSite,
    secure: base.secure,
    path: base.path
  };
}
