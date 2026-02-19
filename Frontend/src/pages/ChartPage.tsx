import { useState } from "react";
import TradingChart from "../components/TradingChart";

export default function ChartPage() {
  const [symbol, setSymbol] = useState("BTCUSD");
  const quickSymbols = ["BTCUSD", "ETHUSD", "XAUUSD", "EURUSD", "SOLUSD"];

  return (
    <>
      <section className="pageHero">
        <div>
          <div className="eyebrow">Chart</div>
          <h1 className="pageTitle">Advanced Chart</h1>
          <p className="pageLead">
            Interactive OHLC chart with pan/zoom, chart types, indicators, and basic drawing tools.
          </p>
        </div>
        <div className="pageHeroActions">
          <label className="pairsSearch chartSymbolField">
            <span className="muted">Symbol</span>
            <input
              value={symbol}
              onChange={(e) => {
                const next = e.target.value.toUpperCase().replace(/[^A-Z0-9/_-]/g, "");
                setSymbol(next || "BTCUSD");
              }}
              placeholder="BTCUSD"
            />
          </label>
        </div>
      </section>

      <section className="marketMeta" aria-label="Quick symbols">
        <div className="muted">Quick switch</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {quickSymbols.map((s) => (
            <button
              key={s}
              type="button"
              className="mini"
              onClick={() => setSymbol(s)}
              aria-pressed={symbol === s}
            >
              {s}
            </button>
          ))}
        </div>
      </section>

      <TradingChart symbol={symbol} />
    </>
  );
}
