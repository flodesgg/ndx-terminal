/** WEI rows and transforms (SPEC §8 `WEI`). */
import type { Schemas } from "@/core/api";

export type SessionState = Schemas["SessionStateItem"];
export type YtdBase = Schemas["YtdBase"];

export interface WeiRow {
  symbol: string;
  label: string;
  group: string;
}

const rows = (group: string, list: [string, string][]): WeiRow[] =>
  list.map(([symbol, label]) => ({ symbol, label, group }));

/** The spec's index list, in its order. */
export const INDICES: readonly WeiRow[] = [
  ...rows("AMERICAS", [
    ["^GSPC", "S&P 500"],
    ["^NDX", "Nasdaq-100"],
    ["^DJI", "Dow Jones Industrial"],
    ["^RUT", "Russell 2000"],
    ["^GSPTSE", "S&P/TSX Composite"],
    ["^BVSP", "Bovespa"],
  ]),
  ...rows("EMEA", [
    ["^STOXX50E", "Euro Stoxx 50"],
    ["^GDAXI", "DAX"],
    ["^FCHI", "CAC 40"],
    ["^FTSE", "FTSE 100"],
    ["^OMXC25", "OMX Copenhagen 25"],
    ["^OMX", "OMX Stockholm 30"],
    ["^AEX", "AEX"],
    ["^IBEX", "IBEX 35"],
    ["^SSMI", "SMI"],
  ]),
  ...rows("APAC", [
    ["^N225", "Nikkei 225"],
    ["^HSI", "Hang Seng"],
    ["000001.SS", "Shanghai Composite"],
    ["^KS11", "KOSPI"],
    ["^AXJO", "S&P/ASX 200"],
    ["^NSEI", "Nifty 50"],
  ]),
];

/** Shown while the US cash market is not open (pre-market, overnight, holidays). */
export const US_FUTURES: readonly WeiRow[] = rows("US FUTURES (CASH MARKET CLOSED)", [
  ["ES=F", "E-mini S&P 500 (ES1)"],
  ["NQ=F", "E-mini Nasdaq-100 (NQ1)"],
  ["YM=F", "E-mini Dow (YM1)"],
]);

/** The cash index whose session decides whether the futures block shows. */
export const US_CASH = "^GSPC";

export function showUsFutures(states: ReadonlyMap<string, SessionState>): boolean {
  const s = states.get(US_CASH)?.state;
  return s !== "OPEN"; // closed, holiday, or unknown: the futures are the live US read
}

/** Closed markets are dimmed (§13 step 4: "APAC closed (dim)"); a lunch break is not. */
export function isClosed(state: SessionState["state"] | undefined): boolean {
  return state === "CLOSED" || state === "HOLIDAY";
}

/** % change since the previous year's last close; null when either side is missing. */
export function ytdPct(
  price: number | null | undefined,
  base: number | null | undefined,
): number | null {
  if (price === null || price === undefined || !base) return null;
  return (price / base - 1) * 100;
}
