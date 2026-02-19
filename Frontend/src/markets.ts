import { apiUrl } from "./lib/api";

export type CryptoQuote = {
  productId: string; // e.g. BTC-USD (frontend convention)
  price: number;
  time: string | null;
};

export type FxQuote = {
  pair: string; // e.g. EUR/USD
  rate: number;
  time: string | null;
};

export type MarketSnapshot = {
  asOf: string; // ISO timestamp when we fetched
  crypto: CryptoQuote[];
  fx: FxQuote[];
  metals: { symbol: string; price: number; time: string | null }[];
  sources: {
    crypto: string;
    fx: string;
    metals?: string;
  };
  marketStatus?: {
    crypto?: "open" | "closed";
    fx?: "open" | "closed";
    metals?: "open" | "closed";
    tz?: string;
  };
};

export type PairItem = { pair: string; base: string | null; quote: string | null };
export type PairsResponse = {
  asOf: string;
  source: string;
  q: string;
  quote: string | null;
  limit: number;
  offset: number;
  total: number;
  items: PairItem[];
};

type BackendSnapshot = {
  asOf: string;
  sources?: { crypto?: string; fx?: string; metals?: string };
  crypto?: Array<{ symbol?: string; price?: number | null }>;
  fx?: Array<{ pair: string; rate: number }>;
  metals?: Array<{ symbol?: string; price?: number | null; updatedAt?: string | null }>;
  marketStatus?: { crypto?: any; fx?: any; metals?: any; tz?: any };
};

async function fetchJson(url: string, signal?: AbortSignal): Promise<any> {
  const res = await fetch(url, {
    method: "GET",
    signal,
    headers: { Accept: "application/json" }
  });
  const j = await res.json().catch(() => null);
  if (!res.ok) throw new Error(j?.error || `HTTP ${res.status} for ${url}`);
  return j;
}

export async function fetchMarketSnapshot(signal?: AbortSignal): Promise<MarketSnapshot> {
  // Served by Backend.
  const j = (await fetchJson(apiUrl("/api/markets/snapshot"), signal)) as BackendSnapshot;

  const cryptoRaw = Array.isArray(j.crypto) ? j.crypto : [];
  const fxRaw = Array.isArray(j.fx) ? j.fx : [];
  const metalsRaw = Array.isArray(j.metals) ? j.metals : [];

  const crypto: CryptoQuote[] = cryptoRaw
    .map((c) => {
      const sym = typeof c.symbol === "string" ? c.symbol.toUpperCase() : null;
      const price = typeof c.price === "number" ? c.price : null;
      if (!sym || price == null) return null;
      return { productId: `${sym}-USD`, price, time: j.asOf } satisfies CryptoQuote;
    })
    .filter(Boolean) as CryptoQuote[];

  const fx: FxQuote[] = fxRaw
    .map((f) => ({
      pair: f.pair,
      rate: f.rate,
      time: j.asOf
    }))
    .filter((f) => typeof f.pair === "string" && typeof f.rate === "number");

  const metals = metalsRaw
    .map((m) => {
      const symbol = typeof m.symbol === "string" ? m.symbol.toUpperCase() : null;
      const price = typeof m.price === "number" ? m.price : null;
      if (!symbol || price == null) return null;
      const t = typeof m.updatedAt === "string" ? m.updatedAt : j.asOf;
      return { symbol, price, time: t };
    })
    .filter(Boolean) as { symbol: string; price: number; time: string | null }[];

  return {
    asOf: j.asOf || new Date().toISOString(),
    crypto,
    fx,
    metals,
    sources: {
      crypto: j.sources?.crypto || "Backend",
      fx: j.sources?.fx || "Backend",
      metals: j.sources?.metals || "Backend"
    },
    marketStatus: j.marketStatus
      ? {
          crypto: j.marketStatus.crypto === "closed" ? "closed" : "open",
          fx: j.marketStatus.fx === "closed" ? "closed" : "open",
          metals: j.marketStatus.metals === "closed" ? "closed" : "open",
          tz: typeof j.marketStatus.tz === "string" ? j.marketStatus.tz : undefined
        }
      : undefined
  };
}

export async function fetchCryptoPairs(params: {
  q?: string;
  quote?: string;
  limit?: number;
  offset?: number;
  signal?: AbortSignal;
}): Promise<PairsResponse> {
  const url = new URL(apiUrl("/api/markets/pairs"), typeof window !== "undefined" ? window.location.origin : "http://localhost");
  if (params.q) url.searchParams.set("q", params.q);
  if (params.quote) url.searchParams.set("quote", params.quote);
  if (typeof params.limit === "number") url.searchParams.set("limit", String(params.limit));
  if (typeof params.offset === "number") url.searchParams.set("offset", String(params.offset));
  return fetchJson(url.toString(), params.signal) as Promise<PairsResponse>;
}
