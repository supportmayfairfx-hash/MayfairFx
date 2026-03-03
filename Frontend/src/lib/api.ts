export function apiBase(): string {
  const envBase = (import.meta as any)?.env?.VITE_API_BASE;
  if (typeof envBase === "string" && envBase.trim()) return envBase.trim().replace(/\/+$/, "");

  if (typeof window !== "undefined") {
    const host = window.location.hostname.toLowerCase();
    const isLocalhost = host === "localhost" || host === "127.0.0.1";
    const isDevVite = isLocalhost && window.location.port === "5173";
    if (isDevVite) return "http://localhost:8787";

    // Fallback for monolith deployments where frontend and backend share the same origin.
    return "";
  }

  return "";
}

export function apiUrl(path: string): string {
  const base = apiBase();
  if (!base) return path;
  return `${base}${path.startsWith("/") ? "" : "/"}${path}`;
}
