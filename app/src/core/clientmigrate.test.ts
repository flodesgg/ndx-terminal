import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalTicker, migrateClientSymbols, startClientMigration } from "./clientmigrate";
import { useWorkspace } from "./layout/store";
import { activeView, fromV1Tree } from "./layout/session";
import { leaf } from "./layout/tree";
import { buildIndex, EMPTY_INDEX, setSecIndex } from "./secindex";
import { recentTickers, replaceRecentTickers } from "@/lib/recent";

const IX = buildIndex({
  complete: ["US"],
  fiat: ["EUR", "USD"],
  items: [
    ["SPY US EQUITY", "SPDR S&P 500 ETF"],
    ["NOVOB DC EQUITY", "Novo Nordisk B", "NOVO-B.CO"],
    ["SPX INDEX", "S&P 500", "^GSPC"],
    ["BTCUSD CURNCY", "Bitcoin", "BTCUSDT"],
  ],
});

describe("client-stored symbols → canonical IDs (SPEC §5)", () => {
  beforeEach(() => localStorage.clear());

  it("maps provider symbols and bare tickers; keeps canonical and unknown ones", () => {
    expect(canonicalTicker("SPY", IX)).toBe("SPY US EQUITY");
    expect(canonicalTicker("NOVO-B.CO", IX)).toBe("NOVOB DC EQUITY");
    expect(canonicalTicker("^GSPC", IX)).toBe("SPX INDEX");
    expect(canonicalTicker("BTCUSDT", IX)).toBe("BTCUSD CURNCY");
    expect(canonicalTicker("NOVOB DC EQUITY", IX)).toBe("NOVOB DC EQUITY");
    expect(canonicalTicker("ENI.MI", IX)).toBe("ENI.MI");
  });

  it("rewrites the stored layout and recent tickers once the index is loaded", () => {
    useWorkspace
      .getState()
      .loadSession(fromV1Tree(leaf({ fn: "GP", ticker: "NOVO-B.CO", args: [] }, "p1")));
    replaceRecentTickers(["SPY", "SPY US EQUITY", "ENI.MI"]);
    migrateClientSymbols(EMPTY_INDEX); // nothing loaded yet: nothing changes
    expect(activeView(useWorkspace.getState().session)?.ticker).toBe("NOVO-B.CO");
    migrateClientSymbols(IX);
    expect(activeView(useWorkspace.getState().session)?.ticker).toBe("NOVOB DC EQUITY");
    expect(recentTickers()).toEqual(["SPY US EQUITY", "ENI.MI"]);
  });

  it("also migrates a session restored after the index had loaded", () => {
    vi.useFakeTimers(); // the save the change schedules never runs here
    setSecIndex(IX);
    const stop = startClientMigration();
    // The session arrives from user.db later (bootSession): migrate it then, too.
    useWorkspace.setState({ ready: false });
    useWorkspace
      .getState()
      .loadSession(fromV1Tree(leaf({ fn: "GP", ticker: "NOVO-B.CO", args: [] }, "p1")));
    useWorkspace.setState({ ready: true });
    expect(activeView(useWorkspace.getState().session)?.ticker).toBe("NOVOB DC EQUITY");
    stop();
    useWorkspace.setState({ ready: false });
    setSecIndex(EMPTY_INDEX);
    vi.useRealTimers();
  });
});
