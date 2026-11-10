import { describe, expect, it } from "vitest";
import type { Schemas } from "@/core/api";
import { marketGroups, providerSummary, networkBadge, quotaText } from "./statusbar";

type M = Schemas["ExchangeStatus"];
type P = Schemas["ProviderStatus"];
const m = (code: string, is_open: boolean | null, holiday = false): M =>
  ({ code, name: code, tz: "UTC", is_open, holiday, next_change: null }) as M;
const p = (
  name: string,
  state: P["state"],
  detail: string | null = null,
  latency = "EOD",
  tag = "EOD",
): P =>
  ({ name, label: name, state, detail, latency, tag, requires_key: false, has_key: true }) as P;

describe("status bar market states (SPEC §4.1): text, never colour alone", () => {
  it("groups exchanges by state in a fixed order and keeps unknown states as N.A.", () => {
    const g = marketGroups([
      m("NYSE", false),
      m("CPH", true),
      m("STO", false, true),
      m("TSE", null),
      m("PAR", true),
    ]);
    expect(g.map((x) => [x.label, x.codes.map((c) => c.code)])).toEqual([
      ["OPEN", ["CPH", "PAR"]],
      ["HOLIDAY", ["STO"]],
      ["CLOSED", ["NYSE"]],
      ["N.A.", ["TSE"]],
    ]);
  });
});

describe("status bar provider health: the server's status, shown honestly", () => {
  it("working providers show their state or latency; disabled ones are grouped by reason", () => {
    const s = providerSummary([
      p("demo", "ok", null, "EOD", "DEMO"),
      p("finnhub", "disabled", "no API key"),
      p("fred", "disabled", "no API key"),
      p("yahoo", "disabled", "opt-in, off (enable in PDF; personal use)"),
      p("binance", "disabled", "DEMO mode: fixtures only, no network"),
      p("sec", "down", "HTTPError: 503", "DELAYED"),
      p("rss", "idle"),
    ]);
    expect(s.active.map((a) => `${a.name} ${a.text}`.trim())).toEqual([
      "DEMO", // the DEMO provider's tag is its name: not "DEMO DEMO", never "EOD"
      "SEC DOWN",
      "RSS idle",
    ]);
    expect(s.off.map((o) => `${o.reason}: ${o.names.join(" ")}`)).toEqual([
      "no key: FINNHUB FRED",
      "opt-in: YAHOO",
      "DEMO: BINANCE",
    ]);
    expect(s.off[0]!.title).toContain("no API key");
  });

  it("a spent budget reads LIMIT with its reset, not DOWN (review 2 A)", () => {
    const why = "daily budget used (18/18); resets 00:00 UTC";
    const s = providerSummary([p("eodhd", "limit", why)]);
    expect(s.active.map((a) => `${a.name} ${a.text}`)).toEqual(["EODHD LIMIT"]);
    expect(s.active[0]!.title).toBe(`eodhd: limit — ${why}`);
  });

  it("working providers show the server's §6.1 tag, not a latency class (review 1b #14)", () => {
    const s = providerSummary([
      p("finnhub", "ok", null, "REALTIME", "RT·TRD"),
      p("yahoo", "ok", null, "DELAYED", "CACHE"),
      p("sec", "ok", null, "STATIC", "CACHE"),
    ]);
    expect(s.active.map((a) => `${a.name} ${a.text}`)).toEqual([
      "FINNHUB RT·TRD",
      "YAHOO CACHE",
      "SEC CACHE",
    ]);
  });

  it("no data from the server is N.A., not an empty healthy bar", () => {
    expect(providerSummary(undefined)).toEqual({ active: [], off: [], na: true });
  });
});

describe("status bar OFFLINE (SPEC §6.3 offline)", () => {
  const base = {
    status: "ok" as const,
    demo: false,
    app: "X",
    version: "1",
    started_at: "2026-11-09T08:00:00Z",
  };
  it("is nothing while online or when the server does not answer", () => {
    expect(
      networkBadge({ ...base, network: "online", offline_since: null, reconnect_in_s: null }),
    ).toBeNull();
    expect(networkBadge(undefined)).toBeNull();
  });
  it("says OFFLINE with since and the next reconnect attempt", () => {
    const b = networkBadge({
      ...base,
      network: "offline",
      offline_since: "2026-11-09T09:15:00Z",
      reconnect_in_s: 3.4,
    });
    expect(b?.text).toBe("OFFLINE");
    expect(b?.title).toMatch(/since .*\d\d:\d\d/);
    expect(b?.title).toContain("reconnecting in 4 s");
  });
});

describe("PROV quota text", () => {
  it("shows used/limit per window and N.A. without a budget", () => {
    expect(quotaText({ quota_limit: 55, quota_used: 3, quota_left: 52, quota_period: "min" })).toBe(
      "3/55 per min",
    );
    expect(
      quotaText({ quota_limit: 50, quota_used: 2, quota_left: 48, quota_period: "symbols" }),
    ).toBe("2/50 symbols");
    expect(
      quotaText({ quota_limit: null, quota_used: null, quota_left: null, quota_period: null }),
    ).toBe("N.A.");
  });
});
