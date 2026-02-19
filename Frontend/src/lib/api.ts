export function apiBase(): string {
  if (typeof window !== "undefined") {
    const host = window.location.hostname.toLowerCase();
    const isLocalhost = host === "localhost" || host === "127.0.0.1";
    const isDevVite = isLocalhost && window.location.port === "5173";
    if (isDevVite) return "http://localhost:8787";

    // In production, keep API calls same-origin so auth cookies remain first-party on Safari/iOS.
    return "";
  }

  const envBase = (import.meta as any)?.env?.VITE_API_BASE;
  if (typeof envBase === "string" && envBase.trim()) return envBase.trim().replace(/\/+$/, "");
  return "";
}

export function apiUrl(path: string): string {
  const base = apiBase();
  if (!base) return path;
  return `${base}${path.startsWith("/") ? "" : "/"}${path}`;
}
